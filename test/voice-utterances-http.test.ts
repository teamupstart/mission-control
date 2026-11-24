import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SdkSupervisor } from "../src/server/sdk/supervisor.ts";
import type { HeardEntry, VoiceCard } from "../src/shared/voice-routing.ts";
import type { SpokenName } from "../src/shared/voice-names.ts";
import { FakeVoiceListener } from "./helpers/fake-voice-listener.ts";

const home = mkdtempSync(join(tmpdir(), "mission-voice-routing-"));
process.env.MISSION_HOME = home;
const { buildApp } = await import("../src/server/routes.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { PendingTurnManager } = await import("../src/server/pending-turns.ts");
const { voiceStateStore, wireVoiceStateEvents } = await import("../src/server/voice/state.ts");
const { VOICE_REQUIRED_FLAGS, VOICE_HELLO_LAPSE_MS, VOICE_LISTENER_PROTOCOL_VERSION } = await import("../src/shared/voice.ts");
const { applyFeatureFlagIntent } = await import("../src/server/feature-flags/index.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const { closeDb } = await import("../src/server/db.ts");
const token = ensureToken();
const registry = new Registry();
const interrupts: string[] = [];
const sdk = { interrupt: async (id: string) => { interrupts.push(id); return "idle"; } } as unknown as SdkSupervisor;
const pending = new PendingTurnManager(registry, sdk, { idleSettleMs: 60_000 });
const app = buildApp({ registry, pendingTurns: pending, sdkSessions: sdk, reviews: new ReviewManager(registry),
  tasks: new TaskManager(registry), queues: new QueueManager(registry) });
const cards: VoiceCard[] = [];
registry.subscribe((event) => { if (event.type === "voice_card") cards.push(event.card); });
const stop = wireVoiceStateEvents((state) => registry.emitVoiceState(state));
const listenerId = randomUUID();
const post = (path: string, body: unknown = {}, auth?: string) => app.request(path, { method: "POST",
  headers: { host: "localhost", "content-type": "application/json", ...(auth ? { "x-harness-token": auth, "x-voice-listener-id": listenerId } : {}) },
  body: JSON.stringify(body) });
const capture = (text: string, id = String(randomUUID())) => ({ id, text, backend: "fluidaudio", capturedAt: Date.now() });
const utterancePath = (revision = voiceStateStore.directive().revision) => "/voice/utterances?revision=" + encodeURIComponent(revision);
const say = (text: string, id?: string) => post(utterancePath(), capture(text, id), token);
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
  voiceStateStore.reset();
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

test("token and schema gates and muted drop", async () => {
  assert.equal((await post(utterancePath(), capture("Steve hello"))).status, 401);
  assert.equal((await post(utterancePath(), { ...capture("Steve hello"), words: [{ text: "x", startMs: 3, endMs: 1 }] }, token)).status, 400);
  await post("/api/voice/mute", { muted: true });
  assert.deepEqual(await (await say("Steve muted words")).json(), { accepted: false });
  assert.deepEqual(await readHeard(), []);
});

test("only one listener can capture or deliver, and its heartbeat lease transfers after lapse", async (t) => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  voiceStateStore.reset();
  const config = await app.request("/api/voice/config", { method: "PUT", headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ cancelWindow: { enabled: false } }) });
  assert.equal(config.status, 200);
  const clients = [0, 1].map(() => new FakeVoiceListener("http://localhost", join(home, "token"), async (url, init) => app.request(url, init)));
  const hellos = await Promise.all(clients.map(client => client.hello()));
  assert.deepEqual(hellos.map(res => res.status).sort(), [200, 409]);
  const owner = clients[hellos.findIndex(res => res.ok)]!;
  const other = clients[hellos.findIndex(res => !res.ok)]!;
  assert.equal((await hellos.find(res => !res.ok)!.json()).error, "listener_in_use");
  const original = await owner.poll();
  assert.equal(original.capture, true);
  await assert.rejects(other.poll(), /409/);
  assert.equal((await other.hello({ version: "2.0" })).status, 409);
  const spoken = "Steve count the microphones";
  const count = queued("Steve").length;
  for (const [client, accepted] of [[owner, true], [other, false]] as const) {
    assert.deepEqual(await (await client.utterance(spoken, [], original.revision)).json(), { accepted });
  }
  assert.equal(queued("Steve").length, count + 1);
  t.mock.timers.setTime(now + 10_000);
  assert.ok((await owner.hello()).ok);
  const held = assert.rejects(owner.poll(original.revision), /409/);
  await new Promise<void>(resolve => setImmediate(resolve));
  t.mock.timers.setTime(now + 10_000 + VOICE_HELLO_LAPSE_MS - 1);
  assert.equal((await other.hello()).status, 409);
  t.mock.timers.setTime(now + 10_000 + VOICE_HELLO_LAPSE_MS);
  assert.deepEqual(await (await owner.utterance(spoken, [], original.revision)).json(), { accepted: false });
  assert.ok((await other.hello()).ok);
  await held;
  const current = await other.poll();
  assert.equal(current.capture, true);
  assert.notEqual(current.revision, original.revision);
  assert.equal((await owner.hello()).status, 409);
  assert.deepEqual(await (await owner.utterance(spoken, [], current.revision)).json(), { accepted: false });
  assert.deepEqual(await (await other.utterance(spoken, [], original.revision)).json(), { accepted: false });
  assert.deepEqual(await (await other.utterance(spoken, [], current.revision)).json(), { accepted: true });
  assert.equal(queued("Steve").length, count + 2);
  assert.deepEqual(queued("Steve").slice(count), ["count the microphones", "count the microphones"]);
  assert.equal((await readHeard()).length, 2);
});

