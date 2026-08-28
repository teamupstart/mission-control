# Phase 3: Mission Control Dispatch-to-Worker Pipeline Continuity UX

## Outcome

A Mission Control Pipeline task renders its full phase meter immediately, advances through live AI Conductor DECIDE events, pauses at an explicit spec-merge gate, and automatically continues on the later daemon/provider worker without becoming a second pipeline. The Engineer conversation stays interactive throughout its part of the lifecycle.

This phase lands only in Mission Control. The AI Conductor fork is attached as read-only context and must not be changed.

## Entry criteria and dependencies

- Source plan: `docs/plans/conductor-planning-pipeline-continuity/plan.md`.
- Phased index: `docs/plans/conductor-planning-pipeline-continuity/phased-plan.md`.
- Direct dependency: Phase 2 is merged in Mission Control.
- Transitive dependency: Phase 1 is merged in `mancej/ai-conductor`.
- The planning PR containing this file is merged.
- The Phase 2 PR documents any deviations from the proposed shared type or provider method names.

## Repository scope

### Primary: Mission Control

Implement, test, document, commit, push, and open one Mission Control PR.

### Attached context-only: `/Users/jordan.mance/workspace/upstart/ai-conductor`

Use the merged event/capability contract and fakes. Do not modify AI Conductor or open another fork/upstream PR.

## Scope

- Capability-gated Pipeline dispatch using durable commission creation and provider Engineer run reservation before host launch.
- Exact Engineer run context delivery to both managed SDK and terminal Engineer paths.
- Task, session, and later implementation-run binding to one commission.
- Immediate and live phase meter on Engineer cards.
- Explicit awaiting-spec-merge and merged/queued lifecycle copy.
- Automatic provider worker membership and meter continuation.
- Commission detail in Runs plus task/rail/Console affordances.
- Strict exclusion of authoring worktrees without execution state from implementation runs.
- Retry, cancellation, interrupted-host, PR-close, daemon-down, restart, and legacy behavior.
- Built-browser Playwright coverage and visual review.
- Product documentation.

## Non-goals

- No AI Conductor changes.
- No automatic spec merge.
- No transcript parsing, question-text inference, title/slug guessing, or artifact-timestamp progress inference.
- No change to downstream model/provider selection.
- No composer on provider-driven worker sessions.
- No requirement that historical/legacy Pipeline tasks gain a commission retroactively.
- No new browser polling or WebSocket channel.

## Inherited contracts

From Phase 1:

- exact capability and Engineer event/replay semantics;
- exact handoff plan slug, branch, PR URL, and awaiting-merge boundary;
- artifact-backed completion and explicit skips.

From Phase 2:

- durable one-task/one-commission storage;
- provider create/replay/cancel adapter;
- ordered Engineer attempts with per-run replay cursors and terminal-run immutability;
- live/replay reducer convergence;
- exact shared projection and SSE collection;
- plugin envelope validation;
- nullable final implementation-run link.

## Verified UI and session findings

- `src/server/dispatcher.ts:856-887` currently reserves a raw-intent run link before host launch.
- `src/server/dispatcher.ts:889-966` intentionally launches a managed Engineer with an interactive session and a launch-scoped MCP descriptor.
- `src/server/registry.ts:6115-6144` projects task ownership separately from `Session.pipeline`.
- `src/server/registry.ts:6226-6274` correlates provider workers by worktree containment.
- `src/web/components/layouts/SessionTile.tsx:277-283` currently gates the meter on `Session.pipeline` plus an observed run.
- `src/web/pipelines/pipeline-run-model.ts` already owns phase/status derivation and must remain the single calculation surface.
- `src/web/components/session-bits.tsx` currently labels pre-run links as planned slugs, which is misleading before DECIDE settles final identity.
- `e2e/fixtures/conductor.ts`, `e2e/specs/conductor-live-ingest.spec.ts`, and `e2e/specs/board-card-phase-meter.spec.ts` provide fake-provider and built-browser patterns.

## Implementation steps

### 1. Reproduce the current gap in the built app

Before changing runtime behavior, add or stage a Playwright test that uses fake agents and fake AI Conductor to show:

- dispatching a Pipeline task produces an Engineer card without a phase meter;
- an architecture-review interaction does not change DECIDE progress;
- an authoring worktree containing `.pipeline/` but no `conduct-state.json` appears as a false all-pending run;
- a later implementation worktree appears as a separate lifecycle.

Keep the failing assertions focused on user-visible behavior. Do not spend model tokens and do not add `data-testid`.

### 2. Activate transactional commission dispatch

Update the provider-neutral dispatch path to use Phase 2's optional Engineer capability.

For the capable AI Conductor fork:

