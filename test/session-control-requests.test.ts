import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { SessionControlRequestResult } from "../src/shared/protocol.ts";
import { unexpectedActiveSdkDelivery } from "./helpers/pending-turn-sender.ts";
import { mkTask } from "./helpers/session-fixture.ts";
import { tempDir } from "./temp-root.mjs";

const home = tempDir("mission-session-control-requests-");
process.env.MISSION_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { PendingTurnManager } = await import("../src/server/pending-turns.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const { maintainScoutSessionCredentials } = await import("../src/server/scouts/session-credentials.ts");
const { sessionScoutCredentialLocator } = await import("../src/server/scouts/submission-auth.ts");
const { sessionScoutCredentialPath } = await import("../src/shared/harness-runtime.mjs");
const { applyFeatureFlagIntent } = await import("../src/server/feature-flags/index.ts");
const { SESSION_CONTROL_REQUEST_EXPIRED, SessionControlRequests } = await import("../src/server/session-control-requests.ts");
const { SESSION_CONTROL_REQUEST_REASON_MAX } = await import("../src/shared/protocol.ts");

const FLAG = "session-control-requests" as const;
const cleanups: Array<() => void> = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
  applyFeatureFlagIntent({ kind: "flag", id: FLAG, enabled: false });
  rmSync(home, { recursive: true, force: true });
});
let serial = 0;

function setFlag(enabled: boolean): void {
  const result = applyFeatureFlagIntent({ kind: "flag", id: FLAG, enabled });
  assert.equal(result.ok, true);
}

