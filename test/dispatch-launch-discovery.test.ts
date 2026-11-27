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
//
// Every ordering these tests depend on is made by a gate or a synchronous sighting, never by a
// timer: a timer's boundary moves under CI contention, and the test then either fails for no
// reason or passes without exercising the order it claims to.

const home = mkdtempSync(join(tmpdir(), "mission-dispatch-launch-discovery-"));
process.env.HARNESS_HOME = home;
process.env.MISSION_CLAUDE_BIN = "/bin/echo";
process.env.MISSION_MCP_SERVER = join(home, "server.mjs");
// How long a typed prompt may go unacknowledged before it is typed again. Short, because the
// overlap test withholds its worker's first acknowledgement on purpose and waits for the retype;
// nothing here races against it.
process.env.MISSION_DISPATCH_ACCEPT_MS = "200";
writeFileSync(process.env.MISSION_MCP_SERVER, "// not executed by this test\n");

const { Registry } = await import("../src/server/registry.ts");
const { Dispatcher } = await import("../src/server/dispatcher.ts");
const { listProcesses } = await import("../src/server/discovery/processes.ts");
const { launchedSessionMatcher } = await import("../src/server/terminal/launch-process.ts");

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

/** The test runner's own process-table entry, which stands in for a launch wrapper. */
async function selfProcess() {
  const procs = await listProcesses();
  const self = procs.find((p) => p.pid === process.pid);
  const parent = procs.find((p) => p.pid === process.ppid);
  assert.ok(self?.startMs && parent?.startMs, "the test runner and its parent are in the process table");
  return { self: { pid: self.pid, startMs: self.startMs }, parent: { pid: parent.pid, startMs: parent.startMs } };
}

