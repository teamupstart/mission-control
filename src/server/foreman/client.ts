import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { BASE_URL, envVar, stateDir } from "@shared/harness-runtime.mjs";
import {
  CLAUDE_TRANSPORT_ENV,
  CODEX_TRANSPORT_ENV,
  DEFAULT_CLAUDE_TRANSPORT,
  DEFAULT_CODEX_TRANSPORT,
  DEFAULT_LLM_RUNNER_ID,
  isClaudeTransport,
  isCodexTransport,
  isLlmRunnerId,
} from "@shared/llm.ts";
import type { ClaudeTransport, CodexTransport, LlmRunnerId } from "@shared/llm.ts";
import { ForemanConfigSchema, TRANSCRIPT_DEFAULT_TAIL_TURNS } from "@shared/protocol.ts";
import type {
  BacklogPlanInput,
  ForemanConfig,
  ForemanInstructionsView,
  ForemanLeaseResult,
  ForemanPlannerControl,
  PromptedCompletionDisposition,
  RecordEpisode,
  SetNote,
  SetWorkItemState,
  SpendReportBody,
  SubmitOptions,
} from "@shared/protocol.ts";
import type { PipelineActionResult, PipelineForemanView, PipelineRun } from "@shared/pipeline.ts";
import type {
  AssignRefusalScope,
  BacklogPlan,
  ForemanPlannerHealth,
  ReviewItem,
  Session,
  SessionDiff,
  SessionGoal,
  PromptedDirectHandoffKind,
  SessionIntentGuard,
  SessionNote,
  SessionQueue,
  Task,
  ToolCall,
  TranscriptMessage,
  WorkItem,
} from "@shared/types.ts";
import type { StandardsBundle } from "../standards.ts";
import { InjectError } from "./queue-apply.ts";
import type { ForemanActions } from "./verdict.ts";
import type {
  WorkflowCompletionClaim,
  WorkflowCompletionClaimResult,
  WorkflowRunPage,
  WorkflowRunSummary,
} from "@shared/workflow.ts";

// The worker's client for the daemon's localhost API. All `/api/*` routes are
// loopback-gated (not token-gated), and the worker runs on the same host, so a
// bare fetch to 127.0.0.1 satisfies the Host check with no token. Reads throw on
// a non-2xx so the loop can log and continue; the config read is the liveness probe.

/**
 * The outcome of asking the daemon to start a task, WITH the HTTP status.
 *
 * The status is carried because "it failed" is not one fact here. The routes answer a
 * documented refusal (404, 409) when nothing was typed and the task is untouched, and a
 * 500 when something threw - and `TaskManager.assign` types the prompt BEFORE it claims
 * the row, so a 500 can mean the text landed in the pane and the write behind it did
 * not. A caller deciding whether it is safe to try again has to be able to tell those
 * apart. See `taskRefused` in worker.ts.
 */
export interface TaskActionResult {
  ok: boolean;
  status: number;
  error?: string;
  /**
   * Whether a refusal was about the SESSION or the TASK. Absent from a daemon older
   * than the field, and from every non-assign call - `assignRefusalParksSession` is
   * where that absence is given a meaning, once.
   */
  scope?: AssignRefusalScope;
}

/** The app-wide model-call choices the worker learns from the daemon once per pass. */
export interface ForemanLlmSelection {
  runner: LlmRunnerId;
  claudeTransport: ClaudeTransport;
  codexTransport: CodexTransport;
}

/** Compatibility answer when the daemon predates the transport field or status route. */
export function foremanClaudeTransportFallback(): ClaudeTransport {
  const configured = envVar(CLAUDE_TRANSPORT_ENV)?.trim() ?? "";
  return isClaudeTransport(configured) ? configured : DEFAULT_CLAUDE_TRANSPORT;
}

/** The same compatibility answer for Codex. Both transports degrade the same way. */
export function foremanCodexTransportFallback(): CodexTransport {
  const configured = envVar(CODEX_TRANSPORT_ENV)?.trim() ?? "";
  return isCodexTransport(configured) ? configured : DEFAULT_CODEX_TRANSPORT;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(BASE_URL + path);
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return (await res.json()) as T;
}

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(BASE_URL + path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
}

const enc = encodeURIComponent;

// ---- headless spend delivery ----
//
// A DURABLE outbox for usage reports, and the reason it exists rather than a bare POST: the
// run whose cost this carries has ALREADY happened. There is no retryable unit of work
// behind a failed report - just a number that will never be seen again if it is dropped. A
// daemon restart is an ordinary event, and the worker deliberately outlives one, so "the
// daemon was down for four seconds" must not be a way to lose spend.
//
// It is a FILE, not the database, and that distinction is the whole of how this respects
// the worker/daemon boundary. The rule the worker lives under is that the daemon is the
// only process that opens SQLite - not that the worker may never write a byte. A spool file
// beside the token in `stateDir()` owns nothing the daemon reads, defines no schema, and
// participates in no migration; it is a buffer for requests the worker has not managed to
// make yet. The ledger is still written in exactly one place, by the daemon, off the route.
//
// Entries leave the spool only on a daemon 2xx acknowledgement or 4xx rejection. An
// in-memory queue alone had a real hole: a worker crash, a redeploy, or a Ctrl-C while the
// daemon happened to be down lost every queued report permanently, and the runs behind them
// were unrecoverable by construction. Writing before the first delivery attempt and erasing
// only after the daemon speaks makes the failure mode "delivered twice", which the daemon
// already absorbs - `window_end_ns` holds the run id, so its insert is idempotent.
//
// This queue is deliberately unbounded. Each entry is small, but represents tokens already
// spent on a completed run, so dropping one is unrecoverable loss and no queue-length limit
// is worth that. The trade is unbounded file growth while the daemon remains unreachable in
// exchange for never losing spend; the file self-heals as soon as daemon acknowledgements
// let the worker drain it.

/** Reports awaiting delivery by this process, oldest first. */
const spendOutbox: SpendReportBody[] = [];
const SPEND_RETRY_BASE_MS = 1_000;
const SPEND_RETRY_MAX_MS = 30_000;
/**
 * How often a running worker re-scans for spools abandoned by an exited peer.
 *
 * A recovery interval rather than a poll of anything live: the reports it finds belong to
 * runs that already happened, so arriving 30s late costs nothing, while scanning on every
 * delivery would read the state directory for each report a busy Foreman makes.
 */
const SPEND_ADOPT_SCAN_MS = 30_000;
let lastAdoptScanAt = 0;
const SPEND_OUTBOX_PREFIX = "foreman-spend-outbox.";
const SPEND_OUTBOX_SUFFIX = ".json";
const LEGACY_SPEND_OUTBOX_NAME = "foreman-spend-outbox.json";
const SPEND_QUARANTINE_PREFIX = "foreman-spend-quarantine.";
const spendOutboxId = randomUUID();
let spendRetryTimer: ReturnType<typeof setTimeout> | null = null;
let spendFailures = 0;
let flushing = false;

/**
 * Where undelivered reports wait out a daemon outage.
 *
 * `stateDir()` rather than a path of this module's own, so the spool follows `MISSION_HOME`
 * exactly as the token and the database do. That is what keeps an isolated daemon/worker
 * pair (a test, an E2E) from inheriting the real install's pending reports, and it is
 * resolved per call rather than cached because a test sets the override after import.
 *
 * The id is minted once per process, so this path has exactly one writer for its lifetime.
 * A restart naturally leaves the old path behind for `loadSpendOutbox()` to adopt.
 */
function spendOutboxPath(): string {
  return join(stateDir(), `${SPEND_OUTBOX_PREFIX}${spendOutboxId}${SPEND_OUTBOX_SUFFIX}`);
}

function fsErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object" || !("code" in err)) return undefined;
  return String((err as { code?: unknown }).code);
}

interface StoredSpendOutbox {
  ownerPid: number | null;
  entries: SpendReportBody[];
  legacy: boolean;
}

