import { test } from "node:test";
import assert from "node:assert/strict";
import { EMULATOR_IDS, MULTIPLEXER_IDS, TERMINAL_BACKEND_IDS } from "../src/shared/terminal.ts";
import {
  defaultTerminalTargetDeps,
  launchTerminal,
  terminalTargetViews,
  type TerminalLaunchSpec,
  type TerminalTargetDeps,
} from "../src/server/terminal/targets.ts";
import type {
  BinSpec,
  DetachedSessionSpec,
  Multiplexer,
  MuxSessions,
  SpawnResult,
  TabSpec,
  TerminalEmulator,
  TerminalResult,
} from "../src/server/terminal/types.ts";
import { PLAIN_NAMES } from "../src/server/terminal/names.ts";
import { EMU_BIN, FAIL, MUX_BIN, OK, fakeEmulator, fakeMultiplexer } from "./helpers/terminal-fakes.ts";

// What is at stake: every row of the terminal menu is a PROMISE that pressing it puts a
// window on the operator's screen, and the operator checks it by looking. That makes the one
// unacceptable failure a row that reports success and shows nothing - indistinguishable from
// a terminal that is merely slow, so it is pressed again rather than reported.
//
// The rule that costs something is that availability on the multiplexer axis is not a
// property of that backend alone. `spawnDetached` on tmux creates a session with no window
// anywhere: exactly right for a dispatched agent, and nothing at all for a human who pressed
// "open a terminal". Making it visible takes a SECOND backend, an emulator, to run the
// `attachArgv`. So "is tmux available" is a question about a pair, and both halves are pinned
// here - the row that refuses while tmux is perfectly well installed, and the launch that
// creates the session and then goes on to raise it.
//
// The rest is the refusal vocabulary. Unavailable rows are returned rather than filtered,
// because "we found no terminal" and "we did not look" read identically as an empty menu;
// each refusal names its own fix, since installing tmux and installing something that can
// SHOW tmux are different afternoons; and finding all this out spawns nothing.

const SPEC: TerminalLaunchSpec = { name: "api", cwd: "/w/api", argv: ["zsh", "-l"] };

/** The named-session half a multiplexer declares. tmux-shaped unless a test says otherwise. */
function sessions(over: Partial<MuxSessions> = {}): MuxSessions {
  return {
    spawnDetached: async () => OK,
    attachArgv: (name) => ["fake-mux", "attach", "-t", name],
    rename: async () => OK,
    kill: async () => OK,
    names: PLAIN_NAMES,
    ...over,
  };
}

/** A multiplexer that records every session it was asked to create. */
function recordingMux(
  opts: { sessions?: Partial<MuxSessions>; mux?: Partial<Multiplexer>; result?: TerminalResult } = {},
): { created: DetachedSessionSpec[]; killed: string[]; backend: Multiplexer } {
  const created: DetachedSessionSpec[] = [];
  const killed: string[] = [];
  const backend = fakeMultiplexer({
    ...opts.mux,
    sessions: sessions({
      spawnDetached: async (spec) => {
        created.push(spec);
        return opts.result ?? OK;
      },
      kill: async (name) => {
        killed.push(name);
        return OK;
      },
      ...opts.sessions,
    }),
  });
  return { created, killed, backend };
}

/** An emulator that records every tab it was asked to open. */
function recordingEmu(
  opts: { emulator?: Partial<TerminalEmulator>; result?: SpawnResult } = {},
): { opened: TabSpec[]; backend: TerminalEmulator } {
  const opened: TabSpec[] = [];
  const backend = fakeEmulator({
    spawn: {
      tab: async (spec) => {
        opened.push(spec);
        return opts.result ?? { ...OK, target: null };
      },
    },
    ...opts.emulator,
  });
  return { opened, backend };
}

function deps(over: Partial<TerminalTargetDeps> = {}): TerminalTargetDeps {
  return {
    multiplexers: {},
    emulators: {},
    installed: () => true,
    launchId: () => "abc123",
    ...over,
  };
}

/**
 * The machine shapes this module exists for, said by identity rather than by name. The fakes
 * carry one `BinSpec` per AXIS, so "only the multiplexer is on this machine" is expressible -
 * and it is the shape that produces the pair's refusal.
 */
const muxOnly = (spec: BinSpec): boolean => spec === MUX_BIN;
const emuOnly = (spec: BinSpec): boolean => spec === EMU_BIN;
const nothingInstalled = (): boolean => false;

