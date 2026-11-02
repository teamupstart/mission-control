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

/**
 * The exact resident Launch the operator clicked: one launch request of one profile revision.
 * A profile whose pinned revision turns **Control other sessions** on gives its run the existing
 * session-control grant only when the daemon consumes this, for that request, profile and
 * revision, over the same private channel as the menu's authorization above.
 */
export const ResidentLaunchAuthorizationSchema = z.object({
  requestId: z.string().uuid(),
  profileId: z.string().min(1).max(200),
  revision: z.number().int().positive(),
}).strict();
export type ResidentLaunchAuthorization = z.infer<typeof ResidentLaunchAuthorizationSchema>;

export interface ResidentLaunchAuthorizationMessage extends ResidentLaunchAuthorization {
  type: "mission:resident-launch-authorization";
  id: string;
}
export interface ResidentLaunchAuthorizationReply {
  type: "mission:resident-launch-authorization-reply";
  id: string;
  granted: boolean;
}

export const SESSION_CONTROL_DESKTOP_REQUIRED =
  "Changing session control requires the Mission Control desktop app and its own daemon. " +
  "Stop any standalone daemon, then reopen the desktop app.";
