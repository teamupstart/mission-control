// Give every `node --test` worker its own throwaway state dir, before it can resolve one.
//
// What is at stake is the operator's real `~/.mission-control`. `src/server/config.ts`
// freezes `STATE_DIR` and `DB_PATH` the instant it is evaluated, so isolation is a race
// that each test file has had to win on its own: set a home override at the very top,
// above every import that could reach `config.ts`. 200-odd files do exactly that and are
// correct. The failure mode is what happens when one does not - a new file, a value
// import hoisted above the preamble, a helper that pulls in the server graph - and the
// answer was the developer's live database. It has happened twice: a config test ran
// `DELETE FROM app_config` against it on every `npm test`, and fixture rows from
// `workflow-inspector-bypass.test.ts` were later found sitting in it.
//
// So the fallback stops being the operator's home. A worker that sets nothing now lands
// in a directory that exists for the length of that one process, and the guard in
// `src/server/db.ts` is left to catch everything this cannot - a nonstandard command that
// never loaded this file, an override set too late, one pointed somewhere real.
//
// Plain `.mjs` with only Node built-ins, and deliberately no import of anything under
// `src/`: this runs through `--import` ahead of `tsx`, so it has no TypeScript loader yet,
// and importing `harness-runtime.mjs` here to "reuse" the alias order would evaluate the
// module whose behavior we are trying to arrange. It writes environment, nothing else, and
// never opens SQLite.

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

// `node --test` sets this in each test process it spawns, which is the scope wanted: the
// runner's PARENT process gets `--import` too (it propagates through `execArgv`) and has no
// business creating a state dir, and a daemon that happens to load this file outside the
// runner must keep the operator's real one. Test files may also set it deliberately on a
// child they spawn - `test/db-isolation.test.ts` does, to simulate a worker from the
// outside - so "the runner set it" is the normal case rather than the only one.
if (process.env.NODE_TEST_CONTEXT) {
  const root = mkdtempSync(join(tmpdir(), "mission-test-state-"));

  // A marker `db.ts` can trust for the life of this process, because the environment cannot
  // be trusted for it: `NODE_TEST_CONTEXT` is an ordinary env var, and a test that runs
  // `delete process.env.NODE_TEST_CONTEXT` before importing the server graph turns the
  // refusal off completely - it returns on its first line and the operator's database opens.
  // `process.env` refuses a non-configurable descriptor ("only accepts a configurable,
  // writable, and enumerable data descriptor"), so the variable itself cannot be pinned; a
  // property here can be. Non-writable and non-configurable, so `delete` answers false and
  // assignment does nothing.
  //
  // The NAME is a contract shared with `src/server/db.ts`, which cannot import this file.
  // It is spelled out in both places rather than shared through a module, because the only
  // module both could import is application configuration this file must not evaluate.
  // `deleting NODE_TEST_CONTEXT does not disarm the guard` in db-isolation fails if the two
  // spellings ever drift, which is what keeps them honest.
  // The ROOTS travel with the marker, captured here and frozen, because `db.ts` deriving them
  // later from `os.tmpdir()` and `os.homedir()` is not the same question. Both of those read
  // the environment on every call, so a test that runs before the first `openDb()` can move
  // `TMPDIR` to sit above the operator's real state dir and `HOME` somewhere else entirely -
  // and the operator's directory is then absent from the denylist AND inside the allowlist.
  // Measured before this: that sequence printed "OPENED THE OPERATOR DB" and left a
  // `harness.db` behind, with this marker present and every other check passing.
  //
  // Captured at preload, these describe the machine as it was before any test module ran,
  // which is the only moment the answer is trustworthy.
  const temp = resolve(tmpdir());
  const tempRoots = new Set([temp]);
  try {
    tempRoots.add(resolve(realpathSync(temp)));
  } catch {
    // An unreadable temp dir just means the symlinked spelling is the only one we know.
  }

  // The state dir this process was ALREADY pointed at, read before the aliases below are
  // cleared, because clearing them is the only reason nothing downstream can see it.
  //
  // An operator may run the daemon with `MISSION_HOME` set anywhere, including inside the
  // temp dir. Every check `db.ts` makes would then wave that path through: it is explicit, it
  // resolves, it is under a temp root, and it hangs off no home directory so the denylist
  // never names it. It is nevertheless somebody's live database. Read in `envVar`'s
  // precedence order, so the value captured is the one that WAS in effect.
  const inherited =
    process.env.MISSION_HOME ?? process.env.FLEET_HOME ?? process.env.HARNESS_HOME;
  const inheritedStateHomes = new Set();
  if (inherited) {
    const absolute = resolve(inherited);
    inheritedStateHomes.add(absolute);
    try {
      inheritedStateHomes.add(resolve(realpathSync(absolute)));
    } catch {
      // Not created yet, or unreadable - the spelling is still worth refusing.
    }
  }

  const captured = {
    root,
    home: homedir(),
    tempRoots: [...tempRoots],
    inheritedStateHomes: [...inheritedStateHomes],
  };

  Object.defineProperty(globalThis, "__missionControlTestState", {
    value: Object.freeze({ ...captured, tempRoots: Object.freeze(captured.tempRoots), inheritedStateHomes: Object.freeze(captured.inheritedStateHomes) }),
    writable: false,
    configurable: false,
    enumerable: false,
  });

  // The same capture again, in the environment, because `globalThis` does not survive a
  // spawn and roughly seventeen test files spawn a child with `...process.env` to exercise
  // the daemon from the outside. Those children inherit `NODE_TEST_CONTEXT` and so are test
  // workers, but they load no preload of their own: without this they would have no captured
  // roots at all, and `db.ts` refuses a worker it knows nothing about.
  //
  // This copy is deliberately NOT the tamper-proof one - the frozen property above is, for
  // the process that owns it. What this buys is reach, not resistance: a child of an
  // isolated worker inherits the same denylist, including the operator's own configured
  // state dir, instead of starting blind.
  process.env.MISSION_TEST_STATE = JSON.stringify(captured);

  // The LOWEST-priority alias, on purpose. `envVar("HOME")` reads MISSION_ then FLEET_ then
  // HARNESS_, so seeding MISSION_HOME here would outrank the 128 files that name
  // HARNESS_HOME themselves - and an early attempt at this did exactly that, stealing the
  // hand-built pre-migration database out from under
  // `test/workflow-check-provider-column.test.ts`. Seeding the last name in the chain means
  // any file-local override, under any of the three names, still wins with no ceremony.
  // This is not a recommendation to use the legacy name anywhere else; MISSION_HOME remains
  // the one operators and new code should set.
  //
  // The two higher-priority names are cleared rather than left alone, because an inherited
  // value would outrank this fallback and quietly reintroduce the very thing it prevents -
  // an operator with MISSION_HOME exported in their shell would run the suite against
  // whatever it names.
  delete process.env.MISSION_HOME;
  delete process.env.FLEET_HOME;
  process.env.HARNESS_HOME = root;

  // The captured path, never `process.env.HARNESS_HOME` re-read at exit: a test file is
  // free to replace that value, and cleanup that resolved the variable here would delete a
  // fixture directory the test built instead of the one this file made.
  //
  // `exit` covers a normal finish and an uncaught throw, and by construction cannot cover a
  // worker killed with SIGKILL - no handler runs there. What that leaks is one empty
  // directory in the OS temp dir, which is the right place for it and is why this does not
  // sweep for strays on startup: a `readdir` of the temp dir on each of 596 worker launches
  // would cost more, every run, than the rare leak it tidies.
  process.on("exit", () => {
    rmSync(root, { recursive: true, force: true });
  });
}
