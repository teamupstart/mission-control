// Shaper sign-in's OAuth flow end to end against a loopback mock authorization server: discovery,
// dynamic registration, S256 PKCE, the code exchange, refresh with rotation, revocation and every
// refusal `phase-1-flow-proof.md` names. The tests pin exactly what the MCP SDK sends, so an SDK
// upgrade that changes it fails here. Fake values only: no real login and no real server.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ShapingResultSchema } from "../src/shared/shaping.ts";
import {
  begin, discover, exchange, refresh, revoke, SIGN_IN_CLIENT_NAME,
  type FlowOptions, type SignInClient, type SignInDiscovery, type SignInFailure, type SignInTarget, type SignInTokens,
} from "../src/server/shaping/sign-in/flow.ts";
import { startFakeOAuthServer, type FakeOAuthRequest, type FakeOAuthServer } from "./fixtures/fake-oauth-server.mjs";

const REDIRECT_URI = "http://127.0.0.1:7317/api/shaping/sign-in/callback";
const SCOPE = "mcp:context";
const NOW = 1_800_000_000_000;
const options: FlowOptions = { now: () => NOW, timeoutMs: 2_000 };

const fake = await startFakeOAuthServer();
const split = await startFakeOAuthServer({ separateIssuer: true });
after(() => Promise.all([fake.close(), split.close()]));

/** Every reason a step returned in this file, and every secret value it saw, checked against each other at the end. */
const reasons: string[] = [];
const secrets = new Set<string>();

function failed<T extends { ok: boolean }>(result: T, code: SignInFailure["code"]): SignInFailure {
  assert.equal(result.ok, false, `expected ${code}, got ${JSON.stringify(result)}`);
  const failure = result as unknown as SignInFailure;
  reasons.push(failure.reason);
  assert.equal(failure.code, code, failure.reason);
  assert.ok(failure.reason.length > 0);
  return failure;
}

function ok<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) {
    reasons.push((result as unknown as SignInFailure).reason);
    assert.fail(`expected success, got ${JSON.stringify(result)}`);
  }
  return result as Extract<T, { ok: true }>;
}

function noteTokens(tokens: SignInTokens): SignInTokens {
  secrets.add(tokens.accessToken);
  if (tokens.refreshToken) secrets.add(tokens.refreshToken);
  return tokens;
}

/** What the browser would do: open the authorization URL and read where it is sent back. */
async function authorizeInBrowser(url: string): Promise<URLSearchParams> {
  const response = await fetch(url, { redirect: "manual" });
  assert.equal(response.status, 302, `the authorization endpoint answered ${response.status}`);
  const location = new URL(response.headers.get("location")!);
  assert.equal(`${location.origin}${location.pathname}`, REDIRECT_URI);
  return location.searchParams;
}

const target = (server: FakeOAuthServer, extra: Partial<SignInTarget> = {}): SignInTarget => ({ url: server.resourceUrl, scope: SCOPE, issuer: null, ...extra });

interface SignedIn { discovery: SignInDiscovery; client: SignInClient; tokens: SignInTokens; authorizationUrl: string; codeVerifier: string; code: string }

async function signIn(server: FakeOAuthServer, signInTarget: SignInTarget, client: SignInClient | null = null): Promise<SignedIn> {
  const { discovery } = ok(await discover(signInTarget, options));
  const begun = ok(await begin(signInTarget, discovery, client, REDIRECT_URI, options));
  secrets.add(begun.codeVerifier);
  const back = await authorizeInBrowser(begun.authorizationUrl);
  assert.equal(back.get("error"), null, `the authorization endpoint answered ${back.get("error")}`);
  assert.equal(back.get("state"), begun.state);
  const code = back.get("code")!;
  secrets.add(code);
  const { tokens } = ok(await exchange(signInTarget, discovery, begun.client, { code, codeVerifier: begun.codeVerifier, redirectUri: REDIRECT_URI, iss: back.get("iss") }, options));
  return { discovery, client: begun.client, tokens: noteTokens(tokens), authorizationUrl: begun.authorizationUrl, codeVerifier: begun.codeVerifier, code };
}

/** The requests from `from` on, so a test reads only its own. */
const since = (server: FakeOAuthServer, from: number): FakeOAuthRequest[] => server.requests.slice(from);
const paths = (requests: readonly FakeOAuthRequest[]): string[] => requests.map((request) => `${request.method} ${request.path}`);
const flat = (request: FakeOAuthRequest): string => `${request.path}${request.query} ${JSON.stringify(request.headers)} ${request.body}`;

async function callGuidance(url: string, token: string | null): Promise<unknown> {
  const client = new Client({ name: "sign-in-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : {},
  });
  try {
    await client.connect(transport);
    const reply = await client.callTool({ name: "get_guidance", arguments: { task: "fake task", repo: { name: "fake-repo" } } });
    return reply.structuredContent;
  } finally {
    await client.close().catch(() => {});
  }
}

