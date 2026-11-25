// Mission Control's OAuth client for shaper sign-in: discovery, dynamic registration, S256 PKCE,
// the code exchange, refresh and revocation. Stateless: every function takes what it needs and
// returns what it learned, and the sign-in service (Phase 4) owns what is remembered.
//
// The sign-in drives the MCP SDK's `auth()` directly, with a provider built here, for one step at
// a time. Four of its behaviours are pinned here rather than left to it:
// - It asks for every scope a server advertises when it is given none, so the connection's own
//   scope is always passed (S5).
// - It does not check that the authorization server's metadata names the server it was read
//   from, so `discover` does, and hands the validated metadata over through `discoveryState()`,
//   which makes `auth()` skip discovery of its own.
// - On `invalid_client`, `unauthorized_client` or `invalid_grant` it invalidates and runs once
//   more, re-registering or opening a new authorization. The provider's `invalidateCredentials`
//   throws instead, so a refused client is reported and never re-registered here.
// - It swallows a refresh that fails for a network reason and starts a new authorization, so
//   `refresh` calls `refreshAuthorization()` and never `auth()`, and the provider holds no tokens.
//
// A failure is a returned value with a reason, never a throw, and every reason is scrubbed of the
// authorization code, the PKCE verifier and both tokens.

import { randomBytes } from "node:crypto";
import { auth, discoverAuthorizationServerMetadata, refreshAuthorization, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  InvalidClientError, InvalidGrantError, OAuthError, TemporarilyUnavailableError, TooManyRequestsError,
  UnauthorizedClientError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import {
  OAuthProtectedResourceMetadataSchema,
  type AuthorizationServerMetadata, type OAuthClientInformationMixed, type OAuthClientMetadata, type OAuthProtectedResourceMetadata,
  type OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import { redactResolved, type ResolvedValue } from "../references.ts";
import { SignInRefusal, SignInRequestError, signInFetch, signInUrlProblem, type SignInFetch } from "./egress.ts";

/** What one sign-in covers: a server URL, the scope asked for, and the authorization server when it is on another origin. */
export interface SignInTarget {
  url: string;
  scope: string;
  issuer: string | null;
}

/** Validated discovery for one target. Plain data: it can be held in memory and handed back. */
export interface SignInDiscovery {
  /** The target URL it was made for. */
  serverUrl: string;
  /** The target issuer it was made for, as configured: null when the authorization server is on the server's own origin. */
  configuredIssuer: string | null;
  /** The authorization server's URL, as the resource metadata names it: the key its clients and tokens are bound to. */
  authorizationServer: string;
  /** The RFC 8707 resource indicator, from the resource metadata, or null when the server publishes none. */
  resource: string | null;
  resourceMetadata: OAuthProtectedResourceMetadata | null;
  metadata: AuthorizationServerMetadata;
  /** Every origin this sign-in may reach: the server's own, and the authorization server's. */
  origins: string[];
}

/** One dynamic registration: the public client Mission Control registered with an authorization server. */
export interface SignInClient {
  issuer: string;
  clientId: string;
  redirectUri: string;
  /** The scope it was registered with. */
  scope: string;
  registeredAt: number;
}

export interface SignInTokens {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch milliseconds, from `expires_in` and the injected clock, or null when the server gave no lifetime. */
  expiresAt: number | null;
  /** The scope granted: what the server answered, or the one asked for when it answered none (RFC 6749 section 5.1). */
  scope: string;
  obtainedAt: number;
}

/**
 * Why a step failed. `refused`: Mission Control's own rules refused it, and nothing was sent past
 * the refusal. `client_rejected`: the server no longer accepts the client. `sign_in_again`: the
 * grant is spent or refused. `retry`: a transient failure that a later try may get past - the
 * network, a timeout, a 5xx, a 408, a 429 or `temporarily_unavailable`. `failed`: the server gave
 * a definite answer that the same request will get again, such as any other 4xx, a status page
 * that is not an OAuth reply, or an unfollowed redirect.
 */
export type SignInFailureCode = "refused" | "client_rejected" | "sign_in_again" | "retry" | "failed";

export interface SignInFailure<Code extends SignInFailureCode = SignInFailureCode> {
  ok: false;
  code: Code;
  reason: string;
}

export interface FlowOptions {
  /** The clock `expiresAt`, `obtainedAt` and `registeredAt` are read from. */
  now?: () => number;
  /** Per request; 10 seconds unless a test shortens it. */
  timeoutMs?: number;
}

export type DiscoverResult = { ok: true; discovery: SignInDiscovery } | SignInFailure;

export type BeginResult =
  | { ok: true; authorizationUrl: string; state: string; codeVerifier: string; client: SignInClient }
  | SignInFailure;

export type TokensResult = { ok: true; tokens: SignInTokens } | SignInFailure;

export type RefreshResult = { ok: true; tokens: SignInTokens } | SignInFailure<"sign_in_again" | "client_rejected" | "retry">;

export type RevokeResult = { ok: true; revoked: boolean } | SignInFailure;

/** The name every registration carries. Never a harness's name (S4). */
export const SIGN_IN_CLIENT_NAME = "Mission Control";

/** The grant types every registration asks for. */
export const SIGN_IN_GRANT_TYPES: readonly string[] = ["authorization_code", "refresh_token"];

/** The longest reason a step returns, cut only after it is redacted. */
const REASON_CHARS = 400;

/** The registration Mission Control asks for: one public client, one redirect URI, the code flow with refresh. */
export function signInClientMetadata(redirectUri: string): OAuthClientMetadata {
  return {
    client_name: SIGN_IN_CLIENT_NAME,
    redirect_uris: [redirectUri],
    grant_types: [...SIGN_IN_GRANT_TYPES],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

/**
 * Reads the server's protected resource metadata and its authorization server's metadata, and
 * refuses either unless the sign-in may go there. The authorization server must be on the
 * server's own origin unless `target.issuer` names another (D6), and its metadata must name
 * itself, keep every endpoint on its origin over https or loopback http, offer S256 and a
 * registration endpoint. Only the server's origin and that authorization server's are reached.
 */
export async function discover(target: SignInTarget, options: FlowOptions = {}): Promise<DiscoverResult> {
  const secrets: ResolvedValue[] = [];
  let seen: Seen | undefined;
  try {
    const server = parseUrl(target.url);
    if (!server) return refused("The shaper's server URL is not a URL.");
    const serverProblem = signInUrlProblem(server, [server.origin]);
    if (serverProblem) return refused(`The shaper's server cannot be signed in to: ${serverProblem}.`);
    const issuer = target.issuer === null ? null : parseUrl(target.issuer);
    if (target.issuer !== null && !issuer) return refused("The configured issuer is not a URL.");
    if (issuer) {
      const issuerProblem = signInUrlProblem(issuer, [issuer.origin]);
      if (issuerProblem) return refused(`The configured issuer cannot be signed in to: ${issuerProblem}.`);
    }
    const authOrigin = issuer?.origin ?? server.origin;
    const origins = [...new Set([server.origin, authOrigin])];
    const watch = watched(signInFetch(origins, options));
    seen = watch.seen;
    const fetchFn = watch.fetchFn;

    const resourceMetadata = await readResourceMetadata(server, fetchFn);
    let authorizationServer: string;
    let resource: string | null = null;
    if (resourceMetadata) {
      if (!checkResourceAllowed({ requestedResource: resourceUrlFromServerUrl(server), configuredResource: resourceMetadata.resource })) {
        return refused(`The server's resource metadata names ${quote(resourceMetadata.resource)}, which does not match the shaper's URL.`);
      }
      resource = resourceMetadata.resource;
    }
    const named = resourceMetadata?.authorization_servers ?? [];
    if (named.length === 0) {
      if (issuer) return refused(`The server names no authorization server of its own, so the configured issuer ${issuer.origin} does not apply.`);
      authorizationServer = String(new URL("/", server));
    } else if (issuer) {
      const match = named.find((entry) => issuersMatch(entry, target.issuer!));
      if (!match) return refused(`The server names ${originsOf(named)} as its authorization server, not the configured issuer ${issuer.origin}.`);
      authorizationServer = match;
    } else {
      const own = named.find((entry) => parseUrl(entry)?.origin === server.origin);
      if (!own) {
        return refused(`The server's authorization server is on another origin, ${originsOf(named)}. Name it in the marker's issuer to allow it.`);
      }
      authorizationServer = own;
    }

    const mark = watch.seen.statuses.length;
    const metadata = await discoverAuthorizationServerMetadata(authorizationServer, { fetchFn });
    if (!metadata) {
      // The SDK moves past any 4xx to the next well-known URL, so a 408 or a 429 can read as absence.
      const transient = watch.seen.statuses.slice(mark).find(transientStatus);
      if (transient !== undefined) {
        return { ok: false, code: "retry", reason: `${authOrigin} answered HTTP ${transient} for its authorization server metadata; a later try may work.` };
      }
      return refused(`${authOrigin} publishes no authorization server metadata.`);
    }
    const problem = metadataProblem(metadata, authorizationServer, authOrigin);
    if (problem) return refused(`The authorization server's metadata was refused: ${problem}`);
    return { ok: true, discovery: { serverUrl: target.url, configuredIssuer: target.issuer, authorizationServer, resource, resourceMetadata, metadata, origins } };
  } catch (error) {
    return failure(classify(error, seen), "Could not read the server's sign-in metadata:", error, secrets, seen);
  }
}

/**
 * Starts a sign-in: registers a client when `client` is null, and builds the authorization URL
 * with the connection's scope, a fresh `state` and an S256 challenge. The URL carries the client
 * id, the `state` and the challenge, and never the verifier, which comes back beside it for the
 * caller to keep. A registration that answers a client secret is refused. `client` is used as
 * given, so a client registered for another scope is the authorization server's to refuse.
 */
export async function begin(
  target: SignInTarget,
  discovery: SignInDiscovery,
  client: SignInClient | null,
  redirectUri: string,
  options: FlowOptions = {},
): Promise<BeginResult> {
  const now = options.now ?? Date.now;
  const secrets: ResolvedValue[] = [];
  const { fetchFn, seen } = watched(signInFetch(discovery.origins, options));
  try {
    const mismatch = scopeProblem(target) ?? discoveryMismatch(target, discovery) ?? (client ? clientMismatch(client, discovery, redirectUri) : null);
    if (mismatch) return refused(mismatch, secrets);
    const state = randomBytes(32).toString("base64url");
    let registered: SignInClient | null = client;
    let authorizationUrl: URL | null = null;
    let codeVerifier: string | null = null;
    const provider = flowProvider(discovery, redirectUri, client, {
      state,
      onRegistered: (clientId) => {
        registered = { issuer: discovery.authorizationServer, clientId, redirectUri, scope: target.scope, registeredAt: now() };
      },
      onVerifier: (verifier) => {
        codeVerifier = verifier;
        secrets.push({ name: "PKCE verifier", value: verifier });
      },
      onRedirect: (url) => { authorizationUrl = url; },
    });
    const result = await auth(provider, { serverUrl: target.url, scope: target.scope, fetchFn });
    const url = authorizationUrl as URL | null;
    if (result !== "REDIRECT" || !url || !codeVerifier || !registered) {
      return refused("The sign-in did not produce an authorization URL.", secrets);
    }
    const urlProblem = signInUrlProblem(url, [new URL(discovery.authorizationServer).origin]);
    if (urlProblem) return refused(`The authorization URL was refused: ${urlProblem}.`, secrets);
    return { ok: true, authorizationUrl: url.href, state, codeVerifier, client: registered };
  } catch (error) {
    return failure(classify(error, seen), "Could not start the sign-in:", error, secrets, seen);
  }
}

/**
 * Finishes a sign-in: exchanges the authorization code with its PKCE verifier at the token
 * endpoint. `iss`, when the authorization server put one on the redirect (RFC 9207), must name
 * the issuer the metadata named, or nothing is sent. A refused client is reported as
 * `client_rejected` and is never re-registered here.
 */
export async function exchange(
  target: SignInTarget,
  discovery: SignInDiscovery,
  client: SignInClient,
  grant: { code: string; codeVerifier: string; redirectUri: string; iss?: string | null },
  options: FlowOptions = {},
): Promise<TokensResult> {
  const now = options.now ?? Date.now;
  const secrets: ResolvedValue[] = [
    { name: "authorization code", value: grant.code },
    { name: "PKCE verifier", value: grant.codeVerifier },
  ];
  const { fetchFn, seen } = watched(signInFetch(discovery.origins, options));
  try {
    const mismatch = scopeProblem(target) ?? discoveryMismatch(target, discovery) ?? clientMismatch(client, discovery, grant.redirectUri);
    if (mismatch) return refused(mismatch, secrets);
    if (grant.iss != null && !issuersMatch(grant.iss, discovery.metadata.issuer)) {
      return refused(`The sign-in was answered by ${quote(grant.iss)}, not the authorization server it was started with.`, secrets);
    }
    let saved: OAuthTokens | null = null;
    const provider = flowProvider(discovery, grant.redirectUri, client, {
      codeVerifier: grant.codeVerifier,
      onTokens: (tokens) => {
        saved = tokens;
        secrets.push(...tokenSecrets(tokens));
      },
    });
    const result = await auth(provider, {
      serverUrl: target.url, scope: target.scope, authorizationCode: grant.code, fetchFn,
    });
    const tokens = saved as OAuthTokens | null;
    if (result !== "AUTHORIZED" || !tokens) return { ok: false, code: "failed", reason: "The authorization server issued no tokens." };
    return { ok: true, tokens: signInTokens(tokens, target.scope, now()) };
  } catch (error) {
    return failure(classify(error, seen), "Could not finish the sign-in:", error, secrets, seen);
  }
}

/**
 * Exchanges a refresh token for a new pair at the token endpoint, with the client that obtained
 * it. Answers the new tokens, or `client_rejected` (`invalid_client`, `unauthorized_client`),
 * `retry` for a transient failure (a network error, a timeout, a 5xx, a 408, a 429,
 * `temporarily_unavailable`), or `sign_in_again` for every definite answer: `invalid_grant`, any
 * other OAuth error or 4xx, a status page that is not an OAuth reply, a refused redirect, or a
 * client bound to another authorization server. Those get the same answer however often they
 * are asked, so retrying them would never end and never ask the operator to sign in. A refresh
 * token the server does not rotate is kept.
 */
export async function refresh(
  discovery: SignInDiscovery,
  client: SignInClient,
  refreshToken: string,
  options: FlowOptions = {},
): Promise<RefreshResult> {
  const now = options.now ?? Date.now;
  const secrets: ResolvedValue[] = [{ name: "refresh token", value: refreshToken }];
  const { fetchFn, seen } = watched(signInFetch(discovery.origins, options));
  try {
    const mismatch = clientMismatch(client, discovery, client.redirectUri);
    if (mismatch) return { ok: false, code: "sign_in_again", reason: bound(redactResolved(mismatch, secrets)) };
    const tokens = await refreshAuthorization(discovery.authorizationServer, {
      metadata: discovery.metadata,
      clientInformation: sdkClient(client, discovery),
      refreshToken,
      ...(discovery.resource ? { resource: discovery.resource } : {}),
      fetchFn,
    });
    secrets.push(...tokenSecrets(tokens));
    return { ok: true, tokens: signInTokens(tokens, client.scope, now()) };
  } catch (error) {
    const code = classify(error, seen);
    const narrowed = code === "client_rejected" || code === "retry" ? code : "sign_in_again";
    return failure(narrowed, "Could not renew the sign-in:", error, secrets, seen);
  }
}

/**
 * Revokes a token at the revocation endpoint (RFC 7009) when the metadata names one. Best effort:
 * `revoked` is false when there is no endpoint, and a failure is returned, never thrown. A client bound
 * to another authorization server is refused before any request, so a token never reaches a
 * server other than the one it came from.
 */
export async function revoke(
  discovery: SignInDiscovery,
  client: SignInClient,
  token: string,
  options: FlowOptions = {},
): Promise<RevokeResult> {
  const secrets: ResolvedValue[] = [{ name: "token", value: token }];
  try {
    // A token goes back only to the authorization server whose client obtained it.
    const mismatch = clientMismatch(client, discovery, client.redirectUri);
    if (mismatch) return refused(mismatch, secrets);
    const endpoint = "revocation_endpoint" in discovery.metadata ? discovery.metadata.revocation_endpoint : undefined;
    if (!endpoint) return { ok: true, revoked: false };
    const response = await signInFetch(discovery.origins, options)(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ token, client_id: client.clientId }),
    });
    if (response.ok) return { ok: true, revoked: true };
    const code: SignInFailureCode = transientStatus(response.status) ? "retry" : "failed";
    return { ok: false, code, reason: bound(redactResolved(`The authorization server did not revoke the token: HTTP ${response.status}.`, secrets)) };
  } catch (error) {
    return failure(classify(error), "Could not revoke the token:", error, secrets);
  }
}

/** Thrown from the provider's `invalidateCredentials`, so `auth()` reports a refusal instead of running again. */
class Invalidated extends Error {
  constructor(readonly scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    super(scope === "tokens"
      ? "the authorization server refused the grant."
      : "the authorization server no longer accepts this client.");
    this.name = "Invalidated";
  }
}

interface ProviderHooks {
  state?: string;
  codeVerifier?: string;
  onRegistered?: (clientId: string) => void;
  onVerifier?: (verifier: string) => void;
  onRedirect?: (url: URL) => void;
  onTokens?: (tokens: OAuthTokens) => void;
}

/**
 * The provider `auth()` runs with for one step. It returns the validated discovery so `auth()`
 * reads none itself, the given client or none, and never any tokens, so `auth()` never refreshes.
 */
function flowProvider(discovery: SignInDiscovery, redirectUri: string, client: SignInClient | null, hooks: ProviderHooks): OAuthClientProvider {
  return {
    get redirectUrl() { return redirectUri; },
    get clientMetadata() { return signInClientMetadata(redirectUri); },
    state: () => {
      if (!hooks.state) throw new Error("this step starts no authorization");
      return hooks.state;
    },
    clientInformation: () => client ? sdkClient(client, discovery) : undefined,
    saveClientInformation: (information) => {
      if (client) return;
      if ("client_secret" in information && information.client_secret !== undefined) {
        throw new SignInRefusal("The authorization server registered a client with a secret. Mission Control signs in as a public client and keeps no secret.");
      }
      const method = "token_endpoint_auth_method" in information ? information.token_endpoint_auth_method : undefined;
      if (method !== undefined && method !== "none") {
        throw new SignInRefusal(`The authorization server registered a client that authenticates with ${quote(method)}, not as a public client.`);
      }
      hooks.onRegistered?.(information.client_id);
    },
    tokens: () => undefined,
    saveTokens: (tokens) => { hooks.onTokens?.(tokens); },
    redirectToAuthorization: (url) => { hooks.onRedirect?.(url); },
    saveCodeVerifier: (verifier) => { hooks.onVerifier?.(verifier); },
    codeVerifier: () => {
      if (!hooks.codeVerifier) throw new Error("this step exchanges no code");
      return hooks.codeVerifier;
    },
    invalidateCredentials: (scope) => { throw new Invalidated(scope); },
    discoveryState: () => ({
      authorizationServerUrl: discovery.authorizationServer,
      authorizationServerMetadata: discovery.metadata,
      ...(discovery.resourceMetadata ? { resourceMetadata: discovery.resourceMetadata } : {}),
    }),
  };
}

/** The client as the SDK reads it, stamped with the authorization server it is bound to. */
function sdkClient(client: SignInClient, discovery: SignInDiscovery): OAuthClientInformationMixed {
  return {
    client_id: client.clientId,
    issuer: discovery.authorizationServer,
    redirect_uris: [client.redirectUri],
    token_endpoint_auth_method: "none",
  };
}

/**
 * Why `target` names no scope to ask for, or null. Given none, the SDK asks for every scope the
 * server advertises (`auth.js` line 274), and an empty string counts as none (S5).
 */
function scopeProblem(target: SignInTarget): string | null {
  return target.scope.trim() === ""
    ? "The sign-in names no scope. Mission Control asks only for the connection's own scope, never for every scope the server advertises."
    : null;
}

/** Why `discovery` may not serve `target`: made for another server URL, or for another configured issuer (D6). */
function discoveryMismatch(target: SignInTarget, discovery: SignInDiscovery): string | null {
  if (target.url !== discovery.serverUrl) return "The discovery was made for another server than this sign-in's.";
  const sameIssuer = target.issuer === null || discovery.configuredIssuer === null
    ? target.issuer === discovery.configuredIssuer
    : issuersMatch(target.issuer, discovery.configuredIssuer);
  return sameIssuer ? null : "The discovery was made for another configured issuer than this sign-in's.";
}

function clientMismatch(client: SignInClient, discovery: SignInDiscovery, redirectUri: string): string | null {
  if (!issuersMatch(client.issuer, discovery.authorizationServer)) return "The client was registered with another authorization server.";
  if (client.redirectUri !== redirectUri) return "The client was registered for another redirect URI.";
  return null;
}

function signInTokens(tokens: OAuthTokens, requestedScope: string, at: number): SignInTokens {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    expiresAt: typeof tokens.expires_in === "number" ? at + tokens.expires_in * 1000 : null,
    scope: tokens.scope ?? requestedScope,
    obtainedAt: at,
  };
}

