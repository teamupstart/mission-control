import { createHash, randomBytes } from "node:crypto";
import type { TelemetryProfileId, TelemetrySourceIdentity } from "@shared/telemetry.ts";

/** Stable content digest, used for resource ids, context ids and batch digests. */
export function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 32);
}

/**
 * JSON with object keys sorted, so two structurally identical attribute maps digest the same
 * whatever order they were built in. Content addressing is worthless without it.
 */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * The destination-scoped event id for one source fact.
 *
 * Derived rather than random, and that is the idempotency contract: a retry of the same batch
 * carries the same id, while two audiences derive DIFFERENT ids for the same underlying fact
 * so their exported identifiers are not trivially joinable. The profile salt is what does
 * that, and it is the reason this is not just a hash of the source identity.
 */
export function eventIdFor(source: TelemetrySourceIdentity, salt: string): string {
  return `evt-${digest([salt, source.kind, source.id, source.revision])}`;
}

/** A 128-bit trace id as OTLP wants it: 32 lowercase hex characters, never all zero. */
export function newTraceId(): string {
  return nonZeroHex(16);
}

/** A 64-bit span id: 16 lowercase hex characters, never all zero. */
export function newSpanId(): string {
  return nonZeroHex(8);
}

function nonZeroHex(bytes: number): string {
  for (;;) {
    const hex = randomBytes(bytes).toString("hex");
    if (!/^0+$/.test(hex)) return hex;
  }
}

/**
 * The opaque per-profile correlation id an internal identity is translated to before export.
 *
 * Two properties matter and both come from the profile salt. The same session reported to two
 * destinations gets two unrelated ids, so the audiences cannot be joined by a third party; and
 * the mapping is one-way, so a backend holding the id cannot recover the Mission Control
 * session it came from.
 */
export function scopedRef(profile: TelemetryProfileId, salt: string, value: string): string {
  return digest([profile, salt, value]).slice(0, 24);
}
