import assert from "node:assert/strict";
import test from "node:test";
import { ANNOUNCED_TOURS } from "../src/shared/protocol.ts";
import {
  pendingTourAnnouncement,
  rearmTourAnnouncement,
  recordTourAnnouncements,
  startupTourDecision,
} from "../src/web/tour/startup.ts";
import { TOUR_ENTRIES } from "../src/web/tour/entries.ts";

const eligible = {
  handled: false,
  hydrated: true,
  enabled: true,
  announcing: false,
  hasTours: true,
  busy: false,
};

test("only authoritative enabled preferences offer the catalog", () => {
  assert.equal(startupTourDecision(eligible), "open");
  assert.equal(startupTourDecision({ ...eligible, hydrated: false }), "wait");
  assert.equal(startupTourDecision({ ...eligible, enabled: false }), "settle");
  assert.equal(startupTourDecision({ ...eligible, hasTours: false }), "settle");
});

test("a busy host defers opening, while opt-out settles even behind a dialog", () => {
  assert.equal(startupTourDecision({ ...eligible, busy: true }), "wait");
  assert.equal(startupTourDecision({ ...eligible, busy: true, enabled: false }), "settle");
});

test("opening, successful launch or opt-out settles the entire document", () => {
  for (const hydrated of [false, true]) for (const busy of [false, true]) {
    assert.equal(startupTourDecision({ ...eligible, handled: true, hydrated, busy }), "wait");
  }
});

test("an owed announcement opens the picker past an opt-out, once per document", () => {
  const optedOut = { ...eligible, enabled: false, announcing: true };
  assert.equal(startupTourDecision(optedOut), "open");
  // It waits for the same things an ordinary opening waits for.
  assert.equal(startupTourDecision({ ...optedOut, hydrated: false }), "wait");
  assert.equal(startupTourDecision({ ...optedOut, busy: true }), "wait");
  assert.equal(startupTourDecision({ ...optedOut, handled: true }), "wait");
  assert.equal(startupTourDecision({ ...optedOut, hasTours: false }), "settle");
});

test("the residents tour is announced to a profile that predates it, and only once", () => {
  assert.deepEqual([...ANNOUNCED_TOURS], ["residents"]);
  const available = TOUR_ENTRIES.map((entry) => entry.id);
  // Upgraded: owed. Fresh, or already announced: nothing.
  assert.equal(pendingTourAnnouncement([], available), "residents");
  assert.equal(pendingTourAnnouncement(["residents"], available), null);
  assert.equal(pendingTourAnnouncement([...ANNOUNCED_TOURS], available), null);
  // A tour the catalog cannot draw is never announced.
  assert.equal(pendingTourAnnouncement([], available.filter((id) => id !== "residents")), null);
  // Recording keeps ids this build does not know and adds each announced tour exactly once.
  assert.deepEqual(recordTourAnnouncements([]), ["residents"]);
  assert.deepEqual(recordTourAnnouncements(["from-a-newer-build", "residents"]), [
    "from-a-newer-build",
    "residents",
  ]);
  assert.equal(pendingTourAnnouncement(recordTourAnnouncements([]), available), null);
});

test("dismissing the residents tour midway makes its announcement owed again", () => {
  const available = TOUR_ENTRIES.map((entry) => entry.id);
  const seen = recordTourAnnouncements(["from-a-newer-build"]);
  const rearmed = rearmTourAnnouncement(seen, "residents");
  assert.deepEqual(rearmed, ["from-a-newer-build"]);
  assert.equal(pendingTourAnnouncement(rearmed, available), "residents");
  // Already owed, or not an announced tour at all: the same list back, so App skips the write.
  assert.equal(rearmTourAnnouncement(rearmed, "residents"), rearmed);
  assert.equal(rearmTourAnnouncement(seen, "setup"), seen);
});
