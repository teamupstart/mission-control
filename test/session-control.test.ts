import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import type { SessionControlAction } from "../src/shared/protocol.ts";
import type { SessionRequestAnswer } from "../src/server/harness/types.ts";
import { unexpectedActiveSdkDelivery } from "./helpers/pending-turn-sender.ts";
import { mkTask } from "./helpers/session-fixture.ts";

const home = mkdtempSync(join(tmpdir(), "mission-session-control-"));
process.env.MISSION_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { PendingTurnManager } = await import("../src/server/pending-turns.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const { maintainScoutSessionCredentials } = await import("../src/server/scouts/session-credentials.ts");
const { sessionScoutCredentialLocator, provisionSessionScoutCredential } = await import("../src/server/scouts/submission-auth.ts");
const { sessionScoutCredentialPath } = await import("../src/shared/harness-runtime.mjs");
const {
  loadHumanResolvedReviews, loadConversationResolvedReviews, createPendingTurn, listPendingTurns,
  claimNextPendingTurn, markPendingTurnUncertain,
} = await import("../src/server/db.ts");
const { upsertSdkSession, getSdkSession } = await import("../src/server/sdk/store.ts");
const { sessionController } = await import("../src/server/session-control.ts");
const { reviewToolResult } = await import("../src/shared/review-item.ts");
const { originOf } = await import("../src/server/injections.ts");
const cleanups: Array<() => void> = [];
after(() => { for (const cleanup of cleanups) cleanup(); rmSync(home, { recursive: true, force: true }); });
let serial = 0;

function fixture(authorizeOverride?: import("../src/server/session-control-authorization.ts").AuthorizeSessionControl) {
  const registry = new Registry();
  cleanups.push(maintainScoutSessionCredentials(registry));
  const make = () => registry.registerSdkSession({ id: `sdk:control-${++serial}`, name: `Session ${serial}`, agent: "claude", cwd: home, agentSessionId: `native-${serial}` });
  const caller = make(); const target = make(); const other = make();
  const paths = [caller, target, other].map((s) => sessionScoutCredentialPath(`session:${sessionScoutCredentialLocator(s.id)}`));
  cleanups.push(() => paths.forEach((path) => rmSync(path, { force: true })));
  const credential = readFileSync(paths[0]!, "utf8").trim();
  const messages: Array<{ id: string; text: string }> = [];
  const interrupts: string[] = [];
  const modes: string[] = [];
  const models: Array<{ id: string; model: string }> = [];
  const efforts: Array<{ id: string; effort: string }> = [];
  const answers: Array<{ id: string; requestId: string; answer: SessionRequestAnswer }> = [];
  const sdk = {
    ...unexpectedActiveSdkDelivery,
    send: async (id: string, input: { text: string }, guard?: () => string | null) => {
      assert.equal(guard?.() ?? null, null);
      messages.push({ id, text: input.text }); return "started";
    },
    sendWhenIdle: async () => "started" as const,
    interrupt: async (id: string) => { interrupts.push(id); return "interrupted"; },
    setPermissionMode: async (_id: string, mode: string) => { modes.push(mode); },
    setModel: async (id: string, model: string) => { models.push({ id, model }); },
    setEffort: async (id: string, effort: string) => { efforts.push({ id, effort }); },
    answer: async (id: string, requestId: string, answer: SessionRequestAnswer) => {
      answers.push({ id, requestId, answer });
      registry.applyDriverEvent(id, { kind: "request_resolved", requestId });
    },
  } as unknown as import("../src/server/sdk/supervisor.ts").SdkSupervisor;
  const reviews = new ReviewManager(registry);
  const pending = new PendingTurnManager(registry, sdk, { idleSettleMs: 60_000 });
  pending.start(); cleanups.push(() => pending.stop());
  reviews.startContinuationRecovery((review, text) => pending.submitReviewContinuation(review.id, review.sessionId, text).ok);
  const queues = new QueueManager(registry);
  const clicks = new Map<string, { sessionId: string; enabled: boolean }>();
  const authorizeSessionControl = authorizeOverride ?? (async (input) => {
    const click = clicks.get(input.requestId); clicks.delete(input.requestId);
    return click?.sessionId === input.sessionId && click?.enabled === input.enabled;
  });
  const app = buildApp({ registry, reviews, queues, tasks: {} as import("../src/server/tasks.ts").TaskManager, sdkSessions: sdk, pendingTurns: pending, authorizeSessionControl });
  const headers = { host: "localhost", "content-type": "application/json" };
  const agentHeaders = { ...headers, "x-harness-token": ensureToken(), "x-mission-scout-credential": credential };
  const request = (path: string, body: unknown, auth: Record<string, string> = agentHeaders, method = "POST") => app.request(path, { method, headers: auth, body: JSON.stringify(body) });
  const grant = (enabled: boolean) => {
    const requestId = randomUUID(); clicks.set(requestId, { sessionId: caller.id, enabled });
    return request(`/api/sessions/${caller.id}/session-control`, { enabled, requestId }, headers, "PUT");
  };
  const act = (command: SessionControlAction, sessionId = target.id) => request("/mcp/session-control/act", { sessionId, command });
  return { registry, caller, target, other, credential, messages, interrupts, modes, models, efforts, answers, sdk, reviews, pending, request, grant, act, headers, agentHeaders, clicks };
}

test("a headerless local caller cannot enable its own session-control grant", async () => {
  const f = fixture();
  const response = await f.request(`/api/sessions/${f.caller.id}/session-control`, { enabled: true }, f.headers, "PUT");
  assert.equal(response.status, 403);
  assert.equal(f.registry.sessionControlEnabled(f.caller.id), false);
  const forged = await f.request(`/api/sessions/${f.caller.id}/session-control`, { enabled: true, requestId: randomUUID() }, {
    ...f.headers, origin: "http://localhost", "x-mission-operation-actor": "human",
  }, "PUT");
  assert.equal(forged.status, 403);
  assert.equal(f.registry.sessionControlEnabled(f.caller.id), false);
});

test("a private click is bound to its session and setting and is consumed once", async () => {
  const f = fixture();
  const put = (id: string, enabled: boolean, requestId: string) => f.request(`/api/sessions/${id}/session-control`, { enabled, requestId }, f.headers, "PUT");
  for (const [id, enabled] of [[f.other.id, true], [f.caller.id, false]] as const) {
    const requestId = randomUUID(); f.clicks.set(requestId, { sessionId: f.caller.id, enabled: true });
    assert.equal((await put(id, enabled, requestId)).status, 403);
  }
  const requestId = randomUUID(); f.clicks.set(requestId, { sessionId: f.caller.id, enabled: true });
  assert.equal((await put(f.caller.id, true, requestId)).status, 200);
  assert.equal((await f.grant(false)).status, 200);
  assert.equal((await put(f.caller.id, true, requestId)).status, 403);
  assert.equal(f.registry.sessionControlEnabled(f.caller.id), false);
});

test("a conversation replaced while desktop authorization is pending cannot inherit the click", async () => {
  let confirm!: (value: boolean) => void;
  const f = fixture(() => new Promise((resolve) => { confirm = resolve; }));
  const granting = f.grant(true);
  while (!confirm) await delay(1);
  f.registry.beginSessionReset(f.caller.id);
  f.registry.endSessionReset(f.caller.id);
  const newId = `${f.caller.agentSessionId}-replacement`;
  f.registry.applyDriverEvent(f.caller.id, { kind: "bound", agentSessionId: newId, transcriptPath: null, modelId: null, pid: null });
  confirm(true);
  assert.equal((await granting).status, 409);
  assert.equal(f.registry.sessionControlEnabled(f.caller.id), false);
});

test("control is off for every session, cannot be self-granted, and revocation is immediate", async () => {
  const f = fixture();
  assert.equal(f.registry.sessionControlEnabled(f.caller.id), false);
  assert.equal((await f.act({ action: "message", text: "must not send" })).status, 403);
  assert.equal((await f.request(`/api/sessions/${f.caller.id}/session-control`, { enabled: true }, f.agentHeaders, "PUT")).status, 403);
  assert.equal((await f.grant(true)).status, 200);
  assert.equal(f.registry.getSession(f.caller.id)?.sessionControlEnabled, true);
  assert.equal(f.registry.getSession(f.target.id)?.sessionControlEnabled, false);
  assert.equal((await f.act({ action: "message", text: "delegated\nmessage" })).status, 200);
  assert.deepEqual(f.messages, [{ id: f.target.id, text: "delegated\nmessage" }]);
  assert.equal(originOf(f.target.id, "delegated\nmessage"), "session");
  assert.equal((await f.grant(false)).status, 200);
  assert.equal((await f.act({ action: "message", text: "revoked" })).status, 403);
  assert.equal(f.messages.length, 1);
});

test("shared machine token, claimed ids, forged signatures and stale episodes do not grant control", async () => {
  const f = fixture(); await f.grant(true);
  assert.equal((await f.request("/mcp/session-control/read", {}, { ...f.agentHeaders, "x-mission-scout-credential": "" })).status, 403);
  assert.equal((await f.request("/mcp/session-control/read", {}, { ...f.agentHeaders, "x-harness-token": "wrong" })).status, 401);
  assert.equal(sessionController(f.registry, f.credential + "tamper"), null);
  assert.equal((await f.request("/mcp/session-control/act", { sessionId: f.target.id, callerId: f.caller.id, command: { action: "interrupt" } })).status, 400);
  const stalePaths = provisionSessionScoutCredential({ sessionId: f.caller.id, taskId: null, episodeId: "old", cwd: home, pid: f.caller.pid, agentSessionId: f.caller.agentSessionId });
  assert.equal(sessionController(f.registry, readFileSync(stalePaths[0]!, "utf8").trim()), null);
  assert.deepEqual(f.interrupts, []);
});

test("reset and daemon replacement revoke the grant without inheriting it", async () => {
  const f = fixture(); await f.grant(true);
  f.registry.beginSessionReset(f.caller.id);
  assert.equal(f.registry.getSession(f.caller.id)?.sessionControlEnabled, false);
  f.registry.endSessionReset(f.caller.id);
  assert.equal((await f.act({ action: "interrupt" })).status, 403);
  await f.grant(true);
  const restored = new Registry();
  restored.registerSdkSession({ id: f.caller.id, name: "restored", agent: "claude", cwd: home, agentSessionId: f.caller.agentSessionId });
  assert.equal(restored.sessionControlEnabled(f.caller.id), false);
});

test("assigning a different task does not carry a controller grant into the new episode", async () => {
  const f = fixture(); await f.grant(true);
  f.registry.upsertTask(mkTask({ id: `assignment-${serial}`, sessionId: f.caller.id, status: "running", repoRoot: home, worktreePath: home }));
  assert.equal(sessionController(f.registry, f.credential), null);
  assert.equal(f.registry.sessionControlEnabled(f.caller.id), false);
  assert.equal(f.registry.getSession(f.caller.id)?.sessionControlEnabled, false);
});

test("reads expose target state and pending reviews; unknown, self, stopping and exited targets disclose nothing", async () => {
  const f = fixture(); await f.grant(true);
  const review = f.reviews.create(f.target.id, "input", "Choose", "Which option?");
  const read = await f.request("/mcp/session-control/read", { sessionId: f.target.id });
  assert.equal(read.status, 200);
  const body = await read.json(); assert.equal(body.session.id, f.target.id); assert.equal(body.reviews[0].id, review.id);
  assert.equal(Object.hasOwn(body, "transcript"), false);
  const listed = await f.request("/mcp/session-control/read", {});
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).sessions.map((s: { id: string }) => s.id).sort(), [f.target.id, f.other.id].sort());
  f.registry.markSessionStopping(f.target.id);
  f.registry.applyDriverEvent(f.other.id, { kind: "exited", reason: "finished", resumable: false });
  assert.equal(f.registry.getSession(f.other.id)?.state, "exited");
  for (const sessionId of ["missing", f.caller.id, f.target.id, f.other.id]) {
    for (const transcript of [false, true]) {
      const refused = await f.request("/mcp/session-control/read", { sessionId, transcript });
      assert.equal(refused.status, 404, `${sessionId}, transcript=${transcript}`);
      assert.deepEqual(await refused.json(), { error: "No such other live session" });
    }
    assert.equal((await f.act({ action: "interrupt" }, sessionId)).status, 404);
  }
  const filtered = await f.request("/mcp/session-control/read", {});
  assert.equal(filtered.status, 200);
  assert.deepEqual(await filtered.json(), { sessions: [] });
});

