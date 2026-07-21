import type { ForemanStatus, Session } from "@shared/types.ts";
import { ForemanConfigSchema } from "@shared/protocol.ts";
import type { ForemanConfig, ForemanConfigPatch, ForemanLeaseResult } from "@shared/protocol.ts";
import { backlogTasks, reportBucket } from "@shared/session.ts";
import { capabilitiesFor } from "@shared/harness-capabilities.ts";
import { readyBacklog } from "@shared/backlog.ts";
import { resolveForemanModels } from "@shared/foreman-models.ts";
import { getAppConfig, setAppConfig } from "../db.ts";
import { getBacklogPlan } from "../backlog.ts";
import { llmRunnerChoice } from "../llm/config.ts";
import { activeAgentCount } from "./backlog-machine.ts";
import { noteKeyFor } from "../registry.ts";
import type { Registry } from "../registry.ts";

// Foreman's operating config + derived live status. The config is the only
// durable state (in app_config); the worker itself runs as a separate process
// (`npm run foreman`) and reports it's alive via a heartbeat, while the queue
// depth and disposition counts are derived from the registry the daemon already
// holds - so the dashboard's status is honest without the worker pushing it.

const CONFIG_KEY = "foreman";
const LEASE_KEY = "foreman.lease";

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

/** The current config, with schema defaults applied over whatever was stored. */
export function getForemanConfig(): ForemanConfig {
  return ForemanConfigSchema.parse(getAppConfig<unknown>(CONFIG_KEY) ?? {});
}

/** Merge a patch over the current config, persist, and return the result. */
export function setForemanConfig(patch: ForemanConfigPatch): ForemanConfig {
  const next = ForemanConfigSchema.parse({ ...getForemanConfig(), ...patch });
  setAppConfig(CONFIG_KEY, next);
  return next;
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
  const cur = getAppConfig<ForemanLease>(LEASE_KEY);
  const held = cur && cur.expiresAt > now;
  if (held && cur.workerId !== workerId) {
    return { leader: false, expiresAt: cur.expiresAt, holder: cur.workerId };
  }
  const next: ForemanLease = { workerId, expiresAt: now + LEASE_TTL_MS };
  setAppConfig(LEASE_KEY, next);
  return { leader: true, expiresAt: next.expiresAt, holder: workerId };
}

/** Release the lease if we hold it, so a standby takes over at once rather than
 *  waiting out the TTL. Best-effort: a crash just lets the lease expire. */
export function releaseForemanLease(workerId: string): void {
  const cur = getAppConfig<ForemanLease>(LEASE_KEY);
  if (cur?.workerId === workerId) setAppConfig(LEASE_KEY, { workerId, expiresAt: 0 });
}

/** True when some worker currently holds a live lease - i.e. a leader is alive. */
function leaderAlive(now: number): boolean {
  const cur = getAppConfig<ForemanLease>(LEASE_KEY);
  return !!cur && cur.expiresAt > now;
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
  // popover's "3 / 5 agents" IS the ceiling being applied and its ready/blocked split
  // is the same one that governs what gets launched. `ready` deliberately ignores the
  // repo allowlist - it answers "is the dependency graph holding this up?", and the
  // allowlist gets its own, separate refusal in the machine's log.
  const backlog = backlogTasks(tasks);
  const ready = readyBacklog(tasks, getBacklogPlan()).length;

  // The same ladder the worker applies (`worker.ts`), resolved once here so the panel and
  // the process that spawns the calls cannot print different providers. An unset
  // `cfg.runner` is "the operator never chose HERE", which hands the question to the
  // app-wide resolution - not to a literal "claude", which would drop the env layer.
  const runner = cfg.runner ?? llmRunnerChoice().id;

  return {
    enabled: cfg.enabled,
    mode: cfg.mode,
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
      blocked: backlog.length - ready,
    },
    // Resolved here, from the daemon's own env, because the browser has no `process`
    // and so cannot see the env layer at all - see `ForemanStatus.models`.
    models: resolveForemanModels(cfg, process.env, runner),
    runner,
  };
}

/**
 * How many drainable sessions currently sit in the shared `needs-you` bucket -
 * Foreman's inbound queue. Gated on the same `workQueue` capability `tickTargets`
 * selects with: a session the worker will never process must not be counted, or the
 * queueDepth badge sits above zero forever.
 */
function countNeedsYou(sessions: Session[]): number {
  let n = 0;
  for (const s of sessions) {
    if (capabilitiesFor(s.agent).workQueue && reportBucket(s, sessions) === "needs-you") n++;
  }
  return n;
}
