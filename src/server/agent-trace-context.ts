/**
 * The W3C trace context an embedded agent is launched under, and how it reaches the agent.
 *
 * Pure on purpose: the two SDK adapters import this, and neither may reach `config.ts` at
 * module load (see the lazy import note in `harness/codex/sdk.ts`). Deciding WHICH context a
 * session gets belongs to telemetry, in `telemetry/session-trace.ts`; this module only carries
 * the decision.
 *
 * The carrier is the two standard variables and nothing else. Claude Code reads `TRACEPARENT`
 * and `TRACESTATE` when it starts each interaction span in an Agent SDK or `-p` session, and
 * `codex app-server` reads them once at startup and parents every request span that carries
 * no per-request `trace` field under them. Neither needs an exporter setting from us: where the
 * spans go is the machine's own configuration (on an Upstart Mac, device management), and an
 * `OTEL_*` exporter key from Mission Control would compete with it.
 */

/** The two W3C Trace Context variables, in the spelling both agents read. */
export const TRACE_CONTEXT_ENV_NAMES = ["TRACEPARENT", "TRACESTATE"] as const;

/** A W3C `traceparent`, version 00. `tracestate` is absent because Mission Control sets none. */
export interface AgentTraceContext {
  traceparent: string;
}

const TRACEPARENT_PATTERN = /^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/;

/** A sampled version-00 `traceparent`, or null when either id is not a valid W3C id. */
export function formatTraceparent(traceId: string, spanId: string): AgentTraceContext | null {
  const traceparent = `00-${traceId}-${spanId}-01`;
  return TRACEPARENT_PATTERN.test(traceparent) ? { traceparent } : null;
}

/**
 * The launch environment with this session's trace context, and only this session's.
 *
 * Any inherited `TRACEPARENT` or `TRACESTATE` is removed first, with or without a context to
 * set. The daemon's own environment belongs to whatever started the daemon - a shell, a CI
 * job, an agent's Bash tool - and an embedded session parented under that would join every
 * session this daemon ever launches to one unrelated trace. With no context, the agent starts
 * its own root spans exactly as it would outside Mission Control.
 */
export function withAgentTraceContext<T extends Record<string, string | undefined>>(
  env: T,
  context: AgentTraceContext | null | undefined,
): T {
  const next: Record<string, string | undefined> = { ...env };
  for (const name of TRACE_CONTEXT_ENV_NAMES) delete next[name];
  if (context) next.TRACEPARENT = context.traceparent;
  return next as T;
}
