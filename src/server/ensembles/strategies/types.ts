import type { z } from "zod";
import type { EnsembleStrategyInfo } from "@shared/ensemble-strategies/types.ts";
import type { CompiledEnsemblePlan, EnsembleJson, EnsembleReviewPersona } from "@shared/ensemble.ts";

/**
 * The seam a strategy plugs into: validate an operator's configuration, compile it once into
 * a generic plan, and never be asked anything again.
 *
 * The point of this interface is what is NOT on it. A descriptor cannot persist, spawn,
 * schedule, read a checkout or emit an event; the generic engine owns all of that, and it
 * dispatches on the compiled plan's stage kinds - never on a strategy id. That is the
 * contract making "a new strategy needs no migration, route, ServerEvent or session field"
 * true by construction rather than by everybody remembering it.
 *
 * A descriptor EXTENDS its browser-safe half (`EnsembleStrategyInfo`) rather than restating a
 * label, a capability or a config schema, so a call site holding one reads every slot off one
 * object - the same shape `Harness extends HarnessCapabilities` and
 * `TaskSourceImpl extends TaskSourceKindInfo` give.
 */

/**
 * What the daemon lends a compilation. Everything here is a VALUE the caller already
 * resolved, which is what keeps `compile` a pure function of its arguments.
 */
export interface StrategyCompileContext {
  /** Canonicalized repository root, already validated by the caller's repo policy. */
  repoRoot: string;
  /**
   * Every Persona this config named, resolved to an exact, immutable SNAPSHOT, keyed by id.
   *
   * A MAP rather than the single snapshot the first strategy needed, because a panel names one
   * Persona per judge and a compiler that could only be handed one would have had to resolve the
   * rest itself - which it cannot do, since resolving reads SQLite. Which ids appear here is the
   * descriptor's own answer (`personaRefs`), so the manager never has to know the shape of a
   * config it does not own.
   *
   * The whole snapshot - name, guidance text and runner/model overrides at the pinned revision -
   * is handed in so the compiler can embed it in the plan and recovery never has to reload the
   * live Persona. A descriptor that named a Persona and finds no entry here must REFUSE rather
   * than silently substitute a built-in rubric: a run judged by a different rubric than the
   * operator chose is a much quieter failure than one that would not start.
   */
  personas: ReadonlyMap<string, EnsembleReviewPersona>;
  /** Wall clock, injected so a compiler stays deterministic under test. */
  now: number;
}

/**
 * One Persona a config names, as the descriptor reports it and the manager resolves it.
 *
 * `path` is the dotted path into that strategy's OWN config (`evaluator.personaId`,
 * `judges.2.personaId`), so a refusal lands on the field the operator filled in rather than on the
 * config as a whole. `revision` is the operator's optional pin: set, and a live Persona that has
 * moved on is a refusal, never a newer snapshot under the request that was made.
 */
export interface StrategyPersonaRef {
  path: string;
  personaId: string;
  revision: number | null;
}

/** One refusal, addressed to a field so a form can put it where the operator typed. */
export interface StrategyIssue {
  /** Dotted path into the strategy's own config (`members.1.effort`); empty for the whole. */
  path: string;
  message: string;
}

export type StrategyCompileResult =
  | { ok: true; plan: CompiledEnsemblePlan; config: EnsembleJson }
  | { ok: false; issues: StrategyIssue[] };

/**
 * One strategy's server half, with its config type ERASED.
 *
 * `compile` takes `unknown` and parses through this descriptor's own schema, which is what
 * makes the catalog one homogeneous record instead of a map of mutually unassignable
 * generics - the same reason `TaskSourceKindInfo` is stored unparameterized. Implementations
 * do not write the erasure by hand: `defineStrategy` below takes a typed spec and produces
 * this, so a compiler still receives a parsed config.
 */
