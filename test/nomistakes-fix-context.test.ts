import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// The join from a fix commit to the round that explains it.
//
// This reads no-mistakes' PRIVATE schema, so the shape is pinned here against a
// database built to match the real one (verified against live data at
// ~/.no-mistakes/state.sqlite). If no-mistakes moves the schema, these fail -
// which is the point: they're the tripwire for the coupling the plan calls out.

process.env.NM_HOME = realpathSync(mkdtempSync(join(tmpdir(), "nm-home-")));

const { readFixLog, forgetFixLog } = await import("../src/server/nomistakes-fixes.ts");

/**
 * no-mistakes' schema, trimmed to the columns the join reads. Each call gets its
 * own NM_HOME so the tests can't leak state into each other - the module reads
 * the env var per lookup, so re-pointing it is enough.
 */
function mkNmDb(repoPath: string, branch: string): DatabaseSync {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "nm-home-")));
  process.env.NM_HOME = home;
  const db = new DatabaseSync(join(home, "state.sqlite"));
  db.exec(`
    CREATE TABLE repos (id TEXT PRIMARY KEY, working_path TEXT NOT NULL UNIQUE,
      upstream_url TEXT NOT NULL DEFAULT '', default_branch TEXT NOT NULL DEFAULT 'main',
      created_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE runs (id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, branch TEXT NOT NULL,
      head_sha TEXT NOT NULL DEFAULT '', base_sha TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'completed', created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE step_results (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_name TEXT NOT NULL,
      step_order INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'completed');
    CREATE TABLE step_rounds (id TEXT PRIMARY KEY, step_result_id TEXT NOT NULL, round INTEGER NOT NULL,
      trigger_type TEXT NOT NULL, findings_json TEXT, user_findings_json TEXT,
      selected_finding_ids TEXT, selection_source TEXT, fix_summary TEXT,
      duration_ms INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
  `);
  db.prepare("INSERT INTO repos (id, working_path) VALUES (?, ?)").run("repo1", repoPath);
  db.prepare("INSERT INTO runs (id, repo_id, branch) VALUES (?, ?, ?)").run("run1", "repo1", branch);
  return db;
}

function findings(...items: Array<{ id: string; desc: string; instructions?: string }>): string {
  return JSON.stringify({
    findings: items.map((i) => ({
      id: i.id,
      severity: "error",
      file: `src/${i.id}.ts`,
      line: 10,
      description: i.desc,
      action: "auto-fix",
      ...(i.instructions ? { user_instructions: i.instructions } : {}),
    })),
  });
}

function mkRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fixctx-")));
  const origin = join(root, "origin");
  execFileSync("git", ["init", "-q", origin]);
  const og = (...a: string[]) => execFileSync("git", ["-C", origin, ...a], { stdio: "pipe" });
  og("branch", "-M", "main");
  og("config", "user.email", "t@test");
  og("config", "user.name", "t");
  writeFileSync(join(origin, "keep.txt"), "base\n");
  og("add", "-A");
  og("commit", "-qm", "base");
  const clone = join(root, "clone");
  execFileSync("git", ["clone", "-q", origin, clone]);
  execFileSync("git", ["-C", clone, "config", "user.email", "t@test"]);
  execFileSync("git", ["-C", clone, "config", "user.name", "t"]);
  return clone;
}

function commit(cwd: string, file: string, subject: string): void {
  writeFileSync(join(cwd, file), `${file}\n`);
  execFileSync("git", ["-C", cwd, "add", "-A"], { stdio: "pipe" });
  execFileSync("git", ["-C", cwd, "commit", "-qm", subject], { stdio: "pipe" });
}

/**
 * THE bug this whole module turns on. A round records the findings IT produced,
 * so the round carrying a fix_summary is the round that RAN the fix - its own
 * findings are the re-review afterwards, i.e. the justification for the NEXT fix.
 * What caused this commit is on round-1.
 *
 * Live proof: commit "fix(queue): queues survive a restart" sits on round 2,
 * whose findings are 13 with the reply "fix all thirteen". It was actually caused
 * by round 1's 4 findings and "apply all four". Attributing round 2's own context
 * looks entirely plausible and is wrong.
 */
