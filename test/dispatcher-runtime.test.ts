import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";

// What is at stake: which of two completely different things a dispatch launches.
//
// The branch is ONE line in `Dispatcher.dispatch`, after provisioning, and everything about
// its correctness is invisible in the happy path: with the toggle off - which is every
// installation until an operator turns it on - the terminal path must be byte-identical to
// what it always was, and with the toggle on there must be NO terminal home, no discovery
// wait, no readiness hedge and no pasted prompt. Silently taking the other path is a
// session whose whole behaviour (where its questions appear, whether it survives a restart,
// whether Focus does anything) is not what the operator asked for, with nothing saying so.
//
// A real git repo and a real worktree, so the branch is reached the way a dispatch reaches
// it - the SDK spec and the supervisor are the only things faked.

const home = mkdtempSync(join(tmpdir(), "mission-dispatch-runtime-"));
process.env.HARNESS_HOME = home;
// A binary that exists, so bin resolution can never be what fails here.
process.env.MISSION_CLAUDE_BIN = "/bin/echo";
process.env.MISSION_CODEX_BIN = "/bin/echo";
// No MCP bundle, which is what lets the terminal case below refuse a dispatch that
// REQUIRES our tools - and refuse it while assembling the argv, before it would open a
// terminal home. That matters more than it looks: a test that let the terminal path reach
// its spawn would create a real tmux session on the developer's machine and start asking
// `heldHomeNames` about sibling worktrees' live agents. Pointed at a path rather than
// unset, because a built checkout HAS the bundle and the test would otherwise pass or fail
// depending on whether `npm run build` had been run.
process.env.MISSION_MCP_SERVER = join(home, "no-such-mcp-bundle.mjs");

const { Registry } = await import("../src/server/registry.ts");
const { Dispatcher } = await import("../src/server/dispatcher.ts");
const { openDb, getForemanInvite } = await import("../src/server/db.ts");
const { setHarnessesConfig, resolveDispatchRuntime } = await import("../src/server/harnesses.ts");
const { HarnessesConfigSchema } = await import("../src/shared/protocol.ts");

type SdkSupervisor = import("../src/server/sdk/supervisor.ts").SdkSupervisor;
type Session = import("../src/shared/types.ts").Session;

after(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.MISSION_CLAUDE_BIN;
  delete process.env.MISSION_CODEX_BIN;
  delete process.env.MISSION_MCP_SERVER;
});

beforeEach(() => {
  openDb().exec("DELETE FROM app_config");
});

/** A repo a worktree can actually be cut from. */
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

/** Records what the dispatcher asked the supervisor for, and answers with a card. */
function fakeSupervisor(registry: InstanceType<typeof Registry>) {
  const starts: Parameters<SdkSupervisor["start"]>[0][] = [];
  const stopped: string[] = [];
  const supervisor = {
    starts,
    stopped,
    async start(input: Parameters<SdkSupervisor["start"]>[0]): Promise<Session> {
      starts.push(input);
      return registry.registerSdkSession({
        id: `sdk:${starts.length}`,
        agent: input.agent,
        name: input.name,
        cwd: input.cwd,
      });
    },
    async stop(id: string): Promise<void> {
      stopped.push(id);
    },
    taskLiveness: () => null,
  };
  return supervisor as typeof supervisor & SdkSupervisor;
}

test("the resolver reads the stored choice, and falls back rather than guessing", () => {
  assert.equal(resolveDispatchRuntime("claude"), "sdk");
  setHarnessesConfig({ sessionRuntime: { claude: "terminal" } });
  assert.equal(resolveDispatchRuntime("claude"), "terminal");
  setHarnessesConfig({ sessionRuntime: { claude: "sdk" } });
  assert.equal(resolveDispatchRuntime("claude"), "sdk");
  // A patch merges: turning Claude on must not blank the Codex row the panel never showed.
  setHarnessesConfig({ autoModeOnDispatch: true });
  assert.equal(resolveDispatchRuntime("claude"), "sdk");

  // A value a NEWER build wrote. It must not throw - `getHarnessesConfig` is on the path of
  // every dispatch, and taking out the model and effort defaults over an unreadable runtime
  // would be a far worse failure than ignoring it.
  openDb()
    .prepare(`INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)`)
    .run("harnesses", JSON.stringify({ sessionRuntime: { claude: "quantum" } }));
  assert.equal(resolveDispatchRuntime("claude"), "terminal");

  // A runtime this build knows but this harness declares no driver for: pi. Stored while a
  // driver existed and read back after it was removed is the same shape, and dispatching
  // into it anyway would launch something the operator's last instruction did not describe.
  setHarnessesConfig({ sessionRuntime: { pi: "sdk" } });
  assert.equal(resolveDispatchRuntime("pi"), "terminal");
});

