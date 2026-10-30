import { after, afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Persona } from "../src/shared/workflow.ts";
import type { Session } from "../src/shared/types.ts";

// A resident launch through the REAL Dispatcher, worktree and standing-instructions composer,
// with only the SDK supervisor faked. What is asserted is what the driver would be handed:
// the runtime (always the SDK), the agent, model and effort, turn one, and the standing
// instructions - repository block first, resident section after - on the pair's out-of-band
// channel, recorded once for resume replay.

const home = mkdtempSync(join(tmpdir(), "mission-residents-dispatch-"));
process.env.HARNESS_HOME = home;
process.env.MISSION_CLAUDE_BIN = "/bin/echo";
process.env.MISSION_CODEX_BIN = "/bin/echo";
process.env.MISSION_MCP_SERVER = join(home, "no-such-mcp-bundle.mjs");

const { Registry } = await import("../src/server/registry.ts");
const { RESIDENT_LAUNCH_TASK_CREATE, TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { ResidentManager } = await import("../src/server/residents/manager.ts");
const { RESIDENT_STANDING_HEADING, composeResidentLaunch } = await import("../src/server/residents/launch.ts");
const { openDb, getStandingInstructions } = await import("../src/server/db.ts");
const { setHarnessesConfig } = await import("../src/server/harnesses.ts");
const { standingInstructionsView, updateStandingInstructions } = await import("../src/server/instructions/config.ts");
const { STANDING_INSTRUCTIONS_HEADING } = await import("../src/server/instructions/compose.ts");
const { ResidentProfileRevisionSchema, RESIDENT_OPENING_TURN } = await import("../src/shared/residents.ts");

type SdkSupervisor = import("../src/server/sdk/supervisor.ts").SdkSupervisor;
type Registry = InstanceType<typeof Registry>;

const repos: string[] = [];
after(() => {
  rmSync(home, { recursive: true, force: true });
  for (const repo of repos) rmSync(repo, { recursive: true, force: true });
  delete process.env.MISSION_CLAUDE_BIN;
  delete process.env.MISSION_CODEX_BIN;
  delete process.env.MISSION_MCP_SERVER;
});

beforeEach(() => {
  openDb().exec("DELETE FROM app_config");
  // The operator's configured runtime is the TERMINAL, which a resident must not follow.
  setHarnessesConfig({ sessionRuntime: { claude: "terminal", codex: "terminal", pi: "terminal" } });
});

const PERSONA: Persona = {
  id: "persona-release-watch",
  name: "Release Watch",
  normalizedName: "release watch",
  description: "",
  guidanceMarkdown: "You watch release branches and flag regressions.",
  runner: null,
  model: null,
  revision: 3,
  archivedAt: null,
  createdAt: 0,
  updatedAt: 0,
  provenance: null,
  builtin: false,
};

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
function fakeSupervisor(registry: Registry) {
  const starts: Parameters<SdkSupervisor["start"]>[0][] = [];
  const supervisor = {
    starts,
    async start(input: Parameters<SdkSupervisor["start"]>[0]): Promise<Session> {
      starts.push(input);
      const session = registry.registerSdkSession({
        id: `sdk:resident-${++seq}`,
        agent: input.agent,
        name: input.name,
        cwd: input.cwd,
      });
      // The real supervisor writes the row (the run's evidence) and records what it sent.
      const { upsertSdkSession } = await import("../src/server/sdk/store.ts");
      upsertSdkSession({
        id: session.id,
        agent: input.agent,
        agentSessionId: null,
        cwd: input.cwd,
        taskId: input.taskId,
        model: input.model,
        effort: input.effort,
        permissionMode: input.permissionMode,
        status: "starting",
        turnInProgress: true,
      });
      if (input.standingInstructions?.delivery.text) {
        registry.recordStandingInstructions(session.id, input.standingInstructions.delivery);
      }
      return session;
    },
    async stop(): Promise<void> {},
    taskLiveness: () => null,
    liveSessionForTask: () => null,
  };
  return supervisor as typeof supervisor & SdkSupervisor;
}

const residentManagers: InstanceType<typeof ResidentManager>[] = [];
afterEach(async () => { for (const manager of residentManagers.splice(0)) await manager.stop(); });

function residentFixture(persona: { current: Persona }) {
  const registry = new Registry();
  const supervisor = fakeSupervisor(registry);
  const tasks = new TaskManager(registry, undefined, supervisor);
  const residents = new ResidentManager({
    registry,
    createTask: (input, internal) => tasks.create(input, internal, RESIDENT_LAUNCH_TASK_CREATE),
    persona: (id) => (id === persona.current.id ? persona.current : null),
  });
  tasks.registerResidentLaunch((task, repository, runtime) => residents.composeLaunch(task, repository, runtime));
  residents.start();
  residentManagers.push(residents);
  return { registry, supervisor, tasks, residents };
}

function profileSettings(agent: "claude" | "codex", instructions: string) {
  return ResidentProfileRevisionSchema.parse({
    identity: { name: `Release Watch ${agent} ${++seq}` },
    persona: { personaId: PERSONA.id },
    instructions: { markdown: instructions },
    execution: agent === "claude"
      ? { agent, model: "claude-sonnet-4-6", effort: "high" }
      : { agent, model: null, effort: null },
  });
}

for (const [agent, mechanism] of [
  ["claude", "claude-sdk-system-prompt-append"],
  ["codex", "codex-developer-instructions"],
] as const) {
  test(`a ${agent} resident launches in the Agent SDK with its persona as standing instructions, never as turn one`, async () => {
    const repo = seedRepo(`resident-${agent}`);
    repos.push(repo);
    const persona = { current: PERSONA };
    const { registry, supervisor, residents } = residentFixture(persona);
    const created = residents.createProfile(profileSettings(agent, "Flag regressions before anything else."));
    assert.ok(created.ok);
    const outcome = await residents.launch(created.profile.id, {
      repoRoot: repo,
      instructions: "Focus on the release branch today.",
      requestId: `req-${agent}`,
    });
    if (!("result" in outcome) || outcome.result.state !== "launched") assert.fail(JSON.stringify(outcome));

    assert.equal(supervisor.starts.length, 1, "the SDK path was taken despite a terminal runtime setting");
    const start = supervisor.starts[0]!;
    assert.equal(start.agent, agent);
    assert.equal(start.model, agent === "claude" ? "claude-sonnet-4-6" : null);
    assert.equal(start.effort, agent === "claude" ? "high" : null);
    assert.equal(start.taskId, outcome.result.taskId);
    assert.equal(start.acceptedGoalPrompt, RESIDENT_OPENING_TURN);
    assert.doesNotMatch(start.prompt, /release branches and flag regressions/, "the persona is not turn one");
    const delivery = start.standingInstructions!.delivery;
    assert.equal(delivery.mechanism, mechanism);
    assert.equal(
      delivery.text,
      [
        `${RESIDENT_STANDING_HEADING}: ${PERSONA.name}`,
        PERSONA.guidanceMarkdown,
        "### Profile instructions\n\nFlag regressions before anything else.",
        "### Instructions for this run\n\nFocus on the release branch today.",
      ].join("\n\n"),
    );
    const task = registry.getTask(outcome.result.taskId)!;
    assert.equal(task.status, "running");
    assert.equal(task.sessionId, start.sessionId ?? `sdk:resident-${seq}`);
  });
}

test("the resident section follows the repository standing instructions in one delivery", async () => {
  const repo = seedRepo("resident-with-rules");
  repos.push(repo);
  const view = standingInstructionsView();
  assert.equal(updateStandingInstructions({
    expectedEtag: view.etag,
    default: "",
    repositories: { [repo]: "Never force-push." },
  }).ok, true);
  const { supervisor, residents } = residentFixture({ current: PERSONA });
  const created = residents.createProfile(profileSettings("claude", ""));
  assert.ok(created.ok);
  await residents.launch(created.profile.id, { repoRoot: repo, requestId: "req-with-rules" });
  const text = supervisor.starts[0]!.standingInstructions!.delivery.text;
  assert.ok(text.startsWith(`${STANDING_INSTRUCTIONS_HEADING}\n\nNever force-push.\n\n${RESIDENT_STANDING_HEADING}`), text);
  assert.doesNotMatch(text, /Profile instructions/, "an empty profile instruction adds no heading");
});

test("a resume replays the persona the run pinned, after the profile and the Persona are both edited", async () => {
  const repo = seedRepo("resident-resume");
  repos.push(repo);
  const persona = { current: PERSONA };
  const { supervisor, residents } = residentFixture(persona);
  const created = residents.createProfile(profileSettings("claude", "Original profile brief."));
  assert.ok(created.ok);
  const outcome = await residents.launch(created.profile.id, { repoRoot: repo, requestId: "req-resume" });
  if (!("result" in outcome) || outcome.result.state !== "launched") assert.fail(JSON.stringify(outcome));
  const sessionId = `sdk:resident-${seq}`;
  const launched = supervisor.starts[0]!.standingInstructions!.delivery.text;

  persona.current = { ...PERSONA, guidanceMarkdown: "A rewritten role." };
  const edited = residents.updateProfile(created.profile.id, 1, profileSettings("claude", "A new profile brief."));
  assert.ok(edited.ok, edited.ok ? "" : edited.error);

  // What `SdkSupervisor.restore` replays: the launch snapshot, keyed by the session.
  assert.equal(getStandingInstructions(sessionId)?.text, launched);
  assert.match(launched, /Original profile brief\./);
  assert.match(launched, /release branches and flag regressions/);
  // And a recomposition for the same task reads the RUN, never the profile's current revision.
  const recomposed = residents.composeLaunch(
    { id: outcome.result.taskId, agent: "claude" } as never,
    { text: "", mechanism: "none", sources: [] },
    "sdk",
  );
  assert.equal(recomposed.text, launched);
});

test("the composer adds nothing when every contributor is silent, and keeps a repository mechanism", () => {
  const repository = { text: "rules", mechanism: "claude-sdk-system-prompt-append" as const, sources: [] };
  const run = {
    persona: { personaId: "p", name: "P", guidanceMarkdown: "" },
    settings: ResidentProfileRevisionSchema.parse({ identity: { name: "n" }, persona: { personaId: "p" } }),
    runInstructions: "",
  } as never;
  assert.equal(
    composeResidentLaunch({ run, agent: "claude", runtime: "sdk" }, repository, []).standing,
    repository,
  );
  const composed = composeResidentLaunch({ run, agent: "claude", runtime: "sdk" }, repository).standing;
  assert.equal(composed.mechanism, "claude-sdk-system-prompt-append");
  assert.equal(composed.text, `rules\n\n${RESIDENT_STANDING_HEADING}: P`);
});

test("a resident task dispatched without a composer fails rather than starting an agent with no role", async () => {
  const repo = seedRepo("resident-no-composer");
  repos.push(repo);
  const registry = new Registry();
  const supervisor = fakeSupervisor(registry);
  const tasks = new TaskManager(registry, undefined, supervisor);
  const residents = new ResidentManager({
    registry,
    createTask: (input, internal) => tasks.create(input, internal, RESIDENT_LAUNCH_TASK_CREATE),
    persona: () => PERSONA,
  });
  residents.start();
  residentManagers.push(residents);
  const created = residents.createProfile(profileSettings("claude", ""));
  assert.ok(created.ok);
  const outcome = await residents.launch(created.profile.id, { repoRoot: repo, requestId: "req-no-composer" });
  if (!("result" in outcome) || outcome.result.state !== "failed") assert.fail(JSON.stringify(outcome));
  assert.match(outcome.result.error, /no resident launch composer/);
  assert.equal(supervisor.starts.length, 0);
});

for (const agent of ["claude", "codex"] as const) {
  test(`a repo-less ${agent} resident uses a run directory, no Git provisioning, and no repository observers`, async () => {
    const { existsSync } = await import("node:fs");
    const { taskHasRepository } = await import("../src/shared/task.ts");
    const { taskRepoRefs, taskHasWorktrees } = await import("../src/shared/task-repos.ts");
    const { isRetentionCandidate } = await import("../src/server/task-resource-generation.ts");
    const { teardownWorktree } = await import("../src/server/dispatcher.ts");
    const { getTask } = await import("../src/server/db.ts");
    const { registry, supervisor, residents } = residentFixture({ current: PERSONA });
    try {
      const created = residents.createProfile(profileSettings(agent, "Keep watching."));
      assert.ok(created.ok);
      const outcome = await residents.launch(created.profile.id, { repoRoot: null, requestId: `no-repo-${agent}` });
      if (!("result" in outcome) || outcome.result.state !== "launched") assert.fail(JSON.stringify(outcome));
      const task = getTask(outcome.result.taskId)!;
      const cwd = outcome.result.run.workspaceDir!;
      assert.ok(existsSync(cwd));
      assert.equal(task.repoRoot, cwd);
      assert.equal(task.workspaceKind, "resident-workspace");
      assert.equal(task.worktreePath, null);
      assert.equal(task.provider, null);
      assert.equal(task.branch, null);
      assert.equal(task.baseSha, null);
      assert.equal(taskHasRepository(task), false);
      assert.deepEqual(taskRepoRefs(task), []);
      assert.equal(taskHasWorktrees(task), false);
      assert.equal(isRetentionCandidate({ ...task, status: "done" }), false);
      assert.deepEqual(registry.driverGitTargets(), []);
      assert.deepEqual(registry.prPollTargets(), []);
      assert.deepEqual(registry.extraRepoPrPollTargets(), []);
      const start = supervisor.starts[0]!;
      assert.equal(start.cwd, cwd);
      assert.equal(start.repoRoot, null);
      assert.equal(start.gitRoot, null);
      assert.match(start.standingInstructions!.delivery.text, /Resident role/);
      assert.doesNotMatch(start.prompt, /Plan inputs and discovery|pull request|repository scope/);
      await teardownWorktree(task);
      assert.ok(existsSync(cwd), "the repository cleanup path must leave the directory alone");
      const replay = await residents.launch(created.profile.id, { repoRoot: null, requestId: `no-repo-${agent}` });
      assert.deepEqual(replay, outcome);
      assert.equal(supervisor.starts.length, 1);
    } finally {
      await residents.stop();
    }
  });
}
