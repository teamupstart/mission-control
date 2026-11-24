// The model step of voice routing: contract E of
// `docs/plans/voice-addressing-for-agents/phased-plan.md`, said once for every side.
//
// Browser-safe: no `node:` import may reach this module. The daemon asks the questions and
// stores the keys; Voice settings draws the key report; both read who is in use through
// `effectiveDecisionProvider`, so the panel can never name a provider the daemon does not call.

import { z } from "zod";
import type { LlmRunnerId } from "./llm.ts";
import { normalizeSpokenName } from "./voice-names.ts";
import type { VoiceDecisionProvider } from "./voice.ts";

// ---- the providers and their keys ----

/** The decision-model providers a key can be saved for, in the order Automatic tries them. */
export const VOICE_KEY_PROVIDERS = ["openai", "jev"] as const;
export type VoiceKeyProvider = (typeof VOICE_KEY_PROVIDERS)[number];

/** How each provider reads to a person. */
export const VOICE_KEY_PROVIDER_LABEL: Record<VoiceKeyProvider, string> = {
  openai: "OpenAI Decisions",
  jev: "Jev",
};

/**
 * The variable in the daemon's environment that holds each provider's key. Read as spelled,
 * not through the `MISSION_` chain: these are the names the providers' own tools use, which is
 * what lets one variable switch the decision model on for a whole organization.
 */
export const VOICE_KEY_ENV: Record<VoiceKeyProvider, string> = {
  openai: "OPENAI_API_KEY",
  jev: "TYPESAFE_API_KEY",
};

/** Where a provider's key comes from: saved in Voice settings, the environment, or nowhere. */
export type VoiceKeySource = "settings" | "environment" | null;

/** Which keys exist, without the keys themselves. */
export interface VoiceKeyAvailability {
  saved: Record<VoiceKeyProvider, boolean>;
  environment: Record<VoiceKeyProvider, boolean>;
}

/** A provider's key source: a saved key overrides the environment on this machine. */
export function voiceKeySource(provider: VoiceKeyProvider, keys: VoiceKeyAvailability): VoiceKeySource {
  if (keys.saved[provider]) return "settings";
  if (keys.environment[provider]) return "environment";
  return null;
}

/**
 * The provider the model step asks first, or null for none.
 *
 * - `off`: none, whatever keys exist. A person's opt-out.
 * - `openai` or `jev`: that provider, when it has a key. Another provider's key is never used.
 * - null, automatic: the first of four sources that exists, in this fixed order: a saved OpenAI
 *   Decisions key, a saved Jev key, `OPENAI_API_KEY`, `TYPESAFE_API_KEY`. So a key in the
 *   environment alone switches the decision model on (the operator's decision of 2026-11-23),
 *   a saved key beats any environment key, and within each source OpenAI Decisions comes first.
 */
export function effectiveDecisionProvider(
  config: { decisionProvider: VoiceDecisionProvider | null },
  keys: VoiceKeyAvailability,
): VoiceKeyProvider | null {
  const chosen = config.decisionProvider;
  if (chosen === "off") return null;
  if (chosen !== null) return voiceKeySource(chosen, keys) ? chosen : null;
  for (const provider of VOICE_KEY_PROVIDERS) if (keys.saved[provider]) return provider;
  for (const provider of VOICE_KEY_PROVIDERS) if (keys.environment[provider]) return provider;
  return null;
}

/**
 * `GET /api/voice/decision-key`: the provider in use and where each provider's key comes from.
 * Never a key, or any part of one.
 */
export interface VoiceDecisionKeyReport {
  /** The provider the model step asks first, or null when routing goes straight to the job. */
  provider: VoiceKeyProvider | null;
  keys: Record<VoiceKeyProvider, { source: VoiceKeySource }>;
  /** Sources describe keys usable for routing even when saved credentials cannot be inspected. */
  savedKeysUnavailable?: true;
}

export function voiceDecisionKeyReport(
  config: { decisionProvider: VoiceDecisionProvider | null },
  keys: VoiceKeyAvailability,
): VoiceDecisionKeyReport {
  return {
    provider: effectiveDecisionProvider(config, keys),
    keys: {
      openai: { source: voiceKeySource("openai", keys) },
      jev: { source: voiceKeySource("jev", keys) },
    },
  };
}

