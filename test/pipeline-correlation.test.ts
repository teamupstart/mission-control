import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import {
  ENGINEER_STEP_NAMES,
  type PipelineCommission,
  type PipelineRun,
} from "../src/shared/pipeline.ts";
import { canMessage, messageBlockReason } from "../src/shared/pane.ts";
import { mkMuxHandle, mkTask } from "./helpers/session-fixture.ts";

// Correlating a carded session to the pipeline run whose work it is doing.
//
// WHAT IS AT STAKE. Mission Control cards any tty agent process with daemon ancestry, and an
// external engine spawns its agents non-detached into a real pane - so an engine-driven
// `--print` claude arrives on the board looking exactly like an agent waiting for the
// operator's next instruction. It is not: it reads no input at all. Everything downstream of
// this stamp (the chip, the frame it groups under, the suppressed composer) hangs off the one
// question below, which is whether a session's cwd sits inside a projected run's worktree.
//
// THE FAIL-OPEN RULE runs through every case here. A fleet observing no engine has an empty
// projection and every session comes out uncorrelated and unchanged, which is the posture
// `Session.pipeline` documents and the reason an operator who has consented to nothing sees
// nothing new.

const home = mkdtempSync(join(tmpdir(), "mission-pipeline-correlation-"));
process.env.MISSION_HOME = home;

const { openDb } = await import("../src/server/db.ts");
const { Registry, pipelineRunDisplayEqual } = await import("../src/server/registry.ts");

after(() => rmSync(home, { recursive: true, force: true }));

openDb();

const REPO = "/repo/demo";

function mkRun(over: Partial<PipelineRun> = {}): PipelineRun {
  return {
    provider: "ai-conductor",
    repoRoot: REPO,
    slug: "add-widgets",
    worktree: `${REPO}/.worktrees/add-widgets`,
    tier: "M",
    track: "product",
    steps: [{ name: "build", state: "in_progress" }],
    lastStep: "build",
    halt: null,
    group: "building",
    prUrl: null,
    costTokens: null,
    updatedAt: 1000,
    ...over,
  };
}

function mkDiscovered(over: Partial<DiscoveredSession> = {}): DiscoveredSession {
  return {
    syntheticId: "sid",
    agent: "claude",
    name: "work",
    nameSource: "process",
    cwd: `${REPO}/.worktrees/add-widgets`,
    gitBranch: "feature/add-widgets",
    pid: 1,
    tty: "ttys1",
    terminals: [mkMuxHandle({ session: "s", windowName: "w", windowIndex: 0, paneId: "%1" })],
    startedAt: 0,
    ...over,
  } as DiscoveredSession;
}

/** A registry holding one projected run, with one session discovered into `cwd`. */
function fleet(runs: PipelineRun[], cwd: string | null, id = "sid") {
  const registry = new Registry();
  registry.initializePipelineRuns(runs);
  registry.applyDiscovery([mkDiscovered({ syntheticId: id, cwd })]);
  return { registry, session: registry.getSession(id)! };
}

test("a session working in a run's worktree is stamped with the run it belongs to", () => {
  const { session } = fleet([mkRun()], `${REPO}/.worktrees/add-widgets`);
  assert.deepEqual(session.pipeline, {
    provider: "ai-conductor",
    repoRoot: REPO,
    slug: "add-widgets",
    step: "build",
  });
});

