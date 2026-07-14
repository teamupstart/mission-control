import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import type { ZodTypeAny, TypeOf } from "zod";

// Runs ONE structured judgment in a fresh `claude -p` process, so every session
// Foreman looks at starts from a clean context (the "auto-clears between reviews"
// guarantee). Extracted from review.ts so the queue verifier inherits exactly the
// same spawn discipline - the tool-less flag, the detached process group, the
// timeout cap, and the parse-miss retry - rather than growing a second, subtly
// different copy of it.

/** The claude binary; overridable so a test/E2E can point at a fake. */
const CLAUDE_BIN = process.env.FOREMAN_CLAUDE_BIN || "claude";
/**
 * Default cap on a single run so a hung reviewer can't stall the queue. Sized for the
 * full reviewer; a cheaper caller (the Tier 1 router) passes its own `timeoutMs`.
 */
const REVIEW_TIMEOUT_MS = Number(process.env.FOREMAN_REVIEW_TIMEOUT_MS || 120_000);

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

/** Children we spawned, so a worker exit doesn't leave them burning tokens. */
const live = new Set<ReturnType<typeof spawn>>();

/**
 * Kill every reviewer we started.
 *
 * Reviewers spawn `detached: true` (so the fleet poller never discovers them as
 * phantom sessions), which also means they SURVIVE the worker's death and keep
 * burning tokens to nowhere. A SIGKILL of the worker still leaks them - nothing
 * can be done about that from in here - but every ordinary exit path is covered.
 */
export function killLiveReviewers(): void {
  for (const child of live) killTree(child);
  live.clear();
}

let exitHooked = false;
function hookExitOnce(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", killLiveReviewers);
}

/**
 * Ask a fresh tool-less `claude -p` for a value matching `schema`, retrying once
 * on a parse miss with a stricter reminder (the model occasionally editorializes
 * in prose instead of emitting the raw object). Never throws.
 *
 * `extract` turns raw stdout into a candidate value; pass the caller's own ladder
 * so an existing extractor (with its envelope/fence handling) stays the single
 * source of that logic.
 */
export async function runStructured<S extends ZodTypeAny>(
  prompt: string,
  extract: (raw: string) => TypeOf<S> | null,
  label = "Foreman",
): Promise<StructuredResult<TypeOf<S>>> {
  const attempts = [
    prompt,
    `${prompt}\n\nYour previous reply was not valid JSON. Reply with ONLY the JSON object.`,
  ];
  for (const p of attempts) {
    let raw: string;
    try {
      raw = await runClaudeText(p);
    } catch (err) {
      return { kind: "failed", reason: `${label} failed: ${String(err)}` };
    }
    const value = extract(raw);
    if (value) return { kind: "ok", value };
  }
  return { kind: "failed", reason: `${label} could not parse a valid reply from the reviewer.` };
}

/**
 * Spawn `claude -p`, feed the prompt on stdin, resolve its stdout. Exported so the
 * cheap Tier 1 triage reuses the exact same headless, tool-less, injection-isolated
 * subprocess machinery - only with a different (cheaper) model. `opts.model` maps to
 * `--model`; omit it for the default (full-reviewer) model. `opts.timeoutMs` defaults to
 * the full review's budget, which is sized for Opus reading 48 turns with the whole POLICY -
 * a cheaper caller should pass its own (see the worker's Tier 1 router).
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
    // reviewer only ever needs to emit JSON - so a crafted/compromised transcript
    // must not be able to steer it into invoking tools (a prompt-injection surface).
    // `detached: true` makes the child its own session/process-group leader with no
    // controlling terminal, so the fleet poller (which groups agents by tty and
    // skips tty-less ones) never discovers this headless reviewer as a phantom
    // session.
    const args = ["-p", "--output-format", "json", "--tools", ""];
    if (opts.model) args.push("--model", opts.model);
    const child = spawn(CLAUDE_BIN, args, {
      cwd: tmpdir(),
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
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
      reject(new Error("review timed out"));
    }, opts.timeoutMs ?? REVIEW_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
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
    // separate Writable, and an unhandled `error` on it THROWS - taking the worker
    // down rather than failing this one verify. Nothing catches that: it isn't a
    // promise rejection, so `main().catch()` never sees it.
    //
    // The write is what raises it. A verify prompt carries a diff, a transcript
    // window and up to 64KB of standards, so it routinely exceeds the OS pipe buffer
    // and stays pending instead of completing into it; if `claude` exits first (an
    // auth or rate-limit fast-fail, or a build that rejects `--tools ""`), the pending
    // write gets EPIPE. Swallowing it is right because it isn't the diagnosis: the
    // `close` handler already reports the real exit code and stderr, which is what
    // failVerify should retry-then-escalate on.
    child.stdin.on("error", () => {});
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * Terminate a detached reviewer. Because it's spawned `detached`, the child is its
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
