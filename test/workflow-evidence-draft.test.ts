import test from "node:test";
import assert from "node:assert/strict";
import { WORKFLOW_IMAGE_LIMITS } from "../src/shared/workflow.ts";
import {
  workflowEvidenceSubmission,
  type WorkflowEvidenceDraft,
} from "../src/web/workflows/WorkflowEvidenceComposer.tsx";
import type { PendingAttachment } from "../src/web/components/ImageDrop.tsx";

const scopes = [
  { value: "all" as const, label: "All repositories" },
  { value: "repo-01" as const, label: "app (primary)" },
];

function attachment(
  id: string,
  over: Partial<PendingAttachment> = {},
): PendingAttachment {
  return {
    id,
    name: `${id}.png`,
    previewUrl: `blob:${id}`,
    status: "ready",
    upload: { path: `/private/uploads/${id}.png`, name: `${id}.png` },
    uploadId: `opaque-${id}.png`,
    bytes: 1024,
    mimeType: "image/png",
    ...over,
  };
}

function controller(draft: WorkflowEvidenceDraft, over: Record<string, unknown> = {}) {
  return {
    draft,
    staged: { generation: 0, images: [], artifacts: [] },
    stagedLoading: false,
    stagedError: null,
    ...over,
  } as Parameters<typeof workflowEvidenceSubmission>[0];
}

test("ready evidence keeps stable client ids across a request retry", () => {
  const draft: WorkflowEvidenceDraft = {
    attachments: [attachment("stable")],
    metadata: { stable: { caption: "Rendered dashboard", repositoryScope: "repo-01" } },
  };
  const first = workflowEvidenceSubmission(controller(draft), scopes);
  const retry = workflowEvidenceSubmission(controller(draft), scopes);
  assert.equal(first.ready, true);
  assert.deepEqual(retry.locators, first.locators);
  assert.equal(first.locators[0]?.clientItemId, "stable");
  assert.doesNotMatch(JSON.stringify(first.locators), /private\/uploads/);
});

test("pending, failed, missing-caption, and invalid-scope drafts cannot capture", () => {
  const draft: WorkflowEvidenceDraft = {
    attachments: [
      attachment("pending", { status: "uploading", upload: undefined, uploadId: undefined, bytes: undefined }),
      attachment("failed", { status: "error", upload: undefined, uploadId: undefined, bytes: undefined, error: "bad pixels" }),
      attachment("invalid"),
    ],
    metadata: {
      pending: { caption: "Pending", repositoryScope: "repo-01" },
      failed: { caption: "Failed", repositoryScope: "repo-01" },
      invalid: { caption: "", repositoryScope: "repo-99" },
    },
  };
  const result = workflowEvidenceSubmission(controller(draft), scopes);
  assert.equal(result.ready, false);
  assert.match(result.errors.join(" "), /still pending/);
  assert.match(result.errors.join(" "), /upload failed/);
  assert.match(result.errors.join(" "), /needs a caption/);
  assert.match(result.errors.join(" "), /needs a repository scope/);
});

test("caption, count, per-image, aggregate, and staged-load bounds are enforced together", () => {
  const attachments = Array.from({ length: WORKFLOW_IMAGE_LIMITS.maxCount }, (_, index) =>
    attachment(`image-${index}`, {
      bytes: index === 0 ? WORKFLOW_IMAGE_LIMITS.maxBytesPerImage + 1 : 1024,
    }));
  const metadata = Object.fromEntries(attachments.map((item, index) => [
    item.id,
    {
      caption: index === 0 ? "x".repeat(WORKFLOW_IMAGE_LIMITS.captionChars + 1) : `Image ${index}`,
      repositoryScope: "repo-01" as const,
    },
  ]));
  const result = workflowEvidenceSubmission(controller(
    { attachments, metadata },
    {
      staged: {
        generation: 2,
        images: [{
          id: "staged",
          clientItemId: "agent-staged",
          sourceKind: "agent",
          displayName: "staged.png",
          caption: "Agent registered",
          repositoryScope: "repo-01",
          mimeType: "image/png",
          bytes: WORKFLOW_IMAGE_LIMITS.maxAggregateBytes,
          sha256: "a".repeat(64),
          generation: 2,
          createdAt: 1,
          updatedAt: 1,
        }],
        artifacts: [],
      },
      stagedError: "generation could not be read",
    },
  ), scopes);
  assert.equal(result.ready, false);
  const errors = result.errors.join(" ");
  assert.match(errors, /longer than 1000/);
  assert.match(errors, /larger than 5 MiB/);
  assert.match(errors, /At most 8 images/);
  assert.match(errors, /larger than 20 MiB/);
  assert.match(errors, /Registered evidence is unavailable/);
});
