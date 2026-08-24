import { randomUUID } from "node:crypto";
import type { ForemanPlannerHealth, ForemanStatus, Session } from "@shared/types.ts";
import { ForemanConfigSchema } from "@shared/protocol.ts";
import type {
  ForemanConfig,
  ForemanConfigPatch,
  ForemanLeaseResult,
  ForemanPlannerControl,
  ForemanPlannerHealthReport,
} from "@shared/protocol.ts";
import { WRAPUP_MODES } from "@shared/queue.ts";
import { backlogTasks, reportBucket } from "@shared/session.ts";
import { readyBacklog } from "@shared/backlog.ts";
import {
  FOREMAN_MODEL_ROLES,
  FOREMAN_MODEL_SPECS,
  resolveForemanRunner,
  resolveForemanRunners,
  resolveForemanModels,
} from "@shared/foreman-models.ts";
import type { ForemanModelRole } from "@shared/foreman-models.ts";
import { isLlmRunnerId } from "@shared/llm.ts";
import { providerOwningModel } from "@shared/model.ts";
import type { LlmRunnerId, ResolvedLlmRunner } from "@shared/llm.ts";
import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import { getAppConfig, setAppConfig } from "../db.ts";
import { getBacklogPlan } from "../backlog.ts";
import { llmRunnerChoice } from "../llm/config.ts";
import { activeAgentCount } from "./backlog-machine.ts";
import { noteKeyFor } from "../registry.ts";
import type { Registry } from "../registry.ts";
import { foremanTriageAuthorized } from "./authorization.ts";
import { foremanInstructionsView } from "./instructions.ts";

// Foreman's operating config + derived live status. The config is the only
// durable state (in app_config); the worker itself runs as a separate process
// (`npm run foreman`) and reports it's alive via a heartbeat, while the queue
// depth and disposition counts are derived from the registry the daemon already
// holds - so the dashboard's status is honest without the worker pushing it.

const CONFIG_ENTRY = APP_CONFIG_ENTRIES.foreman;
const LEASE_ENTRY = APP_CONFIG_ENTRIES.foremanLease;

/**
 * How long a lease survives without a renewal - 3 missed renewals at the worker's
 * 30s timer. Deliberately NOT tied to how long a tick can take: renewal runs on a
 * background timer, not from the loop, so the lease means "this worker process is
 * alive", not "this worker recently finished a session".
 *
 * That decoupling is the whole point. The old heartbeat only advanced when the
 * loop did, and a loop tick can block on a `claude -p` for up to
 * 2 * REVIEW_TIMEOUT_MS = 240s - which is exactly why the old TTL had to be 300s.
 * A lease renewed only by loop progress would have to outlive 240s too, so a
 * "comfortably > one tick" value like 90s would expire MID-VERIFY, a standby would
 * acquire, and both workers would run - reintroducing the very double-send race
 * the lease exists to kill. A timer instead renews every 30s regardless of what
 * the loop is blocked on (a `claude -p` is async I/O, so the event loop is free
 * throughout), which keeps failover fast at 90s and survives any future timeout
 * change by construction.
 */
export const LEASE_TTL_MS = 90_000;

/** The durable lease, in app_config: who owns the sessions right now, and until when. */
interface ForemanLease {
  workerId: string;
  expiresAt: number;
}

/** Latest leader-owned projection of the worker's process-local planner circuit. */
let plannerHealthReport: ForemanPlannerHealthReport | null = null;
/** Operator retry signal. Process-local by design: it is control, not durable schedule state. */
let plannerRetryGeneration = 0;
/** The one worker allowed to spend the current retry generation. */
let plannerRetryClaim: { generation: number; workerId: string } | null = null;
/** Daemon-process identity for rebuilding the projection after a restart. */
const plannerProjectionEpoch = randomUUID();

