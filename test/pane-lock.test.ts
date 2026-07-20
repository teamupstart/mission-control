import { test } from "node:test";
import assert from "node:assert/strict";
import { withPaneLock } from "../src/server/actions.ts";
import { paneToken } from "../src/shared/pane.ts";
import { overlayKeyFromEnv, sessionKey } from "../src/server/registry.ts";
import { paneKeyOf } from "../src/server/foreman/queue-apply.ts";
import type { Session } from "../src/shared/types.ts";

// The pane write lock. It used to guard only permission-mode cycling; the skills
// reload loop is the first writer that types into many panes on its own schedule, so
// for the first time two writers can pick the same pane at once with nobody involved.
//
// Every public write in actions.ts is a real subprocess, so this is the only place
// the guard's own semantics can be asserted: who wins, who is refused, and - the one
// that matters most - whether a key is ever left held.
//
// It also pins the pane TOKEN, at the bottom of the file. The lock is one of four
// subsystems that key on a pane, and they used to build the token four times in two
// spellings - `wezterm:` here and in the capture-miss counter, `wez:` in the registry
// overlay and the Foreman's send guard. Nothing was broken, because each subsystem only
// ever compared the token against itself; the fifth copy, written for a third terminal
// backend, is where a mismatch becomes a session whose hooks bind to nothing.

type Handles = Pick<Session, "tmux" | "wezterm">;

const tmuxPane = (paneId: string): Handles => ({
  tmux: { session: "s", window: "w", windowIndex: 0, paneId },
  wezterm: null,
});

const weztermPane = (paneId: number): Handles => ({
  tmux: null,
  wezterm: { paneId, tabId: 0, windowId: 0, tabTitle: "", isActive: true },
});

const NO_PANE: Handles = { tmux: null, wezterm: null };

/** A write that blocks until released, so two can genuinely overlap. */
function gate(): { held: Promise<void>; release: () => void } {
  let release = (): void => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  return { held, release };
}

test("a second write to the same pane is refused while the first is in flight", async () => {
  const g = gate();
  const first = withPaneLock(tmuxPane("%1"), () => "busy", async () => {
    await g.held;
    return "wrote";
  });
  const second = await withPaneLock(tmuxPane("%1"), () => "busy", async () => "wrote");

  assert.equal(second, "busy", "the loser is refused, not queued");
  g.release();
  assert.equal(await first, "wrote");
});

test("a refusal is a REFUSAL, not a wait", async () => {
  // Queueing would hold a keystroke behind a mode walk that reads the pane between
  // every step, then deliver it into a session that has moved on since.
  const g = gate();
  const first = withPaneLock(tmuxPane("%1"), () => "busy", async () => {
    await g.held;
    return "wrote";
  });
  // Resolves NOW, while the first is still blocked - it doesn't await the release.
  assert.equal(await withPaneLock(tmuxPane("%1"), () => "busy", async () => "wrote"), "busy");
  g.release();
  await first;
});

test("different panes never block each other - the fleet writes in parallel", async () => {
  // The reload loop fans out across the fleet at once, which is the whole point. A
  // lock keyed on anything coarser would serialize it behind one slow pane.
  const g = gate();
  const first = withPaneLock(tmuxPane("%1"), () => "busy", async () => {
    await g.held;
    return "wrote";
  });
  assert.equal(await withPaneLock(tmuxPane("%2"), () => "busy", async () => "wrote"), "wrote");
  g.release();
  assert.equal(await first, "wrote");
});

test("the key is the pane, not the session - two reads of one pane collide", async () => {
  // `session.id` is synthetic for an uninstrumented session and churns as pids/ttys
  // change, so two reads of "the same session" can key differently while addressing
  // one pane. The pane is the thing being protected.
  const g = gate();
  const first = withPaneLock(tmuxPane("%1"), () => "busy", async () => {
    await g.held;
    return "wrote";
  });
  const sameHandleDifferentObject = { tmux: { session: "other", window: "x", windowIndex: 9, paneId: "%1" }, wezterm: null };
  assert.equal(await withPaneLock(sameHandleDifferentObject, () => "busy", async () => "wrote"), "busy");
  g.release();
  await first;
});

test("a tmux pane and a wezterm pane with the same id are different panes", async () => {
  const g = gate();
  const first = withPaneLock(tmuxPane("1"), () => "busy", async () => {
    await g.held;
    return "wrote";
  });
  assert.equal(await withPaneLock(weztermPane(1), () => "busy", async () => "wrote"), "wrote");
  g.release();
  await first;
});

