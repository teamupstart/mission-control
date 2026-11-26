import type { CompleteFailureCode } from "./service.ts";

/**
 * The page the loopback callback answers the browser with. Static: no script, nothing loaded,
 * and never a value the redirect carried or text the authorization server sent. Its two
 * headings are what Settings and the browser suite rely on.
 */
export const SIGN_IN_PAGE_TEXT = Object.freeze({
  signedIn: "Signed in. You can close this tab and go back to Mission Control.",
  notFinished: "The sign-in did not finish.",
} as const);

/** What the sentence under "did not finish" is chosen by. */
export type SignInPageFailure = CompleteFailureCode | "malformed";

const START_AGAIN = "Start again from Settings > Task shaping.";

/** One fixed sentence per kind of failure, each ending with where to start again. */
export const SIGN_IN_PAGE_FAILURES: Readonly<Record<SignInPageFailure, string>> = Object.freeze({
  unknown_state: `Mission Control was not waiting for this sign-in, it expired, or it was already used. ${START_AGAIN}`,
  denied: `The authorization server did not approve the sign-in. ${START_AGAIN}`,
  no_code: `The authorization server sent no authorization code. ${START_AGAIN}`,
  wrong_issuer: `The sign-in was answered by another authorization server than the one it was started with. ${START_AGAIN}`,
  cancelled: `The sign-in was signed out before it finished, so nothing was kept. ${START_AGAIN}`,
  flag_off: `Shaper sign-in was switched off before the sign-in finished. Turn on the Shaper sign-in feature flag (shaper-sign-in). ${START_AGAIN}`,
  malformed: `The address this page was opened with is not one a sign-in sends. ${START_AGAIN}`,
  client_rejected: `The authorization server no longer accepts Mission Control's client registration. ${START_AGAIN}`,
  sign_in_again: `The authorization server's reply did not match the sign-in that was started. ${START_AGAIN}`,
  refused: `The authorization server refused the sign-in. ${START_AGAIN}`,
  retry: `The authorization server could not be reached, or did not answer in time. ${START_AGAIN}`,
  failed: `The authorization server did not issue a sign-in. ${START_AGAIN}`,
});

/**
 * The response headers every callback page carries: nothing cached, no referrer leaves it, and a
 * policy that lets it load nothing but its own inline style.
 */
export const SIGN_IN_PAGE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
});

const STYLE = [
  ":root{color-scheme:light dark}",
  "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;",
  "font:16px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:Canvas;color:CanvasText}",
  "main{max-width:32rem;padding:2rem 1.5rem}",
  "h1{font-size:1.25rem;font-weight:600;margin:0 0 .5rem}",
  "p{margin:0;opacity:.8}",
].join("");

function page(title: string, heading: string, detail: string | null): string {
  // Every string here is one of the constants above, so nothing needs escaping.
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    `<title>${title}</title><style>${STYLE}</style></head>`,
    `<body><main><h1>${heading}</h1>${detail ? `<p>${detail}</p>` : ""}</main></body></html>`,
  ].join("");
}

/** The success page: status 200. */
export function signedInPage(): { status: 200; body: string } {
  return { status: 200, body: page("Signed in - Mission Control", SIGN_IN_PAGE_TEXT.signedIn, null) };
}

/** The failure page: status 400, the fixed heading and the one sentence its kind chooses. */
export function notFinishedPage(failure: SignInPageFailure): { status: 400; body: string } {
  return { status: 400, body: page("Sign-in did not finish - Mission Control", SIGN_IN_PAGE_TEXT.notFinished, SIGN_IN_PAGE_FAILURES[failure]) };
}
