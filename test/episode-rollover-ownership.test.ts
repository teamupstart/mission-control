import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkMuxHandle, mkTask } from "./helpers/session-fixture.ts";
import { terminalResourceId } from "../src/shared/pane.ts";
import type { BoundPane } from "../src/server/terminal/registry.ts";
import type { TerminalResult } from "../src/server/terminal/types.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";

const home = mkdtempSync(join(tmpdir(), "mission-episode-rollover-"));
process.env.HARNESS_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const { sendText } = await import("../src/server/actions.ts");

after(() => rmSync(home, { recursive: true, force: true }));

const ok = (): TerminalResult => ({ ok: true, outcomeUnknown: false });
const WORKTREE = "/repo/pooled-slot-11";
const HOME_NAME = "Phase 4 live delivery";
const PANE = "%11";
const FIRST_ID = "019f8f60-b3ed-73c1-8b7c-d8a8a6bf4414";
const FORKED_ID = "019f8f60-b43f-7163-8311-35f7e19fad67";

/**
 * A dispatched task being worked by a live agent: the task owns the session, the session
 * sits in the task's pooled worktree under the task's terminal home, and a work episode
 * anchors the agent's identity. This is the state every `running` task is in.
 *
 * `witnessIdentity` decides where the identity comes from. Discovery reading it (Codex's
 * open rollout) is exact, and a conflicting hook is refused against it - so a session that
 * was witnessed can only have its identity moved by discovery reading again.
 */
let seq = 0;
function dispatched(id: string, over: { witnessIdentity?: boolean } = {}) {
  // Each test gets its own session/task: the work-episode table is keyed by session id
  // and these tests share one HARNESS_HOME, so a shared id would leak state between them.
  const SID = `rollover-session-${++seq}`;
  const TASK = `live-task-${seq}`;
  const registry = new Registry();
  const handle = mkMuxHandle({
    backend: "tmux",
    session: "workspace-uuid",
    sessionName: HOME_NAME,
    paneId: PANE,
  });
  const discovered: DiscoveredSession = {
    syntheticId: SID,
    agent: "codex",
    name: SID,
    nameSource: "wezterm",
    cwd: WORKTREE,
    gitBranch: "codex/phase-4-live",
    gitRoot: "/repo",
    repoRoot: "/repo",
    nomistakesGated: false,
    pid: 1,
    tty: "ttys001",
    terminals: [handle],
    startedAt: 0,
    ...(over.witnessIdentity === false ? {} : { agentSessionId: id }),
  };
  registry.applyDiscovery([discovered]);
  registry.upsertTask(mkTask({
    id: TASK,
    title: "Workflow builder Phase 4",
    status: "running",
    agent: "codex",
    repoRoot: "/repo",
    worktreePath: WORKTREE,
    provider: "treehouse",
    homeName: HOME_NAME,
    terminalResourceId: terminalResourceId(handle),
    sessionId: SID,
  }));
  if (over.witnessIdentity === false) {
    registry.applyHook({
      agent: "codex", event: "SessionStart", sessionId: id,
      cwd: WORKTREE, transcriptPath: null, env: { tmuxPane: PANE },
    } as Parameters<typeof registry.applyHook>[0]);
  }
  registry.workEpisodeForSession(SID);

  const writes: string[] = [];
  const pane: BoundPane = {
    kind: "multiplexer",
    backend: "tmux",
    label: "tmux",
    token: `tmux:${PANE}`,
    capture: async () => null,
    mode: async () => null,
    write: {
      text: async (text) => (writes.push(`text:${text}`), ok()),
      keys: async () => (writes.push("keys"), ok()),
      paste: async (text) => (writes.push(`paste:${text}`), ok()),
    },
  };
  return {
    registry,
    writes,
    SID,
    TASK,
    deps: { pane: () => pane, capture: async () => null, sleep: async () => {} },
    guard: () => registry.promptResourceBlockerForSession(SID),
    session: () => registry.getSession(SID)!,
    episodeAgent: () => registry.workEpisodeForSession(SID)?.agentSessionId,
    /** Discovery reads the process again and reports a different rollout's identity. */
    discoveryReReads(next: string) {
      registry.applyDiscovery([{ ...discovered, agentSessionId: next }]);
      return registry.getSession(SID)!;
    },
    /** The agent is deliberately started fresh: `/clear` mints a new id on the same pane. */
    clears(next: string) {
      registry.applyHook({
        agent: "codex", event: "SessionStart", source: "clear", sessionId: next,
        cwd: WORKTREE, transcriptPath: null, env: { tmuxPane: PANE },
      } as Parameters<typeof registry.applyHook>[0]);
      return registry.getSession(SID)!;
    },
  };
}

