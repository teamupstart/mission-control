import { deferred } from "./helpers/deferred.ts";
import { VOICE_HELLO_LAPSE_MS, VOICE_SHELL_REPORT_LAPSE_MS, VOICE_LISTENER_PROTOCOL_VERSION } from "../src/shared/voice.ts";
import type { HeardEntry } from "../src/shared/voice-routing.ts";
import assert from "node:assert/strict";
import { beforeEach, test, type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { model, utterancePath, listenerId, act, app, applyFeatureFlagIntent, capture, cards, home, interrupts, name, pending, post, queued, readHeard, registry, roster, say, sdk, token, voiceStateStore } from "./helpers/voice-http.ts";

import { ListenerClient } from "../src/voice-listener/client.ts";
import { playRecording } from "../src/voice-listener/playback.ts";
import { FakeVoiceListener } from "./helpers/fake-voice-listener.ts";
import { voiceHostTimeUs } from "../src/server/voice/host-clock.ts";

const resolved = (id: string) => registry.voiceRouter!.resolution(id) ?? Promise.resolve();
let reportUs = 0;
function orderedShellReport(snapshot: object, auth: string) {
  // These fixtures drive the shell clock with the test timer. The wall-step
  // regression below supplies independent host and Unix timestamps explicitly.
  reportUs = Math.max(reportUs + 1, Date.now() * 1000);
  return post("/voice/shell-report", { reportedAtHostUs: reportUs, ...snapshot }, auth);
}

beforeEach(() => { reportUs = 0; });

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

test("a release delivered before its press keeps call capture closed until a new hold", async t => {
  t.mock.method(voiceStateStore, "hostNowUs", () => 1_000_000);
  const report = async (body: object) =>
    (await (await post("/voice/shell-report", { callActive: true, ...body }, token)).json()).state;
  assert.equal((await report({ reportedAtHostUs: 800_000, pushToTalk: false, pushToTalkReleasedAtHostUs: 790_000 })).mode, "auto-muted");
  const released = voiceStateStore.directive();
  assert.equal(released.capture, false);
  assert.equal((await report({ reportedAtHostUs: 500_000, pushToTalk: true, pushToTalkPressedAtHostUs: 150_000 })).mode, "auto-muted");
  assert.deepEqual(voiceStateStore.directive(), released);
  assert.equal((await report({ reportedAtHostUs: 990_000, pushToTalk: true, pushToTalkPressedAtHostUs: 900_000 })).mode, "push-to-talk");
  assert.equal(voiceStateStore.directive().capture, true);
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
  let hostNow = 1_000_000;
  t.mock.method(voiceStateStore, "hostNowUs", () => hostNow);
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const report = (body: object) => post("/voice/shell-report", { callActive: true, ...body }, token);
  await report({ reportedAtHostUs: 201_000, callActive: true, pushToTalk: true, pushToTalkPressedAtHostUs: 200_000 });
  let held = voiceStateStore.directive().revision;
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
  await submit("choice", "Steven ask Will about the deployment", 600_000, now - 61_000);
  await resolved("choice");
  await submit("too-early", "Will", 550_000, now);
  assert.equal(cards.at(-1)?.state, "unsure");
  await submit("before-choices", "Will", 650_000, now);
  assert.equal(cards.at(-1)?.state, "unsure");

  // Only the second hold was recorded after the candidate rows became available.
  hostNow = 2_000_000;
  await report({ reportedAtHostUs: 1_201_000, pushToTalk: true, pushToTalkPressedAtHostUs: 1_200_000 });
  held = voiceStateStore.directive().revision;
  await report({ reportedAtHostUs: 1_800_000, pushToTalk: false, pushToTalkReleasedAtHostUs: 1_800_000 });
  await submit("pick", "Will", 1_650_000, now - 62_000);
  assert.deepEqual([cards.at(-1)?.id, cards.at(-1)?.state], ["choice", "pending"]);
  await submit("before-pick", "cancel", 1_625_000, now);
  assert.deepEqual([cards.at(-1)?.id, cards.at(-1)?.state], ["later-command", "cancelled"]);
  await submit("after-pick", "cancel", 1_675_000, now - 63_000);
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
  const unsure = capture("Steven ask Will about the build", "clock");
  const postAt = (capturedAt: number) => post(utterancePath(), { ...unsure, capturedAt }, token);
  assert.deepEqual(await (await postAt(now + 1001)).json(), { accepted: false });
  assert.deepEqual(await readHeard(), []);
  assert.equal(cards.length, 0);
  assert.deepEqual(await (await postAt(now + 1000)).json(), { accepted: true });
  await resolved(unsure.id);
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
  await postAt("unsure", "Steven ask Will about the build", 700);
  await resolved("unsure");
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
  assert.equal((await say("Steven ask Will about the build", id)).status, 200);
  await resolved(id);
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

test("a dedicated hold opens the separate Cancel window on release while the microphone stays off", async t => {
  const configure = (listeningMode: string) => app.request("/api/voice/config", { method: "PUT",
    headers: { host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ listeningMode }) });
  assert.equal((await configure("push-to-talk")).status, 200);
  t.after(async () => { await configure("always-on"); });
  const headers = { "x-harness-token": token, "x-voice-listener-id": listenerId };
  const poll = () => app.request("/voice/listener/directive", { headers });
  const { pushToTalkSession, configuredHotkey } = voiceStateStore.state();
  const report = (down: boolean, at: number) => post("/voice/shell-report", {
    pushToTalkSession, registeredHotkey: configuredHotkey, capabilities: { hotkey: { available: true } },
    reportedAtHostUs: at, pushToTalk: down,
    ...(down ? { pushToTalkPressedAtHostUs: at } : { pushToTalkReleasedAtHostUs: at }),
  }, token);
  assert.equal((await (await poll()).json()).capture, false);
  await report(true, voiceHostTimeUs());
  const hold = await poll();
  const revision = hold.headers.get("x-voice-held-revision");
  assert.ok(revision);
  const start = voiceHostTimeUs();
  await new Promise(resolve => setTimeout(resolve, 5));
  const up = voiceHostTimeUs();
  await report(false, up);
  assert.equal((await (await poll()).json()).capture, false);
  const utterance = await app.request(utterancePath(revision), { method: "POST", headers: {
    ...headers, host: "localhost", "content-type": "application/json",
    "x-voice-capture-start-host-us": String(start), "x-voice-capture-end-host-ms": String(Math.floor(up / 1000)),
  }, body: JSON.stringify(capture("Steve wait for cancel", "held-message")) });
  assert.deepEqual(await utterance.json(), { accepted: true });
  assert.equal(cards.at(-1)?.state, "pending");
  assert.equal((await (await poll()).json()).capture, false);
  await act("held-message", "cancel");
  assert.equal(cards.at(-1)?.state, "cancelled");
  assert.deepEqual(queued("Steve"), []);
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
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(queued("Steve").filter((s) => ["check the build", "drop this one"].includes(s)), ["check the build"]);
  assert.deepEqual(cards.map((c) => c.reason === "delivering" ? c.reason : c.state), ["pending", "pending", "cancelled", "delivering", "queued"]);
  assert.equal((await readHeard()).find((e) => e.id === "newer")?.outcome, "cancelled");
});

test("a protocol 4.0 listener keeps its microphone revision through countdowns and delay edits", async t => {
  await post("/voice/listener/hello", { backend: "fluidaudio", version: "4.0", devices: [],
    microphone: "granted", modelLoaded: true, reportsSpeechOnset: true }, token);
  const headers = { "x-harness-token": token, "x-voice-listener-id": listenerId };
  const poll = async (revision = "") => (await app.request("/voice/listener/directive?revision=" + revision, { headers })).json();
  const original = await poll();
  const setDelay = (endOfSpeechMs: number) => app.request("/api/voice/config", { method: "PUT",
    headers: { host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ endOfSpeechMs }) });
  t.after(async () => { await setDelay(original.endOfSpeechMs); });
  const waiting = poll(original.revision);
  await new Promise<void>(resolve => setImmediate(resolve));
  await say("Steve keep listening", "legacy-countdown");
  assert.deepEqual(await poll(), original);
  assert.equal((await setDelay(5000)).status, 200);
  await act("legacy-countdown", "send-now");
  assert.deepEqual(await poll(), original);
  assert.deepEqual(await (await post(utterancePath(original.revision), capture("Will still here"), token)).json(), { accepted: true });
  await post("/api/voice/mute", { muted: true });
  const muted = await waiting;
  assert.equal(muted.capture, false);
  assert.notEqual(muted.revision, original.revision);
  await post("/api/voice/mute", { muted: false });
  assert.deepEqual(await (await post(utterancePath(original.revision), capture("Will stale audio"), token)).json(), { accepted: false });
});

test("spoken cancel beats a four-second delivery window with a five-second speech delay", async (t) => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const configure = (endOfSpeechMs: number) => app.request("/api/voice/config", {
    method: "PUT", headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ endOfSpeechMs, cancelWindow: { enabled: true, seconds: 4 } }),
  });
  const originalDelay = voiceStateStore.directive().endOfSpeechMs;
  assert.ok(originalDelay !== undefined);
  t.after(async () => { await configure(originalDelay); });
  assert.equal((await configure(5000)).status, 200);
  const headers = { "x-harness-token": token, "x-voice-listener-id": listenerId };
  const directive = async (revision = "") => (await app.request("/voice/listener/directive?revision=" + revision, { headers })).json();
  const ordinary = await directive();
  assert.equal(ordinary.endOfSpeechMs, 5000);
  const waiting = directive(ordinary.revision);
  await new Promise<void>(resolve => setImmediate(resolve));
  await say("Steve keep this message", "long-delay-keep");
  assert.equal(cards.at(-1)?.deadline, now + 4000);
  assert.equal((await directive()).endOfSpeechMs, 500);
  const listeningForCancel = await waiting;
  assert.equal(listeningForCancel.endOfSpeechMs, 500);
  assert.equal(listeningForCancel.captureRevision, ordinary.captureRevision);

  // A second countdown overlaps the first one. Speak for 300 ms, then wait for the listener's boundary.
  t.mock.timers.tick(100);
  await say("Steve drop this one", "long-delay-drop");
  const cancel = capture("cancel");
  t.mock.timers.tick(300 + listeningForCancel.endOfSpeechMs);
  assert.deepEqual(await (await post(utterancePath(ordinary.captureRevision), cancel, token)).json(), { accepted: true });
  assert.deepEqual([cards.at(-1)?.id, cards.at(-1)?.state], ["long-delay-drop", "cancelled"]);
  assert.equal((await configure(3000)).status, 200);
  assert.equal((await directive()).endOfSpeechMs, 500);
  const closing = directive(listeningForCancel.revision);
  await new Promise<void>(resolve => setImmediate(resolve));
  t.mock.timers.tick(now + 4000 - Date.now());
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(queued("Steve"), ["keep this message"]);
  assert.equal((await closing).endOfSpeechMs, 3000);
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

  await say("Steven ask Will about the build", "still-eligible");
  await resolved("still-eligible");
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
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: now - 400 });
  await post(utterancePath(), { ...capture("Steven ask Will about the build", "choice"), capturedAt: now - 400 }, token);
  await resolved("choice");
  t.mock.timers.tick(400);
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
  assert.deepEqual(await speak("choice", "Steven ask Will about the deployment", unix, voiceHostTimeUs()), { accepted: true });
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
  await say("Steven ask Will about the deployment", "choice");
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
  const steveBefore = queued("Steve");
  const willBefore = queued("Will");
  await postAt("choice", "Steven ask Will about the clock", now);
  await resolved("choice");
  t.mock.timers.tick(900);
  assert.equal((await act("choice", "pick", { id: "task:Will" })).status, 200);
  assert.equal(cards.at(-1)?.deadline, Date.now() + 1000);
  await postAt("before-click", "cancel", now + 850);
  assert.equal((await readHeard()).find((entry) => entry.id === "before-click")?.rule, "nothing-pending");
  t.mock.timers.tick(200);
  await postAt("after-click", "cancel", now + 1100);
  assert.deepEqual([cards.at(-1)?.id, cards.at(-1)?.state], ["choice", "cancelled"]);
  t.mock.timers.tick(1000);
  assert.deepEqual(queued("Steve"), steveBefore);
  assert.deepEqual(queued("Will"), willBefore);
});

