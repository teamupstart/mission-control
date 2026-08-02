import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  episodeFromPlan,
  menuBlocksAnswer,
  planFromVerdict,
} from "../src/server/foreman/verdict.ts";
import type { ReviewContext, Verdict } from "../src/server/foreman/verdict.ts";
import { cheapActionOf, classifyDivergence } from "../src/server/foreman/triage.ts";
import type { TriageOutcome } from "../src/server/foreman/triage.ts";
import type { Pending } from "../src/server/foreman/pending.ts";
import { RecordEpisodeSchema } from "../src/shared/protocol.ts";

// What is at stake: `shadow` is the posture whose entire stated purpose is MEASUREMENT -
// the panel offers "run the cheap tier alongside, measure it" - and until this phase the
// measurement's only sink was `console.log`. The worker spent a second model call per
// decision, classified the divergence, wrote it to stdout, and dropped it on the next
// line. Nobody who was not tailing the worker could answer the one question the posture
// exists to answer: is the cheap tier safe to turn on?
//
// So what is pinned here is that the measurement reaches the ROW, that it is absent
// exactly where no measurement was taken, and - the one most easily got wrong - that it
// did not achieve this by corrupting `tier`.
//
// `shadowBoth` itself is not importable: `worker.ts` calls `main()` at import, which is
// the same reason `episodeFromPlan` was extracted from `processSession` in the first
// place. What is tested is therefore the seam the worker threads its measurement
// through, the delivery gate and pure functions that produce it, and a narrow source
// contract pinning that normalization at the call site.

const MENU = {
  options: [
    { number: 1, label: "Yes" },
    { number: 2, label: "No" },
  ],
  highlighted: 1,
};

function terminalPending(over: Partial<Pending> = {}): Pending {
  return {
    situation: "terminal-pane",
    surface: "terminal",
    question: "Claude needs your permission to run the tests",
    inputReviewId: null,
    canSend: true,
    marker: "await:1700",
    ...over,
  };
}

function ctxFor(p: Pending, menu: ReviewContext["menu"] = null): ReviewContext {
  return {
    sessionId: "s1",
    promptMarker: p.marker,
    inputReviewId: p.inputReviewId,
    canSend: p.canSend,
    menu,
  };
}

function verdict(over: Partial<Verdict> = {}): Verdict {
  return {
    purpose: "Approving a test run.",
    classification: "routine-access",
    action: "escalate",
    brief: "Reads outside the worktree.",
    confidence: 0.6,
    ...over,
  } as Verdict;
}

/** One episode as the worker would record it, with or without a shadow measurement. */
function record(
  shadow?: {
    cheapAction: "answer" | "escalate" | "skip" | "route-up";
    divergence: "deferred" | "agree" | "cheap-over-eager" | "cheap-too-cautious" | "minor";
  },
  inputs: { pending?: Pending; ctx?: ReviewContext; verdict?: Verdict } = {},
) {
  const pending = inputs.pending ?? terminalPending();
  const ctx = inputs.ctx ?? ctxFor(pending);
  const v = inputs.verdict ?? verdict();
  const plan = planFromVerdict(v, ctx, false);
  return episodeFromPlan({ pending, ctx, pane: "$ npm test", verdict: v, tier: 2, shadow, plan });
}

function shadowRecord(cheap: TriageOutcome, fullVerdict: Verdict, ctx: ReviewContext) {
  const cheapUnderOn =
    cheap.kind === "dispose" && menuBlocksAnswer(cheap.verdict, ctx)
      ? ({ kind: "route-up", reason: "menu-needs-a-row" } as const)
      : cheap;
  return record(
    {
      cheapAction: cheapActionOf(cheapUnderOn),
      divergence: classifyDivergence(cheapUnderOn, fullVerdict),
    },
    { ctx, verdict: fullVerdict },
  );
}

// ---- the measurement reaches the row --------------------------------------------------

test("a shadow decision records what the cheap tier would have done, and how it compared", () => {
  const ep = record({ cheapAction: "answer", divergence: "cheap-over-eager" });
  assert.equal(ep.cheapAction, "answer");
  assert.equal(ep.divergence, "cheap-over-eager");
});

// THE one that matters. `tier` answers "which tier produced the verdict that was used",
// and under shadow that is always 2 - the full review acts, the cheap tier only watches.
// Rewriting it to 1 to mean "the cheap tier was involved" would make the record claim the
// cheap tier decided something it did not, and would corrupt the existing per-session
// drawer at the same time. The new columns carry the other half; `tier` does not move.
test("a shadow decision still reports the tier whose verdict was actually used", () => {
  const ep = record({ cheapAction: "answer", divergence: "cheap-over-eager" });
  assert.equal(ep.tier, 2, "shadow must not rewrite tier to advertise the cheap tier");
});

