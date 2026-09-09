import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { STATE_DIRS } from "@shared/harness-runtime.mjs";
import {
  APP_CONFIG_ENTRIES,
  type AppConfigEntry,
  type AppConfigInput,
  type AppConfigValue,
} from "@shared/app-config-entries.ts";
import { DB_PATH, envVar } from "./config.ts";
import { DatabaseBackupService, type DatabaseBackupRecord } from "./database-backups/service.ts";
import { RANK_STEP, repairBacklogRanks } from "./backlog-rank.ts";
import { supportsEffort } from "@shared/harness-capabilities.ts";
import type { LaunchTurnMarker } from "./launch-presentation.ts";
import {
  STANDING_INSTRUCTIONS_MECHANISMS,
  type StandingInstructionsMechanism,
  type StandingInstructionsSource,
} from "@shared/standing-instructions.ts";
import {
  isPipelineProviderId,
  isPipelineStepState,
  MAX_PIPELINE_COMMISSION_ATTEMPTS,
  PIPELINE_ATTEMPT_ORIGINS,
  PIPELINE_COMMISSION_ATTEMPT_STATES,
  PIPELINE_COMMISSION_LIFECYCLES,
  PIPELINE_EVIDENCE_COMMIT_PROVENANCES,
  PIPELINE_RECOVERY_STATES,
  pipelineRecoveryIsActive,
  type PipelineCommission,
  type PipelineCommissionAttempt,
  type PipelineCommissionAttemptState,
  type PipelineRecoveryGuard,
  type PipelineRecoveryResultCode,
  type PipelineProviderId,
  type PipelineRun,
} from "@shared/pipeline.ts";
import type {
  EpisodeAuthor,
  ForemanEpisode,
  ForemanEpisodeSummary,
  InspectorComment,
  FileCommentMessage,
  FileCommentReview,
  FileCommentThread,
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
  PromptedCompletionDecision,
  PromptedCompletionOutcome,
  PromptedDirectHandoff,
  PromptedDirectHandoffKind,
  PromptedRecoveryState,
  SessionQueue,
  Task,
  TaskAutomaticCleanup,
  TaskPriority,
  TaskRepoEntry,
  TaskStatus,
  TrackedGap,
  WorkItem,
  WorkItemState,
  WorkCycleSummary,
  WorktreeProvider,
} from "@shared/types.ts";
import {
  DEFAULT_TASK_KIND,
  PROMPTED_COMPLETION_OUTCOMES,
  TASK_KINDS,
} from "@shared/types.ts";
import {
  PROMPTED_DECISION_GAPS_MAX,
  PROMPTED_DECISION_GAP_DETAIL_MAX,
  PROMPTED_DECISION_GAP_ID_MAX,
  PROMPTED_DECISION_GAP_PATH_MAX,
  PROMPTED_DECISION_SUMMARY_MAX,
  HtmlBlockPathSchema,
  PromptedRecoveryStateSchema,
  PromptedCompletionDispositionSchema,
  type HtmlBlockPathStep,
  type PromptedCompletionDisposition,
  type PromptedRecoveryClaim,
  type PromptedRecoveryDelivery,
} from "@shared/protocol.ts";
import { shipRecoveryMarker } from "@shared/ship-recovery.ts";
import { nextShipRecoveryAt } from "./foreman/ship-shepherd.ts";
import { readPersistedEnum } from "@shared/schedules.ts";
import { HUMAN_REVIEW_STATUSES, isHumanResolvedReview } from "@shared/review-item.ts";
import { IN_FLIGHT_ITEM_STATES, TERMINAL_ITEM_STATES } from "@shared/queue.ts";
import {
  FILE_COMMENT_MESSAGES_PER_THREAD_MAX,
  FILE_COMMENT_THREAD_MESSAGE_CAP,
  FILE_COMMENT_THREADS_PER_SESSION_MAX,
  OUTSTANDING_THREAD_STATUSES,
  REQUEUEABLE_THREAD_STATUSES,
  holdsQueuePosition,
  isFileCommentThreadStatus,
  isOutstandingThreadStatus,
  type FileCommentAuthor,
  type FileCommentReviewState,
  type FileCommentThreadStatus,
} from "@shared/file-comments.ts";
import { isFileCommentSurface, type FileCommentSurface } from "@shared/file-comment-anchor.ts";
import { readCheapAction, readDivergence, readSkipReason } from "@shared/foreman.ts";
import { askPreviewForWire } from "@shared/foreman-ask.ts";
import type { CheapAction, Divergence, SkipReason } from "@shared/foreman.ts";
import { normalizeLabels } from "@shared/task.ts";
import { TASK_AUTOMATIC_CLEANUP_DETAIL_LIMIT } from "@shared/types.ts";
import {
  isRetentionCandidate,
  isRetentionRetryable,
  taskHoldsCleanupResources,
  taskResourceGeneration,
} from "./task-resource-generation.ts";

/**
 * Durable state. Live sessions are intentionally NOT persisted - they're rebuilt
 * from the OS on every poll. What survives a restart is state the OS can't rebuild:
 * pending review items (a human decision may be waiting), dispatched tasks (their
 * backlog, running intent, and recent outcomes), current work-cycle projections, and the
 * session event log.
 */
let db: DatabaseSync | undefined;

/**
 * The durable marker for the forward migration contract below.
 *
 * Increment this whenever `upgradeDatabaseToCurrentSchema` gains a schema or data migration.
 * The old value is what makes `openDb` capture one verified recovery point before that upgrade.
 * The new value is written only after the entire upgrade succeeds, so an interrupted migration
 * remains pending on the next start. A database from a newer build is never stamped backwards.
 */
export const CURRENT_DATABASE_SCHEMA_VERSION = 1;

function databaseSchemaVersion(d: DatabaseSync): number {
  const row = d.prepare("PRAGMA user_version").get() as { user_version: number };
  const version = Number(row.user_version);
  if (!Number.isSafeInteger(version)) {
    throw new TypeError(`Database user_version is not an integer: ${String(row.user_version)}`);
  }
  return version;
}

function databaseHasPendingMigration(d: DatabaseSync): boolean {
  return databaseSchemaVersion(d) < CURRENT_DATABASE_SCHEMA_VERSION;
}

