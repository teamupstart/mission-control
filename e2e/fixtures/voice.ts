import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  VOICE_LISTENER_PROTOCOL_VERSION,
  type VoiceListenerHello,
} from "../../src/shared/voice.ts";
import type { DaemonHandle } from "./daemon.ts";

/**
 * Voice fixtures (contract B of the voice plan): a stand-in listener, so a spec reaches the mode
 * `listening` on any platform with no microphone, model or macOS.
 *
 * Specs speak to the daemon as a listener would, under the daemon's own token, and never start
 * a recognizer. Phase 3 adds `say` here.
 */

/** How often the stand-in sends a hello: well inside the daemon's 30 second lapse. */
const HELLO_EVERY_MS = 3000;

/** The hello the stand-in sends: a loaded model and a granted microphone. */
export const LISTENER_HELLO: VoiceListenerHello = {
  backend: "sherpa-onnx",
  version: VOICE_LISTENER_PROTOCOL_VERSION,
  devices: [{ id: "built-in", name: "Built-in microphone", builtIn: true }],
  modelLoaded: true,
  microphone: "granted",
};

export function voiceToken(daemon: DaemonHandle): string {
  return readFileSync(join(daemon.home, "token"), "utf8").trim();
}

/** Send one hello. Resolves to the daemon's HTTP status. */
export async function sendHello(daemon: DaemonHandle, hello: Partial<VoiceListenerHello> = {}): Promise<number> {
  const response = await fetch(`${daemon.baseURL}/voice/listener/hello`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": voiceToken(daemon) },
    body: JSON.stringify({ ...LISTENER_HELLO, ...hello }),
  });
  await response.body?.cancel();
  return response.status;
}

export interface Listener {
  /** Stop sending hellos. The daemon reads `unavailable` once the last one lapses. */
  stop(): void;
}

/**
 * Be a listener: send a hello now and every few seconds until stopped. A hello refused while
 * the `voice` flag is off (404) is not an error, so a spec may start this before it turns voice
 * on. Stop it in the test's teardown.
 */
export async function beListener(daemon: DaemonHandle, hello: Partial<VoiceListenerHello> = {}): Promise<Listener> {
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try { await sendHello(daemon, hello); }
    catch { /* the daemon is stopping; the next tick, if any, tries again */ }
  };
  await tick();
  const timer = setInterval(() => void tick(), HELLO_EVERY_MS);
  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}