function readSpendOutbox(path: string): StoredSpendOutbox | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (fsErrorCode(err) === "ENOENT") return null;
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    return { ownerPid: null, entries: everyEntryOrThrow(parsed), legacy: true };
  }
  if (!parsed || typeof parsed !== "object") throw new Error("spend outbox is not an object");
  const stored = parsed as Record<string, unknown>;
  if (!Number.isInteger(stored.ownerPid) || (stored.ownerPid as number) <= 0) {
    throw new Error("spend outbox has no valid owner pid");
  }
  if (!Array.isArray(stored.entries)) throw new Error("spend outbox entries are not an array");
  return {
    ownerPid: stored.ownerPid as number,
    entries: everyEntryOrThrow(stored.entries),
    legacy: false,
  };
}

/**
 * All the entries, or none of them.
 *
 * This used to `filter` - which silently discarded anything that did not match the shape,
 * and was the most dangerous line in the file, because adoption then persisted the
 * survivors and DELETED the source. One malformed entry from a partial hand edit, a schema
 * change, or corruption that leaves the JSON syntactically valid, and that run was gone
 * with nothing to recover it from.
 *
 * Throwing instead routes the whole file into the existing "leave an unreadable spool
 * untouched" path: nothing is adopted, nothing is deleted, the warning fires once, and a
 * human still has every byte. That does mean the file's VALID entries wait too, which is
 * the right trade - undelivered is recoverable, discarded is not - and the alternative
 * (adopt the good ones but keep the file) would re-adopt and re-deliver them on every sweep
 * forever, which is the replay loop this code has already been bitten by once.
 */
function everyEntryOrThrow(entries: unknown[]): SpendReportBody[] {
  const out: SpendReportBody[] = [];
  for (const entry of entries) {
    if (!looksLikeSpendReport(entry)) {
      throw new Error("spend outbox holds an entry that is not a spend report");
    }
    out.push(entry);
  }
  return out;
}

function spendOutboxOwnerLiveness(pid: number): "alive" | "dead" | "unknown" {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (err) {
    if (fsErrorCode(err) === "ESRCH") return "dead";
    console.warn(`[foreman] could not establish spend outbox owner ${pid} liveness:`, err);
    return "unknown";
  }
}

/**
 * Mirror this process's queue to its own spool. Never throws - a spool that cannot be
 * written must not take down a worker, it just costs the durability this function adds.
 *
 * Written whole and renamed into place rather than appended, because a torn write is worse
 * than a slow one: `rename` is atomic within a filesystem, so a crash mid-write leaves the
 * previous complete spool rather than half a JSON document. Serializing the in-memory queue
 * is safe because the per-process id makes this file single-writer for its entire lifetime.
 *
 * An empty queue REMOVES the file instead of writing `[]`, so "nothing is pending" is the
 * absence of a spool rather than a state that has to be parsed to discover.
 */
function persistSpendOutbox(): boolean {
  const path = spendOutboxPath();
  try {
    if (spendOutbox.length === 0) {
      rmSync(path, { force: true });
      return noteSpoolDurability(true);
    }
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ownerPid: process.pid, entries: spendOutbox }), "utf8");
    renameSync(tmp, path);
    return noteSpoolDurability(true);
  } catch (err) {
    console.warn("[foreman] could not persist the spend outbox:", err);
    return noteSpoolDurability(false);
  }
}

/**
 * Track whether the queue is actually on disk, and say so when it stops being.
 *
 * A failed write used to be logged and shrugged off, which quietly downgraded the whole
 * feature: with an unwritable state directory the queue is just an in-memory list again, and
 * if the daemon is also unreachable, a crash loses runs that were already paid for. That is
 * the exact failure the spool exists to prevent, so it must not be a silent state.
 *
 * `error` rather than `warn` on the way down, because it is a durability guarantee going
 * away rather than a routine retry, and once rather than per report so a full disk does not
 * bury the message it needs to deliver. The recovery line matters just as much: an operator
 * who saw the first message needs to know the window closed.
 */
let spoolUndurableSince = 0;
function noteSpoolDurability(ok: boolean): boolean {
  if (ok) {
    if (spoolUndurableSince) {
      console.warn(
        `[foreman] the spend outbox is writable again after ` +
          `${Math.round((Date.now() - spoolUndurableSince) / 1000)}s; queued reports are durable`,
      );
      spoolUndurableSince = 0;
    }
    return true;
  }
  if (!spoolUndurableSince) {
    spoolUndurableSince = Date.now();
    console.error(
      "[foreman] the spend outbox could NOT be written, so queued reports are held only in " +
        "memory and a crash would lose them. Every delivery attempt retries the write.",
    );
  }
  return false;
}

/**
 * Re-attempt a spool write that previously failed, before relying on the queue in memory.
 *
 * Called at the top of every drain, which is the one place guaranteed to run again while
 * anything is pending: a delivery failure arms the retry timer, so as long as reports are
 * undelivered this keeps trying to make them durable. Nothing else would - `enqueueSpend`
 * fires once per run, and the disk being full at that moment says nothing about a minute
 * later.
 */
function retrySpoolPersistIfNeeded(): void {
  if (!spoolUndurableSince || spendOutbox.length === 0) return;
  persistSpendOutbox();
}

/**
 * Where a report the daemon REJECTED goes, instead of being deleted.
 *
 * Separate from the delivery spool on purpose, and never drained automatically. A 4xx body
 * would be rejected again on every retry, so re-queueing it would spin forever; but a 4xx is
 * also what an out-of-date daemon answers mid-rolling-upgrade, when the route is absent
 * (404) or its schema has moved (422), and that resolves by itself. Those two are
 * indistinguishable from here, so the code refuses to decide: it keeps the run rather than
 * discarding it, and leaves re-delivery to a human who can see which case it was.
 *
 * Per-process, like the outbox, so it inherits the same single-writer property and needs no
 * locking. Appends rather than replaces, since a rejected report is a permanent record until
 * somebody clears it.
 */
function spendQuarantinePath(): string {
  return join(stateDir(), `${SPEND_QUARANTINE_PREFIX}${spendOutboxId}${SPEND_OUTBOX_SUFFIX}`);
}

/**
 * Preserve a rejected report and say so loudly.
 *
 * `error` rather than `warn`: this is the one path where a completed, already-paid-for run
 * stops moving toward the ledger, so it needs to be visible in a log an operator scans
 * rather than filed with the routine retry chatter. The message names the file, because the
 * only way this spend ever lands is somebody acting on it.
 */
function quarantineSpend(report: SpendReportBody, status: number): boolean {
  const path = spendQuarantinePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    let entries: unknown[] = [];
    let existing: string | null = null;
    try {
      existing = readFileSync(path, "utf8");
    } catch (err) {
      // A missing quarantine is the ordinary case - there is simply nothing held yet.
      if (fsErrorCode(err) !== "ENOENT") throw err;
    }
    if (existing !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(existing);
      } catch {
        parsed = undefined;
      }
      if (Array.isArray(parsed)) {
        entries = parsed;
      } else {
        // The file holds something this build cannot read - filesystem corruption, a
        // half-written document, a hand-edit. It must NOT simply be replaced: every entry
        // in it is a rejected run that was already paid for, and overwriting would delete
        // the whole history to make room for one new report. That is the same
        // delete-before-preserve mistake this path exists to prevent, one level further in.
        //
        // So the unreadable bytes are moved aside under a name nothing else writes, and the
        // fresh quarantine starts empty beside them. Both are then recoverable by hand,
        // which is the most this code can honestly promise about content it cannot parse.
        const kept = preserveUnreadable(path);
        console.error(
          `[foreman] the spend quarantine at ${path} could not be read; ` +
            (kept
              ? `its bytes are preserved at ${kept} and a new file starts empty. Both hold ` +
                `runs that were already paid for - neither is retried automatically.`
              : `and it could not be preserved either, so its earlier entries may be lost.`),
        );
        if (!kept) return false;
      }
    }
    // De-duplicated by run id, because this can legitimately be reached twice for the same
    // report: the entry is written here BEFORE it leaves the outbox, so a crash in that
    // window leaves the run in both files and the next delivery attempt quarantines it
    // again. Duplication is the safe side of that window - it is the price of never having
    // a moment where the run exists in neither - but the file should still not grow a copy
    // per crash.
    if (entries.some((e) => quarantinedRunId(e) === report.runId)) return true;
    entries.push({ status, quarantinedAt: Date.now(), report });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(entries), "utf8");
    renameSync(tmp, path);
    console.error(
      `[foreman] spend rejected: ${report.role} run ${report.runId} -> ${status}; ` +
        `quarantined in ${path} (${entries.length} held). It is NOT retried automatically - ` +
        `if this was a daemon too old for /api/usage/automation, re-send the file once it is upgraded.`,
    );
    return true;
  } catch (err) {
    // The caller keeps the report in the outbox when this returns false, so nothing is lost
    // here - the run simply stays queued until the quarantine can be written.
    console.error(
      `[foreman] spend rejected: ${report.role} run ${report.runId} -> ${status}, ` +
        `and it could not be quarantined; keeping it queued rather than dropping it:`,
      err,
    );
    return false;
  }
}

