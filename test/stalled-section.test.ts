// What is at stake: with the `idle-stalled` preview on, every stall is drawn in exactly one place.
// An idle stall is a card in Idle's Stalled section and is not an inbox row; every other stall is
// still a Stuck row. A helper that let an idle stall through to both, or to neither, would show
// one problem twice or lose it, and a dismissal keyed differently on the two surfaces would bring a
// dismissed stall back when the flag is switched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isIdleStall, type Stall } from "../src/shared/stall.ts";
import { inboxStalls, NO_STALLED_DRAWN, NO_STALLED_SESSIONS, stalledSessions } from "../src/web/lib/stalled.ts";
import { orderSessions, stalledInOrder } from "../src/web/lib/fleet-order.ts";
import { attentionDismissalKeys, foldAttention, stallDismissalKey } from "../src/web/lib/attention.ts";
import type { Session } from "../src/shared/types.ts";
import { mkSession } from "./helpers/session-fixture.ts";

function stall(sessionId: string, kind: Stall["kind"], fingerprint = `${kind}-${sessionId}`): Stall {
  return { sessionId, kind, forMs: 30 * 60_000, reason: `stall ${kind}`, fingerprint };
}

const IDLE_WORK = stall("s-idle", "unfinished-work");
const PARKED = stall("s-parked", "workflow-parked");
const SILENT = stall("s-silent", "silent-working");
const ESCALATED = stall("s-escalated", "escalated");
const ALL = [IDLE_WORK, PARKED, SILENT, ESCALATED];

test("only the two idle rules are idle stalls", () => {
  assert.deepEqual(ALL.filter(isIdleStall), [IDLE_WORK, PARKED]);
});

/** What App does: order the fleet with the stalls, then drop from the inbox only what Idle drew. */
function drawnBy(sessions: Session[], stalls: readonly Stall[], pinned: ReadonlySet<string> = new Set()) {
  const order = orderSessions(
    sessions, new Set(), false, undefined, undefined, pinned, undefined, undefined,
    stalledSessions(stalls, true, new Map()),
  );
  return stalledInOrder(order.groups);
}

const idleSession = (id: string) => mkSession({ id, name: id, state: "idle", activity: null });

test("flag on: Idle draws the idle stalls and the inbox keeps only the others", () => {
  assert.deepEqual([...stalledSessions(ALL, true, new Map()).keys()], ["s-idle", "s-parked"]);
  const sessions = ["s-idle", "s-parked", "s-silent", "s-escalated"].map(idleSession);
  const drawn = drawnBy(sessions, ALL);
  assert.deepEqual([...drawn].sort(), ["s-idle", "s-parked"]);
  assert.deepEqual(inboxStalls(ALL, drawn), [SILENT, ESCALATED]);
});

test("a pinned resident's idle stall is a Stalled card and leaves the inbox", () => {
  // The stall outranks the pin, so the pinned session is drawn under the Stalled rule and its
  // Stuck row goes, like any other idle stall.
  const sessions = [idleSession("s-idle"), idleSession("s-parked")];
  const drawn = drawnBy(sessions, ALL, new Set(["s-idle"]));
  assert.deepEqual([...drawn].sort(), ["s-idle", "s-parked"]);
  assert.deepEqual(inboxStalls(ALL, drawn), [SILENT, ESCALATED]);
});

test("an idle stall on a session the fleet does not hold keeps its Stuck row", () => {
  // A resident in the residents drawer is not on the fleet, so Idle cannot draw it: its stall stays
  // an inbox row rather than being shown nowhere.
  const onlyParked = drawnBy([idleSession("s-parked")], ALL);
  assert.deepEqual(inboxStalls(ALL, onlyParked), [IDLE_WORK, SILENT, ESCALATED]);
});

test("flag off: Idle draws nothing and the inbox keeps every stall, the same array", () => {
  assert.equal(stalledSessions(ALL, false, new Map()), NO_STALLED_SESSIONS);
  assert.equal(inboxStalls(ALL, NO_STALLED_DRAWN), ALL);
  // Nothing drawn among these: the inbox's input is handed back untouched.
  const others = [SILENT, ESCALATED];
  assert.equal(inboxStalls(others, new Set(["s-idle"])), others);
});

test("a dismissed stall leaves the section until its facts change", () => {
  const key = stallDismissalKey(IDLE_WORK.sessionId, IDLE_WORK);
  const dismissed = new Map([[key.itemId, key.occurrence]]);
  assert.deepEqual([...stalledSessions(ALL, true, dismissed).keys()], ["s-parked"]);
  // New facts on the same session are a new stall, drawn again.
  const moved = { ...IDLE_WORK, fingerprint: "a different open task" };
  assert.deepEqual([...stalledSessions([moved], true, dismissed).keys()], ["s-idle"]);
  // Dismissals not read yet hide nothing.
  assert.deepEqual([...stalledSessions(ALL, true, null).keys()], ["s-idle", "s-parked"]);
  assert.equal(stalledSessions(undefined, true, null), NO_STALLED_SESSIONS);
});

test("a card and an inbox row dismiss a stall under one key", () => {
  // Folded as a Stuck row (flag off), the row's dismissal key is the card's.
  const session = mkSession({ id: IDLE_WORK.sessionId, name: "amber-lynx", state: "idle" });
  const fold = foldAttention({ sessions: [session], reviews: [], ensembles: [], stalls: [IDLE_WORK] });
  const row = fold.items.find((item) => item.kind === "session_stuck");
  assert.ok(row, "the idle stall is a Stuck row with the flag off");
  assert.deepEqual(attentionDismissalKeys(row), [stallDismissalKey(session.id, IDLE_WORK)]);
});

test("with the preview on, Silent while working and an unanswered escalation stay Stuck rows", () => {
  // The inbox fold as App builds it: the stalls minus the ones Idle drew. A silent-working session
  // is in Working and an escalation is a decision for a person, so neither is drawn in Idle, and
  // both keep their rows; the two idle stalls are cards in Idle and are not rows.
  const sessions = [
    idleSession("s-idle"),
    idleSession("s-parked"),
    mkSession({ id: "s-silent", name: "s-silent", state: "working" }),
    idleSession("s-escalated"),
  ];
  const drawn = drawnBy(sessions, ALL);
  const fold = foldAttention({ sessions, reviews: [], ensembles: [], stalls: inboxStalls(ALL, drawn) });
  const stuck = fold.items.filter((item) => item.kind === "session_stuck");
  assert.deepEqual(
    stuck.map((item) => (item.kind === "session_stuck" ? `${item.session.id}:${item.stall.kind}` : "")).sort(),
    ["s-escalated:escalated", "s-silent:silent-working"],
  );
});
