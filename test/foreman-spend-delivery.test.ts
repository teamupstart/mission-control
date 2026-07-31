import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server, ServerResponse } from "node:http";

// What is at stake: a headless run's cost exists exactly once, and only for as long as it
// takes to deliver it.
//
// By the time the worker reports, the tokens are spent and the review is answered. There is
// no retryable unit of work behind a failed report - dropping one does not skip work, it
// deletes a number nothing can reconstruct. And the failure is routine rather than exotic:
// the daemon restarts while the Foreman worker, which is a separate process, keeps running.
// A single POST that logged its own failure would lose spend on the most ordinary event in
// the system.

// Set BEFORE the client is imported: `BASE_URL` is resolved at module load from
// `envVar("PORT")`, which reads MISSION_/FLEET_/HARNESS_ prefixes. Getting this wrong would
// not fail the test - it would quietly POST test rows into the REAL daemon's ledger on 7317.
const PORT = 7391;
process.env.MISSION_PORT = String(PORT);
// Same reasoning for the spool: `stateDir()` honours MISSION_HOME, and without an override
// these tests would write their outbox into the real install's state dir.
const home = mkdtempSync(join(tmpdir(), "foreman-spend-"));
process.env.MISSION_HOME = home;
const SPOOL = join(home, "foreman-spend-outbox.json");

/** What the fake daemon does to the next request. */
let mode: "ok" | "down" | "500" | "400" = "ok";
const received: Array<Record<string, unknown>> = [];
const attempted: string[] = [];
let delayedRunId: string | null = null;
let delayedResponse: ServerResponse | null = null;

let server: Server | null = null;

function start(): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const report = JSON.parse(body) as Record<string, unknown>;
        attempted.push(String(report.runId));
        if (report.runId === delayedRunId) {
          delayedResponse = res;
          return;
        }
        if (mode === "500") {
          res.writeHead(503).end();
          return;
        }
        if (mode === "400") {
          res.writeHead(422).end();
          return;
        }
        received.push(report);
        res.writeHead(204).end();
      });
    });
    server.listen(PORT, "127.0.0.1", () => resolve());
  });
}

function stop(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
    server = null;
  });
}

await start();

const { ForemanClient, flushPendingSpend, loadSpendOutbox, pendingSpendReports } = await import(
  "../src/server/foreman/client.ts"
);
const client = new ForemanClient();

after(async () => {
  await stop();
  rmSync(home, { recursive: true, force: true });
});

function report(role: string, runId: string) {
  return {
    role,
    runner: "codex",
    runId,
    ts: 1_700_000_000_000,
    models: [{
      modelId: "gpt-5.6-terra",
      input: 100,
      output: 10,
      reasoningOutput: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reportedCostUsd: null,
    }],
  } as never;
}

async function eventually(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition did not become true before timeout");
}

function spawnReporter(role: string, runId: string): Promise<void> {
  const clientUrl = new URL("../src/server/foreman/client.ts", import.meta.url).href;
  const script =
    `const { ForemanClient } = await import(${JSON.stringify(clientUrl)});` +
    `await new ForemanClient().reportSpend(${JSON.stringify(report(role, runId))});`;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    {
      env: { ...process.env, MISSION_HOME: home, MISSION_PORT: String(PORT) },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`reporter exited ${code ?? signal}: ${stderr}`));
    });
  });
}

test("a report reaches the daemon and leaves nothing queued or spooled", async () => {
  await client.reportSpend(report("foreman:review", "run-1"));
  assert.equal(received.length, 1);
  assert.equal(pendingSpendReports(), 0);
  // No spool file at rest: "nothing pending" is the absence of one, not an empty array
  // somebody has to parse to find out.
  assert.equal(existsSync(SPOOL), false);
});

test("an undelivered report is written to disk, not just held in memory", async () => {
  // The hole this closes: the run is finished and paid for, the daemon is down, and the
  // worker is then killed. Held only in memory, that spend was gone for good -
  // unrecoverable, because nothing else on the machine knows the run ever happened.
  await stop();
  await client.reportSpend(report("foreman:review", "run-crash"));
  const spooled = JSON.parse(readFileSync(SPOOL, "utf8")) as Array<{ runId: string }>;
  assert.deepEqual(spooled.map((r) => r.runId), ["run-crash"]);

  // Deliver it so the shared queue is clean for the tests below.
  await start();
  await flushPendingSpend();
  assert.equal(existsSync(SPOOL), false, "and the spool is erased once it is acknowledged");
  assert.equal((received.at(-1) as { runId: string }).runId, "run-crash");
});

test("a report left by a dead worker is recovered by the next one", () => {
  // A worker that never got the chance to flush. The spool is all that is left of the run,
  // and startup is the moment it either reaches the ledger or is lost - so `loadSpendOutbox`
  // is what makes the durability real rather than merely written down.
  writeFileSync(SPOOL, JSON.stringify([report("inspector:review", "run-from-the-dead")]), "utf8");
  const recovered = loadSpendOutbox();
  assert.equal(recovered, 1);
  assert.equal(pendingSpendReports(), 1);
});

