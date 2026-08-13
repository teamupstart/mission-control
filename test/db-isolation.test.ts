import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// What is at stake: the operator's real settings database.
//
// A test file that imports server modules without redirecting the state dir first gets
// `~/.mission-control/harness.db` - silently. One such test on a feature branch ran
// `DELETE FROM app_config` in its beforeEach and wiped every saved setting on the
// developer's machine each time the suite ran; the Foreman looked "switched off" and
// nothing pointed back at the test. Fixture rows named `w`, `v` and `full-1` from
// `workflow-inspector-bypass.test.ts` were later found sitting in that same database.
//
// Two things now stand between a test and that outcome, and this file pins both from the
// outside - through real child processes, with a jailed `HOME`, so a regression in either
// scribbles on a scratch home rather than the developer's:
//
//   1. `test/setup-state.mjs`, preloaded by every `node --test` command the repo publishes,
//      hands each worker a disposable state dir before its imports run. A file that sets
//      nothing is isolated anyway, and one that sets its own home still wins.
//   2. `openDb`'s refusal, which catches what a preloader cannot - a command that never
//      loaded it, an override set after `config.ts` froze the path, an override pointing
//      somewhere real, and a late change hiding behind an already-open connection.
//
// The bootstrap is deliberately NOT trusted to make the guard's cases unreachable, and the
// guard is deliberately not trusted to make the bootstrap redundant. Each is tested on its
// own, because the whole point of having two is that either one can be broken alone.

const home = mkdtempSync(join(tmpdir(), "mission-db-isolation-"));
after(() => rmSync(home, { recursive: true, force: true }));

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Import the server graph the way a test file does, open the db, and report what happened.
 *
 * The report comes from INSIDE the child because a bootstrap dir does not survive the
 * process that owns it - the parent asking `existsSync` afterwards is asking about a
 * directory the exit hook has already removed, and would read correct isolation as a
 * missing database.
 */
const OPEN_AND_REPORT = `
  const { existsSync } = await import("node:fs");
  const { STATE_DIR, DB_PATH } = await import("./src/server/config.ts");
  const { openDb } = await import("./src/server/db.ts");
  openDb();
  console.log(JSON.stringify({ stateDir: STATE_DIR, opened: existsSync(DB_PATH) }));
`;

type ChildResult = { status: number; stdout: string; stderr: string };

/**
 * Run `script` in a child that believes it is a test worker.
 *
 * `HOME` is jailed into the temp dir so that if either layer regresses, the child scribbles
 * on a scratch home rather than the real one - a test must never rely on the very guard it
 * is checking. Every home alias is stripped from the inherited environment first, because
 * this file's own worker has a bootstrap home of its own and inheriting it would hide
 * exactly the omission most of these cases are about. `NODE_TEST_CONTEXT` is what
 * `node --test` sets in every test child; stating it explicitly keeps the child honest
 * about what it simulates.
 *
 * `bootstrap` decides which of the two layers is under test: with it, the child is a worker
 * launched by the repo's commands; without it, a worker launched some other way, where only
 * the refusal stands between the import and live state.
 */
