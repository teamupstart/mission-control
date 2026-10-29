import { agentOtelDestinationProblem, type AgentOtelRelayStats, type AgentOtelSignal } from "@shared/agent-telemetry.ts";

// The tee: every OTLP export the daemon receives on `/v1/{logs,metrics,traces}` is answered
// locally exactly as before, and a copy of its raw bytes is queued for the upstream the
// effective policy names.
//
// Fail-open in every direction. Enqueueing never throws and never waits; a full queue drops
// the copy; an upstream that is slow, down, redirecting or refusing costs that one copy and a
// counter. Nothing the upstream does can change the local response, and nothing here logs a
// body or a header - the only recorded error is an HTTP status or an error class.

export interface RelayUpstream {
  url: string;
  headers: Record<string, string>;
}

export interface OtlpForwarderDeps {
  fetch: typeof fetch;
  now: () => number;
  /** Resolved at SEND time, so a settings change applies to what is still queued. */
  upstream: (signal: AgentOtelSignal) => RelayUpstream | null;
  maxQueue?: number;
  maxQueuedBytes?: number;
  maxConcurrent?: number;
  timeoutMs?: number;
}

interface Item {
  signal: AgentOtelSignal;
  body: Uint8Array;
  contentType: string | null;
  contentEncoding: string | null;
}

/** The largest single export the relay accepts, at the route as well as here. */
export const MAX_OTLP_BODY_BYTES = 16 * 1024 * 1024;

export class OtlpForwarder {
  private readonly queue: Item[] = [];
  private queuedBytes = 0;
  private active = 0;
  private readonly idle: Array<() => void> = [];
  private readonly stats: AgentOtelRelayStats = {
    forwarded: 0,
    failed: 0,
    dropped: 0,
    lastError: null,
    lastForwardedAt: null,
  };
  private readonly maxQueue: number;
  private readonly maxQueuedBytes: number;
  private readonly maxConcurrent: number;
  private readonly timeoutMs: number;

  constructor(private readonly deps: OtlpForwarderDeps) {
    this.maxQueue = deps.maxQueue ?? 64;
    this.maxQueuedBytes = deps.maxQueuedBytes ?? 64 * 1024 * 1024;
    this.maxConcurrent = deps.maxConcurrent ?? 4;
    this.timeoutMs = deps.timeoutMs ?? 10_000;
  }

  /**
   * Queue a copy. `skipped` when the policy forwards nothing for this signal (checked now, so
   * an off feature holds no bytes), `dropped` when the queue is full.
   */
  enqueue(
    signal: AgentOtelSignal,
    body: Uint8Array,
    contentType: string | null,
    contentEncoding: string | null = null,
  ): "queued" | "skipped" | "dropped" {
    try {
      if (this.deps.upstream(signal) === null) return "skipped";
    } catch {
      return "skipped";
    }
    if (
      body.byteLength > MAX_OTLP_BODY_BYTES ||
      this.queue.length >= this.maxQueue ||
      this.queuedBytes + body.byteLength > this.maxQueuedBytes
    ) {
      this.stats.dropped += 1;
      return "dropped";
    }
    this.queue.push({ signal, body, contentType, contentEncoding });
    this.queuedBytes += body.byteLength;
    this.pump();
    return "queued";
  }

  snapshot(): AgentOtelRelayStats {
    return { ...this.stats };
  }

  /** Resolves once nothing is queued or in flight. For tests and orderly shutdown. */
  drain(): Promise<void> {
    if (this.active === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idle.push(resolve));
  }

  private pump(): void {
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const item = this.queue.shift()!;
      this.queuedBytes -= item.body.byteLength;
      this.active += 1;
      void this.send(item).finally(() => {
        this.active -= 1;
        this.pump();
        if (this.active === 0 && this.queue.length === 0) {
          for (const resolve of this.idle.splice(0)) resolve();
        }
      });
    }
  }

  private async send(item: Item): Promise<void> {
    let upstream: RelayUpstream | null;
    try {
      upstream = this.deps.upstream(item.signal);
    } catch {
      upstream = null;
    }
    if (upstream === null) return;
    // Policy already applied this rule; checked again where the bytes leave, so no future
    // upstream source can reach `fetch` with a remote plaintext URL.
    if (agentOtelDestinationProblem(upstream.url, Object.keys(upstream.headers).length > 0) !== null) {
      this.fail("insecure destination");
      return;
    }
    const headers: Record<string, string> = { ...upstream.headers };
    if (item.contentType) headers["content-type"] = item.contentType;
    if (item.contentEncoding) headers["content-encoding"] = item.contentEncoding;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const res = await this.deps.fetch(upstream.url, {
        method: "POST",
        headers,
        body: item.body as Uint8Array<ArrayBuffer>,
        // A redirect is not authorization to hand a credential to another destination.
        redirect: "manual",
        signal: controller.signal,
      });
      // The body is never read beyond releasing it.
      await res.body?.cancel().catch(() => {});
      if (res.status >= 200 && res.status < 300) {
        this.stats.forwarded += 1;
        this.stats.lastForwardedAt = this.deps.now();
      } else {
        this.fail(`HTTP ${res.status}`);
      }
    } catch (error) {
      this.fail(controller.signal.aborted ? "timeout" : errorClass(error));
    } finally {
      clearTimeout(timer);
    }
  }

  private fail(reason: string): void {
    this.stats.failed += 1;
    this.stats.lastError = reason.slice(0, 80);
  }
}

/** An error's class or code, never its message: a message can quote a URL or a header. */
function errorClass(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  if (typeof cause?.code === "string") return cause.code;
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === "string" ? name : "error";
}