/** Normalize retired and split settings before validating a stored config. */
function migrateStoredForemanConfig(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const config = value as Record<string, unknown>;

  let next = config;
  const migrate = (patch: Record<string, unknown>): void => {
    if (next === config) next = { ...config };
    Object.assign(next, patch);
  };

  // Before the controls were split, this one value governed both review comments and CI.
  // Preserve an operator's saved answer on upgrade. A genuinely fresh config has neither
  // key and still receives the schema's default-on values for both controls.
  if (
    !Object.prototype.hasOwnProperty.call(config, "trackCiFailures")
    && typeof config.trackReviewFeedback === "boolean"
  ) {
    migrate({ trackCiFailures: config.trackReviewFeedback });
  }

  // The API schema remains strict for new writes. Only a stored, retired wrap-up value is
  // normalized to Ask, which still lets an explicitly bound Workflow claim completion first.
  if (
    typeof config.wrapup === "string"
    && !WRAPUP_MODES.some((mode) => mode === config.wrapup)
  ) {
    migrate({ wrapup: "ask" });
  }

  return next;
}

/** The current config, with schema defaults applied over whatever was stored. */
export function getForemanConfig(): ForemanConfig {
  return ForemanConfigSchema.parse(
    migrateStoredForemanConfig(getAppConfig(CONFIG_ENTRY) ?? {}),
  );
}

/**
 * Merge a patch over the current config, persist, and return the result.
 *
 * Backlog launch defaults are keyed by harness, so merge that one nested map rather
 * than replacing it wholesale. The settings panel edits one agent at a time.
 */
export function setForemanConfig(patch: ForemanConfigPatch): ForemanConfig {
  const cur = getForemanConfig();
  const next = ForemanConfigSchema.parse({
    ...cur,
    ...patch,
    ...pinRoleProviders(cur, patch),
    backlogDefaultModel: { ...cur.backlogDefaultModel, ...(patch.backlogDefaultModel ?? {}) },
  });
  setAppConfig(CONFIG_ENTRY, next);
  return next;
}

/**
 * Record a provider on every role that carries a MODEL and has none of its own.
 *
 * "Pinning a model pins its provider" is the rule the whole page is documented on, and this
 * is where it is made durable for the `foreman` blob. A role with a model is by definition
 * not inheriting any more, so leaving its provider unset stores only half of a pair - and the
 * missing half is then supplied by whatever the ladder happens to resolve to later.
 *
 * Which provider gets recorded, in order:
 *
 *  - The one the model POSITIVELY belongs to (`providerOwningModel`). A saved
 *    `claude-opus-5` came from Claude whatever the ladder says today, so that is the honest
 *    answer and the one that keeps working across every later move.
 *  - Otherwise the provider in force BEFORE this write. A custom or newly released id belongs
 *    to nobody the catalog knows, so the best available answer is the one the operator was
 *    looking at when they picked it - which is also exactly what the panel records at the
 *    moment of pinning, so the two paths agree.
 *
 * This used to fire only when Foreman's own `runner` moved, and that left the reachable
 * sequence the pinning rule exists to prevent: leave Foreman's provider and the role's unset,
 * save a Claude model, then move the APP-WIDE radio. That writes the `llm` blob only, so no
 * Foreman write ever happened, the role went on inheriting, and the resolver guard replaced
 * the operator's model with the new provider's default. The guard is still the backstop for
 * everything no writer can reach - `MISSION_LLM_RUNNER` moving between restarts, a
 * hand-edited blob - but a model saved through this function is now recorded with the
 * provider it was chosen under, so the guard has nothing to refuse.
 *
 * It writes only within the `foreman` blob. Reaching across from `setLlmConfig` would be what
 * turns a per-key merge into a lost update, so it is not done - and is not needed, because
 * the provenance is captured when the model is saved rather than chased afterwards.
 *
 * An explicit provider always wins: a role that already has one, or whose provider this same
 * patch names, is left exactly as written.
 */
