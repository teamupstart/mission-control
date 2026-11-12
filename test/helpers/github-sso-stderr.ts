// gh's stderr for a SAML SSO refusal, captured from `teamupstart/mission-control` on 2026-10-10
// with a token not authorized for that organization. Only the per-request
// `authorization_request` value is replaced; everything else is byte for byte.

export const SSO_AUTHORIZE_URL =
  "https://github.com/orgs/teamupstart/sso?authorization_request=AAM6F5EXAMPLEREQUESTTOKEN";

/** `gh issue list` / `gh release list`: the GraphQL form names the org only in the link. */
export const GRAPHQL_SSO_STDERR =
  "GraphQL: Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization. (repository)\n" +
  `Authorize in your web browser:  ${SSO_AUTHORIZE_URL}\n`;

/** `gh api repos/teamupstart/mission-control`: the REST form names it in prose too. */
export const REST_SSO_STDERR =
  "gh: Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization. The 'teamupstart' organization has enabled or enforced SAML SSO.\n" +
  `To access this repository, visit ${SSO_AUTHORIZE_URL} and try your request again.\n` +
  " (HTTP 403)\n";
