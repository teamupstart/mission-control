import { z } from "zod";
import type { RateLimits } from "@shared/types.ts";
import { openDb } from "./db.ts";

const savedWindow = z.object({
  usedPercentage: z.number().finite().min(0).max(100),
  resetsAt: z.number().finite().positive(),
  recordedAt: z.number().finite().nonnegative(),
});
const savedReading = z.object({
  fiveHour: savedWindow.nullable(),
  sevenDay: savedWindow.nullable(),
  updatedAt: z.number().finite().nonnegative(),
});

/** One account snapshot in the daemon's database, not a session or a usage ledger row. */
export function loadClaudeRateLimits(): RateLimits | null {
  const row = openDb().prepare("SELECT reading_json FROM claude_rate_limit_cache WHERE id = 1")
    .get() as { reading_json: string } | undefined;
  if (!row) return null;
  try {
    const parsed = savedReading.safeParse(JSON.parse(row.reading_json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function saveClaudeRateLimits(reading: RateLimits): void {
  const parsed = savedReading.safeParse(reading);
  if (!parsed.success) return;
  openDb().prepare(`INSERT INTO claude_rate_limit_cache (id, reading_json) VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET reading_json = excluded.reading_json`)
    .run(JSON.stringify(parsed.data));
}