test("every registered backend gets a row, multiplexers first, unavailable ones included", () => {
  const views = terminalTargetViews(
    deps({
      multiplexers: {
        tmux: recordingMux().backend,
        herdr: recordingMux({ mux: { id: "herdr", label: "Herdr" } }).backend,
        cmux: recordingMux({ sessions: { attachArgv: null }, mux: { id: "cmux", label: "cmux" } })
          .backend,
      },
      emulators: {
        wezterm: recordingEmu().backend,
        // Registered, installed, and unable to open a window from outside. This is the row a
        // menu built by filtering would drop, leaving a human who knows Ghostty is running to
        // conclude the feature is broken rather than that this backend cannot do it.
        ghostty: fakeEmulator({ id: "ghostty", label: "Ghostty" }),
        iterm: recordingEmu({ emulator: { id: "iterm", label: "iTerm2" } }).backend,
      },
    }),
  );

  assert.deepEqual(views.map((v) => v.id), [...TERMINAL_BACKEND_IDS]);
  // Order is not incidental: it is the order the menu draws in, and it is one array's, not
  // this module's. A nesting rule read off `@shared/terminal.ts` rather than restated here.
  assert.deepEqual(views.slice(0, MULTIPLEXER_IDS.length).map((v) => v.id), [...MULTIPLEXER_IDS]);
  assert.deepEqual(views.slice(MULTIPLEXER_IDS.length).map((v) => v.id), [...EMULATOR_IDS]);
  assert.ok(views.find((v) => v.id === "ghostty")?.unavailable, "the refusing row is still a row");

  // Every row is drawable whether it can be used or not - a greyed row with no label is one
  // nobody can tell from any other.
  for (const v of views) {
    assert.ok(v.label.trim().length > 0, `${v.id} has no label`);
    assert.ok(v.glyph.trim().length > 0, `${v.id} has no glyph`);
  }
});

test("the default deps are the real registries, so a new backend needs no edit here", () => {
  // The enforcement this module leans on rather than repeats: `MULTIPLEXERS` / `EMULATORS`
  // are already `Record<…Id, …>`, so an id added to the shared arrays reaches the menu the
  // moment its adapter compiles. A hand-kept list here would be the parallel registry.
  assert.deepEqual(
    Object.keys(defaultTerminalTargetDeps.multiplexers).sort(),
    [...MULTIPLEXER_IDS].sort(),
  );
  assert.deepEqual(Object.keys(defaultTerminalTargetDeps.emulators).sort(), [...EMULATOR_IDS].sort());
});

test("an uninstalled emulator says so, and nothing is spawned to find out", () => {
  const emu = recordingEmu();
  const views = terminalTargetViews(
    deps({ emulators: { wezterm: emu.backend }, installed: nothingInstalled }),
  );

  assert.equal(views[0]?.unavailable, "WezTerm is not installed");
  assert.equal(views[0]?.blurb, "");
  // The menu is drawn from the filesystem, never by trying it: a probe that opened a window
  // to discover whether it could would be a menu that opens four terminals to draw itself.
  assert.deepEqual(emu.opened, [], "asking whether a backend is available must launch nothing");
});

test("an emulator that cannot be launched into is a different sentence from an absent one", () => {
  // Two greyed rows, two entirely different things for the human to do: one is `brew install`
  // and the other is nothing at all, because this backend will never gain the capability.
  // A boolean `available` collapses them into a row that explains neither.
  const views = terminalTargetViews(deps({ emulators: { wezterm: fakeEmulator() } }));

  assert.equal(views[0]?.unavailable, "WezTerm cannot open a window from outside");
  assert.doesNotMatch(views[0]?.unavailable ?? "", /installed/);
});

