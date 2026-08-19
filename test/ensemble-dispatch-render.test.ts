// What is at stake: the new-dispatch modal grows an Ensemble mode WITHOUT a second composer, a
// new DraftKind, or client-side plan compilation. The launch is a deliberate review-then-confirm
// whose confirmation a later edit invalidates, and its idempotency key is stable across retries.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { WorkflowSummary, WorkflowVersionMetadata } from "../src/shared/workflow.ts";
import type { PersonaView } from "../src/shared/workflow.ts";
import type { HarnessModelCatalogs } from "../src/shared/protocol.ts";
import {
  compatibilityForWorkflowVersion,
  EnsembleDispatch,
  EnsembleLaunchControls,
  useEnsembleLaunch,
  workflowVersionCompatibilityKey,
  type EnsembleLaunchState,
} from "../src/web/ensembles/dispatch/EnsembleDispatch.tsx";
import {
  buildEnsembleCreateInput,
  ensemblePreviewFingerprint,
  freshEnsembleDraft,
  getConfigPath,
  setConfigPath,
  type EnsembleDispatchDraft,
} from "../src/web/ensembles/dispatch/config.ts";
import type { EnsemblePreviewResult } from "../src/web/ensembles/types.ts";
import {
  BrowserModelCatalogStore,
  ModelCatalogProvider,
  shippedModelCatalogs,
} from "../src/web/model-catalog.tsx";

const compose = { repoRoot: "/repo", title: "Ship it", intent: "do the thing", attachments: [] };

const persona = (
  id: string,
  name: string,
  normalizedName: string,
  builtin: boolean,
): PersonaView => ({
  id,
  name,
  normalizedName,
  description: "",
  guidanceMarkdown: "# Review",
  runner: null,
  model: null,
  revision: builtin ? 1 : 3,
  archivedAt: null,
  createdAt: builtin ? 0 : 1,
  updatedAt: builtin ? 0 : 1,
  provenance: null,
  builtin,
  execution: {
    runner: { id: "claude", source: "default", unknown: null },
    model: { id: "claude-haiku-4-5", source: "default" },
  } as PersonaView["execution"],
});

/**
 * The body plus the footer controls, wired through the real hook - the same pairing the
 * dispatch modal renders. Static markup means no preview has happened, so the footer is in
 * its unreviewed state (Review launch in the primary slot).
 */
function render(over: Partial<{
  ensemble: EnsembleDispatchDraft;
  personas: PersonaView[];
  workflowSummaries: WorkflowSummary[];
  uploading: boolean;
  modelStore: BrowserModelCatalogStore;
}> = {}): string {
  const props = {
    ensemble: freshEnsembleDraft(),
    personas: [] as PersonaView[],
    workflowSummaries: [] as WorkflowSummary[],
    uploading: false,
    ...over,
  };
  function Harness(): React.JSX.Element {
    const launch = useEnsembleLaunch({
      compose,
      ensemble: props.ensemble,
      onEnsembleChange: () => {},
      uploading: props.uploading,
      onLaunched: () => {},
    });
    return createElement(
      "div",
      null,
      createElement(EnsembleDispatch, {
        ensemble: props.ensemble,
        onEnsembleChange: () => {},
        personas: props.personas,
        workflowSummaries: props.workflowSummaries,
        launch,
      }),
      createElement(EnsembleLaunchControls, { launch }),
    );
  }
  const content = createElement(Harness);
  return renderToStaticMarkup(
    props.modelStore
      ? createElement(ModelCatalogProvider, { store: props.modelStore, children: content })
      : content,
  );
}

function livePiStore(): BrowserModelCatalogStore {
  const current: HarnessModelCatalogs = {
    ...shippedModelCatalogs(),
    pi: {
      choices: [
        {
          id: "openai/gpt-5.6-sol",
          label: "GPT-5.6 Sol",
          hint: null,
          provider: "openai",
          contextWindow: null,
          reasoning: true,
          inputModes: ["text"],
        },
        {
          id: "anthropic/claude-sonnet-5",
          label: "Claude Sonnet 5",
          hint: null,
          provider: "anthropic",
          contextWindow: null,
          reasoning: true,
          inputModes: ["text"],
        },
      ],
      source: "live",
      refreshedAt: "2026-08-18T15:00:00.000Z",
      problem: null,
    },
  };
  return new BrowserModelCatalogStore(async () => current, {
    catalogs: current,
    phase: "ready",
    pending: false,
  });
}

