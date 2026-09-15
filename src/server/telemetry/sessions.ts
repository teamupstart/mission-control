/**
 * Phase 3's source owner: what was actually KNOWN about a session while it did work.
 *
 * The rule this whole module exists to hold is P2's: configuration is not evidence of
 * execution. A default in `app_config`, a model flag on a launch and a level the driver
 * accepted for the next turn are three different things, and none of them is "the model that
 * ran this turn". So the effective attribution here is frozen at OBSERVED boundaries - the
 * Registry's own reconciled values - and everything weaker travels with an explicit quality.
 *
 * Two shapes of hook, deliberately:
 *
 *  - An OBSERVER over the Registry's existing event stream (`attachSessionTelemetry`). Session
 *    existence, effective model and effort, turn boundaries and durable departure are all
 *    already reconciled and announced there, and reaching into `registry.ts` to add a second
 *    announcement of each would be a competing lifecycle for facts that have one owner.
 *    `session_remove` is used for departure precisely because `session_exit` is provisional -
 *    a rediscovery inside the linger cancels it - and inferring cleanup from `exited` is the
 *    thing the repository's boundaries forbid by name.
 *
 *  - EXPLICIT calls from owners that know something the stream cannot carry: the dispatcher's
 *    resolution of model and effort, the effort route's acceptance and its next-turn
 *    applicability, the supervisor's restore outcome, the ledger writers' canonical usage, and
 *    the kill intent that precedes an ending the session may well survive.
 *
 * Nothing in here can fail a business operation. `captureTelemetry` returns rather than throws,
 * every listener is wrapped, and collection changes discard in-memory observations so a later
 * opt-in cannot replay activity from before consent.
 */
import { randomUUID } from "node:crypto";
import {
  SYSTEM_ACTOR,
  type TelemetryActor,
  type TelemetryCaptureResult,
} from "@shared/telemetry.ts";
import {
  DISPATCH_FINISHED_EVENT,
  EFFORT_SELECTED_EVENT,
  SESSION_ENDED_EVENT,
  SESSION_KILL_REQUESTED_EVENT,
  SESSION_OPERATION_EVENT,
  SESSION_RESTORE_EVENT,
  SESSION_SEGMENT_EVENT,
  SESSION_STARTED_EVENT,
  TASK_OUTCOME_EVENT,
  TURN_FINISHED_EVENT,
  USAGE_RECORDED_EVENT,
} from "@shared/telemetry-catalog.ts";
import { EMULATOR_IDS, MULTIPLEXER_IDS } from "@shared/terminal.ts";
import type { EmulatorId, MultiplexerId } from "@shared/terminal.ts";
import type {
  AgentType,
  MetaSource,
  Session,
  SessionRuntime,
  Task,
  TaskKind,
  ThinkingLevel,
} from "@shared/types.ts";
import { AGENT_TYPES, SESSION_RUNTIMES, TASK_KINDS, THINKING_LEVELS } from "@shared/types.ts";
import { captureTelemetry } from "./capture.ts";
import { getTelemetryConfig } from "./config.ts";
import { registerTelemetrySource } from "./registration.ts";
import { attributionValue, type AttributionValue } from "./attribution.ts";

/** The source id every fact below deduplicates under. See `registerSessionTelemetrySource`. */
const SOURCE_KIND = "mission.session";

/**
 * How long a recorded launch intent waits for its session to appear.
 *
 * Generous, because `READY_TIMEOUT_MS` in the dispatcher is the real bound and a launch that
 * takes longer than this has already failed. An expired intent is swept rather than matched,
 * so a session discovered an hour later at the same checkout is `discovered` - which is what
 * it is.
 */
const LAUNCH_INTENT_TTL_MS = 5 * 60_000;

/** A signal is not proof of termination; older departures retain an unknown cause. */
const KILL_REQUEST_CORRELATION_MS = 60_000;

/**
 * A telemetry-visible effort value.
 *
 * `unknown` and `unsupported` are members of the type rather than a nullable hole, because
 * P2 requires they never be narrowed into a level: a harness with no effort knob and a
 * session nobody has read yet are both real answers, and `low` is neither of them.
 */
type EffortValue = ThinkingLevel | "unknown" | "unsupported";

/** How strongly the effort value above is known. */
type EffortQuality = "observed" | "launch_resolved" | "unknown" | "unsupported";

/** A task kind, or the explicit no-task state a personal session legitimately has. */
type TaskKindValue = AttributionValue<TaskKind> | "none";

interface LaunchIntent {
  cwd: string;
  taskId: string;
  recordedAt: number;
  /**
   * What the launch RESOLVED, so a harness that never reports an effective value still has
   * something with honest provenance behind it.
   *
   * P2's rule: retain the launch-resolved choice at its weaker quality rather than reporting
   * `unknown`. The two are different answers - "we chose medium and cannot confirm it ran"
   * against "we have no idea" - and only the first can be compared across launches.
   */
  model: string | null;
  effort: EffortValue | null;
}

