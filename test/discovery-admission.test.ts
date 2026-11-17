import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What is at stake: by default the dashboard shows only sessions Mission Control started.
// Discovery admits a session before it reads anything expensive about it, and a session it
// does not admit is absent from the sweep, so the registry's ordinary unseen loop evicts any
// card it had. These cases drive the REAL poller -> discover -> correlate -> registry path with
// an injected process table, so the policy, the annotation seams, and the eviction are each
// observed where they actually happen.

const home = mkdtempSync(join(tmpdir(), "mission-discovery-admission-"));
process.env.HARNESS_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const {
  clearTaskSessionClosure,
  openDb,
  openTaskSessionClosure,
  recordAgentBinding,
  retireTaskSessionClosure,
  sessionsBoundToAgents,
  setAppConfig,
  upsertForemanInvite,
} = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { pollOnce } = await import("../src/server/discovery/poller.ts");
const { discover } = await import("../src/server/discovery/correlate.ts");
const { DISPOSABLE_STATE_ROOT } = await import("../src/server/terminal/launch-process.ts");
const { getTerminalsConfig, setTerminalsConfig } = await import("../src/server/terminals-config.ts");
const { TerminalsConfigPatchSchema } = await import("../src/shared/protocol.ts");
const { APP_CONFIG_ENTRIES } = await import("../src/shared/app-config-entries.ts");
const { mergeSettingPayload } = await import("../src/server/settings-backups/config-registry.ts");
import type { DiscoveredSession, DiscoverDeps, DiscoveryAdmit } from "../src/server/discovery/correlate.ts";
import type { Proc } from "../src/server/discovery/processes.ts";
import type { AgentType, ServerEvent } from "../src/shared/types.ts";
import type { PipelineRun } from "../src/shared/pipeline.ts";
import { mkTask } from "./helpers/session-fixture.ts";

openDb();

const REPO = "/repo/demo";
const WORKTREE = `${REPO}/.worktrees/add-widgets`;

/** One shell and one agent on a tty, optionally beneath a Mission launch wrapper. */
function sessionProcs(n: number, opts: { wrapper?: boolean; agent?: AgentType } = {}): Proc[] {
  const kind = opts.agent ?? "claude";
  const tty = `ttys${n}`;
  const parent: Proc = {
    pid: n * 100,
    ppid: 1,
    tty,
    startRaw: "",
    startMs: 1000,
    command: opts.wrapper
      ? `/bin/sh ${DISPOSABLE_STATE_ROOT}/session-x${n}/launch-and-cleanup.sh`
      : "-zsh",
    agent: null,
    agentNative: false,
  };
  const agent: Proc = {
    pid: n * 100 + 1,
    ppid: n * 100,
    tty,
    startRaw: "",
    startMs: 1000,
    command: kind,
    agent: kind,
    agentNative: true,
  };
  return [parent, agent];
}
const idOf = (n: number): string => `proc:ttys${n}:${n * 100 + 1}:1000`;

const MISSION = 1;
const OUTSIDE = 2;
const TASK_BOUND = 3;
const PIPELINE = 4;
const REPO_ROOT = 5;
const INVITED = 6;
const RESTARTED = 7;
const LATE_BOUND = 12;
// A Mission launch and a hand-started session in ONE directory, for the hook cwd fallback.
const SHARED_MISSION = 13;
const SHARED_OUTSIDE = 14;
// Not Mission-launched and not task-bound, but owed a task closure.
const OWED = 15;
// The same rule for every harness: one Mission-launched and one hand-started session each.
const CODEX_MISSION = 8;
const CODEX_OUTSIDE = 9;
const PI_MISSION = 10;
const PI_OUTSIDE = 11;
const AGENT_OF: Record<number, AgentType> = {
  [CODEX_MISSION]: "codex",
  [CODEX_OUTSIDE]: "codex",
  [PI_MISSION]: "pi",
  [PI_OUTSIDE]: "pi",
};
const WRAPPED = new Set([MISSION, CODEX_MISSION, PI_MISSION, SHARED_MISSION]);
const CWDS: Record<number, string> = {
  [MISSION]: "/work/mission",
  [OUTSIDE]: "/work/outside",
  [TASK_BOUND]: "/work/task",
  [PIPELINE]: `${WORKTREE}/src`,
  [REPO_ROOT]: REPO,
  [INVITED]: "/work/invited",
  [RESTARTED]: "/work/restarted",
  [LATE_BOUND]: "/work/late-bound",
  [CODEX_MISSION]: "/work/codex-mission",
  [CODEX_OUTSIDE]: "/work/codex-outside",
  [PI_MISSION]: "/work/pi-mission",
  [PI_OUTSIDE]: "/work/pi-outside",
  [SHARED_MISSION]: "/work/shared",
  [SHARED_OUTSIDE]: "/work/shared",
  [OWED]: "/work/owed",
};
/** Every kind but RESTARTED, which only the restart case puts on the machine. */
const EVERY = [MISSION, OUTSIDE, TASK_BOUND, PIPELINE, REPO_ROOT, INVITED];

