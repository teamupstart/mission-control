import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "../src/shared/types.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { QueueManager } from "../src/server/queue.ts";
import type { TaskManager } from "../src/server/tasks.ts";

// Where an attention-inbox dismissal is kept, and how every dashboard hears of it.
//
// What is at stake is the row that popped back up. A dismissal held only in the page that
// clicked it is undone by a reload, a second window, or a restart - and so is one held in
// `localStorage`, which is keyed by origin and Electron profile and has moved before. So the
// daemon stores it, a database written before the table existed gains it on open, and every
// write tells every open dashboard to re-read.
//
// And it is never forgotten. A row comes back only when it reports something new, so nothing
// may drop a dismissal by age or by count: an earlier cut dropped the oldest once 500 had
// accumulated, which brought back an item that had reported nothing new.
//
// And it is never overwritten by an older decision from another window. Each write names the
// newest revision of its row the window had seen; a window whose dismissal was delayed past
// another window's newer one is refused, so the newer one stands for everybody.

const home = mkdtempSync(join(tmpdir(), "mission-attention-dismissals-"));
process.env.HARNESS_HOME = home;

// A database the previous release wrote: schema 22, no `attention_dismissals` table.
const raw = new DatabaseSync(join(home, "harness.db"));
raw.exec("PRAGMA user_version = 22;");
raw.close();

const { openDb, CURRENT_DATABASE_SCHEMA_VERSION } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { buildApp } = await import("../src/server/routes.ts");
const store = await import("../src/server/attention-dismissals.ts");
const { ATTENTION_DISMISSAL_LIMITS, DismissAttentionItemsSchema } = await import("../src/shared/protocol.ts");

after(() => rmSync(home, { recursive: true, force: true }));