test("a complete sign-in sends exactly the registration, authorization and token requests the plan pins", async () => {
  fake.resetModes();
  const from = fake.requests.length;
  const signed = await signIn(fake, target(fake));
  const requests = since(fake, from).filter((request) => request.path !== "/authorize");
  // Only the two metadata documents, the registration and the token request: `auth()` read no metadata of its own.
  assert.deepEqual(paths(requests), [
    "GET /.well-known/oauth-protected-resource/mcp",
    "GET /.well-known/oauth-authorization-server",
    "POST /register",
    "POST /token",
  ]);

  const registration = JSON.parse(requests[2]!.body);
  assert.deepEqual(registration, {
    client_name: SIGN_IN_CLIENT_NAME,
    redirect_uris: [REDIRECT_URI],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: SCOPE,
  });
  assert.equal(SIGN_IN_CLIENT_NAME, "Mission Control");
  assert.deepEqual(signed.client, { issuer: fake.issuer, clientId: signed.client.clientId, redirectUri: REDIRECT_URI, scope: SCOPE, registeredAt: NOW });
  assert.match(signed.client.clientId, /^fake-client-\d+$/);

  const url = new URL(signed.authorizationUrl);
  assert.equal(`${url.origin}${url.pathname}`, `${fake.issuer}/authorize`);
  const params = Object.fromEntries(url.searchParams);
  assert.deepEqual(Object.keys(params).sort(), ["client_id", "code_challenge", "code_challenge_method", "redirect_uri", "resource", "response_type", "scope", "state"]);
  assert.equal(params.response_type, "code");
  assert.equal(params.client_id, signed.client.clientId);
  assert.equal(params.code_challenge_method, "S256");
  assert.equal(params.code_challenge, createHash("sha256").update(signed.codeVerifier).digest("base64url"));
  assert.equal(params.redirect_uri, REDIRECT_URI);
  // The configured scope and no other, although the server advertises four.
  assert.equal(params.scope, SCOPE);
  assert.equal(params.resource, fake.resourceUrl);
  assert.match(params.state!, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!signed.authorizationUrl.includes(signed.codeVerifier), "the verifier never leaves in the URL");

  const token = requests[3]!;
  assert.equal(token.headers.authorization, undefined);
  assert.equal(token.headers["content-type"], "application/x-www-form-urlencoded");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(token.body)), {
    grant_type: "authorization_code", code: signed.code, code_verifier: signed.codeVerifier, redirect_uri: REDIRECT_URI,
    resource: fake.resourceUrl, client_id: signed.client.clientId,
  });

  assert.match(signed.tokens.accessToken, /^fake-access-\d+$/);
  assert.match(signed.tokens.refreshToken!, /^fake-refresh-\d+$/);
  assert.deepEqual({ expiresAt: signed.tokens.expiresAt, obtainedAt: signed.tokens.obtainedAt, scope: signed.tokens.scope }, { expiresAt: NOW + 3_600_000, obtainedAt: NOW, scope: SCOPE });
});

test("two sign-ins started for one target carry different state values and verifiers", async () => {
  fake.resetModes();
  const { discovery } = ok(await discover(target(fake), options));
  const first = ok(await begin(target(fake), discovery, null, REDIRECT_URI, options));
  const second = ok(await begin(target(fake), discovery, first.client, REDIRECT_URI, options));
  secrets.add(first.codeVerifier).add(second.codeVerifier);
  assert.notEqual(first.state, second.state);
  assert.notEqual(first.codeVerifier, second.codeVerifier);
  // The stored client is reused as given: no second registration.
  assert.deepEqual(second.client, first.client);
});

test("the protected /mcp answers 401 with a challenge without a token, and its tool with one", async () => {
  fake.resetModes();
  const unauthenticated = await fetch(fake.resourceUrl, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.get("www-authenticate"), `Bearer resource_metadata="${new URL(fake.resourceUrl).origin}/.well-known/oauth-protected-resource/mcp"`);
  await assert.rejects(callGuidance(fake.resourceUrl, null));
  const { tokens } = await signIn(fake, target(fake));
  const guidance = await callGuidance(fake.resourceUrl, tokens.accessToken);
  assert.deepEqual(guidance, { version: "v1.4.0", guidance: [{ id: "guide/fake-repo", title: "Guide", body: "guidance for fake-repo" }] });
});

test("a sign-in for /shape gets a token /shape accepts and /mcp refuses", async () => {
  fake.resetModes();
  const shapeTarget = { url: fake.shapeUrl, scope: SCOPE, issuer: null };
  const post = (url: string, token: string | null) => fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ protocol: 1, task: { title: "Retry failed charges" } }),
  });
  const unauthenticated = await post(fake.shapeUrl, null);
  assert.equal(unauthenticated.status, 401);
  assert.match(unauthenticated.headers.get("www-authenticate")!, /oauth-protected-resource\/shape"$/);

  const signed = await signIn(fake, shapeTarget);
  assert.equal(signed.discovery.resource, fake.shapeUrl);
  const reply = await post(fake.shapeUrl, signed.tokens.accessToken);
  assert.equal(reply.status, 200);
  const result = ShapingResultSchema.parse(await reply.json());
  assert.deepEqual(result, { version: "fake-1", guidance: [{ id: "fake/guide", title: "Guide", body: "guidance for Retry failed charges" }], truncated: false, degraded: false });
  assert.equal((await post(fake.resourceUrl, signed.tokens.accessToken)).status, 401, "/mcp refuses a token issued for /shape");

  const forMcp = await signIn(fake, target(fake));
  assert.equal((await post(fake.shapeUrl, forMcp.tokens.accessToken)).status, 401, "/shape refuses a token issued for /mcp");

  fake.setMode({ shape: "echo" });
  const echoed = ShapingResultSchema.parse(await (await post(fake.shapeUrl, signed.tokens.accessToken)).json());
  assert.equal(echoed.guidance[0]!.body, `the server received Bearer ${signed.tokens.accessToken}`);
  fake.setMode({ shape: "error" });
  const errored = await post(fake.shapeUrl, signed.tokens.accessToken);
  assert.equal(errored.status, 500);
  assert.equal(await errored.text(), `refused Bearer ${signed.tokens.accessToken}`);
  fake.setMode({ shape: "unauthorized" });
  assert.equal((await post(fake.shapeUrl, signed.tokens.accessToken)).status, 401);
  fake.resetModes();
});

