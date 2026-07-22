# Phase 6 plan: hardening, observability, and product polish

Status: **implementation-ready**

Parent: [Persona-driven workflow builder](./plan.md)

Prerequisites:

- [Phase 1 foundation and Personas](./phase-1-foundation-personas.md)
- [Phase 2 builder and publishing](./phase-2-builder-publishing.md)
- [Phase 3 bindings, context, and manual preview execution](./phase-3-preview-engine.md)
- [Phase 4 live repair delivery and Foreman completion](./phase-4-live-foreman.md)
- [Phase 5 Inspector final gate](./phase-5-inspector-gate.md)

## Outcome

The workflow builder is ready for sustained local use rather than only a successful demo. Completed
runs have bounded retention, every workflow-owned model call has honest execution accounting,
operators receive edge-triggered workflow alerts, large histories remain responsive, and the
Persona, builder, binding, Run, and final-gate surfaces are usable by keyboard and assistive
technology. Operational state and recovery choices are visible without weakening the execution,
delivery, provenance, or current-head rules established by earlier phases.

This phase changes no core workflow semantics. It may expose, prune, measure, explain, and improve
the existing behavior, but it must not introduce a second engine, GitHub poller, graph node kind,
terminal delivery path, model resolver, or browser live channel.

## Prior-phase prerequisites

Before implementation, run every targeted suite named by Phases 1 through 5. In particular, the
following contracts are release blockers and are not candidates for polish-driven simplification:

- published Persona and binding snapshots are immutable;
- every cycle passes through the one visible Session node;
- infrastructure failure never becomes a Persona fail;
- ambiguous terminal delivery never retries automatically;
- Foreman stays HTTP-only and claimed completions fail closed;
- Inspector adoption and current-head checks remain strict;
- Shipping cannot bypass an incomplete workflow final gate;
- Reset has one cleanup owner and SSE is the only browser live channel.

## Scope

### Included

- Configurable raw-evidence and completed-run retention with safe pruning.
- Workflow-owned LLM call accounting with nullable, authoritative-only monetary cost.
- Paginated Run/event APIs, filters, and responsive history rendering.
- Edge-triggered alerts for blocked, waiting, uncertain, failed, and completed workflows.
- Keyboard and screen-reader operation for Personas, graph construction, publishing, Runs, and gate
  recovery.
- Canvas undo/redo, duplicate, fit, zoom, minimap, selection, and narrow-screen behavior.
- Empty, loading, corrupt-row, stale-version, conflict, disabled, and recovery states.
- On-demand health/diagnostic view and structured workflow logging.
- Export of immutable workflow versions and retained run audit data.
- Full regression, build, smoke, documentation, and packaging validation.

### Excluded

- New graph semantics, Persona kinds, automatic graph generation, or arbitrary executable nodes.
- Remote collaboration, cloud synchronization, or a hosted workflow service.
- Automatic PR creation, Inspector mode changes, auto-approval, or auto-merge from workflow code.
- Fabricated token or dollar estimates for runners that do not report them authoritatively.

## Retention configuration

Extend Phase 4's `WorkflowConfig` in `app_config`:

```ts
export interface WorkflowRetentionConfig {
  rawEvidenceDays: number;     // default 30, range 1..365
  completedRunDays: number;    // default 180, range 30..3650
  maxCompletedRuns: number;    // default 1000, range 100..10000
}

export interface WorkflowConfig {
  liveEnabled: boolean;
  repoAllowlist: string[];
  retention: WorkflowRetentionConfig;
}
```

Zod defaults upgrade existing config blobs without a migration. Keep one Workflows config writer and
one `PUT /api/workflows/config` schema; do not create a second retention config that can overwrite
live/allowlist fields.

The Workflows settings drawer explains exactly what each window removes and shows the last sweep,
rows compacted/deleted, and last error. A shorter retention choice requires confirmation because it
can make the next sweep destructive.

## Two-stage pruning

Create `src/server/workflows/retention.ts` and call it from `WorkflowManager`, once after recovery and
then hourly through one non-overlapping timer. Do not ride the 1.5-second session discovery sweep.
Housekeeping failure logs and updates health state but never blocks hooks, SSE, or engine work.

### Stage 1: compact raw evidence

For completed or cancelled runs older than `rawEvidenceDays`:

