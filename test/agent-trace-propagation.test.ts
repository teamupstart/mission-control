import { after, afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// W3C trace context from Mission Control into the agents its SDK runtime launches.
//
// The claim is a join, so the oracle is the exported span rather than the helper that built
// the header: the `TRACEPARENT` a launch carries must name the trace and span ids that
// `mission.session.start` is exported under to the organization's Product analytics lane, or
// nothing in the backend connects the agent's spans to the session. And because device
// management owns where the agents' telemetry goes, the launch carries nothing else - no
// `OTEL_*` exporter variable and no `-c otel.*` override.

const home = mkdtempSync(join(tmpdir(), "mission-agent-trace-"));
process.env.HARNESS_HOME = join(home, "state");
mkdirSync(join(home, "agent-state"), { recursive: true });

const { closeDb, openDb } = await import("../src/server/db.ts");
const { getTelemetryConfig, setTelemetryConfig } = await import("../src/server/telemetry/config.ts");
const { runProjectionPass } = await import("../src/server/telemetry/projection.ts");
const { registerBuiltinTelemetry } = await import("../src/server/telemetry/service.ts");
const { recheckOrganization } = await import("../src/server/telemetry/organization.ts");
const { defaultOrganizationDetectionDeps, refreshOrganization } = await import(
  "../src/server/environment/organization.ts"
);
const { attachSessionTelemetry, resetSessionTelemetryForTesting } = await import(
  "../src/server/telemetry/sessions.ts"
);
const { sessionTraceContext, sessionTraceIds } = await import("../src/server/telemetry/session-trace.ts");
const { formatTraceparent, withAgentTraceContext } = await import("../src/server/agent-trace-context.ts");
const { claudeSdkSpec } = await import("../src/server/harness/claude/sdk.ts");
const { codexSdkSpec } = await import("../src/server/harness/codex/sdk.ts");
const { codexAppServerEnv } = await import("../src/server/harness/codex/sdk-deps.ts");
const { HARNESSES } = await import("../src/server/harness/index.ts");
const { Registry } = await import("../src/server/registry.ts");
const { SdkSupervisor } = await import("../src/server/sdk/supervisor.ts");
const { upsertSdkSession } = await import("../src/server/sdk/store.ts");
import type { TracesBatchPayload } from "../src/server/telemetry/projection.ts";
import type { ClaudeSdkDeps, ClaudeSdkQuery, ClaudeSdkQueryOptions } from "../src/server/harness/claude/sdk-types.ts";
import type { SdkLaunchOptions, SdkSessionHandle } from "../src/server/harness/types.ts";

type DetectionDeps = import("../src/server/environment/organization.ts").OrganizationDetectionDeps;

registerBuiltinTelemetry();

const GATEWAY = "http://127.0.0.1:4999";
const W3C = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/;

const TABLES = [
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

function detection(forced: boolean): DetectionDeps {
  return {
    ...defaultOrganizationDetectionDeps(),
    env: forced
      ? { MISSION_ORGANIZATION: "upstart", MISSION_ORGANIZATION_ENDPOINT: GATEWAY }
      : { MISSION_ORGANIZATION: "none" },
    warn: () => {},
  };
}

/** Upstart on a loopback gateway, applied the way a daemon start applies it. */
async function manage(): Promise<void> {
  const outcome = await recheckOrganization(detection(true), 1_000);
  assert.ok(outcome.kind === "applied", JSON.stringify(outcome));
}

beforeEach(async () => {
  const d = openDb();
  for (const table of TABLES) d.exec(`DELETE FROM ${table}`);
  d.exec("DELETE FROM app_config");
  d.exec("DELETE FROM sdk_sessions; DELETE FROM tasks;");
  resetSessionTelemetryForTesting();
  await refreshOrganization(detection(false));
});

afterEach(async () => {
  await refreshOrganization(detection(false));
});

after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

/** The Registry's event stream, reduced to the two methods the session observer reads. */
class FakeHost {
  private listeners: Array<(e: never) => void> = [];
  subscribe(fn: (e: never) => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }
  getTask(): undefined {
    return undefined;
  }
  emit(event: Record<string, unknown>): void {
    for (const listener of this.listeners.slice()) listener(event as never);
  }
}

function sdkSession(id: string): Record<string, unknown> {
  return {
    id,
    agent: "claude",
    runtime: "sdk",
    name: "work",
    nameSource: "task",
    state: "working",
    cwd: "/tmp/checkout",
    gitBranch: null,
    gitRoot: null,
    repoRoot: null,
    pid: null,
    tty: null,
    permissionMode: null,
    terminals: [],
    agentSessionId: null,
    transcriptPath: null,
    meta: null,
    pendingEffort: null,
  };
}

function exportedSpans(profile: string): TracesBatchPayload["spans"] {
  const rows = openDb()
    .prepare(`SELECT payload_json FROM telemetry_batches WHERE profile = ? AND signal = 'traces'`)
    .all(profile) as Array<{ payload_json: string }>;
  return rows.flatMap((row) => (JSON.parse(row.payload_json) as TracesBatchPayload).spans);
}

function launchOpts(over: Partial<SdkLaunchOptions> = {}): SdkLaunchOptions {
  return {
    cwd: "/wt/one",
    stateHome: join(home, "agent-state"),
    prompt: "",
    model: null,
    effort: null,
    permissionMode: null,
    mcp: null,
    extraDirs: [],
    standingInstructions: "",
    standingInstructionsPrompt: "",
    resume: null,
    ...over,
  };
}

const PARENT = { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" };

/** Every key that would compete with the machine's own telemetry routing. */
function telemetryRoutingKeys(env: Record<string, string | undefined>): string[] {
  return Object.keys(env).filter((key) => key.startsWith("OTEL_") || key === "CLAUDE_CODE_PROPAGATE_TRACEPARENT");
}

// ---- the carrier ----

test("a traceparent is version 00, sampled, and refuses ids W3C does not allow", () => {
  assert.deepEqual(formatTraceparent("4bf92f3577b34da6a3ce929d0e0e4736", "00f067aa0ba902b7"), PARENT);
  assert.equal(formatTraceparent("0".repeat(32), "00f067aa0ba902b7"), null);
  assert.equal(formatTraceparent("4bf92f3577b34da6a3ce929d0e0e4736", "0".repeat(16)), null);
  assert.equal(formatTraceparent("4BF92F3577B34DA6A3CE929D0E0E4736", "00f067aa0ba902b7"), null);
  assert.equal(formatTraceparent("4bf92f3577b34da6", "00f067aa0ba902b7"), null);
});

test("the launch environment drops an inherited trace context and adds only TRACEPARENT", () => {
  const inherited = {
    PATH: "/usr/bin",
    TRACEPARENT: "00-11111111111111111111111111111111-2222222222222222-01",
    TRACESTATE: "vendor=ambient",
  };
  // The daemon's own context belongs to whatever started the daemon, never to a session.
  assert.deepEqual(withAgentTraceContext(inherited, null), { PATH: "/usr/bin" });
  assert.deepEqual(withAgentTraceContext(inherited, PARENT), { PATH: "/usr/bin", TRACEPARENT: PARENT.traceparent });
  assert.equal("TRACEPARENT" in inherited, true, "the input is not mutated");
});

// ---- which context a session gets ----

test("no trace context while collection is off, or with no organization's lane exporting", async () => {
  assert.equal(sessionTraceContext("sdk-off"), null, "collection off");

  assert.equal(setTelemetryConfig({ enabled: true }).ok, true);
  assert.equal(sessionTraceContext("sdk-local"), null, "local-only collection exports nothing to join");

  assert.equal(
    setTelemetryConfig({ product: { enabled: true, endpoint: "https://collector.example.com" } }).ok,
    true,
  );
  assert.equal(sessionTraceContext("sdk-unmanaged"), null, "a product lane no organization manages is not the corporate lane");

  await manage();
  assert.ok(sessionTraceContext("sdk-managed"), "the managed lane exports");

  assert.equal(setTelemetryConfig({ enabled: false }).ok, true);
  assert.equal(sessionTraceContext("sdk-managed"), null, "collection switched off again");
});

test("the TRACEPARENT names the exported ids of that session's own start span", async () => {
  await manage();
  assert.equal(getTelemetryConfig().enabled, true);
  const id = "sdk-1700000000000-abc";
  const context = sessionTraceContext(id);
  assert.ok(context);
  const match = W3C.exec(context.traceparent);
  assert.ok(match, context.traceparent);

  // Launch first, then publish: the order the supervisor actually runs in.
  const host = new FakeHost();
  const detach = attachSessionTelemetry(host as never);
  host.emit({ type: "session_upsert", session: sdkSession(id) });
  detach();
  runProjectionPass();

  const start = exportedSpans("product").find((span) => span.name === "mission.session.start");
  assert.ok(start, "the session start span was exported to the managed lane");
  assert.equal(start.traceId, match[1]);
  assert.equal(start.spanId, match[2]);
  assert.equal(start.parentSpanId, null, "the session span is the root the agent joins");

  // Another audience exports the same span under unrelated ids, so the header joins one only.
  assert.notEqual(sessionTraceIds(id).traceId, match[1], "raw ids never leave the daemon");
  const local = exportedSpans("local").find((span) => span.name === "mission.session.start");
  if (local) assert.notEqual(local.traceId, match[1]);

  // Derived, so a restored process for the same session gets the same parent.
  assert.deepEqual(sessionTraceContext(id), context);
  assert.notDeepEqual(sessionTraceContext("sdk-another"), context);
});

// ---- what each adapter hands its agent ----

test("Claude's SDK launch carries the context in env and no telemetry routing key", async () => {
  let options: ClaudeSdkQueryOptions | null = null;
  const deps: ClaudeSdkDeps = {
    executable: async () => "/fake/bin/claude",
    env: () => ({ PATH: "/usr/bin", TRACEPARENT: "00-11111111111111111111111111111111-2222222222222222-01" }),
    query: async ({ options: given }) => {
      options = given;
      return {
        [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
        interrupt: async () => {},
      } as unknown as ClaudeSdkQuery;
    },
  };

  await claudeSdkSpec(deps).launch(launchOpts({ traceContext: PARENT }));
  const withContext = (options as ClaudeSdkQueryOptions | null)?.env ?? {};
  assert.equal(withContext.TRACEPARENT, PARENT.traceparent);
  assert.equal("TRACESTATE" in withContext, false);
  assert.deepEqual(telemetryRoutingKeys(withContext), []);

  await claudeSdkSpec(deps).launch(launchOpts());
  const without = (options as ClaudeSdkQueryOptions | null)?.env ?? {};
  assert.equal("TRACEPARENT" in without, false, "an inherited context never reaches the session");
  assert.deepEqual(telemetryRoutingKeys(without), []);
});

test("Codex's app-server gets the context in env and no -c otel override", async () => {
  const seen: Array<{ args: readonly string[]; traceContext: unknown }> = [];
  const spec = codexSdkSpec({
    connect: async (args, _cwd, _stateHome, traceContext) => {
      seen.push({ args, traceContext });
      // Refuse the handshake: what matters here is what the connection was opened with.
      throw new Error("scripted: no server");
    },
  });
  await assert.rejects(spec.launch(launchOpts({ traceContext: PARENT })));
  await assert.rejects(spec.launch(launchOpts()));
  assert.deepEqual(seen.map((s) => s.traceContext), [PARENT, null]);
  for (const { args } of seen) {
    assert.equal(args.some((arg) => /^otel[.]/.test(arg) || arg.includes("otel.")), false, args.join(" "));
  }

  const base = {
    PATH: "/usr/bin",
    TRACEPARENT: "00-11111111111111111111111111111111-2222222222222222-01",
    TRACESTATE: "vendor=ambient",
  };
  const env = codexAppServerEnv(base, "/wt/one", join(home, "agent-state"), PARENT);
  assert.equal(env.TRACEPARENT, PARENT.traceparent);
  assert.equal("TRACESTATE" in env, false);
  assert.deepEqual(telemetryRoutingKeys(env), []);
  const none = codexAppServerEnv(base, "/wt/one", join(home, "agent-state"), null);
  assert.equal("TRACEPARENT" in none, false);
});

// ---- the supervisor decides it, for a new launch and a restored one ----

/** A driver that never emits and stops on request. */
function idleHandle(): SdkSessionHandle {
  let release: (() => void) | null = null;
  return {
    events: {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<never>>((resolve) => {
          release = () => resolve({ done: true, value: undefined as never });
        }),
      }),
    },
    send: async () => "started" as const,
    sendIfIdle: async () => "started" as const,
    interrupt: async () => {},
    answer: async () => {},
    setPermissionMode: null,
    setEffort: null,
    setModel: null,
    clearContext: null,
    stop: async () => {
      release?.();
    },
  } as unknown as SdkSessionHandle;
}

test("the supervisor launches and restores a session under that session's own context", async (t) => {
  await manage();
  const calls: SdkLaunchOptions[] = [];
  const real = HARNESSES.claude.sdk;
  HARNESSES.claude.sdk = {
    answersRequests: true,
    launch: async (opts) => {
      calls.push(opts);
      return idleHandle();
    },
  };
  t.after(() => (HARNESSES.claude.sdk = real));

  const supervisor = new SdkSupervisor(new Registry());
  const session = await supervisor.start({
    agent: "claude",
    name: "trace",
    cwd: "/wt/trace",
    prompt: "",
    model: null,
    effort: null,
    permissionMode: null,
    mcp: null,
    taskId: null,
  });
  assert.ok(calls[0]?.traceContext, "a managed lane gives the launch a parent");
  assert.deepEqual(calls[0]?.traceContext, sessionTraceContext(session.id));
  await supervisor.stop(session.id).catch(() => {});

  upsertSdkSession({
    id: "sdk:restored-trace", agent: "claude", agentSessionId: "restored-conversation",
    cwd: "/wt/restored-trace", taskId: null, model: null, effort: null, permissionMode: null,
    status: "suspended", turnInProgress: false,
  });
  await new SdkSupervisor(new Registry()).restore();
  const restored = calls.find((call) => call.resume === "restored-conversation");
  assert.ok(restored, "the suspended row was relaunched");
  assert.deepEqual(restored.traceContext, sessionTraceContext("sdk:restored-trace"));
});
