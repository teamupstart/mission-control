import assert from "node:assert/strict";
import test from "node:test";
import {
  compareInspectorFindings,
  findingPublication,
  orderInspectorFindings,
  type FindingPublication,
  type FindingPublicationInput,
} from "../src/shared/inspector-findings.ts";
import type { InspectorComment } from "../src/shared/types.ts";

// The rule table, first match wins. Every consumer - the findings route's clients,
// Foreman's relay, the workflow packet and the dashboard table - reads this one function,
// so a row is pinned here once rather than in each of them.
const URL_NOW = "https://github.com/o/r/pull/7#discussion_r123";
const URL_EARLIER = "https://github.com/o/r/pull/7#discussion_r45";

// A row with no refusal reads zero and no reason; the refusal cases below say otherwise.
type Want = Omit<FindingPublication, "refusals" | "reason"> & Partial<FindingPublication>;
const none: Want = { state: "not-posted", url: null, postedAt: null, earlierPost: false };
const unknown: Want = { state: "unknown", url: null, postedAt: null, earlierPost: false };
const REASON = "Line could not be resolved (HTTP 422)";

const cases: { name: string; row: FindingPublicationInput; want: Want }[] = [
  {
    name: "posting reads posting, whatever the row says about an earlier post",
    row: { status: "posting", postedAt: 100, githubUrl: URL_EARLIER, legacyPosted: null },
    want: { state: "posting", url: null, postedAt: null, earlierPost: false },
  },
  {
    name: "a draft never posted reads not-posted, with no earlier post",
    row: { status: "drafted", postedAt: null, githubUrl: null, legacyPosted: null },
    want: none,
  },
  {
    name: "a legacy unposted draft reads not-posted",
    row: { status: "drafted", postedAt: null, githubUrl: null, legacyPosted: "unposted" },
    want: none,
  },
  {
    name: "a draft whose earlier version was stamped posted carries earlierPost from postedAt",
    row: { status: "drafted", postedAt: 100, githubUrl: URL_EARLIER, legacyPosted: null },
    want: { state: "not-posted", url: URL_EARLIER, postedAt: 100, earlierPost: true },
  },
  {
    name: "a draft whose legacy row was posted carries earlierPost from legacyPosted",
    row: { status: "drafted", postedAt: null, githubUrl: null, legacyPosted: "posted" },
    want: { state: "not-posted", url: null, postedAt: null, earlierPost: true },
  },
  {
    name: "open reads posted, with its link and time",
    row: { status: "open", postedAt: 200, githubUrl: URL_NOW, legacyPosted: null },
    want: { state: "posted", url: URL_NOW, postedAt: 200, earlierPost: false },
  },
  {
    name: "open reads posted before a tick captures its link",
    row: { status: "open", postedAt: 200, githubUrl: null, legacyPosted: null },
    want: { state: "posted", url: null, postedAt: 200, earlierPost: false },
  },
  {
    name: "a legacy open row reads posted with no time",
    row: { status: "open", postedAt: null, githubUrl: null, legacyPosted: "posted" },
    want: { state: "posted", url: null, postedAt: null, earlierPost: false },
  },
  {
    name: "a resolved row that was stamped posted still reads posted",
    row: { status: "resolved", postedAt: 300, githubUrl: URL_NOW, legacyPosted: null },
    want: { state: "posted", url: URL_NOW, postedAt: 300, earlierPost: false },
  },
  {
    name: "a resolved legacy row the backfill proved posted reads posted",
    row: { status: "resolved", postedAt: null, githubUrl: null, legacyPosted: "posted" },
    want: { state: "posted", url: null, postedAt: null, earlierPost: false },
  },
  {
    name: "a resolved legacy row the backfill could not decide reads unknown",
    row: { status: "resolved", postedAt: null, githubUrl: null, legacyPosted: "unknown" },
    want: unknown,
  },
  {
    name: "a resolved legacy row reads posted once a tick captures its own thread",
    row: { status: "resolved", postedAt: null, githubUrl: URL_NOW, legacyPosted: "unknown" },
    want: { state: "posted", url: URL_NOW, postedAt: null, earlierPost: false },
  },
  {
    name: "a legacy unposted draft with a captured thread was posted earlier",
    row: { status: "drafted", postedAt: null, githubUrl: URL_EARLIER, legacyPosted: "unposted" },
    want: { state: "not-posted", url: URL_EARLIER, postedAt: null, earlierPost: true },
  },
  {
    name: "a resolved legacy row the backfill proved unposted reads not-posted",
    row: { status: "resolved", postedAt: null, githubUrl: null, legacyPosted: "unposted" },
    want: none,
  },
  {
    name: "a resolved row this build never confirmed reads not-posted",
    row: { status: "resolved", postedAt: null, githubUrl: null, legacyPosted: null },
    want: none,
  },
  {
    name: "a resolved row from a snapshot older than the fields reads unknown",
    row: { status: "resolved" },
    want: unknown,
  },
  {
    name: "an empty link is no link",
    row: { status: "open", postedAt: 200, githubUrl: "", legacyPosted: null },
    want: { state: "posted", url: null, postedAt: 200, earlierPost: false },
  },
  // The refusal state. The reason shows from the first counted refusal, not only at
  // the cap, so the operator and the session know why a draft is still not on GitHub.
  {
    name: "a draft refused once stays not-posted and carries its count and reason",
    row: { status: "drafted", postedAt: null, githubUrl: null, legacyPosted: null, postRefusals: 1, lastPostError: REASON },
    want: { ...none, refusals: 1, reason: REASON },
  },
  {
    name: "a draft refused twice stays not-posted",
    row: { status: "drafted", postedAt: null, githubUrl: null, legacyPosted: null, postRefusals: 2, lastPostError: REASON },
    want: { ...none, refusals: 2, reason: REASON },
  },
  {
    name: "a draft refused 3 times reads refused",
    row: { status: "drafted", postedAt: null, githubUrl: null, legacyPosted: null, postRefusals: 3, lastPostError: REASON },
    want: { state: "refused", url: null, postedAt: null, earlierPost: false, refusals: 3, reason: REASON },
  },
  {
    name: "a refused draft whose earlier version was posted keeps the earlier link",
    row: { status: "drafted", postedAt: 100, githubUrl: URL_EARLIER, legacyPosted: null, postRefusals: 3, lastPostError: REASON },
    want: { state: "refused", url: URL_EARLIER, postedAt: 100, earlierPost: true, refusals: 3, reason: REASON },
  },
  {
    name: "a refused draft with no recorded reason carries none",
    row: { status: "drafted", postedAt: null, githubUrl: null, legacyPosted: null, postRefusals: 1, lastPostError: null },
    want: { ...none, refusals: 1, reason: null },
  },
  {
    name: "a stale reason with no counted refusal is not shown",
    row: { status: "drafted", postedAt: null, githubUrl: null, legacyPosted: null, postRefusals: 0, lastPostError: REASON },
    want: none,
  },
  {
    name: "a draft from a snapshot older than the refusal fields reads zero refusals",
    row: { status: "drafted", postedAt: null, githubUrl: null, legacyPosted: null },
    want: none,
  },
  {
    // The count is about offering a draft. Once GitHub has the finding, it says nothing.
    name: "a posted row ignores the refusals it collected as a draft",
    row: { status: "open", postedAt: 200, githubUrl: URL_NOW, legacyPosted: null, postRefusals: 2, lastPostError: REASON },
    want: { state: "posted", url: URL_NOW, postedAt: 200, earlierPost: false },
  },
  {
    name: "a resolved never-posted row ignores its refusals",
    row: { status: "resolved", postedAt: null, githubUrl: null, legacyPosted: null, postRefusals: 3, lastPostError: REASON },
    want: none,
  },
];

