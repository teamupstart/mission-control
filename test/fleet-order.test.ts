// What is at stake: keyboard navigation and rendered order staying ONE fact.
//
// Three layouts render this ordering and two arrow-key index arrays are derived from it - the
// grid's flat list and the board's per-column ids. Clustering REORDERS tiles within a column
// (siblings were name-sorted apart before), so an ordering computed twice by two rules is Up/Down
// landing somewhere other than where the eye is, silently, with nothing failing. These assert the
// properties that make the two agree by construction: one function, idempotent, clusters
// contiguous, and never crossing the tone boundary that gives a board column its meaning.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Session } from "../src/shared/types.ts";
import { clusterFallbackLabel, fleetBlocks, orderSessions } from "../src/web/lib/fleet-order.ts";
import { TONE_GROUPS } from "../src/web/lib/tone.ts";
import { moveSelection } from "../src/web/lib/layoutNav.ts";
import { stateDisplay } from "../src/web/lib/format.ts";
import { mkMemberSession, mkSession } from "./helpers/session-fixture.ts";

const NO_GATES: ReadonlySet<string> = new Set();

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
const IDLE: Partial<Session> = { state: "idle", nomistakes: null, activity: null };

function names(sessions: readonly Session[]): string[] {
  return sessions.map((s) => s.name);
}

test("with no ensemble anywhere, the order is exactly the tone/name/pid sort it always was", () => {
  // The regression that would be invisible: clustering must cost an ordinary fleet nothing.
  const fleet = [plain("charlie"), plain("alpha", IDLE), plain("bravo")];
  const ordered = orderSessions(fleet, NO_GATES);
  assert.deepEqual(names(ordered.sessions), ["bravo", "charlie", "alpha"]);
  for (const group of ordered.groups) assert.deepEqual(group.clusters, []);
});

test("every tone group comes back, empty ones included, in TONE_GROUPS order", () => {
  // `groupByTone`'s contract, which App's board columns depend on: `moveSelection` indexes
  // columns positionally, so a dropped empty group is arrow keys crossing into the wrong one.
  const ordered = orderSessions([plain("only")], NO_GATES);
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
  const ordered = orderSessions(fleet, NO_GATES);
  assert.deepEqual(names(ordered.sessions), ["alpha", "november", "zulu", "mid"]);

  const working = ordered.groups.find((g) => g.tone === "working")!;
  assert.deepEqual(working.clusters, [{ runId: "run-a", startIndex: 0, length: 3 }]);
});

test("two runs in one column each cluster, without absorbing the other's members", () => {
  const fleet = [
    member("run-b", 1, "bravo"),
    member("run-a", 2, "delta"),
    member("run-b", 2, "echo"),
    member("run-a", 1, "alpha"),
  ];
  const ordered = orderSessions(fleet, NO_GATES);
  assert.deepEqual(names(ordered.sessions), ["alpha", "delta", "bravo", "echo"]);

  const working = ordered.groups.find((g) => g.tone === "working")!;
  assert.deepEqual(working.clusters, [
    { runId: "run-a", startIndex: 0, length: 2 },
    { runId: "run-b", startIndex: 2, length: 2 },
  ]);
});