/** A machine with every kind of session on it, and seams recording what each read touched. */
function machine(present: number[] = EVERY) {
  const procs = present.flatMap((n) => sessionProcs(n, { wrapper: WRAPPED.has(n), agent: AGENT_OF[n] }));
  // `git` records the cwd of every per-session Git read, in call order.
  const annotated = { rollouts: new Set<string>(), panes: new Set<string>(), git: [] as Array<string | null> };
  const deps: DiscoverDeps = {
    gather: async () => ({ procs, terminals: [] }),
    readCwds: async (pids) =>
      new Map(pids.map((pid) => [pid, CWDS[Math.floor(pid / 100)]!])),
    annotateRollouts: async (sessions: DiscoveredSession[]) => {
      for (const s of sessions) annotated.rollouts.add(s.syntheticId);
    },
    annotatePanes: async (sessions: DiscoveredSession[]) => {
      for (const s of sessions) annotated.panes.add(s.syntheticId);
    },
    markers: () => ({ disposableRoot: DISPOSABLE_STATE_ROOT, resumeGuard: null, resumeLeaseRoot: null }),
    // What the real `gitInfo` returns for these made-up paths, so only the recording differs.
    gitInfo: (cwd) => {
      annotated.git.push(cwd);
      return { branch: null, root: null, repoRoot: null };
    },
  };
  const find = (admit?: DiscoveryAdmit) => discover(admit, deps);
  return { find, annotated };
}

function mkRun(): PipelineRun {
  return {
    provider: "ai-conductor",
    repoRoot: REPO,
    slug: "add-widgets",
    worktree: WORKTREE,
    tier: "M",
    track: "product",
    steps: [{ name: "build", state: "in_progress" }],
    lastStep: "build",
    halt: null,
    group: "building",
    prUrl: null,
    costTokens: null,
    updatedAt: 1000,
  };
}

let taskSeq = 0;
/** A registry with a running task bound to TASK_BOUND and a run whose worktree holds PIPELINE. */
function fleet() {
  const registry = new Registry();
  registry.upsertTask(mkTask({ id: `admission-task-${++taskSeq}`, status: "running", sessionId: idOf(TASK_BOUND) }));
  registry.initializePipelineRuns([mkRun()]);
  return registry;
}

const shown = (registry: InstanceType<typeof Registry>): string[] =>
  registry.snapshot().sessions.filter((s) => s.state !== "exited").map((s) => s.id).sort();

test("the setting is off by default, a patch round-trips, and an empty patch is refused", () => {
  assert.equal(getTerminalsConfig().externalSessions, false);
  const on = setTerminalsConfig({ externalSessions: true });
  assert.equal(on.externalSessions, true);
  assert.equal(getTerminalsConfig().externalSessions, true);
  // Merged like every other key: the per-multiplexer choices are untouched.
  setTerminalsConfig({ multiplexerTerminal: { tmux: "iterm" } });
  assert.equal(getTerminalsConfig().externalSessions, true);
  assert.equal(setTerminalsConfig({ externalSessions: false }).multiplexerTerminal.tmux, "iterm");
  assert.equal(getTerminalsConfig().externalSessions, false);
  assert.equal(TerminalsConfigPatchSchema.safeParse({}).success, false);
  assert.equal(TerminalsConfigPatchSchema.safeParse({ externalSessions: "yes" }).success, false);
  setTerminalsConfig({ multiplexerTerminal: { tmux: null } });
});

