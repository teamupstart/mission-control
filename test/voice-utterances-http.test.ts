import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SdkSupervisor } from "../src/server/sdk/supervisor.ts";
import type { HeardEntry, VoiceCard } from "../src/shared/voice-routing.ts";
import type { SpokenName } from "../src/shared/voice-names.ts";
import type { VoiceDecisionResult, VoiceQuestion } from "../src/shared/voice-decide.ts";

const home = mkdtempSync(join(tmpdir(), "mission-voice-routing-"));
process.env.MISSION_HOME = home;
const { buildApp } = await import("../src/server/routes.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { PendingTurnManager } = await import("../src/server/pending-turns.ts");
const { voiceStateStore, wireVoiceStateEvents } = await import("../src/server/voice/state.ts");
const { VOICE_REQUIRED_FLAGS, VOICE_LISTENER_PROTOCOL_VERSION } = await import("../src/shared/voice.ts");
const { applyFeatureFlagIntent } = await import("../src/server/feature-flags/index.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const { closeDb } = await import("../src/server/db.ts");
const token = ensureToken();
const registry = new Registry();
const interrupts: string[] = [];
const sdk = { interrupt: async (id: string) => { interrupts.push(id); return "idle"; } } as unknown as SdkSupervisor;
const pending = new PendingTurnManager(registry, sdk, { idleSettleMs: 60_000 });
// The model step, scripted: no provider is reached and no model is spawned. "Not sure" unless a
// test says otherwise.
let decide: (questions: readonly VoiceQuestion[]) => VoiceDecisionResult = (questions) =>
  ({ rung: "none", answers: questions.map(() => ({ choice: null, confidence: 0 })), detail: "scripted" });
const app = buildApp({ registry, pendingTurns: pending, sdkSessions: sdk, reviews: new ReviewManager(registry),
  tasks: new TaskManager(registry), queues: new QueueManager(registry),
  voiceDecider: { ask: async (questions) => decide(questions) } });
const resolved = (id: string) => registry.voiceRouter!.resolution(id) ?? Promise.resolve();
const cards: VoiceCard[] = [];
registry.subscribe((event) => { if (event.type === "voice_card") cards.push(event.card); });
const stop = wireVoiceStateEvents((state) => registry.emitVoiceState(state));
const post = (path: string, body: unknown = {}, auth?: string) => app.request(path, { method: "POST",
  headers: { host: "localhost", "content-type": "application/json", ...(auth ? { "x-harness-token": auth } : {}) },
  body: JSON.stringify(body) });
const capture = (text: string, id = String(randomUUID())) => ({ id, text, backend: "fluidaudio", capturedAt: Date.now() });
const say = (text: string, id?: string) => post("/voice/utterances", capture(text, id), token);
const readHeard = async () => (await (await app.request("/api/voice/heard", { headers: { host: "localhost" } })).json() as { entries: HeardEntry[] }).entries;
const act = (id: string, action: string, body?: unknown) => post(`/api/voice/cards/${id}/${action}`, body);
const name = (name: string): SpokenName => ({ key: "task:" + name, name, kind: "session", taskId: name,
  sessionId: "sdk:" + name, role: "", colorId: null, agent: "claude", state: "running" });
const roster = ["Steve", "Will", "Bill"].map(name);
for (const target of roster) registry.registerSdkSession({ id: target.sessionId!, agent: "claude", name: target.name, cwd: home, agentSessionId: target.key });
voiceStateStore.useRoster(() => roster);
pending.start();
const queued = (agent: string) => registry.getSession("sdk:" + agent)!.pendingTurns.map((row) => row.text);

beforeEach(async () => {
  for (const id of [...VOICE_REQUIRED_FLAGS, "voice"] as const) applyFeatureFlagIntent({ kind: "flag", id, enabled: true });
  await app.request("/api/voice/config", { method: "PUT", headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ muted: false, cancelWindow: { enabled: true, seconds: 1 } }) });
  const hello = await post("/voice/listener/hello", { backend: "fluidaudio", version: VOICE_LISTENER_PROTOCOL_VERSION,
    devices: [], microphone: "granted", modelLoaded: true }, token);
  assert.equal(hello.status, 200);
  cards.length = 0;
});
afterEach(() => { registry.voiceRouter!.reset(); });
after(() => { stop(); pending.stop(); closeDb(); rmSync(home, { recursive: true, force: true }); });