test("the lock is released after a write throws, not held forever", async () => {
  // A held key is a pane nothing can ever write to again for the life of the daemon -
  // silently, since every later attempt just reports busy.
  await assert.rejects(
    withPaneLock(tmuxPane("%1"), () => "busy", async () => {
      throw new Error("tmux died");
    }),
  );
  assert.equal(await withPaneLock(tmuxPane("%1"), () => "busy", async () => "wrote"), "wrote");
});

test("the lock is released after a write returns", async () => {
  assert.equal(await withPaneLock(tmuxPane("%1"), () => "busy", async () => "wrote"), "wrote");
  assert.equal(await withPaneLock(tmuxPane("%1"), () => "busy", async () => "wrote"), "wrote");
});

test("handleless sessions never collide with each other", async () => {
  // They have no pane to protect, so they skip the lock and the write itself answers
  // with NO_HANDLE - the honest error. A shared null key would make the second one
  // claim a pane conflict it doesn't have.
  const g = gate();
  const first = withPaneLock(NO_PANE, () => "busy", async () => {
    await g.held;
    return "no handle";
  });
  assert.equal(await withPaneLock(NO_PANE, () => "busy", async () => "no handle"), "no handle");
  g.release();
  await first;
});

test("tmux wins when a session has both handles, exactly as the writes resolve", async () => {
  const both: Handles = {
    tmux: { session: "s", window: "w", windowIndex: 0, paneId: "%1" },
    wezterm: { paneId: 7, tabId: 0, windowId: 0, tabTitle: "", isActive: true },
  };
  const g = gate();
  const first = withPaneLock(both, () => "busy", async () => {
    await g.held;
    return "wrote";
  });
  // Collides on the tmux pane...
  assert.equal(await withPaneLock(tmuxPane("%1"), () => "busy", async () => "wrote"), "busy");
  // ...and not on the wezterm one, which is the outer client and not where we type.
  assert.equal(await withPaneLock(weztermPane(7), () => "busy", async () => "wrote"), "wrote");
  g.release();
  await first;
});

// ---- the token itself: one spelling, four subsystems ----

/** A `Session` is only ever read for its two handles by the functions under test. */
const asSession = (h: Handles): Session => h as Session;

test("every subsystem that keys on a pane spells the token identically", () => {
  // The write lock (here), the registry's hook overlay, and the Foreman's
  // pane-recreated guard. They are three separate processes' worth of code keying
  // three separate maps, and each is internally consistent whatever it emits - so a
  // divergence is invisible until two of them have to agree about one pane.
  for (const h of [tmuxPane("%3"), weztermPane(7)]) {
    const token = paneToken(h);
    assert.ok(token, "a session with a handle has a token");
    assert.equal(sessionKey(asSession(h)), token, "registry overlay key");
    assert.equal(paneKeyOf(asSession(h)), token, "foreman send guard key");
  }
});

test("a hook's env and the discovered session agree, which is what makes binding work", () => {
  // The one place two subsystems' tokens are genuinely compared: an overlay is stored
  // under the key built from the hook's captured env, and found again under the key
  // built from the session discovery saw. The env carries pane ids as strings and
  // discovery as a number, so the two paths cannot share a code path - only a spelling.
  assert.equal(overlayKeyFromEnv({ tmuxPane: "%3" }), paneToken(tmuxPane("%3")));
  assert.equal(overlayKeyFromEnv({ weztermPane: "7" }), paneToken(weztermPane(7)));
});

test("the token names its backend, so two backends' pane ids can never collide", () => {
  // tmux pane "1" and wezterm pane 1 are different panes. A bare id would make the
  // registry hand one session's hook overlay to another's card.
  assert.notEqual(paneToken(tmuxPane("1")), paneToken(weztermPane(1)));
});

test("wezterm pane 0 has a token - presence of the handle decides, not truthiness of the id", () => {
  // The id is a number, so a `if (paneId)` reading of it would silently un-handle the
  // first pane wezterm ever numbers, and that session would lock against nothing.
  assert.equal(paneToken(weztermPane(0)), "wezterm:0");
});

test("a handleless session has no token at all", () => {
  assert.equal(paneToken(NO_PANE), null);
  assert.equal(sessionKey(asSession(NO_PANE)), null);
  assert.equal(paneKeyOf(asSession(NO_PANE)), null);
  assert.equal(overlayKeyFromEnv({}), null);
});
