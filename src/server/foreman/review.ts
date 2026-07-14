import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { buildReviewPrompt } from "./prompt.ts";
import type { ReviewInput } from "./prompt.ts";
import { VerdictSchema } from "./verdict.ts";
import type { Verdict } from "./verdict.ts";

// Runs ONE review in a fresh `claude -p` process, so every session Foreman looks
// at starts from a clean context (the "auto-clears between reviews" guarantee).
// The subprocess is headless (piped stdio, no tty) so the fleet poller never
// discovers it as a session. Its stdout is a JSON envelope whose `result` holds
// the model's text, from which we extract + validate the structured verdict.

/** The claude binary; overridable so a test/E2E can point at a fake. */
const CLAUDE_BIN = process.env.FOREMAN_CLAUDE_BIN || "claude";
/** Hard cap on a single review so a hung reviewer can't stall the queue. */
const REVIEW_TIMEOUT_MS = Number(process.env.FOREMAN_REVIEW_TIMEOUT_MS || 120_000);

/**
 * The result of one review: either a model-produced verdict (success - including a
 * legitimate action:"skip") or a transient failure (a spawn/timeout/exit error, or
 * a parse miss after the retry). The worker treats these differently: a genuine
 * verdict is stamped as handled, but a failure must NOT permanently stamp the
 * prompt's marker, or a single infra blip would abandon the queue item for good.
 */
export type ReviewResult =
  | { kind: "verdict"; verdict: Verdict }
  | { kind: "failed"; reason: string };

/**
 * Review one session in a fresh process; never throws (returns a `failed` result
 * instead). Retries once on a parse miss with a stricter reminder, since the model
 * occasionally editorializes in prose instead of emitting the raw object.
 */
export async function reviewSession(input: ReviewInput): Promise<ReviewResult> {
  const prompt = buildReviewPrompt(input);
  const attempts = [prompt, `${prompt}\n\nYour previous reply was not valid JSON. Reply with ONLY the JSON object.`];
  for (const p of attempts) {
    let raw: string;
    try {
      raw = await runClaude(p);
    } catch (err) {
      return { kind: "failed", reason: `Foreman review failed: ${String(err)}` };
    }
    const verdict = extractVerdict(raw);
    if (verdict) return { kind: "verdict", verdict };
  }
  return { kind: "failed", reason: "Foreman could not parse a verdict from the reviewer." };
}

/** Spawn `claude -p`, feed the prompt on stdin, resolve its stdout. */
function runClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // `--tools ""` is a valid Claude Code CLI flag (verified to exit 0 with an
    // empty value) that sets the available-tool list to empty, disabling every
    // built-in tool. The prompt embeds untrusted child-session transcript text,
    // and the reviewer only ever needs to emit a JSON verdict - so a
    // crafted/compromised transcript must not be able to steer it into invoking
    // tools (a prompt-injection surface).
    // `detached: true` makes the child its own session/process-group leader with
    // no controlling terminal, so the fleet poller (which groups agents by tty
    // and skips tty-less ones) never discovers this headless reviewer as a
    // phantom session.
    const child = spawn(CLAUDE_BIN, ["-p", "--output-format", "json", "--tools", ""], {
      cwd: tmpdir(),
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      detached: true,
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      killReviewer(child);
      reject(new Error("review timed out"));
    }, REVIEW_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`claude exited ${code}: ${err.slice(0, 300)}`));
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * Terminate a detached reviewer. Because it's spawned `detached`, the child is
 * its own process-group leader, so signalling the negative pid kills it plus any
 * grandchildren it spawned; fall back to a direct kill if the group signal fails.
 */
function killReviewer(child: ReturnType<typeof spawn>): void {
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/**
 * Pull a valid Verdict out of a reviewer's raw stdout. Handles the `claude -p`
 * JSON envelope (`{ result: "<text>" }`), markdown-fenced JSON, or a bare object,
 * trying each candidate against the schema. Returns null when none validate.
 * Pure, exported for tests.
 */
export function extractVerdict(raw: string): Verdict | null {
  const text = resultText(raw);
  for (const candidate of jsonCandidates(text)) {
    let obj: unknown;
    try {
      obj = JSON.parse(candidate);
    } catch {
      continue;
    }
    const r = VerdictSchema.safeParse(obj);
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
