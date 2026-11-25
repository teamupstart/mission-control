# Shaper sign-in - Phase 1: Flow proof

## Outcome

Mission Control has the core of an OAuth client, and a test run proves it end to end against
a loopback mock authorization server with fake values: discovery, dynamic registration, S256
PKCE, the code exchange, refresh with rotation, and every refusal the plan names. The tests
pin exactly what the SDK sends. The scout read this flow and did not run it, so this phase
is the go or no-go for phases 4 to 7.

Nothing calls the new code yet. Phase 4 is its first caller.

## Entry criteria and dependencies

- The planning pull request is merged. No other phase is needed.
- It can be built at the same time as phases 2 and 3.

## Hard rules

- No reading, copying, exporting or passing of real credentials: no Keychain reads of other
  applications' items, no `auth.json`, no OAuth tokens or API keys other than this
  feature's own fake-valued test fixtures, and nothing under `~/.claude*` or `~/.codex*`.
- Tests use a loopback mock authorization server and fake values only.
- No real login against Okta or the gateway, and no request to either.
- The feature's own Keychain item names are unique. A test that writes an item removes it
  and verifies it is gone. This phase writes none.
- No full unit suite and no full end-to-end suite locally. Run this phase's own test files,
  with `npm run typecheck` and `npm run lint`. CI runs the full suites.

## Scope

- `src/server/shaping/sign-in/egress.ts`: the fetch every sign-in request uses.
- `src/server/shaping/sign-in/flow.ts`: `discover`, `begin`, `exchange`, `refresh`, `revoke`.
- `test/fixtures/fake-oauth-server.mjs`: the mock, used by every later phase.

Not here: storing anything, timers, the service, routes, the flag, the marker's schema, the
transports, Settings. No file outside `sign-in/` and `test/` changes.

## Repository findings and inherited contracts

- **SDK 1.32.1**, `node_modules/@modelcontextprotocol/sdk/dist/esm/client/auth.js`.
  `auth(provider, { serverUrl, scope, authorizationCode, fetchFn })` returns `REDIRECT` or
  `AUTHORIZED`. With no `scope` it asks for every scope the server advertises (line 274).
  It does not check the metadata's `issuer` (lines 258-262). On `invalid_client` or
  `invalid_grant` it calls `invalidateCredentials` and runs once more (lines 186-203). A
  refresh that fails for a network reason is swallowed and a new authorization starts (lines
  351-389).
- A provider may return discovery results from `discoveryState()`, and `auth()` then skips
  its own discovery (lines 206-240). That is how validated metadata is handed to it.
- Every SDK request for metadata, registration and tokens goes through the `fetchFn` it is
  given, wrapped so a redirect is followed only within the request's own origin.
- `refreshAuthorization`, `discoverOAuthProtectedResourceMetadata` and
  `discoverAuthorizationServerMetadata` are exported. The typed errors are in
  `@modelcontextprotocol/sdk/server/auth/errors.js`.
- `plaintextCredentialProblem` (`src/shared/resident-mcp.ts`) states the HTTPS-or-loopback
  rule, and `readCappedBody` (`src/server/origin-fetch.ts`) reads a body to a cap.
- `redactResolved` (`src/server/shaping/references.ts`) removes named values from text.
- `test/fixtures/fake-guidance-mcp.mjs` has an MCP server with a `get_guidance` tool and
  `startGuidanceHttp`, which records each request's headers.

## Steps

1. **The fixture.** `startFakeOAuthServer(options)` listens on `127.0.0.1` port 0 and
   resolves to `{ resourceUrl, issuer, requests, close }` plus setters for its modes.
   - `POST /mcp`: without a valid bearer, `401` with
     `WWW-Authenticate: Bearer resource_metadata="..."`. With one, the `get_guidance` tool.
   - `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server`.
     The resource metadata advertises more scopes than any test asks for.
   - `/register` answers `fake-client-<n>`. `/authorize` checks the client, the exact
     redirect URI and S256, then redirects at once with `code` and `state`. There is no
     login page. `/token` checks the PKCE verifier, issues `fake-access-<n>` and
     `fake-refresh-<n>`, and rotates the refresh token, single use. `/revoke` records.
   - Modes: the authorization server on a second loopback port; a refresh that answers
     `invalid_grant`, `invalid_client` or 503; a registration that returns a `client_secret`
     or refuses; metadata with a wrong `issuer`, an endpoint on another origin, no S256 or
     no registration endpoint; a stalled reply; an oversized reply; a redirect to another
     origin; an `iss` parameter on the redirect.
   - Every request is recorded with its method, path, headers and body.
