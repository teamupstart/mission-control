import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

// Desktop-owned, like the receipt and outcome. Updating must work without a healthy daemon.
export const UpdatePreferencesSchema = z.object({ alpha: z.boolean().default(false) });
export type UpdatePreferences = z.infer<typeof UpdatePreferencesSchema>;

export function readUpdatePreferences(path: string): UpdatePreferences {
  try {
    return UpdatePreferencesSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { alpha: false };
  }
}

export function writeUpdatePreferences(path: string, input: unknown): UpdatePreferences {
  const preferences = UpdatePreferencesSchema.strict().parse(input);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(preferences)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return preferences;
}
