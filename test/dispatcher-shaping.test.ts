import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn as spawnChild, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
const { Dispatcher, dispatchLaunchArgv } = await import("../src/server/dispatcher.ts");
const { TURN_ONE_FALLBACK_REASON, TURN_ONE_UNCONFIRMED_REASON } = await import("../src/server/shaping/launch.ts");
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
const { launchArgumentTurnOne, TERMINAL_ENV_RESERVE } = await import("../src/server/turn-one-budget.ts");
const { isolatedAgentEnvironment } = await import("../src/server/agent-subprocess-env.ts");
const { sessionTraceContext } = await import("../src/server/telemetry/index.ts");
const { shapeTask } = await import("../src/server/shaping/engine.ts");
const { MEMORY_INDEX_PATH } = await import("../src/shared/memory.ts");
const { loadLaunchWorkUnits } = await import("../src/server/db.ts");
const { WORK_UNIT_ID_FLAG_ID } = await import("../src/shared/feature-flag-registry.ts");
const { WORK_UNIT_ENV_VAR } = await import("../src/shared/work-unit.ts");
const { startGuidanceHttp } = await import("./fixtures/fake-guidance-mcp.mjs");

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
  /** Turn repository task skills on (the `headless-mode` flag's seam). */
  headlessMode?: boolean;
  /**
   * Discover the agent beneath this launch's own wrapper, as a real terminal launch is, so the
   * registry installs the work unit decision it was handed as the session's launch record.
   */
  beneathWrapper?: boolean;
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
    ...(options.headlessMode ? { headlessModeEnabled: () => true } : {}),
    spawn: async (_label, _short, cwd, _bin, args, home, _backend, env, fallback) => {
      if (options.failSpawn) throw new Error("the terminal could not start");
      argv = [...(args ?? [])];
      stateHome = home ?? "";
      extraEnv = { ...env };
      // As the real wrapper does for a launch with a fallback: it ran these arguments, and says so.
      if (fallback && home) writeFileSync(`${home}.turn-one`, "shaped");
      const discovered = mkDiscovered({
        agent: options.agent, cwd, syntheticId: `sid-${options.taskId}-${seq}`,
        ...(options.beneathWrapper ? { missionLaunched: true, missionLaunchHome: home } : {}),
      });
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

test("Claude, Codex and Pi each receive their own turn one followed by the section, on the terminal and SDK runtimes", async () => {
  const repo = seedRepo("identical-text");
  const intent = "THE-OPERATOR-REQUEST";
  for (const agent of ["claude", "codex", "pi"] as const) {
    const terminal = await terminalDispatch({ agent, repo, taskId: `text-${agent}-terminal`, intent, shapeTask: standIn(SECTION).shapeTask });
    assertRunning(terminal.task);
    assert.equal(terminal.prompt, `${await unshapedExpectation(terminal.task, intent)}\n\n${SECTION}`, `${agent} · terminal`);
    const sdk = await sdkDispatch({ agent, repo, taskId: `text-${agent}-sdk`, intent, shapeTask: standIn(SECTION).shapeTask });
    assertRunning(sdk.task);
    assert.equal(sdk.start!.prompt, `${await unshapedExpectation(sdk.task, intent)}\n\n${SECTION}`, `${agent} · sdk`);
  }
});

test("a shaped launch with a repository task skill orders turn one as kind contract, task context, skill", async () => {
  const repo = seedRepo("task-skill-order");
  mkdirSync(join(repo, ".claude", "skills", "ship"), { recursive: true });
  writeFileSync(join(repo, ".claude", "skills", "ship", "SKILL.md"), "Run the focused tests before pushing.\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "ship skill"]);
  const intent = "THE-OPERATOR-REQUEST";
  // Unshaped, the launch is what it is today: the skill follows the kind contract.
  setFlag(false);
  const unshaped = await terminalDispatch({ agent: "claude", repo, taskId: "skill-unshaped", intent, headlessMode: true });
  assertRunning(unshaped.task);
  setFlag(true);
  const contract = await unshapedExpectation(unshaped.task, intent);
  assert.ok(unshaped.prompt.startsWith(contract), "the kind contract leads");
  const skill = unshaped.prompt.slice(contract.length);
  assert.match(skill, /^\n\nThis repository adds the following ship skill\.[\s\S]*Run the focused tests before pushing\./);
  // Shaped, the section sits between the two: kind contract, task context, repository task skill.
  const shaped = await terminalDispatch({ agent: "claude", repo, taskId: "skill-shaped", intent, headlessMode: true, shapeTask: standIn(SECTION).shapeTask });
  assertRunning(shaped.task);
  assert.equal(shaped.prompt, `${await unshapedExpectation(shaped.task, intent)}\n\n${SECTION}${skill}`);
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

test("Pi's launch argument: an environment that leaves little room under ARG_MAX delivers what fits and never produces E2BIG", async () => {
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
  // A turn one well under the per-argument limit, and an environment that leaves it the terminal
  // reserve plus about 24 KiB: room for part of a 64 KiB section, not all of it.
  setFlag(false);
  const baseline = await terminalDispatch({ agent: "pi", repo, taskId: "pi-env-probe", intent: "short request" });
  assertRunning(baseline.task);
  setFlag(true);
  const env = () => ({ ...process.env, ...isolatedAgentEnvironment({ cwd: baseline.task.worktreePath!, stateHome: baseline.stateHome, extraEnv: baseline.extraEnv }) });
  const used = execBytes([piScript, ...baseline.argv], env());
  // Many ordinary-sized variables rather than one huge one, the way a real environment fills up.
  const padNames: string[] = [];
  let room = argMax - used - (TERMINAL_ENV_RESERVE + 24 * 1024);
  for (let n = 0; room > 64; n++) {
    const name = `MISSION_SHAPING_TEST_PAD_${n}`;
    const value = "p".repeat(Math.min(4000, room - name.length - 1 - 1 - 8));
    if (value.length <= 0) break;
    process.env[name] = value;
    padNames.push(name);
    room -= name.length + 1 + value.length + 1 + 8;
  }
  try {
    // This one shaper answers in-process - the real engine, allocator and budget, with 64 KiB to
    // cut - so nothing but the launch itself runs under the padded environment.
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
    assert.match(record?.limit?.reason ?? "", /arguments and environment/, JSON.stringify(record));
    // Part of the section was delivered: what the measured room allowed, not all four entries and
    // not none of them.
    assert.ok(shaped.prompt.includes("## Task context"), "the launch argument carries shaped context");
    assert.ok((record?.entries ?? 0) >= 1 && (record?.entries ?? 0) < 4, `some of the four entries (${record?.entries})`);
    assert.ok((record?.limit?.bytes ?? 0) > 0 && (record?.bytes ?? 0) <= record!.limit!.bytes, "within the room the budget measured");
    assert.equal(getTaskShapingText("pi-env")?.text, shaped.prompt.slice(shaped.prompt.indexOf("## Task context")), "and that is what was recorded as delivered");
    const launchEnv = { ...process.env, ...isolatedAgentEnvironment({ cwd: shaped.task.worktreePath!, stateHome: shaped.stateHome, extraEnv: shaped.extraEnv }) };
    assert.ok(execBytes([piScript, ...shaped.argv], launchEnv) <= argMax, "within the combined limit as the budget counts it");
    // And the kernel agrees: the exact argv and environment execute.
    const ran = spawnSync(piScript, shaped.argv, { env: launchEnv, stdio: "ignore" });
    assert.equal(ran.error, undefined, `the launch executes (${ran.error?.message})`);
    assert.equal(ran.status, 0);
    // And the cut kept the terminal's reserve free: a pane environment up to that size still fits.
    assert.ok(execBytes([piScript, ...shaped.argv], launchEnv) <= argMax - TERMINAL_ENV_RESERVE, "the reserve was left for the terminal");
  } finally {
    for (const name of padNames) delete process.env[name];
    process.env.MISSION_PI_BIN = previousPi;
  }
});

test("Pi's launch argument: the budget counts the WORK_UNIT_ID the launch exports, and the cut launch fits that environment", async (t) => {
  registerLargeShaper();
  const repo = seedRepo("pi-argmax-work-unit");
  const argMax = Number(execFileSync("/usr/bin/getconf", ["ARG_MAX"], { encoding: "utf8" }).trim());
  // Fill the environment to leave the terminal reserve plus about 24 KiB, as above, measured from
  // a launch that carries the work unit, so a 64 KiB section has to be cut.
  setFlag(false);
  setWorkUnitPreview(true);
  t.after(() => setWorkUnitPreview(false));
  const probeRegistry = new Registry();
  seedTask(probeRegistry, "pi-wu-probe", repo, "pi", WU_A);
  const baseline = await terminalDispatch({ agent: "pi", repo, taskId: "pi-wu-probe", intent: "short request", registry: probeRegistry });
  assertRunning(baseline.task);
  assert.equal(baseline.extraEnv[WORK_UNIT_ENV_VAR], WU_A);
  setFlag(true);
  const env = () => ({ ...process.env, ...isolatedAgentEnvironment({ cwd: baseline.task.worktreePath!, stateHome: baseline.stateHome, extraEnv: baseline.extraEnv }) });
  const used = execBytes(["/bin/echo", ...baseline.argv], env());
  const padNames: string[] = [];
  let room = argMax - used - (TERMINAL_ENV_RESERVE + 24 * 1024);
  for (let n = 0; room > 64; n++) {
    const name = `MISSION_SHAPING_WU_PAD_${n}`;
    const value = "p".repeat(Math.min(4000, room - name.length - 1 - 1 - 8));
    if (value.length <= 0) break;
    process.env[name] = value;
    padNames.push(name);
    room -= name.length + 1 + value.length + 1 + 8;
  }
  const large: ShapeTask = (input) => shapeTask(input, {
    config: shapingStore.getShapingConfig(), discovered: [], enabled: true,
    transports: Object.fromEntries(["command", "mcp", "http", "builtin"].map((id) => [id, async () => ({
      kind: "data" as const,
      data: JSON.stringify({ guidance: [1, 2, 3, 4].map((n) => ({ id: `big/${n}`, title: `Big ${n}`, body: `${"line of guidance\n".repeat(900)}` })) }),
    })])) as never,
  });
  try {
    // The same launch twice under the same environment, its ids the same length, once with the
    // work unit and once without: the only difference the budget may see is that one variable.
    const launch = async (taskId: string, preview: boolean) => {
      setWorkUnitPreview(preview);
      const registry = new Registry();
      seedTask(registry, taskId, repo, "pi", WU_A);
      const run = await terminalDispatch({ agent: "pi", repo, taskId, intent: "short request", registry, argMax: async () => argMax, shapeTask: large });
      assertRunning(run.task);
      return run;
    };
    const withUnit = await launch("pi-wu-on", true);
    const without = await launch("pi-wu-no", false);
    assert.equal(withUnit.extraEnv[WORK_UNIT_ENV_VAR], WU_A, "the launch exports the work unit");
    assert.equal(without.extraEnv[WORK_UNIT_ENV_VAR], undefined);
    const roomOf = (run: Run) => {
      const record = currentShaping(run.task);
      assert.match(record?.limit?.reason ?? "", /arguments and environment/, JSON.stringify(record));
      // Cut at the boundary: some of the four entries, within the room the budget measured.
      assert.ok((record?.entries ?? 0) >= 1 && (record?.entries ?? 0) < 4, `some of the four entries (${record?.entries})`);
      assert.ok((record?.bytes ?? 0) <= record!.limit!.bytes, "within the measured room");
      return record!.limit!.bytes;
    };
    // What exec charges for `WORK_UNIT_ID=<id>`: its bytes, the terminating NUL and its pointer.
    const variableBytes = Buffer.byteLength(`${WORK_UNIT_ENV_VAR}=${WU_A}`) + 1 + 8;
    assert.equal(roomOf(without) - roomOf(withUnit), variableBytes, "the budget measured the variable the launch exports");
    // And the cut launch fits the environment it was actually handed, the work unit included.
    const launchEnv = { ...process.env, ...isolatedAgentEnvironment({ cwd: withUnit.task.worktreePath!, stateHome: withUnit.stateHome, extraEnv: withUnit.extraEnv }) };
    assert.equal(launchEnv[WORK_UNIT_ENV_VAR], WU_A);
    assert.ok(withUnit.prompt.includes("## Task context"), "part of the section was delivered");
    assert.ok(execBytes(["/bin/echo", ...withUnit.argv], launchEnv) <= argMax - TERMINAL_ENV_RESERVE, "within the limit, the reserve left");
    const ran = spawnSync("/bin/echo", withUnit.argv, { env: launchEnv, stdio: "ignore" });
    assert.equal(ran.error, undefined, `the launch executes (${ran.error?.message})`);
  } finally {
    for (const name of padNames) delete process.env[name];
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

test("Pi's launch argument: a terminal whose own environment leaves too little room launches the original prompt, recorded as degraded", async () => {
  registerLargeShaper();
  const repo = seedRepo("pi-pane-env");
  const dir = join(home, "pi-pane-env");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, "launched");
  // A stand-in Pi that records the turn one it was launched with and exits at once - before the
  // dispatcher looks - so its wrapper has already removed the state home by then.
  const piScript = join(dir, "pi");
  writeFileSync(piScript, [
    "#!/bin/sh",
    `for last in "$@"; do :; done`,
    `printf '%s' "$last" > '${out}'`,
    "",
  ].join("\n"), { mode: 0o755 });
  const previousPi = process.env.MISSION_PI_BIN;
  process.env.MISSION_PI_BIN = piScript;
  const argMax = Number(execFileSync("/usr/bin/getconf", ["ARG_MAX"], { encoding: "utf8" }).trim());
  // The terminal server's environment: the daemon's, plus variables of its own the daemon never
  // sees, filling all but about 40 KiB of the limit. The daemon's budget, which sees only its
  // own environment and its reserve, admits a 64 KiB section.
  const count = (value: string) => Buffer.byteLength(value) + 1 + 8;
  const pane: Record<string, string> = { ...(process.env as Record<string, string>) };
  let used = Object.entries(pane).reduce((sum, [name, value]) => sum + count(`${name}=${value}`), 0) + 16 * 1024;
  for (let n = 0; argMax - used > 40 * 1024 + 4096; n++) {
    const name = `TERMINAL_SERVER_PAD_${n}`;
    pane[name] = "p".repeat(4000);
    used += count(`${name}=${pane[name]}`);
  }
  let child: ChildProcess | null = null;
  let launched: string[] = [];
  let launchHome = "";
  const registry = new Registry();
  registry.upsertTask(mkTask({ id: "pi-pane-env", status: "dispatching", repoRoot: repo, title: "Shaping", intent: "short request", agent: "pi" }));
  try {
    await new Dispatcher(registry, async () => {}, {
      resolveRuntime: () => "terminal",
      missionMcpDescriptor: async () => MISSION_DESCRIPTOR,
      verifyMissionMcpTools: async () => ({ ok: true }),
      piExtensionInstalled: () => true,
      // The real wrapper, run by a shell under the pane's environment, as a terminal server runs it.
      spawn: async (_label, _short, cwd, bin, args, stateHome, _backend, extraEnv, fallback) => {
        launched = [bin, ...(args ?? [])];
        launchHome = stateHome!;
        const argv = dispatchLaunchArgv(cwd, bin, args ?? [], stateHome!, extraEnv ?? {}, fallback ?? null);
        const wrapper = spawnChild(argv[0]!, argv.slice(1), { env: pane, stdio: "ignore" });
        child = wrapper;
        await new Promise((resolve) => wrapper.once("exit", resolve));
        assert.equal(existsSync(stateHome!), false, "Pi has exited and its wrapper removed the state home");
        const discovered = mkDiscovered({ agent: "pi", cwd, syntheticId: `sid-pi-pane-env-${++seq}` });
        registry.applyDiscovery([discovered]);
        registry.applyHook({ agent: "pi", event: "SessionStart", sessionId: `native-pi-pane-env-${seq}`, cwd, transcriptPath: null,
          env: { tmuxPane: (discovered.terminals[0] as { paneId: string }).paneId } });
        return { homeName: `home-pi-pane-env-${seq}`, homeBackend: "tmux", terminalResourceId: null, launchStateHome: stateHome! };
      },
      inject: async () => { throw new Error("Pi's turn one travels in its launch argument"); },
    }).dispatch("pi-pane-env");
    const task = registry.getTask("pi-pane-env")!;
    assertRunning(task);
    // The failure this guards against, through the same launch: the shaped exec is refused in
    // that environment.
    assert.ok(launched.at(-1)!.includes("## Task context"), "the daemon's budget admitted a section");
    assert.throws(() => execFileSync(launched[0]!, launched.slice(1), { env: pane, stdio: "ignore" }),
      (error: NodeJS.ErrnoException) => error.code === "E2BIG");
    // What ran instead: the original turn one, in the same conversation.
    assert.equal(readFileSync(out, "utf8"), await unshapedExpectation(task, "short request"));
    assert.equal(existsSync(`${launchHome}.turn-one`), false, "the dispatcher consumed the wrapper's answer");
    // And the record says so, rather than claiming context that never arrived.
    const record = currentShaping(task);
    assert.equal(record?.state, "degraded");
    assert.equal(record?.entries, 0);
    assert.equal(record?.bytes, 0);
    assert.equal(record?.truncated, true);
    assert.deepEqual(record?.limit, { bytes: 0, reason: TURN_ONE_FALLBACK_REASON });
    assert.equal(record?.shapers[0]?.outcome, "ok", "the shaper itself answered");
    assert.equal(getTaskShapingText("pi-pane-env"), null, "no delivered text is kept");
  } finally {
    if (child) {
      const exited = child as ChildProcess;
      if (exited.exitCode === null && exited.signalCode === null) await new Promise((resolve) => exited.once("exit", resolve));
    }
    process.env.MISSION_PI_BIN = previousPi;
  }
});

test("a Pi outcome file that cannot be removed never fails a launched dispatch", async () => {
  const repo = seedRepo("pi-outcome-cleanup");
  const registry = new Registry();
  registry.upsertTask(mkTask({ id: "pi-outcome-cleanup", status: "dispatching", repoRoot: repo, title: "Shaping", intent: "short request", agent: "pi" }));
  let outcome = "";
  const warn = console.warn;
  const warnings: unknown[] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args[0]); };
  try {
    await new Dispatcher(registry, async () => {}, {
      resolveRuntime: () => "terminal",
      missionMcpDescriptor: async () => MISSION_DESCRIPTOR,
      verifyMissionMcpTools: async () => ({ ok: true }),
      piExtensionInstalled: () => true,
      argMax: async () => 2_000_000,
      shapeTask: standIn(SECTION).shapeTask,
      spawn: async (_label, _short, cwd, _bin, _args, stateHome, _backend, _env, fallback) => {
        assert.ok(fallback, "a shaped Pi launch carries its fallback");
        // The wrapper's answer, in a form the cleanup cannot remove: a non-empty directory.
        outcome = `${stateHome}.turn-one`;
        mkdirSync(join(outcome, "held"), { recursive: true });
        const discovered = mkDiscovered({ agent: "pi", cwd, syntheticId: `sid-pi-outcome-${++seq}` });
        registry.applyDiscovery([discovered]);
        registry.applyHook({ agent: "pi", event: "SessionStart", sessionId: `native-pi-outcome-${seq}`, cwd, transcriptPath: null,
          env: { tmuxPane: (discovered.terminals[0] as { paneId: string }).paneId } });
        return { homeName: `home-pi-outcome-${seq}`, homeBackend: "tmux", terminalResourceId: null };
      },
      inject: async () => { throw new Error("Pi's turn one travels in its launch argument"); },
    }).dispatch("pi-outcome-cleanup");
  } finally {
    console.warn = warn;
  }
  assertRunning(registry.getTask("pi-outcome-cleanup")!);
  assert.ok(existsSync(outcome), "the file could not be removed");
  assert.ok(warnings.some((w) => /could not remove task pi-outcome-cleanup's launch outcome file/.test(String(w))), "and that was logged");
  // An unreadable answer is never taken as delivered, nor as a confirmed fallback.
  const record = currentShaping(registry.getTask("pi-outcome-cleanup")!);
  assert.equal(record?.state, "degraded");
  assert.equal(record?.entries, 0);
  assert.deepEqual(record?.limit, { bytes: 0, reason: TURN_ONE_UNCONFIRMED_REASON });
  rmSync(outcome, { recursive: true, force: true });
});

test("a launch measurement or a final check that never settles cannot hold the launch past the step's deadline", async () => {
  const { shapeLaunch } = await import("../src/server/shaping/launch.ts");
  assert.equal(shapingStore.applyShapingIntent({ kind: "settings", limits: { deadlineMs: 200 } }).ok, true);
  const never = new Promise<never>(() => {});
  const base = {
    workflowName: () => null, trace: null, workUnitId: null, turnOnes: ["do it"], stillDispatching: () => true, onShaping: () => {},
  };
  // The measurement of a Pi launch argument hangs: the launch goes ahead with no section.
  const pi = mkTask({ id: "stall-measure", status: "dispatching", repoRoot: seedRepo("stall-measure"), title: "Shaping", intent: "do it", agent: "pi" });
  const probe = standIn(SECTION);
  let started = performance.now();
  const measured = await shapeLaunch({ ...base, task: pi, runtime: "terminal", delivery: launchArgumentTurnOne("darwin"),
    launch: () => never }, { shapeTask: probe.shapeTask, enabled: true });
  assert.ok(performance.now() - started < 5_000, "the step settled within its deadline");
  // With no measurement the budget promises no room, which the engine is told (it cuts to it).
  assert.equal(probe.calls[0]?.maxSectionBytes, 0, "and no section was promised room it could not measure");
  assert.match(measured.summary?.limit?.reason ?? "", /could not be measured/);
  // The final paste check hangs after the engine answered: the section is dropped, and the record says why.
  const claude = mkTask({ id: "stall-check", status: "dispatching", repoRoot: seedRepo("stall-check"), title: "Shaping", intent: "do it", agent: "claude" });
  started = performance.now();
  const checked = await shapeLaunch({ ...base, task: claude, runtime: "terminal", delivery: HARNESSES.claude.turnOne.terminal,
    launch: null, finalCheck: () => never }, { shapeTask: standIn(SECTION).shapeTask, enabled: true });
  assert.ok(performance.now() - started < 8_000, "the step settled within its deadline and the check's own bound");
  assert.equal(checked.section, "");
  assert.equal(checked.summary?.entries, 0);
  assert.match(checked.summary?.limit?.reason ?? "", /final check of turn one .* did not finish in time/);
  assert.equal(checked.summary?.state, "degraded", "a check that never answered is a failure, not a size limit");
  // One that throws is degraded too; one that answers "does not fit" keeps the record's own state.
  const threw = await shapeLaunch({ ...base, task: claude, runtime: "terminal", delivery: HARNESSES.claude.turnOne.terminal,
    launch: null, finalCheck: async () => { throw new Error("osascript is missing"); } }, { shapeTask: standIn(SECTION).shapeTask, enabled: true });
  assert.equal(threw.summary?.state, "degraded");
  assert.match(threw.summary?.limit?.reason ?? "", /final check of turn one failed \(osascript is missing\)/);
  const unfit = await shapeLaunch({ ...base, task: claude, runtime: "terminal", delivery: HARNESSES.claude.turnOne.terminal,
    launch: null, finalCheck: async () => "it would not fit" }, { shapeTask: standIn(SECTION).shapeTask, enabled: true });
  assert.equal(unfit.summary?.state, "ok", "a size limit is truncation, not degradation");
  assert.equal(unfit.summary?.truncated, true);
});

test("a dispatch that ended while its launch was being measured starts no shaper", async () => {
  const { shapeLaunch } = await import("../src/server/shaping/launch.ts");
  const task = mkTask({ id: "measure-cancel", status: "dispatching", repoRoot: seedRepo("measure-cancel"), title: "Shaping", intent: "do it", agent: "pi" });
  let dispatching = true;
  const probe = standIn(SECTION);
  const marks: boolean[] = [];
  const shaped = await shapeLaunch({
    task, runtime: "terminal", workflowName: () => null, trace: null, workUnitId: null, delivery: launchArgumentTurnOne("darwin"),
    turnOnes: ["do it"],
    // The cancel lands while the launch is being measured.
    launch: async () => { dispatching = false; return { otherArgs: ["/p"], env: {}, argMax: 1_048_576 }; },
    stillDispatching: () => dispatching, onShaping: (active) => { marks.push(active); },
  }, { shapeTask: probe.shapeTask, enabled: true });
  assert.equal(probe.calls.length, 0, "no shaper ran");
  assert.deepEqual(shaped, { summary: null, section: "" });
  assert.deepEqual(marks, [], "and no Shaping context mark was raised");
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

/** A supervisor that records each start and holds it until the test releases them all. */
function gatedSupervisor(registry: InstanceType<typeof Registry>) {
  const starts: Parameters<SdkSupervisor["start"]>[0][] = [];
  /** The session each start returned, in start order, once it returned. */
  const sessions: string[] = [];
  const stopped: string[] = [];
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const gates: Array<() => void> = [];
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  const supervisor = {
    starts,
    async start(input: Parameters<SdkSupervisor["start"]>[0]): Promise<Session> {
      const index = starts.push(input) - 1;
      const own = new Promise<void>((resolve) => { gates[index] = resolve; });
      for (const waiter of waiters) if (starts.length >= waiter.count) waiter.resolve();
      await Promise.race([released, own]);
      const session = registry.registerSdkSession({ id: input.sessionId ?? `sdk:${++seq}`, agent: input.agent, name: input.name, cwd: input.cwd });
      sessions[index] = session.id;
      return session;
    },
    async stop(id: string): Promise<void> { stopped.push(id); },
    taskLiveness: () => null,
  };
  const reached = (count: number) => new Promise<void>((resolve) => {
    if (starts.length >= count) resolve();
    else waiters.push({ count, resolve });
  });
  /** Let one start, by its order, return while the others stay held. */
  const releaseOne = (index: number) => gates[index]!();
  return { supervisor: supervisor as typeof supervisor & SdkSupervisor, release, releaseOne, reached, sessions, stopped };
}

/** Both attempts of one task through the SAME dispatcher, as a cancel and a redispatch run them. */
function sameDispatcher(taskId: string, repo: string, shapeTask: ShapeTask) {
  setHarnessesConfig({ sessionRuntime: { codex: "sdk" } });
  const registry = new Registry();
  registry.upsertTask(mkTask({ id: taskId, status: "dispatching", repoRoot: repo, title: "Shaping", intent: "do it", agent: "codex" }));
  const gate = gatedSupervisor(registry);
  const dispatcher = new Dispatcher(registry, async () => {}, {
    supervisor: gate.supervisor, missionMcpDescriptor: async () => MISSION_DESCRIPTOR,
    verifyMissionMcpTools: async () => ({ ok: true }), shapeTask,
  });
  const redispatch = () => {
    registry.upsertTask({ ...registry.getTask(taskId)!, status: "cancelled" });
    registry.upsertTask({ ...registry.getTask(taskId)!, status: "dispatching", sessionId: null, worktreePath: null, branch: null });
    return dispatcher.dispatch(taskId);
  };
  return { registry, gate, dispatcher, redispatch };
}

const FIRST_SECTION = `${SHAPING_SECTION_PREAMBLE}\n\n### Acme guidance: First\nfirst launch`;

test("a launch a later dispatch replaced never overwrites the record its successor delivered", async () => {
  let calls = 0;
  const first = standIn(FIRST_SECTION).shapeTask;
  const second = standIn(SECTION).shapeTask;
  const run = sameDispatcher("superseded", seedRepo("superseded"), (input, deps) => (++calls === 1 ? first : second)(input, deps));
  const original = run.dispatcher.dispatch("superseded");
  // The operator cancels and dispatches again while the first driver is still starting.
  await run.gate.reached(1);
  const replacement = run.redispatch();
  await run.gate.reached(2);
  // The first driver comes up while its replacement is still starting, with the task back in
  // `dispatching`: its worker is stopped and never bound to the task.
  run.gate.releaseOne(0);
  await original;
  const firstSession = run.gate.sessions[0]!;
  assert.deepEqual(run.gate.stopped, [firstSession], "the superseded worker alone was stopped");
  assert.equal(run.registry.getTask("superseded")?.status, "dispatching", "the replacement still owns the launch");
  assert.notEqual(run.registry.getTask("superseded")?.sessionId, firstSession, "the superseded worker was never bound");
  assert.equal(getTaskShapingText("superseded"), null, "and recorded nothing");
  run.gate.releaseOne(1);
  await replacement;
  assertRunning(run.registry.getTask("superseded")!);
  assert.equal(run.registry.getTask("superseded")?.sessionId, run.gate.sessions[1], "the replacement's worker is the task's");
  assert.deepEqual(run.gate.stopped, [firstSession]);
  assert.equal(getTaskShapingText("superseded")?.text, SECTION, "only the successor's launch recorded its context");
  assert.equal(currentShaping(getDurableTask("superseded")!)?.entries, 1);
});

test("an embedded launch replaced while its start was being prepared never reaches the supervisor", async () => {
  setHarnessesConfig({ sessionRuntime: { codex: "sdk" } });
  const repo = seedRepo("replaced-prestart");
  const taskId = "replaced-prestart";
  const registry = new Registry();
  registry.upsertTask(mkTask({ id: taskId, status: "dispatching", repoRoot: repo, title: "Shaping", intent: "do it", agent: "codex" }));
  const gate = gatedSupervisor(registry);
  let descriptors = 0;
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstPreparing!: () => void;
  const preparing = new Promise<void>((resolve) => { firstPreparing = resolve; });
  const dispatcher = new Dispatcher(registry, async () => {}, {
    supervisor: gate.supervisor, verifyMissionMcpTools: async () => ({ ok: true }), shapeTask: standIn(SECTION).shapeTask,
    // The first attempt's launch preparation is held; the replacement's is not.
    missionMcpDescriptor: async () => {
      if (++descriptors === 1) { firstPreparing(); await firstHeld; }
      return MISSION_DESCRIPTOR;
    },
  });
  const original = dispatcher.dispatch(taskId);
  await preparing;
  registry.upsertTask({ ...registry.getTask(taskId)!, status: "cancelled" });
  registry.upsertTask({ ...registry.getTask(taskId)!, status: "dispatching", sessionId: null, worktreePath: null, branch: null });
  const replacement = dispatcher.dispatch(taskId);
  await gate.reached(1);
  releaseFirst();
  await original;
  assert.equal(gate.supervisor.starts.length, 1, "only the replacement reached the supervisor");
  gate.release();
  await replacement;
  assertRunning(registry.getTask(taskId)!);
  assert.equal(registry.getTask(taskId)?.sessionId, gate.sessions[0]);
});

test("a dispatch replaced while its shapers ran launches nothing, and leaves the successor's mark alone", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let reachedShaping!: () => void;
  const inShaping = new Promise<void>((resolve) => { reachedShaping = resolve; });
  let calls = 0;
  const second = standIn(SECTION).shapeTask;
  const run = sameDispatcher("replaced-shaping", seedRepo("replaced-shaping"), async (input, deps) => {
    if (++calls > 1) return second(input, deps);
    reachedShaping();
    await held;
    return standIn(FIRST_SECTION).shapeTask(input, deps);
  });
  const original = run.dispatcher.dispatch("replaced-shaping");
  await inShaping;
  // Cancelled and dispatched again: the task is `dispatching` once more, under a new attempt.
  const replacement = run.redispatch();
  await run.gate.reached(1);
  // The first attempt's shapers answer now, while its successor is still starting its driver.
  release();
  await Promise.race([original, run.gate.reached(2)]);
  assert.equal(run.gate.supervisor.starts.length, 1, "the replaced attempt never reached a worker");
  run.gate.release();
  await Promise.all([original, replacement]);
  assertRunning(run.registry.getTask("replaced-shaping")!);
  assert.equal(run.registry.getTask("replaced-shaping")?.shapingContext, undefined, "no mark is left behind");
  assert.equal(getTaskShapingText("replaced-shaping")?.text, SECTION);
  // Each settled attempt releases its identity, so the map does not grow with every task.
  assert.equal((run.dispatcher as unknown as { dispatchAttempts: Map<string, symbol> }).dispatchAttempts.size, 0);
});

test("a terminal launch replaced while its prompt was being delivered retires its own home and never binds the task", async () => {
  const repo = seedRepo("replaced-terminal");
  const taskId = "replaced-terminal";
  const registry = new Registry();
  registry.upsertTask(mkTask({ id: taskId, status: "dispatching", repoRoot: repo, title: "Shaping", intent: "do it", agent: "claude" }));
  const homes: string[] = [];
  const sessions: string[] = [];
  const killed: string[] = [];
  const deliveries: Array<() => void> = [];
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  const delivering = (count: number) => new Promise<void>((resolve) => {
    if (deliveries.length >= count) resolve();
    else waiters.push({ count, resolve });
  });
  const dispatcher = new Dispatcher(registry, async () => {}, {
    resolveRuntime: () => "terminal",
    missionMcpDescriptor: async () => MISSION_DESCRIPTOR,
    verifyMissionMcpTools: async () => ({ ok: true }),
    shapeTask: standIn(SECTION).shapeTask,
    spawn: async (_label, _short, cwd) => {
      const n = homes.length;
      const nativeId = `native-replaced-terminal-${n}`;
      const discovered = mkDiscovered({ agent: "claude", cwd, syntheticId: `sid-replaced-terminal-${n}-${++seq}` });
      registry.applyDiscovery([discovered]);
      registry.applyHook({ agent: "claude", event: "SessionStart", sessionId: nativeId, cwd, transcriptPath: null,
        env: { tmuxPane: (discovered.terminals[0] as { paneId: string }).paneId } });
      homes.push(`home-replaced-terminal-${n}`);
      return { homeName: homes[n]!, homeBackend: "tmux", terminalResourceId: `multiplexer:tmux:launch-${n}-${seq}` };
    },
    inject: async (session, text) => {
      const n = sessions.push(session.id) - 1;
      // Each delivery is held until the test lets it through.
      await new Promise<void>((resolve) => {
        deliveries.push(resolve);
        for (const waiter of waiters) if (deliveries.length >= waiter.count) waiter.resolve();
      });
      registry.applyHook({ agent: "claude", event: "UserPromptSubmit", sessionId: `native-replaced-terminal-${n}`, cwd: session.cwd,
        transcriptPath: null, prompt: text, env: { tmuxPane: "%1" } });
      return { ok: true, pasted: true, submitVerified: true };
    },
    killHome: async (name) => { killed.push(name); return { ok: true, asked: true }; },
  });
  const original = dispatcher.dispatch(taskId);
  await delivering(1);
  // Cancelled and dispatched again while the first prompt is still being typed.
  registry.upsertTask({ ...registry.getTask(taskId)!, status: "cancelled" });
  registry.upsertTask({ ...registry.getTask(taskId)!, status: "dispatching", sessionId: null, worktreePath: null, branch: null,
    homeName: null, terminalResourceId: null });
  const replacement = dispatcher.dispatch(taskId);
  await delivering(2);
  // The first delivery finishes while its replacement is still delivering.
  deliveries[0]!();
  await original;
  assert.deepEqual(killed, [homes[0]], "the replaced attempt closed its own home, and only that");
  assert.equal(registry.getTask(taskId)?.status, "dispatching", "the replacement still owns the launch");
  assert.notEqual(registry.getTask(taskId)?.sessionId, sessions[0], "the replaced worker never bound the task");
  assert.equal(registry.getTask(taskId)?.homeName, homes[1], "nor overwrote the replacement's home");
  deliveries[1]!();
  await replacement;
  assertRunning(registry.getTask(taskId)!);
  assert.equal(registry.getTask(taskId)?.sessionId, sessions[1]);
  assert.deepEqual(killed, [homes[0]]);
  assert.equal(getTaskShapingText(taskId)?.text, SECTION);
});

test("a terminal launch replaced while it waited for readiness never writes its terminal onto the replacement", async () => {
  const repo = seedRepo("replaced-ready");
  const taskId = "replaced-ready";
  const registry = new Registry();
  registry.upsertTask(mkTask({ id: taskId, status: "dispatching", repoRoot: repo, title: "Shaping", intent: "do it", agent: "claude" }));
  const homes: string[] = [];
  const killed: string[] = [];
  const readyHooks: Array<() => void> = [];
  let shapingCalls = 0;
  let releaseSecondShaping!: () => void;
  const secondShapingHeld = new Promise<void>((resolve) => { releaseSecondShaping = resolve; });
  let secondInShaping!: () => void;
  const secondShaping = new Promise<void>((resolve) => { secondInShaping = resolve; });
  let firstSpawned!: () => void;
  const spawnedFirst = new Promise<void>((resolve) => { firstSpawned = resolve; });
  const dispatcher = new Dispatcher(registry, async () => {}, {
    resolveRuntime: () => "terminal",
    missionMcpDescriptor: async () => MISSION_DESCRIPTOR,
    verifyMissionMcpTools: async () => ({ ok: true }),
    shapeTask: async (input, deps) => {
      if (++shapingCalls === 2) {
        // The replacement is held in its shaping step, before it has a terminal of its own.
        secondInShaping();
        await secondShapingHeld;
      }
      return standIn(SECTION).shapeTask(input, deps);
    },
    spawn: async (_label, _short, cwd) => {
      const n = homes.length;
      const nativeId = `native-replaced-ready-${n}`;
      const discovered = mkDiscovered({ agent: "claude", cwd, syntheticId: `sid-replaced-ready-${n}-${++seq}` });
      registry.applyDiscovery([discovered]);
      const hook = () => registry.applyHook({ agent: "claude", event: "SessionStart", sessionId: nativeId, cwd, transcriptPath: null,
        env: { tmuxPane: (discovered.terminals[0] as { paneId: string }).paneId } });
      homes.push(`home-replaced-ready-${n}`);
      // The first agent proves it can read only when the test says so.
      if (n === 0) { readyHooks.push(hook); firstSpawned(); } else hook();
      return { homeName: homes[n]!, homeBackend: "tmux", terminalResourceId: null };
    },
    inject: async (session, text) => {
      registry.applyHook({ agent: "claude", event: "UserPromptSubmit", sessionId: session.agentSessionId ?? session.id, cwd: session.cwd,
        transcriptPath: null, prompt: text, env: { tmuxPane: "%1" } });
      return { ok: true, pasted: true, submitVerified: true };
    },
    killHome: async (name) => { killed.push(name); return { ok: true, asked: true }; },
  });
  const original = dispatcher.dispatch(taskId);
  await spawnedFirst;
  // Let the first attempt reach its readiness wait, then cancel and dispatch again.
  await new Promise((resolve) => setTimeout(resolve, 300));
  registry.upsertTask({ ...registry.getTask(taskId)!, status: "cancelled" });
  registry.upsertTask({ ...registry.getTask(taskId)!, status: "dispatching", sessionId: null, worktreePath: null, branch: null,
    homeName: null, terminalResourceId: null });
  const replacement = dispatcher.dispatch(taskId);
  await secondShaping;
  // The first agent becomes ready while its replacement has no terminal yet.
  readyHooks[0]!();
  await original;
  // Its spawn reported no launch identity, so nothing was closed: never a terminal by its name.
  assert.deepEqual(killed, [], "a home with no launch identity is left standing, not closed by name");
  assert.equal(registry.getTask(taskId)?.terminalResourceId ?? null, null, "and wrote no terminal onto the replacement");
  assert.equal(registry.getTask(taskId)?.homeName ?? null, null);
  releaseSecondShaping();
  await replacement;
  assertRunning(registry.getTask(taskId)!);
  assert.equal(registry.getTask(taskId)?.homeName, homes[1]);
  assert.deepEqual(killed, []);
});

test("a section the final check drops counts nothing as delivered, and keeps each shaper's outcome", async () => {
  const { shapeLaunch } = await import("../src/server/shaping/launch.ts");
  const task = mkTask({ id: "final-check", status: "dispatching", repoRoot: seedRepo("final-check"), title: "Shaping", intent: "do it", agent: "claude" });
  const shaped = await shapeLaunch({
    task, runtime: "terminal", workflowName: () => null, trace: null, workUnitId: null, delivery: HARNESSES.claude.turnOne.terminal,
    turnOnes: ["do it"], launch: null, stillDispatching: () => true, onShaping: () => {},
    finalCheck: async () => "the pane paste would not fit",
  }, { shapeTask: standIn(SECTION).shapeTask, enabled: true });
  assert.equal(shaped.section, "");
  assert.equal(shaped.summary?.state, "ok");
  assert.equal(shaped.summary?.entries, 0, "the chip counts what reached turn one");
  assert.equal(shaped.summary?.bytes, 0);
  assert.equal(shaped.summary?.truncated, true);
  assert.deepEqual(shaped.summary?.limit, { bytes: 0, reason: "the pane paste would not fit" });
  assert.equal(shaped.summary?.shapers[0]?.outcome, "ok", "the shaper still answered");
  assert.equal(shaped.summary?.shapers[0]?.entries, 0);
  assert.equal(shaped.summary?.shapers[0]?.truncated, true);
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

// ---- the work unit (work unit id, Phase 4) ----
//
// Every shaper call of a launch carries the launch's one work unit decision, the value its agent
// is started with. The oracles are the engine input the stand-in records, the environment the
// spawn is handed (or the supervisor's start input), and the launch record the registry installs.

const WU_A = "wu_01JD00000000000000000000AA";
const WU_B = "wu_01JD00000000000000000000BB";
const WU_C = "wu_01JD00000000000000000000CC";

function setWorkUnitPreview(enabled: boolean): void {
  assert.equal(flags.applyFeatureFlagIntent({ kind: "flag", id: WORK_UNIT_ID_FLAG_ID, enabled }).ok, true);
}

/** A task of work unit `workUnitId`, which the dispatch helpers then launch as it is. */
function seedTask(registry: InstanceType<typeof Registry>, id: string, repo: string, agent: "claude" | "codex" | "pi", workUnitId: string | null): void {
  registry.upsertTask(mkTask({ id, status: "dispatching", repoRoot: repo, title: "Shaping", intent: "do it", agent, workUnitId }));
}

test("a new agent's shapers carry its launch's one work unit decision, and none with the preview off or no id", async (t) => {
  t.after(() => setWorkUnitPreview(false));
  const repo = seedRepo("work-unit-new-agent");
  const cases = [
    { name: "on", preview: true, workUnitId: WU_A, expected: WU_A },
    { name: "off", preview: false, workUnitId: WU_B, expected: null },
    { name: "no-id", preview: true, workUnitId: null, expected: null },
  ] as const;
  for (const c of cases) {
    setWorkUnitPreview(c.preview);
    // A pane launch.
    const terminalRegistry = new Registry();
    seedTask(terminalRegistry, `wu-term-${c.name}`, repo, "claude", c.workUnitId);
    const probe = standIn(SECTION);
    const run = await terminalDispatch({
      agent: "claude", repo, taskId: `wu-term-${c.name}`, intent: "do it", registry: terminalRegistry, shapeTask: probe.shapeTask,
      beneathWrapper: true,
    });
    assertRunning(run.task);
    assert.equal(probe.calls.length, 1);
    assert.equal(probe.calls[0]!.workUnitId, c.expected, `${c.name}: the shaper is handed the decision`);
    assert.equal(run.extraEnv[WORK_UNIT_ENV_VAR] ?? null, c.expected, `${c.name}: the agent is started with the same value`);
    assert.equal(run.registry.getSession(run.sessionId)?.launchWorkUnitId ?? null, c.expected, `${c.name}: and its record holds it`);
    // An embedded launch.
    const sdkRegistry = new Registry();
    seedTask(sdkRegistry, `wu-sdk-${c.name}`, repo, "codex", c.workUnitId);
    const sdkProbe = standIn(SECTION);
    try {
      const sdk = await sdkDispatch({ agent: "codex", repo, taskId: `wu-sdk-${c.name}`, intent: "do it", registry: sdkRegistry, shapeTask: sdkProbe.shapeTask });
      assertRunning(sdk.task);
      assert.equal(sdkProbe.calls[0]!.workUnitId, c.expected, `${c.name}: an embedded launch's shaper too`);
      assert.equal(sdk.start!.workUnitId ?? null, c.expected, `${c.name}: and its supervisor start`);
    } finally {
      setHarnessesConfig({ sessionRuntime: { claude: "terminal", codex: "terminal", pi: "terminal" } });
    }
  }
});

test("a dispatch through the real engine gives each MCP get_guidance call the WORK_UNIT_ID its agent is started with", async (t) => {
  const GUIDANCE_FIXTURE = fileURLToPath(new URL("./fixtures/fake-guidance-mcp.mjs", import.meta.url));
  const remote = await startGuidanceHttp({ mode: "echo" });
  const daemonOwn = process.env[WORK_UNIT_ENV_VAR];
  // The daemon's own environment has one, and each shaper is configured to send one of its own:
  // neither may reach a call. Only the launch's decision does.
  process.env[WORK_UNIT_ENV_VAR] = "wu_01JD000000000000000DAEMON";
  t.after(async () => {
    setWorkUnitPreview(false);
    if (daemonOwn === undefined) delete process.env[WORK_UNIT_ENV_VAR];
    else process.env[WORK_UNIT_ENV_VAR] = daemonOwn;
    await remote.close();
  });
  const register = (shaper: unknown, id: string) => {
    assert.equal(shapingStore.applyShapingIntent(ShapingIntentSchema.parse({ kind: "upsert", shaper })).ok, true);
    assert.equal(shapingStore.applyShapingIntent({ kind: "enable", id, enabled: true }).ok, true);
  };
  register({
    id: "wu-remote", label: "Remote guidance", stage: "select", timeoutMs: 30_000,
    transport: { type: "mcp", tool: "get_guidance", server: { type: "http", url: remote.url, headers: { "x-work-unit-id": "wu-configured" } } },
  }, "wu-remote");
  register({
    id: "wu-local", label: "Local guidance", stage: "select", timeoutMs: 30_000,
    transport: { type: "mcp", tool: "get_guidance", server: { type: "stdio", command: process.execPath, args: [GUIDANCE_FIXTURE, "echo"], env: [WORK_UNIT_ENV_VAR] } },
  }, "wu-local");
  const repo = seedRepo("work-unit-mcp-end-to-end");

  for (const [name, preview, expected] of [["on", true, WU_A], ["off", false, null]] as const) {
    setWorkUnitPreview(preview);
    const registry = new Registry();
    seedTask(registry, `wu-mcp-${name}`, repo, "claude", WU_A);
    const seen = remote.requests.length;
    // No stand-in: the real engine and the real `mcp` transport, to two real servers.
    const run = await terminalDispatch({ agent: "claude", repo, taskId: `wu-mcp-${name}`, intent: "do it", registry, beneathWrapper: true });
    assertRunning(run.task);
    const agentUnit = run.extraEnv[WORK_UNIT_ENV_VAR] ?? null;
    assert.equal(agentUnit, expected, `${name}: the agent is started with the launch's decision`);
    assert.equal(run.registry.getSession(run.sessionId)?.launchWorkUnitId ?? null, expected, `${name}: and its record holds it`);

    // The streamable-HTTP server's own record: every request of the call carries the header.
    const posts = (remote.requests.slice(seen) as Array<{ method: string; headers: Record<string, string> }>).filter((r) => r.method === "POST");
    assert.ok(posts.length >= 2, `${name}: the call made its requests (${posts.length})`);
    for (const request of posts) assert.equal(request.headers["x-work-unit-id"] ?? null, agentUnit, `${name}: every request's header is the agent's value`);

    // What each server's get_guidance tool saw, echoed into the section the agent was handed.
    const text = getTaskShapingText(`wu-mcp-${name}`)?.text ?? "";
    const echoes = [...text.matchAll(/^\{"arguments".*$/gm)].map((match) => JSON.parse(match[0]) as {
      arguments: unknown; meta: Record<string, string> | null; env: Record<string, string | null>; headers: Record<string, string> | null;
    });
    assert.equal(echoes.length, 2, `${name}: both shapers answered (${text.slice(0, 300)})`);
    const overHttp = echoes.find((echo) => echo.headers);
    const local = echoes.find((echo) => !echo.headers);
    assert.ok(overHttp && local, `${name}: one call over streamable HTTP and one to a local process`);
    for (const echo of [overHttp, local]) {
      assert.equal(echo.meta?.work_unit_id ?? null, agentUnit, `${name}: tools/call params._meta.work_unit_id is the agent's value`);
      assert.equal(JSON.stringify(echo.arguments).includes("wu_"), false, `${name}: the tool's arguments carry no work unit`);
    }
    assert.equal(overHttp.headers?.["x-work-unit-id"] ?? null, agentUnit, `${name}: the tool saw the agent's value in its header`);
    assert.equal(local.env[WORK_UNIT_ENV_VAR], agentUnit, `${name}: the local server's WORK_UNIT_ID is the agent's value, never the daemon's`);
  }
});

test("a preview switch while shapers run changes neither half: the shaper and the agent hold the same value", async (t) => {
  t.after(() => setWorkUnitPreview(false));
  const repo = seedRepo("work-unit-switch-in-flight");
  for (const [name, before, expected] of [["on-to-off", true, WU_A], ["off-to-on", false, null]] as const) {
    setWorkUnitPreview(before);
    const registry = new Registry();
    seedTask(registry, `wu-switch-${name}`, repo, "claude", WU_A);
    // The switch lands after the dispatch decided and before the agent starts.
    const inner = standIn(SECTION);
    const switching: ShapeTask = async (input) => { setWorkUnitPreview(!before); return inner.shapeTask(input); };
    const run = await terminalDispatch({
      agent: "claude", repo, taskId: `wu-switch-${name}`, intent: "do it", registry, shapeTask: switching, beneathWrapper: true,
    });
    assertRunning(run.task);
    assert.equal(inner.calls[0]!.workUnitId, expected, `${name}: the shaper got the decision made before the switch`);
    assert.equal(run.extraEnv[WORK_UNIT_ENV_VAR] ?? null, expected, `${name}: the agent got that same value`);
    assert.equal(run.registry.getSession(run.sessionId)?.launchWorkUnitId ?? null, expected, `${name}: and so did its record`);
  }
});

test("shaping that succeeds before the launch fails keeps the task's id, writes no record, and a retry decides again", async (t) => {
  t.after(() => setWorkUnitPreview(false));
  const repo = seedRepo("work-unit-launch-fails");
  setWorkUnitPreview(true);
  const registry = new Registry();
  seedTask(registry, "wu-fails", repo, "claude", WU_C);
  const failed = standIn(SECTION);
  const first = await terminalDispatch({
    agent: "claude", repo, taskId: "wu-fails", intent: "do it", registry, shapeTask: failed.shapeTask, failSpawn: true, beneathWrapper: true,
  });
  assert.notEqual(first.task.status, "running", "the launch failed");
  assert.equal(failed.calls[0]!.workUnitId, WU_C, "the call made for this task's work stays tagged with the task's id");
  assert.equal(loadLaunchWorkUnits().some((row) => row.workUnitId === WU_C), false, "no launch record was written");
  assert.equal(registry.snapshot().sessions.some((session) => session.launchWorkUnitId === WU_C), false);
  // The retry is a new launch, so it decides again: the preview is off now, and nothing carries the id.
  setWorkUnitPreview(false);
  const retried = standIn(SECTION);
  const second = await terminalDispatch({
    agent: "claude", repo, taskId: "wu-fails", intent: "do it", registry, shapeTask: retried.shapeTask, beneathWrapper: true,
  });
  assertRunning(second.task);
  assert.equal(retried.calls[0]!.workUnitId, null);
  assert.equal(second.extraEnv[WORK_UNIT_ENV_VAR], undefined);
  assert.equal(second.registry.getSession(second.sessionId)?.launchWorkUnitId ?? null, null);
});