function fixture() {
  const registry = new Registry();
  cleanups.push(maintainScoutSessionCredentials(registry));
  const make = () => registry.registerSdkSession({
    id: `sdk:ask-${++serial}`, name: `Session ${serial}`, agent: "claude", cwd: home, agentSessionId: `native-${serial}`,
  });
  const asker = make(); const controller = make(); const target = make();
  const paths = [asker, controller, target].map((s) => sessionScoutCredentialPath(`session:${sessionScoutCredentialLocator(s.id)}`));
  cleanups.push(() => paths.forEach((path) => rmSync(path, { force: true })));
  const [askerCredential, controllerCredential] = paths.map((path) => readFileSync(path, "utf8").trim());
  const sdk = {
    ...unexpectedActiveSdkDelivery,
    send: async () => "started", sendWhenIdle: async () => "started" as const,
    interrupt: async () => "interrupted",
  } as unknown as import("../src/server/sdk/supervisor.ts").SdkSupervisor;
  const reviews = new ReviewManager(registry);
  const pending = new PendingTurnManager(registry, sdk, { idleSettleMs: 60_000 });
  pending.start(); cleanups.push(() => pending.stop());
  const queues = new QueueManager(registry);
  // Stands in for the shell's private channel: a click is armed only by writing this map,
  // which nothing reachable over HTTP can do, and is consumed by the first ask naming it.
  const clicks = new Map<string, { sessionId: string; enabled: boolean }>();
  const consumed: string[] = [];
  // `holdAuthorization` parks the next private-channel ask until released, the way the real
  // shell's reply arrives after a round trip, so a test can move the ask while it is in flight.
  let held: { entered: () => void; release: Promise<void> } | null = null;
  const holdAuthorization = () => {
    let entered!: () => void; let release!: () => void;
    const inFlight = new Promise<void>((resolve) => { entered = resolve; });
    held = { entered, release: new Promise<void>((resolve) => { release = resolve; }) };
    return { inFlight, release };
  };
  const authorizeSessionControl = async (input: { requestId: string; sessionId: string; enabled: boolean }) => {
    consumed.push(input.requestId);
    const hold = held; held = null;
    if (hold) { hold.entered(); await hold.release; }
    const click = clicks.get(input.requestId); clicks.delete(input.requestId);
    return click?.sessionId === input.sessionId && click?.enabled === input.enabled;
  };
  const app = buildApp({
    registry, reviews, queues, tasks: {} as import("../src/server/tasks.ts").TaskManager,
    sdkSessions: sdk, pendingTurns: pending, authorizeSessionControl,
  });
  const headers = { host: "localhost", "content-type": "application/json" };
  const agentHeaders = (credential = askerCredential!) => ({ ...headers, "x-harness-token": ensureToken(), "x-mission-scout-credential": credential });
  const call = (path: string, body?: unknown, auth: Record<string, string> = headers, method = "POST") =>
    app.request(path, { method, headers: auth, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const ask = async (reason = "I need to answer the blocked reviewer session", credential = askerCredential!) => {
    const response = await call("/mcp/session-control/requests", { reason }, agentHeaders(credential));
    return { status: response.status, body: await response.json() as SessionControlRequestResult & { error?: string } };
  };
  const wait = (id: string, credential = askerCredential!) =>
    call(`/mcp/session-control/requests/${id}/wait`, undefined, agentHeaders(credential), "GET");
  /** The card's Accept: a click armed through the private channel, then the existing grant. */
  const accept = (controlRequestId: string, armed = true, sessionId = asker.id) => {
    const requestId = randomUUID();
    if (armed) clicks.set(requestId, { sessionId, enabled: true });
    return { requestId, response: call(`/api/sessions/${sessionId}/session-control`, { enabled: true, requestId, controlRequestId }, headers, "PUT") };
  };
  const decline = (requestId: string, auth: Record<string, string> = headers) =>
    call(`/api/sessions/${asker.id}/session-control/requests/${requestId}/decline`, undefined, auth);
  return { registry, reviews, asker, controller, target, askerCredential: askerCredential!, controllerCredential: controllerCredential!,
    clicks, consumed, holdAuthorization, call, ask, wait, accept, decline, headers, agentHeaders };
}

test("with the preview flag off, no session can ask and the card has nothing to draw", async () => {
  setFlag(false);
  const f = fixture();
  const raised = await f.ask();
  assert.equal(raised.status, 404);
  assert.equal(raised.body.error, "This feature is disabled.");
  assert.equal(f.registry.getSession(f.asker.id)?.sessionControlRequest ?? null, null);
  assert.equal((await f.decline(randomUUID())).status, 404);
});

test("only the verified session asks for itself; the ask is drawn on that session and grants nothing", async () => {
  setFlag(true);
  const f = fixture();
  const unauthenticated = await f.call("/mcp/session-control/requests", { reason: "let me in" }, f.headers);
  assert.equal(unauthenticated.status, 401);
  const tokenOnly = await f.call("/mcp/session-control/requests", { reason: "let me in" }, { ...f.headers, "x-harness-token": ensureToken() });
  assert.equal(tokenOnly.status, 403, "the machine token alone names no caller");
  assert.equal((await f.ask("let me in", "forged.credential")).status, 403);
  assert.equal((await f.ask("   ")).status, 400, "a blank reason is refused");

  const first = await f.ask("Read the reviewer session and answer its open question");
  assert.equal(first.status, 200);
  assert.equal(first.body.status, "pending");
  const drawn = f.registry.getSession(f.asker.id)?.sessionControlRequest;
  assert.equal(drawn?.id, first.body.id);
  assert.equal(drawn?.reason, "Read the reviewer session and answer its open question");
  assert.equal(f.registry.sessionControlEnabled(f.asker.id), false);
  assert.equal(f.registry.pendingReviews(f.asker.id).length, 0, "an ask is never a review");

  const again = await f.ask("A different reason the operator never read");
  assert.equal(again.body.id, first.body.id, "a repeated call rejoins the same ask");
  assert.equal(f.registry.getSession(f.asker.id)?.sessionControlRequest?.reason, "Read the reviewer session and answer its open question");

  const other = await f.wait(first.body.id, f.controllerCredential);
  assert.equal(other.status, 404, "another session cannot read this session's ask");
});

test("a reason is accepted at the length limit and refused one character past it, raising nothing", async () => {
  setFlag(true);
  const f = fixture();
  const over = await f.ask("r".repeat(SESSION_CONTROL_REQUEST_REASON_MAX + 1));
  assert.equal(over.status, 400);
  assert.equal(f.registry.getSession(f.asker.id)?.sessionControlRequest ?? null, null, "a refused reason raises no ask");
  const atLimit = "r".repeat(SESSION_CONTROL_REQUEST_REASON_MAX);
  const accepted = await f.ask(atLimit);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.status, "pending");
  assert.equal(f.registry.getSession(f.asker.id)?.sessionControlRequest?.reason, atLimit);
});

test("no tool, agent, review answer or controlling session can accept an ask", async () => {
  setFlag(true);
  const f = fixture();
  const { body: raised } = await f.ask();
  const put = (body: unknown, extra: Record<string, string> = {}) =>
    f.call(`/api/sessions/${f.asker.id}/session-control`, body, { ...f.headers, ...extra }, "PUT");

  // The grant with the ask named but no private click: headerless, forged human, token, credential.
  assert.equal((await put({ enabled: true, controlRequestId: raised.id })).status, 403);
  assert.equal((await put({ enabled: true, requestId: randomUUID(), controlRequestId: raised.id },
    { origin: "http://localhost", "x-mission-operation-actor": "human" })).status, 403);
  for (const extra of [
    { "x-harness-token": ensureToken() } as Record<string, string>,
    { "x-mission-scout-credential": f.askerCredential },
    { "x-mission-operation-actor": "agent" },
    { origin: "https://example.com" },
  ]) {
    // A genuinely armed click, so only the caller's own headers can be what refuses it.
    const requestId = randomUUID();
    f.clicks.set(requestId, { sessionId: f.asker.id, enabled: true });
    const response = await put({ enabled: true, requestId, controlRequestId: raised.id }, extra);
    assert.equal(response.status, 403, JSON.stringify(extra));
    assert.equal(f.consumed.includes(requestId), false, "refused before the private channel is asked");
    f.clicks.delete(requestId);
  }

  // The review channel: there is no review, so neither a body-asserted human nor Foreman answers it.
  for (const by of ["human", "foreman"]) {
    const answered = await f.call(`/api/reviews/${raised.id}/resolve`, { action: "approve", by });
    assert.equal(answered.status, 404, by);
  }

  // A session already holding control has no action that accepts, and cannot pass the ask off as a review.
  const controllerClick = randomUUID();
  f.clicks.set(controllerClick, { sessionId: f.controller.id, enabled: true });
  assert.equal((await f.call(`/api/sessions/${f.controller.id}/session-control`, { enabled: true, requestId: controllerClick }, f.headers, "PUT")).status, 200);
  const act = (command: unknown) => f.call("/mcp/session-control/act", { sessionId: f.asker.id, command }, f.agentHeaders(f.controllerCredential));
  assert.equal((await act({ action: "resolve_review", reviewId: raised.id, resolution: { action: "approve" } })).status, 404);
  assert.equal((await act({ action: "accept_session_control", requestId: raised.id })).status, 400);

  // The agent's own Decline is refused too; only the operator's surface removes the ask.
  assert.equal((await f.decline(raised.id, f.agentHeaders())).status, 403);

  assert.equal(f.registry.sessionControlEnabled(f.asker.id), false);
  assert.equal(f.registry.getSession(f.asker.id)?.sessionControlRequest?.id, raised.id, "the ask is still waiting on the operator");
});

test("the operator's private click on Accept grants the asking session and answers its wait", async () => {
  setFlag(true);
  const f = fixture();
  const { body: raised } = await f.ask();
  const waiting = f.wait(raised.id);
  const { requestId, response } = f.accept(raised.id);
  assert.equal((await response).status, 200);
  assert.ok(f.consumed.includes(requestId), "the grant went through the private channel");
  assert.equal(f.registry.sessionControlEnabled(f.asker.id), true);
  assert.equal(f.registry.getSession(f.asker.id)?.sessionControlRequest ?? null, null, "the card is gone");
  assert.deepEqual(await (await waiting).json(), { id: raised.id, status: "granted" });
  assert.equal((await f.call("/mcp/session-control/read", {}, f.agentHeaders())).status, 200, "the granted session can now read others");

  const replay = f.accept(raised.id);
  assert.equal((await replay.response).status, 409, "an answered ask cannot be accepted twice");
  assert.equal(f.consumed.includes(replay.requestId), false, "a refused ask does not spend the click");
  const already = await f.ask();
  assert.equal(already.body.status, "granted", "a session that holds the grant is answered at once");
});

test("Decline answers the wait, and a declined or unknown ask cannot be accepted", async () => {
  setFlag(true);
  const f = fixture();
  const { body: raised } = await f.ask();
  const waiting = f.wait(raised.id);
  assert.equal((await f.decline(raised.id)).status, 200);
  assert.deepEqual(await (await waiting).json(), { id: raised.id, status: "declined" });
  assert.equal(f.registry.getSession(f.asker.id)?.sessionControlRequest ?? null, null);
  assert.equal((await f.decline(raised.id)).status, 409);
  for (const id of [raised.id, randomUUID()]) {
    const late = f.accept(id);
    assert.equal((await late.response).status, 409);
    assert.equal(f.consumed.includes(late.requestId), false);
  }
  const revoke = f.call(`/api/sessions/${f.asker.id}/session-control`, { enabled: false, requestId: randomUUID(), controlRequestId: randomUUID() }, f.headers, "PUT");
  assert.equal((await revoke).status, 400, "an ask can only be accepted, never used to revoke");
  assert.equal(f.registry.sessionControlEnabled(f.asker.id), false);
});

test("an ask declined or expired while its click is being authorized refuses the grant", async () => {
  setFlag(true);
  // Declined in another window mid-flight: the conversation never changed, so only the ask's
  // own re-check after authorization stands between the in-flight click and a grant.
  const declined = fixture();
  const { body: first } = await declined.ask();
  const declinedHold = declined.holdAuthorization();
  const inFlight = declined.accept(first.id);
  await declinedHold.inFlight;
  assert.equal((await declined.decline(first.id)).status, 200);
  declinedHold.release();
  const refused = await inFlight.response;
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: "This session is no longer asking for control" });
  assert.ok(declined.consumed.includes(inFlight.requestId), "the click was consumed before the ask moved");
  assert.equal(declined.registry.sessionControlEnabled(declined.asker.id), false);
  assert.equal(declined.registry.getSession(declined.asker.id)?.sessionControlEnabled, false);

  // Expired mid-flight by the preview turning off: same refusal, still no grant.
  const expired = fixture();
  const { body: second } = await expired.ask();
  const expiredHold = expired.holdAuthorization();
  const pending = expired.accept(second.id);
  await expiredHold.inFlight;
  setFlag(false);
  expiredHold.release();
  assert.equal((await pending.response).status, 409);
  assert.equal(expired.registry.sessionControlEnabled(expired.asker.id), false);
  setFlag(true);
});

