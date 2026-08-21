import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LAYOUTS, detailLayer } from "../src/web/lib/layout.ts";

/**
 * Killing a session has to hand the overview straight back.
 *
 * What's at stake is a dead end, not a wrong pixel: a killed session does NOT leave the
 * list: it is marked `exited` and lingers ~8 seconds before eviction, and only then does
 * App's session-disappeared reconciliation drop the selection. On the board that meant
 * confirming a kill and being left inside the drill-in, reading a transcript that can no
 * longer change, with the action bar (drawn only while the session is live) already gone -
 * Escape the sole way back to the columns. So the kill closes its own detail.
 *
 * Driven as source + pure function rather than a click: no jsdom here, and the flow is a
 * promise resolving into a state update three components up.
 */

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/web/${rel}`, import.meta.url)), "utf8");

test("every layout says which layer a kill closes", () => {
  // A future layout answers here, not in another layout-specific branch in App.
  for (const l of LAYOUTS) {
    assert.ok(["selection", "board"].includes(detailLayer(l.id)), `${l.id} has no layer`);
  }
  // Console drops its selection; Board drops its separate drill-in while leaving the
  // keyboard cursor parked on the tile.
  assert.equal(detailLayer("console"), "selection");
  assert.equal(detailLayer("board"), "board");
});

/**
 * The confirm moved off the action bar and into a dialog (`KillModal`), so the flow this
 * file guards moved with it - but the guarantee did not change, and neither did the way
 * it can regress. It is asserted at the dialog now because that is where the request is
 * made and where its result is read.
 *
 * There are TWO of them to check, which is the part worth stating: Complete also ends the
 * session, so it inherits the same dead end. A Complete that recorded the outcome and
 * left you inside a drill-in reading a transcript that can no longer change is the exact
 * bug above, arriving through the door added to avoid it.
 */
test("a landed kill tells App, and a refused one does not", () => {
  const modal = src("components/KillModal.tsx");
  assert.match(modal, /const r = await api\.kill\(session\.id\)/, modal);
  // Guarded on the result: a kill the daemon refused leaves the dialog open with the
  // reason on it, rather than closing a detail that is still live.
  assert.match(modal, /if \(!r\.ok\) \{[\s\S]*?return;[\s\S]*?\}\s*onKilled\?\.\(\)/, modal);
});

test("a landed complete closes its detail too, and a refused one does not", () => {
  const modal = src("components/CompleteModal.tsx");
  assert.match(modal, /const killed = await api\.kill\(session\.id\)/, modal);
  assert.match(modal, /if \(!killed\.ok\)[\s\S]*?return;/, modal);
  assert.match(modal, /onCompleted\?\.\(\)/, modal);
});

test("App wires both dialogs back to the one detail-closing callback", () => {
  // `onKilled` is the single place that knows which layer to peel per layout. Two
  // dialogs end a session; a second, hand-written closer for one of them is how they
  // drift into disagreeing about the board.
  const app = src("App.tsx");
  for (const [modal, prop] of [["CompleteModal", "onCompleted"], ["KillModal", "onKilled"]]) {
    const start = app.indexOf(`<${modal}`);
    assert.ok(start >= 0, `App does not render ${modal}`);
    const block = app.slice(start, app.indexOf("/>", start));
    assert.match(block, new RegExp(`${prop}=\\{\\(\\) => onKilled\\(`), `${modal}: ${block}`);
  }
});

test("the shared Console and Board detail wires both end-a-session buttons", () => {
  const rel = "components/layouts/ConsoleDetail.tsx";
  const text = src(rel);
  const bar = text.slice(text.indexOf("<ActionBar"), text.indexOf("/>", text.indexOf("<ActionBar")));
  assert.match(bar, /onComplete=/, `${rel} renders an ActionBar with no onComplete: ${bar}`);
  assert.match(bar, /onKill=/, `${rel} renders an ActionBar with no onKill: ${bar}`);
});