interface SessionTrack {
  sessionId: string;
  /** A new observation interval on each adoption; counters cannot collide across restarts. */
  observationId: string;
  agent: AgentType;
  runtime: SessionRuntime;
  lastState: Session["state"];
  taskId: string | null;
  taskKind: TaskKindValue;
  repoCount: number;
  firstSeenAt: number;
  /** True when this installation did not witness the session's real start. */
  observationBounded: boolean;
  conversationId: string | null;
  segmentId: string | null;
  modelId: string;
  effort: EffortValue;
  quality: EffortQuality;
  metaSource: MetaSource | "none";
  effortPending: boolean;
  /** Attribution frozen when this working interval began, before later metadata changes. */
  activeTurn: {
    readonly startedAt: number;
    readonly effort: EffortValue;
    readonly quality: EffortQuality;
    readonly segmentId: string | null;
    readonly conversationId: string | null;
  } | null;
  turnSeq: number;
  /**
   * How many segments this session has opened.
   *
   * In the segment id, and load-bearing rather than cosmetic. The id was
   * `<session>:<turn>:<now>`, so two segments opening inside one millisecond - a conversation
   * binding and the first metadata read routinely land in the same tick - produced the SAME
   * dedupe identity, and the second was silently refused as a duplicate. Unlike every other
   * loss in this facility nothing counted it, because from the store's point of view nothing
   * was lost.
   */
  segmentSeq: number;
  killRequestedAt: number | null;
  handoff: boolean;
  ended: boolean;
}

/** Everything this module reads off a Registry, and nothing else. */
export interface SessionTelemetryHost {
  subscribe(fn: (e: { type: string } & Record<string, unknown>) => void): () => void;
  getTask(id: string): Task | undefined;
}

const tracks = new Map<string, SessionTrack>();
const launchIntents: LaunchIntent[] = [];
/** Tasks whose agent departed with no outcome recorded. See `noteTaskDeparture`. */
const departedTasks = new Set<string>();
/** Task attempts whose outcome has already been captured, keyed `${taskId}:${dispatchedAt}`. */
const settledAttempts = new Set<string>();
/**
 * Tasks that have reached a terminal row, by id alone.
 *
 * Kept beside `settledAttempts` rather than derived from it: the attempt key carries the
 * dispatch time, which a departing session does not know, so asking the attempt set "is this
 * task settled" would answer no for every task and report every ending as leaving work open.
 */
const settledTaskIds = new Set<string>();
/**
 * Dispatch attempt start times, so a duration is measured rather than guessed - and so the
 * attempt has a stable identity to deduplicate on.
 *
 * Retired by the next attempt for the same task rather than by the observation, for the reason
 * `observeDispatchFinished` gives. Bounded because it is otherwise one entry per task ever
 * dispatched in a daemon lifetime.
 */
const dispatchStarts = new Map<string, number>();

/** How many attempt markers are kept. Insertion-ordered, so the oldest goes first. */
const MAX_DISPATCH_STARTS = 512;

function rememberDispatchStart(taskId: string, at: number): void {
  // Deleted first so a re-dispatch moves to the back of the insertion order rather than
  // ageing out on the position its first attempt took.
  dispatchStarts.delete(taskId);
  dispatchStarts.set(taskId, at);
  while (dispatchStarts.size > MAX_DISPATCH_STARTS) {
    const oldest = dispatchStarts.keys().next();
    if (oldest.done) break;
    dispatchStarts.delete(oldest.value);
  }
}
/** Sessions the supervisor is bringing back, so their start is not reported as a new one. */
const restoringSessions = new Set<string>();

let shuttingDown = false;

// ---- owner-facing hooks ----

/**
 * A dispatch is about to launch into this checkout.
 *
 * Recorded BEFORE the spawn, because the session appears - and is announced - before the
 * dispatcher gets control back. An intent recorded afterwards would always lose that race and
 * every app-owned launch would be reported as a session somebody else started.
 */
export function noteDispatchLaunch(
  taskId: string,
  cwd: string,
  resolved: { model: string | null; effort: string | null } = { model: null, effort: null },
  now = Date.now(),
): void {
  sweepLaunchIntents(now);
  launchIntents.push({
    cwd,
    taskId,
    recordedAt: now,
    model: resolved.model,
    effort: resolved.effort === null ? null : effortLevelOf(resolved.effort),
  });
  if (!dispatchStarts.has(taskId)) rememberDispatchStart(taskId, now);
}

/** A dispatch attempt began. Paired with `observeDispatchFinished` to produce a duration. */
export function noteDispatchStarted(taskId: string, now = Date.now()): void {
  // Unconditional: this is what retires the previous attempt's marker, so a re-dispatch gets
  // its own identity instead of deduplicating against the attempt before it.
  rememberDispatchStart(taskId, now);
}

/** The supervisor is resuming this row. Its card is a continuation, not a new session. */
export function noteSessionRestoring(sessionId: string): void {
  restoringSessions.add(sessionId);
}

/**
 * This session is being handed to a real terminal, continuing the same conversation.
 *
 * Set after preflight and before stopping the driver, which can evict the SDK entry before
 * the terminal successor is ready. The returned undo clears the intent if stopping fails
 * and the driver survives. Once the driver leaves, this remains its departure reason even
 * if opening the successor fails; task settlement records that separate outcome.
 */
export function noteSessionHandoff(sessionId: string): () => void {
  const track = tracks.get(sessionId);
  if (track) {
    track.handoff = true;
    // Reaching a new, preflighted stop operation proves the earlier kill did not remove it.
    track.killRequestedAt = null;
  }
  return () => {
    if (track) track.handoff = false;
  };
}

