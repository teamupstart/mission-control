import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

/** What the fake daemon does to the next request. */
let mode: "ok" | "down" | "500" | "400" | "404" | "429" | "418" = "ok";
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
        // A daemon that predates /api/usage/automation. Not a bad body - a stale peer.
        if (mode === "404") {
          res.writeHead(404).end();
          return;
        }
        // A rate limit from the daemon or something in front of it. Transient by nature.
        if (mode === "429") {
          res.writeHead(429).end();
          return;
        }
        // A status this code has never heard of, to prove the DEFAULT is to wait.
        if (mode === "418") {
          res.writeHead(418).end();
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

const {
  ForemanClient,
  flushPendingSpend,
  loadSpendOutbox,
  pendingSpendReports,
  quarantinedSpendReports,
  sweepSpendOutbox,
  spendOutboxTest,
} = await import("../src/server/foreman/client.ts");
const client = new ForemanClient();
const SPOOL = spendOutboxTest.path();
const DEAD_OWNER_PID = 2_147_483_647;

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

function orphanPath(id: string): string {
  return join(home, `foreman-spend-outbox.${id}.json`);
}

function storedSpool(ownerPid: number, entries: unknown[]): string {
  return JSON.stringify({ ownerPid, entries });
}

function spoolFiles(): string[] {
  return readdirSync(home)
    .filter((name) => name.startsWith("foreman-spend-outbox.") && name.endsWith(".json"))
    .map((name) => join(home, name));
}

function spoolRunIds(path: string): string[] {
  const stored = JSON.parse(readFileSync(path, "utf8")) as
    | Array<{ runId: string }>
    | { entries: Array<{ runId: string }> };
  return (Array.isArray(stored) ? stored : stored.entries).map((item) => item.runId);
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

function spawnAdopter(): Promise<void> {
  const clientUrl = new URL("../src/server/foreman/client.ts", import.meta.url).href;
  const script =
    `const { loadSpendOutbox } = await import(${JSON.stringify(clientUrl)});` +
    "loadSpendOutbox();";
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
      else reject(new Error(`adopter exited ${code ?? signal}: ${stderr}`));
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
  assert.equal(
    (JSON.parse(readFileSync(SPOOL, "utf8")) as { ownerPid: number }).ownerPid,
    process.pid,
  );
  assert.deepEqual(spoolRunIds(SPOOL), ["run-crash"]);

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
  const orphan = orphanPath("dead-worker");
  writeFileSync(
    orphan,
    storedSpool(DEAD_OWNER_PID, [report("inspector:review", "run-from-the-dead")]),
    "utf8",
  );
  const recovered = loadSpendOutbox();
  assert.equal(recovered, 1);
  assert.equal(pendingSpendReports(), 1);
  assert.equal(existsSync(SPOOL), true, "the adopting worker made its own durable copy");
  assert.equal(existsSync(orphan), false, "before removing the dead worker's copy");
});

test("the recovered report is delivered, and only then forgotten", async () => {
  await flushPendingSpend();
  assert.equal((received.at(-1) as { runId: string }).runId, "run-from-the-dead");
  assert.equal(pendingSpendReports(), 0);
  assert.equal(existsSync(SPOOL), false);
});

test("an unreadable or ownerless spool is left untouched", () => {
  const unreadable = orphanPath("corrupt");
  writeFileSync(unreadable, "{not json", "utf8");
  assert.equal(loadSpendOutbox(), 0);
  assert.equal(existsSync(unreadable), true);
  rmSync(unreadable);

  const invalid = orphanPath("invalid");
  writeFileSync(invalid, JSON.stringify({ entries: [{ role: "foreman:review" }] }), "utf8");
  assert.equal(loadSpendOutbox(), 0);
  assert.equal(existsSync(invalid), true);
  rmSync(invalid);
});

test("a live owner's spool is not adopted or changed", () => {
  const live = orphanPath("live-owner");
  const raw = storedSpool(process.pid, [report("foreman:review", "run-live-owner")]);
  writeFileSync(live, raw, "utf8");

  assert.equal(loadSpendOutbox(), 0);
  assert.equal(pendingSpendReports(), 0);
  assert.equal(existsSync(SPOOL), false);
  assert.equal(readFileSync(live, "utf8"), raw);
  rmSync(live);
});

test("a previous-build array is recovered without deleting an unprovable owner", async () => {
  const legacy = orphanPath("legacy-array");
  writeFileSync(legacy, JSON.stringify([report("foreman:review", "run-legacy-array")]), "utf8");

  assert.equal(loadSpendOutbox(), 1);
  assert.deepEqual(spoolRunIds(SPOOL), ["run-legacy-array"]);
  // Not deleted - a legacy array carries no owner pid, so a previous-build worker might
  // still be appending to it - but moved aside, so it is preserved rather than re-read.
  assert.equal(existsSync(legacy), false, "the migrated source is no longer at the scan path");
  const migrated = readdirSync(home).filter((n) => n.includes(".migrated-"));
  assert.equal(migrated.length, 1, "its bytes are kept under a name the scan does not match");

  rmSync(join(home, migrated[0]!), { force: true });
  await flushPendingSpend();
  assert.equal(existsSync(SPOOL), false);
});

test("a recovered legacy spool is delivered once, not on every sweep", async () => {
  // The loop this closes. Retaining the legacy file was harmless while adoption only ran at
  // startup; once a living worker sweeps periodically, leaving it in place means re-reading,
  // re-queueing and re-POSTing the same reports forever. The ledger de-duplicates by run id
  // so no row doubles, but the traffic and the repeated delivery logs are real and unbounded.
  assert.equal(pendingSpendReports(), 0, "this case starts from a drained queue");
  const legacy = orphanPath("legacy-replay");
  writeFileSync(legacy, JSON.stringify([report("foreman:review", "run-legacy-once")]), "utf8");

  sweepSpendOutbox();
  await eventually(() => received.some((r) => (r as { runId: string }).runId === "run-legacy-once"));
  const afterFirst = attempted.filter((id) => id === "run-legacy-once").length;

  // Two more sweeps with an empty queue - the exact condition that used to re-adopt it.
  sweepSpendOutbox();
  sweepSpendOutbox();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    attempted.filter((id) => id === "run-legacy-once").length,
    afterFirst,
    "no further delivery attempts were made for an already-migrated legacy spool",
  );
  assert.equal(pendingSpendReports(), 0);
  for (const n of readdirSync(home).filter((f) => f.includes(".migrated-"))) {
    rmSync(join(home, n), { force: true });
  }
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

test("an extended outage never sheds already-spent usage", async () => {
  assert.equal(pendingSpendReports(), 0, "this case starts from a drained queue");
  await stop();
  const expectedRunIds = Array.from({ length: 300 }, (_, index) => `run-unbounded-${index}`);
  const reports = expectedRunIds.map((runId) => report("foreman:review", runId));

  // A report is money already spent, not optional work waiting to run. Keeping every small
  // entry makes the outage buffer unbounded, but any capacity limit would turn a long daemon
  // outage into unrecoverable accounting loss, so durable growth is the correct tradeoff.
  for (const item of reports) await client.reportSpend(item);

  assert.equal(pendingSpendReports(), reports.length, "none were dropped past the old limit");
  assert.deepEqual(spoolRunIds(SPOOL), expectedRunIds, "every report remained in the spool");

  await start();
  await flushPendingSpend();
  assert.equal(pendingSpendReports(), 0);
  assert.equal(existsSync(SPOOL), false, "daemon acknowledgements healed the spool");
});

test("a 5xx holds the report; a 4xx quarantines it rather than blocking the queue", async () => {
  assert.equal(pendingSpendReports(), 0, "this case starts from a drained queue");
  const heldBefore = quarantinedSpendReports();
  mode = "500";
  await client.reportSpend(report("inspector:review", "run-3"));
  assert.equal(pendingSpendReports(), 1, "a daemon-side error is transient, so it is kept");

  // A 422 cannot be retried in place - this daemon will reject the same body forever, and
  // leaving it at the head would stall every later report. But it must not be DELETED: a
  // 4xx is also what a daemon too old for the route answers during a rolling upgrade, and
  // that run is already paid for. So it leaves the queue and is preserved instead.
  mode = "400";
  await flushPendingSpend();
  assert.equal(pendingSpendReports(), 0, "the unprocessable report did not stall the queue");
  assert.equal(
    quarantinedSpendReports(),
    heldBefore + 1,
    "and it was retained for recovery rather than discarded",
  );
  const held = JSON.parse(readFileSync(spendOutboxTest.quarantinePath(), "utf8")) as
    Array<{ status: number; report: { runId: string } }>;
  assert.equal(held.at(-1)?.report.runId, "run-3");
  assert.equal(held.at(-1)?.status, 422, "the rejecting status is kept so the cause is legible");

  mode = "ok";
  await client.reportSpend(report("inspector:reply", "run-4"));
  assert.equal(
    (received.at(-1) as { runId: string }).runId,
    "run-4",
    "and later reports still get through",
  );
});

test("a rejected report is never dropped when its quarantine cannot be written", async () => {
  // The ordering guarantee. The quarantine entry is made durable BEFORE the report leaves
  // the outbox, so there is no instant where the run exists in neither file. This proves the
  // half that is observable: when the quarantine write fails, the report stays queued rather
  // than being erased on the strength of a write that did not happen.
  assert.equal(pendingSpendReports(), 0, "this case starts from a drained queue");
  const quarantine = spendOutboxTest.quarantinePath();
  rmSync(quarantine, { force: true });
  // A directory where the file belongs: writeFileSync onto it fails, standing in for a full
  // disk or a permissions problem.
  mkdirSync(quarantine, { recursive: true });
  try {
    mode = "400";
    await client.reportSpend(report("foreman:verify", "run-unquarantinable"));
    assert.equal(
      pendingSpendReports(),
      1,
      "the run stayed queued rather than being deleted with nowhere to put it",
    );
    assert.deepEqual(spoolRunIds(SPOOL), ["run-unquarantinable"], "and it is still durable");
  } finally {
    rmSync(quarantine, { recursive: true, force: true });
  }

  // With the quarantine writable again the same report moves across cleanly, which is what
  // makes the stall recoverable rather than permanent.
  await flushPendingSpend();
  assert.equal(pendingSpendReports(), 0);
  assert.equal(existsSync(SPOOL), false);
  const held = JSON.parse(readFileSync(quarantine, "utf8")) as Array<{ report: { runId: string } }>;
  assert.equal(held.at(-1)?.report.runId, "run-unquarantinable");
  mode = "ok";
});

test("quarantining the same run twice does not duplicate it", () => {
  // Reachable in normal operation: the entry is written before the outbox drops it, so a
  // crash in that window replays the same report into the quarantine on the next attempt.
  const quarantine = spendOutboxTest.quarantinePath();
  const before = JSON.parse(readFileSync(quarantine, "utf8")) as unknown[];
  const runIds = before.map((e) => (e as { report: { runId: string } }).report.runId);
  assert.equal(
    new Set(runIds).size,
    runIds.length,
    "every quarantined run appears exactly once",
  );
});

test("an unreadable quarantine is preserved, not overwritten by the next rejection", async () => {
  // Every entry in that file is a rejected run that was already paid for. Replacing it to
  // make room for one new report would delete the whole history - the same
  // delete-before-preserve mistake as the outbox, one level further in. The unreadable bytes
  // have to survive somewhere a human can still find them.
  assert.equal(pendingSpendReports(), 0, "this case starts from a drained queue");
  const quarantine = spendOutboxTest.quarantinePath();
  rmSync(quarantine, { force: true });
  writeFileSync(quarantine, '[{"report":{"runId":"older-paid-run"}},{"trunc', "utf8");

  mode = "400";
  await client.reportSpend(report("foreman:review", "run-after-corruption"));
  mode = "ok";

  // The new report landed in a fresh file...
  const held = JSON.parse(readFileSync(quarantine, "utf8")) as Array<{ report: { runId: string } }>;
  assert.deepEqual(held.map((h) => h.report.runId), ["run-after-corruption"]);

  // ...and the damaged bytes are still on disk, verbatim, under a name nothing else writes.
  const preserved = readdirSync(home).filter((n) => n.includes(".unreadable-"));
  assert.equal(preserved.length, 1, "the unreadable quarantine was moved aside, not deleted");
  assert.match(
    readFileSync(join(home, preserved[0]!), "utf8"),
    /older-paid-run/,
    "and the earlier rejected run is still recoverable from it",
  );
  assert.equal(pendingSpendReports(), 0, "the new rejection still left the delivery queue");
  rmSync(join(home, preserved[0]!), { force: true });
});

test("a daemon with no such route holds the run and delivers it after the upgrade", async () => {
  // The rolling-upgrade case: this worker is newer than its daemon, so
  // /api/usage/automation does not exist and every report 404s. That is version skew, not a
  // bad body, and it is answered by upgrading the daemon - so the run WAITS rather than
  // being set aside.
  //
  // Quarantining it instead looked safe (nothing deleted) but was a one-way door: nothing
  // drains the quarantine automatically, so an upgrade seconds later still left the run
  // needing a human to reconstruct and resend it.
  assert.equal(pendingSpendReports(), 0, "this case starts from a drained queue");
  const heldBefore = quarantinedSpendReports();
  mode = "404";
  await client.reportSpend(report("foreman:backlog", "run-rolling-upgrade"));
  assert.equal(pendingSpendReports(), 1, "the run is still queued, waiting for the route");
  assert.equal(quarantinedSpendReports(), heldBefore, "and was NOT set aside for a human");
  assert.deepEqual(spoolRunIds(SPOOL), ["run-rolling-upgrade"], "and stayed durable meanwhile");

  // Blocking the queue behind it is harmless here and worth stating: a daemon with no route
  // is delivering nothing else either, so there is nothing to hold up.
  mode = "ok";
  await flushPendingSpend();
  assert.equal(
    (received.at(-1) as { runId: string }).runId,
    "run-rolling-upgrade",
    "once the daemon has the route, the held run lands by itself with no human involved",
  );
  assert.equal(pendingSpendReports(), 0);
  assert.equal(existsSync(SPOOL), false);
});

test("a peer that dies mid-outage is adopted by a worker that never restarts", async () => {
  // The gap startup-only adoption leaves. Worker B spools a report while the daemon is down
  // and exits; worker A stays up. Nothing ever restarts, so if adoption only happened at
  // boot, B's already-paid-for run would sit on disk indefinitely - on a machine whose
  // worker simply keeps running, that means forever.
  assert.equal(pendingSpendReports(), 0, "this case starts from a drained queue");
  await stop();
  writeFileSync(
    orphanPath("dead-peer-mid-outage"),
    storedSpool(DEAD_OWNER_PID, [report("foreman:verify", "run-from-dead-peer")]),
    "utf8",
  );

  // A is alive and has nothing of its own queued, so no retry is armed and no restart is
  // coming. The sweep is the only thing that can find this.
  await start();
  sweepSpendOutbox();
  await eventually(() => received.some((r) => (r as { runId: string }).runId === "run-from-dead-peer"));
  assert.equal(pendingSpendReports(), 0, "and it was delivered, not merely queued");
  assert.equal(
    existsSync(orphanPath("dead-peer-mid-outage")),
    false,
    "the adopted spool is removed once its report is acknowledged",
  );
});

test("a rate limit is waited out, not filed away as a bad report", async () => {
  // 429 and 408 are transient by definition - from the daemon or anything in front of it -
  // and the run behind them is already paid for. Quarantining them is a one-way door:
  // nothing drains that file, so the report would need a human once the limit cleared.
  assert.equal(pendingSpendReports(), 0, "this case starts from a drained queue");
  const heldBefore = quarantinedSpendReports();
  mode = "429";
  await client.reportSpend(report("foreman:triage", "run-rate-limited"));
  assert.equal(pendingSpendReports(), 1, "held for a retry");
  assert.equal(quarantinedSpendReports(), heldBefore, "and not set aside for a human");

  mode = "ok";
  await flushPendingSpend();
  assert.equal((received.at(-1) as { runId: string }).runId, "run-rate-limited");
  assert.equal(pendingSpendReports(), 0);
});

test("a status this code has never seen waits rather than being quarantined", async () => {
  // The reason quarantine is an allowlist rather than a fallback. Enumerating retryable
  // statuses puts everything nobody anticipated on the one-way path - which is exactly how
  // a transient 429 became permanent. Waiting on an unknown answer is recoverable; filing
  // it away is not.
  assert.equal(pendingSpendReports(), 0, "this case starts from a drained queue");
  const heldBefore = quarantinedSpendReports();
  mode = "418";
  await client.reportSpend(report("inspector:reply", "run-unknown-status"));
  assert.equal(pendingSpendReports(), 1, "an unrecognised status defaults to waiting");
  assert.equal(quarantinedSpendReports(), heldBefore);

  mode = "ok";
  await flushPendingSpend();
  assert.equal((received.at(-1) as { runId: string }).runId, "run-unknown-status");
  assert.equal(pendingSpendReports(), 0);
});

test("reports are delivered oldest-first, so the queue cannot reorder history", async () => {
  assert.equal(pendingSpendReports(), 0, "this case starts from a drained queue");
  await stop();
  await client.reportSpend(report("foreman:triage", "run-5"));
  await client.reportSpend(report("foreman:triage", "run-6"));
  assert.equal(pendingSpendReports(), 2);
  // The spool preserves order too - a restart mid-outage must not shuffle history.
  assert.deepEqual(spoolRunIds(SPOOL), ["run-5", "run-6"]);
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

test("each live worker writes only its own spool", async () => {
  assert.equal(pendingSpendReports(), 0, "this case starts from a drained queue");
  delayedRunId = "run-shared-ack";
  const acknowledgedWorker = spawnReporter("foreman:review", delayedRunId);
  await eventually(() => delayedResponse !== null);

  mode = "500";
  await spawnReporter("foreman:verify", "run-shared-pending");
  let files = spoolFiles();
  assert.equal(files.length, 2);
  assert.deepEqual(
    files.map(spoolRunIds).sort((a, b) => a[0]!.localeCompare(b[0]!)),
    [["run-shared-ack"], ["run-shared-pending"]],
  );

  mode = "ok";
  delayedRunId = null;
  delayedResponse!.writeHead(204).end();
  delayedResponse = null;
  await acknowledgedWorker;
  files = spoolFiles();
  assert.equal(files.length, 1);
  assert.deepEqual(spoolRunIds(files[0]!), ["run-shared-pending"]);

  assert.equal(loadSpendOutbox(), 1);
  await flushPendingSpend();
  assert.deepEqual(spoolFiles(), []);
});

test("orphan adoption de-duplicates run ids into this worker's spool", async () => {
  assert.equal(pendingSpendReports(), 0, "this case starts from a drained queue");
  const first = orphanPath("dedup-first");
  const second = orphanPath("dedup-second");
  writeFileSync(
    first,
    storedSpool(DEAD_OWNER_PID, [
      report("foreman:review", "run-adopt-a"),
      report("foreman:verify", "run-adopt-shared"),
    ]),
    "utf8",
  );
  writeFileSync(
    second,
    storedSpool(DEAD_OWNER_PID, [
      report("foreman:verify", "run-adopt-shared"),
      report("inspector:review", "run-adopt-b"),
    ]),
    "utf8",
  );
  assert.equal(loadSpendOutbox(), 3);
  assert.deepEqual(spoolRunIds(SPOOL), ["run-adopt-a", "run-adopt-shared", "run-adopt-b"]);
  assert.equal(existsSync(first), false);
  assert.equal(existsSync(second), false);

  await flushPendingSpend();
  assert.equal(existsSync(SPOOL), false);
});

test("an orphan remains untouched until the adopter's spool is durable", async () => {
  assert.equal(pendingSpendReports(), 0, "this case starts from a drained queue");
  const orphan = orphanPath("persist-first");
  const raw = storedSpool(DEAD_OWNER_PID, [report("foreman:review", "run-persist-first")]);
  writeFileSync(orphan, raw, "utf8");
  const blockedTmp = `${SPOOL}.${process.pid}.tmp`;
  mkdirSync(blockedTmp);

  assert.equal(loadSpendOutbox(), 1);
  assert.equal(readFileSync(orphan, "utf8"), raw, "the source was neither changed nor removed");
  assert.equal(existsSync(SPOOL), false);

  rmSync(blockedTmp, { recursive: true });
  assert.equal(loadSpendOutbox(), 1, "the repeated adoption de-duplicated the run id");
  assert.equal(existsSync(orphan), false);
  assert.deepEqual(spoolRunIds(SPOOL), ["run-persist-first"]);

  await flushPendingSpend();
  assert.equal(existsSync(SPOOL), false);
});

test("two adopters of one orphan cannot lose its report", async () => {
  assert.equal(pendingSpendReports(), 0, "this case starts from a drained queue");
  const orphan = orphanPath("two-adopters");
  writeFileSync(
    orphan,
    storedSpool(DEAD_OWNER_PID, [report("foreman:review", "run-two-adopters")]),
    "utf8",
  );

  await Promise.all([spawnAdopter(), spawnAdopter()]);
  const durableRunIds = spoolFiles().flatMap(spoolRunIds);
  assert.deepEqual(
    [...new Set(durableRunIds)],
    ["run-two-adopters"],
    "at least one per-worker copy survived concurrent adoption",
  );

  assert.equal(loadSpendOutbox(), 1);
  assert.deepEqual(spoolRunIds(SPOOL), ["run-two-adopters"]);
  await flushPendingSpend();
  assert.deepEqual(spoolFiles(), []);
});
