// A GitHub refusal caused by an organization's SAML SSO, read out of gh's stderr.
//
// Its own module because three runtimes need it and none of them may pull in the others: the
// daemon, Electron main, and `scripts/install-app.mjs`, which the detached updater runs as bare
// node from its own clone. Pure and browser-safe, the same arrangement as `pr-command.mjs`.
//
// It reads the FULL stderr. gh prints the refusal on its first line and the authorize link on a
// later one, so every caller that keeps only the first line for its own message has to ask here
// first, or the one thing the operator needs is already gone.
//
// gh prints two shapes, both captured from `teamupstart/mission-control` on 2026-10-10:
//
//   GraphQL: Resource protected by organization SAML enforcement. You must grant your OAuth
//   token access to this organization. (repository)
//   Authorize in your web browser:  https://github.com/orgs/teamupstart/sso?authorization_request=...
//
//   gh: Resource protected by organization SAML enforcement. ... The 'teamupstart' organization
//   has enabled or enforced SAML SSO.
//   To access this repository, visit https://github.com/orgs/teamupstart/sso?authorization_request=...
//   and try your request again.
//    (HTTP 403)
//
// The GraphQL shape names the organization only inside the link, so the link is the fallback.

const SSO_REFUSAL_RE =
  /Resource protected by organization SAML enforcement|has enabled or enforced SAML SSO/i;
const NAMED_ORG_RE = /The '([^'\s]+)' organization/;
const AUTHORIZE_URL_RE = /https:\/\/github\.com\/orgs\/([^/\s?]+)\/sso(?:\?[^\s]*)?/;

/** `{ org, authorizeUrl }` when `stderr` is a SAML SSO refusal, else null. */
export function classifyGitHubSsoRefusal(stderr) {
  if (typeof stderr !== "string" || !SSO_REFUSAL_RE.test(stderr)) return null;
  const link = AUTHORIZE_URL_RE.exec(stderr);
  const org = NAMED_ORG_RE.exec(stderr)?.[1] ?? link?.[1] ?? null;
  const authorizeUrl = link
    ? link[0].replace(/[.,;)]+$/, "")
    : org
      ? `https://github.com/orgs/${org}/sso`
      : null;
  return { org, authorizeUrl };
}

/**
 * The operator-facing sentence for a refusal: which repository was tried, which organization
 * refused, where to authorize, and the caller's own `remedy` (what to change instead).
 */
export function ssoRefusalMessage({ target, refusal, remedy }) {
  const org = refusal.org ? `the ${refusal.org} organization` : "its organization";
  return [
    `GitHub refused ${target}: ${org} requires SAML SSO and this gh token is not authorized for it.`,
    refusal.authorizeUrl ? `Authorize: ${refusal.authorizeUrl}.` : "",
    remedy ?? "",
  ]
    .filter(Boolean)
    .join(" ");
}
