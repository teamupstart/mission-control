import type { Context, Hono } from "hono";
import type { z } from "zod";
import { SCOUT_SUBMISSION_CREDENTIAL_HEADER } from "@shared/harness-runtime.mjs";
import {
  GetWorkflowRunSchema, ListWorkflowRunsSchema, WorkflowMcpActionSchema,
  type WorkflowActionRequestSchema, workflowActionPath,
} from "@shared/workflow-mcp.ts";
import type { WorkflowBinding } from "@shared/workflow.ts";
import { checkToken } from "../auth.ts";
import { logEvent } from "../db.ts";
import { parseBody } from "../http-body.ts";
import { noteKeyFor, type Registry } from "../registry.ts";
import { sessionControlCaller } from "../session-control.ts";
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
