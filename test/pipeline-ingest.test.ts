/**
 * What is at stake: `POST /ingest/conductor` is the one door in this integration that
 * something outside Mission Control pushes through. Everything else reads files nobody sent
 * us. So the claims here are about a door:
 *
 *  - It is guarded like the rest of the ingest family, by token, on the first line.
 *  - It is downstream of CONSENT. A push naming a repository nobody switched on is counted
 *    and dropped, because ingest must not be a second way to start observing a checkout.
 *  - It is TOLERANT. One malformed line costs that line; a kind this build has never seen
 *    costs nothing at all. Conductor's event union is TypeScript-only and unversioned, so a
 *    route that refused what it did not recognise would break on the engine's next release.
 *  - It buys LATENCY and not authority. A push makes the daemon read the run's own files
 *    now instead of on the next tick; the projection it produces is the same projection the
 *    tick would have produced, from the same files.
 *
 * And the demotion contract, which is the half that is easy to get wrong in the dangerous
 * direction: live ingest relaxes how often the event ledger is read and changes nothing
 * else. State files are read on every pass whatever the plugin is doing, because they are
 * what the projection is built from.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PipelinesView } from "../src/shared/pipeline.ts";
import type { ConductorIngestOutcome } from "../src/shared/protocol.ts";

const home = mkdtempSync(join(tmpdir(), "mission-pipeline-ingest-"));
process.env.HARNESS_HOME = join(home, "state");
// Nothing on PATH, so no test here waits on a probe that would answer the same way anyway.
process.env.MISSION_CONDUCTOR_BIN = join(home, "no-such-conductor");
process.env.AI_CONDUCTOR_REGISTRY = join(home, "no-such-registry.json");
// The backfill sweep is the demotion's own backstop, and one of the tests below is about
// what happens BEFORE it comes due. An hour is longer than this file's wall clock.
process.env.MISSION_PIPELINE_BACKFILL_MS = String(60 * 60 * 1000);
// And the liveness window is set LONGER than the sweep, which is the opposite of the shipped
// ratio and is what makes the sweep reachable at all: a pass dated past a ten-minute window
// would tail because the plugin looks quiet, and prove nothing about the backstop. Every test
// that needs the sweep hands `refreshPipelineRepo` a clock rather than waiting for one.
process.env.MISSION_PIPELINE_INGEST_LIVE_MS = String(6 * 60 * 60 * 1000);
// The debounce is drained explicitly by every test that needs it, so this only decides how
// long an undrained one would sit. Small, so nothing is left pending at exit.
process.env.MISSION_PIPELINE_INGEST_REFRESH_MS = "5";

const { openDb } = await import("../src/server/db.ts");
const { countPipelineEvents, pipelineEvents } = await import("../src/server/db.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const { Registry } = await import("../src/server/registry.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { setPipelinesConfig } = await import("../src/server/pipelines/config.ts");
const {
  drainPipelineRefreshes,
  refreshPipelineRepo,
  pipelineRepoStatuses,
  restorePipelineProjection,
} = await import("../src/server/pipelines/index.ts");
const { isPipelineIngestLive, pipelineIngestState, resetPipelineIngest } = await import(
  "../src/server/pipelines/ingest.ts"
);
const { conductorWorktree, seedConductorDaemon, seedConductorRun } = await import(
  "../e2e/fixtures/conductor.ts"
);

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));

/** A real git repository, because consent resolves a git root and refuses anything else. */
function gitRepo(name: string): string {
  const root = join(home, name);
  mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", root], { stdio: "pipe" });
  return realpathSync(root);
}

const repo = gitRepo("demo-repo");
const stranger = gitRepo("not-consented");

/** A fresh daemon with one consented repository, and nothing observed yet. */
function fixture(consented: readonly string[] = [repo]) {
  db.exec("DELETE FROM pipeline_runs");
  db.exec("DELETE FROM pipeline_events");
  setPipelinesConfig({
    enabled: true,
    repos: consented.map((repoRoot) => ({ provider: "ai-conductor", repoRoot, enabled: true })),
  });
  const registry = new Registry();
  restorePipelineProjection(registry);
  resetPipelineIngest();
  const app = buildApp(
    registry, null as never, null as never, null as never,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined,
  );
  /** POST one NDJSON batch, with the token unless a test is about not having one. */
  const push = (body: string, headers: Record<string, string> = {}) =>
    app.request("/ingest/conductor", {
      method: "POST",
      body,
      headers: {
        host: "127.0.0.1:7317",
        "content-type": "application/x-ndjson",
        "x-harness-token": ensureToken(),
        ...headers,
      },
    });
  const request = (path: string, init?: RequestInit) =>
    app.request(path, {
      ...init,
      headers: { host: "127.0.0.1:7317", "content-type": "application/json", ...init?.headers },
    });
  return { registry, push, request };
}

