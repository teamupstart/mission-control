import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentTelemetryConfigSchema,
  AgentTelemetryPatchSchema,
  agentTelemetryConfigProblem,
} from "../src/shared/agent-telemetry.ts";
import {
  claudeManagedOtelFromEnv,
  codexManagedOtelFromToml,
  parseCodexOtelToml,
  readManagedAgentOtel,
  type AgentOtelManagedDeps,
} from "../src/server/agent-otel/managed.ts";
import { resolveAgentOtelPolicy } from "../src/server/agent-otel/policy.ts";
import {
  claudeAgentOtelEnv,
  codexAgentOtelArgs,
  harnessMode,
  harnessStatuses,
} from "../src/server/agent-otel/launch.ts";
import { OtlpForwarder } from "../src/server/agent-otel/relay.ts";
import { stubRun } from "../src/server/util/exec.ts";

// The pure halves of agent telemetry: reading managed policy, resolving precedence, building
// each harness's launch input, and the relay's queue. The routes are in agent-otel-routes.

const GATEWAY = "https://corp-otel-staging-1.upstart.com";

/** The OTEL keys of the Claude Code managed profile, and only those. */
const CLAUDE_MDM_ENV = {
  CLAUDE_CODE_ENABLE_TELEMETRY: "1",
  OTEL_LOGS_EXPORTER: "otlp",
  OTEL_METRICS_EXPORTER: "otlp",
  OTEL_TRACES_EXPORTER: "otlp",
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${GATEWAY}/v1/logs`,
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${GATEWAY}/v1/metrics`,
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${GATEWAY}/v1/traces`,
  OTEL_LOG_USER_PROMPTS: "1",
  OTEL_LOG_ASSISTANT_RESPONSES: "1",
  OTEL_LOG_RAW_API_BODIES: "1",
  OTEL_LOG_TOOL_CONTENT: "1",
  OTEL_LOG_TOOL_DETAILS: "1",
};

/** The `[otel]` part of the Codex managed profile, inside unrelated config. */
const CODEX_MDM_TOML = `
model = "gpt-5"
note = """
[otel]
log_user_prompt = false
"""

[apps.something]
enabled = true

[otel]
log_user_prompt = true

[otel.exporter.otlp-http]
endpoint = "${GATEWAY}/v1/logs"
protocol = "json"

[otel.metrics_exporter.otlp-http]
endpoint = "${GATEWAY}/v1/metrics"
protocol = "json"

[otel.trace_exporter.otlp-http]
endpoint = "${GATEWAY}/v1/traces"
protocol = "json"

[shell_environment_policy]
inherit = "all"
`;

const RELAY = {
  baseUrl: "http://127.0.0.1:7317",
  harnessToken: "harness-secret-token",
  relayToken: "relay-only-token",
};

const settings = (over: Partial<ReturnType<typeof AgentTelemetryConfigSchema.parse>> = {}) =>
  AgentTelemetryConfigSchema.parse({ enabled: true, endpoint: "https://collector.example.com", ...over });

test("a Claude managed env becomes per-signal routes and capture switches", () => {
  const managed = claudeManagedOtelFromEnv("mdm", CLAUDE_MDM_ENV);
  assert.ok(managed);
  assert.equal(managed.disabled, false);
  assert.deepEqual(managed.endpoints, {
    logs: `${GATEWAY}/v1/logs`,
    metrics: `${GATEWAY}/v1/metrics`,
    traces: `${GATEWAY}/v1/traces`,
  });
  assert.ok(Object.values(managed.capture).every(Boolean));
});

test("a Claude managed env with only a generic endpoint appends OTLP's default paths", () => {
  const managed = claudeManagedOtelFromEnv("managed-settings", {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_LOGS_EXPORTER: "none",
    OTEL_EXPORTER_OTLP_ENDPOINT: `${GATEWAY}/`,
  });
  assert.deepEqual(managed?.endpoints, { logs: null, metrics: `${GATEWAY}/v1/metrics`, traces: null });
});

test("managed console exporters do not become remote OTLP routes", () => {
  for (const exporter of ["console", "prometheus", "none", "console,otlp"]) {
    const managed = claudeManagedOtelFromEnv("mdm", {
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      OTEL_METRICS_EXPORTER: exporter,
      OTEL_EXPORTER_OTLP_ENDPOINT: GATEWAY,
    });
    assert.equal(
      managed?.endpoints.metrics,
      exporter === "console,otlp" ? `${GATEWAY}/v1/metrics` : null,
    );
  }
});

test("managed gRPC routes are not reused as HTTP relay destinations", () => {
  const values = parseCodexOtelToml(`
[otel.exporter.otlp-grpc]
endpoint = "https://collector.example.com:4317"
`);
  assert.ok(values);
  const codex = codexManagedOtelFromToml("mdm", values);
  assert.equal(codex?.endpoints.logs, "https://collector.example.com:4317");
  for (const managed of [
    { claude: null, codex },
    { claude: claudeManagedOtelFromEnv("mdm", {
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      OTEL_LOGS_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.com:4317",
      OTEL_EXPORTER_OTLP_PROTOCOL: "grpc",
    }), codex: null },
  ]) {
    const policy = resolveAgentOtelPolicy({ config: settings(), hasHeaders: false, managed });
    assert.equal(policy.source, "mdm");
    assert.deepEqual(policy.upstream, { logs: null, metrics: null, traces: null });
    assert.deepEqual(claudeAgentOtelEnv(policy, RELAY), {});
    assert.deepEqual(codexAgentOtelArgs(policy, RELAY), []);
  }
});

test("a Claude managed env that turns telemetry off is managed and disabled", () => {
  const managed = claudeManagedOtelFromEnv("mdm", { CLAUDE_CODE_ENABLE_TELEMETRY: "0" });
  assert.equal(managed?.disabled, true);
  const policy = resolveAgentOtelPolicy({
    config: settings(), hasHeaders: false, managed: { claude: managed, codex: null },
  });
  assert.equal(harnessMode("claude", policy), "managed");
  assert.equal(harnessMode("codex", policy), "off");
  assert.equal(claudeManagedOtelFromEnv("mdm", {}), null);
});

test("the Codex reader reads [otel] and nothing else, past a multi-line string", () => {
  const values = parseCodexOtelToml(CODEX_MDM_TOML);
  assert.ok(values);
  assert.deepEqual([...values.keys()].every((k) => k.startsWith("otel.")), true);
  assert.equal(values.get("otel.log_user_prompt"), true);
  const managed = codexManagedOtelFromToml("mdm", values);
  assert.deepEqual(managed?.endpoints, {
    logs: `${GATEWAY}/v1/logs`,
    metrics: `${GATEWAY}/v1/metrics`,
    traces: `${GATEWAY}/v1/traces`,
  });
  assert.equal(managed?.capture.userPrompts, true);
  assert.equal(managed?.capture.toolContent, false);
});

test("an [otel] line the Codex reader cannot read fails open to no policy", () => {
  assert.equal(parseCodexOtelToml(`[otel]\nexporter = { otlp-http = { endpoint = "x" } }\n`), null);
  assert.equal(parseCodexOtelToml(`[otel\nlog_user_prompt = true\n`), null);
  // Unreadable lines OUTSIDE [otel] are not its business.
  assert.deepEqual(parseCodexOtelToml(`[rules]\nallow = [ "a", { b = 1 } ]\n`)?.size, 0);
});

/** Deps over an in-memory set of plist files, with every `plutil` call counted. */
function fakeDeps(
  files: Record<string, unknown>,
  over: Partial<AgentOtelManagedDeps> = {},
): { deps: AgentOtelManagedDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: AgentOtelManagedDeps = {
    platform: "darwin",
    fixture: false,
    root: "/fx",
    user: "ada",
    stat: async (path) => (path in files ? { mtimeMs: 1, size: 1 } : "missing"),
    readText: async () => ({ ok: false, missing: true, reason: "missing" }),
    run: async (bin, args) => {
      calls.push(`${bin} ${args.join(" ")}`);
      const path = args.at(-1)!;
      const key = args[1]!;
      const value = (files[path] as Record<string, unknown> | undefined)?.[key];
      return value === undefined
        ? stubRun({ stdout: "", stderr: "no value", code: 1 })
        : stubRun({ stdout: JSON.stringify(value), stderr: "", code: 0 });
    },
    ...over,
  };
  return { deps, calls };
}

const CLAUDE_PLIST = "/fx/Library/Managed Preferences/com.anthropic.claudecode.plist";
const CODEX_PLIST = "/fx/Library/Managed Preferences/com.openai.codex.plist";

test("both managed profiles are read on macOS", async () => {
  const { deps } = fakeDeps({
    [CLAUDE_PLIST]: { env: { ...CLAUDE_MDM_ENV, OTEL_EXPORTER_OTLP_HEADERS: "Authorization=secret" } },
    [CODEX_PLIST]: { config_toml_base64: Buffer.from(CODEX_MDM_TOML).toString("base64") },
  });
  const state = await readManagedAgentOtel(deps);
  assert.equal(state.claude?.source, "mdm");
  assert.equal(state.codex?.endpoints.traces, `${GATEWAY}/v1/traces`);
  // A header in the managed env is never read out of it.
  assert.doesNotMatch(JSON.stringify(state), /secret|Authorization/);
});

test("off macOS the reader answers none without spawning plutil", async () => {
  const { deps, calls } = fakeDeps(
    { [CLAUDE_PLIST]: { env: CLAUDE_MDM_ENV } },
    { platform: "linux" },
  );
  assert.deepEqual(await readManagedAgentOtel(deps), { claude: null, codex: null });
  assert.deepEqual(calls, []);
  assert.deepEqual(await readManagedAgentOtel(null), { claude: null, codex: null });
});

test("malformed managed input fails open to no policy", async () => {
  for (const codex of [
    { config_toml_base64: 42 },
    { config_toml_base64: Buffer.from(`[otel]\nexporter = { broken`).toString("base64") },
    { config_toml_base64: "" },
  ]) {
    const { deps } = fakeDeps({ [CLAUDE_PLIST]: { env: "not a dictionary" }, [CODEX_PLIST]: codex });
    assert.deepEqual(await readManagedAgentOtel(deps), { claude: null, codex: null });
  }
  const { deps } = fakeDeps({}, { stat: async () => { throw new Error("boom"); } });
  assert.deepEqual(await readManagedAgentOtel(deps), { claude: null, codex: null });
});

test("precedence: managed policy, then Settings, then off", () => {
  const none = { claude: null, codex: null };
  const claude = claudeManagedOtelFromEnv("mdm", CLAUDE_MDM_ENV);
  const off = resolveAgentOtelPolicy({ config: AgentTelemetryConfigSchema.parse({}), hasHeaders: false, managed: none });
  assert.equal(off.source, "off");
  assert.deepEqual(off.upstream, { logs: null, metrics: null, traces: null });

  const user = resolveAgentOtelPolicy({ config: settings({ signals: { logs: true, metrics: false, traces: true } }), hasHeaders: true, managed: none });
  assert.equal(user.source, "settings");
  assert.equal(user.useStoredHeaders, true);
  assert.deepEqual(user.upstream, {
    logs: "https://collector.example.com/v1/logs",
    metrics: null,
    traces: "https://collector.example.com/v1/traces",
  });

  const mdm = resolveAgentOtelPolicy({ config: settings(), hasHeaders: true, managed: { claude, codex: null } });
  assert.equal(mdm.source, "mdm");
  assert.equal(mdm.upstream.metrics, `${GATEWAY}/v1/metrics`);
  // The operator's credential was for their endpoint, not the managed one.
  assert.equal(mdm.useStoredHeaders, false);
  assert.equal(mdm.capture.rawApiBodies, true);

  // A credential bound for a remote plaintext endpoint is not a usable config.
  const plain = resolveAgentOtelPolicy({ config: settings({ endpoint: "http://collector.example.com" }), hasHeaders: true, managed: none });
  assert.equal(plain.source, "off");
});

test("a remote agent-telemetry destination must use HTTPS; plain HTTP is loopback-only", () => {
  const none = { claude: null, codex: null };
  const remote = AgentTelemetryConfigSchema.parse({
    enabled: true,
    endpoint: "http://collector.example.com",
    signals: { logs: true, metrics: true, traces: true },
  });
  // Without any stored header: Mission Control's own telemetry only warns here, the relay refuses.
  assert.match(agentTelemetryConfigProblem(remote, false) ?? "", /HTTPS/);
  assert.equal(resolveAgentOtelPolicy({ config: remote, hasHeaders: false, managed: none }).source, "off");
  for (const endpoint of ["http://127.0.0.1:4318", "http://localhost:4318", "http://[::1]:4318", GATEWAY]) {
    assert.equal(agentTelemetryConfigProblem({ ...remote, endpoint }, false), null, endpoint);
  }

  // A managed plaintext remote route is the agent's own business; the relay does not copy
  // other agents' telemetry onto it.
  const claude = claudeManagedOtelFromEnv("mdm", {
    ...CLAUDE_MDM_ENV,
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://collector.example.com/v1/logs",
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://collector.example.com/v1/metrics",
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:4318/v1/traces",
  });
  const mdm = resolveAgentOtelPolicy({ config: remote, hasHeaders: false, managed: { claude, codex: null } });
  assert.equal(mdm.source, "mdm");
  assert.deepEqual(mdm.upstream, { logs: null, metrics: null, traces: "http://127.0.0.1:4318/v1/traces" });
  assert.deepEqual(mdm.signals, { logs: false, metrics: false, traces: true });
});

test("the relay re-checks the destination scheme immediately before sending", async () => {
  const seen: string[] = [];
  const relay = new OtlpForwarder({
    now: () => 42,
    fetch: async (url) => {
      seen.push(String(url));
      return new Response("{}", { status: 200 });
    },
    upstream: (signal) => ({
      url: signal === "logs" ? "http://gw.example.com/v1/logs" : `http://127.0.0.1:4318/v1/${signal}`,
      headers: {},
    }),
  });
  const body = new Uint8Array([1]);
  relay.enqueue("logs", body, "application/x-protobuf");
  relay.enqueue("metrics", body, "application/x-protobuf");
  await relay.drain();
  assert.deepEqual(seen, ["http://127.0.0.1:4318/v1/metrics"]);
  assert.equal(relay.snapshot().failed, 1);
  assert.equal(relay.snapshot().lastError, "insecure destination");
});

