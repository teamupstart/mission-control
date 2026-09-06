import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PRODUCT_ISSUE_TYPES,
  type ProductIssuePreflight,
  type ProductIssuePreview,
  type ProductIssueSubmitResult,
} from "../src/shared/product-issues.ts";
import {
  EMPTY_PRODUCT_ISSUE_DRAFT,
  PRODUCT_ISSUE_TYPE_UI,
  ProductIssueModal,
  productIssueDraftPayload,
  productIssueDraftProblem,
  type ProductIssueDraftState,
  type ProductIssueModalProps,
} from "../src/web/components/ProductIssueModal.tsx";
import { withOverlayHost } from "./helpers/overlay-host.ts";

/**
 * The Feedback form, at the level a browser cannot check cheaply: exact markup shape.
 *
 * The end-to-end journey in `e2e/specs/product-issue-reporting.spec.ts` is the authority on
 * whether the thing WORKS - a click reaching a route reaching `gh`. What is pinned here is
 * narrower and complements it: that the dialog cannot draw a repository, a label set or a
 * body it invented, and that the screenshot region exposes a real bounded image input. Both
 * are properties of one render, so a case costs a millisecond here and a browser boot there.
 *
 * `createElement` rather than JSX because the runner's glob only matches `.test.ts`.
 */

const PREFLIGHT_READY: ProductIssuePreflight = {
  ready: true,
  target: "acme/public-issues",
  attachments: {
    enabled: true,
    reason: null,
  },
  problems: [],
};

const DRAFT: ProductIssueDraftState = {
  type: "bug",
  title: "Board tiles stop updating after a reconnect",
  details: "Killed the daemon, reconnected, and the tiles froze at their old counts.",
  attachments: [],
};

function preview(overrides: Partial<ProductIssuePreview> = {}): ProductIssuePreview {
  return {
    outcome: "preview",
    requestId: "11111111-2222-4333-8444-555555555555",
    draftIdentity: "a".repeat(64),
    draft: productIssueDraftPayload(DRAFT),
    target: "acme/public-issues",
    labels: ["bug", "status:needs-triage", "source:dashboard"],
    environment: {
      missionControlVersion: "0.1.0",
      platform: "macOS",
      architecture: "arm64",
      client: "browser",
    },
    body: "## Details\n\nKilled the daemon.\n\n<!-- mission-control-product-report:v1 -->",
    attachments: PREFLIGHT_READY.attachments,
    ...overrides,
  };
}

function draw(overrides: Partial<ProductIssueModalProps> = {}): string {
  const props: ProductIssueModalProps = {
    draft: DRAFT,
    onDraftChange: () => {},
    preflight: PREFLIGHT_READY,
    preview: preview(),
    previewProblem: null,
    previewing: false,
    submitting: false,
    result: null,
    retryAllowed: true,
    onSubmit: () => {},
    onClear: () => {},
    onClose: () => {},
    ...overrides,
  };
  return renderToStaticMarkup(withOverlayHost(createElement(ProductIssueModal, props)));
}