test("capture transport delay does not move an API pick before a pre-click cancel", async (t) => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const postAt = (id: string, text: string, capturedAt: number) =>
    post(utterancePath(), { ...capture(text, id), capturedAt }, token);
  await postAt("choice", "Steven ask Will about transit", now - 300);
  await resolved("choice");
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
    assert.equal(cards.at(-1)?.parts[0]?.command, undefined);
  }
  assert.equal(interrupts.length, before);
  for (const command of ["stop", "Stop!"]) {
    const id = randomUUID();
    await say("Steve, " + command, id);
    assert.equal((await act(id, "send-now")).status, 409);
    assert.equal(cards.at(-1)?.parts[0]?.command, "stop");
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
  assert.equal((await act("punctuated-command", "send-now")).status, 409);
  assert.deepEqual(interrupts.slice(before), ["sdk:Will"]);
});

test("space before an address's closing quote preserves bare and quoted stop behavior", async () => {
  const before = interrupts.length;
  for (const text of ["“Will, ” stop", "“ Will ” , stop", "“Will, ”! stop"]) {
    const id = randomUUID();
    await say(text, id);
    assert.equal((await act(id, "send-now")).status, 409);
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
    assert.equal((await act(id, "send-now")).status, 409);
  }
  assert.deepEqual(interrupts.slice(before), ["sdk:Will", "sdk:Will"]);
});

test("a stop after an unclosed address wrapper queues as text at the deadline", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const before = interrupts.length;
  const messages = queued("Will");
  for (const text of ["[Will, stop", "“Will, STOP!", "「[Will, ] stop", ", [Will, stop"]) await say(text);
  t.mock.timers.tick(1000);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(interrupts.length, before);
  assert.deepEqual(queued("Will").slice(messages.length), ["stop", "STOP!", "stop", "stop"]);
  assert.deepEqual(cards.slice(-4).map(({ state }) => state), ["queued", "queued", "queued", "queued"]);
});

