// Shaper sign-in over the daemon's HTTP surface, in process: the three routes, `signIns` in
// `GET /api/shaping`, the `shaping_sign_ins` event and the snapshot field. Against the Phase 1
// loopback mock authorization server, with the memory store forced, so every token, code and
// client id is the fixture's `fake-...` and no Keychain item is written. No request leaves
// this machine.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { Hono } from "hono";
import type { ServerEvent } from "../src/shared/types.ts";
import type { ShapingSignInView } from "../src/shared/shaping.ts";
import type { ShaperSignInService } from "../src/server/shaping/sign-in/service.ts";

const home = mkdtempSync(join(tmpdir(), "mission-sign-in-http-"));
process.env.MISSION_HOME = home;
process.env.MISSION_SHAPER_SIGN_IN_STORE = "memory";

const { closeDb, setAppConfig } = await import("../src/server/db.ts");
const { APP_CONFIG_ENTRIES } = await import("../src/shared/app-config-entries.ts");
const { SHAPER_SIGN_IN_FLAG_ID } = await import("../src/shared/feature-flag-registry.ts");
const { SHAPING_CONFIG_DEFAULTS } = await import("../src/shared/shaping.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const flags = await import("../src/server/feature-flags/index.ts");
const shaping = await import("../src/server/shaping/index.ts");
const { shapersFolder } = await import("../src/server/shaping/discovery.ts");
const { registerShapingRoutes } = await import("../src/server/shaping/routes.ts");
const { shaperSignIns, shaperSignInEnabled, signInRedirectUri, signInUses, startShaperSignIns } = await import("../src/server/shaping/sign-in/index.ts");
const { wireShapingSignInEvents } = await import("../src/server/shaping/sign-in/events.ts");
const { createShaperSignInService, SIGN_IN_BEGIN_REFUSALS } = await import("../src/server/shaping/sign-in/service.ts");
const { createMemorySignInStore } = await import("../src/server/shaping/sign-in/store.ts");
const { connectionId } = await import("../src/server/shaping/sign-in/connection.ts");
const { SIGN_IN_PAGE_FAILURES, SIGN_IN_PAGE_HEADERS, SIGN_IN_PAGE_TEXT } = await import("../src/server/shaping/sign-in/callback-page.ts");
const { INVALID_SIGN_IN_BODY, INVALID_SIGN_OUT_BODY, SIGN_IN_START_FAILURES } = await import("../src/server/shaping/sign-in/routes.ts");
const flow = await import("../src/server/shaping/sign-in/flow.ts");
const { startFakeOAuthServer } = await import("./fixtures/fake-oauth-server.mjs");

const fake = await startFakeOAuthServer();
const stopSignIns = startShaperSignIns();
after(async () => {
  await stopSignIns();
  await fake.close();
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

const app = buildApp({ registry: new Registry(), reviews: new ReviewManager(new Registry()), tasks: new TaskManager(new Registry()), queues: new QueueManager(new Registry()) });
const HOST = "127.0.0.1:7317";
const jsonHeaders = { host: HOST, "content-type": "application/json" };
const redirect = new URL(signInRedirectUri());

// ---- what left the daemon, searched at the end of every test ----

/** Every reply body, event frame and snapshot a test saw, by where it came from. */
type Seen = { from: string; text: string };

function seenBy(): Seen[] { return []; }

/** The fixture's secrets: tokens and codes by their fake prefixes, and each verifier it was sent. */
function secrets(): string[] {
  const verifiers = fake.requests
    .filter((request) => request.path === "/token")
    .map((request) => new URLSearchParams(request.body).get("code_verifier"))
    .filter((value): value is string => !!value);
  return ["fake-access-", "fake-refresh-", "fake-code-", "fake-seeded-", ...verifiers];
}

/**
 * No token, code or verifier anywhere. A `state` and a client id only inside `authorizationUrl`
 * of a sign-in reply, which is the one place they may appear.
 */
function assertNothingLeaked(seen: readonly Seen[], states: readonly string[]): void {
  assert.ok(seen.length > 0, "the test recorded what it saw");
  for (const { from, text } of seen) {
    for (const secret of secrets()) assert.equal(text.includes(secret), false, `${from} carries ${secret}`);
    let rest = text;
    if (from.startsWith("sign-in reply")) {
      const reply = JSON.parse(text) as { authorizationUrl?: string };
      if (reply.authorizationUrl) {
        const url = new URL(reply.authorizationUrl);
        assert.ok(url.searchParams.get("state"), "the authorization URL carries the state");
        assert.match(url.searchParams.get("client_id") ?? "", /^fake-client-/, "and the client id");
      }
      rest = JSON.stringify({ ...reply, authorizationUrl: undefined });
    }
    for (const state of states) assert.equal(rest.includes(state), false, `${from} carries a state outside the authorization URL`);
    assert.equal(/fake-client-\d/.test(rest), false, `${from} carries a client id outside the authorization URL`);
  }
}

async function record(seen: Seen[], from: string, response: Response): Promise<{ status: number; text: string; headers: Headers }> {
  const text = await response.text();
  seen.push({ from, text });
  return { status: response.status, text, headers: response.headers };
}

// ---- requests ----

const setFlag = (id: string, enabled: boolean) => assert.equal(flags.applyFeatureFlagIntent({ kind: "flag", id, enabled } as never).ok, true);

function marked(id: string, scope: string, url = fake.resourceUrl) {
  return {
    id, label: `Marked ${id}`, stage: "select",
    transport: { type: "mcp", tool: "get_guidance", server: { type: "http", url, headers: {}, auth: { type: "oauth", scope } } },
  };
}

async function register(shaper: unknown): Promise<void> {
  const response = await app.request("/api/shaping", { method: "PUT", headers: jsonHeaders, body: JSON.stringify({ kind: "upsert", shaper }) });
  assert.equal(response.status, 200, await response.clone().text());
}

function dropManifest(shaper: { id: string }): void {
  const dir = join(shapersFolder(home), shaper.id);
  mkdirSync(dir, { recursive: true });
  chmodSync(shapersFolder(home), 0o755);
  chmodSync(dir, 0o755);
  writeFileSync(join(dir, "shaper.json"), JSON.stringify(shaper));
  chmodSync(join(dir, "shaper.json"), 0o644);
}

const startSignIn = (shaper: string, target: Hono = app) =>
  target.request("/api/shaping/sign-in", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ shaper }) });
