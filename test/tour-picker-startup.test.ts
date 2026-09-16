import assert from "node:assert/strict";
import test from "node:test";
import { startupTourDecision } from "../src/web/tour/startup.ts";

const eligible = { handled: false, hydrated: true, enabled: true, hasTours: true, busy: false };

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
