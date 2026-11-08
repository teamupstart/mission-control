import type { Context, Hono } from "hono";
import type { z } from "zod";
import { SCOUT_SUBMISSION_CREDENTIAL_HEADER } from "@shared/harness-runtime.mjs";
import {
  ConfigureWorkflowCommandSchema,
  GetWorkflowRunSchema, ListWorkflowRunsSchema, ReadWorkflowCommandOutputMcpSchema,
  WorkflowMcpActionSchema,
  type WorkflowActionRequestSchema, workflowActionPath,
} from "@shared/workflow-mcp.ts";
import type { WorkflowBinding } from "@shared/workflow.ts";
import { checkToken } from "../auth.ts";
import { logEvent } from "../db.ts";
import { parseBody } from "../http-body.ts";
import { noteKeyFor, type Registry } from "../registry.ts";
import { sessionControlCaller } from "../session-control.ts";
import type { WorkflowCommandManager } from "./commands.ts";
import type { WorkflowManager } from "./manager.ts";
import { decodeWorkflowRunCursor } from "./store.ts";

/** Signed identity is mandatory for self-control too; caller IDs never come from arguments. */
function callerFor(c: Context, registry: Registry) {
  if (!checkToken(c.req.header("x-harness-token"))) {
    return { response: c.json({ error: "unauthorized" }, 401) };
  }
  const caller = sessionControlCaller(registry, c.req.header(SCOUT_SUBMISSION_CREDENTIAL_HEADER));
  return caller ? { caller } : { response: c.json({ error: "A current signed session credential is required" }, 403) };
}

function ownsBinding(registry: Registry, caller: string, binding: WorkflowBinding | null): boolean {
  const session = registry.getSession(caller);
  return Boolean(session && binding?.sessionId === caller && binding.noteKey === noteKeyFor(session));
}

function actionIsOwned(
  manager: WorkflowManager, registry: Registry, caller: string,
  request: z.infer<typeof WorkflowActionRequestSchema>,
): boolean {
  if ("sessionId" in request) return request.sessionId === caller;
  if ("bindingId" in request) {
    return ownsBinding(registry, caller, manager.store.getBinding(request.bindingId))
      && (request.action !== "reattach" || request.parameters.sessionId === caller);
  }
  const delivery = "deliveryId" in request ? manager.store.getDelivery(request.deliveryId) : null;
  const run = manager.store.getRun("runId" in request ? request.runId : delivery?.runId ?? "");
  if (!run || !ownsBinding(registry, caller, manager.store.getBinding(run.bindingId))) return false;
  // Old packets retain their original destination after reattachment. They cannot be
  // acknowledged on behalf of that other conversation merely because the binding moved.
  return !("deliveryId" in request) || Boolean(delivery?.sessionId === caller
    && delivery.noteKey === noteKeyFor(registry.getSession(caller)!));
}

const denied = (c: Context) => c.json({
  error: "Enable Control other sessions on the calling session to access another session's workflow",
}, 403);

