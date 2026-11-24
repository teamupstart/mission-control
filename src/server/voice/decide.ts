import { z } from "zod";
import type { LlmRunnerId } from "@shared/llm.ts";
import type { AgentType } from "@shared/types.ts";
import type { VoiceConfig } from "@shared/voice.ts";
import {
  acceptVoiceAnswer,
  effectiveDecisionProvider,
  VOICE_CONFIDENCE_FLOOR,
  VOICE_DECISION_PROVIDER_TIMEOUT_MS,
  VOICE_KEY_PROVIDER_LABEL,
  VOICE_MODEL_STAGE_DEADLINE_MS,
  VOICE_ROUTING_JOB_RUNGS,
  voiceAnswersUnsure,
  type VoiceDecisionResult,
  type VoiceKeyProvider,
  type VoiceQuestion,
  type VoiceQuestionAnswer,
} from "@shared/voice-decide.ts";
import { llmJobRunner } from "../llm/config.ts";
import { runJobStructured } from "../llm/jobs.ts";
import { createLimiter, parseModelReply } from "../llm/structured.ts";
import { decisionKeyAvailability, decisionKeyFor, savedDecisionKeys } from "./decision-key.ts";
import { buildVoiceRoutingPrompt, parseVoiceRoutingReply, VOICE_ROUTING_SYSTEM_PROMPT, voiceRoutingSchema } from "./decide-prompt.ts";
import { DECISION_PROVIDERS, type DecisionProviderAdapter, type RawVoiceAnswers } from "./decision-providers.ts";
import { getVoiceConfig } from "./config.ts";

// The model step (contract E): `VoiceDecider.ask(questions)` answers who, split and option
// questions, each with a choice and a confidence, by a ladder of rungs under one deadline.
//
// 1. The effective decision provider (`effectiveDecisionProvider`), when one has a key: one
//    HTTPS request. A provider error or timeout falls to the job; an answer it was not sure of
//    is an answer, and does not.
// 2. The `voice-routing` background job with thinking off and its own short system prompt, on
//    Claude when every agent involved is a Claude session, on Codex when every one is a Codex
//    session, otherwise on the provider chosen for background jobs. A job error or timeout is
//    "not sure".
// 3. None: every answer "not sure", and routing shows the roster rows. Never an error.
//
// Every rung's answer is checked against the question's own choices before its confidence is
// read, and the whole step, process start and earlier rungs included, has
// `VOICE_MODEL_STAGE_DEADLINE_MS`. A later rung gets only what is left, and an answer that
// arrives after the deadline is dropped rather than acted on.

export interface VoiceAskOptions {
  /** The harness of every agent the questions are about: it chooses the job's provider. */
  agents: readonly AgentType[];
  signal?: AbortSignal;
  /** Monotonic start of the model stage, shared by dependent questions from one capture. */
  startedAt?: number;
}

export interface VoiceDecider {
  ask(questions: readonly VoiceQuestion[], options?: VoiceAskOptions): Promise<VoiceDecisionResult>;
}

export { VOICE_ROUTING_JOB_RUNGS };

/** The provider the job runs on for these agents: theirs when they share one, else the job's. */
export function voiceRoutingRunner(agents: readonly AgentType[], jobRunner: LlmRunnerId): LlmRunnerId {
  if (agents.length > 0 && agents.every((agent) => agent === "claude")) return "claude";
  if (agents.length > 0 && agents.every((agent) => agent === "codex")) return "codex";
  return jobRunner;
}

/** What the job is handed: the provider it runs on, and the time left in the step. */
export type VoiceRoutingJob = (
  questions: readonly VoiceQuestion[],
  run: { runner: LlmRunnerId; timeoutMs: number; signal?: AbortSignal },
) => Promise<RawVoiceAnswers>;

/** The job's whole reply. Choices are free strings here; membership is checked after mapping. */
const VoiceRoutingReplySchema = z.object({
  answers: z.record(z.string(), z.object({ choice: z.string(), confidence: z.number() }).loose()),
}).loose();

/** One call that needs a slot waits for it inside the step's deadline, never outside it. */
const jobLimit = createLimiter(2);

/**
 * The job as the daemon runs it: one attempt, thinking off, schema enforced by the provider.
 * The budget is counted from the call, so a call that waited for a slot gets only what is left,
 * and one whose budget ran out while it waited starts no process at all.
 */
export const runVoiceRoutingJob: VoiceRoutingJob = (questions, run) => {
  const until = performance.now() + run.timeoutMs;
  return jobLimit(() => {
    run.signal?.throwIfAborted();
    return runVoiceRoutingJobNow(questions, run.runner, until - performance.now(), run.signal);
  });
};

