import type { ZodIssue, ZodTypeAny, TypeOf } from "zod";
import { providerFailureKind, type ProviderFailureKind } from "./provider-failure.ts";

// Asking a model for a VALUE rather than for text, and the two helpers every caller that
// does needs. Provider-neutral by construction: nothing here spawns anything, and nothing
// here names `claude`.
//
// It all lived in `claude-cli.ts`, which was the right place while `claude -p` was the only
// way the app talked to a model. It is not any more (`@shared/llm.ts`), and the retry
// ladder, the concurrency gate and the JSON extraction were never about the provider - they
// are about a model that editorializes in prose, a dashboard that must not fork twenty
// subprocesses, and a reply wrapped in a markdown fence. Left where they were, the first
// caller on a second runner would have copied them.
//
// `runStructured` takes a bound RUN FUNCTION rather than a runner, which is what keeps this
// module free of both `LlmRunner` and `runClaudeText`: the caller has already decided who
// answers and on what model, and this only decides what to do when the answer will not
// parse.

/**
 * The result of one structured run: either a model-produced, schema-valid value
 * (success - INCLUDING a judgment you don't like, e.g. action:"skip") or a
 * transient failure, tagged with WHY under `cause`:
 *
 *   - "transport": the run itself failed - a spawn error, a timeout, a non-zero exit.
 *     Evidence about the machine, not about the instruction it was asked to judge.
 *   - "cancelled": the owning durable operation stopped (daemon shutdown, a withdrawn
 *     request) before or during an attempt. There is nothing to blame and nothing to
 *     record; the next poll or the next daemon tries again with a clean slate.
 *   - "parse": the model answered, but nothing it returned - after the retry - passed
 *     the schema. The one cause that is actually evidence about the model's reply.
 *
 * Callers must treat these differently, which is the whole reason the contract
 * separates them: a genuine judgment is durable, but a failure must never be
 * stamped as one, or a single infra blip would abandon the work for good. `cause`
 * is what lets a caller tell "the machine hiccuped, try again" from "the model
 * actually could not answer" without parsing `reason`'s free text.
 */
export type StructuredResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "failed"; reason: string; cause: "transport" | "parse" | "cancelled"; providerFailure?: ProviderFailureKind };

export interface StructuredAttemptObserver {
  /**
   * Return false when the owning durable operation stopped while a previous attempt
   * was in flight. This keeps the parse retry from starting new provider work after
   * cancellation without making provider-neutral structured calls own that lifecycle.
   */
  start(attempt: number, prompt: string): boolean | void;
  finish(
    attempt: number,
    result: { parsed: boolean; raw: string | null; error: string | null; providerFailure?: ProviderFailureKind },
  ): void;
}

/**
 * A per-caller concurrency gate: `limit(fn)` runs `fn` once a slot is free.
 *
 * Scoped to the caller, never module-global, because the callers want opposite things -
 * Foreman wants its serial review queue left alone, while the daemon wants a hard ceiling
 * on goal refreshes so a 20-card dashboard answering prompts at once can't fork 20
 * subprocesses. It could not be module-global anyway: the daemon and the Foreman worker are
 * SEPARATE PROCESSES, and a shared module cannot enforce a cap across that boundary.
 *
 * The loop (not an `if`) is what makes it correct: a released waiter re-checks the count
 * instead of trusting that the slot it was woken for is still free, so two waiters resumed
 * in the same tick can't both take one slot.
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
 * Ask for a value matching `schema`, retrying once on a parse miss with a stricter
 * reminder (the model occasionally editorializes in prose instead of emitting the raw
 * object, or wraps it in a markdown fence despite being told not to - both observed).
 * Never throws.
 *
 * `run` is the already-bound call - a runner and its model and timeout, or the raw
 * `runClaudeText` a not-yet-migrated caller still holds. It is a parameter rather than
 * something resolved here so that this module has no opinion about who answers.
 *
 * `extract` turns raw output into a candidate value; pass the caller's own ladder so an
 * existing extractor (with its envelope/fence handling) stays the single source of that
 * logic.
 */