function tokenSecrets(tokens: OAuthTokens): ResolvedValue[] {
  return [
    { name: "access token", value: tokens.access_token },
    ...(tokens.refresh_token ? [{ name: "refresh token", value: tokens.refresh_token }] : []),
  ];
}

/**
 * RFC 9728 protected resource metadata: the path-aware well-known URL, then the root one. A 404
 * or a 410 at both means the server publishes none, and it is then its own authorization server.
 * A 408, a 429 or a 5xx is a request error a later try may get past, and any other answer is
 * refused rather than taken for absence. No redirect is followed.
 */
async function readResourceMetadata(server: URL, fetchFn: SignInFetch): Promise<OAuthProtectedResourceMetadata | null> {
  const path = server.pathname.replace(/\/$/, "");
  const candidates = [
    ...(path ? [new URL(`/.well-known/oauth-protected-resource${path}`, server.origin)] : []),
    new URL("/.well-known/oauth-protected-resource", server.origin),
  ];
  for (const url of candidates) {
    const response = await fetchFn(url, { headers: { accept: "application/json" } });
    // Only "not here" means none is published. A 401, a 403 or a 429 is the server answering,
    // and reading it as absence would sign in without the resource indicator.
    if (response.status === 404 || response.status === 410) continue;
    if (transientStatus(response.status)) {
      throw new SignInRequestError(`${server.origin} answered HTTP ${response.status} for its resource metadata; a later try may work.`);
    }
    if (!response.ok) throw new SignInRefusal(`${server.origin} answered HTTP ${response.status} for its resource metadata.`);
    const parsed = OAuthProtectedResourceMetadataSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new SignInRefusal(`${server.origin} published resource metadata that is not valid.`);
    return parsed.data;
  }
  return null;
}