/** One envelope line, in the frozen wire shape. */
function line(
  slug: string,
  event: Record<string, unknown>,
  seq = 0,
  repoRoot = repo,
): string {
  return JSON.stringify({
    repo: repoRoot,
    worktree: conductorWorktree(repoRoot, slug),
    slug,
    seq,
    event,
  });
}

test("a push with no token is refused, and stores nothing", async () => {
  const { push } = fixture();
  seedConductorRun(repo, "a-feature", { steps: { build: "in_progress" } });
  const res = await push(line("a-feature", { type: "step_started" }), { "x-harness-token": "" });
  assert.equal(res.status, 401);
  assert.equal(countPipelineEvents("ai-conductor", repo, "a-feature"), 0);

  const wrong = await push(line("a-feature", { type: "step_started" }), {
    "x-harness-token": "not-the-token",
  });
  assert.equal(wrong.status, 401);
  assert.equal(countPipelineEvents("ai-conductor", repo, "a-feature"), 0);
});

test("a batch stores every line, and says what it did", async () => {
  const { push } = fixture();
  seedConductorRun(repo, "a-feature", { steps: { build: "in_progress" } });
  const res = await push(
    [
      line("a-feature", { type: "step_started", step: "build" }, 1),
      line("a-feature", { type: "step_completed", step: "build" }, 2),
      // A blank line in the middle, which a producer that flushes per event will emit.
      "",
      line("a-feature", { type: "gate_checked", step: "build" }, 3),
    ].join("\n"),
  );
  assert.equal(res.status, 200);
  const counts = (await res.json()) as ConductorIngestOutcome;
  assert.deepEqual(counts, {
    received: 3,
    stored: 3,
    duplicate: 0,
    malformed: 0,
    unconsented: 0,
  });
  assert.deepEqual(
    pipelineEvents("ai-conductor", repo, "a-feature").map((r) => [r.kind, r.source, r.producerSeq]),
    [
      ["step_started", "ingest", 1],
      ["step_completed", "ingest", 2],
      ["gate_checked", "ingest", 3],
    ],
  );
});

test("a kind this build has never heard of is stored, not refused", async () => {
  const { push } = fixture();
  seedConductorRun(repo, "a-feature", {});
  const res = await push(
    [
      line("a-feature", { type: "quantum_gate_entangled", extra: { anything: [1, 2, 3] } }, 1),
      // And a record with no discriminant at all, which is the only thing "unknown" means:
      // this build keeps no copy of the engine's union, so it cannot have an opinion about
      // which kinds are real.
      line("a-feature", { note: "no type field" }, 2),
    ].join("\n"),
  );
  const counts = (await res.json()) as ConductorIngestOutcome;
  assert.equal(counts.stored, 2);
  assert.equal(counts.malformed, 0);
  assert.deepEqual(
    pipelineEvents("ai-conductor", repo, "a-feature").map((r) => r.kind),
    ["quantum_gate_entangled", "unknown"],
  );
});

test("a malformed line costs that line and nothing else", async () => {
  const { push } = fixture();
  seedConductorRun(repo, "a-feature", {});
  const res = await push(
    [
      "{ this is not json",
      line("a-feature", { type: "step_started" }, 1),
      // Valid JSON, invalid envelope - the addressing fields are what this route must be
      // able to read, so their absence is the one thing it does refuse.
      JSON.stringify({ repo, slug: "a-feature", event: { type: "x" } }),
      JSON.stringify({ repo, worktree: "/w", slug: "a-feature", seq: -1, event: {} }),
      line("a-feature", { type: "step_completed" }, 2),
    ].join("\n"),
  );
  assert.equal(res.status, 200, "one bad line must never fail the batch");
  const counts = (await res.json()) as ConductorIngestOutcome;
  assert.equal(counts.received, 5);
  assert.equal(counts.stored, 2);
  assert.equal(counts.malformed, 3);
  assert.equal(countPipelineEvents("ai-conductor", repo, "a-feature"), 2);
});

