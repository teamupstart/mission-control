import { withAgentTraceContext } from "../../agent-trace-context.ts";
import type { ShapingTraceContext } from "./types.ts";

/**
 * What every shaper call carries besides its request: the launch's W3C trace context and the
 * shaping run's work unit id. Each has one spelling per carrier, and a configured header or
 * variable of the same name, compared without case, is always removed first, with or without a
 * value to send, so only the launch's own values ever leave. Neither is a credential or a
 * reference: nothing here is resolved, redacted or recorded.
 */

/** The work unit id as an environment variable, for a `command` shaper and an MCP server started locally. */
export const WORK_UNIT_ID_ENV = "WORK_UNIT_ID";
/** The work unit id as a request header, for `http` and streamable-HTTP `mcp` calls. */
export const WORK_UNIT_ID_HEADER = "x-work-unit-id";
/** The work unit id inside an MCP `tools/call`'s `params._meta`. */
export const WORK_UNIT_ID_META = "work_unit_id";

/** The bound on a work unit id. An id outside it is treated as absent rather than sent. */
const WORK_UNIT_ID_MAX_CHARS = 256;

/**
 * The work unit id a run may send, or null. It is opaque, so any visible ASCII text within the
 * bound is accepted as it is. Anything else, an empty string, a space, a control character or a
 * line break that would split a header, is absent: a malformed id costs the shaper one
 * correlation, never the call.
 */
export function carriedWorkUnitId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= WORK_UNIT_ID_MAX_CHARS && /^[\x21-\x7e]+$/.test(value)
    ? value
    : null;
}

/** A variable a carrier owns, in any case: `TRACEPARENT`, `TRACESTATE` or `WORK_UNIT_ID`. */
export function carriedEnvName(name: string): boolean {
  return /^(?:trace(?:parent|state)|work_unit_id)$/i.test(name);
}

/** A header a carrier owns, in any case: `traceparent`, `tracestate` or `x-work-unit-id`. */
export function carriedHeaderName(name: string): boolean {
  return /^(?:trace(?:parent|state)|x-work-unit-id)$/i.test(name);
}

/**
 * `env` without any variable a carrier owns, in any case, then with the launch's own: the trace
 * context through the one carrier agents use, and `WORK_UNIT_ID` when the run has one.
 */
export function withCarriedEnv(env: NodeJS.ProcessEnv, trace: ShapingTraceContext | null, workUnitId: string | null): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) if (!carriedEnvName(name)) next[name] = value;
  const traced = withAgentTraceContext(next, trace);
  if (workUnitId) traced[WORK_UNIT_ID_ENV] = workUnitId;
  return traced;
}

/** `headers` without any header a carrier owns, in any case. */
export function withoutCarriedHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !carriedHeaderName(name)));
}

/** The headers every request of a call carries: `traceparent`, `tracestate` and `x-work-unit-id`, each only when present. */
export function carriedHeaders(trace: ShapingTraceContext | null, workUnitId: string | null): Record<string, string> {
  return {
    ...(trace ? { traceparent: trace.traceparent } : {}),
    ...(trace?.tracestate ? { tracestate: trace.tracestate } : {}),
    ...(workUnitId ? { [WORK_UNIT_ID_HEADER]: workUnitId } : {}),
  };
}

/** What an MCP `tools/call` carries in `params._meta`, or undefined when there is nothing to carry. */
export function carriedMeta(trace: ShapingTraceContext | null, workUnitId: string | null): Record<string, string> | undefined {
  const meta: Record<string, string> = {
    ...(trace ? { traceparent: trace.traceparent } : {}),
    ...(trace?.tracestate ? { tracestate: trace.tracestate } : {}),
    ...(workUnitId ? { [WORK_UNIT_ID_META]: workUnitId } : {}),
  };
  return Object.keys(meta).length > 0 ? meta : undefined;
}