test("a detached-session multiplexer is unavailable until something can raise it", () => {
  // The whole reason this module exists. tmux IS installed and IS capable here; what is
  // missing is anywhere to show the session it would create. Answering per-backend would ship
  // a button that succeeds and puts nothing on screen.
  const mux = recordingMux();
  const emu = recordingEmu();

  const alone = terminalTargetViews(
    deps({ multiplexers: { tmux: mux.backend }, emulators: { wezterm: emu.backend }, installed: muxOnly }),
  );
  assert.equal(
    alone[0]?.unavailable,
    "tmux sessions open detached - install a terminal that can show one",
  );
  assert.equal(
    alone[0]?.dispatchUnavailable,
    null,
    "a background dispatch needs the detached session, not a visible window",
  );
  assert.equal(alone[0]?.dispatchBlurb, "New persistent session for each dispatch.");
  // Telling this operator to install tmux would send them after a thing they already have.
  assert.doesNotMatch(alone[0]?.unavailable ?? "", /tmux is not installed/);
  assert.deepEqual(mux.created, []);
  assert.deepEqual(emu.opened, []);

  const paired = terminalTargetViews(
    deps({ multiplexers: { tmux: mux.backend }, emulators: { wezterm: emu.backend } }),
  );
  assert.equal(paired[0]?.unavailable, null);
  // The blurb NAMES the raiser, because "tmux is available" is not a promise anyone can check
  // and "raised in WezTerm" is.
  assert.equal(paired[0]?.blurb, "New session, raised in WezTerm.");
  assert.equal(paired[0]?.detail, "new-session -c");
});

test("the raiser named in the blurb is the one that will actually run the attach", () => {
  // Not merely the first emulator id: an installed backend with no `spawn` cannot raise
  // anything, so naming it would put a terminal on the row that never opens.
  const views = terminalTargetViews(
    deps({
      multiplexers: { tmux: recordingMux().backend },
      emulators: {
        wezterm: fakeEmulator(),
        ghostty: recordingEmu({ emulator: { id: "ghostty", label: "Ghostty" } }).backend,
      },
    }),
  );

  assert.equal(views[0]?.unavailable, null);
  assert.equal(views[0]?.blurb, "New session, raised in Ghostty.");
});

test("a multiplexer whose sessions are never without a window needs no emulator at all", () => {
  // `attachArgv: null` is cmux's claim that it draws its own workspace from the moment it
  // exists. Requiring a raiser for it would grey out a backend that is fully usable on a
  // machine with no other terminal installed.
  const views = terminalTargetViews(
    deps({
      multiplexers: {
        cmux: recordingMux({ sessions: { attachArgv: null }, mux: { id: "cmux", label: "cmux" } })
          .backend,
      },
      installed: muxOnly,
    }),
  );

  assert.equal(views[0]?.unavailable, null);
  assert.equal(views[0]?.blurb, "New workspace in the worktree.");
  assert.equal(views[0]?.detail, null);
});

test("launching an unavailable backend refuses with that backend's own sentence", async () => {
  // The view is recomputed rather than trusted from the browser, which caches rows for 60s -
  // and the refusal a stale click earns is the same sentence the row would have shown, not a
  // generic 500 the operator has to go and diagnose.
  const mux = recordingMux();
  const emu = recordingEmu();
  const machine = deps({
    multiplexers: { tmux: mux.backend },
    emulators: { wezterm: emu.backend },
    installed: muxOnly,
  });

  const outcome = await launchTerminal("tmux", SPEC, machine);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, 409);
  assert.equal(outcome.label, "tmux");
  assert.equal(outcome.error, "tmux sessions open detached - install a terminal that can show one");
  assert.deepEqual(mux.created, [], "a refused launch must not create a session");
  assert.deepEqual(emu.opened, [], "nor open a window");

  // A backend nobody registered is a 404 rather than a refusal: there is no row to explain.
  const missing = await launchTerminal("ghostty", SPEC, machine);
  assert.equal(missing.status, 404);
  assert.equal(missing.error, "no such terminal");
});

test("a detached session is followed by the raise that makes it visible", async () => {
  const mux = recordingMux();
  const emu = recordingEmu();

  const outcome = await launchTerminal(
    "tmux",
    { ...SPEC, name: "Fix the login bug" },
    deps({ multiplexers: { tmux: mux.backend }, emulators: { wezterm: emu.backend } }),
  );

  assert.equal(outcome.ok, true);
  assert.equal(outcome.status, 200);
  assert.deepEqual(mux.created, [
    // `sidePane: false` is the deliberate difference from a dispatch: that splits off a pane
    // for the operator to watch the agent from, and this IS the operator, who asked for a
    // terminal and not for a terminal plus a spare.
    { name: "Fix the login bug-abc123", cwd: "/w/api", argv: SPEC.argv, sidePane: false, select: true },
  ]);
  assert.deepEqual(emu.opened, [
    {
      // The multiplexer's own attach argv, never one composed here - a second spelling of it
      // would attach to nothing on the day a backend changes its flags.
      argv: ["fake-mux", "attach", "-t", "Fix the login bug-abc123"],
      title: "Fix the login bug-abc123",
      // Null: the session already sits in the worktree, and the tab is only a viewport onto
      // it. Rooting the attach somewhere would be answering a question nobody asked.
      cwd: null,
    },
  ]);
});

