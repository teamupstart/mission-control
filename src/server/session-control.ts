import type { SessionGrantScope } from "@shared/residents.ts";
import { isActiveTask } from "@shared/task-status.ts";
import { hasBlocker } from "@shared/session.ts";
import type { SessionAwaiting, SessionBlocker } from "@shared/types.ts";
import type { Context, Hono } from "hono";
import {
  RequestSessionControlSchema, SessionControlGrantSchema, SessionControlReadSchema, SessionControlRequestSchema,
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
import { requireFeature } from "./feature-flags/index.ts";
import { SESSION_CONTROL_REQUESTS_FLAG, SessionControlRequests } from "./session-control-requests.ts";

// Bound to the exact in-process Request, not headers or inherited async context.
// Only the verified control endpoint can populate this map; direct HTTP cannot.
const delegatedActors = new WeakMap<Request, `session:${string}`>();
export function sessionControlActor(request: Request): `session:${string}` | undefined {
  return delegatedActors.get(request);
}

/** The signed Registry credential identifies the caller, never a body id or cwd. */
export function sessionControlCaller(registry: Registry, credential: string | undefined): string | null {
  const authority = verifyScoutSubmissionCredential(credential);
  if (!authority?.sessionId || !authority.episodeId) return null;
  const session = registry.getSession(authority.sessionId);
  const episode = registry.workEpisodeForSession(authority.sessionId);
  const task = session ? registry.taskForSession(session.id, session.cwd) : null;
  if (!session || !episode || episode.awaitingAgentRebind
    || session.pid !== authority.pid || session.agentSessionId !== authority.agentSessionId
    || authority.taskId !== (task && isActiveTask(task.status) ? task.id : null)
    || session.cwd !== authority.cwd || episode.episodeId !== authority.episodeId
    || !registry.sessionControlIdentity(session.id)) return null;
  return session.id;
}

/** Delegation adds the existing operator grant to the same caller identity check. */
export function sessionController(registry: Registry, credential: string | undefined, required: SessionGrantScope = "control"): string | null {
  const caller = sessionControlCaller(registry, credential);
  return caller && registry.sessionControlEnabled(caller, required) ? caller : null;
}

/** The list form's compact blocker: enough to correlate, without the Markdown details. */
export function blockerSummary(blocker: SessionBlocker | null | undefined) {
  if (!blocker) return null;
  const { id, kind, reason, waitingOn, referenceUrl, startedAt, reply } = blocker;
  return { id, kind, reason, waitingOn, referenceUrl, startedAt, reply };
}

/** The list form's compact wait: what, how it wakes and when it is due, without the details. */
export function awaitingSummary(awaiting: SessionAwaiting | null | undefined, now = Date.now()) {
  if (!awaiting) return null;
  const { id, what, wakeSource, expectedBy, referenceUrl, startedAt } = awaiting;
  return { id, what, wakeSource, expectedBy, referenceUrl, startedAt, overdue: now >= expectedBy };
}

/** The actions that are exactly one dashboard request. `complete` is two; see `completeTarget`. */
export type SingleRequestControlAction = Exclude<SessionControlAction, { action: "complete" }>;

/** Translate only supported actions to the existing dashboard handlers and their guards. */
export function controlRequest(target: string, command: SingleRequestControlAction): {
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
    case "queue_approve": return post(`queue/${encodeURIComponent(command.itemId)}/approve`, { revision: command.revision });
    case "queue_reorder": return { path: `${base}/queue/order`, method: "PUT", body: { ids: command.ids } };
    case "rename": return post("rename", { name: command.name });
    case "set_model": return post("model", { model: command.model });
    case "set_effort": return post("effort", { effort: command.effort });
    case "set_permission_mode": return post("mode", { mode: command.mode });
    case "flag_blocker_reply": return post("blocker/reply", { note: command.note, referenceUrl: command.referenceUrl, blockerId: command.blockerId });
    case "clear_blocker": return post("blocker/clear", { resolution: command.resolution, blockerId: command.blockerId });
    case "clear_awaiting": return post("awaiting/clear", { resolution: command.resolution, awaitingId: command.awaitingId });
  }
}

