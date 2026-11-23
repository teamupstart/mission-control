import { z } from "zod";
import { envVar } from "../../shared/harness-runtime.mjs";
import type { VoiceKeyProvider, VoiceQuestion } from "@shared/voice-decide.ts";
import { VOICE_NOT_SURE, voiceChoiceId, voiceChoiceValues, voiceQuestionInstructions, voiceQuestionName } from "./decide-prompt.ts";

// The two decision-model providers (contract E), each one HTTPS request per utterance carrying
// every question it needs. Both answer a typed `choice` question with a choice and a confidence,
// and neither can abstain, so "not sure" is the confidence floor the decider applies, after it
// has checked the answer is one of the question's choices.
//
// Wire formats, as each provider documents them (read 2026-11-23):
// - OpenAI Decisions: `POST https://api.openai.com/v1/decisions` with a bearer key; body
//   `{ model, input, questions: [{ type: "choice", name, instructions, choices: [{ value,
//   description }] }] }`; answers come back in question order as `{ type: "choice", choice,
//   confidence, probabilities }` or `{ type: "refusal" }`. `gpt-6-luna` is the only model.
// - Jev: `POST https://api.typesafe.ai/v1/systemone` with a bearer key; body `{ model, state,
//   questions: { <name>: { type: "choice", instructions, criteria: { <value>: <description> } } } }`;
//   answers come back keyed by name as `{ type: "choice", choice, confidence, probabilities }`.
//   The model is pinned to a version, never the moving `jev-latest` alias.
//
// The base URLs can be pointed elsewhere (`MISSION_VOICE_OPENAI_DECISIONS_URL`,
// `MISSION_VOICE_JEV_URL`), which is how the browser suite answers with a local stand-in. No
// test reaches a real provider.

/** The OpenAI Decisions model: the only one the API accepts. */
export const OPENAI_DECISIONS_MODEL = "gpt-6-luna";
/** The Jev model, pinned to a version so an alias moving under us cannot change routing. */
export const JEV_MODEL = "jev-1.14.0";

const DEFAULT_BASE_URL: Record<VoiceKeyProvider, string> = {
  openai: "https://api.openai.com",
  jev: "https://api.typesafe.ai",
};

const BASE_URL_ENV: Record<VoiceKeyProvider, string> = {
  openai: "VOICE_OPENAI_DECISIONS_URL",
  jev: "VOICE_JEV_URL",
};

/** A provider's base URL: the override when one is set, else the provider's own. */
export function decisionProviderBaseUrl(provider: VoiceKeyProvider): string {
  return (envVar(BASE_URL_ENV[provider]) ?? DEFAULT_BASE_URL[provider]).replace(/\/+$/, "");
}

/** One raw answer per question, choices mapped back to ids; null for a refusal or "not sure". */
export type RawVoiceAnswers = { choice: string | null; confidence: number }[];

export interface DecisionProviderCall {
  key: string;
  signal: AbortSignal;
  fetch?: typeof fetch;
}

export interface DecisionProviderAdapter {
  id: VoiceKeyProvider;
  ask(questions: readonly VoiceQuestion[], call: DecisionProviderCall): Promise<RawVoiceAnswers>;
}

/** A provider call that did not produce answers. Its message never carries the key. */
export class DecisionProviderError extends Error {
  constructor(readonly provider: VoiceKeyProvider, message: string, readonly status: number | null = null) {
    super(message);
    this.name = "DecisionProviderError";
  }
}

const NOT_SURE_DESCRIPTION = "The words do not settle it.";

/** What both providers are told the shared content is: the speech, once. */
export function decisionInput(questions: readonly VoiceQuestion[]): string {
  return `Speech a person said to a team of AI agents: ${JSON.stringify(questions[0]?.text ?? "")}`;
}

function choicesFor(question: VoiceQuestion): { value: string; description: string }[] {
  return [
    ...voiceChoiceValues(question).map((choice) => ({ value: choice.value, description: choice.detail || choice.value })),
    { value: VOICE_NOT_SURE, description: NOT_SURE_DESCRIPTION },
  ];
}