function pinRoleProviders(
  before: ForemanConfig,
  patch: ForemanConfigPatch,
): Partial<ForemanConfig> {
  // The provider in force before this write, which is what an unattributable model was
  // chosen under. Read off `before` deliberately: on a group-level change this is the
  // OUTGOING provider, so a role carrying a model keeps what it was running rather than
  // being carried over to the incoming one.
  const outgoing = resolveForemanRunner("review", { runner: before.runner }, llmRunnerChoice());
  const merged = { ...before, ...patch };
  const movesGroup = Object.prototype.hasOwnProperty.call(patch, "runner");
  const pins: Partial<ForemanConfig> = {};
  for (const role of FOREMAN_MODEL_ROLES) {
    const spec = FOREMAN_MODEL_SPECS[role];
    // Only a write that reaches this pair may pin it. Any other patch - `enabled`, `mode`,
    // the repo allowlist - leaves an inheriting role inheriting.
    const savesModel = Object.prototype.hasOwnProperty.call(patch, spec.configKey);
    if (!savesModel && !movesGroup) continue;
    const model = merged[spec.configKey]?.trim() ?? "";
    if (!model) continue;
    if (merged[spec.runnerKey]?.trim()) continue;
    // Which provider to record depends on WHY we are here, and the two answers differ for a
    // legacy role - one carrying a model saved by a build that recorded no provider with it.
    //
    // Saving the model: the provider it positively belongs to, else the one in force. The
    // operator just chose this id, so its own catalog is the best evidence of what it is.
    //
    // Moving the group provider: the OUTGOING provider, and never the model's owner. That
    // legacy role is running on the outgoing provider right now - with the resolver guard
    // substituting a default if its stored model belongs elsewhere - and pinning the model's
    // owner instead would silently move it to a provider it was not running on, which is a
    // behaviour change on a write that asked for something else entirely.
    pins[spec.runnerKey] = savesModel ? (providerOwningModel(model) ?? outgoing.id) : outgoing.id;
  }
  return pins;
}

/**
 * Which provider ONE Foreman role spawns through - role, then Foreman's group-level value,
 * then the app-wide ladder.
 *
 * Resolved per call, never captured at module load: the config is editable at runtime and a
 * value read once would need a daemon restart to take effect. Same rule `llmJobRunner` and
 * `inspectorModel` follow.
 */
export function foremanRoleRunner(
  role: ForemanModelRole,
  cfg: ForemanConfig = getForemanConfig(),
): ResolvedLlmRunner {
  return resolveForemanRunner(role, cfg, llmRunnerChoice());
}

/**
 * Foreman's group-level answer: its own `runner` when it has a readable one, else app-wide.
 *
 * What the panel prints as the value every un-overridden role inherits, and what the worker
 * falls back to. NOT the answer for any particular role - ask `foremanRoleRunner` for that.
 *
 * Resolved, not reduced to an id: a stored value this build cannot read - a provider a newer
 * version had, a hand-edited blob - inherits the app-wide answer AND is carried in `unknown`,
 * exactly as a role's own override is. Dropping that here made the group row the one control
 * on the page that could not say why the provider an operator saved is not the one in force;
 * it drew the inherited answer as Foreman's own choice, which is the failure every other
 * `unknown` line on this page exists to prevent.
 */
export function foremanGroupRunnerResolved(
  cfg: ForemanConfig = getForemanConfig(),
): ResolvedLlmRunner {
  const asked = cfg.runner?.trim() ?? "";
  if (!asked) return llmRunnerChoice();
  if (isLlmRunnerId(asked)) return { id: asked, source: "config", unknown: null };
  return { ...llmRunnerChoice(), unknown: asked };
}

/** The same answer as an id, for the callers that only ever wanted one. */
export function foremanGroupRunner(cfg: ForemanConfig = getForemanConfig()): LlmRunnerId {
  return foremanGroupRunnerResolved(cfg).id;
}

/**
 * Acquire or renew the worker lease - the mutual exclusion the sessions had none of.
 *
 * Before this, `npm run foreman` twice gave two loops, and the heartbeat was a
 * single module-global timestamp that could not even *detect* a second worker: it
 * just got beaten twice. For triage the damage was a duplicate answer; for a work
 * queue it would be a duplicated WORK INSTRUCTION typed into a live agent - which
 * can duplicate commits or re-run migrations.
 *
 * Compare-and-swap on (workerId, expiresAt): acquires when the lease is free or
 * expired, renews when it's already ours, and reports `leader: false` otherwise.
 * A non-leader is expected to idle and keep asking, not exit - that's what makes
 * takeover automatic when the leader crashes or is Ctrl-C'd.
 */