/**
 * A task's agent departed before anything recorded an outcome.
 *
 * `TaskManager` settles such a task as `failed` while documenting that a clean exit cannot be
 * told from a crash. This marker is how that honesty survives into telemetry: the terminal row
 * that follows carries `completion_evidence: missing`, so nothing downstream can present it as
 * a measured correctness failure.
 */
export function noteTaskDeparture(taskId: string): void {
  departedTasks.add(taskId);
  // Bounded. The set is only ever read by the very next terminal transition for these ids, and
  // a task that never reaches one would otherwise hold a string for the daemon's lifetime.
  if (departedTasks.size > 512) {
    const first = departedTasks.values().next();
    if (!first.done) departedTasks.delete(first.value);
  }
}

/** Somebody asked a session to stop. An action, captured whether or not an ending follows. */
export function observeKillRequested(input: {
  session: Pick<Session, "id" | "agent" | "runtime">;
  taskId?: string | null;
  outcome: "accepted" | "refused";
  actor: TelemetryActor;
  operationId?: string;
  now?: number;
}): TelemetryCaptureResult {
  const now = input.now ?? Date.now();
  const track = tracks.get(input.session.id);
  if (track && input.outcome === "accepted" &&
    // An SDK rejection can restore the card before the accepted route continuation runs.
    (input.session.runtime !== "sdk" || track.lastState === "stopping" || track.lastState === "exited")) {
    track.killRequestedAt = now;
  }
  return captureTelemetry({
    event: SESSION_KILL_REQUESTED_EVENT,
    source: { kind: SOURCE_KIND, id: `kill:${input.session.id}:${now}`, revision: 1 },
    actor: input.actor,
    facts: {
      agent: agentOf(input.session.agent),
      runtime: runtimeOf(input.session.runtime),
      outcome: input.outcome,
      actor_basis: input.actor.basis,
    },
    refs: refsOf({
      session_id: input.session.id,
      task_id: input.taskId ?? track?.taskId ?? null,
      operation_id: input.operationId ?? null,
    }),
    now,
  });
}

/**
 * An effort change was requested and the driver answered.
 *
 * `applies` is the fact this event exists for. A harness whose driver defers leaves the running
 * turn on its old level, and the segment above is NOT moved here - only an observation moves a
 * segment, which is what stops an accepted request being exported as an executed one.
 */
export function observeEffortSelected(input: {
  session: Pick<Session, "id" | "agent" | "runtime" | "agentSessionId">;
  requested: string;
  outcome: "accepted" | "refused";
  applies: "current_turn" | "next_turn" | "unknown";
  actor: TelemetryActor;
  operationId?: string;
  now?: number;
}): TelemetryCaptureResult {
  const now = input.now ?? Date.now();
  const track = tracks.get(input.session.id);
  if (track) track.effortPending = input.outcome === "accepted" && input.applies === "next_turn";
  return captureTelemetry({
    event: EFFORT_SELECTED_EVENT,
    source: { kind: SOURCE_KIND, id: `effort:${input.session.id}:${now}:${input.requested}`, revision: 1 },
    actor: input.actor,
    facts: {
      requested_effort: requestedLevelOf(input.requested),
      outcome: input.outcome,
      applies: input.applies,
      agent: agentOf(input.session.agent),
      runtime: runtimeOf(input.session.runtime),
      actor_basis: input.actor.basis,
    },
    refs: refsOf({
      session_id: input.session.id,
      operation_id: input.operationId ?? null,
      conversation_id: input.session.agentSessionId,
    }),
    now,
  });
}

/** One conversation operation, captured where delivery is actually known. */
export function observeSessionOperation(input: {
  session: Pick<Session, "id" | "agent" | "runtime" | "agentSessionId">;
  operation: "send" | "queued" | "interrupt" | "cancel" | "question_response";
  outcome: "delivered" | "refused";
  actor: TelemetryActor;
  operationId?: string;
  /**
   * A DURABLE identity for this operation, when the owner has one.
   *
   * A queued turn does: its `pending_turns` row id survives a restart, so a delivery
   * re-announced by a resumed stream deduplicates instead of counting a second send. A
   * route-level operation does not - two sends in the same millisecond are two sends - and
   * falls back to the nonce below, which is what stops the second becoming an uncounted
   * `duplicate`.
   */
  identity?: string;
  now?: number;
}): TelemetryCaptureResult {
  const now = input.now ?? Date.now();
  const track = tracks.get(input.session.id);
  return captureTelemetry({
    event: SESSION_OPERATION_EVENT,
    source: {
      kind: SOURCE_KIND,
      id: input.identity
        ? `op:${input.operation}:${input.identity}`
        : `op:${input.session.id}:${input.operation}:${now}:${operationNonce()}`,
      revision: 1,
    },
    actor: input.actor,
    facts: {
      operation: input.operation,
      outcome: input.outcome,
      agent: agentOf(input.session.agent),
      runtime: runtimeOf(input.session.runtime),
      actor_basis: input.actor.basis,
    },
    refs: refsOf({
      session_id: input.session.id,
      operation_id: input.operationId ?? null,
      conversation_id: input.session.agentSessionId,
      segment_id: track?.segmentId ?? null,
    }),
    now,
  });
}