test("a long-poll round that times out answers pending and keeps the card, then reports the settled ask", async () => {
  setFlag(true);
  const registry = new Registry();
  const asker = registry.registerSdkSession({ id: `sdk:ask-${++serial}`, name: "Asker", agent: "claude", cwd: home, agentSessionId: `native-${serial}` });
  const asks = new SessionControlRequests(registry, () => true);
  cleanups.push(() => asks.stop());
  const raised = asks.request(asker.id, "Steer the reviewer session");
  assert.equal(raised.status, "pending");

  const started = Date.now();
  assert.deepEqual(await asks.wait(asker.id, raised.id, 30), { id: raised.id, status: "pending" });
  assert.ok(Date.now() - started >= 25, "the round waited for its timeout rather than answering at once");
  assert.equal(registry.getSession(asker.id)?.sessionControlRequest?.id, raised.id, "a timed-out round leaves the card up");

  // The next round is woken by the decision, well before its own timeout.
  const nextRound = asks.wait(asker.id, raised.id, 60_000);
  assert.equal(asks.decline(asker.id, raised.id), true);
  assert.deepEqual(await nextRound, { id: raised.id, status: "declined" });
  assert.equal(registry.getSession(asker.id)?.sessionControlRequest ?? null, null);
  assert.deepEqual(await asks.wait(asker.id, raised.id, 60_000), { id: raised.id, status: "declined" }, "a late round reads the settled answer at once");
});

