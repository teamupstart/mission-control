import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";

// A Claude task's per-dispatch advisor pin: Inherit (null), Opus, Sonnet or Off.
//
// What is at stake is quiet in every direction. A pin that is stored but never rendered
// launches a session on the operator's global setting; a rendered pin on a harness with no
// advisor is argv the CLI rejects; and an Inherit launch that differs at all from one before
// this existed changes every unpinned session in the fleet. The terminal and SDK resume
// halves live beside their owners (`managed-resume-tools`, `sdk-supervisor`), and the SDK
// options merge beside its resident counterpart (`residents-mcp-render`).

const home = mkdtempSync(join(tmpdir(), "mission-advisor-override-"));
process.env.HARNESS_HOME = home;
// A binary that exists, so bin resolution is never what fails a launch. The terminal home is
// faked through the dispatcher's `spawn` seam, so nothing reaches a real backend.
process.env.MISSION_CLAUDE_BIN = "/bin/echo";
process.env.HERDR_BIN = join(home, "missing-herdr");

const { HARNESS_CAPABILITIES, supportsAdvisor } = await import("../src/shared/harness-capabilities.ts");
const { DispatchSchema, UpdateTaskSchema, McpUpdateTaskSchema } = await import("../src/shared/protocol.ts");
const { closeDb, openDb, getTask } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager, TaskAdvisorUnsupportedError } = await import("../src/server/tasks.ts");
const { resolveDispatchAdvisor, setHarnessesConfig } = await import("../src/server/harnesses.ts");
const { Dispatcher } = await import("../src/server/dispatcher.ts");
const { getSdkSession, upsertSdkSession } = await import("../src/server/sdk/store.ts");
const { agentSubprocessEnv } = await import("../src/server/agent-subprocess-env.ts");

after(() => rmSync(home, { recursive: true, force: true }));

// ---- the capability ----