const endSignIn = (connection: string) =>
  app.request("/api/shaping/sign-out", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ connection }) });
const shapingReply = () => app.request("/api/shaping", { headers: { host: HOST } });
const callbackAt = (query: string) => app.request(`${redirect.pathname}${query}`, { headers: { host: redirect.host } });

/** What the browser does: open the authorization URL and read where the fixture sends it back. */
async function authorize(authorizationUrl: string): Promise<URL> {
  const response = await fetch(authorizationUrl, { redirect: "manual" });
  assert.equal(response.status, 302);
  const back = new URL(response.headers.get("location")!);
  assert.equal(`${back.origin}${back.pathname}`, `${redirect.origin}${redirect.pathname}`, "the fixture sends the browser to the daemon's callback");
  return back;
}

async function begun(seen: Seen[], shaper: string): Promise<{ authorizationUrl: string; connection: string; expiresAt: number; attempt: number; state: string }> {
  const reply = await record(seen, `sign-in reply for ${shaper}`, await startSignIn(shaper));
  assert.equal(reply.status, 200, reply.text);
  const body = JSON.parse(reply.text) as { authorizationUrl: string; connection: string; expiresAt: number; attempt: number };
  assert.deepEqual(Object.keys(body).sort(), ["attempt", "authorizationUrl", "connection", "expiresAt"]);
  return { ...body, state: new URL(body.authorizationUrl).searchParams.get("state")! };
}

function assertPageHeaders(headers: Headers): void {
  for (const [name, value] of Object.entries(SIGN_IN_PAGE_HEADERS)) assert.equal(headers.get(name), value, name);
}

function assertStaticPage(text: string): void {
  assert.match(text, /^<!doctype html>/);
  assert.equal(/<script|\bsrc=|\bhref=|<link|<img|<form|<iframe/i.test(text), false, "the page loads and runs nothing");
}

const entryOf = (signIns: ShapingSignInView[], id: string) => signIns.find((entry) => entry.id === id);

async function listed(seen: Seen[]): Promise<ShapingSignInView[]> {
  const reply = await record(seen, "GET /api/shaping", await shapingReply());
  assert.equal(reply.status, 200);
  return (JSON.parse(reply.text) as { signIns: ShapingSignInView[] }).signIns;
}

beforeEach(async () => {
  setFlag("task-shaping", true);
  setFlag(SHAPER_SIGN_IN_FLAG_ID, true);
  setAppConfig(APP_CONFIG_ENTRIES.shaping, SHAPING_CONFIG_DEFAULTS);
  shaping.reloadShaping();
  fake.resetModes();
  await shaperSignIns.idle();
});

