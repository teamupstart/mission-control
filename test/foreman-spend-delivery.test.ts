import { after, afterEach, test } from "node:test";
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
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server, ServerResponse } from "node:http";
import type {
  ClaudeSdkMessage,
  ClaudeSdkOneShotDeps,
} from "../src/server/harness/claude/sdk-types.ts";
import type { LlmSpendReport } from "../src/shared/llm-spend.ts";

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
let mode: "ok" | "down" | "500" | "400" | "404" | "429" | "418" | "413" = "ok";
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
        // A payload limit. Plausibly a proxy's rather than the daemon's, so not a verdict.
        if (mode === "413") {
          res.writeHead(413).end();
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
const { claudeRunner, configureClaudeRunnerTransport } = await import("../src/server/llm/claude.ts");
const { setLlmSpendSink } = await import("../src/server/llm/spend.ts");
const { recordSpendReport } = await import("../src/server/spend-ledger.ts");
const { openDb } = await import("../src/server/db.ts");
const SPOOL = spendOutboxTest.path();
const DEAD_OWNER_PID = 2_147_483_647;

after(async () => {
  await stop();
  rmSync(home, { recursive: true, force: true });
});

/**
 * Release anything the fake daemon is holding, whatever the test did or failed to do.
 *
 * `delayedRunId` and `delayedResponse` are module state that several cases park a request
 * on and then release by hand. That is fine on the happy path and a trap on any other: a
 * case that throws between the two leaves the flag set, so the NEXT test's report is parked
 * as well - it fails claiming a run it never queued - and leaves a spawned reporter blocked
 * on a response nobody will ever write, which is a child process that never exits and a file
 * that never finishes.
 *
 * Neither of those is a real defect in the code under test, and both were reported as one.
 * Resetting here costs nothing on a passing case - every one of them has already cleared
 * both - and confines a failure to the test that had it.
 */
afterEach(async () => {
  delayedRunId = null;
  delayedResponse?.writeHead(204).end();
  delayedResponse = null;
  // And the spools a spawned reporter left on disk, for the same reason. Every case here
  // opens on a drained queue - several say so in an assertion - but a case that throws
  // part-way leaves its child's per-worker file behind, and the next `loadSpendOutbox`
  // ADOPTS it. The report then surfaces as a run the following test never queued, which
  // reports the wrong test as broken. This process's own spool is left alone: it is the
  // thing under test, and the drained-queue assertions are what police it.
  // Then wait for any child the case left running. Released first, deliberately: a reporter
  // parked on the response above cannot exit until it gets one, so awaiting before releasing
  // would trade a poisoned next test for a hung file.
  await Promise.allSettled([...liveChildren]);
  for (const path of spoolFiles()) if (path !== SPOOL) rmSync(path, { force: true });
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

/**
 * The budget for a wait whose condition depends on a SPAWNED reporter reaching the server.
 *
 * The condition here needs a `node --import tsx` child to boot, compile TypeScript and
 * complete an HTTP POST, which is around a second on an idle machine and several under
 * `npm test`, where two test files run concurrently and every other one is spawning
 * something too.
 *
 * It flaked for exactly that reason, and the flake was expensive out of proportion to
 * itself: the case that timed out here left `delayedRunId` set and a child parked on a
 * response that was never written, so the two tests after it inherited a report they never
 * queued and the FILE then hung until the runner's own timeout - forty-five minutes of a
 * local `npm test` producing nothing. `afterEach` below closes the second half of that; this
 * closes the first.
 *
 * Generous rather than tuned, because the cost is asymmetric: a long ceiling costs nothing
 * on a machine that is keeping up (the poll returns as soon as the condition holds), while a
 * short one buys nothing and fails a test that was going to pass.
 */
const SPAWN_WAIT_MS = 30_000;

/**
 * The default budget for an in-process wait - no spawn, no compile, nothing off-box.
 *
 * Two seconds was the original default on the theory that a flush here is a tick away, and
 * on an idle machine it is. It is not on a shared CI runner: `test-concurrency=2` keeps
 * another file's HTTP servers, retries and spawned children busy on the same event loop and
 * the same CPU, and this file's own drained-queue assertions mean one slow poll fails not
 * just its own case but every case after it, cascading down the file. `eventually` at
 * `test/foreman-spend-delivery.test.ts:645` timed out at exactly this default under CI load
 * with nothing wrong in the code it was testing - the delivery landed, `received` just took
 * longer than 2 seconds to say so. Same reasoning as `SPAWN_WAIT_MS` above: generous costs
 * nothing when the condition is already true, and 2 seconds bought nothing here but a false
 * failure.
 */
const IN_PROCESS_WAIT_MS = 10_000;

async function eventually(check: () => boolean, timeoutMs = IN_PROCESS_WAIT_MS): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition did not become true before timeout");
}

/**
 * Every spawned child still running, so a case cannot leak one into the next.
 *
 * A reporter writes its spool BEFORE it attempts delivery - durability first - and removes
 * it on a 204. So a child still in flight is a spool file on disk, and the next case's
 * `spoolFiles()` reads it as a report that case never queued. Deleting the file instead of
 * waiting loses the race: the child writes it again a moment later.
 */
const liveChildren = new Set<Promise<void>>();

/** Register a spawn so `afterEach` can wait for it however the case ends. */
function tracked(work: Promise<void>): Promise<void> {
  liveChildren.add(work);
  // Attached rather than chained onto the returned promise, so a caller that awaits this
  // still sees the rejection and a caller that abandons it does not raise an unhandled one.
  void work.catch(() => {}).finally(() => liveChildren.delete(work));
  return work;
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
  return tracked(
    new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`reporter exited ${code ?? signal}: ${stderr}`));
      });
    }),
  );
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
  return tracked(
    new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`adopter exited ${code ?? signal}: ${stderr}`));
      });
    }),
  );
}

