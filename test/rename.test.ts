import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rename, validateSessionName, type RenameDeps } from "../src/server/actions.ts";
import type { RunResult } from "../src/server/util/exec.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { Session, SessionState, Task, TmuxInfo, WeztermInfo } from "../src/shared/types.ts";

// Isolate the daemon's SQLite DB before the Registry (which reads config/db) loads.
process.env.HARNESS_HOME = mkdtempSync(join(tmpdir(), "harness-rename-"));
const { Registry } = await import("../src/server/registry.ts");

const tmux: TmuxInfo = { session: "work", window: "0", windowIndex: 0, paneId: "%3" };
const wezterm: WeztermInfo = { paneId: 12, tabId: 4, windowId: 1, tabTitle: "old", isActive: true };

function mkSession(over: Partial<Session> = {}): Session {
  return {
    id: "s",
    agent: "claude",
    name: "old",
    nameSource: "tmux",
    state: "working" as SessionState,
    cwd: null,
    gitBranch: null,
    gitRoot: null,
    nomistakesGated: false,
    pid: 4242,
    tty: null,
    permissionMode: null,
    wezterm: null,
    tmux: null,
    agentSessionId: null,
    transcriptPath: null,
    instrumented: true,
    activity: null,
    startedAt: null,
    firstSeen: 0,
    lastSeen: 0,
    lastActivity: null,
    pendingReviews: 0,
    nomistakes: null,
    nomistakesNarration: null,
    task: null,
    prUrl: null,
    prNumber: null,
    prState: null,
    prChecks: null,
    meta: null,
    note: null,
    ...over,
  };
}

// ---- validateSessionName (pure) ----

test("validateSessionName trims and accepts a plain tmux name", () => {
  const r = validateSessionName({ tmux, wezterm: null }, "  my session  ");
  assert.deepEqual(r, { ok: true, name: "my session" });
});

test("validateSessionName rejects an empty / whitespace-only name", () => {
  assert.equal(validateSessionName({ tmux, wezterm: null }, "   ").ok, false);
  assert.equal(validateSessionName({ tmux, wezterm: null }, "").ok, false);
});

test("validateSessionName rejects control characters for either handle", () => {
  assert.equal(validateSessionName({ tmux, wezterm: null }, "a\nb").ok, false);
  assert.equal(validateSessionName({ tmux: null, wezterm }, "a\tb").ok, false);
});

test("validateSessionName rejects '.' and ':' only for a tmux session", () => {
  // tmux target specs use these as separators, so rename-session refuses them.
  assert.equal(validateSessionName({ tmux, wezterm: null }, "a.b").ok, false);
  assert.equal(validateSessionName({ tmux, wezterm: null }, "a:b").ok, false);
  // A wezterm tab title is free-form, so the same characters are fine there.
  assert.deepEqual(validateSessionName({ tmux: null, wezterm }, "a.b:c"), {
    ok: true,
    name: "a.b:c",
  });
});

test("validateSessionName rejects a leading '$' only for a tmux session", () => {
  // '$' is tmux's session-ID sigil: `-t '$0'` resolves by ID and never falls back
  // to a name, so a session named `$0` would make focus/kill hit whichever session
  // owns ID 0. tmux itself allows the rename, so we have to refuse it here.
  assert.equal(validateSessionName({ tmux, wezterm: null }, "$0").ok, false);
  assert.equal(validateSessionName({ tmux, wezterm: null }, "$work").ok, false);
  // Only a leading '$' aliases an id - one inside the name is just a character.
  assert.deepEqual(validateSessionName({ tmux, wezterm: null }, "cost$$"), {
    ok: true,
    name: "cost$$",
  });
  // A wezterm tab title is free-form, so a leading '$' is fine there.
  assert.deepEqual(validateSessionName({ tmux: null, wezterm }, "$0"), {
    ok: true,
    name: "$0",
  });
});

test("validateSessionName rejects a session with no renameable handle", () => {
  const r = validateSessionName({ tmux: null, wezterm: null }, "whatever");
  assert.equal(r.ok, false);
});

// ---- rename (dep-injected branching) ----

function spyDeps(
  over: Partial<RenameDeps> = {},
): { deps: RenameDeps; tmuxCalls: [string, string][]; wezCalls: [number, string][] } {
  const tmuxCalls: [string, string][] = [];
  const wezCalls: [number, string][] = [];
  const ok: RunResult = { stdout: "", stderr: "", code: 0 };
  const deps: RenameDeps = {
    renameTmuxSession: (from, to) => {
      tmuxCalls.push([from, to]);
      return Promise.resolve(ok);
    },
    setWeztermTabTitle: (paneId, title) => {
      wezCalls.push([paneId, title]);
      return Promise.resolve(ok);
    },
    ...over,
  };
  return { deps, tmuxCalls, wezCalls };
}