test("optional transcript reads return the target's opening turns and bounded recent conversation", async () => {
  const f = fixture(); await f.grant(true);
  const transcriptPath = join(home, `transcript-${serial}.jsonl`);
  // The existing reader returns small files whole. Cross its byte window so the
  // endpoint's requested tail count is actually exercised instead of that fast path.
  const textFor = (i: number) => `Target turn ${i}: ${"x".repeat(1000)}`;
  writeFileSync(transcriptPath, Array.from({ length: 900 }, (_, i) => JSON.stringify({
    type: "user", uuid: `turn-${i}`, timestamp: new Date(1_000 * i).toISOString(),
    message: { role: "user", content: textFor(i) },
  })).join("\n") + "\n");
  f.registry.applyDriverEvent(f.target.id, {
    kind: "bound", agentSessionId: f.target.agentSessionId!, transcriptPath, modelId: null, pid: null,
  });
  const response = await f.request("/mcp/session-control/read", { sessionId: f.target.id, transcript: true });
  assert.equal(response.status, 200);
  const { session, transcript } = await response.json();
  assert.equal(session.id, f.target.id);
  const expected = [...Array.from({ length: 12 }, (_, i) => i), ...Array.from({ length: 20 }, (_, i) => i + 880)];
  assert.deepEqual(transcript.messages.map((m: { id: string }) => m.id), expected.map((i) => `turn-${i}`));
  assert.deepEqual(transcript.messages.map((m: { text: string }) => m.text), expected.map(textFor));
  assert.equal(transcript.truncated, true);
  assert.equal(transcript.headCount, 12);
});