test("signal paths preserve a gateway's base path and query", () => {
  for (const endpoint of [
    "https://collector.example.com/otel/?tenant=demo#diagnostics",
    "https://collector.example.com/otel?tenant=demo",
  ]) {
    const expected = {
      logs: "https://collector.example.com/otel/v1/logs?tenant=demo",
      metrics: "https://collector.example.com/otel/v1/metrics?tenant=demo",
      traces: "https://collector.example.com/otel/v1/traces?tenant=demo",
    };
    const policy = resolveAgentOtelPolicy({
      config: settings({ endpoint }),
      hasHeaders: false,
      managed: { claude: null, codex: null },
    });
    assert.deepEqual(policy.upstream, expected);
    const managed = claudeManagedOtelFromEnv("mdm", {
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      OTEL_LOGS_EXPORTER: "otlp",
      OTEL_METRICS_EXPORTER: "otlp",
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    });
    assert.deepEqual(managed?.endpoints, expected);
  }
});

test("Claude relays through per-signal env with the daemon token, and capture only turns on", () => {
  const policy = resolveAgentOtelPolicy({
    config: settings({ capture: { userPrompts: true, toolDetails: false, toolContent: false, assistantResponses: true, rawApiBodies: false } }),
    hasHeaders: false,
    managed: { claude: null, codex: null },
  });
  const env: Record<string, string> = claudeAgentOtelEnv(policy, RELAY);
  assert.deepEqual(env, {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:7317/v1/logs",
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_LOGS_HEADERS: "x-harness-token=harness-secret-token",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://127.0.0.1:7317/v1/metrics",
    OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_METRICS_HEADERS: "x-harness-token=harness-secret-token",
    OTEL_TRACES_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:7317/v1/traces",
    OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: "x-harness-token=harness-secret-token",
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
    OTEL_LOG_USER_PROMPTS: "1",
    OTEL_LOG_ASSISTANT_RESPONSES: "1",
  });
  // Never the generic keys the Cost switch writes into settings.json.
  assert.equal("OTEL_EXPORTER_OTLP_ENDPOINT" in env, false);
  assert.equal("OTEL_EXPORTER_OTLP_HEADERS" in env, false);
});