test("a stored blob or a settings snapshot without the key reads as off", () => {
  // What every install upgrading to this build has stored: no migration, still off.
  setAppConfig(APP_CONFIG_ENTRIES.terminals, { multiplexerTerminal: { tmux: "wezterm" } });
  assert.equal(getTerminalsConfig().externalSessions, false);
  // An older snapshot restored over a daemon that had it on turns it back off.
  const restored = mergeSettingPayload(
    APP_CONFIG_ENTRIES.terminals,
    { multiplexerTerminal: {}, externalSessions: true },
    { multiplexerTerminal: { tmux: "wezterm" } },
  ) as { externalSessions: boolean };
  assert.equal(restored.externalSessions, false);
  setTerminalsConfig({ externalSessions: false, multiplexerTerminal: { tmux: null } });
});

test("off: Mission-launched, task-bound, and pipeline-worktree sessions are shown; outside ones are not", async () => {
  setTerminalsConfig({ externalSessions: false });
  const registry = fleet();
  const { find, annotated } = machine();
  await pollOnce(registry, find);

  assert.deepEqual(shown(registry), [idOf(MISSION), idOf(TASK_BOUND), idOf(PIPELINE)].sort());
  // Including the repository root beside the run's worktree: containment, not proximity.
  assert.equal(registry.getSession(idOf(REPO_ROOT)), undefined);
  assert.equal(registry.getSession(idOf(OUTSIDE)), undefined);
  // A hidden session never reached a pane capture or a rollout read.
  for (const seen of [annotated.rollouts, annotated.panes]) {
    assert.deepEqual([...seen].sort(), [idOf(MISSION), idOf(TASK_BOUND), idOf(PIPELINE)].sort());
  }
  // Nor a Git read: one per admitted session, and none for the outside or repo-root session.
  assert.deepEqual(
    [...annotated.git].sort(),
    [CWDS[MISSION], CWDS[TASK_BOUND], CWDS[PIPELINE]].sort(),
  );
  assert.ok(!annotated.git.includes(CWDS[OUTSIDE]!), "an outside session reached gitInfo");
  assert.ok(!annotated.git.includes(CWDS[REPO_ROOT]!), "a repo-root session reached gitInfo");
  assert.equal(registry.getSession(idOf(MISSION))?.cwd, "/work/mission");
});

test("off: a work episode is not launch evidence", async () => {
  setTerminalsConfig({ externalSessions: true });
  const registry = fleet();
  const { find } = machine([OUTSIDE]);
  // Shown once, which is what opens a work episode for it (`mergeDiscovered`).
  await pollOnce(registry, find);
  assert.ok(registry.getSession(idOf(OUTSIDE)));
  setTerminalsConfig({ externalSessions: false });
  const admit = registry.discoveryAdmission()!;
  assert.equal(admit({ syntheticId: idOf(OUTSIDE), agent: "claude", cwd: CWDS[OUTSIDE]!, missionLaunched: false }), false);
});

test("off hides outside Codex and Pi sessions too, and on shows them", async () => {
  const harnesses = [CODEX_MISSION, CODEX_OUTSIDE, PI_MISSION, PI_OUTSIDE];
  setTerminalsConfig({ externalSessions: false });
  const registry = fleet();
  const { find, annotated } = machine(harnesses);
  await pollOnce(registry, find);
  // Only the two launched beneath a Mission wrapper, one per harness.
  assert.deepEqual(shown(registry), [idOf(CODEX_MISSION), idOf(PI_MISSION)].sort());
  assert.equal(registry.getSession(idOf(CODEX_MISSION))?.agent, "codex");
  assert.equal(registry.getSession(idOf(PI_MISSION))?.agent, "pi");
  assert.equal(registry.getSession(idOf(CODEX_OUTSIDE)), undefined);
  assert.equal(registry.getSession(idOf(PI_OUTSIDE)), undefined);
  // Neither hidden session reached a pane capture or a Codex rollout read.
  assert.deepEqual([...annotated.rollouts].sort(), [idOf(CODEX_MISSION), idOf(PI_MISSION)].sort());
  assert.deepEqual([...annotated.panes].sort(), [idOf(CODEX_MISSION), idOf(PI_MISSION)].sort());

  setTerminalsConfig({ externalSessions: true });
  await pollOnce(registry, find);
  assert.deepEqual(shown(registry), harnesses.map(idOf).sort());
  assert.equal(registry.getSession(idOf(CODEX_OUTSIDE))?.agent, "codex");
  assert.equal(registry.getSession(idOf(PI_OUTSIDE))?.agent, "pi");
  setTerminalsConfig({ externalSessions: false });
});

