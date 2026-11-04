/** A failure emitted by a provider, rather than by the local runner or its timeout. */
export type ProviderFailureKind = "retryable" | "token_exhausted";

const TOKEN_EXHAUSTION_CODES = new Set([
  "budget_exhausted",
  "context_length_exceeded",
  "credits_required",
  "insufficient_quota",
  "max_output_tokens",
  "prompt_too_long",
  "usage_limit_reached",
]);

/**
 * Codex currently exposes only a message on its failure events. Match explicit exhaustion
 * diagnostics, never a generic 429 or "rate limit", which may clear during the retry window.
 */
export function isTokenExhaustion(message: string, code?: string | null): boolean {
  if (code && TOKEN_EXHAUSTION_CODES.has(code.toLowerCase())) return true;
  return /\b(?:context_length_exceeded|insufficient_quota|credits_required|max_output_tokens|prompt_too_long|usage_limit_reached)\b/i.test(message)
    || /\b(?:context window|prompt|input) (?:is )?(?:too long|exceeds? (?:the )?(?:model )?(?:token|context) limit)\b/i.test(message)
    || /\b(?:maximum context length|too many input tokens|input exceeds? (?:the )?context window)\b/i.test(message)
    || /\b(?:usage limit reached|hit your usage limit|out of credits|credits exhausted)\b/i.test(message);
}

/**
 * True when a provider's error text says the MODEL is out of capacity, not the account.
 *
 * Covers the wording each harness ends a turn with once its own retries are spent: Codex's
 * "Selected model is at capacity", Claude Code's "Repeated 529 Overloaded errors" and its
 * "Opus is experiencing high load" off-switch, a raw `overloaded_error` envelope, and the
 * API's "temporarily limiting requests (not your usage limit)". Usage and quota exhaustion
 * never match: waiting a minute does not refill a plan.
 */
export function isProviderCapacityMessage(message: string): boolean {
  if (isTokenExhaustion(message)) return false;
  return /\b(?:at capacity|overloaded(?:_error)?|repeated 529|529 overloaded|experiencing high load|temporarily limiting requests)\b/i.test(message);
}

export class ProviderFailure extends Error {
  readonly kind: ProviderFailureKind;

  constructor(message: string, code?: string | null, kind?: ProviderFailureKind) {
    const normalized = message.replace(/\s+/g, " ").trim();
    const bounded = normalized.slice(0, 300) || "Provider returned an error";
    super(bounded);
    this.name = "ProviderFailure";
    this.kind = kind ?? (isTokenExhaustion(normalized, code) ? "token_exhausted" : "retryable");
  }
}

/** Claude's result frame distinguishes provider refusal from CLI and tool failures. */
export function claudeProviderFailure(frame: Record<string, unknown>): ProviderFailure | null {
  if (frame.type !== "result" || frame.is_error !== true) return null;
  const reason = typeof frame.terminal_reason === "string" ? frame.terminal_reason : "";
  const errors = Array.isArray(frame.errors)
    ? frame.errors.filter((value): value is string => typeof value === "string").join("; ")
    : "";
  if (!["api_error", "model_error", "blocking_limit", "rapid_refill_breaker", "prompt_too_long", "budget_exhausted"].includes(reason)) return null;
  const subtype = typeof frame.subtype === "string" ? frame.subtype : "error";
  return new ProviderFailure(`Claude ${subtype} (${reason})${errors ? `: ${errors}` : ""}`, reason);
}

export function providerFailureKind(error: unknown): ProviderFailureKind | null {
  return error instanceof ProviderFailure ? error.kind : null;
}