test("only pre-release speech from the held revision can finish during call auto-mute", async (t) => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const press = (pushToTalk: boolean, pushToTalkReleasedAt?: number | string) =>
    post("/voice/shell-report", { callActive: true, pushToTalk, pushToTalkReleasedAt }, token);
  const poll = () => app.request("/voice/listener/directive", {
    headers: { "x-harness-token": token, "x-voice-listener-id": listenerId },
  });
  const submit = async (revision: string, capturedAt: number, id: string, end: number | null = capturedAt) =>
    (await app.request(utterancePath(revision), { method: "POST", headers: {
      host: "localhost", "content-type": "application/json", "x-harness-token": token, "x-voice-listener-id": listenerId,
      ...(end === null ? {} : { "x-voice-capture-ended-at": String(end) }),
    }, body: JSON.stringify({ ...capture("Steve finish this", id), capturedAt }) })).json();
  await press(true);
  const held = voiceStateStore.directive();
  assert.equal(held.capture, true);
  t.mock.timers.tick(100);
  const keyUp = Date.now();
  t.mock.timers.tick(450); // The shell report was in transit after the operator released the key.
  await app.request("/api/voice/config", { method: "PUT", headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ cancelWindow: { enabled: false } }) });
  const initialQueue = queued("Steve").length;
  const crossing = submit(held.revision, now, "crossing", keyUp + 10);
  const inside = submit(held.revision, now, "inside", keyUp);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(queued("Steve").length, initialQueue);
  assert.deepEqual(await readHeard(), []);
  await press(false, keyUp);
  assert.deepEqual(await crossing, { accepted: false });
  assert.deepEqual(await inside, { accepted: true });
  assert.equal(queued("Steve").length, initialQueue + 1);
  const off = await poll();
  assert.equal(off.headers.get("x-voice-release-revision"), held.revision);
  assert.equal(off.headers.get("x-voice-release-at"), String(now + 100));
  const released = await off.json();
  assert.equal(released.capture, false);
  assert.equal(voiceStateStore.state().mode, "auto-muted");
  await press(false); // A duplicate key-up heartbeat must preserve the drain.
  assert.deepEqual(await submit(held.revision, now, "no-end", null), { accepted: false });
  assert.deepEqual(await submit(held.revision, now, "in-flight", now + 101), { accepted: false });
  assert.deepEqual(await submit(held.revision, now, "in-flight"), { accepted: true });
  assert.deepEqual(await submit(held.revision, now + 99, "tail"), { accepted: true });
  assert.deepEqual(await submit(held.revision, now + 101, "too-late"), { accepted: false });
  assert.deepEqual(await submit(released.revision, now, "capture-off"), { accepted: false });
  assert.deepEqual(cards.map(card => card.id), ["inside", "in-flight", "tail"]);

  await post("/api/voice/mute", { muted: true });
  assert.equal((await poll()).headers.get("x-voice-release-revision"), null);
  assert.deepEqual(await submit(held.revision, now, "after-mute"), { accepted: false });
  await post("/api/voice/mute", { muted: false });
  assert.deepEqual(await submit(held.revision, now, "after-unmute"), { accepted: false });
  for (const invalidKeyUp of [undefined, "bad-clock", Date.now() + 1000]) {
    await press(true);
    const heldAgain = voiceStateStore.directive();
    await press(false, invalidKeyUp);
    const stopped = await poll();
    assert.equal((await stopped.json()).capture, false);
    assert.equal(stopped.headers.get("x-voice-release-at"), null);
    assert.deepEqual(await submit(heldAgain.revision, now, "no-valid-keyup"), { accepted: false });
  }
  await press(true);
  const next = voiceStateStore.directive();
  await post("/api/voice/mute", { muted: true }); // An actual mute while held also discards.
  await press(false, Date.now());
  assert.equal((await poll()).headers.get("x-voice-release-revision"), null);
  assert.deepEqual(await submit(next.revision, now, "muted-while-held"), { accepted: false });
});