test("a later mention of Steve opens a pending card for Will and queues the entire message to Will alone", async () => {
  const body = "ask Steve about the build";
  model.decide = (questions) => {
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

test("a split stays queued until both agents confirm their own deliveries", async () => {
  model.decide = () => ({ rung: "job", answers: [{ choice: "split", confidence: 1 }], detail: "scripted" });
  await say("Steve, check the build, and Will, review the PR", "split");
  await resolved("split");
  assert.deepEqual(cards.at(-1)?.parts.map((p) => [p.target?.name, p.text]), [["Steve", "check the build"], ["Will", "review the PR"]]);
  assert.equal((await act("split", "send-now")).status, 200);
  assert.ok(queued("Steve").includes("check the build"));
  assert.ok(queued("Will").includes("review the PR"));
  assert.equal(cards.at(-1)?.state, "queued");
  for (const [who, state, detail] of [
    ["Will", "queued", "Part 1 (Steve) queued. Part 2 (Will) sent."],
    ["Steve", "sent", "Part 1 (Steve) sent. Part 2 (Will) sent."],
  ] as const) {
    const sessionId = "sdk:" + who;
    const turn = registry.getSession(sessionId)!.pendingTurns.at(-1)!;
    registry.turnDelivered({ sessionId, turnId: turn.id, deliveredAt: Date.now(), spoken: { generation: 0 } });
    const card = cards.at(-1)!;
    const entry = (await readHeard())[0]!;
    assert.deepEqual([card.state, entry.outcome], [state, state]);
    assert.equal(card.detail?.split("\n").at(-1), detail);
    assert.equal(entry.detail, card.detail);
  }
});

test("split delivery interrupts on each bare stop and queues quoted stop verbatim", async () => {
  model.decide = () => ({ rung: "job", answers: [{ choice: "split", confidence: 1 }], detail: "scripted" });
  for (const [text, interrupted, messaged] of [
    ['Steve, "stop", and Will, Stop!', "Will", "Steve"],
    ['Steve, Stop!, and Will, "stop"', "Steve", "Will"],
  ] as const) {
    const before = interrupts.length;
    const id = randomUUID();
    const queuedBefore = queued(messaged).length;
    await say(text, id);
    await resolved(id);
    assert.deepEqual(interrupts.slice(before), ["sdk:" + interrupted]);
    assert.equal(queued(messaged).length, queuedBefore);
    assert.equal((await act(id, "send-now")).status, 200);
    assert.deepEqual(interrupts.slice(before), ["sdk:" + interrupted]);
    assert.equal(queued(messaged).at(-1), '"stop"');
  }
});

test("cancelling a split keeps the immediate interrupt and drops only the ordinary message", async () => {
  model.decide = () => ({ rung: "job", answers: [{ choice: "split", confidence: 1 }], detail: "scripted" });
  const before = interrupts.length;
  await say("Steve, inspect the build, and Will, stop", "split-cancel");
  await resolved("split-cancel");
  assert.deepEqual(interrupts.slice(before), ["sdk:Will"]);
  const pending = cards.at(-1)!;
  assert.equal(pending.state, "pending");
  assert.deepEqual(pending.parts.map(part => part.outcome), [undefined, "sent"]);
  assert.equal(pending.deadline, cards.find(card => card.id === "split-cancel" && card.deadline !== null)?.deadline);
  assert.deepEqual(registry.snapshot().voiceCards, [pending]);
  const firstCancelFrame = cards.length;
  assert.equal((await act("split-cancel", "cancel")).status, 200);
  assert.equal(queued("Steve").length, 0);
  const outcomes = cards.slice(firstCancelFrame).map(card => card.parts.map(part => part.outcome));
  assert.deepEqual(outcomes, [["cancelled", "sent"]]);
  assert.match((await readHeard())[0]!.detail, /Part 1 \(Steve\) cancelled\. Part 2 \(Will\) sent\./);
});

test("cancelling while a split stop is in flight preserves its status through reconnect and settlement", async (t) => {
  model.decide = () => ({ rung: "job", answers: [{ choice: "split", confidence: 1 }], detail: "scripted" });
  let finish!: () => void;
  const delayed = new Promise<void>(resolve => { finish = resolve; });
  const driver = t.mock.method(sdk, "interrupt", async () => { await delayed; return "idle"; });
  await say("Steve, stop, and Will, inspect the build", "delayed-stop");
  await resolved("delayed-stop");
  try {
    assert.equal((await act("delayed-stop", "cancel")).status, 200);
    const stopping = cards.at(-1)!;
    assert.deepEqual(stopping.parts.map(p => [p.immediateStop, p.outcome]), [[true, undefined], [undefined, "cancelled"]]);
    assert.deepEqual(registry.snapshot().voiceCards, [stopping]);
    assert.equal((await act("delayed-stop", "cancel")).status, 409);
  } finally {
    finish();
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.equal(driver.mock.callCount(), 1);
  assert.deepEqual(cards.at(-1)?.parts.map(p => p.outcome), ["sent", "cancelled"]);
  assert.equal(queued("Will").length, 0);
  assert.deepEqual(registry.snapshot().voiceCards, []);
});

test("Recently heard names both deliveries when the second part of a split fails", async (t) => {
  model.decide = () => ({ rung: "job", answers: [{ choice: "split", confidence: 1 }], detail: "scripted" });
  t.mock.method(sdk, "interrupt", async () => null);
  await say("Steve, check the queue, and Will, stop", "partial");
  await resolved("partial");
  const pending = cards.at(-1)!;
  assert.equal(pending.state, "pending");
  assert.deepEqual(pending.parts.map(part => part.outcome), [undefined, "failed"]);
  assert.match(pending.parts[1]!.detail!, /no live embedded driver/);
  assert.deepEqual(registry.snapshot().voiceCards, [pending]);
  assert.equal((await act("partial", "send-now")).status, 200);
  assert.equal(queued("Steve").at(-1), "check the queue");
  const entry = (await readHeard())[0]!;
  assert.equal(entry.outcome, "failed");
  assert.match(entry.detail, /Part 1 \(Steve\) queued\. Part 2 \(Will\) failed\. this session has no live embedded driver/);
  const turn = registry.getSession("sdk:Steve")!.pendingTurns.at(-1)!;
  registry.turnDelivered({ sessionId: "sdk:Steve", turnId: turn.id, deliveredAt: Date.now(), spoken: { generation: 0 } });
  assert.equal(cards.at(-1)?.state, "failed");
  assert.match((await readHeard())[0]!.detail, /Part 1 \(Steve\) sent\. Part 2 \(Will\) failed\./);
});

test("an unclosed address wrapper keeps stop as text for model and picked splits", async () => {
  for (const manual of [false, true]) {
    model.decide = () => ({ rung: "job", answers: [{ choice: manual ? null : "split", confidence: manual ? 0 : 1 }], detail: "scripted" });
    const before = interrupts.length;
    const id = randomUUID();
    await say("[Steve, stop, and [ Will, stop", id);
    await resolved(id);
    if (manual) assert.equal((await act(id, "pick", { id: "task:Will" })).status, 200);
    assert.equal((await act(id, "send-now")).status, 200);
    assert.equal(interrupts.length, before);
    assert.deepEqual([queued("Steve").at(-1), queued("Will").at(-1)], ["stop", "stop"]);
  }
});

test("model and manual split delivery preserve stop punctuation and command-line flags", async () => {
  for (const manual of [false, true]) {
    model.decide = () => ({ rung: "job", answers: [{ choice: manual ? null : "split", confidence: 1 }], detail: "scripted" });
    const id = randomUUID();
    const before = interrupts.length;
    await say("Steve, stop:, and Will, --force is the flag", id);
    await resolved(id);
    if (manual) assert.equal((await act(id, "pick", { id: "task:Will" })).status, 200);
    assert.equal((await act(id, "send-now")).status, 200);
    assert.equal(interrupts.length, before);
    assert.deepEqual([queued("Steve").at(-1), queued("Will").at(-1)], ["stop:", "--force is the flag"]);
  }
});

test("unsure waits indefinitely, cancels without sending, and accepts a spoken or clicked candidate", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  model.decide = (questions) => ({ rung: "none", answers: questions.map(() => ({ choice: null, confidence: 0 })), detail: "scripted" });
  await say("Steven tell Will something", "ambiguous");
  await resolved("ambiguous");
  assert.equal(cards[0]?.state, "unsure");
  assert.equal(cards[0]?.deadline, null);
  assert.equal((await act("ambiguous", "send-now")).status, 409);
  await say("cancel");
  assert.equal(cards.at(-1)?.state, "cancelled");
  assert.ok(!queued("Steve").includes("tell Will something"));
  for (const method of ["spoken", "click"]) {
    t.mock.timers.setTime(Date.now() + 1);
    await say("Steven ask Will about it", method);
    await resolved(method);
    assert.equal((await act(method, "pick", { id: "unknown" })).status, 409);
    t.mock.timers.setTime(Date.now() + 1);
    if (method === "spoken") await say("Will");
    else assert.equal((await act(method, "pick", { id: "task:Will" })).status, 200);
    assert.equal(cards.at(-1)?.state, "pending");
    assert.deepEqual(cards.at(-1)?.parts.map(part => [part.target?.name, part.text]), [["Steve", "ask"], ["Will", "about it"]]);
    assert.equal((await act(method, "cancel")).status, 200);
  }
});

test("a spoken pick finds the only matching unsure card, even when it is older", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  await say("Steven ask Will about the build", "matching-older");
  await say("Steven ask Bill about the release", "matching-newer");
  await resolved("matching-newer");
  t.mock.timers.setTime(Date.now() + 1);
  await say("Steve");
  assert.deepEqual(cards.map((card) => [card.id, card.state]), [["matching-older", "unsure"], ["matching-newer", "unsure"]]);
  assert.equal((await readHeard())[0]?.rule, "ambiguous-pick");

  await say("Will.");
  assert.deepEqual(registry.snapshot().voiceCards?.map((card) => [card.id, card.state]), [
    ["matching-newer", "unsure"], ["matching-older", "pending"],
  ]);
  assert.deepEqual(cards.at(-1)?.parts.map(p => [p.target?.name, p.text]), [
    ["Steve", "ask"], ["Will", "about the build"],
  ]);
  assert.equal((await act("matching-older", "send-now")).status, 200);
  assert.equal(queued("Steve").at(-1), "ask");
  assert.equal(queued("Will").at(-1), "about the build");
});

test("a candidate with leading or nonterminal boundary punctuation leaves the card open until a bare pick", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  await app.request("/api/voice/config", { method: "PUT", headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ cancelWindow: { enabled: false } }) });
  const willBefore = queued("Will");
  const steveBefore = queued("Steve");
  await say("Steven ask Will about the results", "choice");
  await resolved("choice");
  t.mock.timers.setTime(Date.now() + 1);
  for (const text of [",Will", " ?Will.", "Will,", "(Will)", "“Will”", '"Will"!', "'Will'", "“ Will ”", '" Will "!', "「 “ Will ” 」"]) {
    await say(text);
    assert.equal((await readHeard())[0]?.rule, "no-message");
    assert.deepEqual(queued("Will"), willBefore);
    assert.deepEqual(queued("Steve"), steveBefore);
    assert.deepEqual(registry.snapshot().voiceCards?.map((card) => card.state), ["unsure"]);
  }
  await say("Will.");
  assert.deepEqual(queued("Will"), [...willBefore, "about the results"]);
  assert.deepEqual(queued("Steve"), [...steveBefore, "ask"]);
  assert.deepEqual(registry.snapshot().voiceCards, []);
});

test("a delayed spoken pick can only queue choices that were offered when it was captured", async (t) => {
  await app.request("/api/voice/config", { method: "PUT", headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ cancelWindow: { enabled: false } }) });
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: now - 300 });
  const postAt = (id: string, text: string, capturedAt: number) =>
    post(utterancePath(), { ...capture(text, id), capturedAt }, token);
  const before = queued("Will");
  await postAt("delayed-older", "Steven ask Will about yesterday", now - 300);
  await resolved("delayed-older");
  t.mock.timers.setTime(now - 100);
  await postAt("delayed-newer", "Steven ask Will about tomorrow", now - 100);
  await resolved("delayed-newer");
  t.mock.timers.setTime(now);
  await postAt("too-early", "Will", now - 400);
  assert.deepEqual(queued("Will"), before);
  assert.equal((await readHeard()).find((entry) => entry.id === "too-early")?.rule, "no-message");
  await postAt("between", "Will", now - 200);
  assert.deepEqual(queued("Will"), [...before, "about yesterday"]);
  assert.equal(queued("Steve").at(-1), "ask");
  assert.equal((await readHeard()).find((entry) => entry.id === "between")?.rule, "pick");
  assert.deepEqual(registry.snapshot().voiceCards?.map((card) => [card.id, card.state]), [["delayed-newer", "unsure"]]);
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

