import { randomUUID } from "node:crypto";
import type {
  ResidentLaunchAuthorization, ResidentLaunchAuthorizationMessage, ResidentLaunchAuthorizationReply,
  SessionControlAuthorization, SessionControlAuthorizationMessage, SessionControlAuthorizationReply,
} from "@shared/session-control-authorization.ts";

export type AuthorizeSessionControl = (input: SessionControlAuthorization) => Promise<boolean>;
export type AuthorizeResidentLaunch = (input: ResidentLaunchAuthorization) => Promise<boolean>;

type ParentPort = NodeJS.Process["parentPort"];

/** Ask the shell once, correlated by id; anything but its exact `granted: true` is a refusal. */
function askShell(
  port: ParentPort,
  message: SessionControlAuthorizationMessage | ResidentLaunchAuthorizationMessage,
  replyType: (SessionControlAuthorizationReply | ResidentLaunchAuthorizationReply)["type"],
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const finish = (granted: boolean): void => {
      clearTimeout(timer);
      port.off("message", onMessage);
      resolve(granted);
    };
    const onMessage = (event: { data?: unknown }): void => {
      const reply = event.data as SessionControlAuthorizationReply | ResidentLaunchAuthorizationReply | undefined;
      if (reply?.type === replyType && reply.id === message.id) finish(reply.granted === true);
    };
    const timer = setTimeout(() => finish(false), 15_000);
    port.on("message", onMessage);
    try {
      port.postMessage(message);
    } catch { finish(false); }
  });
}

/** No HTTP header, machine token or file can substitute for the private shell reply. */
export function sessionControlAuthorization(
  port: ParentPort | undefined = process.parentPort,
): AuthorizeSessionControl {
  if (!port) return async () => false;
  return (input) => askShell(
    port,
    { type: "mission:session-control-authorization", id: randomUUID(), ...input },
    "mission:session-control-authorization-reply",
  );
}

/**
 * Consume the operator's desktop Launch click for one resident launch, over the same private
 * channel. A standalone daemon has no parent port, so every resident it launches starts without
 * control.
 */
export function residentLaunchAuthorization(
  port: ParentPort | undefined = process.parentPort,
): AuthorizeResidentLaunch {
  if (!port) return async () => false;
  return (input) => askShell(
    port,
    { type: "mission:resident-launch-authorization", id: randomUUID(), ...input },
    "mission:resident-launch-authorization-reply",
  );
}