/** Why the authorization server's metadata may not be used, or null. */
function metadataProblem(metadata: AuthorizationServerMetadata, authorizationServer: string, origin: string): string | null {
  if (!issuersMatch(metadata.issuer, authorizationServer)) {
    return `it names the issuer ${quote(metadata.issuer)}, not the authorization server it was read from, ${quote(authorizationServer)}.`;
  }
  for (const [key, value] of Object.entries(metadata)) {
    if (!(key.endsWith("_endpoint") || key === "jwks_uri") || typeof value !== "string") continue;
    const url = parseUrl(value);
    if (!url) return `its ${key} is not a URL.`;
    const problem = signInUrlProblem(url, [origin]);
    if (problem) return `its ${key} is refused: ${problem}.`;
  }
  if (!metadata.code_challenge_methods_supported?.includes("S256")) return "it does not offer S256 PKCE.";
  if (!metadata.response_types_supported.includes("code")) return "it does not offer the authorization code flow.";
  if (!metadata.registration_endpoint) return "it has no registration endpoint, so Mission Control cannot register.";
  return null;
}

/** Two authorization server identifiers, compared as parsed URLs and tolerant of one trailing `/`, as the SDK compares them. */
function issuersMatch(a: string, b: string): boolean {
  let [x, y] = [a, b];
  try { [x, y] = [new URL(a).href, new URL(b).href]; } catch { /* compared as written */ }
  return x === y || (x.endsWith("/") && x.slice(0, -1) === y) || (y.endsWith("/") && y.slice(0, -1) === x);
}

