import { randomUUID } from "node:crypto";
import { sleep } from "../../util/timers.ts";
import { piSessionFileForIdentity } from "./transcript.ts";

export interface PiLaunchPreparation {
  args: string[];
  sessionId: string;
}

export function preparePiLaunch(): PiLaunchPreparation {
  const sessionId = randomUUID();
  return { args: ["--session-id", sessionId], sessionId };
}

export interface PiLaunchReadyDeps {
  locate?: typeof piSessionFileForIdentity;
  sleep?: typeof sleep;
  isLive?: () => boolean;
}

export async function waitForPiLaunchReady(
  cwd: string,
  sessionId: string,
  timeoutMs: number,
  settleMs: number,
  deps: PiLaunchReadyDeps = {},
): Promise<boolean> {
  const locate = deps.locate ?? piSessionFileForIdentity;
  const wait = deps.sleep ?? sleep;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (deps.isLive?.() === false) return false;
    if (locate(cwd, sessionId)) {
      await wait(settleMs);
      return deps.isLive?.() !== false;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await wait(Math.min(100, remaining));
  }
}