test("on: every session is shown, as before", async () => {
  setTerminalsConfig({ externalSessions: true });
  const registry = fleet();
  assert.equal(registry.discoveryAdmission(), undefined, "on admits everything without a predicate");
  const { find, annotated } = machine();
  await pollOnce(registry, find);
  assert.deepEqual(shown(registry), EVERY.map(idOf).sort());
  assert.equal(annotated.panes.size, EVERY.length);
  // The Git seam is the one discovery uses: with nothing hidden, every session reaches it.
  assert.deepEqual([...annotated.git].sort(), EVERY.map((n) => CWDS[n]).sort());
  setTerminalsConfig({ externalSessions: false });
});

test("off: a dispatch Foreman invite alone admits a session; the same session without it is hidden", async () => {
  setTerminalsConfig({ externalSessions: true });
  const registry = fleet();
  // INVITED and OUTSIDE are alike in every way: no wrapper, no task, no pipeline worktree.
  const { find } = machine([INVITED, OUTSIDE]);
  await pollOnce(registry, find);
  assert.equal(registry.setForemanInvite(idOf(INVITED), "dispatch"), "dispatch");

  setTerminalsConfig({ externalSessions: false });
  await pollOnce(registry, find);
  assert.equal(registry.getSession(idOf(INVITED))?.state !== "exited", true, "the invited session stays");
  assert.equal(registry.getSession(idOf(OUTSIDE))?.state, "exited", "the other one leaves");
});

test("off, after a restart: a dispatch invite stored under the agent's session id still admits", async () => {
  setTerminalsConfig({ externalSessions: false });
  // The invite key is the agent session id once bound, and a fresh registry has no card to
  // read that binding from.
  const agentSessionId = "agent-session-restart-1";
  recordAgentBinding(idOf(RESTARTED), agentSessionId, 1000);
  upsertForemanInvite(agentSessionId, "dispatch", 1000);
  const registry = new Registry();
  const { find } = machine([RESTARTED, OUTSIDE]);
  await pollOnce(registry, find);
  assert.deepEqual(shown(registry), [idOf(RESTARTED)]);
});

test("off, after a restart: a binding recorded after the first sweep still admits its invited session", async () => {
  setTerminalsConfig({ externalSessions: false });
  // The invite already sits under the agent's session id, but the synthetic-to-agent binding
  // that leads there has not been recorded yet, so the first sweep cannot admit it.
  const agentSessionId = "agent-session-late-binding-1";
  upsertForemanInvite(agentSessionId, "dispatch", 1000);
  const registry = new Registry();
  const { find } = machine([LATE_BOUND, OUTSIDE]);
  await pollOnce(registry, find);
  assert.deepEqual(shown(registry), [], "nothing leads from this session to its invite yet");

  recordAgentBinding(idOf(LATE_BOUND), agentSessionId, 2000);
  await pollOnce(registry, find);
  // The first sweep's miss was not kept: the next one reads the binding and admits it.
  assert.deepEqual(shown(registry), [idOf(LATE_BOUND)]);
  await pollOnce(registry, find);
  assert.deepEqual(shown(registry), [idOf(LATE_BOUND)], "and keeps it");
});

