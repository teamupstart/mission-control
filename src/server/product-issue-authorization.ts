// The daemon side of the private desktop authorization used for public issue publishing.
//
// Every HTTP value can be reproduced by another process running as the operator. The publish
// grant therefore depends on a reply that does not travel over HTTP: the Electron utility
// process port. The renderer arms one exact report from its Report click, the shell consumes
// that authorization once, and only then does this port return true to the daemon.

import { randomUUID } from "node:crypto";
import { run } from "./util/exec.ts";

export interface ProductIssueAuthorizationAsk {
  requestId: string;
  draftIdentity: string;
  target: string;
  title: string;
}

export interface ProductIssueAuthorizationPort {
  authorize(ask: ProductIssueAuthorizationAsk): Promise<boolean>;
  readonly unavailable: string | null;
}

const AUTHORIZATION_TIMEOUT_MS = 15_000;

export const PRODUCT_ISSUE_AUTHORIZATION_UNAVAILABLE =
  "Publishing needs the Mission Control desktop app. Open this report in the desktop app " +
  "to publish it with one Report click.";

export interface ProductIssueAuthorizationMessage extends ProductIssueAuthorizationAsk {
  type: "mission:product-issue-authorization";
  id: string;
}

export interface ProductIssueAuthorizationReply {
  type: "mission:product-issue-authorization-reply";
  id: string;
  granted: boolean;
}

export function noProductIssueAuthorization(): ProductIssueAuthorizationPort {
  return {
    unavailable: PRODUCT_ISSUE_AUTHORIZATION_UNAVAILABLE,
    authorize: () => Promise.resolve(false),
  };
}

/** Ask the Electron shell that owns this daemon to consume one armed Report click. */
export function parentPortProductIssueAuthorization(
  port: NodeJS.Process["parentPort"],
): ProductIssueAuthorizationPort {
  return {
    unavailable: null,
    authorize: (ask) =>
      new Promise<boolean>((resolve) => {
        const id = randomUUID();
        let done = false;
        const finish = (granted: boolean): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          port.off("message", onMessage);
          resolve(granted);
        };
        const onMessage = (event: { data?: unknown }): void => {
          const reply = event.data as ProductIssueAuthorizationReply | undefined;
          if (!reply || reply.type !== "mission:product-issue-authorization-reply") return;
          if (reply.id !== id) return;
          finish(reply.granted === true);
        };
        const timer = setTimeout(() => finish(false), AUTHORIZATION_TIMEOUT_MS);
        port.on("message", onMessage);
        port.postMessage({
          type: "mission:product-issue-authorization",
          id,
          ...ask,
        } satisfies ProductIssueAuthorizationMessage);
      }),
  };
}

/** Launch-time test seam equivalent to the private utility-process reply. */
export function commandProductIssueAuthorization(
  command: string,
): ProductIssueAuthorizationPort {
  return {
    unavailable: null,
    authorize: async (ask) => {
      try {
        const result = await run(
          command,
          [ask.requestId, ask.draftIdentity, ask.target, ask.title],
          { timeoutMs: AUTHORIZATION_TIMEOUT_MS },
        );
        return result.code === 0;
      } catch {
        return false;
      }
    },
  };
}

export function resolveProductIssueAuthorization(): ProductIssueAuthorizationPort {
  const command = process.env.MISSION_PRODUCT_ISSUE_AUTHORIZATION_CMD;
  if (command) return commandProductIssueAuthorization(command);
  if (process.parentPort) return parentPortProductIssueAuthorization(process.parentPort);
  return noProductIssueAuthorization();
}
