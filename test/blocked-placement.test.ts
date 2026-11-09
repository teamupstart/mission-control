// What is at stake: one Blocked group, drawn in whichever of three places the operator chose,
// with the Board, the Console rail, the arrow keys and the ⌘-numbers reading the SAME order.
//
// Settings → Display → Blocked sessions moves idle blocked sessions between Board columns. Each
// placement is the same two lists - a column's own cards and the Blocked group - rearranged, so
// these assert the arrangement (`orderSessions(...).columns`), the column treatment
// (`boardColumnModes`), what a collapsed column hides, the rail's section order, and the
// keyboard arrays App derives from the columns. The setting's own schema is pinned first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session, SessionBlocker } from "../src/shared/types.ts";
import {
  BLOCKED_PLACEMENTS,
  BlockedPlacementSchema,
  UI_CONFIG_DEFAULTS,
  UiConfigPatchSchema,
  UiConfigSchema,
  type BlockedPlacement,
} from "../src/shared/protocol.ts";
import {
  fleetColumnOf,
  fleetRailSections,
  orderSessions,
  type FleetOrder,
} from "../src/web/lib/fleet-order.ts";
import { boardColumnModes } from "../src/web/lib/tone.ts";
import { collapsedColumnSessionIds } from "../src/web/lib/column-width.ts";
import { moveSelection } from "../src/web/lib/layoutNav.ts";
import { assignCardShortcuts } from "../src/web/lib/card-shortcuts.ts";
import { stateDisplay } from "../src/web/lib/format.ts";
import { BlockedPlacementPanel } from "../src/web/components/BlockedPlacementPanel.tsx";
import { CollapsedColumnStrip } from "../src/web/components/session-bits.tsx";
import { blockedSummary, oldestBlockerAge } from "../src/web/components/BlockedGroup.tsx";
import { mkSession } from "./helpers/session-fixture.ts";

const HOUR = 3_600_000;
const NOW = Date.now();

function blocker(over: Partial<SessionBlocker> = {}): SessionBlocker {
  return {
    kind: "question",
    reason: "Need the retention window",
    waitingOn: "Dana (platform)",
    resumeWhen: "Dana answers",
    details: null,
    referenceUrl: null,
    startedAt: NOW - HOUR,
    updatedAt: NOW - HOUR,
    checkedAt: null,
    reply: null,
    ...over,
  };
}

function plain(name: string, over: Partial<Session> = {}): Session {
  return mkSession({ id: name, name, pid: 1, ...over });
}

const IDLE: Partial<Session> = { state: "idle", activity: null };
const ASKING: Partial<Session> = { state: "awaiting_input", stateConfirmed: true };

/**
 * One of everything the placement rules distinguish: an asking session, a working one, two
 * idle ones, three idle blocked ones (one with a reply flagged, two of different ages), a
 * blocked session that is asking, and a blocked session that is working.
 */
function fleet(): Session[] {
  return [
    plain("ask-alpha", ASKING),
    plain("work-bravo"),
    plain("idle-charlie", IDLE),
    plain("idle-delta", IDLE),
    // Named so alphabetical order is the reverse of urgency, which is what proves the group
    // is sorted by its own rule rather than left in the baseline's.
    plain("blocked-alpha-newest", { ...IDLE, blocker: blocker({ startedAt: NOW - HOUR }) }),
    plain("blocked-bravo-oldest", { ...IDLE, blocker: blocker({ startedAt: NOW - 30 * HOUR }) }),
    plain("blocked-zulu-flagged", {
      ...IDLE,
      blocker: blocker({
        startedAt: NOW - 2 * HOUR,
        reply: { flaggedAt: NOW, flaggedBy: "operator", note: null, referenceUrl: null },
      }),
    }),
    plain("blocked-asking", { ...ASKING, blocker: blocker() }),
    plain("blocked-working", { blocker: blocker() }),
  ];
}

const BLOCKED_ORDER = ["blocked-zulu-flagged", "blocked-bravo-oldest", "blocked-alpha-newest"];

function order(placement: BlockedPlacement, sessions = fleet()): FleetOrder {
  return orderSessions(sessions, new Set(), false, undefined, undefined, new Set(), placement);
}

function ids(sessions: readonly Session[]): string[] {
  return sessions.map((s) => s.id);
}

function column(o: FleetOrder, id: string): string[] {
  const found = o.columns.find((c) => c.id === id);
  assert.ok(found, `column ${id} is drawn`);
  return ids(found.sessions);
}

