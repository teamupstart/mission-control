import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REAL_BACKEND_UNDER_TEST_RUNNER,
  heldHomeNames,
  homeAlive,
  homeBackends,
  homeNameRules,
  killHome,
  launchHome,
  type HomeDeps,
} from "../src/server/terminal/home.ts";
import {
  EMU_BIN,
  FAIL,
  OK,
  emulatorPane,
  fakeEmulator,
  fakeMultiplexer,
  fakeTerminals,
  muxPane,
} from "./helpers/terminal-fakes.ts";
import { PLAIN_NAMES } from "../src/server/terminal/names.ts";
import type { MuxSessions, Multiplexer, TerminalEmulator } from "../src/server/terminal/types.ts";

// What is at stake: that a dispatch's terminal home is created, probed and destroyed by the
// same backend, and that "no backend could answer" never arrives as "the agent is gone".
//
// Dispatch used to say `tmux` four times, minutes and a restart apart: `new-session -d` to
// create, `list-sessions` to pick a free name, `has-session` to decide on startup whether an
// interrupted task's agent survived, `kill-session` to tear it down. Three of those four are
// destructive in the same direction - the probe answering "gone" runs
// `git worktree remove --force` over the checkout and hands a pooled lease back - and a
// machine with no tmux could not dispatch at all.
//
// So the axis is chosen ONCE (`homeBackends`) and every verb reads that choice, and the
// probe has three answers rather than two. These tests drive the answer nobody's machine
// produces: no backend installed at all, and a backend that can open a home it cannot
// enumerate.

const SPEC = { name: "api", cwd: "/w/api", argv: ["claude", "--model", "x"], sidePane: true };

/** The named-session half, with each verb overridable. */
function sessions(over: Partial<MuxSessions> = {}): MuxSessions {
  return {
    spawnDetached: async () => OK,
    attachArgv: (name) => ["fake", "attach", name],
    rename: async () => OK,
    kill: async () => OK,
    names: PLAIN_NAMES,
    ...over,
  };
}

/** Deps with everything installed unless a test says otherwise. */
function deps(
  mux: Multiplexer,
  emu: TerminalEmulator,
  installed: HomeDeps["installed"] = () => true,
  second?: Multiplexer,
): HomeDeps {
  return { ...fakeTerminals(mux, emu, second), installed };
}

/** A machine with a terminal emulator and no multiplexer at all - the tab-dispatch shape. */
const emulatorOnly: HomeDeps["installed"] = (spec) => spec === EMU_BIN;

test("a multiplexer wins the axis, and the emulator is not consulted at all", async () => {
  // The precedence `enumerateTerminals` declares for NAMING, applied to creation. A
  // multiplexer pane lives inside an emulator pane, so it is the inner, more specific home -
  // and picking one axis is what makes launch, probe and kill agree by construction.
  let tabs = 0;
  const chosen = homeBackends(
    deps(
      fakeMultiplexer({ sessions: sessions() }),
      fakeEmulator({
        spawn: {
          tab: async () => {
            tabs++;
            return { ...OK, target: null };
          },
        },
      }),
    ),
  );

  assert.deepEqual(chosen.map((b) => b.id), ["tmux"]);
  assert.equal(tabs, 0);
});

test("an unsupported multiplexer is excluded before installation or home operations", () => {
  const herdr = fakeMultiplexer({
    id: "herdr",
    label: "Herdr",
    bin: {
      env: "HERDR_BIN",
      candidates: ["herdr"],
      dropEnv: [],
      unsupportedReason: () => "Herdr integration is supported on macOS and Linux only",
    },
    sessions: sessions(),
  });
  let herdrInstallationProbes = 0;
  const terminalDeps: HomeDeps = {
    ...fakeTerminals(fakeMultiplexer(), fakeEmulator()),
    installed: (spec) => {
      if (spec === herdr.bin) herdrInstallationProbes += 1;
      return true;
    },
  };
  terminalDeps.multiplexers.herdr = herdr;

  assert.equal(homeBackends(terminalDeps).some((backend) => backend.id === "herdr"), false);
  assert.equal(herdrInstallationProbes, 0);
});

