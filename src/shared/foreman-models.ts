import { resolveModelChoice } from "./model-choice.ts";
import type { ModelChoiceSpec, ModelSource, ResolvedModel } from "./model-choice.ts";
import { guardProviderModel, providerModelDefault } from "./model.ts";
import { isLlmRunnerId } from "./llm.ts";
import type { LlmRunnerId, ResolvedLlmRunner } from "./llm.ts";

// Which model each of Foreman's four `claude -p` calls runs as.
//
// Shared, and pure, for the reason `@shared/cost.ts` and `@shared/backlog.ts` are: the
// worker SPAWNS with the answer and the settings panel DISPLAYS it, and those two must
// never be able to disagree. A panel that renders a default the worker doesn't actually
// use is worse than no panel - it is a confident wrong answer to "what is this running
// as?", which is the question this whole module exists to answer.
//
// `process.env` is read by the CALLER and passed in, never read here: this file is
// imported by the web bundle, where there is no `process`.
//
// The three-layer LADDER for a MODEL id is `@shared/model-choice.ts`, shared with the
// Inspector. What stays here is the four roles, what each of them is for, and the ladder
// for the PROVIDER each one runs on - which has a rung the others do not: a role's own
// choice, then Foreman's group-level one, then the app-wide answer.

/**
 * Foreman's four model calls. Four and not one because their cost profiles genuinely
 * differ - see each spec's `blurb`, and the long-form reasoning at
 * `DEFAULT_TRIAGE_MODEL` (triage.ts) and `DEFAULT_BACKLOG_MODEL` (backlog-plan.ts).
 *
 * Order is display order: the two deep calls first, then the two cheap ones.
 */
export const FOREMAN_MODEL_ROLES = ["review", "verify", "triage", "backlog"] as const;

export type ForemanModelRole = (typeof FOREMAN_MODEL_ROLES)[number];

/** Where a resolved model id came from. Rendered next to the value, so it must be honest. */
export type ForemanModelSource = ModelSource;

export interface ForemanModelSpec extends ModelChoiceSpec {
  /** The `ForemanConfig` key holding the operator's override, if any. */
  configKey: "reviewModel" | "verifyModel" | "triageModel" | "backlogModel";
  /**
   * The `ForemanConfig` key holding THIS ROLE's own provider override, if any.
   *
   * Beside `configKey` rather than derived from it, for the reason `LlmJobSpec.envKey` sits
   * beside `envVar`: two spellings of one key that must agree, and a derivation is exactly
   * the place a rename silently orphans a persisted value.
   */
  runnerKey: "reviewRunner" | "verifyRunner" | "triageRunner" | "backlogRunner";
}

/**
 * `review` and `verify` default to Opus because that is what the prompts were written
 * against - `prompt.ts` and `queue-prompt.ts` hand a model an untrusted transcript, a
 * diff, and a policy, and ask it to judge. They are named here rather than left unset
 * because an unset `--model` inherits whatever the CLI happens to be logged in as (see
 * `runClaudeText`), which made "what does Foreman run as?" unanswerable.
 */
export const FOREMAN_MODEL_SPECS: Record<ForemanModelRole, ForemanModelSpec> = {
  review: {
    configKey: "reviewModel",
    runnerKey: "reviewRunner",
    envVar: "FOREMAN_REVIEW_MODEL",
    fallback: "claude-opus-5",
    label: "Review",
    blurb: "Judges a stuck session's pending question - answer, escalate, or leave it.",
  },
  verify: {
    configKey: "verifyModel",
    runnerKey: "verifyRunner",
    envVar: "FOREMAN_VERIFY_MODEL",
    fallback: "claude-opus-5",
    label: "Verify",
    blurb: "Reads the diff and decides whether a queued work item is actually done.",
  },
  triage: {
    configKey: "triageModel",
    runnerKey: "triageRunner",
    envVar: "FOREMAN_TRIAGE_MODEL",
    fallback: "claude-haiku-4-5",
    label: "Triage",
    blurb: "The cheap Tier 1 router in front of Review. Buckets the ask; never solves it.",
  },
  backlog: {
    configKey: "backlogModel",
    runnerKey: "backlogRunner",
    envVar: "FOREMAN_BACKLOG_MODEL",
    fallback: "claude-sonnet-5",
    label: "Backlog",
    blurb: "Reads the backlog once per change and orders it by what depends on what.",
  },
};

/** Just the model-id keys, for anything iterating the config's model fields. */
export type ForemanModelConfig = Partial<
  Record<ForemanModelSpec["configKey"], string | undefined>
>;

/**
 * The provider half of the same config: Foreman's group-level default, and each role's own.
 *
 * Loose strings rather than `LlmRunnerId` because these are read straight off a persisted
 * blob. A value a downgrade cannot resolve has to arrive here intact so it can be REPORTED
 * rather than silently sanitised - the rule `LlmJobRunnerConfig` states for background jobs.
 */
export type ForemanRunnerConfig = {
  /** Foreman's group-level provider, used by every role that has not chosen its own. */
  runner?: string;
} & Partial<Record<ForemanModelSpec["runnerKey"], string | undefined>>;

