import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";

// "Discovered" is not "ready", and a successful tmux write is not a delivered prompt.
//
// Both were treated as though they were, and a dispatched task paid for it: discovery
// is a `ps` sweep, so it fired ~1.4s after the tmux spawn, a fixed 2s SETTLE_MS was
// taken as "the TUI must be up by now", and the opening prompt was pasted at
// 13:58:33.418 into an agent whose SessionStart hook did not fire until 13:58:34.065.
// tmux accepted the write - a pty swallows keystrokes just as happily when nothing is
// reading - so `injectPrompt` returned ok and the task was marked `running` against a
// session that sat empty for 13 minutes.
//
// These pin the two signals that replace the guesswork: the first hook (proof the
// agent can read) and the `working` transition (proof it actually did).

const home = mkdtempSync(join(tmpdir(), "fleet-dispatch-readiness-"));
process.env.FLEET_HOME = home;

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");

after(() => rmSync(home, { recursive: true, force: true }));

openDb();

const CWD = "/wt/task-1";
/** Long enough to prove a wait resolves; short enough that a timeout test is instant. */
const BRIEF_MS = 50;

function mkDiscovered(over: Partial<DiscoveredSession> = {}): DiscoveredSession {
  return {
    syntheticId: "sid",
    agent: "claude",
    name: "work",
    nameSource: "process",
    cwd: CWD,
    gitBranch: "harness/task-1",
    nomistakesGated: false,
    pid: 1,
    tty: "ttys015",
    wezterm: null,
    tmux: { session: "s", window: "w", windowIndex: 0, paneId: "%1" },
    startedAt: 0,
    ...over,
  } as DiscoveredSession;
}

/** The hook the agent fires once its input loop exists. */
function sessionStart(registry: InstanceType<typeof Registry>, paneId = "%1"): void {
  registry.applyHook({
    event: "SessionStart",
    sessionId: "agent-1",
    cwd: CWD,
    transcriptPath: null,
    env: { tmuxPane: paneId },
  });
}

test("waitForSessionAtCwd resolves on bare process discovery - it proves nothing about readiness", async () => {
  // Not a complaint about this method, a statement of its contract. This resolving
  // while `hooksSeen` is false IS the 647ms window the old dispatcher typed into.
  const registry = new Registry();
  registry.applyDiscovery([mkDiscovered({ syntheticId: "disc-1" })]);

  const s = await registry.waitForSessionAtCwd(CWD, BRIEF_MS);
  assert.ok(s, "the process is there");
  assert.equal(s?.hooksSeen, false, "...and it has not yet said it can read anything");
});

test("waitForReadySessionAtCwd does NOT resolve on discovery alone", async () => {
  const registry = new Registry();
  registry.applyDiscovery([mkDiscovered({ syntheticId: "boot-1" })]);

  // The whole fix in one assertion: a booting agent is not a ready one.
  assert.equal(await registry.waitForReadySessionAtCwd(CWD, BRIEF_MS), null);
});

test("waitForReadySessionAtCwd resolves once the agent's first hook lands", async () => {
  const registry = new Registry();
  registry.applyDiscovery([mkDiscovered({ syntheticId: "boot-2" })]);

  const ready = registry.waitForReadySessionAtCwd(CWD, 5000);
  sessionStart(registry); // the TUI is up, ~4s after exec in the real trace
  const s = await ready;

  assert.ok(s, "a hook fired, so the input loop exists");
  assert.equal(s?.hooksSeen, true);
});

test("waitForReadySessionAtCwd short-circuits for an agent that is ALREADY hooked", async () => {
  // A re-dispatch into a live session must not wait for a hook that already fired.
  const registry = new Registry();
  registry.applyDiscovery([mkDiscovered({ syntheticId: "warm-1" })]);
  sessionStart(registry);

  const s = await registry.waitForReadySessionAtCwd(CWD, BRIEF_MS);
  assert.equal(s?.hooksSeen, true);
});

test("a null from waitForReadySessionAtCwd means no evidence, not 'not ready'", async () => {
  // An agent with no hooks installed can never satisfy this, and refusing to dispatch
  // to it would be a regression - so the dispatcher falls back to the old fixed sleep
  // on exactly this null. Pinned so nobody "fixes" the null into a throw.
  const registry = new Registry();
  registry.applyDiscovery([mkDiscovered({ syntheticId: "hookless-1" })]);

  assert.equal(await registry.waitForReadySessionAtCwd(CWD, BRIEF_MS), null);
  assert.equal(registry.getSession("hookless-1")?.state !== "exited", true, "it is alive and well");
});

test("waitForPromptAcceptedAtCwd resolves true on the working transition", async () => {
  const registry = new Registry();
  registry.applyDiscovery([mkDiscovered({ syntheticId: "accept-1" })]);
  sessionStart(registry);

  // Subscribe BEFORE typing - the hook can beat the caller's next line.
  const accepted = registry.waitForPromptAcceptedAtCwd(CWD, 5000);
  registry.applyHook({
    event: "UserPromptSubmit",
    sessionId: "agent-1",
    cwd: CWD,
    transcriptPath: null,
    env: { tmuxPane: "%1" },
  });

  assert.equal(await accepted, true);
});

test("waitForPromptAcceptedAtCwd resolves false when the agent just sits there", async () => {
  // The observed failure: text written to the pty, agent never ingests it, state stays
  // idle. This false is what turns a silent lie into a loud dispatch failure.
  const registry = new Registry();
  registry.applyDiscovery([mkDiscovered({ syntheticId: "swallow-1" })]);
  sessionStart(registry);

  assert.equal(await registry.waitForPromptAcceptedAtCwd(CWD, BRIEF_MS), false);
});

test("waitForPromptAcceptedAtCwd ignores a `working` session at a DIFFERENT cwd", async () => {
  // Worktrees are one-per-task, and that isolation is what makes cwd a safe key here.
  const registry = new Registry();
  registry.applyDiscovery([
    mkDiscovered({ syntheticId: "mine-1" }),
    mkDiscovered({ syntheticId: "other-1", cwd: "/wt/task-2", tmux: { session: "o", window: "w", windowIndex: 0, paneId: "%2" } }),
  ]);

  const accepted = registry.waitForPromptAcceptedAtCwd(CWD, BRIEF_MS);
  registry.applyHook({
    event: "UserPromptSubmit",
    sessionId: "agent-2",
    cwd: "/wt/task-2",
    transcriptPath: null,
    env: { tmuxPane: "%2" },
  });

  assert.equal(await accepted, false, "someone else's prompt is not evidence about mine");
});
