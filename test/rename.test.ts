import { test } from "node:test";
import { mkEmuHandle, mkMuxHandle, mkTask as baseTask } from "./helpers/session-fixture.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import {
  OK,
  fakeEmulator,
  fakeMultiplexer,
  fakeTerminals,
} from "./helpers/terminal-fakes.ts";
import type { TerminalDeps } from "../src/server/terminal/registry.ts";
import type { EmulatorPane, MuxClient, TerminalResult } from "../src/server/terminal/types.ts";
import { emulatorHandle, muxHandle } from "../src/shared/pane.ts";
import type { Session, SessionState, Task } from "../src/shared/types.ts";

// Isolate the daemon's SQLite DB before ANY value import that can resolve it loads. A
// static import of actions.ts here once sat above this line; hoisting evaluated it first,
// config.ts stamped the real home, and every run of this file quietly opened the live db.
process.env.HARNESS_HOME = mkdtempSync(join(tmpdir(), "harness-rename-"));
const { rename, validateSessionName, validateSessionNameAgainstTasks } = await import(
  "../src/server/actions.ts"
);
const { Registry } = await import("../src/server/registry.ts");

const PANE = mkMuxHandle({ session: "work", windowName: "0", paneId: "%3" });
const TAB = mkEmuHandle({ paneId: "12", tabId: "4", windowId: "1", tabTitle: "old" });

/** A session on a multiplexer, on an emulator, and on both - the three shapes a rename sees. */
const onMux = { terminals: [PANE] };
const onEmu = { terminals: [TAB] };
const onBoth = { terminals: [PANE, TAB] };

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
    repoRoot: null,
    nomistakesGated: false,
    pid: 4242,
    tty: null,
    permissionMode: null,
    terminals: [],
    agentSessionId: null,
    transcriptPath: null,
    instrumented: true,
    stateConfirmed: true,
    hooksSeen: true,
    activity: null,
    startedAt: null,
    firstSeen: 0,
    lastSeen: 0,
    lastActivity: null,
    pendingReviews: 0,
    nomistakes: null,
    nomistakesFixes: [],
    nomistakesNarration: null,
    task: null,
    prUrl: null,
    prNumber: null,
    prState: null,
    prChecks: null,
    meta: null,
    note: null, cost: null, goal: null,
    queue: null,
    orphanedQueue: null,
    inspector: null,
    paneDialog: null,
    ...over,
  };
}

// ---- validateSessionName (pure) ----

test("validateSessionName trims and accepts a plain tmux name", () => {
  const r = validateSessionName(onMux, "  my session  ");
  assert.deepEqual(r, { ok: true, name: "my session" });
});

test("validateSessionName rejects an empty / whitespace-only name", () => {
  assert.equal(validateSessionName(onMux, "   ").ok, false);
  assert.equal(validateSessionName(onMux, "").ok, false);
});

test("validateSessionName rejects control characters for either handle", () => {
  assert.equal(validateSessionName(onMux, "a\nb").ok, false);
  assert.equal(validateSessionName(onEmu, "a\tb").ok, false);
});

test("validateSessionName rejects '.' and ':' only for a tmux session", () => {
  // tmux target specs use these as separators, so rename-session refuses them.
  assert.equal(validateSessionName(onMux, "a.b").ok, false);
  assert.equal(validateSessionName(onMux, "a:b").ok, false);
  // A wezterm tab title is free-form, so the same characters are fine there.
  assert.deepEqual(validateSessionName(onEmu, "a.b:c"), {
    ok: true,
    name: "a.b:c",
  });
});

test("validateSessionName rejects a leading '$' only for a tmux session", () => {
  // '$' is tmux's session-ID sigil: `-t '$0'` resolves by ID and never falls back
  // to a name, so a session named `$0` would make focus/kill hit whichever session
  // owns ID 0. tmux itself allows the rename, so we have to refuse it here.
  assert.equal(validateSessionName(onMux, "$0").ok, false);
  assert.equal(validateSessionName(onMux, "$work").ok, false);
  // Only a leading '$' aliases an id - one inside the name is just a character.
  assert.deepEqual(validateSessionName(onMux, "cost$$"), {
    ok: true,
    name: "cost$$",
  });
  // A wezterm tab title is free-form, so a leading '$' is fine there.
  assert.deepEqual(validateSessionName(onEmu, "$0"), {
    ok: true,
    name: "$0",
  });
});

test("validateSessionName rejects a session with no renameable handle", () => {
  const r = validateSessionName({ terminals: [] }, "whatever");
  assert.equal(r.ok, false);
});

