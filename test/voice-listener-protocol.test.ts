import assert from "node:assert/strict";
import test, { before, after, describe } from "node:test";
import { Hono } from "hono";
import { playRecording } from "../src/voice-listener/playback.ts";
import { recordingSegments } from "../src/voice-listener/segments.ts";
import { ListenerClient } from "../src/voice-listener/client.ts";
import { voiceHostTimeUs } from "../src/server/voice/host-clock.ts";
import { ensureNativeStateLockAddon } from "./helpers/native-state-lock.ts";
import { FakeVoiceListener } from "./helpers/fake-voice-listener.ts";
import { registerVoiceRoutes, registerVoiceUtteranceRoutes } from "../src/server/voice/routes.ts";
import { voiceStateStore, wireVoiceStateEvents } from "../src/server/voice/state.ts";
import { applyFeatureFlagIntent } from "../src/server/feature-flags/index.ts";
import { ensureToken } from "../src/server/auth.ts";
import { tokenPath } from "../src/shared/harness-runtime.mjs";
import { VOICE_CAPTURE_START_HEADER, VOICE_CAPTURE_END_HEADER, VOICE_HELD_REVISION_HEADER, VOICE_REQUIRED_FLAGS, VoiceShellReportSchema } from "../src/shared/voice.ts";
import { setVoiceConfig } from "../src/server/voice/config.ts";
import { VoiceNameRegistry, wireVoiceNameEvents } from "../src/server/voice/names.ts";
import { Registry } from "../src/server/registry.ts";
import { mkTask } from "./helpers/session-fixture.ts";

const app = new Hono();
registerVoiceRoutes(app);
const router = registerVoiceUtteranceRoutes(app, { deliver: async () => "queued" }, () => {});
for (const id of [...VOICE_REQUIRED_FLAGS, "voice"] as const) applyFeatureFlagIntent({ kind: "flag", id, enabled: true });
ensureToken();
const stop = wireVoiceStateEvents(() => {});
after(() => { stop(); router.reset(); });