/** A dispatch attempt ended, carrying what it resolved and what became of it. */
export function observeDispatchFinished(input: {
  taskId: string;
  agent: AgentType;
  runtime: SessionRuntime;
  taskKind: TaskKind;
  resolvedModel: string | null;
  resolvedEffort: string | null;
  resolutionSource: "task" | "automation" | "kind" | "harness_default" | "harness";
  repoCount: number;
  outcome: "launched" | "failed" | "superseded";
  sessionId?: string | null;
  now?: number;
}): TelemetryCaptureResult {
  const now = input.now ?? Date.now();
  // NOT consumed. The attempt's start time IS half its dedupe identity, so deleting it here
  // made a second report of the same attempt - a second hook, a retried publication - compute
  // a fresh `now`, mint a DIFFERENT id, and be admitted as an extra dispatch rather than
  // refused as a duplicate. The marker is retired by the next `noteDispatchStarted` instead,
  // which every `dispatch()` call makes, so a genuine re-dispatch still gets its own identity.
  const startedAt = dispatchStarts.get(input.taskId) ?? now;
  if (input.outcome !== "launched") {
    for (let i = launchIntents.length - 1; i >= 0; i -= 1) {
      if (launchIntents[i]!.taskId === input.taskId) launchIntents.splice(i, 1);
    }
  }
  return captureTelemetry({
    event: DISPATCH_FINISHED_EVENT,
    source: { kind: "mission.dispatch", id: `${input.taskId}:${startedAt}`, revision: 1 },
    actor: SYSTEM_ACTOR,
    facts: {
      outcome: input.outcome,
      agent: agentOf(input.agent),
      runtime: runtimeOf(input.runtime),
      task_kind: dispatchKindOf(input.taskKind),
      resolved_model: input.resolvedModel ?? "",
      resolved_effort: effortLevelOf(input.resolvedEffort),
      resolution_source: input.resolutionSource,
      repo_count: boundedCount(input.repoCount),
      duration_ms: Math.max(0, now - startedAt),
    },
    refs: refsOf({ task_id: input.taskId, session_id: input.sessionId ?? null }),
    occurredAt: now,
    now,
  });
}

/** One managed session's restoration, as the supervisor observed it. */
export function observeSessionRestore(input: {
  sessionId: string;
  taskId: string | null;
  agent: AgentType;
  outcome: "succeeded" | "failed" | "interrupted";
  durationMs: number;
  turnInProgress: boolean;
  now?: number;
}): TelemetryCaptureResult {
  const now = input.now ?? Date.now();
  return captureTelemetry({
    event: SESSION_RESTORE_EVENT,
    source: { kind: SOURCE_KIND, id: `restore:${input.sessionId}:${now}`, revision: 1 },
    actor: SYSTEM_ACTOR,
    facts: {
      outcome: input.outcome,
      agent: agentOf(input.agent),
      duration_ms: Math.max(0, Math.round(input.durationMs)),
      turn_in_progress: input.turnInProgress,
    },
    refs: refsOf({ session_id: input.sessionId, task_id: input.taskId }),
    now,
  });
}

/**
 * One canonical usage row, projected exactly once.
 *
 * `identity` is the ledger's OWN uniqueness key for the row, handed in rather than
 * reconstructed: it is what makes a replay, a retried POST or a re-read rollout produce a
 * duplicate here instead of a second set of tokens. The alternative - hashing the numbers -
 * would silently merge two genuinely identical requests.
 */
export function observeUsageRecorded(input: {
  identity: string;
  usageOrigin: "authoring" | "automation";
  costBasis: "reported" | "api-equivalent" | "unpriced";
  modelId: string;
  input: number;
  output: number;
  reasoningOutput: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number | null;
  agent?: string;
  sessionId?: string | null;
  conversationId?: string | null;
  taskId?: string | null;
  occurredAt?: number;
  now?: number;
}): TelemetryCaptureResult {
  const now = input.now ?? Date.now();
  const track = input.sessionId ? tracks.get(input.sessionId) : undefined;
  return captureTelemetry({
    event: USAGE_RECORDED_EVENT,
    source: { kind: "mission.usage", id: input.identity, revision: 1 },
    actor: input.usageOrigin === "automation"
      ? { kind: "workflow", origin: "daemon", basis: "owner" }
      : { kind: "agent", origin: "daemon", basis: "owner" },
    facts: {
      usage_origin: input.usageOrigin,
      cost_basis: input.costUsd === null ? "unpriced" : input.costBasis,
      model_id: input.modelId,
      input: nonNegative(input.input),
      output: nonNegative(input.output),
      reasoning_output: nonNegative(input.reasoningOutput),
      cache_read: nonNegative(input.cacheRead),
      cache_write: nonNegative(input.cacheWrite),
      cost_usd: input.costUsd === null ? 0 : Math.max(0, input.costUsd),
    },
    // Not facts, because they are not dimensions of any instrument and a fact schema is the
    // contract a reducer reads. Context is the immutable, content-addressed place for
    // attribution that slices traces rather than metrics.
    context: input.agent ? { "mission.agent": input.agent } : {},
    refs: refsOf({
      session_id: input.sessionId ?? null,
      conversation_id: input.conversationId ?? null,
      segment_id: track?.segmentId ?? null,
      task_id: input.taskId ?? track?.taskId ?? null,
    }),
    occurredAt: input.occurredAt,
    now,
  });
}