test("a repository nobody consented to is counted and dropped", async () => {
  const { push } = fixture([repo]);
  seedConductorRun(stranger, "secret-feature", {});
  const res = await push(
    line("secret-feature", { type: "step_started" }, 1, stranger),
  );
  assert.equal(res.status, 200);
  const counts = (await res.json()) as ConductorIngestOutcome;
  assert.deepEqual(counts, {
    received: 1,
    stored: 0,
    duplicate: 0,
    malformed: 0,
    unconsented: 1,
  });
  assert.equal(countPipelineEvents("ai-conductor", stranger, "secret-feature"), 0);
  // And it left no trace on the liveness map either, so the panel cannot report a
  // repository as pushed-to when the push was refused.
  assert.equal(pipelineIngestState("ai-conductor", stranger), "never");
});

test("the same event pushed twice is stored once and counted as a duplicate", async () => {
  const { push } = fixture();
  seedConductorRun(repo, "a-feature", {});
  const body = line("a-feature", { type: "step_started", step: "build" }, 1);
  await push(body);
  const again = await push(body);
  const counts = (await again.json()) as ConductorIngestOutcome;
  assert.equal(counts.stored, 0);
  assert.equal(counts.duplicate, 1);
  assert.equal(countPipelineEvents("ai-conductor", repo, "a-feature"), 1);
});

test("a batch past its ceiling is refused whole, rather than parsed", async () => {
  const { push } = fixture();
  // Bounded before it is read, because the producer runs unattended inside another program
  // and this daemon is single-threaded.
  const res = await push("x".repeat(5 * 1024 * 1024));
  assert.equal(res.status, 413);
});

test("the size ceiling is bytes on the wire, not JavaScript string length", async () => {
  const { push } = fixture();
  // The ceiling exists to bound what this daemon will read into memory, and memory is paid
  // in BYTES. A JavaScript string is counted in UTF-16 code units, so a body of three-byte
  // characters costs three times what `String.length` reports: this one is ~1.5M units and
  // ~4.5MB on the wire, which slips a body over the ceiling past a check that measures the
  // string. Non-ASCII is not exotic in this stream - conductor step names, branch names and
  // commit subjects all reach it.
  const wide = "あ".repeat(1_500_000);
  assert.ok(wide.length < 4 * 1024 * 1024, "under the ceiling by string length");
  assert.ok(Buffer.byteLength(wide, "utf8") > 4 * 1024 * 1024, "over the ceiling by bytes");
  const res = await push(wide);
  assert.equal(res.status, 413);
});

test("a push naming a slug with no worktree is refused, and stores nothing", async () => {
  const { push } = fixture();
  seedConductorRun(repo, "a-feature", { steps: { build: "in_progress" } });

  // The shape that costs nothing to repeat: well-formed envelopes for a consented
  // repository, naming runs that do not exist. Accepting these writes ledger rows keyed to a
  // slug no pass will ever enumerate, so nothing retires them - the table would grow for as
  // long as a token holder cared to keep posting.
  const res = await push(
    [
      line("no-such-run", { type: "step_started" }, 1),
      line("also-not-real", { type: "step_started" }, 2),
    ].join("\n"),
  );
  assert.equal(res.status, 200);
  const counts = (await res.json()) as ConductorIngestOutcome;
  assert.equal(counts.stored, 0, "a slug with no worktree is not a run to store for");
  assert.equal(counts.malformed, 2, "an unaddressable target is counted, not silently dropped");
  assert.equal(countPipelineEvents("ai-conductor", repo, "no-such-run"), 0);
  assert.equal(countPipelineEvents("ai-conductor", repo, "also-not-real"), 0);
  // And no liveness for it, or one repeated push would stand the tail down over a run that
  // does not exist.
  assert.equal(isPipelineIngestLive("ai-conductor", repo, "no-such-run"), false);
  assert.equal(pipelineIngestState("ai-conductor", repo), "never");

  // The real run alongside them is unaffected: this is a per-line judgement, like every
  // other rejection on this route.
  const ok = await push(line("a-feature", { type: "step_started" }, 3));
  assert.equal(((await ok.json()) as ConductorIngestOutcome).stored, 1);
});