test("review answers preserve delegation, ownership, structured choices and continuation delivery", async () => {
  const f = fixture(); await f.grant(true);
  const review = f.reviews.create(f.target.id, "input", "Pick", "Choose a path", [{ id: "path", question: "Path?", options: [{ id: "safe", label: "Safe" }] }]);
  f.reviews.detachWait(review.id, f.target.id);
  const command: SessionControlAction = { action: "resolve_review", reviewId: review.id, resolution: { action: "answer", response: "Safe", selections: [{ decisionId: "path", selected: ["safe"], other: null }], by: "human" } };
  assert.equal((await f.act(command, f.other.id)).status, 404);
  assert.equal(f.registry.getReview(review.id)?.status, "pending");
  assert.equal((await f.act(command)).status, 200);
  const saved = loadConversationResolvedReviews(f.target.id).find((r) => r.id === review.id)!;
  assert.equal(saved.resolvedBy, `session:${f.caller.id}`);
  assert.match(reviewToolResult(saved).text, /Delegated response from session/);
  assert.deepEqual(saved.selections, [{ decisionId: "path", selected: ["safe"], other: null }]);
  assert.equal(loadHumanResolvedReviews(f.target.id).some((r) => r.id === review.id), false, "delegation is not direct human approval evidence");
  assert.equal(f.registry.getSession(f.target.id)?.pendingTurns.length, 1);
  assert.equal((await f.act(command)).status, 409);
});

