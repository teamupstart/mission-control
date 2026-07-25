// What is at stake: the new-dispatch modal grows an Ensemble mode WITHOUT a second composer, a
// new DraftKind, or client-side plan compilation. The launch is a deliberate review-then-confirm
// whose confirmation a later edit invalidates, and its idempotency key is stable across retries.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { EnsembleDispatch } from "../src/web/ensembles/dispatch/EnsembleDispatch.tsx";
import {
  buildEnsembleCreateInput,
  ensemblePreviewFingerprint,
  freshEnsembleDraft,
  getConfigPath,
  setConfigPath,
} from "../src/web/ensembles/dispatch/config.ts";

const compose = { repoRoot: "/repo", title: "Ship it", intent: "do the thing", attachments: [] };

function render(over: Partial<Parameters<typeof EnsembleDispatch>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(EnsembleDispatch, {
      compose,
      ensemble: freshEnsembleDraft(),
      onEnsembleChange: () => {},
      uploading: false,
      personas: [],
      workflowSummaries: [],
      onLaunched: () => {},
      ...over,
    }),
  );
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

test("the dispatch renders descriptor-driven strategy cards, a roster, and a two-step launch", () => {
  const html = render();
  assert.match(html, /Best of N/); // the strategy card, from ENSEMBLE_STRATEGY_INFO
  assert.match(html, /aria-label="Candidate 1 agent"/); // roster rows are keyboard reachable
  assert.match(html, /aria-label="Candidate 3 approach"/); // three default rows
  assert.match(html, /Review launch/);
  assert.match(html, /Launch 3 agents/);
  assert.match(html, /will push or open a pull request/i); // the publishing-prohibition rule, stated before launch
  assert.match(html, /A person confirms the winner/); // the destructive-decision requirement
  assert.match(html, /Evaluator guidance/); // the evaluator selector (config carries an evaluator)
  assert.match(html, /no workflow/i); // the optional workflow-placement selector
});

test("uploading attachments blocks the launch controls", () => {
  const html = render({ uploading: true });
  // The primary launch button reads Uploading and is disabled while an upload is in flight.
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
  assert.match(modal, /requestId: crypto\.randomUUID\(\)/);
});

test("review uses server estimates, routes nested issues, and hides unsupported task metadata", () => {
  const dispatch = readFileSync(
    new URL("../src/web/ensembles/dispatch/EnsembleDispatch.tsx", import.meta.url),
    "utf8",
  );
  const modal = readFileSync(new URL("../src/web/components/DispatchModal.tsx", import.meta.url), "utf8");
  assert.match(dispatch, /reviewed && preview \? preview\.estimate : liveEstimate/);
  assert.match(dispatch, /normalizeIssuePath/);
  assert.match(dispatch, /members\.\$\{index\}/);
  assert.match(dispatch, /workflowVersionId/);
  assert.match(modal, /\{!ensembleMode && \(\s*<div className="field-row">\s*<label className="field">[\s\S]*?Priority/);
});