/** Tell the observer the daemon is going down, so departures are attributed honestly. */
export function noteDaemonShuttingDown(): void {
  shuttingDown = true;
}

// ---- the observer ----

/**
 * Subscribe to the Registry and turn its reconciled stream into Phase 3's facts.
 *
 * Returns a detach function. Every listener is wrapped: the Registry documents that a
 * subscriber must not throw, and a telemetry defect taking the session event bus down would be
 * strictly worse than the missing chart it would have caused.
 */
export function attachSessionTelemetry(host: SessionTelemetryHost): () => void {
  const unsubscribe = host.subscribe((event) => {
    try {
      if (!getTelemetryConfig().enabled) return;
      if (event.type === "session_upsert") {
        onSession(host, event.session as Session);
      } else if (event.type === "session_remove") {
        onSessionRemoved(String(event.id));
      } else if (event.type === "task_upsert") {
        onTask(event.task as Task);
      }
    } catch (error) {
      console.warn("[telemetry] session observer could not record an event:", error);
    }
  });
  return () => {
    unsubscribe();
  };
}

/** Start a fresh observation window after collection consent changes. */
export function resetSessionTelemetryObservations(): void {
  tracks.clear();
  launchIntents.length = 0;
  departedTasks.clear();
  settledAttempts.clear();
  settledTaskIds.clear();
  dispatchStarts.clear();
  restoringSessions.clear();
}

/** Test-only: drop every tracked session so one fixture cannot leak into another's. */
export function resetSessionTelemetryForTesting(): void {
  resetSessionTelemetryObservations();
  shuttingDown = false;
}

function onSession(host: SessionTelemetryHost, session: Session): void {
  const existing = tracks.get(session.id);
  if (!existing) {
    startTrack(host, session);
    return;
  }
  // An evicted session lingers in `exited` before removal, and its projection keeps being
  // republished. Nothing after departure changes what was observed.
  if (existing.ended) return;
  if (session.state !== "stopping" && session.state !== "exited" &&
    (existing.lastState === "stopping" || existing.lastState === "exited")) {
    // A failed stop restored the card, or discovery cancelled provisional eviction.
    existing.killRequestedAt = null;
  }
  existing.lastState = session.state;
  observeSegment(existing, session);
  observeTurn(existing, session);
}

function startTrack(host: SessionTelemetryHost, session: Session): void {
  const now = Date.now();
  const intent = takeLaunchIntent(session, now);
  const restoring = restoringSessions.delete(session.id);
  // ONLY from the launch intent. A scan of live tasks for one naming this session was
  // considered and rejected: `Task.sessionId` means "currently executing on", so a scan would
  // bind a session to whichever task happened to name it - including one that has since moved
  // on - and a discovered session legitimately has no task at all.
  const taskId = intent?.taskId ?? null;
  const task = taskId ? host.getTask(taskId) : undefined;
  const origin = intent ? "dispatch" : restoring ? "restored" : "discovered";
  const track: SessionTrack = {
    sessionId: session.id,
    observationId: randomUUID(),
    agent: session.agent,
    runtime: session.runtime,
    lastState: session.state,
    taskId: taskId ?? null,
    taskKind: task ? taskKindOf(task.kind) : "none",
    repoCount: task ? boundedCount(1 + task.extraRepos.length) : 0,
    firstSeenAt: now,
    // A launch we performed is the ONE case where the start itself was witnessed. Everything
    // else began before this observation could, and saying so is what keeps it out of a
    // complete-from-start cohort rather than quietly distorting one.
    observationBounded: origin !== "dispatch",
    conversationId: session.agentSessionId,
    segmentId: null,
    modelId: "",
    effort: "unknown",
    quality: "unknown",
    metaSource: "none",
    effortPending: session.pendingEffort !== null,
    activeTurn: null,
    turnSeq: 0,
    segmentSeq: 0,
    killRequestedAt: null,
    handoff: false,
    ended: false,
  };
  // The launch's own resolution, held until the first OBSERVED reading replaces it. Weaker
  // provenance, stated as such - never promoted to `observed` by having been chosen.
  if (intent) {
    if (intent.model !== null) track.modelId = intent.model;
    if (intent.effort !== null) {
      track.effort = intent.effort;
      track.quality = intent.effort === "unknown" || intent.effort === "unsupported"
        ? intent.effort
        : "launch_resolved";
    }
  }
  tracks.set(session.id, track);
  captureTelemetry({
    event: SESSION_STARTED_EVENT,
    // ONE start per session id, forever. The durable dedupe table is what makes a daemon
    // restart that re-adopts the same proven session an observation-continuity update rather
    // than a second adoption - no in-memory guard could survive the restart it has to survive.
    source: { kind: SOURCE_KIND, id: `start:${session.id}`, revision: 1 },
    actor: SYSTEM_ACTOR,
    facts: {
      origin,
      start_observation:
        origin === "dispatch" ? "observed_start" : origin === "restored" ? "after_restart" : "first_observed",
      agent: agentOf(session.agent),
      runtime: runtimeOf(session.runtime),
      task_kind: track.taskKind,
      ...terminalContext(session),
      repo_count: track.repoCount,
    },
    refs: refsOf({
      session_id: session.id,
      task_id: track.taskId,
      conversation_id: session.agentSessionId,
    }),
    now,
  });
  // The first segment, opened from whatever the session already reports. A discovered session
  // usually reports nothing yet, which is `unknown` - never `low`.
  observeSegment(track, session, "first_observation");
  observeTurn(track, session);
}