test("granting from the session control menu also answers a pending ask", async () => {
  setFlag(true);
  const f = fixture();
  const { body: raised } = await f.ask();
  const requestId = randomUUID();
  f.clicks.set(requestId, { sessionId: f.asker.id, enabled: true });
  assert.equal((await f.call(`/api/sessions/${f.asker.id}/session-control`, { enabled: true, requestId }, f.headers, "PUT")).status, 200);
  assert.deepEqual(await (await f.wait(raised.id)).json(), { id: raised.id, status: "granted" });
});

test("a replaced conversation, an ended session or the flag turning off expires the ask without granting", async () => {
  setFlag(true);
  const reassigned = fixture();
  const { body: first } = await reassigned.ask();
  reassigned.registry.upsertTask(mkTask({ id: `assignment-${serial}`, sessionId: reassigned.asker.id, status: "running", repoRoot: home, worktreePath: home }));
  assert.equal(reassigned.registry.getSession(reassigned.asker.id)?.sessionControlRequest ?? null, null);
  const stale = reassigned.accept(first.id);
  assert.equal((await stale.response).status, 409, "a card from the old conversation cannot grant the new one");
  assert.equal(reassigned.registry.sessionControlEnabled(reassigned.asker.id), false);

  const ended = fixture();
  const { body: second } = await ended.ask();
  const waiting = ended.wait(second.id);
  ended.registry.applyDriverEvent(ended.asker.id, { kind: "exited", reason: "finished", resumable: false });
  const settled = await (await waiting).json();
  assert.equal(settled.status, "expired");
  assert.equal(settled.detail, SESSION_CONTROL_REQUEST_EXPIRED.ended);

  const disabled = fixture();
  const { body: third } = await disabled.ask();
  const parked = disabled.wait(third.id);
  setFlag(false);
  const withdrawn = await (await parked).json();
  assert.deepEqual(withdrawn, { id: third.id, status: "expired", detail: SESSION_CONTROL_REQUEST_EXPIRED.disabled });
  assert.equal(disabled.registry.getSession(disabled.asker.id)?.sessionControlRequest ?? null, null, "the card is withdrawn at once");
  assert.equal((await disabled.wait(third.id)).status, 404, "the wait route is gated like every other entry point");
  setFlag(true);
  assert.equal((await disabled.wait(third.id)).status, 200);
  assert.equal(disabled.registry.getSession(disabled.asker.id)?.sessionControlRequest ?? null, null, "turning it back on resurrects nothing");
  const late = disabled.accept(third.id);
  assert.equal((await late.response).status, 409);
  assert.equal(disabled.registry.sessionControlEnabled(disabled.asker.id), false);
});