/** What a step's requests were answered: every status in order, and the last OAuth error a reply carried. */
interface Seen {
  statuses: number[];
  oauthError: { error: string; description: string | null } | null;
}

/**
 * `fetchFn`, noting what each reply answered. The SDK wraps a reply that is not OAuth JSON in a
 * `ServerError` whatever its status, and `auth()` hands a refused grant or client to
 * `invalidateCredentials` without its error, so the status and the OAuth error are read here.
 */
function watched(fetchFn: SignInFetch): { fetchFn: SignInFetch; seen: Seen } {
  const seen: Seen = { statuses: [], oauthError: null };
  return {
    seen,
    fetchFn: async (input, init) => {
      const response = await fetchFn(input, init);
      seen.statuses.push(response.status);
      if (!response.ok && response.body) {
        const body: unknown = await response.clone().json().catch(() => null);
        if (body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string") {
          const { error, error_description: description } = body as { error: string; error_description?: unknown };
          seen.oauthError = { error, description: typeof description === "string" ? description : null };
        }
      }
      return response;
    },
  };
}

/** A status a later try may get past: a 5xx, a request timeout or too many requests. */
function transientStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

function classify(error: unknown, seen?: Seen): SignInFailureCode {
  if (error instanceof Invalidated) return error.scope === "tokens" ? "sign_in_again" : "client_rejected";
  if (error instanceof InvalidClientError || error instanceof UnauthorizedClientError) return "client_rejected";
  if (error instanceof InvalidGrantError) return "sign_in_again";
  if (error instanceof SignInRefusal) return "refused";
  if (error instanceof SignInRequestError) return "retry";
  if (error instanceof TemporarilyUnavailableError || error instanceof TooManyRequestsError) return "retry";
  // Anything else, an OAuth `server_error` and the SDK's plain errors included, by the status
  // that was answered: definite unless it was transient.
  const status = seen?.statuses.at(-1);
  return status !== undefined && transientStatus(status) ? "retry" : "failed";
}

