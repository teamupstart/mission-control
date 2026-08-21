// What is at stake: keyboard navigation and rendered order staying ONE fact.
//
// Both layouts render this ordering and two arrow-key index arrays are derived from it - the
// Console rail's flat list and the Board's per-column ids. Clustering REORDERS tiles within a column
// (siblings were name-sorted apart before), so an ordering computed twice by two rules is Up/Down
// landing somewhere other than where the eye is, silently, with nothing failing. These assert the
// properties that make the two agree by construction: one function, idempotent, clusters
// contiguous, and never crossing the tone boundary that gives a board column its meaning.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Session } from "../src/shared/types.ts";
import {
  clusterFallbackLabel,
  fleetBlocks,
  fleetRows,
  orderSessions,
} from "../src/web/lib/fleet-order.ts";
import { TONE_GROUPS } from "../src/web/lib/tone.ts";
import { moveSelection } from "../src/web/lib/layoutNav.ts";
import { stateDisplay } from "../src/web/lib/format.ts";
import { mkMemberSession, mkSession } from "./helpers/session-fixture.ts";

/** A plain working session, named so the alphabetical baseline is easy to reason about. */
function plain(name: string, over: Partial<Session> = {}): Session {
  return mkSession({ id: `plain-${name}`, name, pid: 1, ...over });
}

/** A member of `runId`, named so it would sort AWAY from its siblings without clustering. */
function member(runId: string, ordinal: number, name: string, over: Partial<Session> = {}): Session {
  return mkMemberSession({
    id: `${runId}-${ordinal}`,
    name,
    ...over,
    link: { runId, ordinal, memberId: `${runId}-m${ordinal}`, maxMembers: 3 },
  });
}

/** An idle session: a different tone group from the working default. */
const IDLE: Partial<Session> = { state: "idle", activity: null };

function names(sessions: readonly Session[]): string[] {
  return sessions.map((s) => s.name);
}

test("with no ensemble anywhere, the order is exactly the tone/name/pid sort it always was", () => {
  // The regression that would be invisible: clustering must cost an ordinary fleet nothing.
  const fleet = [plain("charlie"), plain("alpha", IDLE), plain("bravo")];
  const ordered = orderSessions(fleet);
  assert.deepEqual(names(ordered.sessions), ["bravo", "charlie", "alpha"]);
  for (const group of ordered.groups) assert.deepEqual(group.clusters, []);
});

test("every tone group comes back, empty ones included, in TONE_GROUPS order", () => {
  // `groupByTone`'s contract, which App's board columns depend on: `moveSelection` indexes
  // columns positionally, so a dropped empty group is arrow keys crossing into the wrong one.
  const ordered = orderSessions([plain("only")]);
  assert.deepEqual(
    ordered.groups.map((g) => g.tone),
    TONE_GROUPS.map((g) => g.tone),
  );
  assert.equal(ordered.groups.length, TONE_GROUPS.length);
});

test("siblings of one run come out adjacent, in ordinal order, where the first of them sat", () => {
  // Without clustering these interleave with the plain sessions alphabetically:
  //   alpha, mid, zulu-1... - here the run gathers at `alpha`'s position, ordinals ascending.
  const fleet = [
    member("run-a", 3, "zulu"),
    plain("mid"),
    member("run-a", 1, "alpha"),
    member("run-a", 2, "november"),
  ];
  const ordered = orderSessions(fleet);
  assert.deepEqual(names(ordered.sessions), ["alpha", "november", "zulu", "mid"]);

  const working = ordered.groups.find((g) => g.tone === "working")!;
  assert.deepEqual(working.clusters, [{ kind: "ensemble", runId: "run-a", startIndex: 0, length: 3 }]);
});

test("two runs in one column each cluster, without absorbing the other's members", () => {
  const fleet = [
    member("run-b", 1, "bravo"),
    member("run-a", 2, "delta"),
    member("run-b", 2, "echo"),
    member("run-a", 1, "alpha"),
  ];
  const ordered = orderSessions(fleet);
  assert.deepEqual(names(ordered.sessions), ["alpha", "delta", "bravo", "echo"]);

  const working = ordered.groups.find((g) => g.tone === "working")!;
  assert.deepEqual(working.clusters, [
    { kind: "ensemble", runId: "run-a", startIndex: 0, length: 2 },
    { kind: "ensemble", runId: "run-b", startIndex: 2, length: 2 },
  ]);
});

