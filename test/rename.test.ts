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
import { emulatorHandle, muxHandle, terminalResourceId } from "../src/shared/pane.ts";
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

/**
 * A session on a multiplexer, on an emulator, and on both - the three shapes a TERMINAL rename
 * sees. `runtime` is carried because a name's home is a runtime question before it is a handle
 * question: an embedded session keeps its name on a row and needs no pane at all (`embedded`).
 */
const onMux = { terminals: [PANE], runtime: "terminal" as const };
const onEmu = { terminals: [TAB], runtime: "terminal" as const };
const onBoth = { terminals: [PANE, TAB], runtime: "terminal" as const };

/** A driver-run session: no handles, by construction, and renameable anyway. */
const embedded = { terminals: [], runtime: "sdk" as const };

function mkSession(over: Partial<Session> = {}): Session {
  return {
    id: "s",
    agent: "claude",
    name: "old",
    runtime: "terminal",
    // Rename is pane mechanics; a discovered session is the honest shape here.
    foremanInvite: null,
    nameSource: "tmux",
    state: "working" as SessionState,
    cwd: null,
    gitBranch: null,
    gitRoot: null,
    repoRoot: null,
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
    task: null,
    prUrl: null,
    prNumber: null,
    prState: null,
    prChecks: null,
    meta: null,
    effortBaselineReady: false,
    note: null, cost: null, goal: null,
    queue: null,
    pendingTurns: [],
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

test("validateSessionName rejects a terminal session with no renameable handle", () => {
  const r = validateSessionName({ terminals: [], runtime: "terminal" }, "whatever");
  assert.equal(r.ok, false);
});

// An embedded session has `terminals: []` by construction, which is exactly the shape the
// check above refuses - and refusing it was the bug: every dispatched card lost its rename.
// Its name lives on the durable row, so having no pane is not having nowhere to put a name.
test("validateSessionName accepts an embedded session, which has no pane by construction", () => {
  assert.deepEqual(validateSessionName(embedded, "  a name  "), {
    ok: true,
    name: "a name",
  });
});

test("validateSessionName holds an embedded session to plain display rules, not tmux's", () => {
  // No target grammar to satisfy, so the characters tmux reserves as separators are ordinary
  // text here - and a control character is still refused, because no display name can hold one.
  assert.deepEqual(validateSessionName(embedded, "a.b:c $0"), {
    ok: true,
    name: "a.b:c $0",
  });
  assert.equal(validateSessionName(embedded, "a\nb").ok, false);
  assert.equal(validateSessionName(embedded, "   ").ok, false);
});

// ---- validateSessionNameAgainstTasks (pure) ----

// A `done` task keeps its worktree and home name until an explicit reclaim, and a
// multiplexer frees a dead session's name at once - so this name is free on the backend
// while still aiming the task's teardown (`killHome(homeName)`) at whoever takes it.
const staleTask = { homeName: "fix-login", worktreePath: "/wt/old" };

test("validateSessionNameAgainstTasks refuses a name a worktree-holding task still records", () => {
  // The refusal names the backend that owns the home (mux wins the label), not a generic
  // "terminal" - a cmux collision then reads true rather than approximately.
  assert.deepEqual(validateSessionNameAgainstTasks({ ...onMux, cwd: "/wt/live" }, "fix-login", [staleTask]), {
    ok: false,
    error: "another task still holds the tmux session name 'fix-login'",
  });
});

test("validateSessionNameAgainstTasks allows a name whose task was reclaimed", () => {
  // Reclaim clears worktreePath and homeName together: the task can no longer
  // tear anything down, so it no longer speaks for the name.
  const evicted = { homeName: null, worktreePath: null };
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

test("validateSessionNameAgainstTasks refuses an emulator rename that collides too", () => {
  // A task dispatched into a pure-emulator home records that tab's title as its homeName,
  // and renameSession re-points it - so an emulator rename can re-aim a stale task's
  // teardown exactly as a multiplexer one can, and the guard must refuse it (naming the
  // emulator backend). The old code returned ok:true here and left that rename unchecked.
  assert.deepEqual(
    validateSessionNameAgainstTasks({ ...onEmu, cwd: "/wt/live" }, "fix-login", [staleTask]),
    { ok: false, error: "another task still holds the WezTerm session name 'fix-login'" },
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

// ---- rename's driver arm (embedded sessions) ----

test("rename: an embedded session writes its name down and drives no backend", async () => {
  const { deps, muxCalls, retitled } = spyDeps();
  const wrote: Array<[string, string]> = [];
  const r = await rename(
    mkSession({ ...embedded, id: "sdk:1" }),
    "renamed",
    deps,
    async (s, name) => {
      wrote.push([s.id, name]);
      return true;
    },
  );

  assert.deepEqual(r, { ok: true });
  assert.deepEqual(wrote, [["sdk:1", "renamed"]]);
  // The point of the seam: no shelling out, on a session where there is nothing to shell to.
  assert.deepEqual(muxCalls, []);
  assert.deepEqual(retitled, []);
});

test("rename: an embedded session with no durable row is refused, not reported renamed", async () => {
  // The registry echoes the new name onto the card the moment this returns ok, so a write that
  // hit nothing has to fail here - otherwise the rename appears to work and the next daemon
  // restart brings the card back under its derived name with no explanation.
  const { deps } = spyDeps();
  const r = await rename(mkSession(embedded), "renamed", deps, async () => false);

  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /could not be saved/);
});

test("rename: an embedded session in a build with no driver seam is refused", async () => {
  const { deps } = spyDeps();
  const r = await rename(mkSession(embedded), "renamed", deps);

  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /could not be saved/);
});

test("rename: a busy embedded session is still renameable", async () => {
  // A display name is what the OPERATOR calls the conversation - the agent is never told - so
  // unlike a context clear it does not wait on a turn boundary. Refusing mid-turn would refuse
  // exactly the sessions someone most wants to label.
  const { deps } = spyDeps();
  const r = await rename(
    mkSession({ ...embedded, state: "working" }),
    "renamed",
    deps,
    async () => true,
  );

  assert.deepEqual(r, { ok: true });
});

test("Registry.renameSession echoes an embedded rename with no handles to rewrite", async () => {
  const registry = new Registry();
  const session = registry.registerSdkSession({
    id: "sdk:echo",
    agent: "claude",
    name: "derived",
    cwd: "/repo",
  });
  assert.equal(session.name, "derived");

  registry.renameSession("sdk:echo", "by hand");

  const after = registry.getSession("sdk:echo");
  assert.equal(after?.name, "by hand");
  assert.deepEqual(after?.terminals, [], "there was never a handle to carry the name");
  assert.equal(after?.runtime, "sdk");
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
  r.applyDiscovery([disco({ name: "renamed", terminals: [{ ...PANE, session: "renamed", sessionName: "renamed" }] })]);
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
  baseTask({ worktreePath: "/wt/work", homeName: "work", sessionId: "s1", status: "running", createdAt: 0, updatedAt: 0, ...over });

function taskOf(r: InstanceType<typeof Registry>, id = "t1"): Task | undefined {
  return r.snapshot().tasks.find((t) => t.id === id);
}

// A dispatched agent runs inside its own worktree, so its card's cwd is the
// task's worktreePath - the join that binds the two.
const dispatched = disco({ cwd: "/wt/work" });

test("renameSession moves a dispatched task's homeName binding with the name", () => {
  const r = new Registry();
  r.applyDiscovery([dispatched]);
  r.upsertTask(mkTask());

  r.renameSession("s1", "renamed");

  // reconcileOnStartup probes this name after a restart and force-removes the
  // worktree when it doesn't resolve - a stale binding would destroy live work.
  assert.equal(taskOf(r)?.homeName, "renamed");
});

test("renameSession leaves a task bound to a different tmux session untouched", () => {
  const r = new Registry();
  r.applyDiscovery([dispatched]);
  r.upsertTask(mkTask({ id: "other", homeName: "unrelated", worktreePath: "/wt/other" }));

  r.renameSession("s1", "renamed");

  assert.equal(taskOf(r, "other")?.homeName, "unrelated");
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

  assert.equal(taskOf(r, "stale")?.homeName, "work");
  assert.equal(taskOf(r)?.homeName, "renamed");
});

test("renameSession follows the rename for a worktree-holding task that already failed", () => {
  const r = new Registry();
  r.applyDiscovery([dispatched]);
  // The dispatcher only sets sessionId on the success path, so a failed-but-alive
  // task has none - yet it still holds the worktree that teardown targets.
  r.upsertTask(mkTask({ status: "failed", sessionId: null }));

  r.renameSession("s1", "renamed");

  assert.equal(taskOf(r)?.homeName, "renamed");
});

test("renameSession keeps emulator cleanup ownership across a rename", () => {
  const r = new Registry();
  const handle = mkEmuHandle({ tabTitle: "work" });
  r.applyDiscovery([
    disco({ cwd: "/wt/new", nameSource: "wezterm", terminals: [handle] }),
  ]);
  r.upsertTask(mkTask({
    status: "cancelled",
    sessionId: null,
    worktreePath: "/wt/old",
    terminalResourceId: terminalResourceId(handle),
  }));

  r.renameSession("s1", "renamed");

  assert.equal(taskOf(r)?.homeName, "renamed");
  assert.equal(taskOf(r)?.terminalResourceId, terminalResourceId(handle));
  assert.match(r.promptResourceBlockerForSession("s1") ?? "", /clean up/);
});

test("renameSession preserves cmux address and cleanup ownership", () => {
  const r = new Registry();
  const handle = mkMuxHandle({
    backend: "cmux",
    session: "workspace-uuid",
    sessionName: "work",
    paneId: "surface-id",
  });
  r.applyDiscovery([disco({ cwd: null, nameSource: "cmux", terminals: [handle] })]);
  r.upsertTask(mkTask({
    status: "cancelled",
    sessionId: null,
    worktreePath: "/wt/old",
    terminalResourceId: terminalResourceId(handle),
  }));

  r.renameSession("s1", "renamed");

  assert.equal(muxHandle(sessionOf(r)!)?.session, "workspace-uuid");
  assert.equal(muxHandle(sessionOf(r)!)?.sessionName, "renamed");
  assert.equal(taskOf(r)?.homeName, "renamed");
  assert.equal(taskOf(r)?.terminalResourceId, terminalResourceId(handle));
  assert.match(r.promptResourceBlockerForSession("s1") ?? "", /clean up/);
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
    disco({ syntheticId: "s2", tty: "ttys2", pid: 2, name: "other", terminals: [{ ...PANE, session: "other", sessionName: "other" }] }),
  ]);

  r.renameSession("s1", "renamed");

  assert.equal(muxHandle(sessionOf(r, "s2")!)?.session, "other");
  assert.equal(sessionOf(r, "s2")?.name, "other");
});