test("only the selected live recognizer can open or cancel a card after switching backends", async (t) => {
  const configure = (backend: string) => app.request("/api/voice/config", { method: "PUT",
    headers: { host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ backend }) });
  const sayWithSherpa = (text: string, id: string) =>
    post(utterancePath(), { ...capture(text, id), backend: "sherpa-onnx" }, token);
  t.after(async () => { await configure("auto"); });
  await say("Will keep this", "pending");
  assert.equal((await configure("sherpa-onnx")).status, 200);
  assert.deepEqual(await (await say("cancel", "retry")).json(), { accepted: false });
  assert.deepEqual(await (await sayWithSherpa("cancel", "retry")).json(), { accepted: false });
  await post("/voice/listener/hello", { backend: "sherpa-onnx", version: VOICE_LISTENER_PROTOCOL_VERSION,
    devices: [], microphone: "granted", modelLoaded: true }, token);
  await configure("auto");
  assert.deepEqual(await (await say("Will stale", "stale")).json(), { accepted: false });
  assert.deepEqual(await (await say("cancel", "retry")).json(), { accepted: false });
  assert.deepEqual((await readHeard()).map((entry) => entry.id), ["pending"]);
  assert.deepEqual(await (await sayWithSherpa("cancel", "retry")).json(), { accepted: true });
  assert.deepEqual(cards.map((card) => [card.id, card.state]), [["pending", "pending"], ["pending", "cancelled"]]);
});

test("a held POST times out without routing and can retry the same ID after key-up", async t => {
  // Keep the heartbeat clock live while advancing only the HTTP wait timer.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await post("/voice/shell-report", { callActive: true, pushToTalk: true }, token);
  const held = voiceStateStore.directive().revision;
  const words = capture("Steve check the build");
  const send = () => app.request(utterancePath(held), { method: "POST", headers: {
    host: "localhost", "content-type": "application/json", "x-harness-token": token,
    "x-voice-listener-id": listenerId, "x-voice-capture-ended-at": String(words.capturedAt),
  }, body: JSON.stringify(words) });
  const waiting = send();
  await new Promise<void>(resolve => setImmediate(resolve));
  t.mock.timers.tick(25_000);
  const retry = await waiting;
  assert.equal(retry.headers.get("x-voice-held-revision"), held);
  assert.deepEqual(await retry.json(), { accepted: false });
  assert.deepEqual(await readHeard(), []);
  await post("/voice/shell-report", { callActive: true, pushToTalk: false, pushToTalkReleasedAt: Date.now() }, token);
  assert.deepEqual(await (await send()).json(), { accepted: true });
  assert.deepEqual((await readHeard()).map(entry => entry.id), [words.id]);
});