/** A fabricated post-review state, for pinning the footer's reviewed rendering. */
function reviewedLaunch(over: Partial<EnsembleLaunchState> = {}): EnsembleLaunchState {
  return {
    active: true,
    reviewed: true,
    previewing: false,
    launching: false,
    uploading: false,
    hasCompose: true,
    canLaunch: true,
    preview: {
      ok: true,
      reason: null,
      issues: [],
      estimate: { initialMembers: 3, maxMembers: 3, maxConcurrentMembers: 3, maxWaves: 1, evaluationCalls: 1 },
      workflow: null,
    } satisfies EnsemblePreviewResult,
    previewIssues: [],
    workflowUnsupported: false,
    launchError: null,
    estimate: { initialMembers: 3, maxMembers: 3, maxConcurrentMembers: 3, maxWaves: 1, evaluationCalls: 1 },
    review: async () => {},
    launchNow: async () => {},
    ...over,
  };
}

test("a fresh ensemble draft is Best-of-N, with a request id and three defaulted candidates", () => {
  const draft = freshEnsembleDraft();
  assert.equal(draft.strategyId, "best_of_n");
  assert.ok(draft.requestId.length > 0);
  assert.equal(draft.previewFingerprint, null);
  const members = getConfigPath(draft.config, "members") as unknown[];
  assert.equal(members.length, 3);
});

test("editing config invalidates the preview fingerprint, but the request id never does", () => {
  const draft = freshEnsembleDraft();
  const base = ensemblePreviewFingerprint(buildEnsembleCreateInput(compose, "do the thing", draft));
  const edited = { ...draft, config: setConfigPath(draft.config, "maxConcurrentMembers", 2) };
  const editedFp = ensemblePreviewFingerprint(buildEnsembleCreateInput(compose, "do the thing", edited));
  assert.notEqual(base, editedFp);
  // The idempotency key is deliberately NOT part of the fingerprint: a retry with the same key
  // and the same content must still count as reviewed.
  const rekeyed = { ...draft, requestId: "another-key" };
  assert.equal(ensemblePreviewFingerprint(buildEnsembleCreateInput(compose, "do the thing", rekeyed)), base);
});

test("the dispatch renders descriptor-driven strategy segments, lanes, and a two-step launch", () => {
  const html = render();
  assert.match(html, /Best of N/); // the strategy segment, from ENSEMBLE_STRATEGY_INFO
  assert.match(html, /aria-label="Ensemble strategy"/); // one segmented control, not a card grid
  assert.match(html, /aria-label="Candidate 1 agent"/); // lanes are keyboard reachable
  assert.match(html, /aria-label="Candidate 3 approach"/); // three default rows
  assert.match(html, /Review launch/); // unreviewed: Review holds the primary slot
  assert.doesNotMatch(html, /Launch 3 agents/); // Launch appears only once the plan is reviewed
  assert.match(html, /will push or open a pull request/i); // the publishing-prohibition rule, stated before launch
  assert.match(html, /A person confirms the winner/); // the destructive-decision requirement
  assert.match(html, /base pinned at launch/); // the plan strip names the pin
  assert.match(html, /Judged by/); // the evaluator selector (config carries an evaluator)
  assert.match(html, /no workflow/i); // the optional workflow-placement selector
});

test("Pi ensemble members and the plan strip share the live provider catalog", () => {
  const draft = freshEnsembleDraft();
  const members = structuredClone(getConfigPath(draft.config, "members")) as Record<string, unknown>[];
  members[0] = {
    ...members[0],
    agent: "pi",
    model: "anthropic/claude-sonnet-5",
  };
  const html = render({
    ensemble: { ...draft, config: setConfigPath(draft.config, "members", members) },
    modelStore: livePiStore(),
  });

  assert.match(html, /<optgroup label="openai">/);
  assert.match(html, /<optgroup label="anthropic">/);
  assert.match(html, /value="anthropic\/claude-sonnet-5" selected/);
  assert.match(html, /Claude Sonnet 5/);
});

test("dispatch Persona selectors hide a built-in shadowed by an operator row", () => {
  const operator = persona("operator", "CODE RISK REVIEWER", "code risk reviewer", false);
  const builtin = persona("builtin:code-risk-reviewer", "Code Risk Reviewer", "code risk reviewer", true);
  for (const html of [
    render({ personas: [operator, builtin] }),
    render({ ensemble: freshEnsembleDraft("panel_vote"), personas: [operator, builtin] }),
  ]) {
    assert.match(html, /value="(?:persona:)?operator"/);
    assert.doesNotMatch(html, /value="(?:persona:)?builtin:code-risk-reviewer"/);
  }
});