test("a refresh rotates the pair, and the spent refresh token then gets sign_in_again", async () => {
  fake.resetModes();
  const signed = await signIn(fake, target(fake));
  const from = fake.requests.length;
  const later = { ...options, now: () => NOW + 60_000 };
  const renewed = noteTokens(ok(await refresh(signed.discovery, signed.client, signed.tokens.refreshToken!, later)).tokens);
  assert.notEqual(renewed.accessToken, signed.tokens.accessToken);
  assert.notEqual(renewed.refreshToken, signed.tokens.refreshToken);
  assert.deepEqual({ expiresAt: renewed.expiresAt, obtainedAt: renewed.obtainedAt, scope: renewed.scope }, { expiresAt: NOW + 60_000 + 3_600_000, obtainedAt: NOW + 60_000, scope: SCOPE });

  const [request] = since(fake, from);
  assert.equal(`${request!.method} ${request!.path}`, "POST /token");
  assert.equal(request!.headers.authorization, undefined);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(request!.body)), {
    grant_type: "refresh_token", refresh_token: signed.tokens.refreshToken, resource: fake.resourceUrl, client_id: signed.client.clientId,
  });
  assert.deepEqual(await callGuidance(fake.resourceUrl, renewed.accessToken), { version: "v1.4.0", guidance: [{ id: "guide/fake-repo", title: "Guide", body: "guidance for fake-repo" }] });

  failed(await refresh(signed.discovery, signed.client, signed.tokens.refreshToken!, options), "sign_in_again");
  // The rotated token still works once.
  noteTokens(ok(await refresh(signed.discovery, signed.client, renewed.refreshToken!, options)).tokens);
});

test("refresh classifies invalid_grant, invalid_client, a 503 and a closed socket", async () => {
  fake.resetModes();
  const signed = await signIn(fake, target(fake));
  const cases = [["invalid_grant", "sign_in_again"], ["invalid_client", "client_rejected"], ["503", "retry"], ["close", "retry"]] as const;
  for (const [mode, code] of cases) {
    fake.setMode({ refresh: mode });
    const from = fake.requests.length;
    const failure = failed(await refresh(signed.discovery, signed.client, signed.tokens.refreshToken!, options), code);
    // One request, and no new authorization or registration: refresh never runs `auth()`.
    assert.deepEqual(paths(since(fake, from)), ["POST /token"], mode);
    if (mode === "503") {
      // The server's body repeated the refresh token: the reason keeps the status and drops the value.
      assert.match(failure.reason, /HTTP 503/);
      assert.match(failure.reason, /\[refresh token redacted\]/);
    }
  }
  fake.resetModes();
});

test("a stalled token endpoint is a retry at the deadline", async () => {
  fake.resetModes();
  const signed = await signIn(fake, target(fake));
  fake.setMode({ stall: "/token" });
  failed(await refresh(signed.discovery, signed.client, signed.tokens.refreshToken!, { ...options, timeoutMs: 200 }), "retry");
  fake.resetModes();
});

test("an exchange the server refuses for its client is client_rejected, never a new registration", async () => {
  fake.resetModes();
  const { discovery } = ok(await discover(target(fake), options));
  const begun = ok(await begin(target(fake), discovery, null, REDIRECT_URI, options));
  secrets.add(begun.codeVerifier);
  const code = (await authorizeInBrowser(begun.authorizationUrl)).get("code")!;
  secrets.add(code);
  const stranger: SignInClient = { ...begun.client, clientId: "fake-client-unknown" };
  const from = fake.requests.length;
  const rejected = failed(await exchange(target(fake), discovery, stranger, { code, codeVerifier: begun.codeVerifier, redirectUri: REDIRECT_URI }, options), "client_rejected");
  // The token endpoint's own OAuth error reaches the reason, not only a fixed sentence.
  assert.match(rejected.reason, /no longer accepts this client: the server answered invalid_client\./);
  assert.deepEqual(paths(since(fake, from)), ["POST /token"]);

  const wrongVerifier = `${begun.codeVerifier.slice(0, -2)}xx`;
  secrets.add(wrongVerifier);
  const again = fake.requests.length;
  const spent = failed(await exchange(target(fake), discovery, begun.client, { code, codeVerifier: wrongVerifier, redirectUri: REDIRECT_URI }, options), "sign_in_again");
  assert.match(spent.reason, /refused the grant: the server answered invalid_grant: the code or its verifier does not match/);
  assert.deepEqual(paths(since(fake, again)), ["POST /token"]);
  // The code was never spent, so the right verifier still finishes the sign-in.
  noteTokens(ok(await exchange(target(fake), discovery, begun.client, { code, codeVerifier: begun.codeVerifier, redirectUri: REDIRECT_URI }, options)).tokens);
});

test("an iss on the redirect must name the authorization server, or nothing is exchanged", async () => {
  fake.resetModes();
  fake.setMode({ iss: true });
  await signIn(fake, target(fake));
  fake.setMode({ iss: fake.elsewhereUrl });
  const { discovery } = ok(await discover(target(fake), options));
  const begun = ok(await begin(target(fake), discovery, null, REDIRECT_URI, options));
  secrets.add(begun.codeVerifier);
  const back = await authorizeInBrowser(begun.authorizationUrl);
  secrets.add(back.get("code")!);
  const from = fake.requests.length;
  failed(await exchange(target(fake), discovery, begun.client, { code: back.get("code")!, codeVerifier: begun.codeVerifier, redirectUri: REDIRECT_URI, iss: back.get("iss") }, options), "refused");
  assert.deepEqual(since(fake, from), []);
  fake.resetModes();
});