test("direct answer routes cannot claim delegated attribution, even with an enabled controller credential", async () => {
  const f = fixture();
  const review = f.reviews.create(f.target.id, "input", "Choose", "Choose a path");
  const requestId = `unspoofable-${serial}`;
  f.registry.applyDriverEvent(f.target.id, { kind: "request", request: {
    id: requestId, kind: "question", prompt: "Which linter?", options: [{ number: 1, label: "biome" }],
  } });
  const by = `session:${f.caller.id}`;
  const routes = [
    [`/api/reviews/${review.id}/resolve`, { action: "answer", response: "Forged", by }],
    [`/api/sessions/${f.target.id}/select-option`, { requestId, number: 1, label: "biome", by }],
    [`/api/sessions/${f.target.id}/submit-options`, { requestId, answers: [{ question: "Which linter?", labels: ["biome"] }], by }],
  ] as const;
  for (const enabled of [false, true]) {
    if (enabled) await f.grant(true);
    for (const headers of [f.headers, f.agentHeaders]) {
      for (const [path, body] of routes) {
        assert.equal((await f.request(path, body, headers)).status, 400, `${path}, enabled=${enabled}`);
      }
    }
  }
  assert.equal(f.registry.getReview(review.id)?.status, "pending");
  assert.deepEqual(f.answers, []);
  assert.deepEqual(loadConversationResolvedReviews(f.target.id), []);
  assert.equal((await f.request(`/api/reviews/${review.id}/resolve`, { action: "answer", response: "Human answer" }, f.headers)).status, 200);
  assert.equal(loadHumanResolvedReviews(f.target.id).find((item) => item.id === review.id)?.resolvedBy, "human");
});