// `S` only names the reply's type when a caller states it (`runStructured<typeof Schema>`);
// otherwise `T` is inferred from `extract`, which is the one argument that carries it.
export async function runStructured<S extends ZodTypeAny = ZodTypeAny, T = TypeOf<S>>(
  run: (prompt: string) => Promise<string>,
  prompt: string,
  extract: (raw: string) => T | ModelReplyMiss | null,
  label = "The model",
  observer?: StructuredAttemptObserver,
  opts?: { shapeGuaranteed?: boolean; maxAttempts?: 1 | 2 },
): Promise<StructuredResult<T>> {
  // A provider-guaranteed INPUT shape makes a JSON-syntax re-prompt redundant. Extraction
  // still runs below on every path: callers consume Zod's OUTPUT type, including transforms
  // and refinements no provider-side JSON Schema can execute.
  // A caller that owns its retry budget can independently cap this helper at one execution.
  const attempts = opts?.shapeGuaranteed || opts?.maxAttempts === 1 ? 1 : 2;
  let miss: ModelReplyMiss | null = null;
  for (let index = 0; index < attempts; index++) {
    const p = index === 0 ? prompt : `${prompt}\n\n${retryInstruction(miss)}`;
    const attempt = index + 1;
    let raw: string;
    try {
      if (observer?.start(attempt, p) === false) {
        return {
          kind: "failed",
          reason: `${label} stopped before its next attempt.`,
          cause: "cancelled",
        };
      }
      raw = await run(p);
    } catch (err) {
      const error = String(err);
      const providerFailure = providerFailureKind(err);
      observer?.finish(attempt, { parsed: false, raw: null, error, providerFailure: providerFailure ?? undefined });
      return { kind: "failed", reason: `${label} failed: ${error}`, cause: "transport", providerFailure: providerFailure ?? undefined };
    }
    const value = extract(raw);
    const parsed = value !== null && !(value instanceof ModelReplyMiss);
    observer?.finish(attempt, { parsed, raw, error: null });
    if (parsed && value) return { kind: "ok", value };
    miss = value instanceof ModelReplyMiss ? value : null;
  }
  return {
    kind: "failed",
    reason: miss?.kind === "schema"
      ? `${label} returned a reply that ${replyMissClause(miss)}.`
      : `${label} could not parse a valid reply from the model.`,
    cause: "parse",
  };
}

/**
 * Why a model reply could not be used, in terms safe to hand straight back to the model.
 *
 * `json` means no candidate parsed as JSON at all. `schema` means one did and failed
 * validation; `issues` then names at most `MAX_REPLY_ISSUES` field paths with a clipped
 * message each, built from the issue's code and never from the reply's own content, so a
 * retry prompt can quote it without echoing untrusted text back.
 *
 * A class rather than a tagged object so `runStructured` can tell it apart from any value a
 * caller's schema could produce.
 */
export class ModelReplyMiss {
  constructor(
    readonly kind: "json" | "schema",
    readonly issues: readonly string[] = [],
  ) {}
}

const MAX_REPLY_ISSUES = 3;
const MAX_ISSUE_PATH = 80;
const MAX_ISSUE_MESSAGE = 160;

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

/** A primitive an enum or literal accepts, quoted as JSON where JSON can say it. */
function expectedValue(value: unknown): string {
  return typeof value === "bigint" ? `${value}n` : JSON.stringify(value) ?? String(value);
}

/**
 * The received TYPE of an `invalid_type` issue. Zod 4 drops the input from the issue, so it
 * is read back from Zod's own default message, which names only a type; a custom message
 * gives none.
 */
function receivedType(message: string): string | null {
  return /^Invalid input: expected \S+, received (\S+)$/.exec(message)?.[1] ?? null;
}

/** One `path: message` line per issue. Enum and key issues drop the received value. */
export function describeReplyIssues(issues: readonly ZodIssue[]): string[] {
  return issues.slice(0, MAX_REPLY_ISSUES).map((issue) => {
    const path = issue.path.length ? clip(issue.path.map(String).join("."), MAX_ISSUE_PATH) : "(root)";
    const received = issue.code === "invalid_type" ? receivedType(issue.message) : null;
    const message = issue.code === "invalid_type"
      ? `Expected ${issue.expected}${received ? `, received ${received}` : ""}`
      : issue.code === "invalid_value"
        ? `Expected one of ${issue.values.map(expectedValue).join(" | ")}`
        : issue.code === "unrecognized_keys"
          ? "Unrecognized key(s) in object"
          : issue.message;
    return `${path}: ${clip(message, MAX_ISSUE_MESSAGE)}`;
  });
}

