import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import { mkMuxHandle, mkTask } from "./helpers/session-fixture.ts";
import { writeMcpFixture } from "./helpers/mcp-fixture.ts";

// The dispatcher's OWN telemetry branches, driven through `Dispatcher.dispatch` rather than by
// calling the observation helper.
//
// `telemetry-session-attribution.test.ts` proves what `observeDispatchFinished` does with a
// given set of facts. It cannot prove that the dispatcher reaches it on each of its exits, or
// that the facts it hands over are the ones that launch actually resolved - and those are
// different failures. A branch that never calls the observer leaves a silent hole in exactly
// the chart this phase exists to make trustworthy: `superseded` folded into `failed` would make
// every operator cancel look like a broken launch, and a `failed` carrying the harness default
// as though it had been chosen would put a model in the fails-to-launch column for a preflight
// refusal that had nothing to do with it.
//
// Four exits: pipeline success, terminal-runtime success, the operator settling a
// dispatch underneath it, and a failure after resolution. A real git repo and a real worktree,
// so each branch is reached the way a dispatch reaches it; only the spawn, the pane and the
// provider launch are faked.

const home = mkdtempSync(join(tmpdir(), "mission-telemetry-dispatch-"));
// Set before importing anything that resolves the state dir.
process.env.MISSION_HOME = home;
// Binaries that exist, so bin resolution is never what fails a launch here.
process.env.MISSION_CLAUDE_BIN = "/bin/echo";
process.env.MISSION_PI_BIN = "/bin/echo";

const { closeDb, openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { Dispatcher } = await import("../src/server/dispatcher.ts");
const { setHarnessesConfig } = await import("../src/server/harnesses.ts");
const { setTelemetryConfig } = await import("../src/server/telemetry/config.ts");
const { registerBuiltinTelemetry } = await import("../src/server/telemetry/service.ts");
const { attachSessionTelemetry, resetSessionTelemetryForTesting } = await import("../src/server/telemetry/sessions.ts");
const { MISSION_MCP_TOOLS } = await import("../src/server/mission-mcp.ts");

// Scout launch must pass its real MCP preflight before reaching the injected spawn failure.
// CI runs these source tests before build, so never inherit a developer's dist/ bundle.
process.env.MISSION_MCP_SERVER = writeMcpFixture(join(home, "mcp-fixture.mjs"), MISSION_MCP_TOOLS);

registerBuiltinTelemetry();

after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
  delete process.env.MISSION_CLAUDE_BIN;
  delete process.env.MISSION_PI_BIN;
  delete process.env.MISSION_MCP_SERVER;
});

beforeEach(() => {
  const d = openDb();
  for (const table of [
    "telemetry_journal",
    "telemetry_source_identities",
    "telemetry_projection_state",
    "telemetry_series",
    "telemetry_contexts",
    "telemetry_resources",
    "telemetry_gaps",
  ]) {
    d.exec(`DELETE FROM ${table}`);
  }
  d.exec("DELETE FROM app_config");
  resetSessionTelemetryForTesting();
  assert.equal(setTelemetryConfig({ enabled: true }).ok, true);
});

/** Every captured dispatch fact, in order. */
function dispatches(): Array<{ facts: Record<string, unknown>; refs: Record<string, string> }> {
  return (
    openDb()
      .prepare(
        `SELECT facts_json, refs_json FROM telemetry_journal
         WHERE name = 'mission.dispatch.finished' ORDER BY seq`,
      )
      .all() as unknown as Array<{ facts_json: string; refs_json: string }>
  ).map((r) => ({
    facts: JSON.parse(r.facts_json) as Record<string, unknown>,
    refs: JSON.parse(r.refs_json) as Record<string, string>,
  }));
}

/** Exactly one dispatch fact was captured, and here it is. */
function onlyDispatch(): { facts: Record<string, unknown>; refs: Record<string, string> } {
  const all = dispatches();
  assert.equal(all.length, 1, `expected one dispatch observation, got ${all.length}`);
  return all[0]!;
}

let seq = 0;

