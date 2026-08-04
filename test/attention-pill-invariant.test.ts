/**
 * What is at stake: the two amber figures in the topbar must not contradict each other.
 *
 * The pulse renders `N need you` (sessions in an attention tone, App's `summarize`) beside
 * `N to answer` (the attention fold's total, which is what the inbox draws). They are
 * different UNITS of one set on purpose - how many agents are blocked, versus how many
 * replies it takes to unblock them - so one session holding three questions reads
 * `1 need you / 3 to answer` and that is correct.
 *
 * What is NOT correct, and what this file exists to prevent, is them being different SETS.
 * `1 need you / 0 to answer` is a header that says a thing is stuck and simultaneously
 * offers an empty inbox to fix it in, and it was reachable three ways before the fold grew
 * its `session_blocked` backstop:
 *
 *   - a session parked on a permission prompt, when it was not an ensemble member
 *   - a session whose `awaiting_input` came from a hook, which files no review
 *   - the sub-second window where `pendingReviews` has risen and the review row has not
 *
 * So the property is one-directional and total: EVERY session the fleet paints amber owes at
 * least one answer. Nothing here asserts equality - that would be the bug the units split was
 * introduced to avoid.
 *
 * `summarize` lives in App.tsx, which this runner cannot import (JSX, and the module reaches
 * the DOM). It is re-derived here from the same `stateDisplay` call it makes, and the last
 * test in this file scans App's source to pin that they stay the same derivation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ReviewItem, Session, SessionState } from "../src/shared/types.ts";
import { foldAttention } from "../src/web/lib/attention.ts";
import { stateDisplay } from "../src/web/lib/format.ts";
import { mkEnsembleSummary, mkMemberSession, mkSession } from "./helpers/session-fixture.ts";

/** App's `summarize`, re-derived. Pinned to the original by the source scan below. */
function needYou(sessions: Session[]): number {
  return sessions.filter((s) => stateDisplay(s).tone === "attention").length;
}

function toAnswer(sessions: Session[], reviews: ReviewItem[] = [], ensembles = []): number {
  return foldAttention({ sessions, reviews, ensembles }).total;
}

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

const DIALOG = { options: [], highlighted: 0, prompt: "Allow?" } as Session["paneDialog"];
const STATES: SessionState[] = [
  "starting",
  "idle",
  "working",
  "awaiting_input",
  "awaiting_review",
  "stopping",
  "exited",
];

test("every amber session owes at least one answer, across the whole state matrix", () => {
  // The exhaustive version of the property. Every combination of lifecycle state, review
  // presence, menu presence and state-confidence, as a one-session fleet - which is where the
  // divergences all lived, and where a future precedence change would land first.
  const failures: string[] = [];
  for (const state of STATES) {
    for (const hasReview of [false, true]) {
      for (const hasDialog of [false, true]) {
        for (const stateConfirmed of [false, true]) {
          const session = mkSession({
            id: "s-1",
            state,
            stateConfirmed,
            pendingReviews: hasReview ? 1 : 0,
            paneDialog: hasDialog ? DIALOG : null,
          });
          const reviews = hasReview ? [review({ id: "r-1", sessionId: "s-1" })] : [];
          const amber = needYou([session]);
          const owed = toAnswer([session], reviews);
          if (owed < amber) {
            failures.push(
              `state=${state} review=${hasReview} dialog=${hasDialog} confirmed=${stateConfirmed}` +
                ` -> ${amber} need you but only ${owed} to answer`,
            );
          }
        }
      }
    }
  }
  assert.deepEqual(failures, [], `the inbox cannot open empty under a count:\n${failures.join("\n")}`);
});

test("the three historical inversions are each closed", () => {
  // Named individually so a regression says WHICH one came back, rather than pointing at the
  // matrix above and leaving the reader to bisect it.

  // (a) A non-ensemble session on a permission prompt. Excluded by the old fold's
  // `s.task?.ensemble &&` filter; amber on the fleet the whole time.
  const plain = mkSession({ id: "s-plain", paneDialog: DIALOG });
  assert.equal(needYou([plain]), 1);
  assert.equal(toAnswer([plain]), 1, "a plain session's menu now earns a row");

  // (b) A hook-reported `awaiting_input` with no review filed. The Claude `Notification` and
  // Codex `PermissionRequest` translators are the only writers of this state and neither
  // creates a review, so this is the COMMON case, not an edge one.
  const hooked = mkSession({ id: "s-hook", state: "awaiting_input", activity: "Needs approval" });
  assert.equal(needYou([hooked]), 1);
  assert.equal(toAnswer([hooked]), 1, "a bare lifecycle state now earns a row");

  // (c) The SSE drift window: `session_upsert` carrying a raised `pendingReviews` lands, and
  // the `review_upsert` carrying the row itself has not yet. Two frames, two `useState` maps,
  // and a render can happen in between.
  const drifting = mkSession({ id: "s-drift", pendingReviews: 1 });
  assert.equal(needYou([drifting]), 1);
  assert.equal(toAnswer([drifting], []), 1, "the backstop covers the frame the row misses");
});

