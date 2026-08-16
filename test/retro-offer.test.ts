import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { InspectorSummary, Session } from "../src/shared/types.ts";
import type { WorkflowRunSummary } from "../src/shared/workflow.ts";
import {
  retroBackstopOffer,
  retroCallView,
  retroOffer,
  retroOutcome,
} from "../src/web/lib/retro-offer.ts";
import { ActionBar } from "../src/web/components/ActionBar.tsx";
import { CompleteModal } from "../src/web/components/CompleteModal.tsx";
import { mkSession } from "./helpers/session-fixture.ts";
import { LADDER_SUMMARY } from "./helpers/workflow-ladder.ts";
import { hasTooltipStarting, tooltipLabels } from "./helpers/markup.ts";
import { withOverlayHost } from "./helpers/overlay-host.ts";

// WHEN the dashboard offers a retro.
//
// The predicate is the whole feature at this layer: the route already works without any of
// this (phase 2), so everything shipped here is the answer to "is now the moment". Getting it
// wrong in either direction is a real cost - a permanent Retro button is chrome nobody reads,
// and a missing one is a ceremony that never happens.

function inspector(over: Partial<InspectorSummary> = {}): InspectorSummary {
  return {
    prKey: "owner/repo#1",
    url: "https://github.example/owner/repo/pull/1",
    mode: "live",
    open: 0,
    postedOpen: 0,
    round: 1,
    lastReviewedAt: 1_700_000_000_000,
    failed: false,
    ...over,
  };
}

/** A session at the moment the plan chose: reviewed pull request, corrections behind it. */
function reviewed(over: Partial<Session> = {}): Session {
  return mkSession({
    prUrl: "https://github.example/owner/repo/pull/1",
    inspector: inspector(),
    retro: { reasons: ["corrections"] },
    ...over,
  });
}

const run = (over: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary =>
  ({ ...LADDER_SUMMARY, ...over });

test("a session nobody corrected and whose review found nothing gets no offer", () => {
  // The conditioning rule, stated as its negative. A clean run with no corrections has
  // nothing to catalogue, so even at the exact moment the plan chose there is no prompt.
  const session = reviewed({ retro: undefined });
  assert.equal(retroOffer(session, run({ gate: "clean" })), null);
  assert.equal(retroBackstopOffer(session), null);
});

test("a worthy session is offered the retro once its run's gate reads clean", () => {
  const offer = retroOffer(reviewed(), run({ gate: "clean" }));
  assert.equal(offer?.label, "Run retro");
  assert.deepEqual(offer?.reasons, ["corrections"]);
});

test("a worthy session mid-review is not offered one", () => {
  // The gate is the moment, not the worthiness. `findings` means the Inspector is still
  // waiting on fixes, and a retrospective delivered there would interrupt the work it is
  // supposed to be about.
  const session = reviewed({ inspector: inspector({ open: 2 }) });
  assert.equal(retroOffer(session, run({ gate: "findings" })), null);
});

test("a session with no workflow falls back to its own Inspector chip", () => {
  // The universal predicate: PR present, reviewed, nothing outstanding. Most sessions never
  // bind a workflow at all, so without this arm the offer would be a workflow feature.
  assert.ok(retroOffer(reviewed(), null));
  // A pull request the Inspector never adopted is not evidence of a finished review - it is
  // evidence the PR came from somewhere else, which is what a null summary means.
  assert.equal(retroOffer(reviewed({ inspector: null }), null), null);
  // Adopted but not yet looked at.
  assert.equal(retroOffer(reviewed({ inspector: inspector({ round: 0 }) }), null), null);
  // Reviewed, but the last attempt errored - "clean" is not what that chip says.
  assert.equal(retroOffer(reviewed({ inspector: inspector({ failed: true }) }), null), null);
});

test("a dry-run review still counts as clean", () => {
  // Dry run is the operator's own choice not to post, and the chip calls it clean by the
  // same rule. A retro conditioned on posted comments would silently never fire for anyone
  // running the Inspector in dry-run.
  assert.ok(retroOffer(reviewed({ inspector: inspector({ mode: "dry-run" }) }), null));
});

test("a pull request that merged before the gate cleared keeps the offer", () => {
  // The auto-merge backstop the source plan asks for. A PR that merges early leaves the RUN
  // blocked on `inspector_pr_closed`, while the session's own review outcome is unchanged
  // and still says the findings were addressed. Reading only the gate would withdraw the
  // offer at exactly the moment it is most likely to be wanted.
  assert.ok(retroOffer(reviewed(), run({ gate: "blocked" })));
});

test("the offer explains itself, naming the reason it is being made", () => {
  const both = retroOffer(reviewed({ retro: { reasons: ["corrections", "findings"] } }), null);
  assert.match(both!.tooltip, /up to 3 repository memories/);
  assert.match(both!.tooltip, /nothing is written or committed until you do/);
  assert.match(
    both!.tooltip,
    /Offered because you corrected it during the work, and GitHub Inspector raised findings/,
  );
});

test("a reason this build does not know still explains the offer it is attached to", () => {
  // `RetroReason` is display vocabulary a newer daemon may extend, and the summary reaching
  // an older dashboard must not produce a button with a dangling "Offered because ." on it.
  const future = reviewed({
    retro: { reasons: ["something-new" as unknown as "corrections"] },
  });
  const offer = retroOffer(future, null);
  assert.ok(offer, "an unrecognised reason is still a reason");
  assert.match(offer!.tooltip, /Offered because this session has something worth cataloguing\./);
});

test("the Complete backstop drops the timing condition and keeps the worthiness one", () => {
  // A scout or a spike never opens a pull request, so it never satisfies either arm above -
  // and the Complete dialog is the last time anybody looks at it.
  const noPr = mkSession({ prUrl: null, inspector: null, retro: { reasons: ["corrections"] } });
  assert.equal(retroOffer(noPr, null), null);
  const backstop = retroBackstopOffer(noPr);
  assert.equal(backstop?.label, "Run a retro first");
  assert.match(backstop!.tooltip, /The task stays open and this session stays alive/);
});

test("the two success arms are reported as the different next moves they are", () => {
  assert.match(retroOutcome({ kind: "delivered" }), /Retro sent/);
  assert.match(retroOutcome({ kind: "dispatched" }), /filed in the backlog/);
});

// ---- the request's own state ------------------------------------------------------------

test("a retro in flight disables the control for that session and no other", () => {
  const sending = { sessionId: "s1", status: "sending" as const, message: null };
  assert.deepEqual(retroCallView(sending, "s1"), {
    sending: true,
    notice: null,
    error: null,
  });
  // The defect this replaces, in one line. The state lived on a per-RUN panel as a bare
  // boolean, so a run change while a request was in flight left the next run's ladder
  // reading "Sending…" for a request it had never made. Keyed by session, the answer for
  // anyone else is simply no.
  assert.deepEqual(retroCallView(sending, "s2"), {
    sending: false,
    notice: null,
    error: null,
  });
  assert.deepEqual(retroCallView(null, "s1"), { sending: false, notice: null, error: null });
  // A surface with no session in scope - the ladder can be rendered without one - must not
  // match a call by accident.
  assert.equal(retroCallView(sending, null).sending, false);
});

test("a settled outcome is only ever shown to the session it is about", () => {
  const sent = { sessionId: "s1", status: "sent" as const, message: "Retro sent" };
  assert.equal(retroCallView(sent, "s1").notice, "Retro sent");
  assert.equal(retroCallView(sent, "s1").error, null);
  assert.equal(retroCallView(sent, "s2").notice, null);

  const failed = { sessionId: "s1", status: "failed" as const, message: "the pane refused" };
  assert.equal(retroCallView(failed, "s1").error, "the pane refused");
  assert.equal(retroCallView(failed, "s1").notice, null);
  assert.equal(retroCallView(failed, "s2").error, null);
  // A settled call never keeps the control disabled - only an in-flight one does.
  assert.equal(retroCallView(sent, "s1").sending, false);
  assert.equal(retroCallView(failed, "s1").sending, false);
});

// ---- what the rows actually draw ---------------------------------------------------------

function bar(session: Session, over: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(ActionBar, {
      session,
      onReset: () => {},
      onToggleQueue: () => {},
      onComplete: () => {},
      onKill: () => {},
      ...over,
    }),
  );
}

