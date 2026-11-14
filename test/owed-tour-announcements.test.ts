import assert from "node:assert/strict";
import test from "node:test";

import {
  oweAnnouncement,
  owedAnnouncementsMark,
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
  assert.deepEqual(JSON.parse(store.data.get(KEY)!), { seq: 2, owed: { residents: 2 } });
  // A fresh read, as the next window makes it.
  assert.deepEqual(readOwedAnnouncements(store), ["residents"]);
  // Settled: nothing is owed, and the sequence is kept so an older mark stays older.
  assert.deepEqual(settleOwedAnnouncements(["residents"], store), []);
  assert.deepEqual(JSON.parse(store.data.get(KEY)!), { seq: 2, owed: {} });
});

test("a record write settles only what was owed when it began, never a later dismissal", () => {
  const store = memoryStorage();
  // A picker opening, featuring a tour owed from an earlier midway Exit, captures its mark.
  oweAnnouncement("residents", store);
  const mark = owedAnnouncementsMark(store);
  // Before its write lands, the operator starts the tour from that picker and leaves it midway.
  oweAnnouncement("residents", store);
  assert.ok(owedAnnouncementsMark(store) > mark);
  // The write lands: the newer dismissal is still owed.
  assert.deepEqual(settleOwedAnnouncements(["residents"], store, mark), ["residents"]);
  assert.deepEqual(readOwedAnnouncements(store), ["residents"]);
  // A write that began after it, or a run seen through, settles it.
  assert.deepEqual(settleOwedAnnouncements(["residents"], store, owedAnnouncementsMark(store)), []);
  // An empty store's mark is zero, and a debt owed after settling everything is newer than it.
  const fresh = memoryStorage();
  assert.equal(owedAnnouncementsMark(fresh), 0);
  assert.deepEqual(settleOwedAnnouncements(["residents"], fresh, 0), []);
  oweAnnouncement("residents", fresh);
  assert.deepEqual(settleOwedAnnouncements(["residents"], fresh, 0), ["residents"]);
});

test("an unreadable or absent store owes nothing rather than failing the dashboard", () => {
  for (const raw of [
    "not json",
    "{\"residents\":true}",
    "[7, \"\", null]",
    "[\"residents\"]",
    "{\"seq\":3,\"owed\":{\"residents\":\"3\"}}",
  ]) {
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
