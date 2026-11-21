// A dashboard page's shaping write identity, its tab's lineage, and its write sequences.
import assert from "node:assert/strict";
import test from "node:test";
import { SHAPING_WRITE_WINDOW_MS } from "../src/shared/shaping.ts";

/** The tab's session storage as a page loading in it finds it, here a reloaded tab's. */
const stored = new Map<string, string>();
(globalThis as unknown as { sessionStorage: Pick<Storage, "getItem" | "setItem"> }).sessionStorage = {
  getItem: (key) => stored.get(key) ?? null,
  setItem: (key, value) => { stored.set(key, String(value)); },
};
const now = Date.now();
stored.set("mission.shaping.write-identity", "page-before-reload");
stored.set("mission.shaping.write-lineage", JSON.stringify([
  { id: "page-long-ago", until: now - SHAPING_WRITE_WINDOW_MS - 1000 },
  { id: "page-earlier", until: now - 60_000 },
  { id: "bad/id", until: now },
]));

const { nextShapingWriteSequence, raiseShapingWriteSequence, shapingWriteIdentity } = await import("../src/web/lib/shaping-write-identity.ts");

test("a page load takes an identity of its own, and names its tab's earlier ones while a write under them can wait", () => {
  const identity = shapingWriteIdentity(now);
  assert.notEqual(identity.window, "page-before-reload", "never the identity it found stored");
  // The one replaced longer ago than a write can wait, and an unreadable one, are left out.
  assert.deepEqual(identity.lineage, ["page-earlier", "page-before-reload"]);
  assert.equal(stored.get("mission.shaping.write-identity"), identity.window);
  assert.deepEqual((JSON.parse(stored.get("mission.shaping.write-lineage")!) as Array<{ id: string }>).map((entry) => entry.id), identity.lineage);
  assert.equal(shapingWriteIdentity(now + 1), identity, "taken once per page");
});

test("a floor from the daemon raises the next sequence above it, and never lowers one", () => {
  const first = nextShapingWriteSequence();
  assert.ok(first >= now * 1000);
  // As after the clock was set back an hour: the daemon's floor is ahead of this clock.
  const floor = (Date.now() + 3_600_000) * 1000;
  raiseShapingWriteSequence(floor);
  assert.equal(nextShapingWriteSequence(), floor + 1);
  raiseShapingWriteSequence(5);
  assert.equal(nextShapingWriteSequence(), floor + 2, "a lower floor changes nothing");
  assert.equal(stored.get("mission.shaping.write-sequence"), String(floor + 2), "and the tab keeps it across reloads");
});
