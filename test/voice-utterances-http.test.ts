import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SdkSupervisor } from "../src/server/sdk/supervisor.ts";
import type { HeardEntry, VoiceCard } from "../src/shared/voice-routing.ts";
import type { SpokenName } from "../src/shared/voice-names.ts";
import { FakeVoiceListener } from "./helpers/fake-voice-listener.ts";
import { ensureNativeStateLockAddon } from "./helpers/native-state-lock.ts";
import { voiceHostTimeUs } from "../src/server/voice/host-clock.ts";

before(() => { ensureNativeStateLockAddon(); });

const home = mkdtempSync(join(tmpdir(), "mission-voice-routing-"));
process.env.MISSION_HOME = home;
const { buildApp } = await import("../src/server/routes.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { PendingTurnManager } = await import("../src/server/pending-turns.ts");
const { voiceStateStore, wireVoiceStateEvents } = await import("../src/server/voice/state.ts");
const { VOICE_REQUIRED_FLAGS, VOICE_HELLO_LAPSE_MS, VOICE_LISTENER_PROTOCOL_VERSION, VOICE_SHELL_REPORT_LAPSE_MS } = await import("../src/shared/voice.ts");
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

let reportUs = 0;
function orderedShellReport(snapshot: object, auth: string) {
  // These fixtures drive the shell clock with the test timer. The wall-step
  // regression below supplies independent host and Unix timestamps explicitly.
  reportUs = Math.max(reportUs + 1, Date.now() * 1000);
  return post("/voice/shell-report", { reportedAtHostUs: reportUs, ...snapshot }, auth);
}

beforeEach(async () => {
  reportUs = 0;
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
  t.mock.method(performance, "now", () => Date.now() - now);
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
  const now = Math.floor(voiceHostTimeUs() / 1000) - 1000;
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const press = (pushToTalk: boolean, keyUpMs?: number | string) =>
    orderedShellReport({ callActive: true, pushToTalk, pushToTalkReleasedAtHostUs: typeof keyUpMs === "number" ? keyUpMs * 1000 : keyUpMs }, token);
  const poll = () => app.request("/voice/listener/directive", {
    headers: { "x-harness-token": token, "x-voice-listener-id": listenerId },
  });
  const submit = async (revision: string, capturedAt: number, id: string, end: number | null = capturedAt + 1) =>
    (await app.request(utterancePath(revision), { method: "POST", headers: {
      host: "localhost", "content-type": "application/json", "x-harness-token": token, "x-voice-listener-id": listenerId,
      "x-voice-capture-start-host-us": String(capturedAt * 1000),
      ...(end === null ? {} : { "x-voice-capture-end-host-ms": String(end) }),
    }, body: JSON.stringify({ ...capture("Steve finish this", id), capturedAt }) })).json();
  await press(true);
  const held = voiceStateStore.directive();
  assert.equal(held.capture, true);
  assert.equal((await poll()).headers.get("x-voice-held-revision"), held.revision);
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
  assert.equal(off.headers.get("x-voice-held-revision"), null);
  assert.equal(off.headers.get("x-voice-release-revision"), held.revision);
  assert.equal(off.headers.get("x-voice-release-host-ms"), String(now + 100));
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
  assert.deepEqual(cards.filter(card => card.state === "queued").map(card => card.id), ["inside", "in-flight", "tail"]);
  assert.equal(queued("Steve").length, initialQueue + 3);

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
    assert.equal(stopped.headers.get("x-voice-release-host-ms"), null);
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
  const startUs = voiceHostTimeUs() - 10_000;
  await post("/voice/shell-report", { reportedAtHostUs: startUs, callActive: true, pushToTalk: true }, token);
  const held = voiceStateStore.directive().revision;
  const words = capture("Steve check the build");
  const send = () => app.request(utterancePath(held), { method: "POST", headers: {
    host: "localhost", "content-type": "application/json", "x-harness-token": token,
    "x-voice-listener-id": listenerId, "x-voice-capture-end-host-ms": String(Math.ceil(startUs / 1000) + 1),
    "x-voice-capture-start-host-us": String(startUs),
  }, body: JSON.stringify(words) });
  const waiting = send();
  await new Promise<void>(resolve => setImmediate(resolve));
  t.mock.timers.tick(25_000);
  const retry = await waiting;
  assert.equal(retry.headers.get("x-voice-held-revision"), held);
  assert.deepEqual(await retry.json(), { accepted: false });
  assert.deepEqual(await readHeard(), []);
  const releasedUs = voiceHostTimeUs();
  await post("/voice/shell-report", { reportedAtHostUs: releasedUs, callActive: true, pushToTalk: false, pushToTalkReleasedAtHostUs: releasedUs }, token);
  assert.deepEqual(await (await send()).json(), { accepted: true });
  assert.deepEqual((await readHeard()).map(entry => entry.id), [words.id]);
});

test("a replayed key-up cannot stop a later hold and a heartbeat does not move its start", async (t) => {
  const now = Math.floor(voiceHostTimeUs() / 1000) - 1000;
  t.mock.timers.enable({ apis: ["Date"], now });
  const press = (pushToTalk: boolean, keyUpMs?: number) =>
    orderedShellReport({ callActive: true, pushToTalk, pushToTalkReleasedAtHostUs: keyUpMs === undefined ? undefined : keyUpMs * 1000 }, token);
  await press(true);
  t.mock.timers.setTime(now + 20);
  await press(false, now + 20);
  t.mock.timers.setTime(now + 40);
  await press(true);
  const current = voiceStateStore.directive();
  t.mock.timers.setTime(now + 80);
  await press(true);
  const stale = await press(false, now + 20);
  assert.equal((await stale.json()).state.mode, "push-to-talk");
  assert.deepEqual(voiceStateStore.directive(), current);
  assert.equal(voiceStateStore.releasedCapture(current.revision), undefined);
  const released = await press(false, now + 60);
  assert.equal((await released.json()).state.mode, "auto-muted");
  assert.deepEqual(voiceStateStore.releasedCapture(current.revision), { revision: current.revision, pressedAtUs: (now + 40) * 1000, at: now + 60 });

  // Both events of a quick tap can have occurred before the daemon receives key-down.
  await orderedShellReport({ callActive: true, pushToTalk: true, pushToTalkPressedAtHostUs: (now + 70) * 1000 }, token);
  const quick = voiceStateStore.directive();
  assert.equal((await (await press(false, now + 75)).json()).state.mode, "auto-muted");
  assert.deepEqual(voiceStateStore.releasedCapture(quick.revision), { revision: quick.revision, pressedAtUs: (now + 70) * 1000, at: now + 75 });
});

test("a newer dated press supersedes a hold before the delayed key-up arrives", async (t) => {
  const now = Math.floor(voiceHostTimeUs() / 1000) - 1000;
  t.mock.timers.enable({ apis: ["Date"], now });
  const down = (stamp?: number) => orderedShellReport({ callActive: true, pushToTalk: true, pushToTalkPressedAtHostUs: stamp === undefined ? undefined : stamp * 1000 }, token);
  const up = (stamp: number) => orderedShellReport({ callActive: true, pushToTalk: false, pushToTalkReleasedAtHostUs: stamp * 1000 }, token);
  await down(now);
  const first = voiceStateStore.directive();
  t.mock.timers.setTime(now + 60);
  await down(now + 30);
  const second = voiceStateStore.directive();
  assert.equal(second.capture, true);
  assert.notEqual(second.revision, first.revision);
  assert.equal(voiceStateStore.releasedCapture(first.revision), undefined);
  for (const stamp of [now + 30, undefined, now]) {
    await down(stamp);
    assert.equal(voiceStateStore.directive().revision, second.revision);
  }
  await up(now + 15);
  assert.deepEqual(voiceStateStore.directive(), second);
  await up(now + 50);
  assert.equal(voiceStateStore.directive().capture, false);
  assert.deepEqual(voiceStateStore.releasedCapture(second.revision), { revision: second.revision, pressedAtUs: (now + 30) * 1000, at: now + 50 });
  await down(now + 30);
  assert.equal(voiceStateStore.directive().capture, false, "replaying the completed press cannot reopen the microphone");
});

test("a future shell observation cannot change call state or block the next valid observation", async () => {
  const report = async (reportedAtHostUs: number, callActive: boolean) =>
    (await (await post("/voice/shell-report", { reportedAtHostUs, callActive }, token)).json()).state;
  assert.equal((await report(voiceHostTimeUs(), true)).mode, "auto-muted");
  assert.equal((await report(Date.now() * 1000, false)).mode, "auto-muted");
  assert.equal((await report(voiceHostTimeUs(), false)).mode, "listening");
});

test("an unordered shell report cannot reopen capture or release a key after an ordered call snapshot", async (t) => {
  t.mock.method(voiceStateStore, "hostNowUs", () => 1_000_000);
  const report = async (body: object) => (await (await post("/voice/shell-report", body, token)).json()).state;
  assert.equal((await report({ reportedAtHostUs: 100, callActive: true })).mode, "auto-muted");
  for (const reportedAtHostUs of [undefined, "invalid", -1]) {
    await report({ reportedAtHostUs, callActive: false });
    assert.equal(voiceStateStore.directive().capture, false);
  }
  await report({ reportedAtHostUs: 200, callActive: true, pushToTalk: true });
  const held = voiceStateStore.directive();
  assert.equal(held.capture, true);
  await report({ pushToTalk: false });
  assert.deepEqual(voiceStateStore.directive(), held);
  assert.equal((await report({ reportedAtHostUs: 300, callActive: false })).mode, "listening");
});

test("ordered shell reports ignore a delayed idle heartbeat and release on host time across a wall-clock step", async (t) => {
  t.mock.method(voiceStateStore, "hostNowUs", () => 1_000_000);
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now });
  const report = (body: object) => post("/voice/shell-report", { callActive: true, ...body }, token);
  const poll = () => app.request("/voice/listener/directive", { headers: { "x-harness-token": token, "x-voice-listener-id": listenerId } });
  assert.ok((await report({ reportedAtHostUs: 500_000, pushToTalk: true, pushToTalkPressedAtHostUs: 490_000 })).ok);
  const held = voiceStateStore.directive();
  assert.equal(held.capture, true);
  await report({ reportedAtHostUs: 499_999, pushToTalk: false });
  await report({ reportedAtHostUs: 500_000, pushToTalk: false });
  assert.deepEqual(voiceStateStore.directive(), held);
  t.mock.timers.setTime(now + 60_000);
  await report({ reportedAtHostUs: 800_000, pushToTalk: false, pushToTalkReleasedAtHostUs: 700_000, pushToTalkReleasedAt: now + 9900 });
  const off = await poll();
  assert.equal(off.headers.get("x-voice-release-host-ms"), "700");
  assert.equal(off.headers.get("x-voice-release-at"), null);
  const send = async (end: number) => (await app.request(utterancePath(held.revision), {
    method: "POST", headers: { "content-type": "application/json", "x-harness-token": token,
      "x-voice-listener-id": listenerId, "x-voice-capture-start-host-us": "490000", "x-voice-capture-end-host-ms": String(end) },
    body: JSON.stringify({ ...capture("Steve finish this"), capturedAt: now }),
  })).json();
  assert.deepEqual(await send(701), { accepted: false });
  assert.deepEqual(await send(700), { accepted: true });
  assert.deepEqual(await send(489), { accepted: false });

  await report({ reportedAtHostUs: 900_000, pushToTalk: true });
  await report({ reportedAtHostUs: 950_000, pushToTalk: false, pushToTalkReleasedAt: Date.now() });
  const legacy = await poll();
  assert.equal((await legacy.json()).capture, false);
  assert.equal(legacy.headers.get("x-voice-release-revision"), null);
  await report({ pushToTalk: true, pushToTalkPressedAt: Date.now() });
  assert.equal(voiceStateStore.directive().capture, false, "an unsequenced launcher cannot open a hold");
});

