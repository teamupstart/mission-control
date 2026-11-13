/**
 * What a person reads on a Wait for CI card. A block has no structure of its own - no check
 * list decides it, no requested change carries it - so the sentence IS the outcome, and each
 * code has to render its own reason rather than another code's, an empty line, or the
 * waiting headline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WaitForCiPanel } from "../src/web/workflows/WaitForCiPanel.tsx";
import {
  WAIT_FOR_CI_BLOCK_SENTENCES,
  waitForCiHeadline,
  waitForCiSettingsLine,
} from "../src/web/workflows/run-model.ts";
import {
  WAIT_FOR_CI_BLOCK_CODES,
  initialWaitForCiState,
  type CiCheckRun,
  type WaitForCiBlockCode,
  type WaitForCiState,
} from "../src/shared/wait-for-ci.ts";

const HEAD = "c".repeat(40);
const NOW = 10_000_000;

function waiting(over: Partial<WaitForCiState> = {}): WaitForCiState {
  return {
    ...initialWaitForCiState({
      pullRequestKey: "owner/repo#77",
      pullRequestUrl: "https://github.com/owner/repo/pull/77",
      pullRequestNumber: 77,
      expectedHeadOid: HEAD,
      timeoutMinutes: 45,
      now: NOW,
    }),
    ...over,
  };
}

const blocked = (code: WaitForCiBlockCode, over: Partial<WaitForCiState> = {}): WaitForCiState =>
  waiting({ outcome: "blocked", blocked: { code, detail: "machine detail" }, ...over });

/** The attempt state each code's sentence reads its names or count from. */
const BLOCK_STATE: Partial<Record<WaitForCiBlockCode, Partial<WaitForCiState>>> = {
  ci_expected_missing: { missingExpected: ["deploy", "e2e"] },
  ci_checks_truncated: { checksTotal: 140 },
};

const render = (state: WaitForCiState): string =>
  renderToStaticMarkup(createElement(WaitForCiPanel, { attempt: { output: state as never }, now: NOW + 12 * 60_000 }));

/** The headline paragraph's text, which is the one line a block renders. */
const headline = (html: string): string =>
  /<p class="wf-run-ci-headline">([^<]*)<\/p>/.exec(html)?.[1]?.replaceAll("&quot;", "\"").replaceAll("&#x27;", "'") ?? "";

// What each sentence must say, in words a person acts on - pinned per code so two sentences
// swapped between codes fail here.
const SAYS: Record<WaitForCiBlockCode, RegExp[]> = {
  ci_missing: [/No CI check appeared/, /before the timeout/, /GitHub Inspector is on/],
  ci_timeout: [/still running, or had not stayed settled for the quiet period, when the timeout ran out/, /Wait for CI again/],
  ci_pull_request_unknown: [/could not tell which commit to watch/, /Start a new round/],
  ci_expected_missing: [
    /^These expected checks never appeared on the head commit before the timeout: "deploy", "e2e"\. /,
    /Check that the workflows producing them run on pull requests, or correct the names in a new version, then wait for CI again\.$/,
  ],
  ci_checks_truncated: [
    /^GitHub reported 140 checks; only the first 100 were read, so this node cannot confirm CI passed\. /,
    /Check the rest on GitHub; if they pass, an operator can disable this node for the run, then wait for CI again\.$/,
  ],
};

test("every block code renders its own plain reason as the card's headline", () => {
  const seen = new Set<string>();
  for (const code of WAIT_FOR_CI_BLOCK_CODES) {
    const state = blocked(code, BLOCK_STATE[code]);
    const text = headline(render(state));
    assert.equal(text, WAIT_FOR_CI_BLOCK_SENTENCES[code](state), `${code} did not render its own sentence`);
    for (const pattern of SAYS[code]) assert.match(text, pattern, `${code}: ${text}`);
    assert.doesNotMatch(text, /Waiting for CI/, `${code} fell through to the waiting headline`);
    assert.doesNotMatch(text, /ci_|machine detail/, `${code} leaked its code or detail`);
    seen.add(text);
  }
  assert.equal(seen.size, WAIT_FOR_CI_BLOCK_CODES.length, "two block codes share one sentence");
});

test("a blocked card keeps the pull request it was watching and the checks it saw", () => {
  const html = render({
    ...blocked("ci_timeout"),
    checkRuns: [{ name: "e2e", state: "pending", conclusion: null, detailsUrl: null, title: null, summary: null }],
  });
  assert.match(html, /href="https:\/\/github\.com\/owner\/repo\/pull\/77"/);
  assert.match(html, /head cccccccccccc/);
  assert.match(html, /Checks on the head commit \(1\)/);
  assert.match(html, /e2e<\/span> <span class="wf-run-meta">Running/);
  // A block is not a fail or a pass: neither list renders.
  assert.doesNotMatch(html, /Failing checks|flaky test/);
});