test("the registration carries the configured scope, and a client registered for another scope gets invalid_scope", async () => {
  fake.resetModes();
  const first = await signIn(fake, target(fake));
  assert.equal(first.client.scope, SCOPE);
  const otherScope = { ...target(fake), scope: "mcp:other" };
  const { discovery } = ok(await discover(otherScope, options));
  const reused = ok(await begin(otherScope, discovery, first.client, REDIRECT_URI, options));
  secrets.add(reused.codeVerifier);
  const back = await authorizeInBrowser(reused.authorizationUrl);
  assert.equal(back.get("error"), "invalid_scope");
  assert.equal(back.get("code"), null);

  const from = fake.requests.length;
  const second = await signIn(fake, otherScope);
  assert.notEqual(second.client.clientId, first.client.clientId);
  assert.equal(second.client.scope, "mcp:other");
  const registration = since(fake, from).find((request) => request.path === "/register")!;
  assert.equal(JSON.parse(registration.body).scope, "mcp:other");
  assert.equal(new URL(second.authorizationUrl).searchParams.get("scope"), "mcp:other");
  assert.equal(second.tokens.scope, "mcp:other");
});

test("an authorization server on another origin needs the issuer named", async () => {
  split.resetModes();
  const from = split.requests.length;
  const refusal = failed(await discover(target(split), options), "refused");
  assert.match(refusal.reason, /another origin/);
  // The resource metadata was read; the other origin was never reached.
  assert.deepEqual(since(split, from).map((request) => request.server), ["resource"]);

  const named = await signIn(split, target(split, { issuer: split.issuer }));
  assert.equal(named.discovery.authorizationServer, split.issuer);
  assert.deepEqual(named.discovery.origins, [new URL(split.resourceUrl).origin, split.issuer]);
  assert.deepEqual(await callGuidance(split.resourceUrl, named.tokens.accessToken), { version: "v1.4.0", guidance: [{ id: "guide/fake-repo", title: "Guide", body: "guidance for fake-repo" }] });
  noteTokens(ok(await refresh(named.discovery, named.client, named.tokens.refreshToken!, options)).tokens);

  // The discovery is bound to the issuer it was made for: a target for the same server URL whose
  // configured issuer is now none, or another, cannot reuse it to reach the earlier issuer.
  const grant = { code: "fake-code-rebound", codeVerifier: named.codeVerifier, redirectUri: REDIRECT_URI };
  secrets.add(grant.code);
  const rebound = split.requests.length;
  for (const issuer of [null, split.elsewhereUrl]) {
    const changed = target(split, { issuer });
    assert.match(failed(await begin(changed, named.discovery, null, REDIRECT_URI, options), "refused").reason, /another configured issuer/, String(issuer));
    assert.match(failed(await begin(changed, named.discovery, named.client, REDIRECT_URI, options), "refused").reason, /another configured issuer/, String(issuer));
    assert.match(failed(await exchange(changed, named.discovery, named.client, grant, options), "refused").reason, /another configured issuer/, String(issuer));
  }
  assert.deepEqual(since(split, rebound), []);
  // The same issuer spelled with a trailing slash is the same issuer.
  const reused = ok(await begin(target(split, { issuer: `${split.issuer}/` }), named.discovery, named.client, REDIRECT_URI, options));
  secrets.add(reused.codeVerifier);
});

test("metadata that names a server other than the configured issuer is refused, and neither is reached", async () => {
  split.resetModes();
  const from = split.requests.length;
  failed(await discover(target(split, { issuer: split.elsewhereUrl }), options), "refused");
  assert.deepEqual(since(split, from).map((request) => request.server), ["resource"]);

  split.setMode({ resourceMetadata: "foreign-issuer" });
  const again = split.requests.length;
  failed(await discover(target(split), options), "refused");
  assert.deepEqual(since(split, again).map((request) => request.server), ["resource"]);
  split.resetModes();
});

test("a server with no resource metadata is its own authorization server, only without an issuer", async () => {
  fake.resetModes();
  fake.setMode({ resourceMetadata: "none" });
  const signed = await signIn(fake, target(fake));
  assert.equal(signed.discovery.resourceMetadata, null);
  assert.equal(signed.discovery.resource, null);
  assert.equal(new URL(signed.authorizationUrl).searchParams.get("resource"), null);
  const from = fake.requests.length;
  failed(await discover(target(fake, { issuer: fake.issuer }), options), "refused");
  assert.ok(since(fake, from).every((request) => request.path.startsWith("/.well-known/oauth-protected-resource")));
  fake.resetModes();
});