test("a delayed capture cannot follow a spoken name to a different recipient", async (t) => {
  let recipient = name("Steve");
  voiceStateStore.useRoster(() => [recipient]);
  t.after(() => { voiceStateStore.useRoster(() => roster); });
  const original = voiceStateStore.directive();
  const delayed = capture("Steve review the build", "before-reassignment");
  recipient = { ...name("Will"), name: "Steve" };
  voiceStateStore.publish();

  assert.deepEqual(await (await post(utterancePath(original.revision), delayed, token)).json(), { accepted: false });
  assert.deepEqual(await readHeard(), []);
  assert.equal(cards.length, 0);
  const next = voiceStateStore.directive();
  assert.deepEqual(next.roster, original.roster);
  assert.notEqual(next.revision, original.revision);
  assert.deepEqual(await (await say("Steve review the build", "after-reassignment")).json(), { accepted: true });
  assert.equal(cards.at(-1)?.parts[0]?.target?.key, "task:Will");
  assert.equal((await act("after-reassignment", "send-now")).status, 200);
  assert.equal(queued("Will").at(-1), "review the build");
});

test("future captures beyond clock tolerance are dropped and a cancel on the same listener clock can act immediately", async (t) => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const unsure = capture("Steven ask Will", "clock");
  const postAt = (capturedAt: number) => post(utterancePath(), { ...unsure, capturedAt }, token);
  assert.deepEqual(await (await postAt(now + 1001)).json(), { accepted: false });
  assert.deepEqual(await readHeard(), []);
  assert.equal(cards.length, 0);
  assert.deepEqual(await (await postAt(now + 1000)).json(), { accepted: true });
  await post(utterancePath(), { ...capture("cancel"), capturedAt: now + 1000 }, token);
  assert.deepEqual(cards.map((card) => [card.id, card.state]), [["clock", "unsure"], ["clock", "cancelled"]]);
});

test("a listener clock ahead of the daemon preserves out-of-order cancel and pick eligibility", async (t) => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const postAt = (id: string, text: string, offset: number) =>
    post(utterancePath(), { ...capture(text, id), capturedAt: now + offset }, token);
  await postAt("older", "Will discard this", 100);
  await postAt("newer", "Will keep this", 500);
  assert.equal(cards.at(-1)?.deadline, now + 1000);
  await postAt("delayed-cancel", "cancel", 300);
  assert.deepEqual([cards.at(-1)?.id, cards.at(-1)?.state], ["older", "cancelled"]);
  await postAt("unsure", "Steven ask Will", 700);
  await postAt("delayed-pick", "Will", 600);
  assert.deepEqual(registry.snapshot().voiceCards?.map((card) => [card.id, card.state]), [["newer", "pending"], ["unsure", "unsure"]]);
  assert.deepEqual((await readHeard()).map((entry) => [entry.id, entry.time - now]), [
    ["unsure", 700], ["delayed-pick", 600], ["newer", 500], ["delayed-cancel", 300], ["older", 100],
  ]);
});

test("capture IDs must address a single card action URL segment", async () => {
  for (const id of [".", "..", "%2e", "a/b", "x?y", "x#y", "a b"]) {
    assert.equal((await say("Steve check the build", id)).status, 400, id);
  }
  assert.deepEqual(await readHeard(), []);
  assert.equal(cards.length, 0);
  const id = "call.1~A_b-c";
  assert.equal((await say("Steven ask Will", id)).status, 200);
  assert.equal((await act(id, "pick", { id: "task:Will" })).status, 200);
  assert.equal((await act(id, "cancel")).status, 200);
  assert.equal(cards.at(-1)?.state, "cancelled");
});

test("turning voice off clears pending actions and gates every contract D route", async () => {
  await say("Steve stale", "disabled");
  applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: false });
  assert.equal(registry.voiceRouter!.pendingVoiceActions.length, 0);
  for (const response of [await say("hello"), await act("disabled", "pick"), await act("disabled", "cancel"),
    await act("disabled", "send-now"), ...await Promise.all(["GET", "DELETE"].map((method) =>
      app.request("/api/voice/heard", { method, headers: { host: "localhost" } })))]) assert.equal(response.status, 404);
});

test("a delayed capture from before mute cannot reach Recently heard, cards or the queue after unmute", async () => {
  await post("/voice/shell-report", { callActive: false, pushToTalk: false }, token);
  await app.request("/api/voice/config", { method: "PUT", headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ cancelWindow: { enabled: false } }) });
  const beforeMute = voiceStateStore.directive();
  const stale = capture("Steve pre-mute message");
  const beforeQueue = queued("Steve");
  await post("/api/voice/mute", { muted: true });
  assert.equal(voiceStateStore.state().mode, "muted");
  await post("/api/voice/mute", { muted: false });

  assert.equal(voiceStateStore.state().mode, "listening");
  assert.deepEqual(await (await post(utterancePath(beforeMute.revision), stale, token)).json(), { accepted: false });
  assert.deepEqual(await (await post("/voice/utterances", stale, token)).json(), { accepted: false });
  assert.deepEqual(await readHeard(), []);
  assert.deepEqual(cards, []);
  assert.deepEqual(queued("Steve"), beforeQueue);

  assert.deepEqual(await (await say("Steve post-mute message")).json(), { accepted: true });
  assert.deepEqual(queued("Steve"), [...beforeQueue, "post-mute message"]);
});

