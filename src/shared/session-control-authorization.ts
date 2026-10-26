import { z } from "zod";

/** The exact setting the operator clicked, never a transferable grant token. */
export const SessionControlAuthorizationSchema = z.object({
  requestId: z.string().uuid(),
  sessionId: z.string().min(1).max(256),
  enabled: z.boolean(),
}).strict();
export type SessionControlAuthorization = z.infer<typeof SessionControlAuthorizationSchema>;

export interface SessionControlAuthorizationMessage extends SessionControlAuthorization {
  type: "mission:session-control-authorization";
  id: string;
}
export interface SessionControlAuthorizationReply {
  type: "mission:session-control-authorization-reply";
  id: string;
  granted: boolean;
}

export const SESSION_CONTROL_DESKTOP_REQUIRED =
  "Changing session control requires the Mission Control desktop app and its own daemon. " +
  "Stop any standalone daemon, then reopen the desktop app.";