test("each metadata refusal ends in a reason and no further request", async () => {
  const cases = [
    [{ metadata: "wrong-issuer" }, /names the issuer/],
    [{ metadata: "foreign-endpoint" }, /token_endpoint is refused/],
    [{ metadata: "no-s256" }, /S256/],
    [{ metadata: "no-registration" }, /no registration endpoint/],
    [{ metadata: "no-code" }, /does not offer the authorization code flow/],
    [{ resourceMetadata: "wrong-resource" }, /does not match the shaper's URL/],
  ] as const;
  for (const [mode, reason] of cases) {
    fake.resetModes();
    fake.setMode(mode);
    const from = fake.requests.length;
    const refusal = failed(await discover(target(fake), options), "refused");
    assert.match(refusal.reason, reason, JSON.stringify(mode));
    assert.ok(since(fake, from).every((request) => request.path.startsWith("/.well-known/")), JSON.stringify(mode));
  }
  fake.resetModes();
});

test("a registration that carries a client secret is refused, and so is one the server refuses", async () => {
  fake.resetModes();
  const { discovery } = ok(await discover(target(fake), options));
  fake.setMode({ registration: "secret" });
  const from = fake.requests.length;
  const refusal = failed(await begin(target(fake), discovery, null, REDIRECT_URI, options), "refused");
  assert.match(refusal.reason, /public client/);
  assert.doesNotMatch(refusal.reason, /fake-secret/);
  assert.deepEqual(paths(since(fake, from)), ["POST /register"]);

  fake.setMode({ registration: "refuse" });
  failed(await begin(target(fake), discovery, null, REDIRECT_URI, options), "failed");
  fake.resetModes();
});

test("plain http to a host that is not loopback is refused with no request made", async (t) => {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls += 1; return new Response("{}"); }) as typeof fetch;
  t.after(() => { globalThis.fetch = real; });
  failed(await discover({ url: "http://tools.example/mcp", scope: SCOPE, issuer: null }, options), "refused");
  failed(await discover({ url: fake.resourceUrl, scope: SCOPE, issuer: "http://login.example" }, options), "refused");
  assert.equal(calls, 0);
});

test("an oversized, a stalled and a redirected reply each end the step", async () => {
  fake.resetModes();
  fake.setMode({ oversize: "/.well-known/oauth-authorization-server" });
  let from = fake.requests.length;
  assert.match(failed(await discover(target(fake), options), "retry").reason, /more than 64 KiB/);
  assert.deepEqual(paths(since(fake, from)), ["GET /.well-known/oauth-protected-resource/mcp", "GET /.well-known/oauth-authorization-server"]);

  fake.resetModes();
  fake.setMode({ stall: "/.well-known/oauth-protected-resource/mcp" });
  from = fake.requests.length;
  assert.match(failed(await discover(target(fake), { ...options, timeoutMs: 200 }), "retry").reason, /did not answer within/);
  assert.deepEqual(paths(since(fake, from)), ["GET /.well-known/oauth-protected-resource/mcp"]);

  fake.resetModes();
  fake.setMode({ redirect: "/.well-known/oauth-authorization-server" });
  const elsewhere = fake.requests.filter((request) => request.server === "elsewhere").length;
  assert.match(failed(await discover(target(fake), options), "refused").reason, /redirected the sign-in elsewhere/);

  // A redirect at the token endpoint: the code never reaches the other origin.
  fake.resetModes();
  const { discovery } = ok(await discover(target(fake), options));
  const begun = ok(await begin(target(fake), discovery, null, REDIRECT_URI, options));
  secrets.add(begun.codeVerifier);
  const code = (await authorizeInBrowser(begun.authorizationUrl)).get("code")!;
  secrets.add(code);
  fake.setMode({ redirect: "/token" });
  failed(await exchange(target(fake), discovery, begun.client, { code, codeVerifier: begun.codeVerifier, redirectUri: REDIRECT_URI }, options), "refused");
  assert.equal(fake.requests.filter((request) => request.server === "elsewhere").length, elsewhere);
  fake.resetModes();
});

test("a held token reply finishes the exchange once it is released", async () => {
  fake.resetModes();
  const { discovery } = ok(await discover(target(fake), options));
  const begun = ok(await begin(target(fake), discovery, null, REDIRECT_URI, options));
  secrets.add(begun.codeVerifier);
  const code = (await authorizeInBrowser(begun.authorizationUrl)).get("code")!;
  secrets.add(code);
  const release = fake.hold("/token");
  let settled = false;
  const pending = exchange(target(fake), discovery, begun.client, { code, codeVerifier: begun.codeVerifier, redirectUri: REDIRECT_URI }, options)
    .finally(() => { settled = true; });
  await new Promise((done) => setTimeout(done, 100));
  assert.equal(settled, false);
  release();
  noteTokens(ok(await pending).tokens);
});

test("revoke posts the token to the revocation endpoint, and does nothing without one", async () => {
  fake.resetModes();
  const signed = await signIn(fake, target(fake));
  const from = fake.requests.length;
  assert.deepEqual(await revoke(signed.discovery, signed.client, signed.tokens.refreshToken!, options), { ok: true, revoked: true });
  const [request] = since(fake, from);
  assert.equal(`${request!.method} ${request!.path}`, "POST /revoke");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(request!.body)), { token: signed.tokens.refreshToken, client_id: signed.client.clientId });

  const { revocation_endpoint: _unused, ...metadata } = signed.discovery.metadata as typeof signed.discovery.metadata & { revocation_endpoint?: string };
  const again = fake.requests.length;
  assert.deepEqual(await revoke({ ...signed.discovery, metadata }, signed.client, signed.tokens.accessToken, options), { ok: true, revoked: false });
  assert.equal(fake.requests.length, again);
});

test("a revocation the server refuses is failed, and a 429, a 5xx or a closed socket is retry", async () => {
  fake.resetModes();
  const signed = await signIn(fake, target(fake));
  const token = signed.tokens.refreshToken!;
  const cases = [["400", "failed"], ["429", "retry"], ["503", "retry"], ["close", "retry"]] as const;
  for (const [mode, code] of cases) {
    fake.setMode({ revoke: mode });
    const from = fake.requests.length;
    const failure = failed(await revoke(signed.discovery, signed.client, token, options), code);
    assert.deepEqual(paths(since(fake, from)), ["POST /revoke"], mode);
    // Each error body repeated the token: the reason never does.
    assert.ok(!failure.reason.includes(token), `${mode}: ${failure.reason}`);
    if (mode !== "close") assert.match(failure.reason, new RegExp(`HTTP ${mode}`));
  }
  fake.resetModes();
});