test("a first-seen provider worker resolves its commissioned task through the exact run", () => {
  const registry = new Registry();
  const projected = mkRun();
  const task = mkTask({
    id: "commissioned-task",
    kind: "pipeline",
    repoRoot: REPO,
    status: "running",
    pipelineCommissionId: "commission-1",
    pipelineRun: {
      provider: projected.provider,
      repoRoot: projected.repoRoot,
      slug: projected.slug,
    },
  });
  const commission: PipelineCommission = {
    id: "commission-1",
    taskId: task.id,
    provider: projected.provider,
    repoRoot: projected.repoRoot,
    correlationId: "correlation-1",
    lifecycle: "awaiting_spec_merge",
    attempts: [{
      attempt: 1,
      origin: "mission_control",
      launchKey: "launch-1",
      engineerRunId: "engineer-1",
      previousEngineerRunId: null,
      providerRevision: 3,
      state: "settled",
      terminalReason: "awaiting_spec_merge",
      evidenceCommit: null,
      evidenceCommitProvenance: null,
      evidenceFrozenAt: null,
      updatedAt: 1_000,
    }],
    activeAttempt: 1,
    steps: ENGINEER_STEP_NAMES.map((name) => ({ name, state: "pending" })),
    currentStep: null,
    tier: "M",
    track: "product",
    project: "demo",
    authoringWorktree: `${REPO}/.worktrees/spec`,
    authoringBranch: `plan/${projected.slug}`,
    planSlug: projected.slug,
    handoff: {
      planSlug: projected.slug,
      branch: `plan/${projected.slug}`,
      prUrl: "https://github.com/example/demo/pull/1",
      outcome: "pr_opened",
    },
    linkedRun: {
      provider: projected.provider,
      repoRoot: projected.repoRoot,
      slug: projected.slug,
    },
    blocker: null,
    error: null,
    createdAt: 1_000,
    updatedAt: 1_000,
  };

  registry.upsertTask(task);
  registry.initializePipelineRuns([projected]);
  registry.initializePipelineCommissions([commission]);

  const retainedHost = registry.registerSdkSession({
    id: "sdk:retained-engineer",
    agent: "codex",
    name: "retained Engineer",
    cwd: REPO,
    agentSessionId: "engineer-before-restart",
    gitBranch: null,
    gitRoot: REPO,
    repoRoot: REPO,
  });
  registry.upsertTask({ ...task, sessionId: retainedHost.id });
  registry.bindTaskToWorkEpisode(task.id, retainedHost.id);
  registry.applyDriverEvent(retainedHost.id, {
    kind: "bound",
    agentSessionId: "engineer-after-restart",
    transcriptPath: null,
    modelId: "gpt-5",
    pid: null,
  });
  assert.equal(registry.getTask(task.id)?.status, "running");
  assert.equal(registry.getTask(task.id)?.sessionId, retainedHost.id);
  assert.equal(registry.workEpisodeForTask(task.id)?.agentSessionId, "engineer-after-restart");

  registry.applyDiscovery([mkDiscovered({ syntheticId: "later-worker" })]);

  const session = registry.getSession("later-worker")!;
  assert.deepEqual(session.pipeline, {
    provider: projected.provider,
    repoRoot: projected.repoRoot,
    slug: projected.slug,
    step: projected.lastStep,
  });
  assert.equal(session.task?.id, task.id);
  assert.equal(session.task?.pipelineCommissionId, commission.id);
  assert.deepEqual(session.task?.pipelineRun, commission.linkedRun);

  registry.upsertTask({
    ...registry.getTask(task.id)!,
    status: "done",
    outcome: "shipped",
    updatedAt: 2_000,
  });
  registry.applyDiscovery([
    mkDiscovered({ syntheticId: "later-worker" }),
    mkDiscovered({ syntheticId: "worker-after-completion", pid: 2, tty: "ttys2" }),
  ]);
  assert.equal(registry.getSession("worker-after-completion")?.task, null);
});

test("the stamp carries the repository root, because two repos can hold one slug", () => {
  // The whole reason the link is the run's three-part KEY rather than provider and slug: the
  // projection legitimately holds `add-widgets` in two checkouts (`pipeline-sse.test.ts` pins
  // that case), and every surface downstream addresses the run by this triple. A link missing
  // the repository would deep-link half the fleet's correlated cards at the wrong run.
  const other = "/repo/second";
  const { session } = fleet(
    [mkRun(), mkRun({ repoRoot: other, worktree: `${other}/.worktrees/add-widgets` })],
    `${other}/.worktrees/add-widgets`,
  );
  assert.equal(session.pipeline?.repoRoot, other);
  assert.equal(session.pipeline?.slug, "add-widgets");
});

test("an agent working BELOW the worktree root is still doing that run's work", () => {
  // The engine spawns its agent at the top, but a shell that has `cd`'d into `src/` is the
  // same session on the same feature. Containment, not equality.
  const { session } = fleet([mkRun()], `${REPO}/.worktrees/add-widgets/src/server`);
  assert.equal(session.pipeline?.slug, "add-widgets");
});

test("a sibling worktree whose name merely starts with another's is not claimed", () => {
  // The dangerous direction for a bare `startsWith`: `.worktrees/add` is a prefix of
  // `.worktrees/add-widgets`, and a session in the longer one would be stamped with the
  // shorter one's run - a chip, a frame and a deep link all naming the wrong feature.
  const { session } = fleet(
    [mkRun({ slug: "add", worktree: `${REPO}/.worktrees/add` })],
    `${REPO}/.worktrees/add-widgets`,
  );
  assert.equal(session.pipeline, null);
});