function describe(error: unknown, seen?: Seen): string {
  if (error instanceof Invalidated) {
    const answered = seen?.oauthError;
    if (!answered) return error.message;
    return `${error.message.replace(/\.$/, "")}: the server answered ${answered.error}${answered.description ? `: ${answered.description}` : "."}`;
  }
  if (error instanceof SignInRefusal || error instanceof SignInRequestError) return error.message;
  if (error instanceof OAuthError) return `the server answered ${error.errorCode}${error.message ? `: ${error.message}` : "."}`;
  if (error instanceof Error && error.message) return error.message;
  return "an unexpected error.";
}

function failure<Code extends SignInFailureCode>(
  code: Code, prefix: string, error: unknown, secrets: readonly ResolvedValue[], seen?: Seen,
): SignInFailure<Code> {
  return { ok: false, code, reason: bound(redactResolved(`${prefix} ${describe(error, seen)}`, secrets)) };
}

function refused(reason: string, secrets: readonly ResolvedValue[] = []): SignInFailure<"refused"> {
  return { ok: false, code: "refused", reason: bound(redactResolved(reason, secrets)) };
}

/** A reason on one line, cut to its bound. Called only on text already redacted. */
function bound(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= REASON_CHARS ? line : `${line.slice(0, REASON_CHARS - 1)}…`;
}

function parseUrl(value: string): URL | null {
  try { return new URL(value); } catch { return null; }
}

function originsOf(urls: readonly string[]): string {
  return [...new Set(urls.map((url) => parseUrl(url)?.origin ?? quote(url)))].join(", ");
}

function quote(value: string): string {
  return JSON.stringify(value.length > 120 ? `${value.slice(0, 119)}…` : value);
}
