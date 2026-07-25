import { test } from "node:test";
import assert from "node:assert/strict";
import { canMessage, canWriteTo } from "../src/shared/pane.ts";
import { mkEmuHandle, mkMuxHandle, mkSession } from "./helpers/session-fixture.ts";

// What is at stake: two predicates that answer the same way for every session shipped
// today, and must answer DIFFERENTLY for the one the runtime axis introduces.
//
// `canWriteTo` was doing both jobs because there was only ever one kind of session. Now
// "can a turn reach this session" and "is there a pane to drive" come apart, and each
// wrong direction is its own bug:
//
//  - a delivery site left on `canWriteTo` refuses a driver-run session it could have
//    reached: a greyed-out Send box, a work queue that never ticks, a Foreman escalation
//    that says "no reply channel" about a session with a perfectly good one;
//  - a pane site widened to `canMessage` offers an affordance with nothing behind it:
//    Rename on a session with no terminal to rename, Shift+Tab into no pty, a write lock
//    keyed on a pane that does not exist.
//
// Neither fails loudly, so the truth table is pinned here rather than left to the reading.

const MUX = mkMuxHandle();
const EMU = mkEmuHandle();

test("a pane-backed session can be messaged and written to - the two agree today", () => {
  for (const terminals of [[MUX], [EMU], [MUX, EMU]]) {
    const s = mkSession({ terminals });
    assert.equal(canWriteTo(s), true);
    assert.equal(canMessage(s), true);
  }
});

test("a terminal session with no handle can be neither messaged nor written to", () => {
  // The session in a terminal we do not integrate with: it exists on the dashboard, and
  // nothing can be delivered to it by any route.
  const s = mkSession({ terminals: [] });
  assert.equal(canWriteTo(s), false);
  assert.equal(canMessage(s), false);
});

test("a driver-run session can be messaged and CANNOT be written to", () => {
  // The whole point of the split. No handles, because an SDK session has no pane at all -
  // so `canWriteTo` is false and must stay false, while delivery is available.
  const s = mkSession({ runtime: "sdk", terminals: [], tty: null });
  assert.equal(canWriteTo(s), false, "there is no pane, and nothing may pretend there is");
  assert.equal(canMessage(s), true, "the driver is the delivery channel");
});

test("the runtime decides, never the id spelling", () => {
  // `sdk:<uuid>` ids exist so the two id spaces cannot collide, and are validated exactly
  // once (at registration). A predicate that read the prefix instead would be a second,
  // quieter definition of the axis - and would answer wrongly for either of these.
  const idLooksSdk = mkSession({ id: "sdk:1111", runtime: "terminal", terminals: [] });
  assert.equal(canMessage(idLooksSdk), false);
  const idLooksProc = mkSession({ id: "proc:ttys1:9:0", runtime: "sdk", terminals: [] });
  assert.equal(canMessage(idLooksProc), true);
});

test("canWriteTo needs only handles, so a DiscoveredSession can still be asked", () => {
  // `canMessage` takes `PaneHandles & { runtime }` and `canWriteTo` takes `PaneHandles`
  // alone, which is what keeps discovery's own consumers (the paneDialog stickiness
  // fallback) on the predicate that does not need a field they have never had.
  assert.equal(canWriteTo({ terminals: [MUX] }), true);
  assert.equal(canWriteTo({ terminals: [] }), false);
});
