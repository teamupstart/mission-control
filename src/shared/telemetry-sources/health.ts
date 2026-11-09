import { z } from "zod";
import { AUDIENCE_ALL, TELEMETRY_PROFILE_IDS } from "../telemetry.ts";
import type { TelemetryEventDefinition, TelemetryMetricDefinition } from "../telemetry-catalog.ts";

/** A destination exports only its own health. No endpoint, credential or error text. */
export const HEALTH_FIELDS = {
  pending: "{item}", retrying: "{item}", accepted: "{item}", rejected: "{item}", expired: "{item}",
  pending_bytes: "By", oldest_pending_age: "s", last_accepted_at: "s", observed_at: "s",
} as const;
export const HEALTH_EVENT: TelemetryEventDefinition = {
  name: "mission.telemetry.health", version: 1, group: "telemetry_control", priority: "core",
  question: "Is this destination draining its durable queue?", owner: "src/server/telemetry/health.ts",
  audience: AUDIENCE_ALL, ingress: null, refKeys: [], span: null,
  facts: z.object({ profile: z.enum(TELEMETRY_PROFILE_IDS), ...Object.fromEntries(
    Object.keys(HEALTH_FIELDS).map((key) => [key, z.number().nonnegative().finite()]),
  ) }).strict(),
};
export const HEALTH_METRICS: TelemetryMetricDefinition[] = Object.entries(HEALTH_FIELDS).map(([field, unit]) => ({
  name: `mission.telemetry.health.${field}`, description: HEALTH_EVENT.question, unit, kind: "gauge",
  valueType: "double", event: HEALTH_EVENT.name, audience: AUDIENCE_ALL, dimensions: ["profile"],
  boundaries: null, unknownPolicy: "explicit_unknown", since: 2, owner: HEALTH_EVENT.owner,
  contribution: (facts) => ({ dimensions: { profile: String(facts.profile) }, value: Number(facts[field]) }),
}));
