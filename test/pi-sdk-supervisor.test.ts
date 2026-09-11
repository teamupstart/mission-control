import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What is at stake: whether the Pi driver actually COMPOSES with the daemon that owns
// session lifecycle, rather than merely satisfying its interface.
//
// `pi-sdk-adapter.test.ts` drives the adapter alone; everything here goes through the real
// `SdkSupervisor`, the real registry and the real SQLite row - because that is where the
// facts a restart depends on are written, and none of them are visible from inside the
// handle. A driver id that never reaches `sdk_sessions.agent_session_id` looks perfect in
// isolation and comes back after a daemon restart as a session with nothing to continue.
//
// Pi's harness slot is pointed at `piSdkSpec` with a SCRIPTED Pi behind it, so this is the
// shipped adapter throughout. Nothing installs Pi, reads a credential or spends a token.

const home = mkdtempSync(join(tmpdir(), "pi-sdk-supervisor-"));
process.env.HARNESS_HOME = join(home, "state");
// Resolvable, so the terminal-handoff argv below is composed the way a real one is.
process.env.MISSION_PI_BIN = "/bin/echo";

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { SdkSupervisor } = await import("../src/server/sdk/supervisor.ts");
const { getSdkSession, upsertSdkSession } = await import("../src/server/sdk/store.ts");
const { HARNESSES, resumeArgvFor } = await import("../src/server/harness/index.ts");
const { piSdkSpec } = await import("../src/server/harness/pi/sdk.ts");
const { FakePiSdk, FakePiSession, fakePiSdkDeps } = await import("./helpers/pi-sdk-fake.ts");

type LaunchOptions = import("../src/server/harness/types.ts").SdkLaunchOptions;

after(() => rmSync(home, { recursive: true, force: true }));

beforeEach(() => {
  openDb().exec("DELETE FROM sdk_sessions; DELETE FROM tasks;");
});

/** Point Pi's harness slot at the REAL adapter over a scripted Pi, for one test. */
function withScriptedPi(sdk: InstanceType<typeof FakePiSdk>): {
  restore: () => void;
  calls: LaunchOptions[];
} {
  const calls: LaunchOptions[] = [];
  const real = HARNESSES.pi.sdk;
  const spec = piSdkSpec(fakePiSdkDeps(sdk));
  HARNESSES.pi.sdk = {
    // Read off the REAL spec rather than asserted here: this fake wraps the shipped driver
    // to record its launches, so a declaration of its own would be a second answer to a
    // question the driver already answers.
    answersRequests: spec.answersRequests,
    launch: (opts) => {
      calls.push(opts);
      return spec.launch(opts);
    },
  };
  return { restore: () => (HARNESSES.pi.sdk = real), calls };
}

const START = {
  agent: "pi" as const,
  name: "Try Bedrock",
  cwd: "/wt/pi",
  prompt: "summarize this repository",
  model: "amazon-bedrock/deepseek.v3.2",
  effort: null,
  permissionMode: null,
  mcp: null,
  taskId: null,
};

/**
 * Let the detached pump run, without a clock.
 *
 * `setImmediate` rather than `setTimeout`, so this still works in the tests below that mock
 * timers to skip the eviction linger - which would otherwise cost eight real seconds each.
 */
async function drain(times = 40): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for the supervisor");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("a managed Pi launch persists Pi's own session id as the thing a restart resumes", async () => {
  const sdk = new FakePiSdk();
  const scripted = withScriptedPi(sdk);
  const registry = new Registry();
  const supervisor = new SdkSupervisor(registry);
  try {
    const session = await supervisor.start(START);
    assert.equal(session.runtime, "sdk");
    // The exact provider-qualified id, stored without truncation or translation.
    assert.equal(scripted.calls[0]!.model, "amazon-bedrock/deepseek.v3.2");

    await waitFor(() => getSdkSession(session.id)?.agentSessionId === "pi-session-1");
    const row = getSdkSession(session.id)!;
    assert.equal(row.agent, "pi");
    assert.equal(row.model, "amazon-bedrock/deepseek.v3.2");
    // The card learned the identity the whole file-based read path keys on - which for Pi
    // is also the id `pi --session <id>` reopens.
    assert.equal(registry.getSession(session.id)?.agentSessionId, "pi-session-1");
    assert.match(
      registry.getSession(session.id)?.meta?.modelId ?? "",
      /^amazon-bedrock\/deepseek\.v3\.2$/,
    );
  } finally {
    await supervisor.stopAll(50);
    scripted.restore();
  }
});

