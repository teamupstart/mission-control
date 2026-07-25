# Workflow pipeline UI - phased implementation

Implementation index for `docs/plans/workflow-pipeline-ui/plan.md` (approved 2026-07-25 with all
five dashboard decisions submitted). Each phase is a merge unit that leaves the repository green
and operable; phase files beside this index are the authoritative per-phase instructions.

## Incorporated decisions

1. Session fan-out: relax `session_submitted_route` to at-least-one.
2. Graph view: co-equal fallback editor (pipeline default for stage-expressible graphs).
3. Stage naming: derived only; no model change.
4. Workflow settings: migrate into a Settings page category.
5. Follow-up: this phased plan plus dependency-linked Mission Control tasks.

## Investigated findings that shaped the phases

- The engine already fans out (one idempotent receipt per outgoing edge,
  `src/server/workflows/engine.ts`), so the fan-out change is validator + tests only - it anchors
  phase 1 rather than an engine phase.
- All draft writes flow through `useWorkflowDraft.update`'s CAS autosave, so the pipeline editor
  needs no persistence work at all - stages compile to ordinary graphs (phase 1's module) and the
  editor is pure UI (phase 2).
- The runs reader already computes `workflowNodeStatuses(detail)` and renders `version.graph`
  read-only, so the pipeline strip is a re-presentation, not new data (phase 3).
- **Discrepancies vs the source plan's environment**: the settings registry is
  `SETTINGS_CATEGORIES` in `src/web/lib/settings-registry.ts` with `renderCategory` in
  `SettingsPage.tsx` - AGENTS.md still points at a deleted `SettingsModal.tsx` (phase 4 fixes the
  sentence). And the Graph-view banner needs reasons, not a boolean, so phase 1's API grew
  `stageBlockers(graph): string[]` during decomposition.

## Phases

| # | Phase | File | Direct prerequisites |
|---|-------|------|----------------------|
| 1 | Model groundwork | `phase-1-model-groundwork.md` | none |
| 2 | Pipeline editor | `phase-2-pipeline-editor.md` | 1 |
| 3 | Runs monitor | `phase-3-runs-monitor.md` | 2 |
| 4 | Settings placement and final sweep | `phase-4-settings-and-sweep.md` | 3 |

## Dependency graph and concurrency

```mermaid
flowchart LR
  P1[1 · Model groundwork] --> P2[2 · Pipeline editor] --> P3[3 · Runs monitor] --> P4[4 · Settings + sweep]
```

The chain is deliberately serial. Phase 3 could only run beside phase 2 by forking its own
stage-rendering components and CSS - a second visual dialect is the defect this migration removes,
so phase 3 waits for `pipeline-bits.tsx`. Phase 4 is a sweep and must see both merged surfaces.
There are no concurrent groups; merge order equals phase order.

## Cross-phase contracts

- **Phase 1 -> all**: `src/shared/workflow-stages.ts` exports (`projectStages`, `compileStages`,
  `stageBlockers`, `stageExpressible`, `stageName`, `nodeLabel`, `StagePipeline`, `Stage`), the
  compiler's id-reuse guarantees, the relaxed validator, and unchanged diagnostic codes.
- **Phase 2 -> 3, 4**: `pipeline-bits.tsx` component props (including `ReviewerRow`'s status chip
  slot), the `wf-pipeline-*` CSS vocabulary, the `workflowConfirm` overlay id, and the
  `onBindWorkflow` prop threading through `WorkflowPage`.
- **Phase 3 -> 4**: `wf-run-*` CSS vocabulary; no `window.confirm` left in the runs reader.
- Diagnostics codes, task/run/binding wire shapes, and every server route are unchanged across all
  phases.

## Final verification

After phase 4 merges: author the 2-parallel-reviewer workflow in pipeline mode, publish, bind to an
isolated-daemon session, run a Preview through a fail round and a repair resubmission, and watch it
on the runs monitor - the flow the 2026-07-25 review found impossible, jargon-bound, or
UUID-labelled at every step. Then `git grep` gates: no `window.confirm` under `src/web/workflows/`,
no node UUIDs in rendered markup fixtures, no orphaned `workflow-*` CSS classes, settings search
finds "live delivery". CI (typecheck, test, build, bundle smoke) green on Node 24 and 26 at every
intermediate merge, not only at the end.
