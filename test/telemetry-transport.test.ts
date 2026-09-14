import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The transport half: what an endpoint may be, where a credential may travel, and every branch
// of the delivery state machine.
//
// No sockets. The exporter takes its `fetch` as an injected dependency, so a fixture can answer
// with an exact status, an exact `Retry-After`, or a redirect - and can INSPECT the headers it
// was sent, which is the only way to prove a credential did not follow a redirect.

const home = mkdtempSync(join(tmpdir(), "mission-telemetry-transport-"));
process.env.HARNESS_HOME = join(home, "state");

const { closeDb, openDb } = await import("../src/server/db.ts");
const { captureTelemetry } = await import("../src/server/telemetry/capture.ts");
const {
  installProductIngestForTesting,
  setTelemetryConfig,
  telemetryStatus,
} = await import("../src/server/telemetry/config.ts");
const { runProjectionPass } = await import("../src/server/telemetry/projection.ts");
const { runDeliveryPass, backoffMs } = await import("../src/server/telemetry/delivery.ts");
const { registerBuiltinTelemetry, telemetryCycle } = await import(
  "../src/server/telemetry/service.ts"
);
const { telemetryHealth } = await import("../src/server/telemetry/health.ts");
const { credentialSurvivesRedirect, safeEndpointLabel, signalUrl, validateEndpoint } =
  await import("../src/server/telemetry/endpoint.ts");
const { DAEMON_STARTED_EVENT } = await import("../src/shared/telemetry-catalog.ts");
const { TELEMETRY_LIMITS } = await import("../src/shared/telemetry.ts");

registerBuiltinTelemetry();

after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

const TELEMETRY_TABLES = [
  "telemetry_journal",
  "telemetry_source_identities",
  "telemetry_projection_state",
  "telemetry_series",
  "telemetry_batches",
  "telemetry_delivery",
  "telemetry_destinations",
  "telemetry_secrets",
  "telemetry_gaps",
  "telemetry_contexts",
  "telemetry_resources",
];

beforeEach(() => {
  const d = openDb();
  for (const table of TELEMETRY_TABLES) d.exec(`DELETE FROM ${table}`);
  d.exec("DELETE FROM app_config");
  installProductIngestForTesting(null);
});

// ---- endpoint rules ----

test("a credential-bearing export to a remote plaintext endpoint is refused", async () => {
  // The sharp rule: a bearer token on a plaintext connection to anywhere but this machine is a
  // credential on the wire. Refused at configuration AND again before transmission.
  const check = validateEndpoint("http://collector.example.com:4318", { hasCredential: true });
  assert.equal(check.ok, false);
  assert.equal(check.problem, "credential_requires_https");
});

test("a credential-bearing export to a loopback Collector over plain HTTP is supported", async () => {
  // Every local Collector is exactly this, and requiring TLS here would make the documented
  // reference stack unusable.
  for (const endpoint of ["http://127.0.0.1:4318", "http://localhost:4318", "http://[::1]:4318"]) {
    const check = validateEndpoint(endpoint, { hasCredential: true });
    assert.equal(check.ok, true, endpoint);
    assert.equal(check.loopback, true, endpoint);
  }
});

test("HTTPS validates normally, with or without a credential", async () => {
  assert.equal(validateEndpoint("https://otlp.example.com", { hasCredential: true }).ok, true);
  assert.equal(validateEndpoint("https://otlp.example.com", { hasCredential: false }).ok, true);
});

test("a remote plaintext endpoint with no credential is allowed but flagged", async () => {
  const check = validateEndpoint("http://collector.example.com:4318", { hasCredential: false });
  assert.equal(check.ok, true);
  assert.match(check.warning ?? "", /HTTPS is strongly preferred/);
});

test("an endpoint that carries its own credentials in the URL is refused", async () => {
  // A URL credential is logged by every proxy on the way and copied into any diagnostic that
  // prints the endpoint. The header is the supported carrier.
  const check = validateEndpoint("https://user:secret@otlp.example.com", { hasCredential: false });
  assert.equal(check.ok, false);
  assert.equal(check.problem, "has_credentials_in_url");
});

