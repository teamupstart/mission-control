import type { Shaper, ShapingRequest, ShapingTransportId } from "@shared/shaping.ts";

/**
 * What a transport answers. A transport only moves bytes: `data` is the raw reply (a string the
 * engine parses as JSON, or an already-decoded value), and the engine owns validation, caps,
 * de-duplication, the outcome and the record. A transport never throws.
 */
export type TransportReply =
  | { kind: "data"; data: unknown }
  | { kind: "failed" | "timed_out" | "unavailable"; reason: string };

/** State that lives for one shaping run, so a transport can reuse one connection across calls. */
export interface ShapingRunScope {
  /** Values a transport keeps for the rest of the run, keyed by the transport. */
  readonly shared: Map<string, unknown>;
  /** Run `cleanup` once the run has ended, whatever happened. Failures are logged, never thrown. */
  defer(cleanup: () => void | Promise<void>): void;
}

export interface TransportContext {
  /** Epoch milliseconds when the whole step's deadline passes. */
  readonly deadline: number;
  /** This call's own budget: the shaper's timeout or the time left in the step, whichever is smaller. */
  readonly timeoutMs: number;
  /** Aborted when the step's deadline passes or the task is cancelled. Stop and answer `timed_out`. */
  readonly signal: AbortSignal;
  readonly scope: ShapingRunScope;
  /** The folder a discovered shaper was found in, which its `./` command resolves against. Null when registered. */
  readonly root: string | null;
}

export type ShaperOf<Id extends ShapingTransportId> = Shaper & { transport: Extract<Shaper["transport"], { type: Id }> };

export type ShapingTransport<Id extends ShapingTransportId = ShapingTransportId> = (
  request: ShapingRequest,
  shaper: ShaperOf<Id>,
  ctx: TransportContext,
) => Promise<TransportReply>;