/** The bounds on a key as typed. Both providers' keys are single tokens well inside these. */
export const VOICE_KEY_LIMITS = { minChars: 8, maxChars: 512 } as const;

/** `PUT /api/voice/decision-key`: save one provider's key. The other provider's key stays. */
export const VoiceDecisionKeyPutSchema = z.object({
  provider: z.enum(VOICE_KEY_PROVIDERS),
  key: z.string().trim().min(VOICE_KEY_LIMITS.minChars).max(VOICE_KEY_LIMITS.maxChars)
    .regex(/^[\x21-\x7e]+$/, "A key is one word of printable characters."),
}).strict();

/** `DELETE /api/voice/decision-key?provider=`: remove one provider's saved key. */
export const VoiceDecisionKeyProviderSchema = z.enum(VOICE_KEY_PROVIDERS);

// ---- questions and answers ----

/** One thing a question may be answered with: a roster key, an option id, or a split verdict. */
export interface VoiceChoice {
  id: string;
  /** What the choice is called: an agent's spoken name, an option's label. */
  label: string;
  /** One line that tells two choices apart: an agent's role, an option's description. */
  detail: string;
}

/** A split question's two verdicts. */
export const VOICE_SPLIT_CHOICES = ["split", "mention"] as const;
export type VoiceSplitChoice = (typeof VOICE_SPLIT_CHOICES)[number];

/**
 * One question the model step answers.
 *
 * - `who`: the heard name is in doubt; which candidate was addressed. Never asked for an exact
 *   first-word name (the first-word rule, spike S3).
 * - `split`: the utterance addresses `first` and later names `second`; does `second` start a
 *   message of its own (`split`), or is it only talked about in the message to `first`
 *   (`mention`). The target `first` is fixed and is not a choice.
 * - `option`: a loosely worded answer to a card; which of its options it chooses (Phase 13).
 */
export type VoiceQuestion =
  | { kind: "who"; text: string; candidates: readonly VoiceChoice[] }
  | { kind: "split"; text: string; first: VoiceChoice; second: VoiceChoice; nameOffset?: number }
  | { kind: "option"; text: string; prompt: string; options: readonly VoiceChoice[] };

/** The ids a question may be answered with. Anything else is not an answer. */
export function voiceQuestionChoices(question: VoiceQuestion): readonly string[] {
  switch (question.kind) {
    case "who": return question.candidates.map((candidate) => candidate.id);
    case "split": return VOICE_SPLIT_CHOICES;
    case "option": return question.options.map((option) => option.id);
  }
}

/**
 * One answer. `choice` is null for "not sure": the model said so, its confidence was below the
 * rung's floor, it named something that is not one of the question's choices, or no rung
 * answered in time.
 */
export interface VoiceQuestionAnswer {
  choice: string | null;
  confidence: number;
}

/** Which rung answered. `none` means nothing did, and every answer is "not sure". */
export const VOICE_DECISION_RUNGS = ["openai", "jev", "job", "none"] as const;
export type VoiceDecisionRung = (typeof VOICE_DECISION_RUNGS)[number];

export interface VoiceDecisionResult {
  rung: VoiceDecisionRung;
  /** One per question, in question order. */
  answers: VoiceQuestionAnswer[];
  /** What happened, for Recently heard: the rung, the runner, and why a rung was passed over. */
  detail: string;
}

/**
 * Keep an answer only when it is one of the question's choices and at or above `floor`.
 *
 * Membership is checked before confidence and on every rung: in the spike a model gave a
 * nonexistent option confidence 1.0, so confidence alone was unsafe even at its maximum.
 */
export function acceptVoiceAnswer(
  question: VoiceQuestion,
  raw: { choice: unknown; confidence: unknown } | null | undefined,
  floor: number,
): VoiceQuestionAnswer {
  const confidence = typeof raw?.confidence === "number" && raw.confidence >= 0 && raw.confidence <= 1
    ? raw.confidence
    : 0;
  const choice = typeof raw?.choice === "string" ? raw.choice : null;
  if (choice === null || !voiceQuestionChoices(question).includes(choice) || confidence < floor) {
    return { choice: null, confidence };
  }
  if (question.kind === "who") {
    const selected = question.candidates.find(candidate => candidate.id === choice)!;
    const name = normalizeSpokenName(selected.label);
    if (question.candidates.some(candidate => candidate.id !== choice && normalizeSpokenName(candidate.label) === name)) {
      return { choice: null, confidence };
    }
  }
  return { choice, confidence };
}

