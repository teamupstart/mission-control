import { CONDUCTOR_INTEGRATION_ENABLED } from "@shared/conductor-integration.ts";

// The daemon's reading of the ai-conductor switch.
//
// The switch itself is `CONDUCTOR_INTEGRATION_ENABLED` in `shared/conductor-integration.ts`;
// this accessor exists so the integration's own tests can keep exercising its dormant code in
// process while the shipped build has it off. Production code never writes the override.

let override: boolean | null = null;

/** Whether the daemon serves, watches, and dispatches the ai-conductor integration. */
export function conductorIntegrationEnabled(): boolean {
  return override ?? CONDUCTOR_INTEGRATION_ENABLED;
}

/**
 * Test seam: force the switch for this process, or `null` to return to the shipped value.
 *
 * Only for tests whose subject is the hidden integration itself. A daemon a test spawns does
 * not inherit it.
 */
export function overrideConductorIntegrationForTests(value: boolean | null): void {
  override = value;
}
