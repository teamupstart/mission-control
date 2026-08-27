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
  repoSessionTotals,
  type FleetRow,
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

/**
 * Every session id a row expansion would DRAW, in order, whatever nesting it arrived in.
 *
 * The one assertion that has to hold for the arrow keys: `group.sessions` is what
 * `moveSelection` indexes, and this is what the eye sees. A repository row nests its blocks, so
 * flattening has to recurse - a version that only handled the two flat kinds would silently
 * report an empty list for a grouped column and pass by comparing nothing to nothing.
 */
function renderedIds(rows: readonly FleetRow[]): string[] {
  return rows.flatMap((row) => {
    if (row.kind === "section") return [];
    if (row.kind === "repo") return renderedIds(row.blocks);
    return row.kind === "session" ? [row.session.id] : row.sessions.map((s) => s.id);
  });
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
  const rendered = renderedIds(fleetRows(idle));
  assert.deepEqual(rendered, idle.sessions.map((s) => s.id));
});

// ---- repository grouping ----
//
// What is at stake is the same thing the clustering tests above defend, one level out: the
// partition happens in `orderSessions` precisely so the arrow keys and the rendered frames come
// from one list. It is also the first thing in this file that is OPTIONAL, so "off is
// byte-identical to before" is a property in its own right.

const REPO_A = "/work/alpha-repo";
const REPO_B = "/work/bravo-repo";

/** A session in a repository, otherwise exactly `plain`. */
function inRepo(name: string, repoRoot: string | null, over: Partial<Session> = {}): Session {
  return plain(name, { repoRoot, ...over });
}

test("with grouping off, a fleet full of repositories comes out exactly as before", () => {
  // The regression that would be invisible to everyone who never opens the setting: the
  // partition must cost an ungrouped fleet nothing at all, spans included.
  const fleet = [
    inRepo("charlie", REPO_B),
    inRepo("alpha", REPO_A),
    inRepo("bravo", REPO_B),
    inRepo("delta", null),
  ];
  const off = orderSessions(fleet);
  assert.deepEqual(names(off.sessions), ["alpha", "bravo", "charlie", "delta"]);
  for (const group of off.groups) assert.deepEqual(group.repos, []);
  // And `fleetRows` adds nothing, which is what keeps every existing rendering test honest.
  for (const group of off.groups) assert.deepEqual(fleetRows(group), fleetBlocks(group));
});

test("grouping pulls a repository's sessions together, anchored where its first member sat", () => {
  // `charlie` moves up to sit under `alpha`; `bravo` keeps its relative place behind them. The
  // smallest move that groups them, which is the rule `clusterPartition` already follows.
  const fleet = [inRepo("alpha", REPO_A), inRepo("bravo", REPO_B), inRepo("charlie", REPO_A)];
  const on = orderSessions(fleet, new Set(), true);
  assert.deepEqual(names(on.sessions), ["alpha", "charlie", "bravo"]);
  const working = on.groups.find((g) => g.tone === "working")!;
  assert.deepEqual(working.repos, [
    { repoRoot: REPO_A, startIndex: 0, length: 2 },
    { repoRoot: REPO_B, startIndex: 2, length: 1 },
  ]);
});

test("a session in no repository sorts after every repository and gets no span", () => {
  // It has no repository to be grouped under, and an "(none)" frame would be a box around the
  // one thing these sessions have in common, which is nothing.
  const fleet = [inRepo("alpha", null), inRepo("bravo", REPO_A), inRepo("charlie", null)];
  const on = orderSessions(fleet, new Set(), true);
  assert.deepEqual(names(on.sessions), ["bravo", "alpha", "charlie"]);
  const working = on.groups.find((g) => g.tone === "working")!;
  assert.deepEqual(working.repos, [{ repoRoot: REPO_A, startIndex: 0, length: 1 }]);
  // And they render as loose rows rather than inside a frame.
  assert.deepEqual(
    fleetRows(working).map((r) => r.kind),
    ["repo", "session", "session"],
  );
});

