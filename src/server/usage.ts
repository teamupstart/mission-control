import { envVar } from "./config.ts";
import { commitUsageRead, priceUnpricedUsage, touchUsageSource, usageCursorFor } from "./db.ts";
import { allHarnesses, transcriptFor, usageFor } from "./harness/index.ts";
import type { Session } from "@shared/types.ts";
import type { Registry } from "./registry.ts";
import { unref } from "./util/timers.ts";

const USAGE_POLL_MS = Number(envVar("USAGE_POLL_MS") ?? 4000);
const USAGE_READ_BYTES = 1024 * 1024;
const FINAL_DRAIN_MS = 30_000;
const SOURCE_TOUCH_MS = 24 * 60 * 60 * 1000;

interface HeldSource {
  session: Session;
  path: string;
  lastSeen: number;
}

/** A cursor belongs to one proven conversation at one concrete rollout path. */
export function usageSourceKey(agent: Session["agent"], agentSessionId: string, path: string): string {
  return JSON.stringify([agent, agentSessionId, path]);
}

/**
 * Incrementally ingest request-level usage from every harness that declares the capability.
 *
 * The loop names no harness. Attribution requires the agent's proven session id; cwd and a
 * synthetic discovery id are never enough to attach dollars to a card. Recently exited
 * sources receive a short final drain so their last request is not lost between process exit
 * and the rollout writer's final flush.
 */
export function startUsagePoller(registry: Registry): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const held = new Map<string, HeldSource>();
  const lastTouched = new Map<string, number>();
  // A changed file generation, shortened file, or contradictory session header is not an
  // append-only source. Keep that exact conversation/path quarantined for this daemon
  // lifetime; changing either value produces a new key and is the only safe reset signal.
  const rejected = new Set<string>();
  let pricesRecovered = false;

  const tick = (): void => {
    if (stopped) return;
    const now = Date.now();
    let more = false;
    try {
      if (!pricesRecovered) {
        for (const harness of allHarnesses()) {
          if (!harness.usage) continue;
          for (const key of priceUnpricedUsage(harness.id, harness.usage.estimate)) {
            registry.applyDurableUsage(key);
          }
        }
        pricesRecovered = true;
      }
      for (const session of registry.liveSessions()) {
        const usage = usageFor(session);
        const transcript = transcriptFor(session);
        if (!usage || !transcript || !session.agentSessionId) continue;
        const path = transcript.locate(session);
        if (!path) continue;
        const sourceKey = usageSourceKey(session.agent, session.agentSessionId, path);
        // Cursor retention is age-based, so an observed but byte-idle source still needs
        // a heartbeat. Throttle in memory: SQLite receives at most one write per source/day,
        // not one UPDATE on every four-second usage poll.
        if (now - (lastTouched.get(sourceKey) ?? 0) >= SOURCE_TOUCH_MS) {
          touchUsageSource(sourceKey, now);
          lastTouched.set(sourceKey, now);
        }
        if (rejected.has(sourceKey)) continue;
        held.set(sourceKey, { session, path, lastSeen: now });
      }

      for (const [sourceKey, source] of held) {
        if (now - source.lastSeen > FINAL_DRAIN_MS) {
          held.delete(sourceKey);
          continue;
        }
        const usage = usageFor(source.session);
        if (!usage || !source.session.agentSessionId) continue;
        const cursor = usageCursorFor(sourceKey);
        const read = usage.read(source.path, cursor, USAGE_READ_BYTES);
        if (read.reset) {
          // The cursor belongs to a different file generation, or the source was shortened
          // between reads. Neither can be resumed at an old byte position safely.
          console.warn(`[usage] refusing rewritten source ${sourceKey} at ${source.path}`);
          rejected.add(sourceKey);
          held.delete(sourceKey);
          continue;
        }
        // Re-read the immutable rollout header on every pass. This catches a same-inode
        // truncate-and-regrow that device/inode identity alone cannot distinguish.
        if (read.sourceId === null) continue;
        if (read.sourceId !== source.session.agentSessionId) {
          console.warn(
            `[usage] refusing source ${sourceKey} with contradictory session ${read.sourceId}`,
          );
          rejected.add(sourceKey);
          held.delete(sourceKey);
          continue;
        }
        const events = read.events.map((event) => {
          const priced = usage.estimate(event);
          return {
            ...event,
            costUsd: priced?.costUsd ?? null,
            pricingVersion: priced?.pricingVersion ?? "",
          };
        });
        if (
          read.cursor.offset !== cursor.offset ||
          read.cursor.fileId !== cursor.fileId ||
          events.length > 0
        ) {
          commitUsageRead({
            sourceKey,
            noteKey: source.session.agentSessionId,
            sessionId: source.session.id,
            agent: source.session.agent,
            cursor: read.cursor,
            events,
            updatedAt: now,
          });
          lastTouched.set(sourceKey, now);
          if (events.length > 0) registry.applyDurableUsage(source.session.agentSessionId);
        }
        more ||= read.more;
      }
    } catch (err) {
      console.error("[usage] poll failed:", err);
    }
    if (!stopped) timer = unref(setTimeout(tick, more ? 0 : USAGE_POLL_MS));
  };

  tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
