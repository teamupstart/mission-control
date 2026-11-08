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

function sameArgv(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((arg, index) => arg === right[index]);
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
   * not stretch to it. The repository comes from the run's binding, never from the request,
   * and the machine-wide default is never touched. The session is told to confirm the argv
   * with its operator through `request_input` first; the write itself is what Library ›
   * Commands shows, and an operator can edit or remove it there like any other override.
   *
   * After the commit the run's spent executions of that slot are returned, so the corrected
   * command runs in this run rather than being skipped as `budget_spent` for an execution of
   * a command the repository never provided.
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
    if (!run || !ownsBinding(registry, caller, binding)) {
      return c.json({ error: "Only the session that owns this workflow run can configure its Command" }, 403);
    }
    if (["completed", "cancelled", "failed"].includes(run.status)) {
      return c.json({ error: "This workflow run has finished; configure the Command in Library › Commands" }, 409);
    }
    const repoRoot = binding!.sessionRepoRoot;
    if (!repoRoot) {
      return c.json({ error: "This workflow run reported no repository to configure" }, 409);
    }
    // Deferred while a check for this slot is still running in this run. Its outcome is not
    // known yet, so neither is whether its reservation proved nothing; configuring now would
    // leave a misfit it later records counted against the corrected command. Nothing awaits
    // between this test and the write below, so no check can start in between, and a queued
    // check reads the catalog when it starts.
    const slotNodes = new Set((manager.store.getWorkflowVersionById(run.workflowVersionId)?.graph.nodes ?? [])
      .filter((node) => node.kind === "check" && node.slot === slot).map((node) => node.id));
    if (manager.store.listAttemptsForRun(run.id).some((attempt) =>
      attempt.state === "running" && slotNodes.has(attempt.nodeId))) {
      return c.json({
        error: `A ${slot} check is still running in this workflow run; configure the Command after it finishes`,
      }, 409);
    }
    // One retry absorbs a concurrent unrelated save; a second conflict is reported, not looped.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const view = commands.get(slot);
      if (!view) return c.json({ error: "no such command slot" }, 404);
      const existing = view.overrides.find((entry) => entry.repoRoot === repoRoot);
      const unchanged = existing !== undefined && sameArgv(existing.command, command);
      const overrides = view.overrides.filter((entry) => entry.repoRoot !== repoRoot);
      overrides.push({ repoRoot, command: [...command] });
      // Re-confirming the override already stored writes nothing: a revision bump would tell
      // every open window a slot moved when it did not.
      const result = unchanged ? { ok: true as const, view } : commands.replace(slot, {
        expectedRevision: view.revision,
        defaultCommand: view.defaultCommand,
        overrides,
        maxRuns: view.maxRuns,
        timeoutMs: view.timeoutMs,
        onUnavailable: view.onUnavailable,
        onBudgetExhausted: view.onBudgetExhausted,
      });
      if (!result.ok && result.reason === "revision_conflict") continue;
      if (!result.ok) {
        return c.json({ error: result.reason.replaceAll("_", " ") }, 409);
      }
      // Only executions in which the repository did not provide a DIFFERENT argv are returned,
      // and this argv gets back whatever it had already spent, so no sequence of
      // configurations runs any one command past `maxRuns`.
      const { forgiven, restored } = manager.store.forgiveCheckRuns(run.id, slot, command);
      manager.store.appendEvent(run.id, "workflow_command_configured", {
        slot, repoRoot, command: [...command], forgivenRuns: forgiven, restoredRuns: restored, sessionId: caller,
      });
      logEvent(caller, Date.now(), "workflow_mcp_command_configured", { runId: run.id, slot, repoRoot });
      return c.json({
        slot,
        repoRoot,
        command,
        revision: result.view.revision,
        forgivenRuns: forgiven,
        restoredRuns: restored,
        next: "Resubmit the run with trigger_workflow_action resubmit; pass resubmitUnchanged: true when no files changed.",
      });
    }
    return c.json({ error: "The Command changed concurrently; read it again and retry" }, 409);
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
