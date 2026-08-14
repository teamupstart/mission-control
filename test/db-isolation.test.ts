import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
 *
 * `spec` runs a real `node --test` worker over a file instead of evaluating `script`, for the
 * one case that turns on what the RUNNER hands its children rather than on what this file can
 * set by hand.
 */
function runChild(
  script: string,
  extraEnv: Record<string, string> = {},
  opts: { bootstrap?: boolean; spec?: string } = {},
): ChildResult {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home };
  delete env.MISSION_HOME;
  delete env.FLEET_HOME;
  delete env.HARNESS_HOME;
  // Without `bootstrap`, the child must look like a worker that never met the preload at
  // all - which means dropping the capture this worker's own preload put in the environment
  // for its children. Inheriting it would quietly supply the very context the case is about
  // not having.
  if (!opts.bootstrap) delete env.MISSION_TEST_STATE;
  // A real runner must NOT inherit this: `node --test` reads it to decide whether it is
  // itself a spawned worker, so handing it to the parent stops it behaving as the runner.
  // Everywhere else the child IS the simulated worker, so it is stated explicitly.
  if (opts.spec) delete env.NODE_TEST_CONTEXT;
  else env.NODE_TEST_CONTEXT = "child-v8";
  Object.assign(env, extraEnv);

  const args = [
    ...(opts.spec ? ["--test"] : []),
    ...(opts.bootstrap ? ["--import", "./test/setup-state.mjs"] : []),
    "--import",
    "tsx",
    ...(opts.spec ? [opts.spec] : ["--input-type=module", "-e", script]),
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
  // The documented way is INSIDE the file, at the top, above the imports - which is after
  // the preload has run. That distinction now carries weight: a home arriving through the
  // environment was set before the preload and is therefore indistinguishable from an
  // operator's configured state dir, so the preload records it as one. All 225 fixture files
  // set theirs in the file body, which is the shape reproduced here.
  const state = join(home, "state");
  const res = runChild(
    `process.env.HARNESS_HOME = ${JSON.stringify(state)};\n${OPEN_AND_REPORT}`,
    {},
    { bootstrap: true },
  );
  assert.equal(openedStateDir(res), state);
  assert.equal(existsSync(join(state, "harness.db")), true, "the db did not outlive the child");
});