/**
 * Open a new execution segment when, and only when, something MEANINGFUL changed.
 *
 * A repeated identical observation refreshes the track's freshness and opens nothing: a segment
 * per metadata poll would make "turns per segment" a fact about the poller's interval. A
 * conversation rotation always ends the previous segment, because a model value must never
 * migrate across a context clear into a conversation it was never observed on.
 */
function observeSegment(
  track: SessionTrack,
  session: Session,
  forced: "first_observation" | null = null,
): void {
  const observedModel = session.meta?.modelId ?? "";
  const metaSource = session.meta?.source ?? "none";
  const observedEffort = effortOf(session);
  // An observation always wins. Until there is one, the launch-resolved values seeded above
  // stand, at their own quality - which is the difference between a comparable figure and a
  // hole in the data for every harness that does not report effective effort.
  const hasEffortObservation = session.meta?.thinkingLevel != null || session.meta?.nativeEffort != null;
  const modelId = observedModel !== "" ? observedModel : track.modelId;
  const effort = hasEffortObservation ? observedEffort : track.effort;
  const quality = hasEffortObservation
    ? qualityOf(session, observedEffort)
    : track.quality;
  const rotated = session.agentSessionId !== null && session.agentSessionId !== track.conversationId;
  const reason = forced
    ?? (rotated
      ? "conversation_rotation"
      : modelId !== track.modelId && modelId !== ""
        ? "model_changed"
        : effort !== track.effort
          ? "effort_changed"
          : null);
  track.effortPending = session.pendingEffort !== null;
  if (session.agentSessionId !== null) track.conversationId = session.agentSessionId;
  if (reason === null) {
    // Same values, possibly a better source. Freshness moves; the segment does not.
    track.metaSource = metaSource;
    track.quality = quality;
    return;
  }
  const now = Date.now();
  track.segmentSeq += 1;
  track.segmentId = `${track.sessionId}:${track.observationId}:${track.segmentSeq}`;
  track.modelId = modelId;
  track.effort = effort;
  track.quality = quality;
  track.metaSource = metaSource;
  captureTelemetry({
    event: SESSION_SEGMENT_EVENT,
    source: { kind: SOURCE_KIND, id: `segment:${track.segmentId}`, revision: 1 },
    actor: SYSTEM_ACTOR,
    facts: {
      agent: agentOf(track.agent),
      runtime: runtimeOf(track.runtime),
      model_id: modelId,
      effort,
      quality,
      meta_source: metaSource,
      reason,
      effort_pending: track.effortPending,
    },
    refs: refsOf({
      session_id: track.sessionId,
      task_id: track.taskId,
      conversation_id: track.conversationId,
      segment_id: track.segmentId,
    }),
    now,
  });
}

/**
 * A turn began or finished, measured as OBSERVED EXECUTION rather than wall time.
 *
 * `working` is the Registry's reconciled answer to "is the agent running right now", so the
 * interval between entering and leaving it is the only duration this daemon can honestly
 * claim. A gap it cannot vouch for - a restart, a discovery miss - sets `observation_bounded`
 * so a histogram never mixes a measurement with a lower bound.
 */
function observeTurn(track: SessionTrack, session: Session): void {
  const working = session.state === "working";
  if (working) {
    track.activeTurn ??= {
      startedAt: Date.now(),
      effort: track.effort,
      quality: track.quality,
      segmentId: track.segmentId,
      conversationId: track.conversationId,
    };
    return;
  }
  const turn = track.activeTurn;
  if (turn === null) return;
  track.activeTurn = null;
  track.turnSeq += 1;
  const now = Date.now();
  const outcome =
    session.state === "awaiting_input" || session.state === "awaiting_review"
      ? "blocked"
      : session.state === "exited" || session.state === "stopping"
        ? "ended"
        : "completed";
  captureTelemetry({
    event: TURN_FINISHED_EVENT,
    source: {
      kind: SOURCE_KIND,
      id: `turn:${track.sessionId}:${track.observationId}:${track.turnSeq}`,
      revision: 1,
    },
    actor: SYSTEM_ACTOR,
    facts: {
      agent: agentOf(track.agent),
      runtime: runtimeOf(track.runtime),
      // The segment's effort as it was when the turn STARTED. A selection accepted for the
      // next turn does not reach back into this one, which is the timeline P2 spells out.
      effort: turn.effort,
      quality: turn.quality,
      outcome,
      duration_ms: Math.max(0, now - turn.startedAt),
      observation_bounded: track.observationBounded,
    },
    refs: refsOf({
      session_id: track.sessionId,
      task_id: track.taskId,
      conversation_id: turn.conversationId,
      segment_id: turn.segmentId,
    }),
    now,
  });
}

/**
 * The session's row is gone. This is the durable boundary and the only one used.
 *
 * `session_exit` fires first and is provisional - a rediscovery inside the linger cancels it -
 * so counting departures there would report a session as ended and then go on observing it.
 */
