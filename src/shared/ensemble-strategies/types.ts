import type { z } from "zod";
import type {
  EnsembleArtifactKind,
  EnsembleLaunchEstimate,
  EnsembleStrategyId,
} from "../ensemble.ts";

/**
 * What a strategy can say about itself WITHOUT a `node:` import or a database.
 *
 * The same purity split `HARNESS_CAPABILITIES` makes against `HARNESSES` and
 * `TASK_SOURCE_KIND_INFO` makes against `TASK_SOURCES`: what a strategy IS lives in shared
 * code the dashboard can render, what it DOES - compiling a request into a plan - lives on
 * the server. The server's `StrategyDescriptor` spreads this in rather than restating a
 * label or a capability, so a call site holding a descriptor reads every slot off one
 * object and the two records cannot drift into two different answers.
 */

/**
 * One control on the strategy's configuration form.
 *
 * A bounded union, not arbitrary JSX or a schema-to-form reflector: the dashboard has to be
 * able to render a strategy it cannot import an implementation for, and every renderer here
 * is one the browser already knows how to draw. `member_roster` is the single composite -
 * a repeated row of agent/model/effort/approach - because "which agents, configured how"
 * is the shape every fixed-roster strategy needs and hand-rolling it per strategy is how
 * two of them end up validating the roster differently.
 */
export type StrategyFormField =
  | {
      kind: "int";
      key: string;
      label: string;
      help: string;
      min: number;
      max: number;
      step: number;
    }
  | { kind: "text"; key: string; label: string; help: string; maxLength: number; multiline: boolean }
  | { kind: "toggle"; key: string; label: string; help: string }
  | {
      kind: "select";
      key: string;
      label: string;
      help: string;
      options: Array<{ value: string; label: string }>;
    }
  | {
      kind: "member_roster";
      key: string;
      label: string;
      help: string;
      minRows: number;
      maxRows: number;
      /** Whether two rows may hold identical configuration. Repeats are legitimate. */
      allowDuplicates: boolean;
    }
  | {
      /**
       * A repeated row of ONE choice - the lens a judge is given - for a panel of evaluators.
       *
       * The second composite, and it is a distinct renderer rather than a `member_roster` variant
       * because the two rows are about different things: a member row configures an AGENT that
       * will hold a worktree, a judge row configures a LENS on the finished work. Duplicates are
       * refused here (a panel of two identical lenses cannot disagree), which is the other half of
       * why one renderer could not serve both.
       */
      kind: "lens_panel";
      key: string;
      label: string;
      help: string;
      minRows: number;
      maxRows: number;
      options: Array<{ value: string; label: string; help: string }>;
    };

/**
 * The form a strategy asks for, as data.
 *
 * `key` is a dotted path into that strategy's own config object (`evaluator.model`), which
 * is what lets one generic renderer build a config no component has a type for.
 */
export interface StrategyFormSpec {
  fields: StrategyFormField[];
}

/**
 * What a strategy is capable of, in the terms other subsystems ask about.
 *
 * These are answers a CREATION-time validator needs before anything launches: a
 * finalization that cannot materialize exactly one live Session may not request the
 * one-Session Workflow handoff, and a strategy that shares artifacts between members must
 * say so rather than have the UI describe members as isolated.
 */
export interface EnsembleStrategyCapabilities {
  /** Finalization ends with exactly one live Session, so a Workflow handoff is possible. */
  singleSessionFinalization: boolean;
  /** Members may be shown each other's immutable artifacts. */
  sharesArtifacts: boolean;
  /** A person must confirm the terminal outcome before anything destructive happens. */
  requiresHumanDecision: boolean;
  /** What members submit for comparison. */
  artifactKinds: EnsembleArtifactKind[];
  /** Whether the launch count is exact at creation or grows within a cap. */
  launchShape: "fixed" | "adaptive";
}

/**
 * One strategy's browser-safe half.
 *
 * `configSchema` takes `unknown` on purpose - what is parsed is a blob some other build may
 * have written, every field of which this build's schema may since have made optional, and
 * a schema that only accepted its own output could not read it.
 */
export interface EnsembleStrategyInfo<C = unknown> {
  id: EnsembleStrategyId;
  /** The version this build COMPILES new runs at. Old runs execute their own snapshot. */
  currentVersion: number;
  label: string;
  /** One line under the label on a preset card. */
  blurb: string;
  /** What the operator is agreeing to: how it runs, what it costs, what it will not do. */
  explanation: string;
  capabilities: EnsembleStrategyCapabilities;
  configSchema: z.ZodType<C, z.ZodTypeDef, unknown>;
  form: StrategyFormSpec;
  /**
   * What creating this would start, from a raw config blob. Null when the blob is not
   * valid for this strategy - a form mid-edit is the ordinary case, and an estimate
   * invented from an invalid config is worse than none, because this is the number the
   * later creation UI will show before launching local agents.
   */
  estimate(raw: unknown): EnsembleLaunchEstimate | null;
  /**
   * Whether this build offers it for creation. False is how a strategy ships its
   * persistence and tests before its product surface, without a second registry of
   * "enabled" ids to keep in step.
   */
  enabled: boolean;
}