test("the leak check itself refuses a token, a state outside the URL and a client id outside the URL", () => {
  const url = "http://127.0.0.1:1/authorize?client_id=fake-client-9&state=fake-state-x";
  assert.throws(() => assertNothingLeaked([{ from: "event", text: "{\"t\":\"fake-access-3\"}" }], []));
  assert.throws(() => assertNothingLeaked([{ from: "event", text: "{\"s\":\"fake-state-x\"}" }], ["fake-state-x"]));
  assert.throws(() => assertNothingLeaked([{ from: "sign-in reply", text: JSON.stringify({ authorizationUrl: url, state: "fake-state-x" }) }], ["fake-state-x"]));
  assert.throws(() => assertNothingLeaked([{ from: "sign-out reply", text: "{\"c\":\"fake-client-9\"}" }], []));
  assertNothingLeaked([{ from: "sign-in reply", text: JSON.stringify({ authorizationUrl: url, connection: "c", expiresAt: 1, attempt: 1 }) }], ["fake-state-x"]);
});

// ---- the flow ----

test("a whole sign-in over HTTP: start, the fixture's redirect, the success page, then the list shows it signed in", async () => {
  const seen = seenBy();
  await register(marked("flow", "mcp:flow"));
  const started = await begun(seen, "flow");
  assert.ok(started.expiresAt > Date.now());
  assert.equal(new URL(started.authorizationUrl).searchParams.get("code_challenge_method"), "S256");

  const pending = entryOf(await listed(seen), started.connection);
  assert.equal(pending?.state, "pending");
  assert.equal(pending?.attempt, started.attempt, "the list names the attempt the reply started");
  assert.deepEqual(pending?.shapers, ["flow"]);

  const back = await authorize(started.authorizationUrl);
  const page = await record(seen, "callback page", await callbackAt(back.search));
  assert.equal(page.status, 200);
  assert.ok(page.text.includes(SIGN_IN_PAGE_TEXT.signedIn));
  assertPageHeaders(page.headers);
  assertStaticPage(page.text);
  assert.equal(page.text.includes(back.searchParams.get("code")!), false, "the page never shows the code");
  await shaperSignIns.idle();

  const signedIn = entryOf(await listed(seen), started.connection);
  assert.equal(signedIn?.state, "signed_in");
  assert.equal(signedIn?.storage, "memory");
  assert.equal(started.connection, connectionId({ url: fake.resourceUrl, scope: "mcp:flow", issuer: null }));

  // A state works once: the same redirect again is the failure page, and the sign-in it made stands.
  const replay = await record(seen, "replayed callback page", await callbackAt(back.search));
  assert.equal(replay.status, 400);
  assert.ok(replay.text.includes(SIGN_IN_PAGE_TEXT.notFinished));
  assert.ok(replay.text.includes(SIGN_IN_PAGE_FAILURES.unknown_state));
  assertPageHeaders(replay.headers);
  assert.equal(entryOf(await listed(seen), started.connection)?.state, "signed_in");

  // Sign-out: the reply lists it, and no longer as signed in.
  const ended = await record(seen, "sign-out reply", await endSignIn(started.connection));
  assert.equal(ended.status, 200, ended.text);
  const after = entryOf((JSON.parse(ended.text) as { signIns: ShapingSignInView[] }).signIns, started.connection);
  assert.equal(after?.state, "signed_out", "still listed, because a known shaper names it, but signed out");
  assert.equal(entryOf(await listed(seen), started.connection)?.state, "signed_out");

  assertNothingLeaked(seen, [started.state]);
});

test("a shaper from the folder signs in, and GET /api/shaping tells the service the folder's shapers", async () => {
  const seen = seenBy();
  dropManifest(marked("from-folder", "mcp:folder"));
  try {
    const signIns = await listed(seen);
    const id = connectionId({ url: fake.resourceUrl, scope: "mcp:folder", issuer: null });
    assert.deepEqual(entryOf(signIns, id)?.shapers, ["from-folder"], "the scan this request read is what the service is told");
    const started = await begun(seen, "from-folder");
    assert.equal(started.connection, id);
    const back = await authorize(started.authorizationUrl);
    assert.equal((await record(seen, "callback page", await callbackAt(back.search))).status, 200);
    await shaperSignIns.idle();
    assert.equal(entryOf(await listed(seen), id)?.state, "signed_in");
    assert.equal((await record(seen, "sign-out reply", await endSignIn(id))).status, 200);
    assertNothingLeaked(seen, [started.state]);
  } finally {
    rmSync(join(shapersFolder(home), "from-folder"), { recursive: true, force: true });
  }
});