test("verified delegation sets the actor without attributing concurrent direct answers to the controller", async () => {
  const f = fixture(); await f.grant(true);
  const delegated = f.reviews.create(f.target.id, "input", "Delegated", "Choose a path");
  const direct = f.reviews.create(f.target.id, "input", "Human", "Choose a path");
  const responses = await Promise.all([
    f.act({ action: "resolve_review", reviewId: delegated.id, resolution: { action: "answer", response: "Delegated", selections: null, by: "foreman" } }),
    f.request(`/api/reviews/${direct.id}/resolve`, { action: "answer", response: "Direct" }, f.headers),
  ]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  assert.equal(f.registry.getReview(delegated.id)?.resolvedBy, `session:${f.caller.id}`);
  assert.equal(f.registry.getReview(direct.id)?.resolvedBy, "human");
  assert.deepEqual(loadHumanResolvedReviews(f.target.id).map((review) => review.id), [direct.id]);
});

test("interruption uses the existing runtime action and clears queued input", async () => {
  const f = fixture(); await f.grant(true);
  const key = f.target.agentSessionId!;
  createPendingTurn({ id: `queued-${serial}`, noteKey: key, text: "queued", now: 1 });
  f.registry.refreshPendingTurns(key);
  assert.equal((await f.act({ action: "interrupt" })).status, 200);
  assert.deepEqual(f.interrupts, [f.target.id]);
  assert.equal(listPendingTurns(key).length, 0);
});

test("queued input keeps revision guards and runtime permission changes use the existing handler", async () => {
  const f = fixture(); await f.grant(true);
  const id = `recall-${serial}`; const key = f.target.agentSessionId!;
  createPendingTurn({ id, noteKey: key, text: "editable", now: 1 }); f.registry.refreshPendingTurns(key);
  assert.equal((await f.act({ action: "pending_recall", turnId: id, revision: 9 })).status, 409);
  assert.equal((await f.act({ action: "pending_recall", turnId: id, revision: 0 })).status, 200);
  assert.equal(listPendingTurns(key).length, 0);
  assert.equal((await f.act({ action: "set_permission_mode", mode: "acceptEdits" })).status, 200);
  assert.deepEqual(f.modes, ["acceptEdits"]);
  assert.equal((await f.request("/mcp/session-control/act", { sessionId: f.target.id, command: { action: "reset" } })).status, 400);
});

test("work queue operations preserve item ownership and edit revisions", async () => {
  const f = fixture(); await f.grant(true);
  const added = await f.act({ action: "queue_add", intent: "First delegated work item" });
  assert.equal(added.status, 200);
  const item = await added.json();
  assert.equal((await f.act({ action: "queue_edit", itemId: item.id, intent: "Revised intent", revision: item.revision + 1 })).status, 409);
  assert.equal((await f.act({ action: "queue_edit", itemId: item.id, intent: "Revised intent", revision: item.revision })).status, 200);
  assert.equal((await f.act({ action: "queue_remove", itemId: item.id }, f.other.id)).status, 404);
  assert.equal(f.registry.getQueueItem(item.id)?.intent, "Revised intent");
  assert.equal((await f.act({ action: "queue_remove", itemId: item.id })).status, 200);
  assert.equal(f.registry.getQueueItem(item.id), undefined);
});

test("single-option answers reach the target driver and refuse stale requests or mismatched labels", async () => {
  const f = fixture(); await f.grant(true);
  const requestId = `choice-${serial}`;
  f.registry.applyDriverEvent(f.target.id, { kind: "request", request: {
    id: requestId, kind: "question", prompt: "Which linter?",
    options: [{ number: 1, label: "biome" }, { number: 2, label: "eslint" }],
  } });
  assert.equal((await f.act({ action: "select_option", requestId: "stale", number: 1, label: "biome" })).status, 409);
  assert.equal((await f.act({ action: "select_option", requestId, number: 1, label: "eslint" })).status, 409);
  assert.deepEqual(f.answers, []);
  assert.deepEqual(loadConversationResolvedReviews(f.target.id), []);
  assert.equal((await f.act({ action: "select_option", requestId, number: 1, label: "biome" })).status, 200);
  assert.deepEqual(f.answers, [{ id: f.target.id, requestId, answer: { kind: "option", number: 1, label: "biome" } }]);
  assert.equal(f.registry.getSession(f.target.id)?.paneDialog, null);
  const saved = loadConversationResolvedReviews(f.target.id);
  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.resolvedBy, `session:${f.caller.id}`);
  assert.match(saved[0]!.response!, /biome/);
  assert.equal((await f.act({ action: "select_option", requestId, number: 1, label: "biome" })).status, 409);
  assert.equal(f.answers.length, 1);
});

