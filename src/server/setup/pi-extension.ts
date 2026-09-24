import { canInstallPiExtension } from "../environment/pi-extension.ts";
import { applyPiExtensionConfig } from "../extensions/config.ts";

export type PiExtensionInstallResult = { ok: true; detail: string } | { ok: false; status: 409 | 500; detail: string };

/** One publisher for first install, repair, source development and app updates. */
export async function installPiExtensionFromSetup(): Promise<PiExtensionInstallResult> {
  if (!canInstallPiExtension()) return { ok: false, status: 409, detail: "The Pi extension entry isn't ours to replace. Move the foreign entry before installing from Setup." };
  try {
    const result = await applyPiExtensionConfig({ enabled: true });
    if (result.problems.length) return { ok: false, status: 500, detail: result.problems.join(" ") };
    return { ok: true, detail: "Pi integration installed. Start a fresh Pi session to load it." };
  } catch {
    return { ok: false, status: 500, detail: "The Pi integration could not be published. Re-check Setup and retry." };
  }
}
