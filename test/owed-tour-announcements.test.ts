import assert from "node:assert/strict";
import test from "node:test";

import {
  oweAnnouncement,
  readOwedAnnouncements,
  settleOwedAnnouncements,
} from "../src/web/tour/owed-announcements.ts";
import { pendingTourAnnouncement, withOwedAnnouncements } from "../src/web/tour/startup.ts";
import { TOUR_ENTRIES } from "../src/web/tour/entries.ts";

/** An in-memory `Storage`, so each case starts from its own browser. */
function memoryStorage(initial: Record<string, string> = {}): Storage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  };
}

const KEY = "mission.tourAnnouncementsOwed";

test("a refused midway write is owed in this browser until it is announced or seen through", () => {
  const store = memoryStorage();
  assert.deepEqual(readOwedAnnouncements(store), []);
  assert.deepEqual(oweAnnouncement("residents", store), ["residents"]);
  // Owing it twice is still one debt.
  assert.deepEqual(oweAnnouncement("residents", store), ["residents"]);
  assert.equal(store.data.get(KEY), JSON.stringify(["residents"]));
  // A fresh read, as the next window makes it.
  assert.deepEqual(readOwedAnnouncements(store), ["residents"]);
  // Settled: nothing is left behind in storage.
  assert.deepEqual(settleOwedAnnouncements(["residents"], store), []);
  assert.equal(store.data.has(KEY), false);
});

test("an unreadable or absent store owes nothing rather than failing the dashboard", () => {
  for (const raw of ["not json", "{\"residents\":true}", "[7, \"\", null]"]) {
    assert.deepEqual(readOwedAnnouncements(memoryStorage({ [KEY]: raw })), [], raw);
  }
  assert.deepEqual(readOwedAnnouncements(null), []);
  assert.deepEqual(oweAnnouncement("residents", null), ["residents"]);
  const throwing = { ...memoryStorage(), setItem: () => { throw new Error("quota"); } } as Storage;
  assert.deepEqual(oweAnnouncement("residents", throwing), ["residents"]);
});

test("what this browser owes brings the tour back over a record that reads it as seen", () => {
  const available = TOUR_ENTRIES.map((entry) => entry.id);
  // The daemon kept "seen" because the midway write was refused; the browser owes it.
  const announced = ["residents", "from-a-newer-build"];
  assert.equal(pendingTourAnnouncement(announced, available), null);
  const effective = withOwedAnnouncements(announced, ["residents"]);
  assert.deepEqual(effective, ["from-a-newer-build"]);
  assert.equal(pendingTourAnnouncement(effective, available), "residents");
  // Owing nothing leaves the record exactly as the daemon has it.
  assert.equal(withOwedAnnouncements(announced, []), announced);
  // A debt can only add an announcement, never hide one the daemon still owes.
  assert.equal(pendingTourAnnouncement(withOwedAnnouncements([], ["setup"]), available), "residents");
});