for (const [backend, Client] of [["fluidaudio", FakeVoiceListener], ["sherpa-onnx", ListenerClient]] as const) {
  describe(backend + " listener protocol", () => {
    const listener = new Client("http://localhost", tokenPath(), async (url, init) => app.request(url, init));
    const registry = new Registry();
    let stopNames: () => void;
    before(() => {
      setVoiceConfig({ muted: false, inputDevice: "built-in", backend: "auto" });
      voiceStateStore.reset();
      const names = new VoiceNameRegistry(registry, { now: Date.now, enabled: () => true, taskStored: () => true });
      stopNames = wireVoiceNameEvents(names, () => {});
    });
    after(() => stopNames());

    test("token-gated directives reflect capture, device and spoken roster changes, including a missed mute cycle", { timeout: 3000 }, async () => {
      assert.equal((await app.request("/voice/listener/directive")).status, 401);
      assert.ok((await listener.hello()).ok);
      setVoiceConfig({ muted: false });
      const initial = await listener.poll();
      assert.deepEqual(initial, { revision: initial.revision, speak: null, capture: true, inputDevice: "built-in", roster: [], pauseMs: null });
      const words = [{ text: "hello", startMs: 0, endMs: 320 }];
      assert.deepEqual(await (await listener.utterance("hello", words, initial.revision)).json(), { accepted: true });
      const pending = listener.poll(initial.revision);
      await app.request("/api/voice/mute", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"muted":true}' });
      const muted = await pending;
      assert.equal(muted.capture, false);
      assert.deepEqual(await (await listener.utterance("hello", words, muted.revision)).json(), { accepted: false });
      setVoiceConfig({ muted: false });
      assert.notEqual((await listener.poll(initial.revision)).revision, initial.revision);

      const change = listener.poll((await listener.poll()).revision);
      await new Promise<void>((resolve) => setImmediate(resolve));
      registry.upsertTask(mkTask({ callSign: "Luna", status: "running", dispatchedAt: 10, sessionId: "sdk:luna" }));
      const named = await change;
      assert.deepEqual(named.roster, ["Luna"]);
      const device = listener.poll(named.revision);
      setVoiceConfig({ inputDevice: "system-default" });
      assert.equal((await device).inputDevice, "system-default");
    });

    test("poll holds through identical hellos then returns unchanged at 25 seconds", async (t) => {
      assert.ok((await listener.hello()).ok);
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const initial = await listener.poll();
      let answered = false;
      const response = listener.poll(initial.revision).then((value) => { answered = true; return value; });
      assert.ok((await listener.hello()).ok);
      t.mock.timers.tick(24_999);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(answered, false);
      t.mock.timers.tick(1);
      assert.deepEqual(await response, initial);
    });

    test("disabling Voice returns 404 to an outstanding directive poll", { timeout: 3000 }, async (t) => {
      voiceStateStore.reset();
      t.after(() => { applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: true }); });
      assert.ok((await listener.hello()).ok);
      const current = await listener.poll();
      const pending = assert.rejects(listener.poll(current.revision), /404/);
      await new Promise<void>(resolve => setImmediate(resolve));
      applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: false });
      await pending;
    });

    test("a terminal denial releases capture immediately while Setup retains the denial", async () => {
      voiceStateStore.reset();
      const replacement = new Client("http://localhost", tokenPath(), async (url, init) => app.request(url, init));
      assert.ok((await listener.hello({ microphone: "denied" })).ok);
      assert.deepEqual(voiceStateStore.microphoneReading(), { permission: "denied", source: "listener" });
      await assert.rejects(listener.poll(), /409/);
      assert.ok((await replacement.hello()).ok, "first hello reported denial, so a retry can start immediately");
      setVoiceConfig({ muted: true });
      const initial = await replacement.poll();
      assert.equal(initial.capture, false);
      const pending = assert.rejects(replacement.poll(initial.revision), /409/);
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.ok((await replacement.hello({ microphone: "denied" })).ok);
      await pending;
      assert.deepEqual(voiceStateStore.microphoneReading(), { permission: "denied", source: "listener" });
      assert.ok((await listener.hello()).ok, "an existing owner also releases its lease on denial");
      setVoiceConfig({ muted: false });
      const current = await listener.poll();
      assert.equal(current.capture, true);
      assert.notEqual(current.revision, initial.revision);
      assert.deepEqual(voiceStateStore.microphoneReading(), { permission: "granted", source: "listener" });
      assert.deepEqual(await (await replacement.utterance("hello", [], current.revision)).json(), { accepted: false });
    });

    test("a granted listener takes over immediately from a live helper without microphone access", async () => {
      const replacement = new Client("http://localhost", tokenPath(), async (url, init) => app.request(url, init));
      setVoiceConfig({ muted: false });
      for (const permission of ["not-determined", "restricted", "unknown"] as const) {
        voiceStateStore.reset();
        assert.ok((await listener.hello({ microphone: permission })).ok);
        assert.deepEqual(voiceStateStore.microphoneReading(), { permission, source: "listener" });
        const waiting = await listener.poll();
        assert.equal(waiting.capture, false);
        assert.deepEqual(await (await listener.utterance("old", [], waiting.revision)).json(), { accepted: false });
        assert.ok((await listener.hello({ microphone: permission })).ok, "still sending heartbeats");
        const displaced = assert.rejects(listener.poll(waiting.revision), /409/);
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.ok((await replacement.hello()).ok, "no heartbeat lapse is required");
        await displaced;
        const current = await replacement.poll();
        assert.equal(current.capture, true);
        assert.notEqual(current.revision, waiting.revision);
        assert.deepEqual(voiceStateStore.microphoneReading(), { permission: "granted", source: "listener" });
        assert.equal((await listener.hello({ microphone: permission })).status, 409);
        assert.deepEqual(await (await listener.utterance("old", [], current.revision)).json(), { accepted: false });
        assert.deepEqual(await (await replacement.utterance("fresh", [], current.revision)).json(), { accepted: true });
      }
    });
  });
}

