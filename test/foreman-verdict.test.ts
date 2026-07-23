import { test } from "node:test";
import assert from "node:assert/strict";
import type { ForemanConfig, SetNote } from "../src/shared/protocol.ts";
import {
  applyVerdict,
  foremanMayActLive,
  menuBlocksAnswer,
  planFromVerdict,
  REVIEW_FAILURE_CAP,
  ReviewFailureTracker,
  type ForemanActions,
  type ReviewContext,
  type Verdict,
} from "../src/server/foreman/verdict.ts";
import { extractVerdict } from "../src/server/foreman/review.ts";

function ctx(over: Partial<ReviewContext> = {}): ReviewContext {
  return {
    sessionId: "s1",
    promptMarker: "await:100",
    inputReviewId: null,
    canSend: true,
    ...over,
  };
}

function cfg(over: Partial<ForemanConfig> = {}): ForemanConfig {
  return {
    enabled: true,
    mode: "live",
    repoAllowlist: ["/repo"],
    autoApproveAccess: true,
    triage: "off",
    maxFixAttempts: 3,
    maxFixRounds: 10,
    wrapupTriggers: ["drain"],
    wrapup: "ask",
    autoBacklog: false,
    backlogRespectOpenPrs: true,
    backlogDefaultModel: { claude: null, codex: null, pi: null },
    maxSessions: 3,
    ...over,
  };
}

const ANSWER: Verdict = {
  purpose: "Wiring the auth refactor; deciding how to store tokens.",
  classification: "implementation",
  action: "answer",
  answer: { text: "Use option D: one token store behind a single API.", submit: true },
  confidence: 0.9,
};

const ACCESS_ANSWER: Verdict = {
  purpose: "Child wants to run the test suite before pushing.",
  classification: "access",
  action: "answer",
  answer: { text: "Approve - go ahead.", submit: true },
  confidence: 0.9,
};

test("live + allowlisted answer -> sends via terminal and marks answered", () => {
  const plan = planFromVerdict(ANSWER, ctx(), true);
  assert.equal(plan.note.disposition, "answered");
  assert.equal(plan.note.purpose, ANSWER.purpose);
  assert.equal(plan.note.handledMarker, "await:100");
  assert.ok(plan.send);
  assert.equal(plan.send?.channel, "send");
  assert.equal(plan.send?.text, ANSWER.answer!.text);
});

test("dry-run (mayActLive=false) drafts a reply and sends nothing", () => {
  const plan = planFromVerdict(ANSWER, ctx(), false);
  assert.equal(plan.note.disposition, "pending");
  assert.equal(plan.note.recommendation, ANSWER.answer!.text);
  assert.equal(plan.send, null);
});

test("answer to an input review resolves that review, not the terminal", () => {
  const plan = planFromVerdict(ANSWER, ctx({ inputReviewId: "rev-9", canSend: false }), true);
  assert.equal(plan.send?.channel, "review");
  assert.equal(plan.send?.reviewId, "rev-9");
});

test("answer with no deliverable channel escalates with the drafted text", () => {
  const plan = planFromVerdict(ANSWER, ctx({ canSend: false, inputReviewId: null }), true);
  assert.equal(plan.note.disposition, "escalated");
  assert.equal(plan.note.recommendation, ANSWER.answer!.text);
  assert.equal(plan.send, null);
});

test("access answer with autoApproveAccess=false escalates and sends nothing", () => {
  const plan = planFromVerdict(ACCESS_ANSWER, ctx(), true, false);
  assert.equal(plan.note.disposition, "escalated");
  assert.equal(plan.note.recommendation, ACCESS_ANSWER.answer!.text);
  assert.match(plan.note.lastAction ?? "", /auto-approval disabled/);
  assert.equal(plan.send, null);
});

test("access answer with autoApproveAccess=true answers + sends as before", () => {
  const plan = planFromVerdict(ACCESS_ANSWER, ctx(), true, true);
  assert.equal(plan.note.disposition, "answered");
  assert.ok(plan.send);
  assert.equal(plan.send?.text, ACCESS_ANSWER.answer!.text);
});

test("non-access answer with autoApproveAccess=false still answers", () => {
  const plan = planFromVerdict(ANSWER, ctx(), true, false);
  assert.equal(plan.note.disposition, "answered");
  assert.ok(plan.send);
});