/**
 * Move an unreadable file aside under a name that is free, returning where it went.
 *
 * A FREE name specifically: `renameSync` overwrites its destination silently on POSIX, so
 * a fixed suffix would let the second corruption destroy what the first one preserved -
 * which would be this whole function failing at the one job it has. The counter is bounded
 * so a pathological directory cannot spin here forever; giving up returns null and the
 * caller then refuses to touch the original at all.
 *
 * Returns null on failure, and the caller treats that as "do not proceed" rather than
 * pressing on, because proceeding would mean overwriting the very bytes this preserves.
 */
function moveAside(path: string, tag: string): string | null {
  for (let attempt = 0; attempt < 100; attempt++) {
    const suffix = attempt === 0 ? "" : `-${attempt}`;
    const kept = `${path}.${tag}-${process.pid}-${Date.now()}${suffix}`;
    try {
      if (existsSync(kept)) continue;
      renameSync(path, kept);
      return kept;
    } catch (err) {
      if (fsErrorCode(err) === "ENOENT") return null; // it vanished; nothing to preserve
      return null;
    }
  }
  return null;
}

/** Keep bytes this build cannot parse, under a name the scan will not pick up again. */
function preserveUnreadable(path: string): string | null {
  return moveAside(path, "unreadable");
}

/** The run id inside a stored quarantine entry, tolerating anything hand-edited. */
function quarantinedRunId(entry: unknown): string | null {
  if (!entry || typeof entry !== "object") return null;
  const report = (entry as { report?: unknown }).report;
  if (!report || typeof report !== "object") return null;
  const runId = (report as { runId?: unknown }).runId;
  return typeof runId === "string" ? runId : null;
}

