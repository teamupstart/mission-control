import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "../src/shared/types.ts";
import type { PipelineRun } from "../src/shared/pipeline.ts";

// What is at stake: `pipeline_runs` is a CACHE of files another program owns, and the whole
// integration rests on that being true rather than merely intended. Three things follow, and
// each is a test below:
//
//  - It must be REBUILDABLE. Emptying the table and re-reading the same tree must produce
//    the same projection, or the row has become the source of truth for something.
//  - A row this build cannot read is DROPPED, not skipped. Skipping leaves it shadowing the
//    next write's `ON CONFLICT` under a key nothing can address.
//  - Consent is the whole gate. A repository switched off loses its rows, its live catalog
//    entries and its health line, at the write - not one tick later - and a row that
//    outlived its consent while the daemon was down never comes back.
//
// Plus the one durable thing that is NOT re-derivable: the events offset. A restart that
// re-read every ledger from byte zero would double-count every run's token spend.

const home = mkdtempSync(join(tmpdir(), "mission-pipeline-projection-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb, loadPipelineRuns, pipelineEventCursors } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { setPipelinesConfig } = await import("../src/server/pipelines/config.ts");
const {
  forgetPipelineRepo,
  pipelineRepoStatuses,
  reconcilePipelineConsent,
  refreshPipelineRepo,
  restorePipelineProjection,
} = await import("../src/server/pipelines/index.ts");
const { seedConductorDaemon, seedConductorRun } = await import("../e2e/fixtures/conductor.ts");

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));

/** A throwaway repository root, one per case. */
function repo(name: string): string {
  const root = join(home, name);
  mkdirSync(root, { recursive: true });
  return root;
}

/** Start from an empty projection and an empty consent config. */
function reset(): void {
  db.exec("DELETE FROM pipeline_runs");
  setPipelinesConfig({ enabled: false, repos: [] });
}

/** Consent to one repository, with the master switch on. */
function consentTo(repoRoot: string): void {
  setPipelinesConfig({
    enabled: true,
    repos: [{ provider: "ai-conductor", repoRoot, enabled: true }],
  });
}

test("one pass projects every run, durably and into the live catalog", async () => {
  reset();
  const root = repo("first-pass");
  seedConductorRun(root, "add-widgets", {
    steps: { worktree: "done", build: "in_progress" },
    lastStep: "build",
    tier: "M",
    track: "product",
  });
  seedConductorRun(root, "fix-things", { steps: { worktree: "done" }, tier: "S" });
  seedConductorDaemon(root, { pid: process.pid });
  consentTo(root);

  const registry = new Registry();
  const events: ServerEvent[] = [];
  registry.subscribe((event) => events.push(event));
  await refreshPipelineRepo(registry, "ai-conductor", root);

  const live = registry.listPipelineRuns();
  assert.deepEqual(live.map((r) => r.slug).sort(), ["add-widgets", "fix-things"]);
  assert.equal(live.find((r) => r.slug === "add-widgets")?.group, "building");
  assert.equal(live.find((r) => r.slug === "add-widgets")?.tier, "M");
  assert.deepEqual([...new Set(events.map((e) => e.type))], ["pipeline_upsert"]);
  // And durably, keyed by the engine's own identity.
  assert.deepEqual(
    loadPipelineRuns().map((row) => row.run.slug).sort(),
    ["add-widgets", "fix-things"],
  );
  // The snapshot a reconnecting dashboard gets carries the same set.
  assert.equal(registry.snapshot().pipelineRuns.length, 2);
});

test("an unchanged pass emits nothing, so a quiet fleet wakes no browser", async () => {
  // The suppression is not an optimization: the loop re-derives a whole run every tick, so
  // without it a fleet where nothing is happening pushes one frame per run per tick for ever.
  reset();
  const root = repo("quiet");
  seedConductorRun(root, "feat", { steps: { build: "done" } });
  seedConductorDaemon(root, { pid: process.pid });
  consentTo(root);

  const registry = new Registry();
  await refreshPipelineRepo(registry, "ai-conductor", root);
  const events: ServerEvent[] = [];
  registry.subscribe((event) => events.push(event));
  await refreshPipelineRepo(registry, "ai-conductor", root);
  await refreshPipelineRepo(registry, "ai-conductor", root);
  assert.equal(events.length, 0, "two identical passes should wake nobody");

  // ...and a real change still gets through, so the assertion above is not passing because
  // the emitter is simply broken.
  seedConductorRun(root, "feat", { steps: { build: "done", test_suite: "in_progress" } });
  await refreshPipelineRepo(registry, "ai-conductor", root);
  assert.deepEqual(events.map((e) => e.type), ["pipeline_upsert"]);
});

