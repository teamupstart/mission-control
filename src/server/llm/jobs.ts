import type { ZodTypeAny, TypeOf } from "zod";
import type { LlmJobId } from "@shared/llm-jobs.ts";
import type { LlmConfig } from "@shared/protocol.ts";
import type { LlmRunnerId } from "@shared/llm.ts";
import { getLlmConfig, llmJobModel, llmJobRunner } from "./config.ts";
import { llmRunner } from "./index.ts";
import { runStructured } from "./structured.ts";
import type { StructuredAttemptObserver, StructuredResult } from "./structured.ts";

// How the daemon's own background work asks a model something.
//
// One call per JOB, not per provider and not per model id, because the three questions a
// call site used to answer for itself - which provider, which model, and what to do with a
// reply that will not parse - are exactly the three it has no business deciding. `runJob`
// resolves the first two off the config (`llm/config.ts`) at the moment of the call, so an
// operator's edit in Settings takes effect on the next titling rather than the next daemon
// restart; the third is `runStructured`'s.
//
// What a caller keeps is its own TIMEOUT, and that is deliberate. A budget is a property of
// the prompt - three sentences over a short list is not a 12-turn window - and every one of
// them is separately documented and separately overridable. Folding them in here would make
// them one number that fitted none of the three.
//
// The failure contract is unchanged from what these callers had: every one of them degrades
// silently to a deterministic tier (the first-line title, the heuristic goal, the rollup),
// so `runJob` REJECTS on a spawn/timeout/exit failure exactly as `runClaudeText` did, and
// `runJobStructured` never throws.

/**
 * The pair a call ACTUALLY ran on, post-guard.
 *
 * Handed back rather than left inside, because a caller that has to record what ran - the
 * `llm_calls` ledger, a persisted compaction stamp - otherwise has no way to obtain it and
 * re-derives it from a second config read. That was merely redundant while the answer was
 * app-wide; with a provider per job it is systematically wrong, since the re-derived label
 * names the app-wide provider while the call used the job's own. It also cannot express the
 * one thing only the callee knows: that `guardProviderModel` substituted a fallback.
 *
 * Resolution stays INSIDE the callee. A caller-supplied execution would hand every call site
 * its own chance to resolve differently, which is the drift these functions' own comment
 * ("Model and runner are the config's, not the caller's") exists to prevent.
 */
export interface JobExecution {
  runner: LlmRunnerId;
  model: string;
}

/** What `runJob` hands back: the text, and what produced it. */
export interface JobTextResult {
  text: string;
  execution: JobExecution;
}

/** Options a job may set for itself. Model and runner are the config's, not the caller's. */
export interface JobRunOptions {
  /**
   * Wall-clock budget for one attempt. Every caller passes its own - see above - and a
   * runner's default is the full reviewer's 120s, which is far too generous for any of
   * these.
   */
  timeoutMs?: number;
  observer?: StructuredAttemptObserver;
}

/** Structured-only options kept off `runJob`, whose callers ask for unconstrained text. */
export interface StructuredJobRunOptions extends JobRunOptions {
  /** The already-rendered provider input schema. Caller-side parsing remains mandatory. */
  schema?: Record<string, unknown>;
  /** Trim the syntax retry only when this call site's rendered schema is faithful. */
  shapeGuaranteed?: boolean;
  /** Limit executions independently of provider schema support when the caller owns retries. */
  maxAttempts?: 1 | 2;
  /**
   * Told the resolved pair ONCE, before the first attempt spends anything.
   *
   * For the caller that has to write a row describing a call while it is still in flight -
   * `llm_calls` inserts at `observer.start` and closes at `finish`. The return value carries
   * the same pair, but it arrives too late for that row, and a caller that resolved its own
   * label instead would print the app-wide provider next to a call that used the job's.
   */
  onExecution?: (execution: JobExecution) => void;
}

/**
 * Run one background job's prompt and hand back the model's text, envelope already off.
 *
 * Rejects on spawn failure, timeout or a non-zero exit, which is what every caller here
 * already expects: each catches and falls back to the tier below rather than surfacing an
 * error, because a missing or logged-out `claude` must cost a rougher sentence and never a
 * dispatch.
 */
export async function runJob(
  job: LlmJobId,
  prompt: string,
  opts: JobRunOptions = {},
): Promise<JobTextResult> {
  const cfg = getLlmConfig();
  const execution = jobExecution(job, cfg);
  const text = await llmRunner(execution.runner).run(prompt, {
    model: execution.model,
    timeoutMs: opts.timeoutMs,
  });
  return { text, execution };
}

/**
 * The provider and the model for one call, resolved together off ONE config read.
 *
 * Together, because they are one decision: the model ladder's fallback and
 * `guardProviderModel`'s verdict both depend on which provider won, so resolving them from
 * two reads is how a Claude id ends up handed to Codex. Once, because the config is editable
 * at runtime and a structured retry must land on the same pair as its first attempt.
 */
function jobExecution(job: LlmJobId, cfg: LlmConfig): JobExecution {
  const runner = llmJobRunner(job, cfg).id;
  return { runner, model: llmJobModel(job, cfg, runner).id };
}

/**
 * Run one background job and parse its reply, retrying once on a parse miss. Never throws.
 *
 * The config is read ONCE and both answers taken from it, so the retry cannot land on a
 * different runner or a different model than the first attempt - which would make a
 * two-attempt failure impossible to read in the log.
 */
export async function runJobStructured<S extends ZodTypeAny>(
  job: LlmJobId,
  prompt: string,
  extract: (raw: string) => TypeOf<S> | null,
  label: string,
  opts: StructuredJobRunOptions = {},
): Promise<StructuredResult<TypeOf<S>> & { execution: JobExecution }> {
  const cfg = getLlmConfig();
  const execution = jobExecution(job, cfg);
  opts.onExecution?.(execution);
  const runner = llmRunner(execution.runner);
  const result = await runStructured<S>(
    (p) =>
      runner.run(p, { model: execution.model, timeoutMs: opts.timeoutMs, schema: opts.schema }),
    prompt,
    extract,
    label,
    opts.observer,
    {
      maxAttempts: opts.maxAttempts,
      shapeGuaranteed:
        opts.shapeGuaranteed && runner.structuredOutput?.guaranteesInputShape === true,
    },
  );
  // On the failed branch too. A caller recording what it TRIED - the `llm_calls` row, the
  // fallback compaction stamp - needs the pair exactly as much as one recording what worked.
  return { ...result, execution };
}
