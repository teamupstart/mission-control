import { MISSION_TEST_MCP_DEPS } from "./helpers/mission-mcp-deps.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";

// The advisor a dispatched Claude session launches with: Inherit (null), Opus, Sonnet or Off,
// chosen on Settings -> Harnesses as a default plus per-model overrides, and resolved against
// the model each launch resolves. A task can no longer pin one; a pin saved before that move
// still applies until it is cleared.
//
// What is at stake is quiet in every direction. A setting that is stored but never rendered
// launches a session on the operator's global setting; a rendered choice on a harness with no
// advisor is argv the CLI rejects; and an Inherit launch that differs at all from one before
// this existed changes every session in the fleet. The terminal and SDK resume
// halves live beside their owners (`managed-resume-tools`, `sdk-supervisor`), and the SDK
// options merge beside its resident counterpart (`residents-mcp-render`).

const home = mkdtempSync(join(tmpdir(), "mission-advisor-override-"));
process.env.HARNESS_HOME = home;
// A stand-in bundle: the terminal ask channel only checks that the path EXISTS, and every
// Claude launch now requires `request_input`, so with no bundle at all (CI runs `npm test`
// before `npm run build`) the launch is refused. What it publishes is answered by
// `MISSION_TEST_MCP_DEPS`.
process.env.MISSION_MCP_SERVER = join(home, "mission-mcp-stand-in.mjs");
writeFileSync(process.env.MISSION_MCP_SERVER, "// not executed by this test\n");
// A binary that exists, so bin resolution is never what fails a launch. The terminal home is
// faked through the dispatcher's `spawn` seam, so nothing reaches a real backend.
process.env.MISSION_CLAUDE_BIN = "/bin/echo";
process.env.HERDR_BIN = join(home, "missing-herdr");

const { HARNESS_CAPABILITIES, supportsAdvisor } = await import("../src/shared/harness-capabilities.ts");
const {
  DispatchSchema, UpdateTaskSchema, McpUpdateTaskSchema, McpTaskConfigurationSchema,
  HarnessesConfigPatchSchema, HarnessesConfigSchema,
} = await import("../src/shared/protocol.ts");
const { advisorStatus, mergeAdvisor, resolveLaunchAdvisor } = await import("../src/shared/advisor.ts");
const { claudeAdvisorEnvironment } = await import("../src/server/harness/claude/advisor-environment.ts");
const { HARNESSES } = await import("../src/server/harness/index.ts");
const { closeDb, openDb, getTask } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { HarnessesConfigError, resolveDispatchAdvisor, setHarnessesConfig } = await import("../src/server/harnesses.ts");
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
  // The pairing rule, by family: the advisor must be at least as capable as the session.
  assert.equal(advisor.weakerThan("sonnet", "claude-opus-5-5"), true);
  assert.equal(advisor.weakerThan("opus", "claude-fable-5-1"), true);
  assert.equal(advisor.weakerThan("opus", "claude-opus-4-8[1m]"), false);
  assert.equal(advisor.weakerThan("opus", "claude-sonnet-5"), false);
  assert.equal(advisor.weakerThan("opus", "some-unknown-model"), false);

  assert.equal(HARNESS_CAPABILITIES.codex.advisor, null);
  assert.equal(HARNESS_CAPABILITIES.pi.advisor, null);
  assert.equal(supportsAdvisor("claude", "opus"), true);
  assert.equal(supportsAdvisor("codex", "opus"), false);
  assert.equal(supportsAdvisor("pi", "off"), false);
});

// ---- the wire ----