test("a backward wall-clock step preserves verified held speech and its original capture time", async (t) => {
  t.mock.method(voiceStateStore, "hostNowUs", () => 1_000_000);
  const capturedAt = Date.now();
  await app.request("/api/voice/config", { method: "PUT", headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ cancelWindow: { enabled: false } }) });
  const report = (body: object) => post("/voice/shell-report", { callActive: true, ...body }, token);
  await report({ reportedAtHostUs: 500_000, pushToTalk: true, pushToTalkPressedAtHostUs: 490_000 });
  const held = voiceStateStore.directive().revision;
  t.mock.method(Date, "now", () => capturedAt - 60_000);
  await report({ reportedAtHostUs: 800_000, pushToTalk: false, pushToTalkReleasedAtHostUs: 700_000 });
  const send = async (end: number) => (await app.request(utterancePath(held), {
    method: "POST", headers: { "content-type": "application/json", "x-harness-token": token,
      "x-voice-listener-id": listenerId, "x-voice-capture-start-host-us": "490000", "x-voice-capture-end-host-ms": String(end) },
    body: JSON.stringify({ ...capture("Steve check the release", String(end)), capturedAt }),
  })).json();
  const count = queued("Steve").length;
  assert.deepEqual(await send(489), { accepted: false });
  assert.deepEqual(await send(701), { accepted: false });
  assert.deepEqual(await send(700), { accepted: true });
  assert.deepEqual((await readHeard()).map(({ id, time }) => [id, time]), [["700", capturedAt]]);
  assert.deepEqual(queued("Steve").slice(count), ["check the release"]);
});