test("the units still differ, which is the whole reason there are two segments", () => {
  // Guarding the invariant must not collapse the two figures into one. A session holding
  // three questions is ONE blocked agent and THREE replies, and the segments say so.
  const asking = mkSession({ id: "s-ask", pendingReviews: 3 });
  const reviews = [
    review({ id: "r-1", sessionId: "s-ask", createdAt: 1000 }),
    review({ id: "r-2", sessionId: "s-ask", createdAt: 2000 }),
    review({ id: "r-3", sessionId: "s-ask", createdAt: 3000 }),
  ];
  assert.equal(needYou([asking]), 1);
  assert.equal(toAnswer([asking], reviews), 3);
});

test("run-level obligations raise only `to answer`, because they are not sessions", () => {
  // The legitimate one-way gap. An ensemble parked on a decision is a RUN waiting on you; no
  // session is amber for it, and inventing one would double-count the members.
  const ensembles = [
    mkEnsembleSummary({ id: "run-decide", status: "awaiting_decision" }),
    mkEnsembleSummary({ id: "run-stuck", status: "finalizing", error: "ref vanished" }),
  ];
  const fleet = [mkSession({ id: "s-busy", state: "working" })];
  assert.equal(needYou(fleet), 0);
  assert.equal(foldAttention({ sessions: fleet, reviews: [], ensembles }).total, 2);
});

test("a mixed fleet holds the invariant with every population at once", () => {
  const sessions = [
    mkSession({ id: "s-quiet", state: "idle" }),
    mkSession({ id: "s-busy", state: "working" }),
    mkSession({ id: "s-hook", state: "awaiting_input", activity: "Needs approval: Bash" }),
    mkSession({ id: "s-menu", name: "Menu", paneDialog: DIALOG }),
    mkSession({ id: "s-ask", name: "Asking", pendingReviews: 2 }),
    mkMemberSession({ id: "s-member", paneDialog: DIALOG, link: { ordinal: 2 } }),
    // Settling: counted by neither, which is the other half of making the sets agree.
    mkSession({ id: "s-gone", state: "exited", pendingReviews: 1 }),
    mkSession({ id: "s-drain", state: "stopping", pendingReviews: 1 }),
  ];
  const reviews = [
    review({ id: "r-1", sessionId: "s-ask", createdAt: 1000 }),
    review({ id: "r-2", sessionId: "s-ask", createdAt: 2000 }),
    review({ id: "r-gone", sessionId: "s-gone" }),
    review({ id: "r-drain", sessionId: "s-drain" }),
  ];
  const ensembles = [mkEnsembleSummary({ id: "run-decide", status: "awaiting_decision" })];

  // amber: s-hook, s-menu, s-ask, s-member. Not s-gone (exited) or s-drain (stopping).
  assert.equal(needYou(sessions), 4);
  const result = foldAttention({ sessions, reviews, ensembles });
  // 1 decision + 2 questions from s-ask + 2 menus + 1 blocked = 6.
  assert.equal(result.total, 6);
  assert.ok(result.total >= needYou(sessions));
  assert.deepEqual(
    result.items.map((i) => i.id),
    [
      "ensemble-decision:run-decide",
      "reviews:s-ask",
      // "Menu" sorts before "run-1 candidate 2" - the dialogs order by name, then id.
      "dialog:s-menu",
      "dialog:s-member",
      "blocked:s-hook",
    ],
    "sections never interleave, and the settling sessions contribute nothing",
  );
});

test("App's `summarize` is still the derivation this file re-implements", () => {
  // The one seam. If App stops counting `stateDisplay(...).tone === "attention"`, every
  // assertion above is measuring something the topbar no longer renders.
  const app = readFileSync(fileURLToPath(new URL("../src/web/App.tsx", import.meta.url)), "utf8");
  const summarize = app.slice(app.indexOf("function summarize("));
  assert.ok(summarize, "summarize has been renamed or removed");
  assert.match(summarize, /const tone = stateDisplay\(s\)\.tone;/);
  assert.match(summarize, /if \(tone === "attention"\) attention\+\+;/);
  // And the fold is what feeds the segment beside it.
  assert.match(app, /inbox=\{attention\.total\}/);
});
