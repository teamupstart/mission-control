import type { ZodTypeAny, TypeOf } from "zod";
import type { LlmJobId } from "@shared/llm-jobs.ts";
import { getLlmConfig, llmJobModel, llmRunnerChoice } from "./config.ts";
import { llmRunner } from "./index.ts";
import { runStructured } from "./structured.ts";
import type { StructuredResult } from "./structured.ts";

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

/** Options a job may set for itself. Model and runner are the config's, not the caller's. */
export interface JobRunOptions {
  /**
   * Wall-clock budget for one attempt. Every caller passes its own - see above - and a
   * runner's default is the full reviewer's 120s, which is far too generous for any of
   * these.
   */
  timeoutMs?: number;
}

/**
 * Run one background job's prompt and hand back the model's text, envelope already off.
 *
 * Rejects on spawn failure, timeout or a non-zero exit, which is what every caller here
 * already expects: each catches and falls back to the tier below rather than surfacing an
 * error, because a missing or logged-out `claude` must cost a rougher sentence and never a
 * dispatch.
 */
export function runJob(job: LlmJobId, prompt: string, opts: JobRunOptions = {}): Promise<string> {
  const cfg = getLlmConfig();
  return llmRunner(llmRunnerChoice(cfg).id).run(prompt, {
    model: llmJobModel(job, cfg).id,
    timeoutMs: opts.timeoutMs,
  });
}

/**
 * Run one background job and parse its reply, retrying once on a parse miss. Never throws.
 *
 * The config is read ONCE and both answers taken from it, so the retry cannot land on a
 * different runner or a different model than the first attempt - which would make a
 * two-attempt failure impossible to read in the log.
 */
export function runJobStructured<S extends ZodTypeAny>(
  job: LlmJobId,
  prompt: string,
  extract: (raw: string) => TypeOf<S> | null,
  label: string,
  opts: JobRunOptions = {},
): Promise<StructuredResult<TypeOf<S>>> {
  const cfg = getLlmConfig();
  const runner = llmRunner(llmRunnerChoice(cfg).id);
  const model = llmJobModel(job, cfg).id;
  return runStructured<S>(
    (p) => runner.run(p, { model, timeoutMs: opts.timeoutMs }),
    prompt,
    extract,
    label,
  );
}