test("abandoned renders cannot replace the attachment cleanup refs", () => {
  const source = readFileSync(
    new URL("../src/web/components/ProductIssueModal.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /^  (?:draftRef|clearOnNextOpen)\.current =/m);
  assert.match(source, /useEffect\(\(\) => \{\n    draftRef\.current = draft;\n  \}, \[draft\]\);/);
  assert.match(
    source,
    /useEffect\(\(\) => \{\n    clearOnNextOpen\.current = createdUrl !== null;\n  \}, \[createdUrl\]\);/,
  );
});

test("all five approved report types are offered, in the contract's order", () => {
  const html = draw();
  const order = PRODUCT_ISSUE_TYPES.map((type) => PRODUCT_ISSUE_TYPE_UI[type].label);
  const positions = order.map((label) => html.indexOf(`>${label}<`));
  for (const [index, position] of positions.entries()) {
    assert.ok(position > 0, `type option "${order[index]}" is missing from the form`);
    if (index > 0) {
      assert.ok(
        position > positions[index - 1]!,
        `type option "${order[index]}" is drawn out of the approved order`,
      );
    }
  }
  // The radio's VALUE is the append-only wire value, whatever the label above it says.
  for (const type of PRODUCT_ISSUE_TYPES) assert.match(html, new RegExp(`value="${type}"`));
});

test("the public warning is on screen before anything is filled in", () => {
  const html = draw({ draft: EMPTY_PRODUCT_ISSUE_DRAFT, preview: null });
  assert.match(html, /This is published publicly/);
  assert.match(html, /anyone can read/);
  assert.match(html, /Do not include credentials/);
});

/**
 * The substantive one.
 *
 * Repository, labels, environment and body all come from the daemon's preview object and
 * are re-derived there per call. If this dialog ever composed any of them locally, the two
 * renderings would drift and the public copy would be the one nobody was shown - so what is
 * pinned is that every published fact on screen traces to the response, not to this file.
 */
test("the preview draws the daemon's target, labels, environment and body verbatim", () => {
  const html = draw({
    preview: preview({
      target: "someone-else/elsewhere",
      labels: ["usability", "status:needs-triage", "source:dashboard"],
      body: "## Details\n\nSTRAIGHT FROM THE DAEMON\n\n<!-- mission-control-product-report:v1 -->",
    }),
  });
  assert.match(html, /someone-else\/elsewhere/);
  assert.match(html, /usability, status:needs-triage, source:dashboard/);
  assert.match(html, /STRAIGHT FROM THE DAEMON/);
  assert.match(html, /mission-control-product-report:v1/);
  assert.match(html, /Mission Control 0\.1\.0/);
  assert.match(html, /macOS \/ arm64/);
});

test("a preview for different words than are in the box is not shown as this draft's", () => {
  const stale = preview({
    draft: { ...productIssueDraftPayload(DRAFT), title: "Some older title" },
    target: "stale/target",
  });
  const html = draw({ preview: stale });
  assert.doesNotMatch(html, /stale\/target/);
  // And submit is closed while nothing confirmed describes what is on screen.
  assert.match(html, /<button type="submit"[^>]*disabled=""/);
});

test("the screenshot region offers the bounded first-party attachment input", () => {
  const html = draw();
  assert.match(html, /Choose, paste, or drop up to 5 PNG/);
  assert.match(html, /Each can be at most 10 MB and together at most 25 MB/);
  assert.match(html, /<input type="file"[^>]*multiple=""/);
  assert.doesNotMatch(html, /<input type="file"[^>]*disabled=""/);
  assert.doesNotMatch(html, /is-unavailable/);
});

test("an older GitHub CLI leaves text reports available and explains the screenshot gate", () => {
  const html = draw({
    preflight: {
      ...PREFLIGHT_READY,
      attachments: {
        enabled: false,
        reason: "Screenshot upload requires GitHub CLI 2.99.0 or newer",
      },
    },
  });
  assert.match(html, /GitHub CLI 2\.99\.0 or newer/);
  assert.match(html, /You can still submit a text-only report/);
  assert.match(html, /<input type="file"[^>]*disabled=""/);
  assert.match(html, /is-unavailable/);
});

test("an unavailable preflight does not claim that text-only submission is available", () => {
  const checking = draw({ preflight: null, preview: null });
  assert.match(checking, /Checking GitHub CLI screenshot support/);
  assert.doesNotMatch(checking, /still submit a text-only report/);

  const blocked = draw({
    preflight: {
      ready: false,
      target: "acme/public-issues",
      attachments: PREFLIGHT_READY.attachments,
      problems: [{ code: "gh-auth", message: "GitHub CLI is not authenticated" }],
    },
    preview: null,
  });
  assert.match(blocked, /GitHub CLI is not authenticated/);
  assert.doesNotMatch(blocked, /still submit a text-only report/);
});

test("submit is closed until the draft validates, preflight is ready and a preview matches", () => {
  const disabled = /<button type="submit"[^>]*disabled=""/;
  assert.match(draw({ draft: EMPTY_PRODUCT_ISSUE_DRAFT, preview: null }), disabled);
  assert.match(draw({ preflight: null, preview: null }), disabled);
  assert.match(
    draw({
      preflight: {
        ready: false,
        target: "acme/public-issues",
        attachments: PREFLIGHT_READY.attachments,
        problems: [{ code: "gh-auth", message: "GitHub CLI is not authenticated; run `gh auth login`" }],
      },
    }),
    disabled,
  );
  assert.match(draw({ preview: null }), disabled);
  assert.match(draw({ submitting: true }), disabled);
  // Everything in hand: the one state where publishing is possible.
  assert.doesNotMatch(draw(), disabled);
});

test("the ready form offers one report action without an armed intermediate state", () => {
  const html = draw();
  assert.match(html, /<button type="submit"[^>]*aria-label="Report publicly"/);
  assert.match(html, /data-product-issue-report=""/);
  assert.doesNotMatch(html, /data-product-issue-(?:request-id|draft-identity)/);
  assert.doesNotMatch(html, /Publish to acme\/public-issues/);
  assert.doesNotMatch(html, /Ready to publish/);
});

/**
 * The daemon's derivation moved between reading and pressing.
 *
 * The refusal is what the person sees, and the draft survives it - the words were never the
 * problem. The Layer re-previews on this outcome so the next press is made against content
 * that has been rendered; what is pinned here is that the refusal reads as one more try
 * rather than as a dead end.
 */
test("a stale-confirmation refusal keeps the draft and invites another read", () => {
  const html = draw({
    preview: null,
    result: {
      outcome: "refused",
      message:
        "This report was not confirmed, or its confirmation has already been used; " +
        "review the public content and report it again",
      retrySafe: true,
    },
  });
  assert.match(html, /review the public content and report it again/);
  assert.match(html, /Board tiles stop updating after a reconnect/);
  // Disabled only because the refreshed preview has not landed yet - not because the report
  // is over. The unknown-outcome case above is the one that really closes the door.
  assert.match(html, /<button type="submit"[^>]*disabled=""/);
  assert.doesNotMatch(html, /Check the target repository/);
});

test("a blocked preflight names the missing thing rather than a generic failure", () => {
  const html = draw({
    preflight: {
      ready: false,
      target: "acme/public-issues",
      attachments: PREFLIGHT_READY.attachments,
      problems: [
        {
          code: "labels",
          message: "Create the missing labels in acme/public-issues: usability, source:agent",
        },
      ],
    },
  });
  assert.match(html, /Create the missing labels in acme\/public-issues: usability, source:agent/);
});

test("a created issue offers its URL, and a refusal invites another try", () => {
  const created: ProductIssueSubmitResult = {
    outcome: "created",
    issueUrl: "https://github.com/acme/public-issues/issues/7",
    target: "acme/public-issues",
  };
  const createdHtml = draw({ result: created });
  assert.match(createdHtml, /View GitHub issue/);
  assert.match(createdHtml, /https:\/\/github\.com\/acme\/public-issues\/issues\/7/);
  // The submit control is GONE, replaced by the issue it produced. Left in place it would
  // invite a second press, and the daemon answers that with an uncertain result rather than
  // a refusal - the worst possible answer to a duplicate public issue.
  assert.doesNotMatch(createdHtml, /Report publicly/);
  assert.match(createdHtml, /feedback-created-action/);
  assert.match(
    createdHtml,
    /feedback-created-actions[^]*?<button[^>]*>Close<\/button>[^]*?View GitHub issue/,
  );

  const refused: ProductIssueSubmitResult = {
    outcome: "refused",
    message: "GitHub CLI refused the issue: label not found",
    retrySafe: true,
  };
  const refusedHtml = draw({ result: refused });
  assert.match(refusedHtml, /label not found/);
  // Retry-safe means exactly that: the button is still live, and the draft is still there.
  assert.doesNotMatch(refusedHtml, /<button type="submit"[^>]*disabled=""/);
  assert.match(refusedHtml, /Board tiles stop updating after a reconnect/);
});

/**
 * An unknown outcome is the one result that must NOT invite a retry.
 *
 * The daemon could not tell whether the issue was created, so retrying is how a duplicate
 * public issue gets filed under someone else's name. The recovery it offers instead is the
 * only one that can actually answer the question: go look at the repository.
 */
test("an unknown outcome disables retry for the opening and sends the reader to GitHub", () => {
  const html = draw({
    result: {
      outcome: "unknown",
      message: "GitHub issue creation did not report back",
      retrySafe: false,
    },
    retryAllowed: false,
  });
  assert.match(html, /GitHub issue creation did not report back/);
  assert.match(html, /Check the target repository/);
  assert.match(html, /<button type="submit"[^>]*disabled=""/);
});

test("the draft's own bounds match the schema the daemon enforces", () => {
  assert.equal(productIssueDraftProblem(EMPTY_PRODUCT_ISSUE_DRAFT), "Add a short title.");
  assert.equal(
    productIssueDraftProblem({ ...EMPTY_PRODUCT_ISSUE_DRAFT, title: "  x  " }),
    "Describe what happened.",
  );
  assert.equal(productIssueDraftProblem(DRAFT), null);
  assert.match(
    productIssueDraftProblem({ ...DRAFT, title: "x".repeat(201) }) ?? "",
    /200-character limit/,
  );
});

/**
 * The wire payload carries reporter content and nothing else.
 *
 * Not a restatement of the schema: this is the browser side of the same claim, and it is the
 * side a well-meaning refactor could break by "helpfully" attaching a repository, a source or
 * a local screenshot path to the request.
 */
test("the request the browser builds carries reporter content only", () => {
  const payload = productIssueDraftPayload({
    ...DRAFT,
    title: "  trimmed  ",
    attachments: [
      {
        id: "att-1",
        name: "shot.png",
        previewUrl: "blob:local",
        status: "ready",
        upload: { path: "/Users/someone/Library/mission/uploads/shot.png", name: "shot.png" },
        uploadId: "upload-1",
      },
    ],
  });
  assert.deepEqual(Object.keys(payload).sort(), [
    "attachmentUploadIds",
    "details",
    "title",
    "type",
  ]);
  assert.equal(payload.title, "trimmed");
  assert.deepEqual(payload.attachmentUploadIds, ["upload-1"]);
  // The daemon's opaque locator, never the local path the agent-prompt attachments use.
  assert.doesNotMatch(JSON.stringify(payload), /\/Users\//);
});
