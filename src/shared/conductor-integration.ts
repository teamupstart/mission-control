import {
  SETUP_DEPENDENCY_IDS,
  SETUP_DEPENDENCY_INFO,
  SETUP_FAMILY_IDS,
  type SetupDependencyId,
  type SetupFamilyId,
} from "./setup-catalog.ts";

// The one switch for the ai-conductor pipeline integration.
//
// The integration is HIDDEN, not removed. Operators reading Setup could not tell how to
// install Conductor, and rather than patch that copy the integration is being rebuilt before
// it returns. Everything it owns stays in the tree and keeps its tests: the provider under
// `server/pipelines/`, the persisted pipeline rows and their schema, the append-only
// `ai-conductor` id in `SETUP_DEPENDENCY_IDS`, the `pipeline` task kind, and the Conductor
// Settings panel.
//
// Flipping this to `true` restores, in one edit:
//
//  - the daemon: the pipeline watcher (probes, file tails, commission replay), the
//    `/api/pipelines/*`, `/ingest/conductor` and `/mcp/pipelines/*` routes, Pipeline dispatch,
//    and the `pipelines` facts on the settings-status tuple;
//  - Setup: the ai-conductor row, its Pipelines family, and their place in the banner counts;
//  - the dashboard: the Conductor Settings category, its search and palette entries, the
//    Pipeline task kind in Dispatch, and the guided tour's Pipeline entry (authored in
//    `tours/see-work.md` with `<!-- requires: ai-conductor -->`, gated by `TOUR_REQUIREMENTS`).
//
// Browser-safe, like everything in `shared/`: the dashboard reads this constant directly. The
// daemon reads it through `server/pipelines/availability.ts`, which is the only place a test
// may override it.

/** Whether the ai-conductor pipeline integration is offered at all. Flip to restore it. */
export const CONDUCTOR_INTEGRATION_ENABLED: boolean = false;

/** The sentence a refused request carries while the integration is hidden. */
export const CONDUCTOR_UNAVAILABLE_DETAIL =
  "The ai-conductor pipeline integration is temporarily unavailable while it is rebuilt.";

/** Setup dependencies that belong to the ai-conductor integration. */
const CONDUCTOR_SETUP_DEPENDENCIES: ReadonlySet<SetupDependencyId> = new Set(["ai-conductor"]);

/**
 * Whether Setup reports this dependency.
 *
 * A hidden dependency is neither probed nor listed, so it cannot raise the Setup banner or
 * count toward a family's readiness. Its id stays in the append-only catalog.
 */
export function setupDependencyAvailable(
  id: SetupDependencyId,
  enabled: boolean = CONDUCTOR_INTEGRATION_ENABLED,
): boolean {
  return enabled || !CONDUCTOR_SETUP_DEPENDENCIES.has(id);
}

/** The dependency ids Setup probes and lists, in catalog order. */
export function availableSetupDependencyIds(
  enabled: boolean = CONDUCTOR_INTEGRATION_ENABLED,
): SetupDependencyId[] {
  return SETUP_DEPENDENCY_IDS.filter((id) => setupDependencyAvailable(id, enabled));
}

/**
 * Whether the Setup rail offers this family before any rows have arrived.
 *
 * A family is withheld only when hiding emptied it: it has catalog dependencies and every one
 * of them is hidden. Families with no catalog dependencies at all (Repositories, whose rows
 * are derived) are unaffected. Callers holding rows should also keep any family a row names,
 * so a family is never withheld while it has something to show.
 */
export function setupFamilyAvailable(
  family: SetupFamilyId,
  enabled: boolean = CONDUCTOR_INTEGRATION_ENABLED,
): boolean {
  const members = SETUP_DEPENDENCY_IDS.filter((id) => SETUP_DEPENDENCY_INFO[id].family === family);
  return members.length === 0 || members.some((id) => setupDependencyAvailable(id, enabled));
}

/** The Setup families the rail draws, in catalog order. */
export function visibleSetupFamilyIds(
  rows: readonly { family: SetupFamilyId }[] = [],
  enabled: boolean = CONDUCTOR_INTEGRATION_ENABLED,
): SetupFamilyId[] {
  return SETUP_FAMILY_IDS.filter(
    (family) => setupFamilyAvailable(family, enabled) || rows.some((row) => row.family === family),
  );
}