test("delegated option selection requires the read prompt id even when a newer prompt has identical options", async () => {
  const f = fixture(); await f.grant(true);
  const oldId = `old-choice-${serial}`;
  const newId = `new-choice-${serial}`;
  const ask = (id: string) => f.registry.applyDriverEvent(f.target.id, { kind: "request", request: {
    id, kind: "question", prompt: "Continue?", options: [{ number: 1, label: "Yes" }],
  } });
  ask(oldId);
  const read = await f.request("/mcp/session-control/read", { sessionId: f.target.id });
  assert.equal((await read.json()).session.paneDialog.requestId, oldId);
  f.registry.applyDriverEvent(f.target.id, { kind: "request_resolved", requestId: oldId });
  ask(newId);
  assert.equal(f.registry.getSession(f.target.id)?.paneDialog?.requestId, newId);
  for (const requestId of [undefined, ""]) {
    const response = await f.request("/mcp/session-control/act", {
      sessionId: f.target.id, command: { action: "select_option", requestId, number: 1, label: "Yes" },
    });
    assert.equal(response.status, 400);
  }
  assert.equal((await f.act({ action: "select_option", requestId: oldId, number: 1, label: "Yes" })).status, 409);
  assert.deepEqual(f.answers, []);
  assert.equal(f.registry.getSession(f.target.id)?.paneDialog?.requestId, newId);
  assert.equal((await f.act({ action: "select_option", requestId: newId, number: 1, label: "Yes" })).status, 200);
  assert.deepEqual(f.answers, [{ id: f.target.id, requestId: newId, answer: { kind: "option", number: 1, label: "Yes" } }]);
});

test("pending delivery steers the selected text and refuses stale revisions or a covering prompt", async () => {
  const f = fixture(); await f.grant(true);
  f.registry.applyDriverEvent(f.target.id, { kind: "state", state: "working", activity: null });
  const row = f.pending.submit(f.target.id, "Steer the running task").pendingTurn!;
  const deliver: SessionControlAction = { action: "pending_deliver", turnId: row.id, revision: row.revision, delivery: "steer" };
  assert.equal((await f.act({ ...deliver, revision: row.revision + 1 })).status, 409);
  assert.equal((await f.act(deliver, f.other.id)).status, 409);
  f.registry.applyDriverEvent(f.target.id, { kind: "request", request: {
    id: "covering-prompt", kind: "permission", prompt: "Allow?", options: [{ number: 1, label: "Yes" }],
  } });
  assert.equal((await f.act(deliver)).status, 409);
  assert.deepEqual(listPendingTurns(f.target.agentSessionId!), [row]);
  assert.deepEqual(f.messages, []);
  f.registry.applyDriverEvent(f.target.id, { kind: "request_resolved", requestId: "covering-prompt" });
  f.registry.applyDriverEvent(f.target.id, { kind: "state", state: "working", activity: null });
  assert.equal((await f.act(deliver)).status, 200);
  const expedited = listPendingTurns(f.target.agentSessionId!)[0]!;
  assert.equal(expedited.deliveryMode, "steer");
  assert.equal(expedited.revision, row.revision + 1);
  // The manager drains on its next timer tick. Observe delivery, not just route acceptance.
  for (let attempt = 0; attempt < 100 && listPendingTurns(f.target.agentSessionId!).length; attempt++) await delay(10);
  assert.deepEqual(f.messages, [{ id: f.target.id, text: row.text }]);
  assert.deepEqual(listPendingTurns(f.target.agentSessionId!), []);
});

