/**
 * What is at stake: the `test_evidence_audit` event was written for a year and read by
 * nobody, so the scout report's rollout criterion - first-pass acceptance above 70%, at most
 * 1.5 auditor attempts per run - could not be evaluated at all. This card is the reading, and
 * the failures it can have are all silent: a percentage rendered from an empty population, a
 * rate shown against the wrong denominator, or guidance prose leaking into a surface that is
 * supposed to carry counts.
 *
 * The arithmetic itself is pinned in `workflow-test-evidence-audit.test.ts`. What is pinned
 * here is what a person actually reads off the panel, including the two states a static
 * render is the only cheap way to reach: the daemon has not answered, and the daemon has
 * answered that nothing has happened yet. Those two must never render alike - "unknown" and
 * "no attempts recorded" lead an operator to opposite conclusions about their fleet.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  TestEvidenceReadinessCard,
  formatAuditRate,
  meetsTarget,
  sliceIdentity,
  sliceLabel,
} from "../src/web/components/TestEvidenceReadinessCard.tsx";
import type { TestEvidenceAuditAggregate } from "../src/shared/workflow.ts";

const EMPTY: TestEvidenceAuditAggregate = {
  attempts: 0,
  runs: 0,
  attemptsPerRun: null,
  malformed: 0,
  truncated: false,
  scanLimit: 2000,
  oldestAt: null,
  newestAt: null,
  firstSubmissionAccepted: { count: 0, total: 0, rate: null },
  attemptFailures: { count: 0, total: 0, rate: null },
  rejectionCategories: [
    { category: "visual_artifact", failures: { count: 0, total: 0, rate: null } },
    { category: "focused_execution", failures: { count: 0, total: 0, rate: null } },
    { category: "downstream_proof", failures: { count: 0, total: 0, rate: null } },
    { category: "other", failures: { count: 0, total: 0, rate: null } },
  ],
  readiness: {
    withoutImages: { count: 0, total: 0, rate: null },
    withoutTextArtifacts: { count: 0, total: 0, rate: null },
    withoutChecks: { count: 0, total: 0, rate: null },
    transcriptTruncated: { count: 0, total: 0, rate: null },
    checkOmittedBytes: 0,
    transcriptOmittedHeadBytes: 0,
  },
  possibleOverreach: { count: 0, total: 0, rate: null },
  slices: [],
  slicesOmitted: 0,
};

/** A fleet that is missing the report's targets, which is the state worth drawing loudly. */
const MEASURED: TestEvidenceAuditAggregate = {
  ...EMPTY,
  attempts: 5,
  runs: 3,
  attemptsPerRun: 5 / 3,
  oldestAt: 10,
  newestAt: 50,
  firstSubmissionAccepted: { count: 1, total: 3, rate: 1 / 3 },
  attemptFailures: { count: 3, total: 5, rate: 3 / 5 },
  rejectionCategories: [
    { category: "visual_artifact", failures: { count: 2, total: 3, rate: 2 / 3 } },
    { category: "focused_execution", failures: { count: 1, total: 3, rate: 1 / 3 } },
    { category: "downstream_proof", failures: { count: 0, total: 3, rate: 0 } },
    { category: "other", failures: { count: 1, total: 3, rate: 1 / 3 } },
  ],
  readiness: {
    withoutImages: { count: 2, total: 3, rate: 2 / 3 },
    withoutTextArtifacts: { count: 3, total: 3, rate: 1 },
    withoutChecks: { count: 0, total: 3, rate: 0 },
    transcriptTruncated: { count: 1, total: 3, rate: 1 / 3 },
    checkOmittedBytes: 4000,
    transcriptOmittedHeadBytes: 900,
  },
  possibleOverreach: { count: 1, total: 5, rate: 1 / 5 },
  slices: [
    {
      workflowId: "workflow-review",
      workflowVersion: 8,
      personaId: "builtin:test-evidence-auditor",
      personaRevision: 1,
      guidanceDigest: "aaaaaaaaaaaa",
      attempts: 4,
      firstSubmissionAccepted: { count: 0, total: 2, rate: 0 },
      attemptFailures: { count: 3, total: 4, rate: 0.75 },
    },
    {
      workflowId: "workflow-review",
      workflowVersion: 10,
      personaId: "builtin:test-evidence-auditor",
      personaRevision: 2,
      guidanceDigest: "bbbbbbbbbbbb",
      attempts: 1,
      firstSubmissionAccepted: { count: 1, total: 1, rate: 1 },
      attemptFailures: { count: 0, total: 1, rate: 0 },
    },
  ],
};

