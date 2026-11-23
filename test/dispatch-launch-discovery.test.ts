import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import { mkMuxHandle, mkTask } from "./helpers/session-fixture.ts";

// A dispatched terminal launch binds only the worker its own spawn started.
//
// A cancelled launch and its replacement can share one checkout while the old worker waits to
// be retired. Discovery by checkout alone hands the replacement whichever agent the registry
// yields first - the old one - and the replacement then types its turn one into a worker that
// is about to be closed. Only the terminal home, the pane and the process sightings are faked;
// the dispatcher, provisioning and the registry are real.

const home = mkdtempSync(join(tmpdir(), "mission-dispatch-launch-discovery-"));
process.env.HARNESS_HOME = home;
process.env.MISSION_CLAUDE_BIN = "/bin/echo";
process.env.MISSION_MCP_SERVER = join(home, "server.mjs");
writeFileSync(process.env.MISSION_MCP_SERVER, "// not executed by this test\n");

const { Registry } = await import("../src/server/registry.ts");
const { Dispatcher } = await import("../src/server/dispatcher.ts");
const { listProcesses } = await import("../src/server/discovery/processes.ts");

after(() => rmSync(home, { recursive: true, force: true }));

const MISSION_DESCRIPTOR = { serverName: "mission-control", command: "/usr/bin/node", args: ["/m.mjs"], env: {} };

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
function discovered(cwd: string, muxSession: string, over: Partial<DiscoveredSession> = {}): DiscoveredSession {
  const n = ++seq;
  return {
    syntheticId: `proc:ttys40${n}:${n}:0`,
    agent: "claude",
    name: "work",
    nameSource: "process",
    cwd,
    gitBranch: "harness/task",
    pid: 4000 + n,
    tty: `ttys40${n}`,
    terminals: [mkMuxHandle({ session: muxSession, paneId: `%${500 + n}` })],
    startedAt: 0,
    ...over,
  } as DiscoveredSession;
}

type WorktreePool = NonNullable<ConstructorParameters<typeof Dispatcher>[2]>["worktrees"];

/**
 * A worktree pool that hands every acquisition the same slot, as the real pool does once a
 * cancel has released a lease: the replacement is provisioned into the checkout the cancelled
 * attempt's worker is still running in while that worker waits to be retired.
 */
