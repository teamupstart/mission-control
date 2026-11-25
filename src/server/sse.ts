import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import type { ServerEvent } from "@shared/types.ts";
import { EVENT_STREAM_HEARTBEAT_MS } from "@shared/daemon-protocol.ts";
import type { Registry } from "./registry.ts";
import { unref } from "./util/timers.ts";
import { endedOnShutdown } from "./http-shutdown.ts";
import { taskTitlePresenter } from "./task-titles.ts";
import { REPO_INDEX_IDENTITY_UNKNOWN } from "@shared/repo-index.ts";
import { repoIndexIdentity } from "./repos.ts";

/**
 * The index identity for a snapshot. When the config cannot be read, the sentinel - never an
 * absent field: a window that missed `repo_index_changed` while disconnected learns of it only
 * here, and an omitted identity would let it keep a list for directories no longer indexed.
 */
function snapshotRepoIndexIdentity(): { repoIndexIdentity: string } {
  try {
    return { repoIndexIdentity: repoIndexIdentity() };
  } catch (error) {
    console.warn(
      `[repos] could not read the repository index for the event snapshot; windows will drop ` +
        `their repository lists: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { repoIndexIdentity: REPO_INDEX_IDENTITY_UNKNOWN };
  }
}

interface RegistryEventStream {
  readonly aborted: boolean;
  writeSSE(message: { data: string; event?: string }): Promise<unknown>;
  onAbort(callback: () => void): void;
}

/**
 * SSE endpoint. On connect it sends a full `snapshot`, then streams every
 * registry event as it happens. A periodic ping event keeps the
 * connection alive through proxies and lets us notice a dropped client.
 */
export function sseHandler(registry: Registry) {
  return (c: Context) =>
    streamSSE(c, endedOnShutdown((stream) => streamRegistryEvents(registry, stream)));
}

/**
 * Deliver one reconnect snapshot without a snapshot-to-subscription lost-update window.
 *
 * Subscription comes first. Events emitted while the snapshot is captured or its bytes are
 * being written wait in `queue`, then drain in order. A keyed upsert may therefore appear in
 * both the snapshot and the queue; that duplicate is harmless, while a missing remove is not.
 * Exported as a narrow stream seam so the initial-delivery ordering can be tested without an
 * HTTP server or timing sleeps.
 */
export async function streamRegistryEvents(
  registry: Registry,
  stream: RegistryEventStream,
): Promise<void> {
  const opened = performance.now();
  const voiceTimestamps = () => {
    const voiceServerTime = Date.now();
    // Express both bounds in the current wall-clock epoch even if it changed mid-stream.
    return { voiceServerTime, voiceStreamStartedAt: voiceServerTime - Math.round(performance.now() - opened) };
  };
  const queue: ServerEvent[] = [];
  let wake: (() => void) | null = null;
  let subscribed = true;
  const unsub = registry.subscribe((event) => {
    queue.push(event);
    wake?.();
  });
  const cleanup = (): void => {
    if (!subscribed) return;
    subscribed = false;
    unsub();
  };
  stream.onAbort(() => {
    cleanup();
    wake?.();
  });

  try {
    // Agent-written lines reach the browser with task ids shown as titles (`task-titles.ts`).
    // The registry's own objects are never touched; the presenter copies what it changes.
    const titled = taskTitlePresenter(registry);
    const snapshot = titled.snapshot(registry.snapshot());
    await stream.writeSSE({
      data: JSON.stringify({ type: "snapshot", ...snapshot, ...snapshotRepoIndexIdentity(),
        ...(snapshot.voice && voiceTimestamps()) } satisfies ServerEvent),
    });

    while (!stream.aborted) {
      if (queue.length === 0) {
        // Wait for an event or the heartbeat interval, whichever first.
        await new Promise<void>((resolve) => {
          wake = resolve;
          unref(setTimeout(resolve, EVENT_STREAM_HEARTBEAT_MS));
        });
        wake = null;
        if (queue.length === 0 && !stream.aborted) {
          await stream.writeSSE({ data: "", event: "ping" });
          continue;
        }
      }
      while (queue.length > 0 && !stream.aborted) {
        const event = titled.event(queue.shift()!);
        // Queued frames may have waited behind a snapshot write. Stamp them as they leave.
        const frame = event.type === "voice_card"
          ? { ...event, ...voiceTimestamps() }
          : event;
        await stream.writeSSE({ data: JSON.stringify(frame) });
      }
    }
  } finally {
    cleanup();
  }
}
