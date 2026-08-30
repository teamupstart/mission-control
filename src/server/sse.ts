import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import type { ServerEvent } from "@shared/types.ts";
import type { Registry } from "./registry.ts";
import { unref } from "./util/timers.ts";

const HEARTBEAT_MS = 15000;

interface RegistryEventStream {
  readonly aborted: boolean;
  writeSSE(message: { data: string; event?: string }): Promise<unknown>;
  onAbort(callback: () => void): void;
}

/**
 * SSE endpoint. On connect it sends a full `snapshot`, then streams every
 * registry event as it happens. A periodic comment heartbeat keeps the
 * connection alive through proxies and lets us notice a dropped client.
 */
export function sseHandler(registry: Registry) {
  return (c: Context) =>
    streamSSE(c, (stream) => streamRegistryEvents(registry, stream));
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
    const snapshot = registry.snapshot();
    await stream.writeSSE({
      data: JSON.stringify({ type: "snapshot", ...snapshot } satisfies ServerEvent),
    });

    while (!stream.aborted) {
      if (queue.length === 0) {
        // Wait for an event or the heartbeat interval, whichever first.
        await new Promise<void>((resolve) => {
          wake = resolve;
          unref(setTimeout(resolve, HEARTBEAT_MS));
        });
        wake = null;
        if (queue.length === 0 && !stream.aborted) {
          await stream.writeSSE({ data: "", event: "ping" });
          continue;
        }
      }
      while (queue.length > 0 && !stream.aborted) {
        const event = queue.shift()!;
        await stream.writeSSE({ data: JSON.stringify(event) });
      }
    }
  } finally {
    cleanup();
  }
}
