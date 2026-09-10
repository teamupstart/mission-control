import { readFileSync } from "node:fs";

/**
 * Is this process a test worker?
 *
 * One answer, shared by every guard that has to refuse something under the suite. Two use it
 * today and their subjects are unrelated - `openDb` refuses the operator's database
 * (`src/server/db.ts`), and `launchHome` refuses a real terminal session on the operator's
 * machine (`src/server/terminal/home.ts`) - which is exactly why the detection lives here
 * rather than being spelled twice. A second, weaker spelling is how one of them ends up
 * disarmed by a `delete process.env.NODE_TEST_CONTEXT` that the other survives.
 *
 * Production pays for it once: outside a test worker every caller returns on its first line.
 *
 * Decided ONCE, at import, and not re-asked.
 *
 * `NODE_TEST_CONTEXT` alone cannot answer this. It is an ordinary environment variable, so a
 * test file that runs `delete process.env.NODE_TEST_CONTEXT` before importing this module
 * turns the whole refusal off: it returns on its first line, and the operator's database
 * opens with every check skipped. That is a worse hole than the ones the checks catch,
 * because it needs no unusual path at all.
 *
 * Three signals, because each covers what the others cannot:
 *
 *   1. A marker `test/setup-state.mjs` defines non-writable and non-configurable on
 *      `globalThis` before any test module loads. `delete` answers false and assignment is
 *      ignored, so unlike the environment it cannot be spent.
 *   2. `NODE_TEST_CONTEXT`, read at import, so a worker that reaches this line under the
 *      runner is latched as one even if the variable is removed afterwards.
 *   3. `process.execArgv`, which is how a worker launched WITHOUT the preload is still
 *      recognised after the variable is deleted. Every `node --test` child is spawned with a
 *      `--test-*` family - `--test-isolation=process`, `--test-timeout=0`, and others - and
 *      that is true of a bare `node --test file.js` with no preload and no loader. Ordinary
 *      `node` carries none of them, so the daemon is never mistaken for a worker.
 *
 * Signals 2 and 3 are both ordinary mutable JS, so both are read at module load, which
 * latches a worker that reached this line under the runner. `commandLineFromOs()` is the
 * backstop for a worker that emptied both BEFORE importing - it asks the operating system
 * rather than the process, and that answer cannot be edited from JS.
 *
 * None of this makes a guard built on it a sandbox, and none is trying to be one: a test
 * that WANTS the operator's database can import `node:sqlite` and open it directly, and a
 * test that wants a real tmux session can spawn `tmux` itself - neither comes through a
 * caller of this. What these close is the accident, and every spelling of "turn the guard
 * off first" that a confused test might reach for.
 *
 * The marker name is duplicated in `test/setup-state.mjs`, which cannot import from here;
 * the db-isolation case named in that file's comment fails if the two ever drift.
 */
const CHEAP_TEST_SIGNAL =
  Object.hasOwn(globalThis, "__missionControlTestState") ||
  Boolean(process.env.NODE_TEST_CONTEXT) ||
  process.execArgv.some(isTestRunnerFlag);

function isTestRunnerFlag(flag: string): boolean {
  return flag.startsWith("--test-");
}

/**
 * The command line the OPERATING SYSTEM says this process was started with - not the copy JS
 * can edit.
 *
 * `process.execArgv` and `process.env` are both ordinary mutable values, so a test can empty
 * them before importing this module and the three signals above all read false. This is the
 * one source that survives that, because it is not stored in the JS heap at all.
 *
 * Read once, lazily, and only when every cheap signal has already said no. That ordering is
 * what keeps the cost off the paths that would feel it: a test worker never reaches this,
 * because its marker or its environment answered first, and the daemon reaches it exactly
 * once, on its first guarded call. Measured: 0.06ms on Linux through `/proc`, and 14ms on
 * macOS, where `process.report` is the only route and rebuilds a whole diagnostic report to
 * get one field. Once, against a daemon boot already measured in hundreds of milliseconds.
 */
let osCommandLine: readonly string[] | undefined;
function commandLineFromOs(): readonly string[] {
  if (osCommandLine) return osCommandLine;
  try {
    // Linux: the kernel's own NUL-separated copy.
    return (osCommandLine = readFileSync("/proc/self/cmdline", "utf8").split("\0").filter(Boolean));
  } catch {
    try {
      // Elsewhere: the diagnostic report regenerates this from the process, not from execArgv.
      const report = process.report?.getReport() as { header?: { commandLine?: string[] } };
      return (osCommandLine = report?.header?.commandLine ?? []);
    } catch {
      return (osCommandLine = []); // no way to ask; the signals above are all there is
    }
  }
}

let osVerdict: boolean | undefined;

/** Whether this process is a `node --test` worker. See the note above. */
export function underTestRunner(): boolean {
  if (CHEAP_TEST_SIGNAL) return true;
  if (osVerdict === undefined) osVerdict = commandLineFromOs().some(isTestRunnerFlag);
  return osVerdict;
}