/**
 * A miss as a clause: "was not valid JSON", or "did not match the required shape (...)".
 * For callers that phrase their own correction, such as the workflow engine's.
 */
export function replyMissClause(miss: ModelReplyMiss): string {
  return miss.kind === "json" || !miss.issues.length
    ? "was not valid JSON"
    : `was valid JSON but did not match the required shape (${miss.issues.join("; ")})`;
}

/** The retry instruction for a miss: it says what was actually wrong, and no more. */
function retryInstruction(miss: ModelReplyMiss | null): string {
  if (miss?.kind === "json") {
    return "Your previous reply was not valid JSON. Reply with ONLY the JSON object.";
  }
  if (miss?.kind === "schema" && miss.issues.length) {
    return [
      "Your previous reply was valid JSON but did not match the required shape:",
      ...miss.issues.map((issue) => `- ${issue}`),
      ...(miss.issues.some((issue) => issue.endsWith("received null"))
        ? ["Omit an optional field you have no value for instead of sending null."]
        : []),
      "Reply with ONLY the corrected JSON object.",
    ].join("\n");
  }
  return "Your previous reply could not be used. Reply with ONLY the JSON object in the required shape.";
}

/**
 * Pull a schema-valid object out of a model's raw output. Handles a `claude -p` JSON
 * envelope (`{ result: "<text>" }`), markdown-fenced JSON, or a bare object, trying each
 * candidate against the schema. Returns null when none validate.
 *
 * It had already been copied verbatim into two callers (the reviewer and the queue
 * verifier) before a third (the goal refiner) needed it.
 *
 * The ENVELOPE branch is tolerance for a migration in progress, and it is idempotent
 * either way. `LlmRunner.run` strips its own provider's envelope before returning - a
 * caller that unwrapped a runner's answer would be undoing its own runner's flag - so a
 * migrated caller's text arrives here already bare and this branch does nothing. The
 * callers still holding `runClaudeText` directly hand over the envelope, and they are what
 * it is here for; it goes when the last of them does. A bare JSON object with no `result`
 * key falls through unchanged, so nothing is lost by trying.
 *
 * The fence branch is not defensive padding: a model returns ```json … ``` despite being
 * told not to, observed on a real probe.
 */
export function parseModelJson<S extends ZodTypeAny>(raw: string, schema: S): TypeOf<S> | null {
  const value = parseModelReply(raw, schema);
  return value instanceof ModelReplyMiss ? null : value;
}

/**
 * `parseModelJson`, but a miss says why: the extractor to hand `runStructured`, so its retry
 * names the real problem. Issues come from the first candidate that parsed as JSON, which
 * is the most specific one the ladder found.
 */
export function parseModelReply<S extends ZodTypeAny>(raw: string, schema: S): TypeOf<S> | ModelReplyMiss {
  let firstIssues: ZodIssue[] | null = null;
  for (const candidate of jsonCandidates(unwrapEnvelope(raw))) {
    let obj: unknown;
    try {
      obj = JSON.parse(candidate);
    } catch {
      continue;
    }
    const r = schema.safeParse(obj);
    if (r.success) return r.data;
    firstIssues ??= r.error.issues;
  }
  return firstIssues
    ? new ModelReplyMiss("schema", describeReplyIssues(firstIssues))
    : new ModelReplyMiss("json");
}

/**
 * Unwrap a `{ result: "<text>" }` envelope to its text, or hand back the input.
 *
 * The ONE definition, re-exported as `resultText` from `claude-cli.ts` where it is the
 * `--output-format json` envelope specifically. It sits here rather than there because
 * `parseModelJson` needs it and a neutral parser must not import the Claude module - and
 * because two copies of "is this an envelope?" is how one of them starts answering
 * differently.
 */
export function unwrapEnvelope(raw: string): string {
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
