import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { unwrapEnvelope } from "./llm/structured.ts";
import { locateExecutable } from "./executables/locator.ts";
import { claudeImageUserMessage } from "./llm/claude-input.ts";
import { validateLlmImages } from "./llm/images.ts";
import {
  agentSubprocessEnv,
  cleanupAgentSubprocessEnv,
  dropPaneIdentityEnv,
} from "./agent-subprocess-env.ts";
import type { LlmImageInput } from "@shared/llm.ts";

// Runs ONE headless `claude -p` and hands back its output, so every caller starts
// from a clean context. Two very different callers share it, which is why it lives
// here rather than under `foreman/`:
//
//   - the Foreman worker, for a full review / queue verify / Tier 1 triage route;
//   - the daemon, for the Inspector's review and its follow-up replies.
//
// THIS MODULE IS BEHIND AN INTERFACE. `src/server/llm/claude.ts` is the `LlmRunner`
// implementation and delegates here rather than copying: the arguments below - why
// `--tools` defaults to empty, why the child is detached, which flags are load-bearing by
// their ABSENCE - stay next to the code they constrain. New callers take a runner
// (`src/server/llm/index.ts`) instead of importing this file.
//
// What used to sit here and does not any more: `runStructured`, `createLimiter` and
// `parseModelJson` are provider-neutral - a retry ladder, a concurrency gate and a JSON
// extractor - and moved to `llm/structured.ts` with the LLM-runner item of the
// pluggable-integrations plan. The daemon's own background jobs (the titler, the goal
// refiner, the away digest) no longer reach this file at all; they go through
// `llm/jobs.ts`. Foreman's review / verify / backlog and the Inspector still do, and are
// the remaining call sites that item leaves for a later one.

/**
 * The claude binary; overridable so a test/E2E can point at a fake.
 *
 * Resolved through the harness registry rather than read here, because there is exactly
 * one right answer to "what does `claude` mean on this machine" and a dispatched session
 * has to get the same one - this module's own chain quietly answered differently.
 * `FOREMAN_CLAUDE_BIN` survives as that harness's legacy name (`harness/claude/bin.ts`):
 * it predates this module's move out of `foreman/` and may be set in an existing
 * environment, so dropping it would break those silently rather than loudly.
 *
 * Resolution happens per run, so refresh can make a newly installed executable available
 * without restarting this process.
 */
/**
 * Default cap on a single run so a hung child can't stall its caller. Sized for the
 * full reviewer (Opus reading a 60-turn head+tail window with the whole POLICY), which is the most
 * expensive thing that runs through here; every cheaper caller - the Tier 1 router,
 * the goal refiner - passes its own `timeoutMs` rather than inheriting this.
 */
export const CLAUDE_DEFAULT_TIMEOUT_MS = Number(
  process.env.MISSION_CLAUDE_TIMEOUT_MS || process.env.FOREMAN_REVIEW_TIMEOUT_MS || 120_000,
);

/**
 * The cwd every headless run spawns in.
 *
 * Exported because it is not just where the process runs: Claude derives the directory it
 * writes a run's transcript to from the spawner's cwd, so this value alone decides where they
 * all pile up. The pruner (`goal/prune.ts`) derives that directory from THIS constant rather
 * than re-deriving `tmpdir()` itself - the two must never disagree, or the sweep silently
 * cleans an empty directory while the real one grows forever.
 *
 * Note this is per-process: it follows TMPDIR, so a daemon started from a shell and one
 * started by launchd can write to different directories. Each prunes its own, which is right -
 * neither can know the other's.
 */
export const HEADLESS_CWD = tmpdir();

/** Children we spawned, so a process exit doesn't leave them burning tokens. */
const live = new Set<ReturnType<typeof spawn>>();

/**
 * Kill every headless run we started.
 *
 * Children spawn `detached: true` (so the session poller never discovers them as
 * phantom sessions), which also means they SURVIVE their parent's death and keep
 * burning tokens to nowhere. A SIGKILL of the parent still leaks them - nothing
 * can be done about that from in here - but every ordinary exit path is covered.
 */