test("a disposable-looking home is still refused when nothing captured the machine", () => {
  // The honest limit of a path-shaped check. `<temp>/state` is what a fixture home looks
  // like AND what an operator looks like who runs the daemon with `MISSION_HOME` pointing
  // into the temp dir - explicit, resolving, under a temp root, below no home. Nothing about
  // the path separates them; only reading that setting before it was cleared does, and that
  // is the preload's job.
  //
  // So a worker that loaded no preload, and inherited no capture from one that did, is
  // refused instead of guessed at. It is the one refusal here that is not about a path being
  // wrong - it is about the process not knowing enough to say it is right.
  const state = join(home, "uncaptured-state");
  const res = runChild(OPEN_AND_REPORT, { HARNESS_HOME: state });
  assert.notEqual(res.status, 0, "an unbootstrapped worker opened a state dir on faith");
  assert.match(res.stderr, /loaded no test\/setup-state\.mjs/);
  assert.equal(existsSync(join(state, "harness.db")), false);
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

test("a temp-looking symlink into the operator's state dir is refused", () => {
  // The spelling is not the path. `<temp>/looks-disposable` passes the operator-name check
  // and the temp-dir check on its characters alone, and then SQLite follows the link and
  // opens `~/.mission-control/harness.db` anyway - a lexical guard reads as protection and
  // provides none. This is the case that forces the refusal to judge the resolved path.
  //
  // Its own `$HOME` inside the shared jail, so the operator dir this creates cannot be
  // mistaken for one of the earlier cases' - those assert that `<jail>/.mission-control` was
  // never created, and a test that shares a home with this one would depend on file order.
  const jail = join(home, "symlink-jail");
  const operator = join(jail, ".mission-control");
  mkdirSync(operator, { recursive: true });
  const disguised = join(jail, "looks-disposable");
  symlinkSync(operator, disguised, "dir");

  const res = runChild(OPEN_AND_REPORT, { HOME: jail, MISSION_HOME: disguised });
  assert.notEqual(res.status, 0, "a symlink into the operator's state dir was opened");
  assert.match(res.stderr, /real\s+state dir/i);
  assert.equal(
    existsSync(join(operator, "harness.db")),
    false,
    "the operator's database was created through the link",
  );
});

test("a state home reached through a broken symlink is refused", () => {
  // The dangling cousin of the case above, and the one that shows why the refusal cannot be
  // left to `mkdirSync` to trip over. `looks-disposable` points into `.mission-control` while
  // that target does not exist yet, so `realpathSync` fails on it exactly as it fails on a
  // not-yet-created fixture dir - and treating those two the same re-attaches the name and
  // hands back `<jail>/looks-disposable/nested`, which passes every check on this file.
  //
  // Measured before the fix: the guard DID pass this path, and what stopped it was
  // `mkdirSync` returning ENOENT through the dangling link - on macOS and on Linux node:24
  // alike. So no operator database was ever created. That is worth being precise about,
  // because it means this case is not a reproduction of data loss; it is a reproduction of
  // the guard declining to answer and something else happening to catch it. The assertion is
  // therefore on the REFUSAL, not merely on a non-zero exit: a test that only checked the
  // exit code passed before this change too, on an error from a syscall nobody chose as a
  // safety boundary.
  const jail = join(home, "dangling-jail");
  const operator = join(jail, ".mission-control"); // deliberately never created
  mkdirSync(jail, { recursive: true });
  symlinkSync(operator, join(jail, "looks-disposable"), "dir");

  const res = runChild(OPEN_AND_REPORT, {
    HOME: jail,
    MISSION_HOME: join(jail, "looks-disposable", "nested"),
  });

  assert.notEqual(res.status, 0, "a path through a broken link was opened");
  assert.match(res.stderr, /does not resolve - a broken symlink/);
  assert.equal(existsSync(operator), false, "the link's target was created after all");
});

test("deleting NODE_TEST_CONTEXT does not disarm the guard without the preload either", () => {
  // The sibling of the case below, and the one that needs a REAL `node --test` worker rather
  // than a simulated one: the point is a worker with no preload, so there is no marker on
  // `globalThis` and the environment variable is the only thing the runner supplied - which
  // this file then deletes before importing, exactly as the in-preload case does.
  //
  // What recognises it is `process.execArgv`. Every `node --test` child is spawned carrying a
  // `--test-*` family (`--test-isolation=process`, `--test-timeout=0`, …), with no preload and
  // no loader needed, and ordinary `node` carries none - so this cannot make the daemon look
  // like a worker.
  const jail = join(home, "no-preload-jail");
  const operator = join(jail, ".mission-control");
  mkdirSync(jail, { recursive: true });

  const spec = join(jail, "probe.test.mjs");
  const dbUrl = pathToFileURL(join(REPO_ROOT, "src/server/db.ts")).href;
  writeFileSync(
    spec,
    `import test from "node:test";
     test("tries to open the operator db", async () => {
       delete process.env.NODE_TEST_CONTEXT;
       process.env.MISSION_HOME = ${JSON.stringify(operator)};
       const { openDb } = await import(${JSON.stringify(dbUrl)});
       openDb();
     });`,
  );

  // No `--import ./test/setup-state.mjs`: that omission IS the case.
  const res = runChild("", { HOME: jail }, { spec });
  assert.notEqual(res.status, 0, "the operator db was opened by a worker with no preload");
  assert.match(res.stdout + res.stderr, /real\s+state dir/i);
  assert.equal(
    existsSync(operator),
    false,
    "the operator's state dir was created once the variable was gone",
  );
});

test("emptying execArgv as well does not disarm the guard", () => {
  // Both JS-visible signals removed at once - the variable deleted AND every `--test-*`
  // spliced out of `process.execArgv` - in a worker with no preload, so there is no marker
  // either. Everything the process can say about itself now says "not a test".
  //
  // What answers is the operating system: `/proc/self/cmdline` on Linux, the diagnostic
  // report elsewhere. Neither is stored in the JS heap, so neither can be rewritten from a
  // test file, and that is the whole reason this case is worth a real runner and a spawn.
  const jail = join(home, "tampered-jail");
  const operator = join(jail, ".mission-control");
  mkdirSync(jail, { recursive: true });

  const spec = join(jail, "probe.test.mjs");
  const dbUrl = pathToFileURL(join(REPO_ROOT, "src/server/db.ts")).href;
  writeFileSync(
    spec,
    `import test from "node:test";
     test("tries to open the operator db", async () => {
       delete process.env.NODE_TEST_CONTEXT;
       process.execArgv = process.execArgv.filter((f) => !f.startsWith("--test-"));
       process.env.MISSION_HOME = ${JSON.stringify(operator)};
       const { openDb } = await import(${JSON.stringify(dbUrl)});
       openDb();
     });`,
  );

  const res = runChild("", { HOME: jail }, { spec });
  assert.notEqual(res.status, 0, "a worker that scrubbed both signals opened the operator db");
  assert.match(res.stdout + res.stderr, /real\s+state dir/i);
  assert.equal(existsSync(operator), false, "the operator's state dir was created");
});

test("deleting NODE_TEST_CONTEXT does not disarm the guard", () => {
  // The cheapest possible bypass, and the one that needs no unusual path at all: the refusal
  // used to begin `if (!process.env.NODE_TEST_CONTEXT) return`, and that is an ordinary
  // environment variable. A test file that removes it before importing the server graph does
  // not defeat one check - it skips all of them, and `openDb` opens whatever the state home
  // names, here the operator's own directory.
  //
  // What holds instead is the marker `setup-state.mjs` pins on `globalThis`, which cannot be
  // deleted or reassigned. This case is also what keeps that marker's NAME in step across the
  // two files that spell it out: misspell it in either one and this goes red.
  const jail = join(home, "ctx-jail");
  const operator = join(jail, ".mission-control");
  mkdirSync(jail, { recursive: true });

  const res = runChild(
    `
      delete process.env.NODE_TEST_CONTEXT;
      process.env.MISSION_HOME = ${JSON.stringify(operator)};
      const { openDb } = await import("./src/server/db.ts");
      try { openDb(); console.log("opened"); } catch (err) { console.log("refused:" + err.message); }
    `,
    { HOME: jail },
    { bootstrap: true },
  );

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /refused:refusing to open .*real state dir/);
  assert.doesNotMatch(res.stdout, /\nopened\n/, "the guard was switched off from inside a test");
  assert.equal(
    existsSync(join(operator, "harness.db")),
    false,
    "the operator's database was opened once the variable was gone",
  );
});

test("moving HOME and TMPDIR after the preload cannot launder the operator's state dir", () => {
  // The subtlest bypass in this file, because it defeats the guard without touching any of
  // the signals: the marker is present, the path resolves, nothing dangles. It attacks where
  // the two lists come FROM. `os.tmpdir()` and `os.homedir()` re-read the environment on
  // every call, so a test that runs before the first `openDb()` can point `TMPDIR` at the
  // directory above the operator's state dir - putting it inside the allowlist - and `HOME`
  // somewhere else - taking it out of the denylist. Both lists then agree it is disposable.
  //
  // Measured against the previous build, with the preload loaded and the marker in place:
  // this printed "OPENED THE OPERATOR DB" and left a harness.db in the operator's dir. What
  // stops it is that the preload captures both roots before any test module runs, so this
  // rewriting arrives too late to be believed.
  const jail = join(home, "roots-jail");
  const decoy = join(home, "roots-decoy");
  const operator = join(jail, ".mission-control");
  mkdirSync(jail, { recursive: true });
  mkdirSync(decoy, { recursive: true });

  const res = runChild(
    `process.env.HOME = ${JSON.stringify(decoy)};
     process.env.TMPDIR = ${JSON.stringify(jail)};
     process.env.MISSION_HOME = ${JSON.stringify(operator)};
     ${OPEN_AND_REPORT}`,
    { HOME: jail },
    { bootstrap: true },
  );

  assert.notEqual(res.status, 0, "the operator's state dir was laundered into the allowlist");
  assert.match(res.stderr, /real\s+state dir/i);
  assert.equal(
    existsSync(join(operator, "harness.db")),
    false,
    "the operator's database was created after the roots were moved",
  );
});

test("a no-preload worker cannot move HOME to drop the real state dir from the denylist", () => {
  // The same laundering as the case above, aimed at the half that has no captured value to
  // fall back on. With no preload the denylist comes from `$HOME`, so the test sets `HOME` to
  // a decoy - the real state dir drops out - and `TMPDIR` to the directory above its target,
  // which puts it in the allowlist. Reading `$HOME` at module load only moves the deadline;
  // the assignment simply happens before the import. Measured against the previous build in a
  // real `node --test` worker: it opened a database inside the operator's own state dir.
  //
  // `userInfo().homedir` is what closes it, because it comes from the password database and
  // ignores `$HOME` entirely.
  //
  // ON THE TARGET, deliberately: this is the one case that cannot be staged inside a temp
  // jail, because the value being proven immutable is the REAL home and no test can change
  // it. So the aim is chosen to make a regression bounded and loud rather than dangerous - a
  // fresh subdirectory under the OLDEST state-dir name, which is the one no current install
  // writes to. A broken guard therefore creates one empty junk database in a legacy
  // directory, fails this assertion, and is cleaned up below; `harness.db` under the live
  // `.mission-control` is never the path being opened.
  const probe = join(userInfo().homedir, ".ai-harness", `guard-probe-${process.pid}`);
  after(() => rmSync(probe, { recursive: true, force: true }));

  const jail = join(home, "nopreload-roots-jail");
  const decoy = join(home, "nopreload-roots-decoy");
  mkdirSync(jail, { recursive: true });
  mkdirSync(decoy, { recursive: true });

  const spec = join(jail, "probe.test.mjs");
  const dbUrl = pathToFileURL(join(REPO_ROOT, "src/server/db.ts")).href;
  writeFileSync(
    spec,
    `import test from "node:test";
     test("tries to open under the operator's state dir", async () => {
       delete process.env.NODE_TEST_CONTEXT;
       process.execArgv = process.execArgv.filter((f) => !f.startsWith("--test-"));
       process.env.HOME = ${JSON.stringify(decoy)};
       process.env.TMPDIR = ${JSON.stringify(join(userInfo().homedir, ".ai-harness"))};
       process.env.MISSION_HOME = ${JSON.stringify(probe)};
       const { openDb } = await import(${JSON.stringify(dbUrl)});
       openDb();
     });`,
  );

  const res = runChild("", { HOME: jail }, { spec });
  assert.notEqual(res.status, 0, "a decoy HOME dropped the real state dir from the denylist");
  assert.match(res.stdout + res.stderr, /real\s+state dir/i);
  assert.equal(
    existsSync(join(probe, "harness.db")),
    false,
    "a database was created inside the operator's own state dir",
  );
});

test("a production state home configured inside the temp dir is still refused", () => {
  // The operator database is not always under a home directory. `MISSION_HOME` is a supported
  // setting and it can name anywhere, the temp dir included - and such a path defeats every
  // other check in this file on its merits: explicit, resolvable, inside a temp root, and
  // hanging off no home so the denylist never names it. Nothing downstream can tell it apart
  // from a fixture, because the preload cleared the one variable that identified it.
  //
  // So the preload reads it before clearing it. Here the worker inherits the setting exactly
  // as it would from an operator's shell, and the test then names that same path.
  const operatorState = join(home, "configured-production-state");
  mkdirSync(operatorState, { recursive: true });

  const res = runChild(
    `process.env.MISSION_HOME = ${JSON.stringify(operatorState)};\n${OPEN_AND_REPORT}`,
    { MISSION_HOME: operatorState },
    { bootstrap: true },
  );

  assert.notEqual(res.status, 0, "the operator's configured state dir was opened");
  assert.match(res.stderr, /real\s+state dir/i);
  assert.equal(
    existsSync(join(operatorState, "harness.db")),
    false,
    "a database was created in the state dir the daemon was configured with",
  );
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