test("only http and https are accepted", async () => {
  assert.equal(validateEndpoint("grpc://otlp.example.com", { hasCredential: false }).problem, "unsupported_scheme");
  assert.equal(validateEndpoint("not a url", { hasCredential: false }).problem, "unparseable");
  assert.equal(validateEndpoint("", { hasCredential: false }).problem, "empty");
});

test("per-signal URLs are resolved once from the base", async () => {
  assert.equal(signalUrl("http://127.0.0.1:4318", "metrics"), "http://127.0.0.1:4318/v1/metrics");
  assert.equal(signalUrl("http://127.0.0.1:4318/", "traces"), "http://127.0.0.1:4318/v1/traces");
});

test("an endpoint label is safe to log", async () => {
  // Query strings are dropped wholesale rather than filtered: "which parameters are secret" is
  // not a question worth being wrong about once.
  assert.equal(
    safeEndpointLabel("https://otlp.example.com/v1/metrics?token=abcdef"),
    "https://otlp.example.com/v1/metrics",
  );
});

test("a cross-destination redirect cannot carry a credential", async () => {
  assert.equal(
    credentialSurvivesRedirect("https://a.example.com/v1/metrics", "https://a.example.com/ingest"),
    true,
  );
  assert.equal(
    credentialSurvivesRedirect("https://a.example.com/v1/metrics", "https://b.example.com/ingest"),
    false,
  );
  assert.equal(
    credentialSurvivesRedirect("https://a.example.com/v1/metrics", "http://a.example.com/ingest"),
    false,
    "a downgrade to remote plaintext is a different destination for this purpose",
  );
  assert.equal(
    credentialSurvivesRedirect("http://127.0.0.1:4318/v1/metrics", "http://127.0.0.1:4318/ingest"),
    true,
  );
});

// ---- configuration refusals ----

test("saving a credential with a remote plaintext endpoint is refused as one unit", async () => {
  // Validated against the credential that WILL be in place after the patch, not the one that
  // is now - otherwise turning HTTPS off in the same write that adds a token would slip past.
  const refused = setTelemetryConfig({
    enabled: true,
    user: { enabled: true, endpoint: "http://collector.example.com:4318" },
    userCredential: "secret-token",
  });
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.error, /HTTPS/);
});

test("exporting into this daemon's own cost receiver is refused", async () => {
  // `/v1/metrics` here is the INBOUND Claude Code cost ingest. Pointing the outbound exporter
  // at it would feed telemetry back into the cost ledger.
  const { PORT } = await import("../src/server/config.ts");
  const refused = setTelemetryConfig({
    enabled: true,
    user: { enabled: true, endpoint: `http://127.0.0.1:${PORT}` },
  });
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.error, /cost ingest/i);
});

test("a stored credential is never returned by a read path", async () => {
  const applied = setTelemetryConfig({
    enabled: true,
    user: { enabled: true, endpoint: "https://otlp.example.com" },
    userCredential: "super-secret-token",
  });
  assert.equal(applied.ok, true);

  const status = telemetryStatus();
  assert.equal(status.userCredentialConfigured, true);
  assert.ok(!JSON.stringify(status).includes("super-secret-token"));

  // Nor by the settings surface: the telemetry entry has no backup domain at all.
  const { APP_CONFIG_ENTRIES } = await import("../src/shared/app-config-entries.ts");
  assert.equal(APP_CONFIG_ENTRIES.telemetry.backupDomain, null);
  const stored = openDb()
    .prepare(`SELECT value FROM app_config WHERE key = 'telemetry'`)
    .get() as { value: string };
  assert.ok(!stored.value.includes("super-secret-token"));
});

// ---- delivery ----

interface Attempt {
  url: string;
  headers: Record<string, string>;
}