test("released speech must start at or after physical key-down and end by key-up", async (t) => {
  t.mock.method(voiceStateStore, "hostNowUs", () => 1_000_000);
  const report = (body: object) => post("/voice/shell-report", { callActive: true, ...body }, token);
  await report({ reportedAtHostUs: 500_800, pushToTalk: true, pushToTalkPressedAtHostUs: 500_700 });
  const held = voiceStateStore.directive().revision;
  await report({ reportedAtHostUs: 504_000, pushToTalk: false, pushToTalkReleasedAtHostUs: 503_999 });
  const send = async (start: number | null, end: number) => (await app.request(utterancePath(held), {
    method: "POST", headers: { "content-type": "application/json", "x-harness-token": token,
      "x-voice-listener-id": listenerId, "x-voice-capture-end-host-ms": String(end),
      ...(start === null ? {} : { "x-voice-capture-start-host-us": String(start) }) },
    body: JSON.stringify(capture("Will check the hold")),
  })).json();
  for (const start of [null, 500_699, 503_000, 503_001, 500_700.5]) {
    assert.deepEqual(await send(start, 503), { accepted: false });
  }
  assert.deepEqual(await send(500_700, 504), { accepted: false });
  assert.deepEqual(await send(500_700, 503), { accepted: true });
  assert.equal((await readHeard()).length, 1);
});

