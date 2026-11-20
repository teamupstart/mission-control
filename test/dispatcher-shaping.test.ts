import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { Session, Task } from "../src/shared/types.ts";
import { mkMuxHandle, mkTask } from "./helpers/session-fixture.ts";

// Task shaping at dispatch, end to end through the real `Dispatcher` on every harness and
// runtime: where the section lands in turn one, that nothing changes with the flag off or no
// shaper, that a failing or slow step never stops the launch, the record each launch leaves
// (and the ones it must not), the trace context shapers are given, and that a section never
// makes a launch that works today exceed its delivery path's byte ceiling.
//
// Only the terminal home, the pane and the SDK supervisor are faked, as in
// `standing-instructions-delivery.test.ts`. Provisioning, composition, budgeting and the
// record are real, and the shapers in the budget cases are real `command` processes.

const home = mkdtempSync(join(tmpdir(), "mission-dispatch-shaping-"));
process.env.HARNESS_HOME = home;
process.env.MISSION_CLAUDE_BIN = "/bin/echo";
process.env.MISSION_CODEX_BIN = "/bin/echo";
process.env.MISSION_PI_BIN = "/bin/echo";
process.env.MISSION_MCP_SERVER = join(home, "server.mjs");
writeFileSync(process.env.MISSION_MCP_SERVER, "// not executed by this test\n");

const { Registry } = await import("../src/server/registry.ts");
const { Dispatcher } = await import("../src/server/dispatcher.ts");
const { openDb, getTaskShapingText, getTask: getDurableTask } = await import("../src/server/db.ts");
const { withTaskKindContract } = await import("../src/server/task-contract.ts");
const { taskPlanDiscovery } = await import("../src/server/plans/inputs.ts");
const { setHarnessesConfig } = await import("../src/server/harnesses.ts");
const { updateStandingInstructions, standingInstructionsView } = await import("../src/server/instructions/config.ts");
const { HARNESSES } = await import("../src/server/harness/index.ts");
const flags = await import("../src/server/feature-flags/index.ts");
const shapingStore = await import("../src/server/shaping/index.ts");
const { APP_CONFIG_ENTRIES } = await import("../src/shared/app-config-entries.ts");
const { setAppConfig } = await import("../src/server/db.ts");
const { SHAPING_CONFIG_DEFAULTS, SHAPING_SECTION_PREAMBLE, ShapingIntentSchema, currentShaping } = await import("../src/shared/shaping.ts");
const { launchArgumentTurnOne } = await import("../src/server/turn-one-budget.ts");
const { isolatedAgentEnvironment } = await import("../src/server/agent-subprocess-env.ts");
const { sessionTraceContext } = await import("../src/server/telemetry/index.ts");
const { shapeTask } = await import("../src/server/shaping/engine.ts");
const { MEMORY_INDEX_PATH } = await import("../src/shared/memory.ts");

type ShapeTask = typeof import("../src/server/shaping/engine.ts").shapeTask;
type ShapeTaskInput = Parameters<ShapeTask>[0];
type SdkSupervisor = import("../src/server/sdk/supervisor.ts").SdkSupervisor;

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-shaper.mjs", import.meta.url));
const MISSION_DESCRIPTOR = { serverName: "mission-control", command: "/usr/bin/node", args: ["/m.mjs"], env: {} };
const clones: string[] = [];

after(() => {
  rmSync(home, { recursive: true, force: true });
  for (const root of clones) rmSync(root, { recursive: true, force: true });
});

function setFlag(enabled: boolean): void {
  assert.equal(flags.applyFeatureFlagIntent({ kind: "flag", id: "task-shaping", enabled }).ok, true);
}

beforeEach(() => {
  openDb().exec("DELETE FROM app_config");
  setHarnessesConfig({ sessionRuntime: { claude: "terminal", codex: "terminal", pi: "terminal" } });
  setAppConfig(APP_CONFIG_ENTRIES.shaping, SHAPING_CONFIG_DEFAULTS);
  shapingStore.reloadShaping();
  setFlag(true);
});

