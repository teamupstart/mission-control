import { test } from "node:test";
import assert from "node:assert/strict";
import { renderInspectorFeedback } from "../src/server/workflows/feedback.ts";
import { WORKFLOW_LIMITS } from "../src/shared/workflow.ts";
import type { InspectorComment } from "../src/shared/types.ts";

// What is at stake: a repair delivery is an immutable instruction packet. Ordering,
// deduplication, fallback text, and hashing must not depend on a later ledger read.
function finding(
  fingerprint: string,
  severity: InspectorComment["severity"],
  over: Partial<InspectorComment> = {},
): InspectorComment {
  return {
    id: fingerprint,
    prKey: "owner/repo#12",
    fingerprint,
    path: "src/file.ts",
    line: 10,
    title: `${severity} title`,
    body: `${severity} detail`,
    severity,
    round: 3,
    status: "open",
    replies: 0,
    answeredCommentId: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function render(
  findings: InspectorComment[],
  policy: "restart_workflow" | "inspector_only" = "restart_workflow",
  workflowEvidence = true,
) {
  return renderInspectorFeedback({
    workflowName: "Release review",
    workflowVersion: 4,
    runId: "run-1",
    submissionRound: 2,
    originalGoal: "Ship the safe change",
    prUrl: "https://github.com/owner/repo/pull/12",
    targetHeadSha: "a".repeat(40),
    inspectorRound: 3,
    reviewPosture: "live",
    policy,
    findings,
    workflowEvidence,
  });
}

test("Inspector feedback is severity ordered, fingerprint deduplicated, and stable", () => {
  const rows = [
    finding("minor", "minor"),
    finding("blocker", "blocker", { path: "z.ts" }),
    finding("major", "major"),
    finding("nit", "nit"),
    finding("major", "major", { title: "duplicate wording must not win" }),
  ];
  const first = render(rows);
  const second = render([...rows].reverse());
  assert.equal(first.payloadSha256, second.payloadSha256);
  assert.equal(first.payload, second.payload);
  assert.equal(first.failedPersonaCount, 4);
  assert.ok(first.payload.indexOf("BLOCKER") < first.payload.indexOf("MAJOR"));
  assert.ok(first.payload.indexOf("MAJOR") < first.payload.indexOf("MINOR"));
  assert.ok(first.payload.indexOf("MINOR") < first.payload.indexOf("NIT"));
  assert.equal(first.payload.match(/Fingerprint: major/g)?.length, 1);
  // These rows predate `postedAt`, as an older snapshot would: an open row is still on GitHub.
  assert.match(first.payload, /Location: src\/file\.ts:10\nPosted on GitHub \(link not captured yet\)\nminor detail/);
  assert.match(first.payload, /Original user goal:\nShip the safe change/);
  assert.match(first.payload, /Pinned head: a{40}/);
  assert.match(first.payload, /already authorized you to commit the scoped work/);
  assert.match(first.payload, /already authorized `submit_workflow_evidence`/);
  assert.match(first.payload, /do not ask the human to resubmit the workflow/);
});

test("scrubbed detail and legacy fallback are frozen with published policy wording", () => {
  const packet = render([
    finding("scrubbed", "major", { body: "Token: [REDACTED]\u0007" }),
    finding("legacy", "minor", { body: null, path: null, line: null }),
  ], "inspector_only");
  assert.match(packet.payload, /Token: \[REDACTED\]/);
  assert.doesNotMatch(packet.payload, /\u0007/);
  assert.match(packet.payload, /Legacy finding detail is unavailable/);
  assert.match(packet.payload, /permits bypassing Personas only for this GitHub Inspector repair/);
  assert.match(packet.payload, /commit and push a new head/);
});

test("field and packet caps retain a deterministic hash and truncation notice", () => {
  const huge = "ø".repeat(200_000);
  const first = render([finding("huge", "blocker", { body: huge })]);
  const second = render([finding("huge", "blocker", { body: huge })]);
  assert.equal(first.truncated, true);
  assert.equal(first.payloadSha256, second.payloadSha256);
  assert.equal(first.payload, second.payload);
  assert.match(first.payload, /Workflow repair packet truncated deterministically/);
  assert.match(first.payload, /do not ask the human to resubmit the workflow/);
  assert.ok(Buffer.byteLength(first.payload, "utf8") <= WORKFLOW_LIMITS.feedbackPayloadBytes);
  // The body clips at its field limit and the finding is still listed whole: the packet's
  // final clip never reaches into it.
  assert.equal(first.payload.match(/ø+/)![0].length * 2, WORKFLOW_LIMITS.feedbackFieldBytes);
  assert.match(first.payload, /\nFingerprint: huge\n\n## Mission Control execution authorization/);
  assert.equal(first.failedPersonaCount, 1);
});

// The renderer gets what the payload really has left. A packet that clips nothing carries no
// truncation notice, so a finding that fills the payload to its last byte stays listed; one
// byte more and it is dropped whole. A clipped field brings the notice, and then the finding
// must leave room for it, still to the exact byte.
test("a finding that fits the payload as sent is listed, to the last byte", () => {
  const limit = WORKFLOW_LIMITS.feedbackPayloadBytes;
  const bytes = (value: string): number => Buffer.byteLength(value, "utf8");
  const notice = "\n\n[Workflow repair packet truncated deterministically.]";

  // A one-byte padding measures everything else; each padding byte after that is one payload
  // byte. Every field stays under its own limit except where a case clips one on purpose.
  const cases = [
    {
      name: "nothing clipped",
      over: (size: number) => ({ title: "x".repeat(size), body: "b".repeat(3_000) }),
      endsWithNotice: false,
    },
    {
      // A title over its field limit is clipped, so the notice is sent and its bytes reserved.
      name: "a clipped title",
      over: (size: number) => ({
        title: "t".repeat(WORKFLOW_LIMITS.feedbackFieldBytes + 1),
        body: "x".repeat(size),
      }),
      endsWithNotice: true,
    },
  ];
  for (const { name, over: pad, endsWithNotice } of cases) {
    const packet = (size: number) => render([finding("edge", "major", pad(size))]);
    const fill = limit - bytes(packet(1).payload) + 1;
    assert.ok(fill < WORKFLOW_LIMITS.feedbackFieldBytes, `${name}: the padding would be clipped`);

    const full = packet(fill);
    assert.equal(bytes(full.payload), limit, `${name}: the listed finding does not fill the payload exactly`);
    assert.match(full.payload, /\nFingerprint: edge\n/, `${name}: a finding that fits was dropped`);
    assert.equal(full.payload.endsWith(notice), endsWithNotice, `${name}: notice mismatch`);
    assert.equal(full.truncated, endsWithNotice);

    const over = packet(fill + 1);
    assert.ok(bytes(over.payload) <= limit, `${name}: one byte more overflowed the payload`);
    assert.doesNotMatch(over.payload, /Fingerprint: edge/, `${name}: one byte more was still listed`);
    assert.match(over.payload, /\n\n1 unresolved finding is not listed here, because it does not fit in this message whole\. It stays open\.\n\n/);
    assert.equal(over.failedPersonaCount, 1);
  }
});

// Each header field is capped on its own, and four of them at the cap outgrow the whole
// payload. The findings count is reserved before the header is sized, so the header is
// what gets clipped and the session is still told how many findings it has to fix.
test("header fields that exhaust the payload still leave the findings count", () => {
  const huge = "g".repeat(200_000);
  const rows = [finding("a", "blocker"), finding("b", "major"), finding("c", "minor")];
  const packet = renderInspectorFeedback({
    workflowName: huge,
    workflowVersion: 4,
    runId: "run-1",
    submissionRound: 2,
    originalGoal: huge,
    prUrl: huge,
    targetHeadSha: huge,
    inspectorRound: 3,
    reviewPosture: "live",
    policy: "restart_workflow",
    findings: rows,
    workflowEvidence: true,
  });
  assert.ok(Buffer.byteLength(packet.payload, "utf8") <= WORKFLOW_LIMITS.feedbackPayloadBytes);
  assert.match(packet.payload, /^GitHub Inspector reviewed the pinned pull request head/);
  assert.match(
    packet.payload,
    /\n\n3 unresolved findings are not listed here, because not even the first fits in this message whole\. They stay open\.\n\n## Mission Control execution authorization/,
  );
  assert.doesNotMatch(packet.payload, /^## (BLOCKER|MAJOR|MINOR)/m);
  assert.equal(packet.failedPersonaCount, 3);
  assert.equal(packet.truncated, true);
  assert.match(packet.payload, /Workflow repair packet truncated deterministically/);
  assert.match(packet.payload, /Fix the findings, verify the work, then commit and push it\./);
});

test("a finding too large for the packet even after field clipping is dropped whole and counted", () => {
  const huge = "ø".repeat(200_000);
  const packet = render([finding("huge", "blocker", { title: huge, body: huge })]);
  assert.ok(Buffer.byteLength(packet.payload, "utf8") <= WORKFLOW_LIMITS.feedbackPayloadBytes);
  assert.doesNotMatch(packet.payload, /ø/, "part of the oversized finding was typed");
  assert.doesNotMatch(packet.payload, /Fingerprint: huge|## BLOCKER/);
  assert.match(
    packet.payload,
    /Review posture: live\n\n1 unresolved finding is not listed here, because it does not fit in this message whole\. It stays open\.\n\n## Mission Control execution authorization/,
  );
  assert.equal(packet.failedPersonaCount, 1, "the failed count stays the total");
  assert.equal(packet.truncated, false);
  assert.doesNotMatch(packet.payload, /Workflow repair packet truncated deterministically/);
});

// The marker table itself is pinned in `inspector-findings-text.test.ts`; this pins that the
// packet carries it inside each finding, between location and body.
test("each finding says whether it is on GitHub", () => {
  const packet = render([
    finding("posted", "blocker", {
      postedAt: 5,
      githubUrl: "https://github.com/owner/repo/pull/12#discussion_r1",
    }),
    finding("draft", "major", { status: "drafted", postedAt: null, githubUrl: null }),
    finding("again", "minor", {
      status: "drafted",
      postedAt: 5,
      githubUrl: "https://github.com/owner/repo/pull/12#discussion_r2",
    }),
  ]);
  assert.ok(packet.payload.includes([
    "## BLOCKER - blocker title",
    "Location: src/file.ts:10",
    "Posted on GitHub: https://github.com/owner/repo/pull/12#discussion_r1",
    "blocker detail",
    "Fingerprint: posted",
  ].join("\n")));
  assert.match(packet.payload, /## MAJOR - major title\nLocation: src\/file\.ts:10\nNot posted on GitHub\. This message is the only copy\.\nmajor detail/);
  assert.match(packet.payload, /## MINOR - minor title\nLocation: src\/file\.ts:10\nNot posted again\. An earlier version was posted on GitHub: https:\/\/github\.com\/owner\/repo\/pull\/12#discussion_r2\n/);
  assert.equal(packet.payload.match(/only copy/g)?.length, 1);
});

test("past the payload limit the packet drops whole findings, says how many, and counts all of them", () => {
  const severities = ["blocker", "major", "minor", "nit"] as const;
  const rows = Array.from({ length: 40 }, (_, index) =>
    finding(`fp-${String(index).padStart(2, "0")}`, severities[index % 4]!, { body: "d".repeat(300) }));
  const packet = render(rows);
  const listed = packet.payload.match(/^Fingerprint: /gm)?.length ?? 0;
  assert.ok(Buffer.byteLength(packet.payload, "utf8") <= WORKFLOW_LIMITS.feedbackPayloadBytes);
  assert.ok(listed > 0 && listed < 40);
  assert.equal(packet.failedPersonaCount, 40, "the failed count stays the total, not the number shown");
  assert.equal(packet.truncated, false);
  assert.doesNotMatch(packet.payload, /Workflow repair packet truncated deterministically/);
  assert.equal(packet.payload.match(/d{300}/g)?.length, listed, "a listed finding was clipped mid-text");
  assert.match(
    packet.payload,
    new RegExp(`\\nFingerprint: \\S+\\n\\n${40 - listed} more unresolved findings are not listed here, to keep this message short\\. They stay open and come back in the next relay\\.\\n\\n## Mission Control execution authorization`),
  );
  // Header and closing are the packet's own, and both survive the budget.
  assert.match(packet.payload, /^GitHub Inspector reviewed the pinned pull request head/);
  assert.match(packet.payload, /GitHub Inspector round: 3\nReview posture: live\n\n## BLOCKER/);
  assert.ok(packet.payload.endsWith("Fix the findings, verify the work, then commit and push it."));
  assert.doesNotMatch(packet.payload, /^## NIT/m, "a nit was kept while a higher severity was dropped");
});

test("Inspector feedback omits evidence-tool authority when the pinned graph has no Persona", () => {
  const packet = render([finding("major", "major")], "restart_workflow", false);
  assert.doesNotMatch(packet.payload, /submit_workflow_evidence/);
  assert.match(packet.payload, /do not ask the human to resubmit the workflow/);
});
