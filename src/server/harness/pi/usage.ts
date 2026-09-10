import type { HarnessUsageEvent, UsageSpec } from "../types.ts";
import { readJsonlUsage } from "../usage-jsonl.ts";

/** Immutable provenance for Pi's own pricing, not a Mission Control rate snapshot. */
export const PI_PRICE_VERSION = "pi-reported-v3";

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parse(raw: string): Record<string, unknown> | null {
  try {
    return object(JSON.parse(raw));
  } catch {
    return null;
  }
}

function nonNegative(value: unknown, optional = false): number | null {
  if (value === undefined && optional) return 0;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseRecord(
  raw: string,
  modelId: string | null,
): { modelId: string | null; event: HarnessUsageEvent | null } {
  const record = parse(raw);
  if (record?.type === "model_change") {
    return {
      modelId: typeof record.provider === "string" && record.provider &&
        typeof record.modelId === "string" && record.modelId
        ? `${record.provider}/${record.modelId}` : null,
      event: null,
    };
  }
  const message = object(record?.message);
  const usage = object(message?.usage);
  if (record?.type !== "message" || message?.role !== "assistant" || !usage) {
    return { modelId, event: null };
  }
  const input = nonNegative(usage.input);
  const output = nonNegative(usage.output);
  const cacheRead = nonNegative(usage.cacheRead);
  const cacheWrite = nonNegative(usage.cacheWrite);
  const reasoningOutput = nonNegative(usage.reasoning, true);
  const ts = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
  if (input === null || output === null || cacheRead === null || cacheWrite === null ||
    reasoningOutput === null || !Number.isFinite(ts) ||
    typeof record.id !== "string" || !record.id) {
    return { modelId, event: null };
  }
  return {
    modelId,
    event: {
      // The session header proves attribution; the message entry id deduplicates requests.
      // Reusing the header id here would silently discard every charge after the first.
      identity: record.id,
      ts,
      modelId,
      querySource: "main",
      input,
      output,
      cacheRead,
      cacheWrite,
      reasoningOutput,
      vendorCostUsd: nonNegative(object(usage.cost)?.total),
    },
  };
}

export const piUsage: UsageSpec = {
  read(path, cursor, maxBytes) {
    return readJsonlUsage(path, cursor, maxBytes, {
      headBytes: 64 * 1024,
      header(raw, complete) {
        const header = complete ? parse(raw) : null;
        const sourceId = header?.type === "session" && typeof header.id === "string" && header.id
          ? header.id : null;
        return { sourceId, supported: sourceId !== null && header?.version === 3 };
      },
      record: parseRecord,
    });
  },
  estimate(event) {
    return event.vendorCostUsd === null ? null : {
      costUsd: event.vendorCostUsd,
      pricingModel: event.modelId ?? "",
      pricingVersion: PI_PRICE_VERSION,
    };
  },
};