function runChild(
  script: string,
  extraEnv: Record<string, string> = {},
  opts: { bootstrap?: boolean } = {},
): ChildResult {
  const env: Record<string, string | undefined> = {
    ...process.env,
    NODE_TEST_CONTEXT: "child-v8",
    HOME: home,
  };
  delete env.MISSION_HOME;
  delete env.FLEET_HOME;
  delete env.HARNESS_HOME;
  Object.assign(env, extraEnv);

  const args = [
    ...(opts.bootstrap ? ["--import", "./test/setup-state.mjs"] : []),
    "--import",
    "tsx",
    "--input-type=module",
    "-e",
    script,
  ];
  try {
    const stdout = execFileSync(process.execPath, args, {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") };
  }
}

/**
 * The state dir a child opened its database in - the claim every accepting case turns on.
 *
 * `opened` is asserted here rather than at each call site so no case can pass on a child
 * that resolved a plausible path and never actually reached SQLite.
 */
function openedStateDir(res: ChildResult): string {
  assert.equal(res.status, 0, res.stderr);
  const line = res.stdout.trim().split("\n").filter(Boolean).at(-1);
  assert.ok(line, `the child reported nothing\n${res.stdout}\n${res.stderr}`);
  const report = JSON.parse(line) as { stateDir: string; opened: boolean };
  assert.equal(report.opened, true, `no database was created in ${report.stateDir}`);
  return report.stateDir;
}

// ---- the refusal, on its own ------------------------------------------------

test("a test that never redirected the state dir cannot open the real db", () => {
  const res = runChild(OPEN_AND_REPORT);
  assert.notEqual(res.status, 0, "the open must fail, not fall through to the home dir");
  assert.match(res.stderr, /real\s+state dir/i);
  assert.equal(
    existsSync(join(home, ".mission-control")),
    false,
    "the refusal must come before anything is created",
  );
});

test("an override set the documented way opens exactly where it points", () => {
  const state = join(home, "state");
  assert.equal(openedStateDir(runChild(OPEN_AND_REPORT, { HARNESS_HOME: state })), state);
  assert.equal(existsSync(join(state, "harness.db")), true, "the db did not outlive the child");
});

test("an override that names the operator's own state dir is refused", () => {
  // The alias is explicit and the path is even inside the jailed home, so this clears the
  // "did you set anything?" bar and every temp-dir test in this file. What it names is the
  // one directory that must never be opened from a test - under any of the names the app
  // has shipped, because `envVar` still resolves the old ones and an operator upgrading
  // from `.fleet-control` has their live database sitting under that name.
  for (const name of [".mission-control", ".fleet-control", ".ai-harness"]) {
    const operator = join(home, name);
    const res = runChild(OPEN_AND_REPORT, { MISSION_HOME: operator });
    assert.notEqual(res.status, 0, `${name} was opened`);
    assert.match(res.stderr, /real\s+state dir/i);
    assert.equal(existsSync(operator), false, `${name} was created before the refusal`);
  }
});

test("an override outside the temp dir is refused even though it is explicit", () => {
  // A throwaway `$TMPDIR` is what makes this honest: the refused path is a perfectly
  // ordinary directory, not an operator-looking one, and it fails purely because it is
  // somewhere durable. That is the case that catches a fixture home pointed at a checkout,
  // a shared scratch dir, or anywhere else a test's leavings would outlive the run.
  const tmproot = join(home, "elsewhere-tmp");
  mkdirSync(tmproot, { recursive: true });

  // The second path is the same claim asked the way it actually gets asked wrong. It is NOT
  // inside the temp root - `elsewhere-tmp-sibling` is a different directory from
  // `elsewhere-tmp` - but it does start with the temp root's characters, so containment
  // written as a bare `startsWith` waves it through. Sibling directories whose names are
  // prefixes of each other is not an exotic input here; it is what `mkdtempSync` hands to
  // concurrent workers all day.
  for (const [why, durable] of [
    ["a durable directory", join(home, "durable-state")],
    ["a sibling of the temp root", join(home, "elsewhere-tmp-sibling", "state")],
  ] as const) {
    const res = runChild(OPEN_AND_REPORT, { TMPDIR: tmproot, MISSION_HOME: durable });
    assert.notEqual(res.status, 0, `${why} was opened`);
    assert.match(res.stderr, /not a disposable test state dir/, why);
    assert.equal(existsSync(durable), false, `${why} was created before the refusal`);
  }
});

test("an override that is merely a prefix of the frozen state dir is refused", () => {
  // The old guard asked `DB_PATH.startsWith(override)`, which is not the question. Freeze
  // the path in `…-state-10`, then name `…-state-1`: the string test says yes, and the
  // process goes on writing into a state dir it no longer names - another worker's, if the
  // two came from the same `mkdtempSync` run. Path equality is the only form of this check
  // that means what it says.
  const frozen = join(home, "sibling-state-10");
  const prefix = join(home, "sibling-state-1");
  const res = runChild(
    `
      process.env.HARNESS_HOME = ${JSON.stringify(frozen)};
      const { openDb } = await import("./src/server/db.ts");
      openDb();
      process.env.MISSION_HOME = ${JSON.stringify(prefix)};
      try { openDb(); console.log("accepted"); } catch (err) { console.log("refused:" + err.message); }
    `,
    {},
    { bootstrap: true },
  );

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /refused:refusing to open .*frozen against a different state dir/);
  assert.doesNotMatch(res.stdout, /\naccepted\n/, "a prefix of the frozen path was accepted");
  assert.equal(existsSync(prefix), false, `${prefix} was created despite the refusal`);
});

test("an override set after the path resolved is refused, singleton or not", () => {
  // Two shapes of the same mistake, and the second is the one that survived the old guard.
  //
  // The first is an import ordering slip: something pulled `config.ts` in above the
  // preamble, the path froze against the bootstrap's dir, and the override that follows is
  // an alibi rather than isolation - every write still lands where the path was frozen.
  //
  // The second is worse, because it looks like it worked. The db is already open, so a
  // second `openDb()` used to hand back the cached handle without checking anything: the
  // test redirects itself, sees no error, and keeps writing into the previous state dir.
  // That is why the check runs BEFORE the singleton return.
  const late = join(home, "late-override");
  const second = join(home, "second-override");
  const res = runChild(
    `
      const { openDb } = await import("./src/server/db.ts");
      process.env.MISSION_HOME = ${JSON.stringify(late)};
      try { openDb(); } catch (err) { console.log("first:" + err.message); }

      delete process.env.MISSION_HOME;
      openDb();
      console.log("opened");

      process.env.MISSION_HOME = ${JSON.stringify(second)};
      try { openDb(); console.log("cached"); } catch (err) { console.log("second:" + err.message); }
    `,
    {},
    { bootstrap: true },
  );

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /first:refusing to open .*frozen against a different state dir/);
  assert.match(res.stdout, /\nopened\n/, "the bootstrap's own home must still open normally");
  assert.match(res.stdout, /second:refusing to open .*frozen against a different state dir/);
  assert.doesNotMatch(res.stdout, /\ncached\n/, "an open connection let a late override through");
  for (const dir of [late, second]) {
    assert.equal(existsSync(dir), false, `${dir} was created despite the refusal`);
  }
});