test("a cluster never crosses a tone boundary: a blocked member stays in needs-you", () => {
  // The source plan wanted the cluster to live in the column of its worst tone. Revised: moving
  // two working siblings into "needs you" over one blocked member dilutes the column whose whole
  // job is "these are the things to act on". The blocked member sits there alone, with its
  // cluster header repeated, and the header's rollup is what ties the halves together.
  const blocked = member("run-a", 2, "beta", { pendingReviews: 1, state: "idle" });
  const fleet = [member("run-a", 1, "alpha"), blocked, member("run-a", 3, "gamma")];
  const ordered = orderSessions(fleet, NO_GATES);

  const attention = ordered.groups.find((g) => g.tone === "attention")!;
  const working = ordered.groups.find((g) => g.tone === "working")!;
  assert.deepEqual(names(attention.sessions), ["beta"]);
  assert.deepEqual(names(working.sessions), ["alpha", "gamma"]);
  // Both halves are clusters of the same run - the header renders in each column.
  assert.deepEqual(attention.clusters, [{ runId: "run-a", startIndex: 0, length: 1 }]);
  assert.deepEqual(working.clusters, [{ runId: "run-a", startIndex: 0, length: 2 }]);
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
    mkSession({ id: "gone", name: "ghost", pid: 9, state: "exited", terminals: [], nomistakes: null }),
  ];
  const ordered = orderSessions(fleet, NO_GATES);
  assert.deepEqual(
    names(ordered.sessions),
    ordered.groups.flatMap((g) => names(g.sessions)),
  );
  assert.equal(ordered.sessions.length, fleet.length);
  assert.deepEqual(new Set(ordered.sessions.map((s) => s.id)), new Set(fleet.map((s) => s.id)));
  // Every session lands in the group its own tone names.
  for (const group of ordered.groups) {
    for (const s of group.sessions) {
      assert.equal(stateDisplay(s, false).tone, group.tone, s.name);
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
  const once = orderSessions(fleet, NO_GATES);
  const twice = orderSessions(once.sessions, NO_GATES);
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
  const ordered = orderSessions(fleet, NO_GATES);
  const columns = ordered.groups.map((g) => g.sessions.map((s) => s.id));
  const rendered = ordered.groups.map((g) =>
    fleetBlocks(g).flatMap((b) => (b.kind === "session" ? [b.session.id] : b.sessions.map((s) => s.id))),
  );
  assert.deepEqual(rendered, columns);
});

test("fleetBlocks frames exactly the span, and a lone sibling still gets one", () => {
  const fleet = [plain("aaa"), member("run-a", 1, "bbb"), plain("ccc")];
  const blocks = fleetBlocks(orderSessions(fleet, NO_GATES).groups.find((g) => g.tone === "working")!);
  assert.deepEqual(
    blocks.map((b) => (b.kind === "session" ? b.session.name : `cluster:${b.runId}`)),
    ["aaa", "cluster:run-a", "ccc"],
  );
  // A single-member cluster keeps its frame: it may be the only member of its run in THIS
  // column (the tone-boundary rule), and the header is precisely what says so.
  const lone = blocks.find((b) => b.kind === "cluster");
  assert.ok(lone && lone.kind === "cluster" && lone.sessions.length === 1);
});

test("a gate parked on an idle session moves it, and its cluster, with it", () => {
  // `gateAlerts` is App's cross-session derivation and it changes a session's TONE. The ordering
  // has to consult it, or a session the board draws in "needs you" would be indexed under "idle".
  const gated = member("run-a", 1, "alpha", IDLE);
  const ordered = orderSessions([gated, plain("zulu")], new Set([gated.id]));
  const attention = ordered.groups.find((g) => g.tone === "attention")!;
  assert.deepEqual(names(attention.sessions), ["alpha"]);
  assert.deepEqual(attention.clusters, [{ runId: "run-a", startIndex: 0, length: 1 }]);
});

test("the arrow keys walk straight through a cluster boundary, in both layouts", () => {
  // The end all of the above is for. Clustering is the first thing that reorders tiles WITHIN a
  // column, so this composes the real ordering with the real `moveSelection` and walks the
  // sequence a finger would: down the board column across the frame's edges, and along the flat
  // grid list. A frame that changed the rendered order without changing these arrays would land
  // the cursor on a different tile than the eye.
  const fleet = [
    plain("aaa"),
    member("run-a", 2, "delta"),
    plain("zulu"),
    member("run-a", 1, "mmm"),
  ];
  const ordered = orderSessions(fleet, NO_GATES);
  const working = ordered.groups.find((g) => g.tone === "working")!;
  assert.deepEqual(names(working.sessions), ["aaa", "mmm", "delta", "zulu"]);

  const columns = ordered.groups.map((g) => g.sessions.map((s) => s.id));
  const ids = ordered.sessions.map((s) => s.id);
  const byName = new Map(ordered.sessions.map((s) => [s.name, s.id]));
  const walk = (mode: "board" | "grid", key: "ArrowDown" | "ArrowRight"): string[] => {
    const seen: string[] = [];
    let at: string | null = byName.get("aaa")!;
    while (at) {
      seen.push(ordered.sessions.find((s) => s.id === at)!.name);
      at = moveSelection({ mode, key, ids, currentId: at, cols: 1, columns });
    }
    return seen;
  };
  // Into the frame at `mmm`, out of it at `zulu` - no row skipped, none visited twice.
  assert.deepEqual(walk("board", "ArrowDown"), ["aaa", "mmm", "delta", "zulu"]);
  assert.deepEqual(walk("grid", "ArrowRight"), ["aaa", "mmm", "delta", "zulu"]);
});

test("a cluster falls back to the member link's strategy label before its summary lands", () => {
  // A cluster exists the moment two sibling sessions do, which can be a tick ahead of the run's
  // SSE summary. Waiting for it would flicker a frame in and out around tiles that never moved.
  assert.equal(clusterFallbackLabel(member("run-a", 1, "alpha")), "Best of N");
  assert.equal(clusterFallbackLabel(plain("ordinary")), "Ensemble");
});