/**
 * Which provider ONE Foreman role spawns through, and which layer chose it.
 *
 * A THREE-rung ladder where a background job has two: the role's own provider, then
 * Foreman's group-level one, then the app-wide answer the caller hands in. That extra rung
 * is the only difference from `llmJobRunner`, and the rest is deliberately identical - a
 * Foreman role that answered "what does Inherit mean" differently from a background job
 * would be the same settings screen behaving two ways.
 *
 * `appWide` is PASSED, never derived, for this module's standing reason: it sits behind an
 * env layer only a process with `process.env` can see, and the dashboard imports this file.
 *
 * An unreadable override is reported through `unknown` and then inherits, because "I cannot
 * read your choice here" is much closer to "you did not choose here" than to "use whatever
 * ships" - and a silent replacement would read back as the operator's own pick.
 */
export function resolveForemanRunner(
  role: ForemanModelRole,
  cfg: ForemanRunnerConfig | null | undefined,
  appWide: ResolvedLlmRunner,
): ResolvedLlmRunner {
  let unknown: string | null = null;
  for (const key of [FOREMAN_MODEL_SPECS[role].runnerKey, "runner"] as const) {
    const asked = cfg?.[key]?.trim() ?? "";
    if (!asked) continue;
    if (isLlmRunnerId(asked)) return { id: asked, source: "config", unknown };
    // Recorded and then kept walking DOWN the ladder rather than bottoming out: an
    // unreadable role override still has Foreman's group-level answer under it, which is
    // closer to what the operator configured than the app-wide one and much closer than the
    // shipped default. Only the first unreadable value is reported - it is the one nearest
    // the operator's intent, and a second line about a rung that was never going to be
    // reached is noise.
    unknown ??= asked;
  }
  return { ...appWide, unknown: unknown ?? appWide.unknown };
}

/** Every role's provider at once - what the daemon reports and the panel renders. */
export function resolveForemanRunners(
  cfg: ForemanRunnerConfig | null | undefined,
  appWide: ResolvedLlmRunner,
): Record<ForemanModelRole, ResolvedLlmRunner> {
  return Object.fromEntries(
    FOREMAN_MODEL_ROLES.map((role) => [role, resolveForemanRunner(role, cfg, appWide)]),
  ) as Record<ForemanModelRole, ResolvedLlmRunner>;
}

export interface ResolvedForemanModel extends ResolvedModel {
  role: ForemanModelRole;
  /**
   * A model id that was asked for, belongs to a different provider, and was therefore
   * dropped in favour of this role's provider's own default - or null.
   *
   * The same field `ResolvedLlmJobModel` carries, for the same reason and resolved by the
   * same guard: a row must be able to say the pair it was given could not be honoured,
   * instead of presenting the substitute as the operator's choice. It matters more here than
   * it did when Foreman had one provider, because a role can now be moved onto a provider
   * that does not offer the model saved beside it by an edit somewhere else entirely - an
   * app-wide change, or Foreman's group-level one.
   */
  unsupported: string | null;
}

/**
 * Resolve one role: config, then env, then the shipped fallback.
 *
 * The ranking is `resolveModelChoice`'s, shared with the Inspector, so a fifth call in
 * either subsystem cannot invent a fourth reading of an empty box. All this adds is the
 * role tag and the env LOOKUP, which is Foreman's own: its vars are bare
 * (`FOREMAN_REVIEW_MODEL`), where the Inspector's go through `envVar()`'s prefix chain.
 */
export function resolveForemanModel(
  role: ForemanModelRole,
  cfg: ForemanModelConfig | null | undefined,
  env: Record<string, string | undefined> = {},
  runner: LlmRunnerId = "claude",
): ResolvedForemanModel {
  const spec = FOREMAN_MODEL_SPECS[role];
  const tier = role === "review" || role === "verify" ? "deep" : role === "backlog" ? "balanced" : "cheap";
  const chosen = resolveModelChoice(
    { ...spec, fallback: providerModelDefault(runner, tier) },
    cfg?.[spec.configKey],
    env[spec.envVar],
  );
  // The guard runs LAST, over the winner of the ladder, because a mismatch can enter at any
  // rung - a legacy config value saved under a provider that has since moved underneath it,
  // an env var, or a role whose provider was changed by an edit one level up. This is the
  // half of the pinning invariant nothing that WRITES config can enforce: an app-wide
  // provider change moves this role's effective provider with no Foreman write at all, so
  // there is no patch to intercept and only resolution is left. Same helper as
  // `resolveLlmJobModel`, deliberately.
  const guarded = guardProviderModel(runner, chosen.id, tier);
  return {
    role,
    id: guarded.id,
    // A substituted id came from the shipped provider default, not from the layer that asked
    // for the one that was dropped. Saying `config` here would credit the operator with a
    // choice the app declined to honour.
    source: guarded.unsupported === null ? chosen.source : "default",
    unsupported: guarded.unsupported,
  };
}

/** Every role at once - what the daemon reports and the panel renders. */
export function resolveForemanModels(
  cfg: ForemanModelConfig | null | undefined,
  env: Record<string, string | undefined> = {},
  /**
   * One provider for every role, or - now that a role can carry its own - a function asked
   * per role. A bare id stays accepted because the two forms mean the same thing when no
   * role has overridden, and because several callers still legitimately have one answer.
   */
  runner: LlmRunnerId | ((role: ForemanModelRole) => LlmRunnerId) = "claude",
): Record<ForemanModelRole, ResolvedForemanModel> {
  const runnerFor = typeof runner === "function" ? runner : (): LlmRunnerId => runner;
  return Object.fromEntries(
    FOREMAN_MODEL_ROLES.map((role) => [role, resolveForemanModel(role, cfg, env, runnerFor(role))]),
  ) as Record<ForemanModelRole, ResolvedForemanModel>;
}
