import type { UtilityProcess } from "electron";
import {
  SessionControlAuthorizationSchema,
  type SessionControlAuthorization, type SessionControlAuthorizationReply,
} from "../shared/session-control-authorization.ts";

const armed = new Map<string, { input: SessionControlAuthorization; expiresAt: number }>();

/** Called only by IPC from the main dashboard's trusted-click preload capability. */
export function armSessionControlAuthorization(value: unknown, now = Date.now()): boolean {
  const parsed = SessionControlAuthorizationSchema.safeParse(value);
  if (!parsed.success) return false;
  for (const [id, entry] of armed) if (entry.expiresAt <= now) armed.delete(id);
  if (armed.has(parsed.data.requestId)) return false;
  armed.set(parsed.data.requestId, { input: parsed.data, expiresAt: now + 15_000 });
  return true;
}

export function serveSessionControlAuthorization(child: UtilityProcess): void {
  // Restarting the daemon must not inherit a click intended for its predecessor.
  armed.clear();
  child.on("message", (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const { type, id, ...input } = value as Record<string, unknown>;
    if (type !== "mission:session-control-authorization" || typeof id !== "string") return;
    const parsed = SessionControlAuthorizationSchema.safeParse(input);
    const entry = parsed.success ? armed.get(parsed.data.requestId) : undefined;
    const granted = !!(parsed.success && entry && entry.expiresAt > Date.now()
      && entry.input.sessionId === parsed.data.sessionId && entry.input.enabled === parsed.data.enabled);
    if (parsed.success) armed.delete(parsed.data.requestId);
    child.postMessage({ type: "mission:session-control-authorization-reply", id, granted } satisfies SessionControlAuthorizationReply);
  });
}