test("a repository whose runs cannot be listed stores nothing, rather than trusting the slug", async () => {
  const blocked = gitRepo("unlistable");
  const { push } = fixture([repo, blocked]);
  // `.worktrees` present but not a directory, so listing it throws ENOTDIR. Chosen over
  // chmod because a suite running as root would read an unreadable directory perfectly well
  // and this assertion would quietly stop testing anything.
  writeFileSync(join(blocked, ".worktrees"), "not a directory\n");

  const res = await push(line("a-feature", { type: "step_started" }, 1, blocked));
  assert.equal(res.status, 200);
  const counts = (await res.json()) as ConductorIngestOutcome;
  assert.equal(counts.stored, 0);
  assert.equal(counts.malformed, 1);
  // "We could not look" is not "it is there". The projection makes the opposite call on the
  // same reading - it declines to RETIRE what it could not see - and both follow from the
  // same rule: an unreadable directory is not evidence for the durable act in front of you.
  assert.equal(countPipelineEvents("ai-conductor", blocked, "a-feature"), 0);
  assert.equal(pipelineIngestState("ai-conductor", blocked), "never");
});

test("a push for a repository that lost consent mid-debounce is not folded back", async () => {
  const { registry, push, request } = fixture();
  seedConductorRun(repo, "a-feature", { steps: { build: "in_progress" } });
  await push(line("a-feature", { type: "step_started" }, 1));

  // Withdrawn between the push being accepted and the debounce firing, which is a 150ms
  // window an operator can absolutely land in - they click the switch while the engine is
  // mid-step. The route checked consent when the batch arrived; that answer is now stale.
  const off = await request("/api/pipelines/config", {
    method: "PUT",
    body: JSON.stringify({ enabled: true, repos: [] }),
  });
  assert.equal(off.status, 200);
  assert.equal(registry.listPipelineRuns().length, 0, "withdrawal empties the projection");

  // The queued pass must not put it back. A pass is a durable write plus an emit, so a
  // repository the operator switched off would re-appear on the page by itself - and its
  // ledger rows with it, written under a consent that no longer exists.
  await drainPipelineRefreshes(registry);
  assert.equal(registry.listPipelineRuns().length, 0, "a queued pass must not re-create it");
  assert.equal(countPipelineEvents("ai-conductor", repo, "a-feature"), 0);
});

test("a pass already under way when consent is withdrawn writes nothing", async () => {
  const { registry } = fixture();
  seedConductorRun(repo, "a-feature", { steps: { build: "in_progress" } });

  // The third door onto the same window, and the one neither queue check can see: this pass
  // is past the drain and is not in the pending map, so nothing between here and its first
  // write consults the operator at all. A tick's pass reads a repository's files on every
  // cadence, so this is not an exotic interleaving - it is the ordinary one.
  const pass = refreshPipelineRepo(registry, "ai-conductor", repo);
  setPipelinesConfig({ enabled: true, repos: [] });
  await pass;

  // Everything below the read in a pass is durable and emitted, so a pass that ignored this
  // would put back exactly what withdrawing consent had just deleted - rows, ledger, health
  // line and an SSE upsert - and the operator would watch a repository they switched off
  // draw itself back onto the page.
  assert.equal(registry.listPipelineRuns().length, 0, "no run rows");
  assert.equal(countPipelineEvents("ai-conductor", repo, "a-feature"), 0, "no ledger rows");
  assert.equal(
    pipelineRepoStatuses().some((status) => status.repoRoot === repo),
    false,
    "and no health line for a repository nobody is observing",
  );
});

test("a body that cannot be read is refused, not counted as an empty batch", async () => {
  const { push: _push, request } = fixture();
  seedConductorRun(repo, "a-feature", { steps: { build: "in_progress" } });
  // A stream that errors mid-body: a dropped connection, or the plugin's own shutdown abort
  // ending a request the daemon had already started reading.
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"partial":'));
      controller.error(new Error("connection reset"));
    },
  });
  const res = await request("/ingest/conductor", {
    method: "POST",
    body,
    // @ts-expect-error - `duplex` is required for a streaming body and is not in the DOM lib.
    duplex: "half",
    headers: { "content-type": "application/x-ndjson", "x-harness-token": ensureToken() },
  });
  // NOT 200. The producer treats any 2xx as delivered and drops the batch, so answering
  // "received 0" to a read failure would destroy the events rather than lose the request -
  // and for the kinds conductor never writes down, nothing could ever put them back.
  assert.equal(res.status, 503);
  assert.equal(countPipelineEvents("ai-conductor", repo, "a-feature"), 0);
});

