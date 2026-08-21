// Who says yes to publishing a public issue, and why it cannot be an HTTP caller.
//
// Every other guard on this feature bounds what a request must CONTAIN: a preview must exist, a
// grant must match, a derivation must not have moved. Three revisions of this feature failed
// review because containment is all any of them could ever be. `/api/*` is loopback-reachable
// and unauthenticated, so whatever the dashboard sends, a local process can send too - and the
// same is true of a bearer token, because the token is a file that a process running as the
// operator can read. Possession is not attestation.
//
// So the daemon stops trying to authenticate the caller and asks the human directly. A
// confirmation request over HTTP only ASKS; the answer comes back over a channel no HTTP caller
// participates in - the Electron utility-process port to the app's main process, which raises a
// native dialog and reports what the operator actually clicked. A local script may call the
// confirming route as often as it likes; each call puts a dialog on the operator's screen, and
// without a click on it there is no grant.
//
// The verifier is therefore the daemon, and the thing verified is an event outside the API
// rather than a value inside a request. That is the difference between this and every previous
// attempt, and it is the whole module.

import { randomUUID } from "node:crypto";
import { run } from "./util/exec.ts";

/** What the operator is being asked to agree to, in the words the dialog will use. */
export interface ProductIssueConsentAsk {
  target: string;
  title: string;
}

export interface ProductIssueConsentPort {
  /** True only if a person answered yes. Anything else - refusal, timeout, no UI - is false. */
  ask(ask: ProductIssueConsentAsk): Promise<boolean>;
  /** Why publishing is unavailable, or null when this port can actually ask somebody. */
  readonly unavailable: string | null;
}

/** How long a dialog may sit unanswered before the request gives up. */
const CONSENT_TIMEOUT_MS = 2 * 60_000;

export const PRODUCT_ISSUE_CONSENT_UNAVAILABLE =
  "Publishing needs the Mission Control desktop app, which asks you to confirm the public " +
  "issue in a system dialog. This daemon has no way to ask, so nothing can be published from it.";

/** The message the daemon posts to the shell, and the reply it waits for. */
export interface ProductIssueConsentMessage {
  type: "mission:product-issue-consent";
  id: string;
  target: string;
  title: string;
}
export interface ProductIssueConsentReply {
  type: "mission:product-issue-consent-reply";
  id: string;
  granted: boolean;
}

/** A port that can never say yes, and says why. Used when nothing is there to ask. */
export function noConsentPort(): ProductIssueConsentPort {
  return {
    unavailable: PRODUCT_ISSUE_CONSENT_UNAVAILABLE,
    ask: () => Promise.resolve(false),
  };
}

/**
 * Ask the Electron shell that started this daemon.
 *
 * `parentPort` exists only in a `utilityProcess` child, which in this app means "spawned by the
 * desktop shell". It is not a route, not a socket and not a file: nothing outside this process
 * tree can post to it, which is precisely the property the confirmation needs.
 */
export function parentPortConsent(port: NodeJS.Process["parentPort"]): ProductIssueConsentPort {
  return {
    unavailable: null,
    ask: (ask) =>
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
          const reply = event.data as ProductIssueConsentReply | undefined;
          if (!reply || reply.type !== "mission:product-issue-consent-reply") return;
          if (reply.id !== id) return;
          finish(reply.granted === true);
        };
        // A dialog nobody is at must not hold a request open forever, and the safe answer to
        // "did somebody agree to publish this" when nobody answered is no.
        const timer = setTimeout(() => finish(false), CONSENT_TIMEOUT_MS);
        port.on("message", onMessage);
        port.postMessage({
          type: "mission:product-issue-consent",
          id,
          target: ask.target,
          title: ask.title,
        } satisfies ProductIssueConsentMessage);
      }),
  };
}

/**
 * Ask a program named at launch, instead of a dialog. The end-to-end suite's stand-in.
 *
 * Set on the daemon's own environment by whoever starts it, which is not a privilege escalation
 * for anybody: a process that can choose the daemon's environment has already replaced the
 * daemon. `MISSION_GH_BIN` redirects the GitHub CLI itself on exactly the same reasoning. The
 * program is run with no shell, is given the target and title as argv, and consents by exiting 0.
 */
export function commandConsent(command: string): ProductIssueConsentPort {
  return {
    unavailable: null,
    ask: async (ask) => {
      try {
        const result = await run(command, [ask.target, ask.title], {
          timeoutMs: CONSENT_TIMEOUT_MS,
        });
        return result.code === 0;
      } catch {
        return false;
      }
    },
  };
}

/**
 * The port this daemon actually has.
 *
 * Order matters only in that the launch-time override wins; in a packaged app neither the
 * override nor anything else is set and the shell's port is what answers. A daemon started on
 * its own - `npm run dev`, a LaunchAgent, a test - can ask nobody, and says so rather than
 * falling back to something weaker.
 */
export function resolveConsentPort(): ProductIssueConsentPort {
  const command = process.env.MISSION_PRODUCT_ISSUE_CONSENT_CMD;
  if (command) return commandConsent(command);
  if (process.parentPort) return parentPortConsent(process.parentPort);
  return noConsentPort();
}