test("token and schema gates, muted drop, and push-to-talk acceptance", async () => {
  assert.equal((await post("/voice/utterances", capture("Steve hello"))).status, 401);
  assert.equal((await post("/voice/utterances", { ...capture("Steve hello"), words: [{ text: "x", startMs: 3, endMs: 1 }] }, token)).status, 400);
  await post("/api/voice/mute", { muted: true });
  assert.deepEqual(await (await say("Steve muted words")).json(), { accepted: false });
  assert.deepEqual(await readHeard(), []);
  await post("/api/voice/mute", { muted: false });
  await post("/voice/shell-report", { callActive: true, pushToTalk: true }, token);
  assert.equal(voiceStateStore.state().mode, "push-to-talk");
  assert.deepEqual(await (await say("Steve push to talk")).json(), { accepted: true });
});

test("turning voice off clears pending actions and gates every contract D route", async () => {
  await say("Steve stale", "disabled");
  applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: false });
  assert.equal(registry.voiceRouter!.pendingVoiceActions.length, 0);
  for (const response of [await say("hello"), await act("disabled", "pick"), await act("disabled", "cancel"),
    await act("disabled", "send-now"), ...await Promise.all(["GET", "DELETE"].map((method) =>
      app.request("/api/voice/heard", { method, headers: { host: "localhost" } })))]) assert.equal(response.status, 404);
});

test("a cancel retried after toggling voice cannot dismiss a new card", async () => {
  await say("Steve old message", "old");
  await say("Steve cancel this one", "cancelled");
  const cancel = capture("cancel", "original-cancel");
  await post("/voice/utterances", cancel, token);
  assert.deepEqual(registry.voiceRouter!.pendingVoiceActions.map((action) => action.id), ["old"]);

  applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: false });
  applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: true });
  assert.deepEqual(registry.snapshot().voiceCards, []);
  assert.deepEqual(await readHeard(), []);
  await say("Will check the new build", "new");
  assert.deepEqual(await (await post("/voice/utterances", cancel, token)).json(), { accepted: true });
  assert.deepEqual(registry.snapshot().voiceCards?.map((card) => [card.id, card.state]), [["new", "pending"]]);
  assert.deepEqual((await readHeard()).map((entry) => entry.id), ["new"]);
  await say("cancel", "fresh-cancel");
  assert.deepEqual([cards.at(-1)?.id, cards.at(-1)?.state], ["new", "cancelled"]);
});

test("at the deadline only the older uncancelled card reaches the real pending-turn queue", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  await say("Steve check the build", "older");
  await say("Steve drop this one", "newer");
  assert.deepEqual(registry.snapshot().voiceCards?.map((c) => c.id), ["older", "newer"]);
  const deadline = cards[0]!.deadline;
  assert.equal(deadline, Date.now() + 1000);
  await say("cancel");
  t.mock.timers.tick(999);
  assert.ok(!queued("Steve").includes("check the build"));
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.deepEqual(queued("Steve").filter((s) => ["check the build", "drop this one"].includes(s)), ["check the build"]);
  assert.deepEqual(cards.map((c) => c.state), ["pending", "pending", "cancelled", "queued"]);
  assert.equal((await readHeard()).find((e) => e.id === "newer")?.outcome, "cancelled");
});

test("successive cancels stop exactly one action across kinds; a duplicate capture does nothing", async () => {
  await say("Will first", "a");
  const actions = registry.voiceRouter!.pendingVoiceActions;
  actions.push({ id: "answer", kind: "answer", openedAt: Date.now(), cancel: () => { actions.pop(); } });
  await say("Will second", "b");
  await say("cancel", "cancel-b");
  await say("cancel", "cancel-b");
  assert.deepEqual(actions.map((a) => a.id), ["a", "answer"]);
  await say("cancel");
  await say("cancel");
  await say("cancel");
  assert.deepEqual(cards.filter((c) => c.state === "cancelled").map((c) => c.id), ["b", "a"]);
  assert.equal((await readHeard())[0]?.rule, "nothing-pending");
});

