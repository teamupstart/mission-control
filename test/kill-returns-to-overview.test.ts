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
  // A fourth layout answers here, not in another `layout === "grid"` ternary in App.
  for (const l of LAYOUTS) {
    assert.ok(["expanded", "selection"].includes(detailLayer(l.id)), `${l.id} has no layer`);
  }
  // The grid keeps its selection - that's the keyboard's place among the cards, and focus
  // mode is the only thing filling the screen. The console and the board have no separate
  // expansion to drop, so the selection is what has to go for the overview to come back.
  assert.equal(detailLayer("grid"), "expanded");
  assert.equal(detailLayer("console"), "selection");
  assert.equal(detailLayer("board"), "selection");
});

test("a landed kill tells App, and a refused one does not", () => {
  const bar = src("components/ActionBar.tsx");
  const doKill = bar.slice(bar.indexOf("async function doKill"), bar.indexOf("function startSend"));
  assert.match(doKill, /const r = await run\("kill"/, doKill);
  // Guarded on the result: a kill the daemon refused leaves the screen where it was, with
  // the error `run` put on the bar still next to the button that produced it.
  assert.match(doKill, /if \(r\.ok\) onKilled\?\.\(\)/, doKill);
});

test("both surfaces that draw a kill button are wired to it", () => {
  // SessionCard is the grid's; ConsoleDetail is the console's AND the board's. A kill
  // ordered from a bar that forgot to pass this is the original bug, silently back.
  for (const rel of ["components/SessionCard.tsx", "components/layouts/ConsoleDetail.tsx"]) {
    const text = src(rel);
    const bar = text.slice(text.indexOf("<ActionBar"), text.indexOf("/>", text.indexOf("<ActionBar")));
    assert.match(bar, /onKilled=/, `${rel} renders an ActionBar with no onKilled: ${bar}`);
  }
});