function render(
  aggregate: TestEvidenceAuditAggregate | null,
  workflows: Array<{ id: string; name: string }> = [],
): string {
  return renderToStaticMarkup(createElement(TestEvidenceReadinessCard, {
    aggregate,
    workflows: workflows as never,
  }));
}

test("the card is drawn on its settings anchor before the daemon has answered", () => {
  const html = render(null);
  assert.ok(html.includes('data-anchor="workflows/test-evidence"'), "missing the search anchor");
  assert.match(html, /Unknown - the daemon has not answered/);
  // The one thing a pre-answer render must not do is state a rate.
  assert.doesNotMatch(html, /%/);
});

test("a daemon that has answered nothing yet says so, rather than reading as 0%", () => {
  const html = render(EMPTY);
  assert.match(html, /No Test Evidence Auditor attempt has been recorded yet/);
  assert.doesNotMatch(html, /0%/);
});

/**
 * The state GitHub Inspector caught on #737: every recorded event unreadable.
 *
 * `attempts` is the count of events that PARSED, so a window whose rows are all malformed
 * has `attempts === 0` alongside `malformed > 0` - and the empty state then reported an
 * auditor nobody had run while the malformed warning, which only rendered beside real
 * readings, never appeared at all. That is the one reading this card must never produce:
 * corrupted telemetry disguised as a quiet nothing. The empty state is now reserved for zero
 * valid AND zero malformed rows.
 */
test("a window whose every event is unreadable says so, not that the auditor never ran", () => {
  const html = render({ ...EMPTY, attempts: 0, malformed: 3 });
  assert.match(html, /No Test Evidence Auditor attempt could be read back/);
  assert.match(html, /3 recorded attempts.*could not be read back/s);
  assert.match(html, /not an auditor that has never run/);
  assert.doesNotMatch(
    html,
    /No Test Evidence Auditor attempt has been recorded yet/,
    "an unreadable window must not borrow the never-ran sentence",
  );
  // Still no rate anywhere: nothing parsed, so there is nothing to average.
  assert.doesNotMatch(html, /%/);
});

test("one unreadable attempt is described in the singular", () => {
  assert.match(render({ ...EMPTY, attempts: 0, malformed: 1 }), /1 recorded attempt\s+could not/);
  assert.match(
    render({ ...MEASURED, malformed: 1 }),
    /1 recorded attempt\s+could not be read back and\s+is excluded/,
  );
});

test("the card reads out every number the report's rollout criterion is written in", () => {
  const html = render(MEASURED);
  assert.match(html, /First-pass acceptance 33% \(1 of 3 first submissions\)/);
  assert.match(html, /target at least 70%/);
  assert.match(html, /Attempts that failed/);
  assert.match(html, /60% \(3 of 5 attempts\)/);
  assert.match(html, /1\.67 across 3 runs/);
  assert.match(html, /target at most 1\.5 · over target/);
  assert.match(html, /Possible later-stage overreach/);
  assert.match(html, /20% \(1 of 5 attempts\)/);
  // Every rejection category, including the one at zero: a missing row would read as a
  // reason the classifier does not know about.
  assert.match(html, /No reviewer-visible UI artifact.*67% \(2 of 3 failing attempts\)/s);
  assert.match(html, /No completed focused execution output/);
  assert.match(html, /Asked for later-stage proof.*0% \(0 of 3 failing attempts\)/s);
  // Readiness adoption, over first submissions.
  assert.match(html, /First submissions with no image.*67% \(2 of 3 first submissions\)/s);
  assert.match(html, /First submissions with no text artifact.*100% \(3 of 3 first submissions\)/s);
  assert.match(html, /4000 from Checks, 900 from transcript heads/);
  // The before/after comparison the identity fields exist for.
  assert.match(html, /v8 · guidance aaaaaaaa/);
  assert.match(html, /v10 · guidance bbbbbbbb/);
  // Named from the live catalog when it carries the workflow, so two workflows never draw
  // the same row. Unnamed above because that render passes no catalog.
  assert.match(
    render(MEASURED, [{ id: "workflow-review", name: "Review" }]),
    /Review · v8 · guidance aaaaaaaa/,
  );
});

test("a capped window and unreadable rows are stated instead of quietly narrowing the rates", () => {
  const html = render({ ...MEASURED, truncated: true, malformed: 2, slicesOmitted: 3 });
  assert.match(html, /only the newest 2000/);
  assert.match(html, /2 recorded attempts could not be read back/);
  assert.match(html, /3 further guidance revisions are not listed/);
});