test("a delayed spoken cancel targets the latest preceding capture even when POSTs arrive out of order", async (t) => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const postCapture = (id: string, text: string, capturedAt: number) =>
    post("/voice/utterances", { ...capture(text, id), capturedAt }, token);
  await postCapture("middle", "Will discard the middle message", now - 300);
  await postCapture("oldest", "Will keep the first message", now - 400);
  await postCapture("newest", "Will keep the last message", now - 100);
  await postCapture("delayed", "cancel", now - 200);
  assert.deepEqual([cards.at(-1)?.id, cards.at(-1)?.state], ["middle", "cancelled"]);
  assert.equal((await readHeard())[0]?.detail, "middle");

  await postCapture("before-all", "cancel", now - 500);
  assert.equal((await readHeard())[0]?.rule, "nothing-pending");
  assert.deepEqual(registry.snapshot().voiceCards?.map((card) => card.id), ["oldest", "newest"]);
  t.mock.timers.tick(1000);
  assert.deepEqual(queued("Will").slice(-2), ["keep the first message", "keep the last message"]);
});

test("a picked card's new cancel window follows the time of the pick", async (t) => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  await post("/voice/utterances", { ...capture("Steven ask Will about the build", "choice"), capturedAt: now - 400 }, token);
  await post("/voice/utterances", { ...capture("Will"), capturedAt: now - 200 }, token);

  await post("/voice/utterances", { ...capture("cancel"), capturedAt: now - 300 }, token);
  assert.equal((await readHeard())[0]?.rule, "nothing-pending");
  assert.deepEqual([cards.at(-1)?.id, cards.at(-1)?.state], ["choice", "pending"]);
  await post("/voice/utterances", { ...capture("cancel"), capturedAt: now - 100 }, token);
  assert.deepEqual([cards.at(-1)?.id, cards.at(-1)?.state], ["choice", "cancelled"]);
});

test("Cancel targets its own card, Send now queues once, and clearing history leaves no entry", async () => {
  await say("Steve cancel by id", "a");
  await say("Will send now", "b");
  assert.equal((await act("a", "cancel")).status, 200);
  assert.equal((await act("b", "send-now")).status, 200);
  assert.equal((await act("b", "send-now")).status, 409);
  assert.deepEqual(queued("Will").filter((s) => s === "send now"), ["send now"]);
  assert.ok(!queued("Steve").includes("cancel by id"));
  assert.equal((await app.request("/api/voice/heard", { method: "DELETE", headers: { host: "localhost" } })).status, 204);
  assert.deepEqual(await readHeard(), []);
});

test("window off queues immediately and an addressed stop interrupts the session", async () => {
  await app.request("/api/voice/config", { method: "PUT", headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ cancelWindow: { enabled: false } }) });
  await say("Steve's, ship   it!");
  assert.ok(queued("Steve").includes("ship   it!"));
  await say("Steve, stop.");
  assert.deepEqual(interrupts, ["sdk:Steve"]);
  assert.deepEqual(cards.map((c) => c.state), ["queued", "sent"]);
});

test("a later mention of Steve opens a pending card for Will and queues the entire message to Will alone", async () => {
  const body = "ask Steve about the build";
  decide = (questions) => {
    assert.deepEqual(questions.map((q) => q.kind === "split" && [q.first.label, q.second.label]), [["Will", "Steve"]]);
    return { rung: "job", answers: [{ choice: "mention", confidence: 1 }], detail: "scripted" };
  };
  await say("Will, " + body, "mention");
  await resolved("mention");
  assert.equal(cards[0]?.state, "pending");
  assert.equal(cards[0]?.reason, "mention");
  assert.equal(cards[0]?.parts[0]?.target?.name, "Will");
  assert.equal(cards[0]?.parts[0]?.text, body);
  assert.deepEqual(cards[0]?.candidates, []);
  assert.equal((await act("mention", "send-now")).status, 200);
  assert.ok(queued("Will").includes(body));
  assert.ok(!queued("Steve").includes(body));
});

test("a split queues each part to its own agent", async () => {
  decide = () => ({ rung: "job", answers: [{ choice: "split", confidence: 1 }], detail: "scripted" });
  await say("Steve, check the build, and Will, review the PR", "split");
  await resolved("split");
  assert.deepEqual(cards.at(-1)?.parts.map((p) => [p.target?.name, p.text]), [["Steve", "check the build"], ["Will", "review the PR"]]);
  assert.equal((await act("split", "send-now")).status, 200);
  assert.ok(queued("Steve").includes("check the build"));
  assert.ok(queued("Will").includes("review the PR"));
  assert.equal(cards.at(-1)?.state, "queued");
});

