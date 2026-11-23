import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { describe, it, before, after, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

async function until(condition: () => boolean, description: string) {
  const deadline = Date.now() + 5000;
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

  async function launch(t: TestContext, { roster = [] as string[], inputDevice = "built-in", firstPostStatus = 200 } = {}) {
    const events: string[] = [];
    const posted: { text: string; revision: string | null }[] = [];
    const polls: { revision: string | null; response: ServerResponse }[] = [];
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, "http://localhost");
      if (url.pathname === "/voice/listener/directive") {
        polls.push({ revision: url.searchParams.get("revision"), response: res });
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      if (req.method === "POST" && url.pathname === "/voice/utterances") {
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
      ...process.env, MISSION_VOICE_DAEMON_URL: "http://127.0.0.1:" + address.port,
      MISSION_VOICE_TOKEN_FILE: join(dir, "token"), MISSION_VOICE_MODEL_DIR: dir,
    } });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => events.push(line));
    const closed = once(child, "close");
    t.after(async () => {
      child.kill();
      await closed;
      lines.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    async function nextPoll(revision: string | null) {
      await until(() => polls.length > 0, "directive poll after " + revision);
      const poll = polls.shift()!;
      assert.equal(poll.revision, revision);
      return poll.response;
    }
    function apply(response: ServerResponse, revision: string, capture: boolean, names: string[] = roster) {
      response.end(JSON.stringify({ revision, capture, inputDevice, roster: names }));
    }
    apply(await nextPoll(null), "first", true);
    return { events, posted, child, closed, nextPoll, apply };
  }

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

  it("delivers the next segment on the same active microphone after a transcription failure", async (t) => {
    const { events, posted, child } = await launch(t, { inputDevice: "two-segments" });
    await until(() => events.includes("released next"), "second segment to finish");
    assert.deepEqual(events.filter(e => e.startsWith("decode ")), ["decode undecodable", "decode next"]);
    assert.deepEqual(posted, [{ text: "next", revision: "first" }]);
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