test("the setting defaults to In Needs you, and a missing or unknown stored value reads as it", () => {
  assert.deepEqual([...BLOCKED_PLACEMENTS], ["needs-you", "idle", "column"]);
  assert.equal(UI_CONFIG_DEFAULTS.blockedPlacement, "needs-you");
  assert.equal(UiConfigSchema.parse({}).blockedPlacement, "needs-you");
  assert.equal(UiConfigSchema.parse({}).blockedFrameCollapsed, false);
  for (const placement of BLOCKED_PLACEMENTS) {
    assert.equal(UiConfigSchema.parse({ blockedPlacement: placement }).blockedPlacement, placement);
    assert.equal(BlockedPlacementSchema.parse(placement), placement);
  }
  // A placement a newer build added reads as the default after a downgrade, so the whole
  // config still opens.
  assert.equal(UiConfigSchema.parse({ blockedPlacement: "sidebar" }).blockedPlacement, "needs-you");
  assert.equal(BlockedPlacementSchema.safeParse("sidebar").success, false);
});

test("a patch naming an unknown placement is refused rather than stored as the default", () => {
  assert.equal(UiConfigPatchSchema.safeParse({ blockedPlacement: "sidebar" }).success, false);
  const parsed = UiConfigPatchSchema.parse({ blockedPlacement: "column" });
  assert.equal(parsed.blockedPlacement, "column");
  assert.equal(UiConfigPatchSchema.parse({ blockedFrameCollapsed: true }).blockedFrameCollapsed, true);
});

test("idle blocked sessions form one group, reply flagged first then oldest, in every placement", () => {
  for (const placement of BLOCKED_PLACEMENTS) {
    const o = order(placement);
    assert.deepEqual(ids(o.blocked), BLOCKED_ORDER, placement);
    assert.equal(o.blockedPlacement, placement);
    const idle = o.groups.find((g) => g.tone === "idle")!;
    assert.deepEqual(ids(idle.sessions), ["idle-charlie", "idle-delta"], placement);
  }
});

test("a blocked session that is asking or working stays in its own column", () => {
  for (const placement of BLOCKED_PLACEMENTS) {
    const o = order(placement);
    const attention = o.groups.find((g) => g.tone === "attention")!;
    const working = o.groups.find((g) => g.tone === "working")!;
    assert.ok(ids(attention.sessions).includes("blocked-asking"), placement);
    assert.ok(ids(working.sessions).includes("blocked-working"), placement);
    assert.ok(!ids(o.blocked).includes("blocked-asking"));
    assert.ok(!ids(o.blocked).includes("blocked-working"));
  }
});

test("unconfirmed blocked sessions join the group; gone ones stay in Gone", () => {
  const unconfirmed = plain("blocked-unconfirmed", {
    state: "idle",
    activity: null,
    stateConfirmed: false,
    instrumented: false,
    hooksSeen: false,
    blocker: blocker(),
  });
  const gone = plain("blocked-gone", { state: "exited", blocker: blocker() });
  assert.equal(stateDisplay(unconfirmed).tone, "neutral", "fixture is unconfirmed");
  assert.equal(stateDisplay(gone).tone, "exited", "fixture is gone");
  const o = order("needs-you", [unconfirmed, gone]);
  assert.deepEqual(ids(o.blocked), ["blocked-unconfirmed"]);
  assert.deepEqual(ids(o.groups.find((g) => g.tone === "exited")!.sessions), ["blocked-gone"]);
});

test("blocked wins over held: a held idle session with a blocker is in the Blocked group", () => {
  const sessions = fleet();
  const o = orderSessions(
    sessions,
    new Set(["blocked-bravo-oldest", "idle-delta"]),
    false,
    undefined,
    undefined,
    new Set(),
    "needs-you",
  );
  assert.ok(ids(o.blocked).includes("blocked-bravo-oldest"));
  const idle = o.groups.find((g) => g.tone === "idle")!;
  assert.deepEqual(ids(idle.sessions), ["idle-charlie", "idle-delta"]);
  assert.equal(idle.heldFrom, 1);
});

test("In Needs you: the Blocked lane follows the Needs you cards in the attention column", () => {
  const o = order("needs-you");
  assert.deepEqual(o.columns.map((c) => c.id), ["attention", "working", "idle", "neutral", "exited"]);
  assert.deepEqual(column(o, "attention"), ["ask-alpha", "blocked-asking", ...BLOCKED_ORDER]);
  assert.deepEqual(column(o, "idle"), ["idle-charlie", "idle-delta"]);
  const attention = o.columns.find((c) => c.id === "attention")!;
  assert.deepEqual(ids(attention.blocked), BLOCKED_ORDER);
});