test("dispatch Persona selectors retain a shadowed current selection", () => {
  const operator = persona("operator", "CODE RISK REVIEWER", "code risk reviewer", false);
  const builtin = persona("builtin:code-risk-reviewer", "Code Risk Reviewer", "code risk reviewer", true);

  const best = freshEnsembleDraft();
  const bestWithPersona = {
    ...best,
    config: setConfigPath(
      setConfigPath(best.config, "evaluator.personaId", builtin.id),
      "evaluator.personaRevision",
      builtin.revision,
    ),
  };

  const panel = freshEnsembleDraft("panel_vote");
  const judges = structuredClone(getConfigPath(panel.config, "judges")) as Record<string, unknown>[];
  judges[0] = {
    ...judges[0],
    personaId: builtin.id,
    personaRevision: builtin.revision,
  };
  const panelWithPersona = {
    ...panel,
    config: setConfigPath(panel.config, "judges", judges),
  };

  for (const html of [
    render({ ensemble: bestWithPersona, personas: [operator, builtin] }),
    render({ ensemble: panelWithPersona, personas: [operator, builtin] }),
  ]) {
    assert.match(html, /Code Risk Reviewer \(Built-in, shadowed by your Persona\)/);
    assert.match(html, /value="(?:persona:)?operator"/);
  }
});

test("a forged Foreman evaluator remains unavailable outside the supplied Persona catalog", () => {
  const draft = freshEnsembleDraft();
  const forged = {
    ...draft,
    config: setConfigPath(
      setConfigPath(draft.config, "evaluator.personaId", "foreman"),
      "evaluator.personaRevision",
      1,
    ),
  };
  const html = render({ ensemble: forged, personas: [persona("p1", "Reviewer", "reviewer", false)] });
  assert.match(html, /Unavailable: foreman/);
  assert.doesNotMatch(html, /<option value="foreman">Foreman<\/option>/);
});

test("a reviewed plan puts Launch in the primary slot with a Reviewed chip beside it", () => {
  const html = renderToStaticMarkup(
    createElement(EnsembleLaunchControls, { launch: reviewedLaunch() }),
  );
  assert.match(html, /Reviewed ✓/);
  assert.match(html, /Launch 3 agents/);
  assert.doesNotMatch(html, /Review launch/);
});

test("an unsuccessful or unrestored preview keeps Review in the primary slot", () => {
  const refused = renderToStaticMarkup(
    createElement(EnsembleLaunchControls, {
      launch: reviewedLaunch({
        canLaunch: false,
        preview: {
          ok: false,
          reason: "invalid plan",
          issues: [],
          estimate: {
            initialMembers: 3,
            maxMembers: 3,
            maxConcurrentMembers: 3,
            maxWaves: 1,
            evaluationCalls: 1,
          },
          workflow: null,
        },
      }),
    }),
  );
  const reopened = renderToStaticMarkup(
    createElement(EnsembleLaunchControls, {
      launch: reviewedLaunch({ canLaunch: false, preview: null }),
    }),
  );
  for (const html of [refused, reopened]) {
    assert.match(html, /Review launch/);
    assert.doesNotMatch(html, /Reviewed ✓/);
    assert.doesNotMatch(html, /Launch 3 agents/);
  }
});

test("workflow placement leaves unselected versions lazy", () => {
  const workflow: WorkflowSummary = {
    id: "workflow-1",
    name: "Review winner",
    description: "",
    draftRevision: 1,
    currentVersionId: "workflow-version-1",
    publishedVersion: 1,
    archivedAt: null,
    updatedAt: 1,
    errorCount: 0,
    warningCount: 0,
    nodeCount: 2,
    personaCount: 0,
    builtin: false,
  };
  const html = render({ workflowSummaries: [workflow] });
  assert.match(html, /Review winner \(v1\)/);
  // Unselected versions are never probed: no per-option compatibility fetch, no status.
  assert.doesNotMatch(html, /Review winner \(v1\) · checking compatibility/);
});

test("workflow placement identifies unsupported Live and Foreman modes", () => {
  const version: WorkflowVersionMetadata = {
    id: "workflow-version-1",
    workflowId: "workflow-1",
    version: 1,
    sourceDraftRevision: 1,
    completionPolicy: { kind: "none" },
    resumptionPolicy: "manual",
    bindingDefaults: {
      triggerMode: "manual",
      deliveryMode: "preview",
      maxRepairRounds: 5,
    },
    publishedAt: 1,
  };
  assert.deepEqual(compatibilityForWorkflowVersion(version), {
    supported: true,
    reason: null,
  });
  assert.match(
    compatibilityForWorkflowVersion({
      ...version,
      bindingDefaults: { ...version.bindingDefaults, deliveryMode: "live" },
    }).reason ?? "",
    /Live delivery is not available/,
  );
  assert.match(
    compatibilityForWorkflowVersion({
      ...version,
      bindingDefaults: { ...version.bindingDefaults, triggerMode: "foreman_complete" },
    }).reason ?? "",
    /trigger mode is not available/,
  );
});

