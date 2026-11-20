// The `http` transport against a loopback server: success, statuses, redirects, the egress rule,
// the 256 KiB body cap, the deadline, header references, redaction, and the trace context and
// work unit id every call carries. No real service, no credential.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ShaperSchema, type ShapingRequest } from "../src/shared/shaping.ts";
import { callHttp } from "../src/server/shaping/transports/http.ts";
import { shapeTask } from "../src/server/shaping/engine.ts";
import { SHAPING_CONFIG_DEFAULTS } from "../src/shared/shaping.ts";
import { REMOTE_REPLY_BYTES } from "../src/server/shaping/transports/remote.ts";
import type { ShaperOf, TransportContext, TransportReply } from "../src/server/shaping/transports/types.ts";

const KEY_ENV = "SHAPING_HTTP_FIXTURE_KEY";
/** A run of spaces, and a tab that a JSON error body echoes as the two characters `\t`. */
const SPACED_KEYS = ["alpha  secret", "alpha  secret\tvalue \"quoted\""];
const KEY = "fixture-key-8e1b42";
const TRACE = { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", tracestate: "mc=launch" };
const OK = { version: "v1.4.0", guidance: [{ id: "payments/idempotency", title: "Idempotent charges", body: "Use an idempotency key." }] };

interface Seen { method: string; path: string; headers: IncomingHttpHeaders; body: string }
const seen: Seen[] = [];
let server: Server;
let other: Server;
let base = "";
let otherBase = "";

/** A JSON reply of exactly `bytes` bytes, for standing on either side of the cap. */
function sized(bytes: number): string {
  const shell = JSON.stringify({ guidance: [{ id: "big", body: "" }] });
  return JSON.stringify({ guidance: [{ id: "big", body: "x".repeat(bytes - shell.length) }] });
}

before(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const path = new URL(req.url ?? "/", "http://x").pathname;
    seen.push({ method: req.method ?? "", path, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
    const json = (status: number, value: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    switch (path) {
      case "/ok": return json(200, OK);
      case "/status": return json(503, { error: `upstream unavailable for ${req.headers["x-api-key"] ?? "nobody"}` });
      case "/same": return res.writeHead(307, { location: "/ok" }).end();
      case "/away": return res.writeHead(307, { location: `${otherBase}/ok` }).end();
      case "/at-cap": return res.writeHead(200, { "content-type": "application/json" }).end(sized(REMOTE_REPLY_BYTES));
      case "/over-cap": return res.writeHead(200, { "content-type": "application/json" }).end(sized(REMOTE_REPLY_BYTES + 1));
      case "/slow": setTimeout(() => json(200, OK), 5_000); return;
      case "/echo": return json(200, { guidance: [{ id: "echo", title: `key ${req.headers["x-api-key"] ?? "none"}`, body: JSON.stringify({ headers: req.headers }) }] });
      case "/moved": return res.writeHead(302, { location: "/ok" }).end();
      case "/escaped-status": {
        // Every character of the echoed value written as a \u escape, valid JSON for the same text.
        const echoed = [...String(req.headers["x-api-key"] ?? "")].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
        return res.writeHead(500, { "content-type": "application/json" }).end(`{"error":"denied for ${echoed}"}`);
      }
      case "/spaced-note": {
        const value = String(req.headers["x-caller"] ?? "");
        return json(200, { degraded: true, notes: [`no guidance for ${value.replace(" ", "   ")}`], guidance: [] });
      }
      default: return json(404, {});
    }
  });
  other = createServer((req, res) => {
    seen.push({ method: req.method ?? "", path: `other:${req.url}`, headers: req.headers, body: "" });
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(OK));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  // "localhost" and "127.0.0.1" are different origins, so a redirect between them leaves the origin.
  await new Promise<void>((done) => other.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  otherBase = `http://localhost:${(other.address() as AddressInfo).port}`;
});
after(async () => {
  server.closeAllConnections();
  other.closeAllConnections();
  await new Promise((done) => server.close(done));
  await new Promise((done) => other.close(done));
});

function shaper(path: string, headers: Record<string, string> = {}, url = `${base}${path}`): ShaperOf<"http"> {
  return ShaperSchema.parse({ id: "remote", label: "Remote", stage: "select", transport: { type: "http", url, headers } }) as ShaperOf<"http">;
}

function request(): ShapingRequest {
  return {
    protocol: 1, stage: "select", task: "Retry failed charges", repo: { name: "billing-api" },
    context: {
      taskId: "t_1", title: "Retry", kind: "ship", harness: "claude", runtime: "sdk", afterWork: null, labels: [], priority: null,
      repositories: [{ slot: "repo-01", name: "billing-api", role: "primary", branch: null, baseSha: null }], target: "repo-01",
      caller: { user: "declared-user", agent: "claude", conversation: "t_1" },
    },
    limits: { maxBytes: 16_384, deadlineMs: 5_000 },
  };
}

function ctx(extra: Partial<TransportContext> = {}, timeoutMs = 10_000): TransportContext {
  return {
    deadline: Date.now() + timeoutMs, timeoutMs, signal: new AbortController().signal,
    scope: { shared: new Map(), defer() {} }, root: null, trace: null, workUnitId: null, ...extra,
  };
}

function data(reply: TransportReply): any {
  assert.equal(reply.kind, "data", JSON.stringify(reply));
  const value = (reply as { data: unknown }).data;
  return typeof value === "string" ? JSON.parse(value) : value;
}

async function withKey<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const saved = process.env[KEY_ENV];
  if (value === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = value;
  try { return await run(); } finally {
    if (saved === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = saved;
  }
}

const last = () => seen.at(-1)!;

test("a 2xx reply is data, and the request is POSTed as JSON", async () => {
  const reply = await callHttp(request(), shaper("/ok"), ctx());
  assert.deepEqual(data(reply), OK);
  assert.equal(last().method, "POST");
  assert.equal(last().headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(last().body), request());
});

test("a status outside 2xx is failed, with the status", async () => {
  const reply = await callHttp(request(), shaper("/status"), ctx());
  assert.equal(reply.kind, "failed");
  assert.match((reply as { reason: string }).reason, /^The shaper answered HTTP 503: /);
});

test("a redirect on the origin is followed, and one off it is refused without a request there", async () => {
  assert.deepEqual(data(await callHttp(request(), shaper("/same"), ctx())), OK);
  const before = seen.filter((entry) => entry.path.startsWith("other:")).length;
  const reply = await withKey(KEY, () => callHttp(request(), shaper("/away", { "x-api-key": `{env:${KEY_ENV}}` }), ctx()));
  assert.equal(reply.kind, "failed");
  assert.match((reply as { reason: string }).reason, /redirected to another origin/);
  assert.equal(seen.filter((entry) => entry.path.startsWith("other:")).length, before, "the other origin never received a request");
});

test("plain http to a host that is not loopback gets no request, with or without a credential header; loopback is called", async () => {
  const original = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => { fetched += 1; return original(...args); }) as typeof fetch;
  try {
    for (const headers of [{}, { authorization: `Bearer {env:${KEY_ENV}}` }] as Array<Record<string, string>>) {
      const reply = await withKey(KEY, () => callHttp(request(), shaper("", headers, "http://guidance.example.invalid/v1/guidance"), ctx()));
      assert.equal(reply.kind, "unavailable");
      assert.match((reply as { reason: string }).reason, /plain http to a host that is not this machine, so no request was sent/);
    }
    assert.equal(fetched, 0, "nothing was sent");
    const loopback = await withKey(KEY, () => callHttp(request(), shaper("/ok", { authorization: `Bearer {env:${KEY_ENV}}` }), ctx()));
    assert.equal(loopback.kind, "data");
    assert.equal(fetched, 1);
    assert.equal(last().headers.authorization, `Bearer ${KEY}`, "a credential may travel over plain http to loopback");
  } finally { globalThis.fetch = original; }
});

test("the body is read to at most 256 KiB", async () => {
  assert.equal((await callHttp(request(), shaper("/at-cap"), ctx())).kind, "data", "exactly at the cap is read");
  assert.deepEqual(await callHttp(request(), shaper("/over-cap"), ctx()),
    { kind: "failed", reason: "The reply was larger than 256 KiB, so it was not read." });
});

test("the deadline aborts the request", async () => {
  const started = Date.now();
  const reply = await callHttp(request(), shaper("/slow"), ctx({}, 300));
  assert.deepEqual(reply, { kind: "timed_out", reason: "Timed out after 0.3 s." });
  assert.ok(Date.now() - started < 3_000);
  const aborted = new AbortController();
  setTimeout(() => aborted.abort(), 100);
  assert.equal((await callHttp(request(), shaper("/slow"), ctx({ signal: aborted.signal }))).kind, "timed_out", "and so does the engine's signal");
});

test("headers resolve their references at call time, and a missing one sends no request", async () => {
  const headers = { "x-api-key": `{env:${KEY_ENV}}`, "x-caller": "{caller.user}/{caller.agent}/{caller.conversation}" };
  await withKey(KEY, () => callHttp(request(), shaper("/ok", headers), ctx()));
  assert.equal(last().headers["x-api-key"], KEY);
  assert.equal(last().headers["x-caller"], "declared-user/claude/t_1");
  const count = seen.length;
  for (const value of [undefined, ""]) {
    const reply = await withKey(value, () => callHttp(request(), shaper("/ok", headers), ctx()));
    assert.deepEqual(reply, { kind: "unavailable", reason: `The reference {env:${KEY_ENV}} did not resolve to a value, so the shaper was not called.` });
  }
  const undeclared = { ...request(), context: { ...request().context, caller: { user: null, agent: "claude", conversation: "t_1" } } };
  assert.deepEqual(await callHttp(undeclared, shaper("/ok", { "x-caller": "{caller.user}" }), ctx()),
    { kind: "unavailable", reason: "The reference {caller.user} did not resolve to a value, so the shaper was not called." });
  assert.equal(seen.length, count, "no request at all");
});

test("a reply that echoes a resolved header value comes back redacted and marked", async () => {
  const reply = await withKey(KEY, () => callHttp(request(), shaper("/echo", { "x-api-key": `{env:${KEY_ENV}}` }), ctx()));
  assert.equal(reply.redacted, true);
  assert.equal(data(reply).guidance[0].title, `key [${KEY_ENV} redacted]`);
  assert.equal(JSON.stringify((reply as { data: unknown }).data).includes(KEY), false);
  const status = await withKey(KEY, () => callHttp(request(), shaper("/status", { "x-api-key": `{env:${KEY_ENV}}` }), ctx()));
  assert.equal(status.kind, "failed");
  assert.equal(status.redacted, true);
  assert.equal((status as { reason: string }).reason.includes(KEY), false);
  assert.ok((status as { reason: string }).reason.includes(`[${KEY_ENV} redacted]`));
});

test("with a trace context every call carries it, and configured carriers are always removed", async () => {
  const configured = { TraceParent: "00-11111111111111111111111111111111-2222222222222222-01", TRACESTATE: "vendor=configured", "X-Work-Unit-ID": "wu-configured" };
  await callHttp(request(), shaper("/ok", configured), ctx({ trace: TRACE }));
  assert.match(String(last().headers.traceparent), /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
  assert.equal(last().headers.traceparent, TRACE.traceparent);
  assert.equal(last().headers.tracestate, TRACE.tracestate);
  await callHttp(request(), shaper("/ok", configured), ctx({ trace: { traceparent: TRACE.traceparent } }));
  assert.equal(last().headers.traceparent, TRACE.traceparent);
  assert.equal(last().headers.tracestate, undefined, "the configured tracestate is not sent");
  await callHttp(request(), shaper("/ok", configured), ctx());
  assert.equal(Object.keys(last().headers).some((name) => /^(traceparent|tracestate|x-work-unit-id)$/i.test(name)), false, "with none, nothing");
});

test("with a work unit id every call carries x-work-unit-id, and with none it sends none", async () => {
  const configured = { "X-WORK-UNIT-ID": "wu-configured" };
  await callHttp(request(), shaper("/ok", configured), ctx({ workUnitId: "wu_01JD5Z" }));
  assert.equal(last().headers["x-work-unit-id"], "wu_01JD5Z");
  await callHttp(request(), shaper("/ok", configured), ctx());
  assert.equal(last().headers["x-work-unit-id"], undefined, "the configured one is removed even with none to send");
});

test("a reply that echoes the trace context or the work unit id keeps it, unredacted and unmarked", async () => {
  const reply = await withKey(KEY, () => callHttp(request(), shaper("/echo", { "x-api-key": `{env:${KEY_ENV}}` }),
    ctx({ trace: TRACE, workUnitId: "wu_01JD5Z" })));
  const echoedHeaders = JSON.parse(data(reply).guidance[0].body).headers;
  assert.equal(echoedHeaders.traceparent, TRACE.traceparent);
  assert.equal(echoedHeaders["x-work-unit-id"], "wu_01JD5Z");
  assert.equal(echoedHeaders["x-api-key"], `[${KEY_ENV} redacted]`, "only the resolved reference is redacted");
});

test("an echoed value with runs of whitespace, or JSON-escaped in the body, is redacted from a failure reason", async () => {
  for (const key of SPACED_KEYS) {
    const reply = await withKey(key, () => callHttp(request(), shaper("/status", { "x-api-key": `{env:${KEY_ENV}}` }), ctx()));
    assert.equal(last().headers["x-api-key"], key, "the server received the value as written");
    assert.equal(reply.kind, "failed");
    assert.equal(reply.redacted, true, JSON.stringify(reply));
    const reason = (reply as { reason: string }).reason;
    assert.equal(reason, `The shaper answered HTTP 503: {"error":"upstream unavailable for [${KEY_ENV} redacted]"}`);
    for (const piece of ["alpha", "secret", "quoted"]) assert.equal(reason.includes(piece), false, `${piece} is not in the reason`);
  }
});

test("a configured Content-Type or Accept, in any case, never replaces the JSON the transport sends", async () => {
  const reply = await callHttp(request(), shaper("/ok", { "Content-Type": "text/plain", ACCEPT: "text/html", "x-tenant": "kept" }), ctx());
  assert.deepEqual(data(reply), OK);
  assert.equal(last().headers["content-type"], "application/json");
  assert.equal(last().headers.accept, "application/json");
  assert.equal(last().headers["x-tenant"], "kept", "other configured headers still ride the request");
  assert.deepEqual(JSON.parse(last().body), request());
});

test("a value with spaces or tabs at its ends is redacted in the trimmed form the server received", async () => {
  const padded = "  trimmed-key-5c1d\t";
  const reply = await withKey(padded, () => callHttp(request(), shaper("/echo", { "x-api-key": `{env:${KEY_ENV}}` }), ctx()));
  assert.equal(last().headers["x-api-key"], "trimmed-key-5c1d", "Headers trims the ends before sending");
  assert.equal(reply.redacted, true);
  assert.equal(JSON.stringify((reply as { data: unknown }).data).includes("trimmed-key-5c1d"), false);
  assert.equal(data(reply).guidance[0].title, `key [${KEY_ENV} redacted]`);
});

test("an unset reference in a header the transport owns and replaces does not block the call", async () => {
  const reply = await withKey(undefined, () => callHttp(request(), shaper("/ok", { Accept: `{env:${KEY_ENV}}`, "content-type": `{env:${KEY_ENV}}` }), ctx()));
  assert.deepEqual(data(reply), OK);
  assert.equal(last().headers.accept, "application/json");
});

test("a 301 or 302 that would resend the request as a GET is refused, not followed into an empty reply", async () => {
  const before = seen.filter((entry) => entry.path === "/ok").length;
  const reply = await callHttp(request(), shaper("/moved"), ctx());
  assert.equal(reply.kind, "failed");
  assert.match((reply as { reason: string }).reason, /answered 302, a redirect that would resend this POST as a GET without its body/);
  assert.equal(seen.filter((entry) => entry.path === "/ok").length, before, "the GET was never sent");
});

test("a value written with JSON escapes inside a successful reply's text is redacted", async () => {
  // A quote and a backslash: the /echo body is JSON text of the headers, so they arrive escaped.
  const tricky = 'quote"slash\\key-91be';
  const reply = await withKey(tricky, () => callHttp(request(), shaper("/echo", { "x-api-key": `{env:${KEY_ENV}}` }), ctx()));
  assert.equal(reply.redacted, true);
  const body = data(reply).guidance[0].body as string;
  assert.equal(body.includes("key-91be"), false, body.slice(0, 200));
  assert.equal(JSON.parse(body).headers["x-api-key"], `[${KEY_ENV} redacted]`);
});

test("a failure body that spells a value in any JSON escape is redacted from the reason", async () => {
  const reply = await withKey("plain-key-77aa", () => callHttp(request(), shaper("/escaped-status", { "x-api-key": `{env:${KEY_ENV}}` }), ctx()));
  assert.equal(reply.kind, "failed");
  assert.equal(reply.redacted, true);
  assert.equal((reply as { reason: string }).reason, `The shaper answered HTTP 500: {"error":"denied for [${KEY_ENV} redacted]"}`);
});

test("a degraded note that spaces a resolved value out is redacted in the record, and the record is marked", async () => {
  const remote = shaper("/spaced-note", { "x-caller": "{caller.user}" });
  const result = await shapeTask({
    task: "Retry",
    context: {
      taskId: "t_1", title: "Retry", kind: "ship", harness: "claude", runtime: "sdk", afterWork: null, labels: [], priority: null,
      repositories: [{ name: "billing-api", role: "primary", branch: null, baseSha: null, path: null }],
    },
  }, {
    config: { ...SHAPING_CONFIG_DEFAULTS, caller: { user: "Jane Doe" }, shapers: [remote], overrides: { remote: true } },
    discovered: [], enabled: true,
  });
  const row = result.summary!.shapers[0]!;
  assert.equal(last().headers["x-caller"], "Jane Doe");
  assert.equal(row.outcome, "degraded");
  assert.equal(row.redacted, true, JSON.stringify(row));
  assert.equal(JSON.stringify(result.summary).includes("Jane Doe"), false, row.reason ?? "");
  assert.match(row.reason ?? "", /no guidance for \[caller\.user redacted\]/);
});

test("an echoed caller value resolved into a header comes back redacted and marked", async () => {
  const reply = await callHttp(request(), shaper("/echo", { "x-caller": "{caller.user}/{caller.agent}/{caller.conversation}" }), ctx());
  assert.equal(last().headers["x-caller"], "declared-user/claude/t_1", "the server received the resolved values");
  assert.equal(reply.redacted, true);
  const text = JSON.stringify((reply as { data: unknown }).data);
  for (const value of ["declared-user", "claude", "t_1"]) assert.equal(text.includes(value), false, `${value} is not in the reply`);
  assert.equal(JSON.parse(data(reply).guidance[0].body).headers["x-caller"],
    "[caller.user redacted]/[caller.agent redacted]/[caller.conversation redacted]");
});