test("unsure waits indefinitely, cancels without sending, and accepts a spoken or clicked candidate", async () => {
  decide = (questions) => ({ rung: "none", answers: questions.map(() => ({ choice: null, confidence: 0 })), detail: "scripted" });
  await say("Steven tell Will something", "ambiguous");
  await resolved("ambiguous");
  assert.equal(cards[0]?.state, "unsure");
  assert.equal(cards[0]?.deadline, null);
  assert.equal((await act("ambiguous", "send-now")).status, 409);
  await say("cancel");
  assert.equal(cards.at(-1)?.state, "cancelled");
  assert.ok(!queued("Steve").includes("tell Will something"));
  for (const method of ["spoken", "click"]) {
    await say("Steven ask Will about it", method);
    await resolved(method);
    assert.equal((await act(method, "pick", { id: "unknown" })).status, 409);
    if (method === "spoken") await say("Will");
    else assert.equal((await act(method, "pick", { id: "task:Will" })).status, 200);
    assert.equal(cards.at(-1)?.state, "pending");
    assert.deepEqual(cards.at(-1)?.parts.map(part => [part.target?.name, part.text]), [["Steve", "ask"], ["Will", "about it"]]);
    assert.equal((await act(method, "cancel")).status, 200);
  }
});

test("a spoken pick finds the only matching unsure card, even when it is older", async () => {
  await say("Steven ask Will about the build", "older");
  await say("Steven ask Bill about the release", "newer");
  await say("Steve");
  assert.deepEqual(cards.map((card) => [card.id, card.state]), [["older", "unsure"], ["newer", "unsure"]]);
  assert.equal((await readHeard())[0]?.rule, "ambiguous-pick");

  await say("Will.");
  assert.deepEqual(registry.snapshot().voiceCards?.map((card) => [card.id, card.state]), [
    ["newer", "unsure"], ["older", "pending"],
  ]);
  assert.deepEqual(cards.at(-1)?.parts.map(p => [p.target?.name, p.text]), [
    ["Steve", "ask"], ["Will", "about the build"],
  ]);
  assert.equal((await act("older", "send-now")).status, 200);
  assert.equal(queued("Steve").at(-1), "ask");
  assert.equal(queued("Will").at(-1), "about the build");
});

test("a delayed spoken pick can only queue an unsure capture that preceded it", async () => {
  await app.request("/api/voice/config", { method: "PUT", headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ cancelWindow: { enabled: false } }) });
  const now = Date.now();
  const postAt = (id: string, text: string, capturedAt: number) =>
    post("/voice/utterances", { ...capture(text, id), capturedAt }, token);
  const before = queued("Will");
  await postAt("newer", "Steven ask Will about tomorrow", now - 100);
  await postAt("too-early", "Will", now - 400);
  assert.deepEqual(queued("Will"), before);
  assert.equal((await readHeard())[0]?.rule, "no-message");
  await postAt("older", "Steven ask Will about yesterday", now - 300);
  await postAt("between", "Will", now - 200);
  assert.deepEqual(queued("Will"), [...before, "about yesterday"]);
  assert.equal(queued("Steve").at(-1), "ask");
  assert.equal((await readHeard())[0]?.rule, "pick");
  assert.deepEqual(registry.snapshot().voiceCards?.map((card) => [card.id, card.state]), [["newer", "unsure"]]);
});

test("a quote immediately after the address comma survives the preview and queued delivery", async () => {
  await say('Will,"ship it"', "quote");
  assert.equal(cards[0]?.parts[0]?.text, '"ship it"');
  assert.equal((await act("quote", "send-now")).status, 200);
  assert.equal(queued("Will").at(-1), '"ship it"');
});

test("punctuation-only messages reach the named agent and leave an unsure card open", async () => {
  await say("Steven ask Will about the build", "unsure");
  for (const [id, text, body] of [
    ["spaced", "Will, ???", "???"],
    ["adjacent", "Will,!!!", "!!!"],
    ["plain", "Will ...", "..."],
    ["commas", "Will, ,,,", ",,,"],
  ] as const) {
    await say(text, id);
    const card = cards.at(-1);
    assert.deepEqual([card?.id, card?.state, card?.parts[0]?.text], [id, "pending", body]);
    assert.equal((await act(id, "send-now")).status, 200);
    assert.equal(queued("Will").at(-1), body);
  }
  assert.deepEqual(registry.snapshot().voiceCards?.map((card) => [card.id, card.state]), [["unsure", "unsure"]]);
});

