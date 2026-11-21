// A dashboard tab's shaping write identity and its write sequences.
import assert from "node:assert/strict";
import test from "node:test";

/** The tab's session storage as a page loading in it finds it, here a reloaded tab's. */
const stored = new Map<string, string>();
(globalThis as unknown as { sessionStorage: Pick<Storage, "getItem" | "setItem"> }).sessionStorage = {
  getItem: (key) => stored.get(key) ?? null,
  setItem: (key, value) => { stored.set(key, String(value)); },
};
stored.set("mission.shaping.write-identity", "tab-before-reload");

const { nextShapingWriteSequence, raiseShapingWriteSequence, shapingWriteIdentity } = await import("../src/web/lib/shaping-write-identity.ts");

test("a reloaded tab writes under the identity its session storage holds", () => {
  assert.equal(shapingWriteIdentity(), "tab-before-reload");
  assert.equal(shapingWriteIdentity(), "tab-before-reload", "taken once per page");
});

test("a floor from the daemon raises the next sequence above it, and never lowers one", () => {
  const first = nextShapingWriteSequence();
  assert.ok(first >= (Date.now() - 1000) * 1000);
  // As after the clock was set back an hour: the daemon's floor is ahead of this clock.
  const floor = (Date.now() + 3_600_000) * 1000;
  raiseShapingWriteSequence(floor);
  assert.equal(nextShapingWriteSequence(), floor + 1);
  raiseShapingWriteSequence(5);
  assert.equal(nextShapingWriteSequence(), floor + 2, "a lower floor changes nothing");
  assert.equal(stored.get("mission.shaping.write-sequence"), String(floor + 2), "and the tab keeps it across reloads");
});