test("a cluster never crosses a tone boundary: a blocked member stays in needs-you", () => {
  // The source plan wanted the cluster to live in the column of its worst tone. Revised: moving
  // two working siblings into "needs you" over one blocked member dilutes the column whose whole
  // job is "these are the things to act on". The blocked member sits there alone, with its
  // cluster header repeated, and the header's rollup is what ties the halves together.
  const blocked = member("run-a", 2, "beta", { pendingReviews: 1, state: "idle" });
  const fleet = [member("run-a", 1, "alpha"), blocked, member("run-a", 3, "gamma")];
  const ordered = orderSessions(fleet);

  const attention = ordered.groups.find((g) => g.tone === "attention")!;
  const working = ordered.groups.find((g) => g.tone === "working")!;
  assert.deepEqual(names(attention.sessions), ["beta"]);
  assert.deepEqual(names(working.sessions), ["alpha", "gamma"]);
  // Both halves are clusters of the same run - the header renders in each column.
  assert.deepEqual(attention.clusters, [{ kind: "ensemble", runId: "run-a", startIndex: 0, length: 1 }]);
  assert.deepEqual(working.clusters, [{ kind: "ensemble", runId: "run-a", startIndex: 0, length: 2 }]);
  // And the tone ranking still decides which comes first overall.
  assert.deepEqual(names(ordered.sessions), ["beta", "alpha", "gamma"]);
});

test("the flat order is exactly the groups concatenated, and loses nobody", () => {
  // The board reads `groups`, the grid and console read `sessions`. If those two ever disagreed
  // about membership, a session would be arrow-key reachable in one layout and not the other.
  const fleet = [
    member("run-a", 2, "delta"),
    plain("mid", IDLE),
    member("run-a", 1, "alpha"),
    plain("zulu"),
    mkSession({ id: "gone", name: "ghost", pid: 9, state: "exited", terminals: [] }),
  ];
  const ordered = orderSessions(fleet);
  assert.deepEqual(
    names(ordered.sessions),
    ordered.groups.flatMap((g) => names(g.sessions)),
  );
  assert.equal(ordered.sessions.length, fleet.length);
  assert.deepEqual(new Set(ordered.sessions.map((s) => s.id)), new Set(fleet.map((s) => s.id)));
  // Every session lands in the group its own tone names.
  for (const group of ordered.groups) {
    for (const s of group.sessions) {
      assert.equal(stateDisplay(s).tone, group.tone, s.name);
    }
  }
});

test("ordering is idempotent, which is what lets App and the views each compute it", () => {
  // BoardView and ConsoleView call `orderSessions` on the list App already ordered rather than
  // being handed a pre-split structure - the same arrangement `groupByTone` had. That is only
  // safe because a second pass is a no-op.
  const fleet = [
    member("run-b", 2, "echo"),
    plain("mid"),
    member("run-a", 1, "alpha", IDLE),
    member("run-b", 1, "bravo"),
    member("run-a", 2, "zulu", IDLE),
  ];
  const once = orderSessions(fleet);
  const twice = orderSessions(once.sessions);
  assert.deepEqual(names(twice.sessions), names(once.sessions));
  assert.deepEqual(
    twice.groups.map((g) => g.clusters),
    once.groups.map((g) => g.clusters),
  );
});

test("board column id arrays derived from the order match the rendered sequence", () => {
  // App builds `boardColumns` off `fleet.groups`; BoardView renders `fleetBlocks(group)`. This is
  // the pair `moveOnBoard` indexes against - assert they are the same sequence, not merely the
  // same set.
  const fleet = [
    member("run-a", 2, "delta"),
    plain("zulu"),
    member("run-a", 1, "alpha"),
    plain("mid", IDLE),
  ];
  const ordered = orderSessions(fleet);
  const columns = ordered.groups.map((g) => g.sessions.map((s) => s.id));
  const rendered = ordered.groups.map((g) =>
    fleetBlocks(g).flatMap((b) => (b.kind === "session" ? [b.session.id] : b.sessions.map((s) => s.id))),
  );
  assert.deepEqual(rendered, columns);
});

test("fleetBlocks frames exactly the span, and a lone sibling still gets one", () => {
  const fleet = [plain("aaa"), member("run-a", 1, "bbb"), plain("ccc")];
  const blocks = fleetBlocks(orderSessions(fleet).groups.find((g) => g.tone === "working")!);
  assert.deepEqual(
    blocks.map((b) => (b.kind === "session" ? b.session.name : `cluster:${b.runId}`)),
    ["aaa", "cluster:run-a", "ccc"],
  );
  // A single-member cluster keeps its frame: it may be the only member of its run in THIS
  // column (the tone-boundary rule), and the header is precisely what says so.
  const lone = blocks.find((b) => b.kind === "cluster");
  assert.ok(lone && lone.kind === "cluster" && lone.sessions.length === 1);
});

