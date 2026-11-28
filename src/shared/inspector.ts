import { repoAllowlisted } from "./allowlist.ts";
import { resolveModelChoice } from "./model-choice.ts";
import type { ModelChoiceSpec, ResolvedModel } from "./model-choice.ts";
import type { InspectorConfig } from "./protocol.ts";
import type { CodeRabbitSummary } from "./code-rabbit.ts";
import type { InspectorInspection, InspectorSummary } from "./types.ts";
import { guardProviderModel, providerModelDefault } from "./model.ts";
import { resolveLlmEffort } from "./llm.ts";
import type { LlmRunnerId } from "./llm.ts";
import type { ThinkingLevel } from "./types.ts";

const INSPECTOR_MAX_ROUNDS = 100;
const INSPECTOR_MAX_COMMENTS_PER_ROUND = 20;

export const INSPECTOR_LIMITS = {
  maxRounds: INSPECTOR_MAX_ROUNDS,
  maxCommentsPerRound: INSPECTOR_MAX_COMMENTS_PER_ROUND,
  maxFindingFingerprints: INSPECTOR_MAX_ROUNDS * INSPECTOR_MAX_COMMENTS_PER_ROUND,
  /**
   * Validation refusals GitHub may pin on one drafted finding before the planner stops
   * offering it. Counted only when a refusal is attributed to that draft alone (see
   * `classifyReviewRefusal` and the worker's isolation path), never for a rate limit,
   * an auth failure, a server error or a moved head.
   */
  maxPostRefusals: 3,
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
 * What the Inspector is able to do about one pull request, and what a reviewed head was
 * recorded under. APPEND-ONLY: persisted beside a reviewed head.
 *
 * `live` is the only value that means "this GitHub review is real": it was published under the
 * operator's GitHub identity, in a repo they trusted, with the feature switched on. `off`,
 * `dry-run` and `not-allowlisted` each name the switch that is withholding that.
 *
 * `local` is different: it withholds nothing. It records that a head's tree matched a passed
 * Local Inspector review, so no GitHub review ran. It is a recorded posture, never a current
 * one - `inspectorPosture` cannot return it - and the worker writes it only while the current
 * posture is `live`, so Dry run never produces one. The merge predicate accepts it as review
 * provenance only while Local review is on and the workflow manager still reports the match for
 * the observed head; otherwise it refuses it as `local-review-missing`.
 */
export const INSPECTOR_POSTURES = ["live", "off", "dry-run", "not-allowlisted", "local"] as const;
export type InspectorPosture = (typeof INSPECTOR_POSTURES)[number];

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
): Exclude<InspectorPosture, "local"> {
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
 *
 * A `local` head counts as unpublished here too. The worker never asks about a head that
 * still matches a passed local review - it records that head and stops - so a `local` head
 * that reaches this question no longer matches (Local review switched off, or a newer run that
 * did not pass) and is reviewed on GitHub.
 */
export function reviewNeedsLiveRerun(
  current: InspectorPosture,
  reviewed: InspectorPosture | null,
): boolean {
  return current === "live" && reviewed !== "live";
}

/**
 * The reasoning effort a full review asks for when the operator has not chosen one.
 *
 * A review is asked for every finding that clears the bar in its first round, and later
 * rounds only check the repair, so the first read has to be the thorough one. At the
 * provider's default effort a round returned one or two findings and the rest surfaced a
 * push at a time.
 */
export const INSPECTOR_REVIEW_EFFORT: ThinkingLevel = "xhigh";

/** The two calls the Inspector makes: a full review, and an answer in one of its threads. */
export type InspectorCall = "review" | "reply";

/**
 * The effort an Inspector call wants, before the provider is asked whether it offers it.
 *
 * `saved` is the operator's setting, and its three states mean three things. A level is
 * their choice and applies to both calls. `null` is their choice of the provider's default.
 * `undefined` means they never chose, and then a review takes `INSPECTOR_REVIEW_EFFORT`
 * while a reply, which answers one thread, keeps the provider's default.
 *
 * One definition because the settings page must show what the review will run at: reading
 * "never chosen" as "provider default" there would print a level the review does not use.
 */
export function inspectorEffortChoice(
  saved: ThinkingLevel | null | undefined,
  call: InspectorCall,
): ThinkingLevel | null {
  if (saved !== undefined) return saved;
  return call === "review" ? INSPECTOR_REVIEW_EFFORT : null;
}

/**
 * The value the settings row shows for the Inspector's review effort.
 *
 * A saved choice is shown as saved; the row itself marks a level the model does not offer.
 * With nothing saved the row shows what a review will actually run at, which is the review
 * default only when this provider and model offer it. Showing an unoffered default would
 * print a level nobody chose and the review does not use.
 */
export function inspectorEffortShown(
  saved: ThinkingLevel | null | undefined,
  runner: LlmRunnerId | undefined,
  model: string | undefined,
): ThinkingLevel | null {
  if (saved !== undefined) return saved;
  if (runner === undefined || model === undefined) return null;
  return resolveLlmEffort(runner, model, inspectorEffortChoice(saved, "review")).level;
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
  // "Review", not "Review model". It names a SLOT, and the surfaces that render it already
  // supply the noun - the Models grid puts it in a row under Provider and Model columns, so
  // "Review model" made the controls read "Review model provider" and "Review model model".
  label: "Review",
  blurb: "Reviews each push and answers follow-ups in GitHub Inspector's own threads.",
};

/**
 * The Inspector's resolved model, plus the id its provider refused.
 *
 * `ResolvedModel` with one more field, the same shape `ResolvedForemanModel` carries: a
 * dropped id has to reach the panel, or the row shows a model the operator never chose and
 * says nothing about the one they did.
 */
export interface ResolvedInspectorModel extends ResolvedModel {
  /** The stored id this provider cannot run, or null when the pair is honoured. */
  unsupported: string | null;
}

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
): ResolvedInspectorModel {
  const chosen = resolveModelChoice(
    {
      ...INSPECTOR_MODEL_SPEC,
      // oxlint-disable-next-line repository/agent-comparison -- The Inspector has a pinned Claude model fallback.
      fallback: runner === "claude" ? INSPECTOR_MODEL_SPEC.fallback : providerModelDefault(runner, "deep"),
    },
    cfg?.model,
    envValue,
  );
  // The guard runs LAST, over the winner of the ladder, exactly as `resolveForemanModel` runs
  // it - and for a reason specific to this call. Making the Inspector's provider inheritable
  // means an app-wide provider change moves it with NO Inspector write to intercept, so a
  // model saved under Claude can be handed to Codex with nothing in between. Of every call
  // this app makes, this is the one that writes where other people read, so spawning a
  // provider/model pair that cannot exist is the least acceptable place to find out. `deep`
  // because a pull-request review is a deep call: substituting a cheap model for a refused
  // pair would quietly downgrade the review rather than refuse it.
  const guarded = guardProviderModel(runner, chosen.id, "deep");
  return {
    id: guarded.id,
    // A substituted id came from the provider default, not from the layer that asked for the
    // one that was dropped, so it is not the operator's choice to report.
    source: guarded.unsupported === null ? chosen.source : "default",
    unsupported: guarded.unsupported,
  };
}

/**
 * The Inspector chip facts for one ledger row: what a session card carries as `inspector`, and
 * what Foreman's follow-through builds for a pull request it found by adoption instead.
 *
 * `mode` is read from the config, not the row, because changing it changes no row.
 * `codeRabbit` is included only when the caller has one to give. A pull request's stack
 * standing needs the registry, so the session card adds it after this.
 */
export function inspectorSummaryOf(
  row: InspectorInspection,
  inspectorConfig: Pick<InspectorConfig, "mode">,
  codeRabbit?: CodeRabbitSummary,
): InspectorSummary {
  return {
    ...(codeRabbit ? { codeRabbit } : {}),
    prKey: row.key,
    url: row.url,
    mode: inspectorConfig.mode,
    open: row.openFindings,
    postedOpen: row.postedOpenFindings,
    round: row.round,
    lastReviewedAt: row.lastReviewedAt,
    failed: row.lastError !== null,
    reviewedHeadSha: row.headSha,
    observedHeadSha: row.observedHeadSha,
    cleanReviewHeadSha: row.cleanReviewHeadSha ?? null,
    localReviewHeadSha: row.localReviewHeadSha ?? null,
  };
}