// ---- starting ----

test("start: an unknown shaper is 404, a shaper with no marker 400, a begin that fails 502", async () => {
  const seen = seenBy();
  // Ids shaped like a token, a code, a client id and a state: neither reply repeats the id it names.
  for (const id of ["fake-access-1", "fake-code-1", "fake-client-7", "fake-state-x"]) {
    const unknown = await record(seen, "sign-in reply unknown", await startSignIn(id));
    assert.equal(unknown.status, 404);
    assert.deepEqual(JSON.parse(unknown.text), { error: "unknown_shaper", reason: "No shaper this build can run has that id." });
    assert.equal(unknown.text.includes(id), false, `the unknown-shaper reply never repeats ${id}`);
  }

  const plain = marked("fake-code-9", "mcp:plain");
  const { auth: _auth, ...server } = plain.transport.server;
  await register({ ...plain, transport: { ...plain.transport, server } });
  const unmarked = await record(seen, "sign-in reply unmarked", await startSignIn("fake-code-9"));
  assert.equal(unmarked.status, 400);
  assert.deepEqual(JSON.parse(unmarked.text), { error: "no_sign_in", reason: "That shaper does not sign in: its definition carries no auth marker." });
  assert.equal(unmarked.text.includes("fake-code-9"), false, "the no-sign-in reply never repeats the stored id");

  // Nothing listens on port 1, so discovery cannot reach the server.
  await register(marked("unreachable", "mcp:unreachable", "http://127.0.0.1:1/mcp"));
  const failed = await record(seen, "sign-in reply unreachable", await startSignIn("unreachable"));
  assert.equal(failed.status, 502, failed.text);
  const failure = JSON.parse(failed.text) as { error: keyof typeof SIGN_IN_START_FAILURES; reason: string };
  assert.equal(failure.reason, SIGN_IN_START_FAILURES[failure.error], "a fixed sentence for its kind, never the flow's own reason");
  assert.equal(typeof JSON.parse(failed.text).reason, "string");

  // A body that is not `{ shaper }` is refused by its schema.
  const malformed = await app.request("/api/shaping/sign-in", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ shaper: "flow", extra: 1 }) });
  assert.equal(malformed.status, 400);
  assertNothingLeaked(seen, ["fake-state-x"]);
});

test("start: with 16 registrations each named by a held sign-in, another scope is 409 and nothing is registered", async (t) => {
  const seen = seenBy();
  const store = createMemorySignInStore();
  const now = Date.now();
  const clients = [];
  for (let n = 0; n < 16; n++) {
    const scope = `mcp:held-${n}`;
    const target = { url: fake.resourceUrl, scope, issuer: null };
    clients.push({ issuer: fake.issuer, clientId: `fake-client-held-${n}`, redirectUri: signInRedirectUri(), scope, registeredAt: now - 1000 + n });
    await store.write(connectionId(target), {
      v: 1, target, issuer: fake.issuer, clientId: `fake-client-held-${n}`,
      accessToken: `fake-seeded-access-${n}`, refreshToken: `fake-seeded-refresh-${n}`,
      expiresAt: now + 3_600_000, scope, obtainedAt: now,
    });
  }
  let held = structuredClone(clients);
  const service = createShaperSignInService({
    store: () => store,
    flow: { discover: flow.discover, begin: flow.begin, exchange: flow.exchange, refresh: flow.refresh, revoke: flow.revoke },
    registrations: { read: () => structuredClone(held), write: (next) => { held = structuredClone(next); } },
    redirectUri: signInRedirectUri(),
    enabled: shaperSignInEnabled,
    onEnabledChanged: (listener) => flags.onFeatureFlagsChanged(() => listener()),
  });
  service.start();
  t.after(() => service.stop());
  await service.idle();
  assert.equal(service.view().length, 16);

  const limited = new Hono();
  registerShapingRoutes(limited, {
    signIns: { service, noteScan: (discovered) => service.setInUse(signInUses(shaping.getShapingConfig(), discovered)) },
  });
  await register(marked("one-more", "mcp:one-more"));
  const before = fake.requests.filter((request) => request.path === "/register").length;
  const refused = await record(seen, "sign-in reply at the limit", await startSignIn("one-more", limited));
  assert.equal(refused.status, 409, refused.text);
  assert.deepEqual(JSON.parse(refused.text), { error: "registration_limit", reason: SIGN_IN_BEGIN_REFUSALS.registration_limit });
  assert.equal(fake.requests.filter((request) => request.path === "/register").length, before, "the fixture saw no registration request");
  assert.equal(held.length, 16);
  assertNothingLeaked(seen, []);
});