/** How many rejected reports are held for explicit recovery. For the shutdown log and tests. */
export function quarantinedSpendReports(): number {
  try {
    const parsed: unknown = JSON.parse(readFileSync(spendQuarantinePath(), "utf8"));
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Restore reports a previous worker never managed to deliver. Call once, at startup.
 *
 * Returns how many were recovered so the worker can say so - a silent restore would make
 * the one moment this feature earns its keep invisible.
 *
 * Every provably dead owner's spool is copied into this process's own spool BEFORE its source
 * is removed. A live or uncertain owner is left completely alone, so the failure direction
 * is delayed recovery rather than deletion of an already-paid-for run. A recycled pid may
 * make a dead owner look alive; waiting for a later startup is deliberately safer than
 * guessing that a live writer is dead.
 *
 * Two workers may adopt the same dead owner's spool during a handoff, but that can only
 * duplicate delivery: the daemon keys each insert by run id and absorbs the duplicate.
 */
/**
 * Statuses that mean THIS DAEMON has looked at this body and will never accept it.
 *
 * An allowlist, and the direction is the point. The obvious shape - list what is retryable
 * and quarantine the rest - puts every status nobody thought of on the one-way path, and
 * that is exactly how a transient 429 or 408 became a permanent trip to the quarantine.
 * Inverting it means an unanticipated answer waits, which is recoverable, instead of being
 * set aside for a human, which is not.
 *
 * Exactly the two `/api/usage/automation` itself emits about a body: the schema rejected it
 * (400, from `parseBody`) or the daemon understood it and cannot record it (422, an unknown
 * runner). Nothing else qualifies, because quarantine is only defensible when the refusal
 * is DURABLE, and only the daemon's own verdict is.
 *
 * 413 and 415 were briefly here and are deliberately gone. The comment justifying them
 * admitted they could come from a proxy rather than the daemon - and a proxy's payload limit
 * or content-type configuration is exactly the kind of thing that changes, so treating one
 * as a permanent verdict about the report contradicted the retry-by-default contract. They
 * now wait, like every other status this code cannot attribute to the daemon.
 *
 * Also not here: 401/403. If the loopback route ever grew auth, that is a configuration
 * problem an operator fixes, and the run should wait for the fix rather than be filed away.
 */
function permanentlyRejected(status: number): boolean {
  return status === 400 || status === 422;
}

/**
 * Whether a status means "this daemon has no such route", for the log line only.
 *
 * A worker newer than its daemon gets 404, 405 or 501, and saying so plainly is worth a
 * branch: "the daemon has no /api/usage/automation" tells an operator to finish the
 * upgrade, where a bare status does not. It no longer decides anything - retrying is the
 * default for every non-permanent status.
 */
function routeUnavailable(status: number): boolean {
  return status === 404 || status === 405 || status === 501;
}

/**
 * Complain about one file once, not once per scan.
 *
 * The scan became PERIODIC when a running worker started sweeping for dead peers, and that
 * turned every warning inside it from a one-off at startup into a line every interval,
 * forever, for a file that will never become readable. A log an operator learns to ignore
 * is worse than no log; this keeps the first report - the one that names the problem - and
 * drops the repeats.
 *
 * Keyed by path and never cleared: the set is bounded by the number of spool files, and a
 * path that becomes readable again stops reaching here anyway.
 */
const warnedSpoolPaths = new Set<string>();
function warnOncePerPath(path: string, message: string, err: unknown): void {
  if (warnedSpoolPaths.has(path)) return;
  warnedSpoolPaths.add(path);
  console.warn(message, err);
}

function scanAndAdoptSpools(): void {
  const ownPath = spendOutboxPath();
  const dir = dirname(ownPath);
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch (err) {
    if (fsErrorCode(err) !== "ENOENT") {
      console.warn("[foreman] could not scan spend outboxes:", err);
    }
    return;
  }
  for (const name of names) {
    const path = join(dir, name);
    if (path === ownPath) continue;
    if (
      name !== LEGACY_SPEND_OUTBOX_NAME &&
      !(name.startsWith(SPEND_OUTBOX_PREFIX) && name.endsWith(SPEND_OUTBOX_SUFFIX))
    ) {
      continue;
    }
    let restored: StoredSpendOutbox | null;
    try {
      restored = readSpendOutbox(path);
    } catch (err) {
      warnOncePerPath(path, `[foreman] leaving unreadable spend outbox ${name} untouched:`, err);
      continue;
    }
    if (!restored) continue;
    if (!restored.legacy) {
      const ownerPid = restored.ownerPid!;
      if (spendOutboxOwnerLiveness(ownerPid) !== "dead") continue;
      try {
        restored = readSpendOutbox(path);
      } catch (err) {
        warnOncePerPath(path, `[foreman] could not re-read dead owner's spend outbox ${name}:`, err);
        continue;
      }
      if (
        !restored ||
        restored.legacy ||
        restored.ownerPid !== ownerPid ||
        spendOutboxOwnerLiveness(ownerPid) !== "dead"
      ) {
        continue;
      }
    }
    let merged = false;
    for (const report of restored.entries) {
      if (spendOutbox.some((queued) => queued.runId === report.runId)) continue;
      spendOutbox.push(report);
      merged = true;
    }
    // Restore oldest-first across the MERGED queue. Adoption walks the directory in filename
    // order, and those names carry a random per-process id, so two dead workers' spools
    // arrive in an order that has nothing to do with when their runs happened. Appending
    // blindly would deliver a later report before an earlier one and quietly break the
    // oldest-first contract the queue otherwise keeps.
    //
    // Sorted by `ts`, and stable, so this process's own pending reports - already appended
    // in time order - keep their relative positions and equal timestamps do not shuffle.
    if (merged) spendOutbox.sort((a, b) => a.ts - b.ts);
    if (!persistSpendOutbox()) continue;
    if (restored.legacy) {
      // A legacy array carries no owner pid, so liveness cannot be proven and it must not be
      // DELETED - a previous-build worker may still be appending to it. But it cannot be
      // left in place either, now that adoption runs periodically rather than only at
      // startup: the scan would re-read it, re-queue the same reports, and re-POST them on
      // every sweep forever. The ledger de-duplicates by run id so no row doubles, but the
      // traffic and the repeated "delivered" logs are real and unbounded.
      //
      // Moving it aside settles both: the reports are already durable in this process's own
      // spool by the line above, the bytes survive under a name the scan does not match, and
      // an old worker that appends later simply recreates the path with its own array, which
      // is then adopted once more and moved aside again. Bounded, rather than perpetual.
      const moved = moveAside(path, "migrated");
      if (!moved) {
        console.warn(
          `[foreman] adopted the legacy spend outbox ${name} but could not move it aside; ` +
            `it will be re-read until that succeeds`,
        );
      }
      continue;
    }
    try {
      rmSync(path, { force: true });
    } catch (err) {
      console.warn(`[foreman] could not remove adopted spend outbox ${name}:`, err);
    }
  }
}

/**
 * Scan for adoptable spools, at most once per `SPEND_ADOPT_SCAN_MS` unless forced.
 *
 * Throttled because the scan is a `readdir` plus a read per candidate, and the drain calls
 * it on every pass. Startup forces it: that is the one moment where waiting 30s to discover
 * a dead predecessor's reports would be pure delay for no saving.
 */
function adoptOrphanSpools(force = false): void {
  const now = Date.now();
  if (!force && now - lastAdoptScanAt < SPEND_ADOPT_SCAN_MS) return;
  lastAdoptScanAt = now;
  scanAndAdoptSpools();
}

/** Adopt a dead predecessor's reports at startup. Returns how many are now queued. */
export function loadSpendOutbox(): number {
  adoptOrphanSpools(true);
  return spendOutbox.length;
}

/**
 * Look for work left by an exited peer, and deliver it.
 *
 * Called from the worker's main loop, because startup adoption alone is not enough: a peer
 * can die while THIS worker keeps running, and its spool would then sit unreported until
 * some future process happened to start - potentially never, on a machine whose worker
 * simply stays up. Recovery has to be something a living worker does, not only something a
 * booting one does.
 *
 * It also flushes, because adopting without delivering just moves the reports into a queue
 * nothing is draining: this worker's own queue may have been empty, in which case no retry
 * is armed and nothing else would ever send them.
 */
export function sweepSpendOutbox(): void {
  // Unthrottled, deliberately: this is called by a caller that owns a loop and can therefore
  // decide its own cadence, and a hidden time gate here would make "I asked for a sweep and
  // nothing happened" a silent outcome that depends on how recently something else ran.
  // The throttle stays on the drain's internal call, where the frequency is not the
  // caller's to choose.
  adoptOrphanSpools(true);
  if (spendOutbox.length > 0) void flushSpend();
}

export const spendOutboxTest = { path: spendOutboxPath, quarantinePath: spendQuarantinePath };

/** The shape check the restore path applies. Deliberately structural, not a zod import. */
function looksLikeSpendReport(value: unknown): value is SpendReportBody {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.role === "string" &&
    typeof r.runner === "string" &&
    typeof r.runId === "string" &&
    r.runId.length > 0 &&
    typeof r.ts === "number" &&
    Array.isArray(r.models) &&
    r.models.length > 0
  );
}

/**
 * Drop one report from the queue BY IDENTITY, never by position.
 *
 * A positional `shift()` was correct only while the queue could not be reordered underneath
 * an in-flight delivery. It can now: adoption re-sorts by timestamp, and a sweep can adopt
 * while a flush is awaiting its POST, so the entry at index 0 afterwards need not be the one
 * the daemon just acknowledged. Removing by run id makes the removal mean what the code
 * says - "forget the report that landed" - rather than "forget whatever is at the front".
 *
 * Getting this wrong would delete an unacknowledged run while acknowledging a different one,
 * which is the precise failure this whole path exists to prevent.
 */
function forgetQueued(runId: string): void {
  const at = spendOutbox.findIndex((queued) => queued.runId === runId);
  if (at >= 0) spendOutbox.splice(at, 1);
}

function enqueueSpend(report: SpendReportBody): void {
  spendOutbox.push(report);
  // Persisted BEFORE the first delivery attempt, which is the ordering the durability
  // depends on: a crash between the run finishing and the POST landing must still find the
  // report on disk.
  persistSpendOutbox();
}

/**
 * Drain the outbox, stopping at the first report that could not be delivered.
 *
 * IN ORDER and one at a time, so a transient failure leaves the queue intact rather than
 * half-sent. Re-entrancy is guarded because reports arrive from an unawaited sink while an
 * earlier flush may still be in flight; two concurrent drains would interleave their
 * shifts and could send the same report twice. (Double delivery is not a correctness
 * problem downstream - the run id makes the daemon's insert idempotent - but it is still
 * a needless round trip, and relying on the far side to clean up after this one would be
 * the wrong place for the argument.)
 */
async function flushSpend(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    // Pick up anything an exited peer left before draining. This is the path that matters
    // after an outage: the daemon comes back, this worker retries its own queue, and a dead
    // peer's reports should ride along rather than waiting for someone to restart. Throttled
    // internally, so a busy drain does not re-scan the directory per report.
    adoptOrphanSpools();
    // And make the queue durable again if a previous write failed. This runs before any
    // delivery because the in-memory queue is the thing at risk: while the spool is
    // unwritable, a crash here loses runs that have already been paid for.
    retrySpoolPersistIfNeeded();
    while (spendOutbox.length > 0) {
      const report = spendOutbox[0]!;
      let res: Response;
      try {
        res = await send("POST", "/api/usage/automation", report);
      } catch (err) {
        // The daemon is unreachable - restarting, or not up yet. Keep the report and back
        // off; this is the exact case the outbox exists for.
        console.warn(`[foreman] spend delivery deferred (${String(err)})`);
        scheduleSpendRetry();
        return;
      }
      if (res.ok) {
        // Removed only now, on the daemon's ACK. Erasing it any earlier would reopen the
        // exact hole the spool closes - the report would be gone from disk while still
        // only maybe recorded.
        forgetQueued(report.runId);
        persistSpendOutbox();
        spendFailures = 0;
        continue;
      }
      if (permanentlyRejected(res.status)) {
        // A route that EXISTS looked at this body and refused it, and will refuse it
        // identically forever, so retrying in place would stall every later report behind
        // it. It must not be deleted either - the run is already paid for.
        //
        // So it is QUARANTINED: taken out of the delivery queue, where it can no longer
        // block anything, and written to a separate durable file that nothing drains
        // automatically. Automatic re-delivery is deliberately not attempted - a body this
        // daemon rejects would loop forever - so recovery is an explicit operator act.
        // Nothing is lost in the meantime.
        //
        // ORDER IS LOAD-BEARING: the quarantine entry is made durable BEFORE the report
        // leaves the outbox. Doing it the other way round leaves a window where a worker
        // that exits has erased the run from the outbox without having written it anywhere
        // else, which is exactly the loss this whole path exists to prevent. This ordering
        // can instead leave the run in both files for a moment, and duplication is the
        // recoverable side of that trade - `quarantineSpend` de-duplicates by run id.
        if (!quarantineSpend(report, res.status)) {
          // The quarantine could not be written. Keep the report exactly where it is and
          // try again on the next pass: a stalled queue is recoverable, a deleted run is
          // not. Everything behind it stays durable in the outbox meanwhile.
          scheduleSpendRetry();
          return;
        }
        forgetQueued(report.runId);
        persistSpendOutbox();
        continue;
      }
      // EVERYTHING ELSE WAITS. 5xx (the daemon is there but unhappy), 404/405/501 (a daemon
      // older than this worker, mid-upgrade), 408/429 (a timeout or a rate limit, from the
      // daemon or something in front of it) - and, deliberately, any status not anticipated
      // here at all.
      //
      // Retry-by-default is the safe direction and the reason this is a default rather than
      // a list: the only thing that must never happen is losing an already-paid-for run, and
      // holding one costs a stalled queue that resolves itself. Enumerating retryable
      // statuses instead meant every status nobody had thought of fell into quarantine,
      // which is how a transient 429 became a permanent one-way trip.
      console.warn(
        routeUnavailable(res.status)
          ? `[foreman] the daemon has no /api/usage/automation (${res.status}); ` +
            `holding ${report.role} until it does`
          : `[foreman] spend not recorded: ${report.role} -> ${res.status}; will retry`,
      );
      scheduleSpendRetry();
      return;
    }
  } finally {
    flushing = false;
  }
}