function fixture(responses: Array<() => Response>): {
  fetch: typeof globalThis.fetch;
  attempts: Attempt[];
} {
  const attempts: Attempt[] = [];
  let index = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    attempts.push({ url: String(input), headers });
    const make = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return make();
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fetchImpl, attempts };
}

function ok(): Response {
  return new Response(new Uint8Array(0), { status: 200 });
}

function status(code: number, headers: Record<string, string> = {}): Response {
  return new Response(new Uint8Array(0), { status: code, headers });
}

function enableUser(endpoint = "https://otlp.example.com", credential?: string) {
  const applied = setTelemetryConfig({
    enabled: true,
    user: { enabled: true, endpoint },
    ...(credential === undefined ? {} : { userCredential: credential }),
  });
  assert.equal(applied.ok, true, applied.ok ? "" : applied.error);
}

function captureAndProject(id: string, now: number): void {
  const result = captureTelemetry({
    event: DAEMON_STARTED_EVENT,
    source: { kind: "mission.daemon", id, revision: 1 },
    facts: { startup_ms: 100, schema_upgraded: false, launch_mode: "daemon" },
    now,
  });
  assert.equal(result.kind, "accepted");
  runProjectionPass(now + 1);
}

function deliveryRows(): Array<{ batch_id: string; state: string; attempts: number; rejected_items: number }> {
  return openDb()
    .prepare(`SELECT batch_id, state, attempts, rejected_items FROM telemetry_delivery`)
    .all() as unknown as Array<{
    batch_id: string;
    state: string;
    attempts: number;
    rejected_items: number;
  }>;
}

test("an accepted batch is marked accepted and its payload released", async () => {
  enableUser();
  captureAndProject("boot-1", 1_000);
  const f = fixture([ok]);
  await runDeliveryPass({ fetch: f.fetch, now: () => 2_000 });

  assert.ok(f.attempts.length >= 1);
  assert.ok(f.attempts[0]!.url.endsWith("/v1/metrics"));
  assert.equal(f.attempts[0]!.headers["content-type"], "application/x-protobuf");
  for (const row of deliveryRows()) assert.equal(row.state, "accepted");
  // Holding a second copy of every delivered batch is how a bounded budget stops being bounded.
  const remaining = openDb().prepare(`SELECT COUNT(*) AS n FROM telemetry_batches`).get() as { n: number };
  assert.equal(remaining.n, 0);
});

test("a server error retries the same immutable batch rather than rebuilding it", async () => {
  enableUser();
  captureAndProject("boot-1", 1_000);
  const before = openDb().prepare(`SELECT id, digest FROM telemetry_batches`).all() as unknown as Array<{
    id: string;
    digest: string;
  }>;

  const f = fixture([() => status(503)]);
  await runDeliveryPass({ fetch: f.fetch, now: () => 2_000 });

  const rows = deliveryRows();
  assert.ok(rows.some((r) => r.state === "retry"));
  const after = openDb().prepare(`SELECT id, digest FROM telemetry_batches`).all() as unknown as Array<{
    id: string;
    digest: string;
  }>;
  assert.deepEqual(after, before, "the retried payload is byte-identical, not re-aggregated");
});

test("a network failure is retryable and is not assumed to have been unaccepted", async () => {
  enableUser();
  captureAndProject("boot-1", 1_000);
  const fetchImpl = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof globalThis.fetch;

  await runDeliveryPass({ fetch: fetchImpl, now: () => 2_000 });
  assert.ok(deliveryRows().some((r) => r.state === "retry"));
  // The batch is retained, so the same identity is what gets re-sent. A server that already
  // took it sees a duplicate it can recognize, rather than a differently-shaped second batch.
  const remaining = openDb().prepare(`SELECT COUNT(*) AS n FROM telemetry_batches`).get() as { n: number };
  assert.ok(remaining.n > 0);
});

