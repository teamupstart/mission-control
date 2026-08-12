import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  InspectorSettingsPanel,
  canResolveFindings,
  inspectionSummary,
} from "../src/web/components/InspectorSettingsPanel.tsx";
import { INSPECTOR_MODEL_SPEC } from "../src/shared/inspector.ts";
import { InspectorConfigSchema } from "../src/shared/protocol.ts";
import type { InspectorState } from "../src/web/useInspector.ts";
import type { InspectorInspection } from "../src/shared/types.ts";

// What is at stake: this panel is the ONLY place a dry run is legible. It reviews, finds
// things, posts nothing and says nothing anywhere else - so a phrase that is wrong here is
// not cosmetic, it is the whole readout being wrong.
//
// Two failures it has actually shipped, both of the same kind - the panel answering a
// question from data it does not consult:
//
//  1. Every merged PR read "queued / not yet reviewed", forever. `inspectionSummary` fell
//     through to `round === 0` without ever looking at `state`, and a retired row has its
//     `lastError` cleared on the way out, so two dozen finished pull requests rendered as
//     a backlog. The list said the Inspector was hopelessly behind; it was idle.
//  2. There was no model field at all, so "what does this actually run as?" had no answer
//     on screen - while the daemon passed no `--model` and inherited the CLI's most
//     expensive default.
//
// Rendered as static markup rather than driven in a browser, same reason as
// shipping-panel-warnings: the dashboard holds an SSE connection open and hangs headless
// automation. Effects never run here, so nothing fetches.

function row(over: Partial<InspectorInspection> = {}): InspectorInspection {
  return {
    key: "owner/repo#1",
    url: "https://github.com/owner/repo/pull/1",
    owner: "owner",
    repo: "repo",
    number: 1,
    repoRoot: "/repo",
    cwd: "/repo",
    sessionId: null,
    source: "hook",
    state: "open",
    headSha: null,
    reviewPosture: null,
    round: 0,
    lastReviewedAt: null,
    lastError: null,
    failCount: 0,
    lastFailKind: null,
    nextAttemptAt: null,
    lastAttemptSha: null,
    mergedAt: null,
    mergeBlock: null,
    observedHeadSha: null,
    observedState: null,
    observedAt: null,
    headRefName: null,
    title: null,
    adoptedAt: 0,
    updatedAt: 0,
    openFindings: 0,
    postedOpenFindings: 0,
    resolvedFindings: 0,
    ...over,
  };
}

// ---- what a row says about itself ------------------------------------------------------

test("a merged PR that was never reviewed says so, instead of 'queued'", () => {
  // The bug, exactly: adopted, merged by a human before the tick reached it, retired with
  // `round: 0` and no error. "Queued" claims work is pending on something the sweep will
  // never load again (`loadOpenInspectorPrs` selects `state = 'open'`).
  const merged = row({ state: "closed", mergedAt: 1000 });
  assert.equal(inspectionSummary(merged), "merged");
  assert.notEqual(inspectionSummary(merged), "queued");
});

test("a PR closed without merging is distinguished from one that landed", () => {
  assert.equal(inspectionSummary(row({ state: "closed", mergedAt: null })), "closed");
});

test("a retired PR keeps the findings it was reviewed with", () => {
  // The more useful fact about a PR that has landed: what the Inspector said about it.
  // Retirement must not overwrite that with "merged".
  const reviewed = row({ state: "closed", mergedAt: 1000, round: 2, openFindings: 3 });
  assert.equal(inspectionSummary(reviewed), "3 findings");
});

test("an open PR nothing has looked at yet is still 'queued'", () => {
  // The fix must not swallow the state it was distinguishing itself FROM: this row really
  // is waiting for the tick.
  assert.equal(inspectionSummary(row()), "queued");
});

test("a failed round outranks everything - it is the reason nothing else is true", () => {
  assert.equal(inspectionSummary(row({ lastError: "claude -p timed out" })), "failed");
});