test("token replies that omit a lifetime, a scope or a refresh token map to defined results", async () => {
  fake.resetModes();
  fake.setMode({ tokens: "no-expiry" });
  const noExpiry = await signIn(fake, target(fake));
  assert.equal(noExpiry.tokens.expiresAt, null);
  assert.equal(noExpiry.tokens.obtainedAt, NOW);
  assert.equal(noExpiry.tokens.scope, SCOPE);

  fake.setMode({ tokens: "no-scope" });
  const noScope = await signIn(fake, target(fake));
  // RFC 6749 section 5.1: an omitted scope is the one asked for.
  assert.equal(noScope.tokens.scope, SCOPE);
  assert.equal(noScope.tokens.expiresAt, NOW + 3_600_000);
  const renewedNoScope = noteTokens(ok(await refresh(noScope.discovery, noScope.client, noScope.tokens.refreshToken!, options)).tokens);
  assert.equal(renewedNoScope.scope, noScope.client.scope);

  fake.setMode({ tokens: "no-refresh" });
  const noRefresh = await signIn(fake, target(fake));
  assert.equal(noRefresh.tokens.refreshToken, null);
  assert.equal(noRefresh.tokens.expiresAt, NOW + 3_600_000);

  // A server that does not rotate: the refresh token in hand is kept, and works again.
  fake.resetModes();
  const held = await signIn(fake, target(fake));
  fake.setMode({ tokens: "no-refresh" });
  const kept = noteTokens(ok(await refresh(held.discovery, held.client, held.tokens.refreshToken!, options)).tokens);
  assert.equal(kept.refreshToken, held.tokens.refreshToken);
  assert.notEqual(kept.accessToken, held.tokens.accessToken);
  noteTokens(ok(await refresh(held.discovery, held.client, kept.refreshToken!, options)).tokens);
  fake.resetModes();
});

test("a registration with an authentication method other than none is refused before any authorization", async () => {
  fake.resetModes();
  const { discovery } = ok(await discover(target(fake), options));
  fake.setMode({ registration: "auth-method" });
  const from = fake.requests.length;
  const refusal = failed(await begin(target(fake), discovery, null, REDIRECT_URI, options), "refused");
  assert.match(refusal.reason, /authenticates with "client_secret_basic", not as a public client/);
  assert.equal("authorizationUrl" in refusal, false);
  assert.deepEqual(paths(since(fake, from)), ["POST /register"]);
  fake.resetModes();
});

test("a discovery made for another target, or a client bound to another issuer or redirect URI, is refused with no request", async () => {
  fake.resetModes();
  const signed = await signIn(fake, target(fake));
  const { discovery: shapeDiscovery } = ok(await discover({ url: fake.shapeUrl, scope: SCOPE, issuer: null }, options));
  const otherIssuer: SignInClient = { ...signed.client, issuer: fake.elsewhereUrl };
  const otherRedirect: SignInClient = { ...signed.client, redirectUri: "http://127.0.0.1:7318/api/shaping/sign-in/callback" };
  const grant = { code: "fake-code-unused", codeVerifier: signed.codeVerifier, redirectUri: REDIRECT_URI };
  secrets.add(grant.code);
  const from = fake.requests.length;

  assert.match(failed(await begin(target(fake), shapeDiscovery, null, REDIRECT_URI, options), "refused").reason, /discovery was made for another server/);
  assert.match(failed(await exchange(target(fake), shapeDiscovery, signed.client, grant, options), "refused").reason, /discovery was made for another server/);
  assert.match(failed(await begin(target(fake), signed.discovery, otherIssuer, REDIRECT_URI, options), "refused").reason, /registered with another authorization server/);
  assert.match(failed(await exchange(target(fake), signed.discovery, otherIssuer, grant, options), "refused").reason, /registered with another authorization server/);
  assert.match(failed(await begin(target(fake), signed.discovery, otherRedirect, REDIRECT_URI, options), "refused").reason, /registered for another redirect URI/);
  assert.match(failed(await exchange(target(fake), signed.discovery, otherRedirect, grant, options), "refused").reason, /registered for another redirect URI/);
  // A refresh or a revocation with a client bound elsewhere sends its token nowhere.
  assert.match(failed(await refresh(signed.discovery, otherIssuer, signed.tokens.refreshToken!, options), "sign_in_again").reason, /registered with another authorization server/);
  assert.match(failed(await revoke(signed.discovery, otherIssuer, signed.tokens.refreshToken!, options), "refused").reason, /registered with another authorization server/);
  assert.match(failed(await revoke(signed.discovery, otherIssuer, signed.tokens.accessToken, options), "refused").reason, /registered with another authorization server/);

  assert.deepEqual(since(fake, from), []);
  // The refused attempts spent nothing: the real client still refreshes.
  noteTokens(ok(await refresh(signed.discovery, signed.client, signed.tokens.refreshToken!, options)).tokens);
});