test("Claude renders each pin through exactly one channel per runtime; other harnesses declare none", () => {
  const advisor = HARNESS_CAPABILITIES.claude.advisor!;
  assert.deepEqual(advisor.values, ["opus", "sonnet", "off"]);
  assert.deepEqual(advisor.launchArgs("opus"), ["--settings", '{"advisorModel":"opus"}']);
  assert.deepEqual(advisor.launchArgs("sonnet"), ["--settings", '{"advisorModel":"sonnet"}']);
  assert.deepEqual(advisor.launchArgs("off"), []);
  assert.deepEqual(advisor.launchEnv("opus"), {});
  assert.deepEqual(advisor.launchEnv("off"), { CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1" });
  assert.deepEqual(advisor.sdkSettings("sonnet"), { advisorModel: "sonnet" });
  assert.deepEqual(advisor.sdkSettings("off"), {});

  assert.equal(HARNESS_CAPABILITIES.codex.advisor, null);
  assert.equal(HARNESS_CAPABILITIES.pi.advisor, null);
  assert.equal(supportsAdvisor("claude", "opus"), true);
  assert.equal(supportsAdvisor("codex", "opus"), false);
  assert.equal(supportsAdvisor("pi", "off"), false);
});

// ---- the wire ----

test("dispatch and update schemas accept a pin only where the named harness offers one", () => {
  const base = { repoRoot: "/r", intent: "go" };
  assert.equal(DispatchSchema.parse({ ...base, agent: "claude", advisorModel: "opus" }).advisorModel, "opus");
  // No agent named: the kind decides the harness, so `TaskManager.create` judges it.
  assert.equal(DispatchSchema.safeParse({ ...base, advisorModel: "off" }).success, true);
  assert.equal(DispatchSchema.safeParse({ ...base, agent: "codex", advisorModel: "opus" }).success, false);
  assert.equal(DispatchSchema.safeParse({ ...base, agent: "claude", advisorModel: "fable" }).success, false);
  // A create has no stored pin to clear, so null is not a value it takes.
  assert.equal(DispatchSchema.safeParse({ ...base, agent: "claude", advisorModel: null }).success, false);
  assert.equal(DispatchSchema.parse({ ...base }).advisorModel, undefined);

  assert.equal(UpdateTaskSchema.parse({ advisorModel: null }).advisorModel, null);
  assert.equal(UpdateTaskSchema.safeParse({ advisorModel: "sonnet" }).success, true);
  assert.equal(UpdateTaskSchema.safeParse({ agent: "pi", advisorModel: "sonnet" }).success, false);
  // Null never asks the capability, so clearing is accepted whatever the agent.
  assert.equal(UpdateTaskSchema.safeParse({ agent: "codex", advisorModel: null }).success, true);
  // The MCP schemas derive from the same field set.
  assert.equal(McpUpdateTaskSchema.safeParse({ advisorModel: "opus" }).success, true);
});

// ---- the resolver ----

test("the resolver answers the task's pin, and nothing for a harness that cannot take it", () => {
  assert.equal(resolveDispatchAdvisor({ agent: "claude", advisorModel: "opus" }), "opus");
  assert.equal(resolveDispatchAdvisor({ agent: "claude", advisorModel: null }), null);
  assert.equal(resolveDispatchAdvisor({ agent: "codex", advisorModel: "opus" }), null);
});

// ---- the task manager ----

test("a task stores its pin, clears it with null, and drops it when the agent changes", async () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const created = tasks.create({
    repoRoot: "/repo", intent: "pair with an Opus advisor", title: "Opus advisor", kind: "ship", agent: "claude",
    advisorModel: "opus", workflowId: null, backlog: true,
  });
  assert.equal(created.advisorModel, "opus");
  assert.equal(getTask(created.id)?.advisorModel, "opus");

  const unpinned = tasks.create({
    repoRoot: "/repo", intent: "inherit the advisor", title: "Inherit", kind: "ship", agent: "claude", workflowId: null, backlog: true,
  });
  assert.equal(unpinned.advisorModel, null);

  // Omitted leaves it alone; an explicit null takes it back off.
  assert.equal((await tasks.update(created.id, { priority: "high" })).task?.advisorModel, "opus");
  assert.equal((await tasks.update(created.id, { advisorModel: "off" })).task?.advisorModel, "off");
  assert.equal((await tasks.update(created.id, { advisorModel: null })).task?.advisorModel, null);

  // Reset with model and effort on an agent switch, and refused for a harness without one.
  await tasks.update(created.id, { advisorModel: "sonnet" });
  const switched = await tasks.update(created.id, { agent: "codex" });
  assert.equal(switched.ok, true);
  assert.equal(switched.task?.advisorModel, null);
  const refused = await tasks.update(created.id, { advisorModel: "opus" });
  assert.equal(refused.ok, false);
  assert.match(String((refused as { error?: string }).error), /advisor override \(opus\) is not supported by codex/);
});

test("create refuses a pin for an explicitly named harness that has no advisor", () => {
  const tasks = new TaskManager(new Registry());
  assert.throws(
    () => tasks.create({
      repoRoot: "/repo", intent: "x", title: "Pi pin", kind: "ship", agent: "pi", advisorModel: "opus", workflowId: null, backlog: true,
    }),
    TaskAdvisorUnsupportedError,
  );
});

test("create refuses a pin once an omitted agent resolves through the kind to a harness without one", () => {
  // The schema lets this through on purpose - the harness is unknown until the kind default
  // resolves - so this is the only place the pair is judged.
  assert.equal(DispatchSchema.safeParse({ repoRoot: "/repo", intent: "x", advisorModel: "opus" }).success, true);
  setHarnessesConfig({ kindDefaults: { ship: { agent: "codex" } } });
  try {
    const registry = new Registry();
    const tasks = new TaskManager(registry);
    const before = registry.listTasks().length;
    assert.throws(
      () => tasks.create({
        repoRoot: "/repo", intent: "x", title: "Kind-resolved pin", kind: "ship", advisorModel: "opus", workflowId: null, backlog: true,
      }),
      (error) => error instanceof TaskAdvisorUnsupportedError &&
        error.message === "an advisor override (opus) is not supported by codex",
    );
    assert.equal(registry.listTasks().length, before, "nothing is written for a refused pin");
    // The same omitted agent resolving to Claude keeps the pin.
    setHarnessesConfig({ kindDefaults: { ship: { agent: "claude" } } });
    const kept = tasks.create({
      repoRoot: "/repo", intent: "x", title: "Kind-resolved Claude pin", kind: "ship", advisorModel: "opus", workflowId: null, backlog: true,
    });
    assert.equal(kept.agent, "claude");
    assert.equal(kept.advisorModel, "opus");
  } finally {
    openDb().exec("DELETE FROM app_config");
  }
});

// ---- persistence ----

test("a stored pin this harness no longer offers reads back as Inherit", () => {
  const registry = new Registry();
  const task = new TaskManager(registry).create({
    repoRoot: "/repo", intent: "stale pin", title: "Stale pin", kind: "ship", agent: "claude", workflowId: null, backlog: true,
  });
  openDb().prepare(`UPDATE tasks SET advisor_model = 'fable' WHERE id = ?`).run(task.id);
  assert.equal(getTask(task.id)?.advisorModel, null);
  // Valid for the column, wrong for the agent: still Inherit rather than argv Codex rejects.
  openDb().prepare(`UPDATE tasks SET advisor_model = 'opus', agent = 'codex' WHERE id = ?`).run(task.id);
  assert.equal(getTask(task.id)?.advisorModel, null);

  upsertSdkSession({
    id: "sdk-stale-advisor", agent: "claude", agentSessionId: null, cwd: "/wt", taskId: null,
    model: null, effort: null, advisorModel: "opus", permissionMode: null, status: "running", turnInProgress: false,
  });
  assert.equal(getSdkSession("sdk-stale-advisor")?.advisorModel, "opus");
  openDb().prepare(`UPDATE sdk_sessions SET advisor_model = 'fable' WHERE id = ?`).run("sdk-stale-advisor");
  assert.equal(getSdkSession("sdk-stale-advisor")?.advisorModel, null);
});

test("a database from before the pin opens, gains both columns, and reads every row as Inherit", () => {
  const registry = new Registry();
  const task = new TaskManager(registry).create({
    repoRoot: "/repo", intent: "filed before the pin", title: "Before the pin", kind: "ship", agent: "claude", workflowId: null, backlog: true,
  });
  upsertSdkSession({
    id: "sdk-before-pin", agent: "claude", agentSessionId: null, cwd: "/wt", taskId: null,
    model: null, effort: null, permissionMode: null, status: "running", turnInProgress: false,
  });
  // The shape an older build left on disk: same rows, no advisor columns.
  openDb().exec(`ALTER TABLE tasks DROP COLUMN advisor_model; ALTER TABLE sdk_sessions DROP COLUMN advisor_model;`);
  closeDb();

  const db = openDb();
  const columns = (table: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(columns("tasks").includes("advisor_model"));
  assert.ok(columns("sdk_sessions").includes("advisor_model"));
  assert.equal(getTask(task.id)?.advisorModel, null);
  assert.equal(getSdkSession("sdk-before-pin")?.advisorModel, null);
});

// ---- the terminal launch ----

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

/** Dispatch one terminal Claude task and hand back what the spawn seam was given. */
async function terminalLaunch(
  taskId: string,
  advisorModel: "opus" | "sonnet" | "off" | null,
): Promise<{ args: string[]; extraEnv: Readonly<Record<string, string>> | undefined }> {
  const repo = seedRepo(taskId);
  setHarnessesConfig({ sessionRuntime: { claude: "terminal" } });
  const registry = new Registry();
  registry.upsertTask(mkTask({
    id: taskId, status: "dispatching", repoRoot: repo, title: "Advisor pin", intent: "write a haiku",
    agent: "claude", advisorModel,
  }));
  let captured = { args: [] as string[], extraEnv: undefined as Readonly<Record<string, string>> | undefined };
  const dispatcher = new Dispatcher(registry, async () => {}, {
    missionMcpDescriptor: async () => null,
    spawn: async (_label, _short, _cwd, _bin, args, _stateHome, _backend, extraEnv) => {
      captured = { args: [...(args ?? [])], extraEnv };
      // Nothing is discovered, so the dispatch stops here. The launch is what this is about.
      throw new Error("stop after argv");
    },
  });
  await dispatcher.dispatch(taskId).catch(() => {});
  return captured;
}

test("a terminal dispatch renders each pin as argv or env, and Inherit as neither", async () => {
  const opus = await terminalLaunch("advisor-terminal-opus", "opus");
  const at = opus.args.indexOf("--settings");
  assert.notEqual(at, -1, `no --settings in ${JSON.stringify(opus.args)}`);
  assert.deepEqual(JSON.parse(opus.args[at + 1]!), { advisorModel: "opus" });
  assert.equal(opus.args.filter((arg) => arg === "--settings").length, 1, "--settings is single-valued");
  assert.deepEqual(opus.extraEnv, {});

  const off = await terminalLaunch("advisor-terminal-off", "off");
  assert.equal(off.args.includes("--settings"), false);
  assert.deepEqual(off.extraEnv, { CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1" });

  const inherit = await terminalLaunch("advisor-terminal-inherit", null);
  assert.equal(inherit.args.includes("--settings"), false);
  assert.deepEqual(inherit.extraEnv, {});
  // Byte-identical to a launch without the pin: the pinned argv minus exactly its two words.
  assert.deepEqual(
    opus.args.filter((_, index) => index !== at && index !== at + 1).map((arg) => arg.replace(/advisor-terminal-opus/g, "ID")),
    inherit.args.map((arg) => arg.replace(/advisor-terminal-inherit/g, "ID")),
  );
});

test("extra launch env joins the child env but cannot name a state home back in", () => {
  const stateHome = join(home, "extra-env-home");
  mkdirSync(stateHome, { recursive: true });
  const env = agentSubprocessEnv({ PATH: "/usr/bin" }, {
    stateHome,
    extraEnv: { CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1", MISSION_HOME: "/operator/state" },
  });
  assert.equal(env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL, "1");
  assert.equal(env.MISSION_HOME, stateHome);
});