test("the projection rebuilds from the engine's files alone", async () => {
  // The claim the whole design rests on. Delete every row - the way an operator deleting the
  // database would - and one pass over the same tree must produce the same answer.
  reset();
  const root = repo("rebuild");
  seedConductorRun(root, "feat", {
    steps: { worktree: "done", plan: "done", build: "in_progress" },
    lastStep: "build",
    tier: "L",
    track: "technical",
    prUrl: "https://github.com/acme/demo/pull/4",
  });
  seedConductorDaemon(root, { pid: process.pid });
  consentTo(root);

  const before = new Registry();
  await refreshPipelineRepo(before, "ai-conductor", root);
  const original = before.listPipelineRuns();

  db.exec("DELETE FROM pipeline_runs");
  const after_ = new Registry();
  await refreshPipelineRepo(after_, "ai-conductor", root);

  // `updatedAt` is the projection's own clock rather than a fact about the run, so it is the
  // one field a rebuild is not expected to reproduce.
  const strip = (runs: PipelineRun[]): unknown =>
    runs.map(({ updatedAt: _updatedAt, ...rest }) => rest);
  assert.deepEqual(strip(after_.listPipelineRuns()), strip(original));
});

test("the events offset survives a restart, so a run's token spend is not counted twice", async () => {
  reset();
  const root = repo("offsets");
  const worktree = seedConductorRun(root, "feat", {
    steps: { build: "done" },
    events: [{ type: "step_completed", step: "build", tokenUsage: { input: 100, output: 20 } }],
  });
  seedConductorDaemon(root, { pid: process.pid });
  consentTo(root);

  const first = new Registry();
  await refreshPipelineRepo(first, "ai-conductor", root);
  assert.equal(first.listPipelineRuns()[0]?.costTokens, 120);
  const offset = pipelineEventCursors("ai-conductor", root).get("feat")?.offset;
  assert.ok(offset && offset > 0, "the offset should have advanced past the first record");

  // A second pass reads nothing new and must not re-add what it already counted.
  await refreshPipelineRepo(first, "ai-conductor", root);
  assert.equal(first.listPipelineRuns()[0]?.costTokens, 120);

  // Now the restart: a fresh registry seeded from the durable rows, exactly as boot does.
  // `restorePipelineProjection` clears this process's in-memory carry first, so the 120
  // below can only have come from the stored row - which is the whole claim.
  const restarted = new Registry();
  restorePipelineProjection(restarted);
  assert.equal(restarted.listPipelineRuns()[0]?.costTokens, 120);

  appendFileSync(
    join(worktree, ".pipeline", "events.jsonl"),
    `${JSON.stringify({ type: "step_completed", step: "finish", tokenUsage: { input: 5 } })}\n`,
  );
  await refreshPipelineRepo(restarted, "ai-conductor", root);
  assert.equal(
    restarted.listPipelineRuns()[0]?.costTokens,
    125,
    "the restarted daemon must add to the carried total, not re-read the whole ledger",
  );
});