test("a task can no longer pin an advisor: create strips it, update only clears it", () => {
  const base = { repoRoot: "/r", intent: "go" };
  // An older client's field is stripped like any unknown key, never stored.
  assert.equal("advisorModel" in DispatchSchema.parse({ ...base, agent: "claude", advisorModel: "opus" }), false);

  assert.equal(UpdateTaskSchema.parse({ advisorModel: null }).advisorModel, null);
  assert.equal(UpdateTaskSchema.safeParse({ advisorModel: "sonnet" }).success, false);
  assert.equal(UpdateTaskSchema.safeParse({ agent: "codex", advisorModel: null }).success, true);
  assert.equal(McpUpdateTaskSchema.safeParse({ advisorModel: null }).success, true);
  assert.equal(McpUpdateTaskSchema.safeParse({ advisorModel: "opus" }).success, false);
  // The MCP create schema is strict, so a caller still sending a pin is told rather than ignored.
  assert.equal(McpTaskConfigurationSchema.safeParse({ advisorModel: "opus" }).success, false);
});

test("the harness setting takes a default and per-model overrides, only where a harness has an advisor", () => {
  assert.equal(
    HarnessesConfigPatchSchema.safeParse({
      advisor: { claude: { default: "opus", overrides: { "claude-opus-5-5": "off", "claude-haiku-4-5": null } } },
    }).success,
    true,
  );
  assert.equal(HarnessesConfigPatchSchema.safeParse({ advisor: { codex: { default: "opus" } } }).success, false);
  assert.equal(HarnessesConfigPatchSchema.safeParse({ advisor: { pi: { overrides: { m: "off" } } } }).success, false);
  // Clearing never asks the capability.
  assert.equal(HarnessesConfigPatchSchema.safeParse({ advisor: { codex: { default: null } } }).success, true);
  assert.equal(HarnessesConfigPatchSchema.safeParse({ advisor: { claude: { default: "fable" } } }).success, false);
  assert.equal(HarnessesConfigPatchSchema.safeParse({ advisor: { claude: { overrides: { "-rf": "opus" } } } }).success, false);
  // An untouched installation reads every harness as Inherit with no overrides.
  assert.deepEqual(HarnessesConfigSchema.parse({}).advisor.claude, { default: null, overrides: {} });
});

test("a patch merges per harness and per model, and null removes an override", () => {
  const empty = HarnessesConfigSchema.parse({}).advisor;
  const one = mergeAdvisor(empty, { claude: { default: "opus", overrides: { "claude-opus-5-5": "off" } } });
  const two = mergeAdvisor(one, { claude: { overrides: { "claude-haiku-4-5[1m]": "sonnet" } } });
  assert.deepEqual(two.claude, {
    default: "opus",
    // Keyed by the bare id, so a long-context launch finds the same row.
    overrides: { "claude-opus-5-5": "off", "claude-haiku-4-5": "sonnet" },
  });
  const three = mergeAdvisor(two, { claude: { default: null, overrides: { "claude-opus-5-5": null } } });
  assert.deepEqual(three.claude, { default: null, overrides: { "claude-haiku-4-5": "sonnet" } });
  assert.deepEqual(three.codex, empty.codex);
});

test("setHarnessesConfig refuses an override keyed by another harness's model", () => {
  try {
    assert.throws(
      () => setHarnessesConfig({ advisor: { claude: { overrides: { "gpt-6-sol": "opus" } } } }),
      HarnessesConfigError,
    );
    const saved = setHarnessesConfig({ advisor: { claude: { default: "sonnet", overrides: { "claude-fable-5-1": "off" } } } });
    assert.deepEqual(saved.advisor.claude, { default: "sonnet", overrides: { "claude-fable-5-1": "off" } });
  } finally {
    openDb().exec("DELETE FROM app_config");
  }
});

// ---- the resolver ----

test("a launch resolves a legacy task pin, then its model's override, then the default", () => {
  const config = {
    advisor: {
      ...HarnessesConfigSchema.parse({}).advisor,
      claude: { default: "opus", overrides: { "claude-opus-5-5": "off", "claude-haiku-4-5": "fable" } },
      codex: { default: "opus", overrides: {} },
    },
  };
  assert.deepEqual(resolveLaunchAdvisor(config, "claude", "claude-sonnet-5", null), { choice: "opus", source: "default" });
  assert.deepEqual(resolveLaunchAdvisor(config, "claude", "claude-opus-5-5[1m]", null), { choice: "off", source: "override" });
  assert.deepEqual(resolveLaunchAdvisor(config, "claude", null, null), { choice: "opus", source: "default" });
  assert.deepEqual(resolveLaunchAdvisor(config, "claude", "claude-opus-5-5", "sonnet"), { choice: "sonnet", source: "task" });
  // A stored value this build cannot pin falls through rather than reaching argv.
  assert.deepEqual(resolveLaunchAdvisor(config, "claude", "claude-haiku-4-5", null), { choice: "opus", source: "default" });
  // A harness with no advisor resolves to Inherit, whatever was stored for it.
  assert.equal(resolveLaunchAdvisor(config, "codex", "gpt-6-sol", "opus").choice, null);
});