test("mid-review autoApproveAccess flip re-plans an access send into an escalation", () => {
  // The worker builds the plan from the config captured before the (slow) review,
  // then re-plans from a fresh config right before sending. If access auto-approval
  // was switched off mid-review, the re-plan must drop the live send.
  const initial = planFromVerdict(ACCESS_ANSWER, ctx(), true, true);
  assert.ok(initial.send, "captured config would have sent the access approval");

  const replanned = planFromVerdict(ACCESS_ANSWER, ctx(), true, false);
  assert.equal(replanned.send, null, "fresh autoApproveAccess=false drops the send");
  assert.equal(replanned.note.disposition, "escalated");
  assert.equal(replanned.note.recommendation, ACCESS_ANSWER.answer!.text);
});

test("escalate writes brief + recommendation and never sends", () => {
  const v: Verdict = {
    purpose: "p",
    classification: "design-fork",
    action: "escalate",
    brief: "## Fork\nA vs B",
    recommendation: "Lean A",
    confidence: 0.4,
  };
  const plan = planFromVerdict(v, ctx(), true);
  assert.equal(plan.note.disposition, "escalated");
  assert.equal(plan.note.brief, "## Fork\nA vs B");
  assert.equal(plan.note.recommendation, "Lean A");
  assert.equal(plan.send, null);
});

test("skip writes only a purpose", () => {
  const v: Verdict = { purpose: "just a diff review", classification: "other", action: "skip" };
  const plan = planFromVerdict(v, ctx(), true);
  assert.equal(plan.note.disposition, "skipped");
  assert.equal(plan.note.purpose, "just a diff review");
  // A model-produced skip is a real decision, so it stamps the marker immediately
  // (unlike a transient reviewer failure, which retries - see ReviewFailureTracker).
  assert.equal(plan.note.handledMarker, "await:100");
  assert.equal(plan.send, null);
});

test("review failures retry under the cap, then give up with a marker-stamped skip", () => {
  const tracker = new ReviewFailureTracker();
  const c = ctx({ promptMarker: "review:r1" });
  for (let i = 1; i < REVIEW_FAILURE_CAP; i++) {
    assert.equal(tracker.onFailure(c, "review timed out").retry, true, `failure ${i} under the cap retries`);
  }
  const final = tracker.onFailure(c, "review timed out");
  if (final.retry) return void assert.fail("expected a give-up once the cap is reached");
  assert.equal(final.note.disposition, "skipped");
  // The give-up note stamps the marker so the idempotency check stops the loop.
  assert.equal(final.note.handledMarker, "review:r1");
  assert.equal(final.note.purpose, "review timed out");
  assert.match(final.note.lastAction ?? "", /reviewer failed/);
});

test("a new prompt marker resets the failure counter (no stale strikes)", () => {
  const tracker = new ReviewFailureTracker();
  for (let i = 1; i < REVIEW_FAILURE_CAP; i++) tracker.onFailure(ctx({ promptMarker: "review:a" }), "x");
  // A different marker on the same session is a fresh episode, not the capped strike.
  assert.equal(tracker.onFailure(ctx({ promptMarker: "review:b" }), "x").retry, true);
});

test("a successful review clears the failure counter", () => {
  const tracker = new ReviewFailureTracker();
  for (let i = 1; i < REVIEW_FAILURE_CAP; i++) tracker.onFailure(ctx(), "x");
  tracker.onSuccess("s1");
  // After success the next failure is strike 1 again, not the give-up strike.
  assert.equal(tracker.onFailure(ctx(), "x").retry, true);
});

test("foremanMayActLive: only enabled + live + allowlisted (prefix) cwd sends", () => {
  assert.equal(foremanMayActLive(cfg(), "/repo"), true);
  assert.equal(foremanMayActLive(cfg(), "/repo/worktrees/x"), true, "worktree under an allowlisted root");
  assert.equal(foremanMayActLive(cfg(), "/other"), false, "off the allowlist");
  assert.equal(foremanMayActLive(cfg({ mode: "dry-run" }), "/repo"), false);
  assert.equal(foremanMayActLive(cfg({ enabled: false }), "/repo"), false);
  assert.equal(foremanMayActLive(cfg(), null), false);
  assert.equal(foremanMayActLive(cfg({ repoAllowlist: ["/repofoo"] }), "/repo"), false, "no partial-token match");
  assert.equal(
    foremanMayActLive(cfg({ repoAllowlist: ["/repo/"] }), "/repo"),
    true,
    "trailing-slash allowlist entry still matches",
  );
  assert.equal(
    foremanMayActLive(cfg({ repoAllowlist: ["/repo/"] }), "/repo/worktrees/x"),
    true,
    "trailing-slash entry still matches a subdir",
  );
  assert.equal(foremanMayActLive(cfg(), "/repo/"), true, "trailing-slash cwd still matches");
});