test("a replacement session receives neither a pending message nor a pending interrupt", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const will = name("Will");
  voiceStateStore.useRoster(() => [will, name("Steve")]);
  t.after(() => voiceStateStore.useRoster(() => roster));
  await say("Will, stop", "stop-original");
  await say("Steven ask Will about the deployment", "picked-message");
  await say("Will.");
  const replacementQueue = queued("Bill");
  const beforeInterrupts = [...interrupts];
  will.sessionId = "sdk:Bill";

  assert.equal((await act("stop-original", "send-now")).status, 200);
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.deepEqual(queued("Bill"), replacementQueue);
  assert.deepEqual(interrupts, beforeInterrupts);
  assert.deepEqual(cards.slice(-2).map((c) => [c.id, c.state, c.parts.map(p => p.target?.sessionId)]), [
    ["stop-original", "not-running", ["sdk:Will"]], ["picked-message", "not-running", ["sdk:Steve", "sdk:Will"]],
  ]);
  const deliveries = (await readHeard()).filter((entry) => entry.outcome !== "control");
  assert.equal(deliveries.length, 2);
  for (const entry of deliveries) {
    assert.equal(entry.outcome, "not-running");
    assert.equal(entry.detail, "The selected session is unavailable.");
  }
});

test("a selected session missing from the registry is reported as unavailable", async (t) => {
  const will = { ...name("Will"), sessionId: "sdk:gone" };
  voiceStateStore.useRoster(() => [will]);
  t.after(() => voiceStateStore.useRoster(() => roster));
  await say("Will finish the report", "gone");
  assert.equal((await act("gone", "send-now")).status, 200);
  assert.equal(cards.at(-1)?.state, "not-running");
  assert.equal((await readHeard())[0]?.outcome, "not-running");
});

test("a spoken pick for a departed candidate records why the unsure card stays open", async (t) => {
  await say("Steven ask Will about the release", "choose");
  voiceStateStore.useRoster(() => roster.filter((target) => target.name !== "Will"));
  t.after(() => voiceStateStore.useRoster(() => roster));
  await say("Will", "departed");
  const [pick, original] = await readHeard();
  assert.deepEqual([pick?.id, pick?.outcome, pick?.rule], ["departed", "ignored", "candidate-unavailable"]);
  assert.equal(original?.outcome, "unsure");
  assert.deepEqual(registry.snapshot().voiceCards?.map((card) => [card.id, card.state]), [["choose", "unsure"]]);
  await say("Steve");
  assert.deepEqual([cards.at(-1)?.state, cards.at(-1)?.parts[0]?.target?.name], ["pending", "Steve"]);
});