test("a replacement launch sharing the cancelled launch's checkout binds and prompts only its own worker", async () => {
  const repo = seedRepo("overlap");
  const taskId = "overlap-launch";
  const registry = new Registry();
  registry.upsertTask(mkTask({ id: taskId, status: "dispatching", repoRoot: repo, title: "Overlap", intent: "do it", agent: "claude" }));
  // Every sighting is re-applied together, as one discovery sweep reports every live agent.
  const live: DiscoveredSession[] = [];
  const workers: string[] = [];
  const cwds: string[] = [];
  const prompted: string[] = [];
  const killed: string[] = [];
  let releaseOriginal!: () => void;
  const originalHeld = new Promise<void>((resolve) => { releaseOriginal = resolve; });
  let originalDelivering!: () => void;
  const originalReached = new Promise<void>((resolve) => { originalDelivering = resolve; });
  const acceptHook = (n: number, cwd: string, text: string) => registry.applyHook({
    agent: "claude", event: "UserPromptSubmit", sessionId: `native-overlap-${n}`, cwd, transcriptPath: null, prompt: text,
    env: { tmuxPane: "%1" },
  });

  const dispatcher = new Dispatcher(registry, async () => {}, {
    resolveRuntime: () => "terminal",
    missionMcpDescriptor: async () => MISSION_DESCRIPTOR,
    verifyMissionMcpTools: async () => ({ ok: true }),
    worktrees: reusedSlotPool(repo, join(home, "pool-slot")),
    spawn: async (_label, _short, cwd) => {
      const n = cwds.push(cwd) - 1;
      const muxSession = `$${n}@overlap`;
      // Seen at once, beside the cancelled launch's worker, which the registry already holds and
      // so yields first to any lookup by checkout.
      const d = discovered(cwd, muxSession);
      workers[n] = d.syntheticId;
      live.push(d);
      registry.applyDiscovery([...live]);
      registry.applyHook({ agent: "claude", event: "SessionStart", sessionId: `native-overlap-${n}`, cwd, transcriptPath: null,
        env: { tmuxPane: (d.terminals[0] as { paneId: string }).paneId } });
      return { homeName: `home-overlap-${n}`, homeBackend: "tmux", terminalResourceId: `multiplexer:tmux:${muxSession}` };
    },
    inject: async (session, text) => {
      const n = workers.indexOf(session.id);
      const attempt = prompted.filter((id) => id === session.id).length;
      prompted.push(session.id);
      if (n === 0 && attempt === 0) {
        // The original attempt's delivery is held while it is cancelled and replaced.
        originalDelivering();
        await originalHeld;
      } else if (n === 1 && attempt === 0) {
        // The replacement has typed into its own worker and is now waiting for it to take the
        // prompt. Right then, the cancelled worker in the same checkout starts working on its own
        // turn, and the replacement's worker does not acknowledge this paste. That other worker's
        // turn is no evidence this one landed, so the replacement must type again.
        acceptHook(0, session.cwd!, "the cancelled launch's own turn");
        return { ok: true, pasted: true, submitVerified: true };
      }
      acceptHook(n, session.cwd!, text);
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

  assert.equal(cwds.length, 2, "both launches spawned");
  assert.equal(cwds[1], cwds[0], "the two launches share one checkout");
  const task = registry.getTask(taskId)!;
  assert.equal(task.status, "running", `dispatch failed: ${task.error ?? "unknown"}`);
  assert.equal(task.sessionId, workers[1], "the replacement is bound to the worker its own spawn started");
  assert.equal(task.terminalResourceId, "multiplexer:tmux:$1@overlap");
  assert.deepEqual(prompted, [workers[0], workers[1], workers[1]],
    "the replacement typed only into its own worker, and typed again because the cancelled worker's turn was not its acknowledgement");
  assert.deepEqual(killed, ["home-overlap-0"], "the cancelled attempt retired its own home");
});

test("launch discovery takes only the spawn's own resource, never another worker in the checkout", async () => {
  const registry = new Registry();
  const cwd = "/wt/discovery-resource";
  // One worker already here, and a stranger that turns up after the spawn: neither is this launch.
  const old = discovered(cwd, "$9@old");
  registry.applyDiscovery([old]);
  const spawned = { homeName: "h", homeBackend: "tmux" as const, terminalResourceId: "multiplexer:tmux:$10@new" };
  const waiting = registry.waitForLaunchedSessionAtCwd(cwd, spawned, 5_000);
  const stranger = discovered(cwd, "$11@stranger");
  registry.applyDiscovery([old, stranger]);
  const mine = discovered(cwd, "$10@new");
  registry.applyDiscovery([old, stranger, mine]);
  assert.equal((await waiting)?.id, mine.syntheticId);

  // Nothing of its own ever appears: a timeout, never a neighbour.
  const none = await registry.waitForLaunchedSessionAtCwd(cwd,
    { ...spawned, terminalResourceId: "multiplexer:tmux:$12@absent" }, 100);
  assert.equal(none, null);
});

test("a worker whose pane handle arrives on a later sighting is bound only once that sighting carries the spawn's resource", async () => {
  const registry = new Registry();
  const cwd = "/wt/discovery-late-handle";
  const resource = "multiplexer:tmux:$50@late-pane";
  const spawned = { homeName: "h", homeBackend: "tmux" as const, terminalResourceId: resource };
  let bound: string | null = null;
  const waiting = registry.waitForLaunchedSessionAtCwd(cwd, spawned, 5_000)
    .then((session) => { bound = session?.id ?? null; return session; });
  // First sighting: the process, before discovery could tie it to any pane.
  const first = discovered(cwd, "unused", { terminals: [] });
  registry.applyDiscovery([first]);
  assert.ok(registry.getSession(first.syntheticId), "the worker is in the registry");
  // Every check the first sighting started has settled once the next macrotask runs.
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(bound, null, "a sighting without the spawn's resource binds nothing");
  // The same worker again, now reachable through the pane the spawn opened.
  registry.applyDiscovery([{ ...first, terminals: [mkMuxHandle({ session: "$50@late-pane", paneId: "%550" })] }]);
  const session = await waiting;
  assert.equal(session?.id, first.syntheticId);
  assert.equal(session?.terminals.some((t) => t.kind === "multiplexer" && t.session === "$50@late-pane"), true,
    "bound by the sighting that carried the resource");
});

test("the real multiplexer spawner returns its launch state home when the backend reports no terminal resource, on retry too", async () => {
  const { spawnWrappedUniquely } = await import("../src/server/dispatcher.ts");
  const { fakeMultiplexer, fakeEmulator, fakeTerminals, OK, FAIL } = await import("./helpers/terminal-fakes.ts");
  const { PLAIN_NAMES } = await import("../src/server/terminal/names.ts");
  const stateHome = mkdtempSync(join(home, "spawn-state-"));
  // A tmux whose `new-session` output carried no session address: the launch succeeds, but the
  // backend can name no resource. `outcomes` is what each spawn attempt answers, in order.
  const backend = (outcomes: Array<typeof OK>) => {
    const names: string[] = [];
    const deps = fakeTerminals(fakeMultiplexer({
      sessions: {
        spawnDetached: async (spec: { name: string }) => { names.push(spec.name); return outcomes.shift()!; },
        attachArgv: () => [], rename: async () => OK, kill: async () => OK, alive: null, closeIfOnlyPane: null, names: PLAIN_NAMES,
      },
    }), fakeEmulator());
    return { deps: deps as Parameters<typeof spawnWrappedUniquely>[6], names };
  };

  const once = backend([OK]);
  const first = await spawnWrappedUniquely("api", "abc123", process.cwd(), ["/bin/echo"], stateHome, "tmux", once.deps);
  assert.deepEqual(once.names, ["api"]);
  assert.equal(first.terminalResourceId, null, "the backend named no resource");
  assert.equal(first.launchStateHome, stateHome, "the launch is still identified by the state home its wrapper runs from");
  assert.equal(first.launchProcess, null, "a multiplexer's wrapper is read lazily, only when discovery needs it");

  // The bare name is refused, and the unique name launches with no resource either.
  const retried = backend([FAIL("duplicate session: api"), OK]);
  const second = await spawnWrappedUniquely("api", "abc123", process.cwd(), ["/bin/echo"], stateHome, "tmux", retried.deps);
  assert.deepEqual(retried.names, ["api", "api-abc123"], "the retry ran under the unique name");
  assert.equal(second.homeName, "api-abc123");
  assert.equal(second.terminalResourceId, null);
  assert.equal(second.launchStateHome, stateHome, "the retried launch carries the state home as well");
});

test("launch discovery accepts a worker by its spawn's launch process when the terminal resource is not observed", async () => {
  const registry = new Registry();
  const cwd = "/wt/discovery-process";
  const { self, parent } = await selfProcess();
  // The launch wrapper is this test process; a worker beneath it is this process too. Its parent
  // is not beneath the wrapper, even though it reports the same checkout.
  const outsider = discovered(cwd, "$20@outsider", { pid: parent.pid, startedAt: parent.startMs });
  const beneath = discovered(cwd, "$21@beneath", { pid: self.pid, startedAt: self.startMs });
  const spawned = {
    homeName: "emu", homeBackend: "ghostty" as const, terminalResourceId: "emulator:ghostty:unobserved-pane",
    launchProcess: self,
  };
  registry.applyDiscovery([outsider]);
  // Each verdict asked directly, so neither depends on which of two checks finishes first.
  const match = launchedSessionMatcher(spawned);
  assert.equal(await match(registry.getSession(outsider.syntheticId)!), false, "a worker outside the launch is not it");
  // And through the wait the dispatcher uses, which reaches the same answer for the worker beneath it.
  const waiting = registry.waitForLaunchedSessionAtCwd(cwd, spawned, 5_000);
  registry.applyDiscovery([outsider, beneath]);
  assert.equal((await waiting)?.id, beneath.syntheticId);
});

test("a pane with no reported address is found through the launch state home its wrapper recorded", async () => {
  const registry = new Registry();
  const cwd = "/wt/discovery-state-home";
  const { self } = await selfProcess();
  // A multiplexer spawn whose pane address could not be read: no resource, no launch process,
  // only the state home its wrapper (this process, the agent's ancestor) has recorded itself in.
  const stateHome = mkdtempSync(join(home, "launch-state-"));
  writeFileSync(join(stateHome, "terminal-launch.json"), JSON.stringify(self));
  const spawned = { homeName: "mux", homeBackend: "tmux" as const, terminalResourceId: null, launchStateHome: stateHome };
  const waiting = registry.waitForLaunchedSessionAtCwd(cwd, spawned, 5_000);
  const beneath = discovered(cwd, "$40@unreported", { pid: self.pid, startedAt: self.startMs });
  registry.applyDiscovery([beneath]);
  assert.equal((await waiting)?.id, beneath.syntheticId);
});

test("a wrapper that records itself only after the first sighting is still matched on the next one", async () => {
  const registry = new Registry();
  const cwd = "/wt/discovery-late-wrapper";
  const { self } = await selfProcess();
  const beneath = discovered(cwd, "$41@late", { pid: self.pid, startedAt: self.startMs });
  registry.applyDiscovery([beneath]);
  const session = registry.getSession(beneath.syntheticId)!;
  // The wrapper's record, read once per lookup: absent at the first, present from the second.
  let recorded = false;
  const lookups: string[] = [];
  const readOwner = async (stateHome: string) => {
    lookups.push(stateHome);
    return recorded ? self : null;
  };
  const match = launchedSessionMatcher(
    { homeName: "mux", homeBackend: "tmux", terminalResourceId: null, launchStateHome: "/state/late" }, { readOwner });
  assert.equal(await match(session), false, "nothing to match against before the wrapper records itself");
  recorded = true;
  assert.equal(await match(session), true, "the lookup that found nothing was not kept");
  assert.deepEqual(lookups, ["/state/late", "/state/late"]);
  // Once found, the owner is kept: no further lookups.
  assert.equal(await match(session), true);
  assert.equal(lookups.length, 2);
});

test("a worker that moves to another checkout while its identity is read is not bound", async () => {
  const registry = new Registry();
  const cwd = "/wt/discovery-moved";
  const { self } = await selfProcess();
  // Identified by its wrapper, so the check is asynchronous: it reads the state home and `ps`.
  const stateHome = mkdtempSync(join(home, "moved-state-"));
  writeFileSync(join(stateHome, "terminal-launch.json"), JSON.stringify(self));
  const spawned = { homeName: "mux", homeBackend: "tmux" as const, terminalResourceId: null, launchStateHome: stateHome };
  const waiting = registry.waitForLaunchedSessionAtCwd(cwd, spawned, 1_500);
  const beneath = discovered(cwd, "$60@moved", { pid: self.pid, startedAt: self.startMs });
  registry.applyDiscovery([beneath]);
  // The very next sweep, before that check can settle, reports it in another checkout.
  registry.applyDiscovery([{ ...beneath, cwd: "/wt/somewhere-else" }]);
  assert.equal(registry.getSession(beneath.syntheticId)?.cwd, "/wt/somewhere-else");
  assert.equal(await waiting, null, "its check passed, but it is no longer in the launched checkout");
});

test("an undecided check is retried even when no later sighting changes the session", async () => {
  const registry = new Registry();
  const cwd = "/wt/discovery-retry";
  const worker = discovered(cwd, "$61@static");
  registry.applyDiscovery([worker]);
  // A check that cannot decide at first - say the process table could not be read - and can later.
  const checks: string[] = [];
  const matches = async (session: { id: string }) => {
    checks.push(session.id);
    return checks.length > 1;
  };
  const spawned = { homeName: "mux", homeBackend: "tmux" as const, terminalResourceId: null, launchStateHome: "/state/retry" };
  // Nothing is applied after this: the only way to a second check is the wait's own re-check.
  const session = await registry.waitForLaunchedSessionAtCwd(cwd, spawned, 5_000, { matches });
  assert.equal(session?.id, worker.syntheticId);
  assert.deepEqual(checks, [worker.syntheticId, worker.syntheticId]);
});

test("a check that throws is reported and retried, not silently dropped", async () => {
  const registry = new Registry();
  const cwd = "/wt/discovery-check-throws";
  const worker = discovered(cwd, "$64@throws");
  registry.applyDiscovery([worker]);
  let checks = 0;
  const matches = async () => {
    if (++checks === 1) throw new Error("ps: timed out");
    return true;
  };
  const settledChecks: Array<[string, string | null]> = [];
  const spawned = { homeName: "mux", homeBackend: "tmux" as const, terminalResourceId: null, launchStateHome: "/state/throws" };
  const session = await registry.waitForLaunchedSessionAtCwd(cwd, spawned, 5_000, {
    matches,
    onCheckSettled: (sessionId, error) => settledChecks.push([sessionId, error === null ? null : (error as Error).message]),
  });
  assert.deepEqual(settledChecks, [[worker.syntheticId, "ps: timed out"], [worker.syntheticId, null]],
    "the failure reached the caller, and so did the check that got past it");
  assert.equal(session?.id, worker.syntheticId, "and the next check still bound the worker");
});

/**
 * One real dispatch whose worker is never matched, every identity check answered by `matches`.
 * The wait is the dispatcher's own, with `deadlineMs` in place of the dispatch's long deadline.
 */
async function unmatchedDispatch(name: string, deadlineMs: number, matches: () => Promise<boolean>) {
  const repo = seedRepo(name);
  const taskId = `${name}-launch`;
  const registry = new Registry();
  registry.upsertTask(mkTask({ id: taskId, status: "dispatching", repoRoot: repo, title: name, intent: "do it", agent: "claude" }));
  const wait = registry.waitForLaunchedSessionAtCwd.bind(registry);
  registry.waitForLaunchedSessionAtCwd = (cwd, home, _timeoutMs, options) => wait(cwd, home, deadlineMs, { ...options, matches });
  const prompted: string[] = [];
  await new Dispatcher(registry, async () => {}, {
    resolveRuntime: () => "terminal",
    missionMcpDescriptor: async () => MISSION_DESCRIPTOR,
    verifyMissionMcpTools: async () => ({ ok: true }),
    worktrees: reusedSlotPool(repo, join(home, `${name}-slot`)),
    spawn: async (_label, _short, cwd) => {
      registry.applyDiscovery([discovered(cwd, `$${name}@unmatched`)]);
      return { homeName: `home-${name}`, homeBackend: "tmux", terminalResourceId: null, launchStateHome: `/state/${name}` };
    },
    inject: async (session) => {
      prompted.push(session.id);
      return { ok: true, pasted: true, submitVerified: true };
    },
    killHome: async () => ({ ok: true, asked: true }),
  }).dispatch(taskId);
  return { task: registry.getTask(taskId)!, prompted };
}

test("a dispatch whose identity checks keep failing names that failure, not an agent that never started", async () => {
  // Every check fails the way an unreadable process table does.
  const { task, prompted } = await unmatchedDispatch("check-failure", 700,
    async () => { throw new Error("process listing failed: ps timed out"); });
  assert.equal(task.status, "failed");
  assert.match(task.error ?? "", /checking a worker's launch identity failed \(process listing failed: ps timed out\)/);
  assert.doesNotMatch(task.error ?? "", /may have exited immediately/);
  assert.deepEqual(prompted, [], "nothing was typed into a worker that was never matched");
});

test("a failed identity check that a later check got past is not blamed for the timeout", async () => {
  // The first check fails; every later one completes and finds the worker is not this launch's.
  let checks = 0;
  const { task, prompted } = await unmatchedDispatch("stale-failure", 1_500, async () => {
    if (++checks === 1) throw new Error("process listing failed: ps timed out");
    return false;
  });
  assert.ok(checks >= 2, `a later check completed before the deadline (${checks} checks)`);
  assert.equal(task.status, "failed");
  assert.match(task.error ?? "", /agent session never appeared/);
  assert.doesNotMatch(task.error ?? "", /launch identity failed/, "the stale failure is not reported");
  assert.deepEqual(prompted, []);
});

test("a process listing that could not be read in full does not reject a worker for good", async () => {
  const { self, parent } = await selfProcess();
  const registry = new Registry();
  const cwd = "/wt/discovery-partial-ps";
  const beneath = discovered(cwd, "$62@partial", { pid: self.pid, startedAt: self.startMs });
  const outsider = discovered(cwd, "$63@outside", { pid: parent.pid, startedAt: parent.startMs });
  registry.applyDiscovery([beneath, outsider]);
  const full = await (await import("../src/server/discovery/processes.ts")).listProcessesSnapshot();
  assert.equal(full.unknownReason, null, "the real listing is complete here");
  // The first listing timed out with no rows; every later one is complete.
  let listings = 0;
  const listSnapshot = async () => (++listings === 1
    ? { processes: [], unknownReason: "process listing failed: timed out" }
    : full);
  const match = launchedSessionMatcher(
    { homeName: "emu", homeBackend: "ghostty", terminalResourceId: "emulator:ghostty:unobserved", launchProcess: self },
    { listSnapshot });
  assert.equal(await match(registry.getSession(beneath.syntheticId)!), false, "a partial listing cannot find its wrapper");
  assert.equal(await match(registry.getSession(beneath.syntheticId)!), true, "and that answer was not kept");
  // A complete listing's "no" is kept: the outsider is not listed again.
  assert.equal(await match(registry.getSession(outsider.syntheticId)!), false);
  const before = listings;
  assert.equal(await match(registry.getSession(outsider.syntheticId)!), false);
  assert.equal(listings, before, "a complete listing's rejection stands without asking again");
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
