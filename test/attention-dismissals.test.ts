/**
 * What is at stake: every row in the attention inbox can be dismissed, and a dismissed row does
 * not pop back up while it still says the same thing - whether or not what it reports has been
 * resolved.
 *
 * The defect was a Pipeline lifecycle row: it offered "Open Pipeline" and nothing else, so an
 * operator who had read it and could do nothing about it from here met it again on every open,
 * and the `to answer` count never went down. The same was true of every row except a question.
 *
 * Pinned here: the fold drops a dismissed row and its count; what counts as "the same row" for
 * each kind (so a re-rendered detail line does not bring it back, and a different problem
 * does); a dismissal can never re-surface as a different row through the blocked-session
 * backstop; and the inbox draws a Dismiss on every kind the fold can produce.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PipelineCommission, PipelineRun } from "../src/shared/pipeline.ts";
import type { ReviewItem, Session } from "../src/shared/types.ts";
import {
  attentionDismissalKeys,
  foldAttention,
  type AttentionFold,
  type AttentionInput,
  type AttentionItem,
} from "../src/web/lib/attention.ts";
import { AttentionInbox } from "../src/web/components/AttentionInbox.tsx";
import { mkEnsembleSummary, mkSession } from "./helpers/session-fixture.ts";
import { withOverlayHost } from "./helpers/overlay-host.ts";

const REPO = "/repo/demo";

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

function mkCommission(over: Partial<PipelineCommission> = {}): PipelineCommission {
  return {
    id: "commission-1",
    taskId: "pipeline-task",
    provider: "ai-conductor",
    repoRoot: REPO,
    correlationId: "commission-1",
    lifecycle: "authoring",
    attempts: [],
    activeAttempt: 1,
    steps: [],
    currentStep: null,
    tier: null,
    track: null,
    project: null,
    authoringWorktree: null,
    authoringBranch: null,
    planSlug: null,
    handoff: null,
    linkedRun: null,
    blocker: null,
    error: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function mkRun(over: Partial<PipelineRun> = {}): PipelineRun {
  return {
    provider: "ai-conductor",
    repoRoot: REPO,
    slug: "fix-the-thing",
    worktree: `${REPO}/.worktrees/fix-the-thing`,
    tier: "L",
    track: "technical",
    steps: [{ name: "build_review", state: "failed" }],
    lastStep: "build_review",
    halt: { class: "needs-human", reason: "the build review found two blocking defects" },
    group: "halted",
    prUrl: null,
    costTokens: null,
    updatedAt: 5000,
    ...over,
  };
}

/** A Pipeline lifecycle row's problem: the provider held the Engineer. */
const held = (reason: string) => mkCommission({ blocker: { reason } as PipelineCommission["blocker"] });

const DIALOG = {
  options: [{ number: 1, label: "Yes" }, { number: 2, label: "No" }],
  highlighted: 0,
  prompt: "Allow rm -rf build?",
} as Session["paneDialog"];

/** One of every row kind the fold can produce, each on its own subject. */
function everyKind(): AttentionInput {
  return {
    sessions: [
      mkSession({ id: "s-ask", name: "Asking" }),
      mkSession({ id: "s-menu", name: "On a menu", paneDialog: DIALOG }),
      mkSession({ id: "s-blocked", name: "Blocked", state: "awaiting_input", activity: "Needs approval: Bash" }),
    ],
    reviews: [review({ id: "r-1", sessionId: "s-ask" })],
    ensembles: [
      mkEnsembleSummary({ id: "run-decide", title: "Decide me", status: "awaiting_decision" }),
      mkEnsembleSummary({ id: "run-stuck", title: "Stuck", status: "finalizing", error: "ref vanished" }),
    ],
    pipelineRuns: [mkRun()],
    pipelineCommissions: [held("waiting on the provider")],
  };
}

/** Dismiss every key of `items` as the inbox's button would, into a map the fold reads. */
function dismissedFor(...items: AttentionItem[]): Map<string, string> {
  return new Map(items.flatMap(attentionDismissalKeys).map((key) => [key.itemId, key.occurrence]));
}

const kinds = (fold: AttentionFold) => fold.items.map((item) => item.kind);
const only = <K extends AttentionItem["kind"]>(fold: AttentionFold, kind: K) =>
  fold.items.find((item): item is Extract<AttentionItem, { kind: K }> => item.kind === kind)!;