test("the other headlines: waiting with elapsed and limit, pass, fail, and disabled", () => {
  assert.equal(
    waitForCiHeadline(waiting(), NOW + 12 * 60_000),
    `Waiting for CI on PR #77 at ${HEAD.slice(0, 12)} · 12 of 45 min.`,
  );
  assert.equal(waitForCiHeadline(waiting({ outcome: "pass" }), NOW), `CI passed on PR #77 at ${HEAD.slice(0, 12)}.`);
  assert.equal(waitForCiHeadline(waiting({ outcome: "fail" }), NOW), `CI failed on PR #77 at ${HEAD.slice(0, 12)}.`);
  assert.match(waitForCiHeadline(waiting({ outcome: "pass", disabled: true }), NOW), /Disabled for this run/);
  // Before the Inspector has read anything, the card says so rather than showing an empty list.
  assert.match(render(waiting()), /GitHub Inspector has not read CI for this head yet/);
});

test("the quiet period reads in the headline, measured between observations, while the chip stays Waiting for CI", async () => {
  const green = [{ name: "unit", state: "passing" as const, conclusion: "SUCCESS", detailsUrl: null, title: null, summary: null }];
  const head = HEAD.slice(0, 12);
  const quiet = (observedAt: number) => waiting({ checkRuns: green, quietSince: NOW + 60_000, observedAt });
  assert.equal(
    waitForCiHeadline(quiet(NOW + 60_000), NOW + 30 * 60_000),
    `Every counted check has settled on PR #77 at ${head}. Passing once nothing changes for 3 min (0 of 3 so far).`,
    "the clock reads observations, so wall time alone never advances it",
  );
  assert.match(waitForCiHeadline(quiet(NOW + 60_000 + 90_000), NOW), /\(1 of 3 so far\)\.$/);
  assert.match(render(quiet(NOW + 60_000)), /Every counted check has settled on PR #77/);
  // Pending again: back to the waiting headline.
  assert.match(waitForCiHeadline(waiting({ checkRuns: green, quietSince: null, observedAt: NOW }), NOW), /^Waiting for CI on PR #77/);
  const { memberPipelineStatus } = await import("../src/web/workflows/run-model.ts");
  assert.equal(memberPipelineStatus("wait_for_ci", "waiting").label, "Waiting for CI");
});

test("a fail lists every failing check", () => {
  const failed = render(waiting({
    outcome: "fail",
    checkRuns: [{ name: "e2e", state: "failing", conclusion: "FAILURE", detailsUrl: null, title: null, summary: null }],
  }));
  assert.match(failed, /Failing checks[\s\S]*<strong>e2e<\/strong>/);
});

test("any other attempt renders nothing", () => {
  assert.equal(renderToStaticMarkup(createElement(WaitForCiPanel, { attempt: { output: { outcome: "pass" } as never } })), "");
});

test("one function picks each member kind's chip for every run view", async () => {
  const { memberPipelineStatus } = await import("../src/web/workflows/run-model.ts");
  assert.equal(memberPipelineStatus("wait_for_ci", "waiting").label, "Waiting for CI");
  assert.equal(memberPipelineStatus("wait_for_ci", "error").label, "Blocked");
  assert.equal(memberPipelineStatus("wait_for_ci", "pass").label, "CI passed");
  assert.equal(memberPipelineStatus("check", "pass", { checkOutcome: "skipped" }).label, "Skipped");
  assert.equal(memberPipelineStatus("persona", "fail").label, "Changes requested");
  assert.equal(memberPipelineStatus("session_action", undefined).tone, "waiting");
  // The three views call it rather than keeping their own ternary chains.
  const { readFileSync } = await import("node:fs");
  for (const view of ["RunPipeline.tsx", "WorkflowLadder.tsx", "WorkflowLadderPeek.tsx"]) {
    const source = readFileSync(new URL(`../src/web/workflows/${view}`, import.meta.url), "utf8");
    assert.match(source, /memberPipelineStatus\(/, view);
    assert.doesNotMatch(source, /waitForCiStatus\(|reviewerStatus\(/, `${view} re-derives a member chip`);
  }
});

// ---- node settings ---------------------------------------------------------------------------

const ciRun = (
  name: string,
  state: CiCheckRun["state"],
  required?: boolean,
): CiCheckRun => ({
  name,
  state,
  conclusion: state === "pending" ? null : state === "failing" ? "FAILURE" : "SUCCESS",
  detailsUrl: null,
  title: null,
  summary: null,
  ...(required === undefined ? {} : { required }),
});

/** The CI checks list as `name|tag|state` rows, tags blank where there is none. */
const checkRows = (html: string): string[] => {
  const list = /<ul class="wf-run-ci-checks"[^>]*>([\s\S]*?)<\/ul>/.exec(html)?.[1] ?? "";
  return [...list.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((match) => {
    const cell = match[1]!;
    const name = /<span>([^<]*)<\/span>/.exec(cell)?.[1] ?? "";
    const tag = /<span class="wf-run-ci-tag">([^<]*)<\/span>/.exec(cell)?.[1] ?? "";
    const word = /<span class="wf-run-meta">([^<]*)<\/span>/.exec(cell)?.[1] ?? "";
    return `${name}|${tag}|${word}`;
  });
};

test("the settings line says what the node judges under, legacy attempts as the legacy settings", () => {
  assert.equal(waitForCiSettingsLine(waiting()), "All checks · quiet 3 min · limit 45 min");
  assert.equal(
    waitForCiSettingsLine(waiting({ strictness: "required", quietMinutes: 3, expectedChecks: ["deploy", "e2e"] })),
    'Required checks · expects "deploy", "e2e" · quiet 3 min · limit 45 min',
  );
  assert.match(render(waiting()), /<p class="wf-run-meta">All checks · quiet 3 min · limit 45 min<\/p>/);
  // The quiet headline reads the node's own quiet period.
  const quiet = waiting({ quietMinutes: 10, checkRuns: [ciRun("unit", "passing")], quietSince: NOW, observedAt: NOW + 4 * 60_000 });
  assert.match(waitForCiHeadline(quiet, NOW), /nothing changes for 10 min \(4 of 10 so far\)\.$/);
});

test("Required mode tags every check, and lists expected checks not reported yet as their own rows", () => {
  const html = render(waiting({
    strictness: "required",
    quietMinutes: 3,
    expectedChecks: ["deploy", "e2e"],
    observedAt: NOW,
    missingExpected: ["deploy"],
    checkRuns: [ciRun("build", "passing", true), ciRun("e2e", "pending"), ciRun("lint", "failing")],
  }));
  assert.deepEqual(checkRows(html), [
    "build|Required|Passed",
    "e2e|Expected|Running",
    "lint|Not required|Failed",
    "deploy|Expected|Not reported yet",
  ]);
  // With nothing marked, every check counts, so none is called "Not required".
  const unmarked = render(waiting({ strictness: "required", observedAt: NOW, checkRuns: [ciRun("lint", "passing")] }));
  assert.deepEqual(checkRows(unmarked), ["lint||Passed"]);
});

test("All mode tags nothing, but still lists an expected check not reported yet", () => {
  const html = render(waiting({
    expectedChecks: ["deploy"],
    observedAt: NOW,
    missingExpected: ["deploy"],
    checkRuns: [ciRun("build", "passing", true), ciRun("lint", "failing")],
  }));
  assert.deepEqual(checkRows(html), ["build||Passed", "lint||Failed", "deploy|Expected|Not reported yet"]);
});

test("a fail lists only counted failures, then the expected checks CI never reported", () => {
  const html = render(waiting({
    strictness: "required",
    expectedChecks: ["deploy"],
    outcome: "fail",
    observedAt: NOW,
    missingExpected: ["deploy"],
    checkRuns: [ciRun("build", "failing", true), ciRun("lint", "failing")],
  }));
  const failing = /<ul class="wf-run-ci-failing">([\s\S]*?)<\/ul>/.exec(html)?.[1] ?? "";
  assert.match(failing, /<strong>build<\/strong>/);
  assert.doesNotMatch(failing, /lint/, "a failure that is not required read as the reason it failed");
  assert.match(html, /Not reported when CI failed: &quot;deploy&quot;\./);
});

test("the fallback and truncation notes appear only when they apply", () => {
  const plain = render(waiting({ outcome: "pass", checkRuns: [ciRun("unit", "passing")], observedAt: NOW }));
  assert.doesNotMatch(plain, /marked required|only the first/);
  const fallback = render(waiting({ strictness: "required", outcome: "pass", requiredFallback: true, checkRuns: [ciRun("unit", "passing")], observedAt: NOW }));
  assert.match(fallback, /No check on this head is marked required, so every check was judged\./);
  const truncated = render(waiting({ checksTotal: 140, checkRuns: [ciRun("unit", "passing")], observedAt: NOW }));
  assert.match(truncated, /<p class="wf-run-meta">GitHub reported 140 checks; only the first 100 were read\.<\/p>/);
  assert.doesNotMatch(render(waiting({ checksTotal: 100, checkRuns: [ciRun("unit", "passing")], observedAt: NOW })), /only the first/);
  // A truncated Required head counts nothing it cannot see marked: an unmarked check read is not
  // required, and the panel never claims the fallback for it.
  const truncatedRequired = render(waiting({
    strictness: "required",
    outcome: "blocked",
    blocked: { code: "ci_checks_truncated", detail: "x" },
    checksTotal: 140,
    observedAt: NOW,
    missingExpected: [],
    checkRuns: [ciRun("lint", "failing")],
  }));
  assert.deepEqual(checkRows(truncatedRequired), ["lint|Not required|Failed"]);
  assert.doesNotMatch(truncatedRequired, /marked required, so every check/);
});