/** Every answer "not sure". */
export function voiceAnswersUnsure(questions: readonly VoiceQuestion[]): VoiceQuestionAnswer[] {
  return questions.map(() => ({ choice: null, confidence: 0 }));
}

// ---- the budget ----

/**
 * The whole model step's deadline, from the moment routing hands an utterance to it: process
 * start and every earlier rung included (spike S7). A later rung gets only what is left, and
 * an answer after it is never acted on.
 */
export const VOICE_MODEL_STAGE_DEADLINE_MS = 5_000;

/**
 * The most a decision provider may take of that budget, so a provider that hangs still leaves
 * the job a usable share. Both providers answer typed questions without a reasoning pass; a
 * provider that has not answered by then is treated as failed and the job runs.
 */
export const VOICE_DECISION_PROVIDER_TIMEOUT_MS = 2_000;

/** A card is published as `resolving` once the model step has taken this long. */
export const VOICE_RESOLVING_AFTER_MS = 1_000;

/**
 * The confidence floor for the decision providers and for Luna: the spike's 0.98 (S7), at which
 * Luna accepted 56 of 60 with no wrong choice. Neither decision API can abstain, so this floor is
 * how they say "not sure". It is an in-sample choice on synthetic text, not a calibration.
 */
export const VOICE_CONFIDENCE_FLOOR = 0.98;

/**
 * Whether the `voice-routing` job may run on each provider, and the confidence it must reach
 * there. Shared, so Voice settings says what routing does without a key and cannot disagree.
 *
 * Codex runs Luna: GO in the spike at 0.98 with membership validation (S7), unchanged here.
 *
 * Claude runs Haiku. The spike's general-routing prompt was NO-GO, and the operator ruled
 * (2026-11-23) that the rung ships enabled only if a retest of an improved prompt passes a
 * held-out corpus: no wrong accepted answer, at least 80% accepted, and every call inside the
 * five-second deadline. The retest passed on accuracy and coverage and missed on the deadline
 * (one call of 60 took 8.9 seconds), so the rung ships off, with the floor it would use. See
 * `docs/voice-spike-findings.md`, "S7 addendum: Haiku retest". Off, a sentence to Claude
 * sessions that the names could not settle shows the roster rows, exactly as with no rung at
 * all; Luna is never substituted for Claude sessions.
 */
export const VOICE_ROUTING_JOB_RUNGS: Record<LlmRunnerId, { enabled: boolean; floor: number; why: string }> = {
  claude: { enabled: false, floor: 0.9, why: "Haiku routing is off: its retest missed the five-second deadline" },
  codex: { enabled: true, floor: VOICE_CONFIDENCE_FLOOR, why: "" },
};

/** The model each provider's job runs by default, as a person reads it. */
const VOICE_ROUTING_MODEL_NAME: Record<LlmRunnerId, { model: string; agents: string }> = {
  claude: { model: "Haiku", agents: "Claude" },
  codex: { model: "Luna", agents: "Codex" },
};

/** What routing does with no decision model: the job rungs that are on, or the roster rows. */
export function voiceRoutingWithoutProvider(rungs = VOICE_ROUTING_JOB_RUNGS): string {
  const on = (Object.keys(rungs) as LlmRunnerId[]).filter((runner) => rungs[runner].enabled);
  if (on.length === Object.keys(rungs).length) return `routing uses ${on.map((r) => VOICE_ROUTING_MODEL_NAME[r].model).join(" or ")}`;
  if (on.length === 0) return "routing shows the candidates for you to pick";
  const parts = on.map((r) => `${VOICE_ROUTING_MODEL_NAME[r].model} for ${VOICE_ROUTING_MODEL_NAME[r].agents} sessions`);
  const off = (Object.keys(rungs) as LlmRunnerId[]).filter(r => !rungs[r].enabled);
  const manual = off.map(r => VOICE_ROUTING_MODEL_NAME[r].agents).join(" and ");
  return `routing uses ${parts.join(" and ")}. ${manual} sessions show roster choices. Mixed rosters use the Voice routing job if its model is enabled, or show roster choices.`;
}