test("the recovered report is delivered, and only then forgotten", async () => {
  await flushPendingSpend();
  assert.equal((received.at(-1) as { runId: string }).runId, "run-from-the-dead");
  assert.equal(pendingSpendReports(), 0);
  assert.equal(existsSync(SPOOL), false);
});

test("a corrupt spool is discarded rather than replayed forever", () => {
  writeFileSync(SPOOL, "{not json", "utf8");
  assert.equal(loadSpendOutbox(), 0);
  assert.equal(existsSync(SPOOL), false);
  // Entries that parse but are not reports are dropped for the same reason: feeding them
  // to the route would 4xx on every restart instead of once.
  writeFileSync(SPOOL, JSON.stringify([{ role: "foreman:review" }]), "utf8");
  assert.equal(loadSpendOutbox(), 0);
});

test("spend survives the daemon being down, and lands when it returns", async () => {
  // The case the outbox exists for. The daemon is restarting; the run already happened.
  // Counted relative to what has already arrived, so this asserts about its own report
  // rather than about how many tests ran before it.
  const before = received.length;
  await stop();
  await client.reportSpend(report("foreman:verify", "run-2"));
  assert.equal(pendingSpendReports(), 1, "held rather than discarded");
  assert.equal(received.length, before, "and not delivered while nothing was listening");

  // The daemon comes back. Nothing about the run is recoverable from anywhere else, so
  // this is the only path by which its cost ever reaches the ledger.
  await start();
  await flushPendingSpend();
  assert.equal(pendingSpendReports(), 0);
  assert.equal(received.length, before + 1);
  assert.equal((received.at(-1) as { runId: string }).runId, "run-2");
});

test("a 5xx holds the report; a 4xx drops it rather than blocking the queue", async () => {
  assert.equal(pendingSpendReports(), 0, "this case starts from a drained queue");
  mode = "500";
  await client.reportSpend(report("inspector:review", "run-3"));
  assert.equal(pendingSpendReports(), 1, "a daemon-side error is transient, so it is kept");

  // A 422 means this body will never validate - a worker newer than its daemon, say.
  // Retrying it forever would wedge every later report behind it, so it is dropped loudly.
  mode = "400";
  await flushPendingSpend();
  assert.equal(pendingSpendReports(), 0, "the unprocessable report did not stall the queue");

  mode = "ok";
  await client.reportSpend(report("inspector:reply", "run-4"));
  assert.equal(
    (received.at(-1) as { runId: string }).runId,
    "run-4",
    "and later reports still get through",
  );
});

test("reports are delivered oldest-first, so the queue cannot reorder history", async () => {
  assert.equal(pendingSpendReports(), 0, "this case starts from a drained queue");
  await stop();
  await client.reportSpend(report("foreman:triage", "run-5"));
  await client.reportSpend(report("foreman:triage", "run-6"));
  assert.equal(pendingSpendReports(), 2);
  // The spool preserves order too - a restart mid-outage must not shuffle history.
  const spooled = JSON.parse(readFileSync(SPOOL, "utf8")) as Array<{ runId: string }>;
  assert.deepEqual(spooled.map((r) => r.runId), ["run-5", "run-6"]);
  await start();
  await flushPendingSpend();
  assert.deepEqual(
    received.slice(-2).map((r) => (r as { runId: string }).runId),
    ["run-5", "run-6"],
  );
});

test("a new report joins an armed delivery backoff without posting immediately", async () => {
  assert.equal(pendingSpendReports(), 0, "this case starts from a drained queue");
  mode = "500";
  const before = attempted.length;
  await client.reportSpend(report("foreman:review", "run-backoff-1"));
  assert.equal(attempted.length, before + 1, "the first failure armed the retry");

  await client.reportSpend(report("foreman:verify", "run-backoff-2"));
  assert.equal(attempted.length, before + 1, "the new report did not bypass the backoff");

  mode = "ok";
  await flushPendingSpend();
  assert.equal(pendingSpendReports(), 0);
  assert.deepEqual(
    received.slice(-2).map((item) => item.runId),
    ["run-backoff-1", "run-backoff-2"],
  );
});

test("one worker's acknowledgement cannot erase another worker's pending report", async () => {
  assert.equal(pendingSpendReports(), 0, "this case starts from a drained queue");
  delayedRunId = "run-shared-ack";
  const acknowledgedWorker = spawnReporter("foreman:review", delayedRunId);
  await eventually(() => delayedResponse !== null);

  mode = "500";
  await spawnReporter("foreman:verify", "run-shared-pending");
  let spooled = JSON.parse(readFileSync(SPOOL, "utf8")) as Array<{ runId: string }>;
  assert.deepEqual(spooled.map((item) => item.runId), ["run-shared-ack", "run-shared-pending"]);

  mode = "ok";
  delayedRunId = null;
  delayedResponse!.writeHead(204).end();
  delayedResponse = null;
  await acknowledgedWorker;
  spooled = JSON.parse(readFileSync(SPOOL, "utf8")) as Array<{ runId: string }>;
  assert.deepEqual(spooled.map((item) => item.runId), ["run-shared-pending"]);

  assert.equal(loadSpendOutbox(), 1);
  await flushPendingSpend();
  assert.equal(existsSync(SPOOL), false);
});