export function claimForemanLease(workerId: string, now = Date.now()): ForemanLeaseResult {
  const cur = getAppConfig(LEASE_ENTRY);
  const held = cur && cur.expiresAt > now;
  if (held && cur.workerId !== workerId) {
    return { leader: false, expiresAt: cur.expiresAt, holder: cur.workerId };
  }
  const next: ForemanLease = { workerId, expiresAt: now + LEASE_TTL_MS };
  setAppConfig(LEASE_ENTRY, next);
  return { leader: true, expiresAt: next.expiresAt, holder: workerId };
}

/** Release the lease if we hold it, so a standby takes over at once rather than
 *  waiting out the TTL. Best-effort: a crash just lets the lease expire. */
export function releaseForemanLease(workerId: string): void {
  const cur = getAppConfig(LEASE_ENTRY);
  if (cur?.workerId === workerId) {
    setAppConfig(LEASE_ENTRY, { workerId, expiresAt: 0 });
    if (plannerHealthReport?.workerId === workerId) plannerHealthReport = null;
  }
}

function liveLease(now: number): ForemanLease | null {
  const cur = getAppConfig(LEASE_ENTRY);
  return cur && cur.expiresAt > now ? cur : null;
}

/** True when some worker currently holds a live lease - i.e. a leader is alive. */
function leaderAlive(now: number): boolean {
  return liveLease(now) !== null;
}

/**
 * Accept a health projection only from the live leader. A standby may run the same code,
 * but it owns no scheduler state and must never overwrite what the active worker reports.
 */
export function recordForemanPlannerHealth(
  report: ForemanPlannerHealthReport,
  now = Date.now(),
): boolean {
  if (liveLease(now)?.workerId !== report.workerId) return false;
  plannerHealthReport = report;
  return true;
}

/** Mint one process-local retry signal for the worker's next pass. */
export function requestForemanPlannerRetry(): ForemanPlannerControl {
  plannerRetryGeneration = plannerRetryGeneration >= Number.MAX_SAFE_INTEGER
    ? 1
    : plannerRetryGeneration + 1;
  plannerRetryClaim = null;
  return foremanPlannerControl();
}

/** Let only the live leader consume one retry generation, once across worker restarts. */
export function claimForemanPlannerRetry(
  workerId: string,
  retryGeneration: number,
  now = Date.now(),
): boolean {
  if (liveLease(now)?.workerId !== workerId) return false;
  if (retryGeneration !== plannerRetryGeneration || retryGeneration === 0) return false;
  plannerRetryClaim ??= { generation: retryGeneration, workerId };
  return plannerRetryClaim.generation === retryGeneration
    && plannerRetryClaim.workerId === workerId;
}

/** The worker polls this beside config; no scheduler decision is made here. */
export function foremanPlannerControl(): ForemanPlannerControl {
  return {
    retryGeneration: plannerRetryGeneration,
    retryClaimedBy: plannerRetryClaim?.generation === plannerRetryGeneration
      ? plannerRetryClaim.workerId
      : null,
    projectionEpoch: plannerProjectionEpoch,
  };
}