- replace raw diff, transcript, porcelain status paths, and standards bodies with explicit pruned
  sentinels while retaining hashes, counts, caps, HEAD, branch, and timestamps;
- remove exact delivered/refused payload text after retaining kind, SHA-256, target, state,
  timestamps, and error class;
- retain primary user goal, sourced human decisions/rationale, compact constraints, Persona
  snapshots, structured verdicts, Inspector finding fingerprints/titles, PR/head, bypass decision,
  and final outcome;
- retain model-call accounting and the append-only workflow event timeline;
- append one `evidence_pruned` event before removing the raw fields.

Never compact active, waiting, blocked, failed, or delivery-uncertain runs at any age. An uncertain
payload remains inspectable because a human still needs its exact bytes to decide whether it landed.

Use one transaction per run and an idempotent `evidence_pruned_at` marker in run gate/audit state.
The JSON parser must accept both full and explicitly pruned evidence, never confuse a missing/corrupt
field with intentional pruning.

### Stage 2: delete old completed run families

Delete a run family only when it is completed or cancelled, older than `completedRunDays`, and not
among the newest `maxCompletedRuns`. In one transaction delete child calls, deliveries, receipts,
attempts, submissions, events, then the run. Keep bindings, published versions, definitions,
Personas, Inspector PRs/comments, and Foreman queue state.

Emit compact `workflow_run_remove` SSE after commit. Cursor pagination must tolerate the row
disappearing between pages. Never age-delete failed, blocked, waiting, orphaned, or uncertain runs;
those need explicit human resolution first.

Reset remains separate and immediate. It routes through `resetSession` and is not implemented by
calling the retention sweeper.

## Honest model-call accounting

Phase 1 front-loads `workflow_llm_calls`:

| Column | Contract |
|---|---|
| `id` | Text primary key. |
| `run_id` / `submission_id` | Non-null workflow ownership. |
| `node_attempt_id` | Nullable for context compaction, non-null for Persona calls. |
| `purpose` | `context_compaction` or `persona_review`. |
| `runner_id` / `model_id` | Actual resolved values used for the call. |
| `attempt` | Non-null positive call attempt. |
| `state` | `running`, `succeeded`, `failed`, `interrupted`, or `cancelled`. |
| `started_at` / `finished_at` / `duration_ms` | Wall-clock accounting. |
| `input_bytes` / `output_bytes` | Bounded prompt/result byte counts, not token guesses. |
| `cost_usd` | Nullable and populated only from an authoritative provider report. |
| `error_code` | Stable bounded class, without raw prompt/model output. |

Index `(run_id, started_at)` and `(submission_id, purpose)`. No unique index contains a nullable
column. The row is inserted before a model call and finalized after it; startup changes `running` to
`interrupted` before Phase 3 retry recovery creates a new call row.

The current `LlmRunner.run` contract returns text only. Therefore this phase records actual runner,
model, call count, duration, byte sizes, retry, and outcome, while `costUsd` remains null unless a
runner later exposes a measured, authoritative provider value. Do not scrape rate tables, infer
tokens from characters, charge session `usage_ledger`, or display null as `$0.00`.

Run detail shows:

- calls by context compaction and Persona;
- actual provider/model, duration, attempts, and failure class;
- a monetary total only when every included value is authoritative;
- **Cost unavailable from this runner** otherwise.

This table belongs to workflow audit and must not be folded into `usage_ledger`, which measures
interactive session telemetry under a different identity and confidence contract.

## Paginated history and bounded HTTP

Change list/detail APIs before the first large installation makes unbounded reads part of the
contract:

```text
GET /api/workflow-runs?cursor=<opaque>&limit=50&status=&workflowId=&session=
GET /api/workflow-runs/:id/events?after=<event-id>&limit=200
GET /api/workflow-runs/:id/export
GET /api/workflows/:id/versions/:version/export
GET /api/workflows/status
```

- Default Run page size is 50, maximum 200.
- Cursor encodes stable `(updated_at, id)` ordering and is validated as opaque input.
- Event pages use the integer event id, not offset.
- Run detail returns bounded current data plus counts/next cursors for events and LLM calls.
- Export is an on-demand JSON download with schema version, pruned markers, hashes, and no fields the
  caller could not read in Run detail.
