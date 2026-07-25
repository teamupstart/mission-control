# Phase 3 - Runs monitor

## 1. Outcome

A run is watched on the pipeline its author drew: per-reviewer live status on the authored shape, a
round scrubber, verdict cards in the fleet grammar, and a timeline in human names. Every action and
recovery affordance the current reader exposes survives; the wall of UUID-labelled sections does
not.

## 2. Entry criteria and dependencies

- Direct prerequisite: Phase 2 merged (consumes `pipeline-bits.tsx`, the `wf-pipeline-*` CSS
  vocabulary, and the `onBindWorkflow` threading).

## 3. Scope

The `WorkflowRuns.tsx` reader and rail. Non-goals: any server or store change; new run data; the
Workflow settings drawer (phase 4); Persona surfaces.

## 4. Repository findings and inherited contracts

- `WorkflowRuns.tsx` (1,214 lines) holds the rail, filters, and `WorkflowRunView`. Facts verified in
  code: `workflowNodeStatuses(detail)` (`:129`) maps node id -> runtime status and already feeds the
  read-only `WorkflowCanvas` (`:587-591`) with `version.graph` (`:588`); rounds come from
  `detail.submissions` (`roundBySubmission`, `:229`); join packets read `version.graph.edges`
  (`:754-755`).
- **Affordance inventory that must survive** (enumerated from `WorkflowRunView` before any code is
  deleted; the implementer re-audits this list against HEAD): Export; Cancel run; Resubmit;
  Restart all Personas; Retry provider call; Prepare PR in session; Recheck Inspector; delivery
  Retry and the uncertain-delivery resolve controls; Inspector gate state + findings + bypass
  notice; Foreman completion claims; captured intent/evidence sections including the corrupt and
  not-captured variants and pruned badges; workflow-owned model calls; per-persona verdicts with
  evidence references; join packets; the timeline.
- Inherited from phases 1-2: `projectStages`, `nodeLabel`, `stageName`; `pipeline-bits.tsx` leaves
  (with the status chip slot on `ReviewerRow`); `workflowConfirm` overlay for the destructive
  confirms currently done via `window.confirm` in this file.
- The empty state today reads "Bind an immutable published version to a session, then submit a
  manual Preview." with no affordance; App already owns the binding dialog.

## 5. Implementation steps

1. **Rail.** Run list with tone chips (`workflow-chip` vocabulary), filter chips (All, Running,
   Needs you, Done) mapped onto the existing status filter query, session branch and relative time
   per run. Keep pagination/cursor behavior as-is.
2. **Header.** Workflow name + version chip + status chip + session link; contextual actions from
   the inventory rendered as toolbar buttons (danger ones ghosted and separated), each keeping its
   current enabling conditions.
3. **Round scrubber.** A segmented control over `detail.submissions` (round number, failed rounds
   marked); selecting a round scopes the strip, verdicts and timeline. Defaults to the latest
   round. Recovery/gate sections always reflect the live run regardless of the viewed round, with a
   note when viewing an older round.
4. **Pipeline strip.** `projectStages(version.graph)` rendered through `pipeline-bits`; each
   reviewer's status chip driven by `workflowNodeStatuses(detail)`; Session terminus carries the
   submission state, End the outcome/waiting state. When `projectStages` returns null, fall back to
   today's read-only `WorkflowCanvas` with `nodeStatuses` - no capability lost for hand-built
   graphs.
5. **Cards.** Verdict cards (verdict chip, persona name, summary, evidence refs, runner/model/
   duration/cost meta); Inspector gate, completion claims, deliveries and their recovery controls
   as sections in the same card grammar. Error strings render as sentences; codes demoted to
   detail. New classes under `wf-run-*`; stop reusing `persona-error` outside the Persona library.
6. **Timeline.** Existing run events grouped by round, phrased with `nodeLabel`/persona names.
7. **Empty state.** "No workflow runs yet" + a "Bind to a session..." button through
   `onBindWorkflow`.
8. **Styles/docs.** `wf-run-*` rules in the workflows CSS section; grep removed classes; README
   Runs subsection rewritten.

## 6. Data/API/migration

None. The reader consumes the existing `/api/workflow-runs` list and detail payloads unchanged.

## 7. Tests and verification

- `workflow-runs-render.test.ts`: renders a fixture detail (running + failed-round + gate + delivery
  states) via `renderToStaticMarkup`; asserts (a) every inventory affordance's control text is
  present under its enabling fixture, (b) no node/edge UUID appears in markup, (c) the fallback
  canvas path renders for a non-expressible fixture.
- Round-scoping unit tests over the pure helpers (round selection, status mapping).
- Manual: exercise a real Preview run end to end on an isolated daemon (`HARNESS_HOME` temp +
  own ports - never the live fleet), including a fail round and a delivery retry.

## 8. Merge and exit criteria

- Parity checklist in section 4 confirmed item by item against the old reader in the PR
  description; suites green; README updated.
- A running 2-stage run shows live per-reviewer chips on the pipeline strip; an old hand-built
  graph's run still renders on the canvas fallback.

## 9. Downstream handoff

Phase 4 may rely on: the reader no longer using `window.confirm`; `wf-run-*` class vocabulary;
the empty-state bind CTA. Phase 4 must not restyle these.

## 10. Cross-phase audit record

- 2026-07-25: depends on phase 2 (not phase 1 directly) because it consumes `pipeline-bits.tsx` and
  the CSS vocabulary; running it concurrently with phase 2 would fork a second visual dialect,
  which is the defect this migration exists to remove.
