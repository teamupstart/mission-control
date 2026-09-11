import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { transientCheckoutRoot } from "../../../hooks/install-checks.mjs";
import { piExtensionPath } from "../config.ts";
import { canInstallPiExtension, inspectPiExtension } from "../environment/pi-extension.ts";
import { applyPiExtensionConfig } from "../extensions/config.ts";

/** Explicit first install only. Existing/broken installs keep the manual repair boundary. */
export async function installPiExtensionFromSetup(): Promise<{ ok: boolean; detail: string }> {
  if (!canInstallPiExtension()) return { ok: false, detail: "The Pi integration is already enabled or an extension entry exists. Follow the Pi extension warning's manual installer instructions." };
  const output = resolve(piExtensionPath());
  let canonical = output;
  try { canonical = realpathSync(output); } catch { /* The health preflight reports missing output. */ }
  if (transientCheckoutRoot(dirname(output)) || transientCheckoutRoot(dirname(canonical))) {
    return { ok: false, detail: "Pi integration must be installed from a durable Mission Control clone or app installation, not a pooled worktree." };
  }
  // Check before publishing a machine-wide executable. A first install must not create
  // the load-time outage that the report-only check exists to explain.
  const candidate = await inspectPiExtension(piExtensionPath());
  if (!candidate.healthy) return { ok: false, detail: candidate.warning ?? "Build the Pi extension before installing it from Setup." };
  if (!canInstallPiExtension()) return { ok: false, detail: "The Pi installation changed while it was being checked. Re-check Setup and follow its manual instructions." };
  const result = applyPiExtensionConfig({ enabled: true });
  if (result.problems.length) return { ok: false, detail: result.problems.join(" ") };
  const reading = await inspectPiExtension();
  return reading.healthy
    ? { ok: true, detail: "Pi integration installed. Start a fresh Pi session to load it." }
    : { ok: false, detail: reading.warning ?? "Pi integration was enabled, but its installation could not be verified. Follow the manual installer instructions." };
}