test("the arrow keys walk straight through a cluster boundary, in both layouts", () => {
  // The end all of the above is for. Clustering is the first thing that reorders tiles WITHIN a
  // column, so this composes the real ordering with the real `moveSelection` and walks the
  // sequence a finger would: down the board column and Console rail across the frame's edges.
  // A frame that changed the rendered order without changing these arrays would land
  // the cursor on a different tile than the eye.
  const fleet = [
    plain("aaa"),
    member("run-a", 2, "delta"),
    plain("zulu"),
    member("run-a", 1, "mmm"),
  ];
  const ordered = orderSessions(fleet);
  const working = ordered.groups.find((g) => g.tone === "working")!;
  assert.deepEqual(names(working.sessions), ["aaa", "mmm", "delta", "zulu"]);

  const columns = ordered.groups.map((g) => g.sessions.map((s) => s.id));
  const ids = ordered.sessions.map((s) => s.id);
  const byName = new Map(ordered.sessions.map((s) => [s.name, s.id]));
  const walk = (mode: "board" | "console"): string[] => {
    const seen: string[] = [];
    let at: string | null = byName.get("aaa")!;
    while (at) {
      seen.push(ordered.sessions.find((s) => s.id === at)!.name);
      at = moveSelection({ mode, key: "ArrowDown", ids, currentId: at, columns });
    }
    return seen;
  };
  // Into the frame at `mmm`, out of it at `zulu` - no row skipped, none visited twice.
  assert.deepEqual(walk("board"), ["aaa", "mmm", "delta", "zulu"]);
  assert.deepEqual(walk("console"), ["aaa", "mmm", "delta", "zulu"]);
});

test("a cluster falls back to the member link's strategy label before its summary lands", () => {
  // A cluster exists the moment two sibling sessions do, which can be a tick ahead of the run's
  // SSE summary. Waiting for it would flicker a frame in and out around tiles that never moved.
  assert.equal(clusterFallbackLabel(member("run-a", 1, "alpha")), "Best of N");
  assert.equal(clusterFallbackLabel(plain("ordinary")), "Ensemble");
});

// ---- held by an open workflow run ----
//
// What is at stake here is the same "one fact" property as above, plus a second one. The board
// draws a section rule at `heldFrom` and the arrow keys walk `group.sessions`; if the partition
// and the clustering disagree about where the boundary is, the rule lands in the wrong place or
// a frame swallows it. And because the partition is what makes "N free" honest, a held session
// that leaks into the free count is a dispatch decision made against a number that is wrong.

test("held sessions sort last within idle, and the boundary says where they start", () => {
  const fleet = [
    plain("alpha", IDLE),
    plain("bravo", IDLE),
    plain("charlie", IDLE),
  ];
  const ordered = orderSessions(fleet, new Set(["plain-alpha"]));
  const idle = ordered.groups.find((g) => g.tone === "idle")!;
  // `alpha` sorts first alphabetically and is demoted below both free ones.
  assert.deepEqual(names(idle.sessions), ["bravo", "charlie", "alpha"]);
  assert.equal(idle.heldFrom, 2);
});

test("only idle partitions: a held session that needs you is not demoted", () => {
  // The rule that keeps "needs you" worth reading. A held session parked on a question is the
  // most actionable row on the board; sorting it under a rule that says the run will handle it
  // would bury the one thing that will not resolve on its own.
  const fleet = [
    plain("alpha", { state: "awaiting_input", stateConfirmed: true }),
    plain("bravo", { state: "awaiting_input", stateConfirmed: true }),
  ];
  const ordered = orderSessions(fleet, new Set(["plain-alpha"]));
  const attention = ordered.groups.find((g) => g.tone === "attention")!;
  assert.deepEqual(names(attention.sessions), ["alpha", "bravo"]);
  assert.equal(attention.heldFrom, null);
});

test("a group with nothing held has a null boundary, not a zero one", () => {
  // `heldFrom === 0` is a real value meaning "every session here is held", so the empty case
  // has to be distinguishable from it - a view keying on falsiness would draw a held rule over
  // a column where nothing is held.
  const ordered = orderSessions([plain("alpha", IDLE)], new Set());
  assert.equal(ordered.groups.find((g) => g.tone === "idle")!.heldFrom, null);

  const allHeld = orderSessions([plain("alpha", IDLE)], new Set(["plain-alpha"]));
  assert.equal(allHeld.groups.find((g) => g.tone === "idle")!.heldFrom, 0);
});