test("switching backends releases the previous owner and refuses its heartbeats", async (t) => {
  const listener = new FakeVoiceListener("http://localhost", tokenPath(), async (url, init) => app.request(url, init));
  voiceStateStore.reset();
  setVoiceConfig({ muted: false, backend: "auto" });
  t.after(() => { setVoiceConfig({ backend: "auto" }); });
  const sherpa = new ListenerClient("http://localhost", tokenPath(), async (url, init) => app.request(url, init));
  assert.ok((await listener.hello()).ok);
  const active = await listener.poll();
  assert.equal(active.capture, true);
  const stopped = assert.rejects(listener.poll(active.revision), /409/);
  await new Promise<void>(resolve => setImmediate(resolve));
  setVoiceConfig({ backend: "sherpa-onnx" });
  await stopped;
  assert.deepEqual(await (await listener.utterance("old", [], active.revision)).json(), { accepted: false });
  const refused = await listener.hello();
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error, "backend_not_selected");
  assert.ok((await sherpa.hello()).ok);
  const selected = await sherpa.poll();
  assert.equal(selected.capture, true);
  assert.notEqual(selected.revision, active.revision);
  assert.deepEqual(await (await sherpa.utterance("new", [], selected.revision)).json(), { accepted: true });
  setVoiceConfig({ backend: "auto" });
  assert.equal((await (await listener.hello()).json()).error, "listener_in_use");
});

test("sherpa waits for capture, discards a stale decode and posts the next file segment after a mute cycle", { timeout: 3000 }, async () => {
  voiceStateStore.reset();
  setVoiceConfig({ muted: true, backend: "sherpa-onnx" });
  let resumed = false;
  const posts: { text: string; accepted: boolean; revision: string | null }[] = [];
  const client = new ListenerClient("http://localhost", tokenPath(), async (url, init) => {
    const response = app.request(url, init);
    if (url.includes("directive?revision=")) {
      resumed = true;
      setVoiceConfig({ muted: false });
    }
    if (new URL(url).pathname === "/voice/utterances") {
      const { accepted } = await (await response).clone().json();
      posts.push({ text: JSON.parse(String(init.body)).text, accepted, revision: new URL(url).searchParams.get("revision") });
    }
    return response;
  });
  function* samples() {
    assert.ok(resumed, "speech detection waited for the released mute directive");
    yield { samples: Float32Array.of(1) };
    yield { samples: Float32Array.of(2) };
  }
  await playRecording(client, () => Object.assign(samples(), { exhausted: false }), async segment => {
    if (segment[0] === 1) {
      setVoiceConfig({ muted: true });
      setVoiceConfig({ muted: false });
    }
    return { text: segment[0] === 1 ? "stale" : "fresh", tokens: [], timestamps: [], durations: [] };
  });
  assert.deepEqual(posts.map(({ text, accepted }) => [text, accepted]), [["stale", false], ["fresh", true]]);
  assert.notEqual(posts[0]!.revision, posts[1]!.revision);
});

test("sherpa skips a blank decode and posts speech from the next file segment", async () => {
  voiceStateStore.reset();
  setVoiceConfig({ muted: false, backend: "sherpa-onnx" });
  const posts: string[] = [];
  const client = new ListenerClient("http://localhost", tokenPath(), async (url, init) => {
    if (new URL(url).pathname === "/voice/utterances") posts.push(JSON.parse(String(init.body)).text);
    return app.request(url, init);
  });
  const blank = Float32Array.of(1);
  const speech = Float32Array.of(2);
  const decoded: Float32Array[] = [];
  await playRecording(client, () => Object.assign([{ samples: blank }, { samples: speech }].values(), { exhausted: false }), async segment => {
    decoded.push(segment);
    return { text: segment[0] === blank[0] ? " \t" : "check the build", tokens: [], timestamps: [], durations: [] };
  });
  assert.deepEqual(decoded, [blank, speech]);
  assert.deepEqual(posts, ["check the build"]);
});

