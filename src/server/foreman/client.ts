import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { BASE_URL, stateDir } from "@shared/harness-runtime.mjs";
import { DEFAULT_LLM_RUNNER_ID, isLlmRunnerId } from "@shared/llm.ts";
import type { LlmRunnerId } from "@shared/llm.ts";
import { ForemanConfigSchema, TRANSCRIPT_DEFAULT_TAIL_TURNS } from "@shared/protocol.ts";
import type {
  BacklogPlanInput,
  ForemanConfig,
  ForemanLeaseResult,
  RecordEpisode,
  SetNote,
  SetWorkItemState,
  SpendReportBody,
  SubmitOptions,
} from "@shared/protocol.ts";
import type {
  AssignRefusalScope,
  BacklogPlan,
  ReviewItem,
  Session,
  SessionDiff,
  SessionGoal,
  SessionNote,
  SessionQueue,
  Task,
  ToolCall,
  TranscriptMessage,
  WorkItem,
} from "@shared/types.ts";
import type { StandardsBundle } from "../standards.ts";
import { InjectError } from "./queue-apply.ts";
import type { GateRef } from "./pending.ts";
import type { ForemanActions } from "./verdict.ts";
import type { WorkflowCompletionClaim, WorkflowCompletionClaimResult } from "@shared/workflow.ts";

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
// A bounded, DURABLE outbox for usage reports, and the reason it exists rather than a bare
// POST: the run whose cost this carries has ALREADY happened. There is no retryable unit of
// work behind a failed report - just a number that will never be seen again if it is
// dropped. A daemon restart is an ordinary event, and the worker deliberately outlives one,
// so "the daemon was down for four seconds" must not be a way to lose spend.
//
// It is a FILE, not the database, and that distinction is the whole of how this respects
// the worker/daemon boundary. The rule the worker lives under is that the daemon is the
// only process that opens SQLite - not that the worker may never write a byte. A spool file
// beside the token in `stateDir()` owns nothing the daemon reads, defines no schema, and
// participates in no migration; it is a buffer for requests the worker has not managed to
// make yet. The ledger is still written in exactly one place, by the daemon, off the route.
//
// Entries leave the spool only on a daemon ACK. An in-memory queue alone had a real hole:
// a worker crash, a redeploy, or a Ctrl-C while the daemon happened to be down lost every
// queued report permanently, and the runs behind them were unrecoverable by construction.
// Writing before the first delivery attempt and erasing only after a 2xx makes the failure
// mode "delivered twice", which the daemon already absorbs - `window_end_ns` holds the run
// id, so its insert is idempotent.

/** Reports awaiting delivery by this process, oldest first. */
const spendOutbox: SpendReportBody[] = [];
/**
 * How many reports to hold before shedding.
 *
 * Sized so an outage has to be long AND busy to reach it: the Foreman's four roles produce
 * at most a few reports a minute even under load, so 256 is roughly an hour of sustained
 * failure. A cap is still required - without one, a daemon that never comes back turns
 * this into an unbounded leak in a process designed to run for weeks.
 */
const SPEND_OUTBOX_MAX = 256;
const SPEND_RETRY_BASE_MS = 1_000;
const SPEND_RETRY_MAX_MS = 30_000;
const SPEND_LOCK_RETRIES = 8;
const SPEND_LOCK_RETRY_BASE_MS = 10;
// A dead worker must not leave every later worker unable to make its accounting durable.
const SPEND_LOCK_STALE_MS = 5_000;
const spendLockWait = new Int32Array(new SharedArrayBuffer(4));
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
 * One shared path rather than one per worker id: the id is minted fresh per process, so a
 * per-worker file would be orphaned by the very restart this exists to survive. Every
 * mutation merges one process's change under `spendOutboxLockPath()` because workers can
 * overlap during lease handoff even though only the leader creates new spend.
 */
function spendOutboxPath(): string {
  return join(stateDir(), "foreman-spend-outbox.json");
}

function spendOutboxLockPath(): string {
  return join(stateDir(), "foreman-spend-outbox.lock");
}

function fsErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object" || !("code" in err)) return undefined;
  return String((err as { code?: unknown }).code);
}

interface SpendOutboxLock {
  fd: number;
  path: string;
  dev: number;
  ino: number;
}

function acquireSpendOutboxLock(): SpendOutboxLock {
  const path = spendOutboxLockPath();
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < SPEND_LOCK_RETRIES; attempt++) {
    let fd: number | null = null;
    try {
      fd = openSync(path, "wx");
      const identity = fstatSync(fd);
      writeFileSync(fd, `${process.pid}\n`, "utf8");
      return { fd, path, dev: identity.dev, ino: identity.ino };
    } catch (err) {
      if (fd !== null) {
        try { closeSync(fd); } catch {}
        try { rmSync(path, { force: true }); } catch {}
      }
      if (fsErrorCode(err) !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(path).mtimeMs > SPEND_LOCK_STALE_MS) {
          rmSync(path, { force: true });
          continue;
        }
      } catch (statErr) {
        if (fsErrorCode(statErr) === "ENOENT") continue;
        throw statErr;
      }
      if (attempt + 1 < SPEND_LOCK_RETRIES) {
        const delay = SPEND_LOCK_RETRY_BASE_MS * (attempt + 1);
        Atomics.wait(spendLockWait, 0, 0, delay);
      }
    }
  }
  throw new Error(`timed out acquiring ${spendOutboxLockPath()}`);
}