/**
 * Why this request cannot carry the operator's session-control authority, or null when it can.
 * A tool, an attributed agent request or a page from another origin never can: the shared
 * machine token and a signed agent credential identify an agent, not the operator. Both doors
 * that consume a desktop click - this route and a resident launch - ask this first.
 */
export function sessionControlCallerRefusal(c: Context): string | null {
  if (c.req.header("x-harness-token") || c.req.header(SCOUT_SUBMISSION_CREDENTIAL_HEADER)
    || c.req.header("x-mission-operation-actor") === "agent") {
    return "Only the operator can change session control";
  }
  const origin = c.req.header("origin");
  if (origin) {
    try {
      const url = new URL(origin);
      if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return "forbidden";
    } catch { return "forbidden"; }
  }
  return null;
}

export function registerSessionControlRoutes(
  app: Hono, registry: Registry, authorize: AuthorizeSessionControl = sessionControlAuthorization(),
  /**
   * Called for an authorized revoke BEFORE the live grant is turned off, so every durable copy
   * of the grant is gone first: nothing that fails after it can leave a record a restart would
   * apply again. A throw here refuses the revoke with the live grant untouched.
   */
  onRevoke: (sessionId: string) => void = () => {},
  /** A session's own asks for the grant; built here unless a caller needs to hold it. */
  requests?: SessionControlRequests,
): void {
  // Built on first use, not here: it subscribes to the Registry and the flag store, and an app
  // that never sees an ask - most of the HTTP tests' stub registries among them - owes neither.
  let asks = requests ?? null;
  const sessionAsks = (): SessionControlRequests => (asks ??= new SessionControlRequests(registry));
  app.put("/api/sessions/:id/session-control", async (c) => {
    // This is an operator setting. Neither a tool nor an attributed agent request can grant it.
    const refusal = sessionControlCallerRefusal(c);
    if (refusal) return c.json({ error: refusal }, 403);
    const parsed = await parseBody(c, SessionControlGrantSchema);
    if (!parsed.ok) return parsed.res;
    const { enabled, requestId, controlRequestId } = parsed.data;
    const sessionId = c.req.param("id");
    if (!requestId) return c.json({ error: SESSION_CONTROL_DESKTOP_REQUIRED }, 403);
    // Accepting a session's ask is this same grant, armed by the same private click. The ask
    // only says which card was on screen: one the session no longer holds - answered, expired,
    // or raised by a conversation since replaced - refuses rather than granting whoever holds
    // the session now. Checked before the click is consumed, so a refusal costs no click.
    if (controlRequestId !== undefined) {
      if (!enabled) return c.json({ error: "Accepting a request can only turn session control on" }, 400);
      if (!sessionAsks().isPending(sessionId, controlRequestId)) {
        return c.json({ error: "This session is no longer asking for control" }, 409);
      }
    }
    // Hold the identity across the asynchronous private-channel check. A click for the
    // old conversation must not enable a replacement that appeared while it was in flight.
    // Revocation only removes authority, so an identity change must not block it.
    const before = registry.sessionControlIdentity(sessionId);
    if (!await authorize({ sessionId, enabled, requestId })) return c.json({ error: SESSION_CONTROL_DESKTOP_REQUIRED }, 403);
    // The ask may have been declined in another window, or expired, while the click was checked.
    if (controlRequestId !== undefined && !sessionAsks().isPending(sessionId, controlRequestId)) {
      return c.json({ error: "This session is no longer asking for control" }, 409);
    }
    if (!enabled) onRevoke(sessionId);
    if ((enabled && registry.sessionControlIdentity(sessionId) !== before) || !registry.setSessionControlEnabled(sessionId, enabled)) {
      return c.json({ error: "Session control requires a live, registered conversation" }, 409);
    }
    logEvent(c.req.param("id"), Date.now(), "session_control_grant", {
      enabled: parsed.data.enabled,
      ...(controlRequestId ? { controlRequestId } : {}),
    });
    return c.json({ ok: true });
  });

  // --- A session's own ask for the grant (`request_session_control`) ---
  //
  // Raising and waiting are the asking session's alone: the machine token plus its signed
  // Registry credential name the caller, never a body id. Neither route can grant anything.
  app.post("/mcp/session-control/requests", requireFeature(SESSION_CONTROL_REQUESTS_FLAG), async (c) => {
    if (!checkToken(c.req.header("x-harness-token"))) return c.json({ error: "unauthorized" }, 401);
    const parsed = await parseBody(c, RequestSessionControlSchema);
    if (!parsed.ok) return parsed.res;
    const caller = sessionControlCaller(registry, c.req.header(SCOUT_SUBMISSION_CREDENTIAL_HEADER));
    if (!caller) return c.json({ error: "Only a live session Mission Control registered can ask for session control" }, 403);
    const result = sessionAsks().request(caller, parsed.data.reason);
    if (result.status === "pending") logEvent(caller, Date.now(), "session_control_request", { requestId: result.id });
    return c.json(result);
  });

  app.get("/mcp/session-control/requests/:requestId/wait", requireFeature(SESSION_CONTROL_REQUESTS_FLAG), async (c) => {
    if (!checkToken(c.req.header("x-harness-token"))) return c.json({ error: "unauthorized" }, 401);
    const caller = sessionControlCaller(registry, c.req.header(SCOUT_SUBMISSION_CREDENTIAL_HEADER));
    if (!caller) return c.json({ error: "This conversation is no longer the one that asked for session control" }, 403);
    const result = await sessionAsks().wait(caller, c.req.param("requestId"), undefined, c.req.raw.signal);
    if (!result) return c.json({ error: "No such session control request for this session" }, 404);
    return c.json(result);
  });

  // The operator's Decline. Like a revoke it only removes authority, so it needs no private
  // click; it still refuses every caller that identifies itself as a tool or an agent.
  app.post("/api/sessions/:id/session-control/requests/:requestId/decline", requireFeature(SESSION_CONTROL_REQUESTS_FLAG), (c) => {
    const refusal = sessionControlCallerRefusal(c);
    if (refusal) return c.json({ error: refusal }, 403);
    const sessionId = c.req.param("id");
    if (!sessionAsks().decline(sessionId, c.req.param("requestId"))) {
      return c.json({ error: "This session is no longer asking for control" }, 409);
    }
    logEvent(sessionId, Date.now(), "session_control_request_declined", { requestId: c.req.param("requestId") });
    return c.json({ ok: true });
  });

  app.post("/mcp/session-control/read", async (c) => {
    if (!checkToken(c.req.header("x-harness-token"))) return c.json({ error: "unauthorized" }, 401);
    const parsed = await parseBody(c, SessionControlReadSchema);
    if (!parsed.ok) return parsed.res;
    const caller = sessionController(registry, c.req.header(SCOUT_SUBMISSION_CREDENTIAL_HEADER), "read");
    if (!caller) return c.json({ error: "Ask the operator to enable Control other sessions on your session" }, 403);
    if (!parsed.data.sessionId) {
      const sessions = registry.snapshot().sessions.filter((s) => s.id !== caller && s.state !== "exited" && s.state !== "stopping"
        && (!parsed.data.blocked || hasBlocker(s))
        // Every declared wait, overdue ones included: an overdue wait is the one a resident
        // most needs to find, since the session said it would be back by now.
        && (!parsed.data.awaiting || s.awaiting != null));
      const now = Date.now();
      return c.json({ sessions: sessions.map((s) => ({
        id: s.id, name: s.name, agent: s.agent, runtime: s.runtime, state: s.state, cwd: s.cwd, activity: s.activity,
        blocker: blockerSummary(s.blocker),
        awaiting: awaitingSummary(s.awaiting, now),
      })) });
    }
    const session = registry.getSession(parsed.data.sessionId);
    if (!session || session.id === caller || session.state === "exited" || session.state === "stopping") return c.json({ error: "No such other live session" }, 404);
    const reviews = registry.pendingReviews(session.id);
    let transcript: unknown;
    if (parsed.data.transcript) {
      const result = await app.request(`http://localhost/api/sessions/${encodeURIComponent(session.id)}/transcript?turns=20`, { headers: { host: "localhost" } });
      transcript = await result.json();
      if (!sessionController(registry, c.req.header(SCOUT_SUBMISSION_CREDENTIAL_HEADER), "read")) return c.json({ error: "Session control was revoked" }, 403);
    }
    return c.json({ session, reviews, queue: registry.getQueue(session.id), ...(transcript === undefined ? {} : { transcript }) });
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
    const delegate = async (request: { path: string; method: string; body?: unknown }): Promise<Response> => {
      const delegatedRequest = new Request(`http://localhost${request.path}`, {
        method: request.method,
        headers: { host: "localhost", "content-type": "application/json", "x-mission-operation-surface": "mcp", "x-mission-operation-actor": "agent" },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      });
      delegatedActors.set(delegatedRequest, `session:${caller}`);
      try {
        return await app.request(delegatedRequest);
      } finally {
        delegatedActors.delete(delegatedRequest);
      }
    };
    const response = command.action === "complete"
      ? await completeTarget(registry, sessionId, command, delegate)
      : await delegate(controlRequest(sessionId, command));
    logEvent(sessionId, Date.now(), "session_control_action", { controller: caller, target: sessionId, action: command.action, status: response.status });
    return response;
  });
}