test("when two runs' worktrees nest, the deepest one claims the session", () => {
  // Nothing stops an engine from cutting a worktree inside a worktree, and the INNER run is
  // the one whose work is happening there. Asserted from both list orders, because a reader
  // that simply took the first match would pass one of them by luck.
  const outer = mkRun({ slug: "outer", worktree: `${REPO}/.worktrees/outer` });
  const inner = mkRun({
    slug: "inner",
    worktree: `${REPO}/.worktrees/outer/.worktrees/inner`,
    lastStep: "plan",
  });
  for (const runs of [[outer, inner], [inner, outer]]) {
    const { session } = fleet(runs, `${REPO}/.worktrees/outer/.worktrees/inner`, "nested");
    assert.equal(session.pipeline?.slug, "inner");
    assert.equal(session.pipeline?.step, "plan");
  }
});

test("a session outside every worktree, and a session with no cwd, are untouched", () => {
  assert.equal(fleet([mkRun()], `${REPO}/src`, "a").session.pipeline, null);
  assert.equal(fleet([mkRun()], null, "b").session.pipeline, null);
  // The repository root itself is not a worktree. An operator's own agent in the main
  // checkout of a repository the engine also drives is an ordinary session.
  assert.equal(fleet([mkRun()], REPO, "c").session.pipeline, null);
});

test("a run with no worktree of its own claims nothing", () => {
  // A feature the engine has recorded but not cut a worktree for. There is no path to match
  // against, and the alternative - matching on the repository root - would stamp every
  // session in the checkout with a run that has not started.
  const { session } = fleet(
    [mkRun({ worktree: null })],
    `${REPO}/.worktrees/add-widgets`,
    "no-worktree",
  );
  assert.equal(session.pipeline, null);
});

test("with no repository consented to, nothing is stamped and nothing is asked", () => {
  // The consent check is FREE rather than a second gate: the watcher retires every run of a
  // repository whose consent was withdrawn, so an unobserved fleet has an empty projection
  // and this is the whole of the correlation pass for it.
  const { session } = fleet([], `${REPO}/.worktrees/add-widgets`, "unobserved");
  assert.equal(session.pipeline, null);
});

test("a step advancing re-stamps the card, without the session moving", () => {
  // The reason the projection has to notify the registry at all. A run's `lastStep` advances
  // while the agent sits in the same directory with the same pid, so a stamp that were only
  // re-derived on a discovery sweep would show the step the run was on when the agent was
  // first seen - for the whole life of the session.
  const { registry, session } = fleet([mkRun()], `${REPO}/.worktrees/add-widgets`, "moving");
  assert.equal(session.pipeline?.step, "build");

  registry.upsertPipelineRun(mkRun({ lastStep: "test_suite", updatedAt: 2000 }));
  assert.equal(registry.getSession("moving")?.pipeline?.step, "test_suite");
});

test("a retired run gives its sessions back", () => {
  // The engine tore the worktree down, or consent was withdrawn. Either way the session is an
  // ordinary one again - composer included - which is the fail-open posture stated on the
  // field. A stamp left behind would leave a card permanently unable to be replied to,
  // pointing at a run the dashboard no longer holds.
  const { registry } = fleet([mkRun()], `${REPO}/.worktrees/add-widgets`, "retired");
  assert.equal(registry.getSession("retired")?.pipeline?.slug, "add-widgets");

  registry.removePipelineRun("ai-conductor", REPO, "add-widgets");
  assert.equal(registry.getSession("retired")?.pipeline, null);
});

test("a run whose worktree MOVES hands one session back and claims the other", () => {
  // The engine re-cut the feature's worktree somewhere else. Two populations move in opposite
  // directions in the same update, and getting either wrong is invisible until somebody tries
  // to type: the agent left behind in the old path would keep a chip and a suppressed composer
  // pointing at a directory the run no longer owns, and the agent in the new path would go on
  // looking like an ordinary session anybody may interrupt.
  //
  // Both are covered by ONE pass because the candidate set is `named OR inside` rather than
  // `inside`: the session in the old worktree still NAMES this run, which is the same property
  // that lets a retired run give its sessions back. Pinned here as its own case because the two
  // reach that set through different halves of the condition.
  const registry = new Registry();
  registry.initializePipelineRuns([mkRun()]);
  registry.applyDiscovery([
    mkDiscovered({ syntheticId: "was-here", cwd: `${REPO}/.worktrees/add-widgets`, tty: "ttys1" }),
    mkDiscovered({ syntheticId: "now-here", cwd: `${REPO}/.worktrees/add-widgets-v2`, tty: "ttys2", pid: 2 }),
  ]);
  assert.equal(registry.getSession("was-here")?.pipeline?.slug, "add-widgets");
  assert.equal(registry.getSession("now-here")?.pipeline, null);

  registry.upsertPipelineRun(
    mkRun({ worktree: `${REPO}/.worktrees/add-widgets-v2`, updatedAt: 2000 }),
  );

  assert.equal(registry.getSession("was-here")?.pipeline, null, "the old path is handed back");
  assert.equal(registry.getSession("now-here")?.pipeline?.slug, "add-widgets", "the new one is claimed");
  assert.equal(canMessage(registry.getSession("was-here")!), true);
  assert.equal(canMessage(registry.getSession("now-here")!), false);
});

