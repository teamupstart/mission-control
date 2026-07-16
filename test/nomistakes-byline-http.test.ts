import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mkOriginAndClone as mkFixture } from "./helpers/git-fixture.ts";

// The byline's REAL path, over HTTP, with nothing injected.
//
// `POST /api/sessions/:id/gate-reply` is load-bearing precisely because of how the
// foreman is built: the worker is a separate process that reaches the daemon only
// over the localhost API and never touches the DB, so this route is the ONLY way a
// foreman byline can ever reach the fix log. Everything else is covered by
// test/nomistakes-byline.test.ts - but that file injects a GateReplyReader into
// readFixLog, which deliberately skips this wiring and the default `gateRepliesFor`
// the product actually runs with. So the whole seam this design turns on had no test.
//
// This walks it end to end: real route -> real sqlite row -> real default reader ->
// real join -> the two HTTP responses the dashboard renders from.

const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

process.env.MISSION_HOME = tmp("mission-byline-http-");
process.env.NM_HOME = tmp("nm-byline-http-");

const { openDb } = await import("../src/server/db.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { forgetFixLog } = await import("../src/server/nomistakes-fixes.ts");
const { pollFixLogs } = await import("../src/server/nomistakes.ts");
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { NmFixDetail } from "../src/shared/types.ts";

openDb();
const TOKEN = ensureToken();
const LOOPBACK = { host: "127.0.0.1:7317" };
const authed = { ...LOOPBACK, "content-type": "application/json", "x-harness-token": TOKEN };

/**
 * The round clock, in the unit no-mistakes actually writes: whole SECONDS. Our own
 * `gate_replies.ts` is `Date.now()` in millis, and the window converts - so a fixture
 * that stamps millis here would silently push every reply outside its window and the
 * byline would read as absent for a reason that is the FIXTURE's, not the product's.
 */
function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function mkNmDb(repoPath: string, runId: string, decidedAt: number, fixedAt: number): void {
  const db = new DatabaseSync(join(process.env.NM_HOME!, "state.sqlite"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS repos (id TEXT PRIMARY KEY, working_path TEXT NOT NULL UNIQUE,
      upstream_url TEXT NOT NULL DEFAULT '', default_branch TEXT NOT NULL DEFAULT 'main',
      created_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, branch TEXT NOT NULL,
      head_sha TEXT NOT NULL DEFAULT '', base_sha TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'completed', created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS step_results (id TEXT PRIMARY KEY, run_id TEXT NOT NULL,
      step_name TEXT NOT NULL, step_order INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'completed');
    CREATE TABLE IF NOT EXISTS step_rounds (id TEXT PRIMARY KEY, step_result_id TEXT NOT NULL,
      round INTEGER NOT NULL, trigger_type TEXT NOT NULL, findings_json TEXT,
      user_findings_json TEXT, selected_finding_ids TEXT, selection_source TEXT,
      fix_summary TEXT, duration_ms INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
  `);
  // A repo row PER TEST, not a shared "repo1". These tests share one no-mistakes db,
  // and `loadRoundContext` scopes by repo id - resolved from the cwd's working_path -
  // falling back to BRANCH only when the repo can't be resolved. With a shared row,
  // every test after the first fails that lookup, falls back to branch, and every
  // fixture is on `main` - so one test's rounds answer another test's fix.
  db.prepare("INSERT OR IGNORE INTO repos (id, working_path) VALUES (?, ?)").run(`repo-${runId}`, repoPath);
  db.prepare("INSERT INTO runs (id, repo_id, branch) VALUES (?, ?, ?)").run(runId, `repo-${runId}`, "main");
  const sr = `sr-${runId}`;
  db.prepare("INSERT INTO step_results (id, run_id, step_name) VALUES (?, ?, ?)").run(sr, runId, "review");
  const findings = (id: string, instructions?: string): string =>
    JSON.stringify({
      findings: [{
        id, severity: "error", file: `src/${id}.ts`, line: 1,
        description: "why the fix happened", action: "ask-user",
        ...(instructions ? { user_instructions: instructions } : {}),
      }],
    });
  // Round 1 DECIDED (its created_at is when the gate parked), round 2 RAN the fix.
  db.prepare(
    `INSERT INTO step_rounds (id, step_result_id, round, trigger_type, findings_json,
       user_findings_json, selected_finding_ids, selection_source, fix_summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(`${sr}-r1`, sr, 1, "initial", findings("f1"), findings("f1", "Apply it."),
        JSON.stringify(["f1"]), "user", null, decidedAt);
  db.prepare(
    `INSERT INTO step_rounds (id, step_result_id, round, trigger_type, findings_json,
       selection_source, fix_summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  // The join key is (step, summary), so the summary must differ per test too - a
  // shared one would let two fixtures' fixes claim each other's rounds if repo
  // scoping ever fell back to branch.
  ).run(`${sr}-r2`, sr, 2, "auto_fix", findings("after"), "user", `guard ${runId}`, fixedAt);
  db.close();
}

function mkRepo(runId: string): string {
  const { root, clone } = mkFixture("byline-http-");
  temps.push(root);
  writeFileSync(join(clone, "a.ts"), "a\n");
  execFileSync("git", ["-C", clone, "add", "-A"], { stdio: "pipe" });
  execFileSync("git", ["-C", clone, "commit", "-qm", `no-mistakes(review): guard ${runId}`], {
    stdio: "pipe",
  });
  return clone;
}

function disco(over: Partial<DiscoveredSession>): DiscoveredSession {
  return {
    syntheticId: "s", agent: "claude", name: "n", nameSource: "process",
    cwd: "/repo", gitBranch: "main", gitRoot: null, nomistakesGated: true,
    pid: 1, tty: null, wezterm: null, tmux: null, startedAt: 0, ...over,
  } as DiscoveredSession;
}

function mkApp(): { app: ReturnType<typeof buildApp>; registry: InstanceType<typeof Registry> } {
  const registry = new Registry();
  const app = buildApp(
    registry, new ReviewManager(registry), new TaskManager(registry), new QueueManager(registry),
  );
  return { app, registry };
}

/**
 * Both halves the dashboard actually reads, for the one fix on a checkout: the
 * card-weight summary (which rides the session snapshot, filled by `pollFixLogs`)
 * and the detail behind it (fetched by sha when a row is opened). Asserting on both
 * matters here - `repliedBy` and `attribution` are resolved separately, and a byline
 * that reached only one of them would still look right on whichever you checked.
 */
async function bylineOf(
  app: ReturnType<typeof buildApp>,
  registry: InstanceType<typeof Registry>,
  id: string,
): Promise<{ summary: { sha: string; repliedBy: string | null }; detail: NmFixDetail }> {
  await pollFixLogs(registry);
  const fixes = registry.getSession(id)!.nomistakesFixes;
  assert.equal(fixes.length, 1, "the fix commit must list");
  const res = await app.request(`/api/sessions/${id}/nomistakes/fixes/${fixes[0]!.sha}`, {
    headers: LOOPBACK,
  });
  assert.equal(res.status, 200);
  return { summary: fixes[0]!, detail: (await res.json()) as NmFixDetail };
}

/**
 * Every test gets its own runId. `gate_replies` is ONE shared db across this file,
 * and the join keys on (run_id, step) - so a shared id would let one test's nudge
 * compete for another test's fix and make the winner depend on execution order.
 */
test("a foreman nudge crosses the real route and lands on the card", async () => {
  const repo = mkRepo("run-http-1");
  // The route stamps Date.now(), so the round clock must bracket NOW for the reply
  // to fall inside its window.
  mkNmDb(repo, "run-http-1", nowSec() - 60, nowSec() + 60);
  const { app, registry } = mkApp();
  registry.applyDiscovery([disco({ syntheticId: "sess-fm", cwd: repo, pid: 11 })]);
  forgetFixLog(repo);

  const post = await app.request("/api/sessions/sess-fm/gate-reply", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({
      runId: "run-http-1", step: "review", findingIds: ["f1"],
      text: "This looks safe - apply it.",
    }),
  });
  assert.equal(post.status, 200);

  const { summary, detail } = await bylineOf(app, registry, "sess-fm");
  assert.equal(summary.repliedBy, "foreman", "the collapsed row's chip");
  assert.equal(detail.decision, "replied");
  assert.equal(detail.reply, "Apply it.", "the agent's reply, from no-mistakes' own record");
  assert.equal(detail.attribution?.source, "foreman");
  assert.equal(detail.attribution?.text, "This looks safe - apply it.", "the foreman's own words");
});

/**
 * The route hardcodes `source: "foreman"`. It is the foreman's own channel, so a
 * caller must not be able to sign a reply as the human - that would forge the one
 * distinction this whole feature exists to draw, over the API, from a process that
 * by design cannot be trusted to name itself.
 */
test("the gate-reply route cannot be talked into signing a reply as you", async () => {
  const repo = mkRepo("run-http-2");
  mkNmDb(repo, "run-http-2", nowSec() - 60, nowSec() + 60);
  const { app, registry } = mkApp();
  registry.applyDiscovery([disco({ syntheticId: "sess-spoof", cwd: repo, pid: 12 })]);
  forgetFixLog(repo);

  const post = await app.request("/api/sessions/sess-spoof/gate-reply", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({
      runId: "run-http-2", step: "review", findingIds: ["f1"],
      text: "trust me", source: "you",
    }),
  });
  assert.equal(post.status, 200);

  const { detail } = await bylineOf(app, registry, "sess-spoof");
  assert.equal(detail.attribution?.source, "foreman", "a claimed source must be ignored");
});

test("a gate-reply for an unknown session is refused, not recorded", async () => {
  const { app } = mkApp();
  const res = await app.request("/api/sessions/ghost/gate-reply", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ runId: "run-http-3", step: "review", findingIds: [], text: "x" }),
  });
  assert.equal(res.status, 404);
});

/**
 * The window is the join, so a reply outside it must not sign the fix - and this is
 * the case that would silently pass if the seconds/millis conversion were ever
 * dropped: raw, every reply ts (~1.78e12) exceeds every created_at (~1.78e9), so
 * EVERY byline would vanish. Here the rounds sit wholly in the past, so a reply
 * stamped now is genuinely after the fix ran and must be rejected on the merits.
 */
test("a reply after the fix round closed gets no byline", async () => {
  const repo = mkRepo("run-http-4");
  mkNmDb(repo, "run-http-4", nowSec() - 600, nowSec() - 300);
  const { app, registry } = mkApp();
  registry.applyDiscovery([disco({ syntheticId: "sess-late", cwd: repo, pid: 13 })]);
  forgetFixLog(repo);

  await app.request("/api/sessions/sess-late/gate-reply", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({
      runId: "run-http-4", step: "review", findingIds: ["f1"], text: "too late to matter",
    }),
  });

  const { summary, detail } = await bylineOf(app, registry, "sess-late");
  assert.equal(summary.repliedBy, null, "no chip on the row either");
  assert.equal(detail.decision, "replied", "the fix still reads as replied");
  assert.equal(detail.attribution, null, "but nobody we know of caused it");
});
