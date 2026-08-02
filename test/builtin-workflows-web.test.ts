import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkflowSummary, WorkflowVersionMetadata } from "../src/shared/workflow.ts";
import { WorkflowLibrary } from "../src/web/workflows/WorkflowLibrary.tsx";
import { WorkflowStateNotice } from "../src/web/workflows/WorkflowLibrary.tsx";
import { WorkflowVersionHistory } from "../src/web/workflows/WorkflowVersionHistory.tsx";
import { workflowValidSentence } from "../src/web/workflows/WorkflowProperties.tsx";
import {
  workflowArchiveBlocked,
  workflowPublishBlocked,
  workflowSavePreflight,
} from "../src/web/workflows/useWorkflowDraft.ts";
import type { LlmState } from "../src/web/useLlm.ts";
import type { WorkflowDefinition } from "../src/shared/workflow.ts";

// What is at stake: an operator opening the shipped workflow has to be told why it will not
// take an edit, and told the RIGHT reason. The daemon refuses every write, so a control that
// still looks live is a button whose only outcome is an error banner - and a sentence naming
// the wrong cause ("Archived", about a workflow nobody archived) sends them looking for a
// control that would not have helped. Duplicate is the way forward and has to say so.

const llm: LlmState = {
  config: null,
  status: null,
  personaDefaults: null,
  error: null,
  update: async () => {},
};

const summary = (overrides: Partial<WorkflowSummary> = {}): WorkflowSummary => ({
  id: "builtin-workflow:no-mistakes-review",
  name: "No-Mistakes Review",
  description: "",
  draftRevision: 1,
  currentVersionId: "builtin-workflow:no-mistakes-review@1",
  publishedVersion: 1,
  archivedAt: null,
  updatedAt: 0,
  errorCount: 0,
  warningCount: 0,
  nodeCount: 7,
  personaCount: 4,
  builtin: true,
  ...overrides,
});

test("the library row marks a built-in and leaves an operator's own workflow unmarked", () => {
  // Mounted directly, because the builder is a Library surface now rather than a tab on the
  // Workflows page - the component under test is the same one either way.
  const html = renderToStaticMarkup(createElement(WorkflowLibrary, {
    summaries: [summary(), summary({ id: "mine", name: "My review", builtin: false })],
    personas: [],
    hasSnapshot: true,
    onDirtyChange: () => {},
  }));
  assert.match(html, /<em class="wf-list-tag">Built-in<\/em>/);
  assert.equal(html.match(/wf-list-tag/g)?.length, 1, "only the built-in carries the tag");
  assert.match(html, /No-Mistakes Review/);
  assert.match(html, /read-only, Duplicate to customize/);
});

test("the built-in sentence names Duplicate and takes precedence over an archived one", () => {
  const builtin = renderToStaticMarkup(createElement(WorkflowStateNotice, {
    builtin: true,
    archived: false,
  }));
  assert.match(builtin, /class="wf-state builtin"/);
  assert.match(builtin, /ships with Mission Control/);
  assert.match(builtin, /Duplicate it to make a copy you own/);

  const archived = renderToStaticMarkup(createElement(WorkflowStateNotice, {
    builtin: false,
    archived: true,
  }));
  assert.match(archived, /class="wf-state archived"/);
  assert.match(archived, /Archived/);

  // The precedence claim, stated directly: an operator reading "Archived" about a workflow
  // they never archived would go looking for the wrong control.
  const both = renderToStaticMarkup(createElement(WorkflowStateNotice, {
    builtin: true,
    archived: true,
  }));
  assert.match(both, /ships with Mission Control/);
  assert.doesNotMatch(both, /Archived/);

  assert.equal(
    renderToStaticMarkup(createElement(WorkflowStateNotice, { builtin: false, archived: false })),
    "",
  );
});

test("Archive, Publish and autosave are all off for a built-in", () => {
  const ready = {
    dirty: false,
    saving: false,
    conflicted: false,
    valid: true,
    alreadyPublished: false,
    archived: false,
  };
  assert.equal(workflowPublishBlocked({ ...ready, builtin: false }), false);
  assert.equal(workflowPublishBlocked({ ...ready, builtin: true }), true);

  assert.equal(
    workflowArchiveBlocked({ transitioning: false, archived: false, builtin: false }),
    false,
  );
  assert.equal(
    workflowArchiveBlocked({ transitioning: false, archived: false, builtin: true }),
    true,
  );

  // And the save state machine itself never PATCHes one, so a missed `readOnly` prop is a
  // control that does nothing rather than a read-only workflow raising a save error.
  const workflow = (builtin: boolean): WorkflowDefinition => ({
    id: "w",
    name: "Review",
    normalizedName: "review",
    description: "edited",
    draft: { nodes: [], edges: [] },
    completionPolicy: { kind: "none" },
    resumptionPolicy: "manual",
    bindingDefaults: { triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 },
    draftRevision: 1,
    currentVersionId: null,
    archivedAt: null,
    createdAt: 0,
    updatedAt: 0,
    builtin,
  });
  assert.equal(workflowSavePreflight(workflow(false), null, "stale"), "save");
  assert.equal(workflowSavePreflight(workflow(true), null, "stale"), "clean");
});

test("a clean built-in draft is not offered as ready to publish", () => {
  // The rail sits beside a Publish button that is deliberately off. "Ready to publish" there
  // reads as a broken control rather than as a workflow that shipped already published.
  assert.equal(workflowValidSentence(false), "Ready to publish.");
  assert.equal(workflowValidSentence(true), "Published with this build.");
});

test("a shipped version reports its provenance where a row would print a date", () => {
  const metadata: WorkflowVersionMetadata = {
    id: "builtin-workflow:no-mistakes-review@1",
    workflowId: "builtin-workflow:no-mistakes-review",
    version: 1,
    sourceDraftRevision: 1,
    completionPolicy: { kind: "inspector", onFindings: "restart_workflow", missingPrAction: "offer_prepare_pr" },
    resumptionPolicy: "manual",
    bindingDefaults: { triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 },
    publishedAt: 0,
  };
  const html = renderToStaticMarkup(createElement(WorkflowVersionHistory, {
    versions: [metadata],
    personas: [],
    builtin: true,
  }));
  assert.match(html, /Version 1/);
  assert.match(html, /Built-in · ships with this build/);
  // A shipped version carries `publishedAt: 0`; printing that instant renders 1970 beside the
  // flagship workflow.
  assert.doesNotMatch(html, /1970/);
});