test("a key release during decoding admits only speech read inside the hold", { timeout: 3000 }, async t => {
  ensureNativeStateLockAddon();
  setVoiceConfig({ backend: "sherpa-onnx", muted: false, autoMuteDuringCalls: true });
  voiceStateStore.reset();
  t.after(() => voiceStateStore.reset());
  const pressed = voiceHostTimeUs();
  voiceStateStore.acceptShellReport(VoiceShellReportSchema.parse({ reportedAtHostUs: pressed, callActive: true, pushToTalk: true }));
  let released = 0;
  let accepted = false;
  const client = new ListenerClient("http://localhost", tokenPath(), async (url, init) => {
    const response = await app.request(url, init);
    if (new URL(url).pathname === "/voice/utterances") {
      const headers = new Headers(init.headers);
      const start = Number(headers.get(VOICE_CAPTURE_START_HEADER));
      const end = Number(headers.get(VOICE_CAPTURE_END_HEADER));
      assert.ok(start >= pressed && start < end * 1000 && end * 1000 <= released);
      accepted = (await response.clone().json()).accepted;
    }
    return response;
  });
  let ready = false;
  await playRecording(client, signal => recordingSegments(new Float32Array(512 * 70), {
    acceptWaveform() {}, flush() { ready = true; }, isEmpty: () => !ready,
    front: () => ({ start: 10 * 512, samples: new Float32Array(60 * 512) }), pop() { ready = false; }, reset() {},
  }, signal, voiceHostTimeUs), async () => {
    await new Promise(resolve => setTimeout(resolve, 4));
    released = voiceHostTimeUs();
    voiceStateStore.acceptShellReport(VoiceShellReportSchema.parse({ reportedAtHostUs: released, callActive: true, pushToTalkReleasedAtHostUs: released }));
    assert.equal(voiceStateStore.state().mode, "auto-muted");
    return { text: "speech", tokens: [], timestamps: [], durations: [] };
  });
  assert.equal(accepted, true);
});

test("a still-held response retries the same capture and leaves subsequent speech playable", async () => {
  const requests: { body: string; at: number; bounds: string[] }[] = [];
  const client = new ListenerClient("http://localhost", tokenPath(), async (url, init) => {
    if (new URL(url).pathname.endsWith("/directive")) return Response.json({ revision: "r", capture: true, inputDevice: "system-default", roster: [] },
      { headers: { [VOICE_HELD_REVISION_HEADER]: "r" } });
    if (!new URL(url).pathname.endsWith("/utterances")) return Response.json({ accepted: true });
    const headers = new Headers(init.headers);
    requests.push({ body: String(init.body), at: performance.now(), bounds: [headers.get(VOICE_CAPTURE_START_HEADER)!, headers.get(VOICE_CAPTURE_END_HEADER)!] });
    return requests.length <= 3 ? Response.json({ accepted: false }, { headers: { [VOICE_HELD_REVISION_HEADER]: "r" } }) : Response.json({ accepted: true });
  });
  const segments = [1, 2].map(i => ({ samples: Float32Array.of(i), capture: { startUs: i * 1000, endMs: i + 1 } }));
  await playRecording(client, () => Object.assign(segments.values(), { exhausted: false }), async samples => ({
    text: String(samples[0]), tokens: [], timestamps: [], durations: [],
  }));
  assert.equal(requests.length, 4);
  assert.deepEqual(requests.slice(0, 3).map(r => r.body), Array(3).fill(requests[0]!.body));
  assert.deepEqual(requests.map(r => r.bounds), [["1000", "2"], ["1000", "2"], ["1000", "2"], ["2000", "3"]]);
  assert.ok(requests[1]!.at - requests[0]!.at >= 245 && requests[2]!.at - requests[1]!.at >= 245);
  assert.equal(JSON.parse(requests[3]!.body).text, "2");
});

test("the listener cancels the held response body before a failing retry", async () => {
  let attempts = 0;
  let cancelled = false;
  const client = new ListenerClient("http://localhost", tokenPath(), async () => {
    if (++attempts === 1) {
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { [VOICE_HELD_REVISION_HEADER]: "hold" } });
    }
    assert.ok(cancelled, "release the previous response before the next POST");
    throw new Error("retry connection closed");
  });
  await assert.rejects(client.utterance("speech", [], "hold", Date.now(), new AbortController().signal,
    { startUs: 1000, endMs: 2 }), /retry connection closed/);
  assert.equal(attempts, 2);
});

