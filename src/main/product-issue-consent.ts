// The desktop shell's half of publishing a public product issue.
//
// The daemon does not decide this and cannot fake it. When somebody asks it to confirm a
// report, it posts a question down the utility-process port it was forked on, and waits. This
// module is what answers: a native dialog, and whatever the operator actually clicked.
//
// The reason the question travels this way rather than over the daemon's HTTP API is the whole
// design. `/api/*` is loopback-reachable and unauthenticated, so anything the dashboard can
// send, a local process can send too - and a bearer token is no better, because the token is a
// file that a process running as the operator can read. An answer that arrives here, though, is
// not something an HTTP caller can produce at all: nothing outside this process tree can post
// to that port, and nothing but a click can make this function resolve true.

import { dialog } from "electron";
import type { UtilityProcess } from "electron";
import type {
  ProductIssueConsentMessage,
  ProductIssueConsentReply,
} from "../server/product-issue-consent.ts";
import { getMainWindow } from "./window.ts";

function isConsentAsk(value: unknown): value is ProductIssueConsentMessage {
  if (typeof value !== "object" || value === null) return false;
  const ask = value as Partial<ProductIssueConsentMessage>;
  return (
    ask.type === "mission:product-issue-consent" &&
    typeof ask.id === "string" &&
    typeof ask.target === "string" &&
    typeof ask.title === "string"
  );
}

/**
 * Ask the operator whether to publish, and tell the daemon what they said.
 *
 * The dialog defaults to Cancel and treats a dismissal as one, because the irreversible answer
 * must never be the one a stray Return key picks. The window is raised first: a confirmation
 * behind a hidden window is one somebody answers without having read the report it names.
 */
export function serveProductIssueConsent(child: UtilityProcess): void {
  child.on("message", (message: unknown) => {
    if (!isConsentAsk(message)) return;
    void (async () => {
      let granted = false;
      try {
        // Raise whatever window there is first: a confirmation behind a hidden window is one
        // somebody answers without having read the report it names. A shell with no window at
        // all still asks, as a standalone dialog.
        const window = getMainWindow();
        if (window) {
          if (window.isMinimized()) window.restore();
          window.show();
        }
        const options = {
          type: "warning" as const,
          buttons: ["Cancel", "Publish publicly"],
          defaultId: 0,
          cancelId: 0,
          title: "Report product feedback",
          message: `Publish this report in ${message.target}?`,
          detail:
            `"${message.title}"\n\n` +
            "This files a public GitHub issue that anyone can read, and Mission Control " +
            "cannot take it back.",
          noLink: true,
        };
        const answer = window
          ? await dialog.showMessageBox(window, options)
          : await dialog.showMessageBox(options);
        granted = answer.response === 1;
      } catch {
        // A dialog that could not be shown is a question nobody was asked, and the safe answer
        // to "did somebody agree to publish this" is always no.
        granted = false;
      }
      child.postMessage({
        type: "mission:product-issue-consent-reply",
        id: message.id,
        granted,
      } satisfies ProductIssueConsentReply);
    })();
  });
}