test("a definite answer from the token endpoint stops the retrying, and only a transient one is retry", async () => {
  fake.resetModes();
  const signed = await signIn(fake, target(fake));
  const token = signed.tokens.refreshToken!;
  // Each status page repeats the request it got, the refresh token included.
  const cases = [
    [{ status: { "/token": 403 } }, "sign_in_again", /HTTP 403/],
    [{ status: { "/token": 404 } }, "sign_in_again", /HTTP 404/],
    [{ refresh: "invalid_scope" }, "sign_in_again", /invalid_scope: the scope is no longer granted/],
    [{ redirect: "/token" }, "sign_in_again", /redirected the sign-in elsewhere/],
    [{ status: { "/token": 408 } }, "retry", /HTTP 408/],
    [{ status: { "/token": 429 } }, "retry", /HTTP 429/],
    [{ status: { "/token": 502 } }, "retry", /HTTP 502/],
  ] as const;
  for (const [mode, code, reason] of cases) {
    fake.resetModes();
    fake.setMode(mode);
    const from = fake.requests.length;
    const failure = failed(await refresh(signed.discovery, signed.client, token, options), code);
    assert.match(failure.reason, reason, JSON.stringify(mode));
    assert.ok(!failure.reason.includes(token), JSON.stringify(mode));
    assert.deepEqual(paths(since(fake, from)), ["POST /token"], JSON.stringify(mode));
  }
  fake.resetModes();
  // None of those spent the refresh token.
  noteTokens(ok(await refresh(signed.discovery, signed.client, token, options)).tokens);

  // At the exchange a definite answer is failed, since the code is single use, and a 5xx is retry.
  for (const [status, code] of [[403, "failed"], [503, "retry"]] as const) {
    const { discovery } = ok(await discover(target(fake), options));
    const begun = ok(await begin(target(fake), discovery, null, REDIRECT_URI, options));
    secrets.add(begun.codeVerifier);
    const authorizationCode = (await authorizeInBrowser(begun.authorizationUrl)).get("code")!;
    secrets.add(authorizationCode);
    fake.setMode({ status: { "/token": status } });
    const failure = failed(await exchange(target(fake), discovery, begun.client, { code: authorizationCode, codeVerifier: begun.codeVerifier, redirectUri: REDIRECT_URI }, options), code);
    assert.match(failure.reason, new RegExp(`HTTP ${status}`));
    assert.ok(!failure.reason.includes(authorizationCode) && !failure.reason.includes(begun.codeVerifier), failure.reason);
    fake.resetModes();
  }
});

test("a blank scope is refused before any request, never widened to what the server advertises", async () => {
  fake.resetModes();
  const signed = await signIn(fake, target(fake));
  const grant = { code: "fake-code-blank", codeVerifier: signed.codeVerifier, redirectUri: REDIRECT_URI };
  secrets.add(grant.code);
  const from = fake.requests.length;
  for (const scope of ["", "   "]) {
    const blank = target(fake, { scope });
    assert.match(failed(await begin(blank, signed.discovery, null, REDIRECT_URI, options), "refused").reason, /names no scope/);
    assert.match(failed(await begin(blank, signed.discovery, signed.client, REDIRECT_URI, options), "refused").reason, /names no scope/);
    assert.match(failed(await exchange(blank, signed.discovery, signed.client, grant, options), "refused").reason, /names no scope/);
  }
  assert.deepEqual(since(fake, from), []);
});

test("resource metadata is absent only on a 404 or a 410; a 408, 429 or 5xx is retry and any other status a refusal", async () => {
  const wellKnown = "/.well-known/oauth-protected-resource/mcp";
  const cases = [[408, "retry"], [429, "retry"], [503, "retry"], [401, "refused"], [403, "refused"]] as const;
  for (const [status, code] of cases) {
    fake.resetModes();
    fake.setMode({ status: { [wellKnown]: status } });
    const from = fake.requests.length;
    const failure = failed(await discover(target(fake), options), code);
    assert.match(failure.reason, new RegExp(`HTTP ${status} for its resource metadata`));
    // Neither is taken for absence, so the root URL and the authorization server are never asked.
    assert.deepEqual(paths(since(fake, from)), [`GET ${wellKnown}`], String(status));
  }

  // A 410 falls back to the root URL, as a 404 does, and the server is then its own authorization server.
  fake.resetModes();
  fake.setMode({ status: { [wellKnown]: 410 } });
  const gone = ok(await discover(target(fake), options)).discovery;
  assert.equal(gone.resourceMetadata, null);
  assert.equal(gone.resource, null);

  // The authorization server's metadata: a 503 and a 429 are retry, not "publishes none".
  for (const status of [503, 429]) {
    fake.resetModes();
    fake.setMode({ status: { "/.well-known/oauth-authorization-server": status } });
    assert.match(failed(await discover(target(fake), options), "retry").reason, new RegExp(`HTTP ${status}`));
  }
  fake.resetModes();
});

test("a same-origin redirect at the token endpoint is refused, and the code or refresh token is never resent", async () => {
  fake.resetModes();
  const signed = await signIn(fake, target(fake));
  fake.setMode({ redirectWithin: "/token" });
  let from = fake.requests.length;
  assert.match(failed(await refresh(signed.discovery, signed.client, signed.tokens.refreshToken!, options), "sign_in_again").reason, /answered a POST with a 307 redirect/);
  assert.deepEqual(paths(since(fake, from)), ["POST /token"]);

  fake.resetModes();
  const { discovery } = ok(await discover(target(fake), options));
  const begun = ok(await begin(target(fake), discovery, null, REDIRECT_URI, options));
  secrets.add(begun.codeVerifier);
  const code = (await authorizeInBrowser(begun.authorizationUrl)).get("code")!;
  secrets.add(code);
  fake.setMode({ redirectWithin: "/token" });
  from = fake.requests.length;
  failed(await exchange(target(fake), discovery, begun.client, { code, codeVerifier: begun.codeVerifier, redirectUri: REDIRECT_URI }, options), "refused");
  assert.deepEqual(paths(since(fake, from)), ["POST /token"]);
  assert.equal(fake.requests.filter((request) => request.path.startsWith("/moved/")).length, 0);
  fake.resetModes();
});

