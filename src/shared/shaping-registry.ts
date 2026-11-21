/**
 * Task shaping's persisted vocabularies. Data only: no logic, and no imports, so a test build
 * can substitute this module and the shared logic in `shaping.ts` stays the one reader.
 *
 * Every tuple here is append-only. Stage, transport and built-in ids are stored inside
 * `app_config.shaping` and in shaper manifests, and outcome, origin and reference kinds are
 * recorded with every launch. Never rename, reorder or reuse a value: a stored shaper whose id
 * this build does not know is kept and listed as unsupported, never reinterpreted.
 */

/** Ordered. A stage starts when the one before it has settled. `route` is appended with FR-04. */
export const SHAPING_STAGES = ["gather", "select"] as const;
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