test("a fresh config uses the Agent SDK for harnesses that declare an embedded driver", () => {
  const config = HarnessesConfigSchema.parse({});
  assert.deepEqual(config.sessionRuntime, { claude: "sdk", codex: "sdk", pi: "terminal" });
});

test("with both toggles on, Claude and Codex dispatch through the supervisor without a home", async () => {
  const repos = {
    claude: seedRepo("sdk-claude-repo"),
    codex: seedRepo("sdk-codex-repo"),
  };
  setHarnessesConfig({ sessionRuntime: { claude: "sdk", codex: "sdk" } });
  const registry = new Registry();
  for (const agent of ["claude", "codex"] as const) {
    registry.upsertTask(
      mkTask({
        id: `task-sdk-${agent}`,
        status: "dispatching",
        repoRoot: repos[agent],
        title: `Exercise ${agent} SDK dispatch`,
        intent: `run ${agent} through the embedded runtime`,
        agent,
      }),
    );
  }
  const supervisor = fakeSupervisor(registry);
  const dispatcher = new Dispatcher(registry, async () => {}, {
    supervisor,
    // The bundle is not built in a test run, and a dispatch that passes no `missionMcp`
    // requirement is unaffected by its absence.
    missionMcpDescriptor: async () => null,
    // A pane write here would be the defect, not a fixture detail: reaching `injectPrompt`
    // at all means the branch did not take.
    inject: async () => {
      throw new Error("an embedded dispatch must never type at a pane");
    },
  });

  await dispatcher.dispatch("task-sdk-claude");
  await dispatcher.dispatch("task-sdk-codex");

  assert.deepEqual(supervisor.starts.map((start) => start.agent), ["claude", "codex"]);
  for (const agent of ["claude", "codex"] as const) {
    const start = supervisor.starts.find((candidate) => candidate.agent === agent)!;
    // The task's own title, unsanitized: `sessionLabel` cuts a name to a terminal backend's
    // grammar, and there is no terminal here to satisfy.
    assert.equal(start.name, `Exercise ${agent} SDK dispatch`);
    // The intent IS turn one. There is no separate delivery step to verify or retry.
    assert.equal(start.prompt, `run ${agent} through the embedded runtime`);
    assert.equal(start.taskId, `task-sdk-${agent}`);
    assert.ok(start.cwd.length > 0);

    const task = registry.getTask(`task-sdk-${agent}`)!;
    assert.equal(task.status, "running");
    assert.match(task.sessionId ?? "", /^sdk:/);
    // No terminal home was spawned, so there is no name or pane resource to record.
    assert.equal(task.homeName, null);
    assert.equal(task.terminalResourceId, null);
    assert.ok(task.worktreePath, "provisioning is identical on both paths");
    // An embedded dispatch stores NO Foreman-invite row: the "sdk" grant is implied by
    // the runtime itself, and the dispatcher's terminal-path invite write is never
    // reached (the embedded branch returns before `waitForSessionAtCwd`).
    assert.equal(registry.getSession(task.sessionId!)?.foremanInvite, "sdk");
    assert.equal(getForemanInvite(task.sessionId!), undefined);
  }
});

test("with both toggles off, Claude and Codex stay on the terminal branch", async () => {
  const registry = new Registry();
  for (const agent of ["claude", "codex"] as const) {
    registry.upsertTask(
      mkTask({
        id: `task-term-${agent}`,
        status: "dispatching",
        repoRoot: seedRepo(`terminal-${agent}-repo`),
        agent,
      }),
    );
  }
  const supervisor = fakeSupervisor(registry);
  const dispatcher = new Dispatcher(registry, async () => {}, { supervisor });

  // Required Mission MCP tools with no bundle on disk is the terminal path's own refusal,
  // and it fires while it is assembling the argv - BEFORE it would open a terminal home.
  // That is deliberate here: a test that let the terminal path run to its spawn would
  // create a real tmux session on the developer's machine, and `heldHomeNames` would then
  // be answering about sibling worktrees' live agents. What this asserts is which path was
  // taken, not that it completed.
  await dispatcher.dispatch("task-term-claude", { missionMcp: { tools: ["report_status"] } });
  await dispatcher.dispatch("task-term-codex", { missionMcp: { tools: ["report_status"] } });
  assert.equal(supervisor.starts.length, 0);
  for (const agent of ["claude", "codex"] as const) {
    assert.equal(registry.getTask(`task-term-${agent}`)?.status, "failed");
    assert.match(
      registry.getTask(`task-term-${agent}`)?.error ?? "",
      /required Mission MCP tools/,
    );
  }
});