test("the invite binding lookup reads a whole set of keys backwards, through its index", () => {
  recordAgentBinding("synthetic-bound-a", "agent-bound-a", 3000);
  recordAgentBinding("synthetic-bound-b", "agent-bound-b", 3000);
  recordAgentBinding("synthetic-unrelated", "agent-unrelated", 3000);
  assert.deepEqual(
    [...sessionsBoundToAgents(["agent-bound-a", "agent-bound-b", "agent-never-bound"])].sort(),
    ["synthetic-bound-a", "synthetic-bound-b"],
  );
  assert.equal(sessionsBoundToAgents([]).size, 0);
  // Bindings are never pruned, so admission's once-per-sweep read must not scan the table.
  const plan = openDb()
    .prepare(
      `EXPLAIN QUERY PLAN SELECT session_id AS id FROM session_agent_bindings
        WHERE agent_session_id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(["agent-bound-a"])) as { detail: string }[];
  assert.ok(
    plan.some((row) => row.detail.includes("idx_agent_bindings_agent")),
    plan.map((row) => row.detail).join("\n"),
  );
});

test("off: a session owed a task closure stays admitted on a fresh registry, before and after retirement", async () => {
  setTerminalsConfig({ externalSessions: false });
  // Its task is done, so it is not task-bound, and a fresh registry has no retired target.
  openTaskSessionClosure("admission-owed-task", idOf(OWED), 1000, 60_000);
  const { find } = machine([OWED, OUTSIDE]);
  const registry = new Registry();
  await pollOnce(registry, find);
  assert.deepEqual(shown(registry), [idOf(OWED)], "owed but not yet retired: still a card to close");

  retireTaskSessionClosure("admission-owed-task", idOf(OWED), 2000);
  const restarted = new Registry();
  await pollOnce(restarted, find);
  assert.deepEqual(shown(restarted), [], "a retired session is never published again");
  assert.equal(restarted.missionSessionClosureTarget(idOf(OWED))?.id, idOf(OWED), "but its teardown target is kept");
  await pollOnce(restarted, find);
  assert.equal(restarted.missionSessionClosureTarget(idOf(OWED))?.id, idOf(OWED), "on every sweep that sees it");
  clearTaskSessionClosure("admission-owed-task");
});

test("off: a hidden session in a visible card's directory keeps the hook cwd fallback ambiguous", async () => {
  setTerminalsConfig({ externalSessions: false });
  const registry = new Registry();
  const together = machine([SHARED_MISSION, SHARED_OUTSIDE]);
  await pollOnce(registry, together.find);
  assert.deepEqual(shown(registry), [idOf(SHARED_MISSION)]);
  // A paneless hook from the hidden session must not be bound to the one card beside it.
  assert.equal(registry.findSessionByEnv({}, "agent-of-the-hidden-session", "/work/shared"), undefined);

  // Alone in that directory, the Mission session's first paneless hook still finds its card.
  const alone = machine([SHARED_MISSION]);
  await pollOnce(registry, alone.find);
  assert.equal(registry.findSessionByEnv({}, "agent-of-the-mission-session", "/work/shared")?.id, idOf(SHARED_MISSION));

  // On, both have cards, so the directory is ambiguous exactly as it was before this setting.
  setTerminalsConfig({ externalSessions: true });
  await pollOnce(registry, together.find);
  assert.equal(registry.findSessionByEnv({}, "agent-of-either-session", "/work/shared"), undefined);
  setTerminalsConfig({ externalSessions: false });
});

test("turning the setting off evicts an outside card through the one eviction path", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  setTerminalsConfig({ externalSessions: true });
  const registry = fleet();
  const events: ServerEvent[] = [];
  registry.on("event", (e: ServerEvent) => events.push(e));
  const { find } = machine([MISSION, OUTSIDE]);
  await pollOnce(registry, find);
  assert.deepEqual(shown(registry), [idOf(MISSION), idOf(OUTSIDE)].sort());

  setTerminalsConfig({ externalSessions: false });
  await pollOnce(registry, find);
  // `beginEviction`: greyed out first, then removed after the linger.
  assert.equal(registry.getSession(idOf(OUTSIDE))?.state, "exited");
  assert.equal(events.some((e) => e.type === "session_remove"), false);
  t.mock.timers.tick(60_000);
  const removed = events.filter((e) => e.type === "session_remove").map((e) => (e as { id: string }).id);
  assert.deepEqual(removed, [idOf(OUTSIDE)]);
  assert.ok(registry.getSession(idOf(MISSION)), "the Mission session is untouched");

  // Turned back on, the next sweep brings it back.
  setTerminalsConfig({ externalSessions: true });
  await pollOnce(registry, find);
  assert.deepEqual(shown(registry), [idOf(MISSION), idOf(OUTSIDE)].sort());
  setTerminalsConfig({ externalSessions: false });
});

test("off: dispatch still finds its terminal session at its cwd", async () => {
  setTerminalsConfig({ externalSessions: false });
  const registry = fleet();
  const { find } = machine([MISSION, OUTSIDE]);
  const waiting = registry.waitForSessionAtCwd(CWDS[MISSION]!, 5_000);
  await pollOnce(registry, find);
  assert.equal((await waiting)?.id, idOf(MISSION));
  assert.equal(await registry.waitForSessionAtCwd(CWDS[OUTSIDE]!, 50), null);
});