test("released controls follow monotonic capture order when Unix times move backward", async (t) => {
  t.mock.method(voiceStateStore, "hostNowUs", () => 1_000_000);
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const report = (body: object) => post("/voice/shell-report", { callActive: true, ...body }, token);
  await report({ reportedAtHostUs: 201_000, callActive: true, pushToTalk: true, pushToTalkPressedAtHostUs: 200_000 });
  const held = voiceStateStore.directive().revision;
  await report({ reportedAtHostUs: 800_000, pushToTalk: false, pushToTalkReleasedAtHostUs: 800_000 });
  const submit = async (id: string, text: string, hostUs: number, unixMs: number) => {
    const response = await app.request(utterancePath(held), { method: "POST", headers: {
      "content-type": "application/json", "x-harness-token": token, "x-voice-listener-id": listenerId,
      "x-voice-capture-start-host-us": String(hostUs), "x-voice-capture-end-host-ms": String(Math.ceil(hostUs / 1000) + 10),
    }, body: JSON.stringify({ ...capture(text, id), capturedAt: unixMs }) });
    assert.deepEqual(await response.json(), { accepted: true });
  };
  await submit("command", "Will review this", 300_000, now);
  await submit("later-command", "Will keep this", 500_000, now - 2000);
  await submit("cancel", "cancel", 400_000, now - 60_000);
  assert.deepEqual([cards.at(-1)?.id, cards.at(-1)?.state], ["command", "cancelled"]);
  await submit("choice", "Steven ask Will", 600_000, now - 61_000);
  await submit("too-early", "Will", 550_000, now);
  assert.equal(cards.at(-1)?.state, "unsure");
  await submit("pick", "Will", 650_000, now - 62_000);
  assert.deepEqual([cards.at(-1)?.id, cards.at(-1)?.state], ["choice", "pending"]);
  await submit("before-pick", "cancel", 625_000, now);
  assert.deepEqual([cards.at(-1)?.id, cards.at(-1)?.state], ["later-command", "cancelled"]);
  await submit("after-pick", "cancel", 675_000, now - 63_000);
  assert.deepEqual([cards.at(-1)?.id, cards.at(-1)?.state], ["choice", "cancelled"]);
  assert.equal((await readHeard()).find(entry => entry.id === "cancel")?.time, now - 60_000);
});