2. **`signInFetch`.** Given the origins a sign-in may reach, it refuses any other origin and
   any URL that is not HTTPS or loopback HTTP before a request is made. It sends no cookie,
   adds no header of its own, follows no redirect itself, reads at most 64 KiB and gives
   each request 10 seconds.
3. **`discover(target)`.** Reads the protected resource metadata, then picks the
   authorization server: with `target.issuer` null it must be on the server's own origin,
   otherwise it must be `target.issuer`. A server with no resource metadata is its own
   authorization server, which is allowed only when `target.issuer` is null. Then it reads
   the server metadata and refuses, with a reason, when: the metadata's `issuer` does not
   name that server, an endpoint is on another origin or is not HTTPS or loopback, S256 is
   not offered, there is no registration endpoint, or the resource does not match the URL.
4. **`begin(target, discovery, client, redirectUri)`.** Runs `auth()` with the configured
   scope and a provider that returns the validated discovery, the stored client or none, a
   `state` of 32 random bytes, and this metadata: `client_name` "Mission Control", the one
   redirect URI, `authorization_code` and `refresh_token`, response type `code`, and
   `token_endpoint_auth_method` `none`. It returns the authorization URL, the `state`, the
   verifier and the client. A registration that carries a `client_secret` is refused.
5. **`exchange(target, discovery, client, { code, codeVerifier, redirectUri })`.** Runs
   `auth()` with the code and returns the tokens, with `expiresAt` from `expires_in` and an
   injected clock. A refused client is reported, never re-registered here.
6. **`refresh(discovery, client, refreshToken)`.** Calls `refreshAuthorization()`. It
   answers the new tokens, or `sign_in_again` (`invalid_grant`), `client_rejected`
   (`invalid_client`, `unauthorized_client`), or `retry` (anything else: a network error, a
   timeout, a 5xx, `temporarily_unavailable`, a 429).
7. **`revoke(discovery, client, token)`.** Posts to the revocation endpoint when the
   metadata names one. Best effort.
8. Every failure is a returned value with a reason. Each reason is passed through
   `redactResolved` with the code, the verifier and both tokens, so none can appear in it.

## Data, API and compatibility

- No stored data, no route, no schema change, no flag. The daemon's behaviour is unchanged.
- `flow.ts` declares `SignInTarget` as `{ url, scope, issuer }`. Phase 3 declares the same
  shape in the shared schema, and Phase 4 keeps only that one.
- The fixture's hosts are loopback and its values are fake. Nothing names a company.

## Tests and verification

`test/shaping-sign-in-flow.test.ts` and `test/shaping-sign-in-egress.test.ts`.

- **What is sent.** The registration body. The authorization URL: `response_type=code`, the
  client id, a challenge with `S256`, the exact redirect URI, a `state`, the configured
  scope and no other, and the resource from the metadata. The token request: the code, the
  verifier, the redirect URI, the client id in the body and no `Authorization` header. The
  refresh request. Two calls to `begin` give different `state` values.
- **Where it goes.** No sign-in request carries a cookie, `traceparent`, `tracestate` or
  `x-work-unit-id`. The fixture sees the code and the refresh token only at `/token`.
- **Rotation.** A refresh returns a new pair. The spent refresh token then gets
  `sign_in_again`.
- **Each refusal in step 3**, the second-origin server with and without `target.issuer`,
  metadata that names a server other than `target.issuer`, a `client_secret`, a plain HTTP
  URL to a host that is not loopback (no request is made), an oversized reply, a stalled
  reply, a redirect to another origin.
- **Classification.** `invalid_grant`, `invalid_client`, a 503 and a closed socket.
- **No value in a reason.** Every returned reason is searched for the fake code, verifier
  and tokens.

Run the two test files, `npm run typecheck` and `npm run lint`.

## Merge and exit criteria

- A complete sign-in and a refresh run against the fixture, with fake values only.
- The scope sent is exactly the configured one, although the fixture advertises more.
- Every refusal listed above ends in a returned reason and no further request.
- No returned reason holds a code, a verifier or a token.
- **Go or no-go.** If the SDK cannot be made to meet a rule above, stop, change nothing
  else, and report what failed with the test that shows it. Phases 4 to 7 wait on this.

## Handoff

Later phases may rely on the five functions and their returned shapes, on `signInFetch`, and
on the fixture and its modes. They must not change the client's name, the grant types or the
rule that a failure is a value. The flow keeps no state: Phase 4 owns what is remembered.

## Cross-phase audit

- Phase 2: no shared file. The store holds what `exchange` and `refresh` return.
- Phase 3: owns the shared `SignInTarget`. The shape here matches the contract.
- Phase 4: calls all five functions, and owns the pending `state`, the timers and the
  client's storage. It maps `refresh`'s three answers to its states.
- Phases 5, 6 and 7: use the fixture's protected `/mcp` and its `/authorize` redirect.