test("a stop reaches the original session immediately and a pending message cannot follow its replacement", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const will = name("Will");
  voiceStateStore.useRoster(() => [will, name("Steve")]);
  t.after(() => voiceStateStore.useRoster(() => roster));
  const startingInterrupts = interrupts.length;
  await say("Will, stop", "stop-original");
  assert.deepEqual(interrupts.slice(startingInterrupts), ["sdk:Will"]);
  await say("Steve, check the build, and Will, review the PR", "picked-message");
  await resolved("picked-message");
  t.mock.timers.tick(1);
  await say("Will.");
  const firstQueue = queued("Steve");
  const replacementQueue = queued("Bill");
  const beforeInterrupts = [...interrupts];
  will.sessionId = "sdk:Bill";

  assert.equal((await act("stop-original", "send-now")).status, 409);
  t.mock.timers.tick(1000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(queued("Steve"), [...firstQueue, "check the build"]);
  assert.deepEqual(queued("Bill"), replacementQueue);
  assert.deepEqual(interrupts, beforeInterrupts);
  const entries = await readHeard();
  assert.equal(entries.find(entry => entry.id === "stop-original")?.outcome, "sent");
  const stale = entries.find(entry => entry.id === "picked-message");
  assert.equal(stale?.outcome, "not-running");
  assert.match(stale.detail, /Part 1 \(Steve\) queued\. Part 2 \(Will\) unavailable\./);
});

test("a reconnect sees an in-flight interrupt until its final event and cannot act on it again", async (t) => {
  let started!: () => void;
  let finish!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const delayed = new Promise<void>((resolve) => { finish = resolve; });
  const driver = t.mock.method(sdk, "interrupt", async () => { started(); await delayed; return "idle"; });
  await say("Will, stop", "in-flight");
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
    await new Promise<void>(resolve => setImmediate(resolve));
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
  await say("Steven ask Will about the build", "choice");
  await resolved("choice");
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

test("a manual split pick leaves the card open when its running roster row has no live session", async (t) => {
  const gone = { ...name("Will"), sessionId: "sdk:gone" };
  voiceStateStore.useRoster(() => [name("Steve"), gone]);
  t.after(() => voiceStateStore.useRoster(() => roster));
  await say("Steve, ask Will about the release", "pick-gone");
  await resolved("pick-gone");
  assert.equal((await act("pick-gone", "pick", { id: "task:Will" })).status, 409);
  assert.equal(cards.at(-1)?.state, "unsure");
  assert.equal((await act("pick-gone", "send-now")).status, 409);
  assert.equal((await act("pick-gone", "pick", { id: "task:Steve" })).status, 200);
  assert.equal((await act("pick-gone", "send-now")).status, 200);
  assert.equal(queued("Steve").at(-1), "ask Will about the release");
});

test("a spoken pick for a departed candidate records why the unsure card stays open", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  await say("Steven ask Will about the release", "choose");
  await resolved("choose");
  t.mock.timers.setTime(Date.now() + 1);
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
  model.decide = () => ({ rung: "none", answers: [{ choice: null, confidence: 0 }], detail: "scripted" });
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  await say("Steve, ask Will about the build", "choice");
  await resolved("choice");
  assert.equal(cards.at(-1)?.state, "unsure");
  for (let i = 1; i < 50; i++) {
    assert.deepEqual(await (await say("Will wait", "pending-" + i)).json(), { accepted: true });
  }
  const snapshot = registry.snapshot().voiceCards;
  assert.equal(snapshot?.length, 50);
  assert.deepEqual(await (await say("Will try again", "overflow")).json(), { accepted: false });
  assert.deepEqual(registry.snapshot().voiceCards, snapshot);
  assert.equal(registry.voiceRouter!.pendingVoiceActions.length, 50);
  assert.ok(!(await readHeard()).some(({ id }) => id === "overflow"));
  t.mock.timers.tick(1);
  assert.deepEqual(await (await say("Will")).json(), { accepted: true });
  assert.deepEqual([cards.at(-1)?.id, cards.at(-1)?.state], ["choice", "pending"]);
  await say("cancel");
  assert.deepEqual([cards.at(-1)?.id, cards.at(-1)?.state], ["choice", "cancelled"]);
  assert.deepEqual(await (await say("Will try again", "overflow")).json(), { accepted: true });
  assert.deepEqual([cards.at(-1)?.id, cards.at(-1)?.state], ["overflow", "pending"]);
});

test("out-of-order unsure captures keep the five newest choices, including when the incoming card is oldest", async () => {
  const postUnsure = (id: string, capturedAt: number) =>
    post(utterancePath(), { ...capture("Steven ask Will about the build", id), capturedAt }, token);
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
  t.mock.method(pending, "submitSpoken", () => ({ ok: false, error: "Queue full." }));
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

test("speech onset pins the in-window message across segmentation and a later capture", async t => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const hostUs = voiceStateStore.hostNowUs();
  t.mock.method(voiceStateStore, "hostNowUs", () => hostUs + (Date.now() - now) * 1000);
  const setWindow = async (seconds: number) => {
    const response = await app.request("/api/voice/config", { method: "PUT", headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ cancelWindow: { enabled: true, seconds } }) });
    assert.equal(response.status, 200);
  };
  await setWindow(10);
  await say("Will keep the older message", "onset-older");
  t.mock.timers.tick(100);
  await setWindow(1);
  await say("Will discard this message", "onset-target");
  t.mock.timers.tick(970);
  const speechStartUs = voiceStateStore.hostNowUs();
  const revision = voiceStateStore.directive().captureRevision;
  assert.ok(revision);
  const onset = await post("/voice/listener/speech?revision=" + revision, { speechStartUs, phase: "start" }, token);
  t.mock.timers.tick(10);
  await setWindow(10);
  await say("Will keep the newer message", "onset-newer");
  // Model a longer end-of-speech setting, then decoder and HTTP latency.
  t.mock.timers.tick(5500);
  const response = await app.request(utterancePath(revision), { method: "POST", headers: {
    host: "localhost", "content-type": "application/json", "x-harness-token": token, "x-voice-listener-id": listenerId,
    "x-voice-capture-start-host-us": String(speechStartUs - 100000), "x-voice-speech-start-host-us": String(speechStartUs),
    "x-voice-capture-end-host-ms": String(Math.ceil(speechStartUs / 1000) + 5300),
  }, body: JSON.stringify({ ...capture("Cancel."), capturedAt: now + 970 }) });
  assert.deepEqual(await response.json(), { accepted: true });
  assert.deepEqual(registry.snapshot().voiceCards?.map(card => card.id), ["onset-older", "onset-newer"]);
  t.mock.timers.tick(10_000);
  assert.deepEqual(queued("Will"), ["keep the older message", "keep the newer message"]);
  assert.equal(onset.status, 200);
  assert.deepEqual(cards.filter(card => card.state === "cancelled").map(card => card.id), ["onset-target"]);
});

test("a pre-release cancel onset arriving after key-up reserves the countdown until the held transcript arrives", async t => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const baseUs = Math.floor(voiceHostTimeUs() / 1000) * 1000;
  t.mock.method(voiceStateStore, "hostNowUs", () => baseUs + (Date.now() - now) * 1000);
  await post("/voice/listener/hello", { backend: "fluidaudio", version: VOICE_LISTENER_PROTOCOL_VERSION,
    devices: [], microphone: "granted", modelLoaded: true, reportsSpeechOnset: true }, token);
  await say("Will check the build", "held-target");
  t.mock.timers.tick(850);
  const press = voiceStateStore.hostNowUs();
  await post("/voice/shell-report", { callActive: true, pushToTalk: true, reportedAtHostUs: press, pushToTalkPressedAtHostUs: press }, token);
  const revision = voiceStateStore.directive().revision;
  t.mock.timers.tick(120);
  const release = voiceStateStore.hostNowUs();
  await post("/voice/shell-report", { callActive: true, pushToTalk: false, reportedAtHostUs: release, pushToTalkReleasedAtHostUs: release }, token);
  assert.equal(voiceStateStore.directive().capture, false);
  t.mock.timers.tick(70); // The timer expired while the final microphone buffer was in transit.
  const start = async (speechStartUs: number, rev = revision) =>
    (await post("/voice/listener/speech?revision=" + rev, { phase: "start", speechStartUs }, token)).json();
  const onset = release - 1;
  assert.deepEqual(await start(press - 1), { accepted: false });
  assert.deepEqual(await start(release), { accepted: false });
  assert.deepEqual(await start(release + 1), { accepted: false });
  assert.deepEqual(await start(onset, "unknown"), { accepted: false });
  assert.deepEqual(await start(onset), { accepted: true });
  t.mock.timers.tick(5500);
  assert.equal(cards.at(-1)?.state, "pending");
  assert.deepEqual(queued("Will"), []);
  const result = await app.request(utterancePath(revision), { method: "POST", headers: {
    "content-type": "application/json", "x-harness-token": token, "x-voice-listener-id": listenerId,
    "x-voice-capture-start-host-us": String(press), "x-voice-speech-start-host-us": String(onset),
    "x-voice-capture-end-host-ms": String(release / 1000),
  }, body: JSON.stringify(capture("Cancel.")) });
  assert.deepEqual(await result.json(), { accepted: true });
  assert.deepEqual(cards.filter(c => c.state === "cancelled").map(c => c.id), ["held-target"]);
  assert.deepEqual(queued("Will"), []);
});