test("a replaced ledger restarts the token total instead of adding to it", async () => {
  // A worktree torn down and re-cut under the same slug gets a fresh ledger, which the tail
  // reads from byte zero - so what it reports is already the whole of the NEW run's spend.
  // Adding the old run's total to it reports a cost that never happened, and goes on
  // reporting it for as long as the row lives.
  reset();
  const root = repo("replaced-ledger");
  const worktree = seedConductorRun(root, "feat", {
    // Three records, so the replacement below is unambiguously SHORTER in bytes - which is
    // the signal the tail detects. A same-length replacement is not detectable by offset
    // alone and is out of this repair's scope.
    steps: { build: "done" },
    events: [
      { type: "step_completed", step: "build", tokenUsage: { input: 300 } },
      { type: "step_completed", step: "test_suite", tokenUsage: { input: 300 } },
      { type: "step_completed", step: "build_review", tokenUsage: { input: 300 } },
    ],
  });
  seedConductorDaemon(root, { pid: process.pid });
  consentTo(root);

  const registry = new Registry();
  await refreshPipelineRepo(registry, "ai-conductor", root);
  assert.equal(registry.listPipelineRuns()[0]?.costTokens, 900);
  const before = statSync(join(worktree, ".pipeline", "events.jsonl")).size;

  // The re-cut: a shorter ledger at the same path.
  writeFileSync(
    join(worktree, ".pipeline", "events.jsonl"),
    `${JSON.stringify({ type: "step_completed", step: "w", tokenUsage: { input: 5 } })}\n`,
  );
  assert.ok(
    statSync(join(worktree, ".pipeline", "events.jsonl")).size < before,
    "the fixture must actually shrink, or it is not exercising the signal",
  );
  await refreshPipelineRepo(registry, "ai-conductor", root);
  assert.equal(
    registry.listPipelineRuns()[0]?.costTokens,
    5,
    "the new ledger's spend, not the old run's plus the new one's",
  );

  // And it accumulates normally again from there - the reset is for the replacement, not a
  // permanent switch to last-batch-only.
  appendFileSync(
    join(worktree, ".pipeline", "events.jsonl"),
    `${JSON.stringify({ type: "step_completed", step: "build", tokenUsage: { input: 7 } })}\n`,
  );
  await refreshPipelineRepo(registry, "ai-conductor", root);
  assert.equal(registry.listPipelineRuns()[0]?.costTokens, 12);
});

test("a replacement with no spend of its own does not resurrect the old total", async () => {
  // The half of the reset that the first repair missed. A replacement ledger whose first
  // pass carries no token-bearing record computes a null total, and the write that stores a
  // total skips a null - so the OLD value stayed cached, and the next ordinary append found
  // it and added to it. The stale value must not outlive the pass that learned it was stale.
  reset();
  const root = repo("replaced-empty");
  const worktree = seedConductorRun(root, "feat", {
    steps: { build: "done" },
    events: [
      { type: "step_completed", step: "build", tokenUsage: { input: 400 } },
      { type: "step_completed", step: "test_suite", tokenUsage: { input: 400 } },
      { type: "step_completed", step: "build_review", tokenUsage: { input: 400 } },
    ],
  });
  seedConductorDaemon(root, { pid: process.pid });
  consentTo(root);

  const registry = new Registry();
  await refreshPipelineRepo(registry, "ai-conductor", root);
  assert.equal(registry.listPipelineRuns()[0]?.costTokens, 1200);
  const before = statSync(join(worktree, ".pipeline", "events.jsonl")).size;

  // The re-cut, with a shorter ledger carrying NO token usage at all.
  writeFileSync(
    join(worktree, ".pipeline", "events.jsonl"),
    `${JSON.stringify({ type: "step_started", step: "w" })}\n`,
  );
  assert.ok(statSync(join(worktree, ".pipeline", "events.jsonl")).size < before);
  await refreshPipelineRepo(registry, "ai-conductor", root);
  assert.equal(
    registry.listPipelineRuns()[0]?.costTokens,
    null,
    "an unknown spend, not the old run's",
  );

  // The ordinary append that used to find the stale total and add to it.
  appendFileSync(
    join(worktree, ".pipeline", "events.jsonl"),
    `${JSON.stringify({ type: "step_completed", step: "b", tokenUsage: { input: 9 } })}\n`,
  );
  await refreshPipelineRepo(registry, "ai-conductor", root);
  assert.equal(registry.listPipelineRuns()[0]?.costTokens, 9, "the new ledger's spend alone");
});

