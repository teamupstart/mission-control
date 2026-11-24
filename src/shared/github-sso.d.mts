// Hand-written types for github-sso.mjs, so the daemon and Electron main import the same
// classifier `scripts/install-app.mjs` runs as bare node. Same arrangement as pr-command.d.mts.

export interface GitHubSsoRefusal {
  /** The refusing organization, or null when gh named none. */
  org: string | null;
  /** gh's authorize link, else the organization's SSO page, else null. */
  authorizeUrl: string | null;
}

/** The SAML SSO refusal in gh's full stderr, or null. Non-strings are never a refusal. */
export function classifyGitHubSsoRefusal(stderr: unknown): GitHubSsoRefusal | null;

/** "GitHub refused <target>: ..." with the authorize link and the caller's remedy. */
export function ssoRefusalMessage(input: {
  target: string;
  refusal: GitHubSsoRefusal;
  remedy?: string;
}): string;
