import { DatabaseSync } from "node:sqlite";
import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { STATE_DIRS } from "@shared/harness-runtime.mjs";
import { DB_PATH, envVar } from "./config.ts";
import { supportsEffort } from "@shared/harness-capabilities.ts";
import type {
  EpisodeAuthor,
  ForemanEpisode,
  ForemanEpisodeSummary,
  InspectorComment,
  InspectorCommentStatus,
  InspectorFailKind,
  InspectorInspection,
  InspectorPr,
  InspectorPrState,
  InspectorSeverity,
  NoteDisposition,
  PaneDialogSummary,
  PendingTurn,
  PendingTurnState,
  PlanDecision,
  PlanDecisionAnswer,
  ReviewActor,
  ReviewItem,
  ReviewKind,
  ReviewStatus,
  SessionCost,
  CostBasis,
  SessionGoal,
  SessionNote,
  SessionQueue,
  Task,
  TaskPriority,
  TaskRepoEntry,
  TaskStatus,
  TrackedGap,
  WorkItem,
  WorkItemState,
  WorktreeProvider,
} from "@shared/types.ts";
import { DEFAULT_TASK_KIND, TASK_KINDS } from "@shared/types.ts";
import { readPersistedEnum } from "@shared/schedules.ts";
import { HUMAN_REVIEW_STATUSES, isHumanResolvedReview } from "@shared/review-item.ts";
import { IN_FLIGHT_ITEM_STATES, TERMINAL_ITEM_STATES } from "@shared/queue.ts";
import { readCheapAction, readDivergence, readSkipReason } from "@shared/foreman.ts";
import { askPreviewForWire } from "@shared/foreman-ask.ts";
import type { CheapAction, Divergence, SkipReason } from "@shared/foreman.ts";
import { normalizeLabels } from "@shared/task.ts";

/**
 * Durable state. Live sessions are intentionally NOT persisted - they're rebuilt
 * from the OS on every poll. What survives a restart is state the OS can't rebuild:
 * pending review items (a human decision may be waiting), dispatched tasks (their
 * backlog, running intent, and recent outcomes), and the session event log.
 */
let db: DatabaseSync;

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

/** The last override that passed the checks below, so the steady state is one string compare. */
let isolatedOverride: string | undefined;

/**
 * Whether this process is a test worker - decided ONCE, at import, and not re-asked.
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
 * None of this makes `openDb` a sandbox, and it is not trying to be one: a test that WANTS
 * the operator's database can import `node:sqlite` and open it directly, without coming
 * through here at all. What these close is the accident, and every spelling of "turn the
 * guard off first" that a confused test might reach for.
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
 * once, on its first `openDb()`. Measured: 0.06ms on Linux through `/proc`, and 14ms on
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
function underTestRunner(): boolean {
  if (CHEAP_TEST_SIGNAL) return true;
  if (osVerdict === undefined) osVerdict = commandLineFromOs().some(isTestRunnerFlag);
  return osVerdict;
}

/**
 * Refuse to open anything but a disposable test state dir from inside the test runner.
 *
 * Twice now a test has destroyed live state: the state-dir rename once moved
 * `~/.fleet-control` out from under a running daemon (see migrate-state.ts), and a
 * branch's config test ran `DELETE FROM app_config` against the real db on every
 * `npm test`, wiping every setting the operator had saved - repeatedly, since agents
 * run the suite before every PR. Fixture rows from `workflow-inspector-bypass.test.ts`
 * were later found sitting in the operator's database too. All of them had the same
 * shape: a test file that imports server modules without redirecting the state dir
 * first, failing silently into someone's home directory.
 *
 * `test/setup-state.mjs` now hands every worker a temp dir before its imports run, which
 * removes the omission as a routine mistake. This stays as the boundary that catches what
 * a preloader cannot: a nonstandard command that never loaded it, an override set after
 * `config.ts` already froze the real path, and an override that names somewhere real.
 *
 * The check is here rather than in `stateDir()` because resolution has to stay
 * side-effect free and is evaluated at module load by files that never touch the db
 * (health.test.ts imports routes.ts and is rightly hermetic without any env). Opening
 * the db is the moment real damage becomes possible, so it is the moment to refuse.
 *
 * Four claims, each one a way live state has been or could be reached:
 *
 *   1. An override is set at all. No override means `stateDir()` resolved the home dir.
 *   2. The frozen `DB_PATH` is exactly the `harness.db` the override names NOW. This is
 *      the "same wipe with an alibi" case - an override applied after config.ts read the
 *      real home - and it is path equality rather than the prefix test this used to run,
 *      because `~/.mission-c` is a prefix of `~/.mission-control/harness.db` and a bare
 *      `startsWith` accepted it.
 *   3. It is not the operator's state dir under ANY name the app has used. Redundant with
 *      (4) on a normal machine and not on one whose `$TMPDIR` sits under `$HOME`, and it
 *      is the check that can say what is actually wrong.
 *   4. It lives in the platform temp dir, so what it opens is disposable by construction.
 *
 * Production pays for none of it: outside a test worker (see `underTestRunner`) this returns
 * on its first line, and the live daemon opens whatever `stateDir()` resolved, exactly as
 * before.
 */