async function setupOnsetCountdown(t: TestContext, version: string = VOICE_LISTENER_PROTOCOL_VERSION) {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const hostUs = voiceStateStore.hostNowUs();
  t.mock.method(voiceStateStore, "hostNowUs", () => hostUs + (Date.now() - now) * 1000);
  const hello = await post("/voice/listener/hello", { backend: "fluidaudio", version,
    devices: [], microphone: "granted", modelLoaded: true, reportsSpeechOnset: true }, token);
  assert.deepEqual(await hello.json(), { accepted: true, protocol: VOICE_LISTENER_PROTOCOL_VERSION });
  return { hostUs, revision: voiceStateStore.directive().revision };
}

test("capture overflow cancels the reserved addressed message after its countdown without delivering it", async t => {
  const { revision } = await setupOnsetCountdown(t);
  const id = "overflow-target";
  await say("Will check the build", id);
  assert.equal(cards.at(-1)?.state, "pending");
  t.mock.timers.tick(100);
  const speechStartUs = voiceStateStore.hostNowUs();
  const speech = (phase: string) => post("/voice/listener/speech?revision=" + revision, { phase, speechStartUs }, token);
  assert.deepEqual(await (await speech("start")).json(), { accepted: true });
  t.mock.timers.tick(61_000);
  assert.deepEqual(registry.snapshot().voiceCards?.map(card => card.id), [id]);
  assert.deepEqual(queued("Will"), []);

  assert.deepEqual(await (await speech("capture-limit")).json(), { accepted: true });
  assert.equal(cards.findLast(card => card.id === id)?.state, "cancelled");
  assert.equal(cards.at(-1)?.reason, "capture-limit");
  assert.deepEqual(registry.snapshot().voiceCards ?? [], []);
  t.mock.timers.tick(90_000);
  assert.deepEqual(queued("Will"), []);
});

test("overflow reported after dated key-up cancels the message reserved during that hold", async t => {
  await setupOnsetCountdown(t);
  const id = "released-overflow-target";
  await say("Will check the build", id);
  assert.equal(cards.at(-1)?.state, "pending");
  t.mock.timers.tick(100);
  const pressed = voiceStateStore.hostNowUs();
  const reportKey = (down: boolean) => {
    const now = voiceStateStore.hostNowUs();
    return post("/voice/shell-report", { callActive: true, pushToTalk: down, reportedAtHostUs: now,
      ...(down ? { pushToTalkPressedAtHostUs: pressed } : { pushToTalkReleasedAtHostUs: now }) }, token);
  };
  await reportKey(true);
  const held = voiceStateStore.directive().revision;
  t.mock.timers.tick(100);
  const speechStartUs = voiceStateStore.hostNowUs();
  const report = (phase: string) => post("/voice/listener/speech?revision=" + held, { phase, speechStartUs }, token);
  assert.deepEqual(await (await report("start")).json(), { accepted: true });
  for (let i = 0; i < 6; i++) {
    t.mock.timers.tick(10_000);
    await reportKey(true);
  }
  t.mock.timers.tick(20);
  await reportKey(false);
  assert.equal(voiceStateStore.directive().capture, false);
  assert.ok(voiceStateStore.releasedCapture(held));
  assert.deepEqual(registry.snapshot().voiceCards?.map(card => card.id), [id]);
  assert.deepEqual(await (await report("capture-limit")).json(), { accepted: true });
  assert.equal(cards.findLast(card => card.id === id)?.state, "cancelled");
  assert.equal(cards.at(-1)?.reason, "capture-limit");
  assert.deepEqual(registry.snapshot().voiceCards ?? [], []);
  t.mock.timers.tick(90_000);
  assert.deepEqual(queued("Will"), []);
});

test("a hold that outlasts the decode budget keeps its reserved countdown until its transcript arrives after key-up", async t => {
  await setupOnsetCountdown(t);
  const id = "long-hold-target";
  await say("Will check the build", id);
  assert.equal(cards.at(-1)?.state, "pending");
  t.mock.timers.tick(100);
  const pressed = voiceStateStore.hostNowUs();
  const reportKey = (down: boolean) => {
    const now = voiceStateStore.hostNowUs();
    return post("/voice/shell-report", { callActive: true, pushToTalk: down, reportedAtHostUs: now,
      ...(down ? { pushToTalkPressedAtHostUs: pressed } : { pushToTalkReleasedAtHostUs: now }) }, token);
  };
  await reportKey(true);
  const held = voiceStateStore.directive().revision;
  t.mock.timers.tick(100);
  // The hold's one onset falls inside the countdown and reserves it for a spoken Cancel.
  const speechStartUs = voiceStateStore.hostNowUs();
  const started = await post("/voice/listener/speech?revision=" + held, { phase: "start", speechStartUs }, token);
  assert.deepEqual(await started.json(), { accepted: true });
  // The key stays down past the 90-second decode budget, still inside the two-minute hold.
  for (let i = 0; i < 10; i++) {
    t.mock.timers.tick(10_000);
    await reportKey(true);
  }
  assert.equal(voiceStateStore.directive().revision, held, "the key is still held");
  assert.deepEqual(registry.snapshot().voiceCards?.map(card => card.id), [id], "nothing is delivered while the key is down");
  assert.deepEqual(queued("Will"), []);
  t.mock.timers.tick(20);
  await reportKey(false);
  const releasedAt = voiceStateStore.releasedCapture(held)!.at;
  const result = await app.request(utterancePath(held), { method: "POST", headers: {
    "content-type": "application/json", "x-harness-token": token, "x-voice-listener-id": listenerId,
    "x-voice-capture-start-host-us": String(speechStartUs), "x-voice-speech-start-host-us": String(speechStartUs),
    "x-voice-capture-end-host-ms": String(releasedAt),
  }, body: JSON.stringify(capture("Cancel.")) });
  assert.deepEqual(await result.json(), { accepted: true });
  assert.equal(cards.findLast(card => card.id === id)?.state, "cancelled", "the hold's Cancel still reaches the message it reserved");
  t.mock.timers.tick(90_000);
  assert.deepEqual(queued("Will"), []);
});

test("a held reservation that never gets its transcript releases the message at the hold limit plus the decode budget", async t => {
  await setupOnsetCountdown(t);
  const id = "abandoned-hold-target";
  await say("Will check the build", id);
  assert.equal(cards.at(-1)?.state, "pending");
  t.mock.timers.tick(100);
  const pressed = voiceStateStore.hostNowUs();
  const reportKey = (down: boolean) => {
    const now = voiceStateStore.hostNowUs();
    return post("/voice/shell-report", { callActive: true, pushToTalk: down, reportedAtHostUs: now,
      ...(down ? { pushToTalkPressedAtHostUs: pressed } : { pushToTalkReleasedAtHostUs: now }) }, token);
  };
  await reportKey(true);
  const held = voiceStateStore.directive().revision;
  t.mock.timers.tick(100);
  const started = await post("/voice/listener/speech?revision=" + held,
    { phase: "start", speechStartUs: voiceStateStore.hostNowUs() }, token);
  assert.deepEqual(await started.json(), { accepted: true });
  const deadline = 120_000 + 90_000; // VOICE_MAX_HOLD_MS plus the long-capture decode budget, from the onset.
  for (let i = 0; i < 11; i++) {
    t.mock.timers.tick(10_000);
    await reportKey(true);
  }
  t.mock.timers.tick(20);
  await reportKey(false);
  // No transcript and no finish ever arrive for this hold.
  t.mock.timers.tick(deadline - 110_020 - 1);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(registry.snapshot().voiceCards?.map(card => card.id), [id], "the reservation holds until its combined deadline");
  assert.deepEqual(queued("Will"), []);
  t.mock.timers.tick(2);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(registry.snapshot().voiceCards ?? [], [], "at the deadline the unanswered reservation lets the message go");
  assert.equal(queued("Will").length, 1);
});