test("every row kind can be dismissed, and a dismissed row leaves the list and the count", () => {
  const before = foldAttention(everyKind());
  assert.deepEqual(kinds(before), [
    "ensemble_decision",
    "session_reviews",
    "session_dialog",
    "pipeline_commission",
    "pipeline_halt",
    "session_blocked",
    "parked_finalization",
  ]);
  for (const item of before.items) {
    const after = foldAttention({ ...everyKind(), dismissed: dismissedFor(item) });
    assert.ok(attentionDismissalKeys(item).length > 0, `${item.kind} has no key to dismiss it by`);
    assert.ok(!after.items.some((row) => row.id === item.id), `${item.kind} came back after it was dismissed`);
    assert.equal(after.items.length, before.items.length - 1, `dismissing ${item.kind} hid something else too`);
    assert.equal(after.total, before.total - 1, `${item.kind} still counts toward "to answer"`);
  }
  const none = foldAttention({ ...everyKind(), dismissed: dismissedFor(...before.items) });
  assert.deepEqual(none.items, []);
  assert.equal(none.total, 0);
});

test("the fold reports exactly the dismissals it applied, which is what keeps them alive", () => {
  // `hidden` is the dashboard's sighting report: a stored dismissal missing from it is one whose
  // row is gone, and only a week of that lets the daemon forget it. So an unresolved row has to
  // be listed on every fold, and a row that now says something new must not be.
  const before = foldAttention(everyKind());
  const dismissed = dismissedFor(...before.items);
  const keys = [...dismissed.keys()].sort();
  assert.deepEqual([...foldAttention({ ...everyKind(), dismissed }).hidden].sort(), keys);

  // The same fleet, re-derived with a resolved question and a halt that reports a new reason.
  const later = everyKind();
  later.reviews = [];
  later.pipelineRuns = [mkRun({ halt: { class: "needs-human", reason: "a different defect" } })];
  const after = foldAttention({ ...later, dismissed });
  assert.deepEqual(
    [...after.hidden].sort(),
    keys.filter((id) => id !== "review:r-1" && !id.startsWith("pipeline-halt:")),
  );
  assert.ok(after.items.some((item) => item.kind === "pipeline_halt"), "the new halt is shown");
  assert.deepEqual(foldAttention(everyKind()).hidden, [], "nothing dismissed, nothing hidden");
});

test("no dismissals folds exactly as before dismissal existed", () => {
  assert.deepEqual(foldAttention({ ...everyKind(), dismissed: new Map() }), foldAttention(everyKind()));
});

test("a dismissed Pipeline lifecycle row stays dismissed until the problem it reports changes", () => {
  const input = (commission: PipelineCommission): AttentionInput => ({
    sessions: [],
    reviews: [],
    ensembles: [],
    pipelineCommissions: [commission],
  });
  const first = only(foldAttention(input(held("waiting on the provider"))), "pipeline_commission");
  assert.equal(first.attention.title, "Engineer is held");
  const dismissed = dismissedFor(first);

  // The same problem, re-derived on a later frame with its detail line re-worded and its
  // commission touched, is the SAME row: it must not pop back up.
  const reworded = mkCommission({
    blocker: { reason: "still waiting on the provider (retry 4)" } as PipelineCommission["blocker"],
    updatedAt: 99,
  });
  assert.deepEqual(foldAttention({ ...input(reworded), dismissed }).items, []);
  assert.equal(foldAttention({ ...input(reworded), dismissed }).total, 0);

  // A different problem on the same commission is a new obligation, and is shown.
  const failed = mkCommission({ lifecycle: "failed", error: "provider crashed" });
  assert.deepEqual(kinds(foldAttention({ ...input(failed), dismissed })), ["pipeline_commission"]);
});

test("a dismissed question stays hidden, and a new question on the same session is shown alone", () => {
  const session = mkSession({ id: "s-ask", name: "Asking" });
  const first = foldAttention({ sessions: [session], reviews: [review({ id: "r-1", sessionId: "s-ask" })], ensembles: [] });
  const dismissed = dismissedFor(...first.items);

  const later = foldAttention({
    sessions: [session],
    reviews: [
      review({ id: "r-1", sessionId: "s-ask" }),
      review({ id: "r-2", sessionId: "s-ask", createdAt: 2000 }),
    ],
    ensembles: [],
    dismissed,
  });
  const row = only(later, "session_reviews");
  assert.deepEqual(row.reviews.map((r) => r.id), ["r-2"]);
  assert.equal(later.total, 1, "only the question nobody dismissed is owed");
});

