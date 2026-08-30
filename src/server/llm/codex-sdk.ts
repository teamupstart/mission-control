import { tmpdir } from "node:os";

import { Codex } from "@openai/codex-sdk";
import type { LlmRunOptions } from "@shared/llm.ts";
import { agentSubprocessEnv, cleanupAgentSubprocessEnv } from "../agent-subprocess-env.ts";

/**
 * One headless Codex call, driven through `@openai/codex-sdk` instead of hand-parsed argv.
 *
 * The counterpart to `claude-sdk.ts`, and selected the same way - `codexTransport` in the LLM
 * config, resolved per call so a Settings edit reaches the next run.
 *
 * WHAT THIS BUYS, AND WHAT IT DOES NOT. The SDK spawns the same `codex` executable the exec
 * transport does: `spawn(this.executablePath, …)` inside its `CodexExec`. So this is a
 * PARSING change, not a fetching one - typed thread events in place of decoding a `--json`
 * stream by hand. It is not faster, and it must not be sold as such. Measured on the
 * configured provider, a `gpt-5.6-luna` title call is 4.5-7.7s wall, of which ~0.3-0.6s is
 * the process; the rest is the model round trip, which both transports pay identically.
 * Prompt size is not a factor either - 72,422 input tokens answered in the same time as
 * 12,414.
 *
 * `codexPathOverride` is the load-bearing option here and is NOT optional in practice. The
 * SDK declares a dependency on `@openai/codex`, so installing it drops a SECOND copy of the
 * CLI into `node_modules` - a different version from the operator's (0.149.0 against a
 * configured 0.147.0 when this was written). Left to its own resolution the SDK would run
 * that bundled copy, so the two transports would silently execute different binaries and
 * disagree about flags, models and auth. Pinning it to the SAME path the exec transport
 * spawns makes the transport choice a choice about parsing alone, which is the only honest
 * version of it.
 */

/** What one SDK run reports back, shaped to match the exec transport's event read. */
export interface CodexSdkResult {
  text: string;
  usage: Record<string, unknown> | null;
  threadId: string;
}

/**
 * The posture every SDK run is pinned to, matching the exec transport's argv term for term.
 *
 * `workingDirectory` is the one that bites if it is left out. The SDK defaults the thread to
 * the CURRENT PROCESS's directory, which for the daemon and the Foreman worker is a real
 * checkout - so an omitted setting silently scopes a tool-less run to whatever repository
 * happens to be open, while `codex exec` has always spawned in `tmpdir()`. These calls have
 * no repository scope by design: `LlmRunOptions` carries no `cwd`, the only `cwd` in the
 * model lives on `LlmToolGrant`, and this runner declares `sandbox: null` and refuses every
 * grant outright. A run that may not be granted a directory must not inherit one either.
 */
const THREAD_POSTURE = {
  skipGitRepoCheck: true,
  sandboxMode: "read-only",
  approvalPolicy: "never",
  workingDirectory: tmpdir(),
} as const;

/**
 * Provider config the exec transport spells as `-c` flags. Passed at the client because that
 * is where the SDK flattens `--config` overrides; a thread option cannot express these.
 */
const CLIENT_CONFIG = {
  features: { shell_tool: false, unified_exec: false },
} as const;

interface SdkThread {
  readonly id?: string | null;
  run(prompt: string, turnOptions?: { signal?: AbortSignal; outputSchema?: unknown }): Promise<{
    finalResponse?: string | null;
    usage?: Record<string, unknown> | null;
  }>;
}

export interface CodexSdkDeps {
  /**
   * Constructs the client. Injected so a test need not spawn a real provider.
   *
   * Handed the WHOLE options object rather than just the path, so a test can assert the
   * posture that reaches the provider instead of only the binary that runs it.
   */
  createClient?: (options: {
    codexPathOverride: string;
    config: unknown;
    env: Record<string, string>;
  }) => {
    startThread(options?: unknown): SdkThread;
  };
}