test("both ActionBar variants draw Retro at the moment, and neither draws it before", () => {
  const session = reviewed();
  const card = bar(session);
  assert.match(card, /class="btn btn-retro"[^>]*>Run retro</, card);
  const foot = bar(session, { variant: "foot" });
  assert.match(foot, /class="act act-retro"[^>]*>retro</, foot);

  // ABSENT rather than disabled, on both. A greyed-out Retro standing on every card for the
  // whole life of every session says "you could have retrospected", which is the opposite of
  // the message an offer carries.
  const early = reviewed({ retro: undefined });
  assert.doesNotMatch(bar(early), /btn-retro/);
  assert.doesNotMatch(bar(early, { variant: "foot" }), /act-retro/);
});

test("the ActionBar's Retro carries the same sentence the predicate wrote", () => {
  // One wording, from one place. A button whose tooltip was rewritten at the render site is
  // how the console footer and the Board tile start describing the same click differently.
  const offer = retroOffer(reviewed(), null);
  assert.ok(tooltipLabels(bar(reviewed())).includes(offer!.tooltip));
});

test("a workflow run still mid-gate withholds Retro from the bar", () => {
  // The bar reads the run when its host has one, so this is the case that proves the prop is
  // wired rather than ignored: same session, same worthiness, run says not yet.
  const session = reviewed({ inspector: inspector({ open: 3 }) });
  assert.doesNotMatch(bar(session, { workflowRun: run({ gate: "findings" }) }), /btn-retro/);
  assert.match(bar(session, { workflowRun: run({ gate: "clean" }) }), /btn-retro/);
});

test("the Complete dialog offers a retro before completing, and never instead of it", () => {
  const html = renderToStaticMarkup(
    withOverlayHost(
      createElement(CompleteModal, {
        session: mkSession({ retro: { reasons: ["corrections"] }, task: null }),
        tasks: [],
        onClose: () => {},
      }),
    ),
  );
  assert.match(html, /complete-retro/, html);
  assert.ok(
    hasTooltipStarting(html, "Ask this session to review its own transcript"),
    "the backstop has to say what it does",
  );
  // Still a Complete dialog. The retro is the one thing worth doing BEFORE answering it, not
  // a third answer to it.
  assert.match(html, /Complete &amp; close/);

  const unworthy = renderToStaticMarkup(
    withOverlayHost(
      createElement(CompleteModal, {
        session: mkSession({ task: null }),
        tasks: [],
        onClose: () => {},
      }),
    ),
  );
  assert.doesNotMatch(unworthy, /complete-retro/);
});