function reusedSlotPool(repo: string, path: string): WorktreePool {
  execFileSync("git", ["-C", repo, "worktree", "add", "-q", "--detach", path]);
  const baseSha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  let lease = 0;
  return {
    acquire: async () => ({ outcome: "acquired", lease: { path: realpathSync(path), leaseId: `lease-${++lease}`, baseSha } }),
    settleDomainLease: () => {},
    runningTaskClaim: () => null,
    onClaimChange: () => () => {},
  } as unknown as WorktreePool;
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a replacement launch sharing the cancelled launch's checkout binds and prompts only its own worker", async () => {
  const repo = seedRepo("overlap");
  const taskId = "overlap-launch";
  const registry = new Registry();
  registry.upsertTask(mkTask({ id: taskId, status: "dispatching", repoRoot: repo, title: "Overlap", intent: "do it", agent: "claude" }));
  // Every sighting is re-applied together, as one discovery sweep reports every live agent.
  const live: DiscoveredSession[] = [];
  const sweep = () => registry.applyDiscovery([...live]);
  const workers: string[] = [];
  const cwds: string[] = [];
  const prompted: string[] = [];
  const killed: string[] = [];
  let releaseOriginal!: () => void;
  const originalHeld = new Promise<void>((resolve) => { releaseOriginal = resolve; });
  let originalDelivering!: () => void;
  const originalReached = new Promise<void>((resolve) => { originalDelivering = resolve; });
  let ownAccepted = false;
  // Whether the replacement's own worker had taken the prompt when the task went running.
  let acceptedBeforeRunning: boolean | null = null;
  const unsubscribe = registry.subscribe((e) => {
    if (e.type === "task_upsert" && e.task.id === taskId && e.task.status === "running" && acceptedBeforeRunning === null) {
      acceptedBeforeRunning = ownAccepted;
    }
  });

  const dispatcher = new Dispatcher(registry, async () => {}, {
    resolveRuntime: () => "terminal",
    missionMcpDescriptor: async () => MISSION_DESCRIPTOR,
    verifyMissionMcpTools: async () => ({ ok: true }),
    worktrees: reusedSlotPool(repo, join(home, "pool-slot")),
    spawn: async (_label, _short, cwd) => {
      const n = cwds.push(cwd) - 1;
      const muxSession = `$${n}@overlap`;
      const sight = () => {
        const d = discovered(cwd, muxSession);
        workers[n] = d.syntheticId;
        live.push(d);
        sweep();
        registry.applyHook({ agent: "claude", event: "SessionStart", sessionId: `native-overlap-${n}`, cwd, transcriptPath: null,
          env: { tmuxPane: (d.terminals[0] as { paneId: string }).paneId } });
      };
      // The first worker is up at once. The replacement's agent boots more slowly, so the
      // cancelled launch's worker is the only one in the checkout when discovery starts.
      if (n === 0) sight();
      else setTimeout(sight, 300);
      return { homeName: `home-overlap-${n}`, homeBackend: "tmux", terminalResourceId: `multiplexer:tmux:${muxSession}` };
    },
    inject: async (session, text) => {
      prompted.push(session.id);
      const n = workers.indexOf(session.id);
      const accept = () => registry.applyHook({ agent: "claude", event: "UserPromptSubmit", sessionId: `native-overlap-${n}`,
        cwd: session.cwd, transcriptPath: null, prompt: text, env: { tmuxPane: "%1" } });
      if (session.id === workers[0] && prompted.length === 1) {
        // The original attempt's delivery is held while it is cancelled and replaced.
        originalDelivering();
        await originalHeld;
      }
      if (session.id === workers[1]) {
        // While the replacement waits for its own worker to take the prompt, the cancelled
        // worker in the same checkout starts working on its prompt. Its own worker accepts
        // only afterwards, and only that may count as delivery.
        setTimeout(releaseOriginal, 50);
        setTimeout(() => { ownAccepted = true; accept(); }, 500);
        return { ok: true, pasted: true, submitVerified: true };
      }
      accept();
      return { ok: true, pasted: true, submitVerified: true };
    },
    killHome: async (name) => { killed.push(name); return { ok: true, asked: true }; },
  });

  const original = dispatcher.dispatch(taskId);
  await originalReached;
  registry.upsertTask({ ...registry.getTask(taskId)!, status: "cancelled" });
  registry.upsertTask({ ...registry.getTask(taskId)!, status: "dispatching", sessionId: null, worktreePath: null, branch: null,
    homeName: null, terminalResourceId: null });
  // The replacement spawns, discovers its worker and delivers while the old worker is live.
  await dispatcher.dispatch(taskId);
  releaseOriginal();
  await original;
  unsubscribe();

  assert.equal(cwds.length, 2, "both launches spawned");
  assert.equal(cwds[1], cwds[0], "the two launches share one checkout");
  const task = registry.getTask(taskId)!;
  assert.equal(task.status, "running", `dispatch failed: ${task.error ?? "unknown"}`);
  assert.equal(task.sessionId, workers[1], "the replacement is bound to the worker its own spawn started");
  assert.equal(task.terminalResourceId, "multiplexer:tmux:$1@overlap");
  assert.deepEqual(prompted, [workers[0], workers[1]],
    "the replacement typed its turn one into its own worker only, never into the cancelled one");
  assert.deepEqual(killed, ["home-overlap-0"], "the cancelled attempt retired its own home");
  assert.equal(acceptedBeforeRunning, true,
    "the cancelled worker starting its own turn was not taken as the replacement's prompt landing");
});

test("launch discovery takes only the spawn's own resource, never another worker in the checkout", async () => {
  const registry = new Registry();
  const cwd = "/wt/discovery-resource";
  // One worker already here, and a stranger that turns up after the spawn: neither is this launch.
  const old = discovered(cwd, "$9@old");
  registry.applyDiscovery([old]);
  const spawned = { homeName: "h", homeBackend: "tmux" as const, terminalResourceId: "multiplexer:tmux:$10@new" };
  const waiting = registry.waitForLaunchedSessionAtCwd(cwd, spawned, 2_000);
  const stranger = discovered(cwd, "$11@stranger");
  registry.applyDiscovery([old, stranger]);
  await tick(50);
  const mine = discovered(cwd, "$10@new");
  registry.applyDiscovery([old, stranger, mine]);
  assert.equal((await waiting)?.id, mine.syntheticId);

  // Nothing of its own ever appears: a timeout, never a neighbour.
  const none = await registry.waitForLaunchedSessionAtCwd(cwd,
    { ...spawned, terminalResourceId: "multiplexer:tmux:$12@absent" }, 100);
  assert.equal(none, null);
});