test("a daemon restart reopens the EXACT Pi conversation and sends no unsolicited turn", async () => {
  const sdk = new FakePiSdk();
  sdk.sessions.set("pi-session-1", "/fake/.pi/agent/sessions/--wt-pi--/ts_pi-session-1.jsonl");
  const scripted = withScriptedPi(sdk);
  try {
    upsertSdkSession({
      id: "sdk:pi-restore",
      agent: "pi",
      agentSessionId: "pi-session-1",
      cwd: "/wt/pi",
      taskId: null,
      model: "amazon-bedrock/deepseek.v3.2",
      effort: "high",
      permissionMode: null,
      status: "running",
      turnInProgress: false,
    });
    const registry = new Registry();
    const supervisor = new SdkSupervisor(registry, { missionMcpDescriptor: async () => null });
    await supervisor.restore();

    assert.equal(scripted.calls.length, 1);
    assert.equal(scripted.calls[0]!.resume, "pi-session-1");
    assert.equal(scripted.calls[0]!.prompt, "");
    // Resolved through Pi's OWN session listing, to the exact file rather than a look-alike.
    assert.equal(
      sdk.created[0]!.sessionPath,
      "/fake/.pi/agent/sessions/--wt-pi--/ts_pi-session-1.jsonl",
    );
    assert.deepEqual(sdk.runtime.session.deliveries, [], "a resumed idle session gets no turn");
    assert.equal(registry.getSession("sdk:pi-restore")?.agentSessionId, "pi-session-1");
    // The row keeps the id it is being picked up from rather than being blanked and relearned.
    assert.equal(getSdkSession("sdk:pi-restore")?.agentSessionId, "pi-session-1");
    await supervisor.stopAll(50);
  } finally {
    scripted.restore();
  }
});

test("a restart whose Pi conversation is gone shows a card and then takes it away", async (t) => {
  // The eviction is the point. `session_remove` is what settles a task, so a row that
  // simply never came back would leave its task running with nothing to look at.
  const sdk = new FakePiSdk();
  const scripted = withScriptedPi(sdk);
  try {
    upsertSdkSession({
      id: "sdk:pi-lost",
      agent: "pi",
      agentSessionId: "pi-session-gone",
      cwd: "/wt/pi",
      taskId: null,
      model: null,
      effort: null,
      permissionMode: null,
      status: "running",
      turnInProgress: false,
    });
    const registry = new Registry();
    const removals: string[] = [];
    registry.subscribe((event) => {
      if (event.type === "session_remove") removals.push(event.id);
    });
    const reported: string[] = [];
    t.mock.method(console, "error", (...parts: unknown[]) => {
      reported.push(parts.map(String).join(" "));
    });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const supervisor = new SdkSupervisor(registry, { missionMcpDescriptor: async () => null });
    await supervisor.restore();

    assert.equal(getSdkSession("sdk:pi-lost")?.status, "failed");
    // Registered, THEN evicted: a row that failed quietly in the database leaves the task it
    // was running `running` for ever, because `reconcileTasksBoundTo` fires on
    // `session_remove` and on nothing else.
    assert.equal(registry.getSession("sdk:pi-lost")?.state, "exited");
    assert.match(
      reported.join("\n"),
      /no longer holds the session pi-session-gone/,
      "the refusal names the conversation rather than reporting a generic failure",
    );
    t.mock.timers.tick(9_000);
    assert.deepEqual(removals, ["sdk:pi-lost"]);
  } finally {
    scripted.restore();
  }
});

test("clearing a managed Pi session moves the durable driver id to the replacement", async () => {
  const sdk = new FakePiSdk();
  const scripted = withScriptedPi(sdk);
  const registry = new Registry();
  const supervisor = new SdkSupervisor(registry);
  try {
    const session = await supervisor.start(START);
    await waitFor(() => getSdkSession(session.id)?.agentSessionId === "pi-session-1");

    assert.equal(await supervisor.clearContext(session.id), true);
    await waitFor(() => getSdkSession(session.id)?.agentSessionId === "replacement-1");
    // The Mission Control identity is preserved; only the Pi conversation behind it moved.
    assert.equal(registry.getSession(session.id)?.agentSessionId, "replacement-1");
    // And the replaced conversation's outstanding turn is retired, so the card is not left
    // working over a conversation nobody is looking at.
    assert.equal(getSdkSession(session.id)?.turnInProgress, false);
  } finally {
    await supervisor.stopAll(50);
    scripted.restore();
  }
});