test("start: each failure answers its status and a fixed sentence, never the service's reason", async () => {
  const seen = seenBy();
  await register(marked("refusals", "mcp:refusals"));
  const cases = [
    ["store_unread", 409], ["flag_off", 409], ["registration_limit", 409], ["timeout", 504],
    ["retry", 502], ["refused", 502], ["client_rejected", 502], ["sign_in_again", 502], ["failed", 502],
  ] as const;
  for (const [code, status] of cases) {
    const begins: unknown[] = [];
    // Only `begin` is reached by this route; the rest of the service is never called.
    const service = {
      begin: async (target: unknown) => {
        begins.push(target);
        // A reason carrying every kind of value a reply may never hold.
        return { ok: false as const, code, reason: `fake-access-1 fake-code-1 verifier-xyz state=fake-state-1 client_id=fake-client-1 (${code})` };
      },
    } as unknown as ShaperSignInService;
    const stubbed = new Hono();
    registerShapingRoutes(stubbed, { signIns: { service, noteScan: () => {} } });
    const reply = await record(seen, `sign-in reply ${code}`, await startSignIn("refusals", stubbed));
    assert.equal(reply.status, status, code);
    assert.deepEqual(JSON.parse(reply.text), { error: code, reason: SIGN_IN_START_FAILURES[code] });
    for (const value of ["fake-access-1", "fake-code-1", "verifier-xyz", "fake-state-1", "fake-client-1"]) {
      assert.equal(reply.text.includes(value), false, `${code}: the reply never carries ${value}`);
    }
    assert.deepEqual(begins, [{ url: fake.resourceUrl, scope: "mcp:refusals", issuer: null }], "begin was given the shaper's target");
  }
  assertNothingLeaked(seen, []);
});

test("start: a registered shaper is chosen over a folder manifest with the same id, and an unsupported one is not signed in for", async () => {
  const seen = seenBy();
  const folderDir = join(shapersFolder(home), "twin");
  try {
    dropManifest(marked("twin", "mcp:twin-folder"));
    await register(marked("twin", "mcp:twin-registered"));
    const started = await begun(seen, "twin");
    assert.equal(started.connection, connectionId({ url: fake.resourceUrl, scope: "mcp:twin-registered", issuer: null }), "the registered definition's connection");
    assert.equal(new URL(started.authorizationUrl).searchParams.get("scope"), "mcp:twin-registered");
    assert.equal((await record(seen, "sign-out reply", await endSignIn(started.connection))).status, 200);

    // A stored entry this build cannot run holds the id; the valid manifest under it is not used.
    setAppConfig(APP_CONFIG_ENTRIES.shaping, { ...SHAPING_CONFIG_DEFAULTS, shapers: [{ id: "twin", label: "Future", stage: "select", transport: { type: "grpc", endpoint: "dns:///twin" } }] });
    shaping.reloadShaping();
    const before = fake.requests.length;
    const refused = await record(seen, "sign-in reply unsupported", await startSignIn("twin"));
    assert.equal(refused.status, 404);
    assert.equal(JSON.parse(refused.text).error, "unknown_shaper");
    assert.equal(fake.requests.length, before, "no request was made for the folder's definition");
    assertNothingLeaked(seen, [started.state]);
  } finally {
    rmSync(folderDir, { recursive: true, force: true });
  }
});