test("an Always-on onset still releases its reserved countdown after the 90-second decode budget", async t => {
  const { revision } = await setupOnsetCountdown(t);
  const id = "automatic-budget-target";
  await say("Will check the build", id);
  t.mock.timers.tick(100);
  const speechStartUs = voiceStateStore.hostNowUs();
  const started = await post("/voice/listener/speech?revision=" + revision, { phase: "start", speechStartUs }, token);
  assert.deepEqual(await started.json(), { accepted: true });
  t.mock.timers.tick(89_000);
  assert.deepEqual(registry.snapshot().voiceCards?.map(card => card.id), [id], "the countdown waits for the phrase's result");
  t.mock.timers.tick(2_000);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(registry.snapshot().voiceCards ?? [], [], "an unanswered automatic phrase stops holding the message at the budget");
  assert.equal(queued("Will").length, 1);
});

test("a capture-limit report for an unauthorized revision leaves the reserved card alone and publishes no recovery", async t => {
  const { revision } = await setupOnsetCountdown(t);
  const id = "still-reserved";
  await say("Will keep the original message", id);
  t.mock.timers.tick(100);
  const speechStartUs = voiceStateStore.hostNowUs();
  const speech = (rev: string, phase: string) => post("/voice/listener/speech?revision=" + rev, { phase, speechStartUs }, token);
  assert.deepEqual(await (await speech(revision, "start")).json(), { accepted: true });
  t.mock.timers.tick(1500);
  const count = cards.length;
  assert.deepEqual(await (await speech("stale-revision", "capture-limit")).json(), { accepted: false });
  assert.equal(cards.length, count);
  assert.deepEqual((await readHeard()).map(entry => entry.id), [id]);
  assert.deepEqual(registry.snapshot().voiceCards?.map(card => [card.id, card.state]), [[id, "pending"]]);
  assert.deepEqual(queued("Will"), []);
  assert.deepEqual(await (await speech(revision, "finish")).json(), { accepted: true });
  assert.deepEqual(queued("Will"), ["keep the original message"]);
});

test("the last microphone buffer can arrive after expiry, but speech starting at expiry cannot reserve delivery", async t => {
  const { hostUs, revision } = await setupOnsetCountdown(t);
  const speech = (phase: string, speechStartUs: number) =>
    post("/voice/listener/speech?revision=" + revision, { phase, speechStartUs }, token);

  await say("Will wait for the last frame", "last-frame");
  t.mock.timers.tick(1050);
  await speech("start", hostUs + 999_999);
  t.mock.timers.tick(400);
  assert.deepEqual(queued("Will"), []);
  assert.equal((await act("last-frame", "cancel")).status, 409);
  // The decoder dropped this segment. The waiting card must still send once.
  await speech("finish", hostUs + 999_999);
  assert.deepEqual(queued("Will"), ["wait for the last frame"]);

  await say("Will send at expiry", "expired-frame");
  const boundary = voiceStateStore.hostNowUs() + 1_000_000;
  t.mock.timers.tick(1000);
  await speech("start", boundary);
  t.mock.timers.tick(250);
  assert.deepEqual(queued("Will"), ["wait for the last frame", "send at expiry"]);
});

test("an onset arriving at 250 ms reserves its original card, but one arriving a microsecond later cannot", async t => {
  const { revision } = await setupOnsetCountdown(t);
  const reportStart = async (speechStartUs: number) => {
    const response = await post("/voice/listener/speech?revision=" + revision, { phase: "start", speechStartUs }, token);
    assert.deepEqual(await response.json(), { accepted: true });
  };
  await say("Will cancel this message", "at-limit");
  t.mock.timers.tick(999);
  const onset = voiceStateStore.hostNowUs();
  const capturedAt = Date.now();
  t.mock.timers.tick(1);
  await say("Will deliver this message", "over-limit");
  t.mock.timers.tick(249);
  await reportStart(onset); // 250,000 µs old, one millisecond before automatic delivery.
  t.mock.timers.tick(1);
  assert.deepEqual(queued("Will"), []);
  assert.equal(registry.snapshot().voiceCards?.find(card => card.id === "at-limit")?.state, "pending");

  const result = await app.request(utterancePath(revision), { method: "POST", headers: {
    "content-type": "application/json", "x-harness-token": token, "x-voice-listener-id": listenerId,
    "x-voice-capture-start-host-us": String(onset), "x-voice-speech-start-host-us": String(onset),
    "x-voice-capture-end-host-ms": String(Math.ceil(voiceStateStore.hostNowUs() / 1000)),
  }, body: JSON.stringify({ ...capture("Cancel."), capturedAt }) });
  assert.deepEqual(await result.json(), { accepted: true });
  assert.deepEqual(cards.filter(card => card.state === "cancelled").map(card => card.id), ["at-limit"]);
  t.mock.timers.tick(999);
  // The second card is also one millisecond from automatic delivery and still eligible to be held.
  assert.deepEqual(registry.snapshot().voiceCards?.map(card => [card.id, card.state]), [["over-limit", "pending"]]);
  await reportStart(voiceStateStore.hostNowUs() - 250_001);
  t.mock.timers.tick(1);
  assert.deepEqual(queued("Will"), ["deliver this message"]);
});

for (const [version, seconds] of [["4.1", 35], [VOICE_LISTENER_PROTOCOL_VERSION, 90]] as const) {
  test(`a missing speech result delivers once at ${seconds} seconds from a FluidAudio ${version} reservation`, async t => {
    const { revision } = await setupOnsetCountdown(t, version);
    const submits = t.mock.method(pending, "submitSpoken");
    const id = "lost-frame-" + version;
    await say("Will recover after listener loss", id);
    t.mock.timers.tick(800);
    const onset = voiceStateStore.hostNowUs();
    t.mock.timers.tick(100);
    const response = await post("/voice/listener/speech?revision=" + revision, { phase: "start", speechStartUs: onset }, token);
    assert.deepEqual(await response.json(), { accepted: true });
    t.mock.timers.tick(seconds * 1000 - 1);
    assert.deepEqual(registry.snapshot().voiceCards?.map(card => [card.id, card.state]), [[id, "pending"]]);
    assert.deepEqual(queued("Will"), []);
    assert.equal(submits.mock.callCount(), 0);
    t.mock.timers.tick(1);
    assert.deepEqual(queued("Will"), ["recover after listener loss"]);
    t.mock.timers.tick(35_000);
    assert.equal(submits.mock.callCount(), 1);
  });
}

test("an explicitly cancelled target cannot redirect its in-flight spoken cancel onto another pending card", async t => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const onset = voiceStateStore.hostNowUs();
  t.mock.method(voiceStateStore, "hostNowUs", () => onset + (Date.now() - now) * 1000);
  await say("Will keep the other card", "pinned-other");
  await say("Will discard by button", "pinned-click");
  const revision = voiceStateStore.directive().revision;
  const path = "/voice/listener/speech?revision=" + revision;
  assert.equal((await post(path, { phase: "start", speechStartUs: onset })).status, 401);
  await post(path, { phase: "start", speechStartUs: onset }, token);
  assert.equal((await act("pinned-click", "cancel")).status, 200);
  const cancel = { ...capture("cancel", "pinned-control"), capturedAt: now };
  const response = await app.request(utterancePath(revision), { method: "POST", headers: {
    "content-type": "application/json", "x-harness-token": token, "x-voice-listener-id": listenerId,
    "x-voice-capture-start-host-us": String(onset), "x-voice-speech-start-host-us": String(onset),
    "x-voice-capture-end-host-ms": String(Math.ceil(onset / 1000) + 1),
  }, body: JSON.stringify(cancel) });
  assert.deepEqual(await response.json(), { accepted: true });
  assert.equal((await readHeard())[0]?.rule, "nothing-pending");
  t.mock.timers.tick(1000);
  assert.deepEqual(queued("Will"), ["keep the other card"]);
});

test("a cancel arriving after its reservation times out cannot dismiss an older unsure card", async t => {
  const { revision } = await setupOnsetCountdown(t);
  await say("Steven ask Will about the build", "older-choice");
  await resolved("older-choice");
  t.mock.timers.tick(10);
  await say("Will discard by button", "button-target");
  t.mock.timers.tick(100);
  const onset = voiceStateStore.hostNowUs();
  const capturedAt = Date.now();
  const start = await post("/voice/listener/speech?revision=" + revision, { phase: "start", speechStartUs: onset }, token);
  assert.deepEqual(await start.json(), { accepted: true });
  assert.equal((await act("button-target", "cancel")).status, 200);
  t.mock.timers.tick(55_000);

  const postCancel = async (id: string, speechStartUs: number) => {
    const response = await app.request(utterancePath(revision), { method: "POST", headers: {
      "content-type": "application/json", "x-harness-token": token, "x-voice-listener-id": listenerId,
      "x-voice-capture-start-host-us": String(speechStartUs), "x-voice-speech-start-host-us": String(speechStartUs),
      "x-voice-capture-end-host-ms": String(Math.ceil(speechStartUs / 1000) + 1),
    }, body: JSON.stringify({ ...capture("Cancel.", id), capturedAt }) });
    assert.deepEqual(await response.json(), { accepted: true });
  };
  await postCancel("late-reserved", onset);
  assert.deepEqual(registry.snapshot().voiceCards?.map(({ id, state }) => [id, state]), [["older-choice", "unsure"]]);
  assert.equal((await readHeard()).find(entry => entry.id === "late-reserved")?.rule, "nothing-pending");
  assert.deepEqual(queued("Will"), []);

  // A different onset with no reservation still addresses the older open choice.
  await postCancel("never-reserved", onset + 1);
  assert.equal(cards.findLast(card => card.id === "older-choice")?.state, "cancelled");
  assert.equal((await readHeard()).find(entry => entry.id === "never-reserved")?.detail, "older-choice");
});