function assertTestStateIsolation(): void {
  if (!underTestRunner()) return;
  const override = envVar("HOME");
  // Same override as the last accepted call - nothing about the answer can have changed,
  // and this is the path every helper takes.
  if (override !== undefined && override === isolatedOverride) return;

  const fix =
    " Set MISSION_HOME to a fresh temp dir BEFORE importing anything that resolves it - see" +
    " ui-config-store.test.ts for the pattern - or run this file the way AGENTS.md documents," +
    " which preloads test/setup-state.mjs and gives the worker a disposable one.";
  const refusal = (why: string): Error =>
    new Error(`refusing to open ${DB_PATH} under the test runner: ${why}.${fix}`);

  if (!override) {
    throw refusal("no state-dir override is set, so this is the machine's real state dir");
  }
  const selected = resolve(override);
  if (resolve(DB_PATH) !== join(selected, "harness.db")) {
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
}

export function openDb(): DatabaseSync {
  // BEFORE the singleton return, not after. A cached handle is how a late override change
  // would otherwise keep writing to a state dir the process no longer names - the caller
  // believes it redirected itself, and every statement still lands in the previous one.
  assertTestStateIsolation();
  if (db) return db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL;");
  // SQLite parses REFERENCES clauses whatever this says and enforces them only when it is
  // on, so declaring a foreign key without this line is a comment that looks like a
  // constraint. It is safe to switch on for the whole file because the ensemble family
  // below is the ONLY one that declares a foreign key - every other table in here relates
  // by convention, and turning the pragma on cannot retroactively constrain a relation the
  // schema never declared. A new REFERENCES clause on an older table therefore becomes
  // live the moment it is written, which is the point.
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS reviews (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      kind        TEXT NOT NULL,
      title       TEXT NOT NULL,
      body        TEXT NOT NULL,
      status      TEXT NOT NULL,
      response    TEXT,
      created_at  INTEGER NOT NULL,
      resolved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_reviews_session ON reviews(session_id);
    CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status);

    CREATE TABLE IF NOT EXISTS session_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      ts         INTEGER NOT NULL,
      kind       TEXT NOT NULL,
      payload    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_session ON session_events(session_id, ts);

    CREATE TABLE IF NOT EXISTS session_agent_bindings (
      session_id       TEXT PRIMARY KEY,  -- the synthetic id (tty+pid+start)
      agent_session_id TEXT NOT NULL,     -- what the agent calls itself: the note/queue key
      updated_at       INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id            TEXT PRIMARY KEY,
      title         TEXT NOT NULL,
      intent        TEXT NOT NULL,
      kind          TEXT NOT NULL,
      agent         TEXT NOT NULL,
      priority      TEXT,               -- low|med|high|blocker, NULL = nobody set one
      labels        TEXT,               -- JSON array of strings, NULL = none
      dependencies  TEXT,               -- JSON TaskDependency[], NULL = none
      -- May the backlog autopilot schedule this? 1 unless somebody switched it off.
      -- NOT NULL DEFAULT 1 rather than nullable: there is no third state, and a NULL
      -- read as falsy would silently park every task filed before the toggle existed.
      enabled       INTEGER NOT NULL DEFAULT 1,
      model         TEXT,
      effort        TEXT,
      -- Published Workflow identity armed for this task's completion. The immutable
      -- version is selected only when the launched session can be bound.
      workflow_id   TEXT,
      -- Where a task source swept this task from. The LINK BACK only: identity for
      -- de-duplication lives in task_source_seen below, whose rows outlive the task.
      -- NULL on every task a human typed, which is nearly all of them.
      source_id     TEXT,
      external_id   TEXT,
      source_url    TEXT,
      repo_root     TEXT NOT NULL,
      worktree_path TEXT,
      branch        TEXT,
      provider      TEXT,
      -- The full 40-char commit the PRIMARY repo's branch was cut at. Here rather than in a
      -- task_repos row so "a single-repo task has zero task_repos rows" stays true; a reader
      -- that iterates task_repos alone therefore cannot see the primary and must read this.
      -- Nullable: every task dispatched before this column existed genuinely has no baseline.
      base_sha      TEXT,
      home_name     TEXT,               -- name of the terminal home, any backend (was tmux_session)
      terminal_resource_id TEXT,
      session_id    TEXT,
      -- Which recurring mission filed this task, and for which instant. All three NULL
      -- on every task a human dispatched, an MCP call created, or a task source swept -
      -- which is every task that existed before Recurring Missions. Deliberately NOT
      -- folded into source_id/external_id above: a task source reads an EXTERNAL system
      -- and dedupes against task_source_seen, where a schedule is internal state whose
      -- identity is (schedule_id, scheduled_for) and lives in its own occurrence ledger.
      schedule_id            TEXT,
      schedule_occurrence_id TEXT,
      scheduled_for          INTEGER,
      status        TEXT NOT NULL,
      outcome       TEXT,
      outcome_url   TEXT,
      error         TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      dispatched_at INTEGER,
      completed_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status   ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_worktree ON tasks(worktree_path);

    -- The SECONDARY repositories attached to a multi-repo task, one row each. The primary
    -- is never in here - it stays on the tasks row above - so a single-repo task has zero
    -- rows and an old database upgrades by gaining an empty table.
    --
    -- position is the entry's slot as well as its display order: the git-fallback
    -- worktree path is derived from it, so nothing may renumber a provisioned entry
    -- without moving its tree.
    CREATE TABLE IF NOT EXISTS task_repos (
      task_id       TEXT NOT NULL,
      repo_root     TEXT NOT NULL,
      worktree_path TEXT,
      branch        TEXT,
      provider      TEXT,
      base_sha      TEXT,
      position      INTEGER NOT NULL,
      PRIMARY KEY (task_id, repo_root)
    );
    CREATE INDEX IF NOT EXISTS idx_task_repos_worktree ON task_repos(worktree_path);

    CREATE TABLE IF NOT EXISTS session_work_episodes (
      session_id       TEXT PRIMARY KEY,
      episode_id       TEXT NOT NULL UNIQUE,
      agent_session_id TEXT NOT NULL,
      branch           TEXT,
      pr_url           TEXT,
      pr_head_sha      TEXT,
      merged_at        INTEGER,
      prompted_at      INTEGER,
      awaiting_agent_rebind INTEGER NOT NULL DEFAULT 0,
      rebind_from_transcript_path TEXT,
      started_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_work_episode_prompts (
      session_id  TEXT NOT NULL,
      episode_id  TEXT NOT NULL,
      prompted_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, episode_id, prompted_at)
    );

    -- One episode's pull request in a SECONDARY repository, one row per repo.
    --
    -- The same additive split task_repos makes, on the other axis: the primary repo's pull
    -- request stays on session_work_episodes.pr_url (and the binding rows that mirror it), so
    -- a single-repo task writes zero rows here and every existing reader keeps its meaning.
    -- One owner per repo, never two - nothing writes the primary's URL into this table, and
    -- nothing reads a secondary's from the scalar.
    --
    -- Keyed on the EPISODE rather than the task because that is what the refusal guard is
    -- about: within one episode a repo holds at most one pull request, and a second one for
    -- the same repo is refused exactly as the scalar guard refuses it for the primary. A new
    -- episode is new work and may open a new one.
    --
    -- task_id is carried so the row can be cleaned up with its task and harvested for the
    -- completion quorum without walking every historical binding; it is nullable because the
    -- episode, not the task, owns the row's identity.
    CREATE TABLE IF NOT EXISTS work_episode_prs (
      episode_id  TEXT NOT NULL,
      repo_root   TEXT NOT NULL,
      session_id  TEXT NOT NULL,
      task_id     TEXT,
      pr_url      TEXT NOT NULL,
      pr_state    TEXT,               -- open | merged, as of the last observation
      pr_head_sha TEXT,
      merged_at   INTEGER,
      updated_at  INTEGER NOT NULL,
      PRIMARY KEY (episode_id, repo_root)
    );
    CREATE INDEX IF NOT EXISTS idx_work_episode_prs_task ON work_episode_prs(task_id);
    CREATE INDEX IF NOT EXISTS idx_work_episode_prs_url ON work_episode_prs(pr_url);

    CREATE TABLE IF NOT EXISTS task_work_episode_bindings (
      task_id          TEXT PRIMARY KEY,
      episode_id       TEXT NOT NULL,
      session_id       TEXT NOT NULL,
      agent_session_id TEXT NOT NULL,
      branch           TEXT,
      pr_url           TEXT,
      pr_head_sha      TEXT,
      merged_at        INTEGER,
      bound_at         INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_task_work_episode_session
      ON task_work_episode_bindings(session_id);

    CREATE TABLE IF NOT EXISTS historical_task_work_episode_bindings (
      task_id          TEXT NOT NULL,
      episode_id       TEXT NOT NULL,
      session_id       TEXT NOT NULL,
      agent_session_id TEXT NOT NULL,
      branch           TEXT,
      pr_url           TEXT,
      pr_head_sha      TEXT,
      merged_at        INTEGER,
      bound_at         INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      PRIMARY KEY (task_id, episode_id)
    );
    CREATE INDEX IF NOT EXISTS idx_historical_task_work_episode_session
      ON historical_task_work_episode_bindings(session_id, episode_id);

    -- Every decision Foreman has faced on a session, append-only: the question it
    -- was asked, what it concluded, and what was actually sent back.
    --
    -- Its own table rather than columns on session_notes, and for a sharper reason
    -- than "history needs rows". session_notes is a CURRENT STATE row: one
    -- disposition and one updated_at, both meaning "what Foreman decided, and when".
    -- It is keyed note_key PRIMARY KEY and upserted, so each write destroys its
    -- predecessor - and the UI's Approve deliberately nulls brief/recommendation,
    -- because after you answer there IS no current recommendation. All three of
    -- those are correct for a live pointer and fatal for a record.
    --
    -- What makes this buildable is that the marker already exists: classifyPending
    -- computes a stable id for each waiting episode and the worker already sends it
    -- as handledMarker for its own idempotency. So episode identity costs nothing,
    -- and (note_key, marker) is unique BY CONSTRUCTION - the worker refuses to
    -- re-handle a marker it has stamped, and a human's later Approve updates that
    -- same row rather than appending a second one.
    --
    -- The pane is the load-bearing column. For a terminal ask - a permission prompt,
    -- an AskUserQuestion menu - the child's screen is the ONLY place the question
    -- ever exists: Claude appends the assistant turn when a tool call COMPLETES, so
    -- a blocked dialog is not in the transcript, and the worker reads the pane once
    -- and drops it. Not capturing it here does not defer the question, it loses it.
    --
    -- session_id is provenance only, never joined on: it is synthetic (tty+pid+start)
    -- and re-mints on restart, which is why note_key is the key here as it is there.
    CREATE TABLE IF NOT EXISTS foreman_episodes (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      note_key       TEXT NOT NULL,
      session_id     TEXT NOT NULL,
      marker         TEXT NOT NULL,  -- Pending.marker: this waiting episode's identity
      situation      TEXT NOT NULL,  -- PendingSituation
      surface        TEXT NOT NULL,  -- input-review | terminal
      question       TEXT NOT NULL,  -- the ask, verbatim
      pane           TEXT,           -- the child's screen at decision time (terminal only)
      menu           TEXT,           -- JSON PaneDialog: the rows the model chose among
      review_id      TEXT,           -- reviews.id when the ask arrived as a review
      purpose        TEXT,
      brief          TEXT,
      recommendation TEXT,
      classification TEXT,
      confidence     REAL,
      tier           INTEGER,
      -- The shadow measurement: what the cheap tier would have done, and how that compared
      -- with the full review that actually acted. Written only under the shadow posture,
      -- and NULL everywhere else - which is "not measured", not "agreed". Deliberately
      -- separate from tier, which keeps reporting the tier whose verdict was USED (2 under
      -- shadow). Also ALTERed in migrate(), for a db that predates them.
      cheap_action   TEXT,           -- answer | escalate | skip | route-up
      divergence     TEXT,           -- deferred | agree | cheap-over-eager | cheap-too-cautious | minor
      -- Why the tier ladder landed where it did: TriageOutcome.reason, verbatim. The
      -- cheap tier has always computed this and always dropped it on the next log line.
      -- Free text rather than a CHECKed vocabulary because one arm interpolates an error
      -- ('tier1-failed: <err>'). Also ALTERed in migrate().
      triage_reason  TEXT,
      -- Why a skipped row was skipped, when the disposition alone does not say. Today only
      -- 'stale': the reviewer reached a verdict and the session moved on before it could be
      -- delivered, which is a race rather than a judgment and was 74% of the skip pile.
      skip_reason    TEXT,           -- stale
      disposition    TEXT NOT NULL,
      last_action    TEXT,
      sent_text      TEXT,           -- what was actually delivered
      sent_option    TEXT,           -- JSON {number,label} for a menu selection
      sent_by        TEXT,           -- foreman | you: who authored what was delivered
      created_at     INTEGER NOT NULL,
      resolved_at    INTEGER,
      -- Who DECIDED the episode, which is a different question from who sent the text
      -- and has a different answer on every path where nothing was sent. A dismissal
      -- resolves an episode without delivering a word, so sent_by is null there while
      -- resolved_by is 'you'; folding the two together made a dismissal indistinguishable
      -- from an approval, and the card read "You approved" over a header saying you
      -- dismissed it. Null while the episode is still open.
      resolved_by    TEXT            -- foreman | you
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_foreman_episodes_marker
      ON foreman_episodes(note_key, marker);
    CREATE INDEX IF NOT EXISTS idx_foreman_episodes_key
      ON foreman_episodes(note_key, created_at DESC);

    CREATE TABLE IF NOT EXISTS session_notes (
      note_key       TEXT PRIMARY KEY,
      purpose        TEXT,
      brief          TEXT,
      recommendation TEXT,
      disposition    TEXT NOT NULL,
      last_action    TEXT,
      handled_marker TEXT,
      updated_at     INTEGER NOT NULL
    );

    -- What each session is currently attempting to solve. Keyed exactly like session_notes
    -- (noteKeyFor = agentSessionId ?? synthetic id) so it shares that lifecycle, but kept
    -- in its own row: the note has one disposition and one updated_at that mean "what
    -- Foreman decided, and when", and a second writer sharing them would corrupt both.
    CREATE TABLE IF NOT EXISTS session_goals (
      note_key                TEXT PRIMARY KEY,
      text                    TEXT,              -- compact durable objective for the card
      source                  TEXT,              -- 'heuristic' (initial raw ask) | 'model'
      objective               TEXT,              -- durable completion contract
      prompt                  TEXT,              -- latest filtered human instruction
      focus                   TEXT,              -- compact latest instruction
      relationship            TEXT,              -- initial | steer | amend | replace | unclear
      rationale               TEXT,              -- why the latest relationship was chosen
      objective_version       INTEGER NOT NULL DEFAULT 0,
      prompt_revision         INTEGER NOT NULL DEFAULT 0,
      resolved_prompt_revision INTEGER NOT NULL DEFAULT 0,
      pending_prompts         TEXT NOT NULL DEFAULT '[]', -- unresolved revisions, oldest first
      updated_at              INTEGER NOT NULL
    );

    -- Whether Foreman is invited to act in a session. Keyed like session_notes so the
    -- invite shares that lifecycle (rotation, reset, prune), and one row per key holds
    -- the latest explicit state: 'dispatch' (Mission Control launched this terminal
    -- session for a task), 'operator' (a human invited Foreman), or 'withdrawn' - the
    -- tombstone an operator's withdrawal writes. The tombstone is a stored fact rather
    -- than a deleted row because withdrawal must beat the IMPLICIT grant an SDK-runtime
    -- session re-derives on every resolution, and must survive a restart. SDK sessions
    -- otherwise store nothing: their invite is implied by the runtime. The source domain
    -- is append-only from the moment it shipped - see docs/agent-guides/change-contracts.md.
    CREATE TABLE IF NOT EXISTS foreman_invites (
      note_key   TEXT PRIMARY KEY,   -- noteKeyFor(s), same key as session_notes
      source     TEXT NOT NULL CHECK (source IN ('dispatch','operator','withdrawn')),
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Reusable workflow judges. guidance_md is exact operator-authored Markdown: no
    -- normalized copy exists and every write names this column directly.
    --
    -- import_provenance_json records where an IMPORTED Persona's guidance was read from
    -- (PersonaProvenance: path, repo, plugin version, content hash, imported-at). NULL is the
    -- ordinary case and means "authored here", which is also what every row written before the
    -- column existed genuinely was - hence nullable with no default. It is live-catalog data
    -- only: published versions carry their own guidance copy and never consult this.
    CREATE TABLE IF NOT EXISTS personas (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      description     TEXT NOT NULL DEFAULT '',
      guidance_md     TEXT NOT NULL,
      runner_id       TEXT,
      model_id        TEXT,
      revision        INTEGER NOT NULL DEFAULT 1,
      archived_at     INTEGER,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      import_provenance_json TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_personas_normalized_name
      ON personas(normalized_name);

    -- Reusable instructions a workflow types into its bound session. prompt_md is exact
    -- operator-authored Markdown: no normalized copy exists and every write names this
    -- column directly, because this text is DELIVERED verbatim rather than summarized.
    --
    -- A table of its own rather than columns on personas, because the two answer different
    -- questions: a Persona picks a model and returns a verdict, an action picks a prompt and
    -- a proof. Sharing a row would give every Persona reader a nullable completion kind to
    -- ignore and every action a runner it never uses.
    --
    -- completion_kind is a closed, server-owned adapter id (see
    -- SESSION_ACTION_COMPLETION_KINDS). It is deliberately NOT tolerant on read: a value this
    -- build cannot interpret fails the row rather than degrading to session_turn, which would
    -- complete a historical action under a weaker proof than it was written with.
    --
    -- required_skill_id names a skill CAPABILITY and never a command. The harness-native
    -- invocation is resolved immediately before send, so an argv can never be persisted here
    -- and can never reach an exported published version.
    CREATE TABLE IF NOT EXISTS session_actions (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      normalized_name   TEXT NOT NULL,
      description       TEXT NOT NULL DEFAULT '',
      prompt_md         TEXT NOT NULL,
      required_skill_id TEXT,
      completion_kind   TEXT NOT NULL,
      revision          INTEGER NOT NULL DEFAULT 1,
      archived_at       INTEGER,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_session_actions_normalized_name
      ON session_actions(normalized_name);

    -- The Global Command catalog: what each portable workflow slot runs on this machine.
    --
    -- One row per built-in slot, seeded on first open, holding the repository-NEUTRAL default
    -- argv. Normalized out of the workflows app_config blob it used to share, because a
    -- command is no longer a preference: it has its own revision, its own compare-and-swap
    -- write path, and its own live projection, none of which a JSON blob under one key can
    -- give four independently edited slots.
    --
    -- The slot column carries NO CHECK constraint on purpose. The slot list is append-only,
    -- and a CHECK would make shipping a fifth slot an ALTER-and-rebuild of a table holding
    -- operator data rather than one line in a TypeScript array.
    --
    -- default_command_json is nullable and stores an argv array; NULL is "no machine-wide
    -- command", which is a different fact from an empty argv and is the fresh-install state.
    CREATE TABLE IF NOT EXISTS workflow_commands (
      slot                 TEXT PRIMARY KEY,
      default_command_json TEXT,
      revision             INTEGER NOT NULL DEFAULT 1,
      created_at           INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL
    );

    -- One repository or subdirectory exception to a slot's default command.
    --
    -- Separate rows rather than a JSON array on the slot, because these elements have
    -- identity: (slot, repo_root) is the key resolution picks by and the key a duplicate
    -- write has to be refused on, and a composite PRIMARY KEY is the only place that
    -- refusal cannot be forgotten. repo_root is a repository root OR a path beneath one -
    -- the monorepo override - and the longest match wins at resolution time.
    CREATE TABLE IF NOT EXISTS workflow_command_overrides (
      slot         TEXT NOT NULL,
      repo_root    TEXT NOT NULL,
      command_json TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      PRIMARY KEY (slot, repo_root)
    );

    -- The complete workflow family is front-loaded in Phase 1 so published definitions,
    -- executions, delivery identity and later audit data all share one migration boundary.
    CREATE TABLE IF NOT EXISTS workflow_definitions (
      id                     TEXT PRIMARY KEY,
      name                   TEXT NOT NULL,
      normalized_name        TEXT NOT NULL,
      description            TEXT NOT NULL DEFAULT '',
      draft_graph_json       TEXT NOT NULL,
      completion_policy_json TEXT NOT NULL,
      resumption_policy      TEXT,
      binding_defaults_json  TEXT NOT NULL,
      draft_revision         INTEGER NOT NULL DEFAULT 1,
      current_version_id     TEXT,
      archived_at            INTEGER,
      created_at             INTEGER NOT NULL,
      updated_at             INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_definitions_normalized_name
      ON workflow_definitions(normalized_name);

    CREATE TABLE IF NOT EXISTS workflow_versions (
      id                     TEXT PRIMARY KEY,
      workflow_id            TEXT NOT NULL,
      version                INTEGER NOT NULL,
      source_draft_revision  INTEGER NOT NULL,
      graph_json             TEXT NOT NULL,
      completion_policy_json TEXT NOT NULL,
      resumption_policy      TEXT,
      binding_defaults_json  TEXT NOT NULL,
      published_at           INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_versions_number
      ON workflow_versions(workflow_id, version);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_versions_draft
      ON workflow_versions(workflow_id, source_draft_revision);

    -- repo_root is WHICH CHECKOUT this binding reviews, and the second column of the
    -- active-binding key. Empty string means "the session's own checkout" - every row ever
    -- written, and every single-repo binding still. A non-empty value names a secondary
    -- repository of the session's multi-repo task, and session_cwd/session_repo_root then
    -- hold that repository's worktree and root.
    --
    -- NOT NULL with an empty-string default, never nullable: SQLite treats nulls as distinct
    -- in a unique index, so a null here would let two active bindings own one conversation.
    -- The default is also the whole backfill - every pre-feature row IS a session's own
    -- checkout - which is why no UPDATE accompanies the ALTER in migrate().
    CREATE TABLE IF NOT EXISTS workflow_bindings (
      id                  TEXT PRIMARY KEY,
      workflow_version_id TEXT NOT NULL,
      note_key            TEXT NOT NULL,
      session_id          TEXT,
      session_agent       TEXT NOT NULL DEFAULT '',
      session_name        TEXT NOT NULL DEFAULT '',
      session_cwd         TEXT,
      session_repo_root   TEXT,
      repo_root           TEXT NOT NULL DEFAULT '',
      trigger_mode        TEXT NOT NULL,
      delivery_mode       TEXT NOT NULL,
      state               TEXT NOT NULL,
      max_repair_rounds   INTEGER NOT NULL,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL
    );
    -- idx_workflow_bindings_active_note_repo is created by migrate(), NOT here, for the same
    -- reason idx_workflow_submissions_segment is: this block runs first and its CREATE TABLE
    -- is a no-op on an existing database, so an index over repo_root here would be built
    -- against a table that does not have the column yet.
    CREATE INDEX IF NOT EXISTS idx_workflow_bindings_version
      ON workflow_bindings(workflow_version_id);

    CREATE TABLE IF NOT EXISTS workflow_runs (
      id                    TEXT PRIMARY KEY,
      binding_id            TEXT NOT NULL,
      workflow_version_id   TEXT NOT NULL,
      status                TEXT NOT NULL,
      current_phase         TEXT NOT NULL,
      max_repair_rounds     INTEGER NOT NULL,
      trigger_source        TEXT NOT NULL,
      trigger_key           TEXT NOT NULL,
      inspector_pr_key      TEXT,
      inspector_head_sha    TEXT,
      gate_state_json       TEXT,
      started_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL,
      completed_at          INTEGER,
      evidence_pruned_at    INTEGER,
      disabled_nodes_json   TEXT,
      persona_directives_json TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_runs_trigger
      ON workflow_runs(trigger_key);
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_binding
      ON workflow_runs(binding_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_updated
      ON workflow_runs(updated_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_status_updated
      ON workflow_runs(status, updated_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_version_updated
      ON workflow_runs(workflow_version_id, updated_at DESC, id DESC);

    -- One immutable evidence snapshot, identified by (round, segment).
    --
    -- round counts REPAIR and nothing else, so max_repair_rounds compares it alone.
    -- segment counts the successive evidence snapshots inside one repair round that a
    -- completed session action creates. The two are separate columns rather than one
    -- ordinal because they answer to different budgets: an arbitrary number of actions must
    -- never consume a repair round, and a repair must always restart the graph at Session.
    --
    -- The three continuation columns are all-or-nothing with a nonzero segment, enforced at
    -- the row boundary in store.ts. continuation_node_attempt_id deliberately names an
    -- attempt in the PARENT submission: that attempt ran against the parent evidence and its
    -- completion is what authorized downstream work against this one.
    CREATE TABLE IF NOT EXISTS workflow_submissions (
      id                   TEXT PRIMARY KEY,
      run_id               TEXT NOT NULL,
      round                INTEGER NOT NULL,
      segment              INTEGER NOT NULL DEFAULT 0,
      parent_submission_id TEXT,
      continuation_node_id TEXT,
      continuation_node_attempt_id TEXT,
      mode                 TEXT NOT NULL,
      trigger_source       TEXT NOT NULL,
      trigger_key          TEXT NOT NULL,
      evidence_fingerprint TEXT NOT NULL,
      context_json         TEXT NOT NULL,
      evidence_json        TEXT NOT NULL,
      pr_head_sha          TEXT,
      status               TEXT NOT NULL,
      created_at           INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL,
      completed_at         INTEGER
    );
    -- idx_workflow_submissions_segment is created by migrate(), NOT here. This block runs
    -- before migrate(), and on an upgraded database the CREATE TABLE above is a no-op - so
    -- an index over the segment column here would be built against a table that lacks the
    -- column yet, and every daemon start on an existing machine would fail to open the
    -- database. It lives beside its ALTER, which is the house rule for exactly this reason.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_submissions_trigger
      ON workflow_submissions(trigger_key);

    CREATE TABLE IF NOT EXISTS workflow_node_attempts (
      id                    TEXT PRIMARY KEY,
      submission_id         TEXT NOT NULL,
      node_id               TEXT NOT NULL,
      attempt               INTEGER NOT NULL,
      state                 TEXT NOT NULL,
      persona_snapshot_json TEXT,
      -- The action this attempt executes, frozen from the run's immutable version. Its own
      -- column rather than a reuse of persona_snapshot_json: every reader of that column
      -- treats the record as something that produces a verdict, and an action produces none.
      session_action_snapshot_json TEXT,
      -- Exact run-scoped feedback this Persona attempt claimed. NULL for every non-Persona
      -- attempt and for a Persona that started while no directive was active.
      operator_directive_json TEXT,
      runner_id             TEXT,
      model_id              TEXT,
      verdict_json          TEXT,
      output_json           TEXT,
      retry_at              INTEGER,
      input_fingerprint     TEXT NOT NULL,
      error                 TEXT,
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL,
      started_at            INTEGER,
      finished_at           INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_node_attempts_identity
      ON workflow_node_attempts(submission_id, node_id, attempt);
    CREATE INDEX IF NOT EXISTS idx_workflow_node_attempts_state
      ON workflow_node_attempts(state, retry_at);

    CREATE TABLE IF NOT EXISTS workflow_edge_receipts (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      submission_id     TEXT NOT NULL,
      edge_id            TEXT NOT NULL,
      source_attempt_id  TEXT NOT NULL,
      payload_json       TEXT NOT NULL,
      created_at         INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_edge_receipts_identity
      ON workflow_edge_receipts(submission_id, edge_id, source_attempt_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_edge_receipts_edge
      ON workflow_edge_receipts(submission_id, edge_id);

    CREATE TABLE IF NOT EXISTS workflow_deliveries (
      id             TEXT PRIMARY KEY,
      run_id         TEXT NOT NULL,
      submission_id  TEXT NOT NULL,
      kind           TEXT NOT NULL,
      -- The node attempt that owns this packet, for 'session_action' only. NULL for every
      -- other kind, including every historical pr_handoff row, and required for an action -
      -- both enforced at the row boundary in store.ts. Two action nodes in one submission
      -- could legitimately render the same payload, so (submission_id, kind, payload_sha256)
      -- alone would deduplicate two genuinely distinct packets into one.
      node_attempt_id TEXT,
      session_id     TEXT NOT NULL,
      note_key       TEXT NOT NULL,
      payload        TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      state          TEXT NOT NULL,
      error          TEXT,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      delivered_at   INTEGER,
      payload_pruned_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_deliveries_identity
      ON workflow_deliveries(submission_id, kind, payload_sha256);
    CREATE INDEX IF NOT EXISTS idx_workflow_deliveries_run
      ON workflow_deliveries(run_id, created_at);
    -- The two node_attempt_id indexes are created by migrate() beside their ALTER, for the
    -- reason spelled out on workflow_submissions above.

    CREATE TABLE IF NOT EXISTS workflow_llm_calls (
      id               TEXT PRIMARY KEY,
      run_id           TEXT NOT NULL,
      submission_id    TEXT NOT NULL,
      node_attempt_id  TEXT,
      purpose          TEXT NOT NULL,
      runner_id        TEXT NOT NULL,
      model_id         TEXT NOT NULL,
      attempt          INTEGER NOT NULL,
      state            TEXT NOT NULL,
      started_at       INTEGER NOT NULL,
      finished_at      INTEGER,
      duration_ms      INTEGER,
      input_bytes      INTEGER NOT NULL DEFAULT 0,
      output_bytes     INTEGER NOT NULL DEFAULT 0,
      cost_usd         REAL,
      error_code       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_llm_calls_run
      ON workflow_llm_calls(run_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_workflow_llm_calls_submission
      ON workflow_llm_calls(submission_id, purpose);

    CREATE TABLE IF NOT EXISTS workflow_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id       TEXT NOT NULL,
      ts           INTEGER NOT NULL,
      event_kind   TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_events_run
      ON workflow_events(run_id, id);

    -- One external orchestrator's durable claim on exactly one Workflow binding.
    --
    -- source_key is the PRIMARY KEY because it is the idempotency key: a caller that lost
    -- our response, or that retried after a daemon restart, derives the same key and gets
    -- the same binding back instead of creating a second one. binding_id is UNIQUE because
    -- a binding has at most one owner, so two orchestrators cannot both believe they
    -- started the same review.
    --
    -- source_id is stored separately and is display identity only. Nothing parses the
    -- opaque source_key back into ids; that spelling is internal and may change.
    --
    -- Every column is NOT NULL: SQLite treats NULLs as distinct inside a unique index, so a
    -- nullable half would let the row multiply on retry rather than collide. source_key says
    -- NOT NULL explicitly even though it is the primary key, because on a non-STRICT rowid
    -- table SQLite does NOT imply it - a long-standing compatibility quirk - so PRIMARY KEY
    -- alone would admit several NULL keys and lose the one-claim-per-source identity.
    CREATE TABLE IF NOT EXISTS workflow_binding_claims (
      source_key  TEXT NOT NULL PRIMARY KEY,
      source_kind TEXT NOT NULL,
      source_id   TEXT NOT NULL,
      binding_id  TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_binding_claims_binding
      ON workflow_binding_claims(binding_id);

    -- The durable owner of a pooled worktree a Workflow check is holding.
    --
    -- Not workflow_node_attempts.output_json, which holds the final CheckOutcome and
    -- nothing else. A lease is a RESOURCE, and a resource outlives the row that asked for
    -- it: a daemon killed mid-check has to be able to find the tree it was holding, prove
    -- it is still ours, and hand it back - long after attempt retention would have removed
    -- the attempt itself.
    --
    -- NO FOREIGN KEY to workflow_node_attempts, deliberately, and it must stay that way.
    -- PRAGMA foreign_keys = ON is set above, so a REFERENCES clause here would be
    -- ENFORCED, and both enforcement modes are wrong: ON DELETE CASCADE would delete this
    -- row when retention removes the attempt, destroying the only record of a tree that is
    -- still held; RESTRICT would make retention fail outright on a leaked lease. The
    -- requirement is precisely that this table outlives both. (It also matches the house
    -- rule that the ensemble family is the only one here that declares foreign keys.)
    --
    -- submission_id and node_id are CARRIED rather than joined for, for the same reason.
    -- Before a check node may retry, it has to answer "does this node still own an
    -- unresolved lease?" - because a retry is a NEW attempt id, so it carries a new holder
    -- token and would happily lease a DIFFERENT tree while the first group may still be
    -- writing into the original. There is no natural collision to rely on. A join through
    -- workflow_node_attempts would answer that correctly right up until the moment it
    -- matters, which is exactly when retention has deleted the attempt.
    --
    -- Every column is NOT NULL, and attempt_id says so explicitly even though it is the
    -- primary key: on a non-STRICT rowid table SQLite does NOT imply it (a long-standing
    -- compatibility quirk), so PRIMARY KEY alone would admit several NULL keys - see
    -- workflow_binding_claims above.
    --
    -- supervisor_pid = 0 and supervisor_start_ticks = '' are SENTINELS meaning "the gate
    -- was never released", and that state is load-bearing rather than filler. A row
    -- carrying the sentinel is positive proof that branch code never started, which is the
    -- one thing that distinguishes a crash between spawn and persist from a process group
    -- that is still alive - and only the first of those may have its tree returned on
    -- ownership alone. Do NOT "clean these up" into nullable columns: a NULL is
    -- indistinguishable from a row written by a build that did not set the column, and the
    -- distinction is what authorises a destructive return.
    --
    -- cleanup_state is the lease's own lifecycle: 'held' -> 'returning' -> 'returned', plus
    -- the terminal 'lost'. A failed return moves to 'returning' and STAYS there; it must
    -- never delete the row, release its reaper pin, or permit a second lease for the same
    -- attempt. 'lost' is the holder-mismatch terminal: the path is held by a token that is
    -- not ours, so no return is issued, the row is kept for audit, and the pin IS dropped
    -- (see check-lease.ts for why those two are compatible).
    CREATE TABLE IF NOT EXISTS workflow_check_leases (
      attempt_id             TEXT    NOT NULL PRIMARY KEY,
      submission_id          TEXT    NOT NULL,
      node_id                TEXT    NOT NULL,
      repo_root              TEXT    NOT NULL,
      lease_path             TEXT    NOT NULL,
      holder_token           TEXT    NOT NULL,
      cleanup_state          TEXT    NOT NULL,
      supervisor_pid         INTEGER NOT NULL,
      supervisor_start_ticks TEXT    NOT NULL,
      -- WHICH provider handed this tree over, and therefore which one must take it back.
      -- Read from the row on every release and NEVER re-probed from the current machine:
      -- that is the entire reason the column exists. A tree taken from the pool has to go
      -- back to the pool after the operator uninstalls treehouse, and a plain git worktree
      -- must never be handed to "treehouse return" because the binary reappeared.
      --
      -- NOT NULL DEFAULT 'treehouse', which is historically ACCURATE rather than merely
      -- convenient - see the migration in migrate(), and the warning about nullable columns
      -- a few lines above, which this default is what keeps clear of.
      provider               TEXT    NOT NULL DEFAULT 'treehouse',
      created_at             INTEGER NOT NULL,
      updated_at             INTEGER NOT NULL
    );
    -- UNIQUE over LIVE rows only. Two attempts believing they hold the same tree is the
    -- corruption this whole subsystem exists to prevent, so it fails at the insert - but
    -- the uniqueness has to be scoped to the states that mean "we are holding it", because
    -- terminal rows are retained for audit and the pool hands the SAME slot out again and
    -- again. Unscoped, the second check to ever use pool slot 3 would fail its insert
    -- against slot 3's retained 'returned' row, and would keep failing forever. This is the
    -- same seam that keeps the reaper's checkLeasePaths honest: retaining a row for audit
    -- and treating the table as a live index are different jobs, and the state filter is
    -- what makes both claims true at once. Write it as the WHERE, not as a convention.
    --
    -- Do not "restore" the unscoped index this was written as. The failure is not
    -- hypothetical and it is not recoverable: it strands a pool slot for every future run.
    -- Proven by "a pool slot can be leased again after an earlier lease of it went terminal"
    -- in test/workflow-check-lease.test.ts, which fails with UNIQUE constraint failed the
    -- moment the WHERE is removed.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_check_leases_path
      ON workflow_check_leases(lease_path) WHERE cleanup_state IN ('held', 'returning');
    CREATE INDEX IF NOT EXISTS idx_workflow_check_leases_node
      ON workflow_check_leases(submission_id, node_id);

    -- What each task source has already filed, and will never file again.
    --
    -- Its OWN table rather than de-duplicating against the three columns on tasks, and
    -- this is the load-bearing decision of the whole feature:
    --
    --   A TASK YOU DELETED MUST STAY DELETED. Dedupe against tasks means deleting a
    --   swept task makes it un-seen, so the next sweep files it again - the source
    --   becomes impossible to say no to, and the delete button becomes a snooze button
    --   that does not even snooze.
    --
    -- So a row here OUTLIVES the task it produced, and holds no reference to one: there
    -- is nothing to join on, which is what stops the next reader from re-introducing the
    -- bug. Re-filing an item you deleted is a deliberate act - "Forget seen items" on the
    -- source, which clears its rows.
    --
    -- Both key columns are NOT NULL, which the ON CONFLICT depends on: SQLite treats
    -- NULLs as DISTINCT inside a unique index, so a nullable half would make the upsert
    -- silently become an insert and the row would multiply on every sweep.
    CREATE TABLE IF NOT EXISTS task_source_seen (
      source_id   TEXT NOT NULL,   -- TaskSourceInstance.id
      external_id TEXT NOT NULL,   -- stable id in the EXTERNAL system, e.g. owner/repo#123
      url         TEXT,            -- deep link, kept for provenance; never matched on
      seen_at     INTEGER NOT NULL,
      PRIMARY KEY (source_id, external_id)
    );

    -- API-equivalent estimates and token usage, one row per source event or export window.
    --
    -- Its OWN table rather than a new kind in session_events, and the reason is written
    -- down at logEvent below: that table has exactly one writer, and hooksEverSeen asks
    -- "any row for this session?" - not "any row of a hook kind". A second writer would
    -- make every session it touched claim hooks it never emitted, which is the
    -- installation fact the work queue gates on. Non-hook records need their own
    -- tables for exactly this reason.
    --
    -- Keyed on note_key, never on session_id: a session id is synthetic (tty+pid+start)
    -- and re-mints on every restart, while this record is meant to outlive the session
    -- that made it. OTel's session.id attribute IS the agent session id, which is what
    -- noteKeyFor already prefers.
    CREATE TABLE IF NOT EXISTS usage_ledger (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      note_key      TEXT NOT NULL,           -- agentSessionId (OTel session.id)
      session_id    TEXT,                    -- provenance only; never joined on
      agent         TEXT NOT NULL DEFAULT 'claude',
      -- Both NOT NULL with an empty-string "unknown", and that is load-bearing rather
      -- than tidiness: SQLite treats NULLs as DISTINCT inside a UNIQUE index, so a
      -- nullable model_id would make the ON CONFLICT below never fire for a datapoint
      -- that carried no model attribute - every retry of that export would insert a new
      -- row and the total would climb on its own. The writer coalesces; nothing stores null.
      model_id      TEXT NOT NULL DEFAULT '',  -- raw, e.g. claude-opus-4-8[1m]
      query_source  TEXT NOT NULL DEFAULT '',  -- main | subagent | auxiliary
      -- The datapoint's dedup identity, as TEXT. timeUnixNano is ~1.78e18, well past
      -- Number.MAX_SAFE_INTEGER (9.007e15), so parsing it as a JS number would silently
      -- collide adjacent windows. Holds timeUnixNano for a delta datapoint (each export
      -- is a distinct window, and the rows accumulate) and startTimeUnixNano for a
      -- cumulative one (the series has one fixed start, so every export replaces the same
      -- row with the newer running total). SUM over rows is correct in both cases.
      window_end_ns TEXT NOT NULL,
      ts            INTEGER NOT NULL,        -- window end in epoch ms, for range queries
      -- Who the spend belongs to: 'session' for work a human asked a card to do,
      -- 'automation' for a headless run one of the autonomous loops made on its own.
      --
      -- A column rather than a prefix test on note_key, because four separate aggregate
      -- queries need the distinction and 'note_key LIKE ''foreman:%'' OR ...' repeated in
      -- each is a convention enforced nowhere - the fifth query would silently omit a role.
      -- The DEFAULT is what makes the migration correct on an existing database: every row
      -- written before this column existed came from a session's OTel or rollout stream.
      --
      -- An automation row keys window_end_ns to the RUN's own id (claude's session_id,
      -- codex's thread_id) rather than an export window, which is what makes a retried
      -- report idempotent and what lets SESSION_SPEND_ONLY find a claude run's OTel twin.
      spend_kind    TEXT NOT NULL DEFAULT 'session',
      -- Which ingest wrote the row: 'otel' | 'driver' | 'rollout' | 'report'. See the
      -- addColumn in migrate() for why this cannot be derived from the columns beside it,
      -- and why '' (the upgrade default) means "predates the column" and nothing else.
      writer        TEXT NOT NULL DEFAULT '',
      cost_usd      REAL NOT NULL DEFAULT 0,
      cost_basis    TEXT NOT NULL DEFAULT 'reported',
      cost_known    INTEGER NOT NULL DEFAULT 1,
      pricing_version TEXT NOT NULL DEFAULT '',
      input         INTEGER NOT NULL DEFAULT 0,
      output        INTEGER NOT NULL DEFAULT 0,
      reasoning_output INTEGER NOT NULL DEFAULT 0,
      cache_read    INTEGER NOT NULL DEFAULT 0,
      cache_write   INTEGER NOT NULL DEFAULT 0,
      UNIQUE(note_key, model_id, query_source, window_end_ns)
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_key ON usage_ledger(note_key, ts);
    CREATE INDEX IF NOT EXISTS idx_ledger_ts  ON usage_ledger(ts);
    -- The index on spend_kind is NOT here: this block runs before migrate() adds that
    -- column, so an existing database would fail to open on a CREATE naming it. See the
    -- addColumn beside it.

    -- Durable byte cursors for harness-owned append-only usage sources. The event rows
    -- and cursor move in one transaction, so a crash can replay but cannot skip usage.
    CREATE TABLE IF NOT EXISTS usage_sources (
      source_key   TEXT PRIMARY KEY,
      agent        TEXT NOT NULL,
      offset       INTEGER NOT NULL,
      model_id     TEXT NOT NULL DEFAULT '',
      discard_partial INTEGER NOT NULL DEFAULT 0,
      file_id      TEXT NOT NULL DEFAULT '',
      updated_at   INTEGER NOT NULL
    );

    -- The last skills generation each session was told about. Durable on purpose:
    -- held in memory, a daemon restart would forget every ack while the generation
    -- stayed put, and the next idle moment would type /reload-skills into every
    -- claude on the machine at once.
    CREATE TABLE IF NOT EXISTS skills_acks (
      note_key   TEXT PRIMARY KEY,   -- noteKeyFor(s), same key as session_notes
      generation INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Sessions the daemon RUNS rather than finds: one row per embedded (SDK-runtime)
    -- session. Live sessions are otherwise never persisted because the OS can rebuild
    -- them, but not these: terminal discovery deliberately excludes daemon-owned
    -- subprocesses. Without this row a daemon restart loses the session, its harness-native
    -- thread id (the only way to resume the conversation), and any task bound to it.
    --
    -- The id is the supervisor's own sdk:<uuid>, which is why it is durable: it is the
    -- registry's map key AND this primary key, so a restored row registers the same card
    -- rather than a second one. agent_session_id is nullable because it does not exist
    -- until the harness mints it - that is the driver bound event, and a row written before
    -- it lands is a session that was starting when the daemon died.
    --
    -- Ordinary table with no REFERENCES clause (the ensemble family stays the only one
    -- declaring foreign keys) and no index: the only reads are by primary key and the
    -- whole-table restore sweep, which runs once at startup over the embedded-session ledger.
    CREATE TABLE IF NOT EXISTS sdk_sessions (
      id                TEXT PRIMARY KEY NOT NULL,
      agent             TEXT NOT NULL,
      agent_session_id  TEXT,
      cwd               TEXT NOT NULL,
      task_id           TEXT,
      model             TEXT,
      effort            TEXT,
      permission_mode   TEXT,
      status            TEXT NOT NULL,
      -- Independent of lifecycle status: a suspended driver may owe a continuation turn.
      turn_in_progress  INTEGER NOT NULL DEFAULT 0,
      -- The name a PERSON gave this session, and only that. NULL is not "unnamed" - it means
      -- nobody has renamed this card, so its name is still derived (see restoredName: the
      -- bound task's title, else the cwd basename, else the id). The distinction is the whole
      -- point of the column rather than caching the launch name here: a dispatch's title is
      -- refined by an async model call afterwards, so a persisted launch name would make a
      -- restart revert every card to its pre-refinement guess. A rename outranks both.
      display_name      TEXT,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );

    -- Human turns the daemon still owns. Unlike a harness's internal queue, rows here have
    -- not been accepted by Claude or Codex and can therefore be recalled into the composer.
    -- note_key follows session notes and work queues so a transient pane replacement does
    -- not strand the outbox. A claimed row remains durable until delivery is acknowledged.
    CREATE TABLE IF NOT EXISTS pending_turns (
      id          TEXT PRIMARY KEY NOT NULL,
      note_key    TEXT NOT NULL,
      seq         INTEGER NOT NULL,
      text        TEXT NOT NULL,
      state       TEXT NOT NULL,
      revision    INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      claimed_at  INTEGER,
      last_error  TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_turns_order
      ON pending_turns(note_key, seq);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_turns_sending
      ON pending_turns(note_key) WHERE state = 'sending';

    CREATE TABLE IF NOT EXISTS foreman_queues (
      note_key        TEXT PRIMARY KEY,   -- noteKeyFor(s) = agentSessionId ?? synthetic id
      cwd             TEXT,               -- + branch: the re-attach hint when the key dies
      branch          TEXT,
      wrapup_asked_at INTEGER,            -- the drain ask fires exactly once
      wrapup_answer   TEXT,
      prompted_goal   TEXT,               -- the goal the prompted trigger last fired on
      updated_at      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS foreman_queue_items (
      id                TEXT PRIMARY KEY,
      note_key          TEXT NOT NULL,
      seq               INTEGER NOT NULL,  -- whole-list renumber on reorder, in a txn
      intent            TEXT NOT NULL,
      state             TEXT NOT NULL,
      round             INTEGER NOT NULL DEFAULT 0,
      base_sha          TEXT,              -- HEAD at delivery -> scopes the diff
      transcript_anchor INTEGER,           -- transcript byte offset at delivery -> scopes it
      gaps              TEXT,              -- JSON TrackedGap[]
      send_attempts     INTEGER NOT NULL DEFAULT 0,
      verify_failures   INTEGER NOT NULL DEFAULT 0,
      escalation_reason TEXT,
      last_verdict      TEXT,
      approved_at       INTEGER,           -- set when a human approves a 'proposed' item
      proposed_payload  TEXT,              -- the exact text a 'proposed' item would send
      recovered_at      INTEGER,           -- adopted mid-send after a restart -> never resend
      revision          INTEGER NOT NULL DEFAULT 0,  -- CAS token for edits
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      sent_at           INTEGER,
      completed_at      INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_fqi_queue ON foreman_queue_items(note_key, seq);
    -- The re-attach hint asks "any queue at THIS cwd?" once per discovered session
    -- per sweep, several times a second, on the one synchronous handle that also
    -- serves hook ingest and SSE. Unindexed that is a full scan per session per
    -- sweep, and the table only ever grows: every /clear mints a new note key and so
    -- a new row.
    CREATE INDEX IF NOT EXISTS idx_fq_cwd ON foreman_queues(cwd);

    -- The Inspector's ADOPTION ledger. A row here is the permission to comment on a
    -- pull request, and the absence of one is why we don't comment on everyone else's.
    -- Rows are written only from a signal that PROVES we opened the PR, and they
    -- outlive the session that did (a PR is not done when its session exits).
    CREATE TABLE IF NOT EXISTS inspector_prs (
      key              TEXT PRIMARY KEY,  -- "owner/repo#123"
      url              TEXT NOT NULL,
      owner            TEXT NOT NULL,
      repo             TEXT NOT NULL,
      number           INTEGER NOT NULL,
      repo_root        TEXT,              -- INSPECTOR.md + standards + the allowlist check
      cwd              TEXT,              -- a checkout to run gh from
      session_id       TEXT,              -- nullable: the PR outlives the session
      source           TEXT NOT NULL,     -- hook | legacy
      state            TEXT NOT NULL,     -- open | closed
      head_sha         TEXT,              -- head as of the last completed review
      review_posture   TEXT,              -- consent posture that produced head_sha
      round            INTEGER NOT NULL DEFAULT 0,
      last_reviewed_at INTEGER,
      last_error       TEXT,
      fail_count       INTEGER NOT NULL DEFAULT 0,  -- consecutive failures, for the backoff
      last_fail_kind   TEXT,              -- push-fixable | persistent (may a push skip the wait)
      next_attempt_at  INTEGER,          -- not before this; null = due now
      last_attempt_sha TEXT,             -- the head the backoff was earned on
      merged_at        INTEGER,          -- when YOLO mode landed it; null = we did not
      merge_block      TEXT,             -- why it has not merged itself (see shipping.ts)
      -- What the LAST poll saw on GitHub, as opposed to what the last completed REVIEW was
      -- about. head_sha above only advances when a review finishes, so it cannot answer
      -- "has the branch reached the PR yet" - which is exactly the question a pull_request
      -- session action has to answer before it lets downstream stages read fresh evidence.
      -- Written every tick from the snapshot fetchPr already pays for, so this is the
      -- durable form of a signal that was otherwise transient, not a second poller.
      observed_head_sha  TEXT,
      observed_state     TEXT,           -- OPEN | CLOSED | MERGED
      observed_at        INTEGER,
      head_ref_name      TEXT,           -- the branch the PR is opened FROM
      title              TEXT,           -- as of the last poll; NULL until one happens
      adopted_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inspector_prs_state ON inspector_prs(state);

    -- The Inspector's PROVENANCE ledger: one row per ISSUE per PR, not per comment.
    --
    -- The unique index is the dedup, and it is here rather than in code on purpose:
    -- "don't post the same complaint twice" is the rule that keeps an automated
    -- reviewer tolerable, and a rule enforced by a code path is a rule someone
    -- eventually routes around. The fingerprint deliberately excludes the line number,
    -- so a push that shifts code down doesn't re-raise everything.
    CREATE TABLE IF NOT EXISTS inspector_comments (
      id                  TEXT PRIMARY KEY,  -- our uuid, also embedded in the marker
      pr_key              TEXT NOT NULL,
      fingerprint         TEXT NOT NULL,     -- sha1(path + normalized title)
      path                TEXT,
      line                INTEGER,
      title               TEXT NOT NULL,
      body                TEXT,
      severity            TEXT NOT NULL,
      round               INTEGER NOT NULL,
      status              TEXT NOT NULL,     -- drafted | posting | open | resolved
      replies             INTEGER NOT NULL DEFAULT 0,
      answered_comment_id INTEGER,           -- newest foreign comment we've answered
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL
    );
    -- No index on (pr_key) alone: it is the leftmost prefix of the unique index below,
    -- so it can serve no query that one cannot, and it costs a write per row.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_inspector_comments_fp
      ON inspector_comments(pr_key, fingerprint);

    -- ---- recurring missions ----
    --
    -- One row per schedule the operator created. The TEMPLATE is not here: it lives on
    -- the immutable revision this row points at, because history has to be able to say
    -- what a run was configured to do at the moment it ran, and a rename must not
    -- rewrite what already happened.
    CREATE TABLE IF NOT EXISTS mission_schedules (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      enabled        INTEGER NOT NULL DEFAULT 0,
      archived_at    INTEGER,           -- archived: hidden from the catalog, deletes nothing
      expression     TEXT NOT NULL,     -- five cron fields, canonical spacing
      timezone       TEXT NOT NULL,     -- canonical IANA id, as Intl resolved it
      overlap_policy TEXT NOT NULL,
      missed_policy  TEXT NOT NULL,
      execution_mode TEXT NOT NULL,
      runner_id      TEXT,              -- always NULL in V1; the always-on host, later
      revision       INTEGER NOT NULL,  -- -> mission_schedule_revisions.revision
      -- The durable cursor, in UTC epoch milliseconds. This, not an in-memory timer, is
      -- what makes catch-up correct: timers stop when the laptop sleeps and are lost on
      -- restart, and neither event may lose a due instant. NULL only for paused,
      -- archived, or uncomputable.
      next_run_at    INTEGER,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    );
    -- The tick asks "which enabled, unarchived schedules are due?" on a bounded loop.
    CREATE INDEX IF NOT EXISTS idx_mission_schedules_due
      ON mission_schedules(enabled, next_run_at);

    -- Immutable. An edit inserts revision n+1 and repoints the schedule; nothing here is
    -- ever updated. Cadence and policies are COPIED rather than joined because they are
    -- what explain a historical decision, and the schedule's current values do not.
    CREATE TABLE IF NOT EXISTS mission_schedule_revisions (
      schedule_id    TEXT NOT NULL,
      revision       INTEGER NOT NULL,
      template_json  TEXT NOT NULL,
      expression     TEXT NOT NULL,
      timezone       TEXT NOT NULL,
      overlap_policy TEXT NOT NULL,
      missed_policy  TEXT NOT NULL,
      execution_mode TEXT NOT NULL,
      runner_id      TEXT,
      created_at     INTEGER NOT NULL,
      PRIMARY KEY (schedule_id, revision)
    );

    -- The exactly-once ledger. One row per (schedule, instant), and the UNIQUE index is
    -- the guarantee itself rather than a check somewhere in TypeScript: two ticks, two
    -- processes or a restart mid-claim all collide on the same key, and exactly one wins.
    --
    -- Both key columns are NOT NULL, which is load-bearing. SQLite treats NULLs as
    -- distinct, so a nullable column in an index you ON CONFLICT against turns the upsert
    -- back into an insert and the row multiplies on every retry - here that would be a
    -- duplicate agent task per tick.
    CREATE TABLE IF NOT EXISTS mission_schedule_occurrences (
      id                TEXT PRIMARY KEY,
      schedule_id       TEXT NOT NULL,
      schedule_revision INTEGER NOT NULL,  -- the revision in force at claim time
      scheduled_for     INTEGER NOT NULL,  -- the instant this is FOR, not when it ran
      trigger_kind      TEXT NOT NULL,     -- scheduled | manual (Run now)
      -- The intent RESERVED with the claim, before any task exists. Immutable, and the
      -- reason recovery can finish a crashed claim at all: without it, a restart would
      -- have to recompute policy from a schedule the operator may have edited in the
      -- meantime, and a pending coalesce would come back as something else.
      decision_kind     TEXT NOT NULL,
      claimed_at        INTEGER NOT NULL,
      finished_at       INTEGER,
      status            TEXT NOT NULL,     -- claimed is the only non-terminal value
      task_id           TEXT,              -- preallocated at claim, so recovery can find it
      covered_by_id     TEXT,              -- the later occurrence that represented this one
      blocking_task_id  TEXT,              -- the still-active task behind a skipped_overlap
      delay_ms          INTEGER NOT NULL DEFAULT 0,
      error             TEXT,
      created_at        INTEGER NOT NULL,
      UNIQUE (schedule_id, scheduled_for)
    );
    -- History is drawn newest-first and paged on scheduled_for; the UNIQUE index above is
    -- (schedule_id, scheduled_for) already, so this exists only for the DESC scan.
    CREATE INDEX IF NOT EXISTS idx_mission_occurrences_history
      ON mission_schedule_occurrences(schedule_id, scheduled_for DESC);
    -- Crash recovery sweeps every unfinished reservation, across all schedules.
    CREATE INDEX IF NOT EXISTS idx_mission_occurrences_recovery
      ON mission_schedule_occurrences(status, claimed_at);
    -- A generated task deep-links back to the run that filed it.
    CREATE INDEX IF NOT EXISTS idx_mission_occurrences_task
      ON mission_schedule_occurrences(task_id);

    -- ---- multi-agent ensembles ----
    --
    -- One family, generic on purpose. Nothing below says candidate, judge, diff or winner:
    -- Best-of-N is a strategy that COMPILES into these rows, and a tournament, a critique
    -- round or a synthesis has to persist through the same ones. A strategy that needed a
    -- column here would be introducing a new primitive, not a new strategy.
    --
    -- This is the one table family in this file that declares FOREIGN KEYs, and they are
    -- live: the pragma above is on. A member row whose run does not exist is unreachable
    -- garbage - nothing can render it, cancel it or clean up after it - so the constraint
    -- is worth more than the freedom to write one. Deletion cascades DOWNWARD from a run
    -- only; nothing here references tasks, because ensemble history has to outlive the task
    -- cleanup that reaps a worktree.
    --
    -- Every TEXT primary key below says NOT NULL explicitly, for the reason spelled out on
    -- workflow_binding_claims: a non-STRICT rowid table does NOT imply it, so PRIMARY KEY
    -- alone would admit several NULL ids and lose the identity the whole family joins on.
    CREATE TABLE IF NOT EXISTS ensemble_runs (
      id                   TEXT NOT NULL PRIMARY KEY,
      -- Who asked. source_key is the caller's idempotency key: a create request that lost
      -- its response, or was retried after a restart, derives the same key and gets the same
      -- run back instead of launching another N agents. Both columns are NOT NULL because
      -- SQLite treats NULLs as DISTINCT inside a unique index, so a nullable half would let
      -- the row multiply on exactly the retry it exists to absorb.
      source_kind          TEXT NOT NULL,
      source_key           TEXT NOT NULL,
      -- Display identity of the external record. NULL, not empty string: an operator-created
      -- ensemble genuinely has no external record, and this column is in no uniqueness key,
      -- so there is nothing an empty-string normalization would buy.
      source_id            TEXT,
      -- id and version separately, plus the id@version key the compiled plan carries. The
      -- key is what a newer build's run is still identifiable by when strategy_id names
      -- nothing this build has.
      strategy_id          TEXT NOT NULL,
      strategy_version     INTEGER NOT NULL,
      strategy_key         TEXT NOT NULL,
      strategy_label       TEXT NOT NULL,
      title                TEXT NOT NULL,
      intent               TEXT NOT NULL,
      repo_root            TEXT NOT NULL,
      -- Informational. base_sha is the fact that matters, and it is NULL until the launch
      -- runtime resolves and pins one full commit - a phase this schema deliberately
      -- precedes. Comparison between members is meaningless if their starting points differ.
      base_branch          TEXT,
      base_sha             TEXT,
      -- The immutable compiled plan and the validated config it came from. A run executes
      -- THIS for its whole life; recovery never recompiles with current defaults, because a
      -- compiler whose defaults moved would silently re-aim a run that is already launched.
      compiled_plan_json   TEXT NOT NULL,
      strategy_config_json TEXT NOT NULL,
      status               TEXT NOT NULL,
      active_stage_id      TEXT,
      outcome_json         TEXT,
      -- The optional post-selection Workflow handoff snapshot, pinned at creation and updated
      -- as the handoff runs. Nullable: most runs choose no handoff, and the linkage lives here
      -- rather than on workflow_bindings so Workflow retention never reaches an ensemble ref.
      workflow_handoff_json TEXT,
      -- A stable fingerprint of the raw create request. A retry that reuses a source key with any
      -- different field (a different repository, title, config, or workflow) is a conflict rather
      -- than a silent idempotent replay of the old run. Empty string on rows written before it.
      request_fingerprint    TEXT NOT NULL DEFAULT '',
      created_at           INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL,
      completed_at         INTEGER,
      error                TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ensemble_runs_source
      ON ensemble_runs(source_kind, source_key);
    -- Restart reconciliation asks "which runs are not terminal?" once per start.
    CREATE INDEX IF NOT EXISTS idx_ensemble_runs_status
      ON ensemble_runs(status, updated_at);

    -- One logical member per compiled role. Created with the run, before any process exists,
    -- because every member of a wave has to be durable before the first task in that wave is
    -- dispatched - otherwise a crash mid-launch leaves agents nothing owns.
    --
    -- Deliberately holds no score, rank or winner flag. Those belong to an evaluation or the
    -- terminal outcome: one artifact may be judged in several panels, pairs or rounds, and a
    -- column here could only hold the last of them.
    CREATE TABLE IF NOT EXISTS ensemble_members (
      id                  TEXT NOT NULL PRIMARY KEY,
      run_id              TEXT NOT NULL REFERENCES ensemble_runs(id) ON DELETE CASCADE,
      role_key            TEXT NOT NULL,
      role_label          TEXT NOT NULL,
      ordinal             INTEGER NOT NULL,
      wave                INTEGER NOT NULL,
      -- Empty string means "no task yet", and unlike source_id above this one IS in a
      -- uniqueness key, which is why it is normalized rather than nullable. The partial
      -- index enforces at most one member per task while leaving every unlaunched member
      -- free to share the empty value.
      task_id             TEXT NOT NULL DEFAULT '',
      status              TEXT NOT NULL,
      selected_attempt_id TEXT,
      result_label        TEXT,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      error               TEXT,
      UNIQUE (id, run_id),
      UNIQUE (run_id, ordinal),
      UNIQUE (run_id, role_key)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ensemble_members_task
      ON ensemble_members(task_id) WHERE task_id <> '';

    -- One launch of one member. A retry appends an attempt; it never rewrites the member,
    -- so what was tried and what it was pinned to stays readable afterwards.
    CREATE TABLE IF NOT EXISTS ensemble_attempts (
      id               TEXT NOT NULL PRIMARY KEY,
      run_id           TEXT NOT NULL REFERENCES ensemble_runs(id) ON DELETE CASCADE,
      member_id        TEXT NOT NULL,
      attempt          INTEGER NOT NULL,
      task_id          TEXT,
      session_id       TEXT,
      -- Launch facts as RESOLVED, not as requested: requested_model records what was asked
      -- for and observed_model what the harness reported, and reading one as the other is
      -- how a comparison credits a model that never ran.
      agent            TEXT,
      requested_model  TEXT,
      requested_effort TEXT,
      observed_model   TEXT,
      base_sha         TEXT,
      worktree_path    TEXT,
      branch           TEXT,
      status           TEXT NOT NULL,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      started_at       INTEGER,
      finished_at      INTEGER,
      error            TEXT,
      UNIQUE (id, run_id),
      FOREIGN KEY (member_id, run_id)
        REFERENCES ensemble_members(id, run_id) ON DELETE CASCADE,
      UNIQUE (member_id, attempt)
    );
    CREATE INDEX IF NOT EXISTS idx_ensemble_attempts_run
      ON ensemble_attempts(run_id, member_id);

    -- Immutable submitted evidence. LOCATORS and digests only - a ref, a commit id, a path -
    -- never the bytes. A full patch belongs in Git, which already stores it exactly once and
    -- can hand it back on demand; storing it here would put megabytes into a row that a
    -- detail read has to page and an SSE summary must never carry.
    CREATE TABLE IF NOT EXISTS ensemble_artifacts (
      id             TEXT NOT NULL PRIMARY KEY,
      run_id         TEXT NOT NULL REFERENCES ensemble_runs(id) ON DELETE CASCADE,
      -- Attempt ownership, or the empty string for an artifact the RUN owns (a synthesis
      -- input, an evaluation record) that belongs to no single attempt. Normalized rather
      -- than nullable because it is half of the uniqueness key below.
      attempt_id     TEXT NOT NULL DEFAULT '',
      kind           TEXT NOT NULL,
      format_version INTEGER NOT NULL,
      attempt        INTEGER NOT NULL,
      status         TEXT NOT NULL,
      locator_json   TEXT NOT NULL,
      digest         TEXT NOT NULL,
      metadata_json  TEXT NOT NULL,
      -- Stable per-capture key, so a repeated submission returns the artifact it already
      -- made rather than a second row describing the same commit.
      operation_key  TEXT NOT NULL,
      created_at     INTEGER NOT NULL,
      ready_at       INTEGER,
      error          TEXT,
      UNIQUE (run_id, attempt_id, kind, attempt)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ensemble_artifacts_operation
      ON ensemble_artifacts(operation_key);
    CREATE INDEX IF NOT EXISTS idx_ensemble_artifacts_status
      ON ensemble_artifacts(run_id, status);

    -- One attempt at one compiled stage. command_key is persisted BEFORE the side effect it
    -- authorizes, which is what makes a crash mid-wave replayable: the same command derives
    -- the same key, collides, and does not launch a second set of agents.
    CREATE TABLE IF NOT EXISTS ensemble_stage_attempts (
      id          TEXT NOT NULL PRIMARY KEY,
      run_id      TEXT NOT NULL REFERENCES ensemble_runs(id) ON DELETE CASCADE,
      stage_id    TEXT NOT NULL,
      driver_kind TEXT NOT NULL,
      -- The exact id@version the plan named, not whatever this build considers current for
      -- that stage kind. A driver version removed while a non-terminal run still names it is
      -- a startup health error, never permission to invoke the latest one.
      driver_key  TEXT NOT NULL,
      attempt     INTEGER NOT NULL,
      command_key TEXT NOT NULL,
      status      TEXT NOT NULL,
      input_json  TEXT NOT NULL,
      output_json TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      started_at  INTEGER,
      finished_at INTEGER,
      error       TEXT,
      UNIQUE (id, run_id),
      UNIQUE (run_id, stage_id, attempt)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ensemble_stage_attempts_command
      ON ensemble_stage_attempts(command_key);

    -- What a review stage decided, and about exactly which artifacts. input_fingerprint is
    -- the digest of the bounded evidence actually presented, so a retry can prove it judged
    -- the same thing rather than a re-materialized approximation of it.
    CREATE TABLE IF NOT EXISTS ensemble_evaluations (
      id                TEXT NOT NULL PRIMARY KEY,
      run_id            TEXT NOT NULL REFERENCES ensemble_runs(id) ON DELETE CASCADE,
      stage_attempt_id  TEXT NOT NULL,
      attempt           INTEGER NOT NULL,
      method            TEXT NOT NULL,
      runner_id         TEXT,
      model_id          TEXT,
      input_fingerprint TEXT NOT NULL,
      subjects_json     TEXT NOT NULL,
      result_json       TEXT,
      status            TEXT NOT NULL,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      finished_at       INTEGER,
      error             TEXT,
      UNIQUE (id, run_id),
      FOREIGN KEY (stage_attempt_id, run_id)
        REFERENCES ensemble_stage_attempts(id, run_id) ON DELETE CASCADE,
      UNIQUE (stage_attempt_id, attempt)
    );

    -- Model calls the ENSEMBLE made - never the member agents' own work, whose cost is
    -- session telemetry. cost_usd stays nullable and authoritative-only: a provider that
    -- does not report a cost gets NULL, and reading that as zero is how a total quietly
    -- understates itself.
    CREATE TABLE IF NOT EXISTS ensemble_llm_calls (
      id               TEXT NOT NULL PRIMARY KEY,
      run_id           TEXT NOT NULL REFERENCES ensemble_runs(id) ON DELETE CASCADE,
      stage_attempt_id TEXT,
      evaluation_id    TEXT,
      purpose          TEXT NOT NULL,
      runner_id        TEXT NOT NULL,
      model_id         TEXT NOT NULL,
      attempt          INTEGER NOT NULL,
      operation_key    TEXT NOT NULL,
      state            TEXT NOT NULL,
      started_at       INTEGER NOT NULL,
      finished_at      INTEGER,
      duration_ms      INTEGER,
      input_bytes      INTEGER NOT NULL DEFAULT 0,
      output_bytes     INTEGER NOT NULL DEFAULT 0,
      cost_usd         REAL,
      error_code       TEXT,
      FOREIGN KEY (stage_attempt_id, run_id)
        REFERENCES ensemble_stage_attempts(id, run_id) ON DELETE CASCADE,
      FOREIGN KEY (evaluation_id, run_id)
        REFERENCES ensemble_evaluations(id, run_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ensemble_llm_calls_run
      ON ensemble_llm_calls(run_id, started_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ensemble_llm_calls_operation
      ON ensemble_llm_calls(operation_key);

    -- The operator-visible audit trail. Append-only and bounded: what changed, not why an
    -- agent said it did. operation_key is UNIQUE so a replayed transition writes one row.
    CREATE TABLE IF NOT EXISTS ensemble_events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id        TEXT NOT NULL REFERENCES ensemble_runs(id) ON DELETE CASCADE,
      ts            INTEGER NOT NULL,
      event_kind    TEXT NOT NULL,
      payload_json  TEXT NOT NULL,
      operation_key TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ensemble_events_run
      ON ensemble_events(run_id, id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ensemble_events_operation
      ON ensemble_events(operation_key);

    -- What a person chose. Versioned rather than updated, so history explains a promotion
    -- under the evidence that was on screen when it was made. An LLM ranking is evidence and
    -- reaches this table only as the rationale beside a human actor.
    CREATE TABLE IF NOT EXISTS ensemble_decisions (
      id                            TEXT NOT NULL PRIMARY KEY,
      run_id                        TEXT NOT NULL REFERENCES ensemble_runs(id) ON DELETE CASCADE,
      version                       INTEGER NOT NULL,
      actor                         TEXT NOT NULL,
      actor_id                      TEXT,
      status                        TEXT NOT NULL,
      selection_json                TEXT NOT NULL,
      rationale                     TEXT NOT NULL DEFAULT '',
      finalization_stage_attempt_id TEXT,
      operation_key                 TEXT NOT NULL,
      created_at                    INTEGER NOT NULL,
      updated_at                    INTEGER NOT NULL,
      FOREIGN KEY (finalization_stage_attempt_id, run_id)
        REFERENCES ensemble_stage_attempts(id, run_id) ON DELETE CASCADE,
      UNIQUE (run_id, version)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ensemble_decisions_operation
      ON ensemble_decisions(operation_key);

    -- One in-progress explicit deletion per run. run_id is the PRIMARY KEY, so a repeated
    -- Delete resumes the same intent rather than opening a second. It CASCADES with its run:
    -- deletion's last durable step is deleteRun, and after it the intent is gone too, so
    -- recovery only ever finds intents whose run still exists - "there are refs still to
    -- delete". A pre-completion crash leaves this row; a post-completion one leaves nothing.
    CREATE TABLE IF NOT EXISTS ensemble_deletion_intents (
      run_id     TEXT NOT NULL PRIMARY KEY REFERENCES ensemble_runs(id) ON DELETE CASCADE,
      status     TEXT NOT NULL,
      error      TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- The archive library's DISPOSABLE index. Every row here is derived from a bundle
    -- directory under a library root and can be thrown away: delete this database and the
    -- background reconciler rebuilds all three tables from the filesystem, which is the
    -- source of truth. That is why there is no foreign key to tasks or sessions and no
    -- cascade - a completed archive outlives its task, its session, and its worktree, and a
    -- reference to any of them would make the durable thing depend on the disposable one.
    --
    -- Nothing here may hold state that is not IN the bundle. A label, an annotation, or a
    -- "seen" flag stored only in SQLite would be silently lost the first time the index was
    -- rebuilt, which is a data-loss bug that only appears on the recovery path.
    --
    -- producer_id and archive_id are generated UUIDs, and the key column is their composite.
    -- The composite is stored rather than derived so every query, cursor, and join uses one
    -- string; the pair is kept beside it so filtering by producer is an equality test on a
    -- column rather than a LIKE over the key.
    CREATE TABLE IF NOT EXISTS archives (
      key                TEXT NOT NULL PRIMARY KEY,
      producer_id        TEXT NOT NULL,
      archive_id         TEXT NOT NULL,
      producer_label     TEXT,
      -- What the bundle preserves, from its manifest. NULLABLE on purpose: an unreadable
      -- bundle is exactly the case where nothing about its contents is known, and a row
      -- that guessed would be an index inventing provenance. A kind filter therefore
      -- excludes unreadable rows, which is the honest answer rather than a side effect.
      kind               TEXT,
      format_version     INTEGER NOT NULL DEFAULT 0,
      status             TEXT NOT NULL,
      capture_status     TEXT,
      title              TEXT NOT NULL DEFAULT '',
      question           TEXT,
      summary            TEXT,
      tags_json          TEXT,
      agent              TEXT,
      model              TEXT,
      source             TEXT,
      repositories_json  TEXT,
      -- Every repository label this archive names, lowercased and pipe-delimited, as in
      -- |mission-control|docs| . A filter is instr(repo_labels, ?) with a pipe-wrapped
      -- needle, which is an exact label match with no JSON1 extension and no second table.
      -- JSON1 is a compile-time option like FTS5, and a filter that failed on a shipped
      -- SQLite without it would be a runtime error rather than a missing feature.
      repo_labels        TEXT NOT NULL DEFAULT '',
      missing_json       TEXT,
      primary_artifact_id TEXT,
      content_digest     TEXT,
      -- SHA-256 of the manifest FILE, which is what "this key is immutable" is judged on.
      -- content_digest covers only the archived files, so a manifest whose title was
      -- rewritten over unchanged evidence would hash identically and the rewrite would be
      -- adopted in silence; hashing the bytes means a same-key change is always seen, while
      -- an identical copy from a sync tool still reconciles as the archive it already was.
      manifest_digest    TEXT NOT NULL DEFAULT '',
      -- Which library root this bundle was discovered under. There is more than one - new
      -- bundles are written under the archives root, and bundles published before archives
      -- declared a kind stay under the scouts root for ever - so the absolute directory of a
      -- row is not derivable from the write root alone. Server-derived on every pass; never
      -- a claim from a manifest, and re-checked before any file below it is opened.
      library_root       TEXT NOT NULL DEFAULT '',
      relative_path      TEXT NOT NULL,
      manifest_bytes     INTEGER NOT NULL DEFAULT 0,
      manifest_mtime_ns  TEXT NOT NULL DEFAULT '',
      artifact_count     INTEGER NOT NULL DEFAULT 0,
      bytes              INTEGER NOT NULL DEFAULT 0,
      error              TEXT,
      created_at         INTEGER,
      completed_at       INTEGER,
      -- completed_at when known, else created_at, else indexed_at. Stored rather than
      -- computed so the list's ORDER BY and its keyset cursor read one column: a cursor
      -- comparing against an expression is a cursor that skips rows when the expression
      -- changes shape.
      sort_at            INTEGER NOT NULL,
      indexed_at         INTEGER NOT NULL,
      -- Which complete discovery pass last saw this bundle. Pruning is "not seen in the pass
      -- that finished", never "the file was missing when I looked", so an interrupted walk
      -- cannot delete the half of the library it never reached.
      last_seen_epoch    INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_archives_sort ON archives(sort_at DESC, key DESC);
    CREATE INDEX IF NOT EXISTS idx_archives_producer ON archives(producer_id);
    CREATE INDEX IF NOT EXISTS idx_archives_status ON archives(status);
    CREATE INDEX IF NOT EXISTS idx_archives_kind ON archives(kind);

    -- One archived file. Identity is (archive key, generated artifact id); the browser asks
    -- for a body by that pair and never by a path, so archive_path is a verified server-side
    -- detail rather than an addressable input.
    CREATE TABLE IF NOT EXISTS archive_artifacts (
      key           TEXT NOT NULL,
      artifact_id   TEXT NOT NULL,
      ordinal       INTEGER NOT NULL DEFAULT 0,
      role          TEXT NOT NULL,
      repo_slot     TEXT,
      original_path TEXT,
      archive_path  TEXT NOT NULL,
      media_type    TEXT NOT NULL DEFAULT '',
      bytes         INTEGER NOT NULL DEFAULT 0,
      sha256        TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (key, artifact_id)
    );
    CREATE INDEX IF NOT EXISTS idx_archive_artifacts_key ON archive_artifacts(key, ordinal);

    -- The bounded text a literal search scans. Segments rather than one blob so a hit can
    -- say WHERE it matched, and so the report body is searchable without loading a manifest
    -- summary and a 256 KiB report into the same row. Deliberately NOT an FTS5 table: FTS5 is
    -- a compile-time option, and a shipped SQLite without it would turn a search feature into
    -- a startup failure.
    --
    -- The text column is what a snippet is cut from; text_fold is the same string lowercased
    -- in JavaScript and is the only thing a query matches against. SQLite's own lower() folds
    -- ASCII only, so a search for a name with an accent or a non-Latin script would silently
    -- match nothing - a search feature that is wrong rather than absent.
    CREATE TABLE IF NOT EXISTS archive_search_segments (
      key         TEXT NOT NULL,
      ordinal     INTEGER NOT NULL,
      source_kind TEXT NOT NULL,
      text        TEXT NOT NULL,
      text_fold   TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (key, ordinal)
    );
    CREATE INDEX IF NOT EXISTS idx_archive_segments_key ON archive_search_segments(key);

    -- Capture COORDINATION for archives this daemon is producing, and nothing a reader of a
    -- finished bundle ever needs. The three tables above are a projection of the library; this
    -- one is the opposite - purely local bookkeeping about work in flight, keyed by an
    -- operation key that is stable for one task work episode.
    --
    -- That key is what makes submission idempotent across a lost HTTP response, an MCP retry,
    -- and a daemon restart: the first call reserves the row and generates the archive identity,
    -- and every later call for the same episode finds it and returns the same answer instead of
    -- publishing a second archive of the same evidence.
    --
    -- task_id and session_id are VALUES here, deliberately with no foreign key and no cascade.
    -- A published archive must survive its task being deleted, so a constraint pointing at the
    -- tasks table would make the durable thing depend on the disposable one - and a row that
    -- outlives its task is exactly what lets a replay answer "already archived, here it is".
    --
    -- The source locators (repos_json) are SERVER-DERIVED checkout roots recorded while the
    -- session still exists, because the whole point of reserving on exit is that they are about
    -- to stop being derivable. Nothing an agent typed reaches this table.
    CREATE TABLE IF NOT EXISTS archive_capture_jobs (
      operation_key   TEXT NOT NULL PRIMARY KEY,
      task_id         TEXT NOT NULL,
      session_id      TEXT,
      episode_id      TEXT,
      -- What this capture will produce, frozen at reservation. NOT NULL with a 'scout'
      -- default, which is a FACT rather than a fallback: every row that can exist without
      -- it was written by a build in which a scout's report was the only thing this daemon
      -- archived. The migration below carries the same value onto rows copied from the
      -- table this one replaces.
      kind            TEXT NOT NULL DEFAULT 'scout',
      -- reserved | submitted | published | failed. Append-only: a status this build does not
      -- know is treated as unfinished rather than as done, which is the safe direction.
      status          TEXT NOT NULL,
      producer_id     TEXT,
      archive_id      TEXT,
      -- What the agent submitted, when it has. Null on a job reserved by an unexpected exit.
      report_path     TEXT,
      summary         TEXT,
      tags_json       TEXT,
      supporting_json TEXT,
      -- Display and provenance the manifest needs, frozen at reservation time.
      title           TEXT,
      question        TEXT,
      origin_json     TEXT,
      repos_json      TEXT,
      -- WHICH unit of work in those checkouts this job captures, for a kind that can produce
      -- more than one archive from one task. Null for a scout, whose whole episode is one
      -- archive. Frozen at reservation for the same reason the kind above is: a plan job
      -- names the directory that was in the task's diff WHEN THE JOB WAS RESERVED, so a
      -- capture resumed after a restart archives what was reserved rather than whatever the
      -- tree happens to hold by then.
      scope_json      TEXT,
      -- Where the published bundle landed under the library root, once it did.
      relative_path   TEXT,
      capture_status  TEXT,
      error           TEXT,
      attempts        INTEGER NOT NULL DEFAULT 0,
      last_attempt_at INTEGER,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_archive_capture_jobs_task ON archive_capture_jobs(task_id);
    CREATE INDEX IF NOT EXISTS idx_archive_capture_jobs_status ON archive_capture_jobs(status);

    -- ---- scout prompt context ----

    -- Where a scout's conversation STARTED, frozen at the instant its task prompt crossed
    -- into the runtime, plus the session name that was on the card at that instant.
    --
    -- Local capture coordination, exactly like archive_capture_jobs above and on the same
    -- (task, episode) key, so a re-dispatch of the same task is genuinely new work with its
    -- own boundary rather than a second write onto the first attempt's. Not a read model:
    -- nothing renders these rows, and the portable manifest is the durable answer once
    -- capture freezes one.
    --
    -- The two nullable locators are nullable for one reason each, and both mean "the walk
    -- starts at the beginning" rather than "this went missing". transcript_path is null for
    -- a harness whose file is not locatable yet - an embedded session is created BY this
    -- delivery, so there is no file to name until it writes one. transcript_offset is null
    -- with it, and zero when the prompt itself travelled in the launch message (pi), where
    -- the whole file belongs to this episode.
    --
    -- session_name is NOT NULL because it is the archive's title of last resort: a session
    -- that has since been evicted cannot be asked, and a null here would mean the archive
    -- silently falls back to the long task title this whole feature exists to stop showing.
    --
    -- No foreign keys, for the reason archive_capture_jobs states: sessions are disposable
    -- and this row has to outlive the one it names.
    CREATE TABLE IF NOT EXISTS scout_prompt_contexts (
      task_id           TEXT NOT NULL,
      episode_id        TEXT NOT NULL,
      session_id        TEXT,
      session_name      TEXT NOT NULL,
      transcript_path   TEXT,
      transcript_offset INTEGER,
      -- Whether any bound below was reached, so a collector reports an incomplete trail as
      -- incomplete instead of presenting what survived as the whole conversation.
      truncated         INTEGER NOT NULL DEFAULT 0,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      PRIMARY KEY (task_id, episode_id)
    );
    -- The rename path refreshes the frozen name by session, not by task.
    CREATE INDEX IF NOT EXISTS idx_scout_prompt_contexts_session
      ON scout_prompt_contexts(session_id);

    -- One user-role turn this daemon SAW DELIVERED into a scout episode, in delivery order.
    --
    -- The point of persisting it is attribution that survives a restart. src/server/injections.ts
    -- remembers who typed what in memory only, so a daemon restarted between a Foreman
    -- instruction and the capture that reads the transcript would archive that instruction as
    -- if a human had written it. That is the one failure this table exists to prevent, which
    -- is why a non-human row keeps only the fingerprint: its payload is needed to EXCLUDE a
    -- transcript turn, never to archive one. Human rows keep their exact text, because they
    -- are also the fallback when the transcript is rotated, missing or not yet flushed.
    --
    -- id is the delivery's own id where one exists (PendingTurn.id) and a generated one
    -- otherwise, and the insert is ON CONFLICT DO NOTHING against it. That is what makes a
    -- pending turn retried after an uncertain delivery one prompt rather than two.
    --
    -- seq is assigned per episode at insert and is what orders the trail. It is not a
    -- timestamp: two turns can share a millisecond, and delivered_at is what was observed
    -- rather than what came first.
    CREATE TABLE IF NOT EXISTS scout_prompt_turns (
      id           TEXT PRIMARY KEY,
      task_id      TEXT NOT NULL,
      episode_id   TEXT NOT NULL,
      seq          INTEGER NOT NULL,
      -- human | foreman | workflow | harness. Append-only, and read defensively: an origin
      -- this build does not know reads as null, which excludes the turn from a human trail
      -- rather than admitting it. That is the safe direction for a privacy bound.
      origin       TEXT NOT NULL,
      -- Null for every non-human row, by design rather than by omission.
      text         TEXT,
      fingerprint  TEXT NOT NULL,
      delivered_at INTEGER NOT NULL,
      UNIQUE (task_id, episode_id, seq)
    );
    -- Every read of this table is "one episode's trail, in order".
    CREATE INDEX IF NOT EXISTS idx_scout_prompt_turns_episode
      ON scout_prompt_turns(task_id, episode_id, seq);
  `);
  db.exec(inFlightIndexSql());
  migrate(db);
  return db;
}

/**
 * Single-flight per queue, enforced by the DB rather than by hope: at most one item
 * per note_key may be mid-cycle. The stakes are a duplicated WORK INSTRUCTION typed
 * into a live agent, so this is a constraint, not a comment.
 *
 * The predicate is BUILT from IN_FLIGHT_ITEM_STATES rather than restated here, so
 * the enforcement and its two TypeScript readers cannot drift apart. `state` is a
 * closed enum of identifiers, so quoting them into SQL is safe by construction.
 */
function inFlightIndexSql(): string {
  const states = IN_FLIGHT_ITEM_STATES.map((s) => `'${s}'`).join(",");
  return `CREATE UNIQUE INDEX IF NOT EXISTS one_inflight_per_queue ON foreman_queue_items(note_key)
      WHERE state IN (${states});`;
}

/**
 * Schema migrations, run once per open after the CREATE TABLEs. Each must be
 * idempotent - this block runs on every start, not just on an upgrade.
 */
function migrate(d: DatabaseSync): void {
  // An embedded driver can be relaunched from `status` plus `agent_session_id`, but those
  // facts cannot say whether the old process died in the middle of a turn. Existing rows
  // default idle: no older build recorded proof that they owe an automatic continuation.
  addColumn(d, "sdk_sessions", "turn_in_progress", "INTEGER NOT NULL DEFAULT 0");

  // The operator's own name for an embedded session. Nullable with NO default, and that is
  // exact rather than convenient: every row written before this column existed was named by
  // derivation, which is precisely what NULL means here, so an upgraded database keeps
  // deriving until someone actually renames a card.
  addColumn(d, "sdk_sessions", "display_name", "TEXT");

  // Phase 3 pins the compatibility facts used by explicit reattachment and records the
  // actual provider/model selected when each Persona attempt starts. Existing Phase 1/2
  // databases can contain table shells but no executable bindings, so empty identity
  // defaults truthfully mean "not captured by an executable build".
  addColumn(d, "workflow_bindings", "session_agent", "TEXT NOT NULL DEFAULT ''");
  addColumn(d, "workflow_bindings", "session_name", "TEXT NOT NULL DEFAULT ''");
  addColumn(d, "workflow_bindings", "session_cwd", "TEXT");
  addColumn(d, "workflow_bindings", "session_repo_root", "TEXT");

  // ---- The binding's repository dimension ---------------------------------------------
  //
  // A conversation owns one active binding PER REPOSITORY, so a multi-repo task's session
  // can run one full review per repository it changed. `repo_root` is that second key
  // column: empty string for the session's own checkout, a secondary repository's root
  // otherwise.
  //
  // NOT NULL DEFAULT '' is exact rather than convenient, and it is the entire backfill.
  // Every binding written before this column existed reviewed the session's own checkout,
  // which is precisely what the empty string means, so SQLite's own ALTER fills each row
  // with the true value and no UPDATE follows. Nullable would have been wrong twice over: a
  // pre-feature row would carry "unknown" rather than a fact, and SQLite treats nulls as
  // distinct in a unique index - two active bindings per conversation, which is the
  // invariant this widens rather than removes. Backfilling from `session_repo_root` instead
  // was rejected for the same reason: that column is nullable, so a session outside a
  // repository would land a null in the key.
  addColumn(d, "workflow_bindings", "repo_root", "TEXT NOT NULL DEFAULT ''");
  // The index replacement, both halves, in this order and only here - the
  // idx_workflow_submissions_segment idiom above, for the same reason. Dropped by exact
  // name after the column exists, and both statements idempotent: on a fresh database the
  // dropped name was never used, and on an upgraded one it cannot come back.
  //
  // A single-repo fleet's rows all carry '', so the widened index refuses exactly what the
  // narrow one refused: a second active binding on one conversation.
  d.exec(`DROP INDEX IF EXISTS idx_workflow_bindings_active_note;`);
  d.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_bindings_active_note_repo
      ON workflow_bindings(note_key, repo_root) WHERE state = 'active';
  `);

  addColumn(d, "workflow_node_attempts", "runner_id", "TEXT");
  addColumn(d, "workflow_node_attempts", "model_id", "TEXT");
  // Phase 6 retention markers are nullable because pre-retention rows contain full
  // evidence and delivery payloads. The sweep fills them only after its transaction
  // has appended the durable audit event and compacted that exact run family.
  addColumn(d, "workflow_runs", "evidence_pruned_at", "INTEGER");
  addColumn(d, "workflow_deliveries", "payload_pruned_at", "INTEGER");
  // Per-run operator-disabled verdict nodes (auto-pass). Nullable with no default: a run
  // written before the column existed genuinely had nothing disabled, and NULL is exactly
  // that. It lives on the run rather than the immutable version because the disable is
  // scoped to one run and must never leak into other runs of the same published workflow.
  addColumn(d, "workflow_runs", "disabled_nodes_json", "TEXT");
  // Persistent operator feedback for Persona nodes is run-scoped and editable. Historical
  // attempts snapshot the bytes they used separately, so changing this active set never
  // rewrites a completed review.
  addColumn(d, "workflow_runs", "persona_directives_json", "TEXT");

  // ---- SessionAction continuation segments -------------------------------------------
  //
  // `segment` splits one repair round into successive immutable evidence snapshots. NOT
  // NULL DEFAULT 0 is exact rather than convenient: every submission written before this
  // column existed WAS the round's only evidence, so zero is what it genuinely is, and no
  // id changes. The three continuation columns are nullable with no default for the mirror
  // reason - a pre-feature row continued nothing.
  addColumn(d, "workflow_submissions", "segment", "INTEGER NOT NULL DEFAULT 0");
  addColumn(d, "workflow_submissions", "parent_submission_id", "TEXT");
  addColumn(d, "workflow_submissions", "continuation_node_id", "TEXT");
  addColumn(d, "workflow_submissions", "continuation_node_attempt_id", "TEXT");
  // The one verified index replacement, both halves, in this order and only here.
  //
  // `idx_workflow_submissions_round` was UNIQUE on (run_id, round), and it is precisely what
  // makes a second evidence snapshot inside a repair round impossible - so it is dropped by
  // that exact name, after the column exists. The replacement is created here rather than in
  // the schema block above because that block runs FIRST and its CREATE TABLE is a no-op on
  // an existing database: an index over `segment` there would be built against a table that
  // does not have the column yet, and the daemon would fail to open every upgraded database.
  //
  // Both statements are idempotent, as every start of the daemon requires: on a fresh
  // database the dropped name was never used, and on an upgraded one it cannot come back.
  d.exec(`DROP INDEX IF EXISTS idx_workflow_submissions_round;`);
  d.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_submissions_segment
      ON workflow_submissions(run_id, round, segment);
  `);

  // The action a waiting attempt is executing, frozen from the run's immutable version.
  addColumn(d, "workflow_node_attempts", "session_action_snapshot_json", "TEXT");
  // The exact active directive a Persona attempt claimed. Nullable means no feedback was
  // active at claim time; retries of the same attempt retain a non-null snapshot.
  addColumn(d, "workflow_node_attempts", "operator_directive_json", "TEXT");

  // Where an imported Persona was read from, so an upstream edit can be SEEN rather than
  // silently adopted. Nullable with no default because a Persona authored in the editor
  // genuinely has no source file, and that is exactly what every pre-feature row is. No index:
  // provenance is read with the row it belongs to and never searched by.
  addColumn(d, "personas", "import_provenance_json", "TEXT");

  // The delivery-to-attempt link. Nullable with no default so every historical row - every
  // persona_feedback, inspector_feedback, unchanged_evidence_nudge and pr_handoff ever
  // written - stays valid and recoverable exactly as it is.
  addColumn(d, "workflow_deliveries", "node_attempt_id", "TEXT");
  d.exec(`
    -- Recovery reads "does this waiting attempt already own a delivery, and in what state?"
    CREATE INDEX IF NOT EXISTS idx_workflow_deliveries_attempt
      ON workflow_deliveries(node_attempt_id, state);
    -- At most ONE live packet per action attempt, enforced by the database rather than by
    -- whichever caller happened to check first. 'uncertain' counts as live on purpose: an
    -- uncertain write may have landed, so preparing a second packet for the same attempt is
    -- exactly the double-type this index exists to prevent. Refused and cancelled rows are
    -- excluded so an explicit retry can prepare again.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_deliveries_action_live
      ON workflow_deliveries(node_attempt_id)
      WHERE node_attempt_id IS NOT NULL
        AND state IN ('prepared', 'sending', 'delivered', 'uncertain');
  `);
  // The optional post-selection Workflow handoff snapshot. Editing the CREATE TABLE block above
  // is not enough - it is IF NOT EXISTS, so an operator upgrading from a Phase 3-5 build keeps
  // the ensemble_runs they already have, and every run write would fail on a column that never
  // appeared. Nullable with no default: a run created before handoffs existed genuinely pinned
  // none, and NULL is exactly that.
  addColumn(d, "ensemble_runs", "workflow_handoff_json", "TEXT");
  // The create-request idempotency fingerprint. NOT NULL DEFAULT '' so a pre-feature row reads as
  // "no recorded fingerprint"; a replay against such a run compares against '' and, when the new
  // request carries a real fingerprint, is a conflict rather than a silent adoption of a stranger.
  addColumn(d, "ensemble_runs", "request_fingerprint", "TEXT NOT NULL DEFAULT ''");

  // `queued` -> `backlog`: the task backlog stopped calling itself a queue, so
  // "queue" now only ever means a session's work queue. Rows persisted before the
  // rename still say 'queued', and `loadActiveTasks` would silently drop them from
  // the backlog on the next start. `tasks.status` is bare TEXT with no CHECK
  // constraint, so rewriting the value in place is safe.
  d.exec(`UPDATE tasks SET status='backlog' WHERE status='queued';`);

  // `priority` / `labels`: the optional triage fields, added to `tasks` long after it
  // shipped - so every existing install only gets them through these ALTERs, and
  // without them every task write on an upgraded db would fail. Both nullable with no
  // default, which reads truthfully rather than merely harmlessly: a task filed before
  // triage existed has no priority and no labels, and NULL is exactly that. It is also
  // a different answer from `low` and from `[]`-set-deliberately, which is why the
  // column is not `TEXT NOT NULL DEFAULT ''`.
  addColumn(d, "tasks", "priority", "TEXT");
  addColumn(d, "tasks", "labels", "TEXT");
  addColumn(d, "tasks", "dependencies", "TEXT");
  addColumn(d, "tasks", "workflow_id", "TEXT");
  // `enabled`: the backlog's autopilot toggle. NOT NULL DEFAULT 1, which is the whole
  // migration - every task already in an operator's backlog was schedulable before this
  // column existed, so backfilling anything else would park their backlog on upgrade
  // and the autopilot would go quiet with nothing on screen to explain it.
  addColumn(d, "tasks", "enabled", "INTEGER NOT NULL DEFAULT 1");
  addColumn(d, "tasks", "terminal_resource_id", "TEXT");
  // Recurring Missions provenance. Editing the CREATE TABLE block above is not enough:
  // it is `IF NOT EXISTS`, so an operator upgrading into this build keeps the table they
  // already have and every task write would fail on three columns that never appeared.
  // All three nullable with no default, and no backfill: there were no scheduled tasks
  // before this feature, so NULL is the true answer for every existing row rather than a
  // placeholder standing in for one.
  addColumn(d, "tasks", "schedule_id", "TEXT");
  addColumn(d, "tasks", "schedule_occurrence_id", "TEXT");
  addColumn(d, "tasks", "scheduled_for", "INTEGER");
  // The one index in this file that cannot live beside its table. The CREATE TABLE block
  // runs BEFORE migrate(), so on an upgrading database this statement would reference a
  // column the ALTER above has not added yet and openDb() would throw on first start -
  // for every existing operator, not just for a fresh install nobody would notice.
  //
  // The overlap check ("is this schedule's previous work still in flight?") runs once per
  // due instant per tick and is bounded by schedule, so it wants the pair. Nullable
  // columns are fine here: unlike the occurrence ledger's UNIQUE index this one is never
  // conflicted against, so SQLite treating NULLs as distinct costs nothing.
  d.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_schedule ON tasks(schedule_id, status);`);
  addColumn(d, "session_work_episodes", "awaiting_agent_rebind", "INTEGER NOT NULL DEFAULT 0");
  addColumn(d, "session_work_episodes", "rebind_from_transcript_path", "TEXT");
  addColumn(d, "session_work_episodes", "merged_at", "INTEGER");
  addColumn(d, "session_work_episodes", "prompted_at", "INTEGER");
  addColumn(d, "task_work_episode_bindings", "merged_at", "INTEGER");
  d.exec(`
    WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (
        PARTITION BY session_id
        ORDER BY
          CASE WHEN dispatched_at IS NULL THEN 1 ELSE 0 END,
          dispatched_at DESC,
          created_at DESC,
          updated_at DESC,
          id DESC
      ) AS position
      FROM tasks
      WHERE session_id IS NOT NULL
    )
    UPDATE tasks SET session_id = NULL
    WHERE id IN (SELECT id FROM ranked WHERE position > 1);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_session
      ON tasks(session_id) WHERE session_id IS NOT NULL;
  `);

  // Usage provenance and immutable pricing metadata. Old rows are Claude's reported
  // telemetry, so the defaults are the truthful migration rather than a placeholder.
  addColumn(d, "usage_ledger", "cost_basis", "TEXT NOT NULL DEFAULT 'reported'");
  addColumn(d, "usage_ledger", "cost_known", "INTEGER NOT NULL DEFAULT 1");
  addColumn(d, "usage_ledger", "pricing_version", "TEXT NOT NULL DEFAULT ''");
  addColumn(d, "usage_ledger", "reasoning_output", "INTEGER NOT NULL DEFAULT 0");
  // Every row that predates headless spend accounting came from a session's own stream, so
  // 'session' is the truthful backfill rather than an unknown bucket. The one population it
  // gets wrong is the orphan OTel rows a `claude -p` Foreman run left behind before this
  // existed; those stay counted as session spend, because relabelling them would mean
  // guessing which uuid was a headless run from the shape of its rows.
  addColumn(d, "usage_ledger", "spend_kind", "TEXT NOT NULL DEFAULT 'session'");
  // Created HERE, not in the CREATE TABLE block, because that block runs first and an
  // upgraded database has no spend_kind column until the line above. Automation rows are a
  // small minority of the table, but every fleet read now filters on them - twice, since
  // the session total also has to exclude their OTel twins.
  d.exec("CREATE INDEX IF NOT EXISTS idx_ledger_kind ON usage_ledger(spend_kind, ts)");
  // WHICH INGEST PRODUCED THE ROW. Not provenance for its own sake: it is the only way to
  // answer "has Claude Code's OTel export ever delivered anything", and that question has to
  // be answerable separately from "is session spend landing" now that a second writer can
  // satisfy the second one. Without it, a driver-written row makes the Cost panel report
  // healthy telemetry while every passively-discovered terminal session silently reads $0 -
  // the exact failure mode that made session spend vanish in the first place.
  //
  // A column rather than a test on (spend_kind, cost_basis), for the reason spend_kind is a
  // column: the pair distinguishes three of the four writers and leaves the two that matter
  // most - Claude's OTel and Claude's driver, both 'session' and both 'reported' - identical.
  //
  // DEFAULT '' plus an explicit backfill, rather than a default that names one writer. Every
  // real writer sets this from now on, so '' can only mean "row predates the column", and
  // the backfill below is what stops that meaning "unknown" forever.
  addColumn(d, "usage_ledger", "writer", "TEXT NOT NULL DEFAULT ''");
  // Idempotent and exact - each arm is decidable from columns the row already had, so this is
  // a relabelling and not a guess. Ordered narrowest-first: automation rows are the only
  // ones `recordAutomationUsage` writes, locally-priced rows are the only ones the rollout
  // reader writes, and what remains is Claude's reported session telemetry, which before this
  // change had exactly one possible source.
  d.exec(`
    UPDATE usage_ledger SET writer = 'report'
      WHERE writer = '' AND spend_kind = 'automation';
    UPDATE usage_ledger SET writer = 'rollout'
      WHERE writer = '' AND cost_basis IN ('api-equivalent', 'unpriced');
    UPDATE usage_ledger SET writer = 'otel' WHERE writer = '';
  `);
  addColumn(d, "usage_sources", "discard_partial", "INTEGER NOT NULL DEFAULT 0");
  addColumn(d, "usage_sources", "file_id", "TEXT NOT NULL DEFAULT ''");

  // `proposed_payload`: what a drafted item would actually type. CREATE TABLE IF
  // NOT EXISTS won't add a column to a table that already exists, so an ALTER is
  // the only way an upgraded DB gets it. Nullable with no default, so existing
  // rows read as "no draft recorded" - and the machine re-drafts on the next tick
  // rather than showing a card with nothing under it.
  addColumn(d, "foreman_queue_items", "proposed_payload", "TEXT");

  // `recovered_at`: whether this item was adopted mid-send after a restart, which is
  // what stops it from ever resending. Same exposure and same reason as the ALTER
  // above - both were added to the CREATE TABLE after it had already shipped, and
  // `CREATE TABLE IF NOT EXISTS` will not add a column to a table that exists, so a
  // db created between the two would fail EVERY queue-item write. Nullable with no
  // default, so an existing row reads as "never crash-recovered" - which is the
  // truthful answer for a row written before the daemon could recover one.
  addColumn(d, "foreman_queue_items", "recovered_at", "INTEGER");

  // `prompted_goal`: the resolved intent episode the `prompted` wrap-up trigger last
  // handled. The historical column name remains, but new writes store an opaque
  // `intent:<objectiveVersion>:<promptRevision>` guard rather than goal text.
  // Same exposure as the two ALTERs above: added to the CREATE TABLE after
  // `foreman_queues` shipped, and CREATE TABLE IF NOT EXISTS will not add a column to
  // an existing table, so without this every queue write on an upgraded db would fail.
  //
  // Nullable with no default, and that reads correctly rather than merely harmlessly:
  // NULL means "this checkout has never had a prompted wrap-up", which is the truthful
  // answer for every row written before the trigger existed. It leaves the trigger
  // ARMED on those checkouts, which is right - the whole point is to fire once the
  // human turns it on - and the verify step still has to agree before anything types.
  addColumn(d, "foreman_queues", "prompted_goal", "TEXT");

  // `decisions`: the structured questions of a `plan-decisions` review, as a JSON
  // array. Added to `reviews` after it shipped, so an upgraded DB only gets it via
  // this ALTER. Nullable with no default: every existing review, and every review of
  // another kind, reads as "no decisions" - which is exactly what they are.
  addColumn(d, "reviews", "decisions", "TEXT");

  // `selections`: which option ids the human actually picked, as a JSON array of
  // `PlanDecisionAnswer`. The `response` beside it has always held the FLATTENED answer the
  // agent reads, which names the chosen labels and nothing else - so the conversation
  // cannot replay the question from it. Nullable with no default: an existing row, and
  // every resolution with no form behind it, reads as "no selections", and the transcript
  // falls back to showing the response prose.
  addColumn(d, "reviews", "selections", "TEXT");

  // `resolved_by`: who settled the review. Needed because Foreman resolves through the same
  // route the dashboard does, and only the human's answers belong in the conversation -
  // Foreman's are already there as its own episode. Nullable with no default, so a row
  // written before this column reads as "unattributed" rather than being credited to the
  // operator on the strength of its status alone.
  addColumn(d, "reviews", "resolved_by", "TEXT");

  // `resolved_by`: who decided the episode, split back out of `sent_by`. Unlike the
  // ALTERs above this covers a window rather than a shipped release - `foreman_episodes`
  // is new enough that the only dbs carrying it are the ones this feature was developed
  // against - but the CREATE TABLE above still won't add the column to them, and every
  // episode write would fail on a db that has the table without it. Nullable with no
  // default, so an episode written before the split reads as "still open", which is the
  // only honest answer: its `sent_by` cannot say whether a human dismissed it.
  addColumn(d, "foreman_episodes", "resolved_by", "TEXT");

  // `cheap_action` / `divergence`: what the cheap tier decided under `shadow`, and how it
  // compared with the full review. Same exposure as `resolved_by` above - the INSERT names
  // both columns, so without these every episode write on an existing db would fail.
  //
  // Nullable with no default, and null is a CLAIM here rather than a gap: "not measured".
  // Every row written before this shipped has no answer, and neither does any row written
  // under `off` (no cheap call is made) or `on` (the cheap tier decided, so there is no
  // second opinion to compare it against). Defaulting either to 'agree' would manufacture
  // evidence for the one question this measurement exists to answer.
  addColumn(d, "foreman_episodes", "cheap_action", "TEXT");
  addColumn(d, "foreman_episodes", "divergence", "TEXT");

  // `triage_reason` / `skip_reason`: WHY a decision came out the way it did, which the
  // record has never carried. Same exposure as the pair above - the INSERT names both, so
  // an existing db without them fails every episode write.
  //
  // Null on every row written before this, and that is a gap rather than a claim, which is
  // the opposite of the shadow pair. A historical `skipped` row genuinely cannot say
  // whether it was declined or went stale, so `episodeOutcome` reads a null skip reason as
  // `declined` - the reading the panel has been making all along, now stated rather than
  // assumed. Backfilling it by matching on `last_action` prose was considered and refused:
  // that string is a rendering, it has already changed once, and a migration that guesses
  // at history is indistinguishable afterwards from one that knew.
  addColumn(d, "foreman_episodes", "triage_reason", "TEXT");
  addColumn(d, "foreman_episodes", "skip_reason", "TEXT");

  // The index `recentEpisodes` needs: the fleet-wide read has no `note_key` predicate, so
  // `idx_foreman_episodes_key` cannot serve it and the query is a full scan plus a sort.
  //
  // It lives HERE, under the ALTERs, and NOT beside the CREATE TABLE, which is the rule
  // `idx_tasks_schedule` exists to demonstrate: the CREATE block runs in full before
  // `migrate()` does. An index there naming a column an ALTER has not added yet throws in
  // `openDb()` on first start - for every existing operator, and never on the fresh install
  // it was tested against. This one indexes `created_at` only, which the CREATE block does
  // define, so it would have survived that ordering by luck; it sits here with the columns
  // it was added for so the next person moves the pair together. Test: `foreman-episodes-db.test.ts`.
  d.exec(
    `CREATE INDEX IF NOT EXISTS idx_foreman_episodes_recent
       ON foreman_episodes(created_at DESC, id DESC)`,
  );

  // `model`: the per-task model override, added to `tasks` after it shipped - so on an
  // upgraded db this ALTER is the only way the column arrives, and without it EVERY
  // task write would fail (the INSERT names the column). Nullable with no default, and
  // that reads correctly rather than merely harmlessly: NULL means "no override, follow
  // the harness default", which is the truthful answer for every task dispatched before
  // a model could be chosen at all.
  addColumn(d, "tasks", "model", "TEXT");
  // `effort`: the per-task reasoning override. NULL follows the launch-time harness
  // default, which is also the truthful value for every task created before it existed.
  addColumn(d, "tasks", "effort", "TEXT");

  // `source_id` / `external_id` / `source_url`: where a task source swept a task from,
  // added to `tasks` long after it shipped. Same exposure as `model` above and the same
  // consequence - the INSERT names all three, so without these EVERY task write on an
  // upgraded db would fail, human-typed ones included. All nullable with no default,
  // which reads truthfully: NULL means "nobody swept this", the right answer for every
  // task filed before sources existed and for every one a human will ever type.
  //
  // Note what these are NOT: they are the link back, not identity. De-duplication is
  // decided against `task_source_seen`, whose rows outlive the task (see its comment) -
  // so nothing here is ever read to answer "have we filed this before?".
  addColumn(d, "tasks", "source_id", "TEXT");
  addColumn(d, "tasks", "external_id", "TEXT");
  addColumn(d, "tasks", "source_url", "TEXT");
  // The primary repo's baseline for multi-repo tasks. Nullable with no default because
  // that is the honest reading of an existing row: nothing recorded where its branch was
  // cut, and a fabricated value would be indistinguishable from a measured one to every
  // rule that later compares a head against it. `task_repos` needs no entry here - a new
  // TABLE is covered by the CREATE TABLE IF NOT EXISTS block, which runs on every open.
  addColumn(d, "tasks", "base_sha", "TEXT");

  // `home_name`: the terminal home a dispatched agent lives in, renamed from the
  // tmux-specific `tmux_session` now that the name is resolved against ANY backend
  // (`killHome` / `homeAlive`), not assumed to be tmux. This is the destructive one: the
  // name drives `teardownWorktree`'s kill and `reconcileOnStartup`'s reclaim, and a real
  // user's upgraded db carries live agents' home names in the old column. So this is a
  // schema migration, not just a rename.
  //
  // Nullable with no default: NULL is "no home yet" (a backlog task, or one whose home was
  // reclaimed), a distinct and truthful answer that `homeName ? … : …` reads directly.
  //
  // The backfill runs EXACTLY ONCE - gated on the migration having just added the column -
  // and never again. `tmux_session` becomes a frozen fossil after this rename (no write
  // path names it), so re-running the copy on every open would RESURRECT a home name onto a
  // task that had since been reclaimed to NULL, re-aiming its teardown at a stranger. Gated
  // on the add, it copies each live name across on the one start after upgrade and then the
  // fossil is inert forever. `hasColumn` guards the pre-triage-fresh-db path where
  // `tmux_session` never existed to copy from.
  migrateTaskHomeName(d);

  // `fail_count` / `next_attempt_at`: the Inspector's retry backoff. Same window as
  // `foreman_episodes.resolved_by` above - `inspector_prs` has never shipped, so the
  // only dbs carrying it are the ones this feature was developed against - but CREATE
  // TABLE IF NOT EXISTS still will not add a column to a table that exists, and the
  // INSERT names both, so without these every adoption on such a db would fail.
  //
  // `fail_count` defaults to 0 and `next_attempt_at` is nullable, so a row written
  // before the backoff existed reads as "no failures, due now" - which is the truthful
  // answer for a row nothing had yet counted failures for.
  addColumn(d, "inspector_prs", "fail_count", "INTEGER NOT NULL DEFAULT 0");
  addColumn(d, "inspector_prs", "next_attempt_at", "INTEGER");
  // `last_attempt_sha`: the head a backoff was earned on, so a new push can cut the wait
  // short. Same unshipped-table window as the two above, and nullable for the same
  // reason - a row written before it existed has attempted nothing we can name, and the
  // backoff on it stays fully in force until something does.
  addColumn(d, "inspector_prs", "last_attempt_sha", "TEXT");
  // `last_fail_kind`: which of the two failure classes earned the wait now in force, so
  // the push-escape can be unlimited for the class a push is the remedy for and capped
  // for the class it cannot touch. Same unshipped-table window as the three above.
  // Nullable, and NULL reads as "nothing has failed" - which is also the safe reading if
  // it somehow survives alongside a non-zero `fail_count`, since an unnamed class falls
  // under the cap rather than escaping it.
  addColumn(d, "inspector_prs", "last_fail_kind", "TEXT");
  // `merged_at` / `merge_block`: YOLO mode's half of the ledger - when we landed a PR
  // ourselves, and why we have not. Both nullable, and NULL reads as "never merged by us,
  // and nothing has evaluated it yet", which is the truthful answer for every row written
  // before the feature existed. Unlike the four above these DO land on shipped databases,
  // so the migration is not optional: the adoption INSERT names both columns.
  addColumn(d, "inspector_prs", "merged_at", "INTEGER");
  addColumn(d, "inspector_prs", "merge_block", "TEXT");
  // A current live setting must not retroactively promote a dry-run review. Nullable is
  // fail-closed for rows written by older builds: their reviewed head must be run again
  // before it can authorize a merge.
  addColumn(d, "inspector_prs", "review_posture", "TEXT");
  // What the last poll SAW, as against what the last review was about.
  //
  // All four nullable with no default, and NULL reads as "this build has not looked at this
  // pull request since the columns existed" - which is the only truthful answer for a row
  // written before them. It is also the fail-closed one for the reader that needs them: a
  // `pull_request` session action waits when it cannot name the pull request's remote head,
  // so an unobserved legacy row makes it wait for the next tick rather than completing on
  // an assumption. The tick fills all four within one poll interval of the daemon starting.
  addColumn(d, "inspector_prs", "observed_head_sha", "TEXT");
  addColumn(d, "inspector_prs", "observed_state", "TEXT");
  addColumn(d, "inspector_prs", "observed_at", "INTEGER");
  addColumn(d, "inspector_prs", "head_ref_name", "TEXT");
  // The pull request's title, on the same terms as the four above: written by the poll,
  // NULL for "not looked at since the column existed". It lands on shipped databases and
  // the adoption INSERT names it, so like `merged_at` the migration is not optional.
  //
  // Nullable with no default because there is no truthful default. A legacy row's title is
  // whatever GitHub says it is, which only a poll can find out; inventing one - the branch,
  // the empty string - would be indistinguishable on the wire from a poll having reported
  // it, and the reader's fallback to `head_ref_name` is what makes null render honestly.
  // Rows already closed or merged when this ships stay null for ever, since the tick only
  // polls open ones. That is accepted: no network sweep backfills history.
  //
  // No index. The table gains single-digit rows a day and nothing selects on the title;
  // if one is ever wanted it belongs here, beside the ALTER, never in the CREATE block.
  addColumn(d, "inspector_prs", "title", "TEXT");
  // Finding bodies were historically posted and then discarded locally. Persist only
  // the already-scrubbed planner output; NULL truthfully identifies legacy rows.
  addColumn(d, "inspector_comments", "body", "TEXT");

  // Whether a parked repair round resumes itself. NULLABLE with NO default on purpose: a
  // NULL is the truthful record of a draft authored, or a version PUBLISHED, by a build
  // that had no such setting, and the store reads it as `manual` so every already-published
  // version keeps behaving exactly as it was published (see
  // `LEGACY_WORKFLOW_RESUMPTION_POLICY`). A `DEFAULT 'auto'` here would have rewritten that
  // history in place and started resubmitting runs on every machine that upgraded. No index:
  // the resumption observer sweeps the handful of non-terminal runs it already holds and
  // never selects on this column.
  addColumn(d, "workflow_definitions", "resumption_policy", "TEXT");
  addColumn(d, "workflow_versions", "resumption_policy", "TEXT");

  // Which provider handed a check its worktree. Editing the CREATE TABLE block above is not
  // enough - it is IF NOT EXISTS, so an operator upgrading into this build keeps the table
  // they already have and every lease write would fail on a column that never appeared.
  //
  // NOT NULL DEFAULT 'treehouse' is a FACT rather than a fallback, and that distinction is
  // the whole migration. Every row that can exist before this column did was written by a
  // build in which the pool was the only way a check could get a tree, so 'treehouse' is
  // what those rows genuinely are - which is what keeps this clear of the trap the table's
  // own comment warns about, where a NULL is indistinguishable from a row written by a build
  // that did not set the column. Here the release path would have to guess, and a wrong
  // guess hands a git worktree to `treehouse return` or abandons a pool slot for good.
  //
  // No backfill statement and no index: the default IS the backfill, and the only reader
  // selects the row it already has by primary key.
  addColumn(d, "workflow_check_leases", "provider", "TEXT NOT NULL DEFAULT 'treehouse'");

  // `inspector_comments(pr_key)` is the leftmost prefix of the unique index on
  // (pr_key, fingerprint), so it can serve no query that one cannot. Dropped rather
  // than merely removed from the CREATE, or a db created before this build keeps
  // paying for it forever. `comment_id` / `thread_id` are left where they are: SQLite
  // column drops are the expensive kind of migration, the columns are nullable, and
  // every INSERT names its columns, so a leftover one is inert.
  d.exec(`DROP INDEX IF EXISTS idx_inspector_comments_pr;`);

  // Goal intent was originally one sentence plus the latest prompt. Keep the existing row as
  // the best recoverable objective and let the next prompt reconcile it. Numeric defaults make
  // legacy rows explicitly pre-versioned rather than inventing a prompt history they never had.
  addColumn(d, "session_goals", "objective", "TEXT");
  addColumn(d, "session_goals", "focus", "TEXT");
  addColumn(d, "session_goals", "relationship", "TEXT");
  addColumn(d, "session_goals", "rationale", "TEXT");
  addColumn(d, "session_goals", "objective_version", "INTEGER NOT NULL DEFAULT 0");
  addColumn(d, "session_goals", "prompt_revision", "INTEGER NOT NULL DEFAULT 0");
  addColumn(d, "session_goals", "resolved_prompt_revision", "INTEGER NOT NULL DEFAULT 0");
  addColumn(d, "session_goals", "pending_prompts", "TEXT NOT NULL DEFAULT '[]'");
  //
  // `usage_sources` is new; its defensive cursor-state migrations above also make
  // intermediate development databases safe to reopen. `usage_ledger` does need a user
  // migration: its provenance/pricing defaults identify every old Claude row as reported
  // rather than retroactively estimating or repricing it.

  // --- the archive library's rename, and the one table it cannot rebuild ---------------
  //
  // The three index tables are a PROJECTION of bundle directories, and the reconciler is
  // built to rebuild them from disk - a deleted database simply has no fingerprints, so
  // every bundle looks new. So the disposable half is dropped rather than copied. Copying
  // it would carry a fingerprint and a `last_seen_epoch` from a read this build never
  // performed, and a cache that vouches for bytes nobody verified is worse than no cache:
  // an unchanged fingerprint is exactly what makes a pass skip re-reading a bundle. The
  // operator pays one background re-index, bounded by the existing candidate cap.
  //
  // `scout_capture_jobs` is the opposite kind of table and is COPIED. It is the idempotency
  // and resume ledger, and its `repos_json` holds server-derived checkout roots recorded
  // while the session still existed - "the whole point of reserving on exit is that they are
  // about to stop being derivable". Dropping it would strand an in-flight capture that was
  // reserved but not published, with no way to rebuild the paths it needed.
  //
  // INSERT ... SELECT names every column, so a row arriving from the old table gets
  // `kind = 'scout'`, which is what every such row is: no other kind could be reserved by
  // the build that wrote it.
  if (tableExists(d, "scout_capture_jobs")) {
    d.exec(`
      INSERT OR IGNORE INTO archive_capture_jobs
        (operation_key, task_id, session_id, episode_id, kind, status, producer_id, archive_id,
         report_path, summary, tags_json, supporting_json, title, question, origin_json,
         repos_json, relative_path, capture_status, error, attempts, last_attempt_at,
         created_at, updated_at)
      SELECT
        operation_key, task_id, session_id, episode_id, 'scout', status, producer_id, archive_id,
        report_path, summary, tags_json, supporting_json, title, question, origin_json,
        repos_json, relative_path, capture_status, error, attempts, last_attempt_at,
        created_at, updated_at
      FROM scout_capture_jobs;
      DROP TABLE scout_capture_jobs;
    `);
  }
  d.exec(`
    DROP TABLE IF EXISTS scout_search_segments;
    DROP TABLE IF EXISTS scout_artifacts;
    DROP TABLE IF EXISTS scout_archives;
  `);

  // Which unit of work a capture job covers, for the kinds that can reserve more than one job
  // per task episode. Additive and nullable: every existing row is a scout's, and a scout's
  // job has always covered the whole episode, so null reads as "the episode" rather than as a
  // value that went missing.
  addColumn(d, "archive_capture_jobs", "scope_json", "TEXT");

  rebuildInFlightIndexIfStale(d);
}

/** Whether a table exists in this database, for a migration that has to read the old one. */
function tableExists(d: DatabaseSync, name: string): boolean {
  const row = d
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { name?: string } | undefined;
  return row?.name === name;
}

/**
 * Rebuild the single-flight index when its stored predicate no longer names the
 * states IN_FLIGHT_ITEM_STATES does.
 *
 * Deriving the SQL only makes the index agree with its readers on a FRESH db:
 * `CREATE UNIQUE INDEX IF NOT EXISTS` leaves an existing index untouched, so a db
 * created before a lifecycle state was added would go on enforcing the old
 * predicate while both TypeScript readers used the new one - exactly the silent
 * drift the shared constant exists to prevent, just deferred to upgrade time.
 *
 * A rebuild can legitimately fail: widening the set can surface rows that already
 * violate single-flight. That's worth reporting, but not worth bricking every
 * subsequent start over - the old index still enforces something, so keep it and
 * say so rather than refusing to open the db.
 *
 * That promise is what makes the TRANSACTION load-bearing rather than tidy. DDL is
 * transactional in SQLite, and without a transaction the DROP commits on its own:
 * the CREATE then fails on the violating rows, the catch logs, and the table is left
 * with NO index at all. Single-flight enforcement is silently gone, and - worse -
 * the next openDb() runs `db.exec(inFlightIndexSql())` against those same rows with
 * nothing to make it a no-op, throws uncaught, and the daemon refuses to start.
 * Failing to rebuild would brick every subsequent start: the exact outcome the catch
 * was written to prevent. Rolling back keeps the old index, so the CREATE stays a
 * no-op and the daemon opens.
 */
function rebuildInFlightIndexIfStale(d: DatabaseSync): void {
  const row = d
    .prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name='one_inflight_per_queue'`)
    .get() as { sql: string | null } | undefined;
  if (!row?.sql) return;
  // SQLite stores the CREATE text with `IF NOT EXISTS` stripped, so compare the one
  // thing that carries meaning: which states the WHERE clause names.
  const stored = new Set([...row.sql.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
  const want = new Set<string>(IN_FLIGHT_ITEM_STATES);
  if (stored.size === want.size && [...want].every((s) => stored.has(s))) return;
  try {
    d.exec("BEGIN IMMEDIATE;");
    d.exec("DROP INDEX one_inflight_per_queue;");
    d.exec(inFlightIndexSql());
    d.exec("COMMIT;");
  } catch (err) {
    // Put the old index back. Swallowing a rollback failure is deliberate: the
    // original error is the one worth reporting, and masking it with "cannot
    // rollback - no transaction is active" would bury the actual cause.
    try {
      d.exec("ROLLBACK;");
    } catch {}
    console.error(
      "[db] could not rebuild one_inflight_per_queue (rows may already violate " +
        `single-flight); keeping the previous index: ${String(err)}`,
    );
  }
}

function migrateTaskHomeName(d: DatabaseSync): void {
  try {
    d.exec("BEGIN IMMEDIATE;");
    if (addColumn(d, "tasks", "home_name", "TEXT") && hasColumn(d, "tasks", "tmux_session")) {
      d.exec(`UPDATE tasks SET home_name = tmux_session WHERE home_name IS NULL AND tmux_session IS NOT NULL;`);
    }
    d.exec("COMMIT;");
  } catch (err) {
    try {
      d.exec("ROLLBACK;");
    } catch {}
    throw err;
  }
}

/** Whether a table already has a column. The building block of an idempotent migration. */
function hasColumn(d: DatabaseSync, table: string, column: string): boolean {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

/**
 * Add a column unless it's already there. The idempotent half of a migration.
 *
 * Returns whether it ADDED the column (false when it was already present), so a caller can
 * hang a one-time data backfill off "the column is new" rather than re-running it on every
 * open - see the `home_name` migration.
 */
function addColumn(d: DatabaseSync, table: string, column: string, decl: string): boolean {
  if (hasColumn(d, table, column)) return false;
  d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl};`);
  return true;
}

interface ReviewRow {
  id: string;
  session_id: string;
  kind: string;
  title: string;
  body: string;
  status: string;
  response: string | null;
  decisions: string | null;
  selections: string | null;
  resolved_by: string | null;
  created_at: number;
  resolved_at: number | null;
}

function rowToReview(r: ReviewRow): ReviewItem {
  return {
    id: r.id,
    sessionId: r.session_id,
    kind: r.kind as ReviewKind,
    title: r.title,
    body: r.body,
    status: r.status as ReviewStatus,
    response: r.response,
    decisions: parseJsonArray<PlanDecision>(r.decisions),
    selections: parseJsonArray<PlanDecisionAnswer>(r.selections),
    resolvedBy: (r.resolved_by as ReviewActor | null) ?? null,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  };
}

/**
 * Decode one of the review table's JSON array columns (`decisions`, `selections`). A
 * malformed blob returns null rather than throwing: one corrupt row must not take down
 * `loadPendingReviews` and every review with it, and "absent" is the safe degradation for
 * both - the card renders as a plain plan, and the transcript falls back to the response
 * prose instead of replaying a form it cannot trust.
 */
function parseJsonArray<T>(raw: string | null): T[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : null;
  } catch {
    return null;
  }
}

export function insertReview(r: ReviewItem): void {
  openDb()
    .prepare(
      `INSERT INTO reviews (id, session_id, kind, title, body, status, response, decisions, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      r.id,
      r.sessionId,
      r.kind,
      r.title,
      r.body,
      r.status,
      r.response,
      jsonArrayColumn(r.decisions),
      r.createdAt,
      r.resolvedAt,
    );
}

/**
 * Settle a review: its status, what the human said, what they picked, and who they were.
 *
 * All five move together in one statement because they describe a single event. Splitting
 * the two new columns into a second UPDATE would leave a window in which the row is
 * `answered` but unattributed, and the conversation reads that as "not a human's answer".
 */
export function updateReviewStatus(
  id: string,
  status: ReviewStatus,
  response: string | null,
  resolvedAt: number | null,
  selections: PlanDecisionAnswer[] | null = null,
  resolvedBy: ReviewActor | null = null,
): void {
  openDb()
    .prepare(
      `UPDATE reviews
          SET status = ?, response = ?, resolved_at = ?, selections = ?, resolved_by = ?
        WHERE id = ?`,
    )
    .run(status, response, resolvedAt, jsonArrayColumn(selections), resolvedBy, id);
}

/** Store a JSON array column, collapsing both "absent" and "empty" to NULL. */
function jsonArrayColumn(rows: unknown[] | null | undefined): string | null {
  return rows && rows.length ? JSON.stringify(rows) : null;
}

/** Reviews still awaiting a human decision - reloaded into the registry on start. */
export function loadPendingReviews(): ReviewItem[] {
  const rows = openDb()
    .prepare(`SELECT * FROM reviews WHERE status = 'pending' ORDER BY created_at ASC`)
    .all() as unknown as ReviewRow[];
  return rows.map(rowToReview);
}

/**
 * The reviews a session's conversation replays: the ones a HUMAN settled, oldest first.
 *
 * Separate from `loadResolvedWorkflowReviews` rather than sharing its query, because the
 * two ask different questions of the same table. That one gathers evidence of intent, so it
 * takes only the kinds that carry a plan or an answer and drops a dismissal outright. This
 * one reconstructs a conversation, so it takes every kind - an approved `diff` is a thing
 * you said - and keeps dismissals, which are the record of a question closed unanswered.
 *
 * The status/actor filter is `isHumanResolvedReview` expressed in SQL, and the predicate is
 * asserted over the result so the two can be shown to agree rather than assumed to.
 *
 * The bound is applied to the NEWEST rows and the page is then flipped back to ascending, so
 * the two orders in play are kept apart: the conversation is READ oldest-first, but when a
 * session has more answers than the cap, the ones worth keeping are the recent ones.
 *
 * Selecting ascending and then limiting - which this did first - keeps the oldest page
 * instead, so past the cap the newest answer silently stops appearing. That is the one
 * failure this whole feature exists to prevent, and it lands on the answer a reader is most
 * likely to have opened the session to check. It cannot be waved off as unreachable either:
 * these rows are never restored to the live registry (`loadPendingReviews` reloads only
 * pending ones), so this query IS the conversation after a restart, with no live half to
 * paper over the gap.
 */
export function loadHumanResolvedReviews(sessionId: string, limit = 500): ReviewItem[] {
  const statuses = [...HUMAN_REVIEW_STATUSES];
  const rows = openDb()
    .prepare(
      `SELECT * FROM (
         SELECT * FROM reviews
          WHERE session_id = ?
            AND resolved_by = 'human'
            AND status IN (${statuses.map(() => "?").join(", ")})
          ORDER BY resolved_at DESC, created_at DESC
          LIMIT ?
       ) ORDER BY resolved_at ASC, created_at ASC`,
    )
    .all(sessionId, ...statuses, limit) as unknown as ReviewRow[];
  return rows.map(rowToReview).filter(isHumanResolvedReview);
}

/** Human-resolved plan/input records retained as workflow intent evidence. */
export function loadResolvedWorkflowReviews(sessionId: string, limit = 100): ReviewItem[] {
  const rows = openDb()
    .prepare(
      `SELECT * FROM reviews
        WHERE session_id = ?
          AND kind IN ('plan', 'plan-decisions', 'input')
          AND status IN ('approved', 'rejected', 'answered')
        ORDER BY resolved_at DESC, created_at DESC
        LIMIT ?`,
    )
    .all(sessionId, limit) as unknown as ReviewRow[];
  return rows.map(rowToReview);
}

export function logEvent(sessionId: string, ts: number, kind: string, payload: unknown): void {
  openDb()
    .prepare(`INSERT INTO session_events (session_id, ts, kind, payload) VALUES (?, ?, ?, ?)`)
    .run(sessionId, ts, kind, payload === undefined ? null : JSON.stringify(payload));
}

/**
 * Longest pane capture kept per episode.
 *
 * A pane is a whole terminal screen and the only copy of a terminal ask, so this is
 * generous - but it is not unbounded, because a pane is whatever the child happened
 * to be printing and a scrolling build log would otherwise land here in full. The
 * ask is at the BOTTOM of a pane (the dialog is the foreground - see
 * `parsePaneDialog`), so when this bites, the tail is the half worth keeping.
 */
const MAX_EPISODE_PANE = 16_000;

/** Longest free-text field (question / brief / recommendation / sent text) per episode. */
const MAX_EPISODE_TEXT = 8000;

/** What the worker records once it has acted on a waiting episode. */
export interface EpisodeWrite {
  noteKey: string;
  sessionId: string;
  marker: string;
  situation: string;
  surface: string;
  question: string;
  pane: string | null;
  menu: PaneDialogSummary | null;
  reviewId: string | null;
  purpose: string | null;
  brief: string | null;
  recommendation: string | null;
  classification: string | null;
  confidence: number | null;
  tier: number | null;
  /** The shadow measurement. Both null unless the posture was `shadow`. */
  cheapAction: CheapAction | null;
  divergence: Divergence | null;
  /** Why the ladder landed here - `TriageOutcome.reason`. See `ForemanEpisode.triageReason`. */
  triageReason: string | null;
  /** Why a skip was not a judgment. Null on an ordinary declined skip. */
  skipReason: SkipReason | null;
  disposition: NoteDisposition;
  lastAction: string | null;
  sentText: string | null;
  sentOption: { number: number; label: string } | null;
  /** Who authored what reached the child; null when nothing was delivered. */
  sentBy: EpisodeAuthor | null;
  createdAt: number;
  resolvedAt: number | null;
  /** Who decided the episode; null while it is still waiting on someone. */
  resolvedBy: EpisodeAuthor | null;
}

/** Clamp a nullable free-text field to what the DB carries. */
function episodeText(v: string | null | undefined, max = MAX_EPISODE_TEXT): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

/**
 * Record what Foreman was asked and what it did about it.
 *
 * Upserts on (note_key, marker) rather than always inserting, and the distinction
 * matters: the pair is unique by construction (the worker refuses to re-handle a
 * marker it has stamped), so a second write for the same pair is not a second
 * episode - it is the SAME episode reaching a later state, which is exactly what a
 * human's Approve does minutes after Foreman escalated. Inserting there would split
 * one decision across two rows, the second holding the outcome and the first the
 * question, with nothing in the UI to rejoin them.
 *
 * `created_at` is therefore preserved on conflict while everything else is
 * overwritten: the episode began when Foreman first faced it, not when the human got
 * round to it.
 */
export function recordEpisode(e: EpisodeWrite): number {
  const res = openDb()
    .prepare(
      `INSERT INTO foreman_episodes
         (note_key, session_id, marker, situation, surface, question, pane, menu, review_id,
          purpose, brief, recommendation, classification, confidence, tier, cheap_action,
          divergence, triage_reason, skip_reason, disposition,
          last_action, sent_text, sent_option, sent_by, created_at, resolved_at, resolved_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(note_key, marker) DO UPDATE SET
         session_id     = excluded.session_id,
         situation      = excluded.situation,
         surface        = excluded.surface,
         question       = excluded.question,
         pane           = COALESCE(excluded.pane, foreman_episodes.pane),
         menu           = COALESCE(excluded.menu, foreman_episodes.menu),
         review_id      = excluded.review_id,
         purpose        = excluded.purpose,
         brief          = excluded.brief,
         recommendation = excluded.recommendation,
         classification = excluded.classification,
         confidence     = excluded.confidence,
         tier           = excluded.tier,
         -- Overwritten wholesale, NOT coalesced like pane/menu above, and the split is
         -- deliberate. Those two are the captured ASK, which a later write may simply not
         -- have re-read - so keeping the earlier copy is keeping evidence. These two are
         -- part of the ANSWER, beside classification/confidence/tier: they describe the
         -- verdict this row now stores. Coalescing them would leave a measurement taken
         -- under shadow attached to a decision later re-made under off, which reads as
         -- a divergence nobody measured. (No backticks in here: this is a template
         -- literal, and one would end it mid-statement.)
         cheap_action   = excluded.cheap_action,
         divergence     = excluded.divergence,
         -- Overwritten on the same terms, and for the same reason: both describe the
         -- verdict this row now stores, not the ask it was captured from. A re-decision
         -- that no longer went stale must not keep the earlier stale mark, or the ledger
         -- reports a race that this row is the proof did not happen.
         triage_reason  = excluded.triage_reason,
         skip_reason    = excluded.skip_reason,
         disposition    = excluded.disposition,
         last_action    = excluded.last_action,
         sent_text      = excluded.sent_text,
         sent_option    = excluded.sent_option,
         sent_by        = excluded.sent_by,
         resolved_at    = excluded.resolved_at,
         resolved_by    = excluded.resolved_by`,
    )
    .run(
      e.noteKey,
      e.sessionId,
      e.marker,
      e.situation,
      e.surface,
      episodeText(e.question) ?? "",
      episodeText(e.pane, MAX_EPISODE_PANE),
      e.menu ? JSON.stringify(e.menu) : null,
      e.reviewId,
      episodeText(e.purpose),
      episodeText(e.brief),
      episodeText(e.recommendation),
      e.classification,
      e.confidence,
      e.tier,
      e.cheapAction,
      e.divergence,
      episodeText(e.triageReason),
      e.skipReason,
      e.disposition,
      episodeText(e.lastAction),
      episodeText(e.sentText),
      e.sentOption ? JSON.stringify(e.sentOption) : null,
      e.sentBy,
      e.createdAt,
      e.resolvedAt,
      e.resolvedBy,
    );
  return Number(res.lastInsertRowid);
}

/**
 * Stamp the human's answer onto an episode Foreman left open.
 *
 * Separate from `recordEpisode` because the caller is different in kind: the worker
 * writes a whole episode from everything it has in hand, while the dashboard knows
 * only the marker and what the human just did. Routing the UI through the full write
 * would make it invent a question and a pane it never saw, and the COALESCE above
 * would then be load-bearing for correctness rather than for belt-and-braces.
 *
 * A marker with no row is a no-op: an episode written before this shipped (or swept)
 * has nothing to stamp, and failing the Approve over a missing audit row would put a
 * bookkeeping gap in front of the human's actual decision.
 */
export function resolveEpisode(p: {
  noteKey: string;
  marker: string;
  disposition: NoteDisposition;
  sentText: string | null;
  /** Who decided it. Whether they SENT anything is read off `sentText`, not asserted. */
  resolvedBy: EpisodeAuthor;
  resolvedAt: number;
}): void {
  const sent = episodeText(p.sentText);
  openDb()
    .prepare(
      `UPDATE foreman_episodes
          SET disposition = ?, sent_text = ?, sent_by = ?, resolved_at = ?, resolved_by = ?
        WHERE note_key = ? AND marker = ?`,
    )
    .run(
      p.disposition,
      sent,
      // Derived, never taken from the caller: a dismissal resolves the episode without
      // delivering anything, so there is no author to name. Attributing a send that
      // never happened is how the record came to claim the human had approved something
      // they had in fact thrown away.
      sent === null ? null : p.resolvedBy,
      p.resolvedAt,
      p.resolvedBy,
      p.noteKey,
      p.marker,
    );
}

/** The columns both episode reads select, so the two cannot drift apart. */
const EPISODE_COLUMNS = `id, note_key, session_id, marker, situation, surface, question, pane,
        menu, review_id, purpose, brief, recommendation, classification, confidence, tier,
        cheap_action, divergence, triage_reason, skip_reason, disposition, last_action,
        sent_text, sent_option, sent_by, created_at, resolved_at, resolved_by`;

/**
 * One stored row back to the wire shape.
 *
 * Shared by `episodesFor` and `recentEpisodes` rather than written twice: the per-field
 * `?? 0` / `typeof` defence below is the point of it. These rows outlive the daemon that
 * wrote them, so every field is read as "whatever is actually there" rather than trusted,
 * and a second copy of that reasoning would be a second place for it to be got wrong.
 */
function episodeFromRow(r: Record<string, unknown>): ForemanEpisode {
  return {
    id: Number(r.id ?? 0),
    noteKey: String(r.note_key ?? ""),
    sessionId: String(r.session_id ?? ""),
    marker: String(r.marker ?? ""),
    situation: String(r.situation ?? ""),
    surface: r.surface === "input-review" ? "input-review" : "terminal",
    question: String(r.question ?? ""),
    pane: typeof r.pane === "string" ? r.pane : null,
    menu: parseMenu(r.menu),
    reviewId: typeof r.review_id === "string" ? r.review_id : null,
    purpose: typeof r.purpose === "string" ? r.purpose : null,
    brief: typeof r.brief === "string" ? r.brief : null,
    recommendation: typeof r.recommendation === "string" ? r.recommendation : null,
    classification: typeof r.classification === "string" ? r.classification : null,
    confidence: typeof r.confidence === "number" ? r.confidence : null,
    tier: typeof r.tier === "number" ? r.tier : null,
    // Unknown reads as null - "not measured" - never as a nearest match. A row written by
    // a newer build with a divergence kind this one has no word for must render blank
    // rather than be rounded to `agree`, which is the one reading that would flatter the
    // cheap tier on exactly the evidence an operator is using to decide whether to trust it.
    cheapAction: readCheapAction(r.cheap_action),
    divergence: readDivergence(r.divergence),
    // Read as whatever is there, unlike the two above: this is the ladder's own diagnosis
    // and a build that has not learned a newer reason should still print the reason it was
    // given. Rounding it to a known value is what the shadow columns must not do, because
    // there the vocabulary IS the measurement; here the string is the evidence.
    triageReason: typeof r.triage_reason === "string" ? r.triage_reason : null,
    skipReason: readSkipReason(r.skip_reason),
    disposition: episodeDisposition(r.disposition),
    lastAction: typeof r.last_action === "string" ? r.last_action : null,
    sentText: typeof r.sent_text === "string" ? r.sent_text : null,
    sentOption: parseSentOption(r.sent_option),
    sentBy: r.sent_by === "foreman" || r.sent_by === "you" ? r.sent_by : null,
    createdAt: Number(r.created_at ?? 0),
    resolvedAt: typeof r.resolved_at === "number" ? r.resolved_at : null,
    resolvedBy: r.resolved_by === "foreman" || r.resolved_by === "you" ? r.resolved_by : null,
  };
}

/** Every episode recorded for one session key, newest first. */
export function episodesFor(noteKey: string, limit = 100): ForemanEpisode[] {
  const rows = openDb()
    .prepare(
      `SELECT ${EPISODE_COLUMNS}
         FROM foreman_episodes WHERE note_key = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(noteKey, limit) as unknown as Array<Record<string, unknown>>;
  return rows.map(episodeFromRow);
}

/**
 * The newest episodes ACROSS every session, for the Foreman settings ledger.
 *
 * The cross-session counterpart to `episodesFor`, and the direct analogue of
 * `loadInspectorInspections`. Until this existed the table could only be read one
 * `note_key` at a time, so the richest record in the app - what Foreman was asked, what it
 * concluded, and what reached the child - was visible only by opening one session's drawer
 * at a time, and the fleet-wide question ("what has Foreman been doing?") had no answer.
 *
 * Ordered `created_at DESC, id DESC`, matching `episodesFor`: `created_at` is preserved
 * across the upsert, so two episodes recorded in the same millisecond still come back in
 * the order they were written rather than in whatever order the scan happens to reach them.
 *
 * **Returns a SUMMARY, not the stored row, and that is the point.** The first cut reused
 * `episodeFromRow` and therefore put up to a hundred captured terminal screens on a
 * 4-second poll: on a real 631-episode database `pane` was 50.6% of the response and the
 * drawer-only fields came to 82KB per poll, about 72MB an hour with the Settings page
 * open. That is the same cost this feature already refused to pay on the SSE channel (see
 * `Registry.recordEpisode`), just reached by a different transport - a poll is not a
 * loophole in that argument. The pane and menu are still READ here, because the ask is
 * derived from them, but they are reduced to one line by the shared `askPreview` and only
 * that line is returned. The full capture stays on `episodesFor`, which is the read for a
 * surface that shows one decision at a time.
 */
export function recentEpisodes(limit = 100): ForemanEpisodeSummary[] {
  const rows = openDb()
    .prepare(
      `SELECT id, note_key, marker, question, pane, menu, purpose, tier, cheap_action,
              divergence, classification, triage_reason, skip_reason, disposition,
              resolved_by, created_at
         FROM foreman_episodes ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(limit) as unknown as Array<Record<string, unknown>>;
  return rows.map(
    (r): ForemanEpisodeSummary => ({
      id: Number(r.id ?? 0),
      noteKey: String(r.note_key ?? ""),
      marker: String(r.marker ?? ""),
      // Reduced HERE rather than in the browser, which is the whole saving: the inputs
      // are the two biggest columns in the table and the output is one clipped line.
      ask: askPreviewForWire({
        pane: typeof r.pane === "string" ? r.pane : null,
        menu: parseMenu(r.menu),
        question: String(r.question ?? ""),
      }),
      purpose: typeof r.purpose === "string" ? r.purpose : null,
      tier: typeof r.tier === "number" ? r.tier : null,
      cheapAction: readCheapAction(r.cheap_action),
      divergence: readDivergence(r.divergence),
      // The three the row's WHY column is built from - short scalars, not the drawer's
      // free text. See `ForemanEpisodeSummary` for the measurement that says these are
      // affordable where `brief`, `recommendation` and the pane are not.
      classification: typeof r.classification === "string" ? r.classification : null,
      triageReason: typeof r.triage_reason === "string" ? r.triage_reason : null,
      skipReason: readSkipReason(r.skip_reason),
      disposition: episodeDisposition(r.disposition),
      resolvedBy: r.resolved_by === "foreman" || r.resolved_by === "you" ? r.resolved_by : null,
      createdAt: Number(r.created_at ?? 0),
    }),
  );
}

/**
 * One episode in full, by id - the detail read behind a ledger row.
 *
 * The counterpart to `recentEpisodes` deliberately keeping the pane off the wire: the
 * ledger ships a hundred summaries every four seconds, and this ships one whole episode
 * when a reader asks for one. Same shape as `episodesFor` returns, so the settings ledger,
 * the session drawer and the transcript are all reading the identical record through
 * `ForemanEpisodeCard` rather than three near-copies of it.
 *
 * By `id` rather than by `(note_key, marker)` because the ledger row already has the id and
 * a fleet-wide surface has no session to scope the read to - most of the keys in a 30-day
 * ledger name sessions that no longer exist.
 */
export function episodeById(id: number): ForemanEpisode | null {
  const row = openDb()
    .prepare(`SELECT ${EPISODE_COLUMNS} FROM foreman_episodes WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  return row ? episodeFromRow(row) : null;
}

/**
 * A stored disposition back to the union, defaulting to `skipped`.
 *
 * `skipped` and not `escalated` on an unrecognised value: these rows outlive the
 * daemon that wrote them, so a disposition minted by a newer build is a real
 * upgrade-window state. Reading it as `escalated` would put a decision in front of
 * the human that nothing established was theirs to make, and the strip would show a
 * live Approve for it. "Left for you" is the claim that stays true either way.
 */
function episodeDisposition(v: unknown): NoteDisposition {
  return v === "answered" || v === "pending" || v === "escalated" ? v : "skipped";
}

/** A stored `menu` blob back to its rows; a bad blob costs the menu, not the read. */
function parseMenu(raw: unknown): PaneDialogSummary | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as PaneDialogSummary;
    if (!v || !Array.isArray(v.options)) return null;
    return {
      options: v.options
        .filter((o) => o && typeof o.number === "number" && typeof o.label === "string")
        .map((o) => ({ number: o.number, label: o.label })),
      highlighted: typeof v.highlighted === "number" ? v.highlighted : 0,
    };
  } catch {
    return null;
  }
}

/** A stored `sent_option` blob back to the row that was selected. */
function parseSentOption(raw: unknown): { number: number; label: string } | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as { number?: unknown; label?: unknown };
    if (typeof v?.number !== "number" || typeof v?.label !== "string") return null;
    return { number: v.number, label: v.label };
  } catch {
    return null;
  }
}

/**
 * Age out episodes. Returns how many rows went.
 *
 * Aged rather than session-scoped because the record is most interesting once the
 * session is over, so dropping it when the session exits would delete it exactly
 * when it starts being read.
 */
export function pruneEpisodes(cutoff: number): number {
  return Number(
    openDb().prepare(`DELETE FROM foreman_episodes WHERE created_at < ?`).run(cutoff).changes,
  );
}

/**
 * Whether this session has ever emitted a hook event - the durable half of
 * `Session.hooksSeen`.
 *
 * `session_events` is written by exactly one caller (`applyHook`) and never
 * pruned, so a row here means "hooks reached us from this session" for as long as
 * the DB lives.
 *
 * That single writer is LOad-BEARING, not incidental: this asks "any row?", not
 * "any row of a hook kind", so a second writer would make every session it
 * touched claim hooks it never emitted, silently, in a fact that decides whether a
 * session looks uninstrumented. Anything logged against a session that is NOT a
 * hook needs a different table, or this query needs to name the kinds it counts.
 *
 * The durability outlasts the process, which is the whole point: overlays are
 * in-memory, so on a daemon restart a live, healthy, hook-instrumented session
 * that happens to be quiet looks identical to one with no integrations at all -
 * and anything that escalates on the latter would fire on the former. The
 * synthetic session id is tty+pid+start, so it's stable across a daemon restart
 * for the same agent process and mints fresh for a genuinely new one.
 */
export function hooksEverSeen(sessionId: string): boolean {
  const row = openDb()
    .prepare(`SELECT 1 AS hit FROM session_events WHERE session_id = ? LIMIT 1`)
    .get(sessionId) as { hit: number } | undefined;
  return row !== undefined;
}

/**
 * Remember which agent session a discovered session is running - the durable half
 * of `Session.agentSessionId`, and the same shape as `hooksEverSeen` above.
 *
 * The binding is not decoration: `noteKeyFor` is `agentSessionId ?? syntheticId`,
 * so it is the identity a session's note and WORK QUEUE are stored under. Only a
 * live hook/statusLine reports it, so without this a daemon restart rebuilds every
 * session under its synthetic id, no stored queue matches a live key, and the
 * orphan sweep terminally escalates the in-flight item of every healthy session in
 * the sessions. The synthetic id is tty+pid+start, so it's stable across a restart for
 * the same agent process and mints fresh for a genuinely new one; a `/clear` mints
 * a new agent session id on the same pane and overwrites the row, which is exactly
 * right - the queue it just left behind SHOULD orphan.
 */
export function recordAgentBinding(sessionId: string, agentSessionId: string, now: number): void {
  openDb()
    .prepare(
      `INSERT INTO session_agent_bindings (session_id, agent_session_id, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         agent_session_id = excluded.agent_session_id,
         updated_at       = excluded.updated_at`,
    )
    .run(sessionId, agentSessionId, now);
}

/** The last agent session id bound to this session, or null if none ever was. */
export function lastAgentBinding(sessionId: string): string | null {
  const row = openDb()
    .prepare(`SELECT agent_session_id AS id FROM session_agent_bindings WHERE session_id = ?`)
    .get(sessionId) as { id: string } | undefined;
  return row?.id ?? null;
}

// ---- tasks ----

interface TaskRow {
  id: string;
  title: string;
  intent: string;
  kind: string;
  agent: string;
  priority: string | null;
  labels: string | null;
  dependencies: string | null;
  enabled: number;
  model: string | null;
  effort: string | null;
  workflow_id: string | null;
  source_id: string | null;
  external_id: string | null;
  source_url: string | null;
  repo_root: string;
  worktree_path: string | null;
  branch: string | null;
  provider: string | null;
  base_sha: string | null;
  home_name: string | null;
  terminal_resource_id: string | null;
  session_id: string | null;
  schedule_id: string | null;
  schedule_occurrence_id: string | null;
  scheduled_for: number | null;
  status: string;
  outcome: string | null;
  outcome_url: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  dispatched_at: number | null;
  completed_at: number | null;
}

interface TaskRepoRow {
  task_id: string;
  repo_root: string;
  worktree_path: string | null;
  branch: string | null;
  provider: string | null;
  base_sha: string | null;
  position: number;
}

/**
 * The pull request to show for one repository, out of everything its task's episodes
 * recorded for it.
 *
 * `primaryRepoPrForTask`'s rule, on the other half of the data shape, and it has to be the
 * SAME rule or the two halves of one card disagree about what "this repo's pull request"
 * means. A task can have several episodes (an agent that restarted, a fix-forward run), so
 * one repository can carry more than one row over its life, and nothing prunes the old ones -
 * deliberately, because a merge on a rolled-off episode is still the outcome.
 *
 * So: a MERGED row counts from ANY episode, newest merge winning. An UNMERGED one counts only
 * from the CURRENT episode. Without that second clause a repo the agent opened a pull request
 * in, then restarted and never touched again, keeps reporting that abandoned pull request for
 * ever - and because `repoChangeVerdict` reads any `prUrl` as "changed" while the url can
 * never merge, the all-merged quorum would hold on it permanently and the task could never
 * complete. Scoping it is what makes "no pull request opened here yet" the honest answer, and
 * hands the repo's membership back to the head-against-baseline clause that exists for it.
 */
function pickRepoPr(
  rows: readonly WorkEpisodeRepoPr[],
  currentEpisodeId: string | null,
): WorkEpisodeRepoPr | null {
  let merged: WorkEpisodeRepoPr | null = null;
  let current: WorkEpisodeRepoPr | null = null;
  for (const row of rows) {
    if (row.mergedAt !== null) {
      if (merged === null || row.mergedAt > (merged.mergedAt ?? 0)) merged = row;
      continue;
    }
    // Rows arrive newest-written first, so the first match is the one to keep.
    if (current === null && currentEpisodeId !== null && row.episodeId === currentEpisodeId) {
      current = row;
    }
  }
  return merged ?? current;
}

function rowToTaskRepo(
  r: TaskRepoRow,
  prs: readonly WorkEpisodeRepoPr[] = [],
  currentEpisodeId: string | null = null,
): TaskRepoEntry {
  const pr = pickRepoPr(
    prs.filter((entry) => entry.repoRoot === r.repo_root),
    currentEpisodeId,
  );
  return {
    repoRoot: r.repo_root,
    worktreePath: r.worktree_path,
    branch: r.branch,
    provider: r.provider as WorktreeProvider | null,
    baseSha: r.base_sha,
    // Projected on read from `work_episode_prs` rather than stored on this row, so there is
    // one writer of a repository's pull request and one reader of it. Deriving any of this
    // from the PRIMARY's pull request would report the wrong repository's work.
    prUrl: pr?.prUrl ?? null,
    prState: pr?.prState ?? null,
    mergedAt: pr?.mergedAt ?? null,
  };
}

/** One task's secondary repos, in `position` order. Empty for a single-repo task. */
export function taskReposFor(taskId: string): TaskRepoEntry[] {
  const rows = openDb()
    .prepare(`SELECT * FROM task_repos WHERE task_id = ? ORDER BY position`)
    .all(taskId) as unknown as TaskRepoRow[];
  if (rows.length === 0) return [];
  const prs = workEpisodeRepoPrsForTask(taskId);
  const currentEpisodeId = taskWorkEpisodeForTask(taskId)?.episodeId ?? null;
  return rows.map((row) => rowToTaskRepo(row, prs, currentEpisodeId));
}

/**
 * Every task's secondary repos in one read, grouped by task id.
 *
 * One query rather than one per row: `listTasks` and its siblings map whole tables, and a
 * per-task lookup there would put a statement behind every card on the board. The whole
 * table is read because it is empty on a single-repo install and small on any other - far
 * cheaper than assembling an `IN (?, ?, …)` list that would also have to be chunked.
 */
function taskReposByTask(): Map<string, TaskRepoEntry[]> {
  const rows = openDb()
    .prepare(`SELECT * FROM task_repos ORDER BY task_id, position`)
    .all() as unknown as TaskRepoRow[];
  const out = new Map<string, TaskRepoEntry[]>();
  if (rows.length === 0) return out;
  const prsByTask = workEpisodeRepoPrsByTask();
  // One read for every task's current episode, for the same reason the pull requests are read
  // whole: the batch reader must reach the same answer as `taskReposFor`, and a per-row lookup
  // would put a statement behind every card on the board.
  const currentEpisodeByTask = new Map(
    (
      openDb()
        .prepare(`SELECT task_id, episode_id FROM task_work_episode_bindings`)
        .all() as unknown as Array<{ task_id: string; episode_id: string }>
    ).map((r) => [r.task_id, r.episode_id]),
  );
  for (const row of rows) {
    const entry = rowToTaskRepo(
      row,
      prsByTask.get(row.task_id) ?? [],
      currentEpisodeByTask.get(row.task_id) ?? null,
    );
    const list = out.get(row.task_id);
    if (list) list.push(entry);
    else out.set(row.task_id, [entry]);
  }
  return out;
}

/**
 * Map task rows to `Task`s, attaching each one's secondary repos.
 *
 * Exists so no caller can write `rows.map(rowToTask)` and silently produce tasks whose
 * `extraRepos` is empty - which for a multi-repo task is not a missing display detail but
 * a set of worktrees the pool reaper would then be free to hard-reset.
 */
function rowsToTasks(rows: TaskRow[]): Task[] {
  if (rows.length === 0) return [];
  const byTask = taskReposByTask();
  return rows.map((r) => rowToTask(r, byTask.get(r.id) ?? []));
}

/** Read a `tasks.labels` blob back as a clean string array; anything unusable is none. */
function parseLabels(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return normalizeLabels(parsed.filter((v): v is string => typeof v === "string"));
  } catch {
    return [];
  }
}

/** Read dependency JSON defensively: one stale row must not take down the backlog. */
function parseTaskDependencies(raw: string | null): Task["dependencies"] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: Task["dependencies"] = [];
    const seen = new Set<string>();
    for (const value of parsed) {
      if (!value || typeof value !== "object") continue;
      const row = value as Record<string, unknown>;
      const selectedAt = typeof row.selectedAt === "number" ? row.selectedAt : null;
      const satisfiedAt = typeof row.satisfiedAt === "number" ? row.satisfiedAt : null;
      if (row.type === "task" && typeof row.taskId === "string" && typeof row.title === "string") {
        const key = `task:${row.taskId}`;
        if (!seen.has(key)) {
          out.push({
            type: "task",
            taskId: row.taskId,
            title: row.title,
            sessionId: typeof row.sessionId === "string" ? row.sessionId : null,
            episodeId: typeof row.episodeId === "string" ? row.episodeId : null,
            agentSessionId: typeof row.agentSessionId === "string" ? row.agentSessionId : null,
            branch: typeof row.branch === "string" ? row.branch : null,
            prUrl: typeof row.prUrl === "string" ? row.prUrl : null,
            selectedAt,
            satisfiedAt,
          });
        }
        seen.add(key);
      } else if (
        row.type === "session" &&
        typeof row.sessionId === "string" &&
        typeof row.title === "string"
      ) {
        const key = `session:${row.sessionId}`;
        if (!seen.has(key)) {
          out.push({
            type: "session",
            sessionId: row.sessionId,
            title: row.title,
            episodeId: typeof row.episodeId === "string" ? row.episodeId : null,
            agentSessionId: typeof row.agentSessionId === "string" ? row.agentSessionId : null,
            branch: typeof row.branch === "string" ? row.branch : null,
            prUrl: typeof row.prUrl === "string" ? row.prUrl : null,
            selectedAt,
            satisfiedAt,
          });
        }
        seen.add(key);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** A stale/newer effort value cannot be trusted as a harness launch option. */
function parseEffort(agent: Task["agent"], raw: string | null): Task["effort"] {
  return raw && supportsEffort(agent, raw as NonNullable<Task["effort"]>)
    ? (raw as Task["effort"])
    : null;
}

/**
 * `extraRepos` is a REQUIRED argument with no default, which is what keeps
 * `rows.map(rowToTask)` from compiling: `map` would pass the index there, and the
 * resulting type error is the whole point - see `rowsToTasks`.
 */
function rowToTask(r: TaskRow, extraRepos: TaskRepoEntry[]): Task {
  return {
    id: r.id,
    title: r.title,
    intent: r.intent,
    // Validated, not cast. The column is unconstrained TEXT, so the value is whatever
    // some build wrote there, and `as TaskKind` let an unknown string flow into typed
    // code as a kind that does not exist - reaching a `Record<TaskKind, …>` lookup as an
    // `undefined` nobody's types warned about.
    //
    // `ship` and not null, which is where this deliberately differs from the schedule
    // store's identical validation (`schedules/store.ts`): a template that cannot be read
    // can be dropped, and a task row cannot. One unreadable row must not remove a task
    // from the backlog, so it degrades to the kind every automated writer already
    // defaults to. The cost is stated plainly - a `plan` row read by a build that predates
    // the kind is a `ship` row on that build, and SAVING it there writes `ship` back.
    kind: readPersistedEnum(TASK_KINDS, r.kind) ?? DEFAULT_TASK_KIND,
    agent: r.agent as Task["agent"],
    priority: r.priority as TaskPriority | null,
    // Re-normalized on the way out, not merely parsed. The column is plain TEXT and
    // this row may predate the cap (or have been written by an older build), so the
    // shared cleaner is what guarantees a caller never sees a duplicate or an
    // unbounded tag. A malformed blob reads as no labels rather than throwing - one
    // bad row must not take out `listTasks` and with it the whole backlog.
    labels: parseLabels(r.labels),
    dependencies: parseTaskDependencies(r.dependencies),
    // Only an explicit 0 parks a task. A row written by an older build, or one whose
    // column somehow reads NULL, is schedulable - the direction that degrades to the
    // behaviour every install already had rather than to a silently frozen backlog.
    enabled: r.enabled !== 0,
    model: r.model,
    effort: parseEffort(r.agent as Task["agent"], r.effort),
    workflowId: r.workflow_id,
    // Both key columns or nothing: half a provenance would render as a link to an item
    // nobody can name, and `source_id` alone cannot be matched back to anything.
    source:
      r.source_id && r.external_id
        ? { sourceId: r.source_id, externalId: r.external_id, url: r.source_url }
        : null,
    repoRoot: r.repo_root,
    worktreePath: r.worktree_path,
    branch: r.branch,
    provider: r.provider as WorktreeProvider | null,
    baseSha: r.base_sha,
    extraRepos,
    homeName: r.home_name,
    terminalResourceId: r.terminal_resource_id,
    sessionId: r.session_id,
    scheduleId: r.schedule_id,
    scheduleOccurrenceId: r.schedule_occurrence_id,
    scheduledFor: r.scheduled_for,
    status: r.status as TaskStatus,
    outcome: r.outcome,
    outcomeUrl: r.outcome_url,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    dispatchedAt: r.dispatched_at,
    completedAt: r.completed_at,
  };
}

export function upsertTask(t: Task): string[] {
  const d = openDb();
  const ownsTransaction = !d.isTransaction;
  if (ownsTransaction) d.exec("BEGIN IMMEDIATE");
  try {
    // `session_id` is "currently executing on" (see `Task.sessionId`), and this is where
    // that is made EXCLUSIVE: writing the pointer onto one task takes it off every other
    // row in the same transaction, so a session names at most one task at a time and the
    // pointer simply MOVES when an agent takes its next task. It is a pointer and not a
    // record: what the displaced task produced is its own row's outcome and its own work
    // episodes, neither of which this touches. `idx_tasks_session` (a partial UNIQUE index)
    // is the same rule stated where it cannot be skipped; this statement is what keeps the
    // write from hitting it. The ids are returned so the caller can unbind those rows in
    // memory too - a Registry that kept a stale pointer would draw a card for a task the
    // database says is no longer running there.
    const displaced = t.sessionId
      ? (d
          .prepare(`SELECT id FROM tasks WHERE session_id = ? AND id <> ?`)
          .all(t.sessionId, t.id) as unknown as Array<{ id: string }>).map((row) => row.id)
      : [];
    if (t.sessionId) {
      d.prepare(`UPDATE tasks SET session_id = NULL WHERE session_id = ? AND id <> ?`).run(
        t.sessionId,
        t.id,
      );
    }
    d.prepare(
      `INSERT INTO tasks (
         id, title, intent, kind, agent, priority, labels, dependencies, enabled, model, effort,
         workflow_id, source_id, external_id, source_url, repo_root, worktree_path, branch,
         provider, base_sha, home_name, terminal_resource_id, session_id,
         schedule_id, schedule_occurrence_id, scheduled_for,
         status, outcome, outcome_url, error,
         created_at, updated_at, dispatched_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title=excluded.title, intent=excluded.intent, kind=excluded.kind, agent=excluded.agent,
         priority=excluded.priority, labels=excluded.labels, dependencies=excluded.dependencies,
         enabled=excluded.enabled, model=excluded.model, effort=excluded.effort,
         workflow_id=excluded.workflow_id,
         source_id=excluded.source_id, external_id=excluded.external_id,
         source_url=excluded.source_url,
         repo_root=excluded.repo_root, worktree_path=excluded.worktree_path, branch=excluded.branch,
         provider=excluded.provider, base_sha=excluded.base_sha, home_name=excluded.home_name,
         terminal_resource_id=excluded.terminal_resource_id, session_id=excluded.session_id,
         schedule_id=excluded.schedule_id,
         schedule_occurrence_id=excluded.schedule_occurrence_id,
         scheduled_for=excluded.scheduled_for,
         status=excluded.status, outcome=excluded.outcome, outcome_url=excluded.outcome_url,
         error=excluded.error, updated_at=excluded.updated_at, dispatched_at=excluded.dispatched_at,
         completed_at=excluded.completed_at`,
    ).run(
      t.id, t.title, t.intent, t.kind, t.agent, t.priority,
      // Stored as NULL rather than "[]" when empty, so the column reads the same for a
      // task filed before labels existed and one filed today with none - there is no
      // third state to tell apart, and `parseLabels` maps both back to [].
      t.labels.length > 0 ? JSON.stringify(t.labels) : null,
      t.dependencies.length > 0 ? JSON.stringify(t.dependencies) : null,
      t.enabled ? 1 : 0,
      t.model,
      t.effort,
      t.workflowId,
      t.source?.sourceId ?? null, t.source?.externalId ?? null, t.source?.url ?? null,
      t.repoRoot, t.worktreePath, t.branch, t.provider, t.baseSha,
      t.homeName, t.terminalResourceId, t.sessionId,
      t.scheduleId, t.scheduleOccurrenceId, t.scheduledFor,
      t.status, t.outcome, t.outcomeUrl, t.error, t.createdAt,
      t.updatedAt, t.dispatchedAt, t.completedAt,
    );
    // The secondary repos are REPLACED, in this same transaction, because `Task` carries
    // the whole collection: a caller that dropped an entry expects the row to go, and a
    // stale row would keep pinning a worktree nothing is using. Delete-then-insert rather
    // than an upsert per entry so a shrunk set actually shrinks. `position` is the array
    // index, which is what the git-fallback worktree path is derived from - so this must
    // stay a faithful rewrite of the same order, never a re-sort.
    d.prepare(`DELETE FROM task_repos WHERE task_id = ?`).run(t.id);
    if (t.extraRepos.length > 0) {
      const insert = d.prepare(
        `INSERT INTO task_repos (task_id, repo_root, worktree_path, branch, provider, base_sha, position)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      t.extraRepos.forEach((entry, position) => {
        insert.run(
          t.id,
          entry.repoRoot,
          entry.worktreePath,
          entry.branch,
          entry.provider,
          entry.baseSha,
          position,
        );
      });
    }
    if (ownsTransaction) d.exec("COMMIT");
    return displaced;
  } catch (error) {
    if (ownsTransaction && d.isTransaction) d.exec("ROLLBACK");
    throw error;
  }
}

export function getTask(id: string): Task | undefined {
  const r = openDb().prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as unknown as
    | TaskRow
    | undefined;
  return r ? rowToTask(r, taskReposFor(r.id)) : undefined;
}

export function taskIdForSession(sessionId: string): string | null {
  const row = openDb()
    .prepare(
      `SELECT id FROM tasks
       WHERE session_id = ? AND status NOT IN ('backlog', 'cancelled')`,
    )
    .get(sessionId) as { id: string } | undefined;
  return row?.id ?? null;
}

export interface SessionWorkEpisode {
  episodeId: string;
  sessionId: string;
  agentSessionId: string;
  branch: string | null;
  prUrl: string | null;
  prHeadSha: string | null;
  mergedAt: number | null;
  promptedAt: number | null;
  awaitingAgentRebind: boolean;
  rebindFromTranscriptPath: string | null;
  startedAt: number;
  updatedAt: number;
}

export interface TaskWorkEpisodeBinding {
  taskId: string;
  episodeId: string;
  sessionId: string;
  agentSessionId: string;
  branch: string | null;
  prUrl: string | null;
  prHeadSha: string | null;
  mergedAt: number | null;
  boundAt: number;
  updatedAt: number;
}

type SessionWorkEpisodeRow = {
  episode_id: string;
  session_id: string;
  agent_session_id: string;
  branch: string | null;
  pr_url: string | null;
  pr_head_sha: string | null;
  merged_at: number | null;
  prompted_at: number | null;
  awaiting_agent_rebind: number;
  rebind_from_transcript_path: string | null;
  started_at: number;
  updated_at: number;
};

type TaskWorkEpisodeRow = {
  task_id: string;
  episode_id: string;
  session_id: string;
  agent_session_id: string;
  branch: string | null;
  pr_url: string | null;
  pr_head_sha: string | null;
  merged_at: number | null;
  bound_at: number;
  updated_at: number;
};

function sessionWorkEpisodeFromRow(row: SessionWorkEpisodeRow): SessionWorkEpisode {
  return {
    episodeId: row.episode_id,
    sessionId: row.session_id,
    agentSessionId: row.agent_session_id,
    branch: row.branch,
    prUrl: row.pr_url,
    prHeadSha: row.pr_head_sha,
    mergedAt: row.merged_at,
    promptedAt: row.prompted_at,
    awaitingAgentRebind: Boolean(row.awaiting_agent_rebind),
    rebindFromTranscriptPath: row.rebind_from_transcript_path,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  };
}

function taskWorkEpisodeFromRow(row: TaskWorkEpisodeRow): TaskWorkEpisodeBinding {
  return {
    taskId: row.task_id,
    episodeId: row.episode_id,
    sessionId: row.session_id,
    agentSessionId: row.agent_session_id,
    branch: row.branch,
    prUrl: row.pr_url,
    prHeadSha: row.pr_head_sha,
    mergedAt: row.merged_at,
    boundAt: row.bound_at,
    updatedAt: row.updated_at,
  };
}

export function sessionWorkEpisodeFor(sessionId: string): SessionWorkEpisode | null {
  const row = openDb()
    .prepare(`SELECT * FROM session_work_episodes WHERE session_id = ?`)
    .get(sessionId) as unknown as SessionWorkEpisodeRow | undefined;
  return row ? sessionWorkEpisodeFromRow(row) : null;
}

export interface TaskDependencyRewrite {
  taskId: string;
  dependencies: Task["dependencies"];
  updatedAt: number;
}

function writeSessionWorkEpisode(d: DatabaseSync, episode: SessionWorkEpisode): void {
  d.prepare(
    `INSERT INTO session_work_episodes
       (session_id, episode_id, agent_session_id, branch, pr_url, pr_head_sha, merged_at, prompted_at,
        awaiting_agent_rebind, rebind_from_transcript_path, started_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       episode_id       = excluded.episode_id,
       agent_session_id = excluded.agent_session_id,
       branch           = excluded.branch,
       pr_url            = excluded.pr_url,
       pr_head_sha       = excluded.pr_head_sha,
       merged_at         = excluded.merged_at,
       prompted_at       = excluded.prompted_at,
       awaiting_agent_rebind = excluded.awaiting_agent_rebind,
       rebind_from_transcript_path = excluded.rebind_from_transcript_path,
       started_at       = excluded.started_at,
       updated_at       = excluded.updated_at`,
  ).run(
    episode.sessionId,
    episode.episodeId,
    episode.agentSessionId,
    episode.branch,
    episode.prUrl,
    episode.prHeadSha,
    episode.mergedAt,
    episode.promptedAt,
    episode.awaitingAgentRebind ? 1 : 0,
    episode.rebindFromTranscriptPath,
    episode.startedAt,
    episode.updatedAt,
  );
  if (episode.promptedAt !== null) {
    d.prepare(
      `INSERT OR IGNORE INTO session_work_episode_prompts
         (session_id, episode_id, prompted_at)
       VALUES (?, ?, ?)`,
    ).run(episode.sessionId, episode.episodeId, episode.promptedAt);
  }
}

function writeTaskDependencyRewrites(
  d: DatabaseSync,
  rewrites: TaskDependencyRewrite[],
): void {
  const update = d.prepare(
    `UPDATE tasks SET dependencies = ?, updated_at = ? WHERE id = ?`,
  );
  for (const rewrite of rewrites) {
    const result = update.run(
      rewrite.dependencies.length > 0 ? JSON.stringify(rewrite.dependencies) : null,
      rewrite.updatedAt,
      rewrite.taskId,
    );
    if (Number(result.changes) !== 1) {
      throw new Error(`task disappeared during dependency rebind: ${rewrite.taskId}`);
    }
  }
}

function invalidateTaskOwnershipInTransaction(
  d: DatabaseSync,
  sessionId: string,
  at: number,
): string[] {
  const rows = d
    .prepare(
      `SELECT task_id FROM task_work_episode_bindings WHERE session_id = ?
       UNION SELECT id AS task_id FROM tasks WHERE session_id = ?`,
    )
    .all(sessionId, sessionId) as unknown as Array<{ task_id: string }>;
  // KNOWN GAP, deliberately left: this is the ONE binding-deleting path that does not
  // archive first. `bindTaskWorkEpisode` archives on both of its keys precisely so a
  // task's merge evidence outlives a rebind, and the same argument reads as if it applied
  // here - a task whose pull request merges after its session's work identity rotated has
  // no current binding and no historical one, so `mergedPrFor` reads null, the row this
  // statement just cancelled can never be upgraded, and `taskPrPollTargets` does not even
  // watch the url. Archiving here was tried and reverted: it makes exactly that upgrade
  // happen, and `complete(..., satisfyDependents)` then releases EVERY dependent of the
  // upgraded task - including edges the selection-time boundary in
  // `reconcileWorkEpisodeMerge` deliberately refuses, which is a different rule about who
  // a merge speaks for. Reconciling those two is a decision in its own right and not one
  // to make as a side effect. See `task-dependencies.test.ts`, which pins the boundary.
  d.prepare(`DELETE FROM task_work_episode_bindings WHERE session_id = ?`).run(sessionId);
  d.prepare(
    `UPDATE tasks SET
       session_id = NULL,
       status = CASE WHEN status IN ('dispatching', 'running') THEN 'cancelled' ELSE status END,
       completed_at = CASE
         WHEN status IN ('dispatching', 'running') THEN COALESCE(completed_at, ?)
         ELSE completed_at
       END,
       updated_at = MAX(updated_at, ?)
     WHERE session_id = ?`,
  ).run(at, at, sessionId);
  return rows.map((row) => row.task_id);
}

export function replaceSessionWorkEpisodeWithDependencies(
  episode: SessionWorkEpisode,
  rewrites: TaskDependencyRewrite[],
  invalidateOwnershipSessionId: string | null = null,
): string[] {
  const d = openDb();
  const ownsTransaction = !d.isTransaction;
  if (ownsTransaction) d.exec("BEGIN IMMEDIATE");
  try {
    const invalidatedTaskIds = invalidateOwnershipSessionId === null
      ? []
      : invalidateTaskOwnershipInTransaction(d, invalidateOwnershipSessionId, episode.updatedAt);
    writeSessionWorkEpisode(d, episode);
    writeTaskDependencyRewrites(d, rewrites);
    if (ownsTransaction) d.exec("COMMIT");
    return invalidatedTaskIds;
  } catch (error) {
    if (ownsTransaction && d.isTransaction) d.exec("ROLLBACK");
    throw error;
  }
}

export function replaceSessionWorkEpisode(episode: SessionWorkEpisode): void {
  replaceSessionWorkEpisodeWithDependencies(episode, []);
}

export function deleteSessionWorkEpisodeWithOwnership(
  sessionId: string,
  at = Date.now(),
): string[] {
  const d = openDb();
  const ownsTransaction = !d.isTransaction;
  if (ownsTransaction) d.exec("BEGIN IMMEDIATE");
  try {
    const invalidatedTaskIds = invalidateTaskOwnershipInTransaction(d, sessionId, at);
    d.prepare(`DELETE FROM session_work_episodes WHERE session_id = ?`).run(sessionId);
    if (ownsTransaction) d.exec("COMMIT");
    return invalidatedTaskIds;
  } catch (error) {
    if (ownsTransaction && d.isTransaction) d.exec("ROLLBACK");
    throw error;
  }
}

export interface PendingSessionWorkEpisodeRebindResult {
  rebound: boolean;
  invalidatedTaskIds: string[];
}

export function rebindPendingSessionWorkEpisodeWithDependencies(
  sessionId: string,
  episodeId: string,
  agentSessionId: string,
  now: number,
  rewrites: TaskDependencyRewrite[],
  invalidateOwnershipSessionId: string | null = null,
): PendingSessionWorkEpisodeRebindResult {
  const d = openDb();
  const ownsTransaction = !d.isTransaction;
  if (ownsTransaction) d.exec("BEGIN IMMEDIATE");
  try {
    const pending = d
      .prepare(
        `SELECT 1 FROM session_work_episodes
         WHERE session_id = ? AND episode_id = ? AND awaiting_agent_rebind = 1`,
      )
      .get(sessionId, episodeId);
    if (!pending) {
      if (ownsTransaction) d.exec("COMMIT");
      return { rebound: false, invalidatedTaskIds: [] };
    }
    const invalidatedTaskIds = invalidateOwnershipSessionId === null
      ? []
      : invalidateTaskOwnershipInTransaction(d, invalidateOwnershipSessionId, now);
    const result = d
      .prepare(
        `UPDATE session_work_episodes
         SET agent_session_id = ?, awaiting_agent_rebind = 0,
             rebind_from_transcript_path = NULL, updated_at = ?
         WHERE session_id = ? AND episode_id = ? AND awaiting_agent_rebind = 1`,
      )
      .run(agentSessionId, now, sessionId, episodeId);
    if (Number(result.changes) !== 1) {
      throw new Error(`pending work episode disappeared during rebind: ${sessionId}`);
    }
    if (invalidateOwnershipSessionId === null) {
      d.prepare(
        `UPDATE task_work_episode_bindings
         SET agent_session_id = ?, updated_at = ?
        WHERE session_id = ? AND episode_id = ?`,
      ).run(agentSessionId, now, sessionId, episodeId);
    }
    writeTaskDependencyRewrites(d, rewrites);
    if (ownsTransaction) d.exec("COMMIT");
    return { rebound: true, invalidatedTaskIds };
  } catch (error) {
    if (ownsTransaction && d.isTransaction) d.exec("ROLLBACK");
    throw error;
  }
}

export function rebindPendingSessionWorkEpisode(
  sessionId: string,
  episodeId: string,
  agentSessionId: string,
  now: number,
): boolean {
  return rebindPendingSessionWorkEpisodeWithDependencies(
    sessionId,
    episodeId,
    agentSessionId,
    now,
    [],
  ).rebound;
}

export function deleteSessionWorkEpisode(sessionId: string): void {
  openDb().prepare(`DELETE FROM session_work_episodes WHERE session_id = ?`).run(sessionId);
}

export function deleteWorkEpisodePrompts(sessionId: string, episodeId: string): void {
  openDb()
    .prepare(
      `DELETE FROM session_work_episode_prompts WHERE session_id = ? AND episode_id = ?`,
    )
    .run(sessionId, episodeId);
}

export function workEpisodePromptIdentities(): Array<{
  sessionId: string;
  episodeId: string;
}> {
  const rows = openDb()
    .prepare(
      `SELECT DISTINCT session_id, episode_id FROM session_work_episode_prompts`,
    )
    .all() as unknown as Array<{ session_id: string; episode_id: string }>;
  return rows.map((row) => ({ sessionId: row.session_id, episodeId: row.episode_id }));
}

export function bindTaskWorkEpisode(binding: TaskWorkEpisodeBinding): void {
  const d = openDb();
  const ownsTransaction = !d.isTransaction;
  if (ownsTransaction) d.exec("BEGIN IMMEDIATE");
  try {
    // Archive the outgoing binding before this write overwrites it. On a rollover the SAME
    // task_id row is upserted with a NEW episode_id, so the episode the task is rolling OFF
    // - and the pr_url / merged_at that are the only durable proof its work landed - would
    // be lost. `mergedPrFor` reads current AND historical bindings precisely so that a merge
    // on a rolled-past episode still completes the task; that read is inert unless the old
    // binding is preserved here. Only a row that actually changes episode and carries a PR
    // is worth keeping - a PR-less binding is no completion evidence, and
    // `cleanupDependencyProvenance` prunes it anyway. (#167 archived here too, then dropped
    // it when dependency provenance moved onto the edges; durable completion is the new
    // reader that needs it back.) COALESCE keeps a merge already recorded on the historical
    // row rather than letting a re-archival clear it.
    d.prepare(
      `INSERT INTO historical_task_work_episode_bindings
         (task_id, episode_id, session_id, agent_session_id, branch, pr_url, pr_head_sha,
          merged_at, bound_at, updated_at)
       SELECT task_id, episode_id, session_id, agent_session_id, branch, pr_url, pr_head_sha,
              merged_at, bound_at, updated_at
       FROM task_work_episode_bindings
       WHERE task_id = ? AND episode_id <> ? AND pr_url IS NOT NULL
       ON CONFLICT(task_id, episode_id) DO UPDATE SET
         session_id       = excluded.session_id,
         agent_session_id = excluded.agent_session_id,
         branch           = excluded.branch,
         pr_url           = excluded.pr_url,
         pr_head_sha      = excluded.pr_head_sha,
         merged_at        = COALESCE(excluded.merged_at, historical_task_work_episode_bindings.merged_at),
         bound_at         = excluded.bound_at,
         updated_at       = excluded.updated_at`,
    ).run(binding.taskId, binding.episodeId);
    // And archive any OTHER task's PR-carrying binding that the cross-task DELETE below is
    // about to drop. A session rebound from task A to task B removes A's current binding
    // here; if A's PR had merged while A was still active, losing that row leaves A with
    // neither a current nor a historical merge, so a later departure fails it. This is the
    // same durable-record contract as the rollover archival above, on the other key
    // (session_id, task_id <>) - #167 archived by both keys for exactly this reason.
    d.prepare(
      `INSERT INTO historical_task_work_episode_bindings
         (task_id, episode_id, session_id, agent_session_id, branch, pr_url, pr_head_sha,
          merged_at, bound_at, updated_at)
       SELECT task_id, episode_id, session_id, agent_session_id, branch, pr_url, pr_head_sha,
              merged_at, bound_at, updated_at
       FROM task_work_episode_bindings
       WHERE session_id = ? AND task_id <> ? AND pr_url IS NOT NULL
       ON CONFLICT(task_id, episode_id) DO UPDATE SET
         session_id       = excluded.session_id,
         agent_session_id = excluded.agent_session_id,
         branch           = excluded.branch,
         pr_url           = excluded.pr_url,
         pr_head_sha      = excluded.pr_head_sha,
         merged_at        = COALESCE(excluded.merged_at, historical_task_work_episode_bindings.merged_at),
         bound_at         = excluded.bound_at,
         updated_at       = excluded.updated_at`,
    ).run(binding.sessionId, binding.taskId);
    d.prepare(
      `DELETE FROM task_work_episode_bindings WHERE session_id = ? AND task_id <> ?`,
    ).run(binding.sessionId, binding.taskId);
    d.prepare(
      `INSERT INTO task_work_episode_bindings
         (task_id, episode_id, session_id, agent_session_id, branch, pr_url, pr_head_sha,
          merged_at, bound_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET
         episode_id       = excluded.episode_id,
         session_id       = excluded.session_id,
         agent_session_id = excluded.agent_session_id,
         branch           = excluded.branch,
         pr_url           = excluded.pr_url,
         pr_head_sha      = excluded.pr_head_sha,
         merged_at        = excluded.merged_at,
         bound_at         = excluded.bound_at,
         updated_at       = excluded.updated_at`,
    ).run(
      binding.taskId,
      binding.episodeId,
      binding.sessionId,
      binding.agentSessionId,
      binding.branch,
      binding.prUrl,
      binding.prHeadSha,
      binding.mergedAt,
      binding.boundAt,
      binding.updatedAt,
    );
    if (ownsTransaction) d.exec("COMMIT");
  } catch (error) {
    if (ownsTransaction && d.isTransaction) d.exec("ROLLBACK");
    throw error;
  }
}

export function taskWorkEpisodeForSession(sessionId: string): TaskWorkEpisodeBinding | null {
  const row = openDb()
    .prepare(
      `SELECT b.* FROM task_work_episode_bindings b
       JOIN tasks t ON t.id = b.task_id
       WHERE b.session_id = ? AND t.status NOT IN ('backlog', 'cancelled')`,
    )
    .get(sessionId) as unknown as TaskWorkEpisodeRow | undefined;
  return row ? taskWorkEpisodeFromRow(row) : null;
}

export function taskWorkEpisodeForTask(taskId: string): TaskWorkEpisodeBinding | null {
  const row = openDb()
    .prepare(`SELECT * FROM task_work_episode_bindings WHERE task_id = ?`)
    .get(taskId) as unknown as TaskWorkEpisodeRow | undefined;
  return row ? taskWorkEpisodeFromRow(row) : null;
}

export function historicalTaskWorkEpisodeBindings(): TaskWorkEpisodeBinding[] {
  const rows = openDb()
    .prepare(`SELECT * FROM historical_task_work_episode_bindings ORDER BY updated_at DESC`)
    .all() as unknown as TaskWorkEpisodeRow[];
  return rows.map(taskWorkEpisodeFromRow);
}

export function historicalTaskWorkEpisodeBindingsForTask(
  taskId: string,
): TaskWorkEpisodeBinding[] {
  const rows = openDb()
    .prepare(
      `SELECT * FROM historical_task_work_episode_bindings
       WHERE task_id = ? ORDER BY bound_at DESC`,
    )
    .all(taskId) as unknown as TaskWorkEpisodeRow[];
  return rows.map(taskWorkEpisodeFromRow);
}

export function deleteHistoricalTaskWorkEpisodeBinding(
  taskId: string,
  episodeId: string,
): void {
  openDb()
    .prepare(
      `DELETE FROM historical_task_work_episode_bindings
       WHERE task_id = ? AND episode_id = ?`,
    )
    .run(taskId, episodeId);
}

export function updateWorkEpisodePr(
  sessionId: string,
  episodeId: string,
  branch: string,
  prUrl: string,
  prHeadSha: string | null,
  now: number,
): boolean {
  const d = openDb();
  const result = d
    .prepare(
      `UPDATE session_work_episodes
       SET branch = ?, pr_url = ?, pr_head_sha = ?, updated_at = ?
       WHERE session_id = ? AND episode_id = ? AND (pr_url IS NULL OR pr_url = ?)`,
    )
    .run(branch, prUrl, prHeadSha, now, sessionId, episodeId, prUrl);
  if (Number(result.changes) === 0) return false;
  d.prepare(
    `UPDATE task_work_episode_bindings
     SET branch = ?, pr_url = ?, pr_head_sha = ?, updated_at = ?
     WHERE session_id = ? AND episode_id = ? AND (pr_url IS NULL OR pr_url = ?)`,
  ).run(branch, prUrl, prHeadSha, now, sessionId, episodeId, prUrl);
  return true;
}

/** One secondary repository's pull request on one work episode. */
export interface WorkEpisodeRepoPr {
  episodeId: string;
  repoRoot: string;
  sessionId: string;
  taskId: string | null;
  prUrl: string;
  prState: string | null;
  prHeadSha: string | null;
  mergedAt: number | null;
  updatedAt: number;
}

interface WorkEpisodeRepoPrRow {
  episode_id: string;
  repo_root: string;
  session_id: string;
  task_id: string | null;
  pr_url: string;
  pr_state: string | null;
  pr_head_sha: string | null;
  merged_at: number | null;
  updated_at: number;
}

function rowToWorkEpisodeRepoPr(r: WorkEpisodeRepoPrRow): WorkEpisodeRepoPr {
  return {
    episodeId: r.episode_id,
    repoRoot: r.repo_root,
    sessionId: r.session_id,
    taskId: r.task_id,
    prUrl: r.pr_url,
    prState: r.pr_state,
    prHeadSha: r.pr_head_sha,
    mergedAt: r.merged_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Associate a pull request with one SECONDARY repository of a work episode.
 *
 * The per-repo twin of `updateWorkEpisodePr`, refusal guard included and for the same
 * reason: within one episode a repository holds at most one pull request, so a SECOND,
 * different URL arriving for a repo that already has one is refused rather than
 * overwriting - `false` back to the caller, which then declines to treat it as this
 * episode's deliverable. The same URL arriving again is an update (state and head move as
 * the poller re-observes it), which is what the `WHERE pr_url = excluded.pr_url` clause
 * says: conflict on the key, proceed only if it is the same pull request.
 *
 * Nothing writes the PRIMARY repo's URL here. That lives on `session_work_episodes.pr_url`
 * and the binding rows that mirror it, and one owner per repo is what keeps the two tables
 * from disagreeing about the same pull request.
 */
export function recordWorkEpisodeRepoPr(
  entry: Omit<WorkEpisodeRepoPr, "mergedAt" | "updatedAt">,
  now: number,
): boolean {
  const result = openDb()
    .prepare(
      `INSERT INTO work_episode_prs
         (episode_id, repo_root, session_id, task_id, pr_url, pr_state, pr_head_sha,
          merged_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT(episode_id, repo_root) DO UPDATE SET
         session_id  = excluded.session_id,
         task_id     = COALESCE(excluded.task_id, work_episode_prs.task_id),
         pr_state    = excluded.pr_state,
         pr_head_sha = excluded.pr_head_sha,
         updated_at  = excluded.updated_at
       WHERE work_episode_prs.pr_url = excluded.pr_url`,
    )
    .run(
      entry.episodeId,
      entry.repoRoot,
      entry.sessionId,
      entry.taskId,
      entry.prUrl,
      entry.prState,
      entry.prHeadSha,
      now,
    );
  return Number(result.changes) > 0;
}

/** Every secondary-repo pull request recorded against a task, newest write first. */
export function workEpisodeRepoPrsForTask(taskId: string): WorkEpisodeRepoPr[] {
  const rows = openDb()
    .prepare(
      `SELECT * FROM work_episode_prs WHERE task_id = ? ORDER BY updated_at DESC`,
    )
    .all(taskId) as unknown as WorkEpisodeRepoPrRow[];
  return rows.map(rowToWorkEpisodeRepoPr);
}

/**
 * Every secondary-repo pull request, grouped by task.
 *
 * One read for the whole table, exactly as `taskReposByTask` reads all of `task_repos`: the
 * table is empty on a single-repo install and small on any other, so a per-task statement
 * behind every card would cost far more than reading it whole.
 */
export function workEpisodeRepoPrsByTask(): Map<string, WorkEpisodeRepoPr[]> {
  const rows = openDb()
    .prepare(
      `SELECT * FROM work_episode_prs WHERE task_id IS NOT NULL ORDER BY updated_at DESC`,
    )
    .all() as unknown as WorkEpisodeRepoPrRow[];
  const out = new Map<string, WorkEpisodeRepoPr[]>();
  for (const row of rows) {
    const entry = rowToWorkEpisodeRepoPr(row);
    const list = out.get(row.task_id as string);
    if (list) list.push(entry);
    else out.set(row.task_id as string, [entry]);
  }
  return out;
}

/** The secondary-repo pull request one episode holds for one repository, if any. */
export function workEpisodeRepoPr(
  episodeId: string,
  repoRoot: string,
): WorkEpisodeRepoPr | null {
  const row = openDb()
    .prepare(`SELECT * FROM work_episode_prs WHERE episode_id = ? AND repo_root = ?`)
    .get(episodeId, repoRoot) as unknown as WorkEpisodeRepoPrRow | undefined;
  return row ? rowToWorkEpisodeRepoPr(row) : null;
}

/** One repository's pull request on a task, in the shape every per-repo surface reads. */
export interface TaskRepoPrRecord {
  prUrl: string | null;
  prState: string | null;
  mergedAt: number | null;
}

/**
 * The PRIMARY repository's pull request on a task, read from the same bindings
 * `mergedPrFor` reads.
 *
 * The primary has no `work_episode_prs` row - its pull request lives on the episode scalar
 * and the binding rows that mirror it - so this is where a per-repo reader gets it, and it
 * is why nothing may build a repo list by iterating `task_repos` alone.
 *
 * Two passes, and the asymmetry between them is the whole rule.
 *
 * A MERGED pull request counts from ANY of the task's episodes, current or rolled-off, for
 * the reason `mergedPrFor` gives: a merge on an episode the task has already rolled past is
 * still the outcome, and the newest one wins among several.
 *
 * An UNMERGED one counts only from the CURRENT episode. A rolled-off episode's open pull
 * request is work this task walked away from - the agent restarted, cut a new branch, and the
 * poller's branch-based re-association will never re-attach the old one - so reporting it as
 * what the primary repo holds is wrong twice over: the card names a pull request nobody is
 * working on, and the completion quorum says the task is waiting for a url that is never
 * going to move. "No pull request opened here yet" is the true answer in that window, and
 * the quorum then decides the primary's membership from its head against its baseline, which
 * is the clause that exists for exactly this - changes with no live pull request.
 *
 * `prState` is derived rather than stored: a binding exists only for a pull request this
 * task opened, and the only transition the daemon records against it is the merge. A pull
 * request closed unmerged therefore still reads `open` here, which is the same thing the
 * session chip does with one - the poller simply stops reporting it.
 */
export function primaryRepoPrForTask(taskId: string): TaskRepoPrRecord {
  const current = taskWorkEpisodeForTask(taskId);
  let merged: TaskWorkEpisodeBinding | null = null;
  for (const binding of [
    ...(current ? [current] : []),
    ...historicalTaskWorkEpisodeBindingsForTask(taskId),
  ]) {
    if (binding.prUrl === null || binding.mergedAt === null) continue;
    if (merged === null || binding.mergedAt > (merged.mergedAt ?? 0)) merged = binding;
  }
  if (merged !== null) {
    return { prUrl: merged.prUrl, prState: "merged", mergedAt: merged.mergedAt };
  }
  if (current?.prUrl) return { prUrl: current.prUrl, prState: "open", mergedAt: null };
  return { prUrl: null, prState: null, mergedAt: null };
}

export function recordWorkEpisodePrompt(
  sessionId: string,
  episodeId: string,
  promptedAt: number,
): boolean {
  const d = openDb();
  const ownsTransaction = !d.isTransaction;
  if (ownsTransaction) d.exec("BEGIN IMMEDIATE");
  try {
    const result = d.prepare(
      `UPDATE session_work_episodes
       SET prompted_at = MAX(COALESCE(prompted_at, 0), ?), updated_at = MAX(updated_at, ?)
       WHERE session_id = ? AND episode_id = ?`,
    ).run(promptedAt, promptedAt, sessionId, episodeId);
    if (Number(result.changes) > 0) {
      d.prepare(
        `INSERT OR IGNORE INTO session_work_episode_prompts
           (session_id, episode_id, prompted_at)
         VALUES (?, ?, ?)`,
      ).run(sessionId, episodeId, promptedAt);
    }
    if (ownsTransaction) d.exec("COMMIT");
    return Number(result.changes) > 0;
  } catch (error) {
    if (ownsTransaction && d.isTransaction) d.exec("ROLLBACK");
    throw error;
  }
}

export function firstWorkEpisodePromptAfter(
  sessionId: string,
  episodeId: string,
  after: number,
): number | null {
  const row = openDb()
    .prepare(
      `SELECT prompted_at FROM session_work_episode_prompts
       WHERE session_id = ? AND episode_id = ? AND prompted_at > ?
       ORDER BY prompted_at ASC
       LIMIT 1`,
    )
    .get(sessionId, episodeId, after) as { prompted_at: number } | undefined;
  return row?.prompted_at ?? null;
}

export function markWorkEpisodeMerged(
  sessionId: string,
  episodeId: string,
  prUrl: string,
  now: number,
): boolean {
  const d = openDb();
  const ownsTransaction = !d.isTransaction;
  if (ownsTransaction) d.exec("BEGIN IMMEDIATE");
  try {
    const session = d
      .prepare(
        `UPDATE session_work_episodes
         SET merged_at = COALESCE(merged_at, ?), updated_at = MAX(updated_at, ?)
         WHERE session_id = ? AND episode_id = ? AND pr_url = ?`,
      )
      .run(now, now, sessionId, episodeId, prUrl);
    const binding = d
      .prepare(
        `UPDATE task_work_episode_bindings
         SET merged_at = COALESCE(merged_at, ?), updated_at = MAX(updated_at, ?)
         WHERE session_id = ? AND episode_id = ? AND pr_url = ?`,
      )
      .run(now, now, sessionId, episodeId, prUrl);
    // The SAME stamp over the historical row, in this one transaction. A binding that
    // rolled to a new episode before the merge was seen keeps its provenance ONLY here -
    // the current binding was overwritten with the new episode, and session_work_episodes
    // followed it - so a by-URL merge observed for that old episode (Phase 2's harvest)
    // would land nowhere durable without this. `mergedAt` is COALESCEd so an id that
    // already recorded the merge is never restamped. No column check is needed:
    // `merged_at` has been in this table's CREATE block since it shipped (#167).
    const historical = d
      .prepare(
        `UPDATE historical_task_work_episode_bindings
         SET merged_at = COALESCE(merged_at, ?), updated_at = MAX(updated_at, ?)
         WHERE session_id = ? AND episode_id = ? AND pr_url = ?`,
      )
      .run(now, now, sessionId, episodeId, prUrl);
    // And the SECONDARY repositories' row for the same episode, in the same transaction and
    // on the same key. A url either belongs to the primary (the three statements above) or
    // to exactly one secondary (this one), never both - one owner per repo - so this is a
    // fourth place the same merge can land rather than a second copy of the same fact.
    const repo = d
      .prepare(
        `UPDATE work_episode_prs
         SET merged_at = COALESCE(merged_at, ?), pr_state = 'merged', updated_at = MAX(updated_at, ?)
         WHERE session_id = ? AND episode_id = ? AND pr_url = ?`,
      )
      .run(now, now, sessionId, episodeId, prUrl);
    if (ownsTransaction) d.exec("COMMIT");
    return (
      Number(session.changes) > 0 ||
      Number(binding.changes) > 0 ||
      Number(historical.changes) > 0 ||
      Number(repo.changes) > 0
    );
  } catch (error) {
    if (ownsTransaction && d.isTransaction) d.exec("ROLLBACK");
    throw error;
  }
}

export function invalidateTaskWorkEpisodeBindings(sessionId: string): string[] {
  const d = openDb();
  const ownsTransaction = !d.isTransaction;
  if (ownsTransaction) d.exec("BEGIN IMMEDIATE");
  try {
    const taskIds = invalidateTaskOwnershipInTransaction(d, sessionId, Date.now());
    if (ownsTransaction) d.exec("COMMIT");
    return taskIds;
  } catch (error) {
    if (ownsTransaction && d.isTransaction) d.exec("ROLLBACK");
    throw error;
  }
}

export function deleteTask(id: string): void {
  const d = openDb();
  d.prepare(`DELETE FROM task_repos WHERE task_id = ?`).run(id);
  d.prepare(`DELETE FROM work_episode_prs WHERE task_id = ?`).run(id);
  d.prepare(`DELETE FROM task_work_episode_bindings WHERE task_id = ?`).run(id);
  d.prepare(`DELETE FROM historical_task_work_episode_bindings WHERE task_id = ?`).run(id);
  d.prepare(`DELETE FROM tasks WHERE id = ?`).run(id);
}

export function listTasks(): Task[] {
  const rows = openDb()
    .prepare(`SELECT * FROM tasks ORDER BY created_at DESC`)
    .all() as unknown as TaskRow[];
  return rowsToTasks(rows);
}

/** Tasks still in flight (backlog/dispatching/running) - reloaded into the registry on start. */
export function loadActiveTasks(): Task[] {
  const rows = openDb()
    .prepare(
      `SELECT * FROM tasks WHERE status IN ('backlog','dispatching','running') ORDER BY created_at ASC`,
    )
    .all() as unknown as TaskRow[];
  return rowsToTasks(rows);
}

/**
 * The most recent terminal tasks (done/failed/cancelled), so the roundup report's
 * "recent outcomes" survives a daemon restart instead of vanishing even though
 * the row is still stored. Bounded so a long-lived history doesn't bloat memory.
 */
export function loadRecentTerminalTasks(limit: number): Task[] {
  const rows = openDb()
    .prepare(
      `SELECT * FROM tasks WHERE status IN ('done','failed','cancelled')
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(limit) as unknown as TaskRow[];
  return rowsToTasks(rows);
}

/**
 * Terminal tasks that still hold resources (a task awaiting reclaim, or a
 * failed-but-alive dispatch). Loaded regardless of the recent cap so their live
 * resources are always reconciled on start rather than orphaned once newer terminal
 * tasks push them past the cap.
 */
export function loadResourceHoldingTerminalTasks(): Task[] {
  const rows = openDb()
    .prepare(
       `SELECT * FROM tasks
       WHERE status IN ('done','failed','cancelled')
         AND (worktree_path IS NOT NULL OR home_name IS NOT NULL)`,
    )
    .all() as unknown as TaskRow[];
  return rowsToTasks(rows);
}

/**
 * Terminal tasks a merged pull request could still complete: `failed` or `cancelled`,
 * carrying a pull request on some work episode of theirs.
 *
 * The same argument as `loadResourceHoldingTerminalTasks` above, about a different kind of
 * loose end. That one keeps a task whose RESOURCES still need reconciling; this one keeps a
 * task whose OUTCOME does. A reclaimed `failed` row holds no worktree, so once fifty newer
 * terminal tasks exist it is not loaded at all - and then nothing polls the pull request it
 * left behind, nothing observes the merge, and it stays a `stopped` blocker over every
 * dependent for work that shipped. `running` and `dispatching` candidates need no query of
 * their own: `loadActiveTasks` already loads every one of them.
 *
 * Both binding tables, because a merge can land on an episode the task rolled past long
 * before anyone looked. `done` is excluded (its outcome is recorded) and so is `backlog`
 * (a rescheduled task is being re-run, so its previous attempt's pull request is not this
 * run's outcome) - the same rule `completableByMerge` states for the harvest itself.
 */
export function loadPrPendingTerminalTasks(): Task[] {
  const rows = openDb()
    .prepare(
      `SELECT * FROM tasks t
       WHERE t.status IN ('failed','cancelled')
         AND EXISTS (
           SELECT 1 FROM task_work_episode_bindings b
           WHERE b.task_id = t.id AND b.pr_url IS NOT NULL
           UNION ALL
           SELECT 1 FROM historical_task_work_episode_bindings h
           WHERE h.task_id = t.id AND h.pr_url IS NOT NULL
         )`,
    )
    .all() as unknown as TaskRow[];
  return rowsToTasks(rows);
}

/**
 * Does this task carry a pull request on any of its work episodes?
 *
 * What `pruneTerminalTasks` asks before dropping a terminal row from memory: a task with an
 * unresolved pull request is one the completion reconciler is still waiting on, so evicting
 * it would silently stop the polling that was going to settle it - undoing the load above
 * on the very next terminal task to arrive.
 */
export function taskHasPrCarryingBinding(taskId: string): boolean {
  const row = openDb()
    .prepare(
      `SELECT 1 AS present FROM task_work_episode_bindings
       WHERE task_id = ? AND pr_url IS NOT NULL
       UNION ALL
       SELECT 1 AS present FROM historical_task_work_episode_bindings
       WHERE task_id = ? AND pr_url IS NOT NULL
       LIMIT 1`,
    )
    .get(taskId, taskId) as { present: number } | undefined;
  return row !== undefined;
}

// ---- task sources: what has already been filed ----
//
// Read the `task_source_seen` CREATE TABLE above before touching any of this. The one
// rule: a seen row outlives the task it produced, so nothing here consults `tasks`.

/**
 * Every external id this source has already filed, as one set.
 *
 * Read whole rather than probed per candidate, for the reason `getSkillsAcks` is: it
 * keeps the dedupe in `ingest.ts` a pure decision over data the caller already holds,
 * with no I/O in the middle of the loop. One source's set is a handful of short strings
 * per item it has ever filed.
 */
export function seenExternalIds(sourceId: string): Set<string> {
  const rows = openDb()
    .prepare(`SELECT external_id FROM task_source_seen WHERE source_id = ?`)
    .all(sourceId) as unknown as Array<{ external_id: string }>;
  return new Set(rows.map((r) => r.external_id));
}

/** How many items this source has filed and will not file again - the panel's figure. */
export function countTaskSourceSeen(sourceId: string): number {
  const row = openDb()
    .prepare(`SELECT COUNT(*) AS n FROM task_source_seen WHERE source_id = ?`)
    .get(sourceId) as { n: number } | undefined;
  return row?.n ?? 0;
}

/**
 * Record that this source has filed this item.
 *
 * Upserts rather than inserts, so a re-file after "Forget seen items" cannot fail on a
 * row a concurrent sweep had already put back.
 */
export function recordTaskSourceSeen(
  sourceId: string,
  externalId: string,
  url: string | null,
  now = Date.now(),
): void {
  openDb()
    .prepare(
      `INSERT INTO task_source_seen (source_id, external_id, url, seen_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(source_id, external_id) DO UPDATE SET url=excluded.url, seen_at=excluded.seen_at`,
    )
    .run(sourceId, externalId, url, now);
}

/**
 * Forget everything one source has filed, so its items can be filed again. The
 * deliberate act that answers "a task you deleted stays deleted" - the only way back.
 *
 * Also what retires a source's rows when it is removed from the config: without that,
 * deleting and re-adding a source under the SAME id would file nothing at all, forever.
 */
export function forgetTaskSourceSeen(sourceId: string): number {
  const before = countTaskSourceSeen(sourceId);
  openDb().prepare(`DELETE FROM task_source_seen WHERE source_id = ?`).run(sourceId);
  return before;
}

/**
 * Run `fn` inside one SQLite transaction, rolling back if it throws.
 *
 * Written for ingest, where the seen row and the task row have to land together: a task
 * with no seen row is re-filed on every sweep forever, and a seen row with no task is an
 * item silently swallowed. Neither is fixed by retrying, so they are not allowed to
 * happen separately.
 */
export function inTransaction<T>(fn: () => T): T {
  const d = openDb();
  d.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    d.exec("COMMIT");
    return out;
  } catch (err) {
    // Guarded like `reorderQueueItems`': if the BEGIN itself never took there is no
    // transaction to roll back, and an unguarded ROLLBACK throws over the original
    // error - which is the one the caller needs to see.
    try {
      d.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

// ---- Foreman session notes ----

interface SessionNoteRow {
  note_key: string;
  purpose: string | null;
  brief: string | null;
  recommendation: string | null;
  disposition: string;
  last_action: string | null;
  handled_marker: string | null;
  updated_at: number;
}

function rowToNote(r: SessionNoteRow): SessionNote {
  return {
    noteKey: r.note_key,
    purpose: r.purpose,
    brief: r.brief,
    recommendation: r.recommendation,
    disposition: r.disposition as NoteDisposition,
    lastAction: r.last_action,
    handledMarker: r.handled_marker,
    updatedAt: r.updated_at,
  };
}

export function upsertSessionNote(n: SessionNote): void {
  openDb()
    .prepare(
      `INSERT INTO session_notes (
         note_key, purpose, brief, recommendation, disposition, last_action, handled_marker, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(note_key) DO UPDATE SET
         purpose=excluded.purpose, brief=excluded.brief, recommendation=excluded.recommendation,
         disposition=excluded.disposition, last_action=excluded.last_action,
         handled_marker=excluded.handled_marker, updated_at=excluded.updated_at`,
    )
    .run(
      n.noteKey, n.purpose, n.brief, n.recommendation, n.disposition, n.lastAction,
      n.handledMarker, n.updatedAt,
    );
}

export function getSessionNote(noteKey: string): SessionNote | undefined {
  const r = openDb().prepare(`SELECT * FROM session_notes WHERE note_key = ?`).get(noteKey) as
    | unknown as SessionNoteRow | undefined;
  return r ? rowToNote(r) : undefined;
}

/** All notes, reloaded into the registry on start so Purpose survives a restart. */
export function loadSessionNotes(): SessionNote[] {
  const rows = openDb()
    .prepare(`SELECT * FROM session_notes ORDER BY updated_at DESC`)
    .all() as unknown as SessionNoteRow[];
  return rows.map(rowToNote);
}

// ---- session goals ----

interface SessionGoalRow {
  note_key: string;
  text: string | null;
  source: string | null;
  objective: string | null;
  prompt: string | null;
  focus: string | null;
  relationship: string | null;
  rationale: string | null;
  objective_version: number;
  prompt_revision: number;
  resolved_prompt_revision: number;
  pending_prompts: string;
  updated_at: number;
}

function pendingGoalPrompts(r: SessionGoalRow): SessionGoal["pendingPrompts"] {
  const promptRevision = r.prompt_revision || (r.prompt ? 1 : 0);
  const resolvedRevision =
    r.resolved_prompt_revision || (r.prompt && r.source === "model" ? 1 : 0);
  try {
    const parsed = JSON.parse(r.pending_prompts || "[]") as unknown;
    if (Array.isArray(parsed)) {
      const valid = parsed.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const revision = (entry as { revision?: unknown }).revision;
        const prompt = (entry as { prompt?: unknown }).prompt;
        return Number.isInteger(revision) && Number(revision) > 0 &&
          (typeof prompt === "string" || prompt === null)
          ? [{ revision: Number(revision), prompt }]
          : [];
      });
      const unresolved = valid
        .filter((entry) => entry.revision > resolvedRevision && entry.revision <= promptRevision)
        .sort((a, b) => a.revision - b.revision)
        .filter((entry, index, entries) => index === 0 || entry.revision !== entries[index - 1]!.revision);
      if (unresolved.length > 0) return unresolved;
    }
  } catch {
    // Fall through to the conservative legacy reconstruction below.
  }

  if (promptRevision <= resolvedRevision) return [];
  if (promptRevision === resolvedRevision + 1) {
    return [{ revision: promptRevision, prompt: r.prompt }];
  }
  // Older builds retained only the latest prompt. The missing earlier instruction cannot be
  // reconstructed safely, so preserve an unresolved barrier instead of allowing the latest
  // prompt to mark the whole gap complete against a potentially stale objective.
  return [
    { revision: resolvedRevision + 1, prompt: null },
    ...(r.prompt ? [{ revision: promptRevision, prompt: r.prompt }] : []),
  ];
}

function rowToGoal(r: SessionGoalRow): SessionGoal {
  return {
    noteKey: r.note_key,
    text: r.text,
    // Narrowed, not cast blind: a row written by a newer build (or hand-edited) could carry
    // a source this build doesn't know, and typing it as one we do would put an unrenderable
    // value on a card. An unknown source reads as "no source", which the UI handles already.
    source: r.source === "heuristic" || r.source === "model" ? r.source : null,
    objective: r.objective ?? r.text ?? r.prompt,
    prompt: r.prompt,
    focus: r.focus,
    relationship:
      r.relationship === "initial" || r.relationship === "steer" ||
        r.relationship === "amend" || r.relationship === "replace" ||
        r.relationship === "unclear"
        ? r.relationship
        : null,
    rationale: r.rationale,
    objectiveVersion: r.objective_version || (r.text || r.prompt ? 1 : 0),
    promptRevision: r.prompt_revision || (r.prompt ? 1 : 0),
    resolvedPromptRevision:
      r.resolved_prompt_revision || (r.prompt && r.source === "model" ? 1 : 0),
    pendingPrompts: pendingGoalPrompts(r),
    updatedAt: r.updated_at,
  };
}

export function upsertSessionGoal(g: SessionGoal): void {
  openDb()
    .prepare(
      `INSERT INTO session_goals
         (note_key, text, source, objective, prompt, focus, relationship, rationale,
          objective_version, prompt_revision, resolved_prompt_revision, pending_prompts, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(note_key) DO UPDATE SET
         text=excluded.text, source=excluded.source, objective=excluded.objective,
         prompt=excluded.prompt, focus=excluded.focus, relationship=excluded.relationship,
         rationale=excluded.rationale, objective_version=excluded.objective_version,
         prompt_revision=excluded.prompt_revision,
         resolved_prompt_revision=excluded.resolved_prompt_revision,
         pending_prompts=excluded.pending_prompts,
         updated_at=excluded.updated_at`,
    )
    .run(
      g.noteKey, g.text, g.source, g.objective, g.prompt, g.focus, g.relationship,
      g.rationale, g.objectiveVersion, g.promptRevision, g.resolvedPromptRevision,
      JSON.stringify(g.pendingPrompts), g.updatedAt,
    );
}

export function getSessionGoal(noteKey: string): SessionGoal | undefined {
  const r = openDb().prepare(`SELECT * FROM session_goals WHERE note_key = ?`).get(noteKey) as
    | unknown as SessionGoalRow | undefined;
  return r ? rowToGoal(r) : undefined;
}

/** All goals, reloaded into the registry on start so a card keeps its Goal across one. */
export function loadSessionGoals(): SessionGoal[] {
  const rows = openDb()
    .prepare(`SELECT * FROM session_goals ORDER BY updated_at DESC`)
    .all() as unknown as SessionGoalRow[];
  return rows.map(rowToGoal);
}

/**
 * Delete goals that belong to no live session and have gone stale. Returns how many went.
 *
 * The table needs this and `session_notes` does not, despite the identical shape: a note is
 * written only when Foreman inspects a session, whereas a goal row is written for every
 * instrumented session on every substantive prompt, and `loadSessionGoals` pulls all of them
 * into memory at boot. Every `/clear` rotates `noteKeyFor` and strands the old row for good,
 * so the orphans accumulate for as long as the daemon is used.
 *
 * BOTH conditions are load-bearing, and the live-key one is the safety property: a row whose
 * key still belongs to a session is never touched no matter how old it is, so a long-running
 * card cannot have the sentence deleted out from under it. Age alone would do exactly that.
 * `liveKeys` is `noteKeyFor` over the registry's live sessions.
 *
 * An EMPTY `liveKeys` means "liveness unknown", never "nothing is live", and so deletes
 * nothing. The distinction is the whole safety of the call: an empty set read as a fact turns
 * this into `WHERE updated_at < ?`, which is precisely the query the paragraph above says must
 * never run - and every caller is one await away from that state, because a daemon holds a
 * full goal table from `loadSessionGoals` before it has discovered a single session. Refusing
 * here costs one sweep on genuinely no sessions (there is nothing to strand anyway, and the
 * next hour retries); reading it as a fact costs a parked session its goal, permanently, since
 * only a new prompt rebuilds one.
 */
export function pruneSessionGoals(liveKeys: Iterable<string>, olderThan: number): number {
  const keys = [...new Set(liveKeys)];
  if (!keys.length) return 0;
  const placeholders = keys.map(() => "?").join(",");
  const r = openDb()
    .prepare(
      `DELETE FROM session_goals WHERE updated_at < ? AND note_key NOT IN (${placeholders})`,
    )
    .run(olderThan, ...keys);
  return Number(r.changes);
}

// ---- foreman invites (whether Foreman may act in a session) ----

/**
 * The persisted invite domain. `'withdrawn'` is the tombstone and never surfaces on
 * `Session.foremanInvite` - the registry resolves it to `null`. Append-only, like the
 * shared `FOREMAN_INVITES` tuple it extends.
 */
export type ForemanInviteSource = "dispatch" | "operator" | "withdrawn";

export interface ForemanInviteRow {
  noteKey: string;
  source: ForemanInviteSource;
  createdAt: number;
}

export function upsertForemanInvite(
  noteKey: string,
  source: ForemanInviteSource,
  now = Date.now(),
): void {
  openDb()
    .prepare(
      `INSERT INTO foreman_invites (note_key, source, created_at) VALUES (?, ?, ?)
       ON CONFLICT(note_key) DO UPDATE SET source=excluded.source, created_at=excluded.created_at`,
    )
    .run(noteKey, source, now);
}

/** Every source this build can read. See the change-contracts entry before extending. */
const KNOWN_FOREMAN_INVITE_SOURCES = new Set<string>(["dispatch", "operator", "withdrawn"]);

/**
 * Narrow a stored row to one this build can read, or undefined - REPORTING the drop
 * rather than guessing, the same rule `resolveDispatchRuntime` holds for a persisted
 * runtime. An unreadable source exists after a downgrade: a newer build widened the
 * CHECK (this build's own CREATE is a no-op on an existing table) and wrote a value
 * these types never named. Passing it through would put a raw string on
 * `Session.foremanInvite` and out over SSE as if it were a valid `ForemanInvite`;
 * narrowing to "no row" means the session resolves from its runtime alone. The row
 * itself is deliberately left in place - it belongs to the build that understands it.
 */
function readForemanInviteRow(r: {
  note_key: string;
  source: string;
  created_at: number;
}): ForemanInviteRow | undefined {
  if (!KNOWN_FOREMAN_INVITE_SOURCES.has(r.source)) {
    console.warn(
      `[db] ignoring the foreman invite for ${r.note_key}: ` +
        `unreadable source "${r.source}" (written by a newer build?)`,
    );
    return undefined;
  }
  return { noteKey: r.note_key, source: r.source as ForemanInviteSource, createdAt: r.created_at };
}

export function getForemanInvite(noteKey: string): ForemanInviteRow | undefined {
  const r = openDb()
    .prepare(`SELECT note_key, source, created_at FROM foreman_invites WHERE note_key = ?`)
    .get(noteKey) as unknown as
    | { note_key: string; source: string; created_at: number }
    | undefined;
  return r ? readForemanInviteRow(r) : undefined;
}

/** Restore-then-elevate's first half: dropping a tombstone lets implicit grants resume. */
export function deleteForemanInvite(noteKey: string): void {
  openDb().prepare(`DELETE FROM foreman_invites WHERE note_key = ?`).run(noteKey);
}

/** All READABLE invites, reloaded into the registry on start - the notes/goals boot pattern. */
export function loadForemanInvites(): ForemanInviteRow[] {
  const rows = openDb()
    .prepare(`SELECT note_key, source, created_at FROM foreman_invites`)
    .all() as unknown as Array<{ note_key: string; source: string; created_at: number }>;
  return rows.flatMap((r) => {
    const row = readForemanInviteRow(r);
    return row ? [row] : [];
  });
}

/**
 * Carry an invite across a note-key rotation - the binding of an agent session id, a
 * Pi launch rebind, or a reset - so a dispatched session does not silently lose Foreman
 * the moment its hooks land. `session_notes` and `session_goals` strand their rows on
 * rotation and live with it; an invite stranding is a policy change, not stale prose.
 *
 * Last-write-wins with the moved row's own `created_at`: the row followed the pane, and
 * a row already sitting under the target key is the same pane's earlier state.
 */
export function moveForemanInvite(fromKey: string, toKey: string): void {
  if (fromKey === toKey) return;
  const d = openDb();
  const row = getForemanInvite(fromKey);
  if (!row) return;
  d.exec("BEGIN IMMEDIATE");
  try {
    d.prepare(
      `INSERT INTO foreman_invites (note_key, source, created_at) VALUES (?, ?, ?)
       ON CONFLICT(note_key) DO UPDATE SET source=excluded.source, created_at=excluded.created_at`,
    ).run(toKey, row.source, row.createdAt);
    d.prepare(`DELETE FROM foreman_invites WHERE note_key = ?`).run(fromKey);
    d.exec("COMMIT");
  } catch (err) {
    if (d.isTransaction) d.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Delete invites that belong to no live session and have gone stale. Returns how many.
 *
 * The same shape and the same safety property as `pruneSessionGoals` above: a row whose
 * key still belongs to a session is never touched no matter how old, and an EMPTY
 * `liveKeys` means "liveness unknown", never "nothing is live", and so deletes nothing.
 */
export function pruneForemanInvites(liveKeys: Iterable<string>, olderThan: number): number {
  const keys = [...new Set(liveKeys)];
  if (!keys.length) return 0;
  const placeholders = keys.map(() => "?").join(",");
  const r = openDb()
    .prepare(
      `DELETE FROM foreman_invites WHERE created_at < ? AND note_key NOT IN (${placeholders})`,
    )
    .run(olderThan, ...keys);
  return Number(r.changes);
}

// ---- usage ledger (API-equivalent estimates and token usage) ----

/**
 * The columns an OTel datapoint may land in, keyed by the name the ingest uses.
 *
 * A WHITELIST, and the only reason `upsertUsageCell` can interpolate a column name into
 * SQL at all: the value is looked up here, never taken from the wire. A `type` attribute
 * the exporter invents tomorrow finds no entry and is dropped, which is the right answer
 * for a tier we cannot price into a column that does not exist.
 */
const USAGE_COLS = {
  costUsd: "cost_usd",
  input: "input",
  output: "output",
  cacheRead: "cache_read",
  cacheWrite: "cache_write",
} as const;
export type UsageCol = keyof typeof USAGE_COLS;

/** The identity of one export window, as the ingest resolves it. */
export interface UsageCell {
  noteKey: string;
  /** Provenance only - which live session we believed this key belonged to. */
  sessionId: string | null;
  agent: string;
  /** Empty string when the datapoint carried no such attribute; never null. See the table. */
  modelId: string;
  querySource: string;
  /** The datapoint's dedup identity, as text. Never parsed as a JS number. */
  windowEndNs: string;
  /** Window end in epoch ms, derived with BigInt division. */
  ts: number;
}

/**
 * Record one metric's value for one export window.
 *
 * REPLACE on conflict, never SUM, and the direction is the whole point. OTel delta
 * datapoints carry a unique `(start, end)` window, so a retried or duplicated POST
 * arrives with the same `window_end_ns` and overwrites the row with an identical value -
 * it cannot double-count. An additive upsert would double-count on exactly that retry,
 * which is the failure this is here to make impossible. The cumulative total is `SUM`
 * over rows at read time.
 *
 * One COLUMN at a time, because `cost.usage` and `token.usage` are separate metrics
 * sharing one window: each datapoint updates only its own column, which makes the writes
 * order-independent and lets a partial export (cost arrived, tokens didn't) still be
 * correct for what it carried.
 *
 * `ts` is also refreshed, so a cumulative series - whose rows are replaced rather than
 * accumulated - still reports the freshness of its LATEST export rather than of its first.
 */
export function upsertUsageCell(k: UsageCell, col: UsageCol, value: number): void {
  const c = USAGE_COLS[col];
  if (!c) throw new Error(`refusing to write an unknown usage column: ${String(col)}`);
  openDb()
    .prepare(
      `INSERT INTO usage_ledger
         (note_key, session_id, agent, model_id, query_source, window_end_ns, ts, writer, ${c})
       VALUES (?, ?, ?, ?, ?, ?, ?, 'otel', ?)
       ON CONFLICT(note_key, model_id, query_source, window_end_ns)
         DO UPDATE SET ${c} = excluded.${c},
                       ts = MAX(usage_ledger.ts, excluded.ts),
                       writer = excluded.writer,
                       session_id = COALESCE(excluded.session_id, usage_ledger.session_id)`,
    )
    .run(k.noteKey, k.sessionId, k.agent, k.modelId, k.querySource, k.windowEndNs, k.ts, value);
}

export interface UsageSourceCursor {
  offset: number;
  modelId: string | null;
  discardPartial: boolean;
  fileId: string | null;
}

export interface DurableUsageEvent {
  identity: string;
  ts: number;
  modelId: string | null;
  querySource: string;
  input: number;
  output: number;
  reasoningOutput: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number | null;
  pricingVersion: string;
}

/** Last committed byte position for a harness-owned usage stream. */
export function usageCursorFor(sourceKey: string): UsageSourceCursor {
  const row = openDb()
    .prepare(`SELECT offset, model_id, discard_partial, file_id FROM usage_sources WHERE source_key = ?`)
    .get(sourceKey) as { offset: number; model_id: string; discard_partial: number; file_id: string } | undefined;
  return row
    ? {
      offset: row.offset,
      modelId: row.model_id || null,
      discardPartial: row.discard_partial === 1,
      fileId: row.file_id || null,
    }
    : { offset: 0, modelId: null, discardPartial: false, fileId: null };
}

/** Keep an observed source's cursor alive without changing its committed byte position. */
export function touchUsageSource(sourceKey: string, observedAt: number): boolean {
  return openDb()
    .prepare(`UPDATE usage_sources SET updated_at = ? WHERE source_key = ?`)
    .run(observedAt, sourceKey).changes > 0;
}

/**
 * Commit request events and their new cursor atomically.
 *
 * Event identity is immutable economic history: a replay may fill missing live-session
 * provenance, but never recalculates tokens or dollars with a newer price snapshot.
 */
export function commitUsageRead(input: {
  sourceKey: string;
  noteKey: string;
  sessionId: string | null;
  agent: string;
  cursor: UsageSourceCursor;
  events: DurableUsageEvent[];
  updatedAt: number;
}): void {
  const d = openDb();
  const insert = d.prepare(
    `INSERT INTO usage_ledger
       (note_key, session_id, agent, model_id, query_source, window_end_ns, ts,
        cost_usd, cost_basis, cost_known, pricing_version, input, output,
        reasoning_output, cache_read, cache_write, writer)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'rollout')
     ON CONFLICT(note_key, model_id, query_source, window_end_ns)
       DO UPDATE SET session_id = COALESCE(usage_ledger.session_id, excluded.session_id)`,
  );
  try {
    d.exec("BEGIN IMMEDIATE;");
    for (const event of input.events) {
      insert.run(
        input.noteKey,
        input.sessionId,
        input.agent,
        event.modelId ?? "",
        event.querySource,
        event.identity,
        event.ts,
        event.costUsd ?? 0,
        event.costUsd === null ? "unpriced" : "api-equivalent",
        event.costUsd === null ? 0 : 1,
        event.pricingVersion,
        event.input,
        event.output,
        event.reasoningOutput,
        event.cacheRead,
        event.cacheWrite,
      );
    }
    d.prepare(
      `INSERT INTO usage_sources
         (source_key, agent, offset, model_id, discard_partial, file_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_key) DO UPDATE SET
         offset = excluded.offset,
         model_id = excluded.model_id,
         discard_partial = excluded.discard_partial,
         file_id = excluded.file_id,
         updated_at = excluded.updated_at`,
    ).run(
      input.sourceKey,
      input.agent,
      input.cursor.offset,
      input.cursor.modelId ?? "",
      input.cursor.discardPartial ? 1 : 0,
      input.cursor.fileId ?? "",
      input.updatedAt,
    );
    d.exec("COMMIT;");
  } catch (err) {
    try { d.exec("ROLLBACK;"); } catch {}
    throw err;
  }
}

/** One model's usage from a headless run, already valued by its runner. */
export interface AutomationUsageRow {
  modelId: string;
  input: number;
  output: number;
  reasoningOutput: number;
  cacheRead: number;
  cacheWrite: number;
  /** Null when the runner declined to value it; stored as cost_known = 0. */
  costUsd: number | null;
  basis: string;
  pricingVersion: string;
}

/**
 * Record one finished headless run: a row per model, keyed to the ROLE that spent it.
 *
 * `note_key` is the role rather than a session, which is the whole point - these runs have
 * no card, and until they had a key of their own their spend was either absent from the
 * ledger (Codex, which exports nothing from an ephemeral run) or present under a uuid
 * belonging to nothing (Claude, whose headless runs still export OTel under a fresh session
 * id). Either way it was unanswerable. A stable key per role makes "what does the Inspector
 * cost" a query.
 *
 * `session_id` is NULL by construction. The column is provenance - which live card we
 * believed the key belonged to - and asserting one here would be inventing the very link
 * this whole path exists because it does not exist.
 *
 * ON CONFLICT DO NOTHING, unlike `upsertUsageCell`'s replace and `commitUsageRead`'s
 * provenance fill. The conflict target is (note_key, model_id, query_source, window_end_ns)
 * and `window_end_ns` holds the RUN's own id, so a conflict means precisely "this exact run
 * was already recorded" - which happens when the Foreman worker retries a POST it never saw
 * the response to. The row is immutable economic history and the retry carries identical
 * numbers, so the correct action is to keep the first and add nothing.
 */
export function recordAutomationUsage(input: {
  role: string;
  agent: string;
  runId: string;
  ts: number;
  models: AutomationUsageRow[];
}): void {
  const d = openDb();
  const insert = d.prepare(
    `INSERT INTO usage_ledger
       (note_key, session_id, agent, model_id, query_source, window_end_ns, ts,
        cost_usd, cost_basis, cost_known, pricing_version, input, output,
        reasoning_output, cache_read, cache_write, spend_kind, writer)
     VALUES (?, NULL, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'automation', 'report')
     ON CONFLICT(note_key, model_id, query_source, window_end_ns) DO NOTHING`,
  );
  try {
    d.exec("BEGIN IMMEDIATE;");
    for (const m of input.models) {
      insert.run(
        input.role,
        input.agent,
        m.modelId,
        input.runId,
        input.ts,
        m.costUsd ?? 0,
        m.costUsd === null ? "unpriced" : m.basis,
        m.costUsd === null ? 0 : 1,
        m.pricingVersion,
        m.input,
        m.output,
        m.reasoningOutput,
        m.cacheRead,
        m.cacheWrite,
      );
    }
    d.exec("COMMIT;");
  } catch (err) {
    try { d.exec("ROLLBACK;"); } catch {}
    throw err;
  }
}

/**
 * Record one driven turn's usage: a row per model, keyed to the card that spent it.
 *
 * The third ledger writer, and the one that makes Claude session spend not depend on an
 * exporter. `recordAutomationUsage` reads a headless run's envelope; this reads the SAME
 * envelope off a supervised session's `result` frame. The difference is only what the row is
 * keyed to - a role there, a real note key here - so a card's chip and the fleet total both
 * find it through the queries they already use.
 *
 * `window_end_ns` holds the TURN's own uuid, exactly as an automation row holds the run's.
 * That is what makes ON CONFLICT DO NOTHING correct rather than lossy: a conflict means "this
 * turn is already recorded", which happens when a driver re-emits a `result` it already
 * reported - a resumed stream replaying its tail, a supervisor reconnecting. The numbers are
 * identical and the row is immutable economic history, so keeping the first is the answer.
 *
 * `cost_basis` is 'reported' and `pricing_version` is empty because Claude Code priced this
 * itself, from rates the account has and this repo does not. Same provenance as an OTel row,
 * because it is the same arithmetic by the same CLI - only the transport differs, and the
 * transport is what was broken.
 */
export function recordDriverSessionUsage(input: {
  noteKey: string;
  sessionId: string | null;
  agent: string;
  turnId: string;
  ts: number;
  models: readonly {
    modelId: string;
    input: number;
    output: number;
    reasoningOutput: number;
    cacheRead: number;
    cacheWrite: number;
    reportedCostUsd: number | null;
  }[];
}): void {
  if (input.models.length === 0) return;
  const d = openDb();
  const insert = d.prepare(
    `INSERT INTO usage_ledger
       (note_key, session_id, agent, model_id, query_source, window_end_ns, ts,
        cost_usd, cost_basis, cost_known, pricing_version, input, output,
        reasoning_output, cache_read, cache_write, spend_kind, writer)
     VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, 'session', 'driver')
     ON CONFLICT(note_key, model_id, query_source, window_end_ns) DO NOTHING`,
  );
  try {
    d.exec("BEGIN IMMEDIATE;");
    for (const m of input.models) {
      insert.run(
        input.noteKey,
        input.sessionId,
        input.agent,
        m.modelId,
        input.turnId,
        input.ts,
        m.reportedCostUsd ?? 0,
        m.reportedCostUsd === null ? "unpriced" : "reported",
        m.reportedCostUsd === null ? 0 : 1,
        m.input,
        m.output,
        m.reasoningOutput,
        m.cacheRead,
        m.cacheWrite,
      );
    }
    d.exec("COMMIT;");
  } catch (err) {
    try { d.exec("ROLLBACK;"); } catch {}
    throw err;
  }
}

/**
 * Whether this note key's spend is already owned by a session's DRIVER.
 *
 * The guard that keeps one writer per note key now that Claude has two candidates. A driven
 * session's subprocess is ordinary Claude Code, so it exports OTel for the same turns its
 * driver already reported; without this, both land and the card reads double.
 *
 * Durable rather than a walk over live sessions, and that is the load-bearing part: OTel
 * arrives on an export interval, so a datapoint routinely lands AFTER the session it belongs
 * to has exited and left the live map. A liveness test would admit exactly those late
 * datapoints and double-count the end of every driven session.
 *
 * TWO clauses, because neither is airtight alone and they fail at opposite ends of a session:
 *
 *   1. The key belongs to a driven session (`sdk_sessions`). This is what covers the FIRST
 *      turn, where no driver row exists yet: the supervisor records the binding when the
 *      driver binds, on the `init` frame, long before a turn completes. Matches `id` as well
 *      as `agent_session_id` because `noteKeyFor` falls back to the session id until the
 *      binding lands, so an early turn's rows are keyed to `sdk:<uuid>`.
 *   2. The ledger already holds a driver row for the key. This covers the other end - a
 *      datapoint that lands after the session went quiet, or after a `/clear` rotation retired
 *      an `agent_session_id`.
 *
 * BOTH ARE BOUNDED IN TIME, and that bound is not tidiness - without it this guard silently
 * becomes the very bug it was added to prevent. A conversation driven through the Agent SDK can
 * later be continued as a plain terminal `claude --resume <id>`: a DISCOVERED session, with no
 * driver, whose note key is that same id. Neither table forgets - `sdk_sessions` rows are never
 * deleted and driver rows live for the ledger's 180 days - so an unbounded test would keep
 * dropping that session's datapoints for months, and the exporter is the ONLY party that can
 * ever report a discovered session's cost. Its spend would vanish permanently and silently,
 * which is exactly the failure this change exists to close, relocated one workflow sideways.
 *
 * The window only has to outlast the gap between a turn happening and its export arriving.
 * Exports are pushed on `exportIntervalMs`, capped at 60s by `COST_EXPORT_INTERVAL_MAX_MS`, and
 * stop entirely once the subprocess exits - so an hour is generous by orders of magnitude while
 * bounding the wrong-way cost to "a hand-off to a terminal in the same hour may lose up to an
 * hour of that session's export", instead of losing all of it forever.
 *
 * A turn STARTING refreshes `sdk_sessions.updated_at` - `setSdkSessionTurnInProgress` in
 * `src/server/sdk/store.ts`, called by the supervisor as it accepts the turn - which is what
 * keeps clause 1 true through a long turn whose own driver row does not exist yet.
 */
const DRIVER_OWNERSHIP_WINDOW_MS = 60 * 60 * 1000;

export function sdkOwnedNoteKey(noteKey: string, now = Date.now()): boolean {
  const since = now - DRIVER_OWNERSHIP_WINDOW_MS;
  const r = openDb()
    .prepare(
      `SELECT 1 AS x FROM sdk_sessions
         WHERE (agent_session_id = ? OR id = ?) AND updated_at >= ?
       UNION ALL
       SELECT 1 AS x FROM usage_ledger
         WHERE note_key = ? AND writer = 'driver' AND ts >= ?
       LIMIT 1`,
    )
    .get(noteKey, noteKey, since, noteKey, since) as { x: number } | undefined;
  return Boolean(r);
}

/** Where the last observed OTLP export is remembered, so a restart does not forget it. */
const OTEL_SEEN_KEY = "costOtelLastSeen";

/**
 * How often the last-seen stamp is actually persisted.
 *
 * Exports arrive every `exportIntervalMs` - 15s by default, per live session - so writing on
 * each one would turn a passive health signal into a steady stream of database writes for a
 * value nothing reads more than once every few seconds. A minute of granularity is far finer
 * than the staleness window that consumes it.
 */
const OTEL_SEEN_WRITE_THROTTLE_MS = 60_000;

/**
 * Remember that an attributable OTLP export ARRIVED, whatever became of its datapoints.
 *
 * Called from the ingest before any datapoint is filtered, and that position is the whole
 * point. The obvious implementation of "is the exporter working" is to look for rows it wrote,
 * and it is unsound here for two independent reasons:
 *
 *   - Rows are DROPPED for a driven session, deliberately, by `sdkOwnedNoteKey`. A fleet of
 *     embedded sessions with a perfectly healthy exporter writes no `otel` row at all, so a
 *     row test would report a broken exporter and the panel would cry wolf. (In practice
 *     headless automation twins land under un-owned keys and mask this, which is luck rather
 *     than design - it disappears the moment the loops are switched off.)
 *   - Rows are PRUNED at 180 days and, worse, an unbounded "has one ever existed" test never
 *     goes back to false. An exporter that worked and then silently stopped - exactly the
 *     failure this whole change exists to make visible - would keep reporting healthy for
 *     months while every terminal session read $0.
 *
 * Arrival is what the flag claims to measure, so arrival is what it measures.
 */
export function noteOtelExportSeen(now: number): void {
  const previous = getAppConfig<number>(OTEL_SEEN_KEY);
  // One comparison, two properties, and both are wanted. It throttles a rewrite that is sooner
  // than the granularity anything reads, AND it refuses to move the stamp BACKWARDS - a clock
  // that steps back must not be able to age a live exporter into looking dead.
  if (typeof previous === "number" && now - previous < OTEL_SEEN_WRITE_THROTTLE_MS) return;
  setAppConfig(OTEL_SEEN_KEY, now);
}

/** When an OTLP export was last observed arriving, or null if one never has. */
export function lastOtelExportSeenAt(): number | null {
  const stored = getAppConfig<number>(OTEL_SEEN_KEY);
  return typeof stored === "number" ? stored : null;
}

/**
 * Whether any CLAUDE session spend was recorded on or after `tsMs`.
 *
 * Pairs with the stamp above to answer "is the exporter silent while there is work to report".
 * Silence on its own proves nothing - a machine nobody has used since Friday has no exports
 * because it has no sessions, and warning about that would be noise that teaches an operator
 * to ignore the panel.
 *
 * `agent = 'claude'` is the whole point of the name, and leaving it out defeats the pairing it
 * exists to serve. Codex's rollout reader writes `spend_kind = 'session'` rows too, so an
 * unscoped test counts a fleet whose only recent work was CODEX as "active" - and since no
 * Claude session ran, no Claude export arrived either, so the panel would announce that Claude
 * Code's exporter is broken on a machine where it simply had nothing to report. That is the
 * exact false alarm the activity half was added to prevent, so the activity has to be measured
 * for the same harness whose exporter is being judged.
 *
 * The column is trustworthy for this: the OTel ingest writes `'claude'`, the driver writes the
 * session's own agent, and the rollout reader writes the source session's.
 */
export function hasClaudeSessionUsageSince(tsMs: number): boolean {
  const r = openDb()
    .prepare(
      `SELECT 1 AS x FROM usage_ledger
        WHERE ${SESSION_SPEND_ONLY} AND agent = 'claude' AND ts >= ? LIMIT 1`,
    )
    .get(tsMs) as { x: number } | undefined;
  return Boolean(r);
}

/**
 * The SQL predicate for "this row is a card's spend, not the app's own".
 *
 * Two clauses, and the second is the subtle one. Excluding automation rows is obvious. The
 * subquery excludes their TWINS: a headless `claude -p` run is Claude Code, so it exports
 * OTel exactly as a human's session does, under the fresh session id it minted for itself.
 * Those datapoints arrive with a real `session.id`, so `applyOtelMetrics` accepts them - as
 * it should, it cannot tell - and they land as ordinary session rows under a note key that
 * matches no card and never will. They were being counted as fleet session spend before
 * this existed; now that the same run is recorded properly under its role, counting them
 * too would bill it twice.
 *
 * Matching on `window_end_ns` is what makes this exact rather than a heuristic: an
 * automation row stores the run's own id there, and that id IS the note key its OTel twin
 * arrived under. No prefix guessing, no timing assumption - the twin can arrive before or
 * after the report, since this is resolved at read time.
 *
 * `sessionCostFor` applies the first clause only. A card cannot hold a role as its note key,
 * so the filter is belt-and-braces rather than load-bearing - but it makes "automation
 * spend never appears on a card" a property of the query instead of a property of what
 * callers happen to pass. The twin subquery is deliberately NOT added there: that is a
 * per-card read on a hot path, and a twin's note key is a uuid no session ever holds.
 */
const SESSION_SPEND_ONLY =
  `spend_kind = 'session'
     AND note_key NOT IN (SELECT window_end_ns FROM usage_ledger WHERE spend_kind = 'automation')`;

/** One role's headless spend over a window. */
export interface AutomationRoleSpend {
  role: string;
  costUsd: number | null;
  tokens: number;
  runs: number;
}

/**
 * What each role spent since `tsMs`, newest-heaviest first.
 *
 * Grouped by role rather than returned as one figure because the roles are the answerable
 * unit: "the loops cost $9 today" prompts no action, while "Foreman verify cost $6 of it"
 * points at the 106 KB prompt that did it. `runs` counts DISTINCT run ids rather than rows,
 * since a run that used two models writes two.
 *
 * Cost is null for a role whose window contains an unpriced row, on exactly the rule
 * `fleetEstimatedCostSince` uses: a subtotal of the priced rows would read as a total.
 */
export function automationSpendSince(tsMs: number): AutomationRoleSpend[] {
  const rows = openDb()
    .prepare(
      `SELECT note_key AS role,
              SUM(CASE WHEN cost_known = 1 THEN cost_usd ELSE 0 END) AS cost,
              SUM(CASE WHEN cost_known = 0 THEN 1 ELSE 0 END) AS unknown,
              SUM(input + output + cache_read + cache_write) AS tokens,
              COUNT(DISTINCT window_end_ns) AS runs
         FROM usage_ledger
        WHERE spend_kind = 'automation' AND ts >= ?
        GROUP BY note_key
        ORDER BY cost DESC, tokens DESC`,
    )
    .all(tsMs) as unknown as Array<{
      role: string; cost: number | null; unknown: number | null; tokens: number | null; runs: number;
    }>;
  return rows.map((r) => ({
    role: r.role,
    costUsd: (r.unknown ?? 0) > 0 ? null : (r.cost ?? 0),
    tokens: r.tokens ?? 0,
    runs: r.runs,
  }));
}

/**
 * One session's estimated API-equivalent cost, or null when the ledger has never heard
 * of its key.
 *
 * Null rather than a zeroed summary, deliberately: "we have not been told" and "it cost
 * nothing" are different claims, and only the first is ever true of a session with no
 * rows. A card that showed `$0.00` for an untracked session would be asserting the one
 * of the two that is false.
 *
 * The per-field `?? 0` is the same defence `episodesFor`'s row mapper takes: these rows
 * outlive the daemon that wrote them, so a column added later reads as absent on an old
 * row rather than as `undefined` arriving on the wire.
 */
export function sessionCostFor(noteKey: string): SessionCost | null {
  const rows = openDb()
    .prepare(
      `SELECT cost_basis, cost_known, cost_usd, input, output, reasoning_output,
              cache_read, cache_write, model_id, pricing_version, ts
         FROM usage_ledger WHERE note_key = ? AND spend_kind = 'session'`,
    )
    .all(noteKey) as unknown as Array<{
      cost_basis: string; cost_known: number; cost_usd: number; input: number; output: number;
      reasoning_output: number; cache_read: number; cache_write: number; model_id: string;
      pricing_version: string; ts: number;
    }>;
  if (!rows.length) return null;
  const bases = new Set(rows.map((r) => r.cost_basis));
  const mixed = bases.size !== 1;
  const rawBasis = mixed ? "unpriced" : rows[0]!.cost_basis;
  const basis: CostBasis = rawBasis === "reported" || rawBasis === "api-equivalent"
    ? rawBasis
    : "unpriced";
  const known = !mixed && rows.every((r) => r.cost_known === 1);
  return {
    costUsd: known ? rows.reduce((n, r) => n + r.cost_usd, 0) : null,
    basis: known ? basis : "unpriced",
    pricingModels: [...new Set(rows.map((r) => r.model_id).filter(Boolean))].sort(),
    pricingVersions: [...new Set(rows.map((r) => r.pricing_version).filter(Boolean))].sort(),
    input: rows.reduce((n, r) => n + r.input, 0),
    output: rows.reduce((n, r) => n + r.output, 0),
    reasoningOutput: rows.reduce((n, r) => n + r.reasoning_output, 0),
    cacheRead: rows.reduce((n, r) => n + r.cache_read, 0),
    cacheWrite: rows.reduce((n, r) => n + r.cache_write, 0),
    updatedAt: Math.max(...rows.map((r) => r.ts)),
  };
}

/**
 * Fleet-wide API-equivalent estimate since `tsMs`, regardless of who calculated it.
 *
 * Null when even one row is unpriced: returning the sum of known rows would present a
 * partial subtotal as the fleet's total. Zero remains the truthful answer for no rows.
 *
 * SESSION spend only. The autonomous loops' own runs are reported separately by
 * `automationSpendSince` and deliberately not folded in here: session cost is work an
 * operator asked for, and the loops are overhead they did not. Adding the two into one
 * headline would make the number that answers "what is my fleet costing me" move when
 * nobody asked for anything, and there would be no way to see which half had moved.
 */
export function fleetEstimatedCostSince(tsMs: number): number | null {
  const r = openDb()
    .prepare(
      `SELECT SUM(CASE WHEN cost_known = 1 THEN cost_usd ELSE 0 END) c,
              SUM(CASE WHEN cost_known = 0 THEN 1 ELSE 0 END) unknown
         FROM usage_ledger WHERE ts >= ? AND ${SESSION_SPEND_ONLY}`,
    )
    .get(tsMs) as { c: number | null; unknown: number | null } | undefined;
  if ((r?.unknown ?? 0) > 0) return null;
  return r?.c ?? 0;
}

/**
 * The same estimate over automation rows, as one figure for the strip's headline.
 *
 * Separate from the per-role breakdown because the strip asks a different question of it -
 * one number beside the fleet's - and because summing the breakdown in TypeScript would
 * have to re-derive the unpriced rule, which is the sort of duplication that eventually
 * disagrees.
 */
export function automationEstimatedCostSince(tsMs: number): number | null {
  const r = openDb()
    .prepare(
      `SELECT SUM(CASE WHEN cost_known = 1 THEN cost_usd ELSE 0 END) c,
              SUM(CASE WHEN cost_known = 0 THEN 1 ELSE 0 END) unknown
         FROM usage_ledger WHERE ts >= ? AND spend_kind = 'automation'`,
    )
    .get(tsMs) as { c: number | null; unknown: number | null } | undefined;
  if ((r?.unknown ?? 0) > 0) return null;
  return r?.c ?? 0;
}

/** Automation tokens since `tsMs`, every tier summed. The token twin of the figure above. */
export function automationTokensSince(tsMs: number): number {
  const r = openDb()
    .prepare(
      `SELECT SUM(input + output + cache_read + cache_write) t
         FROM usage_ledger WHERE ts >= ? AND spend_kind = 'automation'`,
    )
    .get(tsMs) as { t: number | null } | undefined;
  return r?.t ?? 0;
}

/**
 * Fleet-wide tokens since `tsMs`, every tier summed.
 *
 * A separate query from `fleetEstimatedCostSince` rather than one row carrying both, because the
 * two are asked at different times: cost is also read per session, and the strip is the
 * only caller that wants tokens. Two indexed scans of the same rows cost less than the
 * coupling.
 */
export function fleetTokensSince(tsMs: number): number {
  const r = openDb()
    .prepare(
      `SELECT SUM(input + output + cache_read + cache_write) t
         FROM usage_ledger WHERE ts >= ? AND ${SESSION_SPEND_ONLY}`,
    )
    .get(tsMs) as { t: number | null } | undefined;
  return r?.t ?? 0;
}

/**
 * How many pull requests we PROVED we opened since `tsMs`.
 *
 * `adopted_at` is the right column and the only one: a row exists here because a hook
 * caught the `gh pr create` hook, which is exactly the provenance rule the Inspector posts
 * under. Counting `inspector_prs` rows by
 * any other date - or counting `prUrl` off live sessions - would fold in pull requests we
 * merely stood next to.
 */
export function prsOpenedSince(tsMs: number): number {
  const r = openDb()
    .prepare(`SELECT COUNT(*) n FROM inspector_prs WHERE adopted_at >= ?`)
    .get(tsMs) as { n: number } | undefined;
  return r?.n ?? 0;
}

/** True when the ledger holds any reported or locally-derived usage row. */
export function usageLedgerHasRows(): boolean {
  const r = openDb().prepare(`SELECT 1 AS x FROM usage_ledger LIMIT 1`).get() as
    | { x: number }
    | undefined;
  return Boolean(r);
}

/** True only after Claude's reported session telemetry has arrived; Codex rows are automatic. */
export function reportedUsageLedgerHasRows(): boolean {
  const r = openDb()
    .prepare(
      `SELECT 1 AS x FROM usage_ledger
        WHERE cost_basis = 'reported' AND spend_kind = 'session' LIMIT 1`,
    )
    .get() as { x: number } | undefined;
  return Boolean(r);
}

/**
 * Age out ledger rows. Returns how many went.
 *
 * Pruned by AGE and nothing else because these are keyed to a session that will be
 * long gone, and the record becomes
 * interesting PRECISELY once it is - "what did last week cost?" is a question you ask
 * about finished work. Session-scoped pruning would delete the answer at the moment it
 * started to matter.
 */
export function pruneUsageLedger(cutoff: number): number {
  return Number(openDb().prepare(`DELETE FROM usage_ledger WHERE ts < ?`).run(cutoff).changes);
}

/** Cursor retention is independent of event retention and deliberately age-only. */
export function pruneUsageSources(cutoff: number): number {
  return Number(openDb().prepare(`DELETE FROM usage_sources WHERE updated_at < ?`).run(cutoff).changes);
}

// ---- Editable pending conversation turns ----

interface PendingTurnRow {
  id: string;
  note_key: string;
  seq: number;
  text: string;
  state: string;
  revision: number;
  created_at: number;
  updated_at: number;
  claimed_at: number | null;
  last_error: string | null;
}

const PENDING_TURN_STATE_SET = new Set<PendingTurnState>(["queued", "sending", "uncertain"]);

function rowToPendingTurn(row: PendingTurnRow): PendingTurn {
  const state = PENDING_TURN_STATE_SET.has(row.state as PendingTurnState)
    ? (row.state as PendingTurnState)
    : "uncertain";
  return {
    id: row.id,
    noteKey: row.note_key,
    seq: row.seq,
    text: row.text,
    state,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    claimedAt: row.claimed_at,
    lastError:
      state === "uncertain" && !PENDING_TURN_STATE_SET.has(row.state as PendingTurnState)
        ? `unrecognized pending-turn state: ${row.state}`
        : row.last_error,
  };
}

export function listPendingTurns(noteKey: string): PendingTurn[] {
  const rows = openDb()
    .prepare(`SELECT * FROM pending_turns WHERE note_key = ? ORDER BY seq ASC`)
    .all(noteKey) as unknown as PendingTurnRow[];
  return rows.map(rowToPendingTurn);
}

export function createPendingTurn(input: {
  id: string;
  noteKey: string;
  text: string;
  now: number;
}): PendingTurn {
  const d = openDb();
  d.exec("BEGIN IMMEDIATE");
  try {
    const row = d
      .prepare(`SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM pending_turns WHERE note_key = ?`)
      .get(input.noteKey) as unknown as { seq: number };
    d.prepare(
      `INSERT INTO pending_turns
         (id, note_key, seq, text, state, revision, created_at, updated_at, claimed_at, last_error)
       VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, NULL, NULL)`,
    ).run(input.id, input.noteKey, row.seq, input.text, input.now, input.now);
    d.exec("COMMIT");
    return {
      id: input.id,
      noteKey: input.noteKey,
      seq: row.seq,
      text: input.text,
      state: "queued",
      revision: 0,
      createdAt: input.now,
      updatedAt: input.now,
      claimedAt: null,
      lastError: null,
    };
  } catch (err) {
    try {
      d.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

/** Claim only the FIFO head, and only while no delivery for this conversation is unresolved. */
export function claimNextPendingTurn(noteKey: string, now: number): PendingTurn | null {
  const d = openDb();
  d.exec("BEGIN IMMEDIATE");
  try {
    const unresolved = d
      .prepare(
        `SELECT 1 AS present FROM pending_turns
          WHERE note_key = ? AND state <> 'queued' LIMIT 1`,
      )
      .get(noteKey) as unknown as { present: number } | undefined;
    if (unresolved) {
      d.exec("COMMIT");
      return null;
    }
    const row = d
      .prepare(
        `SELECT * FROM pending_turns
          WHERE note_key = ? AND state = 'queued' ORDER BY seq ASC LIMIT 1`,
      )
      .get(noteKey) as unknown as PendingTurnRow | undefined;
    if (!row) {
      d.exec("COMMIT");
      return null;
    }
    const changed = d
      .prepare(
        `UPDATE pending_turns
            SET state = 'sending', revision = revision + 1, updated_at = ?,
                claimed_at = ?, last_error = NULL
          WHERE id = ? AND state = 'queued' AND revision = ?`,
      )
      .run(now, now, row.id, row.revision).changes;
    if (changed !== 1) {
      d.exec("ROLLBACK");
      return null;
    }
    d.exec("COMMIT");
    return {
      ...rowToPendingTurn(row),
      state: "sending",
      revision: row.revision + 1,
      updatedAt: now,
      claimedAt: now,
      lastError: null,
    };
  } catch (err) {
    try {
      d.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

/** Move the newest still-editable row back to the composer. */
export function recallPendingTurn(
  noteKey: string,
  id: string,
  revision: number,
): PendingTurn | null {
  const d = openDb();
  d.exec("BEGIN IMMEDIATE");
  try {
    const newest = d
      .prepare(
        `SELECT * FROM pending_turns
          WHERE note_key = ? AND state = 'queued' ORDER BY seq DESC LIMIT 1`,
      )
      .get(noteKey) as unknown as PendingTurnRow | undefined;
    if (!newest || newest.id !== id || newest.revision !== revision) {
      d.exec("COMMIT");
      return null;
    }
    const changed = d
      .prepare(`DELETE FROM pending_turns WHERE id = ? AND state = 'queued' AND revision = ?`)
      .run(id, revision).changes;
    if (changed !== 1) {
      d.exec("ROLLBACK");
      return null;
    }
    d.exec("COMMIT");
    return rowToPendingTurn(newest);
  } catch (err) {
    try {
      d.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

function transitionPendingTurn(
  id: string,
  revision: number,
  from: PendingTurnState,
  to: PendingTurnState,
  now: number,
  lastError: string | null,
): PendingTurn | null {
  const d = openDb();
  const changed = d
    .prepare(
      `UPDATE pending_turns
          SET state = ?, revision = revision + 1, updated_at = ?,
              claimed_at = CASE WHEN ? = 'queued' THEN NULL ELSE claimed_at END,
              last_error = ?
        WHERE id = ? AND state = ? AND revision = ?`,
    )
    .run(to, now, to, lastError, id, from, revision).changes;
  if (changed !== 1) return null;
  const row = d.prepare(`SELECT * FROM pending_turns WHERE id = ?`).get(id) as
    | unknown as PendingTurnRow
    | undefined;
  return row ? rowToPendingTurn(row) : null;
}

export function releasePendingTurn(
  id: string,
  revision: number,
  error: string,
  now: number,
): PendingTurn | null {
  return transitionPendingTurn(id, revision, "sending", "queued", now, error);
}

export function markPendingTurnUncertain(
  id: string,
  revision: number,
  error: string,
  now: number,
): PendingTurn | null {
  return transitionPendingTurn(id, revision, "sending", "uncertain", now, error);
}

export function retryPendingTurn(
  id: string,
  revision: number,
  now: number,
): PendingTurn | null {
  return transitionPendingTurn(id, revision, "uncertain", "queued", now, null);
}

export function deleteClaimedPendingTurn(id: string, revision: number): boolean {
  return (
    openDb()
      .prepare(`DELETE FROM pending_turns WHERE id = ? AND state = 'sending' AND revision = ?`)
      .run(id, revision).changes === 1
  );
}

export function resolveUncertainPendingTurn(id: string, revision: number): boolean {
  return (
    openDb()
      .prepare(`DELETE FROM pending_turns WHERE id = ? AND state = 'uncertain' AND revision = ?`)
      .run(id, revision).changes === 1
  );
}

/**
 * Drop every still-editable row in one conversation's outbox, and nothing else.
 *
 * What an interrupt does to the queue, in SQL. `state = 'queued'` is the whole predicate
 * and the exclusions are the point: a `sending` row has already left for the harness, so
 * deleting it here would erase Mission Control's only record of a message that may be
 * mid-flight, and an `uncertain` row exists precisely because nobody knows whether it
 * landed - it is a question waiting for a human, and this is not the human answering it.
 *
 * Distinct from `clearPendingTurns`, which is reset's tool: that one empties the outbox and
 * takes an explicit preserve list, because reset is discarding the conversation those rows
 * were written for. An interrupt keeps the conversation.
 *
 * Returns how many rows went, so the caller can say so.
 */
export function dropQueuedPendingTurns(noteKey: string): number {
  return Number(
    openDb()
      .prepare(`DELETE FROM pending_turns WHERE note_key = ? AND state = 'queued'`)
      .run(noteKey).changes,
  );
}

export function clearPendingTurns(noteKey: string, preserveIds: readonly string[] = []): number {
  const d = openDb();
  if (preserveIds.length === 0) {
    return Number(d.prepare(`DELETE FROM pending_turns WHERE note_key = ?`).run(noteKey).changes);
  }
  const placeholders = preserveIds.map(() => "?").join(", ");
  return Number(
    d.prepare(
      `DELETE FROM pending_turns WHERE note_key = ? AND id NOT IN (${placeholders})`,
    ).run(noteKey, ...preserveIds).changes,
  );
}

/** Carry pre-binding outbox rows from a synthetic session id onto the real conversation. */
export function rekeyPendingTurns(fromKey: string, toKey: string, now: number): boolean {
  if (fromKey === toKey) return true;
  const d = openDb();
  d.exec("BEGIN IMMEDIATE");
  try {
    const source = d
      .prepare(`SELECT COUNT(*) AS n FROM pending_turns WHERE note_key = ?`)
      .get(fromKey) as unknown as { n: number };
    if (source.n === 0) {
      d.exec("COMMIT");
      return true;
    }
    const sending = d
      .prepare(
        `SELECT note_key FROM pending_turns
          WHERE note_key IN (?, ?) AND state = 'sending' GROUP BY note_key`,
      )
      .all(fromKey, toKey) as unknown as Array<{ note_key: string }>;
    if (sending.length > 1) {
      d.exec("COMMIT");
      return false;
    }
    const target = d
      .prepare(`SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM pending_turns WHERE note_key = ?`)
      .get(toKey) as unknown as { seq: number };
    d.prepare(
      `UPDATE pending_turns
          SET note_key = ?, seq = seq + ?, updated_at = ?
        WHERE note_key = ?`,
    ).run(toKey, target.seq, now, fromKey);
    d.exec("COMMIT");
    return true;
  } catch (err) {
    try {
      d.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

/** A daemon crash can leave delivery possible but unacknowledged, so never auto-resend it. */
export function recoverSendingPendingTurns(now: number): number {
  return Number(
    openDb()
      .prepare(
        `UPDATE pending_turns
            SET state = 'uncertain', revision = revision + 1, updated_at = ?,
                last_error = 'Mission Control restarted during delivery; confirm before retrying.'
          WHERE state = 'sending'`,
      )
      .run(now).changes,
  );
}

// ---- Foreman session work queues ----

interface QueueRow {
  note_key: string;
  cwd: string | null;
  branch: string | null;
  wrapup_asked_at: number | null;
  wrapup_answer: string | null;
  prompted_goal: string | null;
  updated_at: number;
}

/**
 * One row -> object mapping, for the four readers that need it.
 *
 * Spelled once because it was spelled four times, and a column added to the table
 * reached whichever copies its author happened to grep: a `prompted_goal` missing
 * from `listQueueRows` alone would leave the orphan sweep reading every queue as
 * never-wrapped-up, which is the state that FIRES the trigger.
 */
function toQueueRow(r: QueueRow): Omit<SessionQueue, "items"> {
  return {
    noteKey: r.note_key,
    cwd: r.cwd,
    branch: r.branch,
    wrapupAskedAt: r.wrapup_asked_at,
    wrapupAnswer: r.wrapup_answer,
    promptedGoal: r.prompted_goal,
    updatedAt: r.updated_at,
  };
}

interface QueueItemRow {
  id: string;
  note_key: string;
  seq: number;
  intent: string;
  state: string;
  round: number;
  base_sha: string | null;
  transcript_anchor: number | null;
  gaps: string | null;
  send_attempts: number;
  verify_failures: number;
  escalation_reason: string | null;
  last_verdict: string | null;
  approved_at: number | null;
  proposed_payload: string | null;
  recovered_at: number | null;
  revision: number;
  created_at: number;
  updated_at: number;
  sent_at: number | null;
  completed_at: number | null;
}

function rowToItem(r: QueueItemRow): WorkItem {
  return {
    id: r.id,
    noteKey: r.note_key,
    seq: r.seq,
    intent: r.intent,
    state: r.state as WorkItemState,
    round: r.round,
    baseSha: r.base_sha,
    transcriptAnchor: r.transcript_anchor,
    gaps: parseGaps(r.gaps),
    sendAttempts: r.send_attempts,
    verifyFailures: r.verify_failures,
    escalationReason: r.escalation_reason,
    lastVerdict: r.last_verdict,
    approvedAt: r.approved_at,
    proposedPayload: r.proposed_payload,
    recoveredAt: r.recovered_at,
    revision: r.revision,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    sentAt: r.sent_at,
    completedAt: r.completed_at,
  };
}

/** Corrupt/absent gap JSON reads as "no gaps" - never throws out of a row read. */
function parseGaps(raw: string | null): TrackedGap[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as TrackedGap[]) : [];
  } catch {
    return [];
  }
}

export function upsertQueue(q: Omit<SessionQueue, "items">): void {
  openDb()
    .prepare(
      `INSERT INTO foreman_queues
         (note_key, cwd, branch, wrapup_asked_at, wrapup_answer, prompted_goal, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(note_key) DO UPDATE SET
         cwd=excluded.cwd, branch=excluded.branch, wrapup_asked_at=excluded.wrapup_asked_at,
         wrapup_answer=excluded.wrapup_answer, prompted_goal=excluded.prompted_goal,
         updated_at=excluded.updated_at`,
    )
    .run(q.noteKey, q.cwd, q.branch, q.wrapupAskedAt, q.wrapupAnswer, q.promptedGoal, q.updatedAt);
}

export function getQueueRow(noteKey: string): Omit<SessionQueue, "items"> | undefined {
  const r = openDb().prepare(`SELECT * FROM foreman_queues WHERE note_key = ?`).get(noteKey) as
    | unknown as QueueRow | undefined;
  return r ? toQueueRow(r) : undefined;
}

/** Every stored queue (without items) - for the orphan sweep + the session list. */
export function listQueueRows(): Omit<SessionQueue, "items">[] {
  const rows = openDb()
    .prepare(`SELECT * FROM foreman_queues ORDER BY updated_at DESC`)
    .all() as unknown as QueueRow[];
  return rows.map(toQueueRow);
}

/** Queues recorded at one cwd - the re-attach hint's question, asked as a lookup. */
export function listQueueRowsForCwd(cwd: string): Omit<SessionQueue, "items">[] {
  const rows = openDb()
    .prepare(`SELECT * FROM foreman_queues WHERE cwd = ? ORDER BY updated_at DESC`)
    .all(cwd) as unknown as QueueRow[];
  return rows.map(toQueueRow);
}

/**
 * How many of a queue's items are still open, without loading any of them.
 *
 * The hint needs a count, and `listQueueItems` was hydrating every row - gaps JSON,
 * verdicts, drafted payloads and all - to take its length. The predicate is DERIVED
 * from TERMINAL_ITEM_STATES rather than restated, for the reason @shared/queue.ts
 * gives: a lifecycle state added without updating a hand-copied SQL list makes this
 * silently miscount. `state` is a closed enum of identifiers, so quoting them into
 * SQL is safe by construction (same argument as `inFlightIndexSql`).
 */
export function countOpenQueueItems(noteKey: string): number {
  const states = TERMINAL_ITEM_STATES.map((s) => `'${s}'`).join(",");
  const r = openDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM foreman_queue_items
        WHERE note_key = ? AND state NOT IN (${states})`,
    )
    .get(noteKey) as unknown as { n: number };
  return r.n;
}

/**
 * Age out queues nothing can reach any more. Returns how many rows went.
 *
 * Nothing pruned these before, so they accumulated for the DB's lifetime - and every
 * `/clear` mints a new note key, hence a new row, so the floor rose with use and
 * never came back down.
 *
 * Deliberately conservative about WHAT goes, because the failure mode on this side is
 * deleting a human's backlog:
 *  - a queue with ANY open item is untouchable at any age. That's precisely what the
 *    re-attach affordance exists to resume - the orphan sweep leaves `queued` items
 *    intact on purpose so a human can pick them up later, and a retention policy that
 *    ate them would be a bug wearing a safety hat.
 *  - a live session's queue is untouchable, whatever its items say: `liveKeys` is
 *    passed in rather than inferred from `updated_at`, because a drained queue on a
 *    session you are still sitting in is not garbage - it's the card's own history,
 *    and the wrap-up ask still hangs off that row.
 * So this only ever drops a fully-finished batch whose session is gone and which
 * nothing has touched since `cutoff`.
 *
 * The second branch collects rows that hold NOTHING - no items at all, and none of the
 * three wrap-up fields set - regardless of age. `ensureQueue` mints a row for any
 * session whose wrap-up state is merely touched, and the `prompted` trigger touches
 * every session it ever considers, so this is now the common shape of a row rather than
 * a rarity. Waiting out `cutoff` for a row with nothing in it buys no safety: there is
 * no backlog to resume, no ask to answer and no episode to keep retired, and if the
 * session comes back `ensureQueue` mints it again for free. The `liveKeys` guard still
 * applies to both branches, which is what keeps this away from the row a live session is
 * mid-write on - `ensureQueue` and the `promptedGoal` stamp that follows it are two
 * writes, and between them the row is legitimately empty.
 */
export function pruneDeadQueues(liveKeys: Set<string>, cutoff: number): number {
  const db = openDb();
  const states = TERMINAL_ITEM_STATES.map((s) => `'${s}'`).join(",");
  const dead = db
    .prepare(
      `SELECT note_key FROM foreman_queues q
        WHERE (
                q.updated_at < ?
                AND NOT EXISTS (
                  SELECT 1 FROM foreman_queue_items i
                   WHERE i.note_key = q.note_key AND i.state NOT IN (${states})
                )
              )
           OR (
                q.wrapup_asked_at IS NULL
                AND q.wrapup_answer IS NULL
                AND q.prompted_goal IS NULL
                AND NOT EXISTS (
                  SELECT 1 FROM foreman_queue_items i WHERE i.note_key = q.note_key
                )
              )`,
    )
    .all(cutoff) as unknown as Array<{ note_key: string }>;
  const drop = dead.map((r) => r.note_key).filter((k) => !liveKeys.has(k));
  if (drop.length === 0) return 0;
  // All-or-nothing, like `rekeyQueue`: a queue row outliving its items is a card
  // claiming a batch it can no longer show, and orphaned items outliving their row
  // are invisible to every reader here (all of which start from the row).
  db.exec("BEGIN");
  try {
    const delItems = db.prepare(`DELETE FROM foreman_queue_items WHERE note_key = ?`);
    const delQueue = db.prepare(`DELETE FROM foreman_queues WHERE note_key = ?`);
    for (const key of drop) {
      delItems.run(key);
      delQueue.run(key);
    }
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
  return drop.length;
}

export function upsertQueueItem(i: WorkItem): void {
  openDb()
    .prepare(
      `INSERT INTO foreman_queue_items (
         id, note_key, seq, intent, state, round, base_sha, transcript_anchor, gaps,
         send_attempts, verify_failures, escalation_reason, last_verdict, approved_at,
         proposed_payload, recovered_at, revision, created_at, updated_at, sent_at,
         completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         note_key=excluded.note_key, seq=excluded.seq, intent=excluded.intent,
         state=excluded.state, round=excluded.round, base_sha=excluded.base_sha,
         transcript_anchor=excluded.transcript_anchor, gaps=excluded.gaps,
         send_attempts=excluded.send_attempts, verify_failures=excluded.verify_failures,
         escalation_reason=excluded.escalation_reason, last_verdict=excluded.last_verdict,
         approved_at=excluded.approved_at, proposed_payload=excluded.proposed_payload,
         recovered_at=excluded.recovered_at, revision=excluded.revision,
         updated_at=excluded.updated_at, sent_at=excluded.sent_at,
         completed_at=excluded.completed_at`,
    )
    .run(
      i.id, i.noteKey, i.seq, i.intent, i.state, i.round, i.baseSha, i.transcriptAnchor,
      JSON.stringify(i.gaps), i.sendAttempts, i.verifyFailures, i.escalationReason,
      i.lastVerdict, i.approvedAt, i.proposedPayload, i.recoveredAt, i.revision,
      i.createdAt, i.updatedAt, i.sentAt, i.completedAt,
    );
}

export function getQueueItem(id: string): WorkItem | undefined {
  const r = openDb().prepare(`SELECT * FROM foreman_queue_items WHERE id = ?`).get(id) as
    | unknown as QueueItemRow | undefined;
  return r ? rowToItem(r) : undefined;
}

/** A queue's items in authored order. */
export function listQueueItems(noteKey: string): WorkItem[] {
  const rows = openDb()
    .prepare(`SELECT * FROM foreman_queue_items WHERE note_key = ? ORDER BY seq ASC`)
    .all(noteKey) as unknown as QueueItemRow[];
  return rows.map(rowToItem);
}

export function deleteQueueItem(id: string): void {
  openDb().prepare(`DELETE FROM foreman_queue_items WHERE id = ?`).run(id);
}

/** Drop a queue row (its items are re-keyed or deleted by the caller first). */
export function deleteQueue(noteKey: string): void {
  openDb().prepare(`DELETE FROM foreman_queues WHERE note_key = ?`).run(noteKey);
}

/**
 * Clear a whole queue on demand - every item AND the row - in ONE transaction.
 *
 * The bulk clear a session RESET needs, and deliberately unlike its two neighbours:
 * `deleteQueue` drops only the row, and `pruneDeadQueues` only ever collects a queue
 * whose session is already gone AND whose items are all terminal. This drops OPEN and
 * even IN-FLIGHT items too, because a reset is the explicit "discard this task" action
 * - the branch the items targeted is gone and the agent's context is /cleared, so
 * there is nothing left to run them against. (A bare /clear is the opposite case: its
 * backlog survives, orphaned, for the re-attach affordance.)
 *
 * All-or-nothing, like `pruneDeadQueues`: a row outliving its items is a card claiming
 * a batch it can't show, and items outliving their row are invisible to every reader
 * here (all of which start from the row). Returns true when anything was cleared.
 */
export function clearQueue(noteKey: string): boolean {
  const db = openDb();
  db.exec("BEGIN");
  try {
    const items = db.prepare(`DELETE FROM foreman_queue_items WHERE note_key = ?`).run(noteKey);
    const queue = db.prepare(`DELETE FROM foreman_queues WHERE note_key = ?`).run(noteKey);
    db.exec("COMMIT");
    return Number(items.changes) + Number(queue.changes) > 0;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

/**
 * Move a whole queue onto a new note key, in ONE transaction: write the target
 * row, re-key every item, drop the source row.
 *
 * Atomic for the same reason `reorderQueueItems` is. This is a re-key of N rows
 * that is only correct all-or-nothing: a throw or a crash partway through the
 * statement sequence leaves the batch SPLIT across two keys, with some items under
 * a queue row that has already been deleted and the rest still on the old one -
 * a state no reader models and the re-attach button cannot repair, since the hint
 * it keys off is computed from the very rows that got half-moved.
 *
 * `items` arrive already re-keyed and renumbered; the caller owns that policy
 * (which seqs, which target row), this owns only the all-or-nothing.
 */
export function rekeyQueue(
  fromKey: string,
  toRow: Omit<SessionQueue, "items">,
  items: WorkItem[],
): void {
  const d = openDb();
  d.exec("BEGIN");
  try {
    upsertQueue(toRow);
    for (const i of items) {
      // Delete-then-insert rather than an in-place re-key: an in-flight item would
      // otherwise have to pass through a moment where both keys hold it, which is
      // exactly what the single-flight partial index forbids.
      deleteQueueItem(i.id);
      upsertQueueItem(i);
    }
    deleteQueue(fromKey);
    d.exec("COMMIT");
  } catch (err) {
    try {
      d.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

/** The next authored position for a queue (max(seq) + 1, or 0 when empty). */
export function nextQueueSeq(noteKey: string): number {
  const r = openDb()
    .prepare(`SELECT COALESCE(MAX(seq), -1) AS m FROM foreman_queue_items WHERE note_key = ?`)
    .get(noteKey) as { m: number } | undefined;
  return (r?.m ?? -1) + 1;
}

/**
 * Renumber a whole queue to the given id order, in ONE transaction. Whole-list
 * (not a swap) because a partial renumber can transiently collide on seq, and the
 * authored order is the queue's entire contract - it must never be observable
 * half-applied. Ids not in `ids` keep their rows and are pushed after, so a stale
 * client list can't silently drop an item.
 */
export function reorderQueueItems(noteKey: string, ids: string[], now: number): void {
  const d = openDb();
  d.exec("BEGIN");
  try {
    // Rows the client didn't list - a concurrent add that raced the drop, or a
    // caller that legitimately sent a subset (the route only validates that each
    // id it WAS given is known). They're selected explicitly rather than inferred
    // from a seq range: they never moved, so nothing distinguishes them by seq, and
    // an earlier attempt to catch them by `seq >= scratch` matched nothing at all.
    // Left where they were, an unlisted row collides at seq 0 with the reordered
    // head, and `nextSendable`'s strict `<` then breaks the tie by arbitrary row
    // order - i.e. which work instruction gets typed becomes luck.
    const placeholders = ids.map(() => "?").join(", ");
    const unlisted = (
      d
        .prepare(
          `SELECT id FROM foreman_queue_items
           WHERE note_key = ?${ids.length ? ` AND id NOT IN (${placeholders})` : ""}
           ORDER BY seq ASC`,
        )
        .all(noteKey, ...ids) as unknown as Array<{ id: string }>
    ).map((r) => r.id);

    // Their authored order is preserved, and they land after the reordered block.
    const order = [...ids, ...unlisted];

    const upd = d.prepare(
      `UPDATE foreman_queue_items SET seq = ?, updated_at = ? WHERE id = ? AND note_key = ?`,
    );
    // Two passes over a scratch offset: seq has no UNIQUE constraint, but writing
    // the final numbers directly still means the list passes through states where
    // two rows share a seq. Ordering by the scratch pass keeps the intermediate
    // rows unambiguous if anything reads mid-transaction.
    const scratch = 1_000_000;
    order.forEach((id, i) => upd.run(scratch + i, now, id, noteKey));
    order.forEach((id, i) => upd.run(i, now, id, noteKey));
    d.exec("COMMIT");
  } catch (err) {
    // Guarded like rekeyQueue's: if the BEGIN itself never took there is no
    // transaction to roll back, and an unguarded ROLLBACK throws over the original
    // error - which is the one the caller needs to see.
    try {
      d.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

// ---- generic app config (Foreman config, future singletons) ----

/** Read a JSON-encoded config blob by key, or undefined when unset/corrupt. */
export function getAppConfig<T>(key: string): T | undefined {
  const r = openDb().prepare(`SELECT value FROM app_config WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  if (!r) return undefined;
  try {
    return JSON.parse(r.value) as T;
  } catch {
    return undefined;
  }
}

// ---- skills acks (which generation each session has been told about) ----

/**
 * Every session's acked generation, as one map.
 *
 * Read whole rather than per-session because the reload loop's selector is a pure
 * function over the sessions and wants no I/O inside it - the same discipline
 * `decideQueueTick` holds. The table is one row per session ever seen, integers
 * only, so reading it on a 1.5s tick is noise.
 */
export function getSkillsAcks(): Map<string, number> {
  const rows = openDb().prepare(`SELECT note_key, generation FROM skills_acks`).all() as unknown as
    Array<{ note_key: string; generation: number }>;
  return new Map(rows.map((r) => [r.note_key, r.generation]));
}

/**
 * Record that a session has been told about `generation`.
 *
 * Also the ROLLBACK: pass the prior value to undo an ack written before a delivery
 * that turned out never to reach the pane. Absent and 0 are the same fact ("never
 * acked"), because generation 0 means the symlink set has never changed and so
 * nothing is owed to anybody.
 */
export function setSkillsAck(noteKey: string, generation: number, now = Date.now()): void {
  openDb()
    .prepare(
      `INSERT INTO skills_acks (note_key, generation, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(note_key) DO UPDATE SET generation=excluded.generation, updated_at=excluded.updated_at`,
    )
    .run(noteKey, generation, now);
}

export function setAppConfig(key: string, value: unknown): void {
  openDb()
    .prepare(
      `INSERT INTO app_config (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    )
    .run(key, JSON.stringify(value));
}

// ---- Inspector: the adoption + provenance ledgers ----
//
// Everything below is read and written ONLY by the Inspector (daemon-side). The two
// tables answer the two questions that make automated PR review safe to run at all:
// "is this PR ours to comment on?" and "is this comment ours to resolve?".

interface InspectorPrRow {
  key: string;
  url: string;
  owner: string;
  repo: string;
  number: number;
  repo_root: string | null;
  cwd: string | null;
  session_id: string | null;
  source: string;
  state: string;
  head_sha: string | null;
  review_posture: string | null;
  round: number;
  last_reviewed_at: number | null;
  last_error: string | null;
  fail_count: number;
  last_fail_kind: string | null;
  next_attempt_at: number | null;
  last_attempt_sha: string | null;
  merged_at: number | null;
  merge_block: string | null;
  observed_head_sha: string | null;
  observed_state: string | null;
  observed_at: number | null;
  head_ref_name: string | null;
  title: string | null;
  adopted_at: number;
  updated_at: number;
}

function rowToInspectorPr(r: InspectorPrRow): InspectorPr {
  return {
    key: r.key,
    url: r.url,
    owner: r.owner,
    repo: r.repo,
    number: r.number,
    repoRoot: r.repo_root,
    cwd: r.cwd,
    sessionId: r.session_id,
    source: r.source === "hook" ? "hook" : "legacy",
    state: r.state as InspectorPrState,
    headSha: r.head_sha,
    reviewPosture: (r.review_posture as InspectorPr["reviewPosture"]) ?? null,
    round: r.round,
    lastReviewedAt: r.last_reviewed_at,
    lastError: r.last_error,
    failCount: r.fail_count,
    lastFailKind: (r.last_fail_kind as InspectorFailKind | null) ?? null,
    nextAttemptAt: r.next_attempt_at,
    lastAttemptSha: r.last_attempt_sha,
    mergedAt: r.merged_at,
    mergeBlock: r.merge_block,
    observedHeadSha: r.observed_head_sha,
    observedState: (r.observed_state as InspectorPr["observedState"]) ?? null,
    observedAt: r.observed_at,
    headRefName: r.head_ref_name,
    title: r.title,
    adoptedAt: r.adopted_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Adopt a PR for review, idempotently. Returns true when this call is what adopted it.
 *
 * `DO NOTHING` rather than an upsert, and that is the whole design of the function:
 * adoption is a fact about the past ("we opened this"), so a later sighting must never
 * be able to rewrite it. Repeated hook delivery is a no-op instead of a re-adoption
 * that would reset the head sha and re-review a PR from scratch.
 */
export function adoptInspectorPr(pr: InspectorPr): boolean {
  const res = openDb()
    .prepare(
      `INSERT INTO inspector_prs
         (key, url, owner, repo, number, repo_root, cwd, session_id, source, state,
          head_sha, review_posture, round, last_reviewed_at, last_error, fail_count, last_fail_kind,
          next_attempt_at, last_attempt_sha, merged_at, merge_block,
          observed_head_sha, observed_state, observed_at, head_ref_name, title,
          adopted_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO NOTHING`,
    )
    .run(
      pr.key,
      pr.url,
      pr.owner,
      pr.repo,
      pr.number,
      pr.repoRoot,
      pr.cwd,
      pr.sessionId,
      pr.source,
      pr.state,
      pr.headSha,
      pr.reviewPosture,
      pr.round,
      pr.lastReviewedAt,
      pr.lastError,
      pr.failCount,
      pr.lastFailKind,
      pr.nextAttemptAt,
      pr.lastAttemptSha,
      pr.mergedAt,
      pr.mergeBlock,
      pr.observedHeadSha,
      pr.observedState,
      pr.observedAt,
      pr.headRefName,
      pr.title,
      pr.adoptedAt,
      pr.updatedAt,
    );
  return Number(res.changes) > 0;
}

/**
 * Refresh the mutable half of a ledger row after a tick.
 *
 * `cwd` and `repo_root` are deliberately NOT writable here. They record where the PR was
 * opened from, which is a fact about the past; the worktree behind `cwd` gets reaped and
 * pooled worktrees get reused, so the value is only ever a hint. Resolving a directory
 * that still exists is the tick's job, once per pass, and it falls back to `repo_root`
 * because git's common dir outlives any worktree of the repo - see `liveDir` in
 * `inspector/worker.ts`. Identity columns (key/owner/repo/number/source/adopted_at) are
 * untouched by construction.
 */
export function updateInspectorPr(
  key: string,
  patch: {
    state?: InspectorPrState;
    headSha?: string | null;
    reviewPosture?: InspectorPr["reviewPosture"];
    round?: number;
    lastReviewedAt?: number | null;
    lastError?: string | null;
    failCount?: number;
    lastFailKind?: InspectorFailKind | null;
    nextAttemptAt?: number | null;
    lastAttemptSha?: string | null;
    mergedAt?: number | null;
    mergeBlock?: string | null;
    observedHeadSha?: string | null;
    observedState?: InspectorPr["observedState"];
    observedAt?: number | null;
    headRefName?: string | null;
    /** Re-recorded every tick, so a retitled pull request stops being stale. */
    title?: string | null;
  },
  now: number,
): void {
  const cur = getInspectorPr(key);
  if (!cur) return;
  const next = { ...cur, ...patch };
  openDb()
    .prepare(
      `UPDATE inspector_prs
          SET state = ?, head_sha = ?, review_posture = ?, round = ?,
              last_reviewed_at = ?, last_error = ?, fail_count = ?, last_fail_kind = ?,
              next_attempt_at = ?, last_attempt_sha = ?,
              merged_at = ?, merge_block = ?,
              observed_head_sha = ?, observed_state = ?, observed_at = ?, head_ref_name = ?,
              title = ?,
              updated_at = ?
        WHERE key = ?`,
    )
    .run(
      next.state,
      next.headSha,
      next.reviewPosture,
      next.round,
      next.lastReviewedAt,
      next.lastError,
      next.failCount,
      next.lastFailKind,
      next.nextAttemptAt,
      next.lastAttemptSha,
      next.mergedAt,
      next.mergeBlock,
      next.observedHeadSha,
      next.observedState,
      next.observedAt,
      next.headRefName,
      next.title,
      now,
      key,
    );
}

export function getInspectorPr(key: string): InspectorPr | null {
  const r = openDb().prepare(`SELECT * FROM inspector_prs WHERE key = ?`).get(key) as
    | InspectorPrRow
    | undefined;
  return r ? rowToInspectorPr(r) : null;
}

/**
 * Point an adopted pull request at the checkout it actually belongs to.
 *
 * Deliberately narrow, and separate from `updateInspectorPr`, because `repo_root` is not a
 * poll observation - it decides which `INSPECTOR.md` and which standards a review is written
 * against, and which directory `gh` and the reviewer run in.
 *
 * It exists because adoption cannot always know. The proving signal is a hook or a driver
 * event carrying a URL and the SESSION's identity, and on a multi-repo task the session's
 * repo is the primary - so a pull request the agent opened in a secondary repository is
 * adopted against the primary's checkout. The branch poller later finds that same URL by
 * asking `gh` inside one specific worktree, which is not a guess about which repository it
 * belongs to but a measurement, and this is how that measurement gets recorded. Single-repo
 * adoption never moves: it is already correct, and this writes only when the value differs.
 */
export function retargetInspectorPrCheckout(
  key: string,
  repoRoot: string,
  cwd: string | null,
  now: number,
): boolean {
  const result = openDb()
    .prepare(
      `UPDATE inspector_prs
          SET repo_root = ?, cwd = ?, updated_at = ?
        WHERE key = ? AND (repo_root IS NULL OR repo_root <> ?)`,
    )
    .run(repoRoot, cwd, now, key, repoRoot);
  return Number(result.changes) > 0;
}

/** Every PR still worth polling - what the tick iterates. */
export function loadOpenInspectorPrs(): InspectorPr[] {
  const rows = openDb()
    .prepare(`SELECT * FROM inspector_prs WHERE state = 'open' ORDER BY adopted_at ASC`)
    .all() as unknown as InspectorPrRow[];
  return rows.map(rowToInspectorPr);
}

/**
 * Every open adoption, plus the ones RETIRED since a given instant.
 *
 * The open set alone cannot answer a `pull_request` session action, and the reason is a
 * one-tick race in the poller: it records what it saw - including `observed_state = 'CLOSED'` -
 * and then, in the very next statement, sets `state = 'closed'` to retire the row. So a pull
 * request closed while an action was waiting for it leaves the open set on the same tick that
 * first observed the closure, and the adapter never sees the state it is supposed to BLOCK on.
 * It would report an ordinary "no pull request yet" wait for a durable contradiction that
 * needs a human, and wait for ever.
 *
 * Bounded by the caller's own instant rather than by a window constant, because there is a
 * principled one available: an action asks about pull requests observed since its instruction
 * was delivered. That keeps the extra set at approximately zero rows in the ordinary case,
 * which matters - the caller resolves a repository identity per distinct root, and that is a
 * git subprocess.
 *
 * Retired rows OLDER than the bound stay out. A pull request closed last year is history, not
 * a contradiction this turn produced, and the branch's next pull request is a new row.
 */
export function loadAdoptedInspectorPrsSince(observedSince: number): InspectorPr[] {
  const rows = openDb()
    .prepare(
      `SELECT * FROM inspector_prs
        WHERE state = 'open'
           OR (observed_at IS NOT NULL AND observed_at >= ?)
        ORDER BY adopted_at ASC`,
    )
    .all(observedSince) as unknown as InspectorPrRow[];
  return rows.map(rowToInspectorPr);
}

interface InspectorCommentRow {
  id: string;
  pr_key: string;
  fingerprint: string;
  path: string | null;
  line: number | null;
  title: string;
  body: string | null;
  severity: string;
  round: number;
  status: string;
  replies: number;
  answered_comment_id: number | null;
  created_at: number;
  updated_at: number;
}

function rowToInspectorComment(r: InspectorCommentRow): InspectorComment {
  return {
    id: r.id,
    prKey: r.pr_key,
    fingerprint: r.fingerprint,
    path: r.path,
    line: r.line,
    title: r.title,
    body: r.body,
    severity: r.severity as InspectorSeverity,
    round: r.round,
    status: r.status as InspectorCommentStatus,
    replies: r.replies,
    answeredCommentId: r.answered_comment_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Record (or re-record) one issue on one PR.
 *
 * The conflict target is `(pr_key, fingerprint)` - the ISSUE's identity - so a finding
 * the reviewer raises again in a later round updates its row instead of minting a
 * second one. That is also what lets a resolved-then-regressed issue come back: the
 * row flips out of `resolved` and gets a fresh comment id, rather than being blocked
 * by a primary key it can't reuse.
 */
export function upsertInspectorComment(c: InspectorComment): void {
  openDb()
    .prepare(
      `INSERT INTO inspector_comments
         (id, pr_key, fingerprint, path, line, title, body, severity,
          round, status, replies, answered_comment_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(pr_key, fingerprint) DO UPDATE SET
         path = excluded.path,
         line = excluded.line,
         title = excluded.title,
         body = excluded.body,
         severity = excluded.severity,
         round = excluded.round,
         status = excluded.status,
         replies = excluded.replies,
         answered_comment_id = excluded.answered_comment_id,
         updated_at = excluded.updated_at`,
    )
    .run(
      c.id,
      c.prKey,
      c.fingerprint,
      c.path,
      c.line,
      c.title,
      c.body,
      c.severity,
      c.round,
      c.status,
      c.replies,
      c.answeredCommentId,
      c.createdAt,
      c.updatedAt,
    );
}

/**
 * Close every finding still counted as open on one pull request, at an operator's word.
 * Returns how many rows actually changed.
 *
 * The recovery route for a ledger the Inspector cannot correct itself. `closeRow` in the
 * worker is driven by the model - by a review round listing a fingerprint as resolved, or
 * by a follow-up reply dropping its own finding - and neither can reach a finding whose
 * fix was pushed, reviewed once, and then simply never mentioned again: the review round
 * returns early on a head it has already reviewed, so no later round exists to list it.
 * That left `mergeBlock: findings` permanent, with no path out at all, and pull requests
 * had to be merged by hand.
 *
 * What this deliberately does NOT do is weaken the gate. `mergeVerdict` still refuses on
 * any open finding, `openFindings` still counts every non-resolved row, and a merge still
 * has to clear the `threads` gate - which counts unresolved review threads from GITHUB's
 * own snapshot, ours and everyone else's. So this closes our ledger's opinion and nothing
 * else: an operator who clicks it while the review threads are still open has moved the
 * pull request from `findings` to `threads`, not to merged.
 *
 * Every row NOT already `resolved` is closed, rather than only the `open` ones: `drafted`
 * (previewed in dry run, never posted) and `posting` (a round whose response was lost) are
 * the two other ways a row is counted open by `openFindings`, and both strand a pull
 * request in exactly the same way.
 *
 * A pull request that has CLOSED is refused, and the refusal lives here rather than only at
 * the route or in the panel that hides the control. A retired row is out of the sweep for
 * good, so resolving it can unblock nothing - all it can do is overwrite the record of what
 * the Inspector said about work that has already landed, which this ledger deliberately
 * keeps (see `inspectionSummary`, and `docs/inspector-and-shipping.md`). The guard belongs
 * to the WRITER because a UI check is not enforcement: it does not bind a direct caller of
 * the route, and it does not survive the window between the panel's 4s poll and the click,
 * in which the pull request can close under the operator. Returns 0, which is the truthful
 * count - the caller decides whether that is an error worth a status code.
 *

 * Written row-by-row through `upsertInspectorComment` rather than as one `UPDATE ... SET
 * status`, and that is the point rather than an oversight. There are two POLICIES that
 * resolve a finding - the worker's `closeRow`, driven by the model, and this one, driven by
 * an operator - and they must not become two independent answers to "what a resolved row
 * looks like". Sharing the one upsert keeps a single statement in the whole tree that can
 * write this column, so the two paths cannot drift on the status vocabulary or on what
 * `updated_at` means; `test/inspector-resolution-writer.test.ts` pins that. The cost is one
 * statement per open finding instead of one per pull request, on an operator's click rather
 * than in the sweep, against a set the round cap bounds at 20.
 */
export function resolveInspectorFindings(prKey: string, now: number): number {
  const pr = getInspectorPr(prKey);
  if (!pr || pr.state !== "open") return 0;
  const open = loadInspectorComments(prKey).filter((c) => c.status !== "resolved");
  for (const row of open) {
    upsertInspectorComment({ ...row, status: "resolved", updatedAt: now });
  }
  return open.length;
}

export function loadInspectorComments(prKey: string): InspectorComment[] {
  const rows = openDb()
    .prepare(`SELECT * FROM inspector_comments WHERE pr_key = ? ORDER BY created_at ASC`)
    .all(prKey) as unknown as InspectorCommentRow[];
  return rows.map(rowToInspectorComment);
}

/**
 * The tally half of every inspection read: ledger row plus its finding counts, in ONE
 * grouped query rather than a load-then-count-per-row loop. This runs on the daemon's
 * single synchronous SQLite handle - the same one serving hook ingest and SSE - and the
 * panels poll it.
 *
 * Shared by the two orderings below so their tallies cannot drift apart. Everything after
 * the join (the WHERE, the GROUP BY, the ORDER BY) belongs to the caller, which is the
 * only thing the two differ in.
 */
const INSPECTION_TALLY_FROM = `SELECT p.*,
              COALESCE(SUM(CASE WHEN c.status IN ('open','drafted','posting') THEN 1 ELSE 0 END), 0) AS open_findings,
              COALESCE(SUM(CASE WHEN c.status = 'open' THEN 1 ELSE 0 END), 0) AS posted_open_findings,
              COALESCE(SUM(CASE WHEN c.status = 'resolved' THEN 1 ELSE 0 END), 0) AS resolved_findings
         FROM inspector_prs p
         LEFT JOIN inspector_comments c ON c.pr_key = p.key`;

type InspectionTallyRow = InspectorPrRow & {
  open_findings: number;
  posted_open_findings: number;
  resolved_findings: number;
};

function rowToInspection(r: InspectionTallyRow): InspectorInspection {
  return {
    ...rowToInspectorPr(r),
    openFindings: Number(r.open_findings),
    postedOpenFindings: Number(r.posted_open_findings),
    resolvedFindings: Number(r.resolved_findings),
  };
}

/**
 * Every ledger row with its finding tallies, most recently REVIEWED first - the settings
 * panel's list, and what the per-session chip is derived from.
 *
 * `limit` is OPTIONAL, and the default is "all of them", because the two callers want
 * different things. The settings panel is a display and wants the recent slice; the
 * registry builds the per-session chip out of this and must not be truncated - rows are
 * never deleted, so a cap would eventually drop live PRs off the bottom, and an absent
 * chip is documented in three places as meaning "that PR came from somewhere else".
 *
 * Review recency is the wrong order for "what shipped in the last week" - see
 * `loadInspectionsAdoptedSince`.
 */
export function loadInspectorInspections(limit?: number): InspectorInspection[] {
  const rows = openDb()
    .prepare(
      `${INSPECTION_TALLY_FROM}
        GROUP BY p.key
        ORDER BY COALESCE(p.last_reviewed_at, p.adopted_at) DESC
        LIMIT ?`,
    )
    .all(limit ?? -1) as unknown as InspectionTallyRow[];
  return rows.map(rowToInspection);
}

/**
 * The same rows windowed and ordered by ADOPTION instead - "every pull request we opened
 * since T, newest first".
 *
 * `adopted_at` is not a stylistic choice of column. It is the provenance rule the Line's
 * Shipped count is already made of (`prsOpenedSince`): a row exists here because a hook
 * caught `gh pr create`, so adoption time is the one instant that means "we shipped this".
 * A surface listing what that count counted has to filter and sort on the same column, or
 * it can disagree with the number the operator clicked - the exact failure the panel's
 * `COALESCE(last_reviewed_at, adopted_at)` ordering produces, since a review is not a
 * ship and a re-review reorders a settled week.
 *
 * Uncapped, and that is the point rather than an oversight: a cap is a truncation the
 * caller cannot see, so a busy week would silently render short against a count that
 * included everything. The window is the bound, the ledger gains single-digit rows a day,
 * and the caller chooses how far back to look.
 *
 * NOT to be confused with `loadAdoptedInspectorPrsSince`, whose bound is `observed_at` and
 * whose subject is the retire race a `pull_request` session action has to survive.
 */
export function loadInspectionsAdoptedSince(sinceMs: number): InspectorInspection[] {
  const rows = openDb()
    .prepare(
      `${INSPECTION_TALLY_FROM}
        WHERE p.adopted_at >= ?
        GROUP BY p.key
        ORDER BY p.adopted_at DESC`,
    )
    .all(sinceMs) as unknown as InspectionTallyRow[];
  return rows.map(rowToInspection);
}