test("a fresh snapshot with a stale key event renews call state and applies permission without authorizing audio", async (t) => {
  const start = performance.now();
  let elapsed = start;
  t.mock.method(voiceStateStore, "hostNowUs", () => 400_000 + Math.round((elapsed - start) * 1000));
  t.mock.method(performance, "now", () => elapsed);
  const report = async (body: object) => (await (await post("/voice/shell-report", { callActive: true, ...body }, token)).json()).state;
  await report({ reportedAtHostUs: 100_000, pushToTalk: true });
  const held = voiceStateStore.directive().revision;
  assert.equal((await report({ reportedAtHostUs: 300_000, pushToTalk: false })).mode, "auto-muted");

  // The shell recovered the physical key-up after its first idle report.
  const idle = { pushToTalk: false, pushToTalkReleasedAtHostUs: 250_000 };
  elapsed += 10_000;
  await report({ ...idle, reportedAtHostUs: 10_300_000 });
  elapsed += 6000;
  assert.equal(voiceStateStore.state().mode, "auto-muted", "the fresh heartbeat kept the active call live");
  assert.equal((await report({ ...idle, reportedAtHostUs: 16_300_000, callActive: false })).mode, "listening");
  assert.equal((await report({ ...idle, reportedAtHostUs: 16_310_000, microphone: "denied" })).mode, "unavailable");
  assert.deepEqual(voiceStateStore.microphoneReading(), { permission: "denied", source: "shell" });
  assert.equal(voiceStateStore.releasedCapture(held), undefined, "a discarded hold cannot be revived");
});

test("a new call cannot renew a released hold when the shell lease lapse timer is late", async t => {
  const start = performance.now();
  let elapsed = start;
  t.mock.method(voiceStateStore, "hostNowUs", () => 400_000 + Math.round((elapsed - start) * 1000));
  t.mock.method(performance, "now", () => elapsed);
  const report = (body: object) => post("/voice/shell-report", { callActive: true, ...body }, token);
  await report({ reportedAtHostUs: 100_000, pushToTalk: true });
  const held = voiceStateStore.directive().revision;
  await report({ reportedAtHostUs: 300_000, pushToTalk: false, pushToTalkReleasedAtHostUs: 250_000 });
  assert.equal(voiceStateStore.releasedCapture(held)?.at, 250);
  elapsed += VOICE_SHELL_REPORT_LAPSE_MS; // No intervening timer, poll or publication.
  await report({ reportedAtHostUs: 15_300_000, pushToTalk: false });
  const delayed = await app.request(utterancePath(held), { method: "POST", headers: {
    "content-type": "application/json", "x-harness-token": token, "x-voice-listener-id": listenerId,
    "x-voice-capture-start-host-us": "100000", "x-voice-capture-end-host-ms": "250",
  }, body: JSON.stringify(capture("Will stale command")) });
  assert.deepEqual(await delayed.json(), { accepted: false });
  assert.deepEqual(voiceStateStore.drainingRevisions(), []);
  assert.deepEqual(await readHeard(), []);
});

test("a newer idle report closes an inferred hold when key-up predates its first snapshot", async (t) => {
  t.mock.method(voiceStateStore, "hostNowUs", () => 1_000_000);
  const report = (body: object) => post("/voice/shell-report", { callActive: true, ...body }, token);
  await report({ reportedAtHostUs: 300_000, pushToTalk: true });
  const held = voiceStateStore.directive();
  assert.equal(held.capture, true);
  await report({ reportedAtHostUs: 350_000, pushToTalk: true });
  for (const order of [400_000, 500_000]) {
    await report({ reportedAtHostUs: order, pushToTalk: false, pushToTalkReleasedAtHostUs: 250_000 });
    assert.equal(voiceStateStore.state().mode, "auto-muted");
    assert.equal(voiceStateStore.directive().capture, false);
    assert.equal(voiceStateStore.releasedCapture(held.revision), undefined);
  }
});

