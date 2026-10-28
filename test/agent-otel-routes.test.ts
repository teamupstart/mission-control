import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// Agent telemetry at the routes: the tee on `/v1/{logs,metrics,traces}` and the Settings API.
//
// What is at stake is that the tee is purely additive. `/v1/metrics` must answer and write the
// ledger exactly as before whatever the upstream does, the relay-only token must never reach the
// ledger, and a stored header must never come back out of any response.

const home = mkdtempSync(join(tmpdir(), "mission-agent-otel-routes-"));
process.env.MISSION_HOME = home;

const { openDb } = await import("../src/server/db.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { agentOtelForwarder, agentOtelLaunch } = await import("../src/server/agent-otel/config.ts");
const { setAgentOtelManagedDepsForTest } = await import("../src/server/agent-otel/managed.ts");
const { agentOtelRelayToken } = await import("../src/server/agent-otel/relay-token.ts");
const { stubRun } = await import("../src/server/util/exec.ts");

// A local OTLP sink standing in for the gateway. Its answer is scripted per test.
const received: Array<{ url: string; headers: IncomingHttpHeaders; body: Buffer }> = [];
let sinkStatus = 200;
const sink = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    received.push({ url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
    res.statusCode = sinkStatus;
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
});
await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
const SINK = `http://127.0.0.1:${(sink.address() as AddressInfo).port}`;

after(() => {
  sink.close();
  setAgentOtelManagedDepsForTest(null);
  rmSync(home, { recursive: true, force: true });
});

const db = openDb();
const TOKEN = ensureToken();
const registry = new Registry();
const app = buildApp({
  registry,
  reviews: new ReviewManager(registry),
  tasks: new TaskManager(registry),
  queues: new QueueManager(registry),
});

const END_NS = `${Date.now()}000000`;
const METRICS = (sessionId: string) => ({
  resourceMetrics: [
    {
      scopeMetrics: [
        {
          metrics: [
            {
              name: "claude_code.cost.usage",
              sum: {
                aggregationTemporality: 1,
                dataPoints: [
                  {
                    asDouble: 0.5,
                    timeUnixNano: END_NS,
                    attributes: [{ key: "session.id", value: { stringValue: sessionId } }],
                  },
                ],
              },
            },
          ],
        },
      ],
    },
  ],
});

async function call(
  method: string,
  path: string,
  body?: BodyInit,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.fetch(
    new Request(`http://127.0.0.1:7317${path}`, {
      method,
      headers: { host: "127.0.0.1:7317", ...headers },
      body,
    }),
  );
}

const putConfig = (patch: unknown) =>
  call("PUT", "/api/agent-telemetry", JSON.stringify(patch), { "content-type": "application/json" });

const ledgerRows = (noteKey: string) =>
  (db.prepare(`SELECT COUNT(*) n FROM usage_ledger WHERE note_key = ?`).get(noteKey) as { n: number }).n;

/** Wait for the relay to settle, holding the loop open while its unref'd timers run. */
async function settle(): Promise<void> {
  const hold = setInterval(() => {}, 5);
  await agentOtelForwarder().drain();
  clearInterval(hold);
}

test("off by default: metrics answer and ledger as before, and nothing is forwarded", async () => {
  const status = await (await call("GET", "/api/agent-telemetry")).json();
  assert.equal(status.config.enabled, false);
  assert.equal(status.effective.source, "off");
  assert.deepEqual(status.harnesses.map((h: { mode: string }) => h.mode), ["off", "off", "extension"]);

  const res = await call("POST", "/v1/metrics", JSON.stringify(METRICS("off-sess")), {
    "content-type": "application/json",
    "x-harness-token": TOKEN,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {});
  assert.equal(ledgerRows("off-sess"), 1);
  await settle();
  assert.equal(received.length, 0);
  assert.deepEqual(await agentOtelLaunch("claude"), { env: {}, args: [] });
});

test("logs and traces need a token", async () => {
  for (const path of ["/v1/logs", "/v1/traces", "/v1/metrics"]) {
    const res = await call("POST", path, "{}", { "content-type": "application/json" });
    assert.equal(res.status, 401, path);
  }
});

test("Settings stores a header whose value never comes back out", async () => {
  const res = await putConfig({
    enabled: true,
    endpoint: SINK,
    headers: [{ name: "Authorization", value: "Bearer gw-s3cret" }],
    capture: { userPrompts: true },
  });
  assert.equal(res.status, 200);
  const status = await res.json();
  assert.deepEqual(status.headerNames, ["Authorization"]);
  assert.equal(status.effective.source, "settings");
  assert.doesNotMatch(JSON.stringify(status), /gw-s3cret/);
  assert.doesNotMatch(JSON.stringify(await (await call("GET", "/api/agent-telemetry")).json()), /gw-s3cret/);
  assert.doesNotMatch(
    JSON.stringify(db.prepare(`SELECT value FROM app_config WHERE key = 'agentTelemetry'`).get()),
    /gw-s3cret/,
  );
});

test("an invalid config is refused at the route", async () => {
  assert.equal((await putConfig({ endpoint: "ftp://nope" })).status, 400);
  assert.equal((await putConfig({ endpoint: "http://127.0.0.1:7317" })).status, 400);
  assert.equal((await putConfig({ headers: [{ name: "x-harness-token", value: "x" }] })).status, 400);
  assert.equal((await putConfig({ nonsense: true })).status, 400);
});

test("the tee forwards raw bytes with their content type, and the ledger still sees metrics", async () => {
  received.length = 0;
  const metrics = JSON.stringify(METRICS("tee-sess"));
  const res = await call("POST", "/v1/metrics", metrics, {
    "content-type": "application/json",
    "x-harness-token": TOKEN,
  });
  assert.equal(res.status, 200);
  assert.equal(ledgerRows("tee-sess"), 1);

  const protobuf = new Uint8Array([0x0a, 0x02, 0x08, 0x01]);
  const logs = await call("POST", "/v1/logs", protobuf, {
    "content-type": "application/x-protobuf",
    "x-harness-token": TOKEN,
  });
  assert.equal(logs.status, 200);
  assert.deepEqual(await logs.json(), {});

  await settle();
  const byPath = new Map(received.map((r) => [r.url, r]));
  assert.equal(byPath.get("/v1/metrics")?.body.toString(), metrics);
  assert.equal(byPath.get("/v1/metrics")?.headers["content-type"], "application/json");
  assert.deepEqual([...(byPath.get("/v1/logs")?.body ?? [])], [...protobuf]);
  assert.equal(byPath.get("/v1/logs")?.headers["content-type"], "application/x-protobuf");
  for (const r of received) {
    assert.equal(r.headers.authorization, "Bearer gw-s3cret");
    // The daemon's own credential never leaves the machine.
    assert.equal(r.headers["x-harness-token"], undefined);
  }
});

test("an upstream failure does not change the local answer", async () => {
  sinkStatus = 503;
  received.length = 0;
  const res = await call("POST", "/v1/metrics", JSON.stringify(METRICS("fail-sess")), {
    "content-type": "application/json",
    "x-harness-token": TOKEN,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {});
  assert.equal(ledgerRows("fail-sess"), 1);
  await settle();
  assert.equal(received.length, 1);
  const status = await (await call("GET", "/api/agent-telemetry")).json();
  assert.equal(status.relay.lastError, "HTTP 503");
  assert.ok(status.relay.failed >= 1);
  sinkStatus = 200;
});

test("the relay-only token forwards metrics without writing the ledger", async () => {
  received.length = 0;
  const res = await call("POST", "/v1/metrics", JSON.stringify(METRICS("relay-sess")), {
    "content-type": "application/json",
    "x-mission-otel-relay": agentOtelRelayToken(),
  });
  assert.equal(res.status, 200);
  assert.equal(ledgerRows("relay-sess"), 0);
  await settle();
  assert.equal(received.length, 1);
  const wrong = await call("POST", "/v1/logs", "{}", { "x-mission-otel-relay": "guess" });
  assert.equal(wrong.status, 401);
});

test("launches carry the relay env and -c overrides while Settings relays", async () => {
  const claude = await agentOtelLaunch("claude");
  assert.match(claude.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ?? "", /^http:\/\/127\.0\.0\.1:\d+\/v1\/logs$/);
  assert.equal(claude.env.OTEL_LOG_USER_PROMPTS, "1");
  const codex = await agentOtelLaunch("codex");
  assert.ok(codex.args.some((a) => a.includes(agentOtelRelayToken())));
  assert.ok(!codex.args.join(" ").includes(TOKEN));
  assert.deepEqual(await agentOtelLaunch("pi"), { env: {}, args: [] });
});

test("a chunked export over the cap is refused while it is read, with no declared length", async () => {
  const { MAX_OTLP_BODY_BYTES } = await import("../src/server/agent-otel/relay.ts");
  const chunk = new Uint8Array(1024 * 1024);
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent > MAX_OTLP_BODY_BYTES + chunk.byteLength) return controller.close();
      sent += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  const res = await app.fetch(
    new Request("http://127.0.0.1:7317/v1/logs", {
      method: "POST",
      headers: { host: "127.0.0.1:7317", "x-harness-token": TOKEN, "content-type": "application/json" },
      body: stream,
      // @ts-expect-error Node's fetch needs this for a streamed request body.
      duplex: "half",
    }),
  );
  assert.equal(res.status, 413);
  // It stopped reading at the cap rather than draining the whole stream first.
  assert.ok(sent <= MAX_OTLP_BODY_BYTES + 2 * chunk.byteLength);
});

test("a relay token with non-ASCII characters is refused, not thrown on", async () => {
  const sameLength = "é".repeat(agentOtelRelayToken().length);
  const res = await app.fetch(
    new Request("http://127.0.0.1:7317/v1/logs", {
      method: "POST",
      headers: { host: "127.0.0.1:7317", "x-mission-otel-relay": sameLength },
      body: "{}",
    }),
  );
  assert.equal(res.status, 401);
});

test("two spellings of one header name are refused", async () => {
  const res = await putConfig({
    headers: [
      { name: "Authorization", value: "a" },
      { name: "authorization", value: "b" },
    ],
  });
  assert.equal(res.status, 400);
});

test("a managed policy makes Settings read-only and the managed agent gets nothing", async () => {
  const plist = "/fx/Library/Managed Preferences/com.anthropic.claudecode.plist";
  setAgentOtelManagedDepsForTest(() => ({
    platform: "darwin",
    fixture: true,
    root: "/fx",
    user: null,
    readText: async () => ({ ok: false }) as never,
    stat: async (path) => (path === plist ? { mtimeMs: 1, size: 1 } : "missing"),
    run: async () =>
      stubRun({
        stdout: JSON.stringify({
          CLAUDE_CODE_ENABLE_TELEMETRY: "1",
          OTEL_METRICS_EXPORTER: "otlp",
          OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://corp-otel-staging-1.upstart.com/v1/metrics",
        }),
        stderr: "",
        code: 0,
      }),
  }));
  const status = await (await call("GET", "/api/agent-telemetry")).json();
  assert.equal(status.managed, true);
  assert.equal(status.effective.source, "mdm");
  assert.equal(status.effective.hosts.metrics, "corp-otel-staging-1.upstart.com");
  assert.equal(status.harnesses[0].mode, "managed");
  assert.equal((await putConfig({ enabled: false })).status, 409);
  assert.deepEqual(await agentOtelLaunch("claude"), { env: {}, args: [] });
  // Codex has no managed policy here, so it relays toward the managed destination.
  assert.ok((await agentOtelLaunch("codex")).args.length > 0);
  setAgentOtelManagedDepsForTest(null);
});
