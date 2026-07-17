import { envVar } from "./config.ts";
import { unref } from "./util/timers.ts";
import {
  computeRuntimeMeta,
  computeSessionActivity,
  PASSIVE_TAIL_BYTES,
  readTailLines,
  resolveTranscriptPath,
} from "./transcript.ts";
import { findRolloutForSession, readRolloutMeta } from "./codex-rollout.ts";
import type { Registry } from "./registry.ts";
import type { Session } from "@shared/types.ts";

// Passive poller that keeps each live session's model / thinking level / context %
// current from the highest-authority *passive* source: the Claude transcript, or
// the Codex rollout. Claude's statusLine forwarder (when installed) posts directly
// to the daemon and outranks this - the registry won't let a passive read clobber
// a fresh statusLine reading. Every read here is a bounded tail read (plus, for
// Codex, a cached path lookup), so a tick is cheap and spawns no subprocesses.

/** How often to refresh runtime metadata (ms). */
const RUNTIME_META_POLL_MS = Number(envVar("RUNTIME_META_POLL_MS") ?? 4000);
/** How long to wait before re-scanning the filesystem for a Codex session that
 *  hasn't matched a rollout yet (a bounded directory walk, so not every tick). */
const CODEX_RESCAN_MS = 30_000;

/** Cached Codex rollout binding for a session (path null = looked, none yet). */
interface CodexBinding {
  cwd: string;
  path: string | null;
  triedAt: number;
}

export function startRuntimeMetaPoller(registry: Registry): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const codexBindings = new Map<string, CodexBinding>();

  const tick = (): void => {
    if (stopped) return;
    try {
      const live = registry.liveSessions();
      for (const s of live) {
        if (s.agent === "claude") {
          const path = resolveTranscriptPath(s);
          if (path) {
            // One bounded tail read feeds both axes: runtime metadata and the
            // hook-free idle/working signal that keeps a quiet or post-restart
            // session's queue moving.
            const lines = readTailLines(path, PASSIVE_TAIL_BYTES);
            registry.applyRuntimeMeta(s.id, computeRuntimeMeta(lines), "transcript");
            registry.applyPassiveActivity(s, computeSessionActivity(lines));
          }
        } else if (s.agent === "codex" && s.cwd) {
          const path = codexRolloutPath(codexBindings, s);
          if (path) registry.applyRuntimeMeta(s.id, readRolloutMeta(path), "codex-rollout");
        }
      }
      // Drop rollout bindings for sessions that have gone away.
      const liveIds = new Set(live.map((s) => s.id));
      for (const id of codexBindings.keys()) if (!liveIds.has(id)) codexBindings.delete(id);
    } catch (err) {
      console.error("[runtime-meta] poll failed:", err);
    }
    if (stopped) return;
    timer = unref(setTimeout(tick, RUNTIME_META_POLL_MS));
  };

  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/**
 * The rollout path for a Codex session, cached. A found path is reused until the
 * session's cwd changes; a miss is retried only every CODEX_RESCAN_MS so a
 * rollout-less session doesn't trigger a filesystem walk every tick.
 */
function codexRolloutPath(cache: Map<string, CodexBinding>, s: Session): string | null {
  const now = Date.now();
  const hit = cache.get(s.id);
  if (hit && hit.cwd === s.cwd && (hit.path !== null || now - hit.triedAt < CODEX_RESCAN_MS)) {
    return hit.path;
  }
  const path = findRolloutForSession(s);
  cache.set(s.id, { cwd: s.cwd!, path, triedAt: now });
  return path;
}
