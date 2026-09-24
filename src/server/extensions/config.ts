import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { acquireHelperLock, releaseHelperLock, realHelperLockOperations } from "../../../scripts/update-lock.mjs";
import { stateDir } from "@shared/harness-runtime.mjs";
import { assertTestStateIsolation } from "../state/isolation.ts";
import { publishPiIntegration } from "./pi-publisher.ts";
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

// Serialize daemon startup, Setup and configuration writes across asynchronous probes.
let operation: Promise<unknown> = Promise.resolve();
function serialize<T>(run: () => Promise<T>): Promise<T> {
  const locked = async () => {
    const home = stateDir();
    assertTestStateIsolation(join(home, "pi-extension.json"));
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const directory = join(home, "pi-extension.lock.d");
    const ops = realHelperLockOperations();
    const lock = acquireHelperLock(directory, ops);
    if (!lock.ok || !lock.entryName) throw new Error("Another Pi integration publication is in progress. Retry from Setup.");
    try { return await run(); }
    finally { releaseHelperLock(directory, lock.entryName, ops); }
  };
  const next = operation.then(locked, locked);
  operation = next.catch(() => {});
  return next;
}
export function reconcilePiExtension() {
  return serialize(async () => getPiExtensionConfig().enabled
    ? publishPiIntegration() : reconcileExtensionLink(false));
}

/** Intent commits only after a verified generation and its discovery link are published.
 * The link publisher restores the previous link if committing the staged intent fails. */
export function applyPiExtensionConfig(input: z.input<typeof PiExtensionConfigPatchSchema>) {
  const config = PiExtensionConfigPatchSchema.parse(input);
  const home = stateDir();
  assertTestStateIsolation(join(home, "pi-extension.json"));
  return serialize(async () => {
    getPiExtensionConfig(); // Malformed/unreadable intent is never overwritten.
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const stage = mkdtempSync(join(home, ".pi-extension-"));
    try {
      const staged = join(stage, "intent.json");
      writeFileSync(staged, JSON.stringify(config) + "\n", { mode: 0o600 });
      const commit = () => renameSync(staged, join(home, "pi-extension.json"));
      // Off remains durable even if a foreign entry prevents removal.
      if (!config.enabled) commit();
      const result = config.enabled ? await publishPiIntegration(commit) : reconcileExtensionLink(false);
      return { ...result, config: getPiExtensionConfig() };
    } finally { rmSync(stage, { recursive: true, force: true }); }
  });
}