test("the status line says whether a session will consult an advisor, and why not", () => {
  const env = (over: Partial<{ inherited: string | null; blocked: string | null }> = {}) => ({
    inherited: null, source: "~/.claude/settings.json", blocked: null, ...over,
  });
  assert.equal(advisorStatus("claude", "opus", "claude-sonnet-5", env()).on, true);
  assert.equal(advisorStatus("claude", "off", "claude-sonnet-5", env({ inherited: "opus" })).on, false);
  const inherited = advisorStatus("claude", null, null, env({ inherited: "opus" }));
  assert.equal(inherited.on, true);
  assert.match(inherited.text, /inherits Opus from ~\/\.claude\/settings\.json/);
  const none = advisorStatus("claude", null, null, env());
  assert.equal(none.on, false);
  assert.match(none.text, /names no advisor/);
  const blocked = advisorStatus("claude", "opus", null, env({ blocked: "CLAUDE_CODE_DISABLE_ADVISOR_TOOL is set in X." }));
  assert.equal(blocked.on, false);
  assert.match(blocked.text, /CLAUDE_CODE_DISABLE_ADVISOR_TOOL/);
  // Harness default with nothing named still names the switch, not the missing setting.
  const blockedUnnamed = advisorStatus("claude", null, null, env({ blocked: "CLAUDE_CODE_DISABLE_ADVISOR_TOOL is set in X." }));
  assert.equal(blockedUnnamed.on, false);
  assert.equal(blockedUnnamed.text, "Off: CLAUDE_CODE_DISABLE_ADVISOR_TOOL is set in X.");
  // The pairing rule: a Sonnet advisor on an Opus session is configured but not consulted.
  assert.match(String(advisorStatus("claude", "sonnet", "claude-opus-5-5", env()).warning), /less capable/);
  assert.equal(advisorStatus("claude", "opus", "claude-opus-4-8", env()).warning, null);
});

