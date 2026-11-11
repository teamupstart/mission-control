import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { InspectorComment } from "../src/shared/types.ts";
import {
  InspectorFindingsTable,
  UNKNOWN_POSTED_TOOLTIP,
  inspectorFindingLocation,
  inspectorFindingPostedCell,
  inspectorFindingSeverityStatus,
  inspectorFindingStatusStatus,
} from "../src/web/components/InspectorFindingsTable.tsx";

const COMMENT_URL = "https://github.com/owner/repo/pull/7#discussion_r123";

function finding(id: string, overrides: Partial<InspectorComment> = {}): InspectorComment {
  return {
    id,
    prKey: "owner/repo#7",
    fingerprint: `fp-${id}`,
    path: "src/gate.ts",
    line: 42,
    title: `Finding ${id}`,
    body: `Body of ${id}.`,
    severity: "major",
    round: 2,
    status: "open",
    replies: 0,
    answeredCommentId: null,
    postedAt: null,
    githubUrl: null,
    legacyPosted: null,
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

test("a finding's severity, status and location are spelled once", () => {
  assert.deepEqual(inspectorFindingSeverityStatus("blocker"), { tone: "failed", label: "blocker" });
  assert.deepEqual(inspectorFindingSeverityStatus("major"), { tone: "failed", label: "major" });
  assert.deepEqual(inspectorFindingSeverityStatus("minor"), { tone: "waiting", label: "minor" });
  assert.deepEqual(inspectorFindingSeverityStatus("nit"), { tone: "waiting", label: "nit" });
  assert.deepEqual(inspectorFindingStatusStatus("resolved"), { tone: "passed", label: "resolved" });
  assert.deepEqual(inspectorFindingStatusStatus("posting"), { tone: "waiting", label: "posting" });
  assert.deepEqual(inspectorFindingStatusStatus("drafted"), { tone: "failed", label: "drafted" });
  assert.deepEqual(inspectorFindingStatusStatus("open"), { tone: "failed", label: "open" });
  const located = finding("f1");
  assert.equal(inspectorFindingLocation(located), "src/gate.ts:42");
  assert.equal(inspectorFindingLocation({ ...located, line: null }), "src/gate.ts");
  // A finding with no path is "general", which is the word the card already used.
  assert.equal(inspectorFindingLocation({ ...located, path: null, line: null }), "general");
});

test("the Posted cell reads every publication state", () => {
  // Posted, linked to GitHub when the link is known.
  assert.deepEqual(
    inspectorFindingPostedCell(finding("a", { postedAt: 5, githubUrl: COMMENT_URL })),
    { label: "Posted", href: COMMENT_URL, tooltip: "Open this finding on GitHub", note: null },
  );
  // Posted, plain while it is not: the claim is true, the link is not captured yet.
  const unlinked = inspectorFindingPostedCell(finding("b", { postedAt: 5 }));
  assert.equal(unlinked.label, "Posted");
  assert.equal(unlinked.href, null);
  // A resolved finding that was posted still reads as posted.
  assert.equal(
    inspectorFindingPostedCell(finding("c", { status: "resolved", postedAt: 5 })).label,
    "Posted",
  );
  // A draft that never reached GitHub.
  assert.deepEqual(
    inspectorFindingPostedCell(finding("d", { status: "drafted" })),
    { label: "Not posted", href: null, tooltip: null, note: null },
  );
  // A draft whose earlier version was posted links to that earlier comment, and is never
  // read as "Not posted" alone.
  const earlier = inspectorFindingPostedCell(
    finding("e", { status: "drafted", postedAt: 5, githubUrl: COMMENT_URL }),
  );
  assert.equal(earlier.label, "Not posted (posted earlier)");
  assert.equal(earlier.href, COMMENT_URL);
  // Proven by the legacy backfill rather than a stamp, with no link to offer.
  const legacyEarlier = inspectorFindingPostedCell(
    finding("f", { status: "drafted", legacyPosted: "posted" }),
  );
  assert.equal(legacyEarlier.label, "Not posted (posted earlier)");
  assert.equal(legacyEarlier.href, null);
  assert.deepEqual(
    inspectorFindingPostedCell(finding("g", { status: "posting" })),
    { label: "Posting", href: null, tooltip: null, note: null },
  );
  assert.deepEqual(
    inspectorFindingPostedCell(finding("h", { status: "resolved", legacyPosted: "unknown" })),
    { label: "Unknown", href: null, tooltip: "Recorded before Mission Control tracked posting", note: null },
  );
  // A snapshot taken before the posted fields existed cannot prove either way.
  const { postedAt: _p, githubUrl: _g, legacyPosted: _l, ...frozen } = finding("i", { status: "resolved" });
  assert.equal(inspectorFindingPostedCell(frozen as InspectorComment).label, "Unknown");
});

// A draft GitHub refused still reads Not posted below the cap, with how many times on a line of
// its own and GitHub's reason on hover; at the cap it reads Refused.
const REASON = "Line could not be resolved (HTTP 422)";

test("the Posted cell reads a draft GitHub refused, from the first refusal", () => {
  assert.deepEqual(
    inspectorFindingPostedCell(finding("r1", { status: "drafted", postRefusals: 1, lastPostError: REASON })),
    { label: "Not posted", href: null, tooltip: `GitHub's reason: ${REASON}`, note: "GitHub refused it 1 time" },
  );
  assert.deepEqual(
    inspectorFindingPostedCell(finding("r2", { status: "drafted", postRefusals: 2, lastPostError: REASON })),
    { label: "Not posted", href: null, tooltip: `GitHub's reason: ${REASON}`, note: "GitHub refused it 2 times" },
  );
  assert.deepEqual(
    inspectorFindingPostedCell(finding("r3", { status: "drafted", postRefusals: 3, lastPostError: REASON })),
    { label: "Refused", href: null, tooltip: `GitHub's reason: ${REASON}`, note: "GitHub refused it 3 times" },
  );
  // Refused after an earlier version was posted: still links to that version.
  const earlier = inspectorFindingPostedCell(
    finding("r4", { status: "drafted", postedAt: 5, githubUrl: COMMENT_URL, postRefusals: 3, lastPostError: REASON }),
  );
  assert.equal(earlier.label, "Refused (posted earlier)");
  assert.equal(earlier.href, COMMENT_URL);
  assert.equal(earlier.note, "GitHub refused it 3 times");
  assert.match(earlier.tooltip ?? "", /^GitHub's reason: Line could not be resolved \(HTTP 422\)\. Not posted again/);
  // No reason recorded: the cell still says it was refused, and says GitHub gave none.
  assert.equal(
    inspectorFindingPostedCell(finding("r5", { status: "drafted", postRefusals: 1, lastPostError: null })).tooltip,
    "GitHub's reason: GitHub gave no reason",
  );
});

test("the table shows a refusal's count in the cell and its reason as the cell's description", () => {
  const html = renderToStaticMarkup(createElement(InspectorFindingsTable, {
    caption: "Refused findings",
    findings: [
      finding("once", { status: "drafted", postRefusals: 1, lastPostError: REASON }),
      finding("capped", { status: "drafted", postRefusals: 3, lastPostError: REASON }),
    ],
  }));
  assert.match(html, /<span aria-describedby="[^"]+">Not posted<\/span>(?:<span id="[^"]+" class="tt-desc">[^<]*<\/span>)?<span class="inspector-finding-refusals">GitHub refused it 1 time<\/span>/);
  assert.match(html, /<span aria-describedby="[^"]+">Refused<\/span>(?:<span id="[^"]+" class="tt-desc">[^<]*<\/span>)?<span class="inspector-finding-refusals">GitHub refused it 3 times<\/span>/);
  assert.ok(html.includes(`class="tt-desc">GitHub&#x27;s reason: ${REASON}</span>`));
  // Both stay unresolved, so both bodies stay on screen.
  assert.match(html, /Body of once\./);
  assert.match(html, /Body of capped\./);
});

test("the shared table draws the Posted column and keeps the body rule", () => {
  const html = renderToStaticMarkup(createElement(InspectorFindingsTable, {
    caption: "Findings under test",
    findings: [
      finding("open", { postedAt: 5, githubUrl: COMMENT_URL }),
      finding("draft", { status: "drafted", body: "The draft's body." }),
      finding("legacy", { status: "resolved", legacyPosted: "unknown", body: null }),
      finding("closed", { status: "resolved", postedAt: 5, body: "The resolved body." }),
    ],
  }));
  assert.match(html, /<caption class="sr-only">Findings under test<\/caption>/);
  assert.match(html, /<th>Posted<\/th>/);
  assert.match(
    html,
    new RegExp(`<a href="${COMMENT_URL}" target="_blank" rel="noreferrer"[^>]*>Posted</a>`),
  );
  assert.match(html, /<span>Not posted<\/span>/);
  // "Unknown" carries its tooltip as the cell's accessible description.
  const unknown = /<span aria-describedby="([^"]+)">Unknown<\/span>/.exec(html);
  assert.ok(unknown, "the Unknown cell is described by its tooltip");
  assert.ok(html.includes(`<span id="${unknown[1]}" class="tt-desc">${UNKNOWN_POSTED_TOOLTIP}</span>`));
  // Unresolved bodies are always on screen; a resolved one waits behind Show finding.
  assert.match(html, /Body of open\./);
  assert.match(html, /The draft&#x27;s body\./);
  assert.doesNotMatch(html, /The resolved body\./);
  // The alert row spans every column, Posted included.
  assert.match(html, /colSpan="7"|colspan="7"/);
});
