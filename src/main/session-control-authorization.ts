import type { UtilityProcess } from "electron";
import type { z } from "zod";
import {
  ResidentLaunchAuthorizationSchema, SessionControlAuthorizationSchema,
  type ResidentLaunchAuthorizationReply, type SessionControlAuthorizationReply,
} from "../shared/session-control-authorization.ts";

/**
 * One kind of trusted click the shell arms and the daemon consumes: the exact input it was armed
 * with, single-use, for 15 seconds. Both session-control authorities - the session menu's
 * setting and a resident's Launch - are this, and differ only in what a consumption must match.
 */
function clickAuthorizations<T extends { requestId: string }>(
  schema: z.ZodType<T>,
  matches: (armed: T, asked: T) => boolean,
) {
  const armed = new Map<string, { input: T; expiresAt: number }>();
  return {
    arm(value: unknown, now = Date.now()): boolean {
      const parsed = schema.safeParse(value);
      if (!parsed.success) return false;
      for (const [id, entry] of armed) if (entry.expiresAt <= now) armed.delete(id);
      if (armed.has(parsed.data.requestId)) return false;
      armed.set(parsed.data.requestId, { input: parsed.data, expiresAt: now + 15_000 });
      return true;
    },
    /** Any ask naming an armed request id consumes it, granted or not. */
    consume(value: unknown): boolean {
      const parsed = schema.safeParse(value);
      if (!parsed.success) return false;
      const entry = armed.get(parsed.data.requestId);
      armed.delete(parsed.data.requestId);
      return !!(entry && entry.expiresAt > Date.now() && matches(entry.input, parsed.data));
    },
    clear(): void { armed.clear(); },
  };
}

const sessionControl = clickAuthorizations(SessionControlAuthorizationSchema,
  (armed, asked) => armed.sessionId === asked.sessionId && armed.enabled === asked.enabled);
const residentLaunch = clickAuthorizations(ResidentLaunchAuthorizationSchema,
  (armed, asked) => armed.profileId === asked.profileId && armed.revision === asked.revision);

/** Called only by IPC from the main dashboard's trusted-click preload capability. */
export function armSessionControlAuthorization(value: unknown, now = Date.now()): boolean {
  return sessionControl.arm(value, now);
}

/**
 * Called only by IPC from the main dashboard's trusted Launch click on a resident whose profile
 * has Control other sessions on. Bound to that launch request, profile and revision.
 */
export function armResidentLaunchAuthorization(value: unknown, now = Date.now()): boolean {
  return residentLaunch.arm(value, now);
}

export function serveSessionControlAuthorization(child: UtilityProcess): void {
  // Restarting the daemon must not inherit a click intended for its predecessor.
  sessionControl.clear();
  residentLaunch.clear();
  child.on("message", (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const { type, id, ...input } = value as Record<string, unknown>;
    if (typeof id !== "string") return;
    if (type === "mission:session-control-authorization") {
      const granted = sessionControl.consume(input);
      child.postMessage({ type: "mission:session-control-authorization-reply", id, granted } satisfies SessionControlAuthorizationReply);
    } else if (type === "mission:resident-launch-authorization") {
      const granted = residentLaunch.consume(input);
      child.postMessage({ type: "mission:resident-launch-authorization-reply", id, granted } satisfies ResidentLaunchAuthorizationReply);
    }
  });
}