test("a new press and an old release within the same millisecond keep their event order", async (t) => {
  t.mock.method(voiceStateStore, "hostNowUs", () => 1_000_000);
  const report = (body: object) => post("/voice/shell-report", { callActive: true, ...body }, token);
  await report({ reportedAtHostUs: 450_000, pushToTalk: true, pushToTalkPressedAtHostUs: 449_000 });
  const first = voiceStateStore.directive().revision;
  await report({ reportedAtHostUs: 500_200, pushToTalk: false, pushToTalkReleasedAtHostUs: 500_100 });
  assert.equal(voiceStateStore.releasedCapture(first)?.at, 500);
  await report({ reportedAtHostUs: 500_800, pushToTalk: true, pushToTalkPressedAtHostUs: 500_700 });
  const second = voiceStateStore.directive();
  assert.equal(second.capture, true);
  assert.notEqual(second.revision, first);
  await report({ reportedAtHostUs: 502_000, pushToTalk: false, pushToTalkReleasedAtHostUs: 500_100 });
  assert.deepEqual(voiceStateStore.directive(), second);
  await report({ reportedAtHostUs: 504_000, pushToTalk: false, pushToTalkReleasedAtHostUs: 503_999 });
  assert.equal(voiceStateStore.releasedCapture(second.revision)?.at, 503);
});

test("a rapid second press preserves the first release, until a privacy or recipient change", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Math.floor(voiceHostTimeUs() / 1000) - 1000 });
  const press = (down: boolean) => orderedShellReport({
    callActive: true, pushToTalk: down, ...(!down && { pushToTalkReleasedAtHostUs: Date.now() * 1000 }),
  }, token);
  const submit = async (revision: string, at: number) => (await app.request(utterancePath(revision), {
    method: "POST", headers: { "content-type": "application/json", "x-harness-token": token,
      "x-voice-listener-id": listenerId, "x-voice-capture-start-host-us": String((at - 1) * 1000), "x-voice-capture-end-host-ms": String(at) },
    body: JSON.stringify({ ...capture("Steve do this"), capturedAt: at }),
  })).json();
  await press(true);
  t.mock.timers.tick(2);
  const at = Date.now();
  const first = voiceStateStore.directive().revision;
  await press(false);
  await press(true);
  const poll = await app.request("/voice/listener/directive?revision=" + first, {
    headers: { "x-harness-token": token, "x-voice-listener-id": listenerId },
  });
  assert.equal((await poll.json()).capture, true);
  assert.equal(poll.headers.get("x-voice-release-revision"), first, "poll can miss the intervening off directive");
  assert.equal(poll.headers.get("x-voice-draining-revisions"), first);
  assert.deepEqual(await submit(first, at), { accepted: true });
  assert.deepEqual(await submit(first, at + 10_000), { accepted: false });
  const second = voiceStateStore.directive().revision;
  await press(false);
  assert.deepEqual(await submit(first, at), { accepted: true });
  voiceStateStore.useRoster(() => roster.slice(1));
  try {
    assert.deepEqual(await submit(first, at), { accepted: false });
    assert.deepEqual(await submit(second, at), { accepted: false });
  } finally { voiceStateStore.useRoster(() => roster); }
  await press(true);
  const third = voiceStateStore.directive().revision;
  await press(false);
  await post("/api/voice/mute", { muted: true });
  assert.deepEqual(await submit(third, at), { accepted: false });
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

test("turning voice off while a held utterance waits returns the disabled route response", async () => {
  await post("/voice/shell-report", { reportedAtHostUs: voiceHostTimeUs(), callActive: true, pushToTalk: true }, token);
  const count = queued("Steve").length;
  const waiting = say("Steve check the build", "disabled-during-post");
  await new Promise<void>(resolve => setImmediate(resolve));
  applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: false });
  const response = await waiting;
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "This feature is disabled.", feature: "voice" });
  assert.equal(queued("Steve").length, count);
  assert.deepEqual(cards, []);
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
  await post("/voice/shell-report", { reportedAtHostUs: voiceHostTimeUs(), callActive: false, pushToTalk: false }, token);
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
  assert.deepEqual(cards.map((c) => c.reason === "delivering" ? c.reason : c.state), ["pending", "pending", "cancelled", "delivering", "queued"]);
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