/**
 * The bug this covers: live mode kept asking for confirmation on every session in the
 * dashboard. Every real checkout is a WORKTREE parked outside the repo (`~/.treehouse/...`,
 * the daemon's worktrees dir), so a cwd-prefix allowlist said "no" about the very repo
 * the human had allowlisted - and Foreman drafted, forever, everywhere.
 */
test("foremanMayActLive: a worktree of an allowlisted repo may send, wherever it sits", () => {
  const wt = "/Users/me/.treehouse/ai-harness-c7356c/14/ai-harness";
  assert.equal(foremanMayActLive(cfg(), wt, "/repo"), true, "worktree OF an allowlisted repo");
  assert.equal(
    foremanMayActLive(cfg(), "/var/folders/tmp/worktrees/abc", "/repo/"),
    true,
    "trailing-slash repo root still matches",
  );
  // The repo identity is what's allowlisted - not the worktree's throwaway location.
  assert.equal(foremanMayActLive(cfg(), wt, "/other-repo"), false, "worktree of an OFF-list repo");
  assert.equal(foremanMayActLive(cfg(), wt, null), false, "no repo root, off-list cwd: no send");
  assert.equal(foremanMayActLive(cfg({ mode: "dry-run" }), wt, "/repo"), false, "mode still rules");
  assert.equal(foremanMayActLive(cfg({ enabled: false }), wt, "/repo"), false, "enabled still rules");
  assert.equal(
    foremanMayActLive(cfg({ repoAllowlist: ["/repofoo"] }), wt, "/repo"),
    false,
    "no partial-token match on the repo root either",
  );
  // Fail-closed: an omitted repoRoot degrades to the cwd rule, never grants a send.
  assert.equal(foremanMayActLive(cfg(), wt), false, "absent repoRoot can't grant");
});

test("applyVerdict: live answer sends first, then records the answered note", async () => {
  const calls: string[] = [];
  const actions: ForemanActions = {
    putNote: async () => (calls.push("putNote"), {}),
    sendText: async () => (calls.push("sendText"), {}),
    selectOption: async () => (calls.push("selectOption"), {}),
    resolveReview: async () => (calls.push("resolveReview"), {}),
    logGateReply: async () => (calls.push("logGateReply"), {}),
  };
  const plan = planFromVerdict(ANSWER, ctx(), true);
  await applyVerdict(actions, ctx(), plan);
  assert.deepEqual(calls, ["sendText", "putNote"]);
});

test("applyVerdict: a failed send records purpose only (no marker) and rethrows", async () => {
  const notes: SetNote[] = [];
  const actions: ForemanActions = {
    putNote: async (_id: string, patch: SetNote) => (notes.push(patch), {}),
    sendText: async () => {
      throw new Error("pane gone");
    },
    selectOption: async () => ({}),
    resolveReview: async () => ({}),
    logGateReply: async () => ({}),
  };
  const plan = planFromVerdict(ANSWER, ctx(), true);
  await assert.rejects(applyVerdict(actions, ctx(), plan), /pane gone/);
  // Purpose is preserved (as a non-draft skip), but the answered disposition +
  // handledMarker are NOT stamped, so the worker's idempotency check lets the next
  // loop retry.
  assert.deepEqual(notes, [{ purpose: ANSWER.purpose, disposition: "skipped" }]);
});

test("applyVerdict: dry-run draft writes the note and sends nothing", async () => {
  const calls: string[] = [];
  const actions: ForemanActions = {
    putNote: async () => (calls.push("putNote"), {}),
    sendText: async () => (calls.push("sendText"), {}),
    selectOption: async () => (calls.push("selectOption"), {}),
    resolveReview: async () => (calls.push("resolveReview"), {}),
    logGateReply: async () => (calls.push("logGateReply"), {}),
  };
  await applyVerdict(actions, ctx(), planFromVerdict(ANSWER, ctx(), false));
  assert.deepEqual(calls, ["putNote"]);
});

