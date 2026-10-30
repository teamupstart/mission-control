import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const ModelWindows = z.object({ models: z.array(z.object({
  slug: z.string(), context_window: z.number().int().positive(),
  effective_context_window_percent: z.number().positive().max(100),
})) });
/** Read the native model catalog, never guess a window from a model's name. */
export function codexResidentCompactionArgs(model: string | null, threshold: number,
  path = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "models_cache.json")): string[] {
  let window: number | null = null;
  try {
    if (statSync(path).size <= 4_000_000) {
      const catalog = ModelWindows.parse(JSON.parse(readFileSync(path, "utf8")));
      const entry = catalog.models.find((entry) => entry.slug === model);
      if (entry) window = Math.floor(entry.context_window * entry.effective_context_window_percent / 100);
    }
  } catch { /* Missing native metadata must not silently use a fabricated window. */ }
  if (!window) throw new Error("Codex's context window is unavailable for this resident model. Choose an explicit model present in the native Codex model catalog.");
  return ["-c", `model_auto_compact_token_limit=${Math.floor(window * threshold / 100)}`];
}
