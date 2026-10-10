/**
 * Repository plan conventions shared by prompts, skills and legacy capture.
 * Managed plans retain immutable Markdown snapshots and rendered HTML in the daemon store.
 * Markdown is authoritative in the checkout; HTML enters Git only under pinned opt-in.
 * Legacy unmanaged layouts remain unchanged. Saving never publishes or satisfies dependencies.
 * See managed-plans.ts for versioned policy, revision and tool payload contracts.
 */

/** The checkout-relative root every plan directory sits directly under. */
export const PLAN_ROOT = "docs/plans";
/** The plan's source of truth. The page is a rendering of it, never a fork. */
export const PLAN_SOURCE_FILENAME = "plan.md";
/** The rendered page a human actually reviews. */
export const PLAN_PAGE_FILENAME = "plan.html";

/** The shape a plan's markdown is written at, as a contract quotes it back. */
export const PLAN_SOURCE_PATH_SHAPE = `${PLAN_ROOT}/<name>/${PLAN_SOURCE_FILENAME}`;
/** The checkout shape for opted-in HTML and legacy plans; default previews stay local. */
export const PLAN_PAGE_PATH_SHAPE = `${PLAN_ROOT}/<name>/${PLAN_PAGE_FILENAME}`;
