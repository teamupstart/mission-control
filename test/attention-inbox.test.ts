/**
 * What is at stake: ONE place to drain everything that needs a person.
 *
 * Before this fold there was a chip that opened the first answerable review's session modal.
 * Everything else the operator owed - a run parked on a decision, a second blocked session, a
 * finalization stuck mid-promotion, a shipping gate nobody was driving - was found by noticing
 * it. A queue that quietly drops one of those is worse than no queue: it says "you are clear"
 * over work that is stopped.
 *
 * So what is pinned here is what the fold PROMISES. Its sections are fixed and never
 * interleave, because they are different kinds of obligation. Its order inside a section is
 * total, so the same state cannot render two ways. A member's question carries the run context
 * an answerer would otherwise have to go and find - the gap that let someone nudge one
 * competitor of a comparison without knowing it was one. Its total is ANSWERS, not rows. And
 * every review appears exactly once, which is what keeps two agents' option menus in one
 * document from sharing a radio group.
 *
 * The component itself is covered by source scan rather than by rendering, for the reason
 * `overlay-registry.test.ts` gives about `ReviewModal`: it draws `ReviewCard`, which reaches
 * `react-diff-view`'s stylesheet, and this runner cannot load a `.css` import. The fold above
 * it is where the decisions are, and it is pure on purpose.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ReviewItem, Session } from "../src/shared/types.ts";
import { foldAttention, ensembleRunContext } from "../src/web/lib/attention.ts";
import { OVERLAY_IDS } from "../src/web/components/Overlay.tsx";
import {
  mkEnsembleLink,
  mkEnsembleSummary,
  mkMemberSession,
  mkSession,
  mkTaskSummary,
} from "./helpers/session-fixture.ts";

const NO_GATES: ReadonlySet<string> = new Set();

function review(over: Partial<ReviewItem> & { id: string; sessionId: string }): ReviewItem {
  return {
    kind: "input",
    title: "Which parser?",
    body: "Which parser should I use?",
    status: "pending",
    response: null,
    createdAt: 1000,
    resolvedAt: null,
    ...over,
  };
}

function fold(over: {
  sessions?: Session[];
  reviews?: ReviewItem[];
  ensembles?: ReturnType<typeof mkEnsembleSummary>[];
  gateAlerts?: ReadonlySet<string>;
}) {
  return foldAttention({
    sessions: over.sessions ?? [],
    reviews: over.reviews ?? [],
    ensembles: over.ensembles ?? [],
    gateAlerts: over.gateAlerts ?? NO_GATES,
  });
}

test("the sections are fixed in order: decisions, questions, parked menus, then the rest", () => {
  const member = mkMemberSession({
    id: "s-member",
    paneDialog: { options: [], highlighted: 0, prompt: "Allow rm -rf?" } as Session["paneDialog"],
    link: { ordinal: 2 },
  });
  const asking = mkSession({ id: "s-ask", name: "Asking" });
  const gated = mkSession({ id: "s-gate", name: "Gated" });
  const result = fold({
    sessions: [member, asking, gated],
    reviews: [review({ id: "r-1", sessionId: "s-ask" })],
    ensembles: [
      mkEnsembleSummary({ id: "run-decide", status: "awaiting_decision" }),
      mkEnsembleSummary({ id: "run-stuck", status: "finalizing", error: "ref vanished" }),
      // A healthy run needs nobody and must not appear at all.
      mkEnsembleSummary({ id: "run-fine", status: "running" }),
    ],
    gateAlerts: new Set(["s-gate"]),
  });

  assert.deepEqual(
    result.items.map((item) => item.kind),
    [
      "ensemble_decision",
      "session_reviews",
      "member_dialog",
      "parked_finalization",
      "gate",
    ],
  );
  assert.equal(result.items.filter((i) => i.kind === "ensemble_decision").length, 1);
});

test("nothing that needs nobody is listed, and an empty fleet folds to an empty queue", () => {
  const quiet = fold({
    sessions: [mkSession({ id: "s-1" })],
    ensembles: [mkEnsembleSummary({ status: "running" }), mkEnsembleSummary({ id: "b", status: "completed" })],
  });
  assert.deepEqual(quiet.items, []);
  assert.equal(quiet.total, 0);
});

test("the total counts ANSWERS owed, not rows, so a second question raises it", () => {
  // The chip counted `answerableReviews.length` before this existed. Counting rows instead
  // would make the figure DROP when a session already listed raised a second question.
  const asking = mkSession({ id: "s-ask" });
  const one = fold({ sessions: [asking], reviews: [review({ id: "r-1", sessionId: "s-ask" })] });
  const two = fold({
    sessions: [asking],
    reviews: [
      review({ id: "r-1", sessionId: "s-ask" }),
      review({ id: "r-2", sessionId: "s-ask", createdAt: 2000 }),
    ],
  });
  assert.equal(one.items.length, 1);
  assert.equal(one.total, 1);
  assert.equal(two.items.length, 1, "one session is one row, however many questions it holds");
  assert.equal(two.total, 2);
});

test("a review whose session is gone is not listed - the live filter survives the fold", () => {
  // The narrowing happens in App (`answerableReviews`), but the fold must not undo it by
  // listing a review it was handed for a session it cannot see: the row would carry a name it
  // does not have and an Open session that opens nothing.
  const result = fold({
    sessions: [mkSession({ id: "s-live" })],
    reviews: [
      review({ id: "r-live", sessionId: "s-live" }),
      review({ id: "r-dead", sessionId: "s-vanished" }),
    ],
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.total, 1, "the count and the list agree, which is the whole property");
  const item = result.items[0];
  assert.equal(item?.kind === "session_reviews" && item.reviews.length, 1);
});

test("an ensemble member's question carries the run context that answering it needs", () => {
  // G13: the answer surfaces say nothing about the run, so the operator steering candidate 3
  // could not tell they were tilting a comparison.
  const member = mkMemberSession({ id: "s-m", link: { ordinal: 3, maxMembers: 5 } });
  const ordinary = mkSession({ id: "s-o" });
  const result = fold({
    sessions: [member, ordinary],
    reviews: [
      review({ id: "r-m", sessionId: "s-m", createdAt: 1000 }),
      review({ id: "r-o", sessionId: "s-o", createdAt: 2000 }),
    ],
    ensembles: [mkEnsembleSummary({ id: "run-1", title: "Fix the parser" })],
  });
  const [memberItem, ordinaryItem] = result.items;
  assert.equal(
    memberItem?.kind === "session_reviews" && memberItem.context,
    'Best of N "Fix the parser" - candidate 3 of 5',
  );
  assert.equal(
    ordinaryItem?.kind === "session_reviews" && ordinaryItem.context,
    null,
    "an ordinary session gets no run clause invented for it",
  );
});

test("the run context reads off the link before the summary lands, and never says 3 of 3", () => {
  // The denominator is the roster the operator CHOSE. `launchedMembers` climbs wave by wave,
  // so "candidate 3 of 3" on a five-lane run is a sentence that changes meaning while nothing
  // about the member does. And a member exists before its run's SSE summary does.
  const link = mkEnsembleLink({ ordinal: 3, launchedMembers: 3, maxMembers: 5 });
  assert.equal(ensembleRunContext(link, null), "Best of N - candidate 3 of 5");
  assert.equal(
    ensembleRunContext(link, mkEnsembleSummary({ title: "Fix the parser" })),
    'Best of N "Fix the parser" - candidate 3 of 5',
  );
});

test("the oldest wait leads its section, and the order is total", () => {
  const a = mkSession({ id: "s-a", name: "A" });
  const b = mkSession({ id: "s-b", name: "B" });
  const result = fold({
    sessions: [a, b],
    reviews: [
      review({ id: "r-new", sessionId: "s-a", createdAt: 9000 }),
      review({ id: "r-old", sessionId: "s-b", createdAt: 1000 }),
    ],
    ensembles: [
      mkEnsembleSummary({ id: "run-new", status: "awaiting_decision", updatedAt: 9000 }),
      mkEnsembleSummary({ id: "run-old", status: "awaiting_decision", updatedAt: 1000 }),
    ],
  });
  assert.deepEqual(
    result.items.map((item) => item.id),
    ["ensemble-decision:run-old", "ensemble-decision:run-new", "reviews:s-b", "reviews:s-a"],
  );
  // Same state in, same list out: two renders of one fleet must not reshuffle the queue.
  assert.deepEqual(
    fold({
      sessions: [b, a],
      reviews: [
        review({ id: "r-old", sessionId: "s-b", createdAt: 1000 }),
        review({ id: "r-new", sessionId: "s-a", createdAt: 9000 }),
      ],
      ensembles: [
        mkEnsembleSummary({ id: "run-old", status: "awaiting_decision", updatedAt: 1000 }),
        mkEnsembleSummary({ id: "run-new", status: "awaiting_decision", updatedAt: 9000 }),
      ],
    }).items.map((item) => item.id),
    result.items.map((item) => item.id),
  );
});

test("every item id is unique, so no review can be drawn into the document twice", () => {
  // Two option-carrying `input` reviews in one document share a radio group unless each names
  // its own, which `ReviewCard` does by review id. Drawing a review twice defeats that by
  // putting the SAME name on screen twice, and answering one clears the other.
  const member = mkMemberSession({
    id: "s-both",
    // A session can hold both a question and a menu; they are two asks, and both are listed.
    paneDialog: { options: [], highlighted: 0, prompt: "Allow?" } as Session["paneDialog"],
  });
  const result = fold({
    sessions: [member],
    reviews: [
      review({ id: "r-1", sessionId: "s-both" }),
      review({ id: "r-2", sessionId: "s-both", createdAt: 2000 }),
    ],
    ensembles: [mkEnsembleSummary()],
    gateAlerts: new Set(["s-both"]),
  });
  const ids = result.items.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  const reviewIds = result.items.flatMap((item) =>
    item.kind === "session_reviews" ? item.reviews.map((r) => r.id) : [],
  );
  assert.deepEqual(reviewIds, ["r-1", "r-2"]);
});

test("only ensemble members are listed for a pane dialog, and a dead session's menu is not", () => {
  // 5.1(c): a pane dialog is a transient TUI fact answered on the card, so it earns a row only
  // where the run view would otherwise show that member as merrily "Active". An ordinary
  // session parked on a menu is already amber on the fleet and is not duplicated here.
  const dialog = { options: [], highlighted: 0, prompt: "Allow?" } as Session["paneDialog"];
  const result = fold({
    sessions: [
      mkMemberSession({ id: "s-member", paneDialog: dialog }),
      mkSession({ id: "s-plain", paneDialog: dialog }),
      // `paneDialog` outlives the pane: an exited session carries its last menu for the whole
      // linger window, and nothing can be typed at it.
      mkMemberSession({ id: "s-exited", state: "exited", paneDialog: dialog }),
    ],
  });
  assert.deepEqual(
    result.items.map((item) => item.id),
    ["dialog:s-member"],
  );
});

test("a finalization is parked only when it FAILED, not merely because it is promoting", () => {
  const healthy = fold({ ensembles: [mkEnsembleSummary({ status: "finalizing", error: null })] });
  assert.deepEqual(healthy.items, []);
  const stuck = fold({
    ensembles: [mkEnsembleSummary({ status: "finalizing", error: "winner ref missing" })],
  });
  assert.equal(stuck.items[0]?.kind, "parked_finalization");
  assert.equal(
    stuck.items[0]?.kind === "parked_finalization" && stuck.items[0].error,
    "winner ref missing",
  );
});

test("a gate is listed from App's own derivation, never re-decided here", () => {
  // `gateParked` already excludes a gate some sibling session is driving. A second opinion
  // here would put an amber row over a run an agent is answering itself.
  const driving = mkSession({ id: "s-driving" });
  const parked = mkSession({ id: "s-parked" });
  const result = fold({ sessions: [driving, parked], gateAlerts: new Set(["s-parked"]) });
  assert.deepEqual(
    result.items.map((item) => item.id),
    ["gate:s-parked"],
  );
});

test("a task with no ensemble link takes the ordinary path", () => {
  const plain = mkSession({ id: "s-1", task: mkTaskSummary({ ensemble: null }) });
  const result = fold({ sessions: [plain], reviews: [review({ id: "r", sessionId: "s-1" })] });
  const item = result.items[0];
  assert.equal(item?.kind === "session_reviews" && item.context, null);
});

// ---- the component, from source (see the header for why it is not rendered) ----

const inbox = readFileSync(
  fileURLToPath(new URL("../src/web/components/AttentionInbox.tsx", import.meta.url)),
  "utf8",
);

test("the inbox is a registered overlay and draws the shared review card", () => {
  assert.ok(OVERLAY_IDS.attention, "the inbox needs its own id, or onlyOpen() cannot match it");
  assert.match(inbox, /<Overlay\s*\n?\s*id=\{OVERLAY_IDS\.attention\}/);
  // Reused, never re-implemented: a second answering surface is a second thing to keep in
  // step with `api.resolveReview` and with the radio-group rule.
  assert.match(inbox, /import \{ ReviewCard \} from "\.\/ReviewModal\.tsx"/);
  assert.match(inbox, /<ReviewCard key=\{review\.id\} review=\{review\} \/>/);
  // And the progress rendering is Phase 3's one leaf, not a second row of squares.
  assert.match(inbox, /<EnsembleProgressDots summary=\{item\.summary\} \/>/);
});

test("the inbox renders every item kind the fold can produce", () => {
  // A fold that grows a kind the component cannot draw is a silent hole in the queue: the
  // count goes up and nothing appears. `SECTION_TITLES` is a total Record over the union, so
  // the compiler catches the heading - this catches the case arm.
  for (const kind of [
    "ensemble_decision",
    "session_reviews",
    "member_dialog",
    "parked_finalization",
    "gate",
  ]) {
    assert.match(inbox, new RegExp(`case "${kind}":`), `${kind} has no arm in the inbox`);
  }
});

test("a deep link closes the inbox; answering in place does not", () => {
  // The item's home is elsewhere - an inbox still covering it hides the thing the click asked
  // for. A review is answered right here, so the modal must NOT close under the operator.
  assert.match(inbox, /const leave = \(go: \(\) => void\) => \(\) => \{\s*onClose\(\);/);
  assert.match(inbox, /onOpenEnsemble=\{\(runId\) => leave\(\(\) => onOpenEnsemble\(runId\)\)\(\)\}/);
  const reviews = inbox.slice(inbox.indexOf('case "session_reviews":'), inbox.indexOf('case "member_dialog":'));
  assert.doesNotMatch(reviews, /onClose/);
});

test("every class the inbox renders has a rule in the stylesheet", () => {
  // There is no linter for a className that lost its rule, so this is it.
  const css = readFileSync(new URL("../src/web/styles.css", import.meta.url), "utf8");
  for (const cls of [
    "attention-inbox",
    "inbox-section",
    "inbox-entry",
    "inbox-item",
    "inbox-decision",
    "inbox-reviews",
    "inbox-dialog",
    "inbox-parked",
    "inbox-gate",
    "inbox-head",
    "inbox-spacer",
    "inbox-glyph",
    "inbox-meta",
    "inbox-context",
    "inbox-line",
    "inbox-error",
    "inbox-empty",
  ]) {
    assert.ok(css.includes(`.${cls}`), `${cls} has no rule in styles.css`);
  }
});