test("a mute during speech detection pauses the file scan and resumes at the next unread sample", async () => {
  voiceStateStore.reset();
  setVoiceConfig({ muted: false, backend: "sherpa-onnx" });
  const windows = 256;
  let scanned = 0;
  let pausedAt = 0;
  const decoded: number[] = [];
  const posts: boolean[] = [];
  const client = new ListenerClient("http://localhost", tokenPath(), async (url, init) => {
    const response = app.request(url, init);
    if (url.includes("directive?revision=")) {
      pausedAt = scanned;
      assert.ok(pausedAt > 0 && pausedAt < windows);
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(scanned, pausedAt);
      assert.deepEqual(decoded, []);
      setVoiceConfig({ muted: false });
    }
    if (new URL(url).pathname === "/voice/utterances") posts.push((await (await response).clone().json()).accepted);
    return response;
  });
  const samples = new Float32Array(512 * windows);
  let detected = 0;
  let partial = 0;
  await playRecording(client, signal => recordingSegments(samples, {
    acceptWaveform(batch) {
      assert.equal(batch.byteOffset / 4, scanned * 512);
      scanned++;
      if (scanned === 1) partial = scanned;
      if (scanned === windows) detected = partial || scanned;
      if (scanned === 2) setVoiceConfig({ muted: true });
    },
    isEmpty: () => detected === 0, front: () => ({ start: 0, samples: Float32Array.of(detected) }),
    pop() { detected = 0; },
    reset() { partial = 0; detected = 0; },
    flush() {},
  }, signal, voiceHostTimeUs), async segment => {
    decoded.push(segment[0]!);
    return { text: "speech", tokens: [], timestamps: [], durations: [] };
  });
  assert.ok(pausedAt > 0, "the scan must observe the mute before EOF");
  assert.equal(scanned, windows);
  assert.deepEqual(decoded, [windows], "only speech captured under the resumed directive is decoded");
  assert.deepEqual(posts, [true]);
});

test("muting during the last decode discards it and ends playback while capture stays muted", async () => {
  voiceStateStore.reset();
  setVoiceConfig({ muted: false, backend: "sherpa-onnx" });
  const accepted: boolean[] = [];
  const client = new ListenerClient("http://localhost", tokenPath(), async (url, init) => {
    assert.equal(new URL(url).searchParams.has("revision") && url.includes("/directive"), false,
      "a finished recording must not wait for capture to resume");
    const response = await app.request(url, init);
    if (new URL(url).pathname === "/voice/utterances") accepted.push((await response.clone().json()).accepted);
    return response;
  });
  let ready = false;
  await playRecording(client, signal => recordingSegments(Float32Array.of(1), {
    acceptWaveform() {}, flush() { ready = true; }, isEmpty: () => !ready,
    front: () => ({ start: 0, samples: Float32Array.of(1) }), pop() { ready = false; }, reset() { ready = false; },
  }, signal, voiceHostTimeUs), async () => {
    setVoiceConfig({ muted: true });
    return { text: "last", tokens: [], timestamps: [], durations: [] };
  });
  assert.deepEqual(accepted, [false]);
});

test("completed speech is delivered before the scanner reads any trailing silence", async () => {
  voiceStateStore.reset();
  setVoiceConfig({ muted: false, backend: "sherpa-onnx" });
  const windows = 256;
  let scanned = 0;
  let ready = false;
  const deliveredAt: number[] = [];
  const client = new ListenerClient("http://localhost", tokenPath(), async (url, init) => {
    const response = await app.request(url, init);
    if (new URL(url).pathname === "/voice/utterances" && (await response.clone().json()).accepted) deliveredAt.push(scanned);
    return response;
  });
  await playRecording(client, signal => recordingSegments(new Float32Array(512 * windows), {
    acceptWaveform() { ready = ++scanned === 3; },
    isEmpty: () => !ready, front: () => ({ start: 0, samples: Float32Array.of(1) }),
    pop() { ready = false; }, reset() { ready = false; }, flush() {},
  }, signal, voiceHostTimeUs), async () => ({ text: "command", tokens: [], timestamps: [], durations: [] }));
  assert.deepEqual(deliveredAt, [3]);
  assert.equal(scanned, windows);
});