export function killLiveClaudeRuns(): void {
  for (const child of live) killTree(child);
  live.clear();
}

let exitHooked = false;
function hookExitOnce(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", killLiveClaudeRuns);
}

/**
 * Unwrap the `claude -p --output-format json` envelope to its `result` text.
 *
 * The implementation is `llm/structured.ts`'s, re-exported under the name this module's
 * callers have always used. It sits over there because `parseModelJson` needs it and a
 * provider-neutral parser must not import this file; the envelope itself is still Claude's,
 * which is why the name that says so is here.
 */
export { unwrapEnvelope as resultText };

/**
 * Spawn `claude -p`, feed the prompt on stdin, resolve its stdout. `opts.model` maps
 * to `--model`; omit it to inherit the CLI's own default, which is the most expensive
 * and least predictable choice - every cheap caller should name a model. `opts.timeoutMs`
 * defaults to the full review's budget, so a cheaper caller should pass its own.
 *
 * Note this runs through the local `claude` CLI, NOT the Anthropic API: there is no
 * API key in this path, and usage bills through whatever the CLI is logged in as.
 */
export interface ClaudeRunOptions {
  model?: string;
  timeoutMs?: number;
  /** Cancels the run and its detached process group. A pre-aborted signal prevents spawning. */
  signal?: AbortSignal;
  /** A rendered JSON Schema passed to Claude Code's structured-output validator. */
  schema?: string;
  /**
   * The `--tools` value. Defaults to `""` - EVERY tool disabled - because that is what
   * makes it safe to embed untrusted transcript and repo text in a prompt, which every
   * caller here does.
   *
   * Overriding it is a security decision, not a convenience. The Inspector does, and
   * pays for it with four other layers (see `src/server/inspector/`); nothing else
   * should without the same argument. The default stays `""` precisely so that widening
   * this for one caller cannot widen it for the others by accident.
   */
  tools?: string;
  /** Tools pre-approved for this unattended run. Must be a subset of `tools`. */
  allowedTools?: string;
  /** Claude Code settings layers to load. Omitted by default so background LLM jobs stay isolated. */
  settingSources?: readonly ("user" | "project" | "local")[];
  /**
   * Where the run spawns. Defaults to `HEADLESS_CWD` (a temp dir), which is right for
   * every tool-less caller: with no tools, a working directory is meaningless, and a
   * real one only risks the run noticing a repo it has no business in.
   *
   * A caller that DOES grant tools has to set this, because under `-p` the working
   * directory is what scopes reads: there is no one to approve a prompt for a file
   * outside it, so the read fails instead.
   */
  cwd?: string;
  /** A `--settings` JSON string - how a tool-granting caller passes permission rules. */
  settings?: string;
  /** Ordered native images. Omit or pass empty to retain the historical text input. */
  images?: readonly LlmImageInput[];
}

type ClaudeOutputFormat = "json" | "stream-json";

