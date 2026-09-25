import { basename, dirname, join, resolve } from "node:path";
import { stateDir } from "@shared/harness-runtime.mjs";

/** Publication, retention and ownership share this one managed namespace. */
export const piIntegrationRoot = () => resolve(stateDir(), "integrations", "pi");

export function piGenerationPath(buildId: string): string {
  if (!/^[a-f0-9]{64}$/.test(buildId)) throw new Error("Invalid Pi integration build ID");
  return join(piIntegrationRoot(), buildId);
}

export function isManagedPiExtensionTarget(target: string): boolean {
  const parent = dirname(resolve(target));
  return /^[a-f0-9]{64}$/.test(basename(parent))
    && parent === piGenerationPath(basename(parent)) && basename(target) === "extension.js";
}