test("a session that was created and never shown is a failure, not a success", async () => {
  // The failure this whole module is about, at the one moment it can still be caught: the
  // multiplexer reported ok, so returning here would flash "opened in tmux" over an empty
  // screen. The operator's evidence is the window, so ours has to be too.
  const mux = recordingMux();
  const emu = recordingEmu({ result: { ...FAIL("no window server"), target: null } });

  const outcome = await launchTerminal(
    "tmux",
    SPEC,
    deps({ multiplexers: { tmux: mux.backend }, emulators: { wezterm: emu.backend } }),
  );

  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, 502);
  assert.equal(outcome.error, "no window server", "the emulator's own words, not ours");
  assert.equal(mux.created.length, 1, "the session WAS created - what failed is that nobody saw it");
  assert.deepEqual(mux.killed, ["api-abc123"]);
});

test("an uncertain raise leaves the detached session alone", async () => {
  const mux = recordingMux();
  const emu = recordingEmu({
    result: { ok: false, outcomeUnknown: true, target: null },
  });

  const outcome = await launchTerminal(
    "tmux",
    SPEC,
    deps({ multiplexers: { tmux: mux.backend }, emulators: { wezterm: emu.backend } }),
  );

  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, 504);
  assert.equal(outcome.homeName, "api-abc123");
  assert.equal(outcome.error, "tmux did not report back - the window may still be opening");
  assert.deepEqual(mux.killed, []);
});

test("a known raise failure reports when the detached session cannot be cleaned up", async () => {
  const mux = recordingMux({ sessions: { kill: null } });
  const emu = recordingEmu({ result: { ...FAIL("no window server"), target: null } });

  const outcome = await launchTerminal(
    "tmux",
    SPEC,
    deps({ multiplexers: { tmux: mux.backend }, emulators: { wezterm: emu.backend } }),
  );

  assert.equal(outcome.status, 502);
  assert.equal(
    outcome.error,
    "no window server; tmux cannot clean up the detached session",
  );
});

test("a multiplexer launch uses a fresh name and retries one confirmed collision", async () => {
  const created: DetachedSessionSpec[] = [];
  const ids = ["abc123", "def456"];
  const mux = recordingMux({
    sessions: {
      spawnDetached: async (spec) => {
        created.push(spec);
        return created.length === 1 ? FAIL("duplicate session") : OK;
      },
    },
  });
  const emu = recordingEmu();

  const outcome = await launchTerminal(
    "tmux",
    { ...SPEC, name: "api".repeat(30) },
    deps({
      multiplexers: { tmux: mux.backend },
      emulators: { wezterm: emu.backend },
      launchId: () => ids.shift() ?? "unused",
    }),
  );

  assert.equal(outcome.ok, true);
  assert.equal(created.length, 2);
  assert.deepEqual(created.map((spec) => spec.select), [true, true]);
  assert.match(created[0]?.name ?? "", /-abc123$/);
  assert.match(created[1]?.name ?? "", /-def456$/);
  assert.notEqual(created[0]?.name, created[1]?.name);
  assert.deepEqual(emu.opened[0]?.argv, [
    "fake-mux",
    "attach",
    "-t",
    created[1]?.name,
  ]);
});

test("a backend that draws its own window is launched without asking an emulator", async () => {
  // The other half of `attachArgv: null`, and the reason the raise is guarded on the
  // capability rather than on "did we find an emulator": there is nothing to raise, so a
  // machine with no emulator installed still gets its window.
  const mux = recordingMux({ sessions: { attachArgv: null }, mux: { id: "cmux", label: "cmux" } });

  const outcome = await launchTerminal(
    "cmux",
    SPEC,
    deps({ multiplexers: { cmux: mux.backend }, installed: muxOnly }),
  );

  assert.equal(outcome.ok, true);
  assert.equal(outcome.label, "cmux");
  assert.equal(mux.created[0]?.sidePane, false);
  assert.equal(mux.created[0]?.select, true);
});