test("a replacement ledger of the SAME length is still a replacement", async () => {
  // The case a byte comparison cannot see, and the one a re-cut worktree actually produces:
  // the path is deleted and created again, so the new file can be any length at all - equal
  // or longer included. Resuming at the old offset would skip the replacement's opening
  // records and add whatever came after them to a total belonging to a run that is gone.
  //
  // The identity signal (dev:ino:birthtime) is what catches it, so this test recreates the
  // file rather than truncating it, and asserts the sizes MATCH - otherwise it would be
  // passing on the length check and proving nothing about identity.
  reset();
  const root = repo("replaced-same-length");
  const worktree = seedConductorRun(root, "feat", {
    steps: { build: "done" },
    events: [{ type: "step_completed", step: "aaaa", tokenUsage: { input: 700 } }],
  });
  seedConductorDaemon(root, { pid: process.pid });
  consentTo(root);

  const registry = new Registry();
  await refreshPipelineRepo(registry, "ai-conductor", root);
  assert.equal(registry.listPipelineRuns()[0]?.costTokens, 700);
  const ledger = join(worktree, ".pipeline", "events.jsonl");
  const before = statSync(ledger);
  const beforeBytes = readFileSync(ledger, "utf8");

  // Delete and recreate with a body of exactly the same length: a different file, same size.
  // A DIFFERENT figure of the same byte width, so the three outcomes are distinguishable:
  // 701 is the replacement read correctly, 700 is the stale total kept because nothing was
  // read, and 1401 would be the old total plus the new one.
  rmSync(ledger);
  writeFileSync(
    ledger,
    `${JSON.stringify({ type: "step_completed", step: "bbbb", tokenUsage: { input: 701 } })}\n`,
  );
  const after = statSync(ledger);
  // The two things this fixture must actually guarantee, both of which the test controls:
  // the same byte length (so it cannot pass on the size check) and different content (so it
  // is a real replacement). Deliberately NOT an assertion about the inode - Linux reuses the
  // inode number when a file is deleted and immediately recreated, which is how CI caught
  // that `dev:ino` was the wrong signal in the first place.
  assert.equal(after.size, before.size, "the fixture must be the same length, or it proves nothing");
  assert.notEqual(
    readFileSync(ledger, "utf8"),
    beforeBytes,
    "and must genuinely be a different ledger",
  );

  await refreshPipelineRepo(registry, "ai-conductor", root);
  assert.equal(
    registry.listPipelineRuns()[0]?.costTokens,
    701,
    "the replacement's own spend - not 700 (stale, nothing read) and not 1401 (accumulated)",
  );
});

test("an upgraded row rebuilds its spend from the ledger instead of trusting it", async () => {
  // The whole point of treating an unverifiable cursor as a restart, seen from the outside:
  // a row written by a build that could not tell a replaced ledger from an appended one has
  // its figure RECOMPUTED from the file rather than carried forward. The stored 9999 below
  // is a total no ledger on disk supports, standing in for one accumulated across a
  // replacement the old build could not see.
  reset();
  const root = repo("upgraded-cursor");
  const worktree = seedConductorRun(root, "feat", {
    steps: { build: "done" },
    events: [
      { type: "step_completed", step: "a", tokenUsage: { input: 30 } },
      { type: "step_completed", step: "b", tokenUsage: { input: 12 } },
    ],
  });
  seedConductorDaemon(root, { pid: process.pid });
  consentTo(root);

  // A pre-upgrade row: a real offset, no identity, and a spend the ledger does not justify.
  const size = statSync(join(worktree, ".pipeline", "events.jsonl")).size;
  db.prepare(
    `INSERT INTO pipeline_runs
       (provider, repo_root, slug, run_json, events_offset, events_identity, updated_at)
     VALUES (?, ?, ?, ?, ?, '', ?)`,
  ).run(
    "ai-conductor",
    root,
    "feat",
    JSON.stringify({
      provider: "ai-conductor",
      repoRoot: root,
      slug: "feat",
      worktree,
      tier: null,
      track: null,
      steps: [],
      lastStep: null,
      halt: null,
      group: "eligible",
      prUrl: null,
      costTokens: 9999,
      updatedAt: 1,
    }),
    size,
    1,
  );

  const registry = new Registry();
  restorePipelineProjection(registry);
  assert.equal(registry.listPipelineRuns()[0]?.costTokens, 9999, "the stored figure, at boot");

  await refreshPipelineRepo(registry, "ai-conductor", root);
  assert.equal(
    registry.listPipelineRuns()[0]?.costTokens,
    42,
    "recomputed from the ledger on the first upgraded pass, not carried forward",
  );
});

