import { randomUUID } from "node:crypto";
import type {
  SessionControlAuthorization, SessionControlAuthorizationMessage, SessionControlAuthorizationReply,
} from "@shared/session-control-authorization.ts";

export type AuthorizeSessionControl = (input: SessionControlAuthorization) => Promise<boolean>;

/** No HTTP header, machine token or file can substitute for the private shell reply. */
export function sessionControlAuthorization(
  port: NodeJS.Process["parentPort"] | undefined = process.parentPort,
): AuthorizeSessionControl {
  if (!port) return async () => false;
  return (input) => new Promise<boolean>((resolve) => {
    const id = randomUUID();
    const finish = (granted: boolean): void => {
      clearTimeout(timer);
      port.off("message", onMessage);
      resolve(granted);
    };
    const onMessage = (event: { data?: unknown }): void => {
      const reply = event.data as SessionControlAuthorizationReply | undefined;
      if (reply?.type === "mission:session-control-authorization-reply" && reply.id === id) {
        finish(reply.granted === true);
      }
    };
    const timer = setTimeout(() => finish(false), 15_000);
    port.on("message", onMessage);
    try {
      port.postMessage({ type: "mission:session-control-authorization", id, ...input } satisfies SessionControlAuthorizationMessage);
    } catch { finish(false); }
  });
}
