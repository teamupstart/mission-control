import { realpathSync } from "node:fs";
import type { LlmRunOptions } from "@shared/llm.ts";
import { defaultClaudeSdkOneShotDeps } from "../harness/claude/sdk-deps.ts";
import type {
  ClaudeSdkMessage,
  ClaudeSdkOneShotDeps,
} from "../harness/claude/sdk-types.ts";
import { CLAUDE_DEFAULT_TIMEOUT_MS, HEADLESS_CWD } from "../claude-cli.ts";

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

/**
 * Run one tool-less Claude call through one Agent SDK `query()`.
 *
 * The SDK still starts the operator's Claude Code binary. What changes here is the wire
 * protocol and cancellation authority, not the process or the account it bills.
 */
export async function runClaudeSdkOneShot(
  prompt: string,
  opts: LlmRunOptions = {},
  deps: ClaudeSdkOneShotDeps = defaultClaudeSdkOneShotDeps,
): Promise<ClaudeSdkOneShotResult> {
  // Phase 3 owns translating the Inspector's provider-enforced deny rules. Refuse before
  // resolving a binary or constructing `query()`: silently dropping a grant would run an
  // untrusted review under a weaker sandbox than its caller requested.
  if (opts.grant) {
    throw new Error("Claude Agent SDK tool grants are not implemented until phase 3");
  }
  if (
    opts.maxBudgetUsd !== undefined
    && (!Number.isFinite(opts.maxBudgetUsd) || opts.maxBudgetUsd <= 0)
  ) {
    throw new Error("Claude Agent SDK maxBudgetUsd must be a positive finite number");
  }

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
  const execute = async (): Promise<ClaudeSdkOneShotResult> => {
    const executable = await deps.executable();
    if (controller.signal.aborted) {
      throw cancelError ?? new Error("Claude Agent SDK run aborted");
    }

    // `tools: []` disables every built-in tool. That is the DEFAULT here and the reason
    // this module is safe to hand untrusted text: the prompt embeds child-session
    // transcripts and repo content from a diff, the model only ever needs to emit JSON,
    // and a crafted transcript must not be able to steer it into invoking tools.
    //
    // A grant widens that for a caller that has argued for it. Today only the Inspector
    // does, and this phase refuses that branch above so the empty default cannot widen by
    // accident.
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
    // it dead code.
    //
    // `realpathSync` is load-bearing on macOS, where TMPDIR is commonly a symlink. Claude
    // records the resolved cwd in its encoded project path, and `headlessTranscriptDir()`
    // resolves the same value before sweeping. Passing the unresolved spelling would make
    // the test seam and the pruner disagree about where this run belongs.
    const query = await deps.query({
      prompt,
      options: {
        tools: [],
        settingSources: [],
        maxTurns: 1,
        cwd: realpathSync(HEADLESS_CWD),
        pathToClaudeCodeExecutable: executable,
        // A headless Claude run fires the same machine-installed hooks as an interactive
        // one. Strip every inherited pane identity and add the independent marker that
        // lets a current hook decline the event entirely. Both layers matter because the
        // installed hook may come from an older checkout.
        env: { ...deps.env(), MISSION_HEADLESS: "1" },
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
  }
}
