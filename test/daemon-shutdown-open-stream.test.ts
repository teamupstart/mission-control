import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer, get, type IncomingMessage } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { ensureNativeStateLockAddon } from "./helpers/native-state-lock.ts";
import { closeHttpServer, OpenEndedRequests } from "../src/server/http-shutdown.ts";

const root = mkdtempSync(join(tmpdir(), "mission-daemon-shutdown-"));
const repo = fileURLToPath(new URL("..", import.meta.url));
const children = new Set<ChildProcess>();
// A source-loaded daemon can wait behind the full suite's workers before it listens.
const CHILD_START_TIMEOUT_MS = 60_000;

ensureNativeStateLockAddon();

after(async () => {
  for (const child of children) child.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
});

async function unusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  server.close();
  await once(server, "close");
  return port;
}

/** Open a GET and resolve once its response headers arrive; the body is left streaming. */
function openResponse(url: string): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = get(url, resolve);
    req.on("error", reject);
  });
}

async function listening(handler: Parameters<typeof createHttpServer>[1]): Promise<{ server: ReturnType<typeof createHttpServer>; base: string }> {
  const server = createHttpServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/**
 * Resolves once the server's handler has run for each of `urls`.
 *
 * A fixed delay before closing is a race on a loaded machine: a connection the server has
 * accepted but whose request it has not yet parsed counts as idle, `server.close()` closes it,
 * and the client sees ECONNRESET for a request the test meant to be in flight.
 */
function arrivals(urls: readonly string[]): { seen: (url: string | undefined) => void; all: Promise<void> } {
  const waiting = new Set(urls);
  let done!: () => void;
  const all = new Promise<void>((resolve) => {
    done = resolve;
  });
  return {
    seen: (url) => {
      if (url !== undefined) waiting.delete(url);
      if (waiting.size === 0) done();
    },
    all,
  };
}

async function bodyOf(res: Promise<IncomingMessage>): Promise<string> {
  let body = "";
  for await (const chunk of await res) body += String(chunk);
  return body;
}

test("closeHttpServer ends registered streams at once and gives a slower request the grace", async () => {
  const openEnded = new OpenEndedRequests();
  const arrived = arrivals(["/stream", "/slow"]);
  const { server, base } = await listening((req, res) => {
    arrived.seen(req.url);
    if (req.url === "/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": open\n\n");
      // Like the daemon's /events: it ends only when told to.
      const release = openEnded.add(() => res.end());
      res.on("close", release);
      return;
    }
    // Longer than the old one-second cutoff, inside the grace.
    setTimeout(() => res.end("done"), 1_500);
  });

  const stream = bodyOf(openResponse(`${base}/stream`));
  const slow = bodyOf(openResponse(`${base}/slow`));
  // Both requests are in the server's hands before shutdown starts, not merely sent.
  await arrived.all;

  const started = Date.now();
  const result = await closeHttpServer(server, { graceMs: 5_000, openEnded });
  const elapsed = Date.now() - started;

  assert.equal(result.forced, false, "nothing should have needed cutting");
  assert.equal(await stream, ": open\n\n", "the stream ended as a completed response");
  assert.equal(await slow, "done", "a request still running after one second was cut");
  assert.ok(elapsed >= 1_300 && elapsed < 4_000, `closed in ${elapsed}ms`);
});

test("closeHttpServer cuts an unregistered never-ending stream after the grace and lets a short request finish", async () => {
  const arrived = arrivals(["/stream", "/short"]);
  const { server, base } = await listening((req, res) => {
    arrived.seen(req.url);
    if (req.url === "/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": open\n\n");
      return; // never ends and never registered
    }
    setTimeout(() => res.end("done"), 100);
  });

  const stream = await openResponse(`${base}/stream`);
  stream.on("error", () => {});
  const shortRequest = bodyOf(openResponse(`${base}/short`));
  await arrived.all;

  const started = Date.now();
  const result = await closeHttpServer(server, { graceMs: 300, openEnded: new OpenEndedRequests() });
  const elapsed = Date.now() - started;

  assert.equal(result.forced, true);
  assert.ok(elapsed >= 250 && elapsed < 2_000, `closed in ${elapsed}ms`);
  assert.equal(await shortRequest, "done");
});

test("closeHttpServer does not wait out the grace when nothing is open", async () => {
  const { server } = await listening((_req, res) => res.end("ok"));

  const started = Date.now();
  const result = await closeHttpServer(server, { graceMs: 5_000, openEnded: new OpenEndedRequests() });

  assert.equal(result.forced, false);
  assert.ok(Date.now() - started < 1_000);
});

test("closeHttpServer propagates the error server.close reports", async () => {
  const server = createHttpServer(); // never listened, so close reports ERR_SERVER_NOT_RUNNING
  await assert.rejects(
    closeHttpServer(server, { graceMs: 5_000, openEnded: new OpenEndedRequests() }),
    { code: "ERR_SERVER_NOT_RUNNING" },
  );
});

test("an open-ended request that starts after shutdown began is ended at once, and a released one is not ended", () => {
  const openEnded = new OpenEndedRequests();
  let released = 0;
  const release = openEnded.add(() => released++);
  release();
  let kept = 0;
  openEnded.add(() => kept++);
  openEnded.endAll();
  assert.equal(released, 0, "a request that already finished was ended again");
  assert.equal(kept, 1);

  let late = 0;
  openEnded.add(() => late++);
  assert.equal(late, 1, "a request arriving during shutdown was left open");
});

test("one request failing to end does not keep the others open", () => {
  const openEnded = new OpenEndedRequests();
  const ended: string[] = [];
  openEnded.add(() => ended.push("before"));
  openEnded.add(() => {
    throw new Error("this stream could not be ended");
  });
  openEnded.add(() => ended.push("after"));
  assert.doesNotThrow(() => openEnded.endAll());
  assert.deepEqual(ended, ["before", "after"]);
});

test("the daemon exits promptly on SIGTERM while a dashboard event stream is open", async () => {
  const home = join(root, "home");
  const port = await unusedPort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MISSION_HOME: home,
    MISSION_PORT: String(port),
    MISSION_POLL_MS: "0",
    MISSION_SCOUT_RECONCILE_MS: "0",
  };
  delete env.NODE_TEST_CONTEXT;
  delete env.MISSION_TEST_STATE;
  delete env.FLEET_HOME;
  delete env.HARNESS_HOME;
  const child = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
    cwd: repo,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let output = "";
  child.stdout?.on("data", (chunk) => (output += String(chunk)));
  child.stderr?.on("data", (chunk) => (output += String(chunk)));
  const exited = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;

  const deadline = Date.now() + CHILD_START_TIMEOUT_MS;
  while (!output.includes("[mission-control] listening on")) {
    if (child.exitCode !== null) assert.fail(`daemon exited before listening\n${output}`);
    if (Date.now() > deadline) assert.fail(`daemon did not listen\n${output}`);
    await delay(25);
  }

  const events = await openResponse(`http://127.0.0.1:${port}/events`);
  assert.equal(events.statusCode, 200);
  events.on("error", () => {});
  events.resume();

  const started = Date.now();
  child.kill("SIGTERM");
  const outcome = await Promise.race([exited, delay(15_000).then(() => "still running" as const)]);
  const elapsed = Date.now() - started;

  // Before the bounded close, this daemon never exited while the stream stayed open.
  assert.notEqual(outcome, "still running", `daemon still running ${elapsed}ms after SIGTERM\n${output}`);
  assert.deepEqual(outcome, [0, null], output);
  // Ended cooperatively: nothing had to wait out the grace or be cut.
  assert.match(output, /\[mission-control\] shutdown finished in \d+ms\n/);
  assert.doesNotMatch(output, /requests still open after/);
  assert.ok(elapsed < 5_000, `daemon took ${elapsed}ms to exit`);
  children.delete(child);
});