for (const c of cases) {
  test(`findingPublication: ${c.name}`, () => {
    assert.deepEqual(findingPublication(c.row), { refusals: 0, reason: null, ...c.want });
  });
}

function row(fingerprint: string, over: Partial<InspectorComment>): InspectorComment {
  return {
    id: fingerprint,
    prKey: "o/r#7",
    fingerprint,
    path: "src/a.ts",
    line: 1,
    title: fingerprint,
    body: null,
    severity: "major",
    round: 1,
    status: "open",
    replies: 0,
    answeredCommentId: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

test("findings order unresolved first, then by severity, path, line and fingerprint", () => {
  const rows = [
    row("resolved-blocker", { status: "resolved", severity: "blocker" }),
    row("nit", { severity: "nit", status: "drafted" }),
    row("major-b", { path: "src/b.ts" }),
    row("major-a-20", { line: 20, status: "posting" }),
    row("major-a-body", { line: null }),
    row("major-a-5-z", { line: 5 }),
    row("major-a-5-y", { line: 5 }),
    row("blocker", { severity: "blocker" }),
  ];
  assert.deepEqual(orderInspectorFindings(rows).map((r) => r.fingerprint), [
    "blocker",
    "major-a-5-y",
    "major-a-5-z",
    "major-a-20",
    "major-a-body",
    "major-b",
    "nit",
    "resolved-blocker",
  ]);
  assert.equal(rows[0]?.fingerprint, "resolved-blocker", "the input is not sorted in place");
  assert.ok(compareInspectorFindings(row("a", { severity: "minor" }), row("b", { severity: "major" })) > 0);
});
