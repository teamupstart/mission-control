import type { ForemanStatus, Session } from "@shared/types.ts";
import { ForemanConfigSchema } from "@shared/protocol.ts";
import type { ForemanConfig, ForemanConfigPatch } from "@shared/protocol.ts";
import { reportBucket } from "@shared/session.ts";
import { getAppConfig, setAppConfig } from "../db.ts";
import type { Registry } from "../registry.ts";

// Foreman's operating config + derived live status. The config is the only
// durable state (in app_config); the worker itself runs as a separate process
// (`npm run foreman`) and reports it's alive via a heartbeat, while the queue
// depth and disposition counts are derived from the registry the daemon already
// holds - so the dashboard's status is honest without the worker pushing it.

const CONFIG_KEY = "foreman";
/** A worker heartbeat older than this means "not running". */
const HEARTBEAT_TTL_MS = 15_000;

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

  const counts = { answered: 0, escalated: 0, pending: 0, skipped: 0 };
  let lastActionAt: number | null = null;
  for (const n of registry.listNotes()) {
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

/** How many live sessions currently sit in the shared `needs-you` bucket. */
function countNeedsYou(sessions: Session[]): number {
  let n = 0;
  for (const s of sessions) if (reportBucket(s, sessions) === "needs-you") n++;
  return n;
}