/**
 * Arm one exponentially-backed-off retry.
 *
 * `unref` so a queue that cannot drain never holds the process open - a worker being shut
 * down should exit, not linger trying to deliver accounting for runs that are over. Only
 * ever one timer: a second report arriving during a backoff joins the same drain rather
 * than starting a competing one.
 */
function scheduleSpendRetry(): void {
  if (spendRetryTimer) return;
  const delay = Math.min(SPEND_RETRY_BASE_MS * 2 ** spendFailures, SPEND_RETRY_MAX_MS);
  spendFailures++;
  spendRetryTimer = setTimeout(() => {
    spendRetryTimer = null;
    void flushSpend();
  }, delay);
  spendRetryTimer.unref?.();
}

/** Queue depth, for the worker's shutdown log and for tests. */
export function pendingSpendReports(): number {
  return spendOutbox.length;
}

/** Deliver whatever is queued right now. The shutdown path's last best effort. */
export function flushPendingSpend(): Promise<void> {
  if (spendRetryTimer) {
    clearTimeout(spendRetryTimer);
    spendRetryTimer = null;
  }
  return flushSpend();
}

export interface TranscriptWindowResponse {
  messages: TranscriptMessage[];
  truncated: boolean;
  /** Boundary of the elided middle - see `TranscriptWindow`. Absent when there is no window. */
  headCount?: number;
  unavailable?: boolean;
  /**
   * True when a `since` offset is past EOF: the transcript was reset (a `/clear`),
   * so the anchor is meaningless. Callers must escalate rather than judge an item
   * against a near-empty window and invent gaps.
   */
  reset?: boolean;
}

/**
 * Coerce one turn's `tools` back to `ToolCall[]` across a daemon/worker version skew.
 *
 * `tools` used to be `string[]` and is now `ToolCall[]`. The worker is started separately from
 * the daemon, so an old daemon still serving `["Bash"]` to a new worker is an ordinary
 * upgrade-window state - and this is the one cast where that stops being free. Those strings
 * reach `riskContextFrom` as `t.input ? … : t.name`, where BOTH are undefined, so every call
 * flattens to the literal "undefined": the tool names and the commands vanish from the denylist
 * blob while prose still scans, so `hasProse` holds, backstop 3(a) does not fire, and a
 * `Bash(rm -rf …)` reads as clean - the exact hole carrying inputs was filed to close, failing
 * silently and OPEN. `formatTranscript` degrades the same way, rendering "(tools: undefined)".
 *
 * So this follows `recentTurns`' precedent rather than the blanket cast rule: a field arriving
 * over the wire must never let its own absence become the permissive answer. A string becomes
 * `{ name }`, which restores exactly the pre-input behaviour (names scan, inputs are absent
 * because that daemon never had them) and invents nothing. Anything unrecognisable is dropped
 * instead of being carried as a half-formed call.
 */
function normalizeTools(tools: unknown): ToolCall[] {
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((t): ToolCall[] => {
    if (typeof t === "string") return [{ name: t }];
    if (!t || typeof t !== "object") return [];
    const { name, input } = t as Record<string, unknown>;
    if (typeof name !== "string") return [];
    return [{ name, input: typeof input === "string" ? input : undefined }];
  });
}

/** Read + write helpers over the daemon API; satisfies `ForemanActions`. */
export class ForemanClient implements ForemanActions {
  /**
   * The config, parsed rather than cast. Every other read here casts the response and can
   * afford to: a malformed session list costs a bad log line. This one drives whether Foreman
   * acts and how - so it is validated at the edge, which applies the schema's own defaults to
   * a key an older daemon doesn't serve yet (`triage` -> `shadow`; the worker is started
   * separately from the daemon, so a version skew between them is an ordinary upgrade-window
   * state) and rejects a value outside the enum instead of letting it reach the tier dispatch.
   * A parse failure throws like any other bad read: the caller already logs it and retries,
   * which idles Foreman rather than running it under a config nobody can vouch for.
   */
  async getConfig(): Promise<ForemanConfig> {
    return ForemanConfigSchema.parse(await get<unknown>("/api/foreman/config"));
  }

  /**
   * Which provider and Claude transport the app's offline work uses, resolved by the DAEMON.
   *
   * Over a route rather than off the DB, because the Foreman worker is a separate process
   * and never touches it - and off the daemon rather than re-derived here, because the
   * setting is one ladder (config, then env, then default) and the daemon is the only side
   * that can see the config layer at all. A worker resolving it from its own environment
   * would answer differently from the panel that printed it.
   *
   * Falls back rather than throwing on fields it cannot read. A newer worker paired with an
   * older daemon takes its own environment transport and then this build's shipped default.
   * The caller handles a failed request separately by retaining its last known answer.
   */
  async llmSelection(): Promise<ForemanLlmSelection> {
    const status = await get<{
      runner?: { id?: string };
      claudeTransport?: string;
      codexTransport?: string;
    }>("/api/llm/status");
    const id = status?.runner?.id;
    const transport = status?.claudeTransport;
    const codex = status?.codexTransport;
    return {
      runner: id && isLlmRunnerId(id) ? id : DEFAULT_LLM_RUNNER_ID,
      claudeTransport: transport && isClaudeTransport(transport)
        ? transport
        : foremanClaudeTransportFallback(),
      // Read beside Claude's, off the same status body, so ONE request carries every
      // app-wide model-call choice and a transient failure retains all of them together.
      codexTransport: codex && isCodexTransport(codex)
        ? codex
        : foremanCodexTransportFallback(),
    };
  }

  /**
   * Acquire/renew the worker lease. Returns null when the daemon is unreachable,
   * which the caller MUST treat as "not the leader" - assuming leadership because
   * we couldn't ask is exactly how two workers end up draining the queue.
   */
  async heartbeat(workerId: string): Promise<ForemanLeaseResult | null> {
    try {
      const res = await send("POST", "/api/foreman/heartbeat", { workerId });
      if (!res.ok) return null;
      return (await res.json()) as ForemanLeaseResult;
    } catch {
      return null;
    }
  }