test("workflow compatibility loads selected metadata by pinned version", () => {
  const workflow: WorkflowSummary = {
    id: "workflow-1",
    name: "Review winner",
    description: "",
    draftRevision: 2,
    currentVersionId: "workflow-version-2",
    publishedVersion: 2,
    archivedAt: null,
    updatedAt: 2,
    errorCount: 0,
    warningCount: 0,
    nodeCount: 2,
    personaCount: 0,
    builtin: false,
  };
  const ensemble = {
    ...freshEnsembleDraft(),
    workflow: { workflowId: workflow.id, workflowVersion: 1 },
  };
  const html = render({ ensemble, workflowSummaries: [workflow] });
  assert.match(html, /Review winner \(v1\) · pinned · checking compatibility/);
  assert.match(html, /Review winner \(v2\)/);
  assert.notEqual(
    workflowVersionCompatibilityKey(workflow.id, 1),
    workflowVersionCompatibilityKey(workflow.id, 2),
  );

  const source = readFileSync(
    new URL("../src/web/ensembles/dispatch/EnsembleDispatch.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /workflowRequest<WorkflowVersionMetadata\[\]>/);
  assert.match(source, /item\.version === selectedVersion/);
  assert.doesNotMatch(source, /Promise\.all/);
  assert.doesNotMatch(source, /versions\/\$\{workflow\.publishedVersion\}/);
});

test("uploading attachments blocks the launch controls", () => {
  // Unreviewed: Review is disabled while an upload is in flight (an image still uploading
  // has no path yet, so the plan under review would be missing its screenshot).
  const unreviewed = render({ uploading: true });
  assert.match(unreviewed, /class="btn btn-primary" disabled=""[^>]*>Review launch/);
  // Reviewed: the primary reads Uploading and is disabled.
  const html = renderToStaticMarkup(
    createElement(EnsembleLaunchControls, {
      launch: reviewedLaunch({ uploading: true, canLaunch: false }),
    }),
  );
  assert.match(html, /Uploading…<\/button>/);
  assert.match(html, /class="btn btn-primary"[^>]*disabled/);
});

test("the dispatch modal wires Single/Ensemble mode with no second composer and no new DraftKind", () => {
  const modal = readFileSync(new URL("../src/web/components/DispatchModal.tsx", import.meta.url), "utf8");
  assert.match(modal, /dispatch-mode-toggle/);
  assert.match(modal, /<EnsembleDispatch/);
  assert.match(modal, /const ensembleMode =/);
  // Backlog edit stays Single-only: the toggle only renders for a new dispatch.
  assert.match(modal, /!editing && onLaunchModeChange/);
  // Dispatch is its own attachment surface; it introduces no session DraftKind.
  assert.doesNotMatch(modal, /DraftKind/);
});

test("preview and launch reconciliation preserve newer dispatch input", () => {
  const dispatch = readFileSync(
    new URL("../src/web/ensembles/dispatch/EnsembleDispatch.tsx", import.meta.url),
    "utf8",
  );
  const modal = readFileSync(new URL("../src/web/components/DispatchModal.tsx", import.meta.url), "utf8");
  assert.match(dispatch, /const ensembleRef = useRef\(ensemble\)/);
  assert.match(dispatch, /currentFingerprint !== submittedFingerprint/);
  assert.doesNotMatch(dispatch, /onEnsembleChange\(\{ \.\.\.ensemble, previewFingerprint: fingerprint \}\)/);
  assert.match(modal, /draftsEqual\(draftRef\.current, submitted\)/);
  assert.match(modal, /ensembleDraftsEqual\(ensembleDraftRef\.current, submittedEnsemble\)/);
  assert.match(modal, /const draftChanged =/);
  assert.match(modal, /requestId: crypto\.randomUUID\(\)/);
  assert.match(
    modal,
    /if \(draftChanged\) \{[\s\S]*?\} else \{[\s\S]*?\}\s*onEnsembleLaunched\?\.\(runId\);\s*onClose\(\);/,
  );
});

test("review uses server estimates, routes nested issues, and hides unsupported task metadata", () => {
  const dispatch = readFileSync(
    new URL("../src/web/ensembles/dispatch/EnsembleDispatch.tsx", import.meta.url),
    "utf8",
  );
  const modal = readFileSync(new URL("../src/web/components/DispatchModal.tsx", import.meta.url), "utf8");
  assert.match(dispatch, /reviewed && preview \? preview\.estimate : liveEstimate/);
  assert.match(dispatch, /normalizeIssuePath/);
  // Repeated-row fields address their issues at the key the FORM declared, not at a literal
  // "members" - there are two of them now (the candidate roster and the judge panel), and a
  // hard-coded path would silently route one field's issues onto the other.
  assert.match(dispatch, /\$\{fieldKey\}\.\$\{index\}/);
  assert.match(dispatch, /workflowVersionId/);
  // Task metadata an Ensemble cannot carry (priority, labels, dependencies) lives inside
  // the Single-only backlog-details fold, so Ensemble mode never renders it.
  assert.match(modal, /\{!ensembleMode && \(\s*<div className="dispatch-more-wrap">[\s\S]*?Priority/);
});