// ---- validateSessionNameAgainstTasks (pure) ----

// A `done` task keeps its worktree and tmux name until an explicit reclaim, and tmux
// frees a dead session's name at once - so this name is free in tmux while still
// aiming the task's teardown (`tmux kill-session -t tmuxSession`) at whoever takes it.
const staleTask = { tmuxSession: "fix-login", worktreePath: "/wt/old" };

test("validateSessionNameAgainstTasks refuses a name a worktree-holding task still records", () => {
  assert.deepEqual(validateSessionNameAgainstTasks({ ...onMux, cwd: "/wt/live" }, "fix-login", [staleTask]), {
    ok: false,
    error: "another task still holds the tmux session name 'fix-login'",
  });
});

test("validateSessionNameAgainstTasks allows a name whose task was reclaimed", () => {
  // Reclaim clears worktreePath and tmuxSession together: the task can no longer
  // tear anything down, so it no longer speaks for the name.
  const evicted = { tmuxSession: null, worktreePath: null };
  assert.deepEqual(validateSessionNameAgainstTasks({ ...onMux, cwd: "/wt/live" }, "fix-login", [evicted]), {
    ok: true,
  });
});

test("validateSessionNameAgainstTasks allows a session onto its own task's recorded name", () => {
  // The task holding this session's worktree is its own binding, not a collision -
  // it follows the rename in renameSession rather than being left aimed elsewhere.
  assert.deepEqual(
    validateSessionNameAgainstTasks({ ...onMux, cwd: "/wt/old" }, "fix-login", [staleTask]),
    { ok: true },
  );
});

test("validateSessionNameAgainstTasks allows a name no task records", () => {
  assert.deepEqual(validateSessionNameAgainstTasks({ ...onMux, cwd: "/wt/live" }, "auth", [staleTask]), {
    ok: true,
  });
});

test("validateSessionNameAgainstTasks ignores task bindings for a wezterm-only session", () => {
  // Renaming a wezterm tab sets a free-form title and moves no tmux name, so no
  // task's teardown can be re-aimed by it.
  assert.deepEqual(
    validateSessionNameAgainstTasks({ ...onEmu, cwd: "/wt/live" }, "fix-login", [staleTask]),
    { ok: true },
  );
});

// ---- rename (registry-driven branching) ----

/** A wezterm-ish pane whose tab hosts a multiplexer client (only the ids and tty matter). */
function hostPane(paneId: number, over: Partial<EmulatorPane> = {}): EmulatorPane {
  return {
    paneId: String(paneId),
    tabId: String(paneId),
    windowId: "1",
    tabTitle: "old",
    windowTitle: "",
    cwd: null,
    tty: `ttys00${paneId}`,
    isActive: false,
    ...over,
  };
}

/** The client list a host lookup joins against - one client per host pane, same ttys. */
function clientsFor(panes: EmulatorPane[], session = "work"): MuxClient[] {
  return panes.map((p) => ({ tty: p.tty, session }));
}

interface RenameSpy {
  deps: TerminalDeps;
  muxCalls: [string, string][];
  retitled: [string, string][];
}

/**
 * A multiplexer that renames and an emulator that retitles, both recording.
 *
 * `hosts` is what the emulator enumerates; the multiplexer reports a client on each of their
 * ttys, so the composition join finds them the way it does on a real machine rather than
 * through a `findTmuxHostPanes` hook that skipped the join entirely.
 */
function spyDeps(
  opts: {
    hosts?: EmulatorPane[];
    renameResult?: TerminalResult;
    retitleResult?: TerminalResult;
    sessions?: boolean;
    retitle?: boolean;
  } = {},
): RenameSpy {
  const hosts = opts.hosts ?? [];
  const muxCalls: [string, string][] = [];
  const retitled: [string, string][] = [];
  const mux = fakeMultiplexer({
    clients: async () => clientsFor(hosts),
    sessions:
      opts.sessions === false
        ? null
        : {
            spawnDetached: async () => OK,
            attachArgv: (name) => ["fake", "attach", name],
            rename: async (from, to) => {
              muxCalls.push([from, to]);
              return opts.renameResult ?? OK;
            },
            kill: async () => OK,
            names: { validate: () => null, sanitize: (t) => t },
          },
  });
  const emu = fakeEmulator({
    list: async () => hosts,
    retitle:
      opts.retitle === false
        ? null
        : async (t, title) => {
            retitled.push([t.paneId, title]);
            return opts.retitleResult ?? OK;
          },
  });
  return { deps: fakeTerminals(mux, emu), muxCalls, retitled };
}