test("pending retry and resolution reconcile uncertain delivery with ownership, state and revision guards", async () => {
  const f = fixture(); await f.grant(true);
  f.registry.applyDriverEvent(f.target.id, { kind: "state", state: "working", activity: null });
  const key = f.target.agentSessionId!;
  const row = createPendingTurn({ id: `uncertain-${serial}`, noteKey: key, text: "Keep this instruction", now: 1 });
  f.registry.refreshPendingTurns(key);
  for (const action of ["pending_retry", "pending_resolve"] as const) {
    assert.equal((await f.act({ action, turnId: row.id, revision: row.revision })).status, 409, "a queued message is not uncertain");
  }
  const claimed = claimNextPendingTurn(key, 2)!;
  const uncertain = markPendingTurnUncertain(row.id, claimed.revision, "Delivery acknowledgement lost", 3)!;
  f.registry.refreshPendingTurns(key);
  for (const action of ["pending_retry", "pending_resolve"] as const) {
    assert.equal((await f.act({ action, turnId: row.id, revision: uncertain.revision + 1 })).status, 409);
    assert.equal((await f.act({ action, turnId: row.id, revision: uncertain.revision }, f.other.id)).status, 409);
    assert.deepEqual(listPendingTurns(key), [uncertain]);
  }
  assert.equal((await f.act({ action: "pending_retry", turnId: row.id, revision: uncertain.revision })).status, 200);
  const retried = listPendingTurns(key)[0]!;
  assert.equal(retried.id, row.id);
  assert.equal(retried.text, row.text);
  assert.equal(retried.state, "queued");
  assert.equal(retried.revision, uncertain.revision + 1);
  assert.equal(retried.lastError, null);
  assert.equal(retried.claimedAt, null);
  assert.deepEqual(f.registry.getSession(f.target.id)?.pendingTurns, [retried]);
  const reclaimed = claimNextPendingTurn(key, 4)!;
  const unresolved = markPendingTurnUncertain(row.id, reclaimed.revision, "Still unconfirmed", 5)!;
  f.registry.refreshPendingTurns(key);
  assert.equal((await f.act({ action: "pending_resolve", turnId: row.id, revision: unresolved.revision })).status, 200);
  assert.deepEqual(listPendingTurns(key), []);
  assert.deepEqual(f.registry.getSession(f.target.id)?.pendingTurns, []);
  assert.deepEqual(f.messages, [], "marking a message sent must not resend it");
});

test("queue approval requires a drafted proposal and reordering rejects another session's items", async () => {
  const f = fixture(); await f.grant(true);
  const firstResponse = await f.act({ action: "queue_add", intent: "First item" });
  const secondResponse = await f.act({ action: "queue_add", intent: "Second item" });
  const foreignResponse = await f.act({ action: "queue_add", intent: "Another session's item" }, f.other.id);
  for (const response of [firstResponse, secondResponse, foreignResponse]) assert.equal(response.status, 200);
  const first = await firstResponse.json(); const second = await secondResponse.json(); const foreign = await foreignResponse.json();
  assert.equal((await f.act({ action: "queue_approve", itemId: first.id })).status, 409);
  f.registry.putQueueItem({ ...f.registry.getQueueItem(first.id)!, state: "proposed" });
  assert.equal((await f.act({ action: "queue_approve", itemId: first.id })).status, 409, "no drafted text to approve");
  assert.equal(f.registry.getQueueItem(first.id)?.approvedAt, null);
  f.registry.putQueueItem({ ...f.registry.getQueueItem(first.id)!, proposedPayload: "Exact prompt to send" });
  assert.equal((await f.act({ action: "queue_approve", itemId: first.id }, f.other.id)).status, 404);
  assert.equal((await f.act({ action: "queue_approve", itemId: first.id })).status, 200);
  const approved = f.registry.getQueueItem(first.id)!;
  assert.equal(typeof approved.approvedAt, "number");
  assert.equal(approved.state, "proposed");
  assert.equal(approved.proposedPayload, "Exact prompt to send");
  assert.equal((await f.act({ action: "queue_reorder", ids: [second.id, foreign.id, first.id] })).status, 409);
  assert.deepEqual(f.registry.getQueue(f.target.id)?.items.map((item) => item.id), [first.id, second.id]);
  assert.equal((await f.act({ action: "queue_reorder", ids: [second.id, first.id] })).status, 200);
  assert.deepEqual(f.registry.getQueue(f.target.id)?.items.map((item) => item.id), [second.id, first.id]);
  assert.deepEqual(f.registry.getQueue(f.other.id)?.items.map((item) => item.id), [foreign.id]);
});