test("At the top of Idle: the Blocked frame comes before the idle cards", () => {
  const o = order("idle");
  assert.deepEqual(o.columns.map((c) => c.id), ["attention", "working", "idle", "neutral", "exited"]);
  assert.deepEqual(column(o, "attention"), ["ask-alpha", "blocked-asking"]);
  assert.deepEqual(column(o, "idle"), [...BLOCKED_ORDER, "idle-charlie", "idle-delta"]);
});

test("Own column: a Blocked column between Needs you and Working", () => {
  const o = order("column");
  assert.deepEqual(o.columns.map((c) => c.id), ["attention", "blocked", "working", "idle", "neutral", "exited"]);
  const blocked = o.columns.find((c) => c.id === "blocked")!;
  assert.equal(blocked.group, null);
  assert.equal(blocked.label, "blocked");
  assert.deepEqual(ids(blocked.sessions), BLOCKED_ORDER);
  assert.deepEqual(column(o, "attention"), ["ask-alpha", "blocked-asking"]);
});

test("the flat order is the columns read in order, and re-ordering it changes nothing", () => {
  for (const placement of BLOCKED_PLACEMENTS) {
    const o = order(placement);
    assert.deepEqual(ids(o.sessions), o.columns.flatMap((c) => ids(c.sessions)), placement);
    const again = order(placement, o.sessions);
    assert.deepEqual(ids(again.sessions), ids(o.sessions), `${placement} is idempotent`);
  }
});

test("a fleet with no blocker draws the same columns it drew before the setting existed", () => {
  const sessions = fleet().filter((s) => !s.blocker);
  const before = orderSessions(sessions);
  for (const placement of ["needs-you", "idle"] as const) {
    const o = order(placement, sessions);
    assert.deepEqual(o.columns.map((c) => ids(c.sessions)), before.groups.map((g) => ids(g.sessions)));
  }
});

test("column treatment: Needs you is drawn while either lane has a card", () => {
  const onlyBlocked = fleet().filter((s) => s.id.startsWith("blocked-") && s.id !== "blocked-asking");
  const o = order("needs-you", onlyBlocked);
  const modes = boardColumnModes(o.columns, new Set(), null);
  assert.equal(modes.get("attention"), "sessions");
  assert.equal(modes.get("idle"), "stashed");
  const empty = order("needs-you", [plain("idle-only", IDLE)]);
  assert.equal(boardColumnModes(empty.columns, new Set(), null).get("attention"), "stashed");
});

test("column treatment: At the top of Idle keeps Idle while only the frame has cards", () => {
  const o = order("idle", [plain("b", { ...IDLE, blocker: blocker() })]);
  const modes = boardColumnModes(o.columns, new Set(), null);
  assert.equal(modes.get("idle"), "sessions");
  assert.equal(modes.get("attention"), "stashed");
});

test("column treatment: the Own column Blocked column hides when empty and can be revealed", () => {
  const none = order("column", [plain("idle-only", IDLE)]);
  assert.equal(boardColumnModes(none.columns, new Set(), null).get("blocked"), "stashed");
  assert.equal(boardColumnModes(none.columns, new Set(["blocked"]), null).get("blocked"), "revealed");
  assert.equal(boardColumnModes(none.columns, new Set(), "idle").get("blocked"), "revealed");
  const some = order("column");
  assert.equal(boardColumnModes(some.columns, new Set(), null).get("blocked"), "sessions");
  assert.equal(boardColumnModes(order("needs-you").columns, new Set(), null).has("blocked"), false);
});

test("a collapsed column hides the Blocked cards it draws, and only those", () => {
  const lane = order("needs-you");
  assert.deepEqual(
    [...collapsedColumnSessionIds(lane.columns, new Set(["attention"]))].sort(),
    ["ask-alpha", "blocked-asking", ...BLOCKED_ORDER].sort(),
  );
  const own = order("column");
  assert.deepEqual(
    [...collapsedColumnSessionIds(own.columns, new Set(["blocked"]))].sort(),
    [...BLOCKED_ORDER].sort(),
  );
  assert.equal(collapsedColumnSessionIds(lane.columns, new Set(["blocked"])).size, 0);
});

test("arrow keys walk the rendered order: a lane follows the lane above it", () => {
  const o = order("needs-you");
  const columns = o.columns.map((c) => ids(c.sessions));
  const down = (from: string) =>
    moveSelection({ mode: "board", key: "ArrowDown", ids: ids(o.sessions), currentId: from, columns });
  assert.equal(down("blocked-asking"), "blocked-zulu-flagged");
  assert.equal(down("blocked-zulu-flagged"), "blocked-bravo-oldest");
  // The lane is part of its column's one sequence, not a column of its own, so a sideways move
  // keeps the row index and clamps it to Working's end.
  const right = moveSelection({
    mode: "board", key: "ArrowRight", ids: ids(o.sessions), currentId: "blocked-zulu-flagged", columns,
  });
  assert.equal(right, "work-bravo");
});

