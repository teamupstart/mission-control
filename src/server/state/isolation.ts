import { lstatSync, realpathSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { envVar, STATE_DIRS } from "@shared/harness-runtime.mjs";
import { underTestRunner } from "../util/test-runner.ts";

/**
 * What `test/setup-state.mjs` recorded about this machine BEFORE any test module ran.
 *
 * `os.tmpdir()` and `os.homedir()` both re-read the environment on every call, so deriving
 * the allowlist and the denylist from them at first `openDb()` asks the question far too
 * late: a test can move `TMPDIR` above the operator's real state dir and `HOME` somewhere
 * else, and that directory is then missing from the denylist and inside the allowlist at the
 * same moment. Measured before this was captured, with the marker present and every other
 * check passing: the open succeeded and left a `harness.db` in the operator's dir.
 *
 * Frozen at the preload, so these describe the machine as it was at process start. Shape is
 * checked rather than trusted - it is a global, and a wrong shape must degrade to the
 * fallback below rather than throw somewhere unhelpful.
 */
type CapturedTestState = { home?: unknown; tempRoots?: unknown; inheritedStateHomes?: unknown };

/**
 * The capture, from the frozen property when this process ran the preload itself, and from
 * the environment when it is a CHILD of a process that did.
 *
 * The second is not a weaker version of the first, it answers a different need. `globalThis`
 * does not survive a spawn, and a good number of test files spawn a child with
 * `...process.env` to drive the daemon from the outside; those children are test workers -
 * they inherit `NODE_TEST_CONTEXT` - with no preload of their own. Inheriting the capture is
 * what lets them carry the same denylist instead of starting blind.
 */
function readCapturedTestState(): CapturedTestState | undefined {
  const marked = (globalThis as Record<string, unknown>)["__missionControlTestState"];
  if (marked && typeof marked === "object") return marked as CapturedTestState;
  const inherited = process.env.MISSION_TEST_STATE;
  if (!inherited) return undefined;
  try {
    const parsed: unknown = JSON.parse(inherited);
    return parsed && typeof parsed === "object" ? (parsed as CapturedTestState) : undefined;
  } catch {
    return undefined; // unparseable is the same as absent, and absent fails closed below
  }
}

const capturedTestState = readCapturedTestState();

const CAPTURED_HOME = typeof capturedTestState?.home === "string" ? capturedTestState.home : undefined;

const CAPTURED_TEMP_ROOTS = Array.isArray(capturedTestState?.tempRoots)
  ? capturedTestState.tempRoots.filter((root): root is string => typeof root === "string")
  : undefined;

/**
 * The state dir this process was pointed at BEFORE the preload cleared the aliases.
 *
 * An operator is free to run the daemon with `MISSION_HOME` set anywhere, the temp dir
 * included, and every other check here would wave that path through: explicit, resolvable,
 * inside a temp root, and hanging off no home directory so the denylist never names it. It is
 * still somebody's live database, and the only reason nothing else can see it is that the
 * preload cleared the variable that named it.
 */
const CAPTURED_INHERITED_STATE_HOMES = Array.isArray(capturedTestState?.inheritedStateHomes)
  ? capturedTestState.inheritedStateHomes.filter((dir): dir is string => typeof dir === "string")
  : [];

/**
 * The fallback for a worker that never loaded the preload: the same two values, read at
 * MODULE LOAD rather than at first `openDb()`.
 *
 * It cannot be as good - nothing of ours runs before the first line of a test file when the
 * preload is absent - but it narrows the window from "any time before the first open" to
 * "before this module is imported", and it costs a pair of string reads.
 */
const HOME_AT_IMPORT = homedir();
const TMPDIR_AT_IMPORT = tmpdir();

/**
 * Where a test's state dir is allowed to live, in every spelling the platform hands out.
 *
 * macOS resolves `$TMPDIR` through a symlink - `/var/folders/…` and `/private/var/folders/…`
 * name the same directory - and the suite uses both: most files take `mkdtempSync` at face
 * value, while the ones that compare stored paths (workflow-check-lease, and the provider
 * column fixture beside it) canonicalize with `realpathSync` first. Refusing either spelling
 * would fail honest tests, so both roots are held.
 *
 * Resolved once and cached. This is the only filesystem call the refusal makes, and it must
 * not become one per `openDb()`: the helpers below call it constantly.
 */
let temporaryRoots: readonly string[] | undefined;
function testStateRoots(): readonly string[] {
  if (temporaryRoots) return temporaryRoots;
  if (CAPTURED_TEMP_ROOTS?.length) return (temporaryRoots = CAPTURED_TEMP_ROOTS);
  const configured = resolve(TMPDIR_AT_IMPORT);
  const roots = new Set([configured]);
  try {
    roots.add(resolve(realpathSync(configured)));
  } catch {
    // An unreadable temp dir just means the symlinked spelling is the only one we know.
  }
  return (temporaryRoots = [...roots]);
}

/**
 * The path the filesystem will actually open, with any not-yet-created tail kept.
 *
 * `resolve()` is lexical, and a lexical check is not a check. A state home spelled
 * `<temp>/looks-disposable` clears both tests below on its characters alone while being a
 * symlink to `~/.mission-control`, and `new DatabaseSync` then follows it into the operator's
 * database - the exact outcome this guard exists to prevent. What gets opened is the physical
 * path, so the physical path is what has to be judged.
 *
 * Most test homes do not exist yet at this point - `HARNESS_HOME=<temp>/state` is the
 * documented pattern and `openDb` is what creates it - so a bare `realpathSync` would throw on
 * the honest case. Walking up to the nearest ancestor that DOES exist and re-attaching the
 * tail keeps those working while still resolving every link that is already on disk, which is
 * where a link has to be to redirect the open.
 *
 * The two reasons `realpathSync` can fail are not interchangeable, and conflating them is a
 * hole. "No such component" is the honest case above. "The component is there but does not
 * resolve" is a BROKEN SYMLINK, and re-attaching its name as though it were an ordinary
 * missing directory hands back a path that passes every check below while naming somewhere
 * else entirely - `<temp>/looks-disposable/nested`, where `looks-disposable` dangles into
 * `~/.mission-control`. `lstatSync` is what tells them apart: it does not follow the link, so
 * it answers "this name exists" for a link whose target does not.
 *
 * Such a path is refused rather than resolved. Where it would land is a question about a
 * directory that does not exist yet, and a guard that cannot answer must not guess. This is
 * deliberately not left to `mkdirSync` to trip over: today it happens to fail ENOENT through
 * a dangling link on both macOS and Linux, which means the safety of this path currently
 * rests on the error behaviour of a syscall nobody chose for that purpose.
 */
type PhysicalPath = { path: string } | { unresolvable: string };

function physicalPath(path: string): PhysicalPath {
  const absolute = resolve(path);
  const tail: string[] = [];
  let cursor = absolute;
  for (;;) {
    try {
      return { path: join(realpathSync(cursor), ...tail) };
    } catch {
      let present = true;
      try {
        lstatSync(cursor);
      } catch {
        present = false; // genuinely absent - the honest not-yet-created case
      }
      if (present) return { unresolvable: cursor };
      const parent = dirname(cursor);
      if (parent === cursor) return { path: absolute }; // nothing along this path exists yet
      tail.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

/**
 * Every home the operator's state dir could hang off, and the reason there is more than one.
 *
 * `homedir()` answers `$HOME`, which a test can set - and setting it is the whole trick:
 * point `HOME` at a decoy and the real `~/.mission-control` drops out of the denylist, then
 * point `TMPDIR` at it and it appears in the allowlist. Without the preload there is no
 * captured value to fall back on, so reading it at module load only moves the deadline; the
 * test simply assigns before importing. Measured against the previous build, in a real
 * `node --test` worker with no preload: it opened a database inside the operator's own state
 * directory.
 *
 * `userInfo().homedir` is the answer to a different question. It comes from the password
 * database - `getpwuid` - and ignores `$HOME` outright, which `test/workflow-check-env.ts`
 * already relies on. No amount of environment editing moves it, so the real state dir cannot
 * be dropped from this list.
 *
 * All of them are held rather than one, because every entry only ever ADDS a refusal. A
 * test's own home is a `mkdtemp` directory, so widening this cannot catch an honest fixture -
 * no test in the suite names a state dir `.mission-control`, `.fleet-control` or
 * `.ai-harness`.
 */
function operatorHomes(): readonly string[] {
  const homes = new Set<string>();
  if (CAPTURED_HOME) homes.add(CAPTURED_HOME);
  homes.add(HOME_AT_IMPORT);
  try {
    homes.add(userInfo().homedir);
  } catch {
    // No passwd entry (some containers). The environment-derived homes are all there is.
  }
  return [...homes];
}

/**
 * The operator's state dir under every name the app has shipped, in both spellings.
 *
 * The physical form matters on any machine whose home is reached through a link (a network
 * or relocated home, `/home` -> `/System/Volumes/Data/home`): comparing only the lexical
 * `~/.mission-control` there would miss the very directory it names. Cached, like the temp
 * roots, so the filesystem work happens once rather than per `openDb()`.
 */
let operatorStateDirs: readonly string[] | undefined;
function operatorStateRoots(): readonly string[] {
  if (operatorStateDirs) return operatorStateDirs;
  // The pre-bootstrap home joins the list as a state dir in its own right, not as a home to
  // hang the shipped names off: an operator's `MISSION_HOME` IS the state dir.
  const roots = new Set<string>(CAPTURED_INHERITED_STATE_HOMES);
  for (const [home, name] of operatorHomes().flatMap((h) => STATE_DIRS.map((n) => [h, n] as const))) {
    const dir = join(home, name);
    roots.add(resolve(dir));
    // An operator dir that is itself an unresolvable link contributes only its lexical form;
    // the candidate below is still refused, because a candidate that cannot resolve never
    // reaches this comparison at all.
    const physical = physicalPath(dir);
    if ("path" in physical) roots.add(physical.path);
  }
  return (operatorStateDirs = [...roots]);
}

/**
 * `child` IS `parent` or sits inside it - compared by path segment.
 *
 * A bare `startsWith` would read `/tmp/state-10` as living inside `/tmp/state-1`, which in a
 * guard is the dangerous direction: sibling temp dirs are precisely what `mkdtempSync` hands
 * out to concurrent workers.
 */
function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** Cache the last accepted override and destination together. */
let isolatedOverride: string | undefined;
let isolatedStateFile: string | undefined;

/**
 * Refuse state writes outside a disposable test home. Call immediately before opening
 * a state file, passing the actual destination, even when it was resolved at module load.
 * Resolution stays side-effect free; this policy protects both SQLite and file writers.
 * The destination must be a direct child of the currently selected state home.
 */
export function assertTestStateIsolation(stateFile: string): void {
  if (!underTestRunner()) return;
  const override = envVar("HOME");
  // A different writer must validate its own destination, even under an accepted override.
  if (override !== undefined && override === isolatedOverride && stateFile === isolatedStateFile) return;

  const fix =
    " Set MISSION_HOME to a fresh temp dir BEFORE importing anything that resolves it - see" +
    " ui-config-store.test.ts for the pattern - or run this file the way AGENTS.md documents," +
    " which preloads test/setup-state.mjs and gives the worker a disposable one.";
  const refusal = (why: string): Error =>
    new Error(`refusing to open ${stateFile} under the test runner: ${why}.${fix}`);

  if (!override) {
    throw refusal("no state-dir override is set, so this is the machine's real state dir");
  }
  const selected = resolve(override);
  if (dirname(resolve(stateFile)) !== selected) {
    throw refusal(
      `the override now names ${selected}, so this path was frozen against a different ` +
        "state dir - it was resolved before the override was set",
    );
  }
  // Judged on BOTH spellings: the one written down, and the one the filesystem resolves it
  // to. Checking only the first is bypassable by a symlink; checking only the second would
  // stop naming the path the author actually set when it comes time to explain the refusal.
  const resolved = physicalPath(selected);
  if ("unresolvable" in resolved) {
    throw refusal(
      `${resolved.unresolvable} is present but does not resolve - a broken symlink - so which ` +
        `directory ${selected} would create cannot be known`,
    );
  }
  const physical = resolved.path;
  for (const candidate of physical === selected ? [selected] : [selected, physical]) {
    const subject = candidate === selected ? candidate : `${selected} -> ${candidate}`;
    if (operatorStateRoots().some((dir) => isInside(candidate, dir))) {
      throw refusal(`${subject} is the machine's real state dir, whichever alias named it`);
    }
    if (!testStateRoots().some((root) => isInside(candidate, root))) {
      // Names the root actually being enforced, which is the captured one when there is a
      // preload - saying `tmpdir()` here would print whatever the test last set it to.
      throw refusal(
        `${subject} is outside ${testStateRoots().join(" and ")}, so it is not a disposable test state dir`,
      );
    }
  }

  // Last, because every check above says something more specific and should say it. This one
  // is about what CANNOT be known: with no capture, "an explicit path under the temp dir" is
  // the exact description of both a fixture home and an operator who runs the daemon with
  // `MISSION_HOME` pointing there. The preload is what tells them apart, by reading that
  // setting before clearing it - so a worker that never loaded it, and did not inherit a
  // capture from one that did, is refused rather than guessed at.
  if (!capturedTestState) {
    throw refusal(
      `${selected} looks disposable, but this worker loaded no test/setup-state.mjs and ` +
        "inherited no capture from one that did, so a fixture dir and the state dir the " +
        "daemon was configured with are indistinguishable here",
    );
  }

  isolatedOverride = override;
  isolatedStateFile = stateFile;
}