test("a launch that never reported back is not called a failure", async () => {
  // `outcomeUnknown` is the narrowing flag: the spawn may well have landed, and calling that
  // "did not work" sends the operator to press the button a second time and get two windows.
  // `openFile` draws this line in the same place, for the same reason.
  const unknown = recordingEmu({
    result: { ok: false, outcomeUnknown: true, target: null },
  });
  const pending = await launchTerminal(
    "wezterm",
    SPEC,
    deps({ emulators: { wezterm: unknown.backend }, installed: emuOnly }),
  );
  assert.equal(pending.ok, false);
  assert.equal(pending.status, 504);
  assert.equal(pending.error, "WezTerm did not report back - the window may still be opening");

  // A spawn that answered, and answered no, is the other thing entirely.
  const refused = recordingEmu({ result: { ...FAIL("nowhere to put it"), target: null } });
  const failed = await launchTerminal(
    "wezterm",
    SPEC,
    deps({ emulators: { wezterm: refused.backend }, installed: emuOnly }),
  );
  assert.equal(failed.status, 502);
  assert.equal(failed.error, "nowhere to put it");

  // ...and one that refused without saying why still names the backend that refused, since
  // that is the only thing the operator can act on.
  const mute = recordingEmu({
    result: { ok: false, outcomeUnknown: false, target: null },
  });
  const silent = await launchTerminal(
    "wezterm",
    SPEC,
    deps({ emulators: { wezterm: mute.backend }, installed: emuOnly }),
  );
  assert.equal(silent.status, 502);
  assert.equal(silent.error, "WezTerm could not open a window");
});

test("a name is spelled the backend's own way before anything is created under it", async () => {
  // Name rules belong to the adapter, both directions, and the coercing one is what a launch
  // needs: there is nobody to refuse to here. Sanitizing after the create, or not at all,
  // makes the session's real name a thing this process guessed - and the attach argv then
  // addresses a session that does not exist.
  const mux = recordingMux({
    sessions: {
      names: {
        validate: () => null,
        sanitize: (text) => `coerced-${text.match(/-([^-]+)$/)?.[1] ?? "name"}`,
      },
    },
  });
  const emu = recordingEmu();

  const outcome = await launchTerminal(
    "tmux",
    { ...SPEC, name: "Fix\tthe\nlogin bug" },
    deps({ multiplexers: { tmux: mux.backend }, emulators: { wezterm: emu.backend } }),
  );

  assert.equal(outcome.ok, true);
  assert.equal(mux.created[0]?.name, "coerced-abc123");
  // The same string all the way through: what was created, what is attached to, what the tab
  // is called.
  assert.deepEqual(emu.opened[0]?.argv, ["fake-mux", "attach", "-t", "coerced-abc123"]);
  assert.equal(emu.opened[0]?.title, "coerced-abc123");
});

// ---- Inspector follow-up on PR #269, round 2 ----

test("an emulator launch reports NO durable home, because it produced none", async () => {
  // The three-valued liveness contract, at the point where a value enters it. A tab title
  // is a label, not a resource: no backend enumerates it, so `heldHomeNames` can never
  // contain it and `homeAlive` reads it as `false`. `false` is the ONE value that lets
  // `reconcileOnStartup` run `git worktree remove --force`, so persisting a title as a home
  // means a restart deletes the checkout of an agent that is alive in that very tab.
  //
  // Null is the honest answer and maps to "could not tell", which reclaims nothing.
  const emu = recordingEmu();
  const outcome = await launchTerminal(
    "wezterm",
    SPEC,
    deps({ emulators: { wezterm: emu.backend } }),
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.homeName, null, "a tab title must never be persisted as a home");
  // The title still reaches the tab - it is a label, and that is all it ever was.
  assert.equal(emu.opened[0]?.title, PLAIN_NAMES.sanitize(SPEC.name));
});

test("a multiplexer launch DOES report a durable home", async () => {
  // The other half, so the null above reads as a distinction rather than as "we stopped
  // reporting homes". A multiplexer session name is enumerable by `heldHomeNames` and
  // addressable by `killHome`, so a later liveness check can answer truthfully about it.
  const mux = recordingMux();
  const emu = recordingEmu();
  const outcome = await launchTerminal(
    "tmux",
    SPEC,
    deps({ multiplexers: { tmux: mux.backend }, emulators: { wezterm: emu.backend } }),
  );
  assert.equal(outcome.ok, true);
  assert.equal(typeof outcome.homeName, "string");
  assert.equal(outcome.homeName, mux.created[0]?.name, "the home is the session actually made");
});