1. mint and persist the commission plus `Task.pipelineCommissionId`;
2. mint and persist commission attempt 1 plus its opaque launch key;
3. create/reserve the provider Engineer run with the commission id as correlation and the launch key as attempt key;
4. persist the returned Engineer run id, attempt ordinal, and predecessor;
5. only then launch the selected host;
6. emit task/commission state after durable writes.

Remove raw-intent `Task.pipelineRun` reservation on this capable path. Keep the current legacy path for providers/versions outside the new contract, with explicit UI copy or pre-launch refusal matching the approved source plan.

The active-run collision check must use commission/provider identities and the exact handoff run link, not the provisional intent slug.

### 3. Deliver Engineer run context to both host paths

The managed SDK path must retain its interactive composer, launch-scoped attribution, and accepted-goal presentation. Deliver only the generic Engineer run context the canonical AI Conductor flow requires. Do not expose bearer credentials in prompt text.

The terminal path passes provider-owned argv/flags returned by the provider adapter. Preserve the CLAUDECODE nesting guard and terminal ownership behavior.

Capability mismatch, create failure, malformed JSON, or missing required host support fails before spawn with an actionable error. If no terminal Engineer run exists, retrying the same launch transaction reuses the commission attempt and launch key idempotently, which recovers safely when provider creation succeeded but its response was lost. A non-terminal interrupted run resumes as the same attempt.

If the Engineer run is failed, attempt-cancelled, or otherwise terminal, an explicit retry keeps the commission but atomically appends the next commission attempt with a new launch key. Provider creation returns a new Engineer run linked to its predecessor. Never reopen the old run, reset its revision, or reuse its launch key. Reject retry while another attempt is non-terminal.

### 4. Bind task and sessions to the commission

Project `pipelineCommissionId` through `TaskSummary`. Add registry lookups for:

- directly bound Engineer session by task commission;
- provider worker session by exact `Session.pipeline` run link matched to a commission's final run;
- retained Engineer session after handoff;
- no match for legacy or unrelated sessions.

Keep membership precedence:

1. explicit ensemble membership;
2. direct task commission;
3. exact provider-run commission;
4. legacy pipeline run key.

Do not set `Session.pipeline` on the Engineer SDK session. Do not clear the provider worker's `Session.pipeline`.

### 5. Correct false implementation-run discovery

Tighten the AI Conductor reader so an implementation run requires `conduct-state.json` or another explicit execution manifest defined by the provider contract. `.pipeline/` alone is not proof. Exclude Engineer authoring worktrees from `PipelineRun` projection even when they contain verification artifacts.

Keep unreadable-directory and partial-listing failure behavior unchanged. Add unit and browser regression coverage so a future loose scanner cannot recreate the duplicate all-pending row.

### 6. Generalize the phase meter view model

Refactor `pipeline-run-model.ts` so both `PipelineRun` and `PipelineCommission` feed one shared phase/status calculation. Do not duplicate step-to-phase or status-tone rules.

Commission-specific lifecycle copy supplies:

- **Starting Engineer** before the first provider event;
- **Retrying Engineer (attempt N)** after a successor attempt is reserved;
- current DECIDE phase/step while authoring;
- **Awaiting spec merge** after handoff;
- **Spec merged - waiting for Conductor** when merge is known but no run exists;
- ordinary BUILD/SHIP copy once the exact provider run appears;
- explicit interrupted, failed, cancelled, or unsupported state.

No step becomes `in_progress` until provider evidence says so.

### 7. Render Board, rail, Console, and Runs behavior

Update the Board tile to render the commission meter whenever the session resolves to a commission, even before a provider run exists. Preserve card customization visibility controls.

Replace planned-slug chips on commissioned tasks with lifecycle-aware commission affordances. Link to a new or extended Runs commission detail showing:

- ordered authoring attempts and their run/step history;
- tier/track/skips;
- spec branch and PR gate;
- exact linked implementation run and its existing detail;
- recovery/error state.

Cluster the retained Engineer and later provider worker under the same commission where current Board/Console grouping supports it. The Engineer card remains clickable/messageable. The provider worker retains the standard driven-by-provider notice.

### 8. Handle handoff, merge, retry, and cancellation

On the exact handoff event:

- persist final plan slug, branch, and spec PR URL;
- update `Task.pipelineRun` to the exact final link;
- show awaiting merge;
- refuse collisions with another active task/commission.

Use existing GitHub/PR observation where available to distinguish merged/queued from merely awaiting. If merge state cannot be read, remain honest at awaiting until provider run discovery proves continuation.

When the provider run appears, bind it to the commission and let existing run settlement continue to own BUILD/SHIP completion. A later worker session joins automatically through the run link.

An explicit retry after an Engineer attempt fails or is attempt-cancelled creates the successor attempt described above. The UI keeps prior attempts visible, makes only the successor current, and derives current DECIDE progress from that successor. AI Conductor may reconcile reusable accepted artifacts into the new run; Mission Control does not carry prior completed steps forward on its own.