  /** Process-local retry signal from the daemon; it carries no plan or scheduler state. */
  plannerControl(): Promise<ForemanPlannerControl> {
    return get<ForemanPlannerControl>("/api/foreman/planner/control");
  }

  /** Atomically consume a pending operator retry while this worker holds the lease. */
  async claimPlannerRetry(workerId: string, retryGeneration: number): Promise<boolean> {
    const res = await send("POST", "/api/foreman/planner/control/claim", {
      workerId,
      retryGeneration,
    });
    if (!res.ok) return false;
    return ((await res.json()) as { claimed?: unknown }).claimed === true;
  }

  /** Project the leader's bounded circuit state for status/UI without touching SQLite. */
  async reportPlannerHealth(workerId: string, health: ForemanPlannerHealth): Promise<void> {
    const res = await send("POST", "/api/foreman/planner/health", { workerId, ...health });
    if (!res.ok) throw new Error(`reportPlannerHealth -> ${res.status}`);
  }

  /** Hand the lease back on a clean shutdown, so a standby takes over at once. */
  async releaseLease(workerId: string): Promise<void> {
    await send("POST", "/api/foreman/heartbeat/release", { workerId }).catch(() => {});
  }

  sessions(): Promise<Session[]> {
    return get<Session[]>("/api/sessions");
  }

  /** Runs bound to this stable session id or note key, newest first. */
  async workflowRuns(session: string): Promise<WorkflowRunSummary[]> {
    const page = await get<WorkflowRunPage>(
      `/api/workflow-runs?session=${enc(session)}&limit=200`,
    );
    return page.items;
  }

  reviews(): Promise<ReviewItem[]> {
    return get<ReviewItem[]>("/api/reviews");
  }

  // ---- the backlog autopilot ----

  /** Every task, not just the backlog: dependencies point at tasks that already left it. */
  tasks(): Promise<Task[]> {
    return get<Task[]>("/api/tasks");
  }

  /** Foreman's stored reading of the backlog, or null when it has never made one. */
  backlogPlan(): Promise<BacklogPlan | null> {
    return get<BacklogPlan | null>("/api/backlog/plan");
  }

  /**
   * Store a fresh plan, replacing whatever was there.
   *
   * Throws on failure, and the caller must NOT count that as progress: the write is
   * what makes the plan cover the backlog, so a tick that failed it leaves the machine
   * deciding `plan` again next pass. Reporting it as advanced is what would turn a
   * broken route into a Sonnet call every BETWEEN_MS.
   */
  async putBacklogPlan(plan: BacklogPlanInput): Promise<void> {
    const res = await send("PUT", "/api/backlog/plan", plan);
    if (!res.ok) throw new Error(`putBacklogPlan -> ${res.status}`);
  }

