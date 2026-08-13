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

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Set by `node --test` in each spawned test process and nowhere else, which is exactly the
// scope wanted: the runner's parent process gets `--import` too (it propagates through
// `execArgv`) and has no business creating a state dir, and a daemon that happens to load
// this file outside the runner must keep the operator's real one.
if (process.env.NODE_TEST_CONTEXT) {
  const root = mkdtempSync(join(tmpdir(), "mission-test-state-"));

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
  process.on("exit", () => {
    rmSync(root, { recursive: true, force: true });
  });
}