async function runClaudeRaw(
  prompt: string,
  opts: ClaudeRunOptions,
  outputFormat: ClaudeOutputFormat,
): Promise<string> {
  const executable = await locateExecutable("claude");
  if (!executable) throw new Error('agent binary "claude" not found in the executable environment');
  return await new Promise((resolve, reject) => {
    let images: ReturnType<typeof validateLlmImages>;
    try {
      // Refuse a missing, changed, spoofed, or oversized file before argv reaches spawn.
      images = validateLlmImages(opts.images);
    } catch (error) {
      reject(error);
      return;
    }
    if (opts.signal?.aborted) {
      reject(new Error("claude -p aborted"));
      return;
    }
    // `--tools` with an empty value is a valid Claude Code CLI flag (verified to exit 0)
    // that sets the available-tool list to empty, disabling every built-in tool. That is
    // the DEFAULT here and the reason this module is safe to hand untrusted text: the
    // prompt embeds child-session transcripts and repo content from a diff, the model
    // only ever needs to emit JSON, and a crafted transcript must not be able to steer
    // it into invoking tools.
    //
    // `opts.tools` widens that for a caller that has argued for it - today only the
    // Inspector, which needs to read source to review a diff properly and carries four
    // other defence layers because of it. The default is empty rather than inherited so
    // that one caller's grant can never become everyone's.
    // `detached: true` makes the child its own session/process-group leader with no
    // controlling terminal, so the session poller (which groups agents by tty and
    // skips tty-less ones) never discovers this headless run as a phantom
    // session. That covers discovery; `headlessEnv()` covers the other way in - the
    // hooks this run fires - which would otherwise bind it to a real card.
    //
    // The FLAGS THAT ARE NOT HERE are load-bearing, and this comment is the only thing
    // saying so. There is no `--resume`, no `--continue`, no `--session-id`: without one
    // of those, every `claude -p` mints a new session with an empty context. That is what
    // makes each run start clean, and it is a correctness property, not a default worth
    // tidying away. Note the contrast with the options above - `tools`, `cwd` and
    // `settings` are deliberately per-caller; context isolation is deliberately not.
    //
    // It matters because the Foreman reviews MANY sessions. Anything that let one
    // invocation see another's context would (a) grow the context monotonically across
    // every session it ever looked at and (b) let session A's transcript influence the
    // verdict on session B. Verified: a single held-open `--input-format stream-json`
    // process does exactly that - turn 2 answers questions about turn 1 - so "hold the
    // process open to skip the ~2s spawn" is not an optimisation available here. Measured,
    // for the record: three cold runs of this exact shape took 4.1s/6.2s/5.0s wall, only
    // ~1.8-2.4s of which is process boot, and all three still got a prompt-cache read
    // because that cache is server-side and survives the process. There is very little to
    // buy and a correctness property to lose.
    //
    // If per-supervised-session memory is ever wanted, the shape is `--session-id <uuid>`
    // keyed on the observed session, then `--resume` - one conversation per supervised
    // session, never one shared. Do not reach for a warm shared process.
    //
    // `--no-session-persistence` is deliberately NOT passed. It would stop these runs
    // writing a transcript at all, which sounds tidy but deletes the only record of what a
    // headless run did - the thing to read when Foreman answers oddly. For the default
    // cwd, `goal/prune.ts` already bounds them by age on purpose; that is the considered
    // answer, and this flag would quietly make it dead code. (A caller that overrides
    // `cwd` writes outside what that sweep walks, which is a gap in the pruner rather
    // than an argument for this flag.)
    const args = ["-p", "--output-format", outputFormat];
    // Claude Code requires verbose mode when stream-json is used with `-p`. The stream is
    // selected only by callers that need raw tool events; ordinary text callers retain the
    // historical JSON envelope byte for byte.
    if (outputFormat === "stream-json") args.push("--verbose");
    if (images.length > 0) args.push("--input-format", "stream-json");
    args.push("--tools", opts.tools ?? "");
    if (opts.allowedTools) args.push("--allowed-tools", opts.allowedTools);
    if (opts.settingSources?.length) {
      args.push("--setting-sources", opts.settingSources.join(","));
    }
    // Unlike the deliberately absent resume flags above, this constrains only the reply
    // shape. It cannot connect this fresh invocation to any previous conversation.
    if (opts.schema) args.push("--json-schema", opts.schema);
    if (opts.model) args.push("--model", opts.model);
    if (opts.settings) args.push("--settings", opts.settings);
    const env = headlessEnv();
    const child = (() => {
      try {
        return spawn(executable.path, args, {
          cwd: opts.cwd ?? HEADLESS_CWD,
          stdio: ["pipe", "pipe", "pipe"],
          env,
          detached: true,
        });
      } catch (error) {
        cleanupAgentSubprocessEnv(env);
        throw error;
      }
    })();
    hookExitOnce();
    live.add(child);
    let out = "";
    let err = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (): boolean => {
      if (settled) return false;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      live.delete(child);
      cleanupAgentSubprocessEnv(env);
      return true;
    };
    const onAbort = (): void => {
      killTree(child);
      if (done()) reject(new Error("claude -p aborted"));
    };
    timer = setTimeout(() => {
      killTree(child);
      if (done()) reject(new Error("claude -p timed out"));
    }, opts.timeoutMs ?? CLAUDE_DEFAULT_TIMEOUT_MS);
    timer.unref?.();
    // Decode ONCE, as a stream, rather than coercing each Buffer chunk to a string
    // independently. `claude -p` streams its response, so a multi-byte character
    // landing across a chunk boundary is ordinary rather than exotic - and coerced
    // per chunk it decodes to replacement characters on both sides. That either
    // breaks the JSON parse (burning both attempts and pushing the item toward a
    // bogus "could not verify" escalation) or, worse, parses with corrupted gap text
    // that then gets typed into the agent. `setEncoding` hands the boundary to the
    // stream's own StringDecoder, which holds the partial bytes until the rest lands.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (out += d));
    child.stderr.on("data", (d: string) => (err += d));
    child.on("error", (e) => {
      if (done()) reject(e);
    });
    child.on("close", (code) => {
      if (!done()) return;
      if (code === 0) resolve(out);
      else reject(new Error(`claude exited ${code}: ${err.slice(0, 300)}`));
    });
    // `child.on("error")` above is the ChildProcess's (spawn failures); stdin is a
    // separate Writable, and an unhandled `error` on it THROWS - taking the caller's
    // process down rather than failing this one run. Nothing catches that: it isn't a
    // promise rejection, so `main().catch()` never sees it.
    //
    // The write is what raises it. A verify prompt carries a diff, a transcript
    // window and up to 64KB of standards, so it routinely exceeds the OS pipe buffer
    // and stays pending instead of completing into it; if `claude` exits first (an
    // auth or rate-limit fast-fail, or a build that rejects `--tools ""`), the pending
    // write gets EPIPE. Swallowing it is right because it isn't the diagnosis: the
    // `close` handler already reports the real exit code and stderr, which is what
    // the caller should retry-then-escalate on.
    child.stdin.on("error", () => {});
    // Register after the process listeners exist, then recheck to close the narrow race between
    // the pre-spawn check and listener registration. The process group is killed either way.
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) {
      onAbort();
      return;
    }
    child.stdin.write(
      images.length === 0
        ? prompt
        : `${JSON.stringify(claudeImageUserMessage(prompt, images))}\n`,
    );
    child.stdin.end();
  });
}

