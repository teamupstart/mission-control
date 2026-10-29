import { expect } from "@playwright/test";
import type { DaemonHandle } from "./daemon.ts";

/** Hooks for an SDK owner carry the native identity established by its driver. */
export async function dispatchedSdkHookIdentity(
  daemon: DaemonHandle,
): Promise<{ cwd: string; sessionId: string }> {
  let identity: { cwd: string; sessionId: string } | null = null;
  await expect.poll(async () => {
    const response = await fetch(`${daemon.baseURL}/api/sessions`);
    expect(response.ok).toBe(true);
    const sessions = await response.json() as {
      runtime: string;
      cwd: string;
      agentSessionId: string | null;
    }[];
    const dispatched = sessions.filter((session) => session.runtime === "sdk");
    expect(dispatched, "exactly one SDK session was dispatched").toHaveLength(1);
    const session = dispatched[0]!;
    identity = session.agentSessionId
      ? { cwd: session.cwd, sessionId: session.agentSessionId }
      : null;
    return identity !== null;
  }, { message: "the SDK driver binds its native identity before its hooks are posted" }).toBe(true);
  return identity!;
}
