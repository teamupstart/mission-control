import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the daemon's SQLite DB before any value import that can resolve it loads - see
// the preamble note in `ui-config-store.test.ts`.
process.env.HARNESS_HOME = mkdtempSync(join(tmpdir(), "harness-focus-"));
const { focus } = await import("../src/server/actions.ts");

import {
  OK,
  FAIL,
  emulatorPane,
  fakeEmulator,
  fakeMultiplexer,
  fakeTerminals,
  muxClient,
} from "./helpers/terminal-fakes.ts";
import { mkSession } from "./helpers/session-fixture.ts";
import type { MuxSessions } from "../src/server/terminal/types.ts";
import type { TmuxInfo, WeztermInfo } from "../src/shared/types.ts";

// What is at stake: that Focus is a COMPOSITION of two axes and not a tmux special case.
//
// Focusing a multiplexer-hosted session is five steps in a fixed order - select the pane,
// select its window, find the tab running a client for it, raise that tab, else open a new
// one running attach - and every one of those steps belongs to a different interface. It
// read as `if (session.wezterm) … else if (session.tmux) …`, so the ORDER was an arm order
// and the "else" carried three unstated claims: that a multiplexer cannot raise, that an
// emulator has nothing to select inside, and that the tab hosting a client is not the
// session's own emulator handle.
//
// These tests state the order out loud and drive each capability null on its own, because
// the nulls are what a third backend arrives as. Ghostty raises without listing; a
// multiplexer with no `clients` cannot be walked outward from at all. Neither describes a
// shipped backend, so neither would ever be exercised by a test against the real two.

const tmux: TmuxInfo = { session: "work", window: "0", windowIndex: 0, paneId: "%3" };
const wezterm: WeztermInfo = { paneId: 12, tabId: 4, windowId: 1, tabTitle: "old", isActive: true };

/** The named-session half a focus fallback needs, recording the attach argv it hands out. */
function sessions(): MuxSessions {
  return {
    spawnDetached: async () => OK,
    attachArgv: (name) => ["fake-mux", "attach", "-t", name],
    rename: async () => OK,
    kill: async () => OK,
    names: { validate: () => null, sanitize: (t) => t },
  };
}

test("a multiplexer-hosted session is selected INSIDE, then its host tab is raised", async () => {
  const steps: string[] = [];
  const host = emulatorPane({ paneId: "5", tabId: "2", tty: "ttys012" });
  const mux = fakeMultiplexer({
    sessions: sessions(),
    clients: async () => [muxClient({ tty: "ttys012", session: "work" })],
    select: async (t) => {
      steps.push(`select:${t.paneId}`);
      return OK;
    },
  });
  const emu = fakeEmulator({
    list: async () => [host],
    focus: {
      granularity: "pane",
      raise: async (t) => {
        steps.push(`raise:${t.tabId}/${t.paneId}`);
        return OK;
      },
    },
  });

  const r = await focus(mkSession({ tmux }), fakeTerminals(mux, emu));

  assert.deepEqual(r, { ok: true });
  // Inward first, then outward. Selecting decides WHAT the session shows and raises nothing;
  // raising puts it in front of a human. Reverse them and the human is looking at the tab
  // before the right pane is under the cursor.
  assert.deepEqual(steps, ["select:%3", "raise:2/5"]);
});

test("the tab raised is the one hosting a CLIENT, never the session's own emulator handle", async () => {
  // An agent inside a multiplexer sits on a multiplexer pane tty while the tab showing it
  // sits on the client tty, so a session carrying both handles must still be raised through
  // the join. Raising `session.wezterm` would bring up whatever pane the agent's own tty
  // maps to, which is not the tab anyone is looking at.
  const raised: string[] = [];
  const host = emulatorPane({ paneId: "5", tabId: "2", tty: "ttys012" });
  const mux = fakeMultiplexer({
    sessions: sessions(),
    clients: async () => [muxClient({ tty: "ttys012", session: "work" })],
    select: async () => OK,
  });
  const emu = fakeEmulator({
    list: async () => [host],
    focus: {
      granularity: "pane",
      raise: async (t) => {
        raised.push(t.paneId);
        return OK;
      },
    },
  });

  await focus(mkSession({ tmux, wezterm }), fakeTerminals(mux, emu));

  assert.deepEqual(raised, ["5"], "pane 12 (session.wezterm) is never raised");
});

test("no tab hosts it: a fresh one is opened running the multiplexer's own attach argv", async () => {
  const opened: { argv: readonly string[]; title: string }[] = [];
  const mux = fakeMultiplexer({
    sessions: sessions(),
    clients: async () => [],
    select: async () => OK,
  });
  const emu = fakeEmulator({
    list: async () => [],
    focus: { granularity: "pane", raise: async () => OK },
    spawn: {
      tab: async (spec) => {
        opened.push({ argv: spec.argv, title: spec.title });
        return { ...OK, target: { paneId: "9", tabId: "9" } };
      },
    },
  });

  const r = await focus(mkSession({ tmux }), fakeTerminals(mux, emu));

  assert.deepEqual(r, { ok: true });
  // The argv comes from the multiplexer, not from a literal here: a `tmux attach` typed at
  // this layer is the branch this migration deletes.
  assert.deepEqual(opened, [{ argv: ["fake-mux", "attach", "-t", "work"], title: "work" }]);
});

