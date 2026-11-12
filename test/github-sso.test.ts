import assert from "node:assert/strict";
import test from "node:test";
import { classifyGitHubSsoRefusal, ssoRefusalMessage } from "../src/shared/github-sso.mjs";
import {
  GRAPHQL_SSO_STDERR,
  REST_SSO_STDERR,
  SSO_AUTHORIZE_URL,
} from "./helpers/github-sso-stderr.ts";

test("the GraphQL refusal reads the organization from gh's authorize link", () => {
  assert.deepEqual(classifyGitHubSsoRefusal(GRAPHQL_SSO_STDERR), {
    org: "teamupstart",
    authorizeUrl: SSO_AUTHORIZE_URL,
  });
});

test("the REST refusal reads the organization from its prose and keeps the link whole", () => {
  assert.deepEqual(classifyGitHubSsoRefusal(REST_SSO_STDERR), {
    org: "teamupstart",
    authorizeUrl: SSO_AUTHORIZE_URL,
  });
  assert.deepEqual(
    classifyGitHubSsoRefusal(
      "The 'acme' organization has enabled or enforced SAML SSO. To access this repository, visit https://github.com/orgs/acme/sso.",
    ),
    { org: "acme", authorizeUrl: "https://github.com/orgs/acme/sso" },
  );
});

test("a refusal without a link points at the organization's SSO page, or at nothing", () => {
  assert.deepEqual(
    classifyGitHubSsoRefusal("The 'acme' organization has enabled or enforced SAML SSO."),
    { org: "acme", authorizeUrl: "https://github.com/orgs/acme/sso" },
  );
  assert.deepEqual(
    classifyGitHubSsoRefusal("GraphQL: Resource protected by organization SAML enforcement. (repository)"),
    { org: null, authorizeUrl: null },
  );
});

test("other failures are not SSO refusals", () => {
  for (const stderr of [
    "",
    "HTTP 401: Bad credentials",
    "HTTP 403: Resource not accessible by integration",
    "GraphQL: Could not resolve to a Repository with the name 'acme/missing'. (repository)",
    // An authorize-shaped link alone is not a refusal.
    "see https://github.com/orgs/acme/sso for details",
    undefined,
    null,
  ]) {
    assert.equal(classifyGitHubSsoRefusal(stderr), null, String(stderr));
  }
});

test("the message names the target and organization, keeps the link, and ends with the remedy", () => {
  const refusal = classifyGitHubSsoRefusal(GRAPHQL_SSO_STDERR)!;
  assert.equal(
    ssoRefusalMessage({
      target: "teamupstart/mission-control",
      refusal,
      remedy: "Forks: set `MISSION_PRODUCT_ISSUES_REPO`.",
    }),
    "GitHub refused teamupstart/mission-control: the teamupstart organization requires SAML SSO " +
      `and this gh token is not authorized for it. Authorize: ${SSO_AUTHORIZE_URL}. ` +
      "Forks: set `MISSION_PRODUCT_ISSUES_REPO`.",
  );
  assert.equal(
    ssoRefusalMessage({ target: "acme/app", refusal: { org: null, authorizeUrl: null } }),
    "GitHub refused acme/app: its organization requires SAML SSO and this gh token is not authorized for it.",
  );
});