function mapChoice(question: VoiceQuestion, value: unknown): string | null {
  if (typeof value !== "string" || value === VOICE_NOT_SURE) return null;
  return voiceChoiceId(question, value);
}

async function post(
  provider: VoiceKeyProvider,
  path: string,
  body: unknown,
  call: DecisionProviderCall,
): Promise<unknown> {
  const doFetch = call.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(`${decisionProviderBaseUrl(provider)}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${call.key}` },
      body: JSON.stringify(body),
      signal: call.signal,
    });
  } catch {
    throw new DecisionProviderError(provider, call.signal.aborted ? "request failed: timed out" : "request failed");
  }
  if (!response.ok) {
    // Provider diagnostics may include the supplied credential. Keep only the status.
    await response.body?.cancel();
    throw new DecisionProviderError(provider, `HTTP ${response.status}`, response.status);
  }
  try {
    return await response.json();
  } catch {
    throw new DecisionProviderError(provider, "the reply is not JSON", response.status);
  }
}

const ChoiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.union([z.string(), z.boolean()]),
  confidence: z.number(),
}).loose();
const RefusalAnswerSchema = z.object({ type: z.literal("refusal") }).loose();
const OpenAiAnswerSchema = z.union([ChoiceAnswerSchema, RefusalAnswerSchema]);
const OpenAiReplySchema = z.object({ answers: z.array(z.unknown()) }).loose();
const JevReplySchema = z.object({ answers: z.record(z.string(), z.unknown()) }).loose();

function readChoice(question: VoiceQuestion, raw: unknown): { choice: string | null; confidence: number } {
  const parsed = OpenAiAnswerSchema.safeParse(raw);
  if (!parsed.success || parsed.data.type !== "choice") return { choice: null, confidence: 0 };
  const answer = parsed.data as z.infer<typeof ChoiceAnswerSchema>;
  return { choice: mapChoice(question, answer.choice), confidence: answer.confidence };
}

export const openAiDecisions: DecisionProviderAdapter = {
  id: "openai",
  async ask(questions, call) {
    const reply = await post("openai", "/v1/decisions", {
      model: OPENAI_DECISIONS_MODEL,
      input: decisionInput(questions),
      questions: questions.map((question, index) => ({
        type: "choice",
        name: voiceQuestionName(index),
        instructions: voiceQuestionInstructions(question),
        choices: choicesFor(question),
      })),
    }, call);
    const parsed = OpenAiReplySchema.safeParse(reply);
    if (!parsed.success || parsed.data.answers.length !== questions.length) {
      throw new DecisionProviderError("openai", "the reply does not answer every question");
    }
    return questions.map((question, index) => readChoice(question, parsed.data.answers[index]));
  },
};

export const jevDecisions: DecisionProviderAdapter = {
  id: "jev",
  async ask(questions, call) {
    const reply = await post("jev", "/v1/systemone", {
      model: JEV_MODEL,
      state: decisionInput(questions),
      questions: Object.fromEntries(questions.map((question, index) => [voiceQuestionName(index), {
        type: "choice",
        instructions: voiceQuestionInstructions(question),
        criteria: Object.fromEntries(choicesFor(question).map((choice) => [choice.value, choice.description])),
      }])),
    }, call);
    const parsed = JevReplySchema.safeParse(reply);
    const answers = parsed.success ? parsed.data.answers : null;
    if (!answers || questions.some((_, index) => !(voiceQuestionName(index) in answers))) {
      throw new DecisionProviderError("jev", "the reply does not answer every question");
    }
    return questions.map((question, index) => readChoice(question, answers[voiceQuestionName(index)]));
  },
};

export const DECISION_PROVIDERS: Record<VoiceKeyProvider, DecisionProviderAdapter> = {
  openai: openAiDecisions,
  jev: jevDecisions,
};
