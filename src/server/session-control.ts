import { isActiveTask } from "@shared/task-status.ts";
import type { Hono } from "hono";
import {
  SessionControlGrantSchema, SessionControlReadSchema, SessionControlRequestSchema,
  type SessionControlAction,
} from "@shared/protocol.ts";
import { SCOUT_SUBMISSION_CREDENTIAL_HEADER } from "@shared/harness-runtime.mjs";
import { checkToken } from "./auth.ts";
import type { Registry } from "./registry.ts";
import { verifyScoutSubmissionCredential } from "./scouts/submission-auth.ts";
import { logEvent } from "./db.ts";
import { parseBody } from "./http-body.ts";
import { SESSION_CONTROL_DESKTOP_REQUIRED } from "@shared/session-control-authorization.ts";
import { sessionControlAuthorization, type AuthorizeSessionControl } from "./session-control-authorization.ts";

// Bound to the exact in-process Request, not headers or inherited async context.
// Only the verified control endpoint can populate this map; direct HTTP cannot.
const delegatedActors = new WeakMap<Request, `session:${string}`>();
export function sessionControlActor(request: Request): `session:${string}` | undefined {
  return delegatedActors.get(request);
}

/** The signed Registry credential identifies the caller, never a body id or cwd. */
export function sessionController(registry: Registry, credential: string | undefined): string | null {
  const authority = verifyScoutSubmissionCredential(credential);
  if (!authority?.sessionId || !authority.episodeId) return null;
  const session = registry.getSession(authority.sessionId);
  const episode = registry.workEpisodeForSession(authority.sessionId);
  const task = session ? registry.taskForSession(session.id, session.cwd) : null;
  if (!session || !episode || episode.awaitingAgentRebind
    || session.pid !== authority.pid || session.agentSessionId !== authority.agentSessionId
    || authority.taskId !== (task && isActiveTask(task.status) ? task.id : null)
    || session.cwd !== authority.cwd || episode.episodeId !== authority.episodeId
    || !registry.sessionControlEnabled(session.id)) return null;
  return session.id;
}

/** Translate only supported actions to the existing dashboard handlers and their guards. */
export function controlRequest(target: string, command: SessionControlAction): {
  path: string; method: string; body?: unknown;
} {
  const base = `/api/sessions/${encodeURIComponent(target)}`;
  const post = (suffix: string, body?: unknown) => ({ path: `${base}/${suffix}`, method: "POST", body });
  switch (command.action) {
    case "message": return post("inject", { text: command.text, buffer: false });
    case "interrupt": return post("interrupt");
    case "select_option": return post("select-option", { requestId: command.requestId, number: command.number, label: command.label });
    case "submit_options": return post("submit-options", command.form);
    case "resolve_review": return { path: `/api/reviews/${encodeURIComponent(command.reviewId)}/resolve`, method: "POST", body: command.resolution };
    case "pending_deliver": return post(`pending-turns/${encodeURIComponent(command.turnId)}/deliver`, { revision: command.revision, action: command.delivery });
    case "pending_recall": return post(`pending-turns/${encodeURIComponent(command.turnId)}/recall`, { revision: command.revision });
    case "pending_retry": return post(`pending-turns/${encodeURIComponent(command.turnId)}/retry`, { revision: command.revision });
    case "pending_resolve": return post(`pending-turns/${encodeURIComponent(command.turnId)}/resolve`, { revision: command.revision });
    case "queue_add": return post("queue", { intent: command.intent });
    case "queue_edit": return { path: `${base}/queue/${encodeURIComponent(command.itemId)}`, method: "PATCH", body: { intent: command.intent, revision: command.revision } };
    case "queue_remove": return { path: `${base}/queue/${encodeURIComponent(command.itemId)}`, method: "DELETE" };
    case "queue_approve": return post(`queue/${encodeURIComponent(command.itemId)}/approve`);
    case "queue_reorder": return { path: `${base}/queue/order`, method: "PUT", body: { ids: command.ids } };
    case "rename": return post("rename", { name: command.name });
    case "set_model": return post("model", { model: command.model });
    case "set_effort": return post("effort", { effort: command.effort });
    case "set_permission_mode": return post("mode", { mode: command.mode });
  }
}