- Version export contains the immutable published graph, Persona snapshots, completion policy,
  binding defaults, and published metadata. Import remains out of scope to avoid inventing conflict
  and trust rules at the end of the project.

Run list filters are URL/hash state so Back/Forward works. The page preserves selection when an SSE
summary updates and falls back to the nearest row when retention removes the selected run.

## Workflow alerts

Extend `AlertScope` with compact `workflowRuns` and append `workflow` to `AlertKind`. Derive alerts
from summary transitions in `@shared/alerts.ts` so browser notification, sound, reconnect catch-up,
and away digest continue to share one rule.

Emit once per transition:

- attention: delivery becomes uncertain;
- attention: run becomes blocked/failed;
- attention: run first waits for manual resubmit, missing PR handoff, Inspector enablement, or
  uncertain resolution;
- info: run completes;
- info: a previously blocked run resumes.

Stable ids include run id and transition class, for example `workflow:<run-id>:uncertain`, so a
reconnect coalesces rather than storms. Do not alert for every Persona node, retry tick, Inspector
poll, or unchanged wait reason. Clicking/focusing an alert opens `#/workflows/runs/<id>`; if the run
was retained away, open Runs with a clear expired-history message.

Attention workflow alerts remain deliverable while Away; complete/resumed alerts are digest-only.
Add their counts and concise labels to the existing away digest rather than creating a workflow-only
notification system.

## Builder ergonomics

Finish the recommended canvas-first design from the parent mockup:

- Fit view, zoom in/out, reset zoom, and minimap controls.
- Snap-to-grid and alignment guides that affect positions only, never graph semantics.
- Undo/redo for the last 50 local draft edits, cleared after loading another workflow and preserved
  across a successful autosave of the same draft revision.
- Duplicate selected Persona/Join/End node with a new id and offset position. Session cannot be
  duplicated.
- Multi-select and delete with a confirmation summary when deleting a node removes edges.
- Auto-layout as an explicit visual-only action; it preserves ids, ports, policies, and version
  meaning.
- Fit after first load and after auto-layout, never after each SSE or autosave update.
- Clear port labels on hover, focus, and connection mode, with fail edges visually distinct without
  relying on color alone.
- Conflict recovery that can download the unsaved local draft before Reload latest.

Phase 2 validation adds finite bounded coordinates for every node. NaN, Infinity, and coordinates
outside the documented canvas range are malformed input, not a reason to let fit-view allocate an
unbounded surface.

On narrow screens, the canvas stays primary while library and inspector become mutually exclusive
drawers. Preserve canvas selection and draft state while drawers mount/unmount.

## Keyboard and assistive technology

Every builder task must have a non-pointer path:

- Palette items are buttons. **Add** places a node at the viewport center.
- Nodes use roving tab focus and announce kind, Persona name, and incoming/outgoing connection count.
- Arrow keys move a focused node by one grid unit; Shift+Arrow moves by ten.
- Delete/Backspace opens the same deletion confirmation as the button.
- Standard local Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z drive draft undo/redo.
- A **Connect nodes** dialog lets keyboard/screen-reader users select source, source port, target,
  and target port from valid options. It calls the same validator as pointer connections.
- Edge rows in the properties pane can be focused, described, and removed.
- Status changes use a polite live region; validation failures and delivery uncertainty use an
  assertive region only when newly introduced.
- Opening a Persona, conflict dialog, binding dialog, or Run restores focus to its trigger on close.
- Pan/zoom animations honor `prefers-reduced-motion`.

These are page-local editing keys, not new fleet shortcuts. If implementation adds a global chord,
it must extend `ActionId`, `ACTIONS`, App dispatch, `KeyboardPanel`, `CommandBar`, README, and
`keybindings.test.ts` together. Do not hide a global shortcut in a workflow component.

Use semantic tabs, listboxes, forms, headings, fieldsets, and buttons before ARIA. Provide accessible
names for graph controls and do not expose decorative connector SVGs. Meet the existing contrast
test thresholds in both themes, including pass/fail, focus, disabled, stale, and uncertain states.

## Persona and Run polish

Personas:

- Search by name/description, filter Active/Archived, and keep selection stable under SSE.
- Surface exact guidance byte count and limit before Save.
- Make effective versus overridden provider/model unmistakable.
- Preserve dirty text through catalog updates and route changes, with Download draft in conflicts.
- Preview Markdown through the existing safe renderer with no raw HTML enablement.