test("a cancel retried after toggling voice cannot dismiss a new card", async () => {
  await say("Steve old message", "old");
  await say("Steve cancel this one", "cancelled");
  const cancel = capture("cancel", "original-cancel");
  await post(utterancePath(), cancel, token);
  assert.deepEqual(registry.voiceRouter!.pendingVoiceActions.map((action) => action.id), ["old"]);

  applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: false });
  applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: true });
  assert.deepEqual(registry.snapshot().voiceCards, []);
  assert.deepEqual(await readHeard(), []);
  await say("Will check the new build", "new");
  // A duplicate id is harmless even when submitted under the current directive.
  assert.deepEqual(await (await post(utterancePath(), cancel, token)).json(), { accepted: true });
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

test("quoted or comma-prefixed cancel leaves the pending card open until a bare cancel dismisses it", async () => {
  await say("Will check the build", "waiting");
  for (const text of ["“cancel”", '"CANCEL!"', "'cancel'", "«cancel».", ",cancel"]) {
    await say(text);
    assert.equal((await readHeard())[0]?.outcome, "ignored");
    assert.deepEqual(registry.snapshot().voiceCards?.map((card) => [card.id, card.state]), [["waiting", "pending"]]);
  }
  await say("Cancel!");
  assert.deepEqual([cards.at(-1)?.id, cards.at(-1)?.state], ["waiting", "cancelled"]);
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
    post(utterancePath(), { ...capture(text, id), capturedAt }, token);
  await postCapture("middle", "Will discard the middle message", now - 300);
  await postCapture("oldest", "Will keep the first message", now - 400);
  await postCapture("newest", "Will keep the last message", now - 100);
  await postCapture("delayed", "cancel", now - 200);
  assert.deepEqual([cards.at(-1)?.id, cards.at(-1)?.state], ["middle", "cancelled"]);
  assert.equal((await readHeard()).find((entry) => entry.id === "delayed")?.detail, "middle");

  await postCapture("before-all", "cancel", now - 500);
  assert.equal((await readHeard()).find((entry) => entry.id === "before-all")?.rule, "nothing-pending");
  assert.deepEqual(registry.snapshot().voiceCards?.map((card) => card.id), ["oldest", "newest"]);
  t.mock.timers.tick(1000);
  assert.deepEqual(queued("Will").slice(-2), ["keep the first message", "keep the last message"]);
});

test("a picked card's new cancel window follows the time of the pick", async (t) => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  await post(utterancePath(), { ...capture("Steven ask Will", "choice"), capturedAt: now - 400 }, token);
  await post(utterancePath(), { ...capture("Will"), capturedAt: now - 200 }, token);

  await post(utterancePath(), { ...capture("cancel", "before-pick"), capturedAt: now - 300 }, token);
  assert.equal((await readHeard()).find((entry) => entry.id === "before-pick")?.rule, "nothing-pending");
  assert.deepEqual([cards.at(-1)?.id, cards.at(-1)?.state], ["choice", "pending"]);
  await post(utterancePath(), { ...capture("cancel"), capturedAt: now - 100 }, token);
  assert.deepEqual([cards.at(-1)?.id, cards.at(-1)?.state], ["choice", "cancelled"]);
});

test("an API pick and a spoken cancel use the shared host clock", async (t) => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const postAt = (id: string, text: string, capturedAt: number) =>
    post(utterancePath(), { ...capture(text, id), capturedAt }, token);
  await postAt("choice", "Steven ask Will about the clock", now);
  t.mock.timers.tick(900);
  assert.equal((await act("choice", "pick", { id: "task:Will" })).status, 200);
  assert.equal(cards.at(-1)?.deadline, Date.now() + 1000);
  await postAt("before-click", "cancel", now + 850);
  assert.equal((await readHeard()).find((entry) => entry.id === "before-click")?.rule, "nothing-pending");
  t.mock.timers.tick(200);
  await postAt("after-click", "cancel", now + 1100);
  assert.deepEqual([cards.at(-1)?.id, cards.at(-1)?.state], ["choice", "cancelled"]);
  t.mock.timers.tick(1000);
  assert.ok(!queued("Will").includes("ask Will about the clock"));
});