test("a repository never crosses a tone column", () => {
  // The rule the run clusters already obey, inherited: a blocked session stays in "needs you"
  // rather than dragging its working siblings out of the column that says what they are.
  const fleet = [
    inRepo("alpha", REPO_A),
    inRepo("bravo", REPO_A, { state: "awaiting_input", activity: null }),
    inRepo("charlie", REPO_A, IDLE),
  ];
  const on = orderSessions(fleet, new Set(), true);
  for (const group of on.groups) {
    if (group.sessions.length === 0) continue;
    assert.equal(group.repos.length, 1, "each column frames its own slice exactly once");
    assert.equal(group.repos[0]!.length, group.sessions.length);
  }
  // Three columns, so three frames for one repository - and each says which part it is.
  assert.equal(on.groups.flatMap((g) => g.repos).length, 3);
});

test("a repository never crosses the free/held boundary either", () => {
  // The same reason: a span straddling the boundary would swallow the section rule, exactly as
  // a run cluster would. So one repository is framed once per SIDE.
  const fleet = [inRepo("alpha", REPO_A, IDLE), inRepo("bravo", REPO_A, IDLE)];
  const on = orderSessions(fleet, new Set(["plain-bravo"]), true);
  const idle = on.groups.find((g) => g.tone === "idle")!;
  assert.equal(idle.heldFrom, 1);
  assert.deepEqual(idle.repos, [
    { repoRoot: REPO_A, startIndex: 0, length: 1 },
    { repoRoot: REPO_A, startIndex: 1, length: 1 },
  ]);
  // The rules land between the two frames, not inside either of them.
  assert.deepEqual(
    fleetRows(idle).map((r) => (r.kind === "section" ? "--" + r.section : r.kind)),
    ["--free", "repo", "--held", "repo"],
  );
});

test("two frames for one repository in one column do not share a key", () => {
  // React would match one fiber and hand the other its collapse state, so folding the free half
  // would fold the held half with it.
  const fleet = [inRepo("alpha", REPO_A, IDLE), inRepo("bravo", REPO_A, IDLE)];
  const on = orderSessions(fleet, new Set(["plain-bravo"]), true);
  const idle = on.groups.find((g) => g.tone === "idle")!;
  const keys = fleetRows(idle).flatMap((r) => (r.kind === "repo" ? [r.key] : []));
  assert.equal(keys.length, 2);
  assert.equal(new Set(keys).size, 2);
});

test("a run cluster sits wholly inside one repository frame", () => {
  // The nesting the whole design rests on: an ensemble's members share a repository, so the
  // repository partition can never split a run. If it could, `fleetRows` would step past a
  // span's end and orphan a block.
  const fleet = [
    inRepo("zulu", REPO_B),
    member("run-a", 2, "yankee", { repoRoot: REPO_A }),
    member("run-a", 1, "xray", { repoRoot: REPO_A }),
  ];
  const on = orderSessions(fleet, new Set(), true);
  const working = on.groups.find((g) => g.tone === "working")!;
  const repoRows = fleetRows(working).flatMap((r) => (r.kind === "repo" ? [r] : []));
  assert.equal(repoRows.length, 2);
  const withRun = repoRows.find((r) => r.repoRoot === REPO_A)!;
  assert.deepEqual(
    withRun.blocks.map((b) => b.kind),
    ["cluster"],
  );
  // Ordinal order survives inside the frame, which is the run's own vocabulary.
  assert.deepEqual(
    withRun.blocks.flatMap((b) => (b.kind === "cluster" ? names(b.sessions) : [])),
    ["xray", "yankee"],
  );
});

test("a run whose members somehow span two repositories degrades into one frame each", () => {
  // The edge the partition ORDER creates, pinned so a reader does not have to work out what it
  // does. Repositories partition before the run clustering, so members in different
  // repositories cannot share a frame - and that is the right answer rather than a loss: one
  // frame cannot be inside two repositories, and this is the same shape the tone-boundary and
  // free/held splits already produce, which is one frame per side with the header's own rollup
  // tying them together.
  //
  // It should not arise in the product - an ensemble's candidates are dispatched into worktrees
  // of ONE repository, and `repoRoot` names the main checkout rather than the worktree, so its
  // members agree. What matters is that if it ever did, nothing orphans a block or throws.
  const fleet = [
    member("run-a", 1, "alpha", { repoRoot: REPO_A }),
    member("run-a", 2, "bravo", { repoRoot: REPO_B }),
  ];
  const on = orderSessions(fleet, new Set(), true);
  const working = on.groups.find((g) => g.tone === "working")!;
  const rows = fleetRows(working);
  assert.deepEqual(
    rows.map((r) => r.kind),
    ["repo", "repo"],
  );
  // Every session still rendered exactly once, in the order the arrow keys walk.
  assert.deepEqual(renderedIds(rows), working.sessions.map((s) => s.id));
  // And each frame holds its own single-member cluster rather than a bare session.
  for (const row of rows) {
    assert.equal(row.kind, "repo");
    if (row.kind !== "repo") continue;
    assert.deepEqual(row.blocks.map((b) => b.kind), ["cluster"]);
  }
});