test("a re-read of a live agent's identity does not cancel the task it is working", () => {
  const { registry, discoveryReReads, episodeAgent, SID, TASK } = dispatched(FIRST_ID);
  discoveryReReads(FORKED_ID);

  // The rebind really happened - otherwise this test would pass without exercising anything.
  assert.equal(episodeAgent(), FORKED_ID, "the episode never rebound; the test proves nothing");

  const task = registry.getTask(TASK)!;
  // A session id is `proc:tty:pid:start`, so this is one OS process throughout. Our
  // reading of who it is changed; the agent did not, and it is still mid-task.
  assert.equal(task.status, "running", "a live agent's task was cancelled by an identity re-read");
  assert.equal(task.sessionId, SID, "the task lost the session still working it");
  assert.equal(registry.workEpisodeForTask(TASK)?.sessionId, SID);
});

test("a live agent can still be prompted after its identity is re-read", async () => {
  const { discoveryReReads, episodeAgent, writes, deps, guard } = dispatched(FIRST_ID);
  const session = discoveryReReads(FORKED_ID);
  assert.equal(episodeAgent(), FORKED_ID, "the episode never rebound; the test proves nothing");

  const result = await sendText(session, "you are authorized, continue", true, deps, guard);
  assert.equal(result.ok, true, `prompt was blocked: ${result.error ?? ""}`);
  assert.deepEqual(writes, ["text:you are authorized, continue", "keys"]);
});

test("an explicit /clear still gives up the work the task was dispatched for", () => {
  // Identity from hooks only: discovery never witnessed one, so the `/clear` is not
  // refused against an exact passive read.
  const { registry, clears, episodeAgent, TASK } = dispatched(FIRST_ID, { witnessIdentity: false });
  clears("019f8f60-cccc-7163-8311-35f7e19fad67");

  assert.equal(episodeAgent(), "019f8f60-cccc-7163-8311-35f7e19fad67");
  // A deliberate fresh start is the one identity change that really does abandon the
  // dispatched work - the case invalidation exists for.
  assert.equal(registry.getTask(TASK)?.status, "cancelled");
});

test("the barrier still blocks a session sitting in a genuinely cancelled task's tree", async () => {
  const { registry, writes, deps, guard, session, SID, TASK } = dispatched(FIRST_ID);
  // The operator cancelled the task and its teardown failed, so the resources remain
  // tracked and the session predates the cancellation. Nothing may be typed at it.
  const liveSession = session();
  //
  // Taken from the episode rather than from a fresh `Date.now()`, and that is not tidiness:
  // an episode starts at wall-clock time and this line runs microseconds later, so the two
  // readings land in the same MILLISECOND often enough to matter. `outcomePrecedesSessionWork`
  // compares them with `>=`, so an equal pair reads as a rollover - the barrier stands down
  // and this test fails for a reason that has nothing to do with what it is testing.
  const episode = registry.workEpisodeForSession(SID)!;
  registry.upsertTask({
    ...registry.getTask(TASK)!,
    status: "cancelled",
    sessionId: null,
    completedAt: episode.startedAt + 1,
  });

  const result = await sendText(liveSession, "more work", true, deps, guard);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /clean up.*cancelled task/);
  assert.deepEqual(writes, []);
});
