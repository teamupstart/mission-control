import { envVar } from "./config.ts";
import { commitUsageRead, usageCursorFor } from "./db.ts";
import { transcriptFor, usageFor } from "./harness/index.ts";
import type { Session } from "@shared/types.ts";
import type { Registry } from "./registry.ts";
import { unref } from "./util/timers.ts";

const USAGE_POLL_MS = Number(envVar("USAGE_POLL_MS") ?? 4000);
const USAGE_READ_BYTES = 1024 * 1024;
const FINAL_DRAIN_MS = 30_000;

interface HeldSource {
  session: Session;
  path: string;
  lastSeen: number;
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

  const tick = (): void => {
    if (stopped) return;
    const now = Date.now();
    let more = false;
    try {
      for (const session of registry.liveSessions()) {
        const usage = usageFor(session);
        const transcript = transcriptFor(session);
        if (!usage || !transcript || !session.agentSessionId) continue;
        const path = transcript.locate(session);
        if (!path) continue;
        held.set(`${session.agent}:${session.agentSessionId}`, { session, path, lastSeen: now });
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
          // The source key contains the proven conversation id. A different conversation
          // naturally gets a different key; shortening this one is an in-place rewrite and
          // cannot be made safe by guessing where its economic history starts.
          console.warn(`[usage] refusing shortened source ${sourceKey} at ${source.path}`);
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
        if (read.cursor.offset !== cursor.offset || events.length > 0) {
          commitUsageRead({
            sourceKey,
            noteKey: source.session.agentSessionId,
            sessionId: source.session.id,
            agent: source.session.agent,
            cursor: read.cursor,
            events,
            updatedAt: now,
          });
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