test("a 401 pauses the destination visibly instead of hammering it", async () => {
  enableUser("https://otlp.example.com", "token");
  captureAndProject("boot-1", 1_000);
  const f = fixture([() => status(401)]);
  await runDeliveryPass({ fetch: f.fetch, now: () => 2_000 });

  const health = telemetryHealth(2_100);
  const user = health.profiles.find((p) => p.profile === "user")!;
  assert.equal(user.pausedReason, "auth");

  // And a second pass sends nothing at all while it is paused.
  const second = fixture([ok]);
  await runDeliveryPass({ fetch: second.fetch, now: () => 3_000 });
  assert.equal(second.attempts.length, 0);
});

test("a 404 pauses the destination as a configuration problem, not an auth one", async () => {
  enableUser();
  captureAndProject("boot-1", 1_000);
  const f = fixture([() => status(404)]);
  await runDeliveryPass({ fetch: f.fetch, now: () => 2_000 });
  assert.equal(
    telemetryHealth(2_100).profiles.find((p) => p.profile === "user")!.pausedReason,
    "configuration",
  );
});

test("a permanent payload rejection quarantines one batch and keeps the destination open", async () => {
  enableUser();
  captureAndProject("boot-1", 1_000);
  const f = fixture([() => status(400)]);
  await runDeliveryPass({ fetch: f.fetch, now: () => 2_000 });

  assert.ok(deliveryRows().some((r) => r.state === "rejected"));
  const health = telemetryHealth(2_100);
  assert.equal(health.profiles.find((p) => p.profile === "user")!.pausedReason, null);
  assert.ok(health.gaps.some((g) => g.kind === "permanently_rejected"));
});

test("Retry-After is honoured in seconds", async () => {
  enableUser();
  captureAndProject("boot-1", 1_000);
  const f = fixture([() => status(429, { "retry-after": "12" })]);
  await runDeliveryPass({ fetch: f.fetch, now: () => 2_000 });

  const row = openDb()
    .prepare(`SELECT next_attempt_at, state FROM telemetry_delivery LIMIT 1`)
    .get() as { next_attempt_at: number; state: string };
  assert.equal(row.state, "retry");
  assert.equal(row.next_attempt_at, 2_000 + 12_000);
});

test("backoff is bounded, jittered and never below the floor", async () => {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    for (const random of [() => 0, () => 0.5, () => 1]) {
      const delay = backoffMs(attempt, random);
      assert.ok(delay >= TELEMETRY_LIMITS.retryMinMs, `attempt ${attempt}`);
      assert.ok(delay <= TELEMETRY_LIMITS.retryMaxMs * 1.25, `attempt ${attempt}`);
    }
  }
});

test("a partial success records the refused items without re-sending the accepted ones", async () => {
  // Retrying the whole batch would amplify the half that already landed. The accounting is the
  // difference between correct numbers and a duplication bug.
  enableUser();
  captureAndProject("boot-1", 1_000);

  const { ProtobufMetricsSerializer } = await import("@opentelemetry/otlp-transformer");
  void ProtobufMetricsSerializer;
  // A Collector reporting a partial success returns a body; an empty one means full success.
  // Encode one by hand through the same public serializer path the exporter reads with.
  const body = Buffer.from([0x0a, 0x04, 0x08, 0x02, 0x12, 0x00]); // partialSuccess{rejected=2}
  const f = fixture([() => new Response(body, { status: 200 })]);
  await runDeliveryPass({ fetch: f.fetch, now: () => 2_000 });

  const rows = deliveryRows();
  assert.ok(rows.every((r) => r.state === "accepted"), "a partial success is not a retry");
  assert.ok(
    telemetryHealth(2_100).gaps.some((g) => g.kind === "permanently_rejected"),
    "the refused items are visible loss",
  );
});

