import { nativeStateLockAddonPath } from "../state-ownership-native.ts";
import { loadVoiceHostClock } from "./native-clock.ts";

let readHostClock: (() => number) | undefined;
/** Microseconds on the listener and shell's host clock, including across process restarts. */
export function voiceHostTimeUs(): number {
  readHostClock ??= loadVoiceHostClock(nativeStateLockAddonPath());
  return readHostClock();
}
