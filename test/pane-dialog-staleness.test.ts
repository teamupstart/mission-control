import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { PaneDialog } from "../src/shared/types.ts";
import { annotatePaneState, paneMissCount, paneReadLost, paneReadOk } from "../src/server/discovery/pane-mode.ts";

// How long a dialog nobody can read any more goes on being offered.
//
// The dialog is deliberately not sticky - an answered menu must leave the card - with one
// exception: a capture that fails tells us NOTHING, and clearing a live menu off a card
// because one `tmux capture-pane` timed out would be its own bug. So the last one rides
// forward while the pane is unreadable.
//
// Unbounded, that exception is how a menu outlives its pane. The card keeps rendering rows
// against a screen no one can see, every click is refused, and nothing anywhere says the
// pane is gone - the symptom being a dialog that has "been sitting there for ages" and
// answers nobody. These pin the two ends of that: a pane still there but momentarily
// unreadable keeps its dialog; a pane that is GONE loses it.

const home = mkdtempSync(join(tmpdir(), "mission-pane-staleness-"));
process.env.MISSION_HOME = home;

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");

after(() => rmSync(home, { recursive: true, force: true }));

openDb();

const DIALOG: PaneDialog = {
  options: [
    { number: 1, label: "Yes" },
    { number: 2, label: "No" },
  ],
  highlighted: 1,
};

function mkDiscovered(over: Partial<DiscoveredSession> = {}): DiscoveredSession {
  return {
    syntheticId: "sid",
    agent: "claude",
    name: "work",
    nameSource: "process",
    cwd: "/repo",
    gitBranch: "feature",
    nomistakesGated: false,
    pid: 1,
    tty: "ttys1",
    wezterm: null,
    tmux: { session: "s", window: "w", windowIndex: 0, paneId: "%1" },
    startedAt: 0,
    ...over,
  } as DiscoveredSession;
}

test("a menu survives a tick that could not read the pane", () => {
  // `undefined` is "no information", which is not the same as "no menu".
  const registry = new Registry();
  registry.applyDiscovery([mkDiscovered({ syntheticId: "flaky-1", paneDialog: DIALOG })]);
  registry.applyDiscovery([mkDiscovered({ syntheticId: "flaky-1" })]);
  assert.deepEqual(registry.getSession("flaky-1")?.paneDialog, DIALOG);
});

test("a menu that was answered is cleared by the read that finds none", () => {
  const registry = new Registry();
  registry.applyDiscovery([mkDiscovered({ syntheticId: "answered-1", paneDialog: DIALOG })]);
  registry.applyDiscovery([mkDiscovered({ syntheticId: "answered-1", paneDialog: null })]);
  assert.equal(registry.getSession("answered-1")?.paneDialog, null);
});

test("a run of unreadable captures gives up, rather than pinning the menu forever", () => {
  // The tolerance above is for a flake, and a flake is short. A pane that has stopped
  // answering entirely is not a flake, and the difference has to be time-boxed - otherwise
  // the one exception that keeps a live menu on screen is also what keeps a dead one there.
  assert.equal(paneReadLost("tmux:%77"), false);
  assert.equal(paneReadLost("tmux:%77"), false);
  assert.equal(paneReadLost("tmux:%77"), true);
});

test("one good read forgives every miss before it", () => {
  // Misses have to be CONSECUTIVE: a pane that reads fine most ticks and times out
  // occasionally is a busy box, not a lost pane, and it must never accumulate its way
  // into having the menu dropped out from under the human.
  assert.equal(paneReadLost("tmux:%78"), false);
  assert.equal(paneReadLost("tmux:%78"), false);
  paneReadOk("tmux:%78");
  assert.equal(paneReadLost("tmux:%78"), false);
  assert.equal(paneReadLost("tmux:%78"), false);
});

test("a pane that vanishes takes its strikes with it, rather than willing them to the next %1", async () => {
  // The counter is keyed by tmux PANE ID, and tmux reuses those. A pane that disappears at
  // one or two strikes is filtered out of the sweep, so it never reads again and never
  // clears - and the next `%1` to exist would start life two strikes down, one flaky
  // capture from having a dialog dropped out from under the human on the tick it opened.
  assert.equal(paneReadLost("tmux:%81"), false);
  assert.equal(paneMissCount("tmux:%81"), 1);

  // A sweep in which that pane is not among the ones we can see. No handles here, so
  // nothing is captured - this is the prune alone.
  await annotatePaneState([mkDiscovered({ syntheticId: "handle-less", tmux: null, wezterm: null })]);
  assert.equal(paneMissCount("tmux:%81"), 0, "the count went with the pane");
});

test("a menu does not outlive the pane it was read from", () => {
  // The handle is gone, so the pane is never captured again AND the keystroke that would
  // answer the menu has nowhere to land. Keeping the rows would be a button that cannot
  // work, on a card that gives no sign of it - for as long as the session lives.
  const registry = new Registry();
  registry.applyDiscovery([mkDiscovered({ syntheticId: "unmoored-1", paneDialog: DIALOG })]);
  assert.deepEqual(registry.getSession("unmoored-1")?.paneDialog, DIALOG);

  registry.applyDiscovery([mkDiscovered({ syntheticId: "unmoored-1", tmux: null, wezterm: null })]);
  assert.equal(registry.getSession("unmoored-1")?.paneDialog, null);
});