test("extractVerdict unwraps the claude -p envelope and fenced JSON", () => {
  const verdict = {
    purpose: "p",
    classification: "access",
    action: "answer",
    answer: { text: "Approve - go ahead." },
  };
  const envelope = JSON.stringify({ result: "```json\n" + JSON.stringify(verdict) + "\n```" });
  const got = extractVerdict(envelope);
  assert.equal(got?.action, "answer");
  assert.equal(got?.answer?.text, "Approve - go ahead.");
});

test("extractVerdict handles a bare object and rejects invalid output", () => {
  const bare = '{"purpose":"p","classification":"other","action":"skip"}';
  assert.equal(extractVerdict(bare)?.action, "skip");
  assert.equal(extractVerdict("not json at all"), null);
  // action=answer without answer.text must fail the schema refine.
  assert.equal(extractVerdict('{"purpose":"p","classification":"other","action":"answer"}'), null);
});

// --- Answering a menu -------------------------------------------------------------
//
// The production failure this locks down, in one line: the reviewer said "Use option 2:
// make the tray uninstall durable", the child recorded "Revert it; rely on master switch"
// (row 1, the default), and shipped the revert. Nothing was broken - the model judged, the
// send succeeded, the note said "answered". The reply was simply typed at a widget that
// does not read text, and the Enter took whatever was highlighted. So the rule here is that
// a menu is answered by naming a ROW, and anything less is handed back to the human.

/** The menu from the session that produced the bug, as its pane rendered it. */
const TRAY_MENU = {
  options: [
    { number: 1, label: "Revert it; rely on master switch (recommended)" },
    { number: 2, label: "Make the tray uninstall durable" },
    { number: 3, label: "Keep links, disable config only" },
  ],
  highlighted: 1,
};

/** The verdict the reviewer actually returned that day, now naming the row it meant. */
const MENU_ANSWER: Verdict = {
  purpose: "Custom-skills branch parked at the review gate over the tray's uninstall scope.",
  classification: "implementation",
  action: "answer",
  answer: {
    text: "Use option 2: the tray's uninstall should be durable, via the daemon's config API.",
    submit: true,
    option: { number: 2, label: "Make the tray uninstall durable" },
  },
};

test("a menu answer sends the chosen row, not the reviewer's prose", () => {
  const plan = planFromVerdict(MENU_ANSWER, ctx({ menu: TRAY_MENU }), true);
  assert.equal(plan.send?.option?.number, 2);
  assert.equal(plan.note.disposition, "answered");
  // The rationale still rides along for the byline, but the DECISION is the row.
  assert.match(plan.send?.text ?? "", /durable/);
});

test("the card names the row, so the audit trail is the decision and not the prose", () => {
  const plan = planFromVerdict(MENU_ANSWER, ctx({ menu: TRAY_MENU }), true);
  assert.equal(plan.note.lastAction, "answered: option 2. Make the tray uninstall durable");
});

test("prose with no row is escalated rather than typed at a menu", () => {
  // THE REGRESSION TEST. `ANSWER` carries no `option`; with a menu up, the old path typed
  // it and the menu confirmed row 1. Nothing may be sent here.
  const plan = planFromVerdict(ANSWER, ctx({ menu: TRAY_MENU }), true);
  assert.equal(plan.send, null);
  assert.equal(plan.note.disposition, "escalated");
  // The judgment is not thrown away - it reaches the human as the recommendation.
  assert.equal(plan.note.recommendation, ANSWER.answer?.text);
});