test("rename: a tmux session renames the tmux session by its current name", async () => {
  const { deps, tmuxCalls, wezCalls } = spyDeps();
  const r = await rename(mkSession({ tmux }), "renamed", deps);

  assert.deepEqual(r, { ok: true });
  assert.deepEqual(tmuxCalls, [["work", "renamed"]]);
  assert.deepEqual(wezCalls, [], "tmux wins - the wezterm path is never touched");
});

test("rename: a wezterm-only session sets the tab title on its pane", async () => {
  const { deps, tmuxCalls, wezCalls } = spyDeps();
  const r = await rename(mkSession({ tmux: null, wezterm, nameSource: "wezterm" }), "renamed", deps);

  assert.deepEqual(r, { ok: true });
  assert.deepEqual(wezCalls, [[12, "renamed"]]);
  assert.deepEqual(tmuxCalls, []);
});

test("rename: tmux wins when a session has both handles", async () => {
  const { deps, tmuxCalls, wezCalls } = spyDeps();
  await rename(mkSession({ tmux, wezterm }), "renamed", deps);

  assert.deepEqual(tmuxCalls, [["work", "renamed"]]);
  assert.deepEqual(wezCalls, []);
});

test("rename: a failed tmux rename surfaces stderr", async () => {
  const fail: RunResult = { stdout: "", stderr: "duplicate session: renamed", code: 1 };
  const { deps } = spyDeps({ renameTmuxSession: () => Promise.resolve(fail) });
  const r = await rename(mkSession({ tmux }), "renamed", deps);

  assert.equal(r.ok, false);
  assert.equal(r.error, "duplicate session: renamed");
});

test("rename: a handle-less session is an error, not a crash", async () => {
  const { deps, tmuxCalls, wezCalls } = spyDeps();
  const r = await rename(mkSession(), "renamed", deps);

  assert.equal(r.ok, false);
  assert.deepEqual(tmuxCalls, []);
  assert.deepEqual(wezCalls, []);
});

// ---- Registry.renameSession (optimistic echo) ----

const PANE = { session: "work", window: "0", windowIndex: 0, paneId: "%3" };

function disco(over: Partial<DiscoveredSession> = {}): DiscoveredSession {
  return {
    syntheticId: "s1",
    agent: "claude",
    name: "work",
    nameSource: "tmux",
    cwd: "/repo",
    gitBranch: "main",
    gitRoot: null,
    nomistakesGated: false,
    pid: 1,
    tty: "ttys1",
    wezterm: null,
    tmux: PANE,
    startedAt: 0,
    ...over,
  };
}

function sessionOf(r: InstanceType<typeof Registry>, id = "s1"): Session | undefined {
  return r.snapshot().sessions.find((s) => s.id === id);
}

test("renameSession echoes the new name onto the card and its tmux handle", () => {
  const r = new Registry();
  r.applyDiscovery([disco()]);

  let emitted = 0;
  r.subscribe((e) => {
    if (e.type === "session_upsert" && e.session.id === "s1") emitted++;
  });

  r.renameSession("s1", "renamed");
  const s = sessionOf(r)!;
  assert.equal(s.name, "renamed");
  // Focus/Kill target tmux.session by name, so it must move with the display name.
  assert.equal(s.tmux?.session, "renamed");
  assert.equal(emitted, 1, "the card re-renders immediately");
});

test("renameSession updates a wezterm tab title in step", () => {
  const r = new Registry();
  r.applyDiscovery([
    disco({ tmux: null, nameSource: "wezterm", wezterm: { paneId: 12, tabId: 4, windowId: 1, tabTitle: "work", isActive: true } }),
  ]);

  r.renameSession("s1", "renamed");
  assert.equal(sessionOf(r)?.wezterm?.tabTitle, "renamed");
});

test("renameSession is a no-op when the name is unchanged", () => {
  const r = new Registry();
  r.applyDiscovery([disco()]);
  let emitted = 0;
  r.subscribe((e) => {
    if (e.type === "session_upsert" && e.session.id === "s1") emitted++;
  });
  r.renameSession("s1", "work"); // same as discovery's name
  assert.equal(emitted, 0);
});

test("a discovery sweep that has caught up doesn't spuriously re-emit after a rename", () => {
  const r = new Registry();
  r.applyDiscovery([disco()]);
  r.renameSession("s1", "renamed");

  let emitted = 0;
  r.subscribe((e) => {
    if (e.type === "session_upsert" && e.session.id === "s1") emitted++;
  });
  // The terminal really was renamed, so the next sweep reports the new name.
  r.applyDiscovery([disco({ name: "renamed", tmux: { ...PANE, session: "renamed" } })]);
  assert.equal(emitted, 0, "the optimistic value already matches - nothing changed");
  assert.equal(sessionOf(r)?.name, "renamed");
});

test("renameSession on an unknown session id is a safe no-op", () => {
  const r = new Registry();
  r.applyDiscovery([disco()]);
  assert.doesNotThrow(() => r.renameSession("nope", "x"));
});

// ---- Registry.renameSession (dispatched task binding) ----