test("capture transport delay does not move an API pick before a pre-click cancel", async (t) => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const postAt = (id: string, text: string, capturedAt: number) =>
    post(utterancePath(), { ...capture(text, id), capturedAt }, token);
  await postAt("choice", "Steven ask Will about transit", now - 300);
  t.mock.timers.tick(500);
  assert.equal((await act("choice", "pick", { id: "task:Will" })).status, 200);
  t.mock.timers.tick(50);
  await postAt("in-transit", "cancel", now + 400);
  assert.deepEqual(registry.snapshot().voiceCards?.map(({ id, state }) => [id, state]), [["choice", "pending"]]);
  assert.equal((await readHeard()).find(({ id }) => id === "in-transit")?.rule, "nothing-pending");
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

test("quoted stop messages reach the queue verbatim while bare stop still interrupts", async () => {
  const before = interrupts.length;
  const messages = ['"stop"', "'STOP!'", "“stop”", "«stop»."];
  for (const [index, message] of messages.entries()) {
    const id = "quoted-stop-" + index;
    await say("Steve, " + message, id);
    assert.equal((await act(id, "send-now")).status, 200);
    assert.deepEqual([cards.at(-1)?.state, queued("Steve").at(-1)], ["queued", message]);
  }
  assert.equal(interrupts.length, before);
  for (const command of ["stop", "Stop!"]) {
    const id = randomUUID();
    await say("Steve, " + command, id);
    assert.equal((await act(id, "send-now")).status, 200);
  }
  assert.deepEqual(interrupts.slice(before), ["sdk:Steve", "sdk:Steve"]);
});

test("extra message punctuation is queued verbatim and cannot turn stop into an interrupt", async () => {
  const before = interrupts.length;
  for (const [captureText, message] of [
    ["Will,,,stop", ",,stop"], ["“Will,”,,,stop", ",,stop"], ["Will, #stop!", "#stop!"], ["Will, stop,", "stop,"],
  ] as const) {
    const id = randomUUID();
    await say(captureText, id);
    assert.equal((await act(id, "send-now")).status, 200);
    assert.deepEqual([cards.at(-1)?.state, queued("Will").at(-1)], ["queued", message]);
  }
  assert.equal(interrupts.length, before);
  await say("Will, STOP。", "punctuated-command");
  await act("punctuated-command", "send-now");
  assert.deepEqual(interrupts.slice(before), ["sdk:Will"]);
});

test("space before an address's closing quote preserves bare and quoted stop behavior", async () => {
  const before = interrupts.length;
  for (const text of ["“Will, ” stop", "“ Will ” , stop"]) {
    const id = randomUUID();
    await say(text, id);
    assert.equal((await act(id, "send-now")).status, 200);
  }
  assert.deepEqual(interrupts.slice(before), ["sdk:Will", "sdk:Will"]);
  await say("“Will, ” “stop”", "message-quote");
  assert.equal((await act("message-quote", "send-now")).status, 200);
  assert.deepEqual([cards.at(-1)?.state, queued("Will").at(-1)], ["queued", "“stop”"]);
  assert.equal(interrupts.length, before + 2);
});

test("mismatched address wrappers stay in the queued message and cannot trigger a stop", async () => {
  const before = interrupts.length;
  for (const [captureText, message] of [
    ["[Will, ) stop", ") stop"], ["“Will, ’ stop", "’ stop"], ["[Will), stop", "), stop"],
    ["「[Will, ] 』 stop", "』 stop"],
  ] as const) {
    const id = randomUUID();
    await say(captureText, id);
    assert.equal((await act(id, "send-now")).status, 200);
    assert.deepEqual([cards.at(-1)?.state, queued("Will").at(-1)], ["queued", message]);
  }
  assert.equal(interrupts.length, before);
  for (const captureText of ["[Will, ] stop", "「[Will, ] 」 stop"]) {
    const id = randomUUID();
    await say(captureText, id);
    assert.equal((await act(id, "send-now")).status, 200);
  }
  assert.deepEqual(interrupts.slice(before), ["sdk:Will", "sdk:Will"]);
});

test("a stop after an unclosed address wrapper queues as text at the deadline", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const before = interrupts.length;
  const messages = queued("Will");
  for (const text of ["[Will, stop", "“Will, STOP!", "「[Will, ] stop", ", [Will, stop"]) await say(text);
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.equal(interrupts.length, before);
  assert.deepEqual(queued("Will").slice(messages.length), ["stop", "STOP!", "stop", "stop"]);
  assert.deepEqual(cards.slice(-4).map(({ state }) => state), ["queued", "queued", "queued", "queued"]);
});

