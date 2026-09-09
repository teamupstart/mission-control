# Phase 3: Completion pane

> Line numbers in this document are locators as of the branch's merge base, not identities.
> Find the symbol or heading; treat a drifted number as drift.

Source plan: [`plan.md`](plan.md) · Index: [`phased-plan.md`](phased-plan.md)

## Outcome

The GitHub Inspector final gate and the Foreman completion claim join the tab bar as a fifth pane,
present only on a run that has one of them. The gate's two fact ledgers collapse into one disclosure,
its findings become a table, and the Foreman claims become rows instead of near-identical paragraphs.
After this phase the run detail page below the round scrubber is the scrubber, the notice band, the
session actions section, the tab container, the model calls section and the Timeline.

## Entry criteria and dependencies

**Depends on Phase 2.** The dependency is file ownership rather than logic: this phase and Phase 2
both make large edits to the same regions of `WorkflowRuns.tsx` and both add rules to `styles.css`,
so they are serialised to avoid reconstructing one file by hand at merge. Start from a checkout where
Phase 2 has merged.

## Scope

- A Completion pane holding the Inspector gate and the Foreman completion claims.
- The findings table.
- The gate's fact ledgers as one disclosure.
- The stale cross-reference in `src/web/workflows/run-actions.ts`.

## Non-goals

- Any change to the Inspector's behaviour: its adoption, its posture, its retry schedule, its
  completion policy and its allowlist are untouched. The gate is re-rendered, not re-decided.
- Any change to how a completion claim is recorded or to its once-only marker.
- Folding findings into the Review worklist. See the findings below for why that would be wrong.
- Workflow-owned model calls and the Timeline. They stay as they are.

## Repository findings

- The gate section is `WorkflowRuns.tsx:2516-2632`. It renders a status chip, `inspectorGateSentence`,
  then one of two shapes: when `spentGateCondition` holds, two `wf-run-gate-ledger` regions labelled
  "Last workflow observation" and "Current Inspector" carrying sixteen facts between them plus the
  historical finding fingerprints list; otherwise a single nine-field fact list. Then the findings
  policy line, the "Open GitHub Inspector settings" button, and one `wf-run-finding` card per finding.
- The Foreman completion claim section is `:2634-2650`. `completionClaims` is derived in the run view by
  filtering `detail.events` for `workflow_completion_claimed` and validating the payload shape. A real
  run in the local records carries five claims, four of them `already_claimed` restating the same
  completion, which is five near-identical paragraphs today.
- **Findings are not in the Review worklist and must not be moved there.** `runChangeWorklist`
  in `run-model.ts` iterates attempts and does `if (!attempt.persona) continue`, so it is built
  from Persona verdicts only. An Inspector finding has never appeared in that list. Folding findings
  in would change what the worklist means and would break the segment counts that
  `e2e/specs/workflow-run-blocker-worklist.spec.ts` asserts.
- **A cross-reference goes stale.** `src/web/workflows/run-actions.ts` reads (the `consequence` of the disabled-Inspector action) "Turn it back on
  from Open GitHub Inspector settings, in GitHub Inspector final gate below." Once the gate is a tab,
  "below" is wrong. `test/workflow-runs-render.test.ts` asserts that exact sentence, so the copy
  and the assertion move together. Check for any other positional copy in the same file before
  assuming this is the only one.
- Existing coverage: `e2e/specs/workflow-round-limit-grant.spec.ts` asserts the
  "Last workflow observation" and "Current Inspector" regions by accessible name. Those regions
  survive inside the disclosure, so keep their `aria-label`s and update only how the spec reaches
  them. `test/workflow-runs-render.test.ts` asserts the gate heading, and
  `test/workflow-inspector-bypass.test.ts` touches the same surface.

## Implementation steps

1. **Add the pane id.** Add `completion` to the pane id tuple in `useWorkflowRoute.ts`.

2. **Extend `runRecordSummary`.** Add the completion facts: gate status, open and resolved finding
   counts, the adopted pull request number and observed state, the Inspector round, and the
   completion claim count by state. The pane's `blocking` flag is true when the gate has not passed.

