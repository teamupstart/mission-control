import type { ForemanStatus, Session } from "@shared/types.ts";
import { ForemanConfigSchema } from "@shared/protocol.ts";
import type { ForemanConfig, ForemanConfigPatch } from "@shared/protocol.ts";
import { reportBucket } from "@shared/session.ts";
import { getAppConfig, setAppConfig } from "../db.ts";
import { noteKeyFor } from "../registry.ts";
import type { Registry } from "../registry.ts";

// Foreman's operating config + derived live status. The config is the only
// durable state (in app_config); the worker itself runs as a separate process
// (`npm run foreman`) and reports it's alive via a heartbeat, while the queue
// depth and disposition counts are derived from the registry the daemon already
// holds - so the dashboard's status is honest without the worker pushing it.

const CONFIG_KEY = "foreman";
/**
 * A worker heartbeat older than this means "not running". The worker beats once per
 * session and then blocks on `claude -p` for the whole review, so this must comfortably
 * exceed the longest gap between two beats. Under `triage: 'on'` that gap is the cheap
 * router AND the full review, run SERIALLY on a route-up: TRIAGE_TIMEOUT_MS +
 * 2 * REVIEW_TIMEOUT_MS = 30s + 240s = 270s against this 300s TTL. (`shadow` runs the two
 * concurrently, so it stays at 240s.) Both budgets are env-tunable
 * (`FOREMAN_TRIAGE_TIMEOUT_MS`, `FOREMAN_REVIEW_TIMEOUT_MS`) - raise either far and this
 * TTL has to move with it, or the dashboard reads "not running" mid-drain.
 */
const HEARTBEAT_TTL_MS = 300_000;

let lastHeartbeatAt = 0;

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

/** The worker calls this each loop tick so the dashboard can show "running". */
export function recordForemanHeartbeat(now = Date.now()): void {
  lastHeartbeatAt = now;
}

/** Live status: config + whether the worker heartbeated + derived queue/counts. */
export function foremanStatus(registry: Registry, now = Date.now()): ForemanStatus {
  const cfg = getForemanConfig();
  const sessions = registry.snapshot().sessions;
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

  return {
    enabled: cfg.enabled,
    mode: cfg.mode,
    running: now - lastHeartbeatAt < HEARTBEAT_TTL_MS,
    queueDepth,
    counts,
    lastActionAt,
  };
}

/**
 * How many claude sessions currently sit in the shared `needs-you` bucket -
 * Foreman's drainable inbound queue. Non-claude (e.g. codex) sessions are
 * excluded because the worker's needsYouQueue only processes agent === "claude",
 * so counting them would leave a queueDepth badge that can never reach zero.
 */
function countNeedsYou(sessions: Session[]): number {
  let n = 0;
  for (const s of sessions) {
    if (s.agent === "claude" && reportBucket(s, sessions) === "needs-you") n++;
  }
  return n;
}