test("a dismissed row never comes back as 'Waiting on you'", () => {
  // Every one of these sessions is amber on the fleet. The backstop draws an amber session no
  // other section claimed, so a dismissal that removed the row before the claim would redraw it
  // under a new heading - the same thing popping back up, renamed.
  const asking = mkSession({ id: "s-ask", name: "Asking", pendingReviews: 1 });
  const menu = mkSession({ id: "s-menu", name: "On a menu", paneDialog: DIALOG });
  const host = mkSession({
    id: "s-host",
    name: "Pipeline host",
    state: "awaiting_input",
    task: { ...mkSession().task!, id: "pipeline-task", kind: "pipeline" } as Session["task"],
  });
  const input: AttentionInput = {
    sessions: [asking, menu, host],
    reviews: [review({ id: "r-1", sessionId: "s-ask" })],
    ensembles: [],
    pipelineCommissions: [held("waiting on the provider")],
  };
  const before = foldAttention(input);
  assert.deepEqual(kinds(before), ["session_reviews", "session_dialog", "pipeline_commission"]);
  const after = foldAttention({ ...input, dismissed: dismissedFor(...before.items) });
  assert.deepEqual(after.items, [], "a dismissed row was redrawn by the backstop");
});

test("a blocked session, a halt, a menu and a stuck finalization come back only when they say something new", () => {
  const blocked = (activity: string) =>
    mkSession({ id: "s-blocked", name: "Blocked", state: "awaiting_input", activity });
  const base = (activity: string, reason: string, prompt: string, error: string): AttentionInput => ({
    sessions: [blocked(activity), mkSession({ id: "s-menu", name: "On a menu", paneDialog: { ...DIALOG!, prompt } })],
    reviews: [],
    ensembles: [mkEnsembleSummary({ id: "run-stuck", status: "finalizing", error })],
    pipelineRuns: [mkRun({ halt: { class: "needs-human", reason } })],
  });
  const first = foldAttention(base("Needs approval: Bash", "two defects", "Allow rm?", "ref vanished"));
  assert.equal(first.items.length, 4);
  const dismissed = dismissedFor(...first.items);

  assert.deepEqual(
    foldAttention({ ...base("Needs approval: Bash", "two defects", "Allow rm?", "ref vanished"), dismissed }).items,
    [],
    "re-deriving the same rows must not bring any of them back",
  );
  assert.deepEqual(
    kinds(foldAttention({ ...base("Needs approval: Edit", "three defects", "Allow mv?", "lock held"), dismissed })).sort(),
    ["parked_finalization", "pipeline_halt", "session_blocked", "session_dialog"],
    "each row reports something new, so each is a new obligation",
  );
});

test("the inbox draws a Dismiss on every row kind, named after the row it removes", () => {
  const html = renderToStaticMarkup(
    withOverlayHost(
      createElement(AttentionInbox, {
        fold: foldAttention(everyKind()),
        onClose: () => {},
        onDismiss: async () => null,
        onOpenEnsemble: () => {},
        onOpenSession: () => {},
      }),
    ),
  );
  for (const subject of [
    "Decide me",
    "Asking",
    "On a menu",
    "Commission commissi",
    "fix-the-thing",
    "Blocked",
    "Stuck",
  ]) {
    assert.match(html, new RegExp(`aria-label="Dismiss ${subject} from the inbox"[^>]*>Dismiss</button>`), `no Dismiss for ${subject}`);
  }
  assert.equal((html.match(/from the inbox"/g) ?? []).length, 7, "one row Dismiss per row");
  // The row Dismiss says BOTH ways a dismissed row comes back, as the attention guide does.
  assert.match(
    html,
    /It comes back if it reports something new, or if it goes away for a week and then recurs/,
  );
  // The one question in this fleet still draws its OWN Dismiss - the one that answers the agent -
  // and it is told apart from every row's by carrying no "from the inbox" name of its own.
  const questionDismiss = [...html.matchAll(/<button(?![^>]*aria-label=)[^>]*>Dismiss<\/button>/g)];
  assert.equal(questionDismiss.length, 1, "the question card's own Dismiss is drawn exactly once");
});