test("arrow keys cross the Own column Blocked column between Needs you and Working", () => {
  const o = order("column");
  const columns = o.columns.map((c) => ids(c.sessions));
  const move = (key: "ArrowRight" | "ArrowLeft", from: string) =>
    moveSelection({ mode: "board", key, ids: ids(o.sessions), currentId: from, columns });
  assert.equal(move("ArrowRight", "ask-alpha"), "blocked-zulu-flagged");
  assert.equal(move("ArrowRight", "blocked-zulu-flagged"), "blocked-working");
  assert.equal(move("ArrowLeft", "blocked-working"), "blocked-zulu-flagged");
});

test("the ⌘-numbers count the Blocked group where it is drawn", () => {
  const slots = (placement: BlockedPlacement) =>
    [...assignCardShortcuts(order(placement).columns.map((c) => ids(c.sessions))).keys()];
  assert.deepEqual(slots("needs-you").slice(0, 5), ["ask-alpha", "blocked-asking", ...BLOCKED_ORDER]);
  assert.deepEqual(slots("column").slice(0, 6), ["ask-alpha", "blocked-asking", ...BLOCKED_ORDER, "blocked-working"]);
  const idle = slots("idle");
  assert.equal(idle.indexOf("blocked-zulu-flagged"), idle.indexOf("idle-charlie") - 3);
});

test("the rail draws the Blocked group after Needs you, or at the top of Idle", () => {
  const sections = (placement: BlockedPlacement) =>
    order(placement).columns.flatMap(fleetRailSections)
      .map((s) => (s.kind === "blocked" ? "blocked" : s.group.tone));
  assert.deepEqual(sections("needs-you"), ["attention", "blocked", "working", "idle", "neutral", "exited"]);
  assert.deepEqual(sections("column"), ["attention", "blocked", "working", "idle", "neutral", "exited"]);
  assert.deepEqual(sections("idle"), ["attention", "working", "blocked", "idle", "neutral", "exited"]);
  const none = order("needs-you", [plain("idle-only", IDLE)]).columns.flatMap(fleetRailSections);
  assert.equal(none.some((s) => s.kind === "blocked"), false);
});

test("a session no column holds still knows which column its drill-in becomes", () => {
  const blocked = plain("b", { ...IDLE, blocker: blocker() });
  assert.equal(fleetColumnOf(blocked, "idle", "needs-you"), "attention");
  assert.equal(fleetColumnOf(blocked, "idle", "idle"), "idle");
  assert.equal(fleetColumnOf(blocked, "idle", "column"), "blocked");
  assert.equal(fleetColumnOf(plain("w", { blocker: blocker() }), "working", "column"), "working");
  assert.equal(fleetColumnOf(plain("i", IDLE), "idle", "column"), "idle");
});

test("the Blocked summary helpers state the count and the oldest blocker's age", () => {
  const sessions = fleet().filter((s) => BLOCKED_ORDER.includes(s.id));
  assert.equal(oldestBlockerAge(sessions, NOW), "1d");
  assert.equal(blockedSummary(sessions, NOW), "3 blocked sessions, oldest 1d");
  assert.equal(blockedSummary(sessions.slice(0, 1), NOW), "1 blocked session, oldest 1h");
});

test("a folded Needs you strip carries both counts", () => {
  const html = renderToStaticMarkup(
    createElement(CollapsedColumnStrip, { label: "needs you", count: 2, blockedCount: 3, onRestore: () => {} }),
  );
  assert.match(html, /aria-label="Restore needs you, 2 cards, 3 blocked"/);
  assert.match(html, /board-col-strip-blocked[^>]*>3</);
  const plainStrip = renderToStaticMarkup(
    createElement(CollapsedColumnStrip, { label: "idle", count: 2, onRestore: () => {} }),
  );
  assert.doesNotMatch(plainStrip, /board-col-strip-blocked/);
});

test("the Display panel offers the three placements with In Needs you chosen", () => {
  const html = renderToStaticMarkup(createElement(BlockedPlacementPanel));
  assert.match(html, /<h3>Blocked sessions<\/h3>/);
  assert.match(html, /data-anchor="display\/blocked"/);
  for (const label of ["In Needs you", "At the top of Idle", "Own column"]) {
    assert.match(html, new RegExp(`aria-label="${label}"`));
  }
  assert.match(html, /aria-label="In Needs you"[^>]*checked=""[^>]*value="needs-you"/);
  assert.doesNotMatch(html, /aria-label="Own column"[^>]*checked=""/);
  assert.match(html, /always showing at least one card/);
});