test("API and spoken cancels respect the deadline even when the timer callback is late", async (t) => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  await say("Will keep the first", "api-expired");
  t.mock.timers.setTime(now + 1000);
  assert.equal((await act("api-expired", "cancel")).status, 409);

  await say("Steven ask Will", "still-eligible");
  await say("Will keep the second", "spoken-expired");
  t.mock.timers.setTime(now + 2001);
  await say("cancel", "cancel-choice");
  assert.equal((await readHeard()).find(({ id }) => id === "cancel-choice")?.detail, "still-eligible");
  await say("cancel", "empty");
  assert.equal((await readHeard()).find(({ id }) => id === "empty")?.rule, "nothing-pending");
  t.mock.timers.tick(0);
  assert.deepEqual(queued("Will").filter((text) => text === "keep the first" || text === "keep the second"),
    ["keep the first", "keep the second"]);
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

test("ordinary speech and dashboard picks use the native host clock after wall time moves backward", async (t) => {
  const unix = Date.now();
  let wallNow = unix;
  t.mock.method(Date, "now", () => wallNow);
  const speak = async (id: string, text: string, capturedAt: number, startUs: number) =>
    (await app.request(utterancePath(), { method: "POST", headers: {
      "content-type": "application/json", "x-harness-token": token, "x-voice-listener-id": listenerId,
      "x-voice-capture-start-host-us": String(startUs),
    }, body: JSON.stringify({ ...capture(text, id), capturedAt }) })).json();
  assert.deepEqual(await speak("choice", "Steven ask Will", unix, voiceHostTimeUs()), { accepted: true });
  const beforePick = voiceHostTimeUs() - 1;
  assert.equal((await act("choice", "pick", { id: "task:Will" })).status, 200);
  wallNow -= 60_000;
  assert.deepEqual(await speak("before", "cancel", unix, beforePick), { accepted: true });
  assert.equal(cards.at(-1)?.state, "pending");
  assert.deepEqual(await speak("after", "cancel", wallNow, voiceHostTimeUs()), { accepted: true });
  assert.deepEqual([cards.at(-1)?.id, cards.at(-1)?.state], ["choice", "cancelled"]);
  assert.equal((await readHeard()).find(entry => entry.id === "before")?.time, unix);
});

test("quiet lead-in before a dashboard pick does not predate the spoken cancel", async () => {
  await say("Steven ask Will", "choice");
  const pcmStart = voiceHostTimeUs() - 100_000;
  assert.equal((await act("choice", "pick", { id: "task:Will" })).status, 200);
  const speechStart = voiceHostTimeUs();
  const submit = async (onset: number) => (await app.request(utterancePath(), { method: "POST", headers: {
    "content-type": "application/json", "x-harness-token": token, "x-voice-listener-id": listenerId,
    "x-voice-capture-start-host-us": String(pcmStart), "x-voice-capture-end-host-ms": String(Math.ceil(speechStart / 1000) + 1),
    "x-voice-speech-start-host-us": String(onset),
  }, body: JSON.stringify(capture("cancel")) })).json();
  assert.deepEqual(await submit(pcmStart), { accepted: true });
  assert.equal(cards.at(-1)?.state, "pending");
  assert.deepEqual(await submit(speechStart), { accepted: true });
  assert.deepEqual([cards.at(-1)?.id, cards.at(-1)?.state], ["choice", "cancelled"]);
  assert.deepEqual(await submit(pcmStart - 1), { accepted: false });
  assert.deepEqual(await submit((Math.ceil(speechStart / 1000) + 1) * 1000), { accepted: false });
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
  assert.deepEqual(cards.map((c) => c.reason === "delivering" ? c.reason : c.state), ["delivering", "queued", "delivering", "sent"]);
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
  for (const text of ["“Will, ” stop", "“ Will ” , stop", "“Will, ”! stop"]) {
    const id = randomUUID();
    await say(text, id);
    assert.equal((await act(id, "send-now")).status, 200);
  }
  assert.deepEqual(interrupts.slice(before), ["sdk:Will", "sdk:Will", "sdk:Will"]);
  await say("“Will, ” “stop”", "message-quote");
  assert.equal((await act("message-quote", "send-now")).status, 200);
  assert.deepEqual([cards.at(-1)?.state, queued("Will").at(-1)], ["queued", "“stop”"]);
  await say("“Will, ” ! stop", "message-exclamation");
  assert.equal((await act("message-exclamation", "send-now")).status, 200);
  assert.deepEqual([cards.at(-1)?.state, queued("Will").at(-1)], ["queued", "! stop"]);
  assert.equal(interrupts.length, before + 3);
});

test("mismatched address wrappers stay in the queued message and cannot trigger a stop", async () => {
  const before = interrupts.length;
  for (const [captureText, message] of [
    ["[Will, ) stop", ") stop"], ["“Will, ’ stop", "’ stop"], ["[Will), stop", "), stop"],
    ["「[Will, ] 』 stop", "』 stop"], ["Will[ stop", "[ stop"], ["“Will”[ stop", "[ stop"],
    ["Will“ stop”", "“ stop”"], ["Will[] stop", "[] stop"],
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
  for (const [text, body] of [
    ['Will,"ship it"', '"ship it"'], ['"Will, "ship it"', '"ship it"'],
    ["'Will, 'ship it'", "'ship it'"], ['"Will, "stop', '"stop'],
  ] as const) {
    const id = randomUUID();
    await say(text, id);
    assert.equal(cards.at(-1)?.parts[0]?.text, body);
    assert.equal((await act(id, "send-now")).status, 200);
    assert.equal(queued("Will").at(-1), body);
  }
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

test("a reconnect sees an in-flight interrupt until its final event and cannot act on it again", async (t) => {
  let started!: () => void;
  let finish!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const delayed = new Promise<void>((resolve) => { finish = resolve; });
  const driver = t.mock.method(sdk, "interrupt", async () => { started(); await delayed; return "idle"; });
  await say("Will, stop", "in-flight");
  const send = act("in-flight", "send-now");
  await entered;
  try {
    const card = cards.at(-1);
    assert.deepEqual([card?.id, card?.state, card?.reason, card?.deadline], ["in-flight", "pending", "delivering", null]);
    assert.deepEqual(registry.snapshot().voiceCards, [card]);
    assert.deepEqual(registry.voiceRouter!.pendingVoiceActions, []);
    assert.equal((await act("in-flight", "send-now")).status, 409);
    assert.equal((await act("in-flight", "cancel")).status, 409);
  } finally {
    finish();
    await send;
  }
  assert.equal(driver.mock.callCount(), 1);
  assert.equal(cards.at(-1)?.state, "sent");
  assert.deepEqual(registry.snapshot().voiceCards, []);
});

test("acknowledging an immediate interrupt lets the listener send another message and cancel while delivery runs", async (t) => {
  await app.request("/api/voice/config", { method: "PUT", headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ cancelWindow: { enabled: false } }) });
  let finish!: () => void;
  const delayed = new Promise<void>((resolve) => { finish = resolve; });
  t.mock.method(sdk, "interrupt", async () => { await delayed; return "idle"; });
  await say("Steven ask Will", "choice");
  const captures = (async () => {
    for (const [text, id] of [["Will, stop", "slow-stop"], ["Bill keep going", "other"], ["cancel", "dismiss"]] as const) {
      assert.deepEqual(await (await say(text, id)).json(), { accepted: true });
    }
  })();
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(queued("Bill").includes("keep going"));
    assert.equal(cards.findLast((card) => card.id === "choice")?.state, "cancelled");
    assert.deepEqual(registry.snapshot().voiceCards?.map(({ id, reason }) => [id, reason]), [["slow-stop", "delivering"]]);
  } finally {
    finish();
    await captures;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(cards.findLast((card) => card.id === "slow-stop")?.state, "sent");
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
  assert.deepEqual(cards.map((card) => [card.state, card.reason]), [["pending", "exact"], ["pending", "delivering"], ["queued", "exact"]]);
  assert.equal((await readHeard())[0]?.outcome, "queued");
});