function onSessionRemoved(sessionId: string): void {
  const track = tracks.get(sessionId);
  if (!track || track.ended) return;
  track.ended = true;
  tracks.delete(sessionId);
  const now = Date.now();
  const reason = shuttingDown
    ? "shutdown"
    : track.killRequestedAt !== null && now - track.killRequestedAt <= KILL_REQUEST_CORRELATION_MS
      ? "kill_requested"
      : track.handoff
        ? "handoff"
        // NOT narrowed further. A terminal that stopped answering, a crash and a clean exit
        // are indistinguishable from here, and inventing a reason is exactly what P2 forbids.
        : "unknown";
  captureTelemetry({
    event: SESSION_ENDED_EVENT,
    source: { kind: SOURCE_KIND, id: `end:${sessionId}`, revision: 1 },
    actor: SYSTEM_ACTOR,
    facts: {
      reason,
      agent: agentOf(track.agent),
      runtime: runtimeOf(track.runtime),
      task_kind: track.taskKind,
      // An observed relationship, not a verdict. Whether the WORK finished is
      // `mission.task.outcome`, which has its own owner and its own evidence field.
      ended_while_work_open: track.taskId !== null && !settledTaskIds.has(track.taskId),
      observed_ms: Math.max(0, now - track.firstSeenAt),
      observation_bounded: track.observationBounded,
    },
    refs: refsOf({
      session_id: sessionId,
      task_id: track.taskId,
      conversation_id: track.conversationId,
    }),
    now,
  });
}

/** A task moved. Capture exactly one outcome per dispatch attempt that reaches a terminal row. */
function onTask(task: Task): void {
  if (task.status !== "done" && task.status !== "failed" && task.status !== "cancelled") {
    settledTaskIds.delete(task.id);
    return;
  }
  const key = attemptKey(task.id, task.dispatchedAt ?? null);
  if (settledAttempts.has(key)) return;
  settledAttempts.add(key);
  settledTaskIds.add(task.id);
  if (settledTaskIds.size > 1024) {
    const oldest = settledTaskIds.values().next();
    if (!oldest.done) settledTaskIds.delete(oldest.value);
  }
  if (settledAttempts.size > 1024) {
    const first = settledAttempts.values().next();
    if (!first.done) settledAttempts.delete(first.value);
  }
  const departed = departedTasks.delete(task.id);
  const now = Date.now();
  const startedAt = task.dispatchedAt ?? null;
  captureTelemetry({
    event: TASK_OUTCOME_EVENT,
    source: { kind: "mission.task", id: key, revision: 1 },
    actor: SYSTEM_ACTOR,
    facts: {
      task_kind: dispatchKindOf(task.kind),
      status: task.status,
      // The three-way answer, kept three-way on purpose. `failed` with `missing` is an
      // unknown ending, and a dashboard that rendered it as a measured correctness failure
      // would be claiming evidence this daemon explicitly says it does not have.
      completion_evidence: departed
        ? "missing"
        : task.status === "done" && (task.outcome ?? "").trim().length > 0
          ? "recorded"
          : task.status === "cancelled"
            ? "recorded"
            : "unknown",
      repo_count: boundedCount(1 + task.extraRepos.length),
      duration_ms: startedAt === null ? 0 : Math.max(0, now - startedAt),
      observation_bounded: startedAt === null,
    },
    refs: refsOf({ task_id: task.id, session_id: task.sessionId }),
    now,
  });
}

// ---- source registration ----

/**
 * What this source can and cannot rebuild after a crash, stated rather than assumed.
 *
 * The unrecoverable list is the important half. A post-restart scan of a live `Session` reports
 * the model it is running NOW; nothing durable records the model it was running an hour ago, so
 * a segment missed during a gap is gone. P1 requires every source say so at its registration
 * site precisely so the next phase does not build a cohort on the assumption it was recovered.
 */
const SESSION_SOURCE = {
  id: SOURCE_KIND,
  recovers: [
    "A live session's existence, on the next Registry sweep after a restart. Its dedupe " +
      "identity is the session id, so a re-adoption updates continuity rather than counting " +
      "a second session.",
    "A task's terminal outcome, from the durable task row, on its next publication.",
  ],
  unrecoverable: [
    "Execution segments during a gap. SessionMeta reports what is running now, and nothing " +
      "durable records what was running an hour ago.",
    "Turn boundaries during a gap. A turn that started before a restart and finished after it " +
      "is reported as bounded rather than measured.",
    "A session that started AND ended while capture was not running.",
  ],
  maxScanPerTick: 0,
} as const;

const DISPATCH_SOURCE = {
  id: "mission.dispatch",
  recovers: [],
  unrecoverable: [
    "A dispatch whose resolution was never captured. The resolved model and effort are " +
      "computed in memory at launch and are not persisted anywhere a scan could read.",
  ],
  maxScanPerTick: 0,
} as const;

const TASK_SOURCE = {
  id: "mission.task",
  recovers: ["A terminal task row, on its next publication after a restart."],
  unrecoverable: [
    "Which intermediate statuses a task passed through while capture was not running.",
  ],
  maxScanPerTick: 0,
} as const;

const USAGE_SOURCE = {
  id: "mission.usage",
  recovers: [],
  unrecoverable: [
    "Ledger rows committed while capture was off. They are immutable economic history and are " +
      "deliberately not re-read into telemetry, because a later opt-in may not widen the " +
      "audience of facts captured before it.",
  ],
  maxScanPerTick: 0,
} as const;