// ---- the bootstrap ----------------------------------------------------------

test("a worker that sets nothing is isolated by the bootstrap alone", () => {
  const state = openedStateDir(runChild(OPEN_AND_REPORT, {}, { bootstrap: true }));

  assert.match(state, /mission-test-state-/, "the worker did not land in a bootstrap dir");
  assert.ok(state.startsWith(tmpdir()), `${state} is not under ${tmpdir()}`);
  assert.equal(
    existsSync(join(home, ".mission-control")),
    false,
    "the operator's state dir must not be touched",
  );
});

test("the bootstrap dir is removed when the worker exits", () => {
  // The disposability is the whole claim. A bootstrap that leaked a directory per test file
  // would put 596 databases in the temp dir on every run.
  const state = openedStateDir(runChild(OPEN_AND_REPORT, {}, { bootstrap: true }));
  assert.equal(existsSync(state), false, `${state} outlived the worker that made it`);
});

test("two workers never share a fallback state dir", () => {
  // Files run concurrently, so a shared fallback would mean one file's fixture rows showing
  // up in another's queries - the same class of failure as the operator db, one step in.
  const first = openedStateDir(runChild(OPEN_AND_REPORT, {}, { bootstrap: true }));
  const second = openedStateDir(runChild(OPEN_AND_REPORT, {}, { bootstrap: true }));
  assert.notEqual(first, second);
});

test("the bootstrap clears the two aliases that would outrank it", () => {
  // `envVar` reads MISSION_ then FLEET_ then HARNESS_, so an inherited value under either of
  // the first two silently outranks the fallback. Both paths below are inside the jailed
  // home and therefore inside the temp dir, so the guard would happily accept either one -
  // this passes only if the bootstrap actually removed them, not because something else
  // refused them afterwards.
  const inheritedMission = join(home, "inherited-mission");
  const inheritedFleet = join(home, "inherited-fleet");
  const state = openedStateDir(
    runChild(
      OPEN_AND_REPORT,
      { MISSION_HOME: inheritedMission, FLEET_HOME: inheritedFleet },
      { bootstrap: true },
    ),
  );

  assert.match(state, /mission-test-state-/);
  for (const dir of [inheritedMission, inheritedFleet]) {
    assert.equal(existsSync(dir), false, `${dir} outranked the worker's own state dir`);
  }
});

// ---- precedence: a file's own home still wins -------------------------------

for (const alias of ["MISSION_HOME", "FLEET_HOME", "HARNESS_HOME"] as const) {
  test(`a file-local ${alias} still owns the state dir under the bootstrap`, () => {
    // The compatibility contract for the 225 files that seed their own home, and the reason
    // the bootstrap seeds the LOWEST-priority alias: `HARNESS_HOME` is the one 128 of those
    // files use, so a bootstrap that claimed MISSION_HOME would outrank them. It did, in an
    // early cut, and it took the hand-built pre-migration database out from under
    // `workflow-check-provider-column.test.ts` - which is the canary rerun beside this file.
    const fixture = join(home, `fixture-${alias}`);
    const res = runChild(
      `process.env.${alias} = ${JSON.stringify(fixture)};\n${OPEN_AND_REPORT}`,
      {},
      { bootstrap: true },
    );

    assert.equal(openedStateDir(res), fixture);
    assert.equal(existsSync(join(fixture, "harness.db")), true, "the fixture db did not survive");
  });
}