test("grouping is still idempotent, so the three call sites cannot disagree", () => {
  // App orders once; BoardView and ConsoleView re-run this on the list they were handed. All
  // three pass `byRepo` from the same store, so re-running must be a no-op.
  const fleet = [
    inRepo("charlie", REPO_B, IDLE),
    inRepo("alpha", REPO_A),
    inRepo("bravo", REPO_B),
    inRepo("delta", null, IDLE),
  ];
  const held = new Set(["plain-charlie"]);
  const once = orderSessions(fleet, held, true);
  const twice = orderSessions(once.sessions, held, true);
  assert.deepEqual(names(twice.sessions), names(once.sessions));
  assert.deepEqual(
    twice.groups.map((g) => g.repos),
    once.groups.map((g) => g.repos),
  );
  assert.deepEqual(
    twice.groups.map((g) => g.heldFrom),
    once.groups.map((g) => g.heldFrom),
  );
});

test("the arrow keys walk straight through a repository frame, in both layouts", () => {
  // The end the whole placement decision is for, composed the way the cluster test above does
  // it: the real ordering, the real `moveSelection`, and the real row expansion, walked the way
  // a finger would. Repository grouping is the second thing that reorders rows WITHIN a column,
  // so a frame that changed the rendered order without changing these arrays would land the
  // cursor on a different card than the eye - silently, with nothing failing.
  const fleet = [
    inRepo("aaa", REPO_A),
    inRepo("mmm", REPO_B),
    inRepo("zulu", REPO_A),
    member("run-a", 1, "delta", { repoRoot: REPO_B }),
  ];
  const ordered = orderSessions(fleet, new Set(), true);
  const working = ordered.groups.find((g) => g.tone === "working")!;
  assert.deepEqual(names(working.sessions), ["aaa", "zulu", "delta", "mmm"]);
  // The rendered sequence - frames flattened - is that same list, which is what the arrow keys
  // are about to be asserted against.
  assert.deepEqual(renderedIds(fleetRows(working)), working.sessions.map((s) => s.id));

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
  // Out of repo A at `zulu`, into repo B and straight through the run cluster nested inside it -
  // no row skipped, none visited twice, and no stop on a frame header.
  assert.deepEqual(walk("board"), ["aaa", "zulu", "delta", "mmm"]);
  assert.deepEqual(walk("console"), ["aaa", "zulu", "delta", "mmm"]);
});

test("the rendered sequence matches the column array across a free/held boundary too", () => {
  // The same property with both partitions in play at once, which is where an off-by-one in
  // `fleetRows`' two cursors would show up.
  const fleet = [
    inRepo("alpha", REPO_A, IDLE),
    inRepo("bravo", REPO_B, IDLE),
    inRepo("charlie", REPO_A, IDLE),
    inRepo("delta", null, IDLE),
  ];
  const on = orderSessions(fleet, new Set(["plain-charlie"]), true);
  const idle = on.groups.find((g) => g.tone === "idle")!;
  assert.deepEqual(renderedIds(fleetRows(idle)), idle.sessions.map((s) => s.id));
});

test("the rollup counts a repository across the whole board, not one column", () => {
  // The denominator in `2 of 7`. Counted over the flat fleet because the number's entire job is
  // to say the frame in front of you is a PART - a per-column count would report each part as
  // the whole and leave nothing hinting that the rest exists.
  const fleet = [
    inRepo("alpha", REPO_A),
    inRepo("bravo", REPO_A, IDLE),
    inRepo("charlie", REPO_A, { state: "awaiting_input", activity: null }),
    inRepo("delta", REPO_B),
    inRepo("echo", null),
  ];
  const totals = repoSessionTotals(orderSessions(fleet, new Set(), true));
  assert.equal(totals.get(REPO_A), 3);
  assert.equal(totals.get(REPO_B), 1);
  // A session in no repository is in no total, so nothing can render "1 of 1" for it.
  assert.equal(totals.size, 2);
});