async function runVoiceRoutingJobNow(
  questions: readonly VoiceQuestion[],
  runner: LlmRunnerId,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<RawVoiceAnswers> {
  if (timeoutMs <= 0) throw new Error("timed out waiting for a slot");
  const result = await runJobStructured(
    "voice-routing",
    buildVoiceRoutingPrompt(questions),
    (raw) => parseModelReply(raw, VoiceRoutingReplySchema),
    "Voice routing",
    {
      runner,
      signal,
      timeoutMs,
      schema: voiceRoutingSchema(questions),
      shapeGuaranteed: true,
      maxAttempts: 1,
      systemPrompt: VOICE_ROUTING_SYSTEM_PROMPT,
    },
  );
  if (result.kind === "failed") throw new Error(result.reason);
  const answers = parseVoiceRoutingReply(result.value, questions);
  if (!answers) throw new Error("the reply does not answer the questions");
  return answers;
}

export interface VoiceDeciderDeps {
  config(): Pick<VoiceConfig, "decisionProvider">;
  savedKeys(): Partial<Record<VoiceKeyProvider, string>>;
  env(): NodeJS.ProcessEnv;
  providers: Record<VoiceKeyProvider, DecisionProviderAdapter>;
  job: VoiceRoutingJob;
  /** The provider chosen for background jobs, for agents that do not share one. */
  jobRunner(): LlmRunnerId;
  rungs?: typeof VOICE_ROUTING_JOB_RUNGS;
  fetch?: typeof fetch;
  now?(): number;
  deadlineMs?: number;
  providerTimeoutMs?: number;
}

class Expired extends Error {}

/** Race `work` against the absolute deadline `at`; at the deadline it rejects with `Expired`. */
function within<T>(work: (signal: AbortSignal) => Promise<T>, at: number, now: () => number, signal?: AbortSignal): Promise<T> {
  const left = at - now();
  if (left <= 0) return Promise.reject(new Expired());
  const controller = new AbortController();
  const workSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const expiry = new Promise<never>((_, reject) => {
    if (signal) {
      onAbort = () => reject(new Error("cancelled"));
      signal.addEventListener("abort", onAbort, { once: true });
    }
    timer = setTimeout(() => reject(new Expired()), left);
    timer.unref?.();
  });
  const start = () => {
    signal?.throwIfAborted();
    if (now() >= at) throw new Expired();
    return work(workSignal);
  };
  return Promise.race([Promise.resolve().then(start), expiry]).then((value) => {
    signal?.throwIfAborted();
    if (now() >= at) throw new Expired();
    return value;
  }).catch(error => {
    controller.abort(error);
    throw error;
  }).finally(() => {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  });
}

function describe(error: unknown): string {
  if (error instanceof Expired) return "timed out";
  const message = error instanceof Error ? error.message : String(error);
  const flat = message.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat;
}

function accept(questions: readonly VoiceQuestion[], raw: RawVoiceAnswers, floor: number): VoiceQuestionAnswer[] {
  return questions.map((question, index) => acceptVoiceAnswer(question, raw[index], floor));
}

/** The daemon's decider over injectable rungs; `defaultVoiceDecider` wires the real ones. */
export function createVoiceDecider(deps: VoiceDeciderDeps): VoiceDecider {
  const now = deps.now ?? (() => performance.now());
  const rungs = deps.rungs ?? VOICE_ROUTING_JOB_RUNGS;
  return {
    async ask(questions, options = { agents: [] }) {
      if (questions.length === 0) return { rung: "none", answers: [], detail: "no questions" };
      const startedAt = Math.min(options.startedAt ?? Infinity, now());
      const deadline = startedAt + (deps.deadlineMs ?? VOICE_MODEL_STAGE_DEADLINE_MS);
      const notes: string[] = [];
      const { signal } = options;

      const saved = deps.savedKeys();
      const env = deps.env();
      const provider = effectiveDecisionProvider(deps.config(), decisionKeyAvailability(saved, env));
      const key = provider ? decisionKeyFor(provider, saved, env) : null;
      if (provider && key) {
        const label = VOICE_KEY_PROVIDER_LABEL[provider];
        const providerDeadline = Math.min(deadline, startedAt + (deps.providerTimeoutMs ?? VOICE_DECISION_PROVIDER_TIMEOUT_MS));
        try {
          const raw = await within(
            requestSignal => deps.providers[provider].ask(questions, { key, signal: requestSignal, fetch: deps.fetch }),
            providerDeadline,
            now,
            signal,
          );
          return { rung: provider, answers: accept(questions, raw, VOICE_CONFIDENCE_FLOOR), detail: `${label} answered` };
        } catch (error) {
          notes.push(`${label} ${describe(error)}`);
        }
      }

      if (signal?.aborted) return { rung: "none", answers: voiceAnswersUnsure(questions), detail: "cancelled" };
      const runner = voiceRoutingRunner(options.agents, deps.jobRunner());
      const rung = rungs[runner];
      if (!rung.enabled) {
        notes.push(`job on ${runner} not run: ${rung.why}`);
        return { rung: "none", answers: voiceAnswersUnsure(questions), detail: notes.join("; ") };
      }
      try {
        const raw = await within(jobSignal => deps.job(questions, {
          runner, timeoutMs: Math.max(0, Math.floor(deadline - now())), signal: jobSignal,
        }), deadline, now, signal);
        notes.push(`job on ${runner} answered`);
        return { rung: "job", answers: accept(questions, raw, rung.floor), detail: notes.join("; ") };
      } catch (error) {
        notes.push(`job on ${runner} ${error instanceof Expired ? "timed out" : "failed"}`);
        return { rung: "none", answers: voiceAnswersUnsure(questions), detail: notes.join("; ") };
      }
    },
  };
}

/** The real rungs: the saved keys, the daemon's environment, both providers and the job. */
export function defaultVoiceDecider(): VoiceDecider {
  return createVoiceDecider({
    config: () => getVoiceConfig(),
    savedKeys: () => savedDecisionKeys() ?? {},
    env: () => process.env,
    providers: DECISION_PROVIDERS,
    job: runVoiceRoutingJob,
    jobRunner: () => llmJobRunner("voice-routing").id,
  });
}