test("a body that fails its schema answers one fixed 400, which repeats no key or value it was sent", async () => {
  const seen = seenBy();
  const sensitive = ["fake-access-4", "fake-code-4", "fake-client-4", "fake-state-4", "verifier-4"];
  const bodies = [
    // Unexpected keys named like each value a reply may never hold.
    ...sensitive.map((value) => JSON.stringify({ [value]: 1 })),
    JSON.stringify({ shaper: "fake-access-4", connection: "0".repeat(32), "fake-code-4": "fake-state-4" }),
    // Values of the wrong shape, each carrying a sensitive-looking string.
    JSON.stringify({ shaper: "Fake-Code-4 fake-state-4", connection: "fake-client-4" }),
    JSON.stringify({ shaper: ["fake-access-4"], connection: { "fake-code-4": "verifier-4" } }),
    JSON.stringify(["fake-state-4"]),
    "fake-code-4 is not JSON",
    "",
  ];
  for (const [path, fixed] of [["/api/shaping/sign-in", INVALID_SIGN_IN_BODY], ["/api/shaping/sign-out", INVALID_SIGN_OUT_BODY]] as const) {
    for (const body of bodies) {
      const reply = await record(seen, `${path} reply`, await app.request(path, { method: "POST", headers: jsonHeaders, body }));
      assert.equal(reply.status, 400, `${path} ${body}`);
      assert.deepEqual(JSON.parse(reply.text), fixed, `${path} ${body}`);
      for (const value of sensitive) assert.equal(reply.text.includes(value), false, `${path} repeats ${value}`);
    }
  }
  assertNothingLeaked(seen, ["fake-state-4"]);
});

// ---- the callback ----

test("callback: an unknown state, an error parameter, a missing code and an oversized value each answer the failure page", async () => {
  const seen = seenBy();
  await register(marked("callbacks", "mcp:callbacks"));

  const unknown = await record(seen, "callback page unknown state", await callbackAt("?state=never-issued&code=fake-code-never"));
  assert.equal(unknown.status, 400);
  assert.ok(unknown.text.includes(SIGN_IN_PAGE_FAILURES.unknown_state));

  const denied = await begun(seen, "callbacks");
  const deniedPage = await record(seen, "callback page denied", await callbackAt(`?state=${encodeURIComponent(denied.state)}&error=access_denied&error_description=${encodeURIComponent("a server's own words")}`));
  assert.equal(deniedPage.status, 400);
  assert.ok(deniedPage.text.includes(SIGN_IN_PAGE_FAILURES.denied));
  assert.equal(deniedPage.text.includes("access_denied") || deniedPage.text.includes("own words"), false, "nothing the server sent is shown");

  const noCode = await begun(seen, "callbacks");
  const noCodePage = await record(seen, "callback page no code", await callbackAt(`?state=${encodeURIComponent(noCode.state)}`));
  assert.equal(noCodePage.status, 400);
  assert.ok(noCodePage.text.includes(SIGN_IN_PAGE_FAILURES.no_code));

  const oversized = await record(seen, "callback page oversized", await callbackAt(`?state=${"s".repeat(2049)}&code=fake-code-long`));
  assert.equal(oversized.status, 400);
  assert.ok(oversized.text.includes(SIGN_IN_PAGE_FAILURES.malformed));

  for (const page of [unknown, deniedPage, noCodePage, oversized]) {
    assert.ok(page.text.includes(SIGN_IN_PAGE_TEXT.notFinished));
    assert.ok(page.text.includes("Start again from Settings &gt; Task shaping.") || page.text.includes("Start again from Settings > Task shaping."));
    assertPageHeaders(page.headers);
    assertStaticPage(page.text);
    assert.equal(page.text.includes("never-issued"), false, "the page never shows the state it was sent");
  }
  const id = connectionId({ url: fake.resourceUrl, scope: "mcp:callbacks", issuer: null });
  assert.equal(entryOf(await listed(seen), id)?.state, "signed_out", "a used state leaves no pending sign-in");
  assertNothingLeaked(seen, [denied.state, noCode.state]);
});