test("the resource must be exactly the one the metadata URL was built from, query included", async () => {
  // A path-aware document that names the origin root is a broader resource, and is refused.
  fake.resetModes();
  fake.setMode({ resourceMetadata: "broader" });
  assert.match(failed(await discover(target(fake), options), "refused").reason, /does not match the shaper's URL/);

  // A root document that names the shaper's own URL is still exactly this resource.
  fake.setMode({ resourceMetadata: "root-only" });
  const rooted = await signIn(fake, target(fake));
  assert.equal(rooted.discovery.resource, fake.resourceUrl);
  assert.equal(new URL(rooted.authorizationUrl).searchParams.get("resource"), fake.resourceUrl);
  assert.deepEqual(await callGuidance(fake.resourceUrl, rooted.tokens.accessToken), { version: "v1.4.0", guidance: [{ id: "guide/fake-repo", title: "Guide", body: "guidance for fake-repo" }] });

  // RFC 9728 section 3.1: the path-aware URL keeps the shaper URL's query.
  fake.resetModes();
  const withQuery = `${fake.resourceUrl}?tenant=blue`;
  const from = fake.requests.length;
  const discovered = ok(await discover({ url: withQuery, scope: SCOPE, issuer: null }, options)).discovery;
  const [first] = since(fake, from);
  assert.equal(`${first!.path}${first!.query}`, "/.well-known/oauth-protected-resource/mcp?tenant=blue");
  assert.equal(discovered.resource, withQuery);
});

test("a refresh reply with no scope keeps the scope originally granted", async () => {
  fake.resetModes();
  const signed = await signIn(fake, target(fake));
  fake.setMode({ tokens: "no-scope" });
  const narrowed = noteTokens(ok(await refresh(signed.discovery, signed.client, signed.tokens.refreshToken!, { ...options, grantedScope: "mcp:context:read" })).tokens);
  assert.equal(narrowed.scope, "mcp:context:read");
  // Without it, the client's registered scope stands in.
  assert.equal(noteTokens(ok(await refresh(signed.discovery, signed.client, narrowed.refreshToken!, options)).tokens).scope, signed.client.scope);
  fake.resetModes();
});

test("the fixture keeps a code bound to its resource, and each hold is released on its own", async () => {
  fake.resetModes();
  const { discovery } = ok(await discover(target(fake), options));
  const begun = ok(await begin(target(fake), discovery, null, REDIRECT_URI, options));
  secrets.add(begun.codeVerifier);
  const code = (await authorizeInBrowser(begun.authorizationUrl)).get("code")!;
  secrets.add(code);
  const swapped = await fetch(`${fake.issuer}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code, code_verifier: begun.codeVerifier, redirect_uri: REDIRECT_URI,
      client_id: begun.client.clientId, resource: fake.shapeUrl,
    }),
  });
  assert.equal(swapped.status, 400);
  assert.equal(((await swapped.json()) as { error: string }).error, "invalid_target");

  // Two holds on one path: releasing the later one does not free a request waiting on the earlier.
  const releaseFirst = fake.hold("/token");
  let settled = false;
  const pending = exchange(target(fake), discovery, begun.client, { code, codeVerifier: begun.codeVerifier, redirectUri: REDIRECT_URI }, options)
    .finally(() => { settled = true; });
  await new Promise((done) => setTimeout(done, 50));
  const releaseSecond = fake.hold("/token");
  releaseSecond();
  await new Promise((done) => setTimeout(done, 50));
  assert.equal(settled, false);
  releaseFirst();
  // The code was not spent by the refused swap, so the held exchange still signs in.
  noteTokens(ok(await pending).tokens);
});

test("no sign-in request carries a cookie, a carrier or baggage, and codes and refresh tokens reach only /token", () => {
  const signInPaths = /^\/(\.well-known\/|register$|token$|revoke$)/;
  for (const server of [fake, split]) {
    for (const request of server.requests.filter((entry) => signInPaths.test(entry.path))) {
      for (const name of ["cookie", "traceparent", "tracestate", "baggage", "x-work-unit-id"]) assert.equal(request.headers[name], undefined, `${name} on ${request.path}`);
    }
    for (const request of server.requests) {
      const text = flat(request);
      const where = `${request.server} ${request.method} ${request.path}`;
      if (/fake-code-\d+/.test(text)) assert.equal(request.path, "/token", `a code reached ${where}`);
      if (/fake-refresh-\d+/.test(text)) assert.ok(request.path === "/token" || request.path === "/revoke", `a refresh token reached ${where}`);
      if (/fake-access-\d+/.test(text)) assert.ok(["/mcp", "/shape", "/revoke"].includes(request.path), `an access token reached ${where}`);
    }
    assert.ok(server.requests.filter((request) => request.server === "elsewhere").every((request) => !/fake-(code|access|refresh)/.test(flat(request))));
  }
});

test("no returned reason holds a code, a verifier or a token", () => {
  assert.ok(reasons.length >= 20, `only ${reasons.length} reasons were collected`);
  assert.ok(secrets.size >= 20, `only ${secrets.size} secrets were collected`);
  for (const reason of reasons) {
    for (const secret of secrets) assert.ok(!reason.includes(secret), `a reason holds a secret: ${reason}`);
    assert.doesNotMatch(reason, /fake-(code|access|refresh|secret)-\d+/);
  }
});
