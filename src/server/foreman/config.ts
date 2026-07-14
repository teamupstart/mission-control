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
 * A worker heartbeat older than this means "not running". It must comfortably
 * exceed one review-with-retry (2 * REVIEW_TIMEOUT_MS) since the worker beats
 * once per session and then blocks on a `claude -p` for the whole review.
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