3. **Make the pane conditional.** The pane's `render` returns null when the run has neither an
   Inspector gate nor a completion claim, which Phase 1's registry already turns into an absent tab.
   Do not add a second mechanism for hiding a tab.

4. **Build the pane.** A stat strip (gate, open findings, resolved, pull request, Inspector round),
   then `inspectorGateSentence` as the summary line, then the findings table, then the completion
   claim rows, then the ledger disclosure, then the findings-policy line and the settings button.

5. **The findings table.** One row per finding: severity chip, title, `path:line`, round and status.
   A row expands its body and its fingerprint. Keep the legacy-finding sentence for a finding whose
   detail was not persisted. Severity keeps its existing tone mapping; do not invent a new one.

6. **The ledger disclosure.** Both shapes the section has today go inside one `<details>`: the
   two-ledger form when `spentGateCondition` holds, the single fact list otherwise. Keep the
   "Last workflow observation" and "Current Inspector" `aria-label`s and the historical finding
   fingerprints list, and keep `ErrorLine` with its `alert` behaviour.

7. **The completion claim rows.** One row per claim: state chip, completion kind, the once-only
   marker truncated as it is today, and the summary's first line. Follow with a sentence counting the
   states, so five claims saying the same thing read as "4 already claimed, 1 started" without anyone
   reading five paragraphs.

8. **Fix the stale copy.** Update that `consequence` string so it names the Completion tab rather than a
   section below, and update its assertion in `test/workflow-runs-render.test.ts` with it.

9. **CSS.** Reuse Phase 2's ledger table and row classes. Add only what the severity chip and the
   findings table need that does not already exist.

## Tests and verification

- `node:test` for the completion facts in `runRecordSummary`: finding counts by status, claim counts
  by state, and the empty cases for a run with a gate but no findings and a run with claims but no
  gate.
- `renderToStaticMarkup` cases for the findings table row, the legacy-finding arm, the claim row and
  the state-count sentence. Update the gate heading assertion and the disabled-Inspector copy assertion.
- A new Playwright spec: the Completion tab is absent on a run with no gate and no claim; it is
  present and carries the amber badge on a run with an open finding; a finding row expands its body;
  the ledger disclosure still exposes the "Last workflow observation" and "Current Inspector" regions
  by accessible name; the "Open GitHub Inspector settings" button still opens settings.
- Update `e2e/specs/workflow-round-limit-grant.spec.ts` to reach those regions through the pane and
  its disclosure. Keep every assertion it makes.
- Run `e2e/specs/workflow-run-blocker-worklist.spec.ts` unchanged: the worklist's segment counts must
  not have moved.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke`, `npm run test:e2e`.

## Merge and exit criteria

- The Completion tab renders the gate and the completion claims, and both old sections are gone.
- The tab is absent on a run that has neither.
- Every gate fact, every finding field, the findings policy, the settings route and every claim field
  still render.
- No positional copy anywhere still points a reader at a section "below".
- The page below the round scrubber is the scrubber, the notice band, session actions, the tab
  container, the model calls section and the Timeline.
- All verification above passes.

## Downstream handoff

Final phase. Anything later touching this surface should extend the pane registry rather than adding
a sibling section, and should keep `blocking` meaning "this pane holds something that stops the run".

## Cross-phase audit record

- Reconciled against Phase 1. The conditional tab is handled by Phase 1's null-render rule rather
  than by a flag added here; that rule was written into Phase 1 for this reason.
- Reconciled against Phase 2. This phase reuses Phase 2's ledger table and row classes and adds no
  new families. Serialised behind Phase 2 for file ownership, which is recorded in the index's
  concurrency section so the ordering is not mistaken for a logical dependency.
- Final audit over all three phases: every submitted decision is owned by exactly one phase (approach
  and human decisions in Phase 1, thumbnails in Phase 2, the scope extension in Phase 3); every
  consumer follows its prerequisite; no phase depends on a later one to repair an intermediate state;
  and the end state matches the source plan with no undocumented cleanup.