test("Codex relays through -c with the relay-only token, never the daemon token", () => {
  const policy = resolveAgentOtelPolicy({
    config: settings({ signals: { logs: true, metrics: true, traces: false }, capture: { userPrompts: true, toolDetails: false, toolContent: false, assistantResponses: false, rawApiBodies: false } }),
    hasHeaders: false,
    managed: { claude: null, codex: null },
  });
  const args = codexAgentOtelArgs(policy, RELAY);
  assert.deepEqual(args, [
    "-c",
    'otel.exporter={otlp-http={endpoint="http://127.0.0.1:7317/v1/logs",protocol="json",headers={"x-mission-otel-relay"="relay-only-token"}}}',
    "-c",
    'otel.metrics_exporter={otlp-http={endpoint="http://127.0.0.1:7317/v1/metrics",protocol="json",headers={"x-mission-otel-relay"="relay-only-token"}}}',
    "-c",
    "otel.log_user_prompt=true",
  ]);
  assert.doesNotMatch(args.join(" "), /harness-secret-token/);
});

test("a harness whose own managed policy configures telemetry gets nothing injected", () => {
  const claude = claudeManagedOtelFromEnv("mdm", CLAUDE_MDM_ENV);
  const policy = resolveAgentOtelPolicy({ config: settings(), hasHeaders: false, managed: { claude, codex: null } });
  assert.equal(harnessMode("claude", policy), "managed");
  assert.deepEqual(claudeAgentOtelEnv(policy, RELAY), {});
  // Codex has no managed policy of its own, so it relays to the managed destination.
  assert.equal(harnessMode("codex", policy), "relay");
  assert.equal(codexAgentOtelArgs(policy, RELAY).length > 0, true);
  assert.equal(harnessMode("pi", policy), "extension");
  const statuses = harnessStatuses(policy);
  assert.deepEqual(statuses.map((s) => [s.agent, s.mode]), [["claude", "managed"], ["codex", "relay"], ["pi", "extension"]]);
  assert.match(statuses[0]!.detail, /corp-otel-staging-1\.upstart\.com/);
  assert.doesNotMatch(JSON.stringify(statuses), /https:\/\//);
});

test("nothing is injected while the feature is off", () => {
  const policy = resolveAgentOtelPolicy({ config: AgentTelemetryConfigSchema.parse({}), hasHeaders: false, managed: { claude: null, codex: null } });
  assert.deepEqual(claudeAgentOtelEnv(policy, RELAY), {});
  assert.deepEqual(codexAgentOtelArgs(policy, RELAY), []);
});

test("header names the relay owns are refused at the schema", () => {
  for (const name of ["x-harness-token", "X-Mission-Otel-Relay", "content-type", "bad name"]) {
    assert.equal(AgentTelemetryPatchSchema.safeParse({ headers: [{ name, value: "v" }] }).success, false, name);
  }
  assert.equal(AgentTelemetryPatchSchema.safeParse({ headers: [{ name: "Authorization", value: "a\r\nb" }] }).success, false);
  assert.equal(AgentTelemetryPatchSchema.safeParse({ headers: [{ name: "Authorization", value: "Bearer x" }] }).success, true);
});

test("upstream header values must be sendable HTTP field values", () => {
  for (const value of ["a\u0000b", "a\u0001b", "a\u007fb", "a🚀b"]) {
    assert.equal(
      AgentTelemetryPatchSchema.safeParse({ headers: [{ name: "Authorization", value }] }).success,
      false,
    );
  }
  for (const value of ["Bearer valid-token", "a\tb", "aéb"]) {
    assert.equal(
      AgentTelemetryPatchSchema.safeParse({ headers: [{ name: "Authorization", value }] }).success,
      true,
    );
  }
});

// ---- the relay's queue ----

function forwarder(over: { fetch: typeof fetch; maxQueue?: number; timeoutMs?: number; maxConcurrent?: number }) {
  return new OtlpForwarder({
    now: () => 42,
    upstream: (signal) =>
      signal === "traces" ? null : { url: `https://gw.example.com/v1/${signal}`, headers: { authorization: "Bearer s3cret" } },
    ...over,
  });
}

test("the relay forwards the raw bytes with their content type, encoding and headers", async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const relay = forwarder({
    fetch: async (url, init) => {
      seen.push({ url: String(url), init: init! });
      return new Response("{}", { status: 200 });
    },
  });
  const body = new Uint8Array([0x0a, 0x01, 0xff]);
  assert.equal(relay.enqueue("logs", body, "application/x-protobuf", "gzip"), "queued");
  assert.equal(relay.enqueue("traces", body, "application/json"), "skipped");
  await relay.drain();
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, "https://gw.example.com/v1/logs");
  assert.deepEqual(seen[0]!.init.headers, {
    authorization: "Bearer s3cret",
    "content-type": "application/x-protobuf",
    "content-encoding": "gzip",
  });
  assert.equal(seen[0]!.init.body, body);
  assert.equal(seen[0]!.init.redirect, "manual");
  assert.deepEqual(relay.snapshot(), { forwarded: 1, failed: 0, dropped: 0, lastError: null, lastForwardedAt: 42 });
});

