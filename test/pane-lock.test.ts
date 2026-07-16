import { test } from "node:test";
import assert from "node:assert/strict";
import { withPaneLock } from "../src/server/actions.ts";
import type { Session } from "../src/shared/types.ts";

// The pane write lock. It used to guard only permission-mode cycling; the skills
// reload loop is the first writer that types into many panes on its own schedule, so
// for the first time two writers can pick the same pane at once with nobody involved.
//
// Every public write in actions.ts is a real subprocess, so this is the only place
// the guard's own semantics can be asserted: who wins, who is refused, and - the one
// that matters most - whether a key is ever left held.

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