test("rename: a multiplexer session renames by its current name", async () => {
  const { deps, muxCalls, retitled } = spyDeps();
  const r = await rename(mkSession(onMux), "renamed", deps);

  assert.deepEqual(r, { ok: true });
  assert.deepEqual(muxCalls, [["work", "renamed"]]);
  assert.deepEqual(retitled, [], "no tab hosts it, so there's no title to retitle");
});

test("rename: a multiplexer session also retitles the tab hosting its client", async () => {
  // The regression this guards: an agent inside a multiplexer never gets an emulator handle
  // (correlate keys it on the agent's tty, which is a multiplexer pane tty), so the tab
  // showing it is only reachable via its client - and renames used to skip it, leaving the
  // tab on its spawn-time title forever.
  const { deps, muxCalls, retitled } = spyDeps({ hosts: [hostPane(1)] });
  const r = await rename(mkSession(onMux), "renamed", deps);

  assert.deepEqual(r, { ok: true });
  assert.deepEqual(muxCalls, [["work", "renamed"]]);
  assert.deepEqual(retitled, [["1", "renamed"]]);
});

test("rename: a multiplexer session retitles every tab attached to it", async () => {
  // One session can be attached from several tabs; a tab left on the old title is the same
  // staleness bug, just in a second window.
  const { deps, retitled } = spyDeps({ hosts: [hostPane(1), hostPane(2)] });
  await rename(mkSession(onMux), "renamed", deps);

  assert.deepEqual(retitled, [
    ["1", "renamed"],
    ["2", "renamed"],
  ]);
});

test("rename: host tabs are resolved by the OLD name, before the rename lands", async () => {
  // The lookup joins clients to emulator panes by the session name, so it has to run while
  // the session still answers to `from`.
  const order: string[] = [];
  const hosts = [hostPane(1)];
  const mux = fakeMultiplexer({
    clients: async () => {
      order.push("clients");
      return clientsFor(hosts);
    },
    sessions: {
      spawnDetached: async () => OK,
      attachArgv: (name) => ["fake", "attach", name],
      rename: async () => {
        order.push("rename");
        return OK;
      },
      kill: async () => OK,
      names: { validate: () => null, sanitize: (t) => t },
    },
  });
  const emu = fakeEmulator({ list: async () => hosts, retitle: async () => OK });
  await rename(mkSession(onMux), "renamed", fakeTerminals(mux, emu));

  assert.deepEqual(order, ["clients", "rename"]);
});

test("rename: a session rename still succeeds when the tab retitle fails", async () => {
  // The emulator may not be running at all, or its GUI may have gone away. The card name
  // already moved, so a cosmetic title must not fail this.
  const { deps, muxCalls } = spyDeps({
    hosts: [hostPane(1)],
    retitleResult: { ok: false, error: "no wezterm mux", outcomeUnknown: false },
  });
  const r = await rename(mkSession(onMux), "renamed", deps);

  assert.deepEqual(r, { ok: true });
  assert.deepEqual(muxCalls, [["work", "renamed"]]);
});

test("rename: a failed session rename leaves the tab title alone", async () => {
  // The tab must keep showing the name the session actually still has.
  const { deps, retitled } = spyDeps({
    hosts: [hostPane(1)],
    renameResult: { ok: false, error: "duplicate session: renamed", outcomeUnknown: false },
  });
  const r = await rename(mkSession(onMux), "renamed", deps);

  assert.equal(r.ok, false);
  assert.deepEqual(retitled, [], "no rename landed, so no title should move");
});

test("rename: an emulator-only session sets the tab title on its own pane", async () => {
  const { deps, muxCalls, retitled } = spyDeps();
  const r = await rename(mkSession({ ...onEmu, nameSource: "wezterm" }), "renamed", deps);

  assert.deepEqual(r, { ok: true });
  assert.deepEqual(retitled, [["12", "renamed"]]);
  assert.deepEqual(muxCalls, []);
});

test("rename: the multiplexer wins when a session has both handles", async () => {
  // `session.wezterm` on a multiplexer-hosted session would be the pane the agent's own tty
  // maps to, not the tab hosting the client - renaming through it would title the wrong tab.
  // The tab is found through the client join instead.
  const { deps, muxCalls, retitled } = spyDeps();
  await rename(mkSession(onBoth), "renamed", deps);

  assert.deepEqual(muxCalls, [["work", "renamed"]]);
  assert.deepEqual(retitled, [], "pane 12 (session.wezterm) is never titled");
});