test("a fix takes the PRECEDING round's findings and reply, not its own", async () => {
  const repo = mkRepo();
  const db = mkNmDb(repo, "main");
  db.prepare("INSERT INTO step_results (id, run_id, step_name) VALUES (?, ?, ?)").run("sr1", "run1", "review");

  // Round 1: reviewed, found 4, and the human said "apply all four".
  db.prepare(
    `INSERT INTO step_rounds (id, step_result_id, round, trigger_type, findings_json,
       user_findings_json, selected_finding_ids, selection_source, fix_summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "rd1", "sr1", 1, "initial",
    findings({ id: "caused-it", desc: "This is why the fix happened." }),
    findings({ id: "caused-it", desc: "This is why the fix happened.", instructions: "Apply all four." }),
    JSON.stringify(["caused-it"]), "user", null, 100,
  );
  // Round 2: RAN the fix (hence fix_summary), then re-reviewed and found new ones.
  db.prepare(
    `INSERT INTO step_rounds (id, step_result_id, round, trigger_type, findings_json,
       user_findings_json, selection_source, fix_summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "rd2", "sr1", 2, "auto_fix",
    findings({ id: "found-after", desc: "Discovered by the re-review AFTER the fix." }),
    findings({ id: "found-after", desc: "Discovered by the re-review AFTER the fix.", instructions: "Fix all thirteen." }),
    "user", "fix the guard", 200,
  );
  db.close();

  commit(repo, "b.ts", "no-mistakes(review): fix the guard");
  forgetFixLog(repo);
  const log = await readFixLog(repo);

  const detail = log.details.get(log.summaries[0]!.sha)!;
  assert.equal(detail.decision, "replied");
  assert.equal(detail.reply, "Apply all four.", "the reply that CAUSED the fix, not the next one");
  assert.deepEqual(
    detail.findings.map((f) => f.id),
    ["caused-it"],
    "round 2's own findings are the re-review, and must not be the justification",
  );
});

/**
 * `document` and `lint` do their work on first execution, so the findings and the
 * fix come from the same call and there is no earlier round to consult. Skipping
 * these (an obvious `round >= 2` guard) silently drops context for every doc and
 * lint fix - live data has 22 such rounds.
 */
test("a round-1 fix uses its own findings and reads as auto-fixed", async () => {
  const repo = mkRepo();
  const db = mkNmDb(repo, "main");
  db.prepare("INSERT INTO step_results (id, run_id, step_name) VALUES (?, ?, ?)").run("sr2", "run1", "document");
  db.prepare(
    `INSERT INTO step_rounds (id, step_result_id, round, trigger_type, findings_json,
       selection_source, fix_summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "rd3", "sr2", 1, "initial",
    findings({ id: "doc-gap", desc: "The chord table is out of date." }),
    null, "sync the docs", 300,
  );
  db.close();

  commit(repo, "docs.md", "no-mistakes(document): sync the docs");
  forgetFixLog(repo);
  const log = await readFixLog(repo);

  const detail = log.details.get(log.summaries[0]!.sha)!;
  assert.equal(detail.decision, "auto", "nobody was asked");
  assert.equal(detail.reply, null);
  assert.deepEqual(detail.findings.map((f) => f.id), ["doc-gap"]);
});

/** An auto-fix round reports more than it fixes, so narrow to what it selected. */
test("an auto-fix carries only the findings it actually selected", async () => {
  const repo = mkRepo();
  const db = mkNmDb(repo, "main");
  db.prepare("INSERT INTO step_results (id, run_id, step_name) VALUES (?, ?, ?)").run("sr3", "run1", "review");
  db.prepare(
    `INSERT INTO step_rounds (id, step_result_id, round, trigger_type, findings_json,
       selected_finding_ids, selection_source, fix_summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "rd4", "sr3", 1, "initial",
    findings(
      { id: "fixed-one", desc: "Mechanical, auto-fixable." },
      { id: "left-alone", desc: "Reported but not selected for this fix." },
    ),
    JSON.stringify(["fixed-one"]), "auto_fix", null, 400,
  );
  db.prepare(
    `INSERT INTO step_rounds (id, step_result_id, round, trigger_type, fix_summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("rd5", "sr3", 2, "auto_fix", "drop the unused import", 500);
  db.close();

  commit(repo, "c.ts", "no-mistakes(review): drop the unused import");
  forgetFixLog(repo);
  const log = await readFixLog(repo);

  const detail = log.details.get(log.summaries[0]!.sha)!;
  assert.equal(detail.decision, "auto");
  assert.deepEqual(detail.findings.map((f) => f.id), ["fixed-one"]);
});

/**
 * A fix commit outlives the branch it was made on - `axi run` rebases and
 * branches get renamed - so the round explaining a commit is often filed under an
 * older branch. Verified live: "fix(queue): drafts surface" sits on
 * session-work-queue-impl but its round is under cite-idle-nudge-evidence.
 * Branch-scoping the lookup lost context for two thirds of a real branch's fixes.
 */
test("context is found even when the round was recorded on another branch", async () => {
  const repo = mkRepo();
  const db = mkNmDb(repo, "an-older-branch"); // NOT the branch we're on now
  db.prepare("INSERT INTO step_results (id, run_id, step_name) VALUES (?, ?, ?)").run("sr4", "run1", "review");
  db.prepare(
    `INSERT INTO step_rounds (id, step_result_id, round, trigger_type, findings_json,
       user_findings_json, selection_source, fix_summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "rd6", "sr4", 1, "initial",
    findings({ id: "carried", desc: "Found on the branch this fix was born on." }),
    findings({ id: "carried", desc: "Found on the branch this fix was born on.", instructions: "Carry it over." }),
    "user", null, 600,
  );
  db.prepare(
    `INSERT INTO step_rounds (id, step_result_id, round, trigger_type, fix_summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("rd7", "sr4", 2, "auto_fix", "carried across a rebase", 700);
  db.close();

  execFileSync("git", ["-C", repo, "checkout", "-qb", "a-newer-branch"]);
  commit(repo, "d.ts", "no-mistakes(review): carried across a rebase");
  forgetFixLog(repo);
  const log = await readFixLog(repo);

  const detail = log.details.get(log.summaries[0]!.sha)!;
  assert.equal(detail.reply, "Carry it over.", "the round is filed under the old branch");
  assert.deepEqual(detail.findings.map((f) => f.id), ["carried"]);
});

/**
 * The read must cost what the BRANCH is, not what the repo's history is. A repo
 * accumulates fix rounds forever (67 already, live) while a branch carries a
 * handful, and each round drags ~20KB of json - so resolving every round in the
 * repo to explain six commits gets steadily worse as the repo ages.
 *
 * Asserted through behaviour rather than by counting queries: rounds belonging to
 * commits that aren't on this branch must not end up in the log at all.
 */
test("context is read for this branch's fixes, not the repo's whole history", async () => {
  const repo = mkRepo();
  const db = mkNmDb(repo, "main");
  const addStep = db.prepare("INSERT INTO step_results (id, run_id, step_name) VALUES (?, ?, ?)");
  const addRound = db.prepare(
    `INSERT INTO step_rounds (id, step_result_id, round, trigger_type, findings_json,
       selection_source, fix_summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // 30 past runs in the same repo, each with its own review step that committed a
  // fix - the shape a long-lived repo actually accumulates. None on this branch.
  for (let i = 0; i < 30; i++) {
    addStep.run(`sr-old-${i}`, "run1", "review");
    addRound.run(`old${i}`, `sr-old-${i}`, 1, "initial",
      findings({ id: `old-${i}`, desc: "ancient history" }), null, `an old fix number ${i}`, 1000 + i);
  }
  // ...and the one round that explains the single commit we actually have.
  addStep.run("sr-cur", "run1", "review");
  addRound.run("cur", "sr-cur", 1, "initial",
    findings({ id: "current", desc: "why this one happened" }), null,
    "the only fix on this branch", 2000);
  db.close();

  commit(repo, "g.ts", "no-mistakes(review): the only fix on this branch");
  forgetFixLog(repo);
  const log = await readFixLog(repo);

  assert.equal(log.summaries.length, 1);
  const detail = log.details.get(log.summaries[0]!.sha)!;
  assert.deepEqual(detail.findings.map((f) => f.id), ["current"]);
  // The 30 unrelated rounds resolve to nothing - they aren't fixes on this branch.
  assert.equal(log.details.size, 1, "only the branch's own fixes are in the log");
});

/**
 * The card states how many findings justified a fix. That number has to be the
 * real one even when the detail stops carrying their text, or a 50-finding fix
 * quietly reads as a 40-finding one.
 */
test("findingCount is the true count even when the carried list is capped", async () => {
  const repo = mkRepo();
  const db = mkNmDb(repo, "main");
  db.prepare("INSERT INTO step_results (id, run_id, step_name) VALUES (?, ?, ?)").run("sr9", "run1", "review");
  // 45 findings, above the 40 the module carries.
  const many = Array.from({ length: 45 }, (_, i) => ({ id: `f${i}`, desc: `finding number ${i}` }));
  db.prepare(
    `INSERT INTO step_rounds (id, step_result_id, round, trigger_type, findings_json,
       selection_source, fix_summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("rd9", "sr9", 1, "initial", findings(...many), null, "fix the pile", 900);
  db.close();

  commit(repo, "f.ts", "no-mistakes(review): fix the pile");
  forgetFixLog(repo);
  const log = await readFixLog(repo);

  const detail = log.details.get(log.summaries[0]!.sha)!;
  assert.equal(detail.findingCount, 45, "the count must not be capped");
  assert.equal(detail.findings.length, 40, "the carried list is capped");
  assert.equal(log.summaries[0]!.findingCount, 45, "the row agrees with the detail");
});

/** A commit whose round is gone still lists - the log degrades, never vanishes. */
test("a fix with no matching round lists without context", async () => {
  const repo = mkRepo();
  const db = mkNmDb(repo, "main");
  db.close(); // no rounds at all

  commit(repo, "e.ts", "no-mistakes(review): nobody remembers why");
  forgetFixLog(repo);
  const log = await readFixLog(repo);

  assert.equal(log.summaries.length, 1);
  assert.equal(log.summaries[0]!.decision, null);
  assert.equal(log.summaries[0]!.findingCount, 0);
  assert.equal(log.details.get(log.summaries[0]!.sha)!.reply, null);
  // The git side is still fully intact.
  assert.equal(log.summaries[0]!.summary, "nobody remembers why");
  assert.equal(log.summaries[0]!.filesChanged, 1);
});