Runs:

- Group timeline events by repair round while preserving event-id order.
- Collapse large context/evidence sections by default and show pruned/truncated badges.
- Link every attempt to its immutable Persona revision and every delivery to its SHA-256.
- Keep pass/fail, error, waiting, delivery uncertainty, Inspector posture, and bypass visually and
  textually distinct.
- Add Copy run id, Copy feedback, Export audit, Open session, Open PR, and Open published version.
- Disable impossible actions with a visible reason rather than omitting them.

Empty/error states cover no Personas, no workflows, no published version, no live sessions, no runs,
archived selection, malformed durable row, disconnected SSE, route 404, Inspector disabled, live
not allowlisted, session orphaned, retention-pruned evidence, and expired run history.

## Operational health and logging

`GET /api/workflows/status` returns bounded, non-sensitive diagnostics:

```ts
export interface WorkflowStatus {
  activeRuns: number;
  queuedPersonaCalls: number;
  runningPersonaCalls: number;
  waitingDeliveries: number;
  uncertainDeliveries: number;
  inspectorGates: number;
  lastRecoveryAt: number | null;
  lastRetentionAt: number | null;
  lastRetentionError: string | null;
  retainedRunCount: number;
}
```

It does not include prompts, model output, diff, transcript, secrets, or terminal payloads. Show it
on demand in the Workflows settings drawer; do not poll it.

Use structured log prefixes and stable ids:

```text
[workflow] run=<id> submission=<id> event=<kind> ...
```

Log transition, duration, runner/model, retry class, recovery, delivery state, Foreman claim,
Inspector wake, Shipping veto, and retention counts. Never log raw goal, guidance, prompt, verdict
body, diff, transcript, finding body, or delivery payload. Errors are bounded and classified before
logging/persistence.

## Performance and concurrency checks

- Keep Persona concurrency at Phase 3's daemon-local limit of 3 and expose queue depth only.
- Measure graph render/validation at the declared 100-node/300-edge caps and Run list at 1000 rows.
- Parse/validate graph JSON once per load/publish transition, not on every node render.
- Memoize derived adjacency/diagnostics by draft revision.
- Never hold SQLite transactions over model, terminal, filesystem, or GitHub work.
- Batch run-summary SSE updates per committed engine transition, not per SQL row.
- Keep full graph, evidence, findings, deliveries, and events off SSE.
- Ensure Inspector signals and retention sweeps cannot overlap themselves; a slow pass delays the
  next rather than running concurrently.

Document measured browser and daemon timings in the implementation PR. Do not weaken limits based on
an unmeasured assumption.

## Security and privacy regression

- Re-run prompt-fence tests with malicious Persona Markdown, transcript, diff, standards, Inspector
  body, and workflow names.
- Confirm every terminal-bound packet strips control characters and remains byte-identical from
  persisted hash through injection.
- Confirm Markdown rendering does not enable raw HTML or unsafe links.
- Confirm version/run export never bypasses pruned markers or returns raw Inspector model output.
- Confirm workflow logs and health routes contain no user/model payloads.
- Confirm retention never deletes Inspector adoption/comment provenance or published Persona
  snapshots still referenced by versions.
- Confirm live/allowlist, Foreman claim, PR provenance, head match, and Shipping veto remain enforced
  after config edits and restart.

## Implementation order

1. Front-load `workflow_llm_calls`, row parsers, and store methods; instrument workflow-owned model
   calls without changing runner semantics.
2. Extend Workflow config with retention defaults and build idempotent two-stage pruning.
3. Add paginated Run/events APIs, exports, filters, and bounded rendering.
4. Extend shared alerts, App scope, notifier/digest tests, and workflow deep links.
5. Add builder history, duplicate, fit/zoom/minimap, auto-layout, bounded positions, and conflict
   draft download.
6. Add keyboard connection/editing paths, focus restoration, live regions, reduced motion, and
   contrast fixes.
7. Polish Persona/Run states and responsive drawers.
8. Add workflow health route/view and payload-free structured logging.
9. Run security, performance-at-cap, recovery, SSE reconnect, build, smoke, and packaging tests.
10. Complete README/operator docs, environment/config reference, backup/export/retention notes, and
    a manual acceptance checklist using both parent mockups.