// `off` makes no cheap call at all, and under `on` the cheap tier IS the decision, so
// there is no second opinion to compare it against. Null in both cases, and null is the
// claim "not measured" - which is a different thing from "agreed", and the difference is
// the whole value of the column. Writing `agree` here would manufacture evidence for the
// exact question an operator uses this to answer.
test("a posture that takes no measurement writes null for both, never 'agree'", () => {
  const ep = record(undefined);
  assert.equal(ep.cheapAction, null);
  assert.equal(ep.divergence, null);
  assert.notEqual(ep.divergence, "agree");
  // The rest of the record is untouched by the absence.
  assert.equal(ep.tier, 2);
  assert.equal(ep.classification, "routine-access");
});

// The worker POSTs this over HTTP to the daemon, so a field the schema does not admit is
// silently dropped between the measurement and the row - which would look exactly like
// the bug this phase fixes.
test("the measurement survives the wire schema the worker posts through", () => {
  const parsed = RecordEpisodeSchema.parse(record({ cheapAction: "skip", divergence: "minor" }));
  assert.equal(parsed.cheapAction, "skip");
  assert.equal(parsed.divergence, "minor");
  // And an unmeasured episode still validates, rather than the schema demanding a value
  // that two of the three postures cannot produce.
  assert.ok(RecordEpisodeSchema.safeParse(record(undefined)).success);
});

// ---- the two pure functions that produce it -------------------------------------------

const dispose = (action: Verdict["action"], tier: 0 | 1 = 1): TriageOutcome => ({
  kind: "dispose",
  tier,
  reason: "test",
  verdict: (action === "answer"
    ? { purpose: "p", classification: "other", action, answer: { text: "go", submit: true } }
    : { purpose: "p", classification: "other", action }) as Verdict,
});

test("shadow measures the cheap outcome after the same delivery gate as on", () => {
  const pending = terminalPending();
  const fullVerdict = verdict({ action: "escalate" });
  const cheapAnswer = dispose("answer");

  const menuEpisode = shadowRecord(cheapAnswer, fullVerdict, ctxFor(pending, MENU));
  assert.equal(menuEpisode.cheapAction, "route-up");
  assert.equal(menuEpisode.divergence, "deferred");
  assert.equal(menuEpisode.tier, 2);

  const promptEpisode = shadowRecord(cheapAnswer, fullVerdict, ctxFor(pending, null));
  assert.equal(promptEpisode.cheapAction, "answer");
  assert.equal(promptEpisode.divergence, "cheap-over-eager");
  assert.equal(promptEpisode.tier, 2);

  const worker = readFileSync(new URL("../src/server/foreman/worker.ts", import.meta.url), "utf8");
  assert.match(
    worker,
    /const cheapUnderOn =\s+cheap\.kind === "dispose" && menuBlocksAnswer\(cheap\.verdict, ctx\)[\s\S]*?classifyDivergence\(cheapUnderOn, r\.verdict\)[\s\S]*?cheapActionOf\(cheapUnderOn\)/,
  );
});

test("cheapActionOf names the cheap tier's own action, including its decline", () => {
  assert.equal(cheapActionOf(dispose("answer")), "answer");
  assert.equal(cheapActionOf(dispose("escalate")), "escalate");
  assert.equal(cheapActionOf(dispose("skip")), "skip");
  assert.equal(cheapActionOf({ kind: "route-up", reason: "tier1-unparseable" }), "route-up");
});

// Stored beside the divergence rather than derived from it, because the comparison throws
// away which side did what: `minor` says the two disagreed without saying whether the
// cheap tier wanted to escalate or to skip. An operator deciding whether to trust it is
// reading its behaviour, not only its agreement rate - so both halves are kept.
test("the cheap action is not recoverable from the divergence alone", () => {
  const opus = verdict({ action: "escalate" });
  const cheapSkipped = dispose("skip");
  assert.equal(classifyDivergence(cheapSkipped, opus), "minor");
  // Same divergence, different cheap behaviour - so the row needs cheapAction to tell
  // these apart, and this is why it is a column rather than a derivation.
  assert.equal(cheapActionOf(cheapSkipped), "skip");
});

// A deferral is the cheap tier declining to decide. Counting it as agreement would
// flatter the cheap tier by exactly the share of prompts it refused to handle - which on
// a cautious router is most of them.
test("a deferral is recorded as its own outcome, not as agreement", () => {
  const routed: TriageOutcome = { kind: "route-up", reason: "tier1-failed" };
  assert.equal(classifyDivergence(routed, verdict({ action: "answer" })), "deferred");
  const ep = record({
    cheapAction: cheapActionOf(routed),
    divergence: classifyDivergence(routed, verdict({ action: "answer" })),
  });
  assert.equal(ep.divergence, "deferred");
  assert.equal(ep.cheapAction, "route-up");
});