function setup() {
  const registry = new Registry();
  const events: ServerEvent[] = [];
  registry.subscribe((event) => events.push(event));
  const app = buildApp({
    registry,
    reviews: {} as unknown as ReviewManager,
    tasks: {} as unknown as TaskManager,
    queues: {} as unknown as QueueManager,
  });
  const call = async (method: "GET" | "POST", body?: unknown, path = "/api/attention/dismissals", raw?: string) => {
    const res = await app.request(path, {
      method,
      headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
      ...(raw !== undefined ? { body: raw } : body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { events, call };
}

const clear = () => openDb().exec("DELETE FROM attention_dismissals");
const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_800_000_000_000;

test("a database from before dismissals gains the table on open", () => {
  const d = openDb();
  const table = d
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'attention_dismissals'")
    .get() as { name: string } | undefined;
  assert.equal(table?.name, "attention_dismissals");
  assert.equal(
    (d.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    CURRENT_DATABASE_SCHEMA_VERSION,
  );
  assert.ok(CURRENT_DATABASE_SCHEMA_VERSION >= 24);
});

test("a dismissal is stored, read back, and announced to every dashboard", async () => {
  clear();
  const { events, call } = setup();
  assert.deepEqual((await call("GET")).body, { dismissals: [] });

  const posted = await call("POST", {
    items: [{ itemId: "pipeline-commission:c-1", occurrence: "0badf00d", basis: 0 }],
  });
  assert.equal(posted.status, 200);
  const read = await call("GET");
  const rows = read.body.dismissals as { itemId: string; occurrence: string; revision: number }[];
  assert.deepEqual(
    rows.map(({ itemId, occurrence }) => ({ itemId, occurrence })),
    [{ itemId: "pipeline-commission:c-1", occurrence: "0badf00d" }],
  );
  // The write answers with the revision it stored, which is all a window needs to learn from it.
  assert.deepEqual(posted.body, {
    ok: true,
    accepted: [{ itemId: "pipeline-commission:c-1", revision: rows[0]!.revision }],
  });
  // Content-free: the frame is the signal, the route is the data.
  assert.deepEqual(events.filter((e) => e.type === "attention_dismissals_changed"), [
    { type: "attention_dismissals_changed" },
  ]);
});

const revisionOf = (body: Record<string, unknown>) =>
  (body.accepted as { revision: number }[])[0]!.revision;

test("dismissing a row again replaces what it was dismissed at, never duplicates it", async () => {
  clear();
  const { call } = setup();
  const first = await call("POST", { items: [{ itemId: "blocked:s-1", occurrence: "aaaaaaaa", basis: 0 }] });
  const second = await call("POST", {
    items: [{ itemId: "blocked:s-1", occurrence: "bbbbbbbb", basis: revisionOf(first.body) }],
  });
  assert.equal(second.status, 200);
  assert.ok(revisionOf(second.body) > revisionOf(first.body), "every write takes a newer revision");
  const rows = (await call("GET")).body.dismissals as { itemId: string; occurrence: string }[];
  assert.deepEqual(rows.map((r) => [r.itemId, r.occurrence]), [["blocked:s-1", "bbbbbbbb"]]);
});

test("another window's older dismissal is refused, and the newer one stands", async () => {
  // The reviewer's sequence. Window A dismisses problem A; its request is delayed. The row now
  // reports problem B, and window B - which saw no stored dismissal either - dismisses B, which
  // is stored. A's request arrives last, still naming basis 0: it never saw B's dismissal.
  clear();
  const { events, call } = setup();
  const changed = () => events.filter((e) => e.type === "attention_dismissals_changed").length;
  const windowB = await call("POST", { items: [{ itemId: "pipeline-commission:c-1", occurrence: "bbbbbbbb", basis: 0 }] });
  assert.equal(windowB.status, 200);
  const before = changed();

  const windowA = await call("POST", { items: [{ itemId: "pipeline-commission:c-1", occurrence: "aaaaaaaa", basis: 0 }] });
  assert.equal(windowA.status, 409);
  assert.deepEqual(windowA.body.superseded, ["pipeline-commission:c-1"]);
  assert.match(String(windowA.body.error), /another window dismissed this/);
  const rows = (await call("GET")).body.dismissals as { occurrence: string; revision: number }[];
  assert.deepEqual(rows.map((r) => r.occurrence), ["bbbbbbbb"], "the newer dismissal stands");
  assert.equal(rows[0]!.revision, revisionOf(windowB.body), "untouched, not rewritten");
  assert.equal(changed(), before, "a refused write changes nothing any window holds");

  // Once window A has read the stored set, a dismissal it makes is its newest decision again.
  const caughtUp = await call("POST", {
    items: [{ itemId: "pipeline-commission:c-1", occurrence: "cccccccc", basis: rows[0]!.revision }],
  });
  assert.equal(caughtUp.status, 200);
});

test("a refused batch stores none of its keys", async () => {
  clear();
  const { call } = setup();
  const stored = await call("POST", { items: [{ itemId: "review:r-2", occurrence: "", basis: 0 }] });
  const batch = await call("POST", {
    items: [
      { itemId: "review:r-1", occurrence: "", basis: 0 },
      { itemId: "review:r-2", occurrence: "", basis: revisionOf(stored.body) - 1 },
    ],
  });
  assert.equal(batch.status, 409);
  assert.deepEqual(batch.body.superseded, ["review:r-2"]);
  const ids = ((await call("GET")).body.dismissals as { itemId: string }[]).map((r) => r.itemId);
  assert.deepEqual(ids, ["review:r-2"], "a row of questions is never left half dismissed");
});

test("rewriting the only row never reissues the revision it just deleted", () => {
  // A dismissal is rewritten (deleted and inserted) to take a fresh revision. With a plain rowid
  // the new row would get the number just freed whenever it was the highest, and a window still
  // holding that number would pass the stale check against a dismissal it never saw.
  clear();
  const first = store.dismissAttentionItems([{ itemId: "blocked:s-1", occurrence: "a", basis: 0 }], T0);
  assert.ok(first.stored);
  const old = first.accepted[0]!.revision;
  const again = store.dismissAttentionItems([{ itemId: "blocked:s-1", occurrence: "b", basis: old }], T0 + 1);
  assert.ok(again.stored);
  assert.ok(again.accepted[0]!.revision > old, "a fresh number, not the one the rewrite freed");
  const stale = store.dismissAttentionItems([{ itemId: "blocked:s-1", occurrence: "c", basis: old }], T0 + 2);
  assert.deepEqual(stale, { stored: false, superseded: ["blocked:s-1"] });
});

test("one row's several keys land together", async () => {
  clear();
  const { call } = setup();
  await call("POST", {
    items: [
      { itemId: "review:r-1", occurrence: "", basis: 0 },
      { itemId: "review:r-2", occurrence: "", basis: 0 },
    ],
  });
  const ids = ((await call("GET")).body.dismissals as { itemId: string }[]).map((r) => r.itemId).sort();
  assert.deepEqual(ids, ["review:r-1", "review:r-2"]);
});

test("a row of hundreds of questions is dismissed whole, and still all or nothing", async () => {
  // A session's row of questions is one key per pending question, sent in one request. An
  // earlier cap of 100 refused such a row outright and it could never be dismissed.
  clear();
  const { call } = setup();
  const questions = Array.from({ length: 250 }, (_, i) => ({ itemId: `review:r-${i}`, occurrence: "", basis: 0 }));
  const whole = await call("POST", { items: questions });
  assert.equal(whole.status, 200, JSON.stringify(whole.body).slice(0, 200));
  assert.equal((whole.body.accepted as unknown[]).length, 250);
  assert.equal(((await call("GET")).body.dismissals as unknown[]).length, 250);

  // One stale key among 250 still refuses the batch, and stores none of the rest.
  clear();
  const stored = await call("POST", { items: [{ itemId: "review:r-249", occurrence: "", basis: 0 }] });
  const batch = await call("POST", {
    items: questions.map((key) => (key.itemId === "review:r-249" ? { ...key, basis: revisionOf(stored.body) - 1 } : key)),
  });
  assert.equal(batch.status, 409);
  assert.deepEqual(batch.body.superseded, ["review:r-249"]);
  assert.deepEqual(((await call("GET")).body.dismissals as { itemId: string }[]).map((r) => r.itemId), ["review:r-249"]);
});

test("one request is bounded: the largest request is stored whole, one key more is refused", async () => {
  // Bounded on purpose (`ATTENTION_DISMISSAL_LIMITS`): an unbounded array is what Zod 3 parses
  // element by element before any length check, so the cap stays. It bounds a request, not a
  // row: the dashboard sends a longer row in several (`dismissalBatches`).
  clear();
  const { events, call } = setup();
  const keys = (n: number) => Array.from({ length: n }, (_, i) => ({ itemId: `review:r-${i}`, occurrence: "", basis: 0 }));
  const largest = await call("POST", { items: keys(ATTENTION_DISMISSAL_LIMITS.keysPerRequest) });
  assert.equal(largest.status, 200);
  assert.equal((largest.body.accepted as unknown[]).length, ATTENTION_DISMISSAL_LIMITS.keysPerRequest);

  clear();
  const before = events.length;
  const tooMany = await call("POST", { items: keys(ATTENTION_DISMISSAL_LIMITS.keysPerRequest + 1) });
  assert.equal(tooMany.status, 400);
  assert.deepEqual((await call("GET")).body, { dismissals: [] }, "nothing stored");
  assert.equal(events.length, before, "nothing announced");
});

test("the request schema refuses an oversized array without parsing its elements, and stops at the first bad one", () => {
  // GHSA-mrhx-c7xc-m3w5: a Zod 3 `z.array` parses every element - one issue per bad one - before
  // its length check. This schema checks the bound first, so an oversized request of garbage is
  // ONE issue, not one per element.
  const oversized = DismissAttentionItemsSchema.safeParse({
    items: Array.from({ length: ATTENTION_DISMISSAL_LIMITS.keysPerRequest + 1 }, () => ({ garbage: true })),
  });
  assert.equal(oversized.success, false);
  assert.deepEqual(
    oversized.error!.issues.map((issue) => [issue.code, issue.path.join(".")]),
    [["too_big", "items"]],
  );
  // Within the bound, validation stops at the first element that fails.
  const bad = DismissAttentionItemsSchema.safeParse({ items: [{ garbage: 1 }, { garbage: 2 }, { garbage: 3 }] });
  assert.equal(bad.success, false);
  assert.ok(bad.error!.issues.length > 0);
  assert.ok(bad.error!.issues.every((issue) => issue.path[0] === "items" && issue.path[1] === 0), "only the first element");
  // And a good request parses to exactly what was sent.
  const good = DismissAttentionItemsSchema.safeParse({ items: [{ itemId: "review:r-1", occurrence: "", basis: 3 }] });
  assert.deepEqual(good.success && good.data, { items: [{ itemId: "review:r-1", occurrence: "", basis: 3 }] });
  // Unknown fields are still refused, as `.strict()` always did.
  assert.equal(DismissAttentionItemsSchema.safeParse({ items: [], extra: 1 }).success, false);
});

test("an absurd body is refused by its size before the schema parses any of it", async () => {
  clear();
  const { call } = setup();
  // Far past what the largest valid request could ever weigh, in tiny elements - the shape that
  // makes per-element parsing expensive.
  const items = "{},".repeat(8_000_000);
  const res = await call("POST", undefined, "/api/attention/dismissals", `{"items":[${items}{}]}`);
  assert.equal(res.status, 413);
  assert.deepEqual((await call("GET")).body, { dismissals: [] });
});

test("a malformed dismissal is refused and stores nothing", async () => {
  clear();
  const { events, call } = setup();
  for (const body of [
    {},
    { items: [] },
    { items: [{ itemId: "", occurrence: "x" }] },
    { items: [{ itemId: "blocked:s-1" }] },
    { items: [{ itemId: "blocked:s-1", occurrence: "x".repeat(65) }] },
    { items: [{ itemId: "blocked:s-1", occurrence: "x", basis: 0, extra: true }] },
    { items: [{ itemId: "blocked:s-1", occurrence: "x" }] },
    { items: [{ itemId: "blocked:s-1", occurrence: "x", basis: -1 }] },
  ]) {
    assert.equal((await call("POST", body)).status, 400, JSON.stringify(body));
  }
  assert.deepEqual((await call("GET")).body, { dismissals: [] });
  assert.equal(events.filter((e) => e.type === "attention_dismissals_changed").length, 0);
});

test("a dismissal never expires and is never pruned, however many pile up or however old", () => {
  clear();
  // A year of dismissals, more than the 500 an earlier cut kept.
  const ids = Array.from({ length: 600 }, (_, i) => `blocked:s-${i}`);
  for (const [i, id] of ids.entries()) {
    store.dismissAttentionItems([{ itemId: id, occurrence: "", basis: 0 }], T0 - 365 * DAY + i * 12 * 60 * 60 * 1000);
  }
  assert.equal(store.listAttentionDismissals().length, 600, "nothing ages out and no count cap applies");
  // And the table keeps nothing an expiry would need.
  const columns = (openDb().prepare("PRAGMA table_info(attention_dismissals)").all() as { name: string }[])
    .map((column) => column.name);
  assert.deepEqual(columns, ["revision", "item_id", "occurrence", "dismissed_at"]);
});
