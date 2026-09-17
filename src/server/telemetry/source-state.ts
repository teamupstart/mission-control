import { TELEMETRY_LIMITS } from "@shared/telemetry.ts";
import { openDb } from "../db.ts";
import { noteBytesAdded, usedBytesForAdmission } from "./store.ts";

/** Source-local versioned checkpoints. Call inside the same telemetry savepoint as capture. */
export function readSourceState<T>(namespace: string, id: string, now: number): T | null {
  const row = openDb().prepare(`SELECT state_json FROM telemetry_source_state
    WHERE namespace = ? AND id = ? AND version = 1 AND expires_at > ?`).get(namespace, id, now) as
    { state_json: string } | undefined;
  return row ? JSON.parse(row.state_json) as T : null;
}

export function writeSourceState(namespace: string, id: string, state: unknown, now: number): void {
  const json = JSON.stringify(state);
  const bytes = Buffer.byteLength(json) + Buffer.byteLength(id) + namespace.length + 32;
  const d = openDb();
  const prior = d.prepare("SELECT bytes FROM telemetry_source_state WHERE namespace = ? AND id = ?")
    .get(namespace, id) as { bytes: number } | undefined;
  const added = bytes - (prior?.bytes ?? 0);
  if (bytes > TELEMETRY_LIMITS.maxEventBytes
    || usedBytesForAdmission(d, Math.max(0, added)) + added > TELEMETRY_LIMITS.maxTotalBytes) {
    throw new Error("telemetry source checkpoint exceeds its budget");
  }
  d.prepare(`INSERT INTO telemetry_source_state VALUES (?, ?, 1, ?, ?, ?)
    ON CONFLICT(namespace, id) DO UPDATE SET version = 1, state_json = excluded.state_json,
      bytes = excluded.bytes, expires_at = excluded.expires_at`).run(
    namespace, id, json, bytes, now + TELEMETRY_LIMITS.reducerStateRetentionMs,
  );
  noteBytesAdded(added);
}
