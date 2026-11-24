import { createRequire } from "node:module";

/** Load the same machine-wide monotonic clock from a daemon, listener, or Electron installation. */
export function loadVoiceHostClock(addon: string): () => number {
  const binding = createRequire(addon)(addon);
  if (typeof binding.hostTimeUs !== "function") throw new Error("Rebuild the native daemon addon to read the voice host clock.");
  return binding.hostTimeUs;
}