test("a run removed before its FIRST pass does not leave its ledger behind", async () => {
  const { registry, push } = fixture();
  seedConductorRun(repo, "brief", { steps: { build: "in_progress" } });

  // Accepted at the door - the worktree was real when the push arrived - and then gone
  // before the debounced refresh could run. So the projection never held a cursor for this
  // slug, and retirement that walks only the cursors it happens to have would never visit
  // it. The rows would sit there for the life of the database.
  await push(line("brief", { type: "step_started" }, 1));
  assert.ok(countPipelineEvents("ai-conductor", repo, "brief") > 0);
  rmSync(conductorWorktree(repo, "brief"), { recursive: true, force: true });

  await refreshPipelineRepo(registry, "ai-conductor", repo);
  assert.equal(
    countPipelineEvents("ai-conductor", repo, "brief"),
    0,
    "a pass that could see everything owes the ledger the same answer it gives the projection",
  );
});

test("the ledger is retired for a run whose worktree is gone, however its rows got there", async () => {
  const { registry, push } = fixture();
  seedConductorRun(repo, "short-lived", { steps: { build: "in_progress" } });
  await refreshPipelineRepo(registry, "ai-conductor", repo);
  await push(line("short-lived", { type: "step_started" }, 1));
  assert.ok(countPipelineEvents("ai-conductor", repo, "short-lived") > 0);

  // The window the door check cannot close on its own: the slug was real when it was
  // accepted and the worktree went away afterwards. Retirement has to answer for rows it
  // did not expect, not only for the slugs it happens to be tracking a cursor for.
  rmSync(conductorWorktree(repo, "short-lived"), { recursive: true, force: true });
  await refreshPipelineRepo(registry, "ai-conductor", repo);
  assert.equal(countPipelineEvents("ai-conductor", repo, "short-lived"), 0);
});

test("a push makes the projection catch up now, without waiting for a tick", async () => {
  const { registry, push } = fixture();
  // A run mid-build, already projected once - so what this test measures is the SECOND
  // observation, which without ingest would arrive on the next tick.
  seedConductorRun(repo, "a-feature", {
    steps: { worktree: "done", build: "in_progress" },
    lastStep: "build",
  });
  seedConductorDaemon(repo, { pid: process.pid });
  await refreshPipelineRepo(registry, "ai-conductor", repo);
  assert.equal(registry.listPipelineRuns()[0]?.group, "building");

  // The engine finishes the step: it writes its files, then emits. The push is the
  // notification; the files are still what the projection is read from, which is why this
  // fixture writes them.
  seedConductorRun(repo, "a-feature", {
    steps: { worktree: "done", build: "done" },
    lastStep: "build",
    halt: "the build review found two blocking defects",
    haltClass: "needs-human",
  });
  await push(line("a-feature", { type: "step_completed", step: "build" }, 1));
  await drainPipelineRefreshes(registry);

  const run = registry.listPipelineRuns()[0];
  assert.equal(run?.group, "halted", "the push should have pulled the halt marker in at once");
  assert.equal(run?.halt?.class, "needs-human");
});

test("what the tail already read is not stored twice when it is pushed", async () => {
  const { registry, push } = fixture();
  // The convergence case as it actually happens: the engine appends to events.jsonl AND the
  // plugin pushes the same record. Two observations of one event, arriving by coordinates
  // from two unrelated spaces - a byte offset and the plugin's own counter.
  const emitted = { type: "step_completed", step: "build", ts: "2026-08-15T10:00:00.000Z" };
  seedConductorRun(repo, "a-feature", { steps: { build: "done" }, events: [emitted] });
  await refreshPipelineRepo(registry, "ai-conductor", repo);
  assert.equal(countPipelineEvents("ai-conductor", repo, "a-feature"), 1);
  assert.equal(pipelineEvents("ai-conductor", repo, "a-feature")[0]?.source, "tail");

  const res = await push(line("a-feature", emitted, 999));
  const counts = (await res.json()) as ConductorIngestOutcome;
  assert.equal(counts.stored, 0, "the plugin's copy is the same event, under a different number");
  assert.equal(counts.duplicate, 1);
  assert.equal(countPipelineEvents("ai-conductor", repo, "a-feature"), 1);

  // And one projection state: the run's spend was counted once, by the tail, from the file.
  await drainPipelineRefreshes(registry);
  const runs = registry.listPipelineRuns();
  assert.equal(runs.length, 1);
});

