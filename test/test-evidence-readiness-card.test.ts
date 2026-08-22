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

function render(aggregate: TestEvidenceAuditAggregate | null): string {
  return renderToStaticMarkup(createElement(TestEvidenceReadinessCard, { aggregate }));
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
    sliceLabel({ ...MEASURED.slices[0]!, workflowVersion: null, guidanceDigest: null }),
    "Before guidance identity was recorded",
  );
  assert.equal(
    sliceLabel({ ...MEASURED.slices[0]!, guidanceDigest: null }),
    "v8 · unknown guidance",
  );
});