test("a moved worktree is never suppressed as a no-op update", () => {
  // The guard the case above depends on, asserted directly rather than through its effect.
  // `upsertPipelineRun` returns early when nothing a human could see moved, and that check is
  // the only thing standing between a worktree change and the re-stamp - so `worktree` being
  // one of the fields it compares is load-bearing for correlation, not just for the rail.
  // A future edit that trimmed the comparison to "what the Runs page draws" would take this
  // out, and every symptom would appear somewhere else entirely.
  const before = mkRun();
  assert.equal(pipelineRunDisplayEqual(before, mkRun({ updatedAt: 9999 })), true);
  assert.equal(
    pipelineRunDisplayEqual(before, mkRun({ worktree: `${REPO}/.worktrees/somewhere-else` })),
    false,
    "a worktree change has to reach the sessions that follow it",
  );
  assert.equal(pipelineRunDisplayEqual(before, mkRun({ worktree: null })), false);
});

test("a run somebody else's session is inside does not disturb this one", () => {
  // The re-stamp sweep is keyed on the run that moved, and this is the assertion that it is:
  // a fleet where one correlated card and one ordinary card sit side by side must not have
  // the ordinary one re-emitted, or re-stamped, when the other's run advances.
  const registry = new Registry();
  registry.initializePipelineRuns([mkRun()]);
  registry.applyDiscovery([
    mkDiscovered({ syntheticId: "driven", cwd: `${REPO}/.worktrees/add-widgets`, tty: "ttys1" }),
    mkDiscovered({ syntheticId: "ordinary", cwd: `${REPO}/src`, tty: "ttys2", pid: 2 }),
  ]);
  registry.upsertPipelineRun(mkRun({ lastStep: "retro", updatedAt: 3000 }));

  assert.equal(registry.getSession("driven")?.pipeline?.step, "retro");
  assert.equal(registry.getSession("ordinary")?.pipeline, null);
});

test("a session Mission Control launched itself is never correlated, wherever it sits", () => {
  // A dispatch whose worktree happens to land inside a directory the engine also manages -
  // an operator pointing a task at a conductor feature branch is the obvious way there.
  //
  // Both doors are asserted, because an invariant one door enforces is not an invariant.
  // `registerSdkSession` writes the field null structurally; the re-stamp sweep is the OTHER
  // way in, and it walks the whole fleet by design (a retired run has no worktree left to
  // test against). Without its runtime guard, a run advancing one step would quietly take the
  // composer off a session whose conversation nothing else can answer.
  const registry = new Registry();
  registry.initializePipelineRuns([mkRun()]);
  const sdk = registry.registerSdkSession({
    id: "sdk:00000000-0000-4000-8000-000000000000",
    agent: "claude",
    name: "dispatched",
    cwd: `${REPO}/.worktrees/add-widgets`,
  });
  assert.equal(sdk.pipeline, null, "the launch door writes it null");

  registry.upsertPipelineRun(mkRun({ lastStep: "retro", updatedAt: 3000 }));
  const after = registry.getSession(sdk.id)!;
  assert.equal(after.pipeline, null, "and the re-stamp door leaves it null");
  assert.equal(canMessage(after), true, "so it is still a session you can talk to");
});