test("a run whose worktree is gone leaves the projection", async () => {
  reset();
  const root = repo("torn-down");
  seedConductorRun(root, "keep", { steps: { build: "done" } });
  seedConductorRun(root, "go", { steps: { build: "done" } });
  seedConductorDaemon(root, { pid: process.pid });
  consentTo(root);

  const registry = new Registry();
  await refreshPipelineRepo(registry, "ai-conductor", root);
  assert.equal(registry.listPipelineRuns().length, 2);

  rmSync(join(root, ".worktrees", "go"), { recursive: true, force: true });
  const events: ServerEvent[] = [];
  registry.subscribe((event) => events.push(event));
  await refreshPipelineRepo(registry, "ai-conductor", root);

  assert.deepEqual(registry.listPipelineRuns().map((r) => r.slug), ["keep"]);
  assert.deepEqual(loadPipelineRuns().map((row) => row.run.slug), ["keep"]);
  const removed = events.filter(
    (e): e is Extract<ServerEvent, { type: "pipeline_remove" }> => e.type === "pipeline_remove",
  );
  assert.equal(removed.length, 1);
  assert.equal(removed[0]?.slug, "go");
});

test("withdrawing consent drops the rows, the catalog entries and the health line at once", async () => {
  // At the WRITE, not one tick later. An operator who switches a repository off and keeps
  // looking at the page is entitled to see it happen.
  reset();
  const root = repo("withdrawn");
  seedConductorRun(root, "feat", { steps: { build: "done" } });
  seedConductorDaemon(root, { pid: process.pid });
  consentTo(root);

  const registry = new Registry();
  await refreshPipelineRepo(registry, "ai-conductor", root);
  assert.equal(registry.listPipelineRuns().length, 1);

  const events: ServerEvent[] = [];
  registry.subscribe((event) => events.push(event));
  setPipelinesConfig({
    enabled: true,
    repos: [{ provider: "ai-conductor", repoRoot: root, enabled: false }],
  });
  reconcilePipelineConsent(registry);

  assert.deepEqual(registry.listPipelineRuns(), []);
  assert.deepEqual(loadPipelineRuns(), []);
  assert.deepEqual(events.map((e) => e.type), ["pipeline_remove"]);
});

test("the master switch alone withdraws every repository, and keeps the choice", async () => {
  reset();
  const root = repo("master-off");
  seedConductorRun(root, "feat", { steps: { build: "done" } });
  seedConductorDaemon(root, { pid: process.pid });
  consentTo(root);

  const registry = new Registry();
  await refreshPipelineRepo(registry, "ai-conductor", root);
  assert.equal(registry.listPipelineRuns().length, 1);

  setPipelinesConfig({
    enabled: false,
    repos: [{ provider: "ai-conductor", repoRoot: root, enabled: true }],
  });
  reconcilePipelineConsent(registry);
  assert.deepEqual(registry.listPipelineRuns(), []);
});

test("a row that outlived its consent while the daemon was down never comes back", async () => {
  // The restore's own half. Consent can be withdrawn between two daemon lifetimes, and a row
  // reloaded then would arrive on every open dashboard as a frame about a repository the
  // operator switched off - which reads as a setting that did not take.
  reset();
  const root = repo("stale-consent");
  seedConductorRun(root, "feat", { steps: { build: "done" } });
  seedConductorDaemon(root, { pid: process.pid });
  consentTo(root);

  const before = new Registry();
  await refreshPipelineRepo(before, "ai-conductor", root);
  assert.equal(loadPipelineRuns().length, 1);

  // The daemon is down; the config is edited (by another build, by hand, by a route).
  setPipelinesConfig({ enabled: false, repos: [] });

  const restarted = new Registry();
  restorePipelineProjection(restarted);
  assert.deepEqual(restarted.listPipelineRuns(), []);
  assert.deepEqual(loadPipelineRuns(), [], "the rows go too, not just the catalog");
});

