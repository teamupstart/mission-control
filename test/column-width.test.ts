// What is at stake: the rules between a board column's three widths, and the half of them
// that is saved.
//
// A column is collapsed, normal, or expanded. Only ONE column is ever expanded, expanding
// never collapses the one it displaces, and a column is never both. The collapsed set is saved
// in `UiConfig` and the expanded column is not - so a fold survives a reload and a "let me read
// this" does not. And a collapsed column's sessions have to leave the arrays the arrow keys
// walk, or the cursor steps onto cards nobody can see (the browser half of that is
// `e2e/specs/board-column-width.spec.ts`).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Session } from "../src/shared/types.ts";
import { orderSessions } from "../src/web/lib/fleet-order.ts";
import { mkSession } from "./helpers/session-fixture.ts";

const cache = new Map<string, string>();
const writes: unknown[] = [];
let refuse = false;
/** Refuse only the writes this matches, so one gesture's save fails and a later one lands. */
let refuseWhen: ((body: unknown) => boolean) | null = null;
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => cache.get(key) ?? null,
    setItem: (key: string, value: string) => void cache.set(key, value),
    removeItem: (key: string) => void cache.delete(key),
  },
});
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: async (_url: string, init?: RequestInit) => {
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (body !== undefined) writes.push(body);
    return refuse || (body !== undefined && refuseWhen?.(body))
      ? new Response(JSON.stringify({ error: "refused" }), { status: 503 })
      : new Response(JSON.stringify({ ok: true }), { status: 200 });
  },
});

const {
  collapsedColumnSessionIds,
  columnWidthOf,
  columnWidths,
  setColumnWidth,
  withColumnWidth,
} = await import("../src/web/lib/column-width.ts");
const { uiConfig, updateUiConfig } = await import("../src/web/lib/uiConfig.ts");

const none = { collapsed: new Set<string>(), wide: null };