test("a credential does not follow a redirect to another host", async () => {
  enableUser("https://otlp.example.com", "super-secret-token");
  captureAndProject("boot-1", 1_000);

  const f = fixture([
    () => status(307, { location: "https://elsewhere.example.com/v1/metrics" }),
    ok,
  ]);
  await runDeliveryPass({ fetch: f.fetch, now: () => 2_000 });

  assert.equal(f.attempts.length >= 2, true);
  assert.equal(f.attempts[0]!.headers.authorization, "super-secret-token");
  assert.equal(
    f.attempts[1]!.headers.authorization,
    undefined,
    "a redirect is not authorization to hand a token to a destination the operator never configured",
  );
});

test("a credential follows a same-origin redirect", async () => {
  enableUser("https://otlp.example.com", "super-secret-token");
  captureAndProject("boot-1", 1_000);

  const f = fixture([() => status(308, { location: "https://otlp.example.com/ingest" }), ok]);
  await runDeliveryPass({ fetch: f.fetch, now: () => 2_000 });

  assert.equal(f.attempts[1]!.headers.authorization, "super-secret-token");
});

test("a batch built for a previous endpoint is never redirected to the new one", async () => {
  enableUser("https://one.example.com");
  captureAndProject("boot-1", 1_000);
  setTelemetryConfig({ user: { endpoint: "https://two.example.com" } });

  const f = fixture([ok]);
  await runDeliveryPass({ fetch: f.fetch, now: () => 2_000 });

  assert.equal(f.attempts.length, 0, "nothing was sent to the new endpoint");
  assert.ok(deliveryRows().some((r) => r.state === "rejected"));
  assert.ok(
    telemetryHealth(2_100).gaps.some((g) => g.kind === "permanently_rejected"),
    "the operator can see that a queue was left behind",
  );
});

test("the probe's exported span covers when it ran, not a window before it started", async () => {
  // The defect: `occurredAt` was read at the top of `runTelemetryProbe`, before the request.
  // The span is reconstructed as [occurredAt - duration, occurredAt], so the whole thing landed
  // BEFORE the probe began, offset by the full round trip - up to the 10s timeout for an
  // unreachable endpoint, which is the case an operator is most likely to be diagnosing.
  const { runTelemetryProbe } = await import("../src/server/telemetry/diagnostics.ts");
  enableUser();

  // A clock that advances 400ms across the request, so a stale stamp is unmistakable.
  const START = 1_000_000;
  const LATENCY = 400;
  let reads = 0;
  const clock = () => (reads++ === 0 ? START : START + LATENCY);

  const result = await runTelemetryProbe("user", { fetch: fixture([ok]).fetch, now: clock });
  assert.equal(result.outcome, "accepted");
  assert.equal(result.latencyMs, LATENCY);

  runProjectionPass(START + LATENCY + 1);
  const row = openDb()
    .prepare(`SELECT payload_json FROM telemetry_batches WHERE profile='user' AND signal='traces'`)
    .get() as { payload_json: string };
  const payload = JSON.parse(row.payload_json) as {
    spans: Array<{ name: string; startTimeMs: number; endTimeMs: number }>;
  };
  const span = payload.spans.find((sp) => sp.name === "mission.telemetry.probe");
  assert.ok(span);

  assert.equal(span!.endTimeMs, START + LATENCY, "the span ends when the probe finished");
  assert.equal(span!.startTimeMs, START, "and starts when it began, not a round trip earlier");
});

// ---- single-flight ----