test("rename: a failed session rename surfaces the backend's own words", async () => {
  const { deps } = spyDeps({
    renameResult: { ok: false, error: "duplicate session: renamed", outcomeUnknown: false },
  });
  const r = await rename(mkSession(onMux), "renamed", deps);

  assert.equal(r.ok, false);
  assert.equal(r.error, "duplicate session: renamed");
});

test("rename: an emulator that can't retitle refuses by name instead of silently succeeding", async () => {
  // The capability null. Ghostty can be launched into and raised and can rename nothing, and
  // the honest answer names the backend rather than reporting a rename that never happened.
  const { deps } = spyDeps({ retitle: false });
  const r = await rename(mkSession(onEmu), "renamed", deps);

  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /WezTerm/);
});

test("rename: a handle-less session is an error, not a crash", async () => {
  const { deps, muxCalls, retitled } = spyDeps();
  const r = await rename(mkSession(), "renamed", deps);

  assert.equal(r.ok, false);
  assert.deepEqual(muxCalls, []);
  assert.deepEqual(retitled, []);
});

// ---- Registry.renameSession (optimistic echo) ----

function disco(over: Partial<DiscoveredSession> = {}): DiscoveredSession {
  return {
    syntheticId: "s1",
    agent: "claude",
    name: "work",
    nameSource: "tmux",
    cwd: "/repo",
    gitBranch: "main",
    gitRoot: null,
    repoRoot: null,
    nomistakesGated: false,
    pid: 1,
    tty: "ttys1",
    terminals: [PANE],
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
  assert.equal(muxHandle(s)?.session, "renamed");
  assert.equal(emitted, 1, "the card re-renders immediately");
});

test("renameSession updates a wezterm tab title in step", () => {
  const r = new Registry();
  r.applyDiscovery([
    disco({ nameSource: "wezterm", terminals: [mkEmuHandle({ tabTitle: "work" })] }),
  ]);

  r.renameSession("s1", "renamed");
  assert.equal(emulatorHandle(sessionOf(r)!)?.tabTitle, "renamed");
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
  r.applyDiscovery([disco({ name: "renamed", terminals: [{ ...PANE, session: "renamed" }] })]);
  assert.equal(emitted, 0, "the optimistic value already matches - nothing changed");
  assert.equal(sessionOf(r)?.name, "renamed");
});

test("renameSession on an unknown session id is a safe no-op", () => {
  const r = new Registry();
  r.applyDiscovery([disco()]);
  assert.doesNotThrow(() => r.renameSession("nope", "x"));
});

// ---- Registry.renameSession (dispatched task binding) ----

/** The shared task fixture with this file's defaults on top. */
const mkTask = (over: Partial<Task> = {}): Task =>
  baseTask({ worktreePath: "/wt/work", tmuxSession: "work", sessionId: "s1", status: "running", createdAt: 0, updatedAt: 0, ...over });

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
    disco({ cwd: "/wt/work", nameSource: "wezterm", terminals: [mkEmuHandle({ tabTitle: "work" })] }),
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
    disco({ syntheticId: "s2", tty: "ttys2", pid: 2, terminals: [{ ...PANE, windowName: "1", windowIndex: 1, paneId: "%9" }] }),
  ]);

  const emitted: string[] = [];
  r.subscribe((e) => {
    if (e.type === "session_upsert") emitted.push(e.session.id);
  });

  r.renameSession("s1", "renamed");

  // Focus/Kill target tmux.session by name, so a sibling left on the old name
  // would attach to a session that no longer resolves.
  assert.equal(muxHandle(sessionOf(r, "s2")!)?.session, "renamed");
  // Its title IS the tmux session name (nameSource: tmux), so it moves too.
  assert.equal(sessionOf(r, "s2")?.name, "renamed");
  assert.deepEqual(emitted, ["s1", "s2"], "both cards re-render immediately");
});

test("renameSession leaves a card on an unrelated tmux session alone", () => {
  const r = new Registry();
  r.applyDiscovery([
    disco(),
    disco({ syntheticId: "s2", tty: "ttys2", pid: 2, name: "other", terminals: [{ ...PANE, session: "other" }] }),
  ]);

  r.renameSession("s1", "renamed");

  assert.equal(muxHandle(sessionOf(r, "s2")!)?.session, "other");
  assert.equal(sessionOf(r, "s2")?.name, "other");
});