test("live ingest relaxes the ledger read and never the state files", async () => {
  const { registry, push } = fixture();
  seedConductorRun(repo, "a-feature", {
    steps: { build: "in_progress" },
    events: [{ type: "step_started", step: "build" }],
  });
  seedConductorDaemon(repo, { pid: process.pid });
  await refreshPipelineRepo(registry, "ai-conductor", repo);
  assert.equal(countPipelineEvents("ai-conductor", repo, "a-feature"), 1);
  assert.equal(isPipelineIngestLive("ai-conductor", repo, "a-feature"), false);

  // A push makes the run live. What it does NOT do is read the ledger; see the test below.
  await push(line("a-feature", { type: "step_started", step: "build" }, 1));
  await drainPipelineRefreshes(registry);
  assert.equal(isPipelineIngestLive("ai-conductor", repo, "a-feature"), true);

  // The engine halts, which is a STATE FILE and not an event at all - conductor does not
  // persist its halts to the ledger, which is why the tail's demotion can never be allowed
  // to reach the state readers.
  seedConductorRun(repo, "a-feature", {
    steps: { build: "done" },
    halt: "a gate refused",
    haltClass: "mechanical",
    events: [{ type: "step_started", step: "build" }],
  });
  // And it appends a record the plugin did NOT push - the case a conductor release that
  // added an event kind produces, since its bus has no wildcard and the installed plugin
  // subscribes to an enumerated list. Appended after the seed, which rewrites the ledger.
  appendFileSync(
    join(conductorWorktree(repo, "a-feature"), ".pipeline", "events.jsonl"),
    `${JSON.stringify({ type: "a_kind_the_plugin_never_subscribed_to" })}\n`,
  );

  await refreshPipelineRepo(registry, "ai-conductor", repo);
  // The halt landed: state files are read on every pass, whatever ingest is doing. This is
  // the load-bearing half - the projection's authority never moves to the push path.
  assert.equal(registry.listPipelineRuns()[0]?.halt?.class, "mechanical");
  // And the ledger read was skipped, because the run is live and the sweep is an hour away.
  assert.equal(
    countPipelineEvents("ai-conductor", repo, "a-feature"),
    1,
    "a live run's ledger should not be re-read on an ordinary tick",
  );

  // The sweep coming due is what picks the unsubscribed event up. Reached by dating the pass
  // past the sweep interval rather than by waiting out an hour, and while the run is still
  // live - so what this proves is the BACKSTOP firing, not the plugin being written off.
  const swept = Date.now() + 90 * 60 * 1000;
  assert.equal(isPipelineIngestLive("ai-conductor", repo, "a-feature", swept), true);
  await refreshPipelineRepo(registry, "ai-conductor", repo, { now: swept });
  assert.equal(
    countPipelineEvents("ai-conductor", repo, "a-feature"),
    2,
    "the backfill sweep is what makes demotion safe; it must actually catch up",
  );
});