test("stopping a managed Pi session disposes Pi once and evicts the card once", async (t) => {
  const sdk = new FakePiSdk();
  const scripted = withScriptedPi(sdk);
  const registry = new Registry();
  const supervisor = new SdkSupervisor(registry);
  const removals: string[] = [];
  registry.subscribe((event) => {
    if (event.type === "session_remove") removals.push(event.id);
  });
  try {
    const session = await supervisor.start(START);
    await waitFor(() => getSdkSession(session.id)?.agentSessionId === "pi-session-1");
    t.mock.timers.enable({ apis: ["setTimeout"] });
    assert.equal(supervisor.requestStop(session.id), true);
    await drain();
    t.mock.timers.tick(9_000);
    await drain();

    assert.deepEqual(removals, [session.id], "one eviction, through Registry.beginEviction");
    assert.equal(sdk.runtime.disposals, 1, "Pi's runtime is disposed exactly once");
    assert.equal(getSdkSession(session.id)?.status, "exited");
  } finally {
    scripted.restore();
  }
});

test("a shutdown suspends a managed Pi session rather than exiting it", async () => {
  // The distinction is the whole of resume-on-restart: a clean restart must not look like
  // an agent that finished, or startup reconciliation reclaims the worktree.
  const sdk = new FakePiSdk();
  const scripted = withScriptedPi(sdk);
  const registry = new Registry();
  const supervisor = new SdkSupervisor(registry);
  try {
    const session = await supervisor.start(START);
    await waitFor(() => getSdkSession(session.id)?.agentSessionId === "pi-session-1");
    await supervisor.stopAll(2_000);
    assert.equal(getSdkSession(session.id)?.status, "suspended");
  } finally {
    scripted.restore();
  }
});

test("the terminal handoff reopens the same Pi conversation the driver created", async () => {
  // The one thing a managed session genuinely takes away is a place to type. Pi keeps ONE
  // session store behind its SDK and its CLI, so `pi --session <id>` reopens the exact
  // conversation this driver has been writing - which is what stops the managed runtime
  // from being a trap.
  const sdk = new FakePiSdk(new FakePiSession("pi-session-handoff"));
  const scripted = withScriptedPi(sdk);
  const registry = new Registry();
  const supervisor = new SdkSupervisor(registry);
  try {
    const session = await supervisor.start(START);
    await waitFor(() => getSdkSession(session.id)?.agentSessionId === "pi-session-handoff");
    const driverId = registry.getSession(session.id)!.agentSessionId!;
    assert.deepEqual(await resumeArgvFor("pi", driverId, null), [
      "/bin/echo",
      "--session",
      "pi-session-handoff",
    ]);
  } finally {
    await supervisor.stopAll(50);
    scripted.restore();
  }
});

test("live model and effort controls reach Pi and persist what a restart will reuse", async () => {
  const sdk = new FakePiSdk();
  const scripted = withScriptedPi(sdk);
  const registry = new Registry();
  const supervisor = new SdkSupervisor(registry);
  try {
    const session = await supervisor.start(START);
    await waitFor(() => getSdkSession(session.id)?.agentSessionId === "pi-session-1");
    await supervisor.setEffort(session.id, "xhigh");
    await supervisor.setModel(session.id, "amazon-bedrock/anthropic.claude-3-5-sonnet");
    assert.deepEqual(sdk.runtime.session.thinkingLevels, ["xhigh"]);
    assert.deepEqual(sdk.runtime.session.modelChanges, [
      { provider: "amazon-bedrock", id: "anthropic.claude-3-5-sonnet" },
    ]);
    const row = getSdkSession(session.id)!;
    assert.equal(row.effort, "xhigh");
    assert.equal(row.model, "amazon-bedrock/anthropic.claude-3-5-sonnet");
  } finally {
    await supervisor.stopAll(50);
    scripted.restore();
  }
});

test("the supervisor refuses a permission-mode change Pi has no way to make", async () => {
  const sdk = new FakePiSdk();
  const scripted = withScriptedPi(sdk);
  const registry = new Registry();
  const supervisor = new SdkSupervisor(registry);
  try {
    const session = await supervisor.start(START);
    await waitFor(() => getSdkSession(session.id)?.agentSessionId === "pi-session-1");
    await assert.rejects(
      () => supervisor.setPermissionMode(session.id, "auto"),
      /cannot change permission mode/,
    );
  } finally {
    await supervisor.stopAll(50);
    scripted.restore();
  }
});