test("with no multiplexer installed, a dispatch still lands - in an emulator tab", async () => {
  // The whole point of giving the interface a spawn capability: a machine with no tmux was
  // simply unable to dispatch, and said so only as an ENOENT inside a task error.
  const opened: { title: string; cwd: string | null; argv: readonly string[] }[] = [];
  const r = await launchHome(
    SPEC,
    deps(
      // Installed, capable, and simply not present on this machine.
      fakeMultiplexer({ sessions: sessions() }),
      fakeEmulator({
        spawn: {
          tab: async (spec) => {
            opened.push({ title: spec.title, cwd: spec.cwd, argv: spec.argv });
            return { ...OK, target: null };
          },
        },
      }),
      emulatorOnly,
    ),
  );

  assert.equal(r.ok, true);
  // The cwd is the load-bearing field. A dispatched agent that opened in the daemon's
  // directory instead of the worktree would commit to the wrong branch.
  assert.deepEqual(opened, [{ title: "api", cwd: "/w/api", argv: SPEC.argv }]);
});

test("an explicit emulator choice bypasses installed multiplexers", async () => {
  const opened: string[] = [];
  const machine = deps(
    fakeMultiplexer({ sessions: sessions() }),
    fakeEmulator({
      spawn: {
        tab: async () => {
          opened.push("wezterm");
          return { ...OK, target: null };
        },
      },
    }),
  );

  assert.deepEqual(homeBackends(machine, "wezterm").map((backend) => backend.id), ["wezterm"]);
  assert.equal((await launchHome(SPEC, machine, "wezterm")).ok, true);
  assert.deepEqual(opened, ["wezterm"]);
});

test("an unavailable explicit choice fails instead of silently choosing another terminal", async () => {
  const machine = deps(
    fakeMultiplexer({ sessions: sessions() }),
    fakeEmulator({ spawn: { tab: async () => ({ ...OK, target: null }) } }),
    (spec) => spec !== EMU_BIN,
  );

  const result = await launchHome(SPEC, machine, "wezterm");
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /selected terminal backend wezterm/);
});

test("an explicit backend owns liveness even when another backend holds the same name", async () => {
  const machine = deps(
    fakeMultiplexer({
      sessions: sessions(),
      list: async () => [muxPane({ session: "api", sessionName: "api" })],
    }),
    fakeEmulator({
      spawn: { tab: async () => ({ ...OK, target: null }) },
      list: async () => [],
    }),
  );

  assert.equal(await homeAlive("api", machine), true);
  assert.equal(await homeAlive("api", machine, "wezterm"), false);
  assert.equal(await homeAlive("api", machine, "future-terminal"), null);
});

// The suite must not open sessions on the machine that runs it, and this is the boundary that
// makes that structural rather than a habit. `multi-repo-dispatch.test.ts` built a `Dispatcher`
// without its documented `spawn` seam, and its one single-repo case reached the real launcher
// on every run: 42 Herdr workspaces and 2 tmux sessions were left behind, one of them holding a
// launch pointed at the operator's live daemon. The seam is a dep, so nothing enforced it.
//
// Shaped after `db-isolation.test.ts` rather than living beside it: the refusal belongs where
// the session is opened, so it is stated in `home.ts` and pinned here, where every other
// launch-policy case already is.
test("the real backends are refused under the test runner, and injected ones are not", async () => {
  // Every case in this file passes fakes, which is what a test that means to reach the launch
  // path is supposed to do. Those are untouched.
  const injected = await launchHome(SPEC, deps(fakeMultiplexer({ sessions: sessions() }), fakeEmulator()));
  assert.equal(injected.ok, true);

  // The default deps ARE the machine's real tmux, Herdr, cmux, WezTerm and the rest. A test
  // worker reaching them opens a session nothing here will ever close.
  const real = await launchHome(SPEC);
  assert.equal(real.ok, false);
  assert.equal(real.ok === false ? real.error : "", REAL_BACKEND_UNDER_TEST_RUNNER);
  // The sentence names both repairs, because a dispatch reaches this through `spawnUniquely`
  // and its author is looking for the Dispatcher seam, not for HomeDeps.
  assert.match(REAL_BACKEND_UNDER_TEST_RUNNER, /spawn/);
  assert.match(REAL_BACKEND_UNDER_TEST_RUNNER, /terminal-fakes/);
});

// The dispatcher half of the same boundary, driven through the function that actually opens
// the session for a dispatch. `spawnUniquely` is what `Dispatcher` calls when `deps.spawn` is
// unset, so this is exactly what a dispatcher constructed without the seam reaches.
test("a dispatch that skipped the spawn seam cannot reach a real backend either", async () => {
  const { spawnUniquely } = await import("../src/server/dispatcher.ts");
  await assert.rejects(
    () => spawnUniquely("api", "abc123", process.cwd(), "/bin/echo", []),
    (error: Error) => {
      assert.equal(error.message, REAL_BACKEND_UNDER_TEST_RUNNER);
      return true;
    },
  );
});