test("a one-revision fleet is not given a by-revision list that restates its headline", () => {
  const html = render({ ...MEASURED, slices: [MEASURED.slices[0]!] });
  assert.doesNotMatch(html, /By guidance revision/);
});

/**
 * A label is a caption, not an identity, so the React key is built independently.
 *
 * The label truncates - eight characters of workflow id, eight of digest - so two rows CAN
 * still read alike where those prefixes coincide, and it drops the Persona entirely for the
 * built-in auditor. The key carries every grouping field untruncated, so rows that a caption
 * cannot separate still reconcile correctly across a refresh.
 */
test("a slice key carries every grouping field untruncated, unlike the label", () => {
  const base = MEASURED.slices[0]!;
  const twin = { ...base, guidanceDigest: "aaaaaaaabbbb" };
  assert.equal(sliceLabel(base), sliceLabel(twin), "eight characters cannot separate these");
  assert.notEqual(sliceIdentity(base), sliceIdentity(twin), "the key must still separate them");
  // The revision is not a grouping field, so it must not enter the key.
  assert.equal(sliceIdentity(base), sliceIdentity({ ...base, personaRevision: 99 }));
  // Every field that IS one does.
  for (const changed of [
    { workflowId: "other" },
    { workflowVersion: 99 },
    { personaId: "persona-other" },
  ]) {
    assert.notEqual(sliceIdentity(base), sliceIdentity({ ...base, ...changed }));
  }
});

test("no reading is never spelled as a zero reading", () => {
  assert.equal(
    formatAuditRate({ count: 0, total: 0, rate: null }, "attempts"),
    "no reading - no attempts recorded",
  );
  assert.equal(formatAuditRate({ count: 0, total: 4, rate: 0 }, "attempts"), "0% (0 of 4 attempts)");
  assert.equal(meetsTarget(null, 0.7, "at_least"), null);
  assert.equal(meetsTarget(0.7, 0.7, "at_least"), true);
  assert.equal(meetsTarget(0.69, 0.7, "at_least"), false);
  assert.equal(meetsTarget(1.5, 1.5, "at_most"), true);
  assert.equal(meetsTarget(1.6, 1.5, "at_most"), false);
});

test("history from before the identity fields existed is labelled, not drawn as version 0", () => {
  assert.equal(
    sliceLabel({
      ...MEASURED.slices[0]!,
      workflowId: null,
      workflowVersion: null,
      guidanceDigest: null,
    }),
    "Before guidance identity was recorded",
  );
  assert.equal(
    sliceLabel({ ...MEASURED.slices[0]!, guidanceDigest: null }),
    "workflow workflow · v8 · unknown guidance",
  );
});

/**
 * The case GitHub Inspector named on #737: two workflows, one built-in auditor.
 *
 * Slices are kept apart by workflow on purpose, but the label used to show only the version
 * and the digest - so two workflows reviewing with the same auditor at the same version drew
 * two rows reading "v8 · guidance aaaaaaaa", with no way to tell which rate described which.
 * That is not a corner case; it is what a fleet with two review workflows looks like.
 */
test("two workflows sharing one auditor are told apart in the label", () => {
  const left = MEASURED.slices[0]!;
  const right = { ...left, workflowId: "workflow-release" };
  const named = (slice: typeof left, name: string | null) => sliceLabel(slice, name);
  assert.notEqual(named(left, "Review"), named(right, "Release"));
  assert.equal(named(left, "Review"), "Review · v8 · guidance aaaaaaaa");
  // A workflow the live catalog no longer carries keeps its identity as a short id rather
  // than borrowing the other row's name or losing the distinction entirely.
  assert.equal(named(right, null), "workflow workflow · v8 · guidance aaaaaaaa");
  assert.notEqual(named(left, null), named({ ...left, workflowId: "abcdefghij" }, null));

  const html = render({ ...MEASURED, slices: [left, right] }, [
    { id: "workflow-review", name: "Review" },
    { id: "workflow-release", name: "Release" },
  ]);
  assert.match(html, /Review · v8 · guidance aaaaaaaa/);
  assert.match(html, /Release · v8 · guidance aaaaaaaa/);
});

/**
 * The auditor is named once in the card's own description, so repeating it on every row is
 * noise - but any OTHER Persona in this telemetry is worth seeing precisely because it is
 * unexpected, and it is a grouping field, so two rows could otherwise be identical.
 */
test("only a Persona that is not the built-in auditor is named on the row", () => {
  const base = MEASURED.slices[0]!;
  assert.doesNotMatch(sliceLabel(base, "Review"), /persona/);
  assert.match(sliceLabel({ ...base, personaId: "persona-custom" }, "Review"), /persona persona-cus/);
});