test("callback: every other failure the service answers is the 400 page with its own fixed sentence, and shows no value", async () => {
  const seen = seenBy();
  const codes = ["wrong_issuer", "cancelled", "flag_off", "client_rejected", "sign_in_again", "refused", "retry", "failed"] as const;
  const sentences = new Set<string>();
  for (const code of codes) {
    const calls: unknown[] = [];
    // Only `complete` is reached by the callback; its reason stands in for text a server sent.
    const service = {
      complete: async (callback: unknown) => {
        calls.push(callback);
        return { ok: false as const, code, reason: `server text fake-server-words-${code}` };
      },
    } as unknown as ShaperSignInService;
    const stubbed = new Hono();
    registerShapingRoutes(stubbed, { signIns: { service, noteScan: () => {} } });
    const query = `?state=fake-state-${code}&code=fake-code-${code}&iss=${encodeURIComponent(`https://issuer-${code}.example`)}`;
    const page = await record(seen, `callback page ${code}`, await stubbed.request(`${redirect.pathname}${query}`));
    assert.equal(page.status, 400, code);
    assert.deepEqual(calls, [{ state: `fake-state-${code}`, code: `fake-code-${code}`, error: null, iss: `https://issuer-${code}.example` }]);
    assert.ok(page.text.includes(SIGN_IN_PAGE_TEXT.notFinished), code);
    const sentence = SIGN_IN_PAGE_FAILURES[code];
    assert.ok(page.text.includes(sentence.replace(">", "&gt;")) || page.text.includes(sentence), `${code} shows its sentence`);
    assert.ok(sentence.endsWith("Start again from Settings > Task shaping."), code);
    sentences.add(sentence);
    for (const value of [`fake-state-${code}`, `issuer-${code}`, "fake-server-words"]) {
      assert.equal(page.text.includes(value), false, `${code}: the page never shows ${value}`);
    }
    assertPageHeaders(page.headers);
    assertStaticPage(page.text);
  }
  assert.equal(sentences.size, codes.length, "each kind of failure has its own sentence");
  assertNothingLeaked(seen, codes.map((code) => `fake-state-${code}`));
});

test("callback: a value of exactly 2 KiB reaches the sign-in service, and one byte more does not", async (t) => {
  const seen = seenBy();
  const complete = t.mock.method(shaperSignIns, "complete");
  const atLimit = "s".repeat(2048);
  const page = await record(seen, "callback page at the limit", await callbackAt(`?state=${atLimit}&code=fake-code-limit`));
  assert.equal(complete.mock.callCount(), 1, "the service is asked");
  assert.equal(complete.mock.calls[0]!.arguments[0].state, atLimit);
  assert.ok(page.text.includes(SIGN_IN_PAGE_FAILURES.unknown_state), "and answers for a state it never issued");

  // Counted in UTF-8 bytes, not characters: 1,025 two-byte characters are 2,050 bytes.
  for (const over of ["s".repeat(2049), "é".repeat(1025)]) {
    const refused = await record(seen, "callback page past the limit", await callbackAt(`?state=${encodeURIComponent(over)}`));
    assert.ok(refused.text.includes(SIGN_IN_PAGE_FAILURES.malformed));
  }
  assert.equal(complete.mock.callCount(), 1, "a value past the limit never reaches the service");
  assertNothingLeaked(seen, []);
});

// ---- sign-out ----

test("sign-out: an unknown connection is 404, and ending a pending sign-in drops it", async () => {
  const seen = seenBy();
  const unknown = await record(seen, "sign-out reply unknown", await endSignIn("0".repeat(32)));
  assert.equal(unknown.status, 404);
  const malformed = await app.request("/api/shaping/sign-out", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ connection: "not-an-id" }) });
  assert.equal(malformed.status, 400);

  await register(marked("cancel", "mcp:cancel"));
  const started = await begun(seen, "cancel");
  const ended = await record(seen, "sign-out reply", await endSignIn(started.connection));
  assert.equal(ended.status, 200);
  assert.equal(entryOf((JSON.parse(ended.text) as { signIns: ShapingSignInView[] }).signIns, started.connection)?.state, "signed_out");
  // The redirect that sign-in would have answered now finds nothing waiting.
  const back = await authorize(started.authorizationUrl);
  const page = await record(seen, "callback page after sign-out", await callbackAt(back.search));
  assert.equal(page.status, 400);
  assertNothingLeaked(seen, [started.state]);
});

// ---- gates ----

test("gates: each route is 404 with either flag off, 403 for a foreign Host or Origin, and 413 past the body limit", async () => {
  const routes = [
    () => startSignIn("flow"),
    () => endSignIn("0".repeat(32)),
    () => callbackAt("?state=x&code=y"),
  ];
  for (const flag of ["task-shaping", SHAPER_SIGN_IN_FLAG_ID]) {
    setFlag(flag, false);
    for (const route of routes) {
      const response = await route();
      assert.equal(response.status, 404, `${flag} off`);
      assert.equal(((await response.json()) as { feature: string }).feature, flag === "task-shaping" ? "task-shaping" : SHAPER_SIGN_IN_FLAG_ID);
    }
    setFlag(flag, true);
  }

  for (const [method, path] of [["POST", "/api/shaping/sign-in"], ["POST", "/api/shaping/sign-out"], ["GET", `${redirect.pathname}?state=x`]] as const) {
    const response = await app.request(path, { method, headers: { ...jsonHeaders, host: "tools.example" }, ...(method === "POST" ? { body: "{}" } : {}) });
    assert.equal(response.status, 403, `${method} ${path} with a foreign Host`);
  }
  for (const path of ["/api/shaping/sign-in", "/api/shaping/sign-out"]) {
    const foreign = await app.request(path, { method: "POST", headers: { ...jsonHeaders, origin: "https://tools.example" }, body: "{}" });
    assert.equal(foreign.status, 403, `${path} with a foreign Origin`);
    const large = await app.request(path, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ shaper: "x".repeat(5000) }) });
    assert.equal(large.status, 413, `${path} past the body limit`);
  }
});