test("a run being pushed about does not have its ledger re-read per batch", async () => {
  const { registry, push } = fixture();
  seedConductorRun(repo, "a-feature", {
    steps: { build: "in_progress" },
    events: [{ type: "step_started", step: "build" }],
  });
  // One ordinary pass first, so the tail holds a cursor and the run has been swept once. This
  // is the state every run reaches before its plugin ever delivers.
  await refreshPipelineRepo(registry, "ai-conductor", repo);
  assert.equal(countPipelineEvents("ai-conductor", repo, "a-feature"), 1);

  // The engine appends a kind this build's plugin never subscribed to - conductor's bus has
  // no wildcard - so this event exists ONLY in the file. It is the exact thing the sweep is
  // for, and the exact thing that never arrives by push.
  appendFileSync(
    join(conductorWorktree(repo, "a-feature"), ".pipeline", "events.jsonl"),
    `${JSON.stringify({ type: "a_kind_the_plugin_never_subscribed_to" })}\n`,
  );

  // Now the plugin flushes, repeatedly, the way it does during a busy step.
  for (let seq = 1; seq <= 5; seq += 1) {
    await push(line("a-feature", { type: "step_progress", n: seq }, seq));
    await drainPipelineRefreshes(registry);
  }

  // Five flushes, five passes, and the ledger was not read once. That is the demotion: a push
  // is not a licence to re-read a file, or the tail would run at the plugin's flush cadence -
  // faster than the tick it was supposed to relax - for exactly the runs it was relaxed for.
  const kinds = pipelineEvents("ai-conductor", repo, "a-feature").map((row) => row.kind);
  assert.equal(kinds.filter((kind) => kind === "step_progress").length, 5);
  assert.equal(
    kinds.includes("a_kind_the_plugin_never_subscribed_to"),
    false,
    "a pushed batch must not force a tail; only the sweep may pick this up",
  );
  assert.equal(countPipelineEvents("ai-conductor", repo, "a-feature"), 6);

  // And the state files were folded on every one of those passes, which is what the push is
  // actually for. Nothing here is an argument for reading the run less.
  assert.equal(registry.listPipelineRuns()[0]?.slug, "a-feature");
});

test("a quiet plugin puts the tail straight back on its ordinary cadence", async () => {
  const { registry, push } = fixture();
  seedConductorRun(repo, "a-feature", { steps: { build: "in_progress" } });
  await push(line("a-feature", { type: "step_started" }, 1));
  await drainPipelineRefreshes(registry);
  assert.equal(pipelineIngestState("ai-conductor", repo), "live");
  assert.equal(isPipelineIngestLive("ai-conductor", repo, "a-feature"), true);

  // Long enough after the last push that the window has closed. Read with an explicit clock
  // rather than by waiting, because the window is measured in minutes on purpose - and in
  // hours in this file, where it is set wide so the sweep is reachable underneath it.
  const later = Date.now() + 7 * 60 * 60 * 1000;
  assert.equal(pipelineIngestState("ai-conductor", repo, later), "quiet");
  assert.equal(isPipelineIngestLive("ai-conductor", repo, "a-feature", later), false);
  // `quiet` and `never` are different claims, and the difference is the whole diagnostic
  // value of the indicator: one says the plugin stopped, the other says it was never there.
  assert.equal(pipelineIngestState("ai-conductor", join(home, "elsewhere")), "never");
});

test("the health line reports how observation is arriving, per repository", async () => {
  const { registry, push, request } = fixture();
  seedConductorRun(repo, "a-feature", { steps: { build: "in_progress" } });
  await refreshPipelineRepo(registry, "ai-conductor", repo);
  assert.equal(pipelineRepoStatuses()[0]?.ingest, "never", "the shipped state: no plugin");

  await push(line("a-feature", { type: "step_started" }, 1));
  await drainPipelineRefreshes(registry);
  assert.equal(pipelineRepoStatuses()[0]?.ingest, "live");

  // And it reaches the panel through the route it actually reads.
  const view = (await (await request("/api/pipelines/config")).json()) as PipelinesView;
  assert.equal(view.status[0]?.ingest, "live");
});

test("withdrawing consent takes the ledger and the liveness with it", async () => {
  const { registry, push, request } = fixture();
  seedConductorRun(repo, "a-feature", { steps: { build: "in_progress" } });
  await push(line("a-feature", { type: "step_started" }, 1));
  await drainPipelineRefreshes(registry);
  assert.ok(countPipelineEvents("ai-conductor", repo, "a-feature") > 0);

  const res = await request("/api/pipelines/config", {
    method: "PUT",
    body: JSON.stringify({ enabled: true, repos: [] }),
  });
  assert.equal(res.status, 200);
  // The one durable thing this integration keeps that is not re-derivable from the engine's
  // files, so it is the one thing that must not outlive the permission to have written it.
  assert.equal(countPipelineEvents("ai-conductor", repo, "a-feature"), 0);
  assert.equal(pipelineIngestState("ai-conductor", repo), "never");
});
