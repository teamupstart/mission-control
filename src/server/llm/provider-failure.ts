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

export class ProviderFailure extends Error {
  readonly kind: ProviderFailureKind;

  constructor(message: string, code?: string | null, kind?: ProviderFailureKind) {
    const bounded = message.replace(/\s+/g, " ").trim().slice(0, 300) || "Provider returned an error";
    super(bounded);
    this.name = "ProviderFailure";
    this.kind = kind ?? (isTokenExhaustion(bounded, code) ? "token_exhausted" : "retryable");
  }
}

/** Claude's result frame distinguishes provider refusal from CLI and tool failures. */
export function claudeProviderFailure(frame: Record<string, unknown>): ProviderFailure | null {
  if (frame.type !== "result" || frame.is_error !== true) return null;
  const reason = typeof frame.terminal_reason === "string" ? frame.terminal_reason : "";
  const errors = Array.isArray(frame.errors)
    ? frame.errors.filter((value): value is string => typeof value === "string").join("; ")
    : "";
  if (!["api_error", "model_error", "blocking_limit", "rapid_refill_breaker", "prompt_too_long", "budget_exhausted"].includes(reason)
    && !isTokenExhaustion(errors)) return null;
  const subtype = typeof frame.subtype === "string" ? frame.subtype : "error";
  return new ProviderFailure(`Claude ${subtype} (${reason})${errors ? `: ${errors}` : ""}`, reason);
}

export function providerFailureKind(error: unknown): ProviderFailureKind | null {
  return error instanceof ProviderFailure ? error.kind : null;
}