test("delegated renaming updates the live card and durable SDK row and refuses blank names", async () => {
  const f = fixture(); await f.grant(true);
  upsertSdkSession({
    id: f.target.id, agent: "claude", agentSessionId: f.target.agentSessionId, cwd: home,
    taskId: null, model: null, effort: null, permissionMode: null, status: "running", turnInProgress: false,
  });
  assert.equal((await f.act({ action: "rename", name: "Delegated task name" })).status, 200);
  assert.equal(f.registry.getSession(f.target.id)?.name, "Delegated task name");
  assert.equal(getSdkSession(f.target.id)?.displayName, "Delegated task name");
  assert.equal((await f.act({ action: "rename", name: "   " })).status, 400);
  assert.equal(f.registry.getSession(f.target.id)?.name, "Delegated task name");
  assert.equal(getSdkSession(f.target.id)?.displayName, "Delegated task name");
});

test("delegated model changes reach the target supervisor and surface driver refusals", async (t) => {
  const f = fixture(); await f.grant(true);
  assert.equal((await f.act({ action: "set_model", model: "claude-sonnet-5" })).status, 200);
  assert.deepEqual(f.models, [{ id: f.target.id, model: "claude-sonnet-5" }]);
  t.mock.method(f.sdk, "setModel", async () => { throw new Error("model unavailable"); });
  const refused = await f.act({ action: "set_model", model: "claude-opus-5" });
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { ok: false, error: "model unavailable" });
  assert.deepEqual(f.models, [{ id: f.target.id, model: "claude-sonnet-5" }]);
});

test("delegated effort changes publish the accepted level and preserve it when the driver refuses", async (t) => {
  const f = fixture(); await f.grant(true);
  const unready = await f.act({ action: "set_effort", effort: "max" });
  assert.equal(unready.status, 409);
  assert.match((await unready.json()).error, /baseline is not ready/);
  assert.deepEqual(f.efforts, []);
  const transcriptPath = join(home, `effort-${serial}.jsonl`);
  writeFileSync(transcriptPath, JSON.stringify({
    type: "assistant", uuid: "effort-baseline", timestamp: "2026-10-23T12:00:00.000Z",
    message: { model: "claude-opus-4-8", usage: { input_tokens: 10, output_tokens: 2 } },
  }) + "\n");
  f.registry.applyDriverEvent(f.target.id, {
    kind: "bound", agentSessionId: f.target.agentSessionId!, transcriptPath, modelId: "claude-opus-4-8", pid: null,
  });
  f.registry.applyRuntimeMeta(f.target.id, {
    modelId: "claude-opus-4-8", contextTokens: 1000, contextWindow: 200_000, contextPct: 1,
    longContext: false, thinkingLevel: "high", effortRevision: "effort-baseline",
  }, "transcript");
  assert.equal((await f.act({ action: "set_effort", effort: "max" })).status, 200);
  assert.deepEqual(f.efforts, [{ id: f.target.id, effort: "max" }]);
  assert.equal(f.registry.getSession(f.target.id)?.meta?.thinkingLevel, "max");
  assert.equal(f.registry.getSession(f.target.id)?.pendingEffort, null);
  t.mock.method(f.sdk, "setEffort", async () => { throw new Error("driver refused effort"); });
  const refused = await f.act({ action: "set_effort", effort: "high" });
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { ok: false, error: "driver refused effort", effort: null });
  assert.equal(f.registry.getSession(f.target.id)?.meta?.thinkingLevel, "max");
});