/** Live status: config + whether the worker heartbeated + derived queue/counts. */
export function foremanStatus(registry: Registry, now = Date.now()): ForemanStatus {
  const cfg = getForemanConfig();
  const { sessions, tasks } = registry.snapshot();
  const queueDepth = countNeedsYou(sessions);

  // Scope counts to currently-live sessions: registry.listNotes() rehydrates
  // every note ever stored (unbounded, never evicted), so counting all of them
  // would let tallies and the "N drafts" badge accumulate lifetime history for
  // long-gone sessions while queueDepth stays live. Keying on the same noteKeyFor
  // the registry uses keeps the counts consistent with the live snapshot.
  const liveKeys = new Set(sessions.map(noteKeyFor));
  const counts = { answered: 0, escalated: 0, pending: 0, skipped: 0 };
  let lastActionAt: number | null = null;
  for (const n of registry.listNotes()) {
    if (!liveKeys.has(n.noteKey)) continue;
    counts[n.disposition]++;
    if (lastActionAt === null || n.updatedAt > lastActionAt) lastActionAt = n.updatedAt;
  }

  // The backlog readout. Derived here from the same `activeAgentCount` and
  // `readyBacklog` the scheduler decides with, rather than counted a second way, so the
  // popover's "3 / 5 agents" IS the ceiling being applied and its
  // ready/blocked/disabled split is the same one that governs what gets launched.
  // `ready` deliberately ignores the
  // repo allowlist - it answers "is the dependency graph holding this up?", and the
  // allowlist gets its own, separate refusal in the machine's log.
  const backlog = backlogTasks(tasks);
  const ready = readyBacklog(tasks, getBacklogPlan()).length;
  // Split off before `blocked` is derived, so the three numbers partition the backlog:
  // a parked item is neither ready nor blocked from scheduling, and folding it into
  // "blocked" would have the popover report a problem whose fix is really its switch.
  // The residual also includes an enabled card carrying a launch error. That card is
  // intentionally blocked from unattended scheduling until the operator retries it.
  const disabled = backlog.filter((t) => !t.enabled).length;

  // The same ladder the worker applies (`worker.ts`), resolved once here so the panel and
  // the process that spawns the calls cannot print different providers. An unset
  // `cfg.runner` is "the operator never chose HERE", which hands the question to the
  // app-wide resolution - not to a literal "claude", which would drop the env layer.
  //
  // Per ROLE now, because the four no longer share one answer. `runner` below stays the
  // group-level value - it is what an un-overridden role inherits, and it is the field the
  // panel's Inherit options are labelled with - and `roleRunners` carries the per-role axis
  // beside it, exactly as `LlmStatus` carries `jobRunners` beside `runner`.
  const groupRunner = foremanGroupRunnerResolved(cfg);
  const roleRunners = resolveForemanRunners(cfg, llmRunnerChoice());
  const models = resolveForemanModels(cfg, process.env, (role) => roleRunners[role].id);
  const leader = liveLease(now);
  const reported = leader && plannerHealthReport?.workerId === leader.workerId
    ? plannerHealthReport
    : null;
  const planner: ForemanPlannerHealth = reported
    ? {
        state: reported.state,
        runner: reported.runner,
        model: reported.model,
        failureCount: reported.failureCount,
        lastError: reported.lastError,
        nextRetryAt: reported.nextRetryAt,
      }
    : {
        state: "healthy",
        // The BACKLOG role's provider, not the group-level one: this line reports what the
        // dependency planner is about to spawn with, and the worker's circuit identity is
        // keyed on that same pair.
        runner: roleRunners.backlog.id,
        model: models.backlog.id,
        failureCount: 0,
        lastError: null,
        nextRetryAt: null,
      };

  return {
    enabled: cfg.enabled,
    mode: cfg.mode,
    // Source only. The exact document and ETag remain on the focused instructions route.
    instructionsSource: foremanInstructionsView().source,
    // "A leader heartbeated recently", not "someone beat recently": a standby
    // worker never acquires the lease, so it can't make this true on its own.
    running: leaderAlive(now),
    queueDepth,
    counts,
    lastActionAt,
    autopilot: {
      on: cfg.autoBacklog,
      active: activeAgentCount(sessions, tasks),
      max: cfg.maxSessions,
      ready,
      blocked: backlog.length - disabled - ready,
      disabled,
    },
    planner,
    // Resolved here, from the daemon's own env, because the browser has no `process`
    // and so cannot see the env layer at all - see `ForemanStatus.models`.
    models,
    runner: groupRunner.id,
    groupRunner,
    roleRunners,
  };
}

/**
 * How many drainable sessions currently sit in the shared `needs-you` bucket -
 * Foreman's inbound queue. Gated on the same triage authorization `tickTargets` selects
 * with: a session the worker will never process must not be counted, or the queueDepth
 * badge sits above zero forever.
 */
function countNeedsYou(sessions: Session[]): number {
  let n = 0;
  for (const s of sessions) {
    if (foremanTriageAuthorized(s, sessions) && reportBucket(s, sessions) === "needs-you") n++;
  }
  return n;
}
