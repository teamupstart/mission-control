import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";

// A dispatched task whose pool claim fails still launches, and its agent is told which step
// failed and what it printed. Real Git and a real pooled slot; only the SDK supervisor is fake.

const home = mkdtempSync(join(tmpdir(), "mission-dispatch-claim-"));
process.env.HARNESS_HOME = home;
process.env.MISSION_CLAUDE_BIN = "/bin/echo";
process.env.MISSION_MCP_SERVER = join(home, "no-such-mcp-bundle.mjs");

const { Registry } = await import("../src/server/registry.ts");
const { Dispatcher } = await import("../src/server/dispatcher.ts");
const { setHarnessesConfig } = await import("../src/server/harnesses.ts");
const { withTaskKindContract } = await import("../src/server/task-contract.ts");
const { taskPlanDiscovery } = await import("../src/server/plans/inputs.ts");
const { WorktreeManager } = await import("../src/server/worktrees/manager.ts");
const { WorktreeClaimSchema } = await import("../src/shared/protocol.ts");

type SdkSupervisor = import("../src/server/sdk/supervisor.ts").SdkSupervisor;
type Session = import("../src/shared/types.ts").Session;

after(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.MISSION_CLAUDE_BIN;
  delete process.env.MISSION_MCP_SERVER;
});

function seedRepo(name: string): { repo: string; sha: string } {
  const repo = join(home, name);
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@test"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
  writeFileSync(join(repo, "file.txt"), "base\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "base"]);
  return { repo, sha: execFileSync("git", ["-C", repo, "rev-parse", "HEAD"]).toString().trim() };
}

function fakeSupervisor(registry: InstanceType<typeof Registry>) {
  const starts: Parameters<SdkSupervisor["start"]>[0][] = [];
  const supervisor = {
    starts,
    async start(input: Parameters<SdkSupervisor["start"]>[0]): Promise<Session> {
      starts.push(input);
      return registry.registerSdkSession({ id: `sdk:${starts.length}`, agent: input.agent, name: input.name, cwd: input.cwd });
    },
    async stop(): Promise<void> {},
    taskLiveness: () => null,
  };
  return supervisor as typeof supervisor & SdkSupervisor;
}

function dispatcherFor(
  registry: InstanceType<typeof Registry>,
  supervisor: SdkSupervisor,
  sha: string,
  stepCode: string,
) {
  const worktrees = new WorktreeManager(undefined, {
    occupancy: async (paths) => new Map(paths.map((path) => [path, { status: "known" as const, occupants: [] }])),
    resolvePolicy: () => ({
      enabled: true,
      maxSlots: 2,
      setupArgv: null,
      claim: WorktreeClaimSchema.parse({ steps: [{ argv: [process.execPath, "-e", stepCode] }] }),
    }),
  });
  return new Dispatcher(registry, async () => {}, {
    supervisor,
    worktrees,
    missionMcpDescriptor: async () => null,
    resolveBases: async () => ({ primary: sha, extras: [] }),
    inject: async () => {
      throw new Error("an embedded dispatch must never type at a pane");
    },
  });
}

test("a failed claim launches the task anyway and leads turn one with the failing step and its tail", async () => {
  const { repo, sha } = seedRepo("claim-fails-repo");
  setHarnessesConfig({ sessionRuntime: { claude: "sdk" } });
  const registry = new Registry();
  registry.upsertTask(
    mkTask({ id: "task-claim-fails", status: "dispatching", repoRoot: repo, agent: "claude", intent: "fix the build" }),
  );
  const supervisor = fakeSupervisor(registry);
  await dispatcherFor(
    registry,
    supervisor,
    sha,
    `console.error("YN0035: the registry answered 401");process.exit(1)`,
  ).dispatch("task-claim-fails");

  const task = registry.getTask("task-claim-fails")!;
  assert.equal(task.status, "running", task.error ?? "");
  assert.equal(task.provider, "mission");
  assert.equal(supervisor.starts.length, 1);
  const prompt = supervisor.starts[0]!.prompt;
  assert.match(prompt, /^## Dependency install warning\n/);
  assert.match(prompt, /Failing step 1 of 1: `.*node -e .*` exited with code 1\./);
  assert.match(prompt, /YN0035: the registry answered 401/);
  assert.ok(
    prompt.endsWith(withTaskKindContract(task, "fix the build", { planDiscovery: await taskPlanDiscovery(task) })),
    "the operator's request and the kind contract follow the note unchanged",
  );
  assert.equal(supervisor.starts[0]!.acceptedGoalPrompt, "fix the build", "the card Goal stays the human request");
});

test("a successful claim leaves turn one exactly as it was", async () => {
  const { repo, sha } = seedRepo("claim-ok-repo");
  setHarnessesConfig({ sessionRuntime: { claude: "sdk" } });
  const registry = new Registry();
  registry.upsertTask(
    mkTask({ id: "task-claim-ok", status: "dispatching", repoRoot: repo, agent: "claude", intent: "ship it" }),
  );
  const supervisor = fakeSupervisor(registry);
  await dispatcherFor(registry, supervisor, sha, `process.exit(0)`).dispatch("task-claim-ok");
  const task = registry.getTask("task-claim-ok")!;
  assert.equal(task.status, "running", task.error ?? "");
  // Turn one as every dispatch composes it, plan discovery included (#1177).
  assert.equal(
    supervisor.starts[0]!.prompt,
    withTaskKindContract(task, "ship it", { planDiscovery: await taskPlanDiscovery(task) }),
  );
});