test("GET /api/shaping carries an empty sign-in list while shaper-sign-in is off", async () => {
  await register(marked("listed", "mcp:listed"));
  setFlag(SHAPER_SIGN_IN_FLAG_ID, false);
  const off = await shapingReply();
  assert.equal(off.status, 200);
  assert.deepEqual(((await off.json()) as { signIns: unknown[] }).signIns, []);
  setFlag(SHAPER_SIGN_IN_FLAG_ID, true);
  const on = (await (await shapingReply()).json()) as { signIns: ShapingSignInView[] };
  assert.deepEqual(entryOf(on.signIns, connectionId({ url: fake.resourceUrl, scope: "mcp:listed", issuer: null }))?.shapers, ["listed"]);
});

// ---- the wire ----

test("wire: the event follows each sign-in and sign-out, clears when either flag goes off, and the snapshot carries the list only with both on", async (t) => {
  const seen = seenBy();
  const registry = new Registry();
  const frames: Array<Extract<ServerEvent, { type: "shaping_sign_ins" }>> = [];
  const unsubscribe = registry.subscribe((event) => {
    if (event.type !== "shaping_sign_ins") return;
    frames.push(event);
    seen.push({ from: "shaping_sign_ins frame", text: JSON.stringify(event) });
  });
  const unwire = wireShapingSignInEvents((signIns) => registry.emitShapingSignIns(signIns));
  t.after(() => { unwire(); unsubscribe(); });
  const snapshot = () => {
    const value = registry.snapshot();
    seen.push({ from: "snapshot", text: JSON.stringify(value.shapingSignIns ?? null) });
    return value;
  };
  const lastFrame = () => frames.at(-1)?.signIns ?? null;

  await register(marked("wired", "mcp:wired"));
  await shaperSignIns.idle();
  const id = connectionId({ url: fake.resourceUrl, scope: "mcp:wired", issuer: null });
  assert.equal(entryOf(lastFrame() ?? [], id)?.state, "signed_out", "registering the shaper lists its connection");
  assert.equal(entryOf(snapshot().shapingSignIns ?? [], id)?.state, "signed_out");

  const started = await begun(seen, "wired");
  assert.equal(entryOf(lastFrame()!, id)?.state, "pending");
  const back = await authorize(started.authorizationUrl);
  assert.equal((await record(seen, "callback page", await callbackAt(back.search))).status, 200);
  await shaperSignIns.idle();
  assert.equal(entryOf(lastFrame()!, id)?.state, "signed_in", "a completed sign-in is sent");
  assert.equal(entryOf(snapshot().shapingSignIns!, id)?.state, "signed_in");
  assert.equal(JSON.stringify(frames).includes("authorizationUrl"), false, "no frame carries a link");

  assert.equal((await record(seen, "sign-out reply", await endSignIn(id))).status, 200);
  await shaperSignIns.idle();
  assert.equal(entryOf(lastFrame()!, id)?.state, "signed_out", "an ended sign-in is sent");

  // Repeating the list sends nothing.
  const count = frames.length;
  registry.emitShapingSignIns(shaperSignIns.view());
  assert.equal(frames.length, count);

  for (const flag of [SHAPER_SIGN_IN_FLAG_ID, "task-shaping"]) {
    setFlag(flag, false);
    assert.deepEqual(lastFrame(), [], `${flag} off sends an empty list`);
    assert.equal("shapingSignIns" in snapshot(), false, `${flag} off: the snapshot has no field`);
    const quiet = frames.length;
    setFlag("voice", false);
    assert.equal(frames.length, quiet, "another flag's change sends nothing");
    setFlag(flag, true);
    await shaperSignIns.idle();
    assert.ok(entryOf(lastFrame()!, id), `${flag} on again sends the list`);
    assert.ok(entryOf(snapshot().shapingSignIns!, id));
  }
  assertNothingLeaked(seen, [started.state]);
});
