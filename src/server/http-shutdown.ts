import type { SSEStreamingApi } from "hono/streaming";

/**
 * Stop the daemon's HTTP server without letting an open-ended request hold shutdown forever.
 *
 * `server.close()` stops listening and closes idle keep-alive sockets, but its callback waits for
 * every connection still carrying a response. Some responses never end on their own: the
 * dashboard's `/events` stream, a transcript stream, an MCP review long-poll. With the dashboard
 * open, the daemon's shutdown therefore stopped at this line indefinitely. The packaged shell holds
 * every quit until the daemon exits (`src/main/quit-drain.ts`), so that wait became the whole
 * quit: about 27 seconds, ending in a SIGKILL that skipped the database close.
 *
 * So shutdown happens in two steps:
 *  1. Every open-ended request registered in `OpenEndedRequests` is told to finish now. A stream
 *     ends its body, and a long-poll answers the way its own timeout would. These are ordinary
 *     completed responses, so `close` sees them leave at once.
 *  2. Any other request still in flight gets `graceMs` to finish. Only one that outlives the grace
 *     (a stalled client, or a stream nobody registered) has its socket destroyed. The grace sits
 *     well inside the shell's 25-second utility deadline.
 */
export interface ClosableHttpServer {
  close(callback: (error?: Error) => void): unknown;
  closeIdleConnections(): void;
  closeAllConnections(): void;
}

export const HTTP_CLOSE_GRACE_MS = 5_000;
const IDLE_SWEEP_MS = 25;

/** Requests whose response ends only when told to. Each is ended once, when shutdown begins. */
export class OpenEndedRequests {
  private readonly ends = new Set<() => void>();
  private ending = false;

  /**
   * Register `end` for the life of one request and return its release, which the request calls
   * when it finishes on its own. A request that starts after shutdown began is ended at once.
   */
  add(end: () => void): () => void {
    if (this.ending) {
      end();
      return () => {};
    }
    this.ends.add(end);
    return () => {
      this.ends.delete(end);
    };
  }

  endAll(): void {
    this.ending = true;
    for (const end of Array.from(this.ends)) {
      this.ends.delete(end);
      try {
        end();
      } catch {
        // One request failing to end must not keep the others open; the grace still bounds it.
      }
    }
  }
}

/** The daemon's single registry, shared by every route that holds a response open. */
export const openEndedRequests = new OpenEndedRequests();

/** Wrap a `streamSSE` body so the daemon's shutdown ends its stream instead of waiting on it. */
export function endedOnShutdown(
  run: (stream: SSEStreamingApi) => Promise<void>,
  openEnded: OpenEndedRequests = openEndedRequests,
): (stream: SSEStreamingApi) => Promise<void> {
  return async (stream) => {
    const release = openEnded.add(() => stream.abort());
    try {
      await run(stream);
    } finally {
      release();
    }
  };
}

export function closeHttpServer(
  server: ClosableHttpServer,
  { graceMs = HTTP_CLOSE_GRACE_MS, openEnded = openEndedRequests }: { graceMs?: number; openEnded?: OpenEndedRequests } = {},
): Promise<{ forced: boolean }> {
  return new Promise((resolve, reject) => {
    let forced = false;
    const force = setTimeout(() => {
      forced = true;
      server.closeAllConnections();
    }, graceMs);
    // `close` closes idle keep-alive sockets only once, when it is called. A response that
    // finishes afterwards - an ended stream, a request that used its grace - leaves its socket
    // idle but open, and `close` would wait on it until the grace ran out.
    const sweep = setInterval(() => server.closeIdleConnections(), IDLE_SWEEP_MS);
    // Stop accepting first, so nothing new can register after the open-ended requests are ended.
    server.close((error) => {
      clearTimeout(force);
      clearInterval(sweep);
      if (error) reject(error);
      else resolve({ forced });
    });
    openEnded.endAll();
  });
}