function assertSpendOutboxLockOwned(lock: SpendOutboxLock): void {
  const current = statSync(lock.path);
  if (current.dev !== lock.dev || current.ino !== lock.ino) {
    throw new Error("spend outbox lock ownership changed");
  }
}

function releaseSpendOutboxLock(lock: SpendOutboxLock): void {
  try {
    closeSync(lock.fd);
  } catch (err) {
    console.warn("[foreman] could not close the spend outbox lock:", err);
  }
  try {
    const current = statSync(lock.path);
    if (current.dev === lock.dev && current.ino === lock.ino) rmSync(lock.path, { force: true });
  } catch (err) {
    if (fsErrorCode(err) !== "ENOENT") {
      console.warn("[foreman] could not release the spend outbox lock:", err);
    }
  }
}

function withSpendOutboxLock<T>(fallback: T, operation: (lock: SpendOutboxLock) => T): T {
  let lock: SpendOutboxLock | null = null;
  try {
    lock = acquireSpendOutboxLock();
    return operation(lock);
  } catch (err) {
    console.warn("[foreman] could not update the spend outbox:", err);
    return fallback;
  } finally {
    if (lock) releaseSpendOutboxLock(lock);
  }
}

function readSpendOutbox(path: string): SpendReportBody[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (fsErrorCode(err) === "ENOENT") return [];
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("spend outbox is not an array");
  return parsed.filter(looksLikeSpendReport);
}

function writeSpendOutbox(
  path: string,
  reports: SpendReportBody[],
  lock: SpendOutboxLock,
): void {
  assertSpendOutboxLockOwned(lock);
  if (reports.length === 0) {
    rmSync(path, { force: true });
    return;
  }
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(reports), "utf8");
  renameSync(tmp, path);
}

type SpendOutboxDelta =
  | { kind: "append"; report: SpendReportBody }
  | { kind: "remove"; runId: string };

/**
 * Merge one local queue change into the shared spool. Never throws - a spool that cannot
 * be written must not take down a worker, it just costs the durability this function adds.
 *
 * Written whole and renamed into place rather than appended, because a torn write is worse
 * than a slow one: `rename` is atomic within a filesystem, so a crash mid-write leaves the
 * previous complete spool rather than half a JSON document. The read and rename share one
 * lock so an overlapping worker's append cannot disappear behind this process's ACK.
 *
 * An empty queue REMOVES the file instead of writing `[]`, so "nothing is pending" is the
 * absence of a spool rather than a state that has to be parsed to discover.
 */
function persistSpendOutbox(delta: SpendOutboxDelta): void {
  const path = spendOutboxPath();
  withSpendOutboxLock(undefined, (lock) => {
    const reports = readSpendOutbox(path);
    if (delta.kind === "append") {
      if (!reports.some((report) => report.runId === delta.report.runId)) {
        reports.push(delta.report);
      }
    } else {
      const index = reports.findIndex((report) => report.runId === delta.runId);
      if (index >= 0) reports.splice(index, 1);
    }
    while (reports.length > SPEND_OUTBOX_MAX) reports.shift();
    writeSpendOutbox(path, reports, lock);
  });
}

/**
 * Restore reports a previous worker never managed to deliver. Call once, at startup.
 *
 * Returns how many were recovered so the worker can say so - a silent restore would make
 * the one moment this feature earns its keep invisible.
 *
 * A malformed spool is discarded rather than repaired. It can only come from a partial
 * write this module did not make or a hand-edit, and the alternative - feeding unvalidated
 * shapes to the route - trades a lost row for a queue that 4xxs forever.
 */
export function loadSpendOutbox(): number {
  const path = spendOutboxPath();
  return withSpendOutboxLock(0, (lock) => {
    let restored: SpendReportBody[];
    try {
      restored = readSpendOutbox(path);
    } catch {
      console.warn("[foreman] discarding an unreadable spend outbox");
      writeSpendOutbox(path, [], lock);
      return 0;
    }
    if (restored.length === 0) {
      writeSpendOutbox(path, [], lock);
      return 0;
    }
    for (const report of restored.slice(-SPEND_OUTBOX_MAX)) {
      if (!spendOutbox.some((queued) => queued.runId === report.runId)) spendOutbox.push(report);
    }
    return spendOutbox.length;
  });
}

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