test("a cluster never straddles the free/held boundary", () => {
  // The property `fleetRows` depends on: it counts sessions while walking BLOCKS, so it can
  // only place the rule if the boundary falls between two blocks. Partitioning before
  // clustering is what guarantees that; clustering first would bucket these two members into
  // one span anchored at the free one, and the rule would land inside a frame or be lost.
  const fleet = [
    member("run-a", 1, "alpha", IDLE),
    member("run-a", 2, "bravo", IDLE),
    plain("charlie", IDLE),
  ];
  const ordered = orderSessions(fleet, new Set(["run-a-2"]));
  const idle = ordered.groups.find((g) => g.tone === "idle")!;
  assert.deepEqual(names(idle.sessions), ["alpha", "charlie", "bravo"]);
  assert.equal(idle.heldFrom, 2);
  // Two frames for the one run, one either side - the tone-boundary rule's shape.
  assert.deepEqual(idle.clusters, [
    { kind: "ensemble", runId: "run-a", startIndex: 0, length: 1 },
    { kind: "ensemble", runId: "run-a", startIndex: 2, length: 1 },
  ]);
  // Every cluster lies wholly on one side of the boundary.
  for (const c of idle.clusters) {
    const endsBefore = c.startIndex + c.length <= idle.heldFrom!;
    const startsAfter = c.startIndex >= idle.heldFrom!;
    assert.ok(endsBefore || startsAfter, `cluster ${c.runId} straddles the boundary`);
  }
  // And the two frames of the one run carry DISTINCT render keys. `runId` alone is not a
  // key here: both sides of the split share it, React would match one fiber and remount or
  // misassign the other's header and disclosure state.
  const clusterBlocks = fleetBlocks(idle).filter((b) => b.kind === "cluster");
  assert.equal(clusterBlocks.length, 2);
  const keys = clusterBlocks.map((b) => (b as { key: string }).key);
  assert.notEqual(keys[0], keys[1]);
  for (const key of keys) assert.match(key, /^cluster-ensemble-run-a-/);
});

test("fleetRows places both rules, and the walk lands exactly on the boundary", () => {
  const fleet = [plain("alpha", IDLE), plain("bravo", IDLE), plain("charlie", IDLE)];
  const ordered = orderSessions(fleet, new Set(["plain-alpha", "plain-charlie"]));
  const idle = ordered.groups.find((g) => g.tone === "idle")!;
  assert.deepEqual(
    fleetRows(idle).map((r) => (r.kind === "section" ? `--${r.section}:${r.count}` : r.kind === "session" ? r.session.name : "cluster")),
    ["--free:1", "bravo", "--held:2", "alpha", "charlie"],
  );
});

test("fleetRows draws only the held rule when every session in the column is held", () => {
  // A "free 0" heading over an empty free side would be labelling nothing.
  const ordered = orderSessions([plain("alpha", IDLE)], new Set(["plain-alpha"]));
  const idle = ordered.groups.find((g) => g.tone === "idle")!;
  assert.deepEqual(
    fleetRows(idle).map((r) => (r.kind === "section" ? `--${r.section}` : "row")),
    ["--held", "row"],
  );
});

test("fleetRows adds nothing to a group with nothing held", () => {
  const ordered = orderSessions([plain("alpha", IDLE), plain("bravo")], new Set());
  for (const g of ordered.groups) {
    assert.deepEqual(fleetRows(g), fleetBlocks(g));
  }
});

test("the partition is idempotent, so App and the views cannot disagree", () => {
  // Same contract the cluster pass has: BoardView and ConsoleView re-run `orderSessions` on the
  // list App already ordered, and must pass the same held set to get the same answer.
  const fleet = [plain("alpha", IDLE), plain("bravo", IDLE), plain("charlie", IDLE)];
  const held = new Set(["plain-alpha"]);
  const once = orderSessions(fleet, held);
  const twice = orderSessions(once.sessions, held);
  assert.deepEqual(names(twice.sessions), names(once.sessions));
  assert.deepEqual(
    twice.groups.map((g) => g.heldFrom),
    once.groups.map((g) => g.heldFrom),
  );
});

test("board column arrays still match the rendered sequence with a boundary in play", () => {
  // The whole point of putting the partition in `orderSessions` rather than in the view: the
  // arrow keys walk `group.sessions`, and the rule is drawn from the same list.
  const fleet = [plain("alpha", IDLE), plain("bravo", IDLE), plain("charlie", IDLE)];
  const ordered = orderSessions(fleet, new Set(["plain-bravo"]));
  const idle = ordered.groups.find((g) => g.tone === "idle")!;
  const rendered = fleetRows(idle).flatMap((r) =>
    r.kind === "section" ? [] : r.kind === "session" ? [r.session.id] : r.sessions.map((s) => s.id),
  );
  assert.deepEqual(rendered, idle.sessions.map((s) => s.id));
});
