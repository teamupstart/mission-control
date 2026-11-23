import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  InspectorSettingsPanel,
  canResolveFindings,
  canViewFindings,
  inspectionSummary,
} from "../src/web/components/InspectorSettingsPanel.tsx";
import {
  closedRecordLine,
  inspectorPrStateWord,
  inspectorRoundsLabel,
  nothingPostedLine,
} from "../src/web/components/InspectorFindingsModal.tsx";
import { inspectorPrClosedAs } from "../src/web/lib/pr-standing.ts";
import { INSPECTOR_MODEL_SPEC } from "../src/shared/inspector.ts";
import { InspectorConfigSchema } from "../src/shared/protocol.ts";
import type { InspectorState } from "../src/web/useInspector.ts";
import type { InspectorComment, InspectorInspection } from "../src/shared/types.ts";

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

test("a retired PR keeps the findings it was reviewed with, worded as left at merge", () => {
  // The more useful fact about a PR that has landed: what the Inspector said about it.
  // Retirement must not overwrite that with "merged".
  const reviewed = row({ state: "closed", mergedAt: 1000, round: 2, openFindings: 3 });
  assert.equal(inspectionSummary(reviewed), "3 unresolved at merge");
});

test("a PR merged by hand reads 'at merge', because merged follows GitHub's observed state", () => {
  // `mergedAt` is written only when YOLO mode merged it, so a human merge has it null.
  const humanMerged = row({ state: "closed", observedState: "MERGED", round: 2, openFindings: 3 });
  assert.equal(inspectionSummary(humanMerged), "3 unresolved at merge");
  assert.equal(inspectionSummary({ ...humanMerged, round: 0, openFindings: 0 }), "merged");
});

test("a PR closed without merging reads 'at close'", () => {
  const closed = { state: "closed", round: 1, openFindings: 1 } as const;
  assert.equal(inspectionSummary(row({ ...closed, observedState: "CLOSED" })), "1 unresolved at close");
  assert.equal(inspectionSummary(row({ ...closed, observedState: null })), "1 unresolved at close");
});

test("a clean or failed closed row keeps its wording", () => {
  assert.equal(
    inspectionSummary(row({ state: "closed", observedState: "MERGED", round: 2, openFindings: 0 })),
    "clean",
  );
  assert.equal(
    inspectionSummary(row({ state: "closed", observedState: "MERGED", round: 2, openFindings: 3, lastError: "boom" })),
    "failed",
  );
});