function markDatabaseSchemaCurrent(d: DatabaseSync): void {
  if (!databaseHasPendingMigration(d)) return;
  d.exec(`PRAGMA user_version = ${CURRENT_DATABASE_SCHEMA_VERSION};`);
}

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
  let existingDatabase = false;
  try {
    existingDatabase = statSync(DB_PATH).size > 0;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const opened = new DatabaseSync(DB_PATH);
  let recoveryPoint: DatabaseBackupRecord | undefined;
  const pendingMigration = existingDatabase && databaseHasPendingMigration(opened);
  if (pendingMigration) {
    try {
      recoveryPoint = new DatabaseBackupService(opened).capturePreMigration();
    } catch (error) {
      try {
        opened.close();
      } catch {}
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Database startup stopped before migrations because its recovery backup failed: ${reason}`,
        { cause: error },
      );
    }
  }

  try {
    upgradeDatabaseToCurrentSchema(opened);
  } catch (error) {
    try {
      opened.close();
    } catch {}
    const reason = error instanceof Error ? error.message : String(error);
    const recovery = recoveryPoint
      ? ` Recovery point: ${recoveryPoint.path}.`
      : existingDatabase
        ? " No schema migration was pending, so no pre-migration recovery point was created."
        : " No earlier database state existed to back up.";
    throw new Error(
      `Database startup or migration failed: ${reason}.${recovery} Healthy live state was not replaced automatically.`,
      { cause: error },
    );
  }
  db = opened;
  return opened;
}

/**
 * The one forward-upgrade contract for both the live database and disposable restore
 * verification. Callers must provide a database they own and may mutate.
 */
export function upgradeDatabaseToCurrentSchema(d: DatabaseSync): void {
  d.exec("PRAGMA journal_mode = WAL;");
  // No `busy_timeout` beside it, and that is a decision rather than an omission.
  //
  // This process is the only one that writes here. Everything else that needs state reaches
  // it over loopback HTTP and never links `node:sqlite`: the Foreman worker (`foreman/
  // client.ts`, whose outbox is a FILE for exactly this reason), the MCP server, both agent
  // hooks, the statusline, and the Electron main process - which runs the daemon as a forked
  // utility process rather than in-process. `scripts/db-shell.mjs` opens the file `-readonly`,
  // which in WAL never blocks a writer. Within this process there is one connection, cached
  // below, and `DatabaseSync` is fully synchronous, so two statements cannot interleave.
  // There is nobody to wait for, and a timeout would buy nothing.
  //
  // The daemon entry acquires the state-directory ownership lock before reaching this call,
  // so the one-writer contract does not depend on the API port. A second daemon pointed at
  // this home exits before SQLite is opened, even if it names a different port. Every
  // transaction here is still `BEGIN IMMEDIATE`, which takes the write lock up front and,
  // with no timeout, fails on the spot instead of retrying if a non-daemon process violates
  // that boundary.
  //
  // A timeout would turn those into a wait, which is why it reads as the missing line. It is
  // deliberately not added: it would make a second writer look supported when the answer is
  // to not have one, and it would hide the collision rather than the fix. The place a second
  // writer IS legitimate is the e2e suite, which seeds this database beside a running daemon
  // - `e2e/fixtures/daemon-db.ts` sets the pragma there, on that connection, where it belongs.

  // SQLite parses REFERENCES clauses whatever this says and enforces them only when it is
  // on, so declaring a foreign key without this line is a comment that looks like a
  // constraint. It is safe to switch on for the whole file because the ensemble family
  // below is the ONLY one that declares a foreign key - every other table in here relates
  // by convention, and turning the pragma on cannot retroactively constrain a relation the
  // schema never declared. A new REFERENCES clause on an older table therefore becomes
  // live the moment it is written, which is the point.
  d.exec("PRAGMA foreign_keys = ON;");
  d.exec(`
    CREATE TABLE IF NOT EXISTS reviews (
      id                     TEXT PRIMARY KEY,
      session_id             TEXT NOT NULL,
      kind                   TEXT NOT NULL,
      title                  TEXT NOT NULL,
      body                   TEXT NOT NULL,
      status                 TEXT NOT NULL,
      response               TEXT,
      created_at             INTEGER NOT NULL,
      resolved_at            INTEGER,
      mcp_wait_detached_at   INTEGER,
      continuation_queued_at INTEGER
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

    -- Current lifecycle projection for one logical conversation. This is deliberately
    -- separate from session_events: that table is hook-only evidence and its any-row query
    -- drives Session.hooksSeen. It is also separate from session_work_episodes, whose rows
    -- own task and pull-request provenance rather than individual agent turns.
    --
    -- One row per logical key keeps restart state bounded by conversations, not turns.
    -- The active bit survives a daemon restart so a later turn end can advance exactly once.
    CREATE TABLE IF NOT EXISTS session_work_cycles (
      logical_key  TEXT PRIMARY KEY,                 -- noteKeyFor(session)
      generation  INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
      active       INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
      completed_at INTEGER,
      updated_at   INTEGER NOT NULL
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
      -- Provider-owned lifecycle key for a pipeline task. repo_root is the third
      -- coordinate, so only provider and slug need their own nullable columns.
      pipeline_provider TEXT,
      pipeline_slug TEXT,
      pipeline_commission_id TEXT,
      pipeline_workspace_path TEXT,
      worktree_path TEXT,
      branch        TEXT,
      provider      TEXT,
      -- Opaque native allocator identity. NULL for historical treehouse and disposable git.
      worktree_lease_id TEXT,
      -- The full 40-char commit the PRIMARY repo's branch was cut at. Here rather than in a
      -- task_repos row so "a single-repo task has zero task_repos rows" stays true; a reader
      -- that iterates task_repos alone therefore cannot see the primary and must read this.
      -- Nullable: every task dispatched before this column existed genuinely has no baseline.
      base_sha      TEXT,
      home_name     TEXT,               -- name of the terminal home, any backend (was tmux_session)
      home_backend  TEXT,               -- exact creator, NULL for automatic or legacy launches
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
      worktree_lease_id TEXT,
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

    -- One post-merge retro task per source work episode. The relation is written before the
    -- ordinary Task row so a retry after a crash reconstructs the same reserved task id
    -- instead of filing a duplicate. It deliberately carries no task lifecycle state: the
    -- Task row remains the single source of truth for dispatch, completion, and pull requests.
    CREATE TABLE IF NOT EXISTS retro_followups (
      source_task_id    TEXT NOT NULL,
      source_episode_id TEXT NOT NULL,
      source_session_id TEXT NOT NULL,
      retro_task_id     TEXT NOT NULL,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      PRIMARY KEY (source_task_id, source_episode_id),
      UNIQUE (retro_task_id)
    );

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
      surface        TEXT NOT NULL,  -- input-review | terminal | pipeline
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

    -- How the DASHBOARD presents the turn that STARTED a Mission Control-managed
    -- conversation. Keyed like session_notes and session_goals (noteKeyFor = agentSessionId
    -- ?? synthetic id) so it shares that lifecycle, and its own row for the same reason the
    -- goal has one: a second writer sharing the note's disposition and updated_at would
    -- corrupt both meanings.
    --
    -- What is deliberately absent is the composed prompt. The agent's own transcript already
    -- holds it in full and is authoritative for every server-side evidence consumer; a copy
    -- here would be a second source of transcript truth that could drift from the first.
    -- The fingerprint column is launchTextFingerprint of that delivered text - enough to
    -- recognize one turn and nothing else - and display_text is the operator's request as it
    -- stood at dispatch, frozen so a later task edit cannot rewrite visible history. A null
    -- display_text means the launch had no distinct human request, which OMITS the turn from
    -- the visible log rather than exposing the platform contract.
    --
    -- message_id is the OCCURRENCE anchor, null until a decorated read identifies the turn
    -- (at dispatch the prompt has not been written yet, so it has no id). Once set, only that
    -- turn projects and the fingerprint is no longer consulted - which is what keeps a later
    -- turn carrying identical bytes, such as a delivery retry, rendering as the real message
    -- it is rather than being replaced by the projection.
    --
    -- An empty table is the shipped state of every existing installation, and absence means
    -- current rendering: no backfill, and no heuristic guessing which historical turn was a
    -- launch.
    CREATE TABLE IF NOT EXISTS session_launch_turns (
      note_key     TEXT PRIMARY KEY,   -- noteKeyFor(s), same key as session_notes
      fingerprint  TEXT NOT NULL,      -- sha256 of the trimmed prompt delivered to the agent
      echo_fingerprint TEXT,           -- sha256 of that prompt whitespace-collapsed, or NULL
      display_text TEXT,               -- the human request, or NULL to omit the turn
      message_id   TEXT,               -- native id of the projected turn, NULL until seen
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_session_launch_turns_age
      ON session_launch_turns(updated_at);

    -- WHAT STANDING INSTRUCTIONS THIS SESSION ACTUALLY RECEIVED, recorded at launch.
    --
    -- A session outlives the setting that launched it. Reading live configuration back to a
    -- session header would quote a running session text it never saw the moment the operator
    -- edits the rule, or show nothing at all once the override is removed - and a marker that
    -- lies is worse than no marker, because it sends the operator looking for the cause of a
    -- behaviour in a rule that was not in effect. So this is a RECORD of something that
    -- happened, which is also why it has no updated_at: a row that can be updated is a row
    -- that can be made to disagree with the launch it describes.
    --
    -- text and sources are therefore immutable, and so is created_at. The ONE field that can
    -- be corrected afterwards is mechanism, and only toward prompt-prefix: a resumed Codex
    -- session can find developerInstructions unusable on the new connection and be sent the
    -- same stored block as prose instead. That is not a disagreement with the launch, it is
    -- the launch's own delivery being re-decided by the same rule start applies - and the
    -- field is not decoration, because tasks.ts reads it to decide whether a later assignment
    -- repeats the rule, and a prefix governs only the turn it rode in. Still no updated_at:
    -- the correction says what happened, and re-aging the row would only hide it from the
    -- prune window it belongs to.
    --
    -- text is the WHOLE composed block, multi-repo labelled parts included, byte for byte
    -- as the agent read it - not one repository's resolution. One row rather than one per
    -- repository, so nothing has to re-assemble the labelled blocks anywhere else; the
    -- provenance that is still needed, which stored key produced each repository's part,
    -- is the sources JSON beside it (session_goals.pending_prompts is the precedent for
    -- a small ordered JSON column here).
    --
    -- mechanism is an APPEND-ONLY vocabulary from STANDING_INSTRUCTIONS_MECHANISMS,
    -- queried back by exact value - see docs/agent-guides/change-contracts.md.
    --
    -- Keyed like session_notes, session_goals and foreman_invites (noteKeyFor = agentSessionId
    -- ?? synthetic id). Its own table rather than a column on one of those for the reason
    -- session_goals records: a second writer sharing another table's disposition and
    -- updated_at corrupts both meanings.
    --
    -- An empty table is the shipped state of every existing installation, and a session with
    -- no standing instruction writes no row at all.
    CREATE TABLE IF NOT EXISTS session_standing_instructions (
      note_key   TEXT PRIMARY KEY,   -- noteKeyFor(s), same key as session_notes
      text       TEXT NOT NULL,      -- the composed block EXACTLY as delivered
      mechanism  TEXT NOT NULL,      -- which channel carried it
      sources    TEXT NOT NULL,      -- JSON, manifest order: [{repoPath, matchedKey|null}]
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_session_standing_instructions_age
      ON session_standing_instructions(created_at);

    CREATE TABLE IF NOT EXISTS app_config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Operational identity for daemon-owned native worktree pools. Policy does not live
    -- here: app_config.worktrees is the sole source for enablement, capacity and setup argv.
    -- The physical Git common directory is the pool identity, not a remote URL, so two local
    -- clones of one remote can never share Git worktree bookkeeping.
    CREATE TABLE IF NOT EXISTS worktree_pools (
      id                     TEXT    NOT NULL PRIMARY KEY,
      git_common_dir         TEXT    NOT NULL,
      main_checkout_root     TEXT    NOT NULL,
      pool_path              TEXT    NOT NULL,
      ordinal_high_water     INTEGER NOT NULL DEFAULT 0,
      last_reconciled_at     INTEGER,
      reconciliation_error  TEXT,
      created_at             INTEGER NOT NULL,
      updated_at             INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_worktree_pools_common_dir
      ON worktree_pools(git_common_dir);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_worktree_pools_path
      ON worktree_pools(pool_path);

    -- One durable native slot. State identifiers are intentionally unconstrained TEXT:
    -- their vocabulary is append-only, and adding a later state must not require rebuilding
    -- an operational table while worktrees are live.
    --
    -- Every filesystem mutation is preceded by provisioning/returning/pruning. The version
    -- rises on every state transition and is part of the release compare-and-swap. Active
    -- identity is cleared only after a proven return; last-released identity closes the
    -- crash window before a domain owner clears its own row.
    CREATE TABLE IF NOT EXISTS worktree_slots (
      id                        TEXT    NOT NULL PRIMARY KEY,
      pool_id                   TEXT    NOT NULL,
      ordinal                   INTEGER NOT NULL,
      path                      TEXT    NOT NULL,
      state                     TEXT    NOT NULL,
      version                   INTEGER NOT NULL,
      requested_head_sha        TEXT,
      current_head_sha          TEXT,
      active_lease_id           TEXT,
      active_owner_kind         TEXT,
      active_owner_key          TEXT,
      leased_at                 INTEGER,
      last_released_lease_id    TEXT,
      last_released_owner_kind  TEXT,
      last_released_owner_key   TEXT,
      last_used_at              INTEGER,
      quarantine_reason         TEXT,
      last_error                TEXT,
      created_at                INTEGER NOT NULL,
      updated_at                INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_worktree_slots_pool_ordinal
      ON worktree_slots(pool_id, ordinal);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_worktree_slots_path
      ON worktree_slots(path);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_worktree_slots_active_lease
      ON worktree_slots(active_lease_id) WHERE active_lease_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_worktree_slots_pool_state
      ON worktree_slots(pool_id, state, ordinal);
    CREATE INDEX IF NOT EXISTS idx_worktree_slots_last_release
      ON worktree_slots(last_released_lease_id);

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
    --
    -- max_runs is how many times this command may actually execute inside one workflow run,
    -- across every repair round. It defaults to 1 in the column as well as in the schema, so
    -- an upgrading database adopts the same budget a fresh install gets rather than keeping
    -- the old unbounded behaviour under a column that claims to bound it.
    CREATE TABLE IF NOT EXISTS workflow_commands (
      slot                 TEXT PRIMARY KEY,
      default_command_json TEXT,
      max_runs             INTEGER NOT NULL DEFAULT 1,
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
      evidence_readiness_policy TEXT NOT NULL DEFAULT 'off',
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
      evidence_readiness_policy TEXT NOT NULL DEFAULT 'off',
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
      persona_directives_json TEXT,
      check_budget_epoch_round INTEGER
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
      refinement_reason    TEXT,
      mode                 TEXT NOT NULL,
      trigger_source       TEXT NOT NULL,
      trigger_key          TEXT NOT NULL,
      evidence_group_key   TEXT NOT NULL DEFAULT '',
      staged_image_generation INTEGER NOT NULL DEFAULT 0,
      evidence_fingerprint TEXT NOT NULL,
      context_json         TEXT NOT NULL,
      evidence_json        TEXT NOT NULL,
      readiness_json       TEXT,
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

    -- Mutable, conversation-owned evidence remains separate from immutable submissions.
    -- Source roots and inline bodies are server-only. Child-supplied locators may enter the
    -- staged-evidence API, but never immutable context_json without capture and validation.
    CREATE TABLE IF NOT EXISTS workflow_evidence_owners (
      note_key              TEXT PRIMARY KEY,
      generation            INTEGER NOT NULL DEFAULT 0,
      all_generation        INTEGER NOT NULL DEFAULT 0,
      updated_at            INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_evidence_scope_generations (
      note_key              TEXT NOT NULL,
      source_root           TEXT NOT NULL,
      generation            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL,
      PRIMARY KEY(note_key, source_root)
    );

    CREATE TABLE IF NOT EXISTS workflow_evidence_staging (
      id                    TEXT PRIMARY KEY,
      note_key              TEXT NOT NULL,
      client_item_id        TEXT NOT NULL,
      source_kind           TEXT NOT NULL,
      evidence_kind         TEXT NOT NULL DEFAULT 'image',
      source_root           TEXT NOT NULL,
      source_locator        TEXT NOT NULL,
      inline_content        TEXT,
      command_exit_code     INTEGER,
      episode_key           TEXT,
      display_name          TEXT NOT NULL,
      caption               TEXT NOT NULL,
      repository_scope      TEXT NOT NULL,
      mime_type             TEXT NOT NULL,
      bytes                 INTEGER NOT NULL,
      sha256                TEXT NOT NULL,
      generation            INTEGER NOT NULL,
      state                 TEXT NOT NULL,
      reserved_group_key    TEXT,
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL,
      UNIQUE(note_key, client_item_id)
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_evidence_staging_owner
      ON workflow_evidence_staging(note_key, state, generation, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_workflow_evidence_staging_reservation
      ON workflow_evidence_staging(reserved_group_key, state);

    CREATE TABLE IF NOT EXISTS workflow_evidence_coverage_staging (
      id                    TEXT PRIMARY KEY,
      note_key              TEXT NOT NULL,
      client_criterion_id   TEXT NOT NULL,
      criterion             TEXT NOT NULL,
      proof_class           TEXT NOT NULL,
      repository_scope      TEXT NOT NULL,
      source_root           TEXT NOT NULL,
      links_json            TEXT NOT NULL,
      episode_key           TEXT,
      generation            INTEGER NOT NULL,
      state                 TEXT NOT NULL,
      reserved_group_key    TEXT,
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL,
      UNIQUE(note_key, client_criterion_id)
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_evidence_coverage_staging_owner
      ON workflow_evidence_coverage_staging(note_key, state, generation, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_workflow_evidence_coverage_staging_reservation
      ON workflow_evidence_coverage_staging(reserved_group_key, state);

    CREATE TABLE IF NOT EXISTS workflow_evidence_reservations (
      staging_id            TEXT NOT NULL,
      submission_id         TEXT NOT NULL,
      ordinal               INTEGER NOT NULL,
      created_at            INTEGER NOT NULL,
      PRIMARY KEY(staging_id, submission_id),
      UNIQUE(submission_id, ordinal)
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_evidence_reservations_submission
      ON workflow_evidence_reservations(submission_id, ordinal);

    CREATE TABLE IF NOT EXISTS workflow_submission_images (
      id                    TEXT PRIMARY KEY,
      submission_id         TEXT NOT NULL,
      staging_id            TEXT NOT NULL,
      ordinal               INTEGER NOT NULL,
      display_name          TEXT NOT NULL,
      caption               TEXT NOT NULL,
      repository_scope      TEXT NOT NULL,
      mime_type             TEXT NOT NULL,
      bytes                 INTEGER NOT NULL,
      sha256                TEXT NOT NULL,
      storage_relative_path TEXT NOT NULL,
      availability          TEXT NOT NULL,
      pruned_at             INTEGER,
      created_at            INTEGER NOT NULL,
      UNIQUE(submission_id, ordinal),
      UNIQUE(submission_id, staging_id)
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_submission_images_submission
      ON workflow_submission_images(submission_id, ordinal);
    CREATE INDEX IF NOT EXISTS idx_workflow_submission_images_availability
      ON workflow_submission_images(availability, created_at, id);

    CREATE TABLE IF NOT EXISTS workflow_submission_evidence_coverage (
      submission_id         TEXT NOT NULL,
      staging_id            TEXT NOT NULL,
      client_criterion_id   TEXT NOT NULL,
      criterion             TEXT NOT NULL,
      proof_class           TEXT NOT NULL,
      repository_scope      TEXT NOT NULL,
      links_json            TEXT NOT NULL,
      generation            INTEGER NOT NULL,
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL,
      PRIMARY KEY(submission_id, client_criterion_id)
    );

    CREATE TABLE IF NOT EXISTS workflow_submission_text_artifacts (
      id                    TEXT PRIMARY KEY,
      submission_id         TEXT NOT NULL,
      staging_id            TEXT NOT NULL,
      ordinal               INTEGER NOT NULL,
      display_name          TEXT NOT NULL,
      caption               TEXT NOT NULL,
      repository_scope      TEXT NOT NULL,
      mime_type             TEXT NOT NULL,
      bytes                 INTEGER NOT NULL,
      sha256                TEXT NOT NULL,
      content               TEXT NOT NULL,
      availability          TEXT NOT NULL,
      pruned_at             INTEGER,
      created_at            INTEGER NOT NULL,
      UNIQUE(submission_id, ordinal),
      UNIQUE(submission_id, staging_id)
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_submission_text_artifacts_submission
      ON workflow_submission_text_artifacts(submission_id, ordinal);
    CREATE INDEX IF NOT EXISTS idx_workflow_submission_text_artifacts_availability
      ON workflow_submission_text_artifacts(availability, created_at, id);

    -- A database-first cleanup ledger makes every body deletion retryable after a crash.
    CREATE TABLE IF NOT EXISTS workflow_image_cleanup (
      id                    TEXT PRIMARY KEY,
      storage_relative_path TEXT NOT NULL UNIQUE,
      trash_relative_path   TEXT,
      state                 TEXT NOT NULL,
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_image_cleanup_state
      ON workflow_image_cleanup(state, created_at, id);

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
      -- Same-submission Check outcomes frozen when a Persona first became runnable.
      check_evidence_json     TEXT,
      -- The Command slot this attempt RESERVED an execution of, or NULL for every attempt
      -- that never reached one. It is the durable claim on a Command's per-run budget, and
      -- it is a slot rather than a flag because the budget belongs to the Command: two check
      -- nodes naming the same slot spend one shared allowance, so the count has to be
      -- answerable without knowing which node asked.
      check_run_slot          TEXT,
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
      event_id     TEXT,
      run_id       TEXT NOT NULL,
      ts           INTEGER NOT NULL,
      event_kind   TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_events_run
      ON workflow_events(run_id, id);
    -- The fleet-wide read: the newest events OF ONE KIND, across every run. The run index
    -- above cannot serve it - it is ordered by run first - so the test_evidence_audit
    -- aggregate would otherwise scan the busiest table this subsystem writes on every poll.
    CREATE INDEX IF NOT EXISTS idx_workflow_events_kind
      ON workflow_events(event_kind, id);

    CREATE TABLE IF NOT EXISTS workflow_submission_readiness_overrides (
      id             TEXT PRIMARY KEY,
      submission_id  TEXT NOT NULL,
      request_id     TEXT NOT NULL UNIQUE,
      actor          TEXT NOT NULL,
      reason         TEXT NOT NULL,
      acknowledged_risk INTEGER NOT NULL CHECK (acknowledged_risk IN (0, 1)),
      created_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_readiness_overrides_submission
      ON workflow_submission_readiness_overrides(submission_id, created_at);

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
      -- Opaque native allocator identity. NULL on every historical provider row.
      lease_id                TEXT,
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
      -- Which ingest wrote the row: 'otel' | 'driver' | 'rollout' | 'report' | 'conductor'.
      -- See the addColumn in migrate() for why this cannot be derived from the columns
      -- beside it, and why '' (the upgrade default) means "predates the column" and nothing
      -- else. APPEND-ONLY - see the persisted-identifier contract.
      --
      -- 'conductor' is the one writer whose subject is not this app: an observed external
      -- pipeline engine, whose per-feature totals are automation spend under nobody's card.
      -- It deliberately has NO backfill arm in migrate(), because the arm above it already
      -- claims every legacy automation row for 'report' and a second claim on the same rows
      -- would relabel history that 'report' did write.
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
      prompted_goal   TEXT,               -- historical intent guard for upgrade bootstrap
      prompted_evidence TEXT,             -- historical evidence guard, compatibility only
      prompted_activity_at INTEGER,       -- historical activity watermark, compatibility only
      prompted_legacy_cutover_generation INTEGER, -- conservative ceiling for ambiguous legacy guards
      prompted_consumed_generation INTEGER, -- latest work-cycle generation handled
      -- The prompted DIRECT SHIPPING latch: which handoff was made, the intent episode
      -- that authorized it, and the generation spent making it. Written only in the same
      -- statement that consumes that generation, so it can never claim a handoff that
      -- was not paid for. See consumePromptedGeneration below.
      prompted_direct_handoff_kind TEXT,
      prompted_direct_handoff_episode TEXT,
      prompted_direct_handoff_generation INTEGER,
      -- WHY the current prompted_consumed_generation stopped where it did, as one
      -- validated JSON payload. One column rather than a scalar group because the record
      -- is all-or-nothing by nature and nothing queries its parts: a partially-written
      -- reason is not a reason, and a column set that could disagree with itself would be
      -- one more thing for a reader to reconcile. See toPromptedDecision below, which
      -- refuses a payload whose logical key or generation is not this row's own.
      prompted_decision TEXT,
      -- Current bounded pre-PR recovery projection. History remains in foreman_episodes.
      prompted_recovery TEXT,
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
      -- Whether Foreman's own settled verdict may conclude the task a run files. Defaulted
      -- rather than nullable, because an upgrading database ALTERs this column in and every
      -- row it lands on was written under the only behaviour that existed: manual.
      completion_policy TEXT NOT NULL DEFAULT 'manual',
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
      completion_policy TEXT NOT NULL DEFAULT 'manual',
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
      -- A failed run remains durable history after the operator has seen it. This timestamp
      -- retires only its attention signal; NULL means the failure has not been acknowledged.
      failure_acknowledged_at INTEGER,
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
      -- Rebuildable prompt detail copied from the verified manifest. Null for bundles that
      -- predate the additive v1 prompt contract and for unreadable rows.
      prompts_json       TEXT,
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
      -- Portable human prompt context frozen at reservation. Null on jobs written before
      -- the prompt contract existed; recovery must not attempt to reconstruct those rows.
      prompts_json    TEXT,
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

    -- Where a scout's conversation STARTED, frozen at the task-delivery seam, plus the
    -- session name that was on the card at that instant. Terminal dispatch and assignment
    -- freeze immediately BEFORE the prompt crosses into the runtime, because the anchor is
    -- the transcript's size right then; embedded dispatch freezes immediately AFTER the
    -- driver starts, because there the prompt IS the start and the anchor is byte zero.
    --
    -- Local capture coordination, exactly like archive_capture_jobs above and on the same
    -- (task, episode) key, so a re-dispatch of the same task is genuinely new work with its
    -- own boundary rather than a second write onto the first attempt's. Not a read model:
    -- nothing renders these rows, and the portable manifest is the durable answer once
    -- capture freezes one.
    --
    -- The two locators are nullable independently, and they answer different questions.
    --
    -- transcript_path is null when no file could be located at freeze time - an embedded
    -- session is created BY this delivery, so there is nothing to name until it writes one.
    -- A collector re-locates it from the live session later; the null is "not yet", not
    -- "gone".
    --
    -- transcript_offset is where this episode BEGINS, and its two values are a real
    -- distinction rather than a fallback. Zero means the episode owns the file from its
    -- first byte, which is the truth whenever the prompt travelled with the process (pi's
    -- positional argument, an embedded session's opening turn) - true whether or not the
    -- path is known yet, so it is recorded either way rather than thrown away for want of a
    -- filename. Null means NO anchor could be established: a delivery into a session that
    -- already held a conversation whose transcript could not be located or measured. A
    -- collector may page from a zero; it must treat a null as completeness it cannot
    -- establish, and say so.
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
    -- transcript turn, never to archive one. A human row keeps its text - trimmed, and
    -- clipped to the per-entry byte bound, which marks the context truncated when it bites -
    -- because it is also the fallback when the transcript is rotated, missing or not yet
    -- flushed.
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

    -- The pipeline projection: what an external SDLC engine's own files say about each
    -- feature it is driving, in the shape the dashboard reads.
    --
    -- A CACHE, in the same family as the three archive index tables above and for the same
    -- reason: every column here is derived from files the engine owns and rewrites, so
    -- deleting this table - or the whole database - costs one refresh pass and nothing else.
    -- Nothing may be stored here that is not already on disk under the engine's control. A
    -- label, an annotation or an operator's own note would be lost the first time the
    -- projection was rebuilt, which is why none may be added: they belong on a task.
    --
    -- It exists at all so that a dashboard connecting before the watcher's first pass sees
    -- the last known truth instead of an empty page, and so that the events tail can resume
    -- at the byte it stopped at rather than re-reading a feature's whole ledger on every
    -- daemon start.
    --
    -- The key is (provider, repo_root, slug): the engine's own identity for a feature. All
    -- three are NOT NULL because the UNIQUE index below is an ON CONFLICT target and SQLite
    -- treats nulls as distinct - two rows for one feature would each be half its history.
    -- The slug is the plan stem, which is the engine's canonical key and not ours; nothing
    -- here mints an id, because a rebuild could not reproduce one.
    CREATE TABLE IF NOT EXISTS pipeline_runs (
      -- An id from PIPELINE_PROVIDER_IDS. Append-only: a row written under a spelling this
      -- build does not know is dropped and re-projected, never guessed at.
      provider      TEXT NOT NULL,
      repo_root     TEXT NOT NULL,
      slug          TEXT NOT NULL,
      -- The serialized PipelineRun. A blob rather than a column per field because every one
      -- of them is re-derived whole on each pass; there is no partial update to express, and
      -- no query here selects on a step's state.
      run_json      TEXT NOT NULL,
      -- Where the events tail stopped in this feature's events.jsonl, in bytes. NOT NULL with
      -- a 0 default, which is exact: a row written before anything was tailed has read none
      -- of it. A file shorter than this offset is a rewritten ledger and restarts at 0.
      events_offset INTEGER NOT NULL DEFAULT 0,
      -- Which FILE that offset is an offset into - dev:ino:birthtime - which changes when
      -- the path is re-created. An offset without it is meaningless across a worktree being
      -- cut again under the same slug, because the replacement is a different file that
      -- happens to sit at the same path. Empty string means "not recorded", which is what
      -- every row written before this column carries - and a nonzero offset beside one is
      -- treated as UNVERIFIABLE rather than as an append: the first pass over such a row
      -- rebuilds from byte zero, because a cursor that cannot be checked is not a cursor.
      events_identity TEXT NOT NULL DEFAULT '',
      updated_at    INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_runs_key
      ON pipeline_runs(provider, repo_root, slug);
    CREATE INDEX IF NOT EXISTS idx_pipeline_runs_repo ON pipeline_runs(provider, repo_root);

    -- The pipeline event ledger: every engine event Mission Control has OBSERVED, from
    -- whichever path observed it first.
    --
    -- Append-only, and the write contract is exact about what that allows: a row's identity,
    -- its ordinal and its body are written once and never rewritten. The single mutation is
    -- also_seq below - the SECOND path to see an event stamping its own coordinate on the row
    -- the first one wrote, NULL to a value, once. That records an observation; it does not
    -- edit an event. Rows are retired only with the run they belong to - a worktree the engine
    -- tore down, or a repository whose consent was withdrawn - plus a per-run cap, so the table
    -- is bounded by the runs that still exist rather than by how long the daemon has been up.
    --
    -- Two writers reach it and they see the same events by two different routes: the file
    -- tail reads each worktree's events.jsonl, and the visualizer plugin pushes over
    -- POST /ingest/conductor. Both are the daemon (the plugin's events arrive as an HTTP
    -- request the daemon serves), so the daemon remains the only SQLite writer.
    --
    -- The key is (provider, repo_root, slug, seq), all NOT NULL because the UNIQUE index is
    -- an INSERT-OR-IGNORE target and SQLite treats nulls as distinct.
    CREATE TABLE IF NOT EXISTS pipeline_events (
      -- An id from PIPELINE_PROVIDER_IDS, as in pipeline_runs. Append-only.
      provider     TEXT NOT NULL,
      repo_root    TEXT NOT NULL,
      slug         TEXT NOT NULL,
      -- MISSION CONTROL'S OWN per-run ordinal, assigned on insert as max+1, never supplied
      -- by a producer. That is a deliberate correction to the obvious design and the reason
      -- is arithmetic: ai-conductor stamps no sequence number on its events, so the tail's
      -- coordinate is a BYTE OFFSET and the plugin's is a counter of its own. Keying on a
      -- producer's number would mean one space where two unrelated ones were being written,
      -- and the failure is silent in both directions - a pushed event whose counter happened
      -- to equal an old byte offset is dropped as a duplicate, and the same event seen twice
      -- under two numbers is stored twice. What each producer said is kept in producer_seq
      -- below; what makes two observations of ONE event converge is fingerprint.
      seq          INTEGER NOT NULL,
      -- The engine's own discriminant (type on the record), or 'unknown' for a record that
      -- names none. Mission Control keeps NO copy of the engine's event union - it is
      -- TypeScript-only, unversioned and 70-odd members long - so every kind is carried
      -- through verbatim and nothing is ever refused for being unrecognised.
      kind         TEXT NOT NULL,
      -- The writer's own ISO-8601 instant. Null when the record carries none, which is a
      -- real case and not a defect: received_at below is always ours.
      ts           TEXT,
      -- 'tail' or 'ingest' - which path saw it FIRST. Diagnostic, and the honest answer to
      -- "is the plugin actually delivering anything".
      source       TEXT NOT NULL,
      -- What that path called it: the byte offset for the tail, the envelope's seq for the
      -- plugin. Kept because it is the producer's own ordering evidence and lets a gap be
      -- noticed; never a key, for the reason seq states.
      producer_seq INTEGER,
      -- The OTHER path's coordinate for the same event, once it has seen it, and NULL until
      -- then. Written once, by convergence, and never changed again.
      --
      -- It is what makes a repeated event survive. Conductor stamps no sequence number, so two
      -- genuine occurrences of one record - a step_started for a step that was retried, a
      -- gate_verdict on a second attempt - are byte-identical and hash alike. Convergence on
      -- the fingerprint ALONE therefore cannot tell "the other path is describing the event I
      -- already have" from "this happened twice", and the ledger used to answer the second by
      -- discarding it. For the 28 kinds conductor never persists this is the only record there
      -- is, so that answer traded away the exact thing the table exists for.
      --
      -- With this column the question is answerable: an event converges onto the oldest row
      -- with its fingerprint that the other path wrote and this path has not yet claimed, and
      -- when there is no such row it is a new occurrence and gets a row of its own. Both paths
      -- see occurrences in order, so the Nth from one lands on the Nth from the other however
      -- they interleave, and neither has to remember anything between batches.
      --
      -- What it costs is stated rather than hidden: a source re-offering an event under a NEW
      -- coordinate - a rewritten events.jsonl whose lines have shifted - is no longer
      -- recognised, and stores a second row for one event. That is the trade taken on purpose.
      -- A duplicate row here is a diagnostic wart and nothing derives from it; a dropped event
      -- is gone.
      also_seq     INTEGER,
      -- sha256 of the record body with its keys in a stable order. The identity of an EVENT
      -- as against the identity of an observation of one, and therefore what makes the two
      -- paths converge on a single row.
      fingerprint  TEXT NOT NULL,
      -- The record itself, verbatim. Opaque by design: this table stores what the engine
      -- said, not this build's reading of it.
      body         TEXT NOT NULL,
      received_at  INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_events_key
      ON pipeline_events(provider, repo_root, slug, seq);
    -- One row per OBSERVATION a path has already recorded: the same path offering the same
    -- event under the same coordinate again cannot mint a second row. The convergence above
    -- is decided in appendPipelineEvents because it needs a claim rather than a comparison;
    -- this index is the backstop under it, so a bug there degrades to an ignored insert rather
    -- than to a ledger that says one event happened twice. Unique alongside the key, so a
    -- plain INSERT OR IGNORE still answers to both without naming a conflict target.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_events_observation
      ON pipeline_events(provider, repo_root, slug, source, fingerprint, producer_seq);

    -- A Mission Control-owned lifecycle that precedes and later links one provider run.
    -- Kept separate from pipeline_runs because this row is durable task state, while that
    -- table is a rebuildable projection of worktrees the provider currently owns.
    CREATE TABLE IF NOT EXISTS pipeline_commissions (
      id             TEXT PRIMARY KEY,
      task_id        TEXT NOT NULL UNIQUE,
      provider       TEXT NOT NULL,
      repo_root      TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      state_json     TEXT NOT NULL,
      active_attempt INTEGER,
      run_slug       TEXT,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_commissions_correlation
      ON pipeline_commissions(provider, correlation_id);
    CREATE INDEX IF NOT EXISTS idx_pipeline_commissions_repo
      ON pipeline_commissions(provider, repo_root);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_commissions_run
      ON pipeline_commissions(provider, repo_root, run_slug) WHERE run_slug IS NOT NULL;

    -- One cursor per provider Engineer run. A successor attempt starts at revision zero and
    -- never rewrites or reopens its predecessor.
    CREATE TABLE IF NOT EXISTS pipeline_commission_attempts (
      commission_id     TEXT NOT NULL,
      attempt           INTEGER NOT NULL CHECK (attempt > 0),
      origin            TEXT,
      launch_key        TEXT NOT NULL,
      engineer_run_id   TEXT,
      previous_engineer_run_id TEXT,
      provider_revision INTEGER NOT NULL DEFAULT 0 CHECK (provider_revision >= 0),
      state             TEXT NOT NULL,
      terminal_reason   TEXT,
      evidence_commit   TEXT,
      evidence_commit_provenance TEXT,
      evidence_frozen_at INTEGER,
      updated_at        INTEGER NOT NULL,
      PRIMARY KEY (commission_id, attempt),
      UNIQUE (commission_id, launch_key),
      UNIQUE (commission_id, engineer_run_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_commission_attempts_engineer_run
      ON pipeline_commission_attempts(engineer_run_id) WHERE engineer_run_id IS NOT NULL;

    -- Bounded opaque evidence. Projection state is reduced in the same transaction, but
    -- unknown kinds remain here without being allowed to mutate it.
    CREATE TABLE IF NOT EXISTS pipeline_commission_events (
      commission_id  TEXT NOT NULL,
      seq            INTEGER NOT NULL,
      engineer_attempt INTEGER,
      provider_revision INTEGER,
      kind           TEXT NOT NULL,
      body           TEXT NOT NULL,
      observed_at    INTEGER NOT NULL,
      PRIMARY KEY (commission_id, seq)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_commission_events_revision
      ON pipeline_commission_events(commission_id, engineer_attempt, provider_revision)
      WHERE engineer_attempt IS NOT NULL AND provider_revision IS NOT NULL;

    -- The task-worktree retention ledger: how long a TERMINAL task's checkouts have gone
    -- without a Git-visible change, and when that makes them reclaimable.
    --
    -- One row per task, and it is the ONLY durable activity clock for this. tasks.updated_at
    -- is not one and cannot be made into one: dependency reconciliation, pull request polling
    -- and title edits all move it without anyone touching a checkout, while an agent editing a
    -- file in a worktree moves nothing on the row at all. So the clock is kept where it can be
    -- derived from the checkouts themselves, and re-derived after a restart.
    --
    -- The row is not created when the task ends. It is created at the FIRST SUCCESSFUL
    -- OBSERVATION of a set of resources, and that is the rollout safety mechanism rather than
    -- laziness: no timestamp this database already holds can prove when a pre-existing tree
    -- was last touched, so every tree that existed before this shipped is seeded at the moment
    -- it is first read and gets one full, final grace period from there.
    CREATE TABLE IF NOT EXISTS task_worktree_retention (
      task_id         TEXT PRIMARY KEY,
      -- The RESOURCE GENERATION this observation was taken against - taskResourceGeneration's
      -- digest over the task's attempt boundary and every cleanup-relevant resource fact. Not a
      -- second source of truth about those facts (nothing reads them back out of it); it is the
      -- answer to one question asked before any write: "is the thing I observed still the thing
      -- the task owns?" A re-dispatch, a reschedule, a replaced path, a re-leased slot or a
      -- released terminal home all change it, and an observation whose generation no longer
      -- matches is discarded rather than carried onto whatever replaced it.
      generation      TEXT NOT NULL,
      -- The aggregate Git-visible fingerprint across every worktree the task owns, combined in
      -- persisted repository-position order. A digest and nothing else: no path, no file
      -- content, no Git output. Comparing it with the next observation's is the whole of "did
      -- anything change".
      fingerprint     TEXT NOT NULL,
      -- When the fingerprint last CHANGED - the activity boundary the 30-day rule counts from.
      -- Seeded at first observation (see above) and reset by any changed fingerprint. An
      -- unknown read never moves it, because "we could not look" is not evidence of quiet.
      last_changed_at INTEGER NOT NULL,
      -- When a successful observation last happened. Diagnostic: it says the clock is being
      -- read, which is the difference between a tree that is genuinely quiet and one nothing
      -- has managed to probe for a week.
      observed_at     INTEGER NOT NULL,
      -- last_changed_at plus the retention window. Stored rather than computed on read so the
      -- boundary a restart resumes from is the one that was actually granted, even if the
      -- window's value ever changes.
      cleanup_due_at  INTEGER NOT NULL,
      -- Everything from here down is Phase 2's claim/retry state, declared now so activating
      -- automatic reclamation needs no second migration. Phase 1 writes 'observing' and NULL
      -- to all of it and never transitions a claim; task-worktree-retention.ts has no
      -- reference to any cleanup path, and its tests assert that.
      cleanup_state   TEXT NOT NULL DEFAULT 'observing',
      claim_token     TEXT,
      claimed_at      INTEGER,
      last_attempt_at INTEGER,
      retry_at        INTEGER,
      -- Bounded internal diagnosis of the last failed observation or cleanup. Truncated on
      -- write, never widened onto the wire, and never the original error MESSAGE - a
      -- filesystem error stringifies to "EACCES: permission denied, open '<path>'", and git
      -- names paths in its diagnostics, so a message written through verbatim would make this
      -- column a record of filenames the ledger otherwise never holds. Producers send a
      -- bounded classification instead; see readFailureClass in git/worktree-activity.ts.
      last_error      TEXT,
      updated_at      INTEGER NOT NULL
    );
    -- Phase 2 selects due rows by time. Cheap, and it keeps that scan off a table walk once a
    -- long-lived install has a row per terminal task it ever ran.
    CREATE INDEX IF NOT EXISTS idx_task_worktree_retention_due
      ON task_worktree_retention(cleanup_due_at);

    -- ---- line comments in the Files workspace ----
    --
    -- A comment anchored to a line of a file a session is working in, and the review queue
    -- those comments form. The rule these three tables enforce is that an anchor is
    -- (path, line range, quoted text) and NOT a line number: the agent edits the file
    -- between deliveries, so a stored number is stale by the time the next comment goes.
    -- That is the Inspector's rule - its fingerprint deliberately excludes the line - applied
    -- to a live working file, and the re-anchor pass is the part it does not have.
    --
    -- Threads are SESSION-SCOPED and end with the session that owns them: session_remove
    -- settles them to orphaned by UPDATE, never by DELETE, and never keyed on
    -- state === 'exited'. See FileCommentManager for the three mechanisms that complete it.
    CREATE TABLE IF NOT EXISTS file_comment_threads (
      id           TEXT PRIMARY KEY,  -- our uuid, minted at the call site
      -- MC-a41f: the stable handle the payload cites, the reply tool takes as its
      -- commentId, and the transcript fallback matches out of free text. Unique PER
      -- SESSION, never global - so every lookup by it is session-scoped, and a lookup
      -- without a session would land a reply on another session's thread.
      short_id     TEXT NOT NULL,
      session_id   TEXT NOT NULL,     -- the session this thread belongs to
      path         TEXT NOT NULL,     -- repository-relative, as the Files tab lists it
      start_line   INTEGER NOT NULL,  -- 1-based, inclusive, in the file's source
      end_line     INTEGER NOT NULL,
      quote        TEXT NOT NULL,     -- the anchored source text, bounded
      quote_hash   TEXT NOT NULL,     -- sha256(path + LF + normalized quote); excludes the line
      revision     TEXT,              -- file revision the anchor was last VALID against
      surface      TEXT NOT NULL,     -- editor | markdown | html
      html_block_path  TEXT,           -- JSON browser-tree path for an HTML preview block
      html_block_quote TEXT,           -- exact source bytes for that HTML element
      -- draft | queued | sending | awaiting | answered | unanswered | resolved | orphaned.
      -- unanswered is outside the outstanding tuple on purpose: auto-advance sends the
      -- next comment while this one has never been answered, and a timed-out thread left
      -- awaiting would collide on the index below and deadlock the queue it protects.
      status       TEXT NOT NULL,
      -- 1 when the quote no longer resolves. A FLAG BESIDE THE STATUS, not one of its
      -- values, and reversible: a thread that goes outdated keeps its place in the review,
      -- and if the quoted text comes back it re-anchors and this clears.
      outdated     INTEGER NOT NULL DEFAULT 0,
      queue_seq    INTEGER,           -- position in the review; NULL once terminal
      -- The correlation pending_turns cannot carry (its row is id/note_key/seq/text/state
      -- and nothing else). It lives here instead, so that table needs no new column, and it
      -- is what lets the walkthrough recognise its own turn in the outbox after a restart.
      delivery_id  TEXT,
      sent_at      INTEGER,
      answered_at  INTEGER,
      addressed_at INTEGER,           -- the agent's "I handled this"; never a closure
      resolved_at  INTEGER,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_file_comment_threads_short
      ON file_comment_threads(session_id, short_id);
    -- The gutter asks "what threads does this file have?" on every open, and the
    -- walkthrough asks "what is this session's queue?" before every send.
    CREATE INDEX IF NOT EXISTS idx_file_comment_threads_session
      ON file_comment_threads(session_id, path);
    -- Deliberately NOT a UNIQUE index on (session_id, queue_seq). The closest analogue
    -- that also reorders is foreman_queue_items, which has none, because a full rewrite
    -- passes through states where two rows share a seq - see the two-pass scratch offset
    -- in reorderFileCommentQueue. pending_turns can afford idx_pending_turns_order only
    -- because it never reorders. Recorded so a later change does not "fix" this.
    CREATE INDEX IF NOT EXISTS idx_file_comment_threads_queue
      ON file_comment_threads(session_id, queue_seq);

    -- The messages of a thread: the opening comment, agent replies, and human follow-ups.
    -- The BODY lives here rather than on the thread, which is what makes a draft a draft -
    -- and what makes updateFileCommentMessageBody's refusal the contract it is.
    CREATE TABLE IF NOT EXISTS file_comment_messages (
      id            TEXT PRIMARY KEY,
      thread_id     TEXT NOT NULL,
      author        TEXT NOT NULL,    -- human | agent
      session_id    TEXT,             -- the session that wrote or received it
      body          TEXT NOT NULL,
      -- When it reached the agent. Stamped from CONFIRMED delivery, never from submitting,
      -- which only enqueues a turn that can still be recalled or turned uncertain.
      delivered_at  INTEGER,
      read_at       INTEGER,          -- when a human read it; NULL while it counts toward the pip
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL  -- editable until delivered or outstanding, frozen after
    );
    CREATE INDEX IF NOT EXISTS idx_file_comment_messages_thread
      ON file_comment_messages(thread_id, created_at);

    -- The walkthrough's run state: one row per session, and a TABLE rather than a derived
    -- value. "Paused" and "never started" are the same set of rows - everything queued,
    -- nothing outstanding - so the walkthrough cannot tell them apart by looking at
    -- threads, and between two comments the outstanding set is briefly empty, which would
    -- make a derived "running" flicker. Keyed by session_id because there is exactly one
    -- review per session and inventing a second id would only create a way to have two.
    CREATE TABLE IF NOT EXISTS file_comment_reviews (
      session_id    TEXT PRIMARY KEY,
      state         TEXT NOT NULL,    -- idle | running | paused
      pause_reason  TEXT,             -- why it stopped; NULL unless paused
      started_at    INTEGER,
      updated_at    INTEGER NOT NULL
    );
  `);
  d.exec(inFlightIndexSql());
  d.exec(outstandingFileCommentIndexSql());
  migrate(d);
  markDatabaseSchemaCurrent(d);
}

/** Close the daemon's singleton connection before releasing state-directory ownership. */
export function closeDb(): void {
  if (!db) return;
  db.close();
  db = undefined;
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
 * One comment outstanding per SESSION, enforced by the database rather than by the
 * walkthrough's bookkeeping. Same argument as `inFlightIndexSql` above: the stakes are a
 * second comment typed into a live agent while the first is still unanswered, which is the
 * one thing one-at-a-time exists to prevent, so this is a constraint and not a comment.
 *
 * The predicate is BUILT from `OUTSTANDING_THREAD_STATUSES` rather than restated here, so
 * the enforcement and its TypeScript readers - `queueFileCommentThread`'s refusal and
 * `updateFileCommentMessageBody`'s freeze - cannot drift apart. `status` is a closed enum
 * of identifiers, so quoting them into SQL is safe by construction.
 */
function outstandingFileCommentIndexSql(): string {
  const states = OUTSTANDING_THREAD_STATUSES.map((s) => `'${s}'`).join(",");
  return `CREATE UNIQUE INDEX IF NOT EXISTS one_outstanding_file_comment
      ON file_comment_threads(session_id) WHERE status IN (${states});`;
}

/**
 * Schema migrations, run once per open after the CREATE TABLEs. Each must be
 * idempotent - this block runs on every start, not just on an upgrade.
 */
function migrate(d: DatabaseSync): void {
  migrateWorktreeOrdinalHighWater(d);

  // HTML preview comments originally persisted only a line-wide quote. When compact HTML
  // puts several elements on one line, that cannot distinguish a paragraph from its inline
  // child. Existing rows remain nullable and keep the legacy resolver; new rows carry the
  // server-validated browser path plus the exact element source used to validate it.
  addColumn(d, "file_comment_threads", "html_block_path", "TEXT");
  addColumn(d, "file_comment_threads", "html_block_quote", "TEXT");

  // Which file each pipeline run's events offset indexes into. Added after `pipeline_runs`
  // shipped, so an existing row carries the empty-string default - which is exact: those
  // rows were written by a build that recorded no identity. The tail treats an empty
  // identity beside a NONZERO offset as an unverifiable cursor and rebuilds that run from
  // byte zero once, which costs one extra read and recomputes the token total from the
  // ledger rather than trusting a figure accumulated by a build that could not tell a
  // replaced ledger from an appended one.
  addColumn(d, "pipeline_runs", "events_identity", "TEXT NOT NULL DEFAULT ''");

  // The other path's coordinate for an event this one already recorded. Nullable with no
  // default, which is exact for every existing row: a build without this column recorded no
  // second observation, so "the other path has not been seen here" is the truth about all of
  // them - and it leaves each of those rows claimable, which is what lets a ledger written by
  // that build converge normally from the next pass on.
  addColumn(d, "pipeline_events", "also_seq", "INTEGER");
  // And the index that used to make a repeated event impossible. Dropped rather than left
  // beside its replacement: while it exists, the second occurrence of a byte-identical event
  // is still refused by SQLite before `appendPipelineEvents` can store it, so an upgraded
  // database would keep the defect the column above exists to fix.
  d.exec(`DROP INDEX IF EXISTS idx_pipeline_events_identity`);

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
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_workflow_deliveries_transcript_attribution
      ON workflow_deliveries(session_id, note_key, delivered_at DESC)
      WHERE delivered_at IS NOT NULL AND payload_pruned_at IS NULL;
  `);
  // Per-run operator-disabled verdict nodes (auto-pass). Nullable with no default: a run
  // written before the column existed genuinely had nothing disabled, and NULL is exactly
  // that. It lives on the run rather than the immutable version because the disable is
  // scoped to one run and must never leak into other runs of the same published workflow.
  addColumn(d, "workflow_runs", "disabled_nodes_json", "TEXT");
  // Persistent operator feedback for Persona nodes is run-scoped and editable. Historical
  // attempts snapshot the bytes they used separately, so changing this active set never
  // rewrites a completed review.
  addColumn(d, "workflow_runs", "persona_directives_json", "TEXT");

  // ---- Command run budgets ------------------------------------------------------------
  //
  // How many times one Command may execute inside a single run. NOT NULL DEFAULT 1 gives an
  // upgrading catalog the same budget a fresh install gets - deliberately a behaviour change,
  // since a gate that re-ran on every repair round is the cost this bounds - and it needs no
  // backfill because the default IS the migrated value for every existing slot.
  addColumn(d, "workflow_commands", "max_runs", "INTEGER NOT NULL DEFAULT 1");
  // One attempt's claim on a Command's per-run execution budget. Nullable with no default and
  // no backfill: an attempt written before this column existed reserved nothing, and inventing
  // a reservation for it would spend a budget against work whose cost is already paid.
  addColumn(d, "workflow_node_attempts", "check_run_slot", "TEXT");
  // Where the run's command budget starts counting from, as a repair round number.
  //
  // Nullable with no default, and the two absences mean the same thing on purpose: a run
  // written before this column existed, and a run nobody has granted rounds to, both count
  // every execution the run has ever made. A grant or a full restart writes the round its
  // new submission will carry, which is what makes those two escape hatches able to buy a
  // real re-validation instead of handing an operator more rounds that all skip the gate.
  addColumn(d, "workflow_runs", "check_budget_epoch_round", "INTEGER");

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
  // Phase 2 image evidence. Empty evidence groups preserve historical rows without
  // inventing a completion boundary, and generation zero means no staged set was observed.
  addColumn(d, "workflow_submissions", "evidence_group_key", "TEXT NOT NULL DEFAULT ''");
  addColumn(d, "workflow_submissions", "staged_image_generation", "INTEGER NOT NULL DEFAULT 0");
  // The same capture hashed without its transcript anchor, so "has the work changed since the
  // round that asked for a fix?" stops being answered by the submission's identity. Nullable
  // with no default and no backfill on purpose: a row written before this column existed has
  // no such hash, and inventing one would be inventing a comparison. The unchanged-evidence
  // guard falls back to the full fingerprint for those rows, which is exactly what it did
  // before, so an upgraded database keeps its historical behaviour on historical rows.
  addColumn(d, "workflow_submissions", "repository_fingerprint", "TEXT");
  addColumn(d, "workflow_evidence_owners", "all_generation", "INTEGER NOT NULL DEFAULT 0");
  // Existing staged rows are images. The append-only kind lets text/log evidence share the
  // reservation and generation lifecycle without changing any historical row's meaning.
  addColumn(d, "workflow_evidence_staging", "evidence_kind", "TEXT NOT NULL DEFAULT 'image'");
  // Direct command evidence uses the same reservation lifecycle as path-backed logs, but the
  // bounded content is already present at registration and therefore must survive until capture.
  // NULL means every historical row and every path/image source exactly as before.
  addColumn(d, "workflow_evidence_staging", "inline_content", "TEXT");
  // Command status is structured evidence metadata. Keeping it beside the immutable content
  // prevents compaction from reverse-parsing a human-readable retained artifact.
  addColumn(d, "workflow_evidence_staging", "command_exit_code", "INTEGER");
  // Evidence belongs to the resolved human-intent episode current at registration.
  // NULL preserves legacy rows and unresolved intent without inventing provenance.
  addColumn(d, "workflow_evidence_staging", "episode_key", "TEXT");
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
    CREATE INDEX IF NOT EXISTS idx_workflow_submissions_evidence_group
      ON workflow_submissions(evidence_group_key, run_id);
  `);

  // Un-strand runs parked in the phase a string interpolation invented.
  //
  // The GitHub Inspector gate built its entry phase as `inspector_${waitReason}`, and one of
  // those reasons is itself `inspector_disabled` - so a run that reached the gate while
  // GitHub Inspector was switched off was written as `inspector_inspector_disabled`. Both
  // routes back into a blocked gate test for `inspector_disabled` exactly, so those runs are
  // permanently stopped: re-enabling GitHub Inspector never re-evaluates them and Recheck
  // refuses them. The writer is fixed; this is the rows it already wrote, and it must run here
  // because nothing else will ever look at them again.
  //
  // Narrow on purpose - one exact phase, one exact replacement, and the status is left alone,
  // because `blocked` is what a gate parked behind a disabled GitHub Inspector genuinely is.
  d.exec(`
    UPDATE workflow_runs
       SET current_phase = 'inspector_disabled'
     WHERE current_phase = 'inspector_inspector_disabled';
  `);

  // The action a waiting attempt is executing, frozen from the run's immutable version.
  addColumn(d, "workflow_node_attempts", "session_action_snapshot_json", "TEXT");
  // The exact active directive a Persona attempt claimed. Nullable means no feedback was
  // active at claim time; retries of the same attempt retain a non-null snapshot.
  addColumn(d, "workflow_node_attempts", "operator_directive_json", "TEXT");
  addColumn(d, "workflow_node_attempts", "check_evidence_json", "TEXT");

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
  // Acknowledging a failed run is deliberately separate from deletion: historical rows begin
  // unacknowledged, and the nullable timestamp records the operator action without changing the
  // terminal status or touching any artifacts.
  addColumn(d, "ensemble_runs", "failure_acknowledged_at", "INTEGER");

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
  // `backlog_rank`: the operator's backlog order, and the only one - see
  // `docs/plans/backlog-manual-order/plan.md`. Nullable rather than defaulted, because
  // there is no honest default: a rank is a position among the OTHER backlog rows, which a
  // column default cannot express. `addColumn` returning true is the repo's established
  // one-time-backfill hook (`migrateTaskHomeName` is the worked example), and the backfill
  // is what makes upgrade day invisible: today's backlog is numbered in the order the board
  // was already drawing it.
  if (addColumn(d, "tasks", "backlog_rank", "INTEGER")) backfillBacklogRank(d);
  // Beside its column and never in the CREATE TABLE block above - that block is
  // `IF NOT EXISTS`, so it does not run on an existing database and this statement would
  // reference a column the ALTER had not added yet. The pair is what the ordered read wants.
  d.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_backlog_rank ON tasks(status, backlog_rank);`);
  // Deliberately NOT gated on `addColumn`'s return. The backfill runs exactly once, and a
  // row can lose its rank long after it - an older build opening this database writes NULL
  // into the column it does not know about, a restored or hand-edited row can carry
  // anything. An unranked row does not sort harmlessly to the bottom; it pushes every task
  // filed after it above itself (see `appendRank`). One repair, at every start, and a
  // SELECT-and-nothing-else once the backlog is clean.
  //
  // `repairBacklogRanks`, which HEALS the rows that have no rank and touches nothing else.
  // It cannot renumber the column - a repair with no room reports that instead - because
  // reaching for the full renormalize here would quietly undo the operator's spacing on a
  // start that happened to find one NULL row.
  repairBacklogRanks(d);
  addColumn(d, "tasks", "terminal_resource_id", "TEXT");
  // The exact backend an explicitly configured dispatch used. Nullable with no backfill:
  // every historical row used Automatic, and preserving that answer keeps its existing
  // multi-backend liveness and cleanup policy intact.
  addColumn(d, "tasks", "home_backend", "TEXT");
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
  // The completion guardrail, added to the schedule and to every immutable revision for the
  // same reason the other three policies live on both: the schedule row is what the next tick
  // reads, and the revision row is what explains a decision already taken.
  //
  // NOT NULL DEFAULT 'manual' rather than nullable, and the default is the load-bearing half.
  // `readPolicies` fails a schedule CLOSED on any policy value it cannot read, so a NULL here
  // would take every mission an operator already owns off the clock on the first start after
  // an upgrade - and 'manual' is not a placeholder, it is exactly what those missions have
  // always done.
  addColumn(d, "mission_schedules", "completion_policy", "TEXT NOT NULL DEFAULT 'manual'");
  addColumn(
    d,
    "mission_schedule_revisions",
    "completion_policy",
    "TEXT NOT NULL DEFAULT 'manual'",
  );
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

  // `prompted_goal`: the historical resolved-intent guard used before prompted
  // completion consumed work-cycle generations. It remains readable for one-time
  // compatibility bootstrap and is no longer written by current completion paths.
  // Same exposure as the two ALTERs above: added to the CREATE TABLE after
  // `foreman_queues` shipped, and CREATE TABLE IF NOT EXISTS will not add a column to
  // an existing table, so without this every queue write on an upgraded db would fail.
  //
  // Nullable with no default: NULL means no legacy guard needs compatibility handling.
  addColumn(d, "foreman_queues", "prompted_goal", "TEXT");

  // `prompted_evidence`: the historical proof axis paired with `prompted_goal`.
  // Current completion claims carry their own evidence fingerprint, while lifecycle
  // selection reads only `prompted_consumed_generation`. Keep the column readable for
  // wire and database compatibility; do not revive it as a fallback trigger.
  addColumn(d, "foreman_queues", "prompted_evidence", "TEXT");

  // The historical activity watermark paired with `prompted_evidence`. Retained only
  // for compatibility after the work-cycle cutover.
  addColumn(d, "foreman_queues", "prompted_activity_at", "INTEGER");

  // Very old prompted guards predate the immutable activity watermark. Their queue
  // `updated_at` can move after later work and therefore cannot identify what the guard
  // actually retired. Record the current settled generation as a conservative cutover
  // ceiling instead: it cannot be claimed, while a later generation naturally re-arms.
  addColumn(d, "foreman_queues", "prompted_legacy_cutover_generation", "INTEGER");

  // The current prompted completion guard. A generation is meaningful only beside the
  // `session_work_cycles` row for this queue's logical note key. NULL means no completed
  // generation has been consumed yet; legacy rows are bootstrapped lazily only when their
  // historical `prompted_goal` still matches the resolved intent.
  addColumn(d, "foreman_queues", "prompted_consumed_generation", "INTEGER");

  // The prompted direct-shipping latch. `prompted_consumed_generation` answers "has this
  // settled completion been handled", which by design re-arms on the NEXT generation so a
  // background task notification or an item-less Workflow repair packet can complete under
  // unchanged human intent. Direct shipping cannot use that guard: the instruction it types
  // is itself what produces the next generation, so a generation-only guard re-arms on the
  // turn it caused and types the instruction again.
  //
  // These three columns record the handoff against the human INTENT EPISODE instead. NULL on
  // every upgraded row, which is the truthful answer for a queue written before the latch
  // existed: no handoff is recorded, so the exact-payload Goal guard in
  // `decidePromptedWrapup` remains the compatibility backstop for one already-shipped
  // episode, exactly as it was before this column.
  addColumn(d, "foreman_queues", "prompted_direct_handoff_kind", "TEXT");
  addColumn(d, "foreman_queues", "prompted_direct_handoff_episode", "TEXT");
  addColumn(d, "foreman_queues", "prompted_direct_handoff_generation", "INTEGER");

  // The prompted completion REASON for the current consumed generation.
  //
  // `prompted_consumed_generation` says a settled completion was handled and deliberately
  // says nothing about how, which is what made a false hold invisible: the generation was
  // spent, every later tick skipped it as handled, and what the verifier believed was
  // missing existed only in a log line. This column keeps that reason durable.
  //
  // Nullable with no default, and NULL is the truthful answer for a row written before the
  // column existed: consumed, reason unknown. That is deliberately NOT the same as fresh
  // work - `prompted_consumed_generation` remains the replay guard - so an upgrade cannot
  // re-run a spent generation merely because nobody recorded why it stopped.
  addColumn(d, "foreman_queues", "prompted_decision", "TEXT");

  // Current pre-PR ship recovery claim. One validated JSON object because every field is
  // one CAS identity and a partial scalar group has no safe interpretation.
  addColumn(d, "foreman_queues", "prompted_recovery", "TEXT");

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

  // A blocking MCP request is only a transport, not durable ownership of the answer. Once
  // its host cancels the request, `mcp_wait_detached_at` records that a later human answer
  // must leave through the pending-turn outbox instead. `continuation_queued_at` is the
  // transaction guard that makes that handoff idempotent across daemon restarts.
  addColumn(d, "reviews", "mcp_wait_detached_at", "INTEGER");
  addColumn(d, "reviews", "continuation_queued_at", "INTEGER");

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
  // The provider-run identity learned after a pipeline dispatch's first child agent appears.
  // Both nullable with no default: old and non-pipeline tasks have no provider lifecycle to
  // follow, and a half-written pair fails closed when the row is read.
  addColumn(d, "tasks", "pipeline_provider", "TEXT");
  addColumn(d, "tasks", "pipeline_slug", "TEXT");
  addColumn(d, "tasks", "pipeline_commission_id", "TEXT");
  addColumn(d, "pipeline_commission_attempts", "previous_engineer_run_id", "TEXT");
  addColumn(d, "pipeline_commission_attempts", "terminal_reason", "TEXT");
  addColumn(d, "pipeline_commission_attempts", "origin", "TEXT");
  addColumn(d, "pipeline_commission_attempts", "evidence_commit", "TEXT");
  addColumn(d, "pipeline_commission_attempts", "evidence_commit_provenance", "TEXT");
  addColumn(d, "pipeline_commission_attempts", "evidence_frozen_at", "INTEGER");
  // A provider-owned authoring checkout is visibility state, not a daemon-owned worktree.
  // Keeping it out of `worktree_path` prevents cleanup from reclaiming another tool's tree.
  addColumn(d, "tasks", "pipeline_workspace_path", "TEXT");
  // The primary repo's baseline for multi-repo tasks. Nullable with no default because
  // that is the honest reading of an existing row: nothing recorded where its branch was
  // cut, and a fabricated value would be indistinguishable from a measured one to every
  // rule that later compares a head against it. `task_repos` needs no entry here - a new
  // TABLE is covered by the CREATE TABLE IF NOT EXISTS block, which runs on every open.
  addColumn(d, "tasks", "base_sha", "TEXT");
  addColumn(d, "tasks", "worktree_lease_id", "TEXT");
  addColumn(d, "task_repos", "worktree_lease_id", "TEXT");

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
  // Criterion readiness remains disabled for every historical draft and version. The enum is
  // frozen now so the enforcement phase can consume it without rewriting old rows.
  addColumn(
    d,
    "workflow_definitions",
    "evidence_readiness_policy",
    "TEXT NOT NULL DEFAULT 'off'",
  );
  addColumn(
    d,
    "workflow_versions",
    "evidence_readiness_policy",
    "TEXT NOT NULL DEFAULT 'off'",
  );
  addColumn(d, "workflow_submissions", "readiness_json", "TEXT");
  addColumn(d, "workflow_submissions", "refinement_reason", "TEXT");
  addColumn(d, "workflow_events", "event_id", "TEXT");
  // Pre-release Phase 2 checkouts could already have written an override row without the
  // acknowledgement field. Keep those rows readable as historical unacknowledged actions;
  // every request accepted by this build must explicitly write true.
  addColumn(
    d,
    "workflow_submission_readiness_overrides",
    "acknowledged_risk",
    "INTEGER NOT NULL DEFAULT 0 CHECK (acknowledged_risk IN (0, 1))",
  );
  d.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_events_event_id
            ON workflow_events(event_id) WHERE event_id IS NOT NULL;`);

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
  addColumn(d, "workflow_check_leases", "lease_id", "TEXT");

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
  // Nullable with no backfill, and both halves of that are the design. The value is a
  // fingerprint of the prompt that was delivered, which is deliberately not stored, so an
  // existing row cannot be recomputed - and a guessed one would suppress a real instruction.
  // A marker written before this column simply cannot recognize its echo, which is the
  // behaviour that shipped without it.
  addColumn(d, "session_launch_turns", "echo_fingerprint", "TEXT");
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

  // Prompt context is additive in both places. The capture row is immutable recovery
  // coordination; the archive row is a disposable projection rebuilt from manifests.
  // Null means the row predates prompt retention, never an empty conversation inferred now.
  addColumn(d, "archive_capture_jobs", "prompts_json", "TEXT");
  addColumn(d, "archives", "prompts_json", "TEXT");

  rebuildInFlightIndexIfStale(d);
  rebuildOutstandingFileCommentIndexIfStale(d);
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
  rebuildDerivedPartialIndexIfStale(
    d,
    "one_inflight_per_queue",
    IN_FLIGHT_ITEM_STATES,
    inFlightIndexSql,
    "single-flight",
  );
}

/**
 * The same rebuild for the line-comment outstanding index, for the same reason and with the
 * same failure posture.
 *
 * It exists BEFORE any phase widens the tuple, deliberately: the outstanding-status tuple
 * is a declared cross-phase contract that no later phase may widen, and this is what makes
 * that rule survivable rather than a comment - a build that did widen it would otherwise
 * ship a database still enforcing the old predicate while every TypeScript reader used the
 * new one.
 */
function rebuildOutstandingFileCommentIndexIfStale(d: DatabaseSync): void {
  rebuildDerivedPartialIndexIfStale(
    d,
    "one_outstanding_file_comment",
    OUTSTANDING_THREAD_STATUSES,
    outstandingFileCommentIndexSql,
    "one-outstanding",
  );
}

/**
 * Shared body for the two partial unique indices whose predicate is DERIVED from a
 * TypeScript tuple. The long-form rationale is on `rebuildInFlightIndexIfStale` above; the
 * three properties worth restating where the code is:
 *
 * - `CREATE UNIQUE INDEX IF NOT EXISTS` leaves an EXISTING index untouched, so deriving
 *   the SQL only makes the index agree with its readers on a fresh database. Without this,
 *   the drift the shared constant prevents is merely deferred to upgrade time.
 * - The TRANSACTION is load-bearing, not tidy. DDL is transactional in SQLite; without it
 *   the DROP commits alone, the CREATE fails on rows that already violate the new
 *   predicate, and the table is left with NO index - after which the next `openDb()` runs
 *   the same CREATE against the same rows, throws uncaught, and the daemon refuses to
 *   start. Rolling back keeps the old index, so the CREATE stays a no-op and it opens.
 * - Failing is REPORTED, never fatal. Widening a set can legitimately surface rows that
 *   already violate it, and that is worth saying rather than worth bricking every start.
 */
function rebuildDerivedPartialIndexIfStale(
  d: DatabaseSync,
  name: string,
  want: readonly string[],
  sql: () => string,
  label: string,
): void {
  const row = d
    .prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name=?`)
    .get(name) as { sql: string | null } | undefined;
  if (!row?.sql) return;
  // SQLite stores the CREATE text with `IF NOT EXISTS` stripped, so compare the one
  // thing that carries meaning: which states the WHERE clause names.
  const stored = new Set([...row.sql.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
  const wanted = new Set<string>(want);
  if (stored.size === wanted.size && [...wanted].every((s) => stored.has(s))) return;
  try {
    d.exec("BEGIN IMMEDIATE;");
    d.exec(`DROP INDEX ${name};`);
    d.exec(sql());
    d.exec("COMMIT;");
  } catch (err) {
    // Put the old index back. Swallowing a rollback failure is deliberate: the
    // original error is the one worth reporting, and masking it with "cannot
    // rollback - no transaction is active" would bury the actual cause.
    try {
      d.exec("ROLLBACK;");
    } catch {}
    console.error(
      `[db] could not rebuild ${name} (rows may already violate ` +
        `${label}); keeping the previous index: ${String(err)}`,
    );
  }
}

/**
 * Preserve every native slot ordinal ever issued, including after its row is pruned.
 *
 * The backfill is intentionally idempotent rather than conditional on ADD COLUMN. A build
 * interrupted between an older branch adding the column and filling it can therefore recover,
 * while MAX never lowers a high-water mark after the highest live row has been deleted.
 */
function migrateWorktreeOrdinalHighWater(d: DatabaseSync): void {
  d.exec("BEGIN IMMEDIATE;");
  try {
    addColumn(d, "worktree_pools", "ordinal_high_water", "INTEGER NOT NULL DEFAULT 0");
    d.exec(`
      UPDATE worktree_pools
         SET ordinal_high_water = MAX(
           ordinal_high_water,
           COALESCE((
             SELECT MAX(s.ordinal) FROM worktree_slots s WHERE s.pool_id = worktree_pools.id
           ), 0)
         );
    `);
    d.exec("COMMIT;");
  } catch (error) {
    try {
      d.exec("ROLLBACK;");
    } catch {}
    throw error;
  }
}

/**
 * Number today's backlog the first time `backlog_rank` exists, in the order the board was
 * already drawing - most urgent first, oldest first inside a priority - so an operator who
 * upgrades into manual ordering sees exactly the column they saw yesterday, and only then
 * starts rearranging it.
 *
 * Runs once, hung off `addColumn`'s did-it-add return. A row that loses its rank LATER is
 * not this function's problem and cannot be: see the unconditional `repairBacklogRanks`
 * call at the call site.
 *
 * The `CASE` is a hand-copy of `PRIORITY_RANK`/`UNSET_RANK` from `src/shared/task.ts` into
 * SQL - `blocker` 4, `high` 3, `med` 2, unset 1, `low` 0, with unset deliberately ABOVE
 * `low` - because `byPriorityThenAge` cannot be called from inside a SQL statement and
 * loading the whole backlog to sort it in JS would be a second ordering to keep in step.
 * Nothing but a test will notice the two drifting, so `test/backlog-rank.test.ts` asserts
 * they agree for every priority including unset. Ties break on `created_at` then `id`, the
 * same total order the comparator uses, so the numbering is deterministic.
 */
function backfillBacklogRank(d: DatabaseSync): void {
  d.exec(`
    WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (
        ORDER BY CASE priority
                   WHEN 'blocker' THEN 4
                   WHEN 'high' THEN 3
                   WHEN 'med' THEN 2
                   WHEN 'low' THEN 0
                   ELSE 1
                 END DESC,
                 created_at ASC,
                 id ASC
      ) AS n
      FROM tasks WHERE status = 'backlog'
    )
    UPDATE tasks SET backlog_rank = (SELECT n FROM ranked WHERE ranked.id = tasks.id) * ${RANK_STEP}
    WHERE id IN (SELECT id FROM ranked);
  `);
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
  mcp_wait_detached_at: number | null;
  continuation_queued_at: number | null;
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

/**
 * Record that the MCP host stopped waiting for this review's tool result.
 *
 * Idempotent because cancellation can be observed both by the MCP child and by startup
 * recovery. The first timestamp is the useful one: it says when the direct result channel
 * ceased to be authoritative.
 */
export function markReviewWaitDetached(id: string, at: number): ReviewItem | null {
  const d = openDb();
  d.prepare(
    `UPDATE reviews
        SET mcp_wait_detached_at = COALESCE(mcp_wait_detached_at, ?)
      WHERE id = ?`,
  ).run(at, id);
  const row = d.prepare(`SELECT * FROM reviews WHERE id = ?`).get(id) as unknown as
    | ReviewRow
    | undefined;
  return row ? rowToReview(row) : null;
}

/** Human answers that have lost their MCP result channel and still need a session turn. */
export function loadReviewContinuationCandidates(id?: string): ReviewItem[] {
  const suffix = id === undefined ? "" : " AND id = ?";
  const rows = openDb()
    .prepare(
      `SELECT * FROM reviews
        WHERE mcp_wait_detached_at IS NOT NULL
          AND continuation_queued_at IS NULL
          AND resolved_by = 'human'
          AND status IN ('approved', 'rejected', 'answered', 'dismissed')${suffix}
        ORDER BY resolved_at ASC, created_at ASC`,
    )
    .all(...(id === undefined ? [] : [id])) as unknown as ReviewRow[];
  return rows.map(rowToReview);
}

/**
 * Atomically hand one detached review answer to the durable human-turn outbox.
 *
 * The review stamp and pending-turn insert are one transaction. A daemon crash can leave
 * neither or both, never a review claiming delivery with no queued turn and never two turns
 * for one review after startup reconciliation retries it.
 */
export function createReviewContinuationPendingTurn(input: {
  reviewId: string;
  noteKey: string;
  text: string;
  now: number;
}): PendingTurn | null {
  const d = openDb();
  d.exec("BEGIN IMMEDIATE");
  try {
    const eligible = d
      .prepare(
        `SELECT 1 AS present FROM reviews
          WHERE id = ?
            AND mcp_wait_detached_at IS NOT NULL
            AND continuation_queued_at IS NULL
            AND resolved_by = 'human'
            AND status IN ('approved', 'rejected', 'answered', 'dismissed')`,
      )
      .get(input.reviewId) as unknown as { present: number } | undefined;
    if (!eligible) {
      d.exec("COMMIT");
      return null;
    }
    const sequence = d
      .prepare(`SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM pending_turns WHERE note_key = ?`)
      .get(input.noteKey) as unknown as { seq: number };
    const pendingTurnId = `review-continuation:${input.reviewId}`;
    d.prepare(
      `INSERT INTO pending_turns
         (id, note_key, seq, text, state, revision, created_at, updated_at, claimed_at, last_error)
       VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, NULL, NULL)`,
    ).run(pendingTurnId, input.noteKey, sequence.seq, input.text, input.now, input.now);
    d.prepare(`UPDATE reviews SET continuation_queued_at = ? WHERE id = ?`).run(
      input.now,
      input.reviewId,
    );
    d.exec("COMMIT");
    return {
      id: pendingTurnId,
      noteKey: input.noteKey,
      seq: sequence.seq,
      text: input.text,
      state: "queued",
      revision: 0,
      createdAt: input.now,
      updatedAt: input.now,
      claimedAt: null,
      lastError: null,
    };
  } catch (error) {
    try {
      d.exec("ROLLBACK");
    } catch {}
    throw error;
  }
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

/**
 * Has this session had at least one review a HUMAN settled?
 *
 * The existence half of `loadHumanResolvedReviews`, and it exists because retro worthiness
 * asks a yes/no question that the conversation query answers by materializing up to 500 rows
 * with every column on them. This runs once per session the Registry newly introduces - a
 * daemon restart is the case it is for, since a human decision made yesterday is still the
 * evidence that this session was steered - so the row bodies would be read and thrown away.
 *
 * The filter is spelled from the SAME `HUMAN_REVIEW_STATUSES` set for the same reason the
 * conversation query is: two hand-written status lists drift, and the drift would be a
 * session that replays your answer in its log while claiming nobody steered it. `resolved_by`
 * is asserted rather than inferred from the status, exactly as `isHumanResolvedReview` does -
 * Foreman settles reviews through the same route the dashboard does, and its decisions are
 * not human steering.
 *
 * `SELECT 1 ... LIMIT 1` over the existing `idx_reviews_session` index, so no migration and
 * no new index are needed for it.
 */
export function hasHumanResolvedReview(sessionId: string): boolean {
  const statuses = [...HUMAN_REVIEW_STATUSES];
  return Boolean(
    openDb()
      .prepare(
        `SELECT 1 FROM reviews
          WHERE session_id = ?
            AND resolved_by = 'human'
            AND status IN (${statuses.map(() => "?").join(", ")})
          LIMIT 1`,
      )
      .get(sessionId, ...statuses),
  );
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

interface WorkCycleRow {
  logical_key: string;
  generation: number;
  active: number;
  completed_at: number | null;
  updated_at: number;
}

function rowToWorkCycle(row: WorkCycleRow): WorkCycleSummary {
  return {
    logicalKey: row.logical_key,
    generation: row.generation,
    active: row.active === 1,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

/** Latest durable lifecycle state for one logical conversation, if any was observed. */
export function workCycleFor(logicalKey: string): WorkCycleSummary | null {
  const row = openDb()
    .prepare(`SELECT * FROM session_work_cycles WHERE logical_key = ?`)
    .get(logicalKey) as unknown as WorkCycleRow | undefined;
  return row ? rowToWorkCycle(row) : null;
}

/**
 * Arm a logical conversation after normalized work activity.
 *
 * Repeated activity keeps the same generation. The write time still moves because it is
 * the current-state projection's latest observation, not a completion identity.
 */
export function markWorkCycleActive(logicalKey: string, updatedAt: number): WorkCycleSummary {
  openDb()
    .prepare(
      `INSERT INTO session_work_cycles
         (logical_key, generation, active, completed_at, updated_at)
       VALUES (?, 0, 1, NULL, ?)
       ON CONFLICT(logical_key) DO UPDATE SET
         active = 1,
         updated_at = excluded.updated_at`,
    )
    .run(logicalKey, updatedAt);
  return workCycleFor(logicalKey)!;
}

/**
 * Complete an armed cycle, advancing its generation once.
 *
 * A turn end with no prior work is a no-op. No row is created for idle/end noise, and an
 * existing inactive row is returned unchanged so duplicate turn ends stay on one generation.
 */
export function completeWorkCycle(
  logicalKey: string,
  completedAt: number,
  updatedAt: number,
): WorkCycleSummary | null {
  openDb()
    .prepare(
      `UPDATE session_work_cycles
          SET generation = generation + 1,
              active = 0,
              completed_at = ?,
              updated_at = ?
        WHERE logical_key = ? AND active = 1`,
    )
    .run(completedAt, updatedAt, logicalKey);
  return workCycleFor(logicalKey);
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
    surface:
      r.surface === "input-review" || r.surface === "pipeline" ? r.surface : "terminal",
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

/** Whether a synthetic or live note key already owns this episode marker. */
export function foremanEpisodeExists(noteKey: string, marker: string): boolean {
  return Boolean(
    openDb()
      .prepare(`SELECT 1 FROM foreman_episodes WHERE note_key = ? AND marker = ? LIMIT 1`)
      .get(noteKey, marker),
  );
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
  // `unknown`, not `number | null`: the column is bare INTEGER affinity, so anything a
  // build or a hand edit wrote is what comes back. `rowToTask` validates rather than casts.
  backlog_rank: unknown;
  model: string | null;
  effort: string | null;
  workflow_id: string | null;
  source_id: string | null;
  external_id: string | null;
  source_url: string | null;
  repo_root: string;
  pipeline_provider: string | null;
  pipeline_slug: string | null;
  pipeline_commission_id: string | null;
  pipeline_workspace_path: string | null;
  worktree_path: string | null;
  branch: string | null;
  provider: string | null;
  worktree_lease_id: string | null;
  base_sha: string | null;
  home_name: string | null;
  home_backend: string | null;
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
  worktree_lease_id: string | null;
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
    worktreeLeaseId: r.worktree_lease_id,
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
 * a set of worktrees whose durable owners would silently disappear.
 */
function rowsToTasks(rows: TaskRow[]): Task[] {
  if (rows.length === 0) return [];
  const byTask = taskReposByTask();
  // One query for the whole batch, exactly as the repos are, and for the same reason: a
  // per-task read here would be an N+1 on every `listTasks`, and this runs on the snapshot
  // every browser gets on connect. The map is almost always empty - only a task whose
  // automatic cleanup is mid-retry has a row that projects to anything.
  const cleanup = taskAutomaticCleanupSummaries(rows.map((r) => r.id));
  return rows.map((r) => rowToTask(r, byTask.get(r.id) ?? [], cleanup.get(r.id) ?? null));
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
function rowToTask(
  r: TaskRow,
  extraRepos: TaskRepoEntry[],
  automaticCleanup: TaskAutomaticCleanup | null = null,
): Task {
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
    // Validated, not cast, for the reason `kind` above is - but with a stricter question,
    // because this value is ARITHMETIC downstream. `typeof === "number"` is not enough: a
    // REAL, a fraction and `NaN` all satisfy it, and each would poison the allocator that
    // reads `max(backlog_rank)` and adds a step to it. Anything else reads as unranked,
    // which sorts last and is what `healUnranked` then places properly.
    //
    // This protects what the daemon SERVES and nothing more: the allocator asks the column
    // directly through `backlogRankRows` and never comes through here, which is why the
    // write path carries the same check rather than trusting this one.
    backlogRank: Number.isSafeInteger(r.backlog_rank) ? (r.backlog_rank as number) : null,
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
    pipelineRun:
      r.pipeline_provider && isPipelineProviderId(r.pipeline_provider) && r.pipeline_slug
        ? { provider: r.pipeline_provider, repoRoot: r.repo_root, slug: r.pipeline_slug }
        : null,
    pipelineCommissionId: r.pipeline_commission_id,
    pipelineWorkspacePath: r.pipeline_workspace_path,
    worktreePath: r.worktree_path,
    branch: r.branch,
    provider: r.provider as WorktreeProvider | null,
    worktreeLeaseId: r.worktree_lease_id,
    baseSha: r.base_sha,
    extraRepos,
    homeName: r.home_name,
    homeBackend: r.home_backend,
    terminalResourceId: r.terminal_resource_id,
    sessionId: r.session_id,
    scheduleId: r.schedule_id,
    scheduleOccurrenceId: r.schedule_occurrence_id,
    scheduledFor: r.scheduled_for,
    status: r.status as TaskStatus,
    outcome: r.outcome,
    outcomeUrl: r.outcome_url,
    error: r.error,
    automaticCleanup,
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
         id, title, intent, kind, agent, priority, labels, dependencies, enabled, backlog_rank,
         model, effort,
         workflow_id, source_id, external_id, source_url, repo_root,
         pipeline_provider, pipeline_slug, pipeline_commission_id, pipeline_workspace_path,
         worktree_path, branch, provider, worktree_lease_id,
         base_sha,
         home_name, home_backend, terminal_resource_id, session_id,
         schedule_id, schedule_occurrence_id, scheduled_for,
         status, outcome, outcome_url, error,
         created_at, updated_at, dispatched_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title=excluded.title, intent=excluded.intent, kind=excluded.kind, agent=excluded.agent,
         priority=excluded.priority, labels=excluded.labels, dependencies=excluded.dependencies,
         enabled=excluded.enabled, backlog_rank=excluded.backlog_rank,
         model=excluded.model, effort=excluded.effort,
         workflow_id=excluded.workflow_id,
         source_id=excluded.source_id, external_id=excluded.external_id,
         source_url=excluded.source_url,
         repo_root=excluded.repo_root,
         pipeline_provider=excluded.pipeline_provider, pipeline_slug=excluded.pipeline_slug,
         pipeline_commission_id=CASE
           WHEN ? THEN excluded.pipeline_commission_id
           ELSE tasks.pipeline_commission_id
         END,
         pipeline_workspace_path=excluded.pipeline_workspace_path,
         worktree_path=excluded.worktree_path, branch=excluded.branch,
         provider=excluded.provider, worktree_lease_id=excluded.worktree_lease_id,
         base_sha=excluded.base_sha, home_name=excluded.home_name,
         home_backend=excluded.home_backend,
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
      t.backlogRank,
      t.model,
      t.effort,
      t.workflowId,
      t.source?.sourceId ?? null, t.source?.externalId ?? null, t.source?.url ?? null,
      t.repoRoot, t.pipelineRun?.provider ?? null, t.pipelineRun?.slug ?? null,
      t.pipelineCommissionId ?? null,
      t.pipelineWorkspacePath ?? null,
      t.worktreePath, t.branch, t.provider, t.worktreeLeaseId, t.baseSha,
      t.homeName, t.homeBackend ?? null, t.terminalResourceId, t.sessionId,
      t.scheduleId, t.scheduleOccurrenceId, t.scheduledFor,
      t.status, t.outcome, t.outcomeUrl, t.error, t.createdAt,
      t.updatedAt, t.dispatchedAt, t.completedAt,
      t.pipelineCommissionId !== undefined ? 1 : 0,
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
        `INSERT INTO task_repos
           (task_id, repo_root, worktree_path, branch, provider, worktree_lease_id, base_sha, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      t.extraRepos.forEach((entry, position) => {
        insert.run(
          t.id,
          entry.repoRoot,
          entry.worktreePath,
          entry.branch,
          entry.provider,
          entry.worktreeLeaseId,
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
  if (!r) return undefined;
  return rowToTask(r, taskReposFor(r.id), taskAutomaticCleanupSummaries([r.id]).get(r.id) ?? null);
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

/** Durable ownership of the one retro follow-up allowed for a merged source episode. */
export interface RetroFollowupRelation {
  sourceTaskId: string;
  sourceEpisodeId: string;
  sourceSessionId: string;
  retroTaskId: string;
  createdAt: number;
  updatedAt: number;
}

type RetroFollowupRow = {
  source_task_id: string;
  source_episode_id: string;
  source_session_id: string;
  retro_task_id: string;
  created_at: number;
  updated_at: number;
};

function retroFollowupFromRow(row: RetroFollowupRow): RetroFollowupRelation {
  return {
    sourceTaskId: row.source_task_id,
    sourceEpisodeId: row.source_episode_id,
    sourceSessionId: row.source_session_id,
    retroTaskId: row.retro_task_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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

/** The retro task already reserved for this source episode, when one exists. */
export function retroFollowupForSource(
  sourceTaskId: string,
  sourceEpisodeId: string,
): RetroFollowupRelation | null {
  const row = openDb()
    .prepare(
      `SELECT * FROM retro_followups
       WHERE source_task_id = ? AND source_episode_id = ?`,
    )
    .get(sourceTaskId, sourceEpisodeId) as unknown as RetroFollowupRow | undefined;
  return row ? retroFollowupFromRow(row) : null;
}

/** The source episode for a retro task, used by the no-change completion boundary. */
export function retroFollowupForTask(retroTaskId: string): RetroFollowupRelation | null {
  const row = openDb()
    .prepare(`SELECT * FROM retro_followups WHERE retro_task_id = ?`)
    .get(retroTaskId) as unknown as RetroFollowupRow | undefined;
  return row ? retroFollowupFromRow(row) : null;
}

/**
 * Reserve one stable retro task id for a source episode.
 *
 * The caller supplies the candidate id, then creates an ordinary Task with the returned id.
 * If the process stops between those writes, the next click reads this relation and recreates
 * that exact Task. `BEGIN IMMEDIATE` serializes two clicks before either can observe a gap.
 */
export function reserveRetroFollowup(input: {
  sourceTaskId: string;
  sourceEpisodeId: string;
  sourceSessionId: string;
  retroTaskId: string;
  now: number;
}): { relation: RetroFollowupRelation; created: boolean } {
  const d = openDb();
  const ownsTransaction = !d.isTransaction;
  if (ownsTransaction) d.exec("BEGIN IMMEDIATE");
  try {
    const existing = d
      .prepare(
        `SELECT * FROM retro_followups
         WHERE source_task_id = ? AND source_episode_id = ?`,
      )
      .get(input.sourceTaskId, input.sourceEpisodeId) as unknown as RetroFollowupRow | undefined;
    if (existing) {
      if (ownsTransaction) d.exec("COMMIT");
      return { relation: retroFollowupFromRow(existing), created: false };
    }
    d.prepare(
      `INSERT INTO retro_followups
         (source_task_id, source_episode_id, source_session_id, retro_task_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      input.sourceTaskId,
      input.sourceEpisodeId,
      input.sourceSessionId,
      input.retroTaskId,
      input.now,
      input.now,
    );
    const relation: RetroFollowupRelation = {
      sourceTaskId: input.sourceTaskId,
      sourceEpisodeId: input.sourceEpisodeId,
      sourceSessionId: input.sourceSessionId,
      retroTaskId: input.retroTaskId,
      createdAt: input.now,
      updatedAt: input.now,
    };
    if (ownsTransaction) d.exec("COMMIT");
    return { relation, created: true };
  } catch (error) {
    if (ownsTransaction && d.isTransaction) d.exec("ROLLBACK");
    throw error;
  }
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

/**
 * Pull-request posture used only to decide where a requested retro belongs.
 *
 * An open CURRENT pull request wins over every historical merge because it is the review the
 * live source session can still add a memory commit to. Only when no current review is open
 * does the newest merged binding move the retro into its own task and pull request. This is
 * intentionally separate from `primaryRepoPrForTask`, whose completion-oriented merged-first
 * rule must not change.
 */
export type RetroPrPosture =
  | { kind: "open"; binding: TaskWorkEpisodeBinding }
  | {
      kind: "merged";
      binding: TaskWorkEpisodeBinding;
      prUrl: string;
      mergedAt: number;
    };

export function retroPrPostureForTask(taskId: string): RetroPrPosture | null {
  const current = taskWorkEpisodeForTask(taskId);
  if (current?.prUrl && current.mergedAt === null) return { kind: "open", binding: current };

  const repoPrs = workEpisodeRepoPrsForTask(taskId);
  if (
    current &&
    repoPrs.some(
      (row) =>
        row.episodeId === current.episodeId &&
        row.mergedAt === null &&
        row.prState?.toLowerCase() !== "closed",
    )
  ) {
    return { kind: "open", binding: current };
  }

  const bindings = [
    ...(current ? [current] : []),
    ...historicalTaskWorkEpisodeBindingsForTask(taskId),
  ];
  const bindingByEpisode = new Map(bindings.map((binding) => [binding.episodeId, binding]));
  let merged: Extract<RetroPrPosture, { kind: "merged" }> | null = null;
  for (const binding of bindings) {
    if (binding.prUrl === null || binding.mergedAt === null) continue;
    if (merged === null || binding.mergedAt > merged.mergedAt) {
      merged = {
        kind: "merged",
        binding,
        prUrl: binding.prUrl,
        mergedAt: binding.mergedAt,
      };
    }
  }
  // Secondary-repository reviews have their own durable table. They still belong to the
  // task's work episode, so retain that binding as the follow-up key while carrying the
  // actual merged review URL separately. A row without a surviving binding cannot safely
  // name the source session or episode and is ignored rather than guessed at.
  for (const row of repoPrs) {
    if (row.mergedAt === null) continue;
    const binding = bindingByEpisode.get(row.episodeId);
    if (!binding) continue;
    if (merged === null || row.mergedAt > merged.mergedAt) {
      merged = {
        kind: "merged",
        binding,
        prUrl: row.prUrl,
        mergedAt: row.mergedAt,
      };
    }
  }
  return merged;
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
  const ownsTransaction = !d.isTransaction;
  if (ownsTransaction) d.exec("BEGIN IMMEDIATE");
  try {
    d.prepare(
      `DELETE FROM pipeline_commission_events
       WHERE commission_id IN (SELECT id FROM pipeline_commissions WHERE task_id = ?)`,
    ).run(id);
    d.prepare(
      `DELETE FROM pipeline_commission_attempts
       WHERE commission_id IN (SELECT id FROM pipeline_commissions WHERE task_id = ?)`,
    ).run(id);
    d.prepare(`DELETE FROM pipeline_commissions WHERE task_id = ?`).run(id);
    d.prepare(`DELETE FROM task_repos WHERE task_id = ?`).run(id);
    d.prepare(`DELETE FROM work_episode_prs WHERE task_id = ?`).run(id);
    d.prepare(`DELETE FROM task_work_episode_bindings WHERE task_id = ?`).run(id);
    d.prepare(`DELETE FROM historical_task_work_episode_bindings WHERE task_id = ?`).run(id);
    // The retention ledger is keyed on a task that is about to stop existing. Left behind it
    // would be an orphan whose generation can never match anything again - harmless, but the
    // table would then only ever grow, and `listOrphanedTaskWorktreeRetentionIds` would be
    // cleaning up after this function forever instead of after genuine surprises.
    d.prepare(`DELETE FROM task_worktree_retention WHERE task_id = ?`).run(id);
    d.prepare(`DELETE FROM tasks WHERE id = ?`).run(id);
    if (ownsTransaction) d.exec("COMMIT");
  } catch (error) {
    if (ownsTransaction && d.isTransaction) d.exec("ROLLBACK");
    throw error;
  }
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
      // The EXISTS clause is the ATTACHED half, and it is not a widening for its own sake.
      // Multi-repo teardown clears each repository's recorded path as that repository's tree
      // is actually released, so a run that released the primary and then failed on a second
      // repository leaves a terminal row with `worktree_path IS NULL` and a real checkout
      // still on disk under `task_repos`. Without this clause that task was not loaded on
      // restart at all: nothing reconciled the survivor, nothing offered to clean it up, and
      // the slot it holds was leaked for as long as the row lived. `taskHasWorktrees` is the
      // same predicate in TypeScript - see `src/shared/task-repos.ts`.
      `SELECT * FROM tasks t
       WHERE t.status IN ('done','failed','cancelled')
         AND (
           t.worktree_path IS NOT NULL
           OR t.home_name IS NOT NULL
           OR EXISTS (
             SELECT 1 FROM task_repos r
             WHERE r.task_id = t.id AND r.worktree_path IS NOT NULL
           )
         )`,
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

// ---- task worktree retention: the durable Git-visible activity clock ----
//
// Read the `task_worktree_retention` CREATE TABLE above before touching any of this. Two
// rules, and both are about not fabricating quiet:
//
//  1. A row is only ever written from a SUCCESSFUL observation. An unknown read - Git failed,
//     a path vanished, output was too large to trust - records diagnosis and nothing else. It
//     can never create a row, and it can never move `last_changed_at` or `cleanup_due_at`.
//  2. Every write is guarded by the generation the observation was taken against. A pass that
//     started before a task was re-dispatched cannot land its fingerprint on the replacement.

/** Bytes of diagnosis kept on a ledger row. Long enough to name a cause, short enough to store. */
const RETENTION_ERROR_LIMIT = 500;

/** One retention ledger row, exactly as stored. Internal server state - never the wire. */
export interface TaskWorktreeRetentionRow {
  taskId: string;
  generation: string;
  fingerprint: string;
  lastChangedAt: number;
  observedAt: number;
  cleanupDueAt: number;
  cleanupState: string;
  claimToken: string | null;
  claimedAt: number | null;
  lastAttemptAt: number | null;
  retryAt: number | null;
  lastError: string | null;
  updatedAt: number;
}

interface TaskWorktreeRetentionDbRow {
  task_id: string;
  generation: string;
  fingerprint: string;
  last_changed_at: number;
  observed_at: number;
  cleanup_due_at: number;
  cleanup_state: string;
  claim_token: string | null;
  claimed_at: number | null;
  last_attempt_at: number | null;
  retry_at: number | null;
  last_error: string | null;
  updated_at: number;
}

function toRetentionRow(row: TaskWorktreeRetentionDbRow): TaskWorktreeRetentionRow {
  return {
    taskId: row.task_id,
    generation: row.generation,
    fingerprint: row.fingerprint,
    lastChangedAt: row.last_changed_at,
    observedAt: row.observed_at,
    cleanupDueAt: row.cleanup_due_at,
    cleanupState: row.cleanup_state,
    claimToken: row.claim_token,
    claimedAt: row.claimed_at,
    lastAttemptAt: row.last_attempt_at,
    retryAt: row.retry_at,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

export function getTaskWorktreeRetention(taskId: string): TaskWorktreeRetentionRow | null {
  const row = openDb()
    .prepare(`SELECT * FROM task_worktree_retention WHERE task_id = ?`)
    .get(taskId) as unknown as TaskWorktreeRetentionDbRow | undefined;
  return row ? toRetentionRow(row) : null;
}

/** Every ledger row, one query. The observer's whole-table view for diagnosis and pruning. */
export function listTaskWorktreeRetention(): TaskWorktreeRetentionRow[] {
  const rows = openDb()
    .prepare(`SELECT * FROM task_worktree_retention ORDER BY cleanup_due_at ASC`)
    .all() as unknown as TaskWorktreeRetentionDbRow[];
  return rows.map(toRetentionRow);
}

/**
 * Rows whose deadline has arrived - Phase 2's work queue, and Phase 1's proof that the clock
 * it persists is readable in the shape the next phase needs.
 *
 * Nothing in this phase acts on the result. It is exported and tested now so that activating
 * cleanup adds a consumer rather than a second query with a subtly different predicate.
 */
export function listDueTaskWorktreeRetention(now: number): TaskWorktreeRetentionRow[] {
  const rows = openDb()
    .prepare(
      `SELECT * FROM task_worktree_retention
       WHERE cleanup_due_at <= ? AND (retry_at IS NULL OR retry_at <= ?)
       ORDER BY cleanup_due_at ASC`,
    )
    .all(now, now) as unknown as TaskWorktreeRetentionDbRow[];
  return rows.map(toRetentionRow);
}

/**
 * Ledger rows that no longer describe anything: the task was deleted out from under them, it
 * is no longer terminal (a reschedule put it back in the backlog), or it holds nothing this
 * cleanup is responsible for releasing.
 *
 * That last clause is `taskHoldsCleanupResources`, not `taskHasWorktrees`: a row whose cleanup
 * released the final checkout and then failed on the terminal home still describes something,
 * and pruning it would silently drop the retry that finishes the job.
 *
 * One query rather than a row-per-task probe, and answered from SQLite rather than from the
 * registry's in-memory map on purpose - the map is bounded and evicts, so "the registry does
 * not have it" is not proof a task is gone, and deleting a live task's clock would silently
 * hand it a fresh 30-day grace period.
 *
 * The worktree half mirrors `taskHasWorktrees`: primary path, or any attached row's.
 */
export function listOrphanedTaskWorktreeRetentionIds(): string[] {
  const rows = openDb()
    .prepare(
      `SELECT l.task_id AS task_id FROM task_worktree_retention l
       LEFT JOIN tasks t ON t.id = l.task_id
       WHERE t.id IS NULL
          OR t.status NOT IN ('done','failed','cancelled')
          OR (
            t.worktree_path IS NULL
            AND t.home_name IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM task_repos r
              WHERE r.task_id = t.id AND r.worktree_path IS NOT NULL
            )
          )`,
    )
    .all() as unknown as Array<{ task_id: string }>;
  return rows.map((r) => r.task_id);
}

export function deleteTaskWorktreeRetention(taskId: string): void {
  openDb().prepare(`DELETE FROM task_worktree_retention WHERE task_id = ?`).run(taskId);
}

/** What one observation did to the ledger. Returned so a caller can log or assert it. */
export type RetentionObservationOutcome =
  /** No row existed for this generation: the conservative full window starts NOW. */
  | "seeded"
  /** A row existed for a DIFFERENT generation: it described other resources, so it is replaced
   *  and the conservative full window starts now for the current ones. */
  | "replaced"
  /** Same generation, different fingerprint: Git-visible work happened, so the clock resets. */
  | "changed"
  /**
   * A different generation on a row a failed cleanup left in `retry`: the resources SHRANK
   * under that cleanup, so the row adopts them and keeps its already-expired deadline.
   */
  | "retry-adopted"
  /** Same generation, same fingerprint: only `observed_at` moves. */
  | "unchanged"
  /** An unknown read against an existing matching row: diagnosis recorded, clock untouched. */
  | "unknown-recorded"
  /** An unknown read with no matching row to annotate: nothing is written at all. */
  | "unknown-skipped"
  /**
   * The task no longer owns the resources this observation was taken against, as re-derived
   * INSIDE the write transaction. Nothing is written - see the note on the guard below.
   */
  | "generation-moved";

export interface RetentionObservationInput {
  taskId: string;
  /** `taskResourceGeneration(task)` for the task as it was read for this observation. */
  generation: string;
  /** The aggregate fingerprint, or null when the probe could not produce a trustworthy one. */
  fingerprint: string | null;
  /** Bounded diagnosis for an unknown read. Ignored when `fingerprint` is present. */
  reason?: string | null;
  now: number;
  /** How long a quiet tree is kept. Passed in so policy lives with the observer, not here. */
  retentionMs: number;
}

/**
 * Apply one observation to the ledger, atomically.
 *
 * The four success transitions and the two unknown ones are here in one transaction rather
 * than as six exported writers because they are decided by a COMPARISON with the row that is
 * already there - split across calls, a concurrent pass could read "no row" and then insert
 * over a row another pass had just seeded, handing a tree a second full grace period.
 *
 * Nothing here can move a cleanup claim. `cleanup_state`, `claim_token` and `claimed_at` are
 * written only as the inert defaults a new or replaced row carries; an existing row's claim
 * columns are left exactly as found. That is Phase 1's zero-cleanup boundary expressed in the
 * one place that could otherwise cross it.
 *
 * The caller's generation is re-derived HERE, from the task as it stands inside this
 * transaction, and a mismatch writes nothing. That is deliberately a second check: the observer
 * already re-read the task before calling, but that check protects the write only for as long
 * as nothing can run between the two - which is true today (both calls are synchronous, and the
 * daemon is the only writer) and is exactly the kind of invariant that a later refactor
 * silently repeals. A stale fingerprint landing on a re-dispatched task hands a brand new
 * checkout an age it never lived, and the phase that consumes this ledger deletes on that age,
 * so the guard belongs where the write happens rather than where the caller last looked.
 */
export function recordTaskWorktreeObservation(
  input: RetentionObservationInput,
): { outcome: RetentionObservationOutcome; row: TaskWorktreeRetentionRow | null } {
  const d = openDb();
  const { taskId, generation, fingerprint, now, retentionMs } = input;
  const error = input.reason ? input.reason.slice(0, RETENTION_ERROR_LIMIT) : null;
  d.exec("BEGIN IMMEDIATE");
  try {
    const existing = d
      .prepare(`SELECT * FROM task_worktree_retention WHERE task_id = ?`)
      .get(taskId) as unknown as TaskWorktreeRetentionDbRow | undefined;

    // Does the task STILL own what this observation describes? Asked of the row as it is right
    // now, under the same transaction that is about to write, so no interleaving between the
    // question and the answer is possible regardless of what the caller did or did not check.
    // A task that vanished, went non-terminal, released its last checkout, or was re-dispatched
    // all land here, and all of them write nothing at all.
    const current = getTask(taskId);
    if (
      !current
      || !isRetentionCandidate(current)
      || taskResourceGeneration(current) !== generation
    ) {
      d.exec("COMMIT");
      return { outcome: "generation-moved", row: existing ? toRetentionRow(existing) : null };
    }

    if (fingerprint === null) {
      // An unreadable tree is not a quiet tree. Record why, move nothing, and - when there is
      // no row for this generation - write nothing at all, because a row invented from a
      // failed read would be a deadline derived from an observation that never happened.
      if (!existing || existing.generation !== generation) {
        d.exec("COMMIT");
        return { outcome: "unknown-skipped", row: existing ? toRetentionRow(existing) : null };
      }
      d.prepare(
        `UPDATE task_worktree_retention SET last_error = ?, updated_at = ? WHERE task_id = ?`,
      ).run(error, now, taskId);
      const row = d
        .prepare(`SELECT * FROM task_worktree_retention WHERE task_id = ?`)
        .get(taskId) as unknown as TaskWorktreeRetentionDbRow;
      d.exec("COMMIT");
      return { outcome: "unknown-recorded", row: toRetentionRow(row) };
    }

    let outcome: RetentionObservationOutcome;
    if (!existing) outcome = "seeded";
    else if (existing.generation !== generation) {
      // A generation change on a row that is already in RETRY is not an external replacement,
      // and treating it as one is the bug this branch exists to prevent. A row only reaches
      // `retry` because a cleanup that was already DUE ran on this task and did not finish, and
      // the shapes that shrink a task's resources from there - a partial provider release, a
      // terminal home stopped before an archive refused - are that cleanup's own doing. A
      // re-dispatch cannot land here at all: it puts the task back in the backlog, and a
      // non-terminal task's row is pruned before any of this. So the survivor ADOPTS: new
      // generation, new fingerprint, same activity boundary, same deadline. It was 30 days
      // quiet before the failed attempt and it does not earn another month by surviving one.
      outcome = existing.cleanup_state === "retry" ? "retry-adopted" : "replaced";
    } else if (existing.fingerprint !== fingerprint) outcome = "changed";
    else outcome = "unchanged";

    if (outcome === "retry-adopted") {
      d.prepare(
        `UPDATE task_worktree_retention
         SET generation = ?, fingerprint = ?, observed_at = ?, updated_at = ?
         WHERE task_id = ?`,
      ).run(generation, fingerprint, now, now, taskId);
    } else if (outcome === "unchanged") {
      d.prepare(
        `UPDATE task_worktree_retention SET observed_at = ?, last_error = NULL, updated_at = ?
         WHERE task_id = ?`,
      ).run(now, now, taskId);
    } else if (outcome === "changed") {
      // Changed work outranks every cleanup state there is. A row that was mid-retry after a
      // failed automatic reclaim, or one a claim is sitting on right now, goes back to plain
      // observing with a full new window: somebody edited that checkout, so the tree is not
      // stale any more and the backoff schedule its previous quiet earned no longer describes
      // anything. Clearing `claim_token` here is also what makes an in-flight attempt's own
      // later transition a no-op - every one of them requires the token it no longer holds -
      // so a cleanup that was already running cannot finish against work that arrived under it.
      d.prepare(
        `UPDATE task_worktree_retention
         SET fingerprint = ?, last_changed_at = ?, observed_at = ?, cleanup_due_at = ?,
             cleanup_state = 'observing', claim_token = NULL, claimed_at = NULL, retry_at = NULL,
             last_error = NULL, updated_at = ?
         WHERE task_id = ?`,
      ).run(fingerprint, now, now, now + retentionMs, now, taskId);
    } else {
      // Seed and replace are the same write: a generation nobody has successfully observed
      // before starts its window now, whether or not some other generation's row was sitting
      // in its place. REPLACE rather than UPDATE so the claim columns of the row being
      // superseded cannot survive onto resources they were never claimed against.
      d.prepare(
        `INSERT OR REPLACE INTO task_worktree_retention
           (task_id, generation, fingerprint, last_changed_at, observed_at, cleanup_due_at,
            cleanup_state, claim_token, claimed_at, last_attempt_at, retry_at, last_error,
            updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'observing', NULL, NULL, NULL, NULL, NULL, ?)`,
      ).run(taskId, generation, fingerprint, now, now, now + retentionMs, now);
    }
    const row = d
      .prepare(`SELECT * FROM task_worktree_retention WHERE task_id = ?`)
      .get(taskId) as unknown as TaskWorktreeRetentionDbRow;
    d.exec("COMMIT");
    return { outcome, row: toRetentionRow(row) };
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
}

// ---- task worktree retention: the cleanup claim state machine (Phase 2) ----
//
// Everything above records WHEN a terminal task's checkouts last changed. Everything below
// decides who is allowed to act on that, and it is the half that deletes work.
//
// One rule holds all of it together: **the ledger row is the authority, and every transition
// is a compare-and-swap against it inside a transaction.** The daemon also holds an in-memory
// reservation in `TaskManager` (see `reserveTaskCleanup`), and that is not redundant with
// this - the reservation closes overlap between two in-process callers within one daemon
// life, and the row closes overlap across a restart, where the previous daemon's reservation
// no longer exists but its claim is still written down.
//
// The claim states, and there are only three:
//
//   observing - the ordinary resting state. The clock runs, nobody is touching the trees.
//   claimed   - one cleanup attempt owns this task's resources right now. Its `claim_token`
//               is a value only that attempt holds, so a stale attempt from before a restart
//               cannot finish someone else's work.
//   retry     - a due attempt ran and did not fully release. The activity boundary is
//               PRESERVED (this was already due; a failed cleanup is not new user activity),
//               and `retry_at` holds it off with exponential backoff.
//
// A changed fingerprint always wins over any of them - see `recordTaskWorktreeObservation`,
// which clears claim and retry state when it sees real work. Somebody edited that tree; it
// gets a full new window, not the retry schedule its previous quiet earned.

/** The three cleanup states a ledger row can rest in. Persisted verbatim in `cleanup_state`. */
export type RetentionCleanupState = "observing" | "claimed" | "retry";

/** Why a claim attempt was refused. Never surfaced to a browser - internal diagnosis only. */
export type RetentionClaimRefusal =
  /** No ledger row: nothing has successfully observed these resources yet. */
  | "no-row"
  /** The task vanished, went non-terminal, or released its last checkout. */
  | "not-a-candidate"
  /** The task no longer owns what the caller observed, or the row describes other resources. */
  | "generation-moved"
  /** Git-visible work landed since the caller's probe. The clock restarts, not the cleanup. */
  | "activity-changed"
  /** The deadline has not arrived, or backoff has not elapsed. */
  | "not-due"
  /** Another attempt already holds this row. */
  | "already-claimed";

export interface RetentionClaimInput {
  taskId: string;
  /** The generation the caller just proved, from a re-read of the task. */
  generation: string;
  /** The fingerprint from the caller's FRESH probe. Must equal the row's, or no claim. */
  fingerprint: string;
  /** A value only this attempt holds. Every later transition must present it. */
  token: string;
  now: number;
}

/**
 * Take exclusive durable ownership of one task's cleanup, or say exactly why not.
 *
 * The fingerprint equality check is the load-bearing one and it is why this takes a
 * fingerprint at all rather than reading the row's. The caller must have probed the trees
 * moments ago; if what it saw differs from what the ledger's deadline was granted against,
 * somebody worked in that checkout after the last observation and the row is about to be
 * reset by the ordinary observation path. Claiming anyway would delete work that arrived
 * between the last pass and this one - the exact window the 30-day rule exists to protect.
 *
 * An `unknown` probe cannot reach here at all: it has no digest to present, and there is
 * deliberately no overload that lets a caller claim without one. "We could not read the tree"
 * is never permission to remove it.
 */
export function claimTaskWorktreeCleanup(
  input: RetentionClaimInput,
): { claimed: true; row: TaskWorktreeRetentionRow } | { claimed: false; refusal: RetentionClaimRefusal } {
  const d = openDb();
  const { taskId, generation, fingerprint, token, now } = input;
  d.exec("BEGIN IMMEDIATE");
  try {
    const refuse = (refusal: RetentionClaimRefusal) => {
      d.exec("COMMIT");
      return { claimed: false as const, refusal };
    };
    const existing = d
      .prepare(`SELECT * FROM task_worktree_retention WHERE task_id = ?`)
      .get(taskId) as unknown as TaskWorktreeRetentionDbRow | undefined;
    if (!existing) return refuse("no-row");
    // Re-derived here rather than trusted from the caller, for `recordTaskWorktreeObservation`'s
    // reason: the comparison that authorizes a destructive act belongs in the transaction that
    // writes, not in whatever the caller last looked at.
    // The KEEPING rule, not the seeding one: a row whose cleanup released the last checkout
    // and then failed on the terminal home is still this row's unfinished job, and judging it
    // by `isRetentionCandidate` here would refuse every attempt that could finish it.
    const current = getTask(taskId);
    if (!current || !isRetentionRetryable(current)) return refuse("not-a-candidate");
    if (taskResourceGeneration(current) !== generation) return refuse("generation-moved");
    if (existing.generation !== generation) return refuse("generation-moved");
    if (existing.fingerprint !== fingerprint) return refuse("activity-changed");
    if (existing.cleanup_due_at > now) return refuse("not-due");
    if (existing.retry_at !== null && existing.retry_at > now) return refuse("not-due");
    if (existing.cleanup_state === "claimed") return refuse("already-claimed");
    d.prepare(
      `UPDATE task_worktree_retention
       SET cleanup_state = 'claimed', claim_token = ?, claimed_at = ?, last_attempt_at = ?,
           updated_at = ?
       WHERE task_id = ?`,
    ).run(token, now, now, now, taskId);
    const row = d
      .prepare(`SELECT * FROM task_worktree_retention WHERE task_id = ?`)
      .get(taskId) as unknown as TaskWorktreeRetentionDbRow;
    d.exec("COMMIT");
    return { claimed: true, row: toRetentionRow(row) };
  } catch (err) {
    if (d.isTransaction) d.exec("ROLLBACK");
    throw err;
  }
}

/**
 * The claim is finished and the task holds no checkout: drop the clock.
 *
 * The "holds no checkout" half is re-derived here rather than taken on the caller's word,
 * because deleting the row is what grants a FULL FRESH 30-day window to whatever is observed
 * next. A row deleted while a tree was still standing would silently restart that tree's
 * clock - the one failure mode where a bug in cleanup makes the product forget instead of
 * making it retry.
 */
export function completeTaskWorktreeCleanup(
  taskId: string,
  token: string,
): { kind: "deleted" | "still-held" | "not-claimed" } {
  const d = openDb();
  d.exec("BEGIN IMMEDIATE");
  try {
    const existing = d
      .prepare(`SELECT * FROM task_worktree_retention WHERE task_id = ?`)
      .get(taskId) as unknown as TaskWorktreeRetentionDbRow | undefined;
    if (!existing || existing.claim_token !== token) {
      d.exec("COMMIT");
      return { kind: "not-claimed" };
    }
    // Deleted only when there is genuinely nothing left for this cleanup to release. A
    // teardown that handed back the last checkout and then failed on the terminal home has not
    // finished, and deleting here would take the retry mechanism away while a live resource is
    // still recorded - so that row is reported as still held and defers instead.
    const current = getTask(taskId);
    if (current && taskHoldsCleanupResources(current)) {
      d.exec("COMMIT");
      return { kind: "still-held" };
    }
    d.prepare(`DELETE FROM task_worktree_retention WHERE task_id = ?`).run(taskId);
    d.exec("COMMIT");
    return { kind: "deleted" };
  } catch (err) {
    if (d.isTransaction) d.exec("ROLLBACK");
    throw err;
  }
}

export interface RetentionDeferInput {
  taskId: string;
  token: string;
  now: number;
  /** When this task may be attempted again. Exponential, capped - the service owns the curve. */
  retryAt: number;
  /** Bounded internal classification. Never a raw provider exception - see `last_error`. */
  error: string | null;
  /**
   * The generation of the resources STILL STANDING, when this attempt itself shrank the set.
   *
   * A partial release, or a quiescence that stopped a terminal home before a provider refused,
   * both leave the task owning less than the claim was taken against. That is this cleanup's
   * own mutation and not new user activity, so the row adopts it and KEEPS its due boundary:
   * the remaining tree was already 30 days quiet and does not earn another month by having
   * been half-released. Omit when nothing moved.
   */
  generation?: string;
  /** The aggregate fingerprint of what remains, alongside `generation`. */
  fingerprint?: string;
}

/**
 * The attempt did not fully release: keep every fact, keep the due boundary, back off.
 *
 * `last_changed_at` and `cleanup_due_at` are deliberately untouched in every branch. The tree
 * is past its deadline and stays past it; a provider refusal, an unreadable final probe, or an
 * archive that would not settle are all reasons to try again later, never reasons to hand the
 * checkout another 30 days of life.
 */
export function deferTaskWorktreeCleanup(
  input: RetentionDeferInput,
): { deferred: boolean; row: TaskWorktreeRetentionRow | null } {
  const d = openDb();
  const { taskId, token, now, retryAt } = input;
  const error = input.error ? input.error.slice(0, RETENTION_ERROR_LIMIT) : null;
  d.exec("BEGIN IMMEDIATE");
  try {
    const existing = d
      .prepare(`SELECT * FROM task_worktree_retention WHERE task_id = ?`)
      .get(taskId) as unknown as TaskWorktreeRetentionDbRow | undefined;
    if (!existing || existing.claim_token !== token) {
      d.exec("COMMIT");
      return { deferred: false, row: existing ? toRetentionRow(existing) : null };
    }
    if (input.generation !== undefined && input.fingerprint !== undefined) {
      d.prepare(
        `UPDATE task_worktree_retention
         SET generation = ?, fingerprint = ?, cleanup_state = 'retry', claim_token = NULL,
             claimed_at = NULL, retry_at = ?, last_error = ?, updated_at = ?
         WHERE task_id = ? AND claim_token = ?`,
      ).run(input.generation, input.fingerprint, retryAt, error, now, taskId, token);
    } else {
      d.prepare(
        `UPDATE task_worktree_retention
         SET cleanup_state = 'retry', claim_token = NULL, claimed_at = NULL, retry_at = ?,
             last_error = ?, updated_at = ?
         WHERE task_id = ? AND claim_token = ?`,
      ).run(retryAt, error, now, taskId, token);
    }
    const row = d
      .prepare(`SELECT * FROM task_worktree_retention WHERE task_id = ?`)
      .get(taskId) as unknown as TaskWorktreeRetentionDbRow;
    d.exec("COMMIT");
    return { deferred: true, row: toRetentionRow(row) };
  } catch (err) {
    if (d.isTransaction) d.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Let go without acting and without penalty: the world moved on under this claim.
 *
 * Used for the two outcomes that are not failures at all - a fresh probe found Git-visible
 * work, or the task was re-dispatched/rescheduled/replaced while the attempt was in flight.
 * Both hand the row straight back to ordinary observation, which is what then writes the
 * correct new window from a real observation rather than from this attempt's guess.
 */
export function releaseTaskWorktreeCleanupClaim(taskId: string, token: string, now: number): boolean {
  const changes = openDb()
    .prepare(
      `UPDATE task_worktree_retention
       SET cleanup_state = 'observing', claim_token = NULL, claimed_at = NULL, retry_at = NULL,
           updated_at = ?
       WHERE task_id = ? AND claim_token = ?`,
    )
    .run(now, taskId, token).changes;
  return Number(changes) > 0;
}

/**
 * Reopen claims held by a daemon that is no longer running.
 *
 * Called once at startup, before the observer's first pass. A `claimed` row at that moment
 * cannot belong to anyone: this process has just started and holds no claims, so the token on
 * it was minted by a daemon that died mid-attempt. It becomes retryable rather than
 * immediately claimable, because a crash during provider teardown is genuinely ambiguous -
 * the tree may be half-removed, the lease may or may not have been returned - and the retry
 * runs AFTER startup reconciliation has re-established what the task actually still owns.
 *
 * The deadline is untouched. The tree was due before the crash and is still due.
 *
 * `last_attempt_at` moves to now alongside `retry_at`, which resets the retry SCHEDULE to its
 * base. Those two columns are the endpoints `nextRetryDelayMs` measures the last interval
 * between, and leaving the crashed claim's timestamp in place would make the length of the
 * outage read as the length of the last backoff - so a daemon that was off for a day would
 * come back and immediately grant the maximum delay. An interrupted attempt is not a refusal,
 * and it should not inherit a backoff it never earned.
 */
export function recoverAbandonedTaskWorktreeCleanups(now: number): number {
  const changes = openDb()
    .prepare(
      `UPDATE task_worktree_retention
       SET cleanup_state = 'retry', claim_token = NULL, claimed_at = NULL, retry_at = ?,
           last_attempt_at = ?,
           last_error = 'cleanup was interrupted by a daemon restart', updated_at = ?
       WHERE cleanup_state = 'claimed'`,
    )
    .run(now, now, now).changes;
  return Number(changes);
}

/**
 * Settle a task whose agent restart proved gone, and carry its retention clock across, in ONE
 * transaction.
 *
 * This exists because of a collision between two correct designs. The resource generation
 * includes the bound session id, terminal home and terminal resource - it has to, because
 * cleanup can clear all three, and a generation blind to them would survive a mutation that
 * changed what cleanup would do. But restart reconciliation ALSO clears the session binding,
 * for the unrelated reason that the session is provably dead. Left alone, that write moves the
 * generation, the next observation calls the row "replaced", and a checkout 29 days into its
 * window silently receives a fresh 30. Every restart would push the deadline out, and a daemon
 * restarted weekly would never reclaim anything at all.
 *
 * So the settlement adopts the row instead: exact pre-settlement generation in, computed
 * post-settlement generation out, and `fingerprint`, `last_changed_at`, `cleanup_due_at` and
 * `retry_at` all preserved untouched. Nothing else about the row moves, and claim recovery
 * stays the only thing that transitions claim state.
 *
 * One transaction rather than two writes, because the crash window between them is exactly the
 * bug: a settled task on disk with the pre-settlement generation still on its row would be
 * read by the next observation as an external replacement, which is the outcome this function
 * exists to prevent.
 *
 * Three refusals, all of which write nothing:
 *
 *  - the task is gone, or no longer matches the frozen pre-settlement status and generation.
 *    Something else moved it while the terminal probe was in flight; the caller re-reads.
 *  - there is no row at all. That is not a failure: the settlement commits, and the first
 *    successful observation of the settled resources grants the conservative full period. It
 *    is reported as `adopted: false` so a caller can say which happened.
 *  - the row belongs to a different generation than the one being settled from. It describes
 *    resources this task does not own, so ordinary observation replaces it under the normal
 *    external-generation rule rather than having this settlement adopt someone else's clock.
 */
export function settleTaskWithRetentionAdoption(input: {
  /** The post-settlement task to persist, exactly as the caller wants it written. */
  settled: Task;
  /** The status the caller froze before probing. Not in the generation, so checked here. */
  expectedStatus: TaskStatus;
  /** `taskResourceGeneration` of the frozen pre-settlement task. */
  expectedGeneration: string;
  now: number;
}): { committed: boolean; adopted: boolean; displaced: readonly string[] } {
  const d = openDb();
  const { settled, expectedStatus, expectedGeneration, now } = input;
  d.exec("BEGIN IMMEDIATE");
  try {
    const current = getTask(settled.id);
    if (
      !current
      || current.status !== expectedStatus
      || taskResourceGeneration(current) !== expectedGeneration
    ) {
      d.exec("COMMIT");
      return { committed: false, adopted: false, displaced: [] };
    }
    const existing = d
      .prepare(`SELECT * FROM task_worktree_retention WHERE task_id = ?`)
      .get(settled.id) as unknown as TaskWorktreeRetentionDbRow | undefined;
    // `upsertTask` joins this transaction rather than opening its own - see its
    // `ownsTransaction` guard - which is what makes the pair atomic.
    const displaced = upsertTask(settled);
    const after = taskResourceGeneration(settled);
    let adopted = false;
    if (existing && existing.generation === expectedGeneration) {
      adopted = true;
      if (after !== expectedGeneration) {
        d.prepare(
          `UPDATE task_worktree_retention SET generation = ?, updated_at = ?
           WHERE task_id = ? AND generation = ?`,
        ).run(after, now, settled.id, expectedGeneration);
      }
    }
    d.exec("COMMIT");
    return { committed: true, adopted, displaced };
  } catch (err) {
    if (d.isTransaction) d.exec("ROLLBACK");
    throw err;
  }
}

/**
 * The bounded, browser-safe view of a task's automatic cleanup, or null.
 *
 * Null is the ordinary case and covers every task that is observing quietly, every task with
 * no ledger row at all, and every task whose cleanup succeeded - so a dashboard that renders
 * this only when non-null shows nothing until there is genuinely something to say.
 *
 * What crosses is the state, when it will be tried again, and a sentence a person can read.
 * What does not cross, ever: the fingerprint, the generation, the claim token, raw git or
 * provider output, and any path the task row does not already carry. This is a maintenance
 * note on a card, not a debugging channel.
 */
export function taskAutomaticCleanupSummaries(
  taskIds: readonly string[],
): Map<string, TaskAutomaticCleanup> {
  const out = new Map<string, TaskAutomaticCleanup>();
  if (taskIds.length === 0) return out;
  const d = openDb();
  // No `IN (?, ?, …)` over the caller's ids, and that is not a style preference: `listTasks`
  // passes EVERY task a long-lived install has ever filed, which would blow past SQLite's host
  // parameter ceiling and turn the whole task list into an error. Selecting the retry rows
  // themselves cannot: there is at most one row per resource-holding terminal task, and only
  // the ones whose automatic cleanup is actually mid-retry are in this state - normally none.
  // The single-id case still takes the indexed primary-key path, because `getTask` is hot.
  const rows = (taskIds.length === 1
    ? d.prepare(
      `SELECT task_id, retry_at, last_error FROM task_worktree_retention
       WHERE task_id = ? AND cleanup_state = 'retry'`,
    ).all(taskIds[0]!)
    : d.prepare(
      `SELECT task_id, retry_at, last_error FROM task_worktree_retention
       WHERE cleanup_state = 'retry'`,
    ).all()) as unknown as Array<{
      task_id: string;
      retry_at: number | null;
      last_error: string | null;
    }>;
  if (rows.length === 0) return out;
  const wanted = new Set(taskIds);
  for (const row of rows) {
    if (!wanted.has(row.task_id)) continue;
    out.set(row.task_id, {
      state: "retrying",
      retryAt: row.retry_at,
      detail: row.last_error ? row.last_error.slice(0, TASK_AUTOMATIC_CLEANUP_DETAIL_LIMIT) : null,
    });
  }
  return out;
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

// ---- pipelines: the projection of an external engine's own files ----
//
// Read the `pipeline_runs` CREATE TABLE above before touching any of this. Two rules, and
// both are about the same thing: this table holds nothing that is not already on disk under
// the engine's control, and nothing here ever writes an engine-owned file.

/** One projection row as it is stored: the run, plus where its events tail stopped. */
export interface PipelineRunRow {
  run: PipelineRun;
  eventsOffset: number;
  /** Identity of the file `eventsOffset` indexes into. Empty when never recorded. */
  eventsIdentity: string;
}

/**
 * Whether a stored blob is still a run this build can read.
 *
 * Deliberately strict on the KEY fields and lenient on everything else. The key is what a
 * row is addressed by, and a row whose provider this build does not know cannot be matched
 * against anything - so it is dropped and re-projected from files, which is always possible
 * and is exactly the guarantee this table is built on. Being lenient about the rest would
 * be lenient about display, and the next pass overwrites the display anyway.
 */
function readPipelineRun(json: string): PipelineRun | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const run = parsed as Partial<PipelineRun>;
  if (typeof run.provider !== "string" || !isPipelineProviderId(run.provider)) return null;
  if (typeof run.repoRoot !== "string" || run.repoRoot === "") return null;
  if (typeof run.slug !== "string" || run.slug === "") return null;
  if (!Array.isArray(run.steps)) return null;
  return run as PipelineRun;
}

/**
 * Every projected run, for the boot-time seed of the live catalog.
 *
 * A row this build cannot read is DELETED rather than skipped. Skipping would leave it to
 * shadow the next write's `ON CONFLICT` under a key nothing can address, and the cost of
 * being wrong is one refresh - the whole reason this is a cache.
 */
export function loadPipelineRuns(): PipelineRunRow[] {
  const d = openDb();
  const rows = d
    .prepare(
      `SELECT provider, repo_root, slug, run_json, events_offset, events_identity
         FROM pipeline_runs`,
    )
    .all() as unknown as Array<{
    provider: string;
    repo_root: string;
    slug: string;
    run_json: string;
    events_offset: number;
    events_identity: string;
  }>;
  const out: PipelineRunRow[] = [];
  const unreadable: Array<[string, string, string]> = [];
  for (const row of rows) {
    const run = readPipelineRun(row.run_json);
    if (run === null) {
      unreadable.push([row.provider, row.repo_root, row.slug]);
      continue;
    }
    out.push({
      run,
      eventsOffset: row.events_offset,
      eventsIdentity: row.events_identity ?? "",
    });
  }
  for (const [provider, repoRoot, slug] of unreadable) {
    d.prepare(
      `DELETE FROM pipeline_runs WHERE provider = ? AND repo_root = ? AND slug = ?`,
    ).run(provider, repoRoot, slug);
  }
  if (unreadable.length > 0) {
    console.warn(
      `[pipelines] dropped ${unreadable.length} unreadable projection row(s); they will be re-read from the engine's files`,
    );
  }
  return out;
}

/** Where the events tail stopped, and in WHICH file, for each run in one repository. */
export interface PipelineEventCursor {
  offset: number;
  /** `dev:ino:birthtime` of the file that offset indexes. Empty when never recorded. */
  identity: string;
}

/**
 * The resume cursor per slug.
 *
 * Offset and identity travel together and are never read apart: an offset is a promise about
 * a position in a particular file, and handing one back without saying which file it came
 * from is how a re-cut worktree gets read from the middle of its new ledger.
 */
export function pipelineEventCursors(
  provider: PipelineProviderId,
  repoRoot: string,
): Map<string, PipelineEventCursor> {
  const rows = openDb()
    .prepare(
      `SELECT slug, events_offset, events_identity
         FROM pipeline_runs WHERE provider = ? AND repo_root = ?`,
    )
    .all(provider, repoRoot) as unknown as Array<{
    slug: string;
    events_offset: number;
    events_identity: string;
  }>;
  return new Map(
    rows.map((r) => [r.slug, { offset: r.events_offset, identity: r.events_identity ?? "" }]),
  );
}

/** Store one run's projection. Upsert on the engine's own key. */
export function upsertPipelineRunRow(row: PipelineRunRow): void {
  openDb()
    .prepare(
      `INSERT INTO pipeline_runs
         (provider, repo_root, slug, run_json, events_offset, events_identity, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, repo_root, slug) DO UPDATE SET
         run_json=excluded.run_json,
         events_offset=excluded.events_offset,
         events_identity=excluded.events_identity,
         updated_at=excluded.updated_at`,
    )
    .run(
      row.run.provider,
      row.run.repoRoot,
      row.run.slug,
      JSON.stringify(row.run),
      row.eventsOffset,
      row.eventsIdentity,
      row.run.updatedAt,
    );
}

/** Forget one run - its worktree is gone, so there is nothing left to project. */
export function deletePipelineRunRow(
  provider: PipelineProviderId,
  repoRoot: string,
  slug: string,
): void {
  openDb()
    .prepare(`DELETE FROM pipeline_runs WHERE provider = ? AND repo_root = ? AND slug = ?`)
    .run(provider, repoRoot, slug);
}

/**
 * Forget a whole repository's runs, and say which slugs went.
 *
 * What withdrawing consent means on disk: an operator who switches a repository off is
 * owed a dashboard with nothing of that repository left on it, and the caller needs the
 * slugs to emit a `pipeline_remove` for each.
 */
export function deletePipelineRunsForRepo(
  provider: PipelineProviderId,
  repoRoot: string,
): string[] {
  const d = openDb();
  const rows = d
    .prepare(`SELECT slug FROM pipeline_runs WHERE provider = ? AND repo_root = ?`)
    .all(provider, repoRoot) as unknown as Array<{ slug: string }>;
  d.prepare(`DELETE FROM pipeline_runs WHERE provider = ? AND repo_root = ?`).run(
    provider,
    repoRoot,
  );
  return rows.map((r) => r.slug);
}

/**
 * Every (provider, repoRoot) pair this daemon holds ANY durable pipeline rows for.
 *
 * Both tables, unioned, because this is what consent is reconciled against - and the two
 * are not written at the same moment. A pushed batch lands in the ledger the instant it is
 * accepted, while a `pipeline_runs` row appears only once a pass has run; a repository that
 * was switched on, pushed to, and switched off inside one debounce window therefore has
 * ledger rows and no projection row at all. Asking only the projection would walk straight
 * past it and leave those rows behind for good, written under a consent that no longer
 * exists - the same shape as a run whose slug no pass enumerates, one level up.
 *
 * The reverse case is just as real and is why this is a union rather than a swap: a
 * repository read by a pass that pushed nothing has runs and an empty ledger.
 */
export function pipelineStoredRepos(): Array<{
  provider: PipelineProviderId;
  repoRoot: string;
}> {
  const rows = openDb()
    .prepare(
      `SELECT provider, repo_root FROM pipeline_runs
       UNION
       SELECT provider, repo_root FROM pipeline_events`,
    )
    .all() as unknown as Array<{ provider: string; repo_root: string }>;
  return rows
    .filter((r): r is { provider: PipelineProviderId; repo_root: string } =>
      isPipelineProviderId(r.provider),
    )
    .map((r) => ({ provider: r.provider, repoRoot: r.repo_root }));
}

// ---- pipeline commissions --------------------------------------------------------------

/** A commission's bounded durable Engineer evidence. */
export const MAX_PIPELINE_COMMISSION_EVENTS = 2000;

function projectedPipelineCommission(commission: PipelineCommission): PipelineCommission {
  if (commission.attempts.length <= MAX_PIPELINE_COMMISSION_ATTEMPTS) return commission;
  return {
    ...commission,
    attempts: commission.attempts.slice(-MAX_PIPELINE_COMMISSION_ATTEMPTS),
  };
}

function pipelineCommissionStateJson(commission: PipelineCommission): string {
  return JSON.stringify(projectedPipelineCommission(commission));
}

function validCommissionProjection(value: unknown): value is PipelineCommission {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Partial<PipelineCommission>;
  const nullableString = (field: unknown): boolean => field === null || typeof field === "string";
  const attemptsValid =
    Array.isArray(row.attempts) &&
    row.attempts.every(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Number.isInteger(value.attempt) &&
        (value.origin === undefined ||
          (typeof value.origin === "string" &&
            (PIPELINE_ATTEMPT_ORIGINS as readonly string[]).includes(value.origin))) &&
        typeof value.launchKey === "string" &&
        nullableString(value.engineerRunId) &&
        nullableString(value.previousEngineerRunId) &&
        Number.isInteger(value.providerRevision) &&
        typeof value.state === "string" &&
        (PIPELINE_COMMISSION_ATTEMPT_STATES as readonly string[]).includes(value.state) &&
        nullableString(value.terminalReason) &&
        (value.evidenceCommit === undefined || nullableString(value.evidenceCommit)) &&
        (value.evidenceCommitProvenance === undefined ||
          value.evidenceCommitProvenance === null ||
          (typeof value.evidenceCommitProvenance === "string" &&
            (PIPELINE_EVIDENCE_COMMIT_PROVENANCES as readonly string[]).includes(
              value.evidenceCommitProvenance,
            ))) &&
        (value.evidenceFrozenAt === undefined ||
          value.evidenceFrozenAt === null ||
          typeof value.evidenceFrozenAt === "number") &&
        typeof value.updatedAt === "number",
    );
  const stepsValid =
    Array.isArray(row.steps) &&
    row.steps.every(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        typeof value.name === "string" &&
        typeof value.state === "string" &&
        isPipelineStepState(value.state),
    );
  const linkedRunValid =
    row.linkedRun === null ||
    (typeof row.linkedRun === "object" &&
      row.linkedRun !== null &&
      isPipelineProviderId(row.linkedRun.provider) &&
      typeof row.linkedRun.repoRoot === "string" &&
      typeof row.linkedRun.slug === "string");
  const handoffValid =
    row.handoff === null ||
    (typeof row.handoff === "object" &&
      row.handoff !== null &&
      typeof row.handoff.planSlug === "string" &&
      typeof row.handoff.branch === "string" &&
      nullableString(row.handoff.prUrl) &&
      (row.handoff.outcome === "pr_opened" || row.handoff.outcome === "local_commit"));
  const blocker = row.blocker;
  const blockerValid =
    blocker === undefined ||
    blocker === null ||
    (typeof blocker === "object" &&
      !Array.isArray(blocker) &&
      ((blocker.kind === "land_refused" && typeof blocker.reason === "string") ||
        (blocker.kind === "step_failed" &&
          typeof blocker.step === "string" &&
          typeof blocker.reason === "string")));
  const capabilities = row.capabilities;
  const capabilitiesValid = capabilities === undefined || (
    typeof capabilities === "object" && capabilities !== null &&
    typeof capabilities.supported === "boolean" &&
    [capabilities.readiness, capabilities.worktreeRetirement,
      capabilities.retainedReviewWorktrees, capabilities.ownedAttempts]
      .every((value) => value === undefined || typeof value === "boolean")
  );
  const readiness = row.readiness;
  const readinessValid = readiness === undefined || readiness === null || (
    typeof readiness === "object" &&
    ["ready", "blocked", "inconclusive"].includes(readiness.status) &&
    typeof readiness.code === "string" && typeof readiness.summary === "string" &&
    Array.isArray(readiness.checkedCapabilities) &&
    readiness.checkedCapabilities.every((value) => typeof value === "string") &&
    typeof readiness.retryable === "boolean" && nullableString(readiness.remedy) &&
    nullableString(readiness.diagnostic) && typeof readiness.fingerprint === "string" &&
    typeof readiness.permitted === "boolean" && typeof readiness.checkedAt === "string"
  );
  const failure = row.failure;
  const failureValid = failure === undefined || failure === null || (
    typeof failure === "object" && typeof failure.error === "string" &&
    ["authentication", "authorization", "remote", "workspace", "tooling", "provider", "unknown"]
      .includes(failure.class) &&
    typeof failure.code === "string" && typeof failure.summary === "string" &&
    typeof failure.retryable === "boolean" && nullableString(failure.remedy) &&
    nullableString(failure.diagnostic)
  );
  const retention = row.retention;
  const retentionValid = retention === undefined || retention === null || (
    typeof retention === "object" && typeof retention.retainedCommit === "string" &&
    typeof retention.retainedAt === "string" && typeof retention.retentionDeadline === "string"
  );
  const retirement = row.retirement;
  const retirementValid = retirement === undefined || retirement === null || (
    typeof retirement === "object" && typeof retirement.worktreePath === "string" &&
    typeof retirement.branch === "string" && typeof retirement.planSlug === "string" &&
    ["spec_merged", "spec_closed", "task_cancelled", "retention_expired", "operator_cleanup"]
      .includes(retirement.reason) && nullableString(retirement.retainedCommit) &&
    typeof retirement.retiredAt === "string"
  );
  const successor = row.successorCandidate;
  const successorValid = successor === undefined || successor === null || (
    typeof successor === "object" && typeof successor.engineerRunId === "string" &&
    Number.isInteger(successor.attempt) && typeof successor.previousEngineerRunId === "string" &&
    typeof successor.attemptKey === "string" && Number.isInteger(successor.providerRevision) &&
    typeof successor.state === "string" &&
    ["created", "authoring", "failed", "cancelled", "awaiting_spec_merge", "settled"]
      .includes(successor.state) &&
    nullableString(successor.integrationOwner) &&
    (successor.fingerprint === undefined || typeof successor.fingerprint === "string") &&
    (successor.validation === undefined || ["valid", "invalid"].includes(successor.validation)) &&
    (successor.validationReason === undefined || nullableString(successor.validationReason)) &&
    (successor.branch === undefined || nullableString(successor.branch)) &&
    (successor.planSlug === undefined || nullableString(successor.planSlug)) &&
    (successor.handoff === undefined || successor.handoff === null || (
      typeof successor.handoff === "object" && typeof successor.handoff.planSlug === "string" &&
      typeof successor.handoff.branch === "string" && nullableString(successor.handoff.prUrl) &&
      ["pr_opened", "local_commit"].includes(successor.handoff.outcome)
    )) &&
    (successor.evidenceCommit === undefined || nullableString(successor.evidenceCommit)) &&
    (successor.evidenceCommitProvenance === undefined ||
      successor.evidenceCommitProvenance === null ||
      (typeof successor.evidenceCommitProvenance === "string" &&
        (PIPELINE_EVIDENCE_COMMIT_PROVENANCES as readonly string[])
          .includes(successor.evidenceCommitProvenance)))
  );
  const recovery = row.recovery;
  const recoveryValid = recovery === undefined || recovery === null || (
    typeof recovery === "object" && ["retry", "adoption"].includes(recovery.kind) &&
    Number.isInteger(recovery.predecessorAttempt) &&
    typeof recovery.predecessorEngineerRunId === "string" &&
    Number.isInteger(recovery.predecessorProviderRevision) && Number.isInteger(recovery.attempt) &&
    typeof recovery.state === "string" &&
    (PIPELINE_RECOVERY_STATES as readonly string[]).includes(recovery.state) &&
    nullableString(recovery.candidateFingerprint) && nullableString(recovery.error) &&
    typeof recovery.startedAt === "number" && typeof recovery.updatedAt === "number"
  );
  const projectionDrift = row.projectionDrift;
  const projectionDriftValid = projectionDrift === undefined || projectionDrift === null || (
    typeof projectionDrift === "object" &&
    ["retirement_identity", "retirement_commit"].includes(projectionDrift.kind) &&
    typeof projectionDrift.detail === "string"
  );
  return (
    typeof row.id === "string" &&
    typeof row.taskId === "string" &&
    typeof row.repoRoot === "string" &&
    typeof row.correlationId === "string" &&
    typeof row.provider === "string" &&
    isPipelineProviderId(row.provider) &&
    typeof row.lifecycle === "string" &&
    (PIPELINE_COMMISSION_LIFECYCLES as readonly string[]).includes(row.lifecycle) &&
    (row.activeAttempt === null || Number.isInteger(row.activeAttempt)) &&
    attemptsValid &&
    stepsValid &&
    nullableString(row.currentStep) &&
    nullableString(row.tier) &&
    nullableString(row.track) &&
    nullableString(row.project) &&
    nullableString(row.authoringWorktree) &&
    (row.authoringBranch === undefined || nullableString(row.authoringBranch)) &&
    (row.planSlug === undefined || nullableString(row.planSlug)) &&
    handoffValid &&
    linkedRunValid &&
    blockerValid &&
    capabilitiesValid &&
    (row.integrationOwner === undefined || nullableString(row.integrationOwner)) &&
    (row.readinessRequired === undefined || typeof row.readinessRequired === "boolean") &&
    readinessValid &&
    failureValid &&
    retentionValid &&
    retirementValid &&
    successorValid &&
    recoveryValid &&
    projectionDriftValid &&
    nullableString(row.error) &&
    typeof row.createdAt === "number" &&
    typeof row.updatedAt === "number"
  );
}

function fallbackCommission(row: {
  id: string;
  task_id: string;
  provider: PipelineProviderId;
  repo_root: string;
  correlation_id: string;
  active_attempt: number | null;
  run_slug: string | null;
  created_at: number;
  updated_at: number;
}, attempts: PipelineCommissionAttempt[], reason: string): PipelineCommission {
  return {
    id: row.id,
    taskId: row.task_id,
    provider: row.provider,
    repoRoot: row.repo_root,
    correlationId: row.correlation_id,
    lifecycle: "unsupported",
    attempts,
    activeAttempt: row.active_attempt,
    steps: [],
    currentStep: null,
    tier: null,
    track: null,
    project: null,
    authoringWorktree: null,
    authoringBranch: null,
    planSlug: null,
    handoff: null,
    capabilities: {
      supported: false,
      readiness: false,
      worktreeRetirement: false,
      retainedReviewWorktrees: false,
      ownedAttempts: false,
    },
    integrationOwner: null,
    readinessRequired: false,
    readiness: null,
    failure: null,
    retention: null,
    retirement: null,
    successorCandidate: null,
    recovery: null,
    projectionDrift: null,
    linkedRun: row.run_slug
      ? { provider: row.provider, repoRoot: row.repo_root, slug: row.run_slug }
      : null,
    blocker: null,
    error: reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function commissionAttemptsById(commissionId?: string): {
  attempts: Map<string, PipelineCommissionAttempt[]>;
  unsupported: Map<string, string>;
} {
  const filter = commissionId === undefined ? "" : "WHERE commission_id = ?";
  const rows = openDb()
    .prepare(
      `SELECT commission_id, attempt, origin, launch_key, engineer_run_id, previous_engineer_run_id,
              provider_revision, state, terminal_reason, evidence_commit,
              evidence_commit_provenance, evidence_frozen_at, updated_at
         FROM (
           SELECT commission_id, attempt, origin, launch_key, engineer_run_id, previous_engineer_run_id,
                  provider_revision, state, terminal_reason, evidence_commit,
                  evidence_commit_provenance, evidence_frozen_at, updated_at,
                  ROW_NUMBER() OVER (
                    PARTITION BY commission_id ORDER BY attempt DESC
                  ) AS retained_position
             FROM pipeline_commission_attempts
             ${filter}
         )
        WHERE retained_position <= ?
        ORDER BY commission_id, attempt`,
    )
    .all(...(commissionId === undefined
      ? [MAX_PIPELINE_COMMISSION_ATTEMPTS]
      : [commissionId, MAX_PIPELINE_COMMISSION_ATTEMPTS])) as unknown as Array<{
    commission_id: string;
    attempt: number;
    origin: string | null;
    launch_key: string;
    engineer_run_id: string | null;
    previous_engineer_run_id: string | null;
    provider_revision: number;
    state: string;
    terminal_reason: string | null;
    evidence_commit: string | null;
    evidence_commit_provenance: string | null;
    evidence_frozen_at: number | null;
    updated_at: number;
  }>;
  const out = new Map<string, PipelineCommissionAttempt[]>();
  const unsupported = new Map<string, string>();
  for (const row of rows) {
    const origin = row.origin ?? "mission_control";
    if (!(PIPELINE_ATTEMPT_ORIGINS as readonly string[]).includes(origin)) {
      unsupported.set(row.commission_id, `unsupported stored attempt origin ${origin}`);
      continue;
    }
    if (
      row.evidence_commit_provenance !== null &&
      !(PIPELINE_EVIDENCE_COMMIT_PROVENANCES as readonly string[]).includes(
        row.evidence_commit_provenance,
      )
    ) {
      unsupported.set(
        row.commission_id,
        `unsupported stored evidence provenance ${row.evidence_commit_provenance}`,
      );
      continue;
    }
    const state = (PIPELINE_COMMISSION_ATTEMPT_STATES as readonly string[]).includes(row.state)
      ? (row.state as PipelineCommissionAttemptState)
      : "failed";
    const attempt: PipelineCommissionAttempt = {
      attempt: row.attempt,
      origin: origin as PipelineCommissionAttempt["origin"],
      launchKey: row.launch_key,
      engineerRunId: row.engineer_run_id,
      previousEngineerRunId: row.previous_engineer_run_id,
      providerRevision: row.provider_revision,
      state,
      terminalReason:
        state === row.state ? row.terminal_reason : `unsupported stored attempt state ${row.state}`,
      evidenceCommit: row.evidence_commit,
      evidenceCommitProvenance:
        row.evidence_commit_provenance as PipelineCommissionAttempt["evidenceCommitProvenance"],
      evidenceFrozenAt: row.evidence_frozen_at,
      updatedAt: row.updated_at,
    };
    const list = out.get(row.commission_id);
    if (list) list.push(attempt);
    else out.set(row.commission_id, [attempt]);
  }
  return { attempts: out, unsupported };
}

type PipelineCommissionRow = {
  id: string;
  task_id: string;
  provider: string;
  repo_root: string;
  correlation_id: string;
  state_json: string;
  active_attempt: number | null;
  run_slug: string | null;
  created_at: number;
  updated_at: number;
};

function hydratePipelineCommission(
  row: PipelineCommissionRow,
  attemptState: ReturnType<typeof commissionAttemptsById>,
): { commission: PipelineCommission | null; unsupported: boolean } {
  if (!isPipelineProviderId(row.provider)) return { commission: null, unsupported: true };
  const attemptRows = attemptState.attempts.get(row.id) ?? [];
  const unsupportedAttempt = attemptState.unsupported.get(row.id);
  if (unsupportedAttempt) {
    return {
      commission: fallbackCommission(
        row as PipelineCommissionRow & { provider: PipelineProviderId },
        attemptRows,
        unsupportedAttempt,
      ),
      unsupported: true,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.state_json);
  } catch {
    parsed = null;
  }
  if (!validCommissionProjection(parsed)) {
    return {
      commission: fallbackCommission(
        row as PipelineCommissionRow & { provider: PipelineProviderId },
        attemptRows,
        "stored commission projection is unreadable",
      ),
      unsupported: true,
    };
  }
  if (
    parsed.id !== row.id ||
    parsed.taskId !== row.task_id ||
    parsed.provider !== row.provider ||
    parsed.repoRoot !== row.repo_root ||
    parsed.correlationId !== row.correlation_id
  ) {
    return {
      commission: fallbackCommission(
        row as PipelineCommissionRow & { provider: PipelineProviderId },
        attemptRows,
        "stored commission identity does not match its key columns",
      ),
      unsupported: true,
    };
  }
  return {
    commission: {
      ...parsed,
      blocker: parsed.blocker ?? null,
      capabilities: parsed.capabilities ?? {
        supported: true,
        readiness: false,
        worktreeRetirement: false,
        retainedReviewWorktrees: false,
        ownedAttempts: false,
      },
      integrationOwner: parsed.integrationOwner ?? null,
      readinessRequired: parsed.readinessRequired ?? false,
      readiness: parsed.readiness ?? null,
      failure: parsed.failure ?? null,
      retention: parsed.retention ?? null,
      retirement: parsed.retirement ?? null,
      successorCandidate: parsed.successorCandidate ? {
        ...parsed.successorCandidate,
        fingerprint: parsed.successorCandidate.fingerprint ?? "",
        validation: parsed.successorCandidate.validation ?? "invalid",
        validationReason: parsed.successorCandidate.validationReason === undefined
          ? "Refresh this legacy successor before adoption."
          : parsed.successorCandidate.validationReason,
        branch: parsed.successorCandidate.branch ?? null,
        planSlug: parsed.successorCandidate.planSlug ?? null,
        handoff: parsed.successorCandidate.handoff ?? null,
        evidenceCommit: parsed.successorCandidate.evidenceCommit ?? null,
        evidenceCommitProvenance:
          parsed.successorCandidate.evidenceCommitProvenance ?? null,
      } : null,
      recovery: parsed.recovery ?? null,
      projectionDrift: parsed.projectionDrift ?? null,
      authoringBranch: parsed.authoringBranch ?? parsed.handoff?.branch ?? null,
      planSlug: parsed.planSlug ?? parsed.handoff?.planSlug ?? null,
      attempts: attemptRows.map((attempt) => {
        const projected = parsed.attempts.find((entry) => entry.attempt === attempt.attempt);
        return projected ? { ...projected, ...attempt } : attempt;
      }),
      activeAttempt: row.active_attempt,
      linkedRun: row.run_slug
        ? { provider: row.provider, repoRoot: row.repo_root, slug: row.run_slug }
        : null,
    },
    unsupported: false,
  };
}

/** Load every durable commission, degrading one malformed projection without taking down boot. */
export function loadPipelineCommissions(): PipelineCommission[] {
  const attemptState = commissionAttemptsById();
  const rows = openDb()
    .prepare(
      `SELECT id, task_id, provider, repo_root, correlation_id, state_json, active_attempt,
              run_slug, created_at, updated_at
         FROM pipeline_commissions ORDER BY created_at, id`,
    )
    .all() as unknown as PipelineCommissionRow[];
  const out: PipelineCommission[] = [];
  let unsupported = 0;
  for (const row of rows) {
    const hydrated = hydratePipelineCommission(row, attemptState);
    if (hydrated.unsupported) unsupported += 1;
    if (hydrated.commission) out.push(hydrated.commission);
  }
  if (unsupported > 0) {
    console.warn(`[pipelines] found ${unsupported} unsupported commission row(s)`);
  }
  return out;
}

export function getPipelineCommission(id: string): PipelineCommission | null {
  const row = openDb()
    .prepare(
      `SELECT id, task_id, provider, repo_root, correlation_id, state_json, active_attempt,
              run_slug, created_at, updated_at
         FROM pipeline_commissions WHERE id = ?`,
    )
    .get(id) as unknown as PipelineCommissionRow | undefined;
  if (!row) return null;
  return hydratePipelineCommission(row, commissionAttemptsById(id)).commission;
}

export function pipelineCommissionForEngineerRun(engineerRunId: string): PipelineCommission | null {
  const row = openDb()
    .prepare(`SELECT commission_id FROM pipeline_commission_attempts WHERE engineer_run_id = ?`)
    .get(engineerRunId) as { commission_id: string } | undefined;
  return row ? getPipelineCommission(row.commission_id) : null;
}

/** Create one commission and its first reserved attempt in one durable task-binding write. */
export function createPipelineCommissionRow(
  commission: PipelineCommission,
  attempt: PipelineCommissionAttempt,
): void {
  const d = openDb();
  const ownsTransaction = !d.isTransaction;
  if (ownsTransaction) d.exec("BEGIN IMMEDIATE");
  try {
    const task = d.prepare(`SELECT repo_root FROM tasks WHERE id = ?`).get(commission.taskId) as
      | { repo_root: string }
      | undefined;
    if (!task) throw new Error(`pipeline commission task ${commission.taskId} does not exist`);
    if (task.repo_root !== commission.repoRoot) {
      throw new Error("pipeline commission repository does not match its task");
    }
    d.prepare(
      `INSERT INTO pipeline_commissions
         (id, task_id, provider, repo_root, correlation_id, state_json, active_attempt,
          run_slug, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      commission.id,
      commission.taskId,
      commission.provider,
      commission.repoRoot,
      commission.correlationId,
      pipelineCommissionStateJson(commission),
      commission.activeAttempt,
      commission.linkedRun?.slug ?? null,
      commission.createdAt,
      commission.updatedAt,
    );
    d.prepare(
      `INSERT INTO pipeline_commission_attempts
         (commission_id, attempt, origin, launch_key, engineer_run_id, previous_engineer_run_id,
          provider_revision, state, terminal_reason, evidence_commit,
          evidence_commit_provenance, evidence_frozen_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      commission.id,
      attempt.attempt,
      attempt.origin,
      attempt.launchKey,
      attempt.engineerRunId,
      attempt.previousEngineerRunId,
      attempt.providerRevision,
      attempt.state,
      attempt.terminalReason,
      attempt.evidenceCommit,
      attempt.evidenceCommitProvenance,
      attempt.evidenceFrozenAt,
      attempt.updatedAt,
    );
    d.prepare(
      `UPDATE tasks
          SET pipeline_commission_id = ?, pipeline_provider = NULL, pipeline_slug = NULL
        WHERE id = ?`,
    ).run(commission.id, commission.taskId);
    if (ownsTransaction) d.exec("COMMIT");
  } catch (err) {
    if (ownsTransaction) {
      try { d.exec("ROLLBACK"); } catch {}
    }
    throw err;
  }
}

/** Persist an explicit reserved-attempt transition, separate from event reduction. */
export function upsertPipelineCommissionAttempt(
  commission: PipelineCommission,
  attempt: PipelineCommissionAttempt,
): void {
  const d = openDb();
  const ownsTransaction = !d.isTransaction;
  if (ownsTransaction) d.exec("BEGIN IMMEDIATE");
  try {
    d.prepare(
      `INSERT INTO pipeline_commission_attempts
         (commission_id, attempt, origin, launch_key, engineer_run_id, previous_engineer_run_id,
          provider_revision, state, terminal_reason, evidence_commit,
          evidence_commit_provenance, evidence_frozen_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(commission_id, attempt) DO UPDATE SET
         origin=excluded.origin,
         engineer_run_id=excluded.engineer_run_id,
         previous_engineer_run_id=excluded.previous_engineer_run_id,
         provider_revision=excluded.provider_revision,
         state=excluded.state,
         terminal_reason=excluded.terminal_reason,
         evidence_commit=excluded.evidence_commit,
         evidence_commit_provenance=excluded.evidence_commit_provenance,
         evidence_frozen_at=excluded.evidence_frozen_at,
         updated_at=excluded.updated_at`,
    ).run(
      commission.id,
      attempt.attempt,
      attempt.origin,
      attempt.launchKey,
      attempt.engineerRunId,
      attempt.previousEngineerRunId,
      attempt.providerRevision,
      attempt.state,
      attempt.terminalReason,
      attempt.evidenceCommit,
      attempt.evidenceCommitProvenance,
      attempt.evidenceFrozenAt,
      attempt.updatedAt,
    );
    d.prepare(
      `UPDATE pipeline_commissions
          SET state_json = ?, active_attempt = ?, run_slug = ?, updated_at = ? WHERE id = ?`,
    ).run(
      pipelineCommissionStateJson(commission),
      commission.activeAttempt,
      commission.linkedRun?.slug ?? null,
      commission.updatedAt,
      commission.id,
    );
    d.prepare(
      `UPDATE tasks SET pipeline_provider = ?, pipeline_slug = ? WHERE id = ?`,
    ).run(
      commission.linkedRun?.provider ?? null,
      commission.linkedRun?.slug ?? null,
      commission.taskId,
    );
    if (ownsTransaction) d.exec("COMMIT");
  } catch (err) {
    if (ownsTransaction) {
      try { d.exec("ROLLBACK"); } catch {}
    }
    throw err;
  }
}

export type PipelineRecoveryDbResult =
  | { ok: true; commission: PipelineCommission; idempotent: boolean }
  | { ok: false; code: PipelineRecoveryResultCode; error: string };

function recoveryGuardMatches(
  commission: PipelineCommission,
  guard: PipelineRecoveryGuard,
): boolean {
  const attempt = commission.attempts.find((entry) => entry.attempt === guard.activeAttempt);
  return commission.id === guard.commissionId && commission.activeAttempt === guard.activeAttempt &&
    attempt?.engineerRunId === guard.engineerRunId &&
    attempt.providerRevision === guard.providerRevision;
}

function sameRecoveryPredecessor(
  commission: PipelineCommission,
  guard: PipelineRecoveryGuard,
  kind: "retry" | "adoption",
): boolean {
  const recovery = commission.recovery;
  return recovery?.kind === kind && recovery.predecessorAttempt === guard.activeAttempt &&
    recovery.predecessorEngineerRunId === guard.engineerRunId &&
    recovery.predecessorProviderRevision === guard.providerRevision;
}

/** Reserve exactly one Mission Control retry under a serialized predecessor guard. */
export function reservePipelineCommissionRetry(input: {
  guard: PipelineRecoveryGuard;
  launchKey: string;
  now?: number;
}): PipelineRecoveryDbResult {
  const d = openDb();
  const ownsTransaction = !d.isTransaction;
  if (ownsTransaction) d.exec("BEGIN IMMEDIATE");
  try {
    const held = getPipelineCommission(input.guard.commissionId);
    if (!held) {
      if (ownsTransaction) d.exec("ROLLBACK");
      return { ok: false, code: "stale_guard", error: "the Pipeline commission no longer exists" };
    }
    if (sameRecoveryPredecessor(held, input.guard, "retry")) {
      if (ownsTransaction) d.exec("COMMIT");
      return { ok: true, commission: held, idempotent: true };
    }
    if (!recoveryGuardMatches(held, input.guard)) {
      if (ownsTransaction) d.exec("ROLLBACK");
      return { ok: false, code: "stale_guard", error: "the failed Engineer attempt changed" };
    }
    const task = d.prepare(
      `SELECT status, repo_root, pipeline_commission_id FROM tasks WHERE id = ?`,
    ).get(held.taskId) as {
      status: string;
      repo_root: string;
      pipeline_commission_id: string | null;
    } | undefined;
    if (!task || task.pipeline_commission_id !== held.id || task.repo_root !== held.repoRoot ||
        !["running", "failed"].includes(task.status)) {
      if (ownsTransaction) d.exec("ROLLBACK");
      return { ok: false, code: "task_conflict", error: "the task no longer owns this Pipeline commission" };
    }
    const predecessor = held.attempts.find((entry) => entry.attempt === held.activeAttempt);
    if (held.lifecycle !== "failed" || predecessor?.state !== "failed" ||
        held.failure?.retryable !== true) {
      if (ownsTransaction) d.exec("ROLLBACK");
      return { ok: false, code: "not_retryable", error: "the active Engineer failure is not retryable" };
    }
    if (!held.capabilities?.readiness || !held.capabilities.ownedAttempts) {
      if (ownsTransaction) d.exec("ROLLBACK");
      return { ok: false, code: "unsupported_provider", error: "the provider cannot safely reserve owned recovery attempts" };
    }
    if (held.successorCandidate || pipelineRecoveryIsActive(held.recovery)) {
      if (ownsTransaction) d.exec("ROLLBACK");
      return { ok: false, code: "recovery_in_flight", error: "another Pipeline successor already exists" };
    }
    const now = input.now ?? Date.now();
    const attempt: PipelineCommissionAttempt = {
      attempt: predecessor.attempt + 1,
      origin: "mission_control",
      launchKey: input.launchKey,
      engineerRunId: null,
      previousEngineerRunId: predecessor.engineerRunId,
      providerRevision: 0,
      state: "reserved",
      terminalReason: null,
      evidenceCommit: null,
      evidenceCommitProvenance: null,
      evidenceFrozenAt: null,
      updatedAt: now,
    };
    const next: PipelineCommission = {
      ...held,
      lifecycle: "created",
      attempts: [...held.attempts, attempt].slice(-MAX_PIPELINE_COMMISSION_ATTEMPTS),
      activeAttempt: attempt.attempt,
      steps: held.steps.map((step) => ({ ...step, state: "pending" })),
      currentStep: null,
      project: null,
      authoringWorktree: null,
      authoringBranch: null,
      planSlug: null,
      handoff: null,
      readiness: null,
      failure: null,
      retention: null,
      retirement: null,
      successorCandidate: null,
      projectionDrift: null,
      linkedRun: null,
      blocker: null,
      error: null,
      recovery: {
        kind: "retry",
        predecessorAttempt: predecessor.attempt,
        predecessorEngineerRunId: predecessor.engineerRunId!,
        predecessorProviderRevision: predecessor.providerRevision,
        attempt: attempt.attempt,
        state: "reserved",
        candidateFingerprint: null,
        error: null,
        startedAt: now,
        updatedAt: now,
      },
      updatedAt: now,
    };
    upsertPipelineCommissionAttempt(next, attempt);
    if (ownsTransaction) d.exec("COMMIT");
    return { ok: true, commission: next, idempotent: false };
  } catch (error) {
    if (ownsTransaction) {
      try { d.exec("ROLLBACK"); } catch {}
    }
    throw error;
  }
}

/** Insert a validated provider successor before its existing journal is replayed. */
export function reservePipelineCommissionAdoption(input: {
  guard: PipelineRecoveryGuard;
  candidate: NonNullable<PipelineCommission["successorCandidate"]>;
  now?: number;
}): PipelineRecoveryDbResult {
  const d = openDb();
  const ownsTransaction = !d.isTransaction;
  if (ownsTransaction) d.exec("BEGIN IMMEDIATE");
  try {
    const held = getPipelineCommission(input.guard.commissionId);
    if (!held) {
      if (ownsTransaction) d.exec("ROLLBACK");
      return { ok: false, code: "stale_guard", error: "the Pipeline commission no longer exists" };
    }
    if (sameRecoveryPredecessor(held, input.guard, "adoption")) {
      if (held.recovery?.candidateFingerprint !== input.candidate.fingerprint) {
        if (ownsTransaction) d.exec("ROLLBACK");
        return { ok: false, code: "candidate_changed", error: "the provider successor changed during adoption" };
      }
      if (ownsTransaction) d.exec("COMMIT");
      return { ok: true, commission: held, idempotent: true };
    }
    if (!recoveryGuardMatches(held, input.guard)) {
      if (ownsTransaction) d.exec("ROLLBACK");
      return { ok: false, code: "stale_guard", error: "the failed Engineer attempt changed" };
    }
    const task = d.prepare(
      `SELECT status, repo_root, pipeline_commission_id FROM tasks WHERE id = ?`,
    ).get(held.taskId) as {
      status: string;
      repo_root: string;
      pipeline_commission_id: string | null;
    } | undefined;
    if (!task || task.pipeline_commission_id !== held.id || task.repo_root !== held.repoRoot ||
        !["running", "failed"].includes(task.status)) {
      if (ownsTransaction) d.exec("ROLLBACK");
      return { ok: false, code: "task_conflict", error: "the task no longer owns this Pipeline commission" };
    }
    const predecessor = held.attempts.find((entry) => entry.attempt === held.activeAttempt);
    const candidate = held.successorCandidate;
    if (!predecessor?.engineerRunId || predecessor.state !== "failed" ||
        !candidate || candidate.validation !== "valid") {
      if (ownsTransaction) d.exec("ROLLBACK");
      return { ok: false, code: "lineage_mismatch", error: "no validated direct successor is available" };
    }
    if (candidate.fingerprint !== input.candidate.fingerprint ||
        candidate.engineerRunId !== input.candidate.engineerRunId ||
        candidate.providerRevision !== input.candidate.providerRevision) {
      if (ownsTransaction) d.exec("ROLLBACK");
      return { ok: false, code: "candidate_changed", error: "the provider successor changed during adoption" };
    }
    const now = input.now ?? Date.now();
    const attempt: PipelineCommissionAttempt = {
      attempt: candidate.attempt,
      origin: "provider_reconciled",
      launchKey: candidate.attemptKey,
      engineerRunId: candidate.engineerRunId,
      previousEngineerRunId: candidate.previousEngineerRunId,
      providerRevision: 0,
      state: "reserved",
      terminalReason: null,
      evidenceCommit: candidate.evidenceCommit ?? null,
      evidenceCommitProvenance: candidate.evidenceCommitProvenance ?? null,
      evidenceFrozenAt: candidate.evidenceCommit ? now : null,
      updatedAt: now,
    };
    const next: PipelineCommission = {
      ...held,
      lifecycle: "created",
      attempts: [...held.attempts, attempt].slice(-MAX_PIPELINE_COMMISSION_ATTEMPTS),
      activeAttempt: attempt.attempt,
      steps: held.steps.map((step) => ({ ...step, state: "pending" })),
      currentStep: null,
      project: null,
      authoringWorktree: null,
      authoringBranch: null,
      planSlug: null,
      handoff: null,
      readiness: null,
      failure: null,
      retention: null,
      retirement: null,
      projectionDrift: null,
      linkedRun: null,
      blocker: null,
      error: null,
      recovery: {
        kind: "adoption",
        predecessorAttempt: predecessor.attempt,
        predecessorEngineerRunId: predecessor.engineerRunId,
        predecessorProviderRevision: predecessor.providerRevision,
        attempt: attempt.attempt,
        state: "adoption_replaying",
        candidateFingerprint: candidate.fingerprint ?? null,
        error: null,
        startedAt: now,
        updatedAt: now,
      },
      updatedAt: now,
    };
    upsertPipelineCommissionAttempt(next, attempt);
    if (ownsTransaction) d.exec("COMMIT");
    return { ok: true, commission: next, idempotent: false };
  } catch (error) {
    if (ownsTransaction) {
      try { d.exec("ROLLBACK"); } catch {}
    }
    throw error;
  }
}

/** Advance only the bounded saga cursor for one already-reserved attempt. */
export function updatePipelineCommissionRecovery(input: {
  commissionId: string;
  attempt: number;
  expectedState?: NonNullable<PipelineCommission["recovery"]>["state"];
  state: NonNullable<PipelineCommission["recovery"]>["state"];
  error?: string | null;
  clearCandidate?: boolean;
  now?: number;
}): PipelineCommission | null {
  const d = openDb();
  const ownsTransaction = !d.isTransaction;
  if (ownsTransaction) d.exec("BEGIN IMMEDIATE");
  try {
    const held = getPipelineCommission(input.commissionId);
    const attempt = held?.attempts.find((entry) => entry.attempt === input.attempt);
    if (
      !held?.recovery || held.recovery.attempt !== input.attempt || !attempt ||
      (input.expectedState !== undefined && held.recovery.state !== input.expectedState)
    ) {
      if (ownsTransaction) d.exec("ROLLBACK");
      return null;
    }
    const now = input.now ?? Date.now();
    const next: PipelineCommission = {
      ...held,
      successorCandidate: input.clearCandidate ? null : held.successorCandidate,
      recovery: {
        ...held.recovery,
        state: input.state,
        error: input.error === undefined ? held.recovery.error : input.error?.slice(0, 500) ?? null,
        updatedAt: now,
      },
      updatedAt: now,
    };
    upsertPipelineCommissionAttempt(next, attempt);
    if (ownsTransaction) d.exec("COMMIT");
    return next;
  } catch (error) {
    if (ownsTransaction) {
      try { d.exec("ROLLBACK"); } catch {}
    }
    throw error;
  }
}

export type PipelineEvidenceAdvance = "stored" | "stale" | "frozen";

/**
 * Advance one attempt's immutable Git evidence with predecessor-and-freeze compare-and-swap.
 * Validation of repository identity and ancestry belongs to the workspace resolver; this
 * function owns only the serialized database boundary.
 */
export function advancePipelineCommissionEvidence(input: {
  commissionId: string;
  attempt: number;
  previousCommit: string | null;
  commit: string;
  provenance: PipelineCommissionAttempt["evidenceCommitProvenance"];
  frozenAt?: number | null;
}): PipelineEvidenceAdvance {
  const d = openDb();
  const ownsTransaction = !d.isTransaction;
  if (ownsTransaction) d.exec("BEGIN IMMEDIATE");
  try {
    const current = d.prepare(
      `SELECT evidence_commit, evidence_frozen_at
         FROM pipeline_commission_attempts
        WHERE commission_id = ? AND attempt = ?`,
    ).get(input.commissionId, input.attempt) as {
      evidence_commit: string | null;
      evidence_frozen_at: number | null;
    } | undefined;
    if (!current || current.evidence_commit !== input.previousCommit) {
      if (ownsTransaction) d.exec("ROLLBACK");
      return "stale";
    }
    if (current.evidence_frozen_at !== null) {
      if (ownsTransaction) d.exec("ROLLBACK");
      return "frozen";
    }
    const changed = d.prepare(
      `UPDATE pipeline_commission_attempts
          SET evidence_commit = ?, evidence_commit_provenance = ?, evidence_frozen_at = ?
        WHERE commission_id = ? AND attempt = ?
          AND evidence_frozen_at IS NULL
          AND ((?6 IS NULL AND evidence_commit IS NULL) OR evidence_commit = ?6)`,
    ).run(
      input.commit,
      input.provenance,
      input.frozenAt ?? null,
      input.commissionId,
      input.attempt,
      input.previousCommit,
    );
    if (Number(changed.changes) !== 1) {
      if (ownsTransaction) d.exec("ROLLBACK");
      return "stale";
    }
    const commission = getPipelineCommission(input.commissionId);
    if (!commission) throw new Error(`pipeline commission ${input.commissionId} disappeared`);
    d.prepare(`UPDATE pipeline_commissions SET state_json = ? WHERE id = ?`).run(
      pipelineCommissionStateJson(commission),
      input.commissionId,
    );
    if (ownsTransaction) d.exec("COMMIT");
    return "stored";
  } catch (error) {
    if (ownsTransaction) {
      try { d.exec("ROLLBACK"); } catch {}
    }
    throw error;
  }
}

export type PipelineCommissionEventCommit = "stored" | "duplicate" | "stale" | "conflict";

/**
 * Commit one already-reduced provider event. Revision compare, evidence append, attempt cursor,
 * projection, exact task run link, and cap all share one transaction.
 */
export function commitPipelineCommissionEvent(input: {
  previousRevision: number;
  attempt: PipelineCommissionAttempt;
  commission: PipelineCommission;
  kind: string;
  body: Record<string, unknown>;
  observedAt: number;
}): PipelineCommissionEventCommit {
  const d = openDb();
  const ownsTransaction = !d.isTransaction;
  if (ownsTransaction) d.exec("BEGIN IMMEDIATE");
  try {
    const current = d.prepare(
      `SELECT provider_revision, evidence_commit, evidence_commit_provenance,
              evidence_frozen_at
         FROM pipeline_commission_attempts
        WHERE commission_id = ? AND attempt = ?`,
    ).get(input.commission.id, input.attempt.attempt) as {
      provider_revision: number;
      evidence_commit: string | null;
      evidence_commit_provenance: PipelineCommissionAttempt["evidenceCommitProvenance"];
      evidence_frozen_at: number | null;
    } | undefined;
    if (!current) {
      if (ownsTransaction) d.exec("ROLLBACK");
      return "conflict";
    }
    if (input.attempt.providerRevision <= current.provider_revision) {
      const duplicate = d.prepare(
        `SELECT body FROM pipeline_commission_events
          WHERE commission_id = ? AND engineer_attempt = ? AND provider_revision = ?`,
      ).get(
        input.commission.id,
        input.attempt.attempt,
        input.attempt.providerRevision,
      ) as { body: string } | undefined;
      if (ownsTransaction) d.exec("ROLLBACK");
      return duplicate && duplicate.body === JSON.stringify(input.body) ? "duplicate" : "stale";
    }
    if (
      current.provider_revision !== input.previousRevision ||
      input.attempt.providerRevision !== input.previousRevision + 1
    ) {
      if (ownsTransaction) d.exec("ROLLBACK");
      return "conflict";
    }
    const head = d.prepare(
      `SELECT COALESCE(MAX(seq), 0) AS top FROM pipeline_commission_events WHERE commission_id = ?`,
    ).get(input.commission.id) as { top: number } | undefined;
    const seq = Number(head?.top ?? 0) + 1;
    d.prepare(
      `INSERT INTO pipeline_commission_events
         (commission_id, seq, engineer_attempt, provider_revision, kind, body, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.commission.id,
      seq,
      input.attempt.attempt,
      input.attempt.providerRevision,
      input.kind,
      JSON.stringify(input.body),
      input.observedAt,
    );
    const committedAttempt: PipelineCommissionAttempt = {
      ...input.attempt,
      evidenceCommit: current.evidence_commit ?? input.attempt.evidenceCommit,
      evidenceCommitProvenance:
        current.evidence_commit_provenance ?? input.attempt.evidenceCommitProvenance,
      evidenceFrozenAt:
        current.evidence_frozen_at ?? input.attempt.evidenceFrozenAt,
    };
    const committedCommission: PipelineCommission = {
      ...input.commission,
      attempts: input.commission.attempts.map((attempt) =>
        attempt.attempt === committedAttempt.attempt ? committedAttempt : attempt,
      ),
    };
    d.prepare(
      `UPDATE pipeline_commission_attempts
          SET engineer_run_id = ?, previous_engineer_run_id = ?, provider_revision = ?,
              state = ?, terminal_reason = ?, evidence_commit = ?,
              evidence_commit_provenance = ?, evidence_frozen_at = ?, updated_at = ?
        WHERE commission_id = ? AND attempt = ?`,
    ).run(
      committedAttempt.engineerRunId,
      committedAttempt.previousEngineerRunId,
      committedAttempt.providerRevision,
      committedAttempt.state,
      committedAttempt.terminalReason,
      committedAttempt.evidenceCommit,
      committedAttempt.evidenceCommitProvenance,
      committedAttempt.evidenceFrozenAt,
      committedAttempt.updatedAt,
      input.commission.id,
      committedAttempt.attempt,
    );
    d.prepare(
      `UPDATE pipeline_commissions
          SET state_json = ?, active_attempt = ?, run_slug = ?, updated_at = ? WHERE id = ?`,
    ).run(
      pipelineCommissionStateJson(committedCommission),
      committedCommission.activeAttempt,
      committedCommission.linkedRun?.slug ?? null,
      committedCommission.updatedAt,
      committedCommission.id,
    );
    d.prepare(
      `UPDATE tasks SET pipeline_provider = ?, pipeline_slug = ? WHERE id = ?`,
    ).run(
      input.commission.linkedRun?.provider ?? null,
      input.commission.linkedRun?.slug ?? null,
      input.commission.taskId,
    );
    d.prepare(
      `DELETE FROM pipeline_commission_events
        WHERE commission_id = ? AND seq <= ?`,
    ).run(input.commission.id, seq - MAX_PIPELINE_COMMISSION_EVENTS);
    if (ownsTransaction) d.exec("COMMIT");
    return "stored";
  } catch (err) {
    if (ownsTransaction) {
      try { d.exec("ROLLBACK"); } catch {}
    }
    throw err;
  }
}

export function countPipelineCommissionEvents(commissionId: string): number {
  const row = openDb()
    .prepare(`SELECT COUNT(*) AS n FROM pipeline_commission_events WHERE commission_id = ?`)
    .get(commissionId) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

export function deletePipelineCommissionRow(id: string): void {
  const d = openDb();
  const ownsTransaction = !d.isTransaction;
  if (ownsTransaction) d.exec("BEGIN IMMEDIATE");
  try {
    d.prepare(`UPDATE tasks SET pipeline_commission_id = NULL WHERE pipeline_commission_id = ?`).run(id);
    d.prepare(`DELETE FROM pipeline_commission_events WHERE commission_id = ?`).run(id);
    d.prepare(`DELETE FROM pipeline_commission_attempts WHERE commission_id = ?`).run(id);
    d.prepare(`DELETE FROM pipeline_commissions WHERE id = ?`).run(id);
    if (ownsTransaction) d.exec("COMMIT");
  } catch (err) {
    if (ownsTransaction) {
      try { d.exec("ROLLBACK"); } catch {}
    }
    throw err;
  }
}

// ---- the pipeline event ledger ----
//
// Read the `pipeline_events` CREATE TABLE above before touching any of this. The one rule
// that is not obvious from the DDL: nothing in the projection is DERIVED from this table.
// A run's cost, group, steps and halt all come from the engine's own files by way of the
// tail and the state readers, exactly as they did before this table existed. That is what
// makes a duplicate row here a wart rather than a wrong number, and it is why the ledger
// could be dropped whole without the dashboard changing what it says.

/** How many events one run keeps. Older ones are trimmed as newer ones arrive. */
export const MAX_PIPELINE_EVENTS_PER_RUN = 2000;

/** Which path first observed an event. */
export type PipelineEventSource = "tail" | "ingest";

/** One engine event, in the shape the ledger stores it. */
export interface PipelineEventInput {
  /** The engine's discriminant, or null for a record that names none. */
  kind: string | null;
  /** The writer's own ISO-8601 instant, or null. */
  ts: string | null;
  /** The producer's own coordinate - a byte offset, or the envelope's `seq`. */
  producerSeq: number | null;
  /** The record itself, as the producer wrote it. */
  body: Record<string, unknown>;
}

/** One stored ledger row, for the readers that walk a run's history. */
export interface PipelineEventRow {
  seq: number;
  kind: string;
  ts: string | null;
  source: PipelineEventSource;
  producerSeq: number | null;
  /**
   * The other path's coordinate, once it has seen this event, and null until then.
   *
   * The honest answer to "did both paths see this one", which `source` cannot give: null on a
   * pushed event means a kind conductor never wrote to a file, and null on a tailed event
   * means one the plugin never delivered.
   */
  alsoSeq: number | null;
  body: Record<string, unknown>;
  receivedAt: number;
}

/**
 * Fields a WRITER adds to an event, which are therefore not part of its identity.
 *
 * This is the load-bearing list, and it was measured rather than guessed: ai-conductor's
 * `EventPersister` does not write the event it was handed. It writes
 * `{ ...event, activeInterval?, observedIntervals?, ts }` - a stamped instant plus the
 * durations it measured while holding the event. So the record in `events.jsonl` and the
 * record on the bus are DIFFERENT OBJECTS describing one event, and a hash over either one
 * whole can never match the other.
 *
 * Stripping them is not a workaround for that; it is the definition it forces into the open.
 * The identity of an event is what the engine emitted. When it was written down, and how
 * long the writer had been holding it, are facts about the observation.
 *
 * The cost is stated rather than hidden: two events in one run that are byte-identical once
 * these are removed - a `step_started` for a step that was retried, say - are one fingerprint.
 * That is why the fingerprint is not the whole of convergence. `also_seq` carries the rest,
 * so a repeat is kept as its own row instead of being read as an event already stored; see
 * `appendPipelineEvents`. If conductor ever stamps a sequence number on persisted events
 * (proposed alongside the visualizer wiring upstream), the identity becomes exact by itself
 * and both this list and the claim can go.
 */
const OBSERVATION_ONLY_FIELDS = ["ts", "activeInterval", "observedIntervals"] as const;

/**
 * The identity of an EVENT, as against the identity of one observation of it.
 *
 * Keys are sorted at every level before hashing, because the two paths do not build the
 * object the same way: the tail gets it back from `JSON.parse` of a line the engine wrote,
 * and the plugin hands over an object the engine's own bus constructed. Both round-trip to
 * the same *values*; only the key order is an accident of construction, and a hash over
 * `JSON.stringify` alone would make that accident decide whether an event is a duplicate.
 *
 * This is a convergence aid and never a validity check. Two observations that hash apart
 * cost one extra row and nothing else - see the section header.
 */
function pipelineEventFingerprint(body: Record<string, unknown>): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (typeof value === "object" && value !== null) {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        out[key] = canonical((value as Record<string, unknown>)[key]);
      }
      return out;
    }
    return value;
  };
  const stripped: Record<string, unknown> = { ...body };
  for (const field of OBSERVATION_ONLY_FIELDS) delete stripped[field];
  return createHash("sha256").update(JSON.stringify(canonical(stripped))).digest("hex");
}

/**
 * Append what one path observed of one run, and say how much of it was new.
 *
 * Every event takes one of three outcomes, decided in this order:
 *
 *  1. **This path has already recorded it**, under this very coordinate - a re-read of a
 *     replaced `events.jsonl` from byte zero, or a batch the plugin re-sent after a failed
 *     delivery. Nothing is stored and nothing is claimed.
 *  2. **The other path recorded it and this one had not been counted.** The oldest such row
 *     is claimed by stamping this coordinate into `also_seq`. One event, one row, seen twice.
 *  3. **Otherwise it is an occurrence nobody has recorded**, and it gets a row.
 *
 * Rule 2 is what keeps convergence exact while rule 3 keeps a REPEAT. Those two pull against
 * each other - conductor stamps no sequence number, so a retried step emits a record
 * byte-identical to its first attempt - and a fingerprint comparison alone has to answer both
 * with one verdict. Claiming is what separates them: a row may be converged onto once, so the
 * second occurrence finds nothing to claim and is stored. See `also_seq` in the DDL.
 *
 * An event that converges does not consume an ordinal, so `seq` stays gapless and means "the
 * Nth distinct occurrence Mission Control has recorded for this run". `INSERT OR IGNORE`
 * rather than a named `ON CONFLICT` target, deliberately: two UNIQUE indexes have to hold at
 * once - the key, and the observation - and a bare ignore is the only form that answers to
 * both.
 *
 * One transaction for the batch, because a first pass over an existing ledger is up to a few
 * thousand rows and a commit each would be a few thousand fsyncs.
 */
export function appendPipelineEvents(
  provider: PipelineProviderId,
  repoRoot: string,
  slug: string,
  source: PipelineEventSource,
  events: readonly PipelineEventInput[],
  now = Date.now(),
): number {
  if (events.length === 0) return 0;
  const d = openDb();
  const ownsTransaction = !d.isTransaction;
  if (ownsTransaction) d.exec("BEGIN IMMEDIATE");
  try {
    const head = d
      .prepare(
        `SELECT COALESCE(MAX(seq), 0) AS top FROM pipeline_events
          WHERE provider = ? AND repo_root = ? AND slug = ?`,
      )
      .get(provider, repoRoot, slug) as unknown as { top: number } | undefined;
    let next = Number(head?.top ?? 0);
    const insert = d.prepare(
      `INSERT OR IGNORE INTO pipeline_events
         (provider, repo_root, slug, seq, kind, ts, source, producer_seq, also_seq, fingerprint,
          body, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    );
    /** Rule 1: this path's own coordinate for this event is already on a row. */
    const recorded = d.prepare(
      `SELECT 1 AS hit FROM pipeline_events
        WHERE provider = ? AND repo_root = ? AND slug = ? AND fingerprint = ?
          AND (CASE WHEN source = ? THEN producer_seq ELSE also_seq END) = ?
        LIMIT 1`,
    );
    /** Rule 1 for a producer that offered no coordinate at all - see below. */
    const anyRow = d.prepare(
      `SELECT 1 AS hit FROM pipeline_events
        WHERE provider = ? AND repo_root = ? AND slug = ? AND fingerprint = ? LIMIT 1`,
    );
    /** Rule 2: the oldest occurrence the other path recorded and this one has not claimed. */
    const claimable = d.prepare(
      `SELECT seq FROM pipeline_events
        WHERE provider = ? AND repo_root = ? AND slug = ? AND fingerprint = ?
          AND source <> ? AND also_seq IS NULL
        ORDER BY seq LIMIT 1`,
    );
    const claim = d.prepare(
      `UPDATE pipeline_events SET also_seq = ?
        WHERE provider = ? AND repo_root = ? AND slug = ? AND seq = ?`,
    );
    let stored = 0;
    for (const event of events) {
      const fingerprint = pipelineEventFingerprint(event.body);
      const at = event.producerSeq;
      if (at === null) {
        // No coordinate, so this path cannot tell its own repeat from its own re-offer, and
        // converging on the fingerprint alone is the only honest answer left - which is what
        // every observation did before repeats were kept. Neither producer here is in this
        // case: the tail's coordinate is a byte offset and the plugin's envelope requires a
        // `seq`, so this is the branch for a producer that has not been written yet.
        if (anyRow.get(provider, repoRoot, slug, fingerprint)) continue;
      } else {
        if (recorded.get(provider, repoRoot, slug, fingerprint, source, at)) continue;
        const row = claimable.get(provider, repoRoot, slug, fingerprint, source) as unknown as
          | { seq: number }
          | undefined;
        if (row) {
          claim.run(at, provider, repoRoot, slug, Number(row.seq));
          continue;
        }
      }
      const result = insert.run(
        provider,
        repoRoot,
        slug,
        next + 1,
        event.kind && event.kind !== "" ? event.kind : "unknown",
        event.ts,
        source,
        at,
        fingerprint,
        JSON.stringify(event.body),
        now,
      );
      if (Number(result.changes) > 0) {
        next += 1;
        stored += 1;
      }
    }
    if (stored > 0) {
      // Bounded by the runs that exist, not by uptime. The cap is per run and the trim runs
      // only on a batch that actually stored something, so a quiet ledger costs no DELETE.
      d.prepare(
        `DELETE FROM pipeline_events
          WHERE provider = ? AND repo_root = ? AND slug = ? AND seq <= ?`,
      ).run(provider, repoRoot, slug, next - MAX_PIPELINE_EVENTS_PER_RUN);
    }
    if (ownsTransaction) d.exec("COMMIT");
    return stored;
  } catch (err) {
    if (ownsTransaction) {
      try {
        d.exec("ROLLBACK");
      } catch {}
    }
    throw err;
  }
}

/** One run's observed history, oldest first. Bounded by `limit`, newest kept. */
export function pipelineEvents(
  provider: PipelineProviderId,
  repoRoot: string,
  slug: string,
  limit = MAX_PIPELINE_EVENTS_PER_RUN,
): PipelineEventRow[] {
  const rows = openDb()
    .prepare(
      `SELECT seq, kind, ts, source, producer_seq, also_seq, body, received_at
         FROM pipeline_events
        WHERE provider = ? AND repo_root = ? AND slug = ?
        ORDER BY seq DESC LIMIT ?`,
    )
    .all(provider, repoRoot, slug, limit) as unknown as Array<{
    seq: number;
    kind: string;
    ts: string | null;
    source: string;
    producer_seq: number | null;
    also_seq: number | null;
    body: string;
    received_at: number;
  }>;
  const out: PipelineEventRow[] = [];
  for (const row of rows.reverse()) {
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(row.body);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
      body = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    out.push({
      seq: row.seq,
      kind: row.kind,
      ts: row.ts,
      source: row.source === "ingest" ? "ingest" : "tail",
      producerSeq: row.producer_seq,
      alsoSeq: row.also_seq,
      body,
      receivedAt: row.received_at,
    });
  }
  return out;
}

/** How many events one run's ledger holds. For the tests and the health line. */
export function countPipelineEvents(
  provider: PipelineProviderId,
  repoRoot: string,
  slug: string,
): number {
  const row = openDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM pipeline_events
        WHERE provider = ? AND repo_root = ? AND slug = ?`,
    )
    .get(provider, repoRoot, slug) as unknown as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

/**
 * Retire one run's ledger.
 *
 * Called wherever the run itself is retired, and that pairing is the whole retention story:
 * the ledger describes runs, so it lives exactly as long as they do. Separate from
 * `deletePipelineRunRow` rather than folded into it because the projection is a cache that
 * is legitimately rebuilt from files, and a rebuild must not throw away the observed history
 * of runs that are still there.
 */
export function deletePipelineEventsForRun(
  provider: PipelineProviderId,
  repoRoot: string,
  slug: string,
): void {
  openDb()
    .prepare(`DELETE FROM pipeline_events WHERE provider = ? AND repo_root = ? AND slug = ?`)
    .run(provider, repoRoot, slug);
}

/**
 * Every slug this repository has ledger rows under.
 *
 * Retirement's own question, and it has to be asked of the LEDGER rather than of the
 * projection's cursors. A cursor exists only once a pass has read a run's files; a pushed
 * event can be accepted for a run that is torn down before that pass ever happens. Walking
 * cursors alone would leave those rows with nothing that could ever visit them, so this is
 * what makes "bounded by the runs that exist" true for rows that arrived by either path.
 */
export function pipelineEventSlugs(
  provider: PipelineProviderId,
  repoRoot: string,
): string[] {
  return openDb()
    .prepare(`SELECT DISTINCT slug FROM pipeline_events WHERE provider = ? AND repo_root = ?`)
    .all(provider, repoRoot)
    .map((row) => String((row as { slug: unknown }).slug));
}

/** Retire a whole repository's ledger - its consent was withdrawn. */
export function deletePipelineEventsForRepo(
  provider: PipelineProviderId,
  repoRoot: string,
): void {
  openDb()
    .prepare(`DELETE FROM pipeline_events WHERE provider = ? AND repo_root = ?`)
    .run(provider, repoRoot);
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

// ---- session launch turns (how the dashboard presents a managed launch) ----

interface SessionLaunchTurnRow {
  note_key: string;
  fingerprint: string;
  echo_fingerprint: string | null;
  display_text: string | null;
  message_id: string | null;
  created_at: number;
  updated_at: number;
}

function rowToLaunchTurn(r: SessionLaunchTurnRow): LaunchTurnMarker {
  return {
    noteKey: r.note_key,
    fingerprint: r.fingerprint,
    echoFingerprint: r.echo_fingerprint,
    displayText: r.display_text,
    messageId: r.message_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Record (or replace) the launch marker for one logical conversation.
 *
 * A plain upsert, because a second dispatch into a key that already holds a marker IS the
 * later launch: the earlier conversation it described has been replaced, and the row that
 * survives has to be the one whose prompt is actually at the top of the transcript now.
 * `created_at` is preserved across a replacement so pruning cannot be reset by a rewrite.
 */
export function upsertSessionLaunchTurn(marker: LaunchTurnMarker): void {
  openDb()
    .prepare(
      `INSERT INTO session_launch_turns
         (note_key, fingerprint, echo_fingerprint, display_text, message_id,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(note_key) DO UPDATE SET
         fingerprint=excluded.fingerprint,
         echo_fingerprint=excluded.echo_fingerprint,
         display_text=excluded.display_text,
         message_id=excluded.message_id,
         updated_at=excluded.updated_at`,
    )
    .run(
      marker.noteKey,
      marker.fingerprint,
      marker.echoFingerprint,
      marker.displayText,
      marker.messageId,
      marker.createdAt,
      marker.updatedAt,
    );
}

export function getSessionLaunchTurn(noteKey: string): LaunchTurnMarker | undefined {
  const r = openDb()
    .prepare(
      `SELECT note_key, fingerprint, echo_fingerprint, display_text, message_id,
              created_at, updated_at
         FROM session_launch_turns WHERE note_key = ?`,
    )
    .get(noteKey) as unknown as SessionLaunchTurnRow | undefined;
  return r ? rowToLaunchTurn(r) : undefined;
}

/** All markers, reloaded into the registry on start - the notes/goals/invites boot pattern. */
export function loadSessionLaunchTurns(): LaunchTurnMarker[] {
  const rows = openDb()
    .prepare(
      `SELECT note_key, fingerprint, echo_fingerprint, display_text, message_id,
              created_at, updated_at
         FROM session_launch_turns ORDER BY updated_at DESC`,
    )
    .all() as unknown as SessionLaunchTurnRow[];
  return rows.map(rowToLaunchTurn);
}

/**
 * Drop a marker whose launch did not happen - the rollback half of recording one BEFORE
 * the prompt crosses into the runtime.
 *
 * A marker with no delivery behind it is worse than no marker: it says the dashboard should
 * project a turn that will never be written, and the next real human message to land under
 * that key is the one it would be compared against.
 */
export function deleteSessionLaunchTurn(noteKey: string): void {
  openDb().prepare(`DELETE FROM session_launch_turns WHERE note_key = ?`).run(noteKey);
}

/**
 * Carry a marker from the provisional session key to the harness-native conversation key.
 *
 * Called ONLY for that first bind - see `Registry.moveLaunchTurnOnInitialBind` for why a
 * native-to-native rotation (a `/clear`) must strand the row instead. Last-write-wins on
 * the destination for the same reason `moveForemanInvite` does it: the moved row followed
 * the conversation, and anything already under the target key is that conversation's own
 * earlier state.
 */
export function moveSessionLaunchTurn(fromKey: string, toKey: string): void {
  if (fromKey === toKey) return;
  const d = openDb();
  const row = getSessionLaunchTurn(fromKey);
  if (!row) return;
  d.exec("BEGIN IMMEDIATE");
  try {
    d.prepare(
      `INSERT INTO session_launch_turns
         (note_key, fingerprint, display_text, message_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(note_key) DO UPDATE SET
         fingerprint=excluded.fingerprint,
         display_text=excluded.display_text,
         message_id=excluded.message_id,
         created_at=excluded.created_at,
         updated_at=excluded.updated_at`,
    ).run(toKey, row.fingerprint, row.displayText, row.messageId, row.createdAt, row.updatedAt);
    d.prepare(`DELETE FROM session_launch_turns WHERE note_key = ?`).run(fromKey);
    d.exec("COMMIT");
  } catch (err) {
    if (d.isTransaction) d.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Delete markers that belong to no live session and have gone stale. Returns how many.
 *
 * The same shape and the same safety property as `pruneSessionGoals` and
 * `pruneForemanInvites`: a row whose key still belongs to a session is never touched no
 * matter how old it is, and an EMPTY `liveKeys` means "liveness unknown", never "nothing is
 * live", so it deletes nothing. Stranding is the ordinary end of one of these rows - every
 * `/clear` rotates the key past it deliberately - so the accumulation this answers is the
 * goal table's, and it answers it on the goal table's tick.
 */
export function pruneSessionLaunchTurns(liveKeys: Iterable<string>, olderThan: number): number {
  const keys = [...new Set(liveKeys)];
  if (!keys.length) return 0;
  const placeholders = keys.map(() => "?").join(",");
  const r = openDb()
    .prepare(
      `DELETE FROM session_launch_turns
         WHERE updated_at < ? AND note_key NOT IN (${placeholders})`,
    )
    .run(olderThan, ...keys);
  return Number(r.changes);
}

// ---- session standing instructions (what a launch actually delivered) ----

/** One session's launch snapshot: what was delivered, how, and from which stored keys. */
export interface StandingInstructionsSnapshot {
  noteKey: string;
  /** The composed block exactly as the agent received it. */
  text: string;
  mechanism: StandingInstructionsMechanism;
  /** One entry per contributing repository, in the launch manifest's order. */
  sources: StandingInstructionsSource[];
  createdAt: number;
}

interface StandingInstructionsRow {
  note_key: string;
  text: string;
  mechanism: string;
  sources: string;
  created_at: number;
}

/**
 * Read a row back, tolerating anything a NEWER build could have written.
 *
 * An unreadable `sources` degrades to an empty array and an unknown `mechanism` degrades to
 * `"prompt-prefix"` rather than dropping the row: the text is the part that matters here -
 * it is what an assignment replays and what the header shows - and discarding a real
 * delivery record because its provenance column could not be parsed would lose the only
 * evidence of what a session was told.
 */
function rowToStandingInstructions(r: StandingInstructionsRow): StandingInstructionsSnapshot {
  let sources: StandingInstructionsSource[] = [];
  try {
    const parsed: unknown = JSON.parse(r.sources);
    if (Array.isArray(parsed)) {
      sources = parsed.flatMap((entry): StandingInstructionsSource[] => {
        if (typeof entry !== "object" || entry === null) return [];
        const repoPath = (entry as { repoPath?: unknown }).repoPath;
        const matchedKey = (entry as { matchedKey?: unknown }).matchedKey;
        if (typeof repoPath !== "string") return [];
        return [{ repoPath, matchedKey: typeof matchedKey === "string" ? matchedKey : null }];
      });
    }
  } catch {
    sources = [];
  }
  const mechanism = (STANDING_INSTRUCTIONS_MECHANISMS as readonly string[]).includes(r.mechanism)
    ? (r.mechanism as StandingInstructionsMechanism)
    : "prompt-prefix";
  return {
    noteKey: r.note_key,
    text: r.text,
    mechanism,
    sources,
    createdAt: r.created_at,
  };
}

/**
 * Record what a launch delivered, or correct the CHANNEL a recovery had to use.
 *
 * A row already under this key belongs to an earlier launch into the same pane and is
 * replaced whole. The only in-place amendment is `Registry.markStandingInstructionsPrefixed`,
 * which rewrites `mechanism` alone and preserves the text, sources and `created_at` - see the
 * table comment for why there is still no `updated_at`.
 */
export function insertStandingInstructions(snapshot: StandingInstructionsSnapshot): void {
  openDb()
    .prepare(
      `INSERT INTO session_standing_instructions (note_key, text, mechanism, sources, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(note_key) DO UPDATE SET
         text=excluded.text,
         mechanism=excluded.mechanism,
         sources=excluded.sources,
         created_at=excluded.created_at`,
    )
    .run(
      snapshot.noteKey,
      snapshot.text,
      snapshot.mechanism,
      JSON.stringify(snapshot.sources),
      snapshot.createdAt,
    );
}

/** One session's snapshot, by note key. */
export function getStandingInstructions(noteKey: string): StandingInstructionsSnapshot | undefined {
  const row = openDb()
    .prepare(
      `SELECT note_key, text, mechanism, sources, created_at
         FROM session_standing_instructions WHERE note_key = ?`,
    )
    .get(noteKey) as unknown as StandingInstructionsRow | undefined;
  return row ? rowToStandingInstructions(row) : undefined;
}

/** All snapshots, reloaded into the registry on start - the notes/goals/invites boot pattern. */
export function loadStandingInstructions(): StandingInstructionsSnapshot[] {
  const rows = openDb()
    .prepare(
      `SELECT note_key, text, mechanism, sources, created_at
         FROM session_standing_instructions ORDER BY created_at DESC`,
    )
    .all() as unknown as StandingInstructionsRow[];
  return rows.map(rowToStandingInstructions);
}

/** Drop a snapshot whose launch did not happen. */
export function deleteStandingInstructions(noteKey: string): void {
  openDb().prepare(`DELETE FROM session_standing_instructions WHERE note_key = ?`).run(noteKey);
}

/**
 * Carry a snapshot across a note-key rotation - EVERY rotation, not only the first bind.
 *
 * `moveForemanInvite`'s policy, deliberately, and NOT `moveSessionLaunchTurn`'s. The launch
 * turn is a projection into one conversation and must not be carried into the next, so it
 * strands on a native-to-native rotation. This is a record of what governs the PROCESS -
 * `--append-system-prompt` is a flag on the running CLI, and Codex's value lives on the
 * mutated `LaunchConfig` that survives `clearContext` - and a `/clear` does not end the
 * process. Attach this to the initial-bind policy instead and the header goes blank on the
 * first `/clear` while the instruction it described is still in force.
 *
 * Last-write-wins on the destination, for `moveForemanInvite`'s reason: the moved row
 * followed the process, and anything already under the target key is that process's own
 * earlier state.
 */
export function moveStandingInstructions(fromKey: string, toKey: string): void {
  if (fromKey === toKey) return;
  const d = openDb();
  const row = getStandingInstructions(fromKey);
  if (!row) return;
  d.exec("BEGIN IMMEDIATE");
  try {
    d.prepare(
      `INSERT INTO session_standing_instructions (note_key, text, mechanism, sources, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(note_key) DO UPDATE SET
         text=excluded.text,
         mechanism=excluded.mechanism,
         sources=excluded.sources,
         created_at=excluded.created_at`,
    ).run(toKey, row.text, row.mechanism, JSON.stringify(row.sources), row.createdAt);
    d.prepare(`DELETE FROM session_standing_instructions WHERE note_key = ?`).run(fromKey);
    d.exec("COMMIT");
  } catch (err) {
    if (d.isTransaction) d.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Delete snapshots that belong to no live session and have gone stale. Returns how many.
 *
 * A row whose key still belongs to a session is never touched however old it is - that half
 * is `pruneSessionLaunchTurns`' and it is the half that matters.
 *
 * The other half is DELIBERATELY different, and the difference is the whole comment. Its
 * neighbours treat an empty `liveKeys` as "liveness unknown" and delete nothing, because
 * they are reachable from callers that cannot prove the session map has been swept. This one
 * is not: its only caller is `Registry.pruneStandingInstructions`, which returns early unless
 * `sweptSessions` is true, so by the time the set arrives here an empty one MEANS nothing is
 * live. Repeating the neighbours' guard would make the table unprunable in exactly the state
 * that most needs it - a daemon whose sessions have all exited - and every completed launch
 * that carried standing text would leave up to 8,000 characters behind for good.
 *
 * So liveness is proven by the CALLER and stated once, rather than inferred twice from the
 * shape of the argument.
 */
export function pruneStandingInstructions(liveKeys: Iterable<string>, olderThan: number): number {
  const keys = [...new Set(liveKeys)];
  const placeholders = keys.map(() => "?").join(",");
  const r = openDb()
    .prepare(
      `DELETE FROM session_standing_instructions
         WHERE created_at < ?${keys.length ? ` AND note_key NOT IN (${placeholders})` : ""}`,
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
 * Record what one feature of an external pipeline engine cost.
 *
 * The FIFTH ledger writer, and the first whose subject is not this app. An observed engine
 * spends on its own schedule, in its own worktrees, under no card and no dispatch of ours -
 * which is exactly the property `spend_kind = 'automation'` selects for, so these rows fold
 * into the automation strip beside the Foreman's and stay out of fleet session spend without
 * any query learning that pipelines exist.
 *
 * **The row is REPLACED, not summed, and that is the whole idempotency story.** `window_end_ns`
 * holds the feature's own key, and the value written is the engine's own whole-feature total
 * as it committed it - so a re-projection re-reads the same record and writes the same row.
 * The other three automation-shaped writers can use DO NOTHING because their subject is one
 * finished run whose numbers never move again; a feature's committed record CAN be rewritten
 * by the engine (a re-ship, a repair), and DO NOTHING would pin the first figure for ever
 * while DO UPDATE with addition would double it on the next rebuild of a cache this database
 * is allowed to lose at any time.
 *
 * `ts` is when the ENGINE wrote the record rather than when we read it, which is what keeps a
 * feature that shipped last week out of today's automation figure after a daemon restart
 * re-reads it.
 *
 * `model_id` and `query_source` are empty strings rather than null, for the reason stated on
 * the table: they are in the UNIQUE index this upsert targets, and SQLite treats NULLs there
 * as distinct - one nullable half turns every upsert into an insert.
 */
export function recordPipelineUsage(input: {
  /** The spend role, from `PIPELINE_SPEND_ROLES`. Lands in `note_key`. */
  role: string;
  /**
   * The engine's own writer id, from `PIPELINE_SPEND_WRITERS` - `conductor` today.
   * Passed rather than hardcoded here so that appending a second engine cannot silently
   * file its rows under the first one's provenance.
   */
  writer: string;
  /** The feature's own key - `pipelineRunKey`. The dedup key, in `window_end_ns`. */
  featureKey: string;
  /** Which engine, for the `agent` column. */
  agent: string;
  ts: number;
  costUsd: number;
  /** Every dispatch behind `costUsd` was priced. False stores it as unpriced. */
  costKnown: boolean;
  input: number;
  output: number;
  reasoningOutput: number;
  cacheRead: number;
  cacheWrite: number;
}): void {
  openDb()
    .prepare(
      `INSERT INTO usage_ledger
         (note_key, session_id, agent, model_id, query_source, window_end_ns, ts,
          cost_usd, cost_basis, cost_known, pricing_version, input, output,
          reasoning_output, cache_read, cache_write, spend_kind, writer)
       VALUES (?, NULL, ?, '', '', ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, 'automation', ?)
       ON CONFLICT(note_key, model_id, query_source, window_end_ns) DO UPDATE SET
         ts=excluded.ts,
         cost_usd=excluded.cost_usd,
         cost_basis=excluded.cost_basis,
         cost_known=excluded.cost_known,
         input=excluded.input,
         output=excluded.output,
         reasoning_output=excluded.reasoning_output,
         cache_read=excluded.cache_read,
         cache_write=excluded.cache_write`,
    )
    .run(
      input.role,
      input.agent,
      input.featureKey,
      input.ts,
      input.costKnown ? input.costUsd : 0,
      // 'reported' because the engine's own provider priced it - the same provenance a
      // driver row has, and for the same reason: the arithmetic was done by the CLI that
      // holds the account's rates, not by a price snapshot in this repository.
      input.costKnown ? "reported" : "unpriced",
      input.costKnown ? 1 : 0,
      input.input,
      input.output,
      input.reasoningOutput,
      input.cacheRead,
      input.cacheWrite,
      input.writer,
    );
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
const OTEL_SEEN_ENTRY = APP_CONFIG_ENTRIES.costOtelLastSeen;

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
  const previous = getAppConfig(OTEL_SEEN_ENTRY);
  // One comparison, two properties, and both are wanted. It throttles a rewrite that is sooner
  // than the granularity anything reads, AND it refuses to move the stamp BACKWARDS - a clock
  // that steps back must not be able to age a live exporter into looking dead.
  if (typeof previous === "number" && now - previous < OTEL_SEEN_WRITE_THROTTLE_MS) return;
  setAppConfig(OTEL_SEEN_ENTRY, now);
}

/** When an OTLP export was last observed arriving, or null if one never has. */
export function lastOtelExportSeenAt(): number | null {
  const stored = getAppConfig(OTEL_SEEN_ENTRY);
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
  prompted_evidence: string | null;
  prompted_activity_at: number | null;
  prompted_legacy_cutover_generation: number | null;
  prompted_consumed_generation: number | null;
  prompted_direct_handoff_kind: string | null;
  prompted_direct_handoff_episode: string | null;
  prompted_direct_handoff_generation: number | null;
  prompted_decision: string | null;
  prompted_recovery: string | null;
  updated_at: number;
}

/**
 * One row -> object mapping, shared by every queue reader.
 *
 * Spelled once because it was spelled four times, and a column added to the table
 * reached whichever copies its author happened to grep. Missing the current consumed
 * generation in one reader would make the same completed cycle appear eligible again.
 */
function toQueueRow(r: QueueRow): Omit<SessionQueue, "items"> {
  return {
    noteKey: r.note_key,
    cwd: r.cwd,
    branch: r.branch,
    wrapupAskedAt: r.wrapup_asked_at,
    wrapupAnswer: r.wrapup_answer,
    promptedGoal: r.prompted_goal,
    promptedEvidence: r.prompted_evidence,
    promptedActivityAt: r.prompted_activity_at,
    promptedLegacyCutoverGeneration: r.prompted_legacy_cutover_generation,
    promptedConsumedGeneration: r.prompted_consumed_generation,
    promptedDirectHandoff: toPromptedDirectHandoff(r),
    promptedDecision: toPromptedDecision(r),
    promptedRecovery: toPromptedRecovery(r),
    updatedAt: r.updated_at,
  };
}

/**
 * The stored prompted decision, or null - and null for BOTH "there is none" and "what is
 * there cannot be trusted".
 *
 * FAIL CLOSED, and fail closed loudly for the second case. Every rejection below describes
 * state that no writer in this build can produce, so it is either a hand-edited database
 * or a payload from a build whose vocabulary this one does not have. Coercing any of it
 * into a readable decision would hand Phase 2 recovery a reason to act on that nothing
 * ever decided:
 *
 * - unparseable JSON, or a non-object;
 * - an `outcome` this build cannot interpret (the vocabulary is append-only, so a NEWER
 *   build's value lands here and must read as unknown rather than as the nearest match);
 * - a `logicalKey` that is not this row's own - a decision never migrates across keys, and
 *   a context clear selects a different row entirely;
 * - a `generation` that is not the row's current consumed generation, which is the whole
 *   invariant: a decision is about the generation the queue says was spent, or it is
 *   about nothing;
 * - a reason that does not satisfy `PromptedCompletionDispositionSchema` - most sharply, a
 *   non-`held` outcome carrying gaps. Only a verifier verdict produces gaps, so gaps on a
 *   `retired` or `empty` consumption are feedback no model ever wrote, and Phase 2 reads
 *   exactly this field to decide what to send back to an agent.
 *
 * That last check runs the WRITE schema over the stored payload rather than restating its
 * rules here. A reader with its own idea of what a decision may contain is a second
 * contract that drifts from the first, and it drifts in the one direction that matters:
 * accepting what the writer would have refused. Silently normalizing instead - dropping a
 * malformed gap, or clearing gaps the outcome may not carry - is worse than refusing,
 * because it manufactures a decision that is well-formed, actionable, and not what the row
 * says.
 *
 * Bounds are the deliberate exception, clamped rather than refused: an over-long summary
 * from a build with a larger bound is the same decision, described at greater length, and
 * the write bound only ever held for payloads this build wrote. The rule is that LENGTH is
 * clamped and CONTRADICTION is refused.
 */
function toPromptedDecision(r: QueueRow): PromptedCompletionDecision | null {
  const raw = r.prompted_decision;
  if (!raw) return null;
  const reject = (why: string): null => {
    // Bounded, and once per read: this runs on every queue read the worker polls.
    warnOnce(
      `prompted-decision:${r.note_key}:${why}`,
      `foreman_queues ${r.note_key}: ignoring unreadable prompted decision (${why})`,
    );
    return null;
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return reject("invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return reject("not an object");
  const d = parsed as Record<string, unknown>;
  if (typeof d.outcome !== "string" || !isPromptedCompletionOutcome(d.outcome)) {
    return reject("unknown outcome");
  }
  if (d.logicalKey !== r.note_key) return reject("logical key mismatch");
  if (typeof d.generation !== "number" || d.generation !== r.prompted_consumed_generation) {
    return reject("generation does not match the consumed generation");
  }
  if (typeof d.decidedAt !== "number" || !Number.isFinite(d.decidedAt)) {
    return reject("missing decision time");
  }
  // Clamp first, then validate: a length this build would not have written is trimmed to
  // one it would, and everything the schema still refuses after that is a contradiction
  // rather than an overflow. Non-strings are passed through untouched for the schema to
  // reject - coercing them here is the silent normalization this reader exists to avoid.
  const clamp = (value: unknown, max: number): unknown =>
    typeof value === "string" ? value.slice(0, max) : value;
  const clampGap = (gap: unknown): unknown => {
    if (!gap || typeof gap !== "object" || Array.isArray(gap)) return gap;
    const g = gap as Record<string, unknown>;
    return {
      ...g,
      id: clamp(g.id, PROMPTED_DECISION_GAP_ID_MAX),
      path: clamp(g.path, PROMPTED_DECISION_GAP_PATH_MAX),
      detail: clamp(g.detail, PROMPTED_DECISION_GAP_DETAIL_MAX),
    };
  };
  const reason = PromptedCompletionDispositionSchema.safeParse({
    outcome: d.outcome,
    summary: clamp(d.summary, PROMPTED_DECISION_SUMMARY_MAX),
    gaps: Array.isArray(d.gaps) ? d.gaps.slice(0, PROMPTED_DECISION_GAPS_MAX).map(clampGap) : d.gaps,
  });
  if (!reason.success) {
    return reject(`invalid reason: ${reason.error.issues[0]?.message ?? "unreadable"}`);
  }
  const hasEpisodeKey = Object.prototype.hasOwnProperty.call(d, "episodeKey");
  if (
    hasEpisodeKey
    && d.episodeKey !== null
    && (typeof d.episodeKey !== "string" || d.episodeKey.length < 1 || d.episodeKey.length > 200)
  ) {
    return reject("invalid episode key");
  }
  const hasHeldRound = Object.prototype.hasOwnProperty.call(d, "heldRound");
  if (
    hasHeldRound
    && (
      d.outcome !== "held"
      || typeof d.episodeKey !== "string"
      || !Number.isSafeInteger(d.heldRound)
      || (d.heldRound as number) < 1
    )
  ) {
    return reject("invalid held round");
  }
  return {
    logicalKey: r.note_key,
    generation: d.generation,
    ...(hasEpisodeKey ? { episodeKey: d.episodeKey as string | null } : {}),
    outcome: reason.data.outcome,
    summary: reason.data.summary,
    gaps: reason.data.gaps,
    ...(hasHeldRound ? { heldRound: d.heldRound as number } : {}),
    decidedAt: d.decidedAt,
  };
}

/**
 * Diagnostics for unreadable persisted state, at most once per distinct fact.
 *
 * `toPromptedDecision` runs on EVERY queue read, and the worker polls queues on every
 * tick, so an unbounded warn would turn one hand-edited row into a log flood that hides
 * the very thing it is reporting. The set is process-local and unbounded only in the
 * number of distinct broken rows, which is bounded by the table.
 */
const warnedOnce = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  console.warn(`[queues] ${message}`);
}

function isPromptedCompletionOutcome(value: string): value is PromptedCompletionOutcome {
  return (PROMPTED_COMPLETION_OUTCOMES as readonly string[]).includes(value);
}

/**
 * Serialize one decision for storage, from values the writer has already verified.
 *
 * One serializer, module-private, paired with `toPromptedDecision` above: both write paths
 * - the consume statement and an ordinary row refresh - go through it, so there is exactly
 * one shape the reader has to accept.
 */
function serializePromptedDecision(decision: PromptedCompletionDecision): string {
  return JSON.stringify(decision);
}

/** Read one all-or-nothing recovery projection, failing closed on every contradiction. */
function toPromptedRecovery(r: QueueRow): PromptedRecoveryState | null {
  if (!r.prompted_recovery) return null;
  const reject = (why: string): null => {
    warnOnce(
      `prompted-recovery:${r.note_key}:${why}`,
      `foreman_queues ${r.note_key}: ignoring unreadable prompted recovery (${why})`,
    );
    return null;
  };
  let value: unknown;
  try {
    value = JSON.parse(r.prompted_recovery);
  } catch {
    return reject("invalid JSON");
  }
  const parsed = PromptedRecoveryStateSchema.safeParse(value);
  if (!parsed.success) return reject(parsed.error.issues[0]?.message ?? "invalid state");
  const state = parsed.data;
  if (state.logicalKey !== r.note_key) return reject("logical key mismatch");
  if (state.marker !== shipRecoveryMarker(state)) return reject("marker mismatch");
  return state;
}

function serializePromptedRecovery(state: PromptedRecoveryState): string {
  return JSON.stringify(state);
}

/**
 * The three latch columns as the one all-or-nothing fact they are.
 *
 * A partially-set triple is not a handoff anyone can act on, so it reads back as none at
 * all rather than as a latch with a missing field. Only `consumePromptedGeneration` writes
 * these, and it writes all three together, so a partial row means a hand-edited database.
 */
function toPromptedDirectHandoff(r: QueueRow): PromptedDirectHandoff | null {
  const kind = r.prompted_direct_handoff_kind;
  const episodeKey = r.prompted_direct_handoff_episode;
  const generation = r.prompted_direct_handoff_generation;
  if (kind !== "direct-ship" || !episodeKey || generation === null) return null;
  return { kind, episodeKey, generation };
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
         (note_key, cwd, branch, wrapup_asked_at, wrapup_answer, prompted_goal,
          prompted_evidence, prompted_activity_at, prompted_legacy_cutover_generation,
          prompted_consumed_generation, prompted_direct_handoff_kind,
          prompted_direct_handoff_episode, prompted_direct_handoff_generation,
          prompted_decision, prompted_recovery, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(note_key) DO UPDATE SET
         cwd=excluded.cwd, branch=excluded.branch, wrapup_asked_at=excluded.wrapup_asked_at,
         wrapup_answer=excluded.wrapup_answer, prompted_goal=excluded.prompted_goal,
         prompted_evidence=excluded.prompted_evidence,
         prompted_activity_at=excluded.prompted_activity_at,
         prompted_legacy_cutover_generation=excluded.prompted_legacy_cutover_generation,
         prompted_consumed_generation=excluded.prompted_consumed_generation,
         prompted_direct_handoff_kind=excluded.prompted_direct_handoff_kind,
         prompted_direct_handoff_episode=excluded.prompted_direct_handoff_episode,
         prompted_direct_handoff_generation=excluded.prompted_direct_handoff_generation,
         prompted_decision=excluded.prompted_decision,
         -- Undefined is the rolling-upgrade shape from a caller that does not know this
         -- projection. It has learned nothing that can release an unknown delivery claim.
         -- Null remains the explicit clear; objects remain explicit replacements.
         prompted_recovery=CASE
           WHEN ? = 1 THEN foreman_queues.prompted_recovery
           ELSE excluded.prompted_recovery
         END,
         updated_at=excluded.updated_at`,
    )
    .run(
      q.noteKey,
      q.cwd,
      q.branch,
      q.wrapupAskedAt,
      q.wrapupAnswer,
      q.promptedGoal,
      q.promptedEvidence,
      q.promptedActivityAt,
      q.promptedLegacyCutoverGeneration,
      q.promptedConsumedGeneration,
      q.promptedDirectHandoff?.kind ?? null,
      q.promptedDirectHandoff?.episodeKey ?? null,
      q.promptedDirectHandoff?.generation ?? null,
      // Re-serialized from the READ model, which already refused anything it could not
      // trust - so a row rewritten by an ordinary cwd/branch refresh cannot launder an
      // unreadable payload back into storage, and cannot carry a decision onto a row whose
      // consumed generation has moved.
      q.promptedDecision ? serializePromptedDecision(q.promptedDecision) : null,
      q.promptedRecovery ? serializePromptedRecovery(q.promptedRecovery) : null,
      q.updatedAt,
      q.promptedRecovery === undefined ? 1 : 0,
    );
}

export function getQueueRow(noteKey: string): Omit<SessionQueue, "items"> | undefined {
  const r = openDb().prepare(`SELECT * FROM foreman_queues WHERE note_key = ?`).get(noteKey) as
    | unknown as QueueRow | undefined;
  return r ? toQueueRow(r) : undefined;
}

/**
 * Lazily translate one matching legacy prompted guard into the generation it had spent.
 *
 * A null legacy guard stays eligible. A mismatched guard means intent advanced after the
 * historical decision and also stays eligible. Missing lifecycle state changes nothing so
 * the current reader can fail closed and try the bootstrap again after state is known. An
 * active row is not a completed cutover boundary even when it retains an older completion
 * timestamp, so compatibility must not consume its generation while work is in progress.
 * The historical activity watermark associates the guard with the completion it examined. A later
 * completed cycle stays unconsumed instead of letting an old intent guard advance onto new work.
 * Rows from before the immutable watermark existed fail closed by recording the current settled
 * generation as a separate cutover ceiling. That generation cannot be claimed, but the next one can.
 */
export function bootstrapPromptedConsumedGeneration(
  noteKey: string,
  resolvedEpisodeKey: string,
  d: DatabaseSync = openDb(),
): boolean {
  const result = d.prepare(
    `UPDATE foreman_queues
        SET prompted_consumed_generation = CASE
              WHEN prompted_activity_at IS NOT NULL THEN (
                SELECT generation FROM session_work_cycles
                 WHERE logical_key = foreman_queues.note_key
                   AND generation > 0
                   AND active = 0
                   AND completed_at IS NOT NULL
                   AND completed_at <= foreman_queues.prompted_activity_at
              )
              ELSE prompted_consumed_generation
            END,
            prompted_legacy_cutover_generation = CASE
              WHEN prompted_activity_at IS NULL THEN (
                SELECT generation FROM session_work_cycles
                 WHERE logical_key = foreman_queues.note_key
                   AND generation > 0
                   AND active = 0
                   AND completed_at IS NOT NULL
              )
              ELSE prompted_legacy_cutover_generation
            END
      WHERE note_key = ?
        AND prompted_consumed_generation IS NULL
        AND prompted_legacy_cutover_generation IS NULL
        AND prompted_goal = ?
        AND EXISTS (
          SELECT 1 FROM session_work_cycles
           WHERE logical_key = foreman_queues.note_key
             AND generation > 0
             AND active = 0
             AND completed_at IS NOT NULL
             AND (
               foreman_queues.prompted_activity_at IS NULL
               OR completed_at <= foreman_queues.prompted_activity_at
             )
        )`,
  ).run(noteKey, resolvedEpisodeKey);
  return Number(result.changes) === 1;
}

export interface ConsumePromptedGenerationInput {
  noteKey: string;
  sessionCwd: string | null;
  generation: number;
  /** Daemon-verified intent episode. Absent only for legacy in-process callers. */
  episodeKey?: string | null;
  ask: boolean;
  /**
   * Record a prompted handoff in the SAME statement that consumes the generation, or
   * null to consume without recording one.
   *
   * MARK BEFORE INJECT. Foreman calls this immediately before it types the direct
   * shipping instruction, never after: a crash between the two must leave the handoff
   * recorded, because a retried direct injection is a second push on a branch that may
   * already have one. The existing human Ship it? fallback is the recovery, and it is
   * the only one - nothing here retries an injection.
   *
   * `episodeKey` is the authorizing INTENT episode rather than the generation, because
   * the instruction itself makes the agent work and park, which completes the next
   * generation under exactly the same human intent. A generation-keyed latch would
   * re-arm on the turn it caused. Workflow claims pass null: claiming a Complete
   * workflow is not a direct-shipping handoff and must not latch one.
   */
  directHandoff: { kind: PromptedDirectHandoffKind; episodeKey: string } | null;
  /**
   * WHY this generation is being consumed, written in the SAME statement, or null to
   * consume without recording one.
   *
   * Required of every in-repository caller and defaulted nowhere: a synthesized reason is
   * indistinguishable from a decided one once it is on the row, and Phase 2's recovery
   * reads exactly this field to choose what to send back. Null is reserved for a wire
   * caller from a build that predates the field, and it CLEARS any stored decision - the
   * previous one described an older generation, and a decision that outlives its
   * generation is precisely the state `toPromptedDecision` refuses to return.
   */
  decision: PromptedCompletionDisposition | null;
  now: number;
}

/**
 * Compare and consume one currently completed work-cycle generation in one SQL statement.
 *
 * This is the shared daemon-owned action boundary for direct prompted handoffs and Workflow
 * claims. The INSERT arm lets a queue-less prompted session record its first consumption;
 * the conflict arm advances only to a newer generation. Both arms require the durable
 * lifecycle row to still be the exact settled generation the caller observed.
 */
export function consumePromptedGeneration(
  input: ConsumePromptedGenerationInput,
  d: DatabaseSync = openDb(),
): boolean {
  const ask = input.ask ? 1 : 0;
  const handoffKind = input.directHandoff?.kind ?? null;
  const handoffEpisode = input.directHandoff?.episodeKey ?? null;
  const currentRow = d.prepare(`SELECT * FROM foreman_queues WHERE note_key = ?`)
    .get(input.noteKey) as unknown as QueueRow | undefined;
  const previousDecision = currentRow ? toPromptedDecision(currentRow) : null;
  const previousRecovery = currentRow ? toPromptedRecovery(currentRow) : null;
  const heldRound = input.decision?.outcome === "held" && typeof input.episodeKey === "string"
    ? previousDecision?.outcome === "held"
        && previousDecision.episodeKey === input.episodeKey
        && previousDecision.heldRound !== undefined
      ? previousDecision.heldRound + 1
      : 1
    : undefined;
  // Composed from the arguments this statement is ABOUT to compare, not from anything the
  // caller labelled it with: the stored key and generation are therefore the ones actually
  // spent, which is what lets every reader treat placement as proof.
  const decision = input.decision
    ? serializePromptedDecision({
      logicalKey: input.noteKey,
      generation: input.generation,
      ...(input.episodeKey !== undefined ? { episodeKey: input.episodeKey } : {}),
      outcome: input.decision.outcome,
      summary: input.decision.summary,
      gaps: input.decision.gaps,
      ...(heldRound !== undefined ? { heldRound } : {}),
      decidedAt: input.now,
    })
    : null;
  const recovery = typeof input.episodeKey === "string"
      && previousRecovery?.episodeKey === input.episodeKey
    ? serializePromptedRecovery(previousRecovery)
    : null;
  const result = d.prepare(
    `INSERT INTO foreman_queues (
       note_key, cwd, branch, wrapup_asked_at, wrapup_answer, prompted_goal,
       prompted_evidence, prompted_activity_at, prompted_legacy_cutover_generation,
       prompted_consumed_generation, prompted_direct_handoff_kind,
       prompted_direct_handoff_episode, prompted_direct_handoff_generation,
       prompted_decision, prompted_recovery, updated_at
     )
     SELECT ?, ?, NULL,
            CASE WHEN ? = 1 THEN ? ELSE NULL END,
            NULL, NULL, NULL, NULL, NULL, generation,
            ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE generation END,
            ?, ?, ?
       FROM session_work_cycles
      WHERE logical_key = ?
        AND generation = ?
        AND generation > 0
        AND active = 0
        AND completed_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM foreman_queue_items WHERE note_key = ?
        )
     ON CONFLICT(note_key) DO UPDATE SET
       prompted_consumed_generation = excluded.prompted_consumed_generation,
       -- ASSIGNMENT, not COALESCE, and the opposite choice from the handoff latch three
       -- lines below - deliberately. The latch records an instruction that was already
       -- TYPED and must survive a later consumption that types nothing. This records why
       -- the CURRENT generation stopped, so it moves with that generation or it lies: a
       -- preserved older reason would describe work the session has since finished, and
       -- Phase 2 would send its gaps back into a session that already addressed them.
       -- Clearing on a null decision is the same rule, applied to a caller that gave none.
       prompted_decision = excluded.prompted_decision,
       -- Recovery attempts are one budget per intent episode. Preserve only a validated
       -- projection carrying this daemon-verified episode key; legacy state and a changed
       -- human intent retain the old clear-on-generation behavior.
       prompted_recovery = excluded.prompted_recovery,
       -- COALESCE, not assignment: a consumption that makes no handoff must not ERASE
       -- one. It would be erasing the record of an instruction that was already typed,
       -- and the next tick would type it again. Preserving is safe because eligibility
       -- compares the stored episode against the current one, so a stale latch under a
       -- newer episode is already inert. All three move together or none do, so the
       -- triple can never be left half-written.
       prompted_direct_handoff_kind = COALESCE(
         excluded.prompted_direct_handoff_kind, foreman_queues.prompted_direct_handoff_kind),
       prompted_direct_handoff_episode = COALESCE(
         excluded.prompted_direct_handoff_episode, foreman_queues.prompted_direct_handoff_episode),
       prompted_direct_handoff_generation = COALESCE(
         excluded.prompted_direct_handoff_generation,
         foreman_queues.prompted_direct_handoff_generation),
       wrapup_asked_at = CASE
         WHEN ? = 1 THEN excluded.wrapup_asked_at ELSE foreman_queues.wrapup_asked_at END,
       wrapup_answer = CASE
         WHEN ? = 1 THEN NULL ELSE foreman_queues.wrapup_answer END,
       updated_at = excluded.updated_at
     WHERE (
         foreman_queues.prompted_consumed_generation IS NULL
         OR foreman_queues.prompted_consumed_generation < excluded.prompted_consumed_generation
       )
       AND (
         foreman_queues.prompted_legacy_cutover_generation IS NULL
         OR foreman_queues.prompted_legacy_cutover_generation < excluded.prompted_consumed_generation
       )`,
  ).run(
    input.noteKey,
    input.sessionCwd,
    ask,
    input.now,
    handoffKind,
    handoffEpisode,
    handoffKind,
    decision,
    recovery,
    input.now,
    input.noteKey,
    input.generation,
    input.noteKey,
    ask,
    ask,
  );
  return Number(result.changes) === 1;
}

/**
 * Claim one exact pre-PR recovery attempt before injection.
 *
 * This is the durable CAS half only. The Registry/route boundary re-resolves task,
 * authorization, human, queue, Workflow, PR and idle ownership before it calls here. This
 * statement then makes a lost worker response conservative: the claim is already `unknown`
 * and a restart cannot send it again.
 */
export function claimPromptedRecovery(
  input: PromptedRecoveryClaim,
  now: number,
  d: DatabaseSync = openDb(),
): PromptedRecoveryState | null {
  d.exec("BEGIN IMMEDIATE");
  try {
    const row = d.prepare(`SELECT * FROM foreman_queues WHERE note_key = ?`)
      .get(input.logicalKey) as unknown as QueueRow | undefined;
    if (!row) {
      d.exec("ROLLBACK");
      return null;
    }
    const expectedMarker = shipRecoveryMarker(input);
    const decision = toPromptedDecision(row);
    const decisionMatches = input.decisionGeneration === null
      ? decision === null && input.decisionOutcome === null
      : decision?.generation === input.decisionGeneration
        && decision.outcome === input.decisionOutcome;
    const cycle = d.prepare(
      `SELECT generation, active, completed_at FROM session_work_cycles WHERE logical_key = ?`,
    ).get(input.logicalKey) as unknown as {
      generation: number;
      active: number;
      completed_at: number | null;
    } | undefined;
    if (
      expectedMarker !== input.marker
      || !decisionMatches
      || !cycle
      || cycle.generation !== input.generation
      || cycle.active !== 0
      || cycle.completed_at === null
    ) {
      d.exec("ROLLBACK");
      return null;
    }

    const previous = toPromptedRecovery(row);
    // Null in storage is the legacy/no-attempt case. Non-null storage that the validated
    // reader rejected is a different fact: this build cannot prove which attempt was
    // spent, so it must not overwrite the evidence with a fresh attempt-one claim.
    if (row.prompted_recovery !== null && previous === null) {
      d.exec("ROLLBACK");
      return null;
    }
    const sameEpisodeSequence = previous !== null
      && typeof previous.episodeKey === "string"
      && previous.episodeKey === input.episodeKey;
    const sameLegacySequence = previous !== null
      && typeof previous.episodeKey !== "string"
      && previous.generation === input.generation
      && previous.decisionGeneration === input.decisionGeneration
      && previous.decisionOutcome === input.decisionOutcome;
    const sameSequence = previous !== null
      && previous.taskId === input.taskId
      && previous.logicalKey === input.logicalKey
      && previous.reason === input.reason
      && (sameEpisodeSequence || sameLegacySequence);
    let allowed = false;
    if (!sameSequence) {
      allowed = input.attempt === 1
        || (input.attempt === 4 && input.reason === "verification_failed");
    } else if (previous.lastDelivery !== "escalated") {
      const due = previous.nextEligibleAt !== null && now >= previous.nextEligibleAt;
      allowed = due && (
        (previous.lastDelivery === "confirmed_undelivered"
          ? input.attempt === previous.attempt
          : input.attempt === previous.attempt + 1)
      );
    }
    if (
      !allowed
      || (
        input.attempt === 4
        && input.reason !== "verification_failed"
        && previous?.attempt !== 3
      )
    ) {
      d.exec("ROLLBACK");
      return null;
    }

    const next: PromptedRecoveryState = {
      taskId: input.taskId,
      logicalKey: input.logicalKey,
      generation: input.generation,
      ...(input.episodeKey !== undefined ? { episodeKey: input.episodeKey } : {}),
      decisionGeneration: input.decisionGeneration,
      decisionOutcome: input.decisionOutcome,
      reason: input.reason,
      marker: input.marker,
      attempt: input.attempt,
      payloadSummary: input.payloadSummary,
      claimedAt: now,
      nextEligibleAt: input.attempt === 4 ? null : nextShipRecoveryAt(input.attempt, now),
      lastDelivery: input.attempt === 4 ? "escalated" : "unknown",
    };
    const parsed = PromptedRecoveryStateSchema.safeParse(next);
    if (!parsed.success) {
      d.exec("ROLLBACK");
      return null;
    }
    const changed = d.prepare(
      `UPDATE foreman_queues SET prompted_recovery = ?, updated_at = ? WHERE note_key = ?`,
    ).run(serializePromptedRecovery(next), now, input.logicalKey);
    if (Number(changed.changes) !== 1) {
      d.exec("ROLLBACK");
      return null;
    }
    d.exec("COMMIT");
    return next;
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
}

/** Confirm success or positively release one exact recovery delivery claim. */
export function resolvePromptedRecoveryDelivery(
  input: PromptedRecoveryDelivery,
  now: number,
  d: DatabaseSync = openDb(),
): PromptedRecoveryState | null {
  d.exec("BEGIN IMMEDIATE");
  try {
    const row = d.prepare(`SELECT * FROM foreman_queues WHERE note_key = ?`)
      .get(input.logicalKey) as unknown as QueueRow | undefined;
    const current = row ? toPromptedRecovery(row) : null;
    if (
      !current
      || current.taskId !== input.taskId
      || current.logicalKey !== input.logicalKey
      || current.generation !== input.generation
      || current.episodeKey !== input.episodeKey
      || current.decisionGeneration !== input.decisionGeneration
      || current.decisionOutcome !== input.decisionOutcome
      || current.reason !== input.reason
      || current.attempt !== input.attempt
      || current.marker !== input.marker
      || current.marker !== shipRecoveryMarker(input)
      || current.lastDelivery === "escalated"
    ) {
      d.exec("ROLLBACK");
      return null;
    }
    const desired = input.delivery;
    if (current.lastDelivery !== "unknown" && current.lastDelivery !== desired) {
      d.exec("ROLLBACK");
      return null;
    }
    const next: PromptedRecoveryState = {
      ...current,
      lastDelivery: desired,
      nextEligibleAt: desired === "confirmed_undelivered" ? now : current.nextEligibleAt,
    };
    d.prepare(
      `UPDATE foreman_queues SET prompted_recovery = ?, updated_at = ? WHERE note_key = ?`,
    ).run(serializePromptedRecovery(next), now, input.logicalKey);
    d.exec("COMMIT");
    return next;
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Downgrade a `direct_handoff` decision to `direct_handoff_undelivered`, for the generation
 * that already recorded it.
 *
 * The one amendment to a stored decision, and it exists because the mark it corrects CANNOT
 * be rolled back. Direct shipping is mark-before-inject on purpose: the latch is durable
 * before the instruction types, because a retried direct injection is the double push. So
 * when the injection then fails, the honest options are to leave a record saying Foreman
 * handed the task off when the agent received nothing, or to say what actually happened.
 * This says what happened. The generation stays consumed, the latch stays latched, and the
 * Ship it? card the caller raises alongside remains the recovery.
 *
 * It NARROWS; it can never create. The update requires the row's consumed generation to be
 * the named one, and the stored decision to be a `direct_handoff` for that same generation,
 * so it cannot invent a decision for a generation that was never spent, cannot touch a
 * different generation's reason, and cannot overwrite a `held` or a `workflow_claimed`. A
 * second call after the first is a no-op rather than an error, which is what makes the
 * caller's retry safe. Everything else about the row - the latch triple, the ask stamp, the
 * summary and gaps of the decision itself - is left exactly as it was.
 *
 * Read-modify-write inside one transaction because the amendment is a function of the
 * stored payload: SQLite's JSON functions could express it, but the payload is validated
 * TypeScript on the way in and on the way out, and a second, SQL-shaped definition of the
 * record's shape is the drift this file has already paid for once.
 */
export function markPromptedHandoffUndelivered(
  noteKey: string,
  generation: number,
  now: number,
  d: DatabaseSync = openDb(),
): boolean {
  d.exec("BEGIN IMMEDIATE");
  try {
    const row = d
      .prepare(`SELECT * FROM foreman_queues WHERE note_key = ?`)
      .get(noteKey) as unknown as QueueRow | undefined;
    const decision = row ? toPromptedDecision(row) : null;
    if (
      !row ||
      !decision ||
      row.prompted_consumed_generation !== generation ||
      decision.generation !== generation ||
      decision.outcome !== "direct_handoff"
    ) {
      d.exec("ROLLBACK");
      return false;
    }
    d.prepare(
      `UPDATE foreman_queues SET prompted_decision = ?, updated_at = ? WHERE note_key = ?`,
    ).run(
      serializePromptedDecision({ ...decision, outcome: "direct_handoff_undelivered" }),
      now,
      noteKey,
    );
    d.exec("COMMIT");
    return true;
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
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
 * The second branch collects rows that hold NOTHING: no items and no wrap-up or
 * prompted compatibility/current guard fields - the direct-shipping latch included,
 * so a row whose only content is "Foreman already shipped this episode" is never
 * collected out from under the episode it retires - regardless of age. `ensureQueue` mints
 * a row for any
 * session whose wrap-up state is merely touched, and the `prompted` trigger touches
 * every session it ever considers, so this is now the common shape of a row rather than
 * a rarity. Waiting out `cutoff` for a row with nothing in it buys no safety: there is
 * no backlog to resume, no ask to answer and no episode to keep retired, and if the
 * session comes back `ensureQueue` mints it again for free. The `liveKeys` guard still
 * applies to both branches, which is what keeps this away from the row a live session is
 * mid-write on. A live direct consume can create and populate this row atomically.
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
                AND q.prompted_evidence IS NULL
                AND q.prompted_activity_at IS NULL
                AND q.prompted_legacy_cutover_generation IS NULL
                AND q.prompted_consumed_generation IS NULL
                AND q.prompted_direct_handoff_kind IS NULL
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

/** Read a registered JSON-encoded config blob, or undefined when unset/corrupt JSON. */
export function getAppConfig<Entry extends AppConfigEntry>(
  entry: Entry,
): AppConfigValue<Entry> | undefined {
  const r = openDb().prepare(`SELECT value FROM app_config WHERE key = ?`).get(entry.key) as
    | { value: string }
    | undefined;
  if (!r) return undefined;
  try {
    return JSON.parse(r.value) as AppConfigValue<Entry>;
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

export function setAppConfig<Entry extends AppConfigEntry>(
  entry: Entry,
  value: AppConfigInput<Entry>,
): void {
  openDb()
    .prepare(
      `INSERT INTO app_config (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    )
    .run(entry.key, JSON.stringify(value));
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
    source: r.source === "hook" || r.source === "pipeline" ? r.source : "legacy",
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

// ---- line comments in the Files workspace ----
//
// Shape A (module-level exported functions), like `upsertInspectorComment` above.
//
// Every operation here is DECLARED rather than composable, and that is the design rather
// than a preference: a thread joining the queue is two writes (status and position), and a
// caller composing them out of the generic status route plus the reorder route makes two
// HTTP requests with a window between them where a second submit takes the same number.
// The race is created by the missing operation, not by SQLite - `DatabaseSync` is fully
// synchronous and the daemon is the only writer, so two statements inside ONE store
// function cannot interleave.

interface FileCommentThreadRow {
  id: string;
  short_id: string;
  session_id: string;
  path: string;
  start_line: number;
  end_line: number;
  quote: string;
  quote_hash: string;
  revision: string | null;
  surface: string;
  html_block_path: string | null;
  html_block_quote: string | null;
  status: string;
  outdated: number;
  queue_seq: number | null;
  delivery_id: string | null;
  sent_at: number | null;
  answered_at: number | null;
  addressed_at: number | null;
  resolved_at: number | null;
  created_at: number;
  updated_at: number;
}

interface FileCommentMessageRow {
  id: string;
  thread_id: string;
  author: string;
  session_id: string | null;
  body: string;
  delivered_at: number | null;
  read_at: number | null;
  created_at: number;
  updated_at: number;
}

interface FileCommentReviewRow {
  session_id: string;
  state: string;
  pause_reason: string | null;
  started_at: number | null;
  updated_at: number;
}

/**
 * A status this build does not recognise reads as `orphaned`, which is terminal and inert.
 *
 * The forward-compatibility seam `readEnsembleEnum` establishes, resolved the safe way for
 * this table: a newer build could write a status this one has never heard of, and the two
 * wrong answers would be to crash the read or to let the value through onto a thread the
 * walkthrough then tries to deliver. Reading it as terminal means an older build shows the
 * thread as settled and never sends it - it does not rewrite the row, so the build that
 * understands it still can.
 */
function readThreadStatus(raw: string): FileCommentThreadStatus {
  return isFileCommentThreadStatus(raw) ? raw : "orphaned";
}

function readHtmlBlockPath(raw: string | null): HtmlBlockPathStep[] | null {
  if (raw === null) return null;
  try {
    const parsed = HtmlBlockPathSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function rowToFileCommentMessage(row: FileCommentMessageRow): FileCommentMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    // `human` is the safe fall-through: an unknown author is not attributed to the agent,
    // because "the agent said this" is a claim the dashboard renders as an answer.
    author: row.author === "agent" ? "agent" : "human",
    sessionId: row.session_id,
    body: row.body,
    deliveredAt: row.delivered_at,
    readAt: row.read_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToFileCommentThread(
  row: FileCommentThreadRow,
  messages: FileCommentMessage[],
  messageCount: number,
): FileCommentThread {
  return {
    id: row.id,
    shortId: row.short_id,
    sessionId: row.session_id,
    path: row.path,
    startLine: row.start_line,
    endLine: row.end_line,
    quote: row.quote,
    quoteHash: row.quote_hash,
    revision: row.revision,
    surface: (isFileCommentSurface(row.surface) ? row.surface : "editor") as FileCommentSurface,
    htmlBlockPath: readHtmlBlockPath(row.html_block_path),
    htmlBlockQuote: row.html_block_quote,
    status: readThreadStatus(row.status),
    outdated: row.outdated !== 0,
    queueSeq: row.queue_seq,
    deliveryId: row.delivery_id,
    sentAt: row.sent_at,
    answeredAt: row.answered_at,
    addressedAt: row.addressed_at,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messages,
    messageCount,
  };
}

/**
 * Hydrate a set of threads with their messages in ONE pass rather than per thread.
 *
 * A thread arrives on the wire with its messages (phase 2 renders from one frame, phase 4
 * delivers a reply through one), and the snapshot hydrates every thread the daemon holds,
 * so a per-thread query here would be one statement per thread on every boot.
 *
 * `cap` is what makes the wire budget a budget: with it on, a thread carries the NEWEST
 * `FILE_COMMENT_THREAD_MESSAGE_CAP` messages and `messageCount` reports the true total, so a
 * surface can tell it is looking at a tail. It is off for exactly one caller - the
 * single-thread route, which is the declared escape hatch a surface reaches for once
 * `messageCount` has told it the frame was truncated. A cap that could not be turned off
 * would make that route unable to answer the question it exists for.
 */
function hydrateFileCommentThreads(
  rows: FileCommentThreadRow[],
  cap = true,
): FileCommentThread[] {
  if (!rows.length) return [];
  const placeholders = rows.map(() => "?").join(",");
  const messageRows = openDb()
    .prepare(
      `SELECT * FROM file_comment_messages WHERE thread_id IN (${placeholders})
         ORDER BY created_at ASC, rowid ASC`,
    )
    .all(...rows.map((r) => r.id)) as unknown as FileCommentMessageRow[];
  const byThread = new Map<string, FileCommentMessage[]>();
  for (const row of messageRows) {
    const list = byThread.get(row.thread_id) ?? [];
    list.push(rowToFileCommentMessage(row));
    byThread.set(row.thread_id, list);
  }
  return rows.map((row) => {
    const all = byThread.get(row.id) ?? [];
    const messages =
      !cap || all.length <= FILE_COMMENT_THREAD_MESSAGE_CAP
        ? all
        : all.slice(all.length - FILE_COMMENT_THREAD_MESSAGE_CAP);
    return rowToFileCommentThread(row, messages, all.length);
  });
}

/**
 * Every thread this build should hold live, in queue order within a session.
 *
 * Excludes `orphaned`, which is what a thread becomes when its session went away: those
 * rows are kept for the record and for the prune, and there is nothing left to draw. The
 * registry's boot load is this query, and its first completed sweep is what settles rows
 * whose session vanished while the daemon was down.
 */
export function loadFileCommentThreads(): FileCommentThread[] {
  const rows = openDb()
    .prepare(
      `SELECT * FROM file_comment_threads WHERE status <> 'orphaned'
         ORDER BY session_id ASC, queue_seq ASC, created_at ASC`,
    )
    .all() as unknown as FileCommentThreadRow[];
  return hydrateFileCommentThreads(rows);
}

/** One thread as it rides the wire: its message list capped, `messageCount` exact. */
export function loadFileCommentThread(id: string): FileCommentThread | null {
  return readFileCommentThread(id, true);
}

/**
 * One thread with its WHOLE history, however long. The single-thread route's read.
 *
 * This is the other half of the message cap being a cap rather than a loss: the snapshot and
 * every incremental frame carry a bounded tail plus the true `messageCount`, and a surface
 * that sees `messageCount > messages.length` fetches the rest from here. Without an uncapped
 * path the cap would silently make a long thread unreadable, which is the failure the budget
 * was supposed to avoid rather than cause.
 *
 * Deliberately NOT what the registry or any frame uses - see `hydrateFileCommentThreads`.
 */
export function loadFileCommentThreadWithFullHistory(id: string): FileCommentThread | null {
  return readFileCommentThread(id, false);
}

function readFileCommentThread(id: string, cap: boolean): FileCommentThread | null {
  const row = openDb()
    .prepare(`SELECT * FROM file_comment_threads WHERE id = ?`)
    .get(id) as unknown as FileCommentThreadRow | undefined;
  if (!row) return null;
  return hydrateFileCommentThreads([row], cap)[0] ?? null;
}

export function loadFileCommentThreadsForSession(
  sessionId: string,
  path?: string,
): FileCommentThread[] {
  const d = openDb();
  const rows = (
    path === undefined
      ? d
          .prepare(
            `SELECT * FROM file_comment_threads WHERE session_id = ?
               ORDER BY queue_seq ASC, created_at ASC`,
          )
          .all(sessionId)
      : d
          .prepare(
            `SELECT * FROM file_comment_threads WHERE session_id = ? AND path = ?
               ORDER BY queue_seq ASC, created_at ASC`,
          )
          .all(sessionId, path)
  ) as unknown as FileCommentThreadRow[];
  return hydrateFileCommentThreads(rows);
}

/**
 * Resolve a thread by the handle the agent was shown. ALWAYS session-scoped.
 *
 * `short_id` is unique per session, not globally, so a lookup without a session could land
 * a reply on another session's thread. There is deliberately no global variant of this
 * function for a later phase to reach for.
 */
export function findFileCommentThreadByShortId(
  sessionId: string,
  shortId: string,
): FileCommentThread | null {
  const row = openDb()
    .prepare(`SELECT * FROM file_comment_threads WHERE session_id = ? AND short_id = ?`)
    .get(sessionId, shortId) as unknown as FileCommentThreadRow | undefined;
  if (!row) return null;
  return hydrateFileCommentThreads([row])[0] ?? null;
}

/** True when an error is `one_outstanding_file_comment` refusing a second outstanding row. */
export function isOutstandingFileCommentViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // Matches ONE named index rather than "a UNIQUE failure", the way
  // `isSingleFlightViolation` does. The negative lookahead is load-bearing rather than
  // decorative: the short_id index is on `(session_id, short_id)`, so SQLite reports it as
  // `...file_comment_threads.session_id, file_comment_threads.short_id` and a bare
  // `session_id` match would swallow a mint collision as an outstanding violation - which
  // would refuse to save a comment a human just wrote and report the wrong reason.
  return /UNIQUE constraint failed: file_comment_threads\.session_id(?!\s*,)/i.test(msg);
}

function isShortIdCollision(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /file_comment_threads\.short_id/i.test(msg) ||
    /idx_file_comment_threads_short/i.test(msg);
}

/**
 * `MC-` plus hex. Four characters is 65,536 handles per session, so by the birthday bound a
 * session is around a 1% collision risk at ~36 comments and roughly even odds at ~300. A
 * review is normally tens of comments, so the first candidate nearly always wins - the
 * retry loop exists for the tail, not the common case, and the width is recorded here as a
 * decision rather than left to look accidental.
 */
function mintFileCommentShortId(width: number): string {
  let out = "";
  for (let i = 0; i < width; i += 1) out += Math.floor(Math.random() * 16).toString(16);
  return `MC-${out}`;
}

const SHORT_ID_ATTEMPTS = 8;

export interface CreateFileCommentThreadInput {
  id: string;
  messageId: string;
  sessionId: string;
  path: string;
  startLine: number;
  endLine: number;
  quote: string;
  quoteHash: string;
  revision: string | null;
  surface: FileCommentSurface;
  htmlBlockPath?: HtmlBlockPathStep[] | null;
  htmlBlockQuote?: string | null;
  /** The opening comment. Written through `appendFileCommentMessage`, not a second insert. */
  body: string;
  now: number;
}

/**
 * Create a thread and its opening message, in one transaction.
 *
 * The thread starts as a `draft`: comments are persisted from the first keystroke, because
 * the integrated Files tab and the extracted Files window are two live workspaces that
 * converge only through the daemon, so a comment kept in browser state is wrong in the
 * other one. Submitting is `queueFileCommentThread`, which is a separate, deliberate act.
 *
 * **Minting attempts the insert and inspects the failure; it never pre-checks with a
 * SELECT.** A read-then-write races another create in the same session, and it is the
 * natural wrong fix. If the bounded loop is exhausted the handle WIDENS rather than
 * failing: the column is TEXT and the transcript fallback matches it out of free text, so a
 * longer id costs nothing and is still quotable, whereas refusing to save a comment a human
 * just wrote is a far worse outcome than an id two characters longer.
 */
export function createFileCommentThread(input: CreateFileCommentThreadInput): FileCommentThread {
  const d = openDb();
  for (let attempt = 0; ; attempt += 1) {
    // Widen past the bounded loop rather than fail. Attempt 0-7 are four hex characters;
    // anything after that grows, and a session that reached there has tens of thousands of
    // comments and deserves the wider handle anyway.
    const width = attempt < SHORT_ID_ATTEMPTS ? 4 : 4 + (attempt - SHORT_ID_ATTEMPTS + 1);
    const shortId = mintFileCommentShortId(width);
    d.exec("BEGIN IMMEDIATE");
    try {
      // Inside the transaction, not before it: a pre-check outside would be a racy read, and
      // two concurrent creates could both pass it. `BEGIN IMMEDIATE` is already held for the
      // short-id mint, so this costs one more read on a lock we are taking anyway.
      const held = d
        .prepare(
          `SELECT COUNT(*) AS n FROM file_comment_threads
            WHERE session_id = ? AND status <> 'orphaned'`,
        )
        .get(input.sessionId) as unknown as { n: number };
      if (Number(held.n) >= FILE_COMMENT_THREADS_PER_SESSION_MAX) {
        // Thrown, not rolled back here: the catch below already rolls back and rethrows
        // anything that is not a short-id collision, so one unwind path rather than two.
        throw new FileCommentStoreError(
          `this session already holds ${FILE_COMMENT_THREADS_PER_SESSION_MAX} comments; ` +
            `resolve or delete some before adding another`,
        );
      }
      d.prepare(
        `INSERT INTO file_comment_threads
           (id, short_id, session_id, path, start_line, end_line, quote, quote_hash, revision,
            surface, html_block_path, html_block_quote, status, outdated, queue_seq,
            delivery_id, sent_at, answered_at,
            addressed_at, resolved_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 0, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      ).run(
        input.id,
        shortId,
        input.sessionId,
        input.path,
        input.startLine,
        input.endLine,
        input.quote,
        input.quoteHash,
        input.revision,
        input.surface,
        input.htmlBlockPath == null ? null : JSON.stringify(input.htmlBlockPath),
        input.htmlBlockQuote ?? null,
        input.now,
        input.now,
      );
      // One insert path for messages, not two that can drift: thread creation calls the
      // same writer phase 2's reply box and phase 4's MCP tool call.
      insertFileCommentMessageRow(d, {
        id: input.messageId,
        threadId: input.id,
        author: "human",
        sessionId: input.sessionId,
        body: input.body,
        now: input.now,
      });
      d.exec("COMMIT");
      break;
    } catch (err) {
      // Minting is INSIDE the transaction, so a retry cannot leave a half-created thread
      // behind - the rollback takes the message row with it.
      try {
        d.exec("ROLLBACK");
      } catch {}
      if (!isShortIdCollision(err)) throw err;
    }
  }
  const created = loadFileCommentThread(input.id);
  if (!created) throw new Error("file comment thread vanished immediately after creation");
  return created;
}

function insertFileCommentMessageRow(
  d: DatabaseSync,
  input: {
    id: string;
    threadId: string;
    author: FileCommentAuthor;
    sessionId: string | null;
    body: string;
    now: number;
  },
): void {
  d.prepare(
    `INSERT INTO file_comment_messages
       (id, thread_id, author, session_id, body, delivered_at, read_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
  ).run(input.id, input.threadId, input.author, input.sessionId, input.body, input.now, input.now);
}

/**
 * The ONLY insert into `file_comment_messages`, by either author.
 *
 * Phase 2's reply box passes `human`, phase 4's MCP tool passes `agent`, and thread
 * creation above calls the same row writer - so there is one insert path rather than three
 * that can drift on what a message row looks like.
 */
export function appendFileCommentMessage(input: {
  id: string;
  threadId: string;
  author: FileCommentAuthor;
  sessionId: string | null;
  body: string;
  now: number;
}): FileCommentMessage | null {
  const d = openDb();
  const exists = d
    .prepare(`SELECT id FROM file_comment_threads WHERE id = ?`)
    .get(input.threadId) as { id?: string } | undefined;
  if (!exists?.id) return null;
  const held = d
    .prepare(`SELECT COUNT(*) AS n FROM file_comment_messages WHERE thread_id = ?`)
    .get(input.threadId) as unknown as { n: number };
  if (Number(held.n) >= FILE_COMMENT_MESSAGES_PER_THREAD_MAX) {
    throw new FileCommentStoreError(
      `this comment already holds ${FILE_COMMENT_MESSAGES_PER_THREAD_MAX} messages; ` +
        `start a new comment rather than continuing this one`,
    );
  }
  insertFileCommentMessageRow(d, input);
  touchFileCommentThread(input.threadId, input.now);
  const row = d
    .prepare(`SELECT * FROM file_comment_messages WHERE id = ?`)
    .get(input.id) as unknown as FileCommentMessageRow | undefined;
  return row ? rowToFileCommentMessage(row) : null;
}

/** The thread moved because something about it did. Keeps `updated_at` one statement away. */
function touchFileCommentThread(threadId: string, now: number): void {
  openDb()
    .prepare(`UPDATE file_comment_threads SET updated_at = ? WHERE id = ?`)
    .run(now, threadId);
}

/**
 * One message row, for the caller that holds a message id and needs the thread it belongs
 * to. The edit route is that caller: it has to resolve the OWNER before it writes, so a
 * message id cannot be a way around the thread's own lifetime guard.
 */
export function loadFileCommentMessage(id: string): FileCommentMessage | null {
  const row = openDb()
    .prepare(`SELECT * FROM file_comment_messages WHERE id = ?`)
    .get(id) as unknown as FileCommentMessageRow | undefined;
  return row ? rowToFileCommentMessage(row) : null;
}

export class FileCommentStoreError extends Error {}

/**
 * Edit a comment body. The ONLY way any comment body is edited - phase 2's
 * drafts-from-the-first-keystroke and phase 3's edit-unsent are both this function.
 *
 * **It refuses a delivered message AND one whose thread is merely outstanding**, and both
 * halves are needed because they are two different moments. Submitting only enqueues a
 * turn, so a comment's bytes sit in `pending_turns.text` while its thread is `sending` and
 * before `delivered_at` exists. Refusing on `delivered_at` alone would leave that window
 * editable, and an edit inside it changes the dashboard's copy of a comment already
 * committed to the outbox - the exact divergence the rule exists to prevent.
 *
 * The outstanding statuses are read from the same exported tuple the partial unique index
 * is built from, never respelled here.
 */
export function updateFileCommentMessageBody(
  id: string,
  body: string,
  now: number,
): FileCommentMessage | null {
  const d = openDb();
  const row = d
    .prepare(
      `SELECT m.*, t.status AS thread_status FROM file_comment_messages m
         JOIN file_comment_threads t ON t.id = m.thread_id
        WHERE m.id = ?`,
    )
    .get(id) as unknown as (FileCommentMessageRow & { thread_status: string }) | undefined;
  if (!row) return null;
  // An agent's reply is a RECORD, not a draft, and nothing edits it - not this route, not
  // phase 4's own tool. The two refusals below are both about the SEND window, and an agent
  // reply is on the wrong side of it for either to fire: it arrives undelivered (nobody sends
  // it anywhere) and it moves its thread to `answered`, which is not outstanding. So without
  // this check any caller holding a message id could rewrite what the agent said, which is
  // the same forgery `AppendFileCommentMessageSchema` refuses at creation - a reply the UI
  // renders as the agent's answer, written by somebody else - only worse, because it destroys
  // a real answer instead of inventing one beside it.
  if (row.author !== "human") {
    throw new FileCommentStoreError("an agent's reply is a record and cannot be edited");
  }
  if (row.delivered_at !== null) {
    throw new FileCommentStoreError("a message the agent has already been sent cannot be edited");
  }
  if ((OUTSTANDING_THREAD_STATUSES as readonly string[]).includes(row.thread_status)) {
    throw new FileCommentStoreError(
      "this comment is already committed to the outbox and cannot be edited",
    );
  }
  d.prepare(`UPDATE file_comment_messages SET body = ?, updated_at = ? WHERE id = ?`).run(
    body,
    now,
    id,
  );
  touchFileCommentThread(row.thread_id, now);
  const updated = d
    .prepare(`SELECT * FROM file_comment_messages WHERE id = ?`)
    .get(id) as unknown as FileCommentMessageRow | undefined;
  return updated ? rowToFileCommentMessage(updated) : null;
}

/**
 * Place a thread at the TAIL of its session's queue, setting `queued` and allocating
 * `queue_seq` in one call.
 *
 * **It is the only way a thread enters the queue, first time or not.** Three callers need
 * exactly this - phase 2 submitting a `draft`, a human follow-up on an `answered` or
 * `unanswered` thread, and phase 3 requeueing a thread whose turn resolved with undelivered
 * human messages left - and declaring it once is what stops the second and third being
 * improvised out of the generic status route, which cannot allocate a position at all.
 *
 * **A fresh tail number every time; the prior `queue_seq` is discarded, never reused.**
 * Reusing it would put a follow-up back in the original comment's old position, ahead of
 * comments queued in between, and "re-enters the queue at the end" is the contract.
 *
 * The source-status guard lives on the OPERATION rather than at each of its three callers,
 * and the route is exposed, so it has to hold against a caller that is not one of them. See
 * `REQUEUEABLE_THREAD_STATUSES` for why it is an allow-list and not "anything not
 * outstanding".
 *
 * Modelled on `createPendingTurn`: the allocating SELECT and the UPDATE are one
 * `BEGIN IMMEDIATE`, the house style every transaction in this file follows.
 */
export function queueFileCommentThread(threadId: string, now: number): FileCommentThread | null {
  return inTransaction(() => queueFileCommentThreadRow(threadId, now));
}

/**
 * `queueFileCommentThread`'s body, WITHOUT the transaction.
 *
 * Split out for exactly one caller: `recordAgentFileCommentReply`, which has to release a
 * thread and requeue it in the SAME transaction as the reply that justifies both.
 * `inTransaction` issues `BEGIN IMMEDIATE`, which SQLite refuses inside an open transaction,
 * so composing the exported form would throw rather than nest. Splitting the body is what
 * keeps the tail-allocation and the source-status allow-list to one implementation instead
 * of a second, subtly different copy inside the reply path.
 */
function queueFileCommentThreadRow(threadId: string, now: number): FileCommentThread | null {
  const d = openDb();
  const row = d
    .prepare(`SELECT session_id, status FROM file_comment_threads WHERE id = ?`)
    .get(threadId) as { session_id?: string; status?: string } | undefined;
  if (!row?.session_id) return null;
  const status = readThreadStatus(row.status ?? "");
  if (!(REQUEUEABLE_THREAD_STATUSES as readonly string[]).includes(status)) {
    throw new FileCommentStoreError(`a ${status} comment cannot be queued`);
  }
  const seq = d
    .prepare(
      `SELECT COALESCE(MAX(queue_seq), -1) + 1 AS seq FROM file_comment_threads
         WHERE session_id = ?`,
    )
    .get(row.session_id) as unknown as { seq: number };
  d.prepare(
    `UPDATE file_comment_threads
        SET status = 'queued', queue_seq = ?, updated_at = ?
      WHERE id = ?`,
  ).run(seq.seq, now, threadId);
  return loadFileCommentThread(threadId);
}

/**
 * Rewrite a session's queue order from an explicit list of thread ids.
 *
 * **Two passes with a scratch offset**, exactly as `reorderQueueItems` does for
 * `foreman_queue_items`: the list is written once far above every live value and once back
 * down, so it never passes through an ambiguous order for anything reading mid-transaction.
 * That two-pass shape is also why this table carries no UNIQUE index on
 * `(session_id, queue_seq)` - the first pass legitimately holds values a unique constraint
 * would refuse.
 *
 * Ids that do not belong to this session, or that are not queueable, are ignored rather
 * than refused: a reorder is a drag in a list that may have moved under the operator, and
 * dropping the whole gesture because one row was answered in the meantime is worse than
 * ordering the rows that are still there.
 */
export function reorderFileCommentQueue(
  sessionId: string,
  orderedIds: readonly string[],
  now: number,
): FileCommentThread[] {
  return inTransaction(() => {
    const d = openDb();
    const live = d
      .prepare(
        `SELECT id, status FROM file_comment_threads
          WHERE session_id = ? AND queue_seq IS NOT NULL
          ORDER BY queue_seq`,
      )
      .all(sessionId) as unknown as { id: string; status: string }[];
    const eligible = new Set(live.map((r) => r.id));
    // DEDUPED, first occurrence winning. A drag list is assembled by a browser and arrives
    // over HTTP, so `[a, a, b]` is a reachable body - and writing `a` twice would advance the
    // running index twice, leaving `a` at 1 and `b` at 2 with position 0 unfilled. The
    // consecutive-order contract this function promises is what a later phase reads to find
    // the head of the review, so a hole is not cosmetic.
    const ordered = [...new Set(orderedIds.filter((id) => eligible.has(id)))];
    // Anything the caller did not name keeps its relative order behind the named ones, so a
    // partial list is a promotion rather than a silent truncation of the queue.
    const rest = live
      .map((r) => r.id)
      .filter((id) => !ordered.includes(id));
    const final = [...ordered, ...rest];
    const scratch = 1_000_000;
    const setSeq = d.prepare(
      `UPDATE file_comment_threads SET queue_seq = ?, updated_at = ? WHERE id = ?`,
    );
    final.forEach((id, index) => setSeq.run(scratch + index, now, id));
    final.forEach((id, index) => setSeq.run(index, now, id));
    return loadFileCommentThreadsForSession(sessionId);
  });
}

/**
 * Move a thread to `sending` and record the correlation in `delivery_id`. Phase 3's write
 * at SUBMIT time.
 *
 * It deliberately does NOT stamp `delivered_at`: `pendingTurns.submit()` only enqueues a
 * turn, so from here the thread is outstanding but not yet delivered, and the bytes can
 * still be recalled, dropped, or turned `uncertain` by a restart.
 *
 * **It is also the re-point.** Valid from `queued` for a first send and from `sending` when
 * an `uncertain` delivery is being retried and the correlation is being replaced. It
 * refuses every other status. The single-flight index is unaffected by the retry case
 * (`sending` is outstanding both before and after), and re-pointing through this function
 * rather than a second writer is what keeps `delivery_id` to one declared writer.
 *
 * This is also where the partial unique index bites, which is the point: the index refuses
 * a second outstanding row for the session rather than trusting phase 3's bookkeeping.
 *
 * It writes NO anchor column, deliberately. The phase plan sketched a `deliveryRevision`
 * argument here; taking one would make this a second writer of `revision`, whose single
 * declared writer is `updateFileCommentThreadAnchor`. It is also unnecessary: the
 * re-anchor pass runs over every unsent comment immediately BEFORE each send, so the
 * anchor's revision is already current by the time this is called, and a second write would
 * only be able to disagree with it.
 */
export function beginFileCommentDelivery(
  threadId: string,
  deliveryId: string,
  now: number,
): FileCommentThread | null {
  const d = openDb();
  const row = d
    .prepare(`SELECT status FROM file_comment_threads WHERE id = ?`)
    .get(threadId) as { status?: string } | undefined;
  if (!row?.status) return null;
  const status = readThreadStatus(row.status);
  if (status !== "queued" && status !== "sending") {
    throw new FileCommentStoreError(`a ${status} comment cannot be delivered`);
  }
  // `sent_at` records the FIRST send, so an uncertain-delivery retry re-points the
  // correlation without rewriting when the comment went out.
  d.prepare(
    `UPDATE file_comment_threads
        SET status = 'sending', delivery_id = ?, sent_at = COALESCE(sent_at, ?), updated_at = ?
      WHERE id = ?`,
  ).run(deliveryId, now, now, threadId);
  return loadFileCommentThread(threadId);
}

/**
 * Stamp `delivered_at` on a message and complete the transition `sending` -> `awaiting`.
 *
 * Phase 3 calls this from the CONFIRMED-delivery signal - the one the two sites that retire
 * a claimed pending turn already raise - and never at submit. Stamping at submit would mark
 * a comment delivered while it was still queued in the outbox, and `delivered_at` is what
 * freezes the body and what stops the same message being sent twice.
 */
export function markFileCommentMessageDelivered(id: string, at: number): FileCommentThread | null {
  return inTransaction(() => {
    const d = openDb();
    const row = d
      .prepare(`SELECT thread_id FROM file_comment_messages WHERE id = ?`)
      .get(id) as { thread_id?: string } | undefined;
    if (!row?.thread_id) return null;
    d.prepare(
      `UPDATE file_comment_messages SET delivered_at = ?, updated_at = ?
        WHERE id = ? AND delivered_at IS NULL`,
    ).run(at, at, id);
    d.prepare(
      `UPDATE file_comment_threads SET status = 'awaiting', updated_at = ?
        WHERE id = ? AND status = 'sending'`,
    ).run(at, row.thread_id);
    touchFileCommentThread(row.thread_id, at);
    return loadFileCommentThread(row.thread_id);
  });
}

/**
 * Put a `sending` thread back in the queue because its outbox row went away UNDELIVERED.
 *
 * `recallPendingTurn` and `dropQueuedPendingTurns` both remove rows that never reached the
 * agent, so a row's absence is not proof of delivery - which is why delivery is stamped from
 * the confirmed-delivery signal and never from here. This is the other side of that rule: the
 * signal did not fire, the row is gone, so the comment did not go.
 *
 * **It keeps `queue_seq`, and that is the whole difference from `queueFileCommentThread`.**
 * That operation refuses an outstanding thread and allocates a fresh TAIL position; neither
 * is right for a recall. A recalled comment did not lose its place in the review, and pushing
 * it behind everything queued since would silently reorder a review the operator arranged.
 *
 * `delivery_id` clears, `sent_at` is kept as the record that a send was attempted, and
 * `delivered_at` on the message is untouched - it was never stamped, which is what makes the
 * comment editable again.
 *
 * Refuses anything but `sending`: an `awaiting` thread's bytes provably reached the agent.
 */
export function returnFileCommentDeliveryToQueue(
  threadId: string,
  now: number,
): FileCommentThread | null {
  const d = openDb();
  const changed = d
    .prepare(
      `UPDATE file_comment_threads
          SET status = 'queued', delivery_id = NULL, updated_at = ?
        WHERE id = ? AND status = 'sending'`,
    )
    .run(now, threadId);
  if (!Number(changed.changes)) return null;
  return loadFileCommentThread(threadId);
}

/**
 * The durable half of the re-anchor pass, and the ONLY writer of `start_line`, `end_line`,
 * `revision` and `outdated` after creation.
 *
 * `reanchor()` is pure and returns only an outcome, so without this a thread that moved
 * would be recomputed from its original anchor on every send and `revision` could never
 * leave the value creation gave it.
 *
 * **It changes no status.** `outdated` is a flag beside the status, and whether to hold a
 * comment at the head of the queue is phase 3's decision, not this function's.
 */
export function updateFileCommentThreadAnchor(
  threadId: string,
  patch: { startLine?: number; endLine?: number; revision?: string | null; outdated: boolean },
  now: number,
): FileCommentThread | null {
  const d = openDb();
  const row = d
    .prepare(`SELECT id FROM file_comment_threads WHERE id = ?`)
    .get(threadId) as { id?: string } | undefined;
  if (!row?.id) return null;
  d.prepare(
    `UPDATE file_comment_threads
        SET start_line = COALESCE(?, start_line),
            end_line = COALESCE(?, end_line),
            revision = CASE WHEN ? = 1 THEN ? ELSE revision END,
            outdated = ?,
            updated_at = ?
      WHERE id = ?`,
  ).run(
    patch.startLine ?? null,
    patch.endLine ?? null,
    // `revision` is nullable, so "not supplied" and "supplied as null" cannot be told apart
    // by COALESCE. The explicit flag is what keeps an outdated outcome - which must NOT
    // advance the column - from being indistinguishable from clearing it.
    patch.revision === undefined ? 0 : 1,
    patch.revision ?? null,
    patch.outdated ? 1 : 0,
    now,
    threadId,
  );
  return loadFileCommentThread(threadId);
}

/**
 * The agent's "I handled this". Stamps `addressed_at` and **changes no status**.
 *
 * `addressed` is deliberately not a status - only a person closes a thread - so it cannot
 * ride the status route, which would have to move the thread somewhere in order to write a
 * timestamp, and that is exactly how an agent's suggestion becomes a closure. Phase 4's
 * reply route calls this in the same transaction as its reply insert, so a thread is never
 * seen as addressed by a reply that failed to persist.
 */
export function markFileCommentThreadAddressed(
  threadId: string,
  at: number,
): FileCommentThread | null {
  const d = openDb();
  const changed = d
    .prepare(`UPDATE file_comment_threads SET addressed_at = ?, updated_at = ? WHERE id = ?`)
    .run(at, at, threadId);
  if (!Number(changed.changes)) return null;
  return loadFileCommentThread(threadId);
}

/**
 * Stamp `read_at` on a thread's unread AGENT messages. What clears the Files tab's pip,
 * which counts agent-authored messages where it is NULL.
 *
 * A column rather than browser state for the same reason drafts are: the integrated tab and
 * the extracted Files window are two live workspaces that converge only through the daemon,
 * so a badge kept in one of them is wrong in the other.
 */
export function markFileCommentMessagesRead(threadId: string, at: number): FileCommentThread | null {
  const d = openDb();
  const exists = d
    .prepare(`SELECT id FROM file_comment_threads WHERE id = ?`)
    .get(threadId) as { id?: string } | undefined;
  if (!exists?.id) return null;
  d.prepare(
    `UPDATE file_comment_messages SET read_at = ?, updated_at = ?
      WHERE thread_id = ? AND author = 'agent' AND read_at IS NULL`,
  ).run(at, at, threadId);
  touchFileCommentThread(threadId, at);
  return loadFileCommentThread(threadId);
}

/**
 * Set a thread's status. Phase 2's resolve control is what posts to this; `addressed` never
 * does, and neither does phase 4.
 *
 * Terminal statuses drop the thread out of the queue (`queue_seq` to NULL) because there is
 * no longer a position for it to hold; a re-open through this route therefore requeues
 * through `queueFileCommentThread` like anything else, which is the deliberate two-step.
 */
export function setFileCommentThreadStatus(
  threadId: string,
  status: FileCommentThreadStatus,
  now: number,
): FileCommentThread | null {
  const d = openDb();
  const exists = d
    .prepare(`SELECT id FROM file_comment_threads WHERE id = ?`)
    .get(threadId) as { id?: string } | undefined;
  if (!exists?.id) return null;
  // A queue position is meaningful only while the thread holds one. Clearing it here is what
  // keeps a withdrawn thread from sitting in the order as a `draft`, and a closed one from
  // leaving a permanent hole in it.
  const keepsPosition = holdsQueuePosition(status);
  // `delivery_id` names the `pending_turns` row a comment is correlated to, and it is only
  // meaningful while the comment is outstanding. A thread that has left that set - answered
  // by the agent, timed out to `unanswered`, resolved by a person - is correlated to nothing,
  // and a stale correlation is worse than none: `outstandingDelivery` matches on it, so a
  // recycled turn id would let an unrelated retry lift a pause about a comment that is no
  // longer in flight. `beginFileCommentDelivery` is still the only writer that SETS it.
  const outstanding = isOutstandingThreadStatus(status);
  d.prepare(
    `UPDATE file_comment_threads
        SET status = ?,
            queue_seq = CASE WHEN ? = 1 THEN queue_seq ELSE NULL END,
            delivery_id = CASE WHEN ? = 1 THEN delivery_id ELSE NULL END,
            answered_at = CASE WHEN ? = 'answered' THEN COALESCE(answered_at, ?) ELSE answered_at END,
            resolved_at = CASE WHEN ? = 'resolved' THEN ? ELSE NULL END,
            updated_at = ?
      WHERE id = ?`,
  ).run(
    status,
    keepsPosition ? 1 : 0,
    outstanding ? 1 : 0,
    status,
    now,
    status,
    now,
    now,
    threadId,
  );
  return loadFileCommentThread(threadId);
}

/**
 * Which of a thread's human messages the CURRENT delivery carried, as the ordinal the
 * payload printed - or null when nothing on this thread has been delivered.
 *
 * The greatest `delivered_at` rather than the last message: a thread can be delivered more
 * than once (it times out, a person follows up, it goes round again), and the turn being
 * answered is the most recent one that actually reached the agent. Derived from the message
 * list exactly as `renderFileCommentPayload` derives what it prints, so no column stores it
 * and the two cannot disagree.
 *
 * Read from a thread hydrated WITHOUT the message cap: the ordinal counts every human
 * message, so a capped read past fifty replies would compute a number the payload never
 * printed.
 */
function deliveredOrdinal(thread: FileCommentThread): number | null {
  let ordinal = 0;
  let best: { ordinal: number; at: number } | null = null;
  for (const message of thread.messages) {
    if (message.author !== "human") continue;
    ordinal += 1;
    if (message.deliveredAt === null) continue;
    // `>=`, so a tie goes to the LATER message. Two deliveries of one thread can share a
    // millisecond - a timeout, a follow-up, and its send all inside one tick is ordinary on a
    // fast machine, and `Date.now()` cannot separate them. Messages arrive here in creation
    // order, so among equal stamps the greatest ordinal is the most recent delivery; strict
    // `>` handed a tie to the FIRST one and released the queue on a reply that answered an
    // earlier delivery. Node 26 CI hit exactly that.
    if (!best || message.deliveredAt >= best.at) best = { ordinal, at: message.deliveredAt };
  }
  return best?.ordinal ?? null;
}

export interface AgentFileCommentReply {
  thread: FileCommentThread;
  message: FileCommentMessage;
  /**
   * The reply answered the delivery that is outstanding, so the turn was released.
   *
   * False is an ordinary outcome, not a failure: a late reply, and a reply whose citation
   * carried no ordinal (what the transcript fallback recovers), both persist and release
   * nothing.
   */
  released: boolean;
  /** The released thread went straight back to the queue's tail, owing another turn. */
  requeued: boolean;
}

/**
 * The agent's answer to one delivered comment: persisted, and - only when it answers the
 * delivery that is actually outstanding - the turn released with it.
 *
 * **One transaction, and the insert is the only unconditional part of it.** A reply is real
 * content the agent produced, so it is stored whatever else is true; dropping a late one
 * would lose work. Everything after it is conditional, and TWO INDEPENDENT QUESTIONS decide
 * it - collapsing them is how this deadlocked once already:
 *
 * 1. *Does this reply answer the outstanding delivery?* decides whether the turn is
 *    released. The cited ordinal must name the message the current delivery carried, and
 *    the thread must still be outstanding. Nothing else qualifies: a reply naming an earlier
 *    delivery of a thread that is outstanding AGAIN would otherwise mark the follow-up's
 *    delivery answered and release the next comment having answered nothing.
 * 2. *Does the thread still owe another turn?* decides only where it goes afterwards, and is
 *    asked ONLY once the first has already released it.
 *
 * **Releasing first is what makes the requeue legal.** `queueFileCommentThreadRow` refuses
 * an outstanding thread, so leaving a thread `awaiting` because it has a follow-up on it
 * would wedge the whole review: `awaiting` is in the partial unique index's WHERE clause, so
 * no later comment could ever be delivered, behind a comment that had in fact been answered.
 * `answered` is in `REQUEUEABLE_THREAD_STATUSES`, so the two-step needs no exception.
 *
 * `addressed` is stamped through `markFileCommentThreadAddressed` and never through the
 * status route: it is a suggestion, not a closure, and it must be writable without moving
 * the thread anywhere.
 */
export function recordAgentFileCommentReply(input: {
  messageId: string;
  threadId: string;
  sessionId: string;
  body: string;
  /** The delivery ordinal the reply cited, or null when it cited a bare handle. */
  ordinal: number | null;
  addressed: boolean;
  now: number;
}): AgentFileCommentReply | null {
  return inTransaction(() => {
    // Read BEFORE the insert, uncapped. The insert is agent-authored so it moves no human
    // ordinal, but the status and the delivery stamps are what the two questions turn on and
    // they must be the ones that were true when the reply arrived.
    const before = loadFileCommentThreadWithFullHistory(input.threadId);
    if (!before) return null;
    const message = appendFileCommentMessage({
      id: input.messageId,
      threadId: input.threadId,
      author: "agent",
      sessionId: input.sessionId,
      body: input.body,
      now: input.now,
    });
    if (!message) return null;
    if (input.addressed) markFileCommentThreadAddressed(input.threadId, input.now);

    // `awaiting` specifically, not "outstanding". A `sending` thread's current delivery has
    // not been CONFIRMED, so its message carries no `delivered_at` and the greatest one names
    // an EARLIER delivery - releasing on that would mark the thread answered, and clear the
    // correlation, while its turn is genuinely live in `pending_turns`. `awaiting` is exactly
    // "the outstanding delivery is confirmed", which is what the ordinal can speak about.
    const released =
      input.ordinal !== null
      && before.status === "awaiting"
      && input.ordinal === deliveredOrdinal(before);
    let requeued = false;
    if (released) {
      setFileCommentThreadStatus(input.threadId, "answered", input.now);
      // A person replied while the comment was out. The turn is over, so the follow-up is
      // owed a turn of its own: back to the TAIL, never its old position, because "at the
      // end" is the contract and a reused number would send it ahead of everything queued
      // since.
      if (before.messages.some((m) => m.author === "human" && m.deliveredAt === null)) {
        queueFileCommentThreadRow(input.threadId, input.now);
        requeued = true;
      }
    }
    const thread = loadFileCommentThread(input.threadId);
    return thread ? { thread, message, released, requeued } : null;
  });
}

export function deleteFileCommentThread(threadId: string): boolean {
  return inTransaction(() => {
    const d = openDb();
    d.prepare(`DELETE FROM file_comment_messages WHERE thread_id = ?`).run(threadId);
    const r = d.prepare(`DELETE FROM file_comment_threads WHERE id = ?`).run(threadId);
    return Number(r.changes) > 0;
  });
}

/**
 * Settle every thread a removed session owned to `orphaned`, by UPDATE.
 *
 * **Not a DELETE, and never keyed on `state === 'exited'`** - the standing rule for durable
 * cleanup in this repository, and why there is no second eviction path here. A session that
 * is merely idle, disconnected, or restarting keeps every thread it owns. Returns the ids
 * that MOVED, so the caller emits exactly the frames a browser needs and no more.
 */
export function orphanFileCommentThreadsForSession(sessionId: string, now: number): string[] {
  return inTransaction(() => {
    const d = openDb();
    const rows = d
      .prepare(`SELECT id FROM file_comment_threads WHERE session_id = ? AND status <> 'orphaned'`)
      .all(sessionId) as unknown as { id: string }[];
    if (!rows.length) return [];
    d.prepare(
      `UPDATE file_comment_threads
          SET status = 'orphaned', queue_seq = NULL, updated_at = ?
        WHERE session_id = ? AND status <> 'orphaned'`,
    ).run(now, sessionId);
    // The review's run state goes with them: there is nothing left to walk through, and a
    // row left `running` would resume a review for a session that no longer exists.
    d.prepare(`DELETE FROM file_comment_reviews WHERE session_id = ?`).run(sessionId);
    return rows.map((r) => r.id);
  });
}

/**
 * Finally delete settled threads whose session key is gone.
 *
 * The same shape and the same safety property as `pruneSessionGoals`: BOTH conditions are
 * load-bearing, and the live-key one is the safety property - a thread whose session is
 * still here is never touched no matter how old it is. Only TERMINAL rows are eligible, so
 * a queued comment can never be pruned out from under a review.
 *
 * An empty `liveSessionIds` deletes nothing, for `pruneSessionGoals`' reason.
 */
export function pruneFileCommentThreads(
  liveSessionIds: Iterable<string>,
  olderThan: number,
): number {
  const keys = [...new Set(liveSessionIds)];
  if (!keys.length) return 0;
  return inTransaction(() => {
    const d = openDb();
    const placeholders = keys.map(() => "?").join(",");
    const doomed = d
      .prepare(
        `SELECT id FROM file_comment_threads
          WHERE status IN ('resolved', 'orphaned') AND updated_at < ?
            AND session_id NOT IN (${placeholders})`,
      )
      .all(olderThan, ...keys) as unknown as { id: string }[];
    if (!doomed.length) return 0;
    const ids = doomed.map((r) => r.id);
    const idHoles = ids.map(() => "?").join(",");
    d.prepare(`DELETE FROM file_comment_messages WHERE thread_id IN (${idHoles})`).run(...ids);
    d.prepare(`DELETE FROM file_comment_threads WHERE id IN (${idHoles})`).run(...ids);
    return ids.length;
  });
}

// ---- the walkthrough's run state (phase 3 is its only writer) ----

function rowToFileCommentReview(row: FileCommentReviewRow): FileCommentReview {
  return {
    sessionId: row.session_id,
    state: (["idle", "running", "paused"] as readonly string[]).includes(row.state)
      ? (row.state as FileCommentReviewState)
      : "idle",
    pauseReason: row.pause_reason,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  };
}

/**
 * A session's review state. An absent row reads as `idle` rather than null: "never started"
 * is a real answer the walkthrough and the toolbar both need, and making every caller
 * handle an absence would invite each of them to pick its own default.
 */
export function loadFileCommentReview(sessionId: string): FileCommentReview {
  const row = openDb()
    .prepare(`SELECT * FROM file_comment_reviews WHERE session_id = ?`)
    .get(sessionId) as unknown as FileCommentReviewRow | undefined;
  return row
    ? rowToFileCommentReview(row)
    : { sessionId, state: "idle", pauseReason: null, startedAt: null, updatedAt: 0 };
}

/**
 * Every session's review state, for the registry's boot-time projection.
 *
 * Bounded by `file_comment_reviews`, which holds at most one row per session and is DELETED
 * outright when a session's threads are orphaned - so it is bounded by live sessions in the
 * strictest of the two senses the thread collection uses.
 */
export function loadFileCommentReviews(): FileCommentReview[] {
  const rows = openDb()
    .prepare(`SELECT * FROM file_comment_reviews`)
    .all() as unknown as FileCommentReviewRow[];
  return rows.map(rowToFileCommentReview);
}

export function setFileCommentReviewState(
  sessionId: string,
  state: FileCommentReviewState,
  pauseReason: string | null,
  now: number,
): FileCommentReview {
  openDb()
    .prepare(
      `INSERT INTO file_comment_reviews (session_id, state, pause_reason, started_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         state = excluded.state,
         pause_reason = excluded.pause_reason,
         -- The first start is what started_at records; a pause and resume do not restart
         -- the review, so it is kept rather than rewritten.
         started_at = COALESCE(file_comment_reviews.started_at, excluded.started_at),
         updated_at = excluded.updated_at`,
    )
    .run(sessionId, state, pauseReason, state === "running" ? now : null, now);
  return loadFileCommentReview(sessionId);
}