test("a projection row this build cannot read is dropped, not skipped", () => {
  // Skipping would leave it shadowing the next write's ON CONFLICT under a key nothing can
  // address - so the run would never be projected again while its row sat there for ever.
  // Dropping costs one refresh, which is the whole premise of this table being a cache.
  reset();
  db.prepare(
    `INSERT INTO pipeline_runs (provider, repo_root, slug, run_json, events_offset, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("ai-conductor", "/repo/a", "readable", JSON.stringify({
    provider: "ai-conductor",
    repoRoot: "/repo/a",
    slug: "readable",
    worktree: null,
    tier: null,
    track: null,
    steps: [],
    lastStep: null,
    halt: null,
    group: "waiting",
    prUrl: null,
    costTokens: null,
    updatedAt: 1,
  }), 0, 1);
  // A provider id from a build that knows one this one does not.
  db.prepare(
    `INSERT INTO pipeline_runs (provider, repo_root, slug, run_json, events_offset, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("ai-conductor-2", "/repo/a", "future", '{"provider":"ai-conductor-2"}', 0, 1);
  // And one that is simply not JSON.
  db.prepare(
    `INSERT INTO pipeline_runs (provider, repo_root, slug, run_json, events_offset, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("ai-conductor", "/repo/a", "garbled", "{not json", 0, 1);

  assert.deepEqual(loadPipelineRuns().map((row) => row.run.slug), ["readable"]);
  const left = db
    .prepare(`SELECT slug FROM pipeline_runs ORDER BY slug`)
    .all() as unknown as Array<{ slug: string }>;
  assert.deepEqual(left.map((r) => r.slug), ["readable"]);
});

test("forgetting a repository is idempotent and touches no other repository's rows", async () => {
  reset();
  const kept = repo("forget-kept");
  const gone = repo("forget-gone");
  seedConductorRun(kept, "a", { steps: { build: "done" } });
  seedConductorRun(gone, "b", { steps: { build: "done" } });
  setPipelinesConfig({
    enabled: true,
    repos: [
      { provider: "ai-conductor", repoRoot: kept, enabled: true },
      { provider: "ai-conductor", repoRoot: gone, enabled: true },
    ],
  });

  const registry = new Registry();
  await refreshPipelineRepo(registry, "ai-conductor", kept);
  await refreshPipelineRepo(registry, "ai-conductor", gone);
  assert.equal(registry.listPipelineRuns().length, 2);

  forgetPipelineRepo(registry, "ai-conductor", gone);
  forgetPipelineRepo(registry, "ai-conductor", gone);
  assert.deepEqual(registry.listPipelineRuns().map((r) => r.slug), ["a"]);
});

test("an unreadable repository reports a reason rather than a clean empty list", async () => {
  // "The engine has nothing running here" and "we could not look" must not render as the
  // same page - the first is a fact and the second is a question for the operator.
  reset();
  const root = repo("unreadable");
  // A `.worktrees` that is a FILE, so the enumeration cannot walk it.
  writeFileSync(join(root, ".worktrees"), "not a directory");
  consentTo(root);

  const registry = new Registry();
  await refreshPipelineRepo(registry, "ai-conductor", root);
  assert.deepEqual(registry.listPipelineRuns(), []);
  const status = pipelineRepoStatuses().find((s) => s.repoRoot === root);
  assert.ok(status, "a consented repository always has a status row");
  assert.equal(status.runs, 0);
  assert.notEqual(status.lastReadAt, null, "a pass that ran says when, even seeing nothing");
  assert.match(String(status.error), /could not list/);
});

test("a pass that could not look retires nothing", async () => {
  // The expensive half of the distinction above, and the reason the reader reports null
  // rather than an empty list: a transient permission error on one directory would otherwise
  // delete a repository's whole projection and emit a remove for every run in it, then put
  // them all back on the next tick. "We could not look" is not "it is gone" - the same rule
  // the Inspector's poller holds about a `gh` that errored.
  reset();
  const root = repo("transiently-unreadable");
  seedConductorRun(root, "keep-me", { steps: { build: "in_progress" } });
  seedConductorDaemon(root, { pid: process.pid });
  consentTo(root);

  const registry = new Registry();
  await refreshPipelineRepo(registry, "ai-conductor", root);
  assert.equal(registry.listPipelineRuns().length, 1);

  // The directory becomes unlistable under the daemon's feet.
  const worktrees = join(root, ".worktrees");
  rmSync(worktrees, { recursive: true, force: true });
  writeFileSync(worktrees, "not a directory");

  const events: ServerEvent[] = [];
  registry.subscribe((event) => events.push(event));
  await refreshPipelineRepo(registry, "ai-conductor", root);

  assert.equal(registry.listPipelineRuns().length, 1, "the run must survive a failed look");
  assert.equal(loadPipelineRuns().length, 1, "and so must its row");
  assert.equal(events.length, 0, "nothing is told a run went away");
});
