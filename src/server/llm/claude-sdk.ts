import { realpathSync } from "node:fs";
import { grantRefusal, type LlmRunOptions } from "@shared/llm.ts";
import { defaultClaudeSdkOneShotDeps } from "../harness/claude/sdk-deps.ts";
import type {
  ClaudeSdkMessage,
  ClaudeSdkOneShotDeps,
  ClaudeSdkUserMessage,
} from "../harness/claude/sdk-types.ts";
import { CLAUDE_DEFAULT_TIMEOUT_MS, HEADLESS_CWD } from "../claude-cli.ts";
import { CLAUDE_SANDBOX, claudeGrantSettings } from "./claude-grant.ts";
import { claudeImageUserMessage } from "./claude-input.ts";
import { validateLlmImages } from "./images.ts";
import { cleanupAgentSubprocessEnv } from "../agent-subprocess-env.ts";

// One fresh SDK query for one app-owned model call. This is deliberately separate from
// `harness/claude/sdk.ts`: that adapter owns a long-lived, human-reachable conversation,
// while this one owns the opposite contract, one prompt with no context before it and no
// follow-up after it.

export interface ClaudeSdkOneShotResult {
  /** Model text, or the JSON encoding of provider-validated structured output. */
  text: string;
  /** The result frame retained for the shared Claude spend projection. */
  envelope: Record<string, unknown>;
}

interface LiveRun {
  controller: AbortController;
  cancel(error: Error): void;
}

/** Controllers still capable of stopping an SDK-owned subprocess. */
const live = new Set<LiveRun>();

/** Abort every SDK one-shot this process started. */
export function killLiveClaudeSdkRuns(): void {
  for (const run of live) run.cancel(new Error("Claude Agent SDK run aborted"));
  live.clear();
}

let exitHooked = false;
function hookExitOnce(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", killLiveClaudeSdkRuns);
}

function diagnostic(error: unknown, stderr: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  const detail = stderr.trim().slice(0, 300);
  return new Error(detail ? `${message}: ${detail}` : message, { cause: error });
}

function resultFailure(frame: ClaudeSdkMessage): Error {
  const errors = Array.isArray(frame.errors)
    ? frame.errors.filter((one): one is string => typeof one === "string").join("; ")
    : "";
  const reason = typeof frame.terminal_reason === "string" ? frame.terminal_reason : "";
  const subtype = typeof frame.subtype === "string" ? frame.subtype : "error";
  return new Error(
    `Claude Agent SDK ${subtype}${reason ? ` (${reason})` : ""}${errors ? `: ${errors}` : ""}`,
  );
}

/**
 * The answer this run produced: the structured value on a schema run, the text otherwise.
 *
 * A schema run reads `structured_output` and NOTHING ELSE, deliberately. Falling back to
 * `frame.result` when it is missing was considered and rejected on three counts. It could
 * not have saved the failure this module was fixed for - `error_max_turns` carries
 * `result: null`, and the success gate in the stream loop returns before this is ever
 * called on a failed frame. It would quietly turn `guaranteesInputShape` into a promise
 * sourced from prose scraping. And `parseModelJson`'s candidate ladder takes the widest
 * `{`...`}` span in the text, over prompts that embed untrusted child-session transcripts -
 * so a verdict-shaped object planted in a reviewed transcript becomes a candidate answer.
 * A missing structured output is a real failure and throwing degrades correctly.
 */
function resultText(frame: ClaudeSdkMessage, structured: boolean): string {
  if (structured) {
    if (!("structured_output" in frame)) {
      throw new Error("Claude Agent SDK returned no structured output");
    }
    const encoded = JSON.stringify(frame.structured_output);
    if (encoded === undefined) {
      throw new Error("Claude Agent SDK returned unencodable structured output");
    }
    return encoded;
  }
  if (typeof frame.result !== "string") {
    throw new Error("Claude Agent SDK result carried no text");
  }
  return frame.result;
}

async function* oneUserMessage(
  message: ClaudeSdkUserMessage,
): AsyncGenerator<ClaudeSdkUserMessage> {
  yield message;
}

/**
 * Run one fresh Claude call through one Agent SDK `query()`.
 *
 * The SDK still starts the operator's Claude Code binary. What changes here is the wire
 * protocol and cancellation authority, not the process or the account it bills.
 */