/**
 * Every SDK run currently in flight, by its abort handle.
 *
 * The exec transport keeps the same register (`live`) over its child processes, and for the
 * same two reasons. A run whose answer is no longer wanted must be STOPPED rather than
 * merely ignored - an abandoned `codex exec` goes on burning tokens to nowhere, and the
 * background jobs that use this runner time out routinely against a slow or logged-out
 * provider, so "ignore it" accumulates one live subprocess per timeout. And a daemon
 * shutting down has to be able to take them all with it, which is what `killLiveRuns` on
 * the runner promises; a transport absent from this set would quietly break that promise.
 */
const liveRuns = new Set<AbortController>();

/** Abort every in-flight SDK run. Wired into the codex runner's `killLiveRuns`. */
export function killLiveCodexSdkRuns(): void {
  for (const controller of liveRuns) controller.abort();
  liveRuns.clear();
}

/**
 * Run one prompt and return the model's final text plus what the turn cost.
 *
 * Rejects on any failure, exactly as the exec transport does - every caller in `jobs.ts`
 * catches and degrades to a deterministic tier, so a provider that cannot be reached costs a
 * rougher answer and never a dispatch.
 */
export async function runCodexSdkOneShot(
  prompt: string,
  codexBin: string,
  opts: LlmRunOptions = {},
  deps: CodexSdkDeps = {},
): Promise<CodexSdkResult> {
  // Images and tool grants are deliberately unsupported on this transport rather than
  // silently dropped. The exec transport refuses grants outright for the reason stated on
  // `codexRunner`, and an image list that reached here would simply not be sent - a caller
  // that asked for one and got an answer about nothing is worse than an error.
  if (opts.grant) throw new Error("the codex SDK transport does not support tool grants");
  if (opts.images && opts.images.length > 0) {
    throw new Error("the codex SDK transport does not support images");
  }

  const env = agentSubprocessEnv(process.env, { loopbackAccess: true });
  const controller = new AbortController();
  liveRuns.add(controller);
  try {
    const clientOptions = {
      codexPathOverride: codexBin,
      config: CLIENT_CONFIG,
      env,
    };
    const client = deps.createClient
      ? deps.createClient(clientOptions)
      : new Codex(clientOptions);

    // The same posture the exec transport spells out in argv: no project rules, read-only,
    // never prompt for approval, no shell, and a working directory outside any checkout. A
    // transport that quietly ran with wider powers than its sibling would make the config
    // choice a security decision, which it must not be.
    const thread = client.startThread({
      ...THREAD_POSTURE,
      ...(opts.model ? { model: opts.model } : {}),
    });

    // `outputSchema` is the SDK's spelling of the exec transport's `--output-schema`. Passing
    // it keeps a structured job answering the same shape on either transport; omitting it made
    // the two paths disagree for exactly the callers that care most.
    const run = thread.run(prompt, {
      signal: controller.signal,
      ...(opts.schema ? { outputSchema: opts.schema } : {}),
    });
    const result = opts.timeoutMs
      ? await withTimeout(run, opts.timeoutMs, controller)
      : await run;
    const text = result.finalResponse ?? "";
    if (!text.trim()) throw new Error("codex sdk returned no final response");
    return { text, usage: result.usage ?? null, threadId: thread.id ?? "" };
  } finally {
    liveRuns.delete(controller);
    cleanupAgentSubprocessEnv(env);
  }
}

/**
 * Bound one run by the caller's budget, and CANCEL it when that budget is spent.
 *
 * Every job passes its own `timeoutMs` and each is separately argued for (see `jobs.ts`), so
 * the transport must honour it rather than inherit the SDK's.
 *
 * The abort is the point, and it is what an earlier version of this file got wrong: it
 * rejected the wrapper promise and left `thread.run` executing, on the stated but false
 * assumption that the SDK would tear the child down on its own. Nothing was cancelling it.
 * A title call that hung past its budget therefore let dispatch continue under the heuristic
 * name - correct - while a `codex` process kept running and kept spending, and every
 * subsequent timeout added another. `TurnOptions.signal` is the SDK's supported cancellation
 * and is what actually stops the turn.
 *
 * The abandoned promise is then explicitly observed. Aborting makes it reject, and a rejected
 * promise nobody is awaiting is an unhandled rejection - which on this daemon is fatal.
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  controller: AbortController,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      // Swallow the rejection the abort above is about to cause. The caller has already been
      // handed the timeout error and has degraded; this is only here so the process survives.
      promise.catch(() => {});
      reject(new Error("codex sdk run timed out"));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
