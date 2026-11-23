import { envVar } from "./config.ts";
import { unref } from "./util/timers.ts";
import { allHarnesses, transcriptFor } from "./harness/index.ts";
import type { Registry } from "./registry.ts";
import type { Session } from "@shared/types.ts";

// Passive poller that keeps each live session's model / thinking level / context %
// current from the highest-authority *passive* source: whatever file its harness
// writes. Claude's statusLine forwarder (when installed) posts directly to the daemon
// and outranks this - the registry won't let a passive read clobber a fresh statusLine
// reading.
//
// The loop names no agent. It asks each session's harness for its `transcript`
// capability and takes whatever that one bounded read yields: runtime metadata always,
// plus the hook-free idle/working signal when the harness's file carries turns. A
// harness with no such file is skipped by declaration, and one that has to SEARCH for
// its file caches that behind `locate` - the poller holds no per-vendor state, which is
// what it used to be doing for Codex.

/** How often to refresh runtime metadata (ms). */
const RUNTIME_META_POLL_MS = Number(envVar("RUNTIME_META_POLL_MS") ?? 4000);

export function readRuntimeEffortBaseline(session: Session): string | null | undefined {
  try {
    const spec = transcriptFor(session);
    if (!spec) return undefined;
    const path = spec.locate(session);
    if (!path) return undefined;
    const meta = spec.passiveRead(path).meta;
    return meta ? meta.effortRevision : undefined;
  } catch {
    return undefined;
  }
}

/** One bounded native read, also used immediately before an autonomous resident wake. */
export function refreshRuntimeMeta(registry: Registry, session: Session): void {
  const spec = transcriptFor(session);
  if (!spec) return;
  const path = spec.locate(session);
  if (!path) return;
  const read = spec.passiveRead(path);
  registry.applyRuntimeMeta(session.id, read.meta, spec.metaSource);
  registry.applyPassiveActivity(session, read.activity);
  registry.applyPassivePermissionMode(session.id, read.permissionMode ?? null, read.permissionModeRevision ?? null);
  registry.applyPassiveUsage(session.id, read.usage ?? null);
  registry.applyPassiveRateLimits(read.rateLimits ?? null);
}

export function startRuntimeMetaPoller(registry: Registry): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = (): void => {
    if (stopped) return;
    try {
      const live = registry.liveSessions();
      for (const s of live) refreshRuntimeMeta(registry, s);
      // Let each harness drop whatever it cached for sessions that have gone away.
      const liveIds = new Set(live.map((s) => s.id));
      for (const h of allHarnesses()) h.transcript?.retain?.(liveIds);
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