export function registerSessionControlRoutes(
  app: Hono, registry: Registry, authorize: AuthorizeSessionControl = sessionControlAuthorization(),
): void {
  app.put("/api/sessions/:id/session-control", async (c) => {
    // This is an operator setting. Neither a tool nor an attributed agent request can grant it.
    if (c.req.header("x-harness-token") || c.req.header(SCOUT_SUBMISSION_CREDENTIAL_HEADER)
      || c.req.header("x-mission-operation-actor") === "agent") {
      return c.json({ error: "Only the operator can change session control" }, 403);
    }
    const origin = c.req.header("origin");
    if (origin) {
      try {
        const url = new URL(origin);
        if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return c.json({ error: "forbidden" }, 403);
      } catch { return c.json({ error: "forbidden" }, 403); }
    }
    const parsed = await parseBody(c, SessionControlGrantSchema);
    if (!parsed.ok) return parsed.res;
    const { enabled, requestId } = parsed.data;
    const sessionId = c.req.param("id");
    if (!requestId) return c.json({ error: SESSION_CONTROL_DESKTOP_REQUIRED }, 403);
    // Hold the identity across the asynchronous private-channel check. A click for the
    // old conversation must not enable a replacement that appeared while it was in flight.
    // Revocation only removes authority, so an identity change must not block it.
    const before = registry.sessionControlIdentity(sessionId);
    if (!await authorize({ sessionId, enabled, requestId })) return c.json({ error: SESSION_CONTROL_DESKTOP_REQUIRED }, 403);
    if ((enabled && registry.sessionControlIdentity(sessionId) !== before) || !registry.setSessionControlEnabled(sessionId, enabled)) {
      return c.json({ error: "Session control requires a live, registered conversation" }, 409);
    }
    logEvent(c.req.param("id"), Date.now(), "session_control_grant", { enabled: parsed.data.enabled });
    return c.json({ ok: true });
  });

  app.post("/mcp/session-control/read", async (c) => {
    if (!checkToken(c.req.header("x-harness-token"))) return c.json({ error: "unauthorized" }, 401);
    const parsed = await parseBody(c, SessionControlReadSchema);
    if (!parsed.ok) return parsed.res;
    const caller = sessionController(registry, c.req.header(SCOUT_SUBMISSION_CREDENTIAL_HEADER));
    if (!caller) return c.json({ error: "Ask the operator to enable Control other sessions on your session" }, 403);
    if (!parsed.data.sessionId) {
      const sessions = registry.snapshot().sessions.filter((s) => s.id !== caller && s.state !== "exited" && s.state !== "stopping");
      return c.json({ sessions: sessions.map((s) => ({ id: s.id, name: s.name, agent: s.agent, runtime: s.runtime, state: s.state, cwd: s.cwd, activity: s.activity })) });
    }
    const session = registry.getSession(parsed.data.sessionId);
    if (!session || session.id === caller || session.state === "exited" || session.state === "stopping") return c.json({ error: "No such other live session" }, 404);
    const reviews = registry.pendingReviews(session.id);
    let transcript: unknown;
    if (parsed.data.transcript) {
      const result = await app.request(`http://localhost/api/sessions/${encodeURIComponent(session.id)}/transcript?turns=20`, { headers: { host: "localhost" } });
      transcript = await result.json();
      if (!sessionController(registry, c.req.header(SCOUT_SUBMISSION_CREDENTIAL_HEADER))) return c.json({ error: "Session control was revoked" }, 403);
    }
    return c.json({ session, reviews, ...(transcript === undefined ? {} : { transcript }) });
  });

  app.post("/mcp/session-control/act", async (c) => {
    if (!checkToken(c.req.header("x-harness-token"))) return c.json({ error: "unauthorized" }, 401);
    const parsed = await parseBody(c, SessionControlRequestSchema);
    if (!parsed.ok) return parsed.res;
    const caller = sessionController(registry, c.req.header(SCOUT_SUBMISSION_CREDENTIAL_HEADER));
    if (!caller) return c.json({ error: "Session control is not enabled for this caller" }, 403);
    const { sessionId, command } = parsed.data;
    const target = registry.getSession(sessionId);
    if (!target || target.state === "exited" || target.state === "stopping" || sessionId === caller) return c.json({ error: "No such other live session" }, 404);
    if (registry.sessionResetInProgress(sessionId)) return c.json({ error: "Target session is resetting" }, 409);
    if (command.action === "resolve_review") {
      const review = registry.getReview(command.reviewId);
      if (!review || review.sessionId !== sessionId) return c.json({ error: "Review does not belong to the target session" }, 404);
      if (review.status !== "pending") return c.json({ error: "Review is already resolved" }, 409);
    }
    const request = controlRequest(sessionId, command);
    const delegatedRequest = new Request(`http://localhost${request.path}`, {
      method: request.method,
      headers: { host: "localhost", "content-type": "application/json", "x-mission-operation-surface": "mcp", "x-mission-operation-actor": "agent" },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    });
    delegatedActors.set(delegatedRequest, `session:${caller}`);
    try {
      const response = await app.request(delegatedRequest);
      logEvent(sessionId, Date.now(), "session_control_action", { controller: caller, target: sessionId, action: command.action, status: response.status });
      return response;
    } finally {
      delegatedActors.delete(delegatedRequest);
    }
  });
}