test("an accepted non-cancel transcript after expiry releases the reserved message exactly once", async t => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const hostUs = voiceStateStore.hostNowUs();
  t.mock.method(voiceStateStore, "hostNowUs", () => hostUs + (Date.now() - now) * 1000);
  const id = "reserved-non-cancel";
  await say("Will check the logs", id);
  t.mock.timers.tick(900);
  const capturedAt = Date.now();
  const onset = voiceStateStore.hostNowUs();
  const revision = voiceStateStore.directive().revision;
  const started = await post("/voice/listener/speech?revision=" + revision, { phase: "start", speechStartUs: onset }, token);
  assert.deepEqual(await started.json(), { accepted: true });

  t.mock.timers.tick(1500);
  const card = registry.snapshot().voiceCards?.find(card => card.id === id);
  assert.equal(card?.state, "pending");
  assert.ok(card.deadline !== null && card.deadline < Date.now());
  assert.deepEqual(queued("Will"), []);

  const result = await app.request(utterancePath(revision), { method: "POST", headers: {
    "content-type": "application/json", "x-harness-token": token, "x-voice-listener-id": listenerId,
    "x-voice-capture-start-host-us": String(onset), "x-voice-speech-start-host-us": String(onset),
    "x-voice-capture-end-host-ms": String(Math.ceil(voiceStateStore.hostNowUs() / 1000)),
  }, body: JSON.stringify({ ...capture("Just thinking aloud"), capturedAt }) });
  assert.deepEqual(await result.json(), { accepted: true });
  assert.deepEqual(queued("Will"), ["check the logs"]);
  t.mock.timers.tick(40_000);
  assert.deepEqual(queued("Will"), ["check the logs"]);
});

test("a claimed phrase stays out of session routing after blur", async () => {
  const router = registry.voiceRouter!;
  const disconnect = router.openCards.connect("dashboard", true);
  const target = randomUUID();
  const events: string[] = [];
  const unsubscribe = registry.subscribe(event => {
    if (event.type === "voice_dictation") {
      assert.equal(event.target, target);
      assert.equal(event.windowId, "dashboard");
      events.push((event.interim ? "preview " : "final ") + event.text);
    }
  });
  try {
    router.openCards.report({ windowId: "dashboard", focused: true, dictationTarget: target, cards: [] });
    const revision = voiceStateStore.directive().revision;
    const path = "/voice/listener/speech?revision=" + revision;
    const speechStartUs = voiceHostTimeUs();
    const preview = { phase: "preview", speechStartUs, text: "Steve" };
    assert.deepEqual(await (await post(path, preview, token)).json(), { accepted: false });
    const start = await post(path, { phase: "start", speechStartUs }, token);
    assert.equal(start.headers.get("x-voice-dictation"), "1");
    assert.deepEqual(await (await post(path, preview, token)).json(), { accepted: true });
    router.openCards.report({ windowId: "dashboard", focused: false, cards: [] });
    assert.deepEqual(await (await post(path, preview, token)).json(), { accepted: false });
    const result = await app.request(utterancePath(revision), { method: "POST", headers: {
      "content-type": "application/json", "x-harness-token": token, "x-voice-listener-id": listenerId,
      "x-voice-capture-start-host-us": String(speechStartUs), "x-voice-speech-start-host-us": String(speechStartUs),
      "x-voice-capture-end-host-ms": String(Math.ceil(voiceHostTimeUs() / 1000)),
    }, body: JSON.stringify(capture("Steve check the build")) });
    assert.deepEqual(await result.json(), { accepted: true });
    assert.deepEqual(events, ["preview Steve", "final Steve check the build"]);
    assert.deepEqual(await readHeard(), []);
    assert.deepEqual(cards, []);
    assert.deepEqual(queued("Steve"), []);
  } finally {
    unsubscribe();
    disconnect();
  }
});

test("an active phrase discovers focus after onset and rechecks the editor for each preview and final", async t => {
  const router = registry.voiceRouter!;
  t.after(router.openCards.connect("dashboard", true));
  const first = randomUUID(), second = randomUUID();
  let field: string | undefined;
  const frames: Array<[string, boolean, string]> = [];
  const publish = registry.emitQuestionEvent.bind(registry);
  t.mock.method(registry, "emitQuestionEvent", (event: Parameters<typeof publish>[0]) => {
    if (event.type === "voice_dictation_probe") {
      router.openCards.acknowledgeDictation(event.windowId, event.sequence, field);
    } else {
      if (event.type === "voice_dictation") frames.push([event.target, event.interim, event.text]);
      publish(event);
    }
  });
  const revision = voiceStateStore.directive().revision;
  const speechStartUs = voiceHostTimeUs();
  const path = "/voice/listener/speech?revision=" + revision;
  const phase = (phase: string, text?: string) => post(path, { phase, speechStartUs, text }, token);
  assert.equal((await phase("start")).headers.get("x-voice-dictation"), null);
  field = first;
  assert.equal((await phase("focus")).headers.get("x-voice-dictation"), "1");
  assert.deepEqual(await (await phase("preview", "Steve")).json(), { accepted: true });
  field = second;
  assert.deepEqual(await (await phase("preview", "Steve")).json(), { accepted: true });
  field = first;
  const result = await app.request(utterancePath(revision), { method: "POST", headers: {
    "content-type": "application/json", "x-harness-token": token, "x-voice-listener-id": listenerId,
    "x-voice-capture-start-host-us": String(speechStartUs), "x-voice-speech-start-host-us": String(speechStartUs),
    "x-voice-capture-end-host-ms": String(Math.ceil(voiceHostTimeUs() / 1000) + 1),
  }, body: JSON.stringify(capture("Steve check the build")) });
  assert.deepEqual(await result.json(), { accepted: true });
  assert.deepEqual(await (await phase("preview", "late")).json(), { accepted: false });
  assert.deepEqual(frames, [[first, true, "Steve"], [second, true, "Steve"], [first, false, "Steve check the build"]]);
  assert.deepEqual(await readHeard(), []);
  assert.deepEqual(queued("Steve"), []);
});

test("a delayed onset cannot supersede a newer preview binding", async t => {
  const router = registry.voiceRouter!;
  const started = deferred(), release = deferred();
  const first = { windowId: "dashboard", target: randomUUID() };
  const second = { ...first, target: randomUUID() };
  let probes = 0;
  t.mock.method(router, "resolveDictation", async () => {
    if (++probes === 1) { started.resolve(); await release.promise; return first; }
    return probes === 2 ? second : undefined;
  });
  const frames: string[] = [];
  t.after(registry.subscribe(event => { if (event.type === "voice_dictation") frames.push(event.target); }));
  const revision = voiceStateStore.directive().revision;
  const speechStartUs = voiceHostTimeUs();
  const path = "/voice/listener/speech?revision=" + revision;
  const start = post(path, { phase: "start", speechStartUs }, token);
  await started.promise;
  assert.equal((await post(path, { phase: "preview", speechStartUs, text: "Steve" }, token)).headers.get("x-voice-dictation"), "1");
  release.resolve();
  await start;
  const result = await app.request(utterancePath(revision), { method: "POST", headers: {
    "content-type": "application/json", "x-harness-token": token, "x-voice-listener-id": listenerId,
    "x-voice-capture-start-host-us": String(speechStartUs), "x-voice-speech-start-host-us": String(speechStartUs),
    "x-voice-capture-end-host-ms": String(Math.ceil(speechStartUs / 1000) + 1),
  }, body: JSON.stringify(capture("Steve check the build")) });
  assert.deepEqual(await result.json(), { accepted: true });
  assert.deepEqual(frames, [second.target, second.target]);
});

test("a revoked owner cannot claim a field while an onset probe is pending", async t => {
  const started = deferred(), release = deferred();
  t.mock.method(registry.voiceRouter!, "resolveDictation", async () => {
    started.resolve();
    await release.promise;
    return { windowId: "dashboard", target: randomUUID() };
  });
  const revision = voiceStateStore.directive().revision;
  const start = post("/voice/listener/speech?revision=" + revision, { phase: "start", speechStartUs: voiceHostTimeUs() }, token);
  await started.promise;
  t.mock.method(voiceStateStore, "ownsCapture", () => false);
  release.resolve();
  const response = await start;
  assert.equal(response.headers.get("x-voice-dictation"), null);
  assert.deepEqual(await response.json(), { accepted: false });
});