export function registerWorkflowMcpRoutes(
  app: Hono, registry: Registry, getManager: () => WorkflowManager | null,
  getCommands: () => WorkflowCommandManager | null = () => null,
): void {
  app.post("/mcp/workflows/list", async (c) => {
    const auth = callerFor(c, registry);
    if (auth.response) return auth.response;
    const parsed = await parseBody(c, ListWorkflowRunsSchema);
    if (!parsed.ok) return parsed.res;
    // Body parsing yields: revalidate the signed identity before reading any state.
    const current = callerFor(c, registry);
    if (current.response) return current.response;
    const manager = getManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const cursor = parsed.data.cursor ? decodeWorkflowRunCursor(parsed.data.cursor) : null;
    if (parsed.data.cursor && !cursor) return c.json({ error: "cursor is invalid" }, 400);
    const caller = current.caller!;
    return c.json(manager.runPage({ ...parsed.data, limit: parsed.data.limit ?? 50, cursor,
      // The owner predicate is applied in SQL before LIMIT/cursor selection, not after it.
      owner: registry.sessionControlEnabled(caller) ? undefined
        : { sessionId: caller, noteKey: noteKeyFor(registry.getSession(caller)!) },
    }));
  });

  app.post("/mcp/workflows/read", async (c) => {
    const auth = callerFor(c, registry);
    if (auth.response) return auth.response;
    const parsed = await parseBody(c, GetWorkflowRunSchema);
    if (!parsed.ok) return parsed.res;
    const current = callerFor(c, registry);
    if (current.response) return current.response;
    const manager = getManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const allowed = () => registry.sessionControlEnabled(current.caller!) || ownsBinding(registry, current.caller!,
      manager.store.getBinding(manager.store.getRun(parsed.data.runId)?.bindingId ?? ""));
    if (!allowed()) return denied(c);
    const response = await app.request(`http://localhost/api/workflow-runs/${encodeURIComponent(parsed.data.runId)}`, { headers: { host: "localhost" } });
    const stillCurrent = callerFor(c, registry);
    if (stillCurrent.response) return stillCurrent.response;
    return allowed() ? response : denied(c);
  });

  app.post("/mcp/workflows/read-command-output", async (c) => {
    const auth = callerFor(c, registry);
    if (auth.response) return auth.response;
    const parsed = await parseBody(c, ReadWorkflowCommandOutputMcpSchema);
    if (!parsed.ok) return parsed.res;
    const current = callerFor(c, registry);
    if (current.response) return current.response;
    const manager = getManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const allowed = () => registry.sessionControlEnabled(current.caller!) || ownsBinding(
      registry,
      current.caller!,
      manager.store.getBinding(manager.store.getRun(parsed.data.runId)?.bindingId ?? ""),
    );
    if (!allowed()) return denied(c);
    const query = new URLSearchParams();
    if (parsed.data.cursor) query.set("cursor", parsed.data.cursor);
    if (parsed.data.limit) query.set("limit", String(parsed.data.limit));
    const response = await app.request(
      `http://localhost/api/workflow-runs/${encodeURIComponent(parsed.data.runId)}`
      + `/attempts/${encodeURIComponent(parsed.data.attemptId)}`
      + `/command-output/${encodeURIComponent(parsed.data.artifactId)}`
      + (query.size > 0 ? `?${query}` : ""),
      { headers: { host: "localhost" } },
    );
    const stillCurrent = callerFor(c, registry);
    if (stillCurrent.response) return stillCurrent.response;
    return allowed() ? response : denied(c);
  });

  /**
   * Set one slot's Command for the repository the caller's own run reviews.
   *
   * Own runs only, with no delegated path: this writes the operator's Command catalog, which
   * `control_session` is documented never to alter, so the Control other sessions grant does
   * not stretch to it. Identity and ownership are this route's; every rule about whether the
   * write may happen - operator confirmation included - and what it does to the run belongs
   * to `WorkflowCommandManager.configureRepositoryCommand`.
   */
  app.post("/mcp/workflows/configure-command", async (c) => {
    const auth = callerFor(c, registry);
    if (auth.response) return auth.response;
    const parsed = await parseBody(c, ConfigureWorkflowCommandSchema);
    if (!parsed.ok) return parsed.res;
    const current = callerFor(c, registry);
    if (current.response) return current.response;
    const manager = getManager();
    const commands = getCommands();
    if (!manager || !commands) return c.json({ error: "Workflow Command catalog unavailable" }, 503);
    const caller = current.caller!;
    const { runId, slot, command } = parsed.data;
    const run = manager.store.getRun(runId);
    const binding = run ? manager.store.getBinding(run.bindingId) : null;
    if (!run || !binding || !ownsBinding(registry, caller, binding)) {
      return c.json({ error: "Only the session that owns this workflow run can configure its Command" }, 403);
    }
    const result = commands.configureRepositoryCommand({
      runs: manager.store, run, binding, slot, command, sessionId: caller, reviews: registry.reviewsFor(caller),
    });
    if (!result.ok) {
      const status = result.reason === "unconfirmed" ? 403 : result.reason === "not_found" ? 404 : 409;
      return c.json({ error: result.message, code: result.reason }, status);
    }
    logEvent(caller, Date.now(), "workflow_mcp_command_configured", { runId: run.id, slot, repoRoot: result.repoRoot });
    return c.json({
      slot,
      repoRoot: result.repoRoot,
      command,
      revision: result.view.revision,
      forgivenRuns: result.forgiven,
      restoredRuns: result.restored,
      confirmationReviewId: result.confirmationReviewId,
      next: "Resubmit the run with trigger_workflow_action resubmit; pass resubmitUnchanged: true when no files changed.",
    });
  });

  app.post("/mcp/workflows/act", async (c) => {
    const auth = callerFor(c, registry);
    if (auth.response) return auth.response;
    const parsed = await parseBody(c, WorkflowMcpActionSchema);
    if (!parsed.ok) return parsed.res;
    const current = callerFor(c, registry);
    if (current.response) return current.response;
    const manager = getManager();
    if (!manager) return c.json({ error: "Workflow manager unavailable" }, 503);
    const { request } = parsed.data;
    const caller = current.caller!;
    const own = actionIsOwned(manager, registry, caller, request);
    if (!own && !registry.sessionControlEnabled(caller)) return denied(c);
    const response = await app.request(`http://localhost${workflowActionPath(request)}`, {
      method: "POST", headers: { host: "localhost", "content-type": "application/json",
        "x-mission-operation-surface": "mcp", "x-mission-operation-actor": "agent" },
      body: JSON.stringify(request.parameters),
    });
    logEvent(caller, Date.now(), "workflow_mcp_action", {
      controller: caller, action: request.action, delegated: !own, status: response.status,
    });
    return response;
  });
}
