import { openDb } from "../../src/server/db.ts";
import { setTelemetryConfig } from "../../src/server/telemetry/config.ts";
import { registerBuiltinTelemetry } from "../../src/server/telemetry/service.ts";
export function enableExperience(): void { registerBuiltinTelemetry(); setTelemetryConfig({ enabled: true }); }
export function experienceFacts(name: string) {
  return (openDb().prepare("SELECT facts_json, actor_json FROM telemetry_journal WHERE name = ? AND EXISTS (SELECT 1 FROM json_each(profiles_json) WHERE value = 'local')").all(name) as { facts_json: string; actor_json: string }[])
    .map((r) => ({ facts: JSON.parse(r.facts_json) as Record<string, unknown>, actor: JSON.parse(r.actor_json) as Record<string, unknown> }));
}