test("a row the menu doesn't have is escalated, never approximated", () => {
  const v = {
    ...MENU_ANSWER,
    answer: { ...MENU_ANSWER.answer!, option: { number: 9, label: "Something else" } },
  };
  const plan = planFromVerdict(v, ctx({ menu: TRAY_MENU }), true);
  assert.equal(plan.send, null);
  assert.match(plan.note.lastAction ?? "", /doesn't have/);
});

test("a row whose label disagrees with the screen is escalated", () => {
  // The number is right but the label is another row's: the reviewer miscounted, or read a
  // menu that has since repainted. Delivering row 2 anyway would answer a question nobody
  // asked - which is the exact shape of the original bug, just arrived at differently.
  const v = {
    ...MENU_ANSWER,
    answer: { ...MENU_ANSWER.answer!, option: { number: 2, label: "Keep links, disable config only" } },
  };
  const plan = planFromVerdict(v, ctx({ menu: TRAY_MENU }), true);
  assert.equal(plan.send, null);
  assert.match(plan.note.lastAction ?? "", /isn't what that row says/);
});

test("a multi-select form is declined, not planned as a send that will throw", () => {
  // A form is not answerable by picking a row - Enter ticks a box and the answers reach
  // Claude only when its Submit tab is confirmed - so `selectPaneOption` REFUSES these rows.
  // Its labels parse clean, though, so every other guard here passes and the planner would
  // route a perfectly well-formed verdict into that refusal. The throw is the harm: it exits
  // `processSession` before `recordEpisode`, and the pane capture is the only copy of a
  // terminal ask, so each sweep would spend a review, lose the question, and repeat.
  const form = {
    options: [
      { number: 1, label: "Alpha", checked: false },
      { number: 2, label: "Beta", checked: false },
    ],
    highlighted: 1,
    multiSelect: true as const,
  };
  const v: Verdict = {
    ...MENU_ANSWER,
    answer: { ...MENU_ANSWER.answer!, option: { number: 1, label: "Alpha" } },
  };
  const plan = planFromVerdict(v, ctx({ menu: form }), true);
  assert.equal(plan.send, null, "nothing may be sent at a form");
  assert.equal(plan.note.disposition, "escalated");
  assert.match(plan.note.lastAction ?? "", /multi-select form/);
  // The judgment still reaches the human, who can actually fill the form in.
  assert.equal(plan.note.recommendation, v.answer?.text);
  // And the tier ladder routes up rather than the cheap tier declaring this handled.
  assert.equal(menuBlocksAnswer(v, ctx({ menu: form })), true);
});

test("a hard-wrapped label still matches the row it names", () => {
  // The pane cut the row at the terminal's width; the reviewer copied what it could see. The
  // prefix compare exists for exactly this, and the ambiguity rule below must not cost it.
  const menu = {
    options: [
      { number: 1, label: "Revert it; rely on master switch (recommended)" },
      { number: 2, label: "Make the tray uninstall durable, via the daemon’s config API" },
    ],
    highlighted: 1,
  };
  const v = {
    ...MENU_ANSWER,
    answer: { ...MENU_ANSWER.answer!, option: { number: 2, label: "Make the tray uninstall durable" } },
  };
  assert.equal(planFromVerdict(v, ctx({ menu }), true).send?.option?.number, 2);
});

test("a routine approval on the real permission prompt still SENDS", () => {
  // The menu Foreman meets most, and the direction it exists to automate. The rows are a
  // prefix pair, so every guard on this path runs against them - and a guard that overshoots
  // here doesn't degrade the feature, it deletes it: an `on` fleet would spend a Haiku call,
  // route up, spend an Opus call, and hand a human every routine approval.
  const menu = {
    options: [
      { number: 1, label: "Yes" },
      { number: 2, label: "Yes, and don’t ask again for: curl -s https://example.com" },
      { number: 3, label: "No" },
    ],
    highlighted: 1,
  };
  const v: Verdict = {
    ...ACCESS_ANSWER,
    answer: { text: "Approve - fetching a page is routine.", submit: true, option: { number: 1, label: "Yes" } },
  };
  const plan = planFromVerdict(v, ctx({ menu }), true);
  assert.equal(plan.send?.option?.number, 1, "the approve row must be deliverable");
  assert.equal(plan.note.disposition, "answered");
  assert.equal(menuBlocksAnswer(v, ctx({ menu })), false, "and the tier ladder must not route it up");
});

test("a wrapped label that fits two rows is refused - the wrap can't be told from a miscount", () => {
  // The permission prompt's rows are a prefix pair ("Yes" / "Yes, and don't ask again for: X"),
  // so "the pane cut row 1 short" and "the reviewer miscounted onto row 2" are the SAME string
  // to a prefix compare - it has no terminal width to tell them apart. The label is the only
  // check on the number, so when it can't discriminate it has checked nothing, and confirming
  // a persistent grant nobody verified is worse than going quiet and asking.
  const menu = {
    options: [{ number: 1, label: "Yes" }, { number: 2, label: "Yes, and don’t ask again for: npm test" }],
    highlighted: 1,
  };
  const v = {
    ...MENU_ANSWER,
    classification: "access" as const,
    answer: { text: "Approve - running tests is routine.", submit: true, option: { number: 2, label: "Yes, and don't ask again" } },
  };
  const plan = planFromVerdict(v, ctx({ menu }), true);
  assert.equal(plan.send, null);
  assert.equal(plan.note.disposition, "escalated");
  assert.match(plan.note.lastAction ?? "", /reads the same as another row/);
});

test("with no menu on screen, prose is still typed as it always was", () => {
  // The majority path - a parked no-mistakes gate, an ordinary question - must not regress
  // into escalating for want of an option that has nothing to select.
  const plan = planFromVerdict(ANSWER, ctx({ menu: null }), true);
  assert.equal(plan.send?.text, ANSWER.answer?.text);
  assert.equal(plan.send?.option, undefined);
  assert.equal(plan.note.disposition, "answered");
});

test("an option volunteered against no menu is ignored, not sent", () => {
  const plan = planFromVerdict(MENU_ANSWER, ctx({ menu: null }), true);
  assert.equal(plan.send?.option, undefined);
  assert.equal(plan.send?.text, MENU_ANSWER.answer?.text);
});

test("an input review is answered over the API even while a menu is on the pane", () => {
  // `pickChannel` routes to the review, which no keystroke reaches - so the menu is not
  // this answer's surface and must not gate it.
  const plan = planFromVerdict(ANSWER, ctx({ menu: TRAY_MENU, inputReviewId: "r1" }), true);
  assert.equal(plan.send?.channel, "review");
  assert.equal(plan.send?.option, undefined);
});

test("a menu answer in dry-run drafts and selects nothing", () => {
  const plan = planFromVerdict(MENU_ANSWER, ctx({ menu: TRAY_MENU }), false);
  assert.equal(plan.send, null);
  assert.equal(plan.note.disposition, "pending");
});

test("applyVerdict selects the row and never types at a menu", async () => {
  const calls: string[] = [];
  const actions: ForemanActions = {
    putNote: async () => (calls.push("putNote"), {}),
    sendText: async () => (calls.push("sendText"), {}),
    selectOption: async () => (calls.push("selectOption"), {}),
    resolveReview: async () => (calls.push("resolveReview"), {}),
    logGateReply: async () => (calls.push("logGateReply"), {}),
  };
  const c = ctx({ menu: TRAY_MENU });
  await applyVerdict(actions, c, planFromVerdict(MENU_ANSWER, c, true));
  assert.deepEqual(calls, ["selectOption", "putNote"]);
});

test("a refused selection leaves the session unanswered and retryable", async () => {
  // The daemon refuses when it can't confirm the row against the live screen. Nothing was
  // confirmed, so this must NOT stamp an answered note - the child is still parked.
  const notes: SetNote[] = [];
  const actions: ForemanActions = {
    putNote: async (_id, patch) => (notes.push(patch), {}),
    sendText: async () => ({}),
    selectOption: async () => {
      throw new Error("the menu changed before the selection could be confirmed");
    },
    resolveReview: async () => ({}),
    logGateReply: async () => ({}),
  };
  const c = ctx({ menu: TRAY_MENU });
  await assert.rejects(applyVerdict(actions, c, planFromVerdict(MENU_ANSWER, c, true)), /menu changed/);
  assert.deepEqual(notes, [{ purpose: MENU_ANSWER.purpose, disposition: "skipped" }]);
});

test("a label that fits two rows is escalated - an ambiguous match may not confirm one", () => {
  // The real permission prompt's rows are a prefix pair, so a reviewer that miscounts
  // between them produces a label that AGREES with the wrong row. The label is the only
  // check on the number; when it can't tell the rows apart it has checked nothing.
  const menu = {
    options: [
      { number: 1, label: "Yes" },
      { number: 2, label: "Yes, and don’t ask again for: curl -s https://example.com" },
      { number: 3, label: "No" },
    ],
    highlighted: 1,
  };
  const v: Verdict = {
    ...MENU_ANSWER,
    answer: { text: "Approve it once.", submit: true, option: { number: 1, label: "Yes, and don't ask again for: curl -s https://example.com" } },
  };
  const plan = planFromVerdict(v, ctx({ menu }), true);
  assert.equal(plan.send, null, "the one-off Yes must not be confirmed for a persistent grant");
  assert.equal(plan.note.disposition, "escalated");
  assert.match(plan.note.lastAction ?? "", /reads the same as another row/);
  // The reviewer's judgment still reaches the human.
  assert.match(plan.note.recommendation ?? "", /Approve it once/);
});

test("the gate byline quotes the row that was delivered, never the prose that wasn't", async () => {
  // `text` is the rationale on a menu - it is never typed. A byline quoting it would put
  // words on the fix card that the child never saw, which is the one fabrication that is
  // invisible downstream.
  const logged: string[] = [];
  const actions: ForemanActions = {
    putNote: async () => ({}),
    sendText: async () => ({}),
    selectOption: async () => ({}),
    resolveReview: async () => ({}),
    logGateReply: async (_id, _gate, text: string) => (logged.push(text), {}),
  };
  const c = ctx({ menu: TRAY_MENU, gate: { runId: "r1", step: "review", findingIds: ["f1"] } });
  await applyVerdict(actions, c, planFromVerdict(MENU_ANSWER, c, true));
  assert.deepEqual(logged, ["Make the tray uninstall durable"]);
});

test("a menu send is logged even with submit false - selecting a row always presses the Enter", async () => {
  // `submit` is a question about typing, and nothing is typed here. Gating the byline on it
  // would drop the author of a reply that did land.
  const logged: string[] = [];
  const actions: ForemanActions = {
    putNote: async () => ({}),
    sendText: async () => ({}),
    selectOption: async () => ({}),
    resolveReview: async () => ({}),
    logGateReply: async (_id, _gate, text: string) => (logged.push(text), {}),
  };
  const v: Verdict = { ...MENU_ANSWER, answer: { ...MENU_ANSWER.answer!, submit: false } };
  const c = ctx({ menu: TRAY_MENU, gate: { runId: "r1", step: "review", findingIds: ["f1"] } });
  await applyVerdict(actions, c, planFromVerdict(v, c, true));
  assert.deepEqual(logged, ["Make the tray uninstall durable"]);
});

test("an unsubmitted PROSE send still logs no byline - it's sitting in the pane, unread", async () => {
  const logged: string[] = [];
  const actions: ForemanActions = {
    putNote: async () => ({}),
    sendText: async () => ({}),
    selectOption: async () => ({}),
    resolveReview: async () => ({}),
    logGateReply: async (_id, _gate, text: string) => (logged.push(text), {}),
  };
  const v: Verdict = { ...ANSWER, answer: { ...ANSWER.answer!, submit: false } };
  const c = ctx({ menu: null, gate: { runId: "r1", step: "review", findingIds: ["f1"] } });
  await applyVerdict(actions, c, planFromVerdict(v, c, true));
  assert.deepEqual(logged, []);
});

// --- Which tier can answer a menu --------------------------------------------------

test("menuBlocksAnswer: an answer naming no row is blocked by a menu, so the ladder can route up", () => {
  // The Tier 1 router's schema has no `option` field at all, so every answer it reaches on a
  // menu lands here. Blocked means "this tier can't deliver it", not "a human is needed".
  assert.equal(menuBlocksAnswer(ANSWER, ctx({ menu: TRAY_MENU })), true);
  assert.equal(menuBlocksAnswer(MENU_ANSWER, ctx({ menu: TRAY_MENU })), false, "a named row delivers");
});

test("menuBlocksAnswer: nothing is blocked when the menu isn't the answer's surface", () => {
  assert.equal(menuBlocksAnswer(ANSWER, ctx({ menu: null })), false, "no menu: prose is typed");
  assert.equal(
    menuBlocksAnswer(ANSWER, ctx({ menu: TRAY_MENU, inputReviewId: "r1" })),
    false,
    "an input review is answered over the API; no keystroke reaches the menu",
  );
  assert.equal(
    menuBlocksAnswer(ANSWER, ctx({ menu: TRAY_MENU, canSend: false })),
    false,
    "no channel at all is the planner's escalation, not a route-up",
  );
  const escalate: Verdict = { purpose: "p", classification: "other", action: "escalate" };
  assert.equal(menuBlocksAnswer(escalate, ctx({ menu: TRAY_MENU })), false, "only an ANSWER can be blocked");
});
