import { randomUUID } from "node:crypto";
import { sleep } from "../../util/timers.ts";
import { piMessages, piSessionFileForIdentity } from "./transcript.ts";

const DEFAULT_READY_TIMEOUT_MS = 20_000;
const DEFAULT_ACCEPT_TIMEOUT_MS = 15_000;

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
  now?: () => number;
}

export async function waitForPiLaunchReady(
  cwd: string,
  sessionId: string,
  timeoutMs: number,
  settleMs: number,
  deps: PiLaunchReadyDeps = {},
): Promise<string | null> {
  const locate = deps.locate ?? piSessionFileForIdentity;
  const wait = deps.sleep ?? sleep;
  const now = deps.now ?? Date.now;
  const safeTimeout =
    Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : DEFAULT_READY_TIMEOUT_MS;
  const deadline = now() + safeTimeout;

  for (;;) {
    if (deps.isLive?.() === false) return null;
    const path = locate(cwd, sessionId);
    if (path) {
      await wait(settleMs);
      return deps.isLive?.() === false ? null : path;
    }
    const remaining = deadline - now();
    if (remaining <= 0) return null;
    await wait(Math.min(100, remaining));
  }
}

export interface PiPromptAcceptanceDeps {
  sleep?: typeof sleep;
  isLive?: () => boolean;
  now?: () => number;
}

export function piPromptBaseline(path: string): number | null {
  return piMessages.size(path);
}

export async function waitForPiPromptAccepted(
  path: string,
  offset: number,
  timeoutMs: number,
  deps: PiPromptAcceptanceDeps = {},
): Promise<boolean> {
  const wait = deps.sleep ?? sleep;
  const now = deps.now ?? Date.now;
  const safeTimeout =
    Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : DEFAULT_ACCEPT_TIMEOUT_MS;
  const deadline = now() + safeTimeout;

  for (;;) {
    if (deps.isLive?.() === false) return false;
    const appended = piMessages.since(path, offset);
    if (appended.reset) return false;
    if (appended.messages.some((message) => message.role === "user")) return true;
    const remaining = deadline - now();
    if (remaining <= 0) return false;
    await wait(Math.min(100, remaining));
  }
}