test("a later mention of Steve opens a pending card for Will and queues the entire message to Will alone", async () => {
  const body = "ask Steve about the build";
  await say("Will, " + body, "mention");
  assert.equal(cards[0]?.state, "pending");
  assert.equal(cards[0]?.parts[0]?.target?.name, "Will");
  assert.equal(cards[0]?.parts[0]?.text, body);
  assert.deepEqual(cards[0]?.candidates, []);
  assert.equal((await act("mention", "send-now")).status, 200);
  assert.ok(queued("Will").includes(body));
  assert.ok(!queued("Steve").includes(body));
});

test("unsure waits indefinitely, cancels without sending, and accepts a spoken or clicked candidate", async () => {
  await say("Steven tell Will something", "ambiguous");
  assert.equal(cards[0]?.state, "unsure");
  assert.equal(cards[0]?.deadline, null);
  assert.equal((await act("ambiguous", "send-now")).status, 409);
  await say("cancel");
  assert.equal(cards.at(-1)?.state, "cancelled");
  assert.ok(!queued("Steve").includes("tell Will something"));
  for (const method of ["spoken", "click"]) {
    await say("Steven ask Will", method);
    assert.equal((await act(method, "pick", { id: "unknown" })).status, 409);
    if (method === "spoken") await say("Will");
    else assert.equal((await act(method, "pick", { id: "task:Will" })).status, 200);
    assert.equal(cards.at(-1)?.state, "pending");
    assert.equal(cards.at(-1)?.parts[0]?.target?.name, "Will");
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
  assert.equal(cards.at(-1)?.parts[0]?.target?.name, "Will");
  assert.equal((await act("older", "send-now")).status, 200);
  assert.deepEqual(queued("Will").filter((text) => text === "ask Will about the build"), ["ask Will about the build"]);
});

test("a candidate with leading or nonterminal boundary punctuation leaves the card open until a bare pick", async () => {
  await app.request("/api/voice/config", { method: "PUT", headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ cancelWindow: { enabled: false } }) });
  const before = queued("Will");
  await say("Steven ask Will about the results", "choice");
  for (const text of [",Will", " ?Will.", "Will,", "(Will)", "“Will”", '"Will"!', "'Will'", "“ Will ”", '" Will "!', "「 “ Will ” 」"]) {
    await say(text);
    assert.equal((await readHeard())[0]?.rule, "no-message");
    assert.deepEqual(queued("Will"), before);
    assert.deepEqual(registry.snapshot().voiceCards?.map((card) => card.state), ["unsure"]);
  }
  await say("Will.");
  assert.deepEqual(queued("Will"), [...before, "ask Will about the results"]);
  assert.deepEqual(registry.snapshot().voiceCards, []);
});