export function runClaudeText(prompt: string, opts: ClaudeRunOptions = {}): Promise<string> {
  return runClaudeRaw(prompt, opts, "json");
}

/** One completed tool call captured from Claude Code's provider event stream. */
export interface ClaudeToolCall {
  name: string;
  input: unknown;
  /** The provider's structured output, separate from the text Claude sees or summarizes. */
  output: unknown;
}

/** The final model text plus every provider-backed tool call made during the run. */
export interface ClaudeToolTrace {
  result: string;
  toolCalls: ClaudeToolCall[];
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Claude Code has emitted both the provider payload directly and the MCP result envelope that
 * carries it. Keep callers on one contract: a tool call's output is the provider's structured
 * data, while the model-facing text remains in the stream's tool_result block.
 */
function structuredToolOutput(value: unknown): unknown {
  const envelope = objectRecord(value);
  return envelope && Object.hasOwn(envelope, "structuredContent")
    ? envelope.structuredContent
    : value;
}

/**
 * Parse Claude Code's newline-delimited SDK messages without treating model-facing tool text as
 * provider data. `tool_use_result` carries either the structured MCP output itself or an MCP
 * result envelope containing `structuredContent`; if a CLI version omits it, the matching call is
 * absent from the trace and a caller that requires it can fail closed.
 */
export function parseClaudeToolTrace(raw: string): ClaudeToolTrace {
  const pending = new Map<string, { name: string; input: unknown }>();
  const toolCalls: ClaudeToolCall[] = [];
  let result = "";

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error("claude stream-json returned a non-JSON event");
    }
    const frame = objectRecord(parsed);
    if (!frame) throw new Error("claude stream-json returned an unexpected event");