test("a report reaches the daemon and leaves nothing queued or spooled", async () => {
  await client.reportSpend(report("foreman:review", "run-1"));
  assert.equal(received.length, 1);
  assert.equal(pendingSpendReports(), 0);
  // No spool file at rest: "nothing pending" is the absence of one, not an empty array
  // somebody has to parse to find out.
  assert.equal(existsSync(SPOOL), false);
});

test("an SDK Foreman run keeps its identity and usage through the HTTP outbox", async () => {
  const runId = "foreman-sdk-outbox";
  const modelId = "claude-haiku-4-5-20251001";
  const frame: ClaudeSdkMessage = {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "routed",
    session_id: runId,
    total_cost_usd: 0.013531,
    usage: {
      input_tokens: 9,
      cache_creation_input_tokens: 6_661,
      cache_read_input_tokens: 0,
      output_tokens: 40,
    },
    modelUsage: {
      [modelId]: {
        inputTokens: 9,
        outputTokens: 40,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 6_661,
        costUSD: 0.013531,
        canonicalModel: "claude-haiku-4-5",
      },
    },
  };
  const deps: ClaudeSdkOneShotDeps = {
    executable: async () => "/fake/bin/claude",
    env: () => ({ PATH: "/usr/bin" }),
    query: async () => ({
      async *[Symbol.asyncIterator]() {
        yield frame;
      },
    }),
  };
  const restoreTransport = configureClaudeRunnerTransport(() => "sdk", deps);
  const previousSink = setLlmSpendSink((item) => void client.reportSpend(item));
  try {
    assert.equal(
      await claudeRunner.run("route this prompt", {
        model: "claude-haiku-4-5",
        role: "foreman:triage",
      }),
      "routed",
    );
    // Both ends, for the reason the dead-peer case below spells out: the fields asserted
    // next are the SERVER's copy, but the drained queue and the removed spool asserted after
    // them are the CLIENT's, and the harness records receipt before it writes the 204 that
    // produces either. One wait covering both keeps every claim and races none of them.
    await eventually(
      () =>
        received.some((item) => item.runId === runId) &&
        pendingSpendReports() === 0 &&
        !existsSync(SPOOL),
    );

    const delivered = received.find((item) => item.runId === runId) as unknown as LlmSpendReport;
    assert.equal(delivered.role, "foreman:triage");
    assert.equal(delivered.runner, "claude");
    assert.equal(delivered.runId, runId);
    assert.deepEqual(delivered.models, [{
      modelId,
      input: 9,
      output: 40,
      reasoningOutput: 0,
      cacheRead: 0,
      cacheWrite: 6_661,
      reportedCostUsd: 0.013531,
    }]);
    assert.equal(pendingSpendReports(), 0);
    assert.equal(existsSync(SPOOL), false);

    // The worker only delivered tokens and provider cost. The daemon's existing writer is
    // still the component that values and records the row, exactly as it does for print.
    assert.deepEqual(recordSpendReport(delivered), { kind: "recorded" });
    const row = openDb()
      .prepare(
        `SELECT note_key, agent, window_end_ns, cost_usd, cost_basis, spend_kind
           FROM usage_ledger WHERE window_end_ns = ?`,
      )
      .get(runId) as {
        note_key: string;
        agent: string;
        window_end_ns: string;
        cost_usd: number;
        cost_basis: string;
        spend_kind: string;
      };
    assert.deepEqual({ ...row }, {
      note_key: "foreman:triage",
      agent: "claude",
      window_end_ns: runId,
      cost_usd: 0.013531,
      cost_basis: "reported",
      spend_kind: "automation",
    });
  } finally {
    setLlmSpendSink(previousSink);
    restoreTransport();
  }
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

test("one malformed entry does not cost the whole spool its valid ones", () => {
  // The file parses as JSON and names a dead owner, so it looks adoptable - but one entry is
  // not a spend report. Filtering it away and then deleting the source, which is what this
  // used to do, discarded an already-paid-for run with nothing left to recover it from. A
  // partial hand edit or a schema change is enough to produce this.
  const path = orphanPath("partly-malformed");
  writeFileSync(
    path,
    storedSpool(DEAD_OWNER_PID, [
      report("foreman:review", "run-valid-neighbour"),
      { role: "foreman:review", runner: "codex", runId: "run-half-written" }, // no ts, no models
    ]),
    "utf8",
  );

  const queuedBefore = pendingSpendReports();
  assert.equal(loadSpendOutbox(), queuedBefore, "nothing was adopted from it");
  assert.equal(existsSync(path), true, "and the file is still there, in full");
  const stored = JSON.parse(readFileSync(path, "utf8")) as { entries: Array<{ runId: string }> };
  assert.deepEqual(
    stored.entries.map((e) => e.runId),
    ["run-valid-neighbour", "run-half-written"],
    "both the valid and the malformed entry survive for a human to sort out",
  );
  rmSync(path, { force: true });
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
  // The fixed window is right for the NEGATIVE claim below - "no further attempt happened"
  // can only be checked by giving one a chance to. The positive claim is waited on instead,
  // for the reason the dead-peer case above spells out: `received` is pushed before the 204
  // that drains the queue, so 50ms is a guess about a round trip rather than a fact about it.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    attempted.filter((id) => id === "run-legacy-once").length,
    afterFirst,
    "no further delivery attempts were made for an already-migrated legacy spool",
  );
  await eventually(() => pendingSpendReports() === 0);
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
  // Waited on the CLIENT's end state, not the server's receipt, and the difference is a
  // whole round trip. The harness pushes to `received` and only THEN writes the 204, while
  // the queue drains and the spool is unlinked when the reporter processes that response -
  // so asserting the drain straight after the push asserts something that provably has not
  // happened yet. On an idle machine the 10ms poll granularity hides it; on a loaded runner
  // it does not, and because every later case in this file opens with "starts from a drained
  // queue", the one report left behind fails all thirteen of them (node 26, run
  // 31531047778). Reproduced deterministically by delaying the harness's 204 by 50ms.
  await eventually(
    () =>
      received.some((r) => (r as { runId: string }).runId === "run-from-dead-peer") &&
      pendingSpendReports() === 0 &&
      !existsSync(orphanPath("dead-peer-mid-outage")),
  );
  assert.equal(pendingSpendReports(), 0, "and it was delivered, not merely queued");
  assert.equal(
    existsSync(orphanPath("dead-peer-mid-outage")),
    false,
    "the adopted spool is removed once its report is acknowledged",
  );
});

test("two dead workers' spools merge in timestamp order, not filename order", async () => {
  // Adoption walks the directory in filename order, and those names carry a random
  // per-process id - so without an explicit sort, which dead worker's reports go first is
  // decided by a uuid. The queue promises oldest-first; this is where that promise would
  // quietly break after a recovery.
  assert.equal(pendingSpendReports(), 0, "this case starts from a drained queue");
  await stop();
  const early = { ...(report("foreman:review", "run-earlier") as object), ts: 1_700_000_000_000 };
  const late = { ...(report("foreman:review", "run-later") as object), ts: 1_700_000_009_999 };
  // Written so the LATER report sits in the alphabetically-first file: filename order and
  // chronological order disagree, which is the whole point of the case.
  writeFileSync(orphanPath("aaaa-holds-the-later-run"), storedSpool(DEAD_OWNER_PID, [late]), "utf8");
  writeFileSync(orphanPath("zzzz-holds-the-earlier-run"), storedSpool(DEAD_OWNER_PID, [early]), "utf8");

  assert.equal(loadSpendOutbox(), 2);
  assert.deepEqual(
    spoolRunIds(SPOOL),
    ["run-earlier", "run-later"],
    "the merged queue is ordered by when the runs happened",
  );

  await start();
  await flushPendingSpend();
  assert.deepEqual(
    received.slice(-2).map((r) => (r as { runId: string }).runId),
    ["run-earlier", "run-later"],
    "and they are delivered in that order",
  );
});

test("an acknowledged report is removed by identity, not by position", async () => {
  // What makes the sort above safe. A sweep can adopt - and therefore re-sort - while a
  // flush is awaiting its POST, so the entry at the front afterwards need not be the one the
  // daemon just acknowledged. Removing positionally would delete an unacknowledged run while
  // acknowledging a different one.
  assert.equal(pendingSpendReports(), 0, "this case starts from a drained queue");
  await stop();
  const inFlight = { ...(report("foreman:verify", "run-in-flight") as object), ts: 1_700_000_005_000 };
  writeFileSync(SPOOL, storedSpool(process.pid, [inFlight]), "utf8");
  assert.equal(loadSpendOutbox(), 0, "our own spool is not adopted by us");
  await client.reportSpend(inFlight as never);
  assert.equal(pendingSpendReports(), 1);

  // Hold the delivery open, then adopt an OLDER report from a dead peer mid-flight. The
  // sort moves it in front of the one being delivered.
  await start();
  delayedRunId = "run-in-flight";
  void flushPendingSpend();
  await eventually(() => attempted.includes("run-in-flight"));
  const older = { ...(report("foreman:triage", "run-older-adopted") as object), ts: 1_600_000_000_000 };
  writeFileSync(orphanPath("dead-peer-older"), storedSpool(DEAD_OWNER_PID, [older]), "utf8");
  sweepSpendOutbox();
  assert.equal(spoolRunIds(SPOOL)[0], "run-older-adopted", "the adopted run sorted to the front");

  // Now let the in-flight delivery finish. The 204 is for run-in-flight, so run-in-flight is
  // what must leave the queue - not whatever the sort happened to move to index 0.
  //
  // This is the discriminating assertion: with a positional shift, the 204 would have
  // removed run-older-adopted (now at the front), so that run would vanish having never been
  // sent, while run-in-flight stayed queued and was delivered twice. Requiring each run to
  // arrive exactly once catches precisely that swap.
  delayedRunId = null;
  delayedResponse?.writeHead(204).end();
  delayedResponse = null;
  await eventually(() => pendingSpendReports() === 0);
  // Asserted on POST ATTEMPTS rather than on `received`, because the harness parks the
  // delayed request before recording it - so `attempted` is the only place the in-flight
  // send appears at all.
  assert.equal(
    attempted.filter((id) => id === "run-in-flight").length,
    1,
    "the acknowledged run was sent once and then forgotten, not left queued and retried",
  );
  assert.equal(
    received.filter((r) => (r as { runId: string }).runId === "run-older-adopted").length,
    1,
    "and the adopted run was itself delivered, not silently removed in its place",
  );
  assert.equal(existsSync(SPOOL), false, "nothing is left queued");
  rmSync(orphanPath("dead-peer-older"), { force: true });
});

test("an unwritable spool is retried, not silently downgraded to memory", async () => {
  // With the state directory unwritable AND the daemon unreachable, the queue is just an
  // in-memory list again - a crash there loses a run that has already been paid for. So a
  // failed write must not be shrugged off: every later drain re-attempts it, which is the
  // only thing that closes the window without waiting for a restart.
  assert.equal(pendingSpendReports(), 0, "this case starts from a drained queue");
  await stop();
  rmSync(SPOOL, { force: true });
  // A directory where the spool file belongs: the tmp write succeeds, the rename onto it
  // fails, standing in for a full disk or an unwritable state directory.
  mkdirSync(SPOOL, { recursive: true });

  await client.reportSpend(report("foreman:review", "run-undurable"));
  assert.equal(pendingSpendReports(), 1, "the report is queued");
  assert.equal(statSync(SPOOL).isDirectory(), true, "and it is genuinely not on disk yet");

  // The disk recovers. No new report arrives and no restart happens - the next drain is the
  // only chance to become durable, and it has to take it.
  rmSync(SPOOL, { recursive: true, force: true });
  await flushPendingSpend();
  assert.equal(
    statSync(SPOOL).isFile(),
    true,
    "the retry wrote the spool without needing another report or a restart",
  );
  assert.deepEqual(spoolRunIds(SPOOL), ["run-undurable"]);

  await start();
  await flushPendingSpend();
  assert.equal((received.at(-1) as { runId: string }).runId, "run-undurable");
  assert.equal(pendingSpendReports(), 0);
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

test("a payload limit is waited out, because only the daemon's own verdict is durable", async () => {
  // 413 and 415 look like refusals of the body, but a proxy can emit either about the same
  // request - and a proxy's payload limit or content-type configuration is exactly the kind
  // of thing that changes. Only this daemon's own 400 or 422 is a durable verdict, so
  // anything else waits rather than being filed away for a human.
  assert.equal(pendingSpendReports(), 0, "this case starts from a drained queue");
  const heldBefore = quarantinedSpendReports();
  mode = "413";
  await client.reportSpend(report("foreman:backlog", "run-too-large-for-a-proxy"));
  assert.equal(pendingSpendReports(), 1, "held rather than quarantined");
  assert.equal(quarantinedSpendReports(), heldBefore, "and not set aside for a human");

  mode = "ok";
  await flushPendingSpend();
  assert.equal((received.at(-1) as { runId: string }).runId, "run-too-large-for-a-proxy");
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
  await eventually(() => delayedResponse !== null, SPAWN_WAIT_MS);

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