/** Let the store's fire-and-forget config write settle. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("every column starts normal", () => {
  assert.equal(columnWidthOf(none, "backlog"), "normal");
  assert.equal(columnWidthOf(none, "attention"), "normal");
});

test("any number of columns collapse, and each restores on its own", () => {
  let state = withColumnWidth(none, "backlog", "collapsed");
  state = withColumnWidth(state, "attention", "collapsed");
  assert.equal(columnWidthOf(state, "backlog"), "collapsed");
  assert.equal(columnWidthOf(state, "attention"), "collapsed");
  state = withColumnWidth(state, "backlog", "normal");
  assert.equal(columnWidthOf(state, "backlog"), "normal");
  assert.equal(columnWidthOf(state, "attention"), "collapsed");
});

test("one expanded column at a time, and the one it displaces goes to normal, not collapsed", () => {
  let state = withColumnWidth(none, "working", "wide");
  state = withColumnWidth(state, "idle", "wide");
  assert.equal(columnWidthOf(state, "idle"), "wide");
  assert.equal(columnWidthOf(state, "working"), "normal");
});

test("a column is never both collapsed and expanded", () => {
  // Expanding a collapsed column takes it out of the collapsed set...
  let state = withColumnWidth(withColumnWidth(none, "backlog", "collapsed"), "backlog", "wide");
  assert.equal(columnWidthOf(state, "backlog"), "wide");
  assert.equal(state.collapsed.has("backlog"), false);
  // ...and collapsing the expanded column clears the expansion rather than leaving it pending.
  state = withColumnWidth(state, "backlog", "collapsed");
  assert.equal(columnWidthOf(state, "backlog"), "collapsed");
  assert.equal(state.wide, null);
});

test("collapsing a column leaves another column's expansion alone", () => {
  const state = withColumnWidth(withColumnWidth(none, "working", "wide"), "backlog", "collapsed");
  assert.equal(columnWidthOf(state, "working"), "wide");
  assert.equal(columnWidthOf(state, "backlog"), "collapsed");
});

test("a collapsed tone column hides exactly its own sessions from navigation", () => {
  const fleet: Session[] = [
    mkSession({ id: "w1", state: "working" }),
    mkSession({ id: "w2", state: "working" }),
    mkSession({ id: "i1", state: "idle", activity: null }),
  ];
  const groups = orderSessions(fleet, new Set(), false).groups;
  assert.equal(collapsedColumnSessionIds(groups, new Set()).size, 0);
  assert.deepEqual(
    [...collapsedColumnSessionIds(groups, new Set(["working"]))].sort(),
    ["w1", "w2"],
  );
  // A collapsed Backlog holds tasks, which the arrow keys never walked.
  assert.equal(collapsedColumnSessionIds(groups, new Set(["backlog"])).size, 0);
});

test("collapsing is saved to UiConfig; expanding is not", async () => {
  writes.length = 0;
  setColumnWidth("backlog", "collapsed");
  await settle();
  assert.deepEqual(uiConfig().collapsedBoardColumns, ["backlog"]);
  assert.deepEqual(writes, [{ collapsedBoardColumns: ["backlog"] }]);

  writes.length = 0;
  setColumnWidth("working", "wide");
  await settle();
  assert.deepEqual(writes, [], "an expansion is a gesture, never a saved setting");

  // Restoring removes only that column, and carries an id this build does not know through
  // untouched - it may be a column a newer build draws.
  await updateUiConfig({ collapsedBoardColumns: ["backlog", "from-a-newer-build"] });
  writes.length = 0;
  setColumnWidth("backlog", "normal");
  await settle();
  assert.deepEqual(uiConfig().collapsedBoardColumns, ["from-a-newer-build"]);
  await updateUiConfig({ collapsedBoardColumns: [] });
  setColumnWidth("working", "normal");
});

test("expanding a collapsed column saves it as no longer collapsed", async () => {
  await updateUiConfig({ collapsedBoardColumns: ["attention"] });
  writes.length = 0;
  setColumnWidth("attention", "wide");
  await settle();
  assert.deepEqual(uiConfig().collapsedBoardColumns, []);
  assert.deepEqual(writes, [{ collapsedBoardColumns: [] }]);
  setColumnWidth("attention", "normal");
});

test("a fold the daemon refuses is taken back, so no strip is drawn for an unsaved fold", async () => {
  refuse = true;
  try {
    setColumnWidth("idle", "collapsed");
    assert.deepEqual(uiConfig().collapsedBoardColumns, ["idle"], "applied at once");
    await settle();
    await settle();
    assert.deepEqual(uiConfig().collapsedBoardColumns, [], "and withdrawn on refusal");
  } finally {
    refuse = false;
  }
});

test("a refused save takes the expansion back too, so no column is left both collapsed and wide", async () => {
  // Expanding a collapsed column moves both halves at once. With only the collapsed set rolled
  // back, the column read wide while still in the collapsed set, and expanding another column
  // then snapped it back to a strip instead of normal.
  const widthNow = (id: string): string => columnWidthOf(columnWidths(), id);
  await updateUiConfig({ collapsedBoardColumns: ["backlog"] });
  refuse = true;
  try {
    setColumnWidth("backlog", "wide");
    assert.equal(widthNow("backlog"), "wide", "applied at once");
    await settle();
    await settle();
    assert.equal(widthNow("backlog"), "collapsed", "back to exactly where it was");
    assert.equal(columnWidths().wide, null, "and not also still expanded");
  } finally {
    refuse = false;
  }
  setColumnWidth("idle", "wide");
  assert.equal(widthNow("backlog"), "collapsed");
  assert.equal(widthNow("idle"), "wide");

  // The mirror case: collapsing the expanded column, refused, leaves it expanded.
  refuse = true;
  try {
    setColumnWidth("idle", "collapsed");
    await settle();
    await settle();
    assert.equal(widthNow("idle"), "wide");
  } finally {
    refuse = false;
  }
  setColumnWidth("idle", "normal");
  await updateUiConfig({ collapsedBoardColumns: [] });
});

test("a stale refused save never overrides a newer gesture that left the expansion alone", async () => {
  // Idle expanded, then collapsed, then restored to normal before the collapse's save is
  // refused. The restore left `wide` null, exactly where the collapse did, so a guard on its
  // value took the old refusal for the latest gesture and re-expanded Idle over the choice.
  const widthNow = (id: string): string => columnWidthOf(columnWidths(), id);
  setColumnWidth("idle", "wide");
  refuseWhen = (body) =>
    JSON.stringify(body) === JSON.stringify({ collapsedBoardColumns: ["idle"] });
  try {
    setColumnWidth("idle", "collapsed");
    setColumnWidth("idle", "normal");
    await settle();
    await settle();
    assert.equal(widthNow("idle"), "normal", "the latest gesture stands");
    assert.equal(columnWidths().wide, null);
    assert.deepEqual(uiConfig().collapsedBoardColumns, []);
  } finally {
    refuseWhen = null;
  }
});