  /**
   * Launch a fresh agent in its own worktree for a backlog task.
   *
   * The daemon flips the task out of `backlog` before this resolves, so the next tick's
   * read cannot see it as schedulable again - which is the only thing standing between
   * a laggy read and two agents on one task. The worker keeps a short-lived guard of its
   * own as well; see `recentlyActed`.
   */
  async dispatchTask(id: string, defaultModel: string | null): Promise<TaskActionResult> {
    const res = await send("POST", `/api/tasks/${enc(id)}/dispatch`, { defaultModel });
    if (res.ok) return { ok: true, status: res.status };
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, status: res.status, error: body.error ?? `dispatch -> ${res.status}` };
  }

  /**
   * Hand a backlog task to an agent that is already running.
   *
   * A refusal is a 409 carrying a reason, and it is an ordinary outcome rather than an
   * error: the session can go busy between the decision and this call, and the daemon
   * re-checks. Nothing was typed in that case, so the task stays in the backlog and the
   * next tick decides again from a fresh snapshot.
   *
   * Autopilot may confirm the handover reset unattended because it has already ruled out
   * everything the confirmation is protecting: `agentIsFree` requires an empty work
   * queue, and clearing the context is how it hands an agent over at all.
   */
  async assignTask(id: string, sessionId: string): Promise<TaskActionResult> {
    const res = await send("POST", `/api/tasks/${enc(id)}/assign`, {
      sessionId,
      confirmReset: true,
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      scope?: AssignRefusalScope;
    };
    if (res.ok && body.ok !== false) return { ok: true, status: res.status };
    return {
      ok: false,
      status: res.status,
      error: body.error ?? `assign -> ${res.status}`,
      scope: body.scope,
    };
  }

  // ---- external pipeline triage ----

  /** The daemon's current, opt-in halt view. This read never probes the provider. */
  pipelineForeman(): Promise<PipelineForemanView> {
    return get<PipelineForemanView>("/api/pipelines/foreman");
  }

  /** Stamp ownership of an action before the request crosses to the provider. */
  async recordPipelineEpisode(run: PipelineRun, episode: RecordEpisode): Promise<void> {
    const res = await send("POST", "/api/pipelines/foreman-episode", {
      provider: run.provider,
      repoRoot: run.repoRoot,
      slug: run.slug,
      episode,
    });
    if (!res.ok) throw new Error(`recordPipelineEpisode -> ${res.status}`);
  }

  /** Drive the same phase 4 action route the dashboard uses. */
  async pipelineAction(run: PipelineRun, action: "unpark"): Promise<PipelineActionResult> {
    const res = await send("POST", "/api/pipelines/action", {
      provider: run.provider,
      repoRoot: run.repoRoot,
      slug: run.slug,
      action,
      requestedBy: "foreman",
    });
    if (!res.ok) throw new Error(`pipelineAction -> ${res.status}`);
    return (await res.json()) as PipelineActionResult;
  }

  /**
   * The transcript window, with each turn's `tools` normalized - see `normalizeTools`. The rest
   * of the response is cast like every other read: `headCount` already refuses to let its own
   * absence mean anything permissive (see `recentTurns`), and the remaining fields cost a bad
   * log line at worst.
   *
   * `turns` is the TAIL only: the route adds a fixed opening head of `TRANSCRIPT_HEAD_TURNS`
   * on top, so the default full-reviewer window is 12 + 48 = 60 turns, not 48.
   */
  async transcript(id: string, turns = TRANSCRIPT_DEFAULT_TAIL_TURNS): Promise<TranscriptWindowResponse> {
    const w = await get<TranscriptWindowResponse>(`/api/sessions/${enc(id)}/transcript?turns=${turns}`);
    return { ...w, messages: (w.messages ?? []).map((m) => ({ ...m, tools: normalizeTools(m.tools) })) };
  }

  /** The transcript's current byte size - a work item's delivery anchor. */
  async transcriptSize(id: string): Promise<number | null> {
    const r = await get<{ size: number | null }>(`/api/sessions/${enc(id)}/transcript/size`);
    return r.size;
  }

  /**
   * The child's rendered screen, or null when there is none to read - no pane, a failed
   * capture, or a daemon too old to serve the route (the worker is started separately, so a
   * version skew between them is an ordinary upgrade-window state).
   *
   * Null-on-failure rather than a throw, because every caller's fallback is the same and is
   * safe: without the screen the reviewer reads the transcript alone and skips honestly,
   * which is exactly the behaviour this replaced. Failing the whole review over an
   * unreadable pane would turn a lost improvement into a lost review.
   */
  async pane(id: string): Promise<string | null> {
    try {
      const r = await get<{ text: string | null }>(`/api/sessions/${enc(id)}/pane`);
      return typeof r.text === "string" ? r.text : null;
    } catch {
      return null;
    }
  }

  /** The transcript from a byte offset forward - one work item's turns, exactly. */
  transcriptSince(id: string, offset: number): Promise<TranscriptWindowResponse> {
    return get<TranscriptWindowResponse>(`/api/sessions/${enc(id)}/transcript?since=${offset}`);
  }

  /** A session's diff, optionally scoped to the base recorded when an item was sent. */
  diff(id: string, base?: string | null): Promise<SessionDiff> {
    const q = base ? `?base=${enc(base)}` : "";
    return get<SessionDiff>(`/api/sessions/${enc(id)}/diff${q}`);
  }

  /**
   * The repo standards that apply to the files a diff touched.
   *
   * POSTed rather than GET-with-`path=`-params, because the path list is derived
   * from a patch capped at 1.2MB and is otherwise UNBOUNDED: a few hundred
   * URL-encoded source paths (every `/` becomes `%2F`) overflow Node's 16KB default
   * `maxHeaderSize`, the daemon rejects the request line, and the caller's `.catch`
   * turns that into an empty bundle reporting `truncated: false` - so the verifier
   * judges the item against the repo's contract having read none of it, and nothing
   * says so. A body has no such limit, so the request cannot outgrow its input.
   * This is a read; it's a POST only because the query doesn't fit in a URL.
   */
  async standards(id: string, paths: string[]): Promise<StandardsBundle> {
    const res = await send("POST", `/api/sessions/${enc(id)}/standards`, { paths });
    if (!res.ok) throw new Error(`standards ${id} -> ${res.status}`);
    return (await res.json()) as StandardsBundle;
  }

  /**
   * Foreman's standing instructions - the shipped default, or what the operator has since
   * saved. Empty string when they have chosen to have none.
   *
   * GLOBAL, not per-session, because that is what it is: one setting for the operator rather
   * than a property of whichever session is under review. The caller degrades a failure to ""
   * (see `readInstructions`), which is the same state as an operator who cleared the box.
   */
  async instructions(): Promise<string> {
    const r = await get<ForemanInstructionsView>("/api/foreman/instructions");
    return typeof r?.text === "string" ? r.text : "";
  }

  // ---- work queues ----

  /**
   * The FULL queue for a session. Fetched per target per tick because
   * `Session.queue` carries only the compact card summary, while the machine needs
   * gaps, baseSha, transcriptAnchor, round, revision and strike counts. That's one
   * extra round-trip against a loopback API - noise next to a `claude -p`.
   */
  queue(id: string): Promise<SessionQueue | null> {
    return get<SessionQueue | null>(`/api/sessions/${enc(id)}/queue`);
  }

  /**
   * Offer an already-proven completion boundary to the daemon. Any non-2xx or lost
   * response throws so the worker fails closed and never falls through to shipping.
   */
  async claimWorkflowCompletion(
    sessionId: string,
    claim: WorkflowCompletionClaim,
  ): Promise<WorkflowCompletionClaimResult> {
    const res = await send(
      "POST",
      `/api/sessions/${enc(sessionId)}/workflow-completion`,
      claim,
    );
    if (!res.ok) throw new Error(`claimWorkflowCompletion ${sessionId} -> ${res.status}`);
    return (await res.json()) as WorkflowCompletionClaimResult;
  }

  /** Queues with no live session at all - the orphan sweep's input. */
  orphanedQueues(): Promise<SessionQueue[]> {
    return get<SessionQueue[]>("/api/queues?orphaned=1");
  }

  async setItemState(sessionId: string, itemId: string, patch: SetWorkItemState): Promise<WorkItem> {
    const res = await send("PUT", `/api/sessions/${enc(sessionId)}/queue/${enc(itemId)}/state`, patch);
    if (!res.ok) throw new Error(`setItemState ${itemId} -> ${res.status}`);
    return (await res.json()) as WorkItem;
  }

  /**
   * The same write addressed by QUEUE KEY - for a queue whose session is gone, which
   * is the only state the orphan sweep acts in. The session-scoped route insists the
   * session resolves, and here by definition it cannot.
   */
  async setItemStateByKey(
    noteKey: string,
    itemId: string,
    patch: SetWorkItemState,
  ): Promise<WorkItem> {
    const res = await send("PUT", `/api/queues/${enc(noteKey)}/items/${enc(itemId)}/state`, patch);
    if (!res.ok) throw new Error(`setItemStateByKey ${itemId} -> ${res.status}`);
    return (await res.json()) as WorkItem;
  }

  /**
   * Deliver a whole prompt as ONE bracketed-paste submission. Throws on failure,
   * which is what lets the caller stamp `awaiting_pickup` only after it resolves.
   *
   * The throw is an `InjectError` carrying whether text may have reached the pane,
   * because that decides whether the caller may retry or must escalate. It is only
   * ever safe when the daemon positively said `pasted: false`; a request that never
   * completed tells us nothing about what the daemon did with it.
   */
  async inject(id: string, text: string): Promise<void> {
    let res: Response;
    try {
      // `origin` is what lets the conversation log say who typed this. Every inject from
      // this client is Foreman's: the human's own replies go through the dashboard.
      res = await send("POST", `/api/sessions/${enc(id)}/inject`, { text, origin: "foreman" });
    } catch (err) {
      throw new InjectError(`inject ${id} -> ${String(err)}`, true);
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        pasted?: boolean;
        paneBlocked?: boolean;
      };
      // `paneBlocked` reads the opposite way round from `pasted`: a MISSING field means
      // false, because only the daemon can know a human is in copy-mode and silence is
      // not that claim. Reading it as true would let any malformed error response buy an
      // item unlimited retries.
      throw new InjectError(
        `inject ${id} -> ${res.status}${body.error ? `: ${body.error}` : ""}`,
        body.pasted !== false,
        body.paneBlocked === true,
      );
    }
  }

  /** Stamp delivery server-side (sentAt is the daemon's clock, not ours). */
  async markSent(
    sessionId: string,
    itemId: string,
    baseSha: string | null,
    transcriptAnchor: number | null,
  ): Promise<WorkItem> {
    const res = await send("POST", `/api/sessions/${enc(sessionId)}/queue/${enc(itemId)}/sent`, {
      baseSha,
      transcriptAnchor,
    });
    if (!res.ok) throw new Error(`markSent ${itemId} -> ${res.status}`);
    return (await res.json()) as WorkItem;
  }

  /** Adopt an item a restart left mid-send. */
  async recoverItem(sessionId: string, itemId: string): Promise<WorkItem> {
    const res = await send("POST", `/api/sessions/${enc(sessionId)}/queue/${enc(itemId)}/recover`);
    if (!res.ok) throw new Error(`recoverItem ${itemId} -> ${res.status}`);
    return (await res.json()) as WorkItem;
  }

  /**
   * Stamp the wrap-up ask, so the Ship it? card renders.
   *
   * `clearAnswer` is the PROMPTED trigger's flag and must stay opt-in: that trigger can
   * raise a second ask on a row whose `wrapupAnswer` belongs to a previous episode, and
   * the card hides on a non-null answer - so without clearing it the new question is
   * stamped and then invisibly swallowed. The DRAIN path must never pass it: there the
   * answer it would clobber is the answer to the ask being raised.
   */
  async markWrapupAsked(sessionId: string, opts?: { clearAnswer?: boolean }): Promise<void> {
    const res = await send(
      "POST",
      `/api/sessions/${enc(sessionId)}/queue/wrapup/asked`,
      opts?.clearAnswer ? { clearAnswer: true } : undefined,
    );
    if (!res.ok) throw new Error(`markWrapupAsked ${sessionId} -> ${res.status}`);
  }

  /**
   * Record the wrap-up answer. This is the same endpoint the card uses when a human
   * clicks Send: an auto-wrapup is that same event with Foreman as the author, so it
   * must land in the same durable field. Anything else and the card would re-offer an
   * instruction the agent already has.
   */
  async setWrapupAnswer(sessionId: string, answer: string): Promise<void> {
    const res = await send("PUT", `/api/sessions/${enc(sessionId)}/queue/wrapup`, { answer });
    if (!res.ok) throw new Error(`setWrapupAnswer ${sessionId} -> ${res.status}`);
  }

  /**
   * Say that a recorded direct handoff never reached the agent.
   *
   * Returns whether the correction landed, and never throws for a refusal: the caller is
   * already handling an injection failure, and a 409 here means the row moved on to a
   * reason nobody should overwrite. A transport failure is reported the same way, because
   * there is nothing useful this caller could do differently either way - the Ship it? card
   * it raises next is the recovery, with or without the correction.
   */
  async markPromptedHandoffUndelivered(
    sessionId: string,
    logicalKey: string,
    generation: number,
  ): Promise<boolean> {
    const res = await send(
      "POST",
      `/api/sessions/${enc(sessionId)}/queue/wrapup/prompted/undelivered`,
      { logicalKey, generation },
    ).catch(() => null);
    return Boolean(res?.ok);
  }

  /**
   * Consume one expected completed work-cycle generation, optionally raising its ask or
   * recording the direct-shipping handoff that is about to be typed.
   *
   * `directHandoff` reaches the daemon over this route precisely because Foreman never
   * writes SQLite. The daemon stamps it inside the same compare-and-consume statement,
   * which is what makes "marked before injected" a property of one transaction rather
   * than of two requests a crash can land between.
   */
  async consumePromptedGeneration(
    sessionId: string,
    logicalKey: string,
    generation: number,
    expectedIntent: SessionIntentGuard,
    /**
     * Why this generation stopped. REQUIRED, and positional rather than tucked into
     * `opts`, so a new consumption path cannot be written without answering it - the
     * whole point of the projection is that every consumed generation has a reason
     * beside it, and an optional parameter is a reason that gets forgotten.
     */
    decision: PromptedCompletionDisposition,
    opts?: { ask?: boolean; directHandoff?: PromptedDirectHandoffKind },
  ): Promise<void> {
    const res = await send("POST", `/api/sessions/${enc(sessionId)}/queue/wrapup/prompted`, {
      logicalKey,
      generation,
      expectedIntent,
      decision,
      ...(opts?.ask ? { ask: true } : {}),
      ...(opts?.directHandoff ? { directHandoff: opts.directHandoff } : {}),
    });
    if (!res.ok) throw new Error(`consumePromptedGeneration ${sessionId} -> ${res.status}`);
  }

  /** The full reconciled intent, whose objective and raw prompt the card summary omits. */
  async goal(sessionId: string): Promise<SessionGoal | null> {
    const res = await send("GET", `/api/sessions/${enc(sessionId)}/goal`);
    if (!res.ok) return null;
    return (await res.json()) as SessionGoal;
  }

  note(id: string): Promise<SessionNote | null> {
    return get<SessionNote | null>(`/api/sessions/${enc(id)}/note`);
  }

  async putNote(id: string, patch: SetNote): Promise<unknown> {
    const res = await send("PUT", `/api/sessions/${enc(id)}/note`, patch);
    if (!res.ok) throw new Error(`putNote ${id} -> ${res.status}`);
    return res.json();
  }

  async sendText(id: string, text: string, submit: boolean): Promise<unknown> {
    // A submitted Foreman answer is a whole agent turn, even when it happens to be one
    // line. Route it through the same bracketed-paste + harness settle sequence as work
    // queue prompts. `/send` types and presses Enter back-to-back; Codex can coalesce that
    // Enter into the paste window and leave the answer visibly sitting in its composer
    // while this client reports success. `inject` waits out the harness's settle window first.
    //
    // `submit: false` is intentionally different: it is a draft the model asked to leave
    // in the composer, so it keeps the literal `/send` path and spends no Enter.
    if (submit) return this.inject(id, text);
    // `origin` declared on this arm too, for the same reason `inject` declares it: the
    // daemon cannot tell who is typing once the text is keystrokes, and it refuses a
    // Foreman write into a session that never invited Foreman. Under-declaring here would
    // route Foreman's own drafts around the backstop that exists to stop them.
    const res = await send("POST", `/api/sessions/${enc(id)}/send`, {
      text,
      submit,
      origin: "foreman",
    });
    if (!res.ok) throw new Error(`sendText ${id} -> ${res.status}`);
    return res.json();
  }

  /**
   * Select a row of the menu a child is showing. Throws on a refusal, which is the point:
   * the daemon refuses whenever it can't confirm the row against the live screen, and
   * `applyVerdict` turns that throw into "not answered" rather than a false byline.
   */
  async selectOption(id: string, option: { number: number; label: string }): Promise<unknown> {
    // `by` for the same reason `resolveReview` carries it, documented below: answering a
    // driver QUESTION now leaves a record in the session's conversation, and the record
    // must not say the operator chose this.
    const res = await send("POST", `/api/sessions/${enc(id)}/select-option`, {
      ...option,
      by: "foreman",
    });
    if (!res.ok) throw new Error(`selectOption ${id} -> ${res.status}`);
    return res.json();
  }

  /**
   * Submit a driver form's answers as a whole - the `{answers}` body of `/submit-options`.
   *
   * Throws on refusal exactly as `selectOption` does, and a refusal here means nothing was
   * delivered: the daemon re-checks the submission against the live request and answers 409
   * before any of it reaches the agent, so `applyVerdict`'s catch leaves the session parked
   * rather than half-answered.
   */
  async submitForm(
    id: string,
    answers: NonNullable<SubmitOptions["answers"]>,
  ): Promise<unknown> {
    const res = await send("POST", `/api/sessions/${enc(id)}/submit-options`, {
      answers,
      by: "foreman",
    });
    if (!res.ok) throw new Error(`submitForm ${id} -> ${res.status}`);
    return res.json();
  }

  /**
   * `by: "foreman"` is not decoration - it is what keeps this answer out of the session's
   * conversation as if the operator had given it. The route defaults to the human because
   * its other caller is the dashboard, so the worker has to say who it is; without that,
   * every Foreman auto-answer would render twice in the log, once as its own episode and
   * once as a gold "you answered" card nobody clicked.
   */
  async resolveReview(reviewId: string, action: "answer", response: string): Promise<unknown> {
    const res = await send("POST", `/api/reviews/${enc(reviewId)}/resolve`, {
      action,
      response,
      by: "foreman",
    });
    if (!res.ok) throw new Error(`resolveReview ${reviewId} -> ${res.status}`);
    return res.json();
  }

  /**
   * Record the episode behind a note: what the child was asked, and what we did.
   *
   * Never throws. It runs after the answer has been delivered and the note stamped,
   * so by then the work has SUCCEEDED - letting a failed audit write surface as an
   * error would have the worker log a failure for a session it handled correctly,
   * and (worse) leave the loop looking like it should retry an act it must not
   * repeat. The daemon side fails soft for the same reason; this closes the other
   * half, where the request never arrives at all.
   */
  async recordEpisode(id: string, episode: RecordEpisode): Promise<void> {
    try {
      const res = await send("POST", `/api/sessions/${enc(id)}/foreman-episode`, episode);
      if (!res.ok) console.error(`[foreman] episode not recorded: ${id} -> ${res.status}`);
    } catch (err) {
      console.error("[foreman] could not record the episode:", err);
    }
  }

  /**
   * Report what a headless run cost, so the daemon can put it in the ledger.
   *
   * QUEUED, not fire-and-forget, because the failure this has to survive is routine rather
   * than exotic: the daemon restarts, and the Foreman worker does not. A single POST that
   * merely logged its own failure would discard tokens that were genuinely spent - the run
   * is finished and paid for by the time this is called, so a dropped report is not a
   * retryable unit of work being skipped, it is money that silently never appears. The
   * whole point of this feature is that such spend stops being invisible.
   *
   * Never throws, on `recordEpisode`'s precedent: accounting is strictly downstream of a
   * review that already succeeded, so nothing here may turn a delivered verdict into a
   * failure. The sink does not await it either, which is why the failure path has to be a
   * log rather than a rejection - an unawaited promise that rejected would be an unhandled
   * rejection, and that takes the worker down.
   */
  async reportSpend(report: SpendReportBody): Promise<void> {
    enqueueSpend(report);
    if (spendRetryTimer) return;
    await flushSpend();
  }

}