export interface StrategyDescriptor extends EnsembleStrategyInfo {
  /**
   * The version `compile` produces. Equal to `currentVersion` on a healthy descriptor - two
   * fields only so a build shipping a compiler ahead of its form has to say so rather than
   * let the mismatch pass unnoticed.
   */
  compilesVersion: number;
  compile(raw: unknown, context: StrategyCompileContext): StrategyCompileResult;
  /**
   * Which Personas this raw config names, and where.
   *
   * Called BEFORE `compile`, on a config that has not been validated yet - so it must read
   * defensively and answer "none" for anything it cannot make sense of, leaving the real refusal
   * to the schema. Returning an empty list is the honest answer for a strategy that judges with
   * built-in rubrics only, and it is what the default does.
   */
  personaRefs(raw: unknown): StrategyPersonaRef[];
  /**
   * Bring an older stored config forward before validating it, or null when this build
   * cannot read it. Absent means "the schema has never changed".
   *
   * Never applied to a compiled PLAN - only to a config being compiled for a NEW run. An
   * in-flight run executes the plan it was created with, whatever this would return.
   */
  migrateConfig?(raw: unknown, fromVersion: number): unknown | null;
}

/** The typed half an implementation actually writes. */
export interface TypedStrategySpec<C> extends EnsembleStrategyInfo<C> {
  compilesVersion: number;
  /**
   * Turn a VALIDATED config into an immutable plan.
   *
   * PURE. It must not read SQLite, spawn a process, inspect a checkout, or mint a runtime
   * id: runtime ids are daemon-generated, and a compiler that embedded one could not compile
   * the same plan twice. Determinism is what lets a test assert an exact plan and lets
   * recovery trust the snapshot it stored.
   */
  compile(config: C, context: StrategyCompileContext): StrategyCompileResult;
  /** Which Personas a RAW config names. Absent means this strategy never names one. */
  personaRefs?(raw: unknown): StrategyPersonaRef[];
  migrateConfig?(raw: unknown, fromVersion: number): unknown | null;
}

/** Zod's issue paths carry numbers for array indices; the form addresses fields by string. */
function issuePath(path: (string | number)[]): string {
  return path.join(".");
}

/**
 * Erase a typed strategy into a catalog entry.
 *
 * Parsing happens HERE, once, so no implementation re-derives "how do I turn `unknown` into
 * my config" and no two of them report a validation failure in a different shape.
 */
export function defineStrategy<C>(spec: TypedStrategySpec<C>): StrategyDescriptor {
  return {
    id: spec.id,
    currentVersion: spec.currentVersion,
    compilesVersion: spec.compilesVersion,
    label: spec.label,
    blurb: spec.blurb,
    explanation: spec.explanation,
    capabilities: spec.capabilities,
    configSchema: spec.configSchema as z.ZodType<unknown, z.ZodTypeDef, unknown>,
    form: spec.form,
    estimate: spec.estimate,
    enabled: spec.enabled,
    personaRefs: spec.personaRefs ?? (() => []),
    compile(raw, context) {
      const parsed = spec.configSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          ok: false,
          issues: parsed.error.issues.map((issue) => ({
            path: issuePath(issue.path),
            message: issue.message,
          })),
        };
      }
      return spec.compile(parsed.data, context);
    },
    ...(spec.migrateConfig ? { migrateConfig: spec.migrateConfig } : {}),
  };
}

/**
 * The typed catalog. Readers resolve by lookup - never `if (strategyId === "best_of_n")`.
 *
 * Bounded over `K` so a TEST can register a descriptor of its own without appending a
 * test-only id to the production tuple, while the production catalog stays an exhaustive
 * `Record<EnsembleStrategyId, …>` - which is what fails typecheck the moment a real id is
 * added with nothing able to compile it.
 */
export type StrategyCatalog<K extends string = string> = Record<K, StrategyDescriptor>;

/**
 * Look a descriptor up by an id that may have come off disk.
 *
 * Returns null rather than throwing, and never falls back to "the only strategy we have":
 * that fallback is precisely how a run written by a newer build gets executed as something
 * else entirely.
 */
export function descriptorFor<K extends string>(
  catalog: StrategyCatalog<K>,
  id: string,
): StrategyDescriptor | null {
  return Object.hasOwn(catalog, id) ? catalog[id as K] : null;
}
