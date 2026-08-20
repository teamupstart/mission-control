import type { LlmSpendModelUsage } from "@shared/llm-spend.ts";

// How Claude Code reports what a unit of work cost, read in ONE place.
//
// Two callers, two transports, one payload shape - which is the entire reason this file
// exists rather than a second parser living next to each of them:
//
//   `claude -p --output-format json`  -> the whole stdout IS the envelope (llm/claude.ts)
//   the Agent SDK's message stream    -> the `result` frame carries the same keys (sdk.ts)
//
// That is not an assumption; it is checked on the wire. A `result` frame off the stream
// carries `modelUsage`, `usage`, `total_cost_usd` and `session_id` with byte-identical
// names and nesting to the headless envelope, because both are the same struct serialized
// by the same CLI. The `uuid` the stream adds is the only difference that matters here, and
// it belongs to the caller that has one (see `claudeEnvelopeTurnId`). The values themselves
// are one-shot totals in the first transport and query-to-date totals in the streaming one;
// the SDK adapter converts the latter to deltas after this shared parser has read them.
//
// Keeping the reader here is what stops the two from drifting. They previously could not
// drift because only one of them read usage at all - the SDK driver threw the frame away
// and Claude session spend depended entirely on OpenTelemetry. Now that both read it, a
// change to Anthropic's tier names has exactly one place to land.

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The per-model token breakdown, preferring the model that ACTUALLY served each request.
 *
 * `modelUsage` is read before the flat `usage` block for two reasons, and the second is the
 * one that decides real money.
 *
 * It names the model that ACTUALLY served each request. A run that asked for one model and was
 * served by another - a fallback, an alias resolving differently, a haiku summarization turn
 * folded into an opus conversation - would otherwise be filed under the id we asked for, and
 * the ledger's `model_id` would quietly stop meaning what it says.
 *
 * And it is the only one of the two that INCLUDES SUBAGENTS. Measured on a real two-turn run
 * that spawned one `Task` subagent: `modelUsage` reported 78,321 tokens against the flat
 * block's 52,380, and `total_cost_usd` agreed with `modelUsage`. The flat block counts the
 * main thread alone. Reading it by preference would silently under-report every session that
 * delegates - roughly a third on that run, and far more on a fleet whose agents fan out - and
 * it would under-report SILENTLY, because both numbers are internally consistent and neither
 * looks wrong beside the other. The exporter this replaced split the same usage across its
 * `query_source` attribute (`main` / `subagent` / `auxiliary`) and so counted it too, which is
 * the parity that has to hold for the switch to be a fix rather than a trade.
 *
 * The flat block is the fallback for an envelope carrying no breakdown, and only then is
 * `requestedModel` used, because only then is it the best answer available.
 *
 * Note the tier convention needs no subtraction: Anthropic reports `input_tokens` EXCLUSIVE
 * of the two cache tiers, which is already what the ledger stores. See `codexTokenSplit`
 * for the other half of that story.
 *
 * Returns `[]` for an envelope with neither shape. Callers decide what that means - a
 * headless report drops it, and a driver turn writes no ledger row - because "no usage" is
 * a legitimate result frame for a turn that failed before it reached the model, and
 * inventing a zero row for it would put spend in the ledger for a call that never happened.
 */
export function claudeEnvelopeModels(
  envelope: Record<string, unknown>,
  requestedModel: string,
): LlmSpendModelUsage[] {
  const models: LlmSpendModelUsage[] = [];
  const perModel = envelope.modelUsage;
  if (perModel && typeof perModel === "object") {
    for (const [modelId, value] of Object.entries(perModel as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const u = value as Record<string, unknown>;
      models.push({
        modelId,
        input: number(u.inputTokens),
        output: number(u.outputTokens),
        // Claude reports no reasoning tier of its own; the ledger column stays 0 rather
        // than borrowing output, which would double-count it against the token total.
        reasoningOutput: 0,
        cacheRead: number(u.cacheReadInputTokens),
        cacheWrite: number(u.cacheCreationInputTokens),
        reportedCostUsd: typeof u.costUSD === "number" ? u.costUSD : null,
      });
    }
  }
  if (models.length > 0) return models;
  const usage = envelope.usage;
  if (!usage || typeof usage !== "object") return [];
  const u = usage as Record<string, unknown>;
  models.push({
    modelId: requestedModel,
    input: number(u.input_tokens),
    output: number(u.output_tokens),
    reasoningOutput: 0,
    cacheRead: number(u.cache_read_input_tokens),
    cacheWrite: number(u.cache_creation_input_tokens),
    reportedCostUsd: typeof envelope.total_cost_usd === "number" ? envelope.total_cost_usd : null,
  });
  return models;
}

/**
 * The dedup identity of one result, as the SDK's `result` frame supplies it.
 *
 * A session emits one `result` per turn and a fresh uuid on each. The usage values on that
 * frame are cumulative for the SDK `query()`, so the uuid does not make them per-turn. Once
 * the driver differences the snapshot, however, it is exactly the identity
 * `usage_ledger.window_end_ns` wants: re-recording the same result becomes a conflict rather
 * than a second row.
 *
 * Null rather than a synthesized fallback when the frame carries none. A counter would be
 * the obvious substitute and is the wrong one: it restarts at zero when the daemon does, so
 * a resumed session's second turn would collide with its first and silently overwrite real
 * spend. Declining to attribute an unidentifiable turn loses one turn; a colliding key
 * corrupts the running total.
 */
export function claudeEnvelopeTurnId(envelope: Record<string, unknown>): string | null {
  const uuid = envelope.uuid;
  return typeof uuid === "string" && uuid ? uuid : null;
}