test("new onsets preserve an active dictation claim and abandoned onsets expire", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const router = registry.voiceRouter!;
  const revision = voiceStateStore.directive().revision;
  const path = "/voice/listener/speech?revision=" + revision;
  const onset = voiceHostTimeUs();
  const key = JSON.stringify([listenerId, revision, onset]);
  t.mock.method(router, "resolveDictation", async () => ({ windowId: "dashboard", target: "draft" }));
  assert.equal((await post(path, { phase: "start", speechStartUs: onset }, token)).headers.get("x-voice-dictation"), "1");
  for (let i = 1; i <= 51; i++) router.speechStarted("other-" + i, onset + i);
  assert.equal(router.hasSpeechOnset(key), true);
  assert.equal((await post(path, { phase: "preview", speechStartUs: onset, text: "Steve" }, token)).headers.get("x-voice-dictation"), "1");
  t.mock.timers.tick(5 * 60_000);
  assert.equal(router.hasSpeechOnset(key), false);
  assert.equal(router.hasSpeechOnset("other-51"), false);
  router.speechStarted(key, onset); // A delayed retry cannot revive an expired claim as a session command.
  const lateFinal = { ...capture("Steve check the build"), words: [], backend: "fluidaudio" as const };
  assert.equal(await router.accept(lateFinal, { captureKey: key, speechStartHostUs: onset, dictation: null }), false);
  assert.deepEqual(queued("Steve"), []);
});

test("an unresponsive browser cannot authorize routing from its last non-editing report", async t => {
  const router = registry.voiceRouter!;
  t.after(router.openCards.connect("unresponsive", true));
  router.openCards.report({ windowId: "unresponsive", focused: true, cards: [] });
  const publish = registry.emitQuestionEvent.bind(registry);
  let probed = false;
  t.mock.method(registry, "emitQuestionEvent", (event: Parameters<typeof publish>[0]) => {
    if (event.type === "voice_dictation_probe") probed = true;
    else publish(event);
  });
  assert.deepEqual(await (await say("Steve check the build")).json(), { accepted: false });
  assert.ok(probed);
  assert.deepEqual(queued("Steve"), []);
  assert.deepEqual(cards, []);
  assert.deepEqual(await readHeard(), []);
});

test("a stalled dashboard cannot veto a confirmed editor or authorize session routing", async t => {
  const { openCards } = registry.voiceRouter!;
  for (const id of ["foreground", "background"]) t.after(openCards.connect(id, true));
  const target = randomUUID();
  let editor: string | undefined = target;
  let conflict = false;
  let backgroundProbe = 0;
  const drafts: string[] = [];
  const publish = registry.emitQuestionEvent.bind(registry);
  t.mock.method(registry, "emitQuestionEvent", (event: Parameters<typeof publish>[0]) => {
    if (event.type === "voice_dictation_probe") {
      if (event.windowId === "foreground") openCards.acknowledgeDictation(event.windowId, event.sequence, editor);
      else if (conflict) openCards.acknowledgeDictation(event.windowId, event.sequence, randomUUID());
      else backgroundProbe = event.sequence;
    } else {
      if (event.type === "voice_dictation") {
        assert.equal(event.windowId, "foreground");
        assert.equal(event.target, target);
        drafts.push(event.text);
      }
      publish(event);
    }
  });
  assert.deepEqual(await (await say("Steve check the build")).json(), { accepted: true });
  assert.ok(backgroundProbe > 0);
  assert.equal(openCards.acknowledgeDictation("background", backgroundProbe, randomUUID()), false);
  editor = undefined;
  assert.deepEqual(await (await say("Steve check the logs")).json(), { accepted: false });
  editor = target;
  conflict = true;
  assert.deepEqual(await (await say("Steve run the tests")).json(), { accepted: false });
  assert.deepEqual(drafts, ["Steve check the build"]);
  assert.deepEqual(await readHeard(), []);
  assert.deepEqual(queued("Steve"), []);
  assert.deepEqual(cards, []);
});

test("a fresh no-editor probe overrides a stale focused report at speech onset", async t => {
  const router = registry.voiceRouter!;
  t.after(router.openCards.connect("dashboard", true));
  router.openCards.report({ windowId: "dashboard", focused: true, dictationTarget: randomUUID(), cards: [] });
  const publish = registry.emitQuestionEvent.bind(registry);
  t.mock.method(registry, "emitQuestionEvent", (event: Parameters<typeof publish>[0]) => {
    if (event.type === "voice_dictation_probe") {
      router.openCards.acknowledgeDictation(event.windowId, event.sequence);
    } else publish(event);
  });

  const revision = voiceStateStore.directive().revision;
  const speechStartUs = voiceHostTimeUs();
  const start = await post("/voice/listener/speech?revision=" + revision, { speechStartUs, phase: "start" }, token);
  assert.equal(start.headers.get("x-voice-dictation"), null);
  const result = await app.request(utterancePath(revision), { method: "POST", headers: {
    "content-type": "application/json", "x-harness-token": token, "x-voice-listener-id": listenerId,
    "x-voice-capture-start-host-us": String(speechStartUs), "x-voice-speech-start-host-us": String(speechStartUs),
    "x-voice-capture-end-host-ms": String(Math.ceil(voiceHostTimeUs() / 1000) + 1),
  }, body: JSON.stringify(capture("Steve check the build", "after-blur")) });
  assert.deepEqual(await result.json(), { accepted: true });
  assert.equal(cards.at(-1)?.id, "after-blur");
  assert.equal(cards.at(-1)?.state, "pending");
});

for (const failure of ["synchronous", "asynchronous"] as const) {
  test(`${failure} preview decode failure still delivers the completed message once to its addressed resident`, async () => {
    voiceStateStore.reset();
    const config = await app.request("/api/voice/config", { method: "PUT", headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ showTranscript: true, cancelWindow: { enabled: false } }) });
    assert.equal(config.status, 200);
    const client = new ListenerClient("http://localhost", join(home, "token"), async (url, init) => app.request(url, init));
    const pcm = Float32Array.of(0.1, 0.2);
    const attempted = deferred();
    let previewAttempts = 0;
    let exhausted = false;
    await playRecording(client, () => ({
      get exhausted() { return exhausted; },
      async next({ observe }) {
        assert.ok(observe);
        observe({ preview: "audio", onset: 1, samples: pcm.subarray(0, 1) });
        await attempted.promise;
        assert.equal(voiceStateStore.state().transcript?.phase, "audio");
        assert.deepEqual(queued("Steve"), []);
        exhausted = true;
        return { done: false, value: { samples: pcm, onset: 1 } };
      },
    }), async samples => {
      assert.equal(samples, pcm);
      return { text: "Steve, check the build", tokens: [], durations: [], timestamps: [] };
    }, () => {
      previewAttempts++;
      attempted.resolve();
      const error = new Error("fixture partial decoder failed");
      if (failure === "synchronous") throw error;
      return Promise.reject(error);
    });
    assert.equal(previewAttempts, 1);
    assert.deepEqual(queued("Steve"), ["check the build"]);
    assert.equal(voiceStateStore.state().transcript?.text, "Steve, check the build");
  });
}

test("a rejected transcript request still delivers the completed phrase once to its addressed resident", async () => {
  voiceStateStore.reset();
  const config = await app.request("/api/voice/config", { method: "PUT", headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ showTranscript: true, cancelWindow: { enabled: false } }) });
  assert.equal(config.status, 200);

  const rejected = deferred();
  const requests: string[] = [];
  const client = new ListenerClient("http://localhost", join(home, "token"), async (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/voice/listener/transcript" && JSON.parse(String(init.body)).text === "unfinished") {
      requests.push("preview rejected");
      rejected.resolve();
      return new Response("Preview temporarily unavailable", { status: 503 });
    }
    if (path === "/voice/utterances") requests.push("final utterance");
    return app.request(url, init);
  });
  const pcm = Float32Array.of(0.1, 0.2);
  let exhausted = false;
  await playRecording(client, () => ({
    get exhausted() { return exhausted; },
    async next({ observe }) {
      assert.ok(observe);
      observe({ preview: "audio", onset: 1, samples: pcm.subarray(0, 1) });
      await rejected.promise;
      assert.deepEqual(requests, ["preview rejected"]);
      assert.deepEqual(queued("Steve"), []);
      exhausted = true;
      return { done: false, value: { samples: pcm, onset: 1 } };
    },
  }), async () => ({ text: "Steve, check the build", tokens: [], timestamps: [], durations: [] }),
  async () => ({ text: "unfinished", tokens: [], timestamps: [], durations: [] }));

  assert.deepEqual(requests, ["preview rejected", "final utterance"]);
  assert.deepEqual(queued("Steve"), ["check the build"]);
});