for (const [failure, error] of [
  ["refused hello", "Listener hello refused: 409"],
  ["failed post", "Utterance HTTP 503"],
  ["rejected capture", "Daemon refused the capture"],
] as const) {
  test(`sherpa closes the segment iterator on ${failure}`, async t => {
    const released: string[] = [];
    const response = (name: string, status: number) => new Response(new ReadableStream({ cancel() { released.push(name); } }), { status });
    const client = new ListenerClient("http://localhost", tokenPath(), async url => {
      switch (new URL(url).pathname) {
        case "/voice/listener/hello": return response("hello", failure === "refused hello" ? 409 : 200);
        case "/voice/listener/directive": return Response.json({ revision: "unchanged", capture: true, roster: [], inputDevice: "built-in" });
        case "/voice/utterances": return failure === "failed post" ? response("utterance", 503) : Response.json({ accepted: false });
        default: throw new Error("Unexpected request " + url);
      }
    });
    const segments = Object.assign((function* () { yield { samples: Float32Array.of(1) }; })(), { exhausted: false });
    const close = t.mock.method(segments, "return");
    await assert.rejects(playRecording(client, () => segments, async () => ({
      text: "test", tokens: [], timestamps: [], durations: [],
    })), { message: error });
    assert.equal(close.mock.callCount(), 1);
    assert.deepEqual(released, failure === "failed post" ? ["hello", "utterance"] : ["hello"]);
    assert.equal(segments.next().done, true);
  });
}

test("the listener client accepts HTTP loopback origins and refuses external hosts and other schemes", () => {
  for (const origin of ["http://localhost:7317", "http://127.0.0.1", "http://[::1]"]) {
    assert.doesNotThrow(() => new ListenerClient(origin, tokenPath()));
  }
  for (const origin of ["http://example.com", "https://localhost"]) {
    assert.throws(() => new ListenerClient(origin, tokenPath()), { message: "Expected a loopback daemon URL" });
  }
});

test("an incompatible directive ends playback before a second poll or a recording read", async () => {
  let polls = 0;
  const client = new ListenerClient("http://localhost", tokenPath(), async url => {
    if (new URL(url).pathname === "/voice/listener/directive") assert.equal(++polls, 1);
    return Response.json({});
  });
  await assert.rejects(playRecording(client, () => ({ exhausted: false, next: () => assert.fail("unexpected recording read") }),
    async () => assert.fail("unexpected decode")), { message: "Invalid voice listener directive" });
  assert.equal(polls, 1);
});

test("a malformed utterance acknowledgment stops playback before the next segment", async () => {
  for (const body of ['{"accepted":"false"}', '{}', 'null', 'invalid JSON']) {
    let reads = 0;
    const client = new ListenerClient("http://localhost", tokenPath(), async url => {
      if (new URL(url).pathname === "/voice/utterances") return new Response(body);
      return Response.json({ revision: "current", capture: true, roster: [], inputDevice: "built-in" });
    });
    await assert.rejects(playRecording(client, () => ({
      exhausted: false,
      next() {
        assert.equal(++reads, 1);
        return { done: false, value: { samples: Float32Array.of(1) } };
      },
    }), async () => ({ text: "test", tokens: [], timestamps: [], durations: [] })),
    { message: "Invalid voice utterance acknowledgment" });
  }
});

test("scanning a silent recording lets the event loop run before reaching EOF", async () => {
  const lifetime = new AbortController();
  const windows = 256;
  let scanned = 0;
  const segments = recordingSegments(new Float32Array(512 * windows), {
    acceptWaveform() {
      if (++scanned === 1) setImmediate(() => lifetime.abort());
    },
    isEmpty: () => true,
    flush() {}, pop() {}, reset() {}, front: () => assert.fail("no speech"),
  }, lifetime.signal, voiceHostTimeUs);
  assert.deepEqual(await segments.next({ revision: "active" }), { done: false, value: null });
  await assert.rejects(segments.next({ revision: "active" }), { name: "AbortError" });
  assert.ok(scanned > 0 && scanned < windows);
});
