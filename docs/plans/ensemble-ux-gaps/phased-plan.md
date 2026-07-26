# Ensemble UX gaps - phased implementation plan

Status: phases authored 2026-07-26, tasks scheduled from this index.
Source plan: `docs/plans/ensemble-ux-gaps/plan.md` (rendered: `plan.html`).
Rendered index: `phased-plan.html` beside this file.

## Incorporated human decisions (submitted 2026-07-26)

1. **Direction: phased composition** - wire prerequisite, then Fleet Lens, then Attention Inbox + Decision Dossier, then Run Console, in that order.
2. **The wire prerequisite ships first regardless** of the rest.
3. **Compare surface v1 is the full build**: file-touch matrix PLUS synchronized side-by-side diff panes (the reduced matrix-only scope was declined).
4. **Follow-up**: this phased plan with dependency-linked tasks.

## Investigation findings that shaped the phases

Verified against the working tree on 2026-07-26 (details and line references in each phase file):

- The blocked-member join cannot live in the store (DB-only) or the registry (deliberately store-independent); it lives in `EnsembleManager`, decorating both `publish` and the boot `listSummaries` paths, with a NEW `session_upsert` subscription and a change-guard against the publish/resync feedback loop.
- `test/ensemble-sse.test.ts` pins the exact `EnsembleSummary` key list; `ensembleNeedsAttention` is pinned in `ensemble-contracts`; both are updated by Phase 1, additively.
- Grid arrow-nav is geometric against live CSS tracks - a grid cluster FRAME breaks it silently, so the grid gets adjacency sorting only; board clustering requires one shared ordering function feeding both `boardColumns` and the rendered column order.
- The topbar reviews chip opens a single session's modal today; the inbox replaces that behavior, so Phase 3 builds NO interim topbar chip (ceded to Phase 4).
- `ReviewCard` is session-agnostic but unexported; `PaneDialogPrompt` is portable; they are two wire protocols and stay two (rendered side by side in lanes; dialogs deep-linked, not answered, in the inbox).
- The ensemble detail sees neither sessions nor reviews; Phase 5 threads both (App-scope data, no new wire). Phase 1's session-edge republish is what keeps the detail fresh without polling.
- `materializeSnapshotDiff` has no path parameter; Phase 2 adds `paths` (single `?path=` per request - the multi-path query-param failure is documented at `routes.ts:1113-1117`) and `?filesOnly=1`, keeping "stats always complete".

## Phases

| # | File | Title | Direct prerequisites |
|---|---|---|---|
| 1 | `phase-1-blocked-member-wire.md` | Blocked-member wire signal + shared stage vocabulary | - |
| 2 | `phase-2-per-file-patch-route.md` | Per-file and files-only patch route cuts | - |
| 3 | `phase-3-fleet-lens.md` | Fleet Lens: clusters, marks, badges | 1 |
| 4 | `phase-4-attention-inbox-decision-dossier.md` | Attention inbox + decision dossier | 1, 3 |
| 5 | `phase-5-run-console-lanes.md` | Run console: pipeline, live lanes, inline answering | 4 |
| 6 | `phase-6-compare-workspace.md` | Compare workspace: matrix + synced panes | 2, 5 |

## Dependency graph and concurrency

```
1 ──► 3 ──► 4 ──► 5 ──► 6
2 ─────────────────────► 6
```

- **Concurrency group A**: Phases 1 and 2 start together (no shared files; mergeable in either order).
- Phase 2 remains concurrent with 3, 4 and 5 - only Phase 6 consumes it.
- Phases 3 -> 4 -> 5 are serialized deliberately: 3 and 4 both edit `App.tsx`/`session-bits.tsx`; 4 and 5 both restructure `EnsembleDetail.tsx` and the result plumbing; and the approved direction ordered them.

## Merge order

Any topological order of the graph. The canonical sequence: 1, 2 (either order), 3, 4, 5, 6.

## Cross-phase contracts (the load-bearing handoffs)

- `membersNeedingInput` / `membersOut` / `needsInput` / `ensembleStageWord` (Phase 1) are the ONE wire truth and vocabulary; no browser re-derivation, no second mapping. No new ensemble alert class for blocked members (5.4 rationale). `membersOut` is store-computed row state; the other two are registry-derived at publish.
- `orderSessions` (Phase 3) is the one fleet ordering feeding rendered order AND nav arrays; `EnsembleProgressDots` is the one progress leaf.
- The topbar attention surface belongs to Phase 4's inbox (`OVERLAY_IDS.attention`, fold in `lib/attention.ts`); `DecisionPanel` is the one decision form.
- Phase 2's route contract: single `?path=`, `?filesOnly=1`, `patchPaths`, complete `files` always.
- Threaded `sessions`/`reviews` props (Phase 5) are optional-with-default so route tests with stub registries stay valid.

## Explicitly out of scope (recorded, not owned by any phase)

- G5's feature-home relocation: the phases add the tab badge and inbox entry points, but ensembles remain a tab on the Workflows page - moving the feature's home was not part of any approved solution.
- G9's stall TIMER / deadline policy: the lanes show `lastActivity` age honestly; a policy is a separate product decision.
- G10 observed-model capture (`member-launch.ts:75` "a later phase records") - server telemetry work, untouched.
- G19 task-to-ensemble conversion and G20 non-manual source kinds - out of the approved direction's scope.

## Final verification strategy

Each phase ships its own tests and manual verification (listed per file). After Phase 6: run the full suite, then one end-to-end pass on a real Best-of-N run - launch from Dispatch, watch clusters in all three layouts, block a member with a question and answer it from the inbox AND from its lane, drive to `awaiting_decision`, decide from the dossier, compare two candidates per file, restore a loser - confirming every phase-owned gap (G1-G4, G6-G8, G11-G18, and the badge half of G5) against the source plan's catalog; the out-of-scope list above is what deliberately remains open. The extension-contract invariants (`ensemble-extension-contract.test.ts`: no strategy branch in the engine, no Ensemble node in the Workflow graph) must be green untouched after every phase.
