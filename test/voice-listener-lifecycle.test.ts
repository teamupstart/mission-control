import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { describe, it, before, after, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

async function until(condition: () => boolean, description: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "timed out waiting for " + description);
    await delay(10);
  }
}

describe("Swift listener microphone lifecycle", { skip: process.platform !== "darwin" || process.arch !== "arm64" }, () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "listener-lifecycle-"));
    writeFileSync(join(dir, "token"), "fixture");
    execFileSync("swiftc", ["-parse-as-library", "-module-cache-path", join(dir, "modules"),
      "native/voice-listener/Sources/VoiceListener/Listener.swift",
      "native/voice-listener/Tests/Fixtures/LifecycleDevices.swift", "-o", join(dir, "listener")]);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  async function launch(t: TestContext, { roster = [] as string[], inputDevice = "built-in", firstPostStatus = 200, firstPostCutoff = 0, firstPostHeld = false, repeatedHeld = false, slowLoad = false, held = false, microphone = "granted" } = {}) {
    const events: string[] = [];
    const diagnostics: string[] = [];
    const hellos: { modelLoaded: boolean; version: string; microphone: string }[] = [];
    const instanceIds = new Set<string | undefined>();
    const modelDir = slowLoad ? join(dir, "slow-load") : dir;
    if (slowLoad) mkdirSync(modelDir);
    const posted: { text: string; revision: string | null }[] = [];
    const heldAttempts: number[] = [];
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
        posted.push({ text: JSON.parse(body).text, revision: url.searchParams.get("revision") });
      }
      res.end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const child = spawn(join(dir, "listener"), [], { env: {
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
    apply(initial, "first", true);
    return { events, diagnostics, posted, child, closed, nextPoll, apply, hellos, instanceIds, heldAttempts };
  }

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

  it("finishes the outstanding loading heartbeat before publishing protocol 3.0 readiness", async (t) => {
    const { hellos } = await launch(t, { slowLoad: true });
    await until(() => hellos.length >= 3, "ready hello and delayed heartbeat");
    assert.deepEqual(hellos.map(h => h.modelLoaded), [false, false, true]);
    assert.ok(hellos.every(h => h.version === "3.0"));
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
    const { events, posted, nextPoll, apply } = await launch(t, { held: true });
    await until(() => events.includes("holding audio"), "held microphone");
    const release = await nextPoll("first");
    assert.deepEqual(posted, []);
    release.setHeader("x-voice-release-revision", "first");
    release.setHeader("x-voice-release-host-ms", "1000");
    apply(release, "off", false);
    await until(() => posted.length === 5, "complete phrases and tail");
    assert.deepEqual(posted, ["phrase 1", "phrase 2", "phrase 3", "phrase 4", "final phrase"].map(text => ({ text, revision: "first" })));
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
