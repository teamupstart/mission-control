import { repoAllowlisted } from "./allowlist.ts";
import { resolveModelChoice } from "./model-choice.ts";
import type { ModelChoiceSpec, ResolvedModel } from "./model-choice.ts";
import type { InspectorConfig } from "./protocol.ts";
import { providerModelDefault } from "./model.ts";
import type { LlmRunnerId } from "./llm.ts";

const INSPECTOR_MAX_ROUNDS = 100;
const INSPECTOR_MAX_COMMENTS_PER_ROUND = 20;

export const INSPECTOR_LIMITS = {
  maxRounds: INSPECTOR_MAX_ROUNDS,
  maxCommentsPerRound: INSPECTOR_MAX_COMMENTS_PER_ROUND,
  maxFindingFingerprints: INSPECTOR_MAX_ROUNDS * INSPECTOR_MAX_COMMENTS_PER_ROUND,
} as const;

// "Would the Inspector actually act on this pull request?" - asked once, here.
//
// The Inspector's consent is three independent switches (`enabled`, `mode`, its own
// `repoAllowlist`), and until this module existed only ONE caller read all three: the
// worker's `mayPost`, deciding whether to publish a comment. YOLO mode asked a different
// and weaker question - "did a review happen?" - which a review that posts nothing
// answers yes.
//
// That gap merged commits. `reviewRound` runs whether or not we may post (findings are
// recorded `drafted` instead), so it advances `headSha` and `round` in dry run exactly as
// it does live. A clean dry-run review therefore has a reviewed head matching the PR and
// zero open findings, which satisfied every gate the merge predicate had - and the merge
// is the one action here nobody can undo. "Dry run" has to mean dry for the whole app,
// not just for the half of it that posts comments.
//
// So the three switches are collapsed into one value with a REASON attached. The worker
// persists that value beside the reviewed SHA, while YOLO checks both that historical
// posture and the current one. Current consent cannot retroactively promote a dry-run
// review. Pure - no config reads, no clock, no `node:` import - so the dashboard can call
// it too.

/**
 * What the Inspector is currently able to do about one pull request.
 *
 * `live` is the only value that means "this review is real": it was published under the
 * operator's GitHub identity, in a repo they trusted, with the feature switched on.
 * Every other value names which switch is withholding that.
 */
export type InspectorPosture = "live" | "off" | "dry-run" | "not-allowlisted";

/**
 * Which posture the Inspector holds for this checkout.
 *
 * Order matters only for which reason is reported, and it runs outermost-switch first:
 * an operator whose Inspector is off is not helped by being told their repo is untrusted.
 *
 * Takes a structural type rather than the whole `InspectorConfig` so the dashboard can
 * ask with whatever it holds, and so adding a field to the config cannot silently change
 * what consent means.
 */
export function inspectorPosture(
  cfg: Pick<InspectorConfig, "enabled" | "mode" | "repoAllowlist">,
  cwd: string | null,
  repoRoot: string | null,
): InspectorPosture {
  if (!cfg.enabled) return "off";
  if (cfg.mode !== "live") return "dry-run";
  if (!repoAllowlisted(cwd, repoRoot, cfg.repoAllowlist)) return "not-allowlisted";
  return "live";
}

/**
 * Whether a reviewed head must be run again before it can carry live merge provenance.
 *
 * A non-live current posture does not spend another model run: it still could not
 * publish the result. The transition to live is what makes an earlier dry-run,
 * unallowlisted, or legacy review stale for shipping purposes.
 */
export function reviewNeedsLiveRerun(
  current: InspectorPosture,
  reviewed: InspectorPosture | null,
): boolean {
  return current === "live" && reviewed !== "live";
}

/**
 * The `envVar()` suffix holding a review-model override, as the daemon looks it up.
 *
 * Split out because the string is needed twice in two spellings that must agree: the
 * daemon calls `envVar(INSPECTOR_MODEL_ENV)`, which sweeps the `MISSION_` / `FLEET_` /
 * `HARNESS_` chain, while the panel PRINTS one name a human can actually export. Two
 * literals would let the printed name drift off the one that works.
 */
export const INSPECTOR_MODEL_ENV = "INSPECTOR_MODEL";

/**
 * The model the Inspector reviews and answers follow-ups with.
 *
 * Sonnet, and NAMED rather than left to the CLI, which is the whole point of this spec.
 * An unset `--model` inherits whatever the local `claude` happens to default to - on
 * this machine that resolved to `claude-opus-4-8[1m]`, the 1M-context premium tier, at
 * ~$2 and 225s for a 10KB five-file diff. Nobody chose that, nothing recorded it, and
 * the panel could not have told you it was happening.
 *
 * Sonnet is not a latency fix and must not be sold as one - measured on the same PR it
 * took LONGER (272s, 23 turns) because it reads more files to reach the same verdict.
 * That is `INSPECTOR_TIMEOUT_MS`'s problem, and it is sized for it. What naming a model
 * buys is a review that costs a known amount on a known tier, and a settings screen that
 * can answer "what is this running as?" without guessing.
 */
export const INSPECTOR_MODEL_SPEC: ModelChoiceSpec = {
  envVar: `MISSION_${INSPECTOR_MODEL_ENV}`,
  fallback: "claude-sonnet-5",
  label: "Review model",
  blurb: "Reviews each push and answers follow-ups in the Inspector's own threads.",
};

/**
 * What the Inspector will spawn with, and why.
 *
 * The env value is passed IN rather than read here - this module is imported by the
 * dashboard, and the daemon's `envVar()` reaches for `node:os`. Same split Foreman makes.
 */
export function resolveInspectorModel(
  cfg: Pick<InspectorConfig, "model"> | null | undefined,
  envValue: string | null | undefined,
  runner: LlmRunnerId = "claude",
): ResolvedModel {
  return resolveModelChoice(
    {
      ...INSPECTOR_MODEL_SPEC,
      fallback: runner === "claude" ? INSPECTOR_MODEL_SPEC.fallback : providerModelDefault(runner, "deep"),
    },
    cfg?.model,
    envValue,
  );
}