## Tests

- `workflow-retention.test.ts`: defaults, active-state protection, evidence compaction, uncertain
  protection, idempotency, completed-run cap/age deletion, child order, Inspector/version retention,
  SSE remove, and sweep failure isolation.
- `workflow-llm-calls.test.ts`: pre-call insert, success/failure/interruption, actual runner/model,
  duration/bytes, retries, nullable cost honesty, restart recovery, and no `usage_ledger` writes.
- `workflow-pagination.test.ts`: stable cursors, filters, caps, event-after paging, concurrent delete,
  and malformed cursor.
- `workflow-export.test.ts`: version snapshot, full/pruned run, schema version, no raw hidden fields,
  and browser download naming.
- Extend `alerts.test.ts`, notifier source tests, away digest tests, and reconnect tests for each
  workflow transition without duplicates.
- `workflow-builder-keyboard.test.ts`: add/focus/move/connect/delete/undo/redo/duplicate and no
  duplicate Session.
- `workflow-builder-a11y.test.ts`: source/render assertions for semantic names, live regions, focus
  restoration, reduced motion, and color-independent labels.
- Extend `styles-contrast.test.ts` for every workflow tone in both themes.
- `workflow-builder-performance.test.ts`: validator/adjacency at 100 nodes and 300 edges, bounded
  positions, and no quadratic render derivation.
- `workflow-status.test.ts`: counts, recovery/retention timestamps, error bounds, and payload absence.
- Extend workflow recovery, Reset, delivery, Foreman, Inspector, Shipping, SSE, and layout-parity
  suites as regression gates.
- `npm run typecheck`, `npm test`, `npm run build`, and `npm run smoke`.

## Manual acceptance matrix

Complete at minimum in browser and packaged Electron, light and dark themes:

1. Create/import/edit/export/archive a Persona, including a two-tab CAS conflict.
2. Build the example graph entirely with pointer, then entirely with keyboard.
3. Publish, edit a Persona, and confirm the published version remains immutable/stale-labeled.
4. Bind and run Preview through concurrent fail, repair, resubmit, and pass.
5. Run Live on an allowlisted repo and exercise positive refusal plus an explicitly resolved
   uncertain delivery without duplicate text.
6. Trigger initial and repair submissions through both Foreman boundaries.
7. Exercise missing/unadopted PR, disabled Inspector, findings, full restart, Inspector-only new
   head, clean completion, and Shipping veto.
8. Restart the daemon during Persona execution, prepared delivery, sending delivery, Session wait,
   and Inspector wait.
9. Reset a bound session and confirm workflow rows clear while Personas/versions/Inspector ledger
   remain.
10. Compact and expire test runs, export retained audit, reconnect SSE, and verify alerts do not
    storm.

## Exit criteria

- Retention bounds raw evidence and completed history without deleting unresolved work or reusable
  definitions/Personas/Inspector provenance.
- Every workflow model call reports actual runner/model, timing, byte counts, and outcome; unknown
  monetary cost is absent rather than fabricated.
- Run/event APIs and UI stay bounded at declared scale.
- Workflow alerts are edge-triggered, reconnect-safe, and integrated with away mode.
- The complete example can be authored and operated without a pointer.
- Pass/fail/error/wait/uncertain/bypass states are understandable without color alone.
- Builder ergonomics do not mutate graph meaning or published versions.
- Health/logging aid diagnosis without exposing user or model payloads.
- All earlier safety, provenance, delivery, Reset, layout, SSE, and Shipping invariants remain green.
- Typecheck, full tests, production build, bundle smoke, and the manual acceptance matrix pass.

## Cross-phase audit record

- Initial audit: checked against the parent and Phases 1 through 5.
- Prior-plan follow-up required: front-load `workflow_llm_calls` in Phase 1 and bounded finite node
  coordinates in Phase 2. Those are persistence/input contracts, not late UI embellishments.
- No execution-semantic changes required in Phases 3 through 5. Their state, delivery, Foreman,
  Inspector, and Shipping rules are release gates for this phase.
- Parent follow-up required: qualify cost attribution as authoritative-only, specify two-stage
  retention, integrate workflow transitions into the existing alert engine, and make page-local
  keyboard behavior distinct from the global shortcut registry.