type CompleteAction = Extract<SessionControlAction, { action: "complete" }>;

/**
 * The dashboard's Complete dialog, step for step, through the same two routes it calls.
 *
 * The task is recorded before the stop is requested, and the order matters for the reason the
 * dialog gives: a stop that fails must not leave the outcome unwritten, because the task would
 * then settle as `failed` through the session-went-away path. When completion already asked for
 * the session's closure (a task with its own worktree), no second stop is sent. The task is the
 * one the target is running now, resolved from the live session, never an id the caller names.
 */
async function completeTarget(
  registry: Registry,
  sessionId: string,
  command: CompleteAction,
  delegate: (request: { path: string; method: string; body?: unknown }) => Promise<Response>,
): Promise<Response> {
  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const target = registry.getSession(sessionId);
  const task = target ? registry.taskForSession(target.id, target.cwd) : undefined;
  if (!task) return json({ error: "Target session has no task to complete" }, 409);
  const completed = await delegate({
    path: `/api/tasks/${encodeURIComponent(task.id)}/complete`,
    method: "POST",
    body: {
      // The dialog's own fallback: an outcome is context, not permission to finish.
      outcome: command.outcome || "completed",
      ...(command.satisfyDependents ? { satisfyDependents: true } : {}),
      ...(command.confirmIncompleteScout ? { confirmIncompleteScout: true } : {}),
    },
  });
  if (!completed.ok) return completed;
  const done = await completed.json() as { status: string; sessionClosureRequested?: boolean };
  const result = { ok: true, taskId: task.id, taskStatus: done.status };
  if (done.sessionClosureRequested) return json({ ...result, session: "closing" }, 200);
  // Completion may have ended the session itself; there is nothing left to stop.
  if (!registry.getSession(sessionId)) return json({ ...result, session: "closed" }, 200);
  const killed = await delegate({ path: `/api/sessions/${encodeURIComponent(sessionId)}/kill`, method: "POST" });
  if (!killed.ok) {
    const reason = ((await killed.json().catch(() => null)) as { error?: string } | null)?.error ?? "failed";
    return json({ ...result, ok: false, error: `task marked done, but the session could not be closed: ${reason}` }, killed.status);
  }
  return json({ ...result, session: "closing" }, 200);
}
