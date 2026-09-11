import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { stateDir } from "@shared/harness-runtime.mjs";
import { assertTestStateIsolation } from "../state/isolation.ts";
import { reconcileExtensionLink } from "../skills/reconcile.ts";

export const PiExtensionConfigPatchSchema = z.object({ enabled: z.boolean() }).strict();

/** One machine-local intent, shared by the daemon and standalone installer. */
export function getPiExtensionConfig(): { enabled: boolean } {
  let text: string;
  try { text = readFileSync(join(stateDir(), "pi-extension.json"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { enabled: false };
    throw error;
  }
  return PiExtensionConfigPatchSchema.parse(JSON.parse(text));
}

export function reconcilePiExtension() {
  return reconcileExtensionLink(getPiExtensionConfig().enabled);
}

/**
 * Persist explicit intent even if disk is blocked. One atomic file lets an operator
 * install before the running daemon has this API, without bypassing its SQLite owner.
 * Unknown/unreadable intent is refused rather than overwritten or treated as off.
 */
export function applyPiExtensionConfig(input: z.input<typeof PiExtensionConfigPatchSchema>) {
  const config = PiExtensionConfigPatchSchema.parse(input);
  const home = stateDir();
  assertTestStateIsolation(join(home, "pi-extension.json"));
  getPiExtensionConfig();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const stage = mkdtempSync(join(home, ".pi-extension-"));
  try {
    const staged = join(stage, "intent.json");
    writeFileSync(staged, JSON.stringify(config) + "\n", { mode: 0o600 });
    renameSync(staged, join(home, "pi-extension.json"));
  } finally { rmSync(stage, { recursive: true, force: true }); }
  return { ...reconcileExtensionLink(config.enabled), config };
}
