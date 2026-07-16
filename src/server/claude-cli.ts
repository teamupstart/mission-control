import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import type { ZodTypeAny, TypeOf } from "zod";

// Runs ONE headless `claude -p` and hands back its output, so every caller starts
// from a clean context. Two very different callers share it, which is why it lives
// here rather than under `foreman/`:
//
//   - the Foreman worker, for a full review / queue verify / Tier 1 triage route;
//   - the daemon, for the per-session Goal one-liner.
//
// They run in SEPARATE PROCESSES (the worker is `npm run foreman`), so this module
// deliberately owns no global concurrency state: a shared module cannot enforce a
// shared cap across process boundaries, and pretending otherwise would be a lie.
// Each caller builds its own `createLimiter` instead - Foreman is near-sequential
// already, and the daemon caps its goal runs so a busy fleet can't fork a subprocess
// per card.

/**
 * The claude binary; overridable so a test/E2E can point at a fake.
 *
 * `FOREMAN_CLAUDE_BIN` is still read: it predates this module's move out of
 * `foreman/` and may be set in an existing environment, so dropping it would break
 * those silently rather than loudly.
 */
const CLAUDE_BIN = process.env.FLEET_CLAUDE_BIN || process.env.FOREMAN_CLAUDE_BIN || "claude";
/**
 * Default cap on a single run so a hung child can't stall its caller. Sized for the
 * full reviewer (Opus reading 48 turns with the whole POLICY), which is the most
 * expensive thing that runs through here; every cheaper caller - the Tier 1 router,
 * the goal refiner - passes its own `timeoutMs` rather than inheriting this.
 */
const DEFAULT_TIMEOUT_MS = Number(
  process.env.FLEET_CLAUDE_TIMEOUT_MS || process.env.FOREMAN_REVIEW_TIMEOUT_MS || 120_000,
);

/**
 * The result of one structured run: either a model-produced, schema-valid value
 * (success - INCLUDING a judgment you don't like, e.g. action:"skip") or a
 * transient failure (a spawn/timeout/exit error, or a parse miss after the retry).
 *
 * Callers must treat these differently, which is the whole reason the contract
 * separates them: a genuine judgment is durable, but a failure must never be
 * stamped as one, or a single infra blip would abandon the work for good.
 */
export type StructuredResult<T> = { kind: "ok"; value: T } | { kind: "failed"; reason: string };

/** Children we spawned, so a process exit doesn't leave them burning tokens. */
const live = new Set<ReturnType<typeof spawn>>();

/**
 * Kill every headless run we started.
 *
 * Children spawn `detached: true` (so the fleet poller never discovers them as
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
 * A per-caller concurrency gate: `limit(fn)` runs `fn` once a slot is free.
 *
 * Scoped to the caller, never module-global, because the two callers want opposite
 * things - Foreman wants its serial review queue left alone, while the daemon wants
 * a hard ceiling on goal refreshes so a 20-card fleet answering prompts at once
 * can't fork 20 subprocesses. The loop (not an `if`) is what makes it correct: a
 * released waiter re-checks the count instead of trusting that the slot it was woken
 * for is still free, so two waiters resumed in the same tick can't both take one slot.
 */
export function createLimiter(concurrency: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    while (active >= concurrency) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/**
 * Ask a fresh tool-less `claude -p` for a value matching `schema`, retrying once
 * on a parse miss with a stricter reminder (the model occasionally editorializes
 * in prose instead of emitting the raw object, or wraps it in a markdown fence
 * despite being told not to - both observed). Never throws.
 *
 * `extract` turns raw stdout into a candidate value; pass the caller's own ladder
 * so an existing extractor (with its envelope/fence handling) stays the single
 * source of that logic.
 */
export async function runStructured<S extends ZodTypeAny>(
  prompt: string,
  extract: (raw: string) => TypeOf<S> | null,
  label = "The model",
  opts: { model?: string; timeoutMs?: number } = {},
): Promise<StructuredResult<TypeOf<S>>> {
  const attempts = [
    prompt,
    `${prompt}\n\nYour previous reply was not valid JSON. Reply with ONLY the JSON object.`,
  ];
  for (const p of attempts) {
    let raw: string;
    try {
      raw = await runClaudeText(p, opts);
    } catch (err) {
      return { kind: "failed", reason: `${label} failed: ${String(err)}` };
    }
    const value = extract(raw);
    if (value) return { kind: "ok", value };
  }
  return { kind: "failed", reason: `${label} could not parse a valid reply from the model.` };
}

/**
 * Pull a schema-valid object out of a `claude -p` run's raw stdout. Handles the JSON
 * envelope (`{ result: "<text>" }`), markdown-fenced JSON, or a bare object, trying each
 * candidate against the schema. Returns null when none validate.
 *
 * Lives here rather than with any one caller because the envelope is a property of the
 * `--output-format json` flag THIS module sets - a caller that parses it is undoing what
 * `runClaudeText` asked for. It had already been copied verbatim into two callers (the
 * reviewer and the queue verifier) before a third (the goal refiner) needed it.
 *
 * The fence branch is not defensive padding: a model returns ```json … ``` despite being
 * told not to, observed on a real probe.
 */
export function parseModelJson<S extends ZodTypeAny>(raw: string, schema: S): TypeOf<S> | null {
  for (const candidate of jsonCandidates(resultText(raw))) {
    let obj: unknown;
    try {
      obj = JSON.parse(candidate);
    } catch {
      continue;
    }
    const r = schema.safeParse(obj);
    if (r.success) return r.data;
  }
  return null;
}

/** Unwrap the `claude -p --output-format json` envelope to its `result` text. */
function resultText(raw: string): string {
  const trimmed = raw.trim();
  try {
    const env = JSON.parse(trimmed) as { result?: unknown };
    if (env && typeof env === "object" && typeof env.result === "string") return env.result;
  } catch {
    // not an envelope - the raw output is the text
  }
  return trimmed;
}

/** Candidate JSON strings to try, most-specific first. */
function jsonCandidates(text: string): string[] {
  const out: string[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text))) out.push(m[1]!.trim());
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) out.push(text.slice(first, last + 1));
  out.push(text.trim());
  return out;
}