test("the Claude settings reader reports the inherited advisor and anything that turns it off", () => {
  const dir = mkdtempSync(join(tmpdir(), "mission-advisor-settings-"));
  const path = join(dir, "settings.json");
  const before = process.env.CLAUDE_SETTINGS_PATH;
  process.env.CLAUDE_SETTINGS_PATH = path;
  try {
    assert.deepEqual(claudeAdvisorEnvironment({}), { inherited: null, source: path, blocked: null });
    writeFileSync(path, '{ "advisorModel": "opus", // JSONC\n }');
    assert.equal(claudeAdvisorEnvironment({}).inherited, "opus");
    writeFileSync(path, JSON.stringify({ advisorModel: "opus", env: { CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1" } }));
    assert.equal(claudeAdvisorEnvironment({}).blocked, `CLAUDE_CODE_DISABLE_ADVISOR_TOOL is set in ${path}.`);
    writeFileSync(path, JSON.stringify({ advisorModel: "opus" }));
    assert.match(String(claudeAdvisorEnvironment({ CLAUDE_CODE_USE_BEDROCK: "1" }).blocked), /Amazon Bedrock/);
    assert.equal(claudeAdvisorEnvironment({ CLAUDE_CODE_USE_BEDROCK: "0" }).blocked, null);
    writeFileSync(path, "{ not json");
    assert.deepEqual(claudeAdvisorEnvironment({}), { inherited: null, source: path, blocked: null });
    // Truncated after a valid key: the parser recovers a partial object, which must not count.
    writeFileSync(path, '{ "advisorModel": "opus", "env": {');
    assert.deepEqual(claudeAdvisorEnvironment({}), { inherited: null, source: path, blocked: null });
  } finally {
    if (before === undefined) delete process.env.CLAUDE_SETTINGS_PATH;
    else process.env.CLAUDE_SETTINGS_PATH = before;
    rmSync(dir, { recursive: true, force: true });
  }
  // Only a harness that declares an advisor reads one.
  assert.equal(HARNESSES.claude.advisorEnvironment !== null, HARNESS_CAPABILITIES.claude.advisor !== null);
  assert.equal(HARNESSES.codex.advisorEnvironment, null);
  assert.equal(HARNESSES.pi.advisorEnvironment, null);
});

// ---- the task manager ----

test("a new task stores no pin; a legacy pin is kept until cleared, and dropped on an agent change", async () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const created = tasks.create({
    repoRoot: "/repo", intent: "advisor from settings", title: "Settings advisor", kind: "ship", agent: "claude",
    workflowId: null, backlog: true,
  });
  assert.equal(created.advisorModel, null);

  // A pin saved before the move, as an older build left it.
  openDb().prepare(`UPDATE tasks SET advisor_model = 'opus' WHERE id = ?`).run(created.id);
  registry.upsertTask(getTask(created.id)!);
  // Omitted leaves it alone; an explicit null takes it back off.
  assert.equal((await tasks.update(created.id, { priority: "high" })).task?.advisorModel, "opus");
  assert.equal((await tasks.update(created.id, { advisorModel: null })).task?.advisorModel, null);

  openDb().prepare(`UPDATE tasks SET advisor_model = 'sonnet' WHERE id = ?`).run(created.id);
  registry.upsertTask(getTask(created.id)!);
  const switched = await tasks.update(created.id, { agent: "codex" });
  assert.equal(switched.ok, true);
  assert.equal(switched.task?.advisorModel, null);
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

/**
 * Dispatch one terminal Claude task under the given advisor setting and hand back what the
 * spawn seam was given.
 */
async function terminalLaunch(
  taskId: string,
  advisor: { default?: "opus" | "sonnet" | "off" | null; overrides?: Record<string, "opus" | "sonnet" | "off" | null> },
  task: { model?: string | null; advisorModel?: "opus" | "sonnet" | "off" | null } = {},
  /** Other harness settings in force for the launch - the model defaults, say. */
  config: Omit<Parameters<typeof setHarnessesConfig>[0], "advisor" | "sessionRuntime"> = {},
): Promise<{ args: string[]; extraEnv: Readonly<Record<string, string>> | undefined }> {
  const repo = seedRepo(taskId);
  openDb().exec("DELETE FROM app_config");
  setHarnessesConfig({ ...config, sessionRuntime: { claude: "terminal" }, advisor: { claude: advisor } });
  const registry = new Registry();
  registry.upsertTask(mkTask({
    id: taskId, status: "dispatching", repoRoot: repo, title: "Advisor", intent: "write a haiku",
    agent: "claude", model: task.model ?? null, advisorModel: task.advisorModel ?? null,
  }));
  let captured = { args: [] as string[], extraEnv: undefined as Readonly<Record<string, string>> | undefined };
  const dispatcher = new Dispatcher(registry, async () => {}, {
    ...MISSION_TEST_MCP_DEPS,
    spawn: async (_label, _short, _cwd, _bin, args, _stateHome, _backend, extraEnv) => {
      captured = { args: [...(args ?? [])], extraEnv };
      // Nothing is discovered, so the dispatch stops here. The launch is what this is about.
      throw new Error("stop after argv");
    },
  });
  try {
    await dispatcher.dispatch(taskId).catch(() => {});
  } finally {
    openDb().exec("DELETE FROM app_config");
  }
  return captured;
}

const settingsOf = (args: string[]): unknown => {
  const at = args.indexOf("--settings");
  return at === -1 ? null : JSON.parse(args[at + 1]!);
};

test("a terminal dispatch renders the setting for its launch model as argv or env, and Inherit as neither", async () => {
  const opus = await terminalLaunch("advisor-terminal-opus", { default: "opus" });
  const at = opus.args.indexOf("--settings");
  assert.notEqual(at, -1, `no --settings in ${JSON.stringify(opus.args)}`);
  assert.deepEqual(settingsOf(opus.args), { advisorModel: "opus" });
  assert.equal(opus.args.filter((arg) => arg === "--settings").length, 1, "--settings is single-valued");
  assert.deepEqual(opus.extraEnv, {});

  // The override for the model this launch runs on beats the default.
  const off = await terminalLaunch(
    "advisor-terminal-off",
    { default: "opus", overrides: { "claude-opus-5-5": "off" } },
    { model: "claude-opus-5-5" },
  );
  assert.equal(off.args.includes("--settings"), false);
  assert.deepEqual(off.extraEnv, { CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1" });

  // An override for another model does not apply.
  const other = await terminalLaunch(
    "advisor-terminal-other",
    { default: "sonnet", overrides: { "claude-opus-5-5": "off" } },
    { model: "claude-haiku-4-5" },
  );
  assert.deepEqual(settingsOf(other.args), { advisorModel: "sonnet" });

  // A pin a task saved before the move still wins until it is cleared.
  const legacy = await terminalLaunch("advisor-terminal-legacy", { default: "off" }, { advisorModel: "sonnet" });
  assert.deepEqual(settingsOf(legacy.args), { advisorModel: "sonnet" });

  const inherit = await terminalLaunch("advisor-terminal-inherit", {});
  assert.equal(inherit.args.includes("--settings"), false);
  assert.deepEqual(inherit.extraEnv, {});
  // Byte-identical to a launch without the setting: the Opus argv minus exactly its two words.
  assert.deepEqual(
    opus.args.filter((_, index) => index !== at && index !== at + 1).map((arg) => arg.replace(/advisor-terminal-opus/g, "ID")),
    inherit.args.map((arg) => arg.replace(/advisor-terminal-inherit/g, "ID")),
  );
});

test("an override applies when a default, not the task, supplies the launch model", async () => {
  // The common path: the task pins no model, so the harness default or the kind's row picks
  // it, and the override for THAT model is the one that has to reach the launch.
  const overrides = { "claude-opus-5-5": "off", "claude-haiku-4-5": "sonnet" } as const;
  const fromHarness = await terminalLaunch(
    "advisor-terminal-harness-default",
    { default: "opus", overrides },
    {},
    { defaultModel: { claude: "claude-opus-5-5" } },
  );
  assert.equal(fromHarness.args[fromHarness.args.indexOf("--model") + 1], "claude-opus-5-5");
  assert.equal(fromHarness.args.includes("--settings"), false);
  assert.deepEqual(fromHarness.extraEnv, { CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1" });

  // The kind's row outranks the harness default, and so does its model's override.
  const fromKind = await terminalLaunch(
    "advisor-terminal-kind-default",
    { default: "opus", overrides },
    {},
    { defaultModel: { claude: "claude-opus-5-5" }, kindDefaults: { ship: { agent: "claude", model: "claude-haiku-4-5" } } },
  );
  assert.equal(fromKind.args[fromKind.args.indexOf("--model") + 1], "claude-haiku-4-5");
  assert.deepEqual(settingsOf(fromKind.args), { advisorModel: "sonnet" });
  assert.deepEqual(fromKind.extraEnv, {});
});

test("the dispatch resolver reads the setting in force at launch", () => {
  try {
    setHarnessesConfig({ advisor: { claude: { default: "opus", overrides: { "claude-sonnet-5": "off" } } } });
    assert.equal(resolveDispatchAdvisor({ agent: "claude", advisorModel: null }, "claude-sonnet-5"), "off");
    assert.equal(resolveDispatchAdvisor({ agent: "claude", advisorModel: null }, null), "opus");
    assert.equal(resolveDispatchAdvisor({ agent: "codex", advisorModel: null }, "gpt-6-sol"), null);
  } finally {
    openDb().exec("DELETE FROM app_config");
  }
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