test("a machine with nothing installed is told what would fix it", async () => {
  const r = await launchHome(SPEC, deps(fakeMultiplexer(), fakeEmulator(), () => false));

  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /no terminal backend can host a dispatched agent/);
  // Names the backends rather than leaving the operator to guess which of the two axes.
  assert.match(r.error ?? "", /tmux/);
  assert.match(r.error ?? "", /wezterm/);
});

test("a launch that fails reports the backend's own words, not ours", async () => {
  const r = await launchHome(
    SPEC,
    deps(
      fakeMultiplexer({ sessions: sessions({ spawnDetached: async () => FAIL("duplicate session: api") }) }),
      fakeEmulator(),
    ),
  );

  assert.deepEqual(r, { ok: false, error: "duplicate session: api" });
});

test("background homes preserve selection across backend fallback", async () => {
  const opened: Array<{ backend: string; select: boolean }> = [];
  const first = fakeMultiplexer({
    sessions: sessions({
      spawnDetached: async (spec) => {
        opened.push({ backend: "tmux", select: spec.select });
        return FAIL("tmux unavailable");
      },
    }),
  });
  const second = fakeMultiplexer({
    id: "cmux",
    label: "cmux",
    sessions: sessions({
      spawnDetached: async (spec) => {
        opened.push({ backend: "cmux", select: spec.select });
        return OK;
      },
    }),
  });

  const result = await launchHome(
    SPEC,
    deps(first, fakeEmulator(), () => true, second),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(opened, [
    { backend: "tmux", select: false },
    { backend: "cmux", select: false },
  ]);
});

test("held names come from the pane list, matched exactly", async () => {
  // Exactness is the point: tmux's own `has-session -t api` falls back to a prefix match and
  // answers yes for `api-2`. A dispatch reading that as "taken" renames for nothing; a
  // teardown reading it as "alive" leaves a tree standing forever.
  const held = await heldHomeNames(
    deps(
      fakeMultiplexer({
        sessions: sessions(),
        list: async () => [
          muxPane({ session: "api-2", sessionName: "api-2" }),
          muxPane({ session: "other", sessionName: "other" }),
        ],
      }),
      fakeEmulator(),
    ),
  );

  assert.deepEqual([...held!.keys()].sort(), ["api-2", "other"]);
  assert.equal(held!.has("api"), false);
});

test("a home is killed by its ADDRESS, resolved from the name a task recorded", async () => {
  // The distinction cmux forced: a tmux session's name IS its target spec, so nothing needed
  // to tell them apart until a backend arrived whose workspaces carry a UUID and a separate,
  // renameable title. A teardown that passed the recorded NAME to `close-workspace` would
  // resolve nothing, tear down nothing, and hand a live agent's worktree back to the pool.
  const killed: string[] = [];
  const byUuid = deps(
    fakeMultiplexer({
      list: async () => [muxPane({ session: "9f3c-uuid", sessionName: "Fix the login bug" })],
      sessions: sessions({
        kill: async (address) => {
          killed.push(address);
          return OK;
        },
      }),
    }),
    fakeEmulator(),
  );

  assert.deepEqual(await killHome("Fix the login bug", byUuid), { ok: true, asked: true });
  assert.deepEqual(killed, ["9f3c-uuid"], "the address, never the title");
});

test("a name no backend holds is passed through, so the backend's own refusal is the error", async () => {
  // Not our lookup miss wearing the backend's clothes: on tmux the two strings are one, and
  // a name that resolves to nothing has to reach `kill-session` to produce the "can't find
  // session" a human acts on.
  const tried: string[] = [];
  const r = await killHome(
    "never-existed",
    deps(
      fakeMultiplexer({
        list: async () => [muxPane({ session: "api", sessionName: "api" })],
        sessions: sessions({
          kill: async (address) => {
            tried.push(address);
            return FAIL("can't find session: never-existed");
          },
        }),
      }),
      fakeEmulator(),
    ),
  );

  assert.deepEqual(tried, ["never-existed"]);
  assert.deepEqual(r, { ok: false, asked: true, error: "can't find session: never-existed" });
});

test("an emulator home is named by its TAB TITLE, which is what discovery reads back", async () => {
  const emuOnly = deps(
    fakeMultiplexer(),
    fakeEmulator({
      spawn: { tab: async () => ({ ...OK, target: null }) },
      list: async () => [emulatorPane({ tabTitle: "api" }), emulatorPane({ tabTitle: "" })],
    }),
    emulatorOnly,
  );

  assert.equal(await homeAlive("api", emuOnly), true);
  // An untitled tab is not a home anyone can name, so it contributes nothing.
  assert.equal(await homeAlive("", emuOnly), false);
});

test("emulator liveness follows its saved pane identity through duplicate and empty tab titles", async () => {
  let panes = [emulatorPane({ paneId: "owned", tabTitle: "shell title" })];
  const machine = deps(fakeMultiplexer(), fakeEmulator({ list: async () => panes }), emulatorOnly);
  const alive = (): Promise<boolean | null> =>
    homeAlive("Dispatched task", machine, "wezterm", "emulator:wezterm:owned");
  assert.equal(await alive(), true);
  panes = [...panes, emulatorPane({ paneId: "other", tabTitle: "shell title" })];
  assert.equal(await alive(), true, "duplicate titles must not hide the owned pane");
  panes = [emulatorPane({ paneId: "owned", tabTitle: "" })];
  assert.equal(await alive(), true, "an empty title does not mean the pane closed");
  panes = [emulatorPane({ paneId: "other", tabTitle: "Dispatched task" })];
  assert.equal(await alive(), false, "another pane with the launch title cannot stand in for it");
  assert.equal(await homeAlive("Dispatched task", machine, "ghostty", "emulator:wezterm:owned"), null);
  assert.equal(await homeAlive("Dispatched task", machine, null, "emulator:future:owned"), null);
  machine.emulators.wezterm.list = null;
  assert.equal(await alive(), null, "an unavailable observation is not evidence of closure");
  machine.emulators.wezterm.list = async () => [];
  machine.installed = () => false;
  assert.equal(await alive(), null);
});

test("a backend that cannot be enumerated answers null, and null is not 'gone'", async () => {
  // Ghostty: it opens tabs perfectly well and can list nothing. The distinction decides
  // whether `reconcileOnStartup` runs `git worktree remove --force` on a live agent's
  // checkout, so it must not collapse into `false` on the way out of this function.
  const emuOnly = deps(
    fakeMultiplexer(),
    fakeEmulator({ spawn: { tab: async () => ({ ...OK, target: null }) }, list: null }),
    emulatorOnly,
  );

  assert.equal(await heldHomeNames(emuOnly), null);
  assert.equal(await homeAlive("api", emuOnly), null);
});

test("nothing installed answers null too - a recorded name proves nothing", async () => {
  const nothing = deps(fakeMultiplexer({ sessions: sessions() }), fakeEmulator(), () => false);

  assert.equal(await homeAlive("api", nothing), null);
});

test("a killed home reports that it was asked; an unkillable one reports that it was not", async () => {
  // `asked` is separate from `ok` because a teardown that found no backend able to kill this
  // home did not FAIL - there was nothing to fail at - and is nonetheless about to hand the
  // agent's worktree back to a pool. Collapsing the two is how that becomes a silent no-op.
  const killed: string[] = [];
  const killable = deps(
    fakeMultiplexer({
      sessions: sessions({
        kill: async (name) => {
          killed.push(name);
          return OK;
        },
      }),
    }),
    fakeEmulator(),
  );
  assert.deepEqual(await killHome("api", killable), { ok: true, asked: true });
  assert.deepEqual(killed, ["api"]);

  // An emulator tab is not a group: closing the window is the human's to do, and the agent
  // is reached by its pid. Declared as `kill: null` rather than left to an else-branch.
  const emuOnly = deps(
    fakeMultiplexer(),
    fakeEmulator({ spawn: { tab: async () => ({ ...OK, target: null }) } }),
    emulatorOnly,
  );
  assert.deepEqual(await killHome("api", emuOnly), { ok: false, asked: false });
});

test("a kill that was attempted and refused is asked-but-failed, and carries the reason", async () => {
  const r = await killHome(
    "api",
    deps(
      fakeMultiplexer({ sessions: sessions({ kill: async () => FAIL("can't find session: api") }) }),
      fakeEmulator(),
    ),
  );

  assert.deepEqual(r, { ok: false, asked: true, error: "can't find session: api" });
});

test("name rules come from the backend a dispatch would actually land on", async () => {
  const strict = { validate: () => "nope", sanitize: () => "coerced" };
  const chosen = homeNameRules(
    deps(fakeMultiplexer({ sessions: sessions({ names: strict }) }), fakeEmulator()),
  );
  assert.equal(chosen.sanitize("anything"), "coerced");

  // With nothing installed a name can still be cut - the dispatch fails at `launchHome`,
  // with its own message, rather than three steps earlier at a name that came back empty.
  const none = homeNameRules(deps(fakeMultiplexer(), fakeEmulator(), () => false));
  assert.equal(none.sanitize("Fix the Bug"), "Fix the Bug");
});