test("a managed Pipeline host never falls back to its process cwd without a commission", () => {
  const registry = new Registry();
  const host = registry.registerSdkSession({
    id: "sdk:managed-workspace",
    agent: "codex",
    name: "managed workspace",
    cwd: REPO,
    agentSessionId: "managed-workspace",
    gitBranch: null,
    gitRoot: REPO,
    repoRoot: REPO,
  });
  const authoring = `${REPO}/.worktrees/engineer-add-widgets`;
  registry.upsertTask(mkTask({
    id: "managed-workspace-task",
    kind: "pipeline",
    agent: "codex",
    repoRoot: REPO,
    status: "running",
    sessionId: host.id,
    pipelineRun: {
      provider: "ai-conductor",
      repoRoot: REPO,
      slug: "add-widgets",
    },
    pipelineWorkspacePath: authoring,
  }));

  assert.equal(registry.getSession(host.id)?.cwd, REPO);
  assert.equal(registry.getSession(host.id)?.workspaceRoot, null);
  assert.equal(registry.getSession(host.id)?.pipeline, null);

  registry.upsertPipelineRun(mkRun());
  assert.equal(registry.getSession(host.id)?.workspaceRoot, null);
  assert.equal(registry.getSession(host.id)?.pipeline, null);

  registry.removePipelineRun("ai-conductor", REPO, "add-widgets");
  assert.equal(registry.getSession(host.id)?.workspaceRoot, null);
});

test("an engine-driven session cannot be messaged, and says why", () => {
  // The predicate the whole composer suppression hangs off. It refuses AHEAD of the pane
  // question and that order is the point: the session HAS a pane - the engine spawned it into
  // a real tty, which is why it is carded - and it is running under `--print`, so "no pane to
  // send to" would be false while the box it explains would still be enabled.
  const { session } = fleet([mkRun()], `${REPO}/.worktrees/add-widgets`, "driven");
  assert.equal(canMessage(session), false);
  assert.equal(messageBlockReason(session), "pipeline");

  const ordinary = fleet([mkRun()], `${REPO}/src`, "ordinary").session;
  assert.equal(canMessage(ordinary), true);
  assert.equal(messageBlockReason(ordinary), null);
});

test("the predicate's two refusals stay distinguishable", () => {
  // A driver-run session with no pane is refused for the OTHER reason, and a pane-backed
  // ordinary session is not refused at all. Three answers, because the surfaces that print
  // them say three different things.
  const paneless = { terminals: [], runtime: "terminal" as const };
  assert.equal(messageBlockReason(paneless), "no-pane");
  assert.equal(messageBlockReason({ ...paneless, runtime: "sdk" }), null);
  assert.equal(
    messageBlockReason({
      ...paneless,
      runtime: "sdk",
      pipeline: { provider: "ai-conductor", repoRoot: REPO, slug: "s", step: null },
    }),
    "pipeline",
    "an engine-driven session is refused whatever runtime it claims",
  );
});

test("a session with no pipeline field at all is messageable", () => {
  // The field is optional on the predicate's parameter so anything session-shaped can be
  // asked - a `DiscoveredSession`, a hand-built fixture, a caller written before pipelines
  // existed. Absent and null have to be the same answer or every one of those flips.
  assert.equal(canMessage({ terminals: [], runtime: "sdk" }), true);
});

test("the daemon's own write path refuses one, not just the Send box", async () => {
  // THE ONE A UI GATE CANNOT COVER. `canMessage` refuses the operator's Send box and the
  // send route, but three callers reach `injectPrompt` without going near either: a
  // workflow's session action, a queued turn's delivery, and a task assignment. An
  // engine-driven session owns a real writable tty - that is WHY it is carded - so every
  // pane check downstream passes and the bytes land in a pty nothing is reading.
  //
  // That is not a hypothetical: `dispatch-readiness.test.ts` exists because a pty "swallows
  // keystrokes just as happily when nothing is reading", and a prompt written into one left
  // a dispatched task marked `running` against a session that sat empty for 13 minutes.
  const { injectPrompt, paneAcceptsPrompt } = await import("../src/server/actions.ts");
  const { session: driven } = fleet([mkRun()], `${REPO}/.worktrees/add-widgets`, "write-driven");

  const probe = await paneAcceptsPrompt(driven);
  assert.equal(probe.ok, false);
  assert.match(probe.error ?? "", /external engine is driving/);

  const wrote = await injectPrompt(driven, "do the thing");
  assert.equal(wrote.ok, false);
  assert.equal(wrote.pasted, false, "refused BEFORE a byte reached the pane");
  assert.match(wrote.error ?? "", /external engine is driving/);

  // And the refusal is the correlation's, not a blanket one: the identical session outside
  // every worktree is refused for its own reasons, in its own words, or not at all.
  const { session: ordinary } = fleet([mkRun()], `${REPO}/src`, "write-ordinary");
  const other = await paneAcceptsPrompt(ordinary);
  assert.doesNotMatch(other.error ?? "", /external engine is driving/);
});