export async function runClaudeSdkOneShot(
  prompt: string,
  opts: LlmRunOptions = {},
  deps: ClaudeSdkOneShotDeps = defaultClaudeSdkOneShotDeps,
): Promise<ClaudeSdkOneShotResult> {
  const grant = opts.grant ?? null;
  if (grant) {
    const refusal = grantRefusal(CLAUDE_SANDBOX, grant);
    // Validate again at the transport boundary, before resolving a binary or constructing
    // `query()`. `runClaudeSdkOneShot` is exported and a future caller must not be able to
    // bypass the runner's identical check and reach a partly-honoured grant.
    if (refusal) throw new Error(`Claude Agent SDK refused the tool grant: ${refusal}`);
  }
  if (
    opts.maxBudgetUsd !== undefined
    && (!Number.isFinite(opts.maxBudgetUsd) || opts.maxBudgetUsd <= 0)
  ) {
    throw new Error("Claude Agent SDK maxBudgetUsd must be a positive finite number");
  }
  // Validation opens and hashes every descriptor before the binary is resolved or a
  // provider query is constructed. Empty and omitted lists both leave the old string
  // prompt untouched.
  const images = validateLlmImages(opts.images);

  const controller = new AbortController();
  let cancelError: Error | null = null;
  let rejectCancelled: (error: Error) => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectCancelled = reject;
  });
  const run: LiveRun = {
    controller,
    cancel(error) {
      if (cancelError) return;
      cancelError = error;
      controller.abort();
      rejectCancelled(error);
    },
  };
  live.add(run);
  hookExitOnce();

  const timeoutMs = opts.timeoutMs ?? CLAUDE_DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => {
    run.cancel(new Error("Claude Agent SDK one-shot timed out"));
  }, timeoutMs);
  timer.unref?.();

  let stderr = "";
  let subprocessEnv: NodeJS.ProcessEnv | undefined;
  const execute = async (): Promise<ClaudeSdkOneShotResult> => {
    const cwd = realpathSync(grant?.cwd ?? HEADLESS_CWD);
    const executable = await deps.executable();
    if (controller.signal.aborted) {
      throw cancelError ?? new Error("Claude Agent SDK run aborted");
    }

    // `tools: []` disables every built-in tool. That is the DEFAULT here and the reason
    // this module is safe to hand untrusted text: the prompt embeds child-session
    // transcripts and repo content from a diff, the model only ever needs to emit JSON,
    // and a crafted transcript must not be able to steer it into invoking tools.
    //
    // ONE tool survives that filter, and only when `outputFormat` is set below: the CLI
    // appends `StructuredOutput` AFTER applying the tool list, so "every tool disabled" is
    // not literally true on the schema path. The safety claim above still holds, because of
    // what that one tool is - read-only, not open-world, permission-free, and it does
    // nothing but hand back the model's own answer. There is no capability there for a
    // crafted transcript to steer into. Read the sentence as "nothing that can ACT", not
    // "nothing that can be called".
    //
    // A validated grant widens that for a caller that has argued for it. Today only the
    // Inspector does. Its deny rules travel as inline flag settings, which the SDK defines
    // as the same highest-priority layer as CLI `--settings`; `settingSources: []` disables
    // filesystem settings without disabling this payload. The subprocess-boundary test
    // pins that composition so an SDK change cannot silently detach the rules.
    //
    // The OPTIONS THAT ARE NOT HERE are load-bearing, and this comment is the only thing
    // saying so. There is no `resume`, no `sessionId`, no `forkSession`: without one of
    // those, every `query()` mints a new session with an empty context. That is what makes
    // each run start clean, and it is a correctness property, not a default worth tidying
    // away.
    //
    // It matters because these reviewers inspect MANY unrelated sessions and submissions.
    // Anything that let one invocation see another's context would grow context across
    // them and let one review influence the next. A fresh `query()` per call is therefore
    // part of the result's correctness, not an optimization choice.
    //
    // `persistSession: false` is deliberately NOT passed. It would stop these runs writing
    // a transcript at all, which sounds tidy but deletes the only record of what a
    // headless run did. For this fixed cwd, `goal/prune.ts` already bounds them by age on
    // purpose; that is the considered answer, and disabling persistence would quietly make
    // it dead code. A granted Inspector run uses its worktree as cwd and therefore writes
    // outside that sweep. This is the existing override-cwd pruner gap documented beside
    // the print transport in `claude-cli.ts`; the SDK path inherits it rather than widening
    // transcript cleanup in a security-sensitive transport change.
    //
    // `realpathSync` is load-bearing on macOS, where TMPDIR is commonly a symlink. Claude
    // records the resolved cwd in its encoded project path, and `headlessTranscriptDir()`
    // resolves the same value before sweeping. Passing the unresolved spelling would make
    // the test seam and the pruner disagree about where this run belongs.
    subprocessEnv = deps.env(cwd);
    const query = await deps.query({
      prompt: images.length === 0
        ? prompt
        : oneUserMessage(claudeImageUserMessage(prompt, images)),
      options: {
        tools: grant ? [...grant.tools] : [],
        ...(grant ? { settings: claudeGrantSettings(grant) } : {}),
        settingSources: [],
        // What each of the three shapes of run here costs in turns. The claim that used to
        // stand here - that a tool-less one-shot "can and should finish in one turn" - was
        // true only of the third, and applying it to the second shipped a P0: 4 of 6 small
        // prompts and 1 of 1 at a realistic 198 KB died `error_max_turns`, and 6 of 8 live
        // workflow context compactions silently degraded to `status:"fallback"`.
        //
        // A GRANT gets no cap at all. An Inspector review's first assistant turn commonly
        // asks Read/Grep/Glob, and the tool result has to reach a later assistant turn
        // before a verdict exists; there is no honest number to guess, and its wall-clock
        // timeout is the real bound. Note the Inspector sends a grant AND a schema, so this
        // branch also covers everything below.
        //
        // A SCHEMA costs THREE, and the budget is measured rather than guessed.
        // `outputFormat: { type: "json_schema" }` below is settled only by a
        // `StructuredOutput` call, and disassembling the CLI this actually runs gives three.
        // Which binary that is matters: `sdk-deps.ts` pins the OPERATOR's installed `claude`
        // (2.1.228 when this was measured), never the CLI bundled inside
        // `@anthropic-ai/claude-agent-sdk`, whose own code here only serializes flags - so
        // reading the npm package to predict this behaviour answers about the wrong build.
        //   1. the model answers in prose, because nothing forces the tool up front;
        //   2. `[structured-output-enforce]` is injected, AT MOST ONCE per real user turn -
        //      an explicit already-enforced sentinel means there is no enforcement loop to
        //      leave room for;
        //   3. one Ajv revalidation, because an ERRORED `StructuredOutput` result does not
        //      end the turn. Live here rather than theoretical: every schema
        //      `providerJsonSchema` renders falls back to NON-strict on `minLength` /
        //      `minimum` / `maximum` / `default` (8 such fields in `QueueVerdictSchema`, 4
        //      in `TriageReportSchema`, 2 in `BacklogReportSchema`), so the provider is left
        //      unconstrained while the tool still Ajv-validates the whole schema.
        // `maxTurns: 2` measured 6/6 and 2/2 only because it never reached step 3.
        //
        // EVERYTHING ELSE costs one, and that is the shape the old claim was actually true
        // of: with no grant there is no tool result to wait for, and with no schema there is
        // no enforcement or revalidation to pay for.
        //
        // Explicit rather than omitted, on purpose. The SDK does bound this path itself
        // (`error_max_structured_output_retries` / `structured_output_retry_exhausted`,
        // sdk.d.ts:4271 and :6909), but every number above is an undocumented vendor
        // internal on a surface that has already moved, and this block exists to say which
        // bounds are OURS. Inheriting theirs silently would make the next move invisible
        // from here.
        ...(grant ? {} : { maxTurns: opts.schema ? 3 : 1 }),
        cwd,
        pathToClaudeCodeExecutable: executable,
        // A headless Claude run fires the same machine-installed hooks as an interactive
        // one. Strip every inherited pane identity and add the independent marker that
        // lets a current hook decline the event entirely. Both layers matter because the
        // installed hook may come from an older checkout.
        env: { ...subprocessEnv, MISSION_HEADLESS: "1" },
        abortController: controller,
        stderr: (data) => {
          stderr = (stderr + data).slice(-4_096);
        },
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.maxBudgetUsd !== undefined ? { maxBudgetUsd: opts.maxBudgetUsd } : {}),
        ...(opts.schema
          ? { outputFormat: { type: "json_schema" as const, schema: opts.schema } }
          : {}),
      },
    });

    for await (const frame of query) {
      if (frame.type !== "result") continue;
      if (frame.subtype !== "success" || frame.is_error === true) {
        throw resultFailure(frame);
      }
      return {
        text: resultText(frame, opts.schema !== undefined),
        envelope: frame,
      };
    }
    throw new Error("Claude Agent SDK stream ended without a result");
  };

  try {
    return await Promise.race([execute(), cancelled]);
  } catch (error) {
    if (cancelError) throw cancelError;
    throw diagnostic(error, stderr);
  } finally {
    clearTimeout(timer);
    live.delete(run);
    cleanupAgentSubprocessEnv(subprocessEnv);
  }
}