Cancellation routes through the provider capability during authoring and existing provider control during implementation. Cancelling an attempt for a retry makes only that attempt terminal. Cancelling the Pipeline task makes the commission terminal, refuses same-commission retry, and requires a later request to create a new task and commission. Stale events from prior attempts cannot change the active attempt, and stale later events cannot reopen a cancelled commission. Host exit alone marks interruption, not step failure.

### 9. Update product documentation

Update `docs/pipelines.md` and `docs/dispatch-and-backlog.md` with:

- one commission across multiple sessions;
- immediate card behavior;
- DECIDE event/replay source;
- awaiting-spec-merge gate;
- exact post-merge continuation;
- capability/legacy behavior;
- recovery and cancellation boundaries.

Do not present `.pipeline/conduct-state.json` as the pre-merge source. Do not claim the plugin is authoritative without replay.

## Compatibility details

- Old task rows with no commission remain valid.
- Old provider versions follow the documented legacy/refusal path without partial commission UI.
- Existing `pipeline_upsert` and `pipeline_remove` behavior remains intact.
- Existing uncommissioned Runs detail stays directly addressable.
- The connect snapshot remains bounded by active commissions/tasks, not history.
- A commission is retained through the task/run lifecycle and retired through one documented cleanup path.
- `session_remove` remains the durable session cleanup signal.

## Tests and verification

### Focused server/shared tests

- pre-launch ordering and no-host-on-capability/create failure;
- same-launch idempotency, terminal-attempt successor creation, concurrent-attempt refusal, and collision refusal;
- task/session/worker commission joins and precedence;
- handoff exact-slug binding despite intent/branch/worktree mismatch;
- PR closed unmerged, daemon down, restart, cancellation, and stale event cases;
- authoring worktree excluded without execution manifest;
- commission/run meter derivation parity;
- snapshot/upsert/remove exhaustive handling;
- task settlement still follows the real provider run.

### Browser E2E

Add `e2e/specs/conductor-planning-continuity.spec.ts` or the closest existing spec if consolidation is cleaner. Use role, label, text, and placeholder selectors only.

Prove:

- immediate full meter on the Engineer card;
- no false in-progress step before provider evidence;
- architecture review and other DECIDE steps advance from live events;
- explicit product/technical and tier skips;
- failed/retried authoring step presentation;
- terminal Engineer retry shown as a new run attempt under the same commission, with immutable prior history;
- awaiting-spec-merge copy and PR link;
- refresh/restart replay;
- simulated merge plus implementation run binding;
- later worker in the same commission with continued meter;
- interactive Engineer composer and disabled provider worker composer;
- no duplicate false run from authoring `.pipeline/`;
- normal and narrow Board layouts with reviewed screenshots.

### Commands

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npm run test:e2e -- e2e/specs/conductor-planning-continuity.spec.ts --workers=1
```

Run `npm run test:electron` as well if meter or cluster layout needs native geometry coverage. On macOS under the seatbelt sandbox, use the repository-prescribed scoped approval rather than bypassing preflight.

## Merge and exit criteria

- The original screenshot-visible gap is reproduced by the pre-change browser test and passes after implementation.
- A new Pipeline task shows the meter immediately and advances through DECIDE.
- Handoff, merge, implementation discovery, and a later worker all retain one commission identity.
- No user-visible false run is created from an authoring worktree.
- Error/retry/restart/cancel behavior is explicit and non-misleading.
- A terminal Engineer retry creates a new ordered run attempt without changing the commission or reopening prior history.
- Relevant unit, migration, contract, build, smoke, E2E, and any required Electron geometry tests pass.
- Documentation matches the UI and lifecycle.
- The AI Conductor context checkout has no changes.
- The Mission Control PR is reviewable, green, and merged.

## Downstream handoff

There is no later planned phase. Future consumers may rely on one durable commission spanning the Engineer and provider-run sessions, with AI Conductor as event/step authority and Mission Control as projection/UI authority.

Any future extension must preserve the single event spine, exact final-run binding, session composer boundary, replay correctness, and legacy compatibility. A new provider can implement the optional Engineer capability without copying AI Conductor-specific logic into routes or React.

## Cross-phase audit record

- 2026-08-27: All visible behavior is activated here after Phase 2's dormant foundation, so no earlier merge exposes a half-supported card.
- 2026-08-27: The false-run scanner correction stays with its browser-visible regression coverage.
- 2026-08-27: Session membership uses explicit task/run links, never transcript or naming inference.
- 2026-08-27: AI Conductor remains context-only; this phase consumes but does not alter the provider contract.
- 2026-08-27: Retry identity is commission-stable and run-distinct. Same-launch recovery reuses its attempt key; post-terminal retry appends a new attempt and run.
