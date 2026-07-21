// One ladder for "which model does this `claude -p` call spawn with?", and one answer.
//
// Every headless caller in this app resolves the same three layers in the same order -
// the operator's config, an env var, then a shipped fallback - and every settings panel
// has to print which of the three won. Foreman had that ladder first, for its four
// roles; the Inspector then needed it for its one. Copying it would have meant two
// resolvers that could disagree about what an empty box means, which is the exact bug
// class the readout exists to rule out.
//
// So the ladder lives here and the ROLES stay with their subsystem: `foreman-models.ts`
// keeps its four specs, `inspector.ts` keeps its one. A caller that adds a fifth model
// call writes a spec, not a resolver.
//
// PURE, and deliberately takes the env VALUE rather than an env map or a var name: the
// dashboard imports this, and the Inspector's env lookup goes through `envVar()` in
// `harness-runtime.mjs`, which reads `node:os` and `node:fs` at import. Whoever holds a
// real environment does the lookup; this module only ranks the answers.

/** Where a resolved model id came from. Rendered next to the value, so it must be honest. */
export type ModelSource = "config" | "env" | "default";

/** What one model-taking call declares about itself. */
export interface ModelChoiceSpec {
  /**
   * The env var consulted when the config value is empty, spelled as the operator would
   * type it. This string is SHOWN in the settings panel, so it has to be the name that
   * actually works - for callers reading through `envVar()`, that is the prefixed form.
   */
  envVar: string;
  /** What we spawn with when neither of the above says otherwise. Never empty. */
  fallback: string;
  /** Field label in the settings panel. */
  label: string;
  /** One line under the field: what this call actually does. */
  blurb: string;
}

export interface ResolvedModel {
  /** The id handed to `--model`. Never empty. */
  id: string;
  source: ModelSource;
}

/**
 * Rank the three layers: config, then env, then the shipped fallback.
 *
 * `||` and not `??` throughout, because every layer is optional FREE TEXT and an empty
 * string is a human who cleared the box - not a request to spawn the CLI with no model
 * id at all. An unset `--model` inherits whatever the CLI happens to default to, which
 * is both the most expensive tier available and unanswerable from inside this app; it is
 * never what a cleared field means.
 */
export function resolveModelChoice(
  spec: ModelChoiceSpec,
  configValue: string | null | undefined,
  envValue: string | null | undefined,
): ResolvedModel {
  const fromConfig = configValue?.trim();
  if (fromConfig) return { id: fromConfig, source: "config" };
  const fromEnv = envValue?.trim();
  if (fromEnv) return { id: fromEnv, source: "env" };
  return { id: spec.fallback, source: "default" };
}

/**
 * Model ids offered as autocomplete in the settings panels.
 *
 * A CONVENIENCE LIST, never a validation set: the fields stay free text, because the
 * `claude` CLI accepts ids and aliases this repo has no business knowing about, and a
 * dropdown would strand an operator the day a new model ships. Being slightly stale here
 * costs a suggestion; refusing an unlisted id would cost the feature.
 */
export const MODEL_SUGGESTIONS = [
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-haiku-4-5",
] as const;