test("launch discovery accepts a worker by its spawn's launch process when the terminal resource is not observed", async () => {
  const registry = new Registry();
  const cwd = "/wt/discovery-process";
  const procs = await listProcesses();
  const self = procs.find((p) => p.pid === process.pid);
  const parent = procs.find((p) => p.pid === process.ppid);
  assert.ok(self?.startMs && parent?.startMs, "the test runner and its parent are in the process table");
  // The launch wrapper is this test process; a worker beneath it is this process too. Its parent
  // is not beneath the wrapper, even though it reports the same checkout.
  const outsider = discovered(cwd, "$20@outsider", { pid: parent.pid, startedAt: parent.startMs });
  const beneath = discovered(cwd, "$21@beneath", { pid: self.pid, startedAt: self.startMs });
  const spawned = {
    homeName: "emu", homeBackend: "ghostty" as const, terminalResourceId: "emulator:ghostty:unobserved-pane",
    launchProcess: { pid: self.pid, startMs: self.startMs },
  };
  const waiting = registry.waitForLaunchedSessionAtCwd(cwd, spawned, 5_000);
  registry.applyDiscovery([outsider]);
  await tick(200);
  registry.applyDiscovery([outsider, beneath]);
  assert.equal((await waiting)?.id, beneath.syntheticId);
});

test("a pane with no reported address is found through its launch state home, even when the wrapper records itself late", async () => {
  const registry = new Registry();
  const cwd = "/wt/discovery-state-home";
  const procs = await listProcesses();
  const self = procs.find((p) => p.pid === process.pid);
  assert.ok(self?.startMs, "the test runner is in the process table");
  // A multiplexer spawn whose pane address could not be read: no resource, no launch process,
  // only the state home its wrapper runs from - which has not recorded the wrapper yet.
  const stateHome = mkdtempSync(join(home, "launch-state-"));
  const spawned = { homeName: "mux", homeBackend: "tmux" as const, terminalResourceId: null, launchStateHome: stateHome };
  const waiting = registry.waitForLaunchedSessionAtCwd(cwd, spawned, 10_000);
  const beneath = discovered(cwd, "$40@unreported", { pid: self.pid, startedAt: self.startMs });
  registry.applyDiscovery([beneath]);
  // Past the whole of that first lookup, which finds no wrapper.
  await tick(1_500);
  // The wrapper (this process, as the agent's ancestor) records itself, and the agent is seen again.
  writeFileSync(join(stateHome, "terminal-launch.json"), JSON.stringify({ pid: self.pid, startMs: self.startMs }));
  registry.applyHook({ agent: "claude", event: "SessionStart", sessionId: "native-state-home", cwd, transcriptPath: null,
    env: { tmuxPane: (beneath.terminals[0] as { paneId: string }).paneId } });
  assert.equal((await waiting)?.id, beneath.syntheticId, "the lookup that found nothing was not kept");
});

test("a spawn that names no terminal or launch process binds nothing, even a worker that appears only after it", async () => {
  // The registry half: a fresh worker turning up after the spawn is still not evidence of whose it is.
  const registry = new Registry();
  const cwd = "/wt/discovery-anonymous";
  const anonymous = { homeName: "anon", homeBackend: "tmux" as const, terminalResourceId: null };
  const waiting = registry.waitForLaunchedSessionAtCwd(cwd, anonymous, 2_000);
  registry.applyDiscovery([discovered(cwd, "$30@late")]);
  assert.equal(await waiting, null);

  // The dispatch half: the replacement's spawn reports no identity, and the cancelled launch's
  // worker is discovered late - after that spawn began - in the shared checkout.
  const repo = seedRepo("anonymous");
  const taskId = "anonymous-launch";
  registry.upsertTask(mkTask({ id: taskId, status: "dispatching", repoRoot: repo, title: "Anonymous", intent: "do it", agent: "claude" }));
  const prompted: string[] = [];
  const killed: string[] = [];
  let lateWorker = "";
  await new Dispatcher(registry, async () => {}, {
    resolveRuntime: () => "terminal",
    missionMcpDescriptor: async () => MISSION_DESCRIPTOR,
    verifyMissionMcpTools: async () => ({ ok: true }),
    worktrees: reusedSlotPool(repo, join(home, "anonymous-slot")),
    spawn: async (_label, _short, cwd) => {
      const late = discovered(cwd, "$31@cancelled");
      lateWorker = late.syntheticId;
      registry.applyDiscovery([late]);
      registry.applyHook({ agent: "claude", event: "SessionStart", sessionId: "native-anonymous-cancelled", cwd, transcriptPath: null,
        env: { tmuxPane: (late.terminals[0] as { paneId: string }).paneId } });
      return { homeName: "home-anonymous", homeBackend: "tmux", terminalResourceId: null };
    },
    inject: async (session) => {
      prompted.push(session.id);
      return { ok: true, pasted: true, submitVerified: true };
    },
    killHome: async (name) => { killed.push(name); return { ok: true, asked: true }; },
  }).dispatch(taskId);

  const task = registry.getTask(taskId)!;
  assert.equal(task.status, "failed");
  assert.match(task.error ?? "", /no terminal or launch process to find its agent by/);
  assert.notEqual(task.sessionId, lateWorker, "the late worker was never bound");
  assert.deepEqual(prompted, [], "and never typed into");
  assert.deepEqual(killed, [], "a home with no identity is left standing, never closed by its name");
});