test("attached in a terminal we cannot raise is a success, not a failure", async () => {
  // The pane inside was still selected, so the session is showing the right thing wherever
  // it is attached. We never repoint someone else's client at this session to prove it.
  const mux = fakeMultiplexer({
    sessions: sessions(),
    clients: async () => [muxClient({ tty: "ttys099", session: "work" })],
    select: async () => OK,
  });
  const emu = fakeEmulator({ list: async () => [], spawn: null });

  assert.deepEqual(await focus(mkSession({ tmux }), fakeTerminals(mux, emu)), { ok: true });
});

test("a multiplexer with no emulator anywhere degrades to the refusal it always had", async () => {
  // The behaviour this item promised to preserve exactly. Nothing hosts it, nothing can
  // open a tab, nothing is attached - and the sentence is composed from the backend's own
  // label, so the tmux wording is byte-identical and a cmux one would be true.
  const mux = fakeMultiplexer({ sessions: sessions(), clients: async () => [], select: async () => OK });
  const emu = fakeEmulator();

  const r = await focus(mkSession({ tmux }), fakeTerminals(mux, emu));

  assert.equal(r.ok, false);
  assert.equal(r.error, "no terminal tab hosts this tmux session and none could be opened");
});

test("a failed select never goes on to raise a window", async () => {
  // The pane is what the human is being sent to look at. Raising a tab showing the wrong
  // pane and calling it a focus is worse than saying it did not work.
  let raised = 0;
  const mux = fakeMultiplexer({
    sessions: sessions(),
    clients: async () => [muxClient()],
    select: async () => FAIL("can't find pane: %3"),
  });
  const emu = fakeEmulator({
    list: async () => [emulatorPane()],
    focus: {
      granularity: "pane",
      raise: async () => {
        raised++;
        return OK;
      },
    },
  });

  const r = await focus(mkSession({ tmux }), fakeTerminals(mux, emu));

  assert.equal(r.ok, false);
  assert.equal(r.error, "can't find pane: %3");
  assert.equal(raised, 0);
});

test("an emulator-only session raises its own tab and selects nothing", async () => {
  const raised: string[] = [];
  const emu = fakeEmulator({
    focus: {
      granularity: "pane",
      raise: async (t) => {
        raised.push(`${t.tabId}/${t.paneId}`);
        return OK;
      },
    },
  });

  const r = await focus(
    mkSession({ tmux: null, wezterm, nameSource: "wezterm" }),
    fakeTerminals(fakeMultiplexer(), emu),
  );

  assert.deepEqual(r, { ok: true });
  assert.deepEqual(raised, ["4/12"]);
});

test("an emulator that can only be aimed at the whole app is aimed at the whole app", async () => {
  // Ghostty's granularity. It brings the application forward with no idea which tab that
  // lands on, and the honest thing is to do that rather than to refuse - a human looking at
  // their terminal can find the session; a Focus button that does nothing cannot be
  // distinguished from a broken one.
  let appRaises = 0;
  const emu = fakeEmulator({
    focus: {
      granularity: "app",
      raise: async () => {
        appRaises++;
        return OK;
      },
    },
  });

  const r = await focus(
    mkSession({ tmux: null, wezterm, nameSource: "wezterm" }),
    fakeTerminals(fakeMultiplexer(), emu),
  );

  assert.deepEqual(r, { ok: true });
  assert.equal(appRaises, 1);
});

test("an emulator that cannot raise at all says so by name", async () => {
  const r = await focus(
    mkSession({ tmux: null, wezterm, nameSource: "wezterm" }),
    fakeTerminals(fakeMultiplexer(), fakeEmulator({ focus: null })),
  );

  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /WezTerm/);
});

test("a multiplexer that cannot report its clients still selects, then falls back to a tab", async () => {
  // `clients: null` is a declared capability, and it is exactly what makes the outward walk
  // impossible: with no client list there is no tty to join an emulator pane on. It must
  // not read as "nothing is attached and nothing could be opened" - the fallback still
  // opens a tab, which is the one thing that can still work.
  let opened = 0;
  const mux = fakeMultiplexer({ sessions: sessions(), clients: null, select: async () => OK });
  const emu = fakeEmulator({
    spawn: {
      tab: async () => {
        opened++;
        return { ...OK, target: null };
      },
    },
  });

  const r = await focus(mkSession({ tmux }), fakeTerminals(mux, emu));

  assert.deepEqual(r, { ok: true });
  assert.equal(opened, 1);
});

test("a session with no terminal handle at all is refused, not crashed", async () => {
  const r = await focus(
    mkSession({ tmux: null, wezterm: null }),
    fakeTerminals(fakeMultiplexer(), fakeEmulator()),
  );

  assert.equal(r.ok, false);
  assert.equal(r.error, "session has no focusable pane");
});