test("ignored, pending and cancelled captures leave no transcript in the daemon state directory", async () => {
  const marker = randomUUID();
  await say("Morning " + marker);
  await say("Steve remember " + marker, "cancel-this");
  await say("Will pending " + marker);
  await act("cancel-this", "cancel");
  const response = await app.request("/api/voice/heard", { headers: { host: "localhost" } });
  assert.equal(response.headers.get("cache-control"), "no-store");
  const { entries } = await response.json() as { entries: HeardEntry[] };
  assert.deepEqual(entries.map((entry) => entry.outcome), ["pending", "cancelled", "ignored"]);
  assert.ok(entries.every((entry) => entry.text.includes(marker)));
  const files = readdirSync(home, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
  assert.ok(files.some((file) => file.name === "harness.db"));
  for (const file of files) {
    assert.equal(readFileSync(join(file.parentPath, file.name)).includes(marker), false, file.name);
  }
});

test("Recently heard measures the pause between aligned words and leaves unclear timings empty", async (t) => {
  voiceStateStore.useRoster(() => [name("Release"), name("Build Captain")]);
  t.after(() => voiceStateStore.useRoster(() => roster));
  for (const [text, labels, pause] of [
    ["Release , run tests", ["Release", ",", "run", "tests"], 150],
    ["Build Captain , run tests", ["Build", "Captain,", "run", "tests"], 50],
    ["Release, run tests", ["Other", "run"], null],
    ["Release, run tests", ["Release", ",", "tests"], null],
    ["Build Captain, run tests", ["Other", "Captain", "run"], null],
    ["Release, ???", ["Release", "???"], null],
  ] as const) {
    const words = labels.map((label, i) => ({ text: label, startMs: 100 * i, endMs: 100 * i + 50 }));
    assert.equal((await post("/voice/utterances", { ...capture(text), words }, token)).status, 200);
    const [entry] = await readHeard();
    assert.deepEqual([entry?.outcome, entry?.pauseMs], ["pending", pause], text);
  }
});


test("the downstream say fixture establishes a listener and posts contiguous or supplied word timings", async (t) => {
  const { say: sayFixture } = await import("../e2e/fixtures/voice.ts");
  voiceStateStore.reset();
  t.mock.method(globalThis, "fetch", (url: string, init: RequestInit) => app.request(url, init));
  const daemon = { home, baseURL: "http://localhost" };
  assert.deepEqual(await (await sayFixture(daemon, "Will, grab the door")).json(), { accepted: true });
  assert.equal((await readHeard())[0]?.pauseMs, 0);
  assert.deepEqual(await (await sayFixture(daemon, "Will you grab the door", { words: [
    { text: "Will", startMs: 0, endMs: 130 }, { text: "you", startMs: 100, endMs: 175 },
  ] })).json(), { accepted: true });
  const entries = await readHeard();
  assert.equal(entries[0]?.pauseMs, -30);
  assert.deepEqual(entries.map((entry) => [entry.matchedName, entry.rule]), [["Will", "exact"], ["Will", "exact"]]);
});

test("two weak matches followed by a bare name leave only ignored history", async () => {
  const before = queued("Will");
  for (const text of ["fill in the form", "till tomorrow", "Will?"]) await say(text);
  assert.deepEqual((await readHeard()).map(({ outcome, rule }) => [outcome, rule]), [
    ["ignored", "no-message"], ["ignored", "near-miss"], ["ignored", "near-miss"],
  ]);
  assert.deepEqual(cards, []);
  assert.deepEqual(registry.snapshot().voiceCards, []);
  assert.deepEqual(registry.voiceRouter!.pendingVoiceActions, []);
  assert.deepEqual(queued("Will"), before);
});

test("a sixth unsure card cancels the oldest unsure card and preserves pending delivery", async () => {
  await say("Will keep this", "pending");
  for (let i = 0; i < 6; i++) await say("Steven told Will about it", "unsure-" + i);
  const openIds = ["pending", "unsure-1", "unsure-2", "unsure-3", "unsure-4", "unsure-5"];
  assert.deepEqual(registry.snapshot().voiceCards?.map((card) => card.id), openIds);
  assert.deepEqual(registry.voiceRouter!.pendingVoiceActions.map((action) => action.id), openIds);
  assert.deepEqual(cards.filter((card) => card.state === "cancelled").map((card) => card.id), ["unsure-0"]);
  assert.equal((await readHeard()).find((entry) => entry.id === "unsure-0")?.outcome, "cancelled");
  assert.equal((await act("unsure-0", "pick", { id: "task:Will" })).status, 409);
});

test("Recently heard keeps the refusal reasons from the queue and interrupt adapters", async (t) => {
  t.mock.method(pending, "submit", () => ({ ok: false, error: "Queue full." }));
  await say("Steve send this", "queue-refusal");
  await act("queue-refusal", "send-now");
  t.mock.method(sdk, "interrupt", async () => null);
  await say("Steve stop", "interrupt-refusal");
  await act("interrupt-refusal", "send-now");
  assert.deepEqual((await readHeard()).map(({ outcome, detail }) => [outcome, detail]), [
    ["failed", "this session has no live embedded driver"], ["failed", "Queue full."],
  ]);
});

test("a busy session's accepted turn stays queued on its card and in Recently heard", async () => {
  registry.applyDriverEvent("sdk:Bill", { kind: "state", state: "working", activity: "Running tests" });
  await say("Bill, review the logs", "busy");
  assert.equal((await act("busy", "send-now")).status, 200);
  const session = registry.getSession("sdk:Bill")!;
  assert.equal(session.state, "working");
  assert.ok(session.pendingTurns.some((turn) => turn.text === "review the logs" && turn.claimedAt === null));
  assert.deepEqual(cards.map((card) => card.state), ["pending", "queued"]);
  assert.equal((await readHeard())[0]?.outcome, "queued");
});