test("whether a closed PR merged reads observedState as well as mergedAt", () => {
  assert.equal(inspectorPrClosedAs(row({ state: "open" })), null);
  assert.equal(inspectorPrClosedAs(row({ state: "open", observedState: "MERGED" })), null);
  assert.equal(inspectorPrClosedAs(row({ state: "closed", observedState: "MERGED", mergedAt: null })), "merged");
  assert.equal(inspectorPrClosedAs(row({ state: "closed", mergedAt: 1000 })), "merged");
  assert.equal(inspectorPrClosedAs(row({ state: "closed", observedState: "CLOSED" })), "closed");
  assert.equal(inspectorPrClosedAs(row({ state: "closed", observedState: null })), "closed");
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
    runner: null,
    update: async () => true,
    refresh: async () => {},
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
  assert.match(html, /GitHub Inspector may post reviews in 2 repositories/);
  assert.match(html, /Manage in Trust/);
  assert.doesNotMatch(html, /placeholder="search repos or type a path…"/);
  assert.doesNotMatch(html, /aria-label="Stop reviewing/);
});

// The provider select and the model picker moved to Settings > Models, where every call this
// app makes on the operator's account is answerable in one screen. What has to be true HERE is
// the negative - neither control is still rendered, so two panels cannot write the same keys
// and search cannot have two places to send one operator - plus a pointer a bookmark survives.
// The controls themselves are asserted in `foreman-models-panel.test.ts`.
test("the model and provider controls are gone, leaving a pointer to Models", () => {
  const html = render();
  assert.doesNotMatch(html, /id="inspector-model"/);
  assert.doesNotMatch(html, /id="inspector-provider"/);
  assert.doesNotMatch(html, /data-anchor="inspector\/model"/);
  assert.doesNotMatch(html, /data-anchor="inspector\/provider"/);
  assert.match(html, /Open it in Models/);
});

test("the trade the provider choice makes is still stated where the posture is", () => {
  // The one sentence that had to stay: which provider reviews decides WHAT IT CAN READ, and
  // that is a fact about this subsystem's posture rather than about a model picker.
  const html = render();
  assert.match(html, /Claude receives read-only tools scoped to the worktree/);
  assert.match(html, /Codex reviews the supplied\s+diff without repository tools/);
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
test("no catalog leaks back into this panel through the posture copy", () => {
  // The shape argument above now belongs to the Models page. What this panel must not do is
  // grow a second, unfiltered way to name a model - which is exactly what a free-text box
  // added back "just for the Inspector" would be.
  const html = render(
    state({ config: InspectorConfigSchema.parse({ enabled: true, runner: "codex" }) }),
  );
  assert.doesNotMatch(html, /<input[^>]*id="inspector-model"/);
  assert.doesNotMatch(html, /GPT-5\.6 Sol/);
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
  assert.match(html, /aria-label="Resolve GitHub Inspector&#x27;s findings on repo#494"/);
  // In the ledger's own action cell, under a column that names it.
  assert.match(html, /<span class="sc-act"><button type="button" class="settings-link"/);
  assert.match(html, /<span class="sc-act">Actions<\/span>/);
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

// ---- the Findings modal --------------------------------------------------------------

test("the Findings control is offered on every row with a finding, open or closed", () => {
  assert.equal(canViewFindings(row({ openFindings: 1 })), true);
  // Resolved findings only: the record of what was said, still worth reading.
  assert.equal(canViewFindings(row({ openFindings: 0, resolvedFindings: 2 })), true);
  // A retired row keeps its findings and its control, unlike Resolve.
  assert.equal(canViewFindings(row({ openFindings: 3, state: "closed", mergedAt: 1 })), true);
  assert.equal(canViewFindings(row({ openFindings: 0, resolvedFindings: 0, round: 4 })), false);
});

test("the Findings control is named for the pull request by its full key", () => {
  const html = render(
    state({
      inspections: [
        row({ key: "owner/repo#494", number: 494, openFindings: 1, round: 2 }),
        row({ key: "owner/repo#495", number: 495, openFindings: 0, round: 2 }),
      ],
    }),
  );
  assert.match(html, /aria-label="View GitHub Inspector&#x27;s findings on owner\/repo#494"/);
  assert.doesNotMatch(html, /findings on owner\/repo#495"/);
  assert.match(html, /Open a pull request&#x27;s Findings to read what GitHub Inspector found\./);
  assert.doesNotMatch(html, /the only place GitHub Inspector&#x27;s findings exist/);
});

function finding(over: Partial<InspectorComment> = {}): InspectorComment {
  return {
    id: "f1",
    prKey: "owner/repo#1",
    fingerprint: "fp",
    path: "src/a.ts",
    line: 1,
    title: "t",
    body: "b",
    severity: "major",
    round: 1,
    status: "drafted",
    replies: 0,
    answeredCommentId: null,
    postedAt: null,
    githubUrl: null,
    legacyPosted: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

test("the dry-run line appears only when the posture was not live and nothing reached GitHub", () => {
  const drafts = [finding()];
  assert.equal(
    nothingPostedLine(row({ reviewPosture: "dry-run" }), drafts),
    "Dry run: nothing on this pull request was posted",
  );
  assert.equal(nothingPostedLine(row({ reviewPosture: "live" }), drafts), null);
  // A null posture is a row from an older build, which may have been live.
  assert.equal(nothingPostedLine(row({ reviewPosture: null }), drafts), null);
  // Reviewed live first, then in dry run: the earlier round's comments are on GitHub.
  assert.equal(
    nothingPostedLine(row({ reviewPosture: "dry-run" }), [
      ...drafts,
      finding({ id: "f2", status: "resolved", postedAt: 5 }),
    ]),
    null,
  );
  assert.equal(
    nothingPostedLine(row({ reviewPosture: "dry-run" }), [finding({ postedAt: 5 })]),
    null,
    "a draft whose earlier version was posted is on GitHub",
  );
  assert.equal(
    nothingPostedLine(row({ reviewPosture: "not-allowlisted" }), drafts),
    "Not on the allowlist: nothing on this pull request was posted",
  );
  // A draft GitHub refused 3 times never reached GitHub either, so it keeps the line.
  const refused = [finding({ postRefusals: 3, lastPostError: "Line could not be resolved (HTTP 422)" })];
  assert.equal(
    nothingPostedLine(row({ reviewPosture: "dry-run" }), refused),
    "Dry run: nothing on this pull request was posted",
  );
  // Unless an earlier version of it was posted.
  assert.equal(
    nothingPostedLine(row({ reviewPosture: "dry-run" }), [{ ...refused[0]!, postedAt: 5 }]),
    null,
  );
});

test("the modal's header words for state and rounds", () => {
  assert.equal(inspectorPrStateWord(row({ state: "open" })), "open");
  assert.equal(inspectorPrStateWord(row({ state: "closed", mergedAt: 1 })), "merged");
  assert.equal(inspectorPrStateWord(row({ state: "closed", mergedAt: null })), "closed");
  assert.equal(inspectorPrStateWord(row({ state: "closed", observedState: "MERGED" })), "merged");
  assert.equal(inspectorRoundsLabel(0), "not reviewed yet");
  assert.equal(inspectorRoundsLabel(1), "1 review round");
  assert.equal(inspectorRoundsLabel(3), "3 review rounds");
});

test("a closed PR's leftover findings are named a record, and an open one's are not", () => {
  const merged = row({ state: "closed", observedState: "MERGED", round: 2, openFindings: 3 });
  assert.equal(
    closedRecordLine(merged),
    "This pull request merged with 3 findings unresolved. They are kept as a record and will not be reviewed again.",
  );
  assert.equal(
    closedRecordLine(row({ state: "closed", observedState: "CLOSED", round: 2, openFindings: 1 })),
    "This pull request closed with 1 finding unresolved. It is kept as a record and will not be reviewed again.",
  );
  assert.equal(closedRecordLine(row({ state: "open", round: 2, openFindings: 3 })), null);
  assert.equal(closedRecordLine({ ...merged, openFindings: 0 }), null);
});