function enqueueSpend(report: SpendReportBody): void {
  spendOutbox.push(report);
  // Shed the OLDEST on overflow. Both ends lose real spend, so the tiebreak is which loss
  // is more useful to keep: the newest reports describe what the fleet is doing now, which
  // is what the strip is read for, and the oldest are the likeliest to already be beyond
  // the window anyone is looking at.
  while (spendOutbox.length > SPEND_OUTBOX_MAX) {
    const dropped = spendOutbox.shift();
    console.warn(`[foreman] spend outbox full; dropped ${dropped?.role} usage undelivered`);
  }
  // Persisted BEFORE the first delivery attempt, which is the ordering the durability
  // depends on: a crash between the run finishing and the POST landing must still find the
  // report on disk.
  persistSpendOutbox({ kind: "append", report });
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
        spendOutbox.shift();
        persistSpendOutbox({ kind: "remove", runId: report.runId });
        spendFailures = 0;
        continue;
      }
      if (res.status >= 400 && res.status < 500) {
        // A 4xx will never succeed: the body did not validate, or names a role this daemon
        // does not have (a worker newer than the daemon it is talking to). Retrying it
        // forever would block every later report behind it, so it is dropped loudly - the
        // one failure mode where losing the row is better than stalling the queue. It
        // leaves the spool too, or the next restart would replay it into the same 4xx.
        spendOutbox.shift();
        persistSpendOutbox({ kind: "remove", runId: report.runId });
        console.warn(
          `[foreman] spend rejected as unprocessable: ${report.role} -> ${res.status}; dropped`,
        );
        continue;
      }
      // 5xx: the daemon is there but unhappy. Hold the report and back off.
      console.warn(`[foreman] spend not recorded: ${report.role} -> ${res.status}; will retry`);
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
   * Which provider the app's offline work spawns through, resolved by the DAEMON.
   *
   * Over a route rather than off the DB, because the Foreman worker is a separate process
   * and never touches it - and off the daemon rather than re-derived here, because the
   * setting is one ladder (config, then env, then default) and the daemon is the only side
   * that can see the config layer at all. A worker resolving it from its own environment
   * would answer differently from the panel that printed it.
   *
   * Falls back rather than throwing on anything it cannot read - an id this build does not
   * have, a daemon too old to serve the route. The runner is a preference; a review loop
   * that idled over one would be a worse failure than running on the default.
   */
  async llmRunner(): Promise<LlmRunnerId> {
    const status = await get<{ runner?: { id?: string } }>("/api/llm/status");
    const id = status?.runner?.id;
    return id && isLlmRunnerId(id) ? id : DEFAULT_LLM_RUNNER_ID;
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

  /** Hand the lease back on a clean shutdown, so a standby takes over at once. */
  async releaseLease(workerId: string): Promise<void> {
    await send("POST", "/api/foreman/heartbeat/release", { workerId }).catch(() => {});
  }

  sessions(): Promise<Session[]> {
    return get<Session[]>("/api/sessions");
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
    const r = await get<{ text: string }>("/api/foreman/instructions");
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
   * Retire one episode of the `prompted` trigger. Throws on failure, and the caller
   * must treat that as fatal to the episode: this write is what stops the trigger
   * re-firing, so proceeding to type after it failed is the double-push.
   */
  async markPromptedWrapup(
    sessionId: string,
    goal: string,
    opts?: { ask?: boolean },
  ): Promise<void> {
    const res = await send("POST", `/api/sessions/${enc(sessionId)}/queue/wrapup/prompted`, {
      goal,
      ...(opts?.ask ? { ask: true } : {}),
    });
    if (!res.ok) throw new Error(`markPromptedWrapup ${sessionId} -> ${res.status}`);
  }

  /** The full goal record - the verbatim prompt, which the card summary never carries. */
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
    const res = await send("POST", `/api/sessions/${enc(id)}/send`, { text, submit });
    if (!res.ok) throw new Error(`sendText ${id} -> ${res.status}`);
    return res.json();
  }

  /**
   * Select a row of the menu a child is showing. Throws on a refusal, which is the point:
   * the daemon refuses whenever it can't confirm the row against the live screen, and
   * `applyVerdict` turns that throw into "not answered" rather than a false byline.
   */
  async selectOption(id: string, option: { number: number; label: string }): Promise<unknown> {
    const res = await send("POST", `/api/sessions/${enc(id)}/select-option`, option);
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
    const res = await send("POST", `/api/sessions/${enc(id)}/submit-options`, { answers });
    if (!res.ok) throw new Error(`submitForm ${id} -> ${res.status}`);
    return res.json();
  }

  async resolveReview(reviewId: string, action: "answer", response: string): Promise<unknown> {
    const res = await send("POST", `/api/reviews/${enc(reviewId)}/resolve`, { action, response });
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

  async logGateReply(id: string, gate: GateRef, text: string): Promise<unknown> {
    const res = await send("POST", `/api/sessions/${enc(id)}/gate-reply`, {
      runId: gate.runId,
      step: gate.step,
      findingIds: gate.findingIds,
      text,
    });
    if (!res.ok) throw new Error(`logGateReply ${id} -> ${res.status}`);
    return res.json();
  }
}