/**
 * Spawn `claude -p`, feed the prompt on stdin, resolve its stdout. `opts.model` maps
 * to `--model`; omit it to inherit the CLI's own default, which is the most expensive
 * and least predictable choice - every cheap caller should name a model. `opts.timeoutMs`
 * defaults to the full review's budget, so a cheaper caller should pass its own.
 *
 * Note this runs through the local `claude` CLI, NOT the Anthropic API: there is no
 * API key in this path, and usage bills through whatever the CLI is logged in as.
 */
export function runClaudeText(
  prompt: string,
  opts: { model?: string; timeoutMs?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    // `--tools ""` is a valid Claude Code CLI flag (verified to exit 0 with an
    // empty value) that sets the available-tool list to empty, disabling every
    // built-in tool. The prompt embeds untrusted child-session transcript text (and,
    // for the queue verifier, untrusted repo content from the diff), and the
    // model only ever needs to emit JSON - so a crafted/compromised transcript
    // must not be able to steer it into invoking tools (a prompt-injection surface).
    // `detached: true` makes the child its own session/process-group leader with no
    // controlling terminal, so the fleet poller (which groups agents by tty and
    // skips tty-less ones) never discovers this headless run as a phantom
    // session. That covers discovery; `headlessEnv()` covers the other way in - the
    // hooks this run fires - which would otherwise bind it to a real card.
    const args = ["-p", "--output-format", "json", "--tools", ""];
    if (opts.model) args.push("--model", opts.model);
    const child = spawn(CLAUDE_BIN, args, {
      cwd: tmpdir(),
      stdio: ["pipe", "pipe", "pipe"],
      env: headlessEnv(),
      detached: true,
    });
    hookExitOnce();
    live.add(child);
    let out = "";
    let err = "";
    const done = (): void => {
      clearTimeout(timer);
      live.delete(child);
    };
    const timer = setTimeout(() => {
      killTree(child);
      done();
      reject(new Error("claude -p timed out"));
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
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
      done();
      reject(e);
    });
    child.on("close", (code) => {
      done();
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
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * The env a headless run gets: the parent's, minus the terminal identity, plus a
 * marker saying what this process is.
 *
 * A headless `claude -p` is Claude Code, so it fires the SAME hooks a human's session
 * does. `hooks/harness-hook.mjs` binds an event to a card using `captureTerminalEnv()`,
 * which reads TMUX_PANE / WEZTERM_PANE out of its own process - and the hook is a child
 * of `claude`, which is a child of US. So inheriting the spawner's pane env makes every
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
 * Only the pane ids are dropped: `overlayKeyFromEnv` keys on those two alone, and they
 * are the terminal identity a headless run has no business claiming. TERM_PROGRAM is
 * captured by the hook but identifies a terminal *type*, not a card, so it stays.
 *
 * `FLEET_HEADLESS` is the second, independent layer: it lets the hook decline to report
 * the run at all rather than merely failing to bind it. Both are kept because neither can
 * be assumed - the hook script is installed globally from a checkout that may lag this
 * code, and stripping the env is what protects a stale install.
 */
function headlessEnv(): NodeJS.ProcessEnv {
  // Annotated, not inferred: spreading `process.env` drops its index signature, so an
  // inferred type is the literal `{ FLEET_HEADLESS: string }` and the deletes below stop
  // compiling.
  const env: NodeJS.ProcessEnv = { ...process.env, FLEET_HEADLESS: "1" };
  delete env.TMUX_PANE;
  delete env.WEZTERM_PANE;
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