test("a delayed spoken pick can only queue an unsure capture that preceded it", async () => {
  await app.request("/api/voice/config", { method: "PUT", headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ cancelWindow: { enabled: false } }) });
  const now = Date.now();
  const postAt = (id: string, text: string, capturedAt: number) =>
    post(utterancePath(), { ...capture(text, id), capturedAt }, token);
  const before = queued("Will");
  await postAt("newer", "Steven ask Will about tomorrow", now - 100);
  await postAt("too-early", "Will", now - 400);
  assert.deepEqual(queued("Will"), before);
  assert.equal((await readHeard()).find((entry) => entry.id === "too-early")?.rule, "no-message");
  await postAt("older", "Steven ask Will about yesterday", now - 300);
  await postAt("between", "Will", now - 200);
  assert.deepEqual(queued("Will"), [...before, "ask Will about yesterday"]);
  assert.equal((await readHeard()).find((entry) => entry.id === "between")?.rule, "pick");
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
    ["adjacent-commas", "Will,,,", ",,"],
    ["quoted-name", '"Will",,,', ",,"],
    ["inner-and-outer-separator", "“Will,”,,,", ",,"],
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
  assert.deepEqual(cards.slice(-2).map((c) => [c.id, c.state, c.parts[0]?.target?.sessionId]), [
    ["stop-original", "not-running", "sdk:Will"], ["picked-message", "not-running", "sdk:Will"],
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
    assert.deepEqual(await (await post(utterancePath(), { ...capture(text), words }, token)).json(), { accepted: true });
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

test("the listener posts a delayed message before a concurrently spoken cancel", async (t) => {
  const { say: sayFixture } = await import("../e2e/fixtures/voice.ts");
  voiceStateStore.reset();
  const daemon = { home, baseURL: "http://localhost" };
  let markStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  const posted: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (new URL(url).pathname === "/voice/utterances") {
      const { id } = JSON.parse(String(init.body));
      posted.push(id);
      if (id === "first") {
        markStarted();
        await delayed;
      }
    }
    return app.request(url, init);
  });

  const message = sayFixture(daemon, "Will discard these words", { id: "first" });
  await started;
  const cancel = sayFixture({ ...daemon }, "cancel", { id: "second" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const inFlight = [...posted];
  release();
  const responses = await Promise.all([message, cancel]);
  assert.deepEqual(inFlight, ["first"]);
  assert.deepEqual(posted, ["first", "second"]);
  for (const response of responses) assert.deepEqual(await response.json(), { accepted: true });
  assert.deepEqual(cards.map(({ id, state }) => [id, state]), [["first", "pending"], ["first", "cancelled"]]);
  assert.deepEqual(registry.snapshot().voiceCards, []);
  assert.ok(!queued("Will").includes("discard these words"));
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

test("at capacity the router rejects new cards but preserves deadlines, picks, cancels and retries", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  await say("Steven ask Will", "choice");
  for (let i = 1; i < 50; i++) {
    assert.deepEqual(await (await say("Will wait", "pending-" + i)).json(), { accepted: true });
  }
  const snapshot = registry.snapshot().voiceCards;
  assert.equal(snapshot?.length, 50);
  assert.deepEqual(await (await say("Will try again", "overflow")).json(), { accepted: false });
  assert.deepEqual(registry.snapshot().voiceCards, snapshot);
  assert.equal(registry.voiceRouter!.pendingVoiceActions.length, 50);
  assert.ok(!(await readHeard()).some(({ id }) => id === "overflow"));
  assert.deepEqual(await (await say("Will")).json(), { accepted: true });
  assert.deepEqual([cards.at(-1)?.id, cards.at(-1)?.state], ["choice", "pending"]);
  await say("cancel");
  assert.deepEqual([cards.at(-1)?.id, cards.at(-1)?.state], ["choice", "cancelled"]);
  assert.deepEqual(await (await say("Will try again", "overflow")).json(), { accepted: true });
  assert.deepEqual([cards.at(-1)?.id, cards.at(-1)?.state], ["overflow", "pending"]);
});

test("out-of-order unsure captures keep the five newest choices, including when the incoming card is oldest", async () => {
  const postUnsure = (id: string, capturedAt: number) =>
    post(utterancePath(), { ...capture("Steven ask Will", id), capturedAt }, token);
  for (const time of [30, 10, 50, 20, 40]) await postUnsure(String(time), time);
  await postUnsure("stale", 5);
  assert.deepEqual(cards.filter((card) => card.id === "stale").map((card) => card.state), ["cancelled"]);
  assert.equal((await act("stale", "pick", { id: "task:Will" })).status, 409);
  await postUnsure("tie", 10);
  assert.deepEqual(registry.snapshot().voiceCards?.map((card) => card.id), ["30", "50", "20", "40", "tie"]);
  assert.deepEqual(registry.voiceRouter!.pendingVoiceActions.map((action) => action.id), ["30", "50", "20", "40", "tie"]);
  const cancelled = (await readHeard()).filter((entry) => entry.outcome === "cancelled");
  assert.deepEqual(cancelled.map((entry) => entry.id), ["10", "stale"]);
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
