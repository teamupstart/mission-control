import { createRequire } from "node:module";
import { nativeStateLockAddonPath } from "../state-ownership-native.ts";

const require = createRequire(import.meta.url);
let readHostClock: (() => number) | undefined;

/** Microseconds on the listener and shell's host clock, including across process restarts. */
export function voiceHostTimeUs(): number {
  if (!readHostClock) {
    const binding = require(nativeStateLockAddonPath());
    if (typeof binding.hostTimeUs !== "function") throw new Error("Rebuild the native daemon addon to read the voice host clock.");
    readHostClock = binding.hostTimeUs as () => number;
  }
  return readHostClock();
}