test("upstream failures are counted without a URL, header or body in the error", async () => {
  const statuses = [503, 302];
  const relay = forwarder({
    maxConcurrent: 1,
    fetch: async () => {
      const status = statuses.shift();
      if (status === undefined) {
        throw Object.assign(new TypeError("fetch failed https://gw.example.com Bearer s3cret"), {
          cause: { code: "ECONNREFUSED" },
        });
      }
      return new Response("upstream said Bearer s3cret", { status });
    },
  });
  for (let i = 0; i < 3; i += 1) relay.enqueue("metrics", new Uint8Array([1]), "application/json");
  await relay.drain();
  const stats = relay.snapshot();
  assert.equal(stats.failed, 3);
  assert.equal(stats.forwarded, 0);
  assert.equal(stats.lastError, "ECONNREFUSED");
  assert.doesNotMatch(JSON.stringify(stats), /s3cret|gw\.example/);
});

test("a slow upstream times out and a full queue drops rather than waits", async () => {
  const relay = forwarder({
    maxQueue: 1,
    timeoutMs: 20,
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
  });
  const results = Array.from({ length: 8 }, () => relay.enqueue("logs", new Uint8Array([1]), "application/json"));
  // Four in flight, one queued, the rest dropped. None of it waited.
  assert.deepEqual(results.filter((r) => r === "queued").length, 5);
  assert.equal(results.filter((r) => r === "dropped").length, 3);
  // The relay's timers are unref'd so they never hold the daemon open; this one holds the test.
  const hold = setInterval(() => {}, 5);
  await relay.drain();
  clearInterval(hold);
  const stats = relay.snapshot();
  assert.equal(stats.failed, 5);
  assert.equal(stats.dropped, 3);
  assert.equal(stats.lastError, "timeout");
});