function seedRepo(name: string): string {
  const repo = join(home, name);
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@test"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
  writeFileSync(join(repo, "file.txt"), "base\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "base"]);
  return realpathSync(repo);
}

let seq = 0;
function mkDiscovered(over: Partial<DiscoveredSession>): DiscoveredSession {
  const n = ++seq;
  return {
    syntheticId: `proc:ttys20${n}:${n}:0`,
    agent: "claude",
    name: "work",
    nameSource: "process",
    cwd: `/wt/task-${n}`,
    gitBranch: "harness/task",
    pid: 2000 + n,
    tty: `ttys20${n}`,
    terminals: [mkMuxHandle({ session: `sh${n}`, windowName: "w", windowIndex: 0, paneId: `%${300 + n}` })],
    startedAt: 0,
    ...over,
  } as DiscoveredSession;
}

/** A shaper run that answers with `section`, recording what it was asked. */
function standIn(section: string, summary: Partial<NonNullable<Awaited<ReturnType<ShapeTask>>["summary"]>> = {}) {
  const calls: ShapeTaskInput[] = [];
  const shapeTask: ShapeTask = async (input) => {
    calls.push(input);
    return {
      section,
      entries: [],
      summary: section || Object.keys(summary).length
        ? {
            state: "ok", at: Date.now(), durationMs: 3, entries: section ? 1 : 0, bytes: Buffer.byteLength(section), truncated: false,
            shapers: [{
              id: "acme", label: "Acme guidance", stage: "select", origin: "registered", sha256: null, outcome: "ok", reason: null,
              durationMs: 3, entries: section ? 1 : 0, bytes: Buffer.byteLength(section), truncated: false, redacted: false, version: "v1",
            }],
            ...summary,
          }
        : null,
    };
  };
  return { shapeTask, calls };
}

const SECTION = `${SHAPING_SECTION_PREAMBLE}\n\n### Acme guidance: Idempotent charges\nCharge once per key.`;

interface Run {
  registry: InstanceType<typeof Registry>;
  argv: string[];
  stateHome: string;
  extraEnv: Record<string, string>;
  prompt: string;
  sessionId: string;
  task: Task;
}

interface DispatchOptions {
  agent: "claude" | "codex" | "pi";
  repo: string;
  taskId: string;
  intent: string;
  registry?: InstanceType<typeof Registry>;
  shapeTask?: ShapeTask;
  argMax?: () => Promise<number | null>;
  failSpawn?: boolean;
  workflowName?: (workflowId: string) => string | null;
}

/** One terminal dispatch through the real dispatcher, faking only the home and the pane. */
async function terminalDispatch(options: DispatchOptions): Promise<Run> {
  const registry = options.registry ?? new Registry();
  const existing = registry.getTask(options.taskId);
  registry.upsertTask(existing
    ? { ...existing, status: "dispatching", sessionId: null, worktreePath: null, branch: null, homeName: null, terminalResourceId: null }
    : mkTask({ id: options.taskId, status: "dispatching", repoRoot: options.repo, title: "Shaping", intent: options.intent, agent: options.agent }));
  const nativeId = `native-${options.taskId}-${++seq}`;
  let argv: string[] = [];
  let pasted: string | null = null;
  let sessionId = "";
  let stateHome = "";
  let extraEnv: Record<string, string> = {};
  const dispatcher = new Dispatcher(registry, async () => {}, {
    resolveRuntime: () => "terminal",
    missionMcpDescriptor: async () => MISSION_DESCRIPTOR,
    verifyMissionMcpTools: async () => ({ ok: true }),
    ...(options.shapeTask ? { shapeTask: options.shapeTask } : {}),
    ...(options.argMax ? { argMax: options.argMax } : {}),
    ...(options.workflowName ? { workflowName: options.workflowName } : {}),
    spawn: async (_label, _short, cwd, _bin, args, home, _backend, env) => {
      if (options.failSpawn) throw new Error("the terminal could not start");
      argv = [...(args ?? [])];
      stateHome = home ?? "";
      extraEnv = { ...env };
      const discovered = mkDiscovered({ agent: options.agent, cwd, syntheticId: `sid-${options.taskId}-${seq}` });
      registry.applyDiscovery([discovered]);
      sessionId = discovered.syntheticId;
      registry.applyHook({
        agent: options.agent, event: "SessionStart", sessionId: nativeId, cwd, transcriptPath: null,
        env: { tmuxPane: (discovered.terminals[0] as { paneId: string }).paneId },
      });
      return { homeName: `home-${options.taskId}-${seq}`, homeBackend: "tmux", terminalResourceId: null };
    },
    inject: async (session, text) => {
      pasted = text;
      registry.applyHook({
        agent: options.agent, event: "UserPromptSubmit", sessionId: nativeId, cwd: session.cwd, transcriptPath: null,
        prompt: text, env: { tmuxPane: "%1" },
      });
      return { ok: true, pasted: true, submitVerified: true };
    },
  });
  await dispatcher.dispatch(options.taskId);
  const task = registry.getTask(options.taskId)!;
  const prompt = pasted ?? String(argv[argv.length - 1] ?? "");
  return { registry, argv, stateHome, extraEnv, prompt, sessionId, task };
}

function fakeSupervisor(registry: InstanceType<typeof Registry>) {
  const starts: Parameters<SdkSupervisor["start"]>[0][] = [];
  const supervisor = {
    starts,
    async start(input: Parameters<SdkSupervisor["start"]>[0]): Promise<Session> {
      starts.push(input);
      return registry.registerSdkSession({ id: input.sessionId ?? `sdk:${++seq}`, agent: input.agent, name: input.name, cwd: input.cwd });
    },
    async stop(): Promise<void> {},
    taskLiveness: () => null,
  };
  return supervisor as typeof supervisor & SdkSupervisor;
}

async function sdkDispatch(options: DispatchOptions) {
  setHarnessesConfig({ sessionRuntime: { [options.agent]: "sdk" } });
  const registry = options.registry ?? new Registry();
  const existing = registry.getTask(options.taskId);
  registry.upsertTask(existing
    ? { ...existing, status: "dispatching", sessionId: null, worktreePath: null, branch: null }
    : mkTask({ id: options.taskId, status: "dispatching", repoRoot: options.repo, title: "Shaping", intent: options.intent, agent: options.agent }));
  const supervisor = fakeSupervisor(registry);
  await new Dispatcher(registry, async () => {}, {
    supervisor,
    missionMcpDescriptor: async () => MISSION_DESCRIPTOR,
    verifyMissionMcpTools: async () => ({ ok: true }),
    piExtensionInstalled: () => true,
    ...(options.shapeTask ? { shapeTask: options.shapeTask } : {}),
    inject: async () => { throw new Error("an embedded dispatch must never type at a pane"); },
  }).dispatch(options.taskId);
  const task = registry.getTask(options.taskId)!;
  return { registry, start: supervisor.starts[0], task };
}

function assertRunning(task: Task): void {
  assert.equal(task.status, "running", `dispatch failed: ${task.error ?? "unknown"}`);
}

async function unshapedExpectation(task: Task, intent: string): Promise<string> {
  return withTaskKindContract(task, intent, { planDiscovery: await taskPlanDiscovery(task) });
}

// ---- byte-identical launches ----

test("with the flag off, and with no shaper, turn one and argv are byte-identical and nothing is recorded", async () => {
  const repo = seedRepo("identical");
  const intent = "sort out the flexbox helper";
  for (const agent of ["claude", "codex", "pi"] as const) {
    setFlag(false);
    const probe = standIn(SECTION);
    const off = await terminalDispatch({ agent, repo, taskId: `off-${agent}`, intent, shapeTask: probe.shapeTask });
    assertRunning(off.task);
    assert.equal(probe.calls.length, 0, `${agent}: nothing is called with the flag off`);
    assert.equal(off.prompt, await unshapedExpectation(off.task, intent), `${agent}: turn one is what it was`);
    setFlag(true);
    // The real engine with no shaper configured: no section, no record.
    const none = await terminalDispatch({ agent, repo, taskId: `none-${agent}`, intent });
    assertRunning(none.task);
    assert.equal(none.prompt, await unshapedExpectation(none.task, intent));
    // Normalized for what every launch mints afresh: Pi's session id, the disposable state
    // home and the per-worktree credential path.
    const argvOf = (run: Run) => run.argv.map((arg) => (arg === run.argv[run.argv.indexOf("--session-id") + 1] ? "<id>" : arg)
      .replace(/mission-control-agent-state\/session-[A-Za-z0-9]+/g, "<home>")
      .replace(/mission-control-agent-capabilities\/[0-9a-f]+/g, "<credential>")
      .replaceAll(run.task.worktreePath ?? "<none>", "<worktree>"));
    assert.deepEqual(argvOf(none), argvOf(off), `${agent}: the same argv`);
    for (const run of [off, none]) {
      assert.equal(run.task.shaping, undefined, `${agent}: no record`);
      assert.equal(getDurableTask(run.task.id)?.shaping, undefined);
      assert.equal(getTaskShapingText(run.task.id), null);
    }
  }
});

test("with the flag off an embedded launch hands the supervisor exactly what it did before", async () => {
  const repo = seedRepo("identical-sdk");
  const intent = "sort out the flexbox helper";
  setFlag(false);
  const probe = standIn(SECTION);
  const off = await sdkDispatch({ agent: "claude", repo, taskId: "off-sdk", intent, shapeTask: probe.shapeTask });
  assertRunning(off.task);
  assert.equal(probe.calls.length, 0);
  assert.equal(off.start!.sessionId, undefined, "the supervisor mints the session id, as it always has");
  assert.equal(off.start!.prompt, await unshapedExpectation(off.task, intent));
  assert.equal(off.task.shaping, undefined);
  setFlag(true);
});

test("with the flag on and no shaper, an embedded launch hands the supervisor exactly what an unshaped one does", async () => {
  const repo = seedRepo("identical-sdk-no-shaper");
  const intent = "sort out the flexbox helper";
  setFlag(false);
  const baseline = await sdkDispatch({ agent: "claude", repo, taskId: "sdk-baseline", intent });
  assertRunning(baseline.task);
  setFlag(true);
  // The real engine with nothing configured: no shaper applies to this launch.
  const none = await sdkDispatch({ agent: "claude", repo, taskId: "sdk-no-shaper", intent });
  assertRunning(none.task);
  assert.equal(none.start!.sessionId, undefined, "no pre-minted id reaches the supervisor when no shaper ran");
  assert.deepEqual(Object.keys(none.start!).sort(), Object.keys(baseline.start!).sort(), "the same start input, key for key");
  assert.equal(none.start!.prompt, await unshapedExpectation(none.task, intent));
  assert.deepEqual(
    { ...none.start!, cwd: "<worktree>", taskId: "<task>", gitBranch: "<branch>", gitRoot: "<worktree>", prompt: "<prompt>",
      launchPresentation: "<presentation>", standingInstructions: none.start!.standingInstructions },
    { ...baseline.start!, cwd: "<worktree>", taskId: "<task>", gitBranch: "<branch>", gitRoot: "<worktree>", prompt: "<prompt>",
      launchPresentation: "<presentation>", standingInstructions: baseline.start!.standingInstructions },
    "every value that is not this launch's own worktree, task or prompt is the baseline's",
  );
  assert.equal(none.task.shaping, undefined, "no record");
  assert.equal(getDurableTask("sdk-no-shaper")?.shaping, undefined);
  assert.equal(getTaskShapingText("sdk-no-shaper"), null);
});

test("an embedded launch a shaper ran for starts under the id its shapers' trace context came from", async () => {
  const repo = seedRepo("sdk-shared-id");
  const probe = standIn(SECTION);
  const run = await sdkDispatch({ agent: "codex", repo, taskId: "sdk-shared-id", intent: "do it", shapeTask: probe.shapeTask });
  assertRunning(run.task);
  assert.ok(run.start!.sessionId, "the shaped launch passes its pre-minted id");
  assert.deepEqual(probe.calls[0]!.trace, sessionTraceContext(run.start!.sessionId!));
  assert.equal(currentShaping(run.task)?.sessionId, run.start!.sessionId);
});

// ---- where the section lands ----

test("the section follows the kind contract in both turn-one variants", async () => {
  const repo = seedRepo("position");
  const intent = "THE-OPERATOR-REQUEST";
  // Claude · sdk carries standing instructions out of band, so the launch also composes the
  // fallback turn one that puts them in the prompt. Both must end with the same section.
  const rule = updateStandingInstructions({ expectedEtag: standingInstructionsView().etag, default: "Preserve unrelated work.", repositories: {} });
  assert.equal(rule.ok, true);
  const { shapeTask } = standIn(SECTION);
  const run = await sdkDispatch({ agent: "claude", repo, taskId: "position-sdk", intent, shapeTask });
  assertRunning(run.task);
  const unshaped = await unshapedExpectation(run.task, intent);
  assert.equal(run.start!.prompt, `${unshaped}\n\n${SECTION}`);
  const fallback = run.start!.standingInstructions!.fallbackPrompt;
  assert.ok(fallback.includes("Preserve unrelated work."), "the fallback carries the block in turn one");
  assert.ok(fallback.endsWith(`\n\n${SECTION}`), "and the same section after its contract");
  assert.equal(fallback.indexOf(SECTION), fallback.length - SECTION.length);
});

test("Claude, Codex and Pi receive identical text on the terminal and SDK runtimes", async () => {
  const repo = seedRepo("identical-text");
  const intent = "THE-OPERATOR-REQUEST";
  const prompts: string[] = [];
  for (const agent of ["claude", "codex", "pi"] as const) {
    const terminal = await terminalDispatch({ agent, repo, taskId: `text-${agent}-terminal`, intent, shapeTask: standIn(SECTION).shapeTask });
    assertRunning(terminal.task);
    assert.equal(terminal.prompt, `${await unshapedExpectation(terminal.task, intent)}\n\n${SECTION}`, `${agent} · terminal`);
    prompts.push(terminal.prompt.slice(terminal.prompt.indexOf(SECTION)));
    const sdk = await sdkDispatch({ agent, repo, taskId: `text-${agent}-sdk`, intent, shapeTask: standIn(SECTION).shapeTask });
    assertRunning(sdk.task);
    assert.equal(sdk.start!.prompt, `${await unshapedExpectation(sdk.task, intent)}\n\n${SECTION}`, `${agent} · sdk`);
    prompts.push(sdk.start!.prompt.slice(sdk.start!.prompt.indexOf(SECTION)));
  }
  assert.equal(new Set(prompts).size, 1);
});

// ---- nothing stops the launch ----

test("a rejecting shaping step still launches, unshaped, and records degraded with its reason", async () => {
  const repo = seedRepo("rejecting");
  const intent = "do it";
  const run = await terminalDispatch({
    agent: "claude", repo, taskId: "rejecting", intent,
    shapeTask: async () => { throw new Error("the guidance server is on fire"); },
  });
  assertRunning(run.task);
  assert.equal(run.prompt, await unshapedExpectation(run.task, intent));
  const record = currentShaping(run.task);
  assert.equal(record?.state, "degraded");
  assert.equal(record?.shapers[0]?.outcome, "failed");
  assert.match(record?.shapers[0]?.reason ?? "", /the guidance server is on fire/);
  assert.equal(getTaskShapingText("rejecting"), null, "no text for a launch that received none");
});

test("a shaping step that never settles is cut off at its deadline and the task still launches", async () => {
  const repo = seedRepo("slow");
  const intent = "do it";
  assert.equal(shapingStore.applyShapingIntent({ kind: "settings", limits: { deadlineMs: 1000 } }).ok, true);
  const started = Date.now();
  const run = await terminalDispatch({
    agent: "codex", repo, taskId: "slow", intent,
    shapeTask: () => new Promise(() => {}),
  });
  assertRunning(run.task);
  assert.ok(Date.now() - started < 8000, "the backstop, not the stand-in, ended the step");
  assert.equal(run.prompt, await unshapedExpectation(run.task, intent));
  const record = currentShaping(run.task);
  assert.equal(record?.state, "degraded");
  assert.equal(record?.shapers[0]?.outcome, "timed_out");
});

test("a task shows Shaping context while its step runs, and not before or after", async () => {
  const repo = seedRepo("progress");
  const registry = new Registry();
  const seen: Array<boolean> = [];
  registry.subscribe((event) => {
    if (event.type === "task_upsert" && event.task.id === "progress") seen.push(Boolean(event.task.shapingContext));
  });
  let during: Task | undefined;
  const run = await terminalDispatch({
    agent: "claude", repo, taskId: "progress", intent: "do it", registry,
    shapeTask: async (input) => {
      during = registry.getTask(input.context.taskId!);
      return { summary: null, section: "", entries: [] };
    },
  });
  assertRunning(run.task);
  assert.ok(during?.shapingContext?.startedAt, "marked while the step runs");
  assert.equal(run.task.shapingContext, undefined, "and cleared after");
  assert.equal(seen.filter(Boolean).length >= 1 && seen[seen.length - 1] === false, true);
});

// ---- the record ----

test("a redispatch with its shaper off, or with the flag off, leaves no summary and no text", async () => {
  const repo = seedRepo("redispatch");
  for (const variant of ["shaper-off", "flag-off"] as const) {
    const registry = new Registry();
    const taskId = `redispatch-${variant}`;
    const first = await terminalDispatch({ agent: "claude", repo, taskId, intent: "do it", registry, shapeTask: standIn(SECTION).shapeTask });
    assertRunning(first.task);
    assert.equal(currentShaping(first.task)?.sessionId, first.sessionId);
    assert.equal(getTaskShapingText(taskId)?.text, SECTION);
    if (variant === "flag-off") setFlag(false);
    const second = await terminalDispatch({
      agent: "claude", repo, taskId, intent: "do it", registry,
      shapeTask: standIn("").shapeTask,
    });
    assertRunning(second.task);
    assert.equal(second.task.shaping, undefined, `${variant}: no summary`);
    assert.equal(getDurableTask(taskId)?.shaping, undefined);
    assert.equal(getTaskShapingText(taskId), null, `${variant}: no text`);
    setFlag(true);
  }
});

test("a redispatch whose only shaper times out keeps its own degraded summary and reason, and no text", async () => {
  const repo = seedRepo("redispatch-timeout");
  const registry = new Registry();
  const first = await terminalDispatch({ agent: "claude", repo, taskId: "rt", intent: "do it", registry, shapeTask: standIn(SECTION).shapeTask });
  assertRunning(first.task);
  const timedOut = standIn("", {
    state: "degraded", entries: 0, bytes: 0,
    shapers: [{
      id: "acme", label: "Acme guidance", stage: "select", origin: "registered", sha256: null, outcome: "timed_out",
      reason: "Timed out after 5 s.", durationMs: 5000, entries: 0, bytes: 0, truncated: false, redacted: false, version: null,
    }],
  });
  const second = await terminalDispatch({ agent: "claude", repo, taskId: "rt", intent: "do it", registry, shapeTask: timedOut.shapeTask });
  assertRunning(second.task);
  const record = currentShaping(second.task);
  assert.equal(record?.state, "degraded");
  assert.equal(record?.sessionId, second.sessionId);
  assert.equal(record?.shapers[0]?.reason, "Timed out after 5 s.");
  assert.equal(getTaskShapingText("rt"), null);
});

test("a dispatch whose launch fails after shaping leaves the previous launch's record exactly as it was", async () => {
  const repo = seedRepo("launch-fails");
  const registry = new Registry();
  const first = await terminalDispatch({ agent: "claude", repo, taskId: "lf", intent: "do it", registry, shapeTask: standIn(SECTION).shapeTask });
  assertRunning(first.task);
  const before = { record: getDurableTask("lf")?.shaping, text: getTaskShapingText("lf") };
  const probe = standIn(`${SHAPING_SECTION_PREAMBLE}\n\n### Acme guidance: Another\nother text`);
  const second = await terminalDispatch({ agent: "claude", repo, taskId: "lf", intent: "do it", registry, shapeTask: probe.shapeTask, failSpawn: true });
  assert.equal(probe.calls.length, 1, "the second launch was shaped");
  assert.notEqual(second.task.status, "running");
  assert.deepEqual(getDurableTask("lf")?.shaping, before.record);
  assert.deepEqual(getTaskShapingText("lf"), before.text);
  assert.deepEqual(registry.getTask("lf")?.shaping, before.record);
});

test("a launch whose commit fails keeps a record naming the previous session, which the new one does not show", async () => {
  const repo = seedRepo("commit-fails");
  const registry = new Registry();
  const first = await terminalDispatch({ agent: "claude", repo, taskId: "cf", intent: "do it", registry, shapeTask: standIn(SECTION).shapeTask });
  assertRunning(first.task);
  registry.shapingCommitter = () => { throw new Error("disk full"); };
  try {
    const second = await terminalDispatch({ agent: "claude", repo, taskId: "cf", intent: "do it", registry, shapeTask: standIn(SECTION).shapeTask });
    assertRunning(second.task);
    assert.equal(second.task.shaping?.sessionId, first.sessionId, "the stored record names the earlier session");
    assert.notEqual(second.task.sessionId, first.sessionId);
    assert.equal(currentShaping(second.task), null, "which the new session does not show");
    assert.equal(registry.getSession(second.sessionId)?.task?.shaping, undefined, "nor does its card");
  } finally {
    registry.shapingCommitter = null;
  }
});

// ---- the trace context ----

test("the shaping input carries exactly the trace context the agent is launched with", async () => {
  const repo = seedRepo("trace");
  // A run a shaper took part in: only those launches share the pre-minted id with the agent.
  const sdkProbe = standIn(SECTION);
  const sdk = await sdkDispatch({ agent: "claude", repo, taskId: "trace-sdk", intent: "do it", shapeTask: sdkProbe.shapeTask });
  assertRunning(sdk.task);
  // The supervisor derives its agent's context from the id it is started under, which the
  // dispatcher minted before shaping and handed to both.
  assert.ok(sdk.start!.sessionId, "the embedded session starts under the pre-minted id");
  assert.deepEqual(sdkProbe.calls[0]!.trace, sessionTraceContext(sdk.start!.sessionId!));
  const terminalProbe = standIn("");
  const terminal = await terminalDispatch({ agent: "claude", repo, taskId: "trace-terminal", intent: "do it", shapeTask: terminalProbe.shapeTask });
  assertRunning(terminal.task);
  assert.equal(terminalProbe.calls[0]!.trace, null, "a terminal launch carries none");
});

test("the shaping input is the complete collected task", async () => {
  const repo = seedRepo("input");
  const probe = standIn("");
  const run = await sdkDispatch({ agent: "codex", repo, taskId: "input", intent: "THE PROMPT", shapeTask: probe.shapeTask });
  assertRunning(run.task);
  const input = probe.calls[0]!;
  assert.equal(input.task, "THE PROMPT");
  assert.equal(input.context.taskId, "input");
  assert.equal(input.context.harness, "codex");
  assert.equal(input.context.runtime, "sdk");
  assert.equal(input.context.repositories.length, 1);
  assert.equal(input.context.repositories[0]!.role, "primary");
  assert.equal(input.context.repositories[0]!.path, run.task.worktreePath);
  assert.equal(input.context.repositories[0]!.branch, run.task.branch);
  assert.equal(input.maxSectionBytes, undefined, "an embedded driver has no ceiling to budget against");
});

// ---- delivery paths and their ceilings ----

/** Register one real `command` shaper that returns `total` bytes of entries, and allow 64 KiB. */
function registerLargeShaper(total = 64 * 1024): void {
  assert.equal(shapingStore.applyShapingIntent({ kind: "settings", limits: { totalBytes: 64 * 1024 } }).ok, true);
  // Parsed as the route parses it, so the stored definition is the strict one with its defaults.
  assert.equal(shapingStore.applyShapingIntent(ShapingIntentSchema.parse({ kind: "upsert", shaper: {
    id: "large", label: "Large", stage: "select", maxBytes: 64 * 1024, timeoutMs: 30_000,
    transport: { type: "command", command: process.execPath, args: [FIXTURE, "large", String(total)] },
  } })).ok, true);
  assert.equal(shapingStore.applyShapingIntent({ kind: "enable", id: "large", enabled: true }).ok, true);
}

test("the SDK and the pane paste have no ceiling and deliver a 64 KiB section with a short prompt", async () => {
  registerLargeShaper();
  assert.equal(HARNESSES.claude.turnOne.sdk.maxBytes, null);
  assert.equal(HARNESSES.claude.turnOne.terminal.path, "paste");
  assert.equal(HARNESSES.claude.turnOne.terminal.maxBytes, null);
  const repo = seedRepo("no-ceiling");
  const terminal = await terminalDispatch({ agent: "claude", repo, taskId: "paste-64k", intent: "short" });
  assertRunning(terminal.task);
  const pasted = currentShaping(terminal.task);
  assert.ok(pasted && pasted.bytes > 60 * 1024, `the pasted section is about 64 KiB (${pasted?.bytes})`);
  assert.equal(pasted.limit, undefined);
  assert.ok(terminal.prompt.endsWith(getTaskShapingText("paste-64k")!.text));
  const sdk = await sdkDispatch({ agent: "codex", repo, taskId: "sdk-64k", intent: "short" });
  assertRunning(sdk.task);
  assert.ok((currentShaping(sdk.task)?.bytes ?? 0) > 60 * 1024);
  assert.ok(sdk.start!.prompt.endsWith(getTaskShapingText("sdk-64k")!.text));
});

/** The bytes `execve` charges for an argv and environment, as the budget counts them. */
function execBytes(argv: readonly string[], env: Record<string, string | undefined>): number {
  const count = (value: string) => Buffer.byteLength(value) + 1 + 8;
  return argv.reduce((sum, arg) => sum + count(arg), 0)
    + Object.entries(env).reduce((sum, [name, value]) => (value === undefined ? sum : sum + count(`${name}=${value}`)), 0);
}

test("Pi's launch argument: a turn one within 1 KiB of the per-argument ceiling still launches, its section cut to fit", async () => {
  registerLargeShaper();
  const ceiling = 32 * 4096 - 1;
  const original = HARNESSES.pi.turnOne;
  // The Linux kernel's per-argument limit, declared exactly as that platform's entry declares it,
  // so the case runs on every machine; on Linux it is the live declaration.
  HARNESSES.pi.turnOne = { ...original, terminal: launchArgumentTurnOne("linux") };
  try {
    assert.equal(HARNESSES.pi.turnOne.terminal.maxBytes, ceiling);
    const repo = seedRepo("pi-ceiling");
    // Measure what dispatch wraps around the prompt, then size the prompt to land within 1 KiB.
    setFlag(false);
    const probe = await terminalDispatch({ agent: "pi", repo, taskId: "pi-probe", intent: "x" });
    assertRunning(probe.task);
    setFlag(true);
    const overhead = Buffer.byteLength(probe.prompt) - 1;
    const intent = "y".repeat(ceiling - overhead - 512);
    setFlag(false);
    const today = await terminalDispatch({ agent: "pi", repo, taskId: "pi-today", intent });
    assertRunning(today.task);
    setFlag(true);
    const todayBytes = Buffer.byteLength(today.prompt);
    assert.ok(todayBytes <= ceiling && ceiling - todayBytes <= 1024, `today's turn one is within 1 KiB of the ceiling (${ceiling - todayBytes} left)`);
    const shaped = await terminalDispatch({ agent: "pi", repo, taskId: "pi-shaped", intent });
    assertRunning(shaped.task);
    assert.ok(Buffer.byteLength(shaped.prompt) <= ceiling, "the shaped launch argument still fits");
    const record = currentShaping(shaped.task);
    assert.equal(record?.truncated, true, "and the record says it was cut");
    assert.match(record?.limit?.reason ?? "", /one launch argument/);
    assert.ok((record?.limit?.bytes ?? Infinity) < 1024);
  } finally {
    HARNESSES.pi.turnOne = original;
  }
});

test("Pi's launch argument: an environment that leaves little room under ARG_MAX never produces E2BIG", async () => {
  registerLargeShaper();
  const repo = seedRepo("pi-argmax");
  // Pi's CLI is a `#!` script, often installed deep in a version manager's tree: exec charges its
  // pathname and its interpreter beyond argv, which the budget has to leave room for.
  const piDir = join(home, "versions", ...Array.from({ length: 24 }, (_, n) => `node-v24.19.0-segment-${n}`), "bin");
  mkdirSync(piDir, { recursive: true });
  const piScript = join(piDir, "pi");
  writeFileSync(piScript, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  assert.ok(piScript.length > 600, "a realistically long install path");
  const previousPi = process.env.MISSION_PI_BIN;
  process.env.MISSION_PI_BIN = piScript;
  const argMax = Number(execFileSync("/usr/bin/getconf", ["ARG_MAX"], { encoding: "utf8" }).trim());
  // A turn one well under the per-argument limit, and an environment that leaves it about 8 KiB.
  setFlag(false);
  const baseline = await terminalDispatch({ agent: "pi", repo, taskId: "pi-env-probe", intent: "short request" });
  assertRunning(baseline.task);
  setFlag(true);
  const env = () => ({ ...process.env, ...isolatedAgentEnvironment({ cwd: baseline.task.worktreePath!, stateHome: baseline.stateHome, extraEnv: baseline.extraEnv }) });
  const used = execBytes([piScript, ...baseline.argv], env());
  // Many ordinary-sized variables rather than one huge one, the way a real environment fills up.
  const padNames: string[] = [];
  let room = argMax - used - 8 * 1024;
  for (let n = 0; room > 64; n++) {
    const name = `MISSION_SHAPING_TEST_PAD_${n}`;
    const value = "p".repeat(Math.min(4000, room - name.length - 1 - 1 - 8));
    if (value.length <= 0) break;
    process.env[name] = value;
    padNames.push(name);
    room -= name.length + 1 + value.length + 1 + 8;
  }
  try {
    // Node itself cannot start under an environment this close to ARG_MAX, so this one shaper
    // answers in-process: the real engine, allocator and budget, with 64 KiB to cut.
    const large: ShapeTask = (input) => shapeTask(input, {
      config: shapingStore.getShapingConfig(), discovered: [], enabled: true,
      transports: Object.fromEntries(["command", "mcp", "http", "builtin"].map((id) => [id, async () => ({
        kind: "data" as const,
        data: JSON.stringify({ guidance: [1, 2, 3, 4].map((n) => ({ id: `big/${n}`, title: `Big ${n}`, body: `${"line of guidance\n".repeat(900)}` })) }),
      })])) as never,
    });
    const shaped = await terminalDispatch({ agent: "pi", repo, taskId: "pi-env", intent: "short request", argMax: async () => argMax, shapeTask: large });
    assertRunning(shaped.task);
    const record = currentShaping(shaped.task);
    assert.equal(record?.truncated, true, JSON.stringify(record));
    assert.match(record?.limit?.reason ?? "", /arguments and environment/);
    const launchEnv = { ...process.env, ...isolatedAgentEnvironment({ cwd: shaped.task.worktreePath!, stateHome: shaped.stateHome, extraEnv: shaped.extraEnv }) };
    assert.ok(execBytes([piScript, ...shaped.argv], launchEnv) <= argMax, "within the combined limit as the budget counts it");
    // And the kernel agrees: the exact argv and environment execute.
    const ran = spawnSync(piScript, shaped.argv, { env: launchEnv, stdio: "ignore" });
    assert.equal(ran.error, undefined, `the launch executes (${ran.error?.message})`);
    assert.equal(ran.status, 0);
    // Without the budget the same section would not have fit.
    const unbudgeted = [...shaped.argv.slice(0, -1), `${shaped.argv.at(-1)}${"z".repeat(64 * 1024)}`];
    assert.ok(execBytes([piScript, ...unbudgeted], launchEnv) > argMax, "a 64 KiB section would have exceeded it");
  } finally {
    for (const name of padNames) delete process.env[name];
    process.env.MISSION_PI_BIN = previousPi;
  }
});

test("Pi's launch argument: when ARG_MAX cannot be measured near the limit, the worker still starts, with no section", async () => {
  registerLargeShaper();
  const repo = seedRepo("pi-argmax-unmeasured");
  const argMax = Number(execFileSync("/usr/bin/getconf", ["ARG_MAX"], { encoding: "utf8" }).trim());
  setFlag(false);
  const baseline = await terminalDispatch({ agent: "pi", repo, taskId: "pi-unmeasured-probe", intent: "short request" });
  assertRunning(baseline.task);
  setFlag(true);
  const env = () => ({ ...process.env, ...isolatedAgentEnvironment({ cwd: baseline.task.worktreePath!, stateHome: baseline.stateHome, extraEnv: baseline.extraEnv }) });
  const used = execBytes(["/bin/echo", ...baseline.argv], env());
  // The same environment as the measured case: about 8 KiB left, so a 64 KiB section would not fit.
  const padNames: string[] = [];
  let room = argMax - used - 8 * 1024;
  for (let n = 0; room > 64; n++) {
    const name = `MISSION_SHAPING_UNMEASURED_PAD_${n}`;
    const value = "p".repeat(Math.min(4000, room - name.length - 1 - 1 - 8));
    if (value.length <= 0) break;
    process.env[name] = value;
    padNames.push(name);
    room -= name.length + 1 + value.length + 1 + 8;
  }
  try {
    const large: ShapeTask = (input) => shapeTask(input, {
      config: shapingStore.getShapingConfig(), discovered: [], enabled: true,
      transports: Object.fromEntries(["command", "mcp", "http", "builtin"].map((id) => [id, async () => ({
        kind: "data" as const,
        data: JSON.stringify({ guidance: [1, 2, 3, 4].map((n) => ({ id: `big/${n}`, title: `Big ${n}`, body: "line of guidance\n".repeat(900) })) }),
      })])) as never,
    });
    // `getconf` failing, as `platformArgMax` reports it: no number to budget against.
    const shaped = await terminalDispatch({ agent: "pi", repo, taskId: "pi-unmeasured", intent: "short request", argMax: async () => null, shapeTask: large });
    assertRunning(shaped.task);
    assert.doesNotMatch(shaped.prompt, /## Task context/, "no section is promised without the measure");
    const record = currentShaping(shaped.task);
    assert.equal(record?.truncated, true, "the context that was not added is recorded as cut, not as degraded");
    assert.equal(record?.state, "ok");
    assert.equal(record?.limit?.bytes, 0);
    assert.match(record?.limit?.reason ?? "", /could not be measured/);
    assert.equal(getTaskShapingText("pi-unmeasured"), null);
    // And the kernel agrees the launch is the one that works today.
    const launchEnv = { ...process.env, ...isolatedAgentEnvironment({ cwd: shaped.task.worktreePath!, stateHome: shaped.stateHome, extraEnv: shaped.extraEnv }) };
    const ran = spawnSync("/bin/echo", shaped.argv, { env: launchEnv, stdio: "ignore" });
    assert.equal(ran.error, undefined, `the launch executes (${ran.error?.message})`);
    assert.equal(ran.status, 0);
    const unbudgeted = [...shaped.argv.slice(0, -1), `${shaped.argv.at(-1)}${"z".repeat(64 * 1024)}`];
    assert.ok(execBytes(["/bin/echo", ...unbudgeted], launchEnv) > argMax, "an unbudgeted 64 KiB section would have exceeded it");
  } finally {
    for (const name of padNames) delete process.env[name];
  }
});

// ---- superseded and cancelled launches, and the step's own failures ----

/** A supervisor whose `start` waits until the test releases it. */
function heldSupervisor(registry: InstanceType<typeof Registry>) {
  const starts: Parameters<SdkSupervisor["start"]>[0][] = [];
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let reached!: () => void;
  const atStart = new Promise<void>((resolve) => { reached = resolve; });
  const supervisor = {
    starts,
    async start(input: Parameters<SdkSupervisor["start"]>[0]): Promise<Session> {
      starts.push(input);
      reached();
      await released;
      return registry.registerSdkSession({ id: input.sessionId ?? `sdk:${++seq}`, agent: input.agent, name: input.name, cwd: input.cwd });
    },
    async stop(): Promise<void> {},
    taskLiveness: () => null,
  };
  return { supervisor: supervisor as typeof supervisor & SdkSupervisor, release, atStart };
}

test("a launch a later dispatch replaced never overwrites the record its successor delivered", async () => {
  setHarnessesConfig({ sessionRuntime: { codex: "sdk" } });
  const repo = seedRepo("superseded");
  const registry = new Registry();
  registry.upsertTask(mkTask({ id: "superseded", status: "dispatching", repoRoot: repo, title: "Shaping", intent: "do it", agent: "codex" }));
  const held = heldSupervisor(registry);
  const dispatcher = new Dispatcher(registry, async () => {}, {
    supervisor: held.supervisor, missionMcpDescriptor: async () => MISSION_DESCRIPTOR,
    verifyMissionMcpTools: async () => ({ ok: true }),
    shapeTask: standIn(`${SHAPING_SECTION_PREAMBLE}\n\n### Acme guidance: First\nfirst launch`).shapeTask,
  });
  const first = dispatcher.dispatch("superseded");
  await held.atStart;
  // The operator cancels it and dispatches again while its driver is still starting.
  registry.upsertTask({ ...registry.getTask("superseded")!, status: "cancelled" });
  const second = await sdkDispatch({ agent: "codex", repo, taskId: "superseded", intent: "do it", registry, shapeTask: standIn(SECTION).shapeTask });
  assertRunning(second.task);
  const delivered = { record: getDurableTask("superseded")?.shaping, text: getTaskShapingText("superseded")?.text };
  assert.equal(delivered.text, SECTION, "the successor's launch recorded its own context");
  held.release();
  await first;
  assert.deepEqual(getDurableTask("superseded")?.shaping, delivered.record, "the replaced launch wrote nothing");
  assert.equal(getTaskShapingText("superseded")?.text, SECTION);
});

test("a launch cancelled while its driver started records nothing", async () => {
  setHarnessesConfig({ sessionRuntime: { codex: "sdk" } });
  const repo = seedRepo("cancelled-start");
  const registry = new Registry();
  registry.upsertTask(mkTask({ id: "cancelled-start", status: "dispatching", repoRoot: repo, title: "Shaping", intent: "do it", agent: "codex" }));
  const held = heldSupervisor(registry);
  const run = new Dispatcher(registry, async () => {}, {
    supervisor: held.supervisor, missionMcpDescriptor: async () => MISSION_DESCRIPTOR,
    verifyMissionMcpTools: async () => ({ ok: true }), shapeTask: standIn(SECTION).shapeTask,
  }).dispatch("cancelled-start");
  await held.atStart;
  registry.upsertTask({ ...registry.getTask("cancelled-start")!, status: "cancelled" });
  held.release();
  await run;
  assert.equal(getDurableTask("cancelled-start")?.shaping, undefined, "a stopped driver's launch is not a delivery");
  assert.equal(getTaskShapingText("cancelled-start"), null);
});

test("a workflow lookup that throws neither stops the launch nor reaches it with the flag off", async () => {
  const repo = seedRepo("workflow-lookup");
  for (const enabled of [true, false]) {
    setFlag(enabled);
    const probe = standIn("");
    const registry = new Registry();
    const taskId = `wf-${enabled}`;
    registry.upsertTask(mkTask({ id: taskId, status: "dispatching", repoRoot: repo, title: "Shaping", intent: "do it",
      agent: "claude", workflowId: "wf_review" }));
    let looked = 0;
    const run = await terminalDispatch({
      agent: "claude", repo, taskId, intent: "do it", registry, shapeTask: probe.shapeTask,
      workflowName: () => { looked += 1; throw new Error("the workflow store is unreadable"); },
    });
    assertRunning(run.task);
    if (enabled) {
      assert.equal(looked, 1, "asked only once shaping runs");
      assert.deepEqual(probe.calls[0]!.context.afterWork, { workflowId: "wf_review", name: "wf_review" }, "the id stands in for the name");
    } else {
      assert.equal(looked, 0, "with the flag off nothing is asked");
    }
  }
  setFlag(true);
});

test("the engine runs on the config snapshot the step's budget and deadline were taken from", async () => {
  const repo = seedRepo("snapshot");
  assert.equal(shapingStore.applyShapingIntent({ kind: "settings", limits: { deadlineMs: 4000 } }).ok, true);
  const seenConfigs: unknown[] = [];
  const shapeTask: ShapeTask = async (_input, deps) => {
    seenConfigs.push(deps?.config?.limits.deadlineMs);
    // The operator changes the deadline while the step runs; this run keeps its own snapshot.
    assert.equal(shapingStore.applyShapingIntent({ kind: "settings", limits: { deadlineMs: 60_000 } }).ok, true);
    return { summary: null, section: "", entries: [] };
  };
  const run = await terminalDispatch({ agent: "claude", repo, taskId: "snapshot", intent: "do it", shapeTask });
  assertRunning(run.task);
  assert.deepEqual(seenConfigs, [4000]);
});

test("Pi's launch message uses the memory pointer its budget measured, even if an index appears while shapers run", async () => {
  const repo = seedRepo("pi-pointer");
  let worktree = "";
  const shapeTask: ShapeTask = async (input) => {
    worktree = input.context.repositories[0]!.path!;
    // The checkout gains a memory index after the budget was taken.
    mkdirSync(join(worktree, ".agents", "memory"), { recursive: true });
    writeFileSync(join(worktree, MEMORY_INDEX_PATH), "# Memory index\n");
    return { summary: null, section: "", entries: [] };
  };
  const run = await terminalDispatch({ agent: "pi", repo, taskId: "pi-pointer", intent: "THE REQUEST", shapeTask });
  assertRunning(run.task);
  assert.ok(worktree, "the shaper saw the worktree");
  assert.equal(run.prompt, await unshapedExpectation(run.task, "THE REQUEST"), "no pointer the budget did not count");
});