test("an embedded launch is handed the same MCP descriptor the terminal argv renders", async () => {
  const repo = seedRepo("mcp-ok-repo");
  setHarnessesConfig({ sessionRuntime: { claude: "sdk" } });
  const registry = new Registry();
  registry.upsertTask(
    mkTask({ id: "task-mcp-ok", status: "dispatching", repoRoot: repo, agent: "claude", kind: "scout" }),
  );
  const supervisor = fakeSupervisor(registry);
  let credentialScope: { taskId: string; cwd: string } | null = null;
  await new Dispatcher(registry, async () => {}, {
    supervisor,
    missionMcpDescriptor: async () => ({
      serverName: "mission-control",
      command: "/usr/bin/node",
      args: ["/dist/mcp/server.mjs"],
      env: {},
    }),
    provisionScoutCredential: (taskId, cwd) => {
      credentialScope = { taskId, cwd };
      return "test-credential";
    },
  }).dispatch("task-mcp-ok", { missionMcp: { tools: ["report_status"] } });

  // One descriptor, rendered into whichever launch grammar the runtime speaks. The ask
  // channel's disallow and redirect are dropped for an embedded session - its questions
  // arrive as structured requests - but `report_status` and the rest were never about
  // asking questions, so the server still rides along.
  assert.equal(supervisor.starts.length, 1);
  assert.equal(supervisor.starts[0]!.mcp?.serverName, "mission-control");
  assert.deepEqual(credentialScope, {
    taskId: "task-mcp-ok",
    cwd: supervisor.starts[0]!.cwd,
  });
});

test("an embedded launch that cannot carry required MCP tools fails rather than starting", async () => {
  const repo = seedRepo("mcp-repo");
  setHarnessesConfig({ sessionRuntime: { claude: "sdk" } });
  const registry = new Registry();
  registry.upsertTask(
    mkTask({ id: "task-mcp", status: "dispatching", repoRoot: repo, agent: "claude" }),
  );
  const supervisor = fakeSupervisor(registry);
  await new Dispatcher(registry, async () => {}, {
    supervisor,
    missionMcpDescriptor: async () => null,
  }).dispatch("task-mcp", { missionMcp: { tools: ["submit_ensemble_result"] } });

  // The same rule the terminal path applies to its argv, asked of the thing that actually
  // reaches the child: a member that cannot reach `submit_ensemble_result` would run to
  // completion and then be unable to say so.
  assert.equal(supervisor.starts.length, 0);
  assert.equal(registry.getTask("task-mcp")?.status, "failed");
});

test("a build with no supervisor refuses the runtime rather than silently using the other", async () => {
  const repo = seedRepo("no-sup-repo");
  setHarnessesConfig({ sessionRuntime: { claude: "sdk" } });
  const registry = new Registry();
  registry.upsertTask(
    mkTask({ id: "task-nosup", status: "dispatching", repoRoot: repo, agent: "claude" }),
  );
  await new Dispatcher(registry, async () => {}).dispatch("task-nosup");
  const task = registry.getTask("task-nosup")!;
  assert.equal(task.status, "failed");
  // Falling back to a terminal would launch a session whose behaviour is not the one the
  // operator configured, with nothing anywhere saying it happened.
  assert.match(task.error ?? "", /no session supervisor/);
});

test("a cancel landing mid-launch stops the driver it just started", async () => {
  const repo = seedRepo("cancel-repo");
  setHarnessesConfig({ sessionRuntime: { claude: "sdk" } });
  const registry = new Registry();
  registry.upsertTask(
    mkTask({ id: "task-cancel", status: "dispatching", repoRoot: repo, agent: "claude" }),
  );
  const supervisor = fakeSupervisor(registry);
  const dispatcher = new Dispatcher(
    registry,
    // The teardown a cancel triggers. Cancelling here, at the moment the driver has just
    // been started, is what leaves an agent working in a worktree that is being handed back.
    async () => {},
    { supervisor, missionMcpDescriptor: async () => null },
  );
  const original = supervisor.start.bind(supervisor);
  supervisor.start = async (input) => {
    const session = await original(input);
    const cur = registry.getTask("task-cancel")!;
    registry.upsertTask({ ...cur, status: "cancelled" });
    return session;
  };

  await dispatcher.dispatch("task-cancel");
  assert.deepEqual(supervisor.stopped, ["sdk:1"]);
  assert.equal(registry.getTask("task-cancel")?.status, "cancelled");
});
