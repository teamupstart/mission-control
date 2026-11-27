/**
 * Task shaping's persisted vocabularies. Data only: no logic, and no imports, so a test build
 * can substitute this module and the shared logic in `shaping.ts` stays the one reader.
 *
 * Every tuple here is append-only. Stage, transport and built-in ids are stored inside
 * `app_config.shaping` and in shaper manifests, and outcome, origin and reference kinds are
 * recorded with every launch. Never rename, reorder or reuse a value: a stored shaper whose id
 * this build does not know is kept and listed as unsupported, never reinterpreted.
 */

/**
 * Ordered. A stage starts when the one before it has settled. `route` (FR-04 `route_skills`)
 * returns skills, not context entries, and runs once the selectors have settled.
 */
export const SHAPING_STAGES = ["gather", "select", "route"] as const;
export const RETIRED_SHAPING_STAGES = [] as const;

/** How Mission Control reaches a shaper. Each id has one file in `src/server/shaping/transports/`. */
export const SHAPING_TRANSPORTS = ["command", "mcp", "http", "builtin"] as const;
export const RETIRED_SHAPING_TRANSPORTS = [] as const;

/** Implementations that ship inside Mission Control, with the stages each one serves. */
export const SHAPING_BUILTINS = [
  { id: "repository-files", stages: ["gather"] },
] as const;
export const RETIRED_SHAPING_BUILTINS = [] as const;

/** What one shaper's part of a run came to. Recorded per shaper in the task's summary. */
export const SHAPING_OUTCOMES = ["ok", "degraded", "failed", "timed_out", "invalid", "unavailable"] as const;

/** Where a shaper's definition came from: `app_config.shaping`, or the shapers folder. */
export const SHAPING_ORIGINS = ["registered", "discovered"] as const;

/** The references a shaper's header and environment values may name, resolved at call time. */
export const SHAPING_REFERENCE_KINDS = ["caller.user", "caller.agent", "caller.conversation", "env"] as const;

/**
 * When a routed skill is meant to run. A skill whose point this build does not know is recorded
 * as `unsupported` and never announced, and the rest of its router's reply is still used.
 */
export const SHAPING_LIFECYCLE_POINTS = ["task-start", "during", "after-work"] as const;
export const RETIRED_SHAPING_LIFECYCLE_POINTS = [] as const;

/**
 * What became of one routed skill, recorded in the task's summary. Only `announced` skills have
 * a line in turn one. `superseded`: a repository's own task skill for the kind answers to the
 * same invocation (D14). `unavailable`: the harness or the catalog cannot run it.
 * `unsupported`: its lifecycle point is unknown here. `dropped`: past the cap or the budget.
 */
export const SHAPING_SKILL_STATES = ["announced", "superseded", "unavailable", "unsupported", "dropped"] as const;
export const RETIRED_SHAPING_SKILL_STATES = [] as const;

/**
 * Where a launch's after-work prompt is. `held` waits for Foreman's wrap-up on a task with no
 * workflow, `queued` is in the session's outbox, `waiting` is one the outbox refused for a
 * reason that can clear and is tried again, and `delivered`, `skipped` and `not_delivered` are
 * final.
 */
export const SHAPING_PROMPT_STATES = ["held", "queued", "delivered", "skipped", "not_delivered", "waiting"] as const;
export const RETIRED_SHAPING_PROMPT_STATES = [] as const;

/**
 * How a remote shaper signs in to its server: the `type` of a server's `auth` marker. Stored in
 * the shaper's definition, so a kind this build does not know leaves the shaper unsupported.
 */
export const SHAPING_AUTH_KINDS = ["oauth"] as const;
export const RETIRED_SHAPING_AUTH_KINDS = [] as const;

/**
 * Where one connection's sign-in is. `pending` has sent the operator to the authorization
 * server and waits for the callback; `renewing` holds a token that is being refreshed or that a
 * server refused. Published in the sign-in list, never stored.
 */
export const SHAPING_SIGN_IN_STATES = ["signed_out", "pending", "signed_in", "renewing"] as const;

/** Where a connection's tokens are kept: the macOS Keychain, or the daemon's memory only. */
export const SHAPING_SIGN_IN_STORAGE = ["keychain", "memory"] as const;