/** Register Phase 3's sources. Module constants, so a second call is idempotent. */
export function registerSessionTelemetrySource(): void {
  registerTelemetrySource(SESSION_SOURCE);
  registerTelemetrySource(DISPATCH_SOURCE);
  registerTelemetrySource(TASK_SOURCE);
  registerTelemetrySource(USAGE_SOURCE);
}

// ---- helpers ----

function attemptKey(taskId: string, dispatchedAt?: number | null): string {
  return `${taskId}:${dispatchedAt ?? 0}`;
}

function takeLaunchIntent(session: Session, now: number): LaunchIntent | null {
  sweepLaunchIntents(now);
  const cwd = session.cwd;
  if (!cwd) return null;
  const index = launchIntents.findIndex((intent) => intent.cwd === cwd);
  if (index < 0) return null;
  const [intent] = launchIntents.splice(index, 1);
  return intent ?? null;
}

function sweepLaunchIntents(now: number): void {
  for (let i = launchIntents.length - 1; i >= 0; i -= 1) {
    if (now - launchIntents[i]!.recordedAt > LAUNCH_INTENT_TTL_MS) launchIntents.splice(i, 1);
  }
}

/**
 * Multiplexer and emulator, INDEPENDENTLY.
 *
 * One nests inside the other, so a session in tmux inside Ghostty has both and neither implies
 * the other. `not_applicable` is the SDK runtime, which has no pane at all; `none` is a
 * terminal with no backend of that axis holding it. Neither is `unknown`, which means we
 * could not tell - and pane ids, tty, pid, names and titles are never read here at all.
 */
function terminalContext(session: Session): {
  multiplexer: MultiplexerId | "none" | "unknown" | "not_applicable";
  emulator: EmulatorId | "none" | "unknown" | "not_applicable";
} {
  if (session.runtime === "sdk") {
    return { multiplexer: "not_applicable", emulator: "not_applicable" };
  }
  const handles = session.terminals ?? [];
  const mux = handles.find((h) => h.kind === "multiplexer");
  const emulator = handles.find((h) => h.kind === "emulator");
  return {
    multiplexer: mux
      ? MULTIPLEXER_IDS.includes(mux.backend) ? mux.backend : "unknown"
      : handles.length === 0 ? "unknown" : "none",
    emulator: emulator
      ? EMULATOR_IDS.includes(emulator.backend) ? emulator.backend : "unknown"
      : handles.length === 0 ? "unknown" : "none",
  };
}

/** Normalized effort, or the two values that must never be narrowed into a level. */
function effortOf(session: Session): EffortValue {
  const level = session.meta?.thinkingLevel;
  if (level) return attributionValue(level, THINKING_LEVELS);
  // A harness with no effort parameter at all reports neither a level nor a native value, and
  // reporting that as `unknown` would put "this model has no effort knob" in the same bucket
  // as "we have not read it yet". The native value's presence is what separates them.
  return session.meta?.nativeEffort ? "unsupported" : "unknown";
}

function qualityOf(session: Session, effort: EffortValue): EffortQuality {
  if (effort === "unsupported") return "unsupported";
  if (effort === "unknown") return "unknown";
  return session.meta?.source ? "observed" : "launch_resolved";
}

/**
 * Narrow a value this build may not know to one its schema admits.
 *
 * A strict fact schema REFUSES an unrecognised value, which is right - it is what stops an
 * internal object being spread into an envelope - but it means a session from a newer peer
 * would have its whole fact refused rather than recorded with one coarse field. These three
 * fall back to the vocabulary's own sentinel instead, so the rest of the observation survives.
 */
function agentOf(agent: string): AttributionValue<AgentType> {
  return attributionValue(agent, AGENT_TYPES);
}

function runtimeOf(runtime: string): AttributionValue<SessionRuntime> {
  return attributionValue(runtime, SESSION_RUNTIMES);
}

function taskKindOf(kind: string): TaskKindValue {
  return attributionValue(kind, TASK_KINDS);
}

/** The dispatcher's own kind, which always exists - a dispatch is a task by construction. */
function dispatchKindOf(kind: string): AttributionValue<TaskKind> {
  return attributionValue(kind, TASK_KINDS);
}

/** A requested level. Refused rather than coerced would lose the whole selection record. */
function requestedLevelOf(value: string): EffortValue {
  return attributionValue(value, THINKING_LEVELS);
}

/** No resolved level is unknown; only explicit capability evidence means unsupported. */
function effortLevelOf(value: string | null): EffortValue {
  return attributionValue(value, THINKING_LEVELS);
}

function boundedCount(value: number): number {
  return Math.max(0, Math.min(64, Math.round(value)));
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

/** Drop the refs with nothing behind them. An empty ref is a link that resolves to nothing. */
function refsOf(refs: Record<string, string | null | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(refs)) {
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }
  return out;
}

/**
 * A per-invocation nonce for operations that are genuinely distinct every time.
 *
 * Two sends in the same millisecond are two sends. Keying their dedupe identity on the clock
 * alone would make the second a `duplicate` - and unlike every other loss in this facility,
 * nothing would count it, because from the store's point of view nothing was lost.
 */
let operationCounter = 0;
function operationNonce(): string {
  operationCounter = (operationCounter + 1) % Number.MAX_SAFE_INTEGER;
  return String(operationCounter);
}