function mkTask(over: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "T",
    intent: "do the thing",
    kind: "ship",
    agent: "claude",
    repoRoot: "/repo",
    worktreePath: "/wt/work",
    branch: null,
    provider: null,
    tmuxSession: "work",
    sessionId: "s1",
    status: "running",
    outcome: null,
    outcomeUrl: null,
    error: null,
    createdAt: 0,
    updatedAt: 0,
    dispatchedAt: null,
    completedAt: null,
    ...over,
  };
}

function taskOf(r: InstanceType<typeof Registry>, id = "t1"): Task | undefined {
  return r.snapshot().tasks.find((t) => t.id === id);
}

// A dispatched agent runs inside its own worktree, so its card's cwd is the
// task's worktreePath - the join that binds the two.
const dispatched = disco({ cwd: "/wt/work" });

test("renameSession moves a dispatched task's tmuxSession binding with the name", () => {
  const r = new Registry();
  r.applyDiscovery([dispatched]);
  r.upsertTask(mkTask());

  r.renameSession("s1", "renamed");

  // reconcileOnStartup probes this name after a restart and force-removes the
  // worktree when it doesn't resolve - a stale binding would destroy live work.
  assert.equal(taskOf(r)?.tmuxSession, "renamed");
});

test("renameSession leaves a task bound to a different tmux session untouched", () => {
  const r = new Registry();
  r.applyDiscovery([dispatched]);
  r.upsertTask(mkTask({ id: "other", tmuxSession: "unrelated", worktreePath: "/wt/other" }));

  r.renameSession("s1", "renamed");

  assert.equal(taskOf(r, "other")?.tmuxSession, "unrelated");
});

test("renameSession ignores a dead task that recorded a since-reused tmux name", () => {
  const r = new Registry();
  r.applyDiscovery([dispatched]);
  // A finished task keeps both fields until its worktree is reclaimed, and tmux
  // frees a dead session's name at once - so a later dispatch can be handed the
  // same bare slug. Only the task holding THIS session's worktree may follow the
  // rename; re-pointing the stale one would aim its teardown at a live agent.
  r.upsertTask(mkTask({ id: "stale", status: "done", worktreePath: "/wt/old" }));
  r.upsertTask(mkTask());

  r.renameSession("s1", "renamed");

  assert.equal(taskOf(r, "stale")?.tmuxSession, "work");
  assert.equal(taskOf(r)?.tmuxSession, "renamed");
});

test("renameSession follows the rename for a worktree-holding task that already failed", () => {
  const r = new Registry();
  r.applyDiscovery([dispatched]);
  // The dispatcher only sets sessionId on the success path, so a failed-but-alive
  // task has none - yet it still holds the worktree that teardown targets.
  r.upsertTask(mkTask({ status: "failed", sessionId: null }));

  r.renameSession("s1", "renamed");

  assert.equal(taskOf(r)?.tmuxSession, "renamed");
});

test("renameSession touches no task binding when the session has no tmux handle", () => {
  const r = new Registry();
  r.applyDiscovery([
    disco({
      cwd: "/wt/work",
      tmux: null,
      nameSource: "wezterm",
      wezterm: { paneId: 12, tabId: 4, windowId: 1, tabTitle: "work", isActive: true },
    }),
  ]);
  r.upsertTask(mkTask());

  r.renameSession("s1", "renamed");

  assert.equal(taskOf(r)?.tmuxSession, "work");
});

// ---- Registry.renameSession (cards sharing one tmux session) ----

test("renameSession re-points every card hosted on the renamed tmux session", () => {
  const r = new Registry();
  // Two agents in two windows of one tmux session: correlate groups by tty, so
  // they are two cards sharing a tmux.session.
  r.applyDiscovery([
    disco(),
    disco({ syntheticId: "s2", tty: "ttys2", pid: 2, tmux: { ...PANE, window: "1", windowIndex: 1, paneId: "%9" } }),
  ]);

  const emitted: string[] = [];
  r.subscribe((e) => {
    if (e.type === "session_upsert") emitted.push(e.session.id);
  });

  r.renameSession("s1", "renamed");

  // Focus/Kill target tmux.session by name, so a sibling left on the old name
  // would attach to a session that no longer resolves.
  assert.equal(sessionOf(r, "s2")?.tmux?.session, "renamed");
  // Its title IS the tmux session name (nameSource: tmux), so it moves too.
  assert.equal(sessionOf(r, "s2")?.name, "renamed");
  assert.deepEqual(emitted, ["s1", "s2"], "both cards re-render immediately");
});

test("renameSession leaves a card on an unrelated tmux session alone", () => {
  const r = new Registry();
  r.applyDiscovery([
    disco(),
    disco({ syntheticId: "s2", tty: "ttys2", pid: 2, name: "other", tmux: { ...PANE, session: "other" } }),
  ]);

  r.renameSession("s1", "renamed");

  assert.equal(sessionOf(r, "s2")?.tmux?.session, "other");
  assert.equal(sessionOf(r, "s2")?.name, "other");
});
