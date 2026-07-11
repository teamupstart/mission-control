import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import type { ServerEvent } from "@shared/types.ts";
import type { Registry } from "./registry.ts";
import { unref } from "./util/timers.ts";

const HEARTBEAT_MS = 15000;

/**
 * SSE endpoint. On connect it sends a full `snapshot`, then streams every
 * registry event as it happens. A periodic comment heartbeat keeps the
 * connection alive through proxies and lets us notice a dropped client.
 */
export function sseHandler(registry: Registry) {
  return (c: Context) =>
    streamSSE(c, async (stream) => {
      const queue: ServerEvent[] = [];
      let wake: (() => void) | null = null;

      const snap = registry.snapshot();
      await stream.writeSSE({
        data: JSON.stringify({ type: "snapshot", ...snap } satisfies ServerEvent),
      });

      const unsub = registry.subscribe((e) => {
        queue.push(e);
        wake?.();
      });
      stream.onAbort(() => {
        unsub();
        wake?.();
      });

      try {
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
            const e = queue.shift()!;
            await stream.writeSSE({ data: JSON.stringify(e) });
          }
        }
      } finally {
        unsub();
      }
    });
}