test("a clean review reads as clean, not as zero findings", () => {
  assert.equal(inspectionSummary(row({ round: 1, openFindings: 0 })), "clean");
  assert.equal(inspectionSummary(row({ round: 1, openFindings: 1 })), "1 finding");
});

// ---- what the panel renders ------------------------------------------------------------

function state(over: Partial<InspectorState> = {}): InspectorState {
  return {
    config: InspectorConfigSchema.parse({ enabled: true, mode: "dry-run" }),
    inspections: [],
    model: null,
    update: async () => true,
    resolveFindings: async () => true,
    error: null,
    ...over,
  };
}

function render(s: InspectorState = state()): string {
  return renderToStaticMarkup(
    createElement(InspectorSettingsPanel, { state: s, onNavigate: () => {} }),
  );
}

// The reviewed-repos editor moved to the Trust matrix; the panel keeps the count (so "which
// repos does it post in" is still answerable here) and deep-links to Trust, and the editor
// is gone so the Inspector's list has one writer.
test("the reviewed-repos section is a grant count that deep-links to Trust, not an editor", () => {
  const html = render(
    state({
      config: InspectorConfigSchema.parse({ enabled: true, repoAllowlist: ["/repo/a", "/repo/b"] }),
    }),
  );
  assert.match(html, /The Inspector may post reviews in 2 repositories/);
  assert.match(html, /Manage in Trust/);
  assert.doesNotMatch(html, /placeholder="search repos or type a path…"/);
  assert.doesNotMatch(html, /aria-label="Stop reviewing/);
});

test("the panel has a model field, and shows what would actually run", () => {
  // Without this the operator has no way to see or change the review model, which is how
  // an unnamed `--model` went unnoticed for the life of the feature.
  const html = render();
  assert.match(html, /id="inspector-model"/);
  assert.match(html, new RegExp(INSPECTOR_MODEL_SPEC.fallback));
});

test("the model blurb is still printed under the field - Foreman's tooltip-only mode did not leak", () => {
  // `ModelField.blurb` defaults to "block"; only the Foreman panel passes "hover". This
  // panel must keep the visible paragraph, not just the tooltip's hidden copy.
  assert.match(render(), /<p class="settings-hint foreman-model-blurb">Reviews each push/);
});

test("Inspector can select Codex and offers only Codex catalog models", () => {
  const html = render(state({
    config: InspectorConfigSchema.parse({ enabled: true, runner: "codex", model: "" }),
    model: { id: "gpt-5.6-sol", source: "default" },
  }));
  assert.match(html, /id="inspector-provider"/);
  assert.match(html, /<option value="codex" selected="">Codex<\/option>/);
  assert.match(html, /<select[^>]*id="inspector-model"/);
  assert.match(html, /GPT-5\.6 Sol/);
  assert.doesNotMatch(html, /Claude Sonnet/);
});

test("an env var outranking the box is named, not silently obeyed", () => {
  // The browser cannot see the daemon's environment, so this sentence exists only because
  // the daemon reports the resolution. A panel showing `config || default` would print a
  // model the env is overriding.
  const html = render(state({ model: { id: "claude-opus-4-8", source: "env" } }));
  assert.match(html, new RegExp(INSPECTOR_MODEL_SPEC.envVar));
});

test("the operator's own model is shown without a source line explaining it", () => {
  const html = render(
    state({
      config: InspectorConfigSchema.parse({ model: "claude-haiku-4-5" }),
      model: { id: "claude-haiku-4-5", source: "config" },
    }),
  );
  assert.match(html, /claude-haiku-4-5/);
  assert.doesNotMatch(html, /Shipped default/);
});

test("retired rows are marked so a finished list cannot read as a backlog", () => {
  const html = render(
    state({
      inspections: [
        row({ key: "owner/repo#1", state: "closed", mergedAt: 1 }),
        row({ key: "owner/repo#2", number: 2, state: "open" }),
      ],
    }),
  );
  assert.match(html, /sc-row is-retired/);
  // The live one must NOT pick the marker up, or the distinction says nothing.
  assert.match(html, /class="sc-row"/);
});

// The model control. Asserted as a `<select>` rather than by its value, because the shape
// IS the requirement: a free-text box invites a Claude id while Codex is selected, which
// the config route accepts (`ModelIdSchema` owns parser-safe persisted syntax, not catalog
// membership) and which then fails at spawn time, once, in a log nobody is reading.
test("the model is a picker filtered by the provider, never a free-text box", () => {
  const html = render(
    state({ config: InspectorConfigSchema.parse({ enabled: true, runner: "codex" }) }),
  );
  assert.match(html, /<select[^>]*id="inspector-model"/);
  assert.doesNotMatch(html, /<input[^>]*id="inspector-model"/);
  // Filtered: Codex's catalog, and none of Claude's.
  assert.match(html, /GPT-5\.6 Sol/);
  assert.doesNotMatch(html, /Opus 5/);
});

// Who gets the Resolve control, and who must not.
//
// This is the operator's only route out of a finding that has genuinely been addressed and
// that nothing else can close: a review round resolves only fingerprints the model lists,
// and rounds stop once the head has been reviewed. `e2e/specs/inspector-resolve-findings.spec.ts`
// proves the click reaches the daemon; what is pinned here is the predicate deciding which
// rows are offered it at all, because both wrong answers are quiet ones - a missing control
// on the row that needs it strands the pull request, and a control on a retired row rewrites
// what the Inspector said about work that has already landed.
test("the resolve control is offered on open rows carrying findings, and nowhere else", () => {
  assert.equal(canResolveFindings(row({ openFindings: 2, state: "open" })), true);
  assert.equal(canResolveFindings(row({ openFindings: 0, state: "open" })), false);
  assert.equal(canResolveFindings(row({ openFindings: 2, state: "closed" })), false);
  // A merged pull request is closed too, and is the case most likely to still carry rows.
  assert.equal(
    canResolveFindings(row({ openFindings: 3, state: "closed", mergedAt: 123 })),
    false,
  );
});

test("the resolve control names the pull request it acts on, so a table of them stays legible", () => {
  const html = render(
    state({ inspections: [row({ number: 494, openFindings: 2, round: 5, state: "open" })] }),
  );
  // Named by pull request rather than by position: every row in this table would otherwise
  // offer an identically-named control, which is unusable by keyboard or screen reader.
  // The apostrophe arrives escaped - this is static markup, not a live DOM.
  assert.match(html, /aria-label="Resolve the Inspector&#x27;s findings on repo#494"/);
  // In the ledger's own action cell, under a column that names it.
  assert.match(html, /<span class="sc-act"><button type="button" class="settings-link"/);
  assert.match(html, /<span class="sc-act">Resolve<\/span>/);
  // And a row with nothing to resolve leaves the cell empty rather than dropping it, or the
  // grid would shift every column on the rows that do offer it.
  const clean = render(state({ inspections: [row({ number: 495, openFindings: 0, round: 5 })] }));
  assert.match(clean, /<span class="sc-act"><\/span>/);
  assert.doesNotMatch(clean, /aria-label="Resolve/);
});

// The Closed column counts a single `resolved` status that THREE things now write: a review
// round confirming a push fixed it, the Inspector dropping its own finding in conversation,
// and an operator asserting it was handled. Only the first is evidence a fix landed, and the
// ledger does not record which route produced the row - so a column labelled "fixed" claims a
// provenance the number does not carry. This is a wording contract, which is exactly the kind
// that rots silently.
test("the resolved tally says closed rather than fixed, because it cannot tell them apart", () => {
  const html = render(
    state({ inspections: [row({ number: 494, openFindings: 0, resolvedFindings: 2, round: 5 })] }),
  );
  assert.match(html, /2 closed/);
  assert.doesNotMatch(html, /2 fixed/, "the count cannot claim a push fixed anything");
  assert.match(html, /<span>Closed<\/span>/, "and the column header agrees with the cell");
  // The tooltip is where the three routes are named, so the number is not merely vague.
  assert.match(html, /review round confirms a push fixed it/);
  assert.match(html, /an operator resolves it here/);
});
