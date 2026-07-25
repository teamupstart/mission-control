import type { RequestId } from "./protocol.ts";

// A JSON-RPC 2.0 client for one `codex app-server` connection.
//
// Transport-shaped and protocol-agnostic: it correlates our requests with their responses,
// hands server-to-client requests and notifications to a listener, and knows nothing about
// threads, turns or approvals. What each method MEANS is `../sdk.ts`'s business, which is
// what keeps the app-server vocabulary inside those two modules (C10).
//
// ## What it had to be measured against
//
// The server does NOT echo `jsonrpc` on anything it writes - responses arrive as
// `{"id":1,"result":{…}}` and notifications as `{"method":…,"params":…,"emittedAtMs":…}` -
// so a frame reader that required the member would have discarded every frame. We send it,
// because the request grammar is the one place the spec is unambiguous and the server
// accepts it.
//
// Server request ids live in their OWN counter, starting at 0, which is also a live id in
// our outbound sequence. So responses are matched only against ids WE issued, and a frame
// carrying both `id` and `method` is a request from the server rather than a reply to us -
// that discrimination, not the number, is what tells the two apart.

/**
 * One live connection's bytes, as the client needs them.
 *
 * The transport seam of C4, in the `PaneDeps` shape: a test hands in scripted frames and
 * drives the REAL client and the REAL adapter with no `codex` on the machine, and the only
 * module that spawns a subprocess is `../sdk-deps.ts`.
 */
export interface AppServerTransport {
  /** Write one frame. The transport appends the newline the server's framing requires. */
  send(frame: unknown): void;
  /**
   * Every frame the server wrote, in order, ending when the connection does.
   *
   * Parsed already: line framing and JSON are the transport's problem, because a
   * hand-built test transport has neither.
   */
  frames: AsyncIterable<unknown>;
  /** The subprocess this connection runs over, or null when there is no separate process. */
  pid: number | null;
  /** End the connection. Must make `frames` finish. */
  close(): Promise<void>;
}

/** What the adapter wants told to it, as the client pumps. */
export interface AppServerListener {
  /** A server-to-client request. The adapter answers it via `respond` / `respondError`. */
  request(method: string, id: RequestId, params: unknown): void;
  notification(method: string, params: unknown): void;
}

/** A JSON-RPC error the server returned, with its code preserved for the caller to read. */
export class AppServerError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data: unknown = null,
  ) {
    super(message);
    this.name = "AppServerError";
  }
}

interface Waiter {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  method: string;
}

export class AppServerClient {
  private nextId = 1;
  private readonly waiting = new Map<number, Waiter>();
  private closed = false;

  constructor(
    private readonly transport: AppServerTransport,
    private readonly listener: AppServerListener,
  ) {}

  get pid(): number | null {
    return this.transport.pid;
  }

  /**
   * Call one method and resolve with its result.
   *
   * Rejects on a JSON-RPC error and on the connection ending underneath it. Never resolves
   * on a timeout, because there is no honest timeout to pick: `turn/start` returns as soon
   * as the turn is accepted, but a `thread/start` that is waiting on an MCP server's
   * startup can take as long as that server does. A hung server ends this the way it ends
   * everything else - the frames stop, and every waiter is rejected together.
   */
  request<R>(method: string, params: unknown): Promise<R> {
    if (this.closed) return Promise.reject(new Error(`the ${method} connection has closed`));
    const id = this.nextId++;
    return new Promise<R>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (value: unknown) => void, reject, method });
      try {
        this.transport.send({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        this.waiting.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Fire-and-forget. Only used for frames the protocol defines as notifications. */
  notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.transport.send({ jsonrpc: "2.0", method, params });
  }

  /** Answer a server-to-client request. */
  respond(id: RequestId, result: unknown): void {
    if (this.closed) return;
    this.transport.send({ jsonrpc: "2.0", id, result });
  }

  respondError(id: RequestId, code: number, message: string): void {
    if (this.closed) return;
    this.transport.send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  /**
   * Read frames until the connection ends, then fail everything still waiting.
   *
   * The `finally` is the contract: a caller blocked on `request` when the subprocess dies
   * must reject rather than hang, because `SdkSpec.launch` rejects rather than degrades and
   * a launch that never settles is a dispatch that never fails either.
   */
  async pump(): Promise<void> {
    let failure: Error | null = null;
    try {
      for await (const frame of this.transport.frames) {
        this.consume(frame);
      }
    } catch (err) {
      failure = err instanceof Error ? err : new Error(String(err));
      throw failure;
    } finally {
      this.closed = true;
      const waiters = [...this.waiting.entries()];
      this.waiting.clear();
      for (const [, waiter] of waiters) {
        waiter.reject(
          failure ?? new Error(`the app-server connection ended during ${waiter.method}`),
        );
      }
    }
  }

  private consume(frame: unknown): void {
    if (!frame || typeof frame !== "object") return;
    const msg = frame as Record<string, unknown>;
    const method = typeof msg.method === "string" ? msg.method : null;
    if (method !== null && msg.id !== undefined && msg.id !== null) {
      this.listener.request(method, msg.id as RequestId, msg.params);
      return;
    }
    if (method !== null) {
      this.listener.notification(method, msg.params);
      return;
    }
    if (typeof msg.id !== "number") return;
    const waiter = this.waiting.get(msg.id);
    if (!waiter) return;
    this.waiting.delete(msg.id);
    if (msg.error) {
      const err = msg.error as Record<string, unknown>;
      waiter.reject(
        new AppServerError(
          typeof err.code === "number" ? err.code : 0,
          typeof err.message === "string" ? err.message : `${waiter.method} failed`,
          err.data ?? null,
        ),
      );
      return;
    }
    waiter.resolve(msg.result);
  }
}
