// What is at stake: a folded repository frame and the arrow keys agreeing about what exists.
//
// Collapse began as each view's own `useState`, which is where a presentational fold belongs -
// but folding takes cards out of the DOM while the arrow keys walk index arrays App derives from
// `orderSessions`. Nothing told navigation the rows were gone, so the cursor stepped into them:
// no tile drew as selected, and Enter would have opened a session that was not on screen. The
// browser case is `e2e/specs/board-repo-groups.spec.ts`; this pins the pure half, which is the
// expansion App filters its navigation arrays through.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Session } from "../src/shared/types.ts";
import { fleetRows, orderSessions } from "../src/web/lib/fleet-order.ts";
import { hiddenSessionIds } from "../src/web/lib/repo-collapse.ts";
import { mkSession } from "./helpers/session-fixture.ts";

const REPO_A = "/work/alpha-repo";
const REPO_B = "/work/bravo-repo";
const IDLE: Partial<Session> = { state: "idle", activity: null };

function inRepo(name: string, repoRoot: string | null, over: Partial<Session> = {}): Session {
  return mkSession({ id: `s-${name}`, name, pid: 1, repoRoot, ...over });
}

/** The repository rows of one tone group, so a test can name a frame by its key. */
function repoRowKeys(sessions: readonly Session[], tone: string): string[] {
  const group = orderSessions(sessions, new Set(), true).groups.find((g) => g.tone === tone)!;
  return fleetRows(group).flatMap((row) => (row.kind === "repo" ? [row.key] : []));
}

test("nothing folded hides nothing", () => {
  const fleet = [inRepo("alpha", REPO_A), inRepo("bravo", REPO_B)];
  const groups = orderSessions(fleet, new Set(), true).groups;
  assert.equal(hiddenSessionIds(groups, new Set()).size, 0);
});

test("folding a frame hides exactly its own sessions", () => {
  const fleet = [inRepo("alpha", REPO_A), inRepo("bravo", REPO_A), inRepo("charlie", REPO_B)];
  const groups = orderSessions(fleet, new Set(), true).groups;
  const [firstKey] = repoRowKeys(fleet, "working");
  const hidden = hiddenSessionIds(groups, new Set([firstKey!]));
  assert.deepEqual([...hidden].sort(), ["s-alpha", "s-bravo"]);
});

test("folding one column's frame leaves the same repository's other column alone", () => {
  // The reason the fold is keyed per ROW and not per repository: folding a repository in `idle`
  // must not take away the card of its sibling that is waiting for you in `needs you`. If it
  // did, a fold could hide the one session on the board that wanted a human.
  const fleet = [
    inRepo("alpha", REPO_A, IDLE),
    inRepo("bravo", REPO_A, { state: "awaiting_input", activity: null }),
  ];
  const groups = orderSessions(fleet, new Set(), true).groups;
  const [idleKey] = repoRowKeys(fleet, "idle");
  const hidden = hiddenSessionIds(groups, new Set([idleKey!]));
  assert.deepEqual([...hidden], ["s-alpha"]);
  assert.ok(!hidden.has("s-bravo"), "the attention column's card is still navigable");
});

test("folding a frame hides the members of a run cluster nested inside it", () => {
  // A frame's blocks are not all loose sessions. A cluster occupies one block and several
  // sessions, and a filter that counted blocks would leave its members navigable while their
  // cards were gone.
  const members = [
    mkSession({
      id: "run-1",
      name: "member one",
      pid: 1,
      repoRoot: REPO_A,
      pipeline: { provider: "ai-conductor", repoRoot: REPO_A, slug: "feature", step: "build" },
    }),
    mkSession({
      id: "run-2",
      name: "member two",
      pid: 2,
      repoRoot: REPO_A,
      pipeline: { provider: "ai-conductor", repoRoot: REPO_A, slug: "feature", step: "build" },
    }),
  ];
  const groups = orderSessions(members, new Set(), true).groups;
  const [key] = repoRowKeys(members, "working");
  assert.deepEqual([...hiddenSessionIds(groups, new Set([key!]))].sort(), ["run-1", "run-2"]);
});

test("a key nothing draws hides nothing, so a stale fold cannot blank the board", () => {
  // A row key carries the frame's first member, so it changes when that member leaves the
  // column. The stale key has to be inert rather than matching something else: a fold that
  // outlived its frame and started hiding a different repository's cards would be a board
  // silently missing sessions.
  const fleet = [inRepo("alpha", REPO_A), inRepo("bravo", REPO_B)];
  const groups = orderSessions(fleet, new Set(), true).groups;
  assert.equal(hiddenSessionIds(groups, new Set(["repo-working-/work/gone-s-vanished"])).size, 0);
});

test("with grouping off there are no frames to fold", () => {
  // Nothing can be hidden on a board that draws no frames, whatever keys are left in the store.
  const fleet = [inRepo("alpha", REPO_A), inRepo("bravo", REPO_B)];
  const groups = orderSessions(fleet).groups;
  assert.equal(hiddenSessionIds(groups, new Set(["repo-working-/work/alpha-repo-s-alpha"])).size, 0);
});
