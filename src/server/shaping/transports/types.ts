import type { Shaper, ShapingRequest, ShapingTransportId } from "@shared/shaping.ts";
import type { CarriedTraceContext } from "../../agent-trace-context.ts";

/**
 * The launch's W3C trace context, `{ traceparent, tracestate? }`. It is handed to every call of
 * a run unchanged. It is not a credential and not a reference, so it is never redacted, and the
 * engine never logs or records it.
 */
export type ShapingTraceContext = CarriedTraceContext;

/** How a reply's redactor treats the text it is given. */
export interface RedactOptions {
  /**
   * The text is an identifier, such as a version: values the shaper inherited that are too short
   * to be redacted anywhere are left alone, so `v1.4.0` keeps its `0`. Values the operator named,
   * and every inherited value long enough to be redacted anywhere, are still removed.
   */
  identifier?: boolean;
}

/**
 * What a transport answers. A transport only moves bytes: `data` is the raw reply (a string the
 * engine parses as JSON, or an already-decoded value), and the engine owns validation, caps,
 * de-duplication, the outcome and the record. A transport never throws.
 *
 * Either kind may carry `redacted: true`: the transport removed a value it resolved for a
 * reference, or a credential it passed to a local process, from the data or from the reason.
 * The engine records it for the shaper.
 */
export type TransportReply =
  | {
    kind: "data";
    data: unknown;
    redacted?: boolean;
    /** Why the transport dropped an entry or a fact while redacting. The engine records them. */
    redactionNotes?: readonly string[];
    /**
     * Removes values the shaper was handed from text derived from this reply. The engine runs
     * every reason it builds from `data` through it (an `error` the reply states, its `notes`,
     * a validation failure) before recording one, because the shaper wrote that text too.
     * It runs a reported `version` through it too, as an identifier (see `RedactOptions`).
     * Absent means the transport handed the shaper nothing secret.
     */
    redact?: (text: string, options?: RedactOptions) => string;
    /**
     * Whether `text` holds a value the operator named, which `redact` would remove. The engine asks
     * it of each diagnostic it scrubs, so a credential removed there still marks the record
     * `redacted`. Absent means the transport named nothing.
     */
    holdsNamed?: (text: string) => boolean;
  }
  | { kind: "failed" | "timed_out" | "unavailable"; reason: string; redacted?: boolean };

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
  /** The launch's trace context, or null when it has none. Every call of a run gets the same one. */
  readonly trace: ShapingTraceContext | null;
  /**
   * The shaping run's work unit id, or null when the run has none. Opaque, not a credential and
   * not a reference, so it is never redacted. Every call of a run gets the same one.
   */
  readonly workUnitId: string | null;
}

export type ShaperOf<Id extends ShapingTransportId> = Shaper & { transport: Extract<Shaper["transport"], { type: Id }> };

export type ShapingTransport<Id extends ShapingTransportId = ShapingTransportId> = (
  request: ShapingRequest,
  shaper: ShaperOf<Id>,
  ctx: TransportContext,
) => Promise<TransportReply>;
