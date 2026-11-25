// `signInFetch`, the one fetch shaper sign-in requests use: which origins and URLs it reaches,
// what it adds and strips, redirects, the 64 KiB cap and the deadline. Loopback servers and fake
// values only.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  SIGN_IN_REPLY_BYTES, SIGN_IN_REQUEST_MS, SignInRefusal, SignInRequestError, signInFetch,
} from "../src/server/shaping/sign-in/egress.ts";

interface Loopback { origin: string; seen: Array<{ path: string; headers: IncomingHttpHeaders }>; server: Server }

const servers: Server[] = [];
after(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); })));
});

async function loopback(answer: (path: string, res: import("node:http").ServerResponse, origin: string) => void): Promise<Loopback> {
  const seen: Loopback["seen"] = [];
  let origin = "";
  const server = createServer((req, res) => {
    seen.push({ path: req.url ?? "", headers: { ...req.headers } });
    req.resume();
    req.on("end", () => answer(req.url ?? "", res, origin));
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, seen, server };
}

const other = await loopback((_path, res) => res.writeHead(200).end("elsewhere"));
const main = await loopback((path, res, origin) => {
  if (path === "/big") return void res.writeHead(200).end("x".repeat(SIGN_IN_REPLY_BYTES + 1));
  if (path === "/exact") return void res.writeHead(200).end("x".repeat(SIGN_IN_REPLY_BYTES));
  if (path === "/stall") return;
  if (path === "/away") return void res.writeHead(302, { location: `${other.origin}/taken` }).end();
  if (path === "/near") return void res.writeHead(307, { location: `${origin}/here` }).end();
  if (path === "/empty") return void res.writeHead(204).end();
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ path }));
});

test("the defaults are 64 KiB and 10 seconds", () => {
  assert.equal(SIGN_IN_REPLY_BYTES, 65_536);
  assert.equal(SIGN_IN_REQUEST_MS, 10_000);
});

test("an origin the sign-in may not reach is refused before any request", async () => {
  const fetchFn = signInFetch([main.origin]);
  const before = other.seen.length;
  await assert.rejects(fetchFn(`${other.origin}/metadata`), (error: unknown) => error instanceof SignInRefusal && /not an origin this sign-in may reach/.test(error.message));
  assert.equal(other.seen.length, before);
});

test("plain http to a host that is not loopback, and other schemes, are refused before any request", async (t) => {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls += 1; return new Response("no"); }) as typeof fetch;
  t.after(() => { globalThis.fetch = real; });
  for (const url of ["http://tools.example/mcp", "ftp://tools.example/mcp", "http://user:pw@127.0.0.1:1/x"]) {
    const origin = new URL(url).protocol === "ftp:" ? "ftp://tools.example" : new URL(url).origin;
    await assert.rejects(signInFetch([origin])(url), SignInRefusal, url);
  }
  assert.equal(calls, 0);
  // https to the same host is allowed by the URL rule: it reaches the (stubbed) network.
  await signInFetch(["https://tools.example"])("https://tools.example/mcp");
  assert.equal(calls, 1);
});

test("no cookie and no carrier is sent, and no header is added", async () => {
  const fetchFn = signInFetch([main.origin]);
  const response = await fetchFn(`${main.origin}/plain`, {
    headers: {
      cookie: "fake-session=1", traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", tracestate: "mc=1",
      "x-work-unit-id": "wu_fake", baggage: "fake.key=1", accept: "application/json",
    },
  });
  assert.deepEqual(await response.json(), { path: "/plain" });
  const { headers } = main.seen.at(-1)!;
  for (const name of ["cookie", "traceparent", "tracestate", "baggage", "x-work-unit-id", "authorization"]) assert.equal(headers[name], undefined, name);
  assert.equal(headers.accept, "application/json");
  // What the runtime itself sends, and nothing of Mission Control's.
  assert.deepEqual(
    Object.keys(headers).filter((name) => !["host", "connection", "accept", "accept-language", "accept-encoding", "sec-fetch-mode", "user-agent"].includes(name)),
    [],
  );
});

test("a redirect that leaves the origins is refused and its target is never reached", async () => {
  const before = other.seen.length;
  await assert.rejects(signInFetch([main.origin])(`${main.origin}/away`), (error: unknown) => error instanceof SignInRefusal && /redirected the sign-in elsewhere/.test(error.message));
  assert.equal(other.seen.length, before);
});

test("a redirect within the origins is returned unfollowed, with its location", async () => {
  const seen = main.seen.length;
  const response = await signInFetch([main.origin])(`${main.origin}/near`);
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), `${main.origin}/here`);
  assert.equal(main.seen.length, seen + 1);
});

test("a redirect answering a POST is refused, even within the origins, so its body is never resent", async () => {
  for (const method of ["POST", "PUT"]) {
    const seen = main.seen.length;
    await assert.rejects(
      signInFetch([main.origin])(`${main.origin}/near`, { method, body: "code=fake-code-1&code_verifier=fake-verifier" }),
      (error: unknown) => error instanceof SignInRefusal && new RegExp(`answered a ${method} with a 307 redirect`).test(error.message),
    );
    // The one request was made; the redirect target never was.
    assert.deepEqual(main.seen.slice(seen).map((entry) => entry.path), ["/near"]);
  }
  // A HEAD, like a GET, is a read and comes back unfollowed for the caller to decide on.
  assert.equal((await signInFetch([main.origin])(`${main.origin}/near`, { method: "HEAD" })).status, 307);
});

test("a reply is read to 64 KiB and no further", async () => {
  const exact = await signInFetch([main.origin])(`${main.origin}/exact`);
  assert.equal((await exact.text()).length, SIGN_IN_REPLY_BYTES);
  await assert.rejects(signInFetch([main.origin])(`${main.origin}/big`), (error: unknown) => error instanceof SignInRequestError && /more than 64 KiB/.test(error.message));
});

test("a reply with no body keeps its status", async () => {
  const response = await signInFetch([main.origin])(`${main.origin}/empty`);
  assert.equal(response.status, 204);
});

test("a stalled reply ends at the deadline, as a request error and never a TypeError", async () => {
  const started = Date.now();
  await assert.rejects(signInFetch([main.origin], { timeoutMs: 200 })(`${main.origin}/stall`), (error: unknown) => {
    assert.ok(error instanceof SignInRequestError);
    assert.ok(!(error instanceof TypeError));
    assert.match(error.message, /did not answer within 0\.2 seconds/);
    return true;
  });
  assert.ok(Date.now() - started < 5_000);
});

test("a connection that fails is a request error naming the origin, never a TypeError", async () => {
  const closed = await loopback(() => {});
  const origin = closed.origin;
  await new Promise<void>((done) => { closed.server.closeAllConnections(); closed.server.close(() => done()); });
  servers.splice(servers.indexOf(closed.server), 1);
  await assert.rejects(signInFetch([origin])(`${origin}/x`), (error: unknown) => {
    assert.ok(error instanceof SignInRequestError && !(error instanceof TypeError));
    assert.match(error.message, new RegExp(`Could not reach ${origin.replace(/[.]/g, "\\.")}`));
    return true;
  });
});