test("two concurrent cycles run as one, so a destination never sees two requests at once", async () => {
  // The regression for a real defect: `POST /api/telemetry/drain` used to call the underlying
  // `runTelemetryCycle` directly, while the only single-flight guard lived in a closure inside
  // `startTelemetry` that the route could not reach. A drain landing on the same tick as the
  // thirty-second cadence started a second, independent delivery pass against the same
  // destination. Per-batch leasing stops the two taking the same BATCH; nothing stopped two
  // concurrent OTLP requests to one endpoint, which is what `maxInFlightPerDestination: 1`
  // promises. Both callers now go through `telemetryCycle`.
  enableUser();
  captureAndProject("boot-1", 1_000);

  let inFlight = 0;
  let peak = 0;
  const fetchImpl = (async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 25));
    inFlight -= 1;
    return ok();
  }) as unknown as typeof globalThis.fetch;

  const first = telemetryCycle({ fetch: fetchImpl, now: () => 2_000 });
  const second = telemetryCycle({ fetch: fetchImpl, now: () => 2_000 });
  assert.equal(
    first,
    second,
    "the second caller joins the running cycle rather than starting another",
  );

  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b, "both callers get the real result of the work that actually ran");
  assert.equal(peak, 1, "never two OTLP requests in flight for one destination at once");
  assert.ok(a.accepted > 0, "and the single cycle did deliver");
});

test("a cycle that has finished does not block the next one", async () => {
  // The other half of single-flight: the guard must release. A latch that never cleared would
  // turn the first drain into the only drain this daemon ever performs.
  enableUser();
  captureAndProject("boot-1", 1_000);
  const first = fixture([ok]);
  await telemetryCycle({ fetch: first.fetch, now: () => 2_000 });

  captureAndProject("boot-2", 3_000);
  const second = fixture([ok]);
  const result = await telemetryCycle({ fetch: second.fetch, now: () => 4_000 });
  assert.ok(result.accepted > 0, "a later cycle still runs");
  assert.ok(second.attempts.length > 0);
});

// ---- two destinations ----

test("one destination being offline does not stop the other", async () => {
  // The product audience is `unavailable` in every shipped build, so the only honest way to
  // exercise two independent queues is an isolated local receiver installed through the
  // test-only seam. What is being proved is the independence, not the enrollment.
  installProductIngestForTesting("isolated-local-receiver");
  const applied = setTelemetryConfig({
    enabled: true,
    user: { enabled: true, endpoint: "https://healthy.example.com" },
    product: { enabled: true, endpoint: "https://broken.example.com" },
  });
  assert.equal(applied.ok, true, applied.ok ? "" : applied.error);

  captureAndProject("boot-1", 1_000);

  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    if (url.includes("broken")) return status(503);
    return ok();
  }) as unknown as typeof globalThis.fetch;

  await runDeliveryPass({ fetch: fetchImpl, now: () => 2_000 });

  assert.ok(seen.some((u) => u.includes("healthy")), "the healthy destination was attempted");
  assert.ok(seen.some((u) => u.includes("broken")), "the unhealthy one was attempted too");

  const health = telemetryHealth(2_100);
  const user = health.profiles.find((p) => p.profile === "user")!;
  const product = health.profiles.find((p) => p.profile === "product")!;
  assert.ok(user.accepted > 0, "the healthy destination drained");
  assert.ok(product.retrying > 0, "the unhealthy one is retrying, on its own queue");
  assert.equal(user.retrying, 0, "one destination's failure is not the other's");
});

test("two audiences get unrelated correlation identifiers for the same fact", async () => {
  // Different audiences use different keys, so their exported identifiers are not trivially
  // joinable by anyone holding both.
  installProductIngestForTesting("isolated-local-receiver");
  setTelemetryConfig({
    enabled: true,
    user: { enabled: true, endpoint: "https://one.example.com" },
    product: { enabled: true, endpoint: "https://two.example.com" },
  });
  captureAndProject("boot-1", 1_000);

  const rows = openDb()
    .prepare(`SELECT profile, payload_json FROM telemetry_batches WHERE signal = 'traces'`)
    .all() as unknown as Array<{ profile: string; payload_json: string }>;
  assert.equal(rows.length, 2, "one traces batch per audience");

  const traceIds = rows.map((r) => {
    const payload = JSON.parse(r.payload_json) as { spans: Array<{ traceId: string }> };
    return payload.spans[0]!.traceId;
  });
  assert.equal(traceIds[0]!.length, 32);
  assert.notEqual(traceIds[0], traceIds[1]);
});
