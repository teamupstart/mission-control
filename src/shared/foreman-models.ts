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
export type ForemanModelSource = "config" | "env" | "default";

export interface ForemanModelSpec {
  /** The `ForemanConfig` key holding the operator's override, if any. */
  configKey: "reviewModel" | "verifyModel" | "triageModel" | "backlogModel";
  /** The env var consulted when the config key is empty. */
  envVar: string;
  /** What we spawn with when neither of the above says otherwise. */
  fallback: string;
  /** Field label in the settings panel. */
  label: string;
  /** One line under the field: what this call actually does. */
  blurb: string;
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
    envVar: "FOREMAN_REVIEW_MODEL",
    fallback: "claude-opus-4-8",
    label: "Review",
    blurb: "Judges a stuck session's pending question - answer, escalate, or leave it.",
  },
  verify: {
    configKey: "verifyModel",
    envVar: "FOREMAN_VERIFY_MODEL",
    fallback: "claude-opus-4-8",
    label: "Verify",
    blurb: "Reads the diff and decides whether a queued work item is actually done.",
  },
  triage: {
    configKey: "triageModel",
    envVar: "FOREMAN_TRIAGE_MODEL",
    fallback: "claude-haiku-4-5",
    label: "Triage",
    blurb: "The cheap Tier 1 router in front of Review. Buckets the ask; never solves it.",
  },
  backlog: {
    configKey: "backlogModel",
    envVar: "FOREMAN_BACKLOG_MODEL",
    fallback: "claude-sonnet-5",
    label: "Backlog",
    blurb: "Reads the backlog once per change and orders it by what depends on what.",
  },
};

/**
 * Model ids offered as autocomplete in the settings panel.
 *
 * A CONVENIENCE LIST, never a validation set: the fields stay free text, because the
 * `claude` CLI accepts ids and aliases this repo has no business knowing about, and a
 * dropdown would strand an operator the day a new model ships. Being slightly stale here
 * costs a suggestion; refusing an unlisted id would cost the feature.
 */
export const FOREMAN_MODEL_SUGGESTIONS = [
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-haiku-4-5",
] as const;

/** Just the model-id keys, for anything iterating the config's model fields. */
export type ForemanModelConfig = Partial<
  Record<ForemanModelSpec["configKey"], string | undefined>
>;

export interface ResolvedForemanModel {
  role: ForemanModelRole;
  /** The id handed to `--model`. Never empty. */
  id: string;
  source: ForemanModelSource;
}

/**
 * Resolve one role: config, then env, then the shipped fallback.
 *
 * `||` and not `??` throughout, because every layer here is optional FREE TEXT and an
 * empty string is a human who cleared the box - not a request to spawn the CLI with no
 * model id at all. This is the rule `backlogModel` already documented; it is enforced in
 * one place now so a fifth role cannot get it wrong.
 */
export function resolveForemanModel(
  role: ForemanModelRole,
  cfg: ForemanModelConfig | null | undefined,
  env: Record<string, string | undefined> = {},
): ResolvedForemanModel {
  const spec = FOREMAN_MODEL_SPECS[role];
  const fromConfig = cfg?.[spec.configKey]?.trim();
  if (fromConfig) return { role, id: fromConfig, source: "config" };
  const fromEnv = env[spec.envVar]?.trim();
  if (fromEnv) return { role, id: fromEnv, source: "env" };
  return { role, id: spec.fallback, source: "default" };
}

/** Every role at once - what the daemon reports and the panel renders. */
export function resolveForemanModels(
  cfg: ForemanModelConfig | null | undefined,
  env: Record<string, string | undefined> = {},
): Record<ForemanModelRole, ResolvedForemanModel> {
  return Object.fromEntries(
    FOREMAN_MODEL_ROLES.map((role) => [role, resolveForemanModel(role, cfg, env)]),
  ) as Record<ForemanModelRole, ResolvedForemanModel>;
}