function seedRepo(name: string): string {
  const repo = join(home, name);
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@test"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
  writeFileSync(join(repo, "file.txt"), "base\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "base"]);
  return repo;
}

function mkDiscovered(over: Partial<DiscoveredSession> = {}): DiscoveredSession {
  const n = ++seq;
  return {
    syntheticId: `proc:ttys10${n}:${n}:0`,
    agent: "claude",
    name: "work",
    nameSource: "process",
    cwd: `/wt/task-${n}`,
    gitBranch: "harness/task",
    pid: 900 + n,
    tty: `ttys10${n}`,
    terminals: [mkMuxHandle({ session: `d${n}`, windowName: "w", windowIndex: 0, paneId: `%9${n}` })],
    startedAt: 0,
    ...over,
  } as DiscoveredSession;
}

// ---- the successful exits ----

// Every precedence tier goes through a real dispatch, including the no-flag harness fallback.
for (const [tier, taskModel, launchModel, kindModel, defaultModel, expectedModel] of [
  ["task", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5", "claude-opus-4-8", "claude-opus-5"],
  ["automation", null, "claude-sonnet-5", "claude-haiku-4-5", "claude-opus-4-8", "claude-sonnet-5"],
  ["kind", null, null, "claude-haiku-4-5", "claude-opus-4-8", "claude-haiku-4-5"],
  ["harness_default", null, null, null, "claude-opus-4-8", "claude-opus-4-8"],
  ["harness", null, null, null, null, null],
] as const) {
  test(`a terminal launch uses and reports the model from the ${tier} tier`, async () => {
    const repo = seedRepo(`terminal-${tier}`);
    setHarnessesConfig({
      defaultModel: { claude: defaultModel },
      kindDefaults: { ship: { agent: "claude", model: kindModel } },
    });
    const registry = new Registry();
    registry.upsertTask(
      mkTask({
        id: "task-terminal",
        status: "dispatching",
        repoRoot: repo,
        title: "Terminal attribution",
        intent: "exercise the terminal dispatch branch",
        agent: "claude",
        kind: "ship",
        model: taskModel,
        effort: "high",
      }),
    );

    let worktree: string | null = null;
    let launchedModel: string | null | undefined;
    const dispatcher = new Dispatcher(registry, async () => {}, {
      resolveRuntime: () => "terminal",
      missionMcpDescriptor: async () => null,
      spawn: async (_label, _short, cwd, _bin, args = []) => {
        const modelFlag = args.indexOf("--model");
        launchedModel = modelFlag < 0 ? null : args[modelFlag + 1];
        worktree = cwd;
        const discovered = mkDiscovered({ agent: "claude", cwd, syntheticId: "sid-terminal" });
        registry.applyDiscovery([discovered]);
        // Readiness: a hooked agent proves it can READ before the dispatcher types.
        registry.applyHook({
          agent: "claude",
          event: "SessionStart",
          sessionId: "native-terminal",
          cwd,
          transcriptPath: null,
          env: { tmuxPane: (discovered.terminals[0] as { paneId: string }).paneId },
        });
        return "home-terminal";
      },
      inject: async (_session, text) => {
        registry.applyHook({
          agent: "claude",
          event: "UserPromptSubmit",
          sessionId: "native-terminal",
          cwd: worktree!,
          transcriptPath: null,
          prompt: text,
          env: { tmuxPane: "%91" },
        });
        return { ok: true, pasted: true, submitVerified: true };
      },
    });

    await dispatcher.dispatch("task-terminal", { defaultModel: launchModel });
    assert.equal(registry.getTask("task-terminal")?.status, "running", "the launch reached running");

    const { facts, refs } = onlyDispatch();
    assert.equal(facts.outcome, "launched");
    assert.equal(facts.runtime, "terminal", "the resolved runtime, not the discovered session's");
    assert.equal(facts.agent, "claude");
    assert.equal(facts.task_kind, "ship");
    assert.equal(launchedModel, expectedModel, "the spawn receives the same model telemetry reports");
    assert.equal(facts.resolved_model, expectedModel ?? "");
    assert.equal(facts.resolved_effort, "high");
    assert.equal(facts.resolution_source, tier);
    assert.equal(facts.repo_count, 1);
    assert.ok((facts.duration_ms as number) >= 0);
    // The session this launch produced, so a trace can join the dispatch to the card.
    assert.equal(refs.task_id, "task-terminal");
    assert.equal(refs.session_id, registry.getTask("task-terminal")?.sessionId);
  });
}

test("a pipeline launch is recorded, and claims no resolution it never made", async () => {
  const registry = new Registry();
  registry.upsertTask(
    mkTask({
      id: "task-pipeline",
      status: "dispatching",
      repoRoot: "/repo/demo",
      title: "Pipeline attribution",
      intent: "exercise the pipeline dispatch branch",
      agent: "claude",
      kind: "pipeline",
    }),
  );

  const launches: unknown[][] = [];
  const dispatcher = new Dispatcher(registry, async () => assert.fail("no worktree is owned"), {
    pipelineLaunch: async () => ({
      ok: true,
      launchRuntime: "terminal",
      cwd: "/repo/demo",
      argv: ["/usr/bin/env", "/bin/conduct-ts", "engineer", "--idea", "Pipeline attribution"],
      pipelineRun: {
        provider: "ai-conductor" as const,
        repoRoot: "/repo/demo",
        slug: "pipeline-attribution",
      },
    }),
    spawn: async (...args) => {
      launches.push(args);
      return "Pipeline attribution";
    },
  });

  await dispatcher.dispatch("task-pipeline");
  assert.equal(launches.length, 1, "the Engineer host was launched");

  const { facts } = onlyDispatch();
  // Symmetric with the failure arm. Without this the only pipeline dispatches ever recorded
  // would be the ones that broke, and a launch-success rate computed from failures alone is
  // worse than no rate at all.
  assert.equal(facts.outcome, "launched");
  assert.equal(facts.task_kind, "pipeline");
  // BLANK resolution, deliberately: the Engineer host's model is Conductor's to choose, so
  // this phase reports that nothing was resolved rather than inventing a ladder that never
  // ran. `harness` means the provider decides, which is a different answer from "the panel
  // default was used".
  assert.equal(facts.resolved_model, "");
  assert.equal(facts.resolved_effort, "unknown", "this dispatcher did not observe the pipeline host's effort");
  assert.equal(facts.resolution_source, "harness");
});

test("an embedded launch reports the SDK runtime, from the resolution and not the card", async () => {
  const repo = seedRepo("sdk-ok");
  const registry = new Registry();
  registry.upsertTask(
    mkTask({
      id: "task-sdk",
      status: "dispatching",
      repoRoot: repo,
      title: "SDK attribution",
      intent: "exercise the embedded dispatch branch",
      agent: "claude",
      kind: "ship",
    }),
  );

  const starts: Array<{ agent: string; cwd: string }> = [];
  const supervisor = {
    async start(input: { agent: "claude" | "codex" | "pi"; name: string; cwd: string }) {
      starts.push({ agent: input.agent, cwd: input.cwd });
      return registry.registerSdkSession({
        id: "sdk:attribution",
        agent: input.agent,
        name: input.name,
        cwd: input.cwd,
      });
    },
    async stop(): Promise<void> {},
    taskLiveness: () => null,
  };

  const dispatcher = new Dispatcher(registry, async () => {}, {
    resolveRuntime: () => "sdk",
    missionMcpDescriptor: async () => null,
    supervisor: supervisor as never,
    // Reaching a pane at all would mean the embedded branch did not take.
    inject: async () => assert.fail("an embedded dispatch must never type at a pane"),
  });

  await dispatcher.dispatch("task-sdk");
  assert.equal(starts.length, 1, "the supervisor was asked for an embedded session");

  const { facts, refs } = onlyDispatch();
  assert.equal(facts.outcome, "launched");
  assert.equal(facts.runtime, "sdk");
  assert.equal(facts.task_kind, "ship");
  // No pin on this task, so the ladder fell through to whatever tier answered. What is
  // asserted is that the SOURCE is reported honestly rather than claimed as a deliberate
  // choice: with no task pin and no automation model, `task` and `automation` are both wrong.
  assert.notEqual(facts.resolution_source, "task");
  assert.notEqual(facts.resolution_source, "automation");
  assert.equal(refs.session_id, "sdk:attribution");
  assert.equal(refs.task_id, "task-sdk");
});

// ---- the exits that are not successes ----

test("an operator settling a dispatch underneath it is superseded, not failed", async () => {
  const repo = seedRepo("superseded");
  const registry = new Registry();
  registry.upsertTask(
    mkTask({
      id: "task-superseded",
      status: "dispatching",
      repoRoot: repo,
      title: "Superseded attribution",
      intent: "exercise the superseded branch",
      agent: "claude",
      kind: "ship",
      model: "claude-opus-5",
    }),
  );

  const dispatcher = new Dispatcher(registry, async () => {}, {
    resolveRuntime: () => "terminal",
    missionMcpDescriptor: async () => null,
    spawn: async () => {
      // The operator cancels while the launch is in flight. The dispatch then fails, but the
      // task's terminal state is the operator's and the dispatcher must not overwrite it.
      const current = registry.getTask("task-superseded")!;
      registry.upsertTask({ ...current, status: "cancelled", updatedAt: Date.now() });
      throw new Error("the launch was abandoned");
    },
  });

  await dispatcher.dispatch("task-superseded");
  assert.equal(registry.getTask("task-superseded")?.status, "cancelled");

  const { facts } = onlyDispatch();
  // THE DISTINCTION. Folding this into `failed` would make every operator cancel look like a
  // broken launch on the one chart that answers "do dispatches work".
  assert.equal(facts.outcome, "superseded");
  assert.equal(facts.task_kind, "ship");
  assert.equal(facts.agent, "claude");
});

test("a failure after resolution carries the model that launch resolved", async () => {
  const repo = seedRepo("failed-after");
  const registry = new Registry();
  const detach = attachSessionTelemetry(registry);
  let failedCwd: string | null = null;
  registry.upsertTask(
    mkTask({
      id: "task-failed",
      status: "dispatching",
      repoRoot: repo,
      title: "Failed attribution",
      intent: "exercise the catch-path failed branch",
      agent: "claude",
      kind: "scout",
      model: "claude-opus-5",
      effort: "low",
    }),
  );

  const dispatcher = new Dispatcher(registry, async () => {}, {
    resolveRuntime: () => "terminal",
    missionMcpDescriptor: async () => null,
    // Thrown at the SPAWN, which is after the model and effort ladder has been walked. That
    // ordering is the point: the facts below are the ones this launch resolved, carried
    // forward to an exit three scopes away from where they were computed.
    spawn: async (_label, _short, cwd) => {
      failedCwd = cwd;
      throw new Error("no terminal backend could start a session");
    },
  });

  await dispatcher.dispatch("task-failed");
  assert.equal(registry.getTask("task-failed")?.status, "failed");

  const { facts, refs } = onlyDispatch();
  assert.equal(facts.outcome, "failed");
  assert.equal(facts.runtime, "terminal");
  assert.equal(facts.task_kind, "scout");
  assert.equal(facts.resolved_model, "claude-opus-5");
  assert.equal(facts.resolved_effort, "low");
  assert.equal(facts.resolution_source, "task");
  // A failed launch never becomes a started session, so there is nothing to join it to.
  assert.equal(refs.session_id, undefined);
  assert.equal(refs.task_id, "task-failed");
  // And no session was observed starting, which is the fact `mission.sessions.started` counts.
  const started = openDb()
    .prepare(`SELECT COUNT(*) AS n FROM telemetry_journal WHERE name = 'mission.session.started'`)
    .get() as { n: number };
  assert.equal(started.n, 0);

  // A later session in that checkout must not consume the failed launch's intent.
  assert.ok(failedCwd);
  registry.applyDiscovery([mkDiscovered({ cwd: failedCwd })]);
  const later = openDb().prepare(
    "SELECT facts_json, refs_json FROM telemetry_journal WHERE name = 'mission.session.started'",
  ).get() as { facts_json: string; refs_json: string };
  assert.equal(JSON.parse(later.facts_json).origin, "discovered");
  assert.equal(JSON.parse(later.refs_json).task_id, undefined);
  detach();
});