    if (frame.type === "assistant") {
      const message = objectRecord(frame.message);
      const content = Array.isArray(message?.content) ? message.content : [];
      for (const entry of content) {
        const block = objectRecord(entry);
        if (
          block?.type === "tool_use" &&
          typeof block.id === "string" &&
          typeof block.name === "string"
        ) {
          pending.set(block.id, { name: block.name, input: block.input });
        }
      }
      continue;
    }

    if (frame.type === "user" && Object.hasOwn(frame, "tool_use_result")) {
      const message = objectRecord(frame.message);
      const content = Array.isArray(message?.content) ? message.content : [];
      const results = content
        .map(objectRecord)
        .filter(
          (block): block is Record<string, unknown> =>
            block?.type === "tool_result" && typeof block.tool_use_id === "string",
        );
      // One SDK user frame represents one completed tool call. Refuse to guess which call owns
      // the structured result if a future CLI combines several results into a single frame.
      if (results.length === 1) {
        const toolUseId = results[0]!.tool_use_id as string;
        const call = pending.get(toolUseId);
        if (call) {
          toolCalls.push({ ...call, output: structuredToolOutput(frame.tool_use_result) });
          pending.delete(toolUseId);
        }
      }
      continue;
    }

    if (frame.type === "result" && typeof frame.result === "string") result = frame.result;
  }

  return { result, toolCalls };
}

/** Run one fresh Claude invocation and retain its structured MCP tool results. */
export async function runClaudeToolTrace(
  prompt: string,
  opts: ClaudeRunOptions = {},
): Promise<ClaudeToolTrace> {
  return parseClaudeToolTrace(await runClaudeRaw(prompt, opts, "stream-json"));
}

/**
 * The env a headless run gets: the parent's, minus the terminal identity, plus a
 * marker saying what this process is.
 *
 * A headless `claude -p` is Claude Code, so it fires the SAME hooks a human's session
 * does. `hooks/harness-hook.mjs` binds an event to a card using `captureTerminalEnv()`,
 * which reads pane identity out of its own process - and the hook is a child of `claude`,
 * which is a child of US. So inheriting the spawner's pane env makes every
 * headless run impersonate whichever card sits in the pane the daemon or `npm run
 * foreman` was launched from.
 *
 * That is not a hypothetical: it had poisoned 3 of the 12 rows in this machine's live
 * `session_agent_bindings`, with two DIFFERENT real cards fused onto one headless run's
 * uuid. `applyHook` writes `agentSessionId: evt.sessionId ?? target.agentSessionId`, so
 * the headless uuid becomes the card's - rotating `noteKeyFor` and orphaning the Foreman
 * note and work queue keyed on the real one, repointing `transcriptPath` at the headless
 * run's own transcript, and overwriting `activity` with our prompt.
 *
 * Only pane identity is dropped: `overlayKeyFromEnv` keys on it, and those variables
 * are the terminal identity a headless run has no business claiming. TERM_PROGRAM is
 * captured by the hook but identifies a terminal *type*, not a card, so it stays.
 *
 * `MISSION_HEADLESS` is the second, independent layer: it lets the hook decline to report
 * the run at all rather than merely failing to bind it. Both are kept because neither can
 * be assumed - the hook script is installed globally from a checkout that may lag this
 * code, and stripping the env is what protects a stale install.
 */
function headlessEnv(): NodeJS.ProcessEnv {
  // Annotated, not inferred: spreading `process.env` drops its index signature, so an
  // inferred type is the literal `{ MISSION_HEADLESS: string }` and the deletes below stop
  // compiling.
  const env: NodeJS.ProcessEnv = agentSubprocessEnv(process.env, { loopbackAccess: true });
  env.MISSION_HEADLESS = "1";
  dropPaneIdentityEnv(env);
  return env;
}

/**
 * Terminate a detached child. Because it's spawned `detached`, the child is its
 * own process-group leader, so signalling the negative pid kills it plus any
 * grandchildren it spawned; fall back to a direct kill if the group signal fails.
 */
function killTree(child: ReturnType<typeof spawn>): void {
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}
