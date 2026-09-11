import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REVIEW_GROUP_MIN,
  groupReviewRuns,
  type ReviewGroupRow,
  type ReviewRow,
} from "../src/web/lib/line-review-groups.ts";
import type { WorkflowRunSummary } from "../src/shared/workflow.ts";
import { LADDER_SUMMARY } from "./helpers/workflow-ladder.ts";

/**
 * The Review drawer's fold, as a table.
 *
 * A pure function over the summaries the browser already holds, which is why it is here and
 * not in a rendering test: whether three runs sharing a reason become one bar is a decision,
 * and a decision checked by reading markup is a decision nobody can see. What the DRAWER does
 * with these rows - the bar's markup, the disclosure, the batch confirm - is
 * `line-drawer.test.ts`, and that a person can click it is `e2e/specs/line-drawers.spec.ts`.
 */

const run = (over: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary => ({
  ...LADDER_SUMMARY,
  activePersonaNames: [],
  ...over,
});

/** A blocked run, which is the only kind that folds. */
const stopped = (id: string, phase: string, over: Partial<WorkflowRunSummary> = {}) =>
  run({ id, noteKey: `${id}-note`, status: "blocked", phase, ...over });

const fold = (
  runs: WorkflowRunSummary[],
  live: (run: WorkflowRunSummary) => string | null = () => null,
): ReviewRow[] => groupReviewRuns(runs, live);

const groups = (rows: ReviewRow[]): ReviewGroupRow[] =>
  rows.filter((row): row is ReviewGroupRow => row.kind === "group");

const shape = (rows: ReviewRow[]): string[] =>
  rows.map((row) => row.kind === "group" ? `group:${row.phase}×${row.members.length}` : row.run.id);

test("three runs stopped for one reason become one bar, and two stay two rows", () => {
  // The threshold is the submitted decision, and both sides of it are the claim. A pair is
  // not a pile: folding two rows saves one line and costs the reader both rows' chips, both
  // round counters and both remedies, so at two the bar is strictly worse than what it hides.
  assert.equal(REVIEW_GROUP_MIN, 3);

  const pair = fold([stopped("a", "session_disappeared"), stopped("b", "session_disappeared")]);
  assert.deepEqual(shape(pair), ["a", "b"]);
  assert.equal(groups(pair).length, 0);

  const pile = fold([
    stopped("a", "session_disappeared"),
    stopped("b", "session_disappeared"),
    stopped("c", "session_disappeared"),
  ]);
  assert.deepEqual(shape(pile), ["group:session_disappeared×3"]);
});

test("runs fold by their reason, so two causes are two bars and never one pile", () => {
  // The whole value of the bar is that its one sentence is TRUE of everything under it.
  // Grouping on "blocked" alone would put a run out of rounds and a run whose session died in
  // one row under a reason that describes neither.
  const rows = fold([
    ...Array.from({ length: 3 }, (_, i) => stopped(`gone-${i}`, "session_disappeared", { updatedAt: 900 - i })),
    ...Array.from({ length: 3 }, (_, i) => stopped(`spent-${i}`, "round_limit", { updatedAt: 500 - i })),
  ]);
  assert.deepEqual(shape(rows), ["group:session_disappeared×3", "group:round_limit×3"]);
  assert.deepEqual(groups(rows).map((g) => g.clause), ["session gone", "out of rounds"]);
});

test("an unmapped reason still groups, and still says something readable", () => {
  // `phase` is a free string and `orphanBinding` writes arbitrary codes into it. A future
  // reason code must fold like any other and must not label its bar `undefined`.
  const rows = fold(Array.from({ length: 3 }, (_, i) => stopped(`x${i}`, "some_future_reason")));
  assert.equal(groups(rows)[0]!.clause, "some future reason");
});

test("a newly named phase groups under its cause rather than its own identifier", () => {
  /*
   * The regression this phase exists for, said at the layer the drawer reads.
   *
   * Twelve of the twenty-seven blocked-capable phases had no clause, so a pile of them read
   * "3 · image evidence capture" - a bar whose whole job is to say the reason once, printing
   * the pipeline stage instead. The fallback made that look deliberate: it is grammatical,
   * lower-case and the right length, so nothing about the rendered bar said a clause was
   * missing.
   *
   * Both of these are real states. `image_evidence_capture` is the phase the reported run
   * stopped on; `preflight_refinement_exhausted` is the one a second run in the same operator's
   * state database is parked on right now.
   */
  const rows = fold([
    ...Array.from({ length: 3 }, (_, i) =>
      stopped(`img-${i}`, "image_evidence_capture", { updatedAt: 900 - i })),
    ...Array.from({ length: 3 }, (_, i) =>
      stopped(`pre-${i}`, "preflight_refinement_exhausted", { updatedAt: 500 - i })),
  ]);
  assert.deepEqual(
    groups(rows).map((g) => g.clause),
    ["registered evidence refused", "out of evidence refinements"],
  );
  // Stated as a negative too, because the fallback is what a reader would have seen and it is
  // the thing that must be gone rather than merely improved upon.
  assert.deepEqual(
    groups(rows).map((g) => g.phase.replaceAll("_", " ")),
    ["image evidence capture", "preflight refinement exhausted"],
  );
});

test("only blocked runs fold - a live run and your turn are never hidden behind a caret", () => {
  // The row a person came to this drawer for is the one parked on their answer, and a run
  // that is still moving is the one whose chips are the point. Folding either would bury the
  // thing the surface exists to show.
  const rows = fold([
    run({ id: "yours", status: "waiting_for_action", actionWait: "needs_operator", updatedAt: 10 }),
    run({ id: "live-1", status: "running", updatedAt: 9 }),
    run({ id: "live-2", status: "running", updatedAt: 8 }),
    run({ id: "live-3", status: "running", updatedAt: 7 }),
    ...Array.from({ length: 3 }, (_, i) => stopped(`gone-${i}`, "session_disappeared", { updatedAt: 100 })),
  ]);
  assert.deepEqual(shape(rows), [
    "yours",
    "group:session_disappeared×3",
    "live-1",
    "live-2",
    "live-3",
  ]);
});

test("a group stands where its newest member stood, and terminal runs are not in it", () => {
  // Ordering is `triageOrder`'s, unchanged: rows that want a person, then by recency. A bar
  // takes its newest member's place so the surface reads the same before and after the fold -
  // a pile that jumped to the top would reorder a drawer whose promise is "what wants me,
  // then what is recent".
  const rows = fold([
    stopped("old-1", "round_limit", { updatedAt: 30 }),
    stopped("old-2", "round_limit", { updatedAt: 20 }),
    stopped("old-3", "round_limit", { updatedAt: 10 }),
    stopped("recent", "inspector_findings", { updatedAt: 50 }),
    run({ id: "done", status: "completed", updatedAt: 999 }),
    run({ id: "killed", status: "cancelled", updatedAt: 998 }),
  ]);
  assert.deepEqual(shape(rows), ["recent", "group:round_limit×3"]);

  const newestFirst = fold([
    stopped("a", "round_limit", { updatedAt: 10 }),
    stopped("b", "round_limit", { updatedAt: 30 }),
    stopped("c", "round_limit", { updatedAt: 20 }),
  ]);
  assert.deepEqual(groups(newestFirst)[0]!.members.map((m) => m.run.id), ["b", "c", "a"]);
});

test("a bar names its members by the same three steps a row names itself by", () => {
  // A bar that listed GUIDs where its rows would have listed titles is the original defect,
  // one level up. The live name still leads; the binding's captured title is the fallback
  // that makes an orphaned run nameable at all.
  const rows = fold(
    [
      stopped("a", "session_disappeared", { sessionId: "s1", sessionName: "captured alpha", updatedAt: 30 }),
      stopped("b", "session_disappeared", { sessionId: null, sessionName: "Fix Busy State", updatedAt: 20 }),
      stopped("c", "session_disappeared", { sessionId: null, sessionName: "", noteKey: "claude:9f1c", updatedAt: 10 }),
    ],
    (r) => (r.id === "a" ? "live alpha" : null),
  );
  const group = groups(rows)[0]!;
  assert.deepEqual(group.names, ["live alpha", "Fix Busy State", "claude:9f1c"]);
  assert.equal(group.unnamedCount, 0);
});

test("a bar names the first few members and counts the rest", () => {
  const rows = fold(Array.from({ length: 30 }, (_, i) =>
    stopped(`r${i}`, "session_disappeared", { sessionName: `Run ${i}`, updatedAt: 1000 - i })));
  const group = groups(rows)[0]!;
  assert.deepEqual(group.names, ["Run 0", "Run 1", "Run 2"]);
  assert.equal(group.unnamedCount, 27);
  // Every member is still IN the group. The bar summarises; it never drops.
  assert.equal(group.members.length, 30);
});

test("a bar claims one workflow only when every member is running one", () => {
  const same = groups(fold(Array.from({ length: 3 }, (_, i) =>
    stopped(`r${i}`, "round_limit"))))[0]!;
  assert.equal(same.workflow, "No-Mistakes Review v4");

  const mixed = groups(fold([
    stopped("a", "round_limit"),
    stopped("b", "round_limit", { workflowName: "Docs Review" }),
    stopped("c", "round_limit", { workflowVersion: 9 }),
  ]))[0]!;
  assert.equal(mixed.workflow, "3 workflows");
});

test("the batch is Phase 1's dismiss applied to a set, and nothing else batches", () => {
  // One control, and it is the one whose whole purpose is clearing a pile. `Restart…` demands
  // a typed phrase each time, and batching that would launder thirty deliberate acts into
  // one; `Retry` fires provider calls, and a batch button is a way to fire thirty by accident.
  const dismissable = groups(fold(Array.from({ length: 4 }, (_, i) =>
    stopped(`r${i}`, "session_disappeared", { sessionName: `Run ${i}` }))))[0]!;
  assert.equal(dismissable.remedy?.kind, "dismiss");
  assert.equal(dismissable.remedy?.label, "Dismiss all");
  // The count is echoed in the confirmation, because this ends four runs from a panel one
  // keystroke off the strip - the demand `DELETE /api/ensembles/:id` already makes.
  assert.equal(dismissable.remedy?.confirm?.title, "Cancel 4 runs");
  assert.match(dismissable.remedy!.confirm!.body, /4 runs stopped for the same reason: session gone/);
  assert.equal(dismissable.remedy?.confirm?.danger, true);
  // No phrase to type: the daemon does not demand one for `cancel`, and inventing one here
  // would be a second, stricter cancel than the run page's.
  assert.equal(dismissable.remedy?.confirm?.requirePhrase, undefined);

  // A pile of provider failures still folds - one bar saying it once is the point - but it
  // carries no batch button, so those rows keep their per-row `Retry` behind the caret.
  const provider = groups(fold(Array.from({ length: 3 }, (_, i) =>
    stopped(`r${i}`, "infrastructure_error"))))[0]!;
  assert.equal(provider.remedy, null);

  // And a pile blocked on a DECISION is a bar with no control at all, which is honest: the
  // material for that decision is the run page's.
  const findings = groups(fold(Array.from({ length: 3 }, (_, i) =>
    stopped(`r${i}`, "inspector_findings"))))[0]!;
  assert.equal(findings.remedy, null);
  assert.equal(findings.clause, "GitHub Inspector findings");
});

test("the batch posts each member's own remedy, never one run id repeated", () => {
  // The group's descriptor carries a label and a confirmation; the PATH on it is one
  // member's and is never posted as it stands. This pins that the members are individually
  // addressable, which is what the drawer walks.
  const group = groups(fold([
    stopped("first", "session_disappeared", { updatedAt: 30 }),
    stopped("second", "session_disappeared", { updatedAt: 20 }),
    stopped("third", "session_disappeared", { updatedAt: 10 }),
  ]))[0]!;
  assert.deepEqual(group.members.map((m) => m.run.id), ["first", "second", "third"]);
  assert.equal(new Set(group.members.map((m) => m.run.id)).size, 3);
});
