import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { describe, it, before, after, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";

import { nativeVoiceListener } from "../src/main/voice-listener.ts";
import { ensureToken } from "../src/server/auth.ts";
import { applyFeatureFlagIntent } from "../src/server/feature-flags/index.ts";
import { setVoiceConfig } from "../src/server/voice/config.ts";
import { serveDesktopVoice } from "../src/server/voice/desktop-endpoint.ts";
import { registerVoiceRoutes } from "../src/server/voice/routes.ts";
import { VOICE_REQUIRED_FLAGS, voiceStateOff } from "../src/shared/voice.ts";

async function until(condition: () => boolean, description: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "timed out waiting for " + description);
    await delay(10);
  }
}

describe("voice listener subprocess protocol and Swift microphone lifecycle", { skip: process.platform !== "darwin" || process.arch !== "arm64" }, () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "listener-lifecycle-"));
    writeFileSync(join(dir, "token"), "fixture");
    execFileSync("swiftc", ["-parse-as-library", "-module-cache-path", join(dir, "modules"),
      "native/voice-listener/Sources/VoiceListener/Listener.swift",
      "native/voice-listener/Tests/Fixtures/LifecycleDevices.swift", "-o", join(dir, "listener")]);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  async function launch(t: TestContext, { sherpa = false, initialCapture = true, roster = [] as string[], inputDevice = "built-in", firstPostStatus = 200, firstPostAccepted = true, firstPostCutoff = 0, firstPostHeld = false, repeatedHeld = false, slowLoad = false, held = false, microphone = "granted" } = {}) {
    const events: string[] = [];
    const diagnostics: string[] = [];
    const hellos: { modelLoaded: boolean; version: string; microphone: string }[] = [];
    const instanceIds = new Set<string | undefined>();
    const modelDir = slowLoad ? join(dir, "slow-load") : dir;
    if (slowLoad) mkdirSync(modelDir);
    const posted: { text: string; revision: string | null }[] = [];
    const captureBounds: { start: unknown; onset: unknown; end: unknown }[] = [];
    let acknowledgeStart!: () => void;
    const startAck = new Promise<void>(resolve => { acknowledgeStart = resolve; });
    t.after(acknowledgeStart);
    const heldAttempts: number[] = [];
    const speechReports: { phase: string; speechStartUs: number; revision: string | null }[] = [];
    const polls: { revision: string | null; response: ServerResponse }[] = [];
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, "http://localhost");
      instanceIds.add(req.headers["x-voice-listener-id"] as string | undefined);
      if (url.pathname === "/voice/listener/directive") {
        polls.push({ revision: url.searchParams.get("revision"), response: res });
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      if (url.pathname === "/voice/listener/hello") {
        const hello = JSON.parse(body);
        if (slowLoad && hellos.length === 1 && !hello.modelLoaded) {
          writeFileSync(join(modelDir, "ready"), "");
          await until(() => events.includes("model loaded"), "model to finish during heartbeat");
          await delay(200);
        }
        hellos.push({ modelLoaded: hello.modelLoaded, version: hello.version, microphone: hello.microphone });
      }
      if (req.method === "POST" && url.pathname === "/voice/listener/speech") {
        const report = JSON.parse(body);
        speechReports.push({ ...report, revision: url.searchParams.get("revision") });
        if (report.phase === "start" && (["dropped-segment", "unfinished-segment"].includes(inputDevice) ||
            (inputDevice === "stalled-onset" && report.speechStartUs === 625))) await startAck;
      }
      if (req.method === "POST" && url.pathname === "/voice/utterances") {
        if (repeatedHeld && JSON.parse(body).text === "first") {
          heldAttempts.push(performance.now());
          if (heldAttempts.length <= 8) res.setHeader("x-voice-held-revision", "first");
        }
        if (posted.length === 0 && firstPostHeld) res.setHeader("x-voice-held-revision", "first");
        if (posted.length === 0 && firstPostCutoff) {
          res.setHeader("x-voice-release-revision", "first");
          res.setHeader("x-voice-release-host-ms", String(firstPostCutoff));
        }
        if (posted.length === 0) res.statusCode = firstPostStatus;
        const accepted = (posted.length > 0 || firstPostAccepted) &&
          !res.hasHeader("x-voice-held-revision") && !res.hasHeader("x-voice-release-revision");
        posted.push({ text: JSON.parse(body).text, revision: url.searchParams.get("revision") });
        captureBounds.push({ start: req.headers["x-voice-capture-start-host-us"], onset: req.headers["x-voice-speech-start-host-us"], end: req.headers["x-voice-capture-end-host-ms"] });
        res.end(JSON.stringify({ accepted }));
        return;
      }
      res.end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const executable = sherpa ? process.execPath : join(dir, "listener");
    const args = sherpa ? ["--import", "tsx", "test/helpers/sherpa-protocol-fixture.ts"] : [];
    const child = spawn(executable, args, { env: {
      ...process.env, VOICE_FIXTURE_PERMISSION: microphone, MISSION_VOICE_DAEMON_URL: "http://127.0.0.1:" + address.port,
      MISSION_VOICE_TOKEN_FILE: join(dir, "token"), MISSION_VOICE_MODEL_DIR: modelDir,
    } });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => events.push(line));
    createInterface({ input: child.stderr }).on("line", (line) => diagnostics.push(line));
    const closed = once(child, "close");
    t.after(async () => {
      child.kill();
      await closed;
      lines.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    async function nextPoll(revision: string | null) {
      await until(() => polls.length > 0, "directive poll after " + revision, slowLoad ? 20000 : 5000);
      const poll = polls.shift()!;
      assert.equal(poll.revision, revision);
      return poll.response;
    }
    function apply(response: ServerResponse, revision: string, capture: boolean, names: string[] = roster) {
      response.end(JSON.stringify({ revision, capture, inputDevice, roster: names }));
    }
    const initial = await nextPoll(null);
    if (held) initial.setHeader("x-voice-held-revision", "first");
    apply(initial, "first", initialCapture);
    return { events, diagnostics, posted, captureBounds, child, closed, nextPoll, apply, hellos, instanceIds, heldAttempts, speechReports, acknowledgeStart };
  }

  for (const inputDevice of ["dropped-segment", "unfinished-segment"]) {
    it(inputDevice + " waits for start acknowledgment before releasing its original onset", async t => {
      const { speechReports, posted, nextPoll, apply, acknowledgeStart, events } = await launch(t, { inputDevice });
      const start = { phase: "start", speechStartUs: 123_456, revision: "first" };
      await until(() => speechReports.some(report => report.phase === "start"), "speech onset POST");
      if (inputDevice === "unfinished-segment") {
        apply(await nextPoll("first"), "muted", false);
        await until(() => events.includes("stopped 1"), "mute to stop the partial phrase");
      }
      await delay(150);
      assert.deepEqual(speechReports, [start]);
      acknowledgeStart();
      await until(() => speechReports.length === 2, "finish for the original onset");
      assert.deepEqual(speechReports, [start, { ...start, phase: "finish" }]);
      assert.deepEqual(posted, []);
    });
  }

  it("a stalled onset acknowledgment lets the decoded cancel and queued utterance post in spoken order", async t => {
    const inputDevice = "stalled-onset";
    const { speechReports, posted, captureBounds, events, nextPoll } = await launch(t, { inputDevice, initialCapture: false });
    const capture = { capture: true, captureRevision: "same-capture", inputDevice, roster: [] };
    (await nextPoll("first")).end(JSON.stringify({ ...capture, revision: "before-countdown", endOfSpeechMs: 5000 }));
    await until(() => speechReports.some(report => report.speechStartUs === 625) && events.includes("decode Cancel."), "recorded onset and decoded cancel");
    assert.equal(posted.length, 0);
    (await nextPoll("before-countdown")).end(JSON.stringify({ ...capture, revision: "countdown", endOfSpeechMs: 500 }));
    // The fixture withholds the first acknowledgment until teardown.
    await until(() => posted.length === 2, "both transcripts despite the stalled acknowledgment", 3000);
    assert.deepEqual(posted.map(post => post.text), ["Cancel.", "next"]);
    assert.deepEqual(speechReports.map(report => report.revision), ["same-capture", "same-capture"]);
    assert.deepEqual(posted.map(post => post.revision), ["same-capture", "same-capture"]);
    assert.deepEqual(captureBounds.map(bound => bound.onset), ["625", "1625"]);
  });

  it("key-up releases only the abandoned onset while completed held speech drains", async t => {
    const { speechReports, posted, nextPoll, apply } = await launch(t, { held: true, inputDevice: "partial-hold" });
    await until(() => speechReports.length === 2, "both onset reports");
    const off = await nextPoll("first");
    off.setHeader("x-voice-release-revision", "first");
    off.setHeader("x-voice-release-host-ms", "1000");
    apply(off, "released", false);
    await until(() => speechReports.length >= 3 && posted.length === 2, "partial release and completed transcripts");
    assert.deepEqual(speechReports.filter(r => r.phase === "finish"), [{ phase: "finish", speechStartUs: 626, revision: "first" }]);
    assert.deepEqual(posted.map(p => p.text), ["completed hold", "final phrase"]);
  });

  for (const backend of ["fluidaudio", "sherpa-onnx"]) {
    it(backend + " retries the identical pause acknowledgement after transient 503s", async t => {
      const { nextPoll, apply, instanceIds } = await launch(t, { sherpa: backend === "sherpa-onnx", initialCapture: false });
      for (let attempt = 0; attempt < 2; attempt++) {
        const ack = await nextPoll("first");
        ack.writeHead(503).end();
      }
      apply(await nextPoll("first"), "recovered", false);
      await nextPoll("recovered");
      assert.equal(instanceIds.size, 1);
    });

    it(backend + " waits through mute, primes the resumed roster and posts under the new capture revision", async t => {
      const { nextPoll, apply, events, posted, hellos, instanceIds } = await launch(t, {
        sherpa: backend === "sherpa-onnx", initialCapture: false, inputDevice: "two-utterances",
      });
      const muted = await nextPoll("first");
      assert.deepEqual(posted, []);
      apply(muted, "resumed", true, ["Steve"]);
      await until(() => posted.length > 0, "fixture transcription to reach the daemon");
      assert.ok(events.includes('prime ["Steve"]'));
      assert.deepEqual(posted[0], { text: "first", revision: "resumed" });
      assert.ok(hellos.some(hello => hello.modelLoaded && hello.version === "4.1"));
      assert.equal(instanceIds.size, 1);
      assert.ok([...instanceIds][0]);
    });
  }

  it("applies revised end-of-speech timing to the running Swift microphone listener", async t => {
    const captureRevision = "automatic-capture";
    const { events, posted, nextPoll } = await launch(t, { initialCapture: false });
    let revision = "active";
    (await nextPoll("first")).end(JSON.stringify({ revision, captureRevision, capture: true, inputDevice: "built-in", roster: [] }));
    await until(() => events.includes("decode in-flight"), "decode to start before the edit");
    for (const endOfSpeechMs of [500, 5000]) {
      const poll = await nextPoll(revision);
      revision = String(endOfSpeechMs);
      poll.end(JSON.stringify({ revision, captureRevision, capture: true, inputDevice: "built-in", roster: [], endOfSpeechMs }));
    }
    const replacement = await nextPoll(revision);
    await until(() => events.includes("silence interval 5000 ms") && posted.length === 2, "final setting and buffered speech");
    assert.deepEqual(events.filter(e => /^(opened|stopped) /.test(e)), ["opened 1"]);
    assert.deepEqual(posted, [{ text: "in-flight", revision: captureRevision }, { text: "buffered", revision: captureRevision }]);
    assert.deepEqual(events.filter(e => e.startsWith("silence interval")), [
      "silence interval 2000 ms", "silence interval 500 ms", "silence interval 5000 ms",
    ]);
    replacement.end(JSON.stringify({ revision: "resumed", captureRevision: "new-capture", capture: true, inputDevice: "built-in", roster: [] }));
    await until(() => events.includes("opened 2"), "new capture authorization to open a fresh microphone");
    assert.deepEqual(events.filter(e => /^(opened|stopped) /.test(e)), ["opened 1", "stopped 1", "opened 2"]);
  });

  it("rejects an invalid end-of-speech duration before opening the microphone", async t => {
    const { events, diagnostics, nextPoll, child, closed } = await launch(t, { initialCapture: false });
    const poll = await nextPoll("first");
    poll.end(JSON.stringify({ revision: "invalid", capture: true, inputDevice: "built-in", roster: [], endOfSpeechMs: 0 }));
    await until(() => child.exitCode !== null, "invalid capture directive to stop the listener");
    assert.deepEqual(await closed, [1, null]);
    assert.ok(diagnostics.includes("Voice listener stopped. Check the daemon, local models and selected input."));
    assert.deepEqual(events.filter(e => e.startsWith("opened ") || e.startsWith("silence interval ")), []);
  });

  it("the managed Swift listener authenticates its daemon before delivering its first hello", async t => {
    const endpointFile = join(dir, "desktop.json");
    const tokenFile = join(dir, "desktop-token");
    writeFileSync(tokenFile, ensureToken());
    const previous = new AbortController();
    await serveDesktopVoice(() => assert.fail("unused endpoint"), endpointFile, previous.signal);
    const staleCertificate = JSON.parse(readFileSync(endpointFile, "utf8")).certificate;
    previous.abort();

    const received: string[] = [];
    const current = new AbortController();
    t.after(() => current.abort());
    await serveDesktopVoice((req, res) => {
      received.push(req.url!);
      res.end("{}");
    }, endpointFile, current.signal);
    const endpoint = JSON.parse(readFileSync(endpointFile, "utf8"));
    const run = async (certificate: string) => {
      // A denial lets the real helper send its hello and exit without touching audio hardware.
      const child = spawn(join(dir, "listener"), [], { env: {
        ...process.env, VOICE_FIXTURE_PERMISSION: "denied", MISSION_VOICE_MODEL_DIR: dir,
        MISSION_VOICE_TOKEN_FILE: tokenFile, MISSION_VOICE_DAEMON_CERT: certificate,
        MISSION_VOICE_DAEMON_URL: "https://127.0.0.1:" + endpoint.port,
      } });
      await once(child, "close");
    };
    await run(staleCertificate);
    assert.deepEqual(received, []);
    await run(endpoint.certificate);
    assert.deepEqual(received, ["/voice/listener/hello"]);
  });

  it("a reconnecting desktop supervisor reclaims its live lease only for its own replacement helper", async t => {
    ensureToken();
    for (const id of [...VOICE_REQUIRED_FLAGS, "voice"] as const) applyFeatureFlagIntent({ kind: "flag", id, enabled: true });
    setVoiceConfig({ backend: "fluidaudio", muted: false });
    const app = new Hono();
    const starts: { id: string | undefined; status: number }[] = [];
    let captures = 0;
    app.use("/voice/listener/hello", async (c, next) => {
      const { modelLoaded } = await c.req.raw.clone().json();
      await next();
      if (!modelLoaded) starts.push({ id: c.req.header("x-voice-listener-id"), status: c.res.status });
    });
    app.use("/voice/listener/directive", async (c, next) => {
      await next();
      if (!c.req.query("revision") && (await c.res.clone().json()).capture) captures++;
    });
    registerVoiceRoutes(app);
    const endpointFile = join(dir, "reconnect.json");
    const lifetime = new AbortController();
    await serveDesktopVoice(getRequestListener(app.fetch), endpointFile, lifetime.signal);
    const { port, certificate } = JSON.parse(readFileSync(endpointFile, "utf8"));
    const endpoint = () => ({ origin: "https://127.0.0.1:" + port, certificate });
    const desktop = nativeVoiceListener(join(dir, "listener"), endpoint);
    const other = nativeVoiceListener(join(dir, "listener"), endpoint);
    t.after(async () => { await Promise.all([desktop.stop(), other.stop()]); lifetime.abort(); });
    const off = voiceStateOff();
    const ready = { ...off, mode: "listening", model: { ...off.model, status: "ready", backend: "fluidaudio", directory: dir } } as const;
    desktop.update(ready, true);
    await until(() => captures === 1, "first Swift helper to acquire capture");
    other.update(ready, true);
    await until(() => starts.length >= 2, "competing helper's hello");
    await other.stop();
    assert.equal(starts[1]!.status, 409);
    assert.notEqual(starts[1]!.id, starts[0]!.id);
    desktop.update(off, false); // The shell stops its child on event stream loss.
    desktop.update(ready, true); // A fresh snapshot from the same daemon restores it.
    await until(() => starts.length >= 3, "replacement helper's hello");
    assert.deepEqual(starts[2], starts[0]);
    assert.equal(starts[2]!.status, 200);
    await until(() => captures === 2, "replacement to acquire capture before lease expiry");
  });

  it("explains the authorized-terminal prerequisite on first launch and keeps unapproved capture closed", async t => {
    const { nextPoll, hellos, events, diagnostics, posted, child, closed } = await launch(t, { microphone: "not-determined" });
    await nextPoll("first"); // The helper has now applied a directive requesting capture.
    child.kill();
    await closed;
    assert.equal(hellos[0]?.modelLoaded, false);
    assert.equal(hellos.at(-1)?.modelLoaded, true);
    assert.ok(hellos.every(hello => hello.microphone === "not-determined"));
    assert.deepEqual(events.filter(event => event.startsWith("opened ")), []);
    assert.deepEqual(posted, []);
    assert.equal(diagnostics.filter(line => line.includes("terminal app that already has microphone access")).length, 1);
  });

  it("finishes the outstanding loading heartbeat before publishing protocol 4.1 readiness", async (t) => {
    const { hellos } = await launch(t, { slowLoad: true });
    await until(() => hellos.length >= 3, "ready hello and delayed heartbeat");
    assert.deepEqual(hellos.map(h => h.modelLoaded), [false, false, true]);
    assert.ok(hellos.every(h => h.version === "4.1"));
  });

  it("a stopped engine refreshes the directive and reopens the same selection with fresh audio", async (t) => {
    const { child, nextPoll, apply, events, posted } = await launch(t, { inputDevice: "reconfigured" });
    await nextPoll("first");
    await until(() => events.includes("decode in-flight"), "old segment in progress");
    child.kill("SIGUSR1");
    const refresh = await nextPoll(null);
    await until(() => events.includes("stopped 1"), "stopped input to close");
    apply(refresh, "first", true);
    await until(() => events.includes("released fresh"), "fresh segment delivery");
    assert.deepEqual(posted, [{ text: "fresh", revision: "first" }]);
  });

  it("a stopped engine exits if the selected UID is unavailable on reopen", async (t) => {
    const { child, nextPoll, apply, closed, events, diagnostics } = await launch(t, { inputDevice: "unplugged" });
    await nextPoll("first");
    child.kill("SIGUSR1");
    apply(await nextPoll(null), "first", true);
    assert.deepEqual(await closed, [1, null]);
    assert.match(diagnostics.join("\n"), /selected microphone input is unavailable/);
    assert.ok(events.includes("stopped 1"));
  });

  it("capture on/off/on closes the first input and posts only fresh speech when the old decoder completes", async (t) => {
    const { events, posted, nextPoll, apply } = await launch(t);
    await until(() => events.includes("decode in-flight"), "first microphone decoding");
    apply(await nextPoll("first"), "muted", false);
    const muted = await nextPoll("muted");
    assert.deepEqual(events.filter(e => e.startsWith("opened ")), ["opened 1"]);
    await until(() => events.includes("released microphone 1"), "microphone release while muted");
    assert.ok(events.includes("stopped 1"));
    apply(muted, "resumed", true);
    await nextPoll("resumed");
    await until(() => events.includes("released in-flight") && events.includes("released buffered") &&
      events.includes("released fresh"), "old and new segments to finish processing");
    assert.deepEqual(events.filter(e => e.startsWith("opened ")), ["opened 1", "opened 2"]);
    assert.deepEqual(events.filter(e => e.startsWith("decode ")), ["decode in-flight", "decode fresh"]);
    assert.deepEqual(posted, [{ text: "fresh", revision: "resumed" }]);
  });

  it("key release closes the microphone and drains the in-flight, queued and final speech on the held revision", async (t) => {
    const { events, posted, nextPoll, apply } = await launch(t);
    await until(() => events.includes("decode in-flight"), "recognition in progress");
    const off = await nextPoll("first");
    off.setHeader("x-voice-release-revision", "first");
    off.setHeader("x-voice-release-host-ms", "2500");
    apply(off, "released", false);
    await nextPoll("released");
    await until(() => posted.length === 3, "all held speech to drain after closing");
    assert.ok(events.includes("stopped 1"));
    assert.ok(events.indexOf("stopped 1") < events.indexOf("decode final phrase"));
    assert.deepEqual(events.filter(e => e.startsWith("opened ")), ["opened 1"]);
    assert.deepEqual(posted, ["in-flight", "buffered", "final phrase"].map(text => ({ text, revision: "first" })));
  });

  it("primes the recognizer with the replacement roster while capture stays enabled", async (t) => {
    const first = ["Steve", "Atlas"];
    const replacement = ["Atlas", "Luna"];
    const { events, nextPoll, apply } = await launch(t, { roster: first });
    const primings = () => events.filter(e => e.startsWith("prime ")).map(e => JSON.parse(e.slice(6)));
    await until(() => primings().length === 1, "initial recognizer priming");
    apply(await nextPoll("first"), "roster-change", true, replacement);
    await until(() => primings().length >= 2, "updated recognizer priming");
    assert.deepEqual(primings(), [first, replacement]);
  });

  it("delivers every phrase in a hold in order only after confirmed release", async t => {
    const { events, posted, captureBounds, nextPoll, apply } = await launch(t, { held: true });
    await until(() => events.includes("holding audio"), "held microphone");
    const release = await nextPoll("first");
    assert.deepEqual(posted, []);
    release.setHeader("x-voice-release-revision", "first");
    release.setHeader("x-voice-release-host-ms", "1000");
    apply(release, "off", false);
    await until(() => posted.length === 5, "complete phrases and tail");
    assert.deepEqual(posted, ["phrase 1", "phrase 2", "phrase 3", "phrase 4", "final phrase"].map(text => ({ text, revision: "first" })));
    assert.deepEqual(captureBounds, posted.map(() => ({ start: "125", onset: "625", end: "1" })));
    assert.ok(events.indexOf("stopped 1") < events.indexOf("decode phrase 1"));
  });

  it("closes a held microphone and discards all speech on a Unix-only release", async t => {
    const { events, posted, nextPoll, apply } = await launch(t, { held: true });
    await until(() => events.includes("holding audio"), "held microphone");
    const release = await nextPoll("first");
    release.setHeader("x-voice-release-revision", "first");
    release.setHeader("x-voice-release-at", String(Date.now()));
    apply(release, "off", false);
    await nextPoll("off");
    await until(() => events.includes("released microphone 1"), "discarded hold to close");
    assert.deepEqual(posted, []);
    assert.ok(!events.some(e => e.startsWith("decode ")));
  });

  it("records a second hold while the first is decoding and drains both in spoken order", async t => {
    const { events, posted, nextPoll, apply } = await launch(t, { held: true, inputDevice: "rapid-press" });
    function keyUp(res: ServerResponse, from: string, to: string) {
      res.setHeader("x-voice-release-revision", from);
      res.setHeader("x-voice-release-host-ms", "1000");
      res.setHeader("x-voice-draining-revisions", from === "first" ? "first" : "first,second");
      apply(res, to, false);
    }
    keyUp(await nextPoll("first"), "first", "off");
    await until(() => events.includes("decode first hold"), "first hold decoding before next press");
    const second = await nextPoll("off");
    second.setHeader("x-voice-held-revision", "second");
    second.setHeader("x-voice-draining-revisions", "first");
    apply(second, "second", true);
    await until(() => posted.length === 2, "previous hold to finish while recording the next");
    assert.deepEqual(posted.map(p => [p.revision, p.text]), [["first", "first hold"], ["first", "final phrase"]]);
    keyUp(await nextPoll("second"), "second", "off-again");
    await until(() => posted.length === 7, "second hold to drain");
    assert.deepEqual(posted.slice(2).map(p => p.revision), Array(5).fill("second"));
  });

  it("rechecks a combined release and press before opening a second exclusive microphone", async t => {
    const { events, nextPoll, apply, posted, child } = await launch(t, { held: true, inputDevice: "exclusive" });
    const press = await nextPoll("first");
    press.setHeader("x-voice-release-revision", "first");
    press.setHeader("x-voice-release-host-ms", "1000");
    press.setHeader("x-voice-held-revision", "second");
    press.setHeader("x-voice-draining-revisions", "first");
    apply(press, "second", true);
    await nextPoll("second");
    child.kill("SIGUSR2"); // Deliver the old input's final tap while the poll is pending.
    const refresh = await nextPoll(null);
    assert.ok(events.includes("stopped 1"));
    assert.ok(!events.includes("opened 2"));
    refresh.setHeader("x-voice-held-revision", "second");
    refresh.setHeader("x-voice-draining-revisions", "first");
    apply(refresh, "second", true);
    await until(() => posted.length === 2, "first hold to finish during the second capture");
    assert.ok(events.indexOf("opened 2") > events.indexOf("stopped 1"));
    assert.deepEqual(posted.map(p => p.text), ["first hold", "final phrase"]);
    assert.ok(!events.includes("overlapping microphones"));
  });

  it("mute can cancel a closing tap before a pending second press opens its microphone", async t => {
    const { events, nextPoll, apply, posted } = await launch(t, { held: true, inputDevice: "exclusive" });
    const press = await nextPoll("first");
    press.setHeader("x-voice-release-revision", "first");
    press.setHeader("x-voice-release-host-ms", "1000");
    press.setHeader("x-voice-held-revision", "second");
    press.setHeader("x-voice-draining-revisions", "first");
    apply(press, "second", true);
    apply(await nextPoll("second"), "muted", false);
    await nextPoll("muted");
    await until(() => events.includes("released microphone 1"), "revoked tap to close");
    assert.ok(!events.includes("opened 2"));
    assert.deepEqual(posted, []);
  });

  it("re-decodes a segment straddling key-up when the directive arrives during recognition", async (t) => {
    const { events, posted, nextPoll, apply } = await launch(t);
    await until(() => events.includes("decode in-flight"), "recognition before release");
    const off = await nextPoll("first");
    off.setHeader("x-voice-release-revision", "first");
    off.setHeader("x-voice-release-at", String(Date.now() + 60_000));
    off.setHeader("x-voice-release-host-ms", "1000");
    apply(off, "released", false);
    await until(() => posted.length === 3, "clipped in-flight result, queue and tail");
    assert.ok(events.includes("decode in-flight-clipped"));
    assert.deepEqual(posted.map(p => p.text), ["in-flight-clipped", "buffered", "final phrase"]);
  });

  it("re-decodes the clipped prefix if the POST reaches the daemon before the key-up directive arrives", async (t) => {
    const { events, posted } = await launch(t, { inputDevice: "two-utterances", firstPostCutoff: 1000 });
    await until(() => posted.length === 3, "server refusal followed by clipped result and next segment");
    assert.ok(events.includes("decode first-clipped"));
    assert.deepEqual(posted.map(p => p.text), ["first", "first-clipped", "second"]);
  });

  it("spaces and bounds repeated held responses so later speech can be delivered", async t => {
    const { posted, heldAttempts, events } = await launch(t, { inputDevice: "two-utterances", repeatedHeld: true });
    await until(() => posted.some(p => p.text === "second"), "next segment after repeated held responses");
    assert.ok(heldAttempts.length > 1 && heldAttempts.length <= 3);
    for (let i = 1; i < heldAttempts.length; i++) assert.ok(heldAttempts[i]! - heldAttempts[i - 1]! >= 200);
    assert.deepEqual(events.filter(e => e.startsWith("decode ")), ["decode first", "decode second"]);
  });

  it("retries a held POST before later speech without decoding it a second time", async (t) => {
    const { posted, events } = await launch(t, { inputDevice: "two-utterances", firstPostHeld: true });
    await until(() => posted.length === 3, "retry and subsequent delivery");
    assert.deepEqual(posted.map(p => p.text), ["first", "first", "second"]);
    assert.deepEqual(events.filter(e => e.startsWith("decode ")), ["decode first", "decode second"]);
  });

  it("delivers the next segment on the same active microphone after a transcription failure", async (t) => {
    const { events, posted, child, instanceIds } = await launch(t, { inputDevice: "two-segments" });
    await until(() => events.includes("released next"), "second segment to finish");
    assert.deepEqual(events.filter(e => e.startsWith("decode ")), ["decode undecodable", "decode next"]);
    assert.deepEqual(posted, [{ text: "next", revision: "first" }]);
    assert.equal(instanceIds.size, 1, "hello, polling and delivery must identify the same listener process");
    assert.match([...instanceIds][0] ?? "", /^[0-9a-f-]{36}$/i);
    assert.deepEqual(events.filter(e => /^(opened|stopped|released microphone) /.test(e)), ["opened 1"]);
    assert.equal(child.exitCode, null);
  });

  it("reports a terminal utterance rejection without its text and continues capturing", async t => {
    const { events, diagnostics, posted } = await launch(t, { inputDevice: "two-utterances", firstPostAccepted: false });
    await until(() => events.includes("released second"), "second utterance to finish");
    assert.deepEqual(posted.map(p => p.text), ["first", "second"]);
    assert.deepEqual(diagnostics, ["Voice daemon declined an utterance."]);
  });

  it("posts the next utterance on the same active microphone after the daemon rejects the first POST", async (t) => {
    const { events, posted, child } = await launch(t, { inputDevice: "two-utterances", firstPostStatus: 503 });
    await until(() => events.includes("released second"), "listener to finish the second delivery");
    assert.deepEqual(posted, [{ text: "first", revision: "first" }, { text: "second", revision: "first" }]);
    assert.deepEqual(events.filter(e => /^(opened|stopped|released microphone) /.test(e)), ["opened 1"]);
    assert.equal(child.exitCode, null);
  });

  it("a failed directive poll stops and releases an active microphone and the process exits with failure", { timeout: 10000 }, async (t) => {
    const { events, posted, child, closed, nextPoll } = await launch(t);
    await until(() => events.includes("decode in-flight"), "first microphone decoding");
    const response = await nextPoll("first");
    response.writeHead(503).end();
    await until(() => child.exitCode !== null || child.signalCode !== null, "listener exit after poll failure");
    assert.deepEqual(await closed, [1, null]);
    assert.deepEqual(events.filter(e => e.endsWith(" 1")), ["opened 1", "stopped 1", "released microphone 1"]);
    assert.deepEqual(posted, []);
  });
});
