/**
 * One trace per session, rooted at the session's own start span, that an embedded agent can
 * join.
 *
 * Owned by telemetry because both halves are telemetry facts: the ids `mission.session.started`
 * is captured under, and the exported form of those ids that a launch hands the agent as
 * `TRACEPARENT`. Keeping them in one module is what stops the two from drifting into a parent
 * id that no exported span carries.
 *
 * The raw ids are DERIVED from the session id rather than minted, for two reasons. The agent is
 * launched before the session is registered, so the parent id has to exist before the span
 * does. And an SDK session restored after a daemon restart is a new process that must point at
 * the same start span, which its durable dedupe identity (`start:<session id>`) keeps as the
 * one that was exported first.
 *
 * Exported ids are translated per profile with that profile's salt (`scopedTraceId` and
 * `scopedSpanId`), so a `TRACEPARENT` names exactly one audience. It names the organization's
 * Product analytics lane, because that is the lane that reaches the same backend the agents'
 * own device-managed telemetry does. With collection off, no organization, or that lane not
 * exporting, there is no exported parent to join, and the launch carries no trace context.
 */
import type { TelemetryConfig, TelemetryProfileId } from "@shared/telemetry.ts";
import { SESSION_STARTED_EVENT } from "@shared/telemetry-catalog.ts";
import { formatTraceparent, type AgentTraceContext } from "../agent-trace-context.ts";
import { currentOrganization } from "../environment/organization.ts";
import { getTelemetryConfig, profileIsExporting, profileSalt } from "./config.ts";
import { digest } from "./identity.ts";
import { scopedSpanId, scopedTraceId } from "./projection.ts";

/** The audience whose exported ids an agent's spans are parented under. */
export const SESSION_TRACE_PROFILE: TelemetryProfileId = "product";

/** The raw, never-exported trace and span ids of this session's start span. */
export function sessionTraceIds(sessionId: string): { traceId: string; spanId: string } {
  return {
    traceId: digest(["mission.session.trace", sessionId]),
    spanId: digest(["mission.session.span", sessionId]).slice(0, 16),
  };
}

/**
 * The trace context to launch this session's agent under, or null to launch it with none.
 *
 * Never throws. A launch must not fail because telemetry could not answer, so an unreadable
 * configuration is the same answer as collection being off.
 */
export function sessionTraceContext(
  sessionId: string,
  config?: TelemetryConfig,
): AgentTraceContext | null {
  try {
    const resolved = config ?? getTelemetryConfig();
    if (!resolved.enabled) return null;
    if (currentOrganization() === null) return null;
    if (!SESSION_STARTED_EVENT.audience.includes(SESSION_TRACE_PROFILE)) return null;
    if (!profileIsExporting(resolved, SESSION_TRACE_PROFILE)) return null;
    const salt = profileSalt(SESSION_TRACE_PROFILE);
    const raw = sessionTraceIds(sessionId);
    return formatTraceparent(
      scopedTraceId(SESSION_TRACE_PROFILE, salt, raw.traceId),
      scopedSpanId(SESSION_TRACE_PROFILE, salt, raw.spanId),
    );
  } catch {
    return null;
  }
}
