# Phase 2: Surface Recoverable Engineer Refusals

## Outcome

Mission Control's Board, Console, and Runs surfaces immediately distinguish a recoverable Engineer
land refusal or failed current step from ordinary authoring, expose the exact provider reason, and
return to running when the provider records a retry or later successful transition.

## Entry criteria and dependencies

- Source plan: `docs/plans/engineer-progress-and-refusal-visibility/plan.md`.
- Phased index: `docs/plans/engineer-progress-and-refusal-visibility/phased-plan.md`.
- Direct phase dependencies: none.
- Scheduling dependency: this planning session and plan PR must merge first.
- AI Conductor is attached only to verify the existing event contract.

## Repository scope

### Primary: Mission Control

Implement, test, document, commit, push, and open the Mission Control pull request.

### Attached context-only: `/Users/jordan.mance/workspace/upstart/ai-conductor`

Read the current provider event and reducer semantics. Do not edit AI Conductor. An AI Conductor diff
makes this phase incomplete rather than multi-repository.

## Scope

- Add explicit, reducer-owned provenance for recoverable failed-step and land-refusal blockers.
- Derive the blocked presentation only from that typed provenance.
- Reuse the shared Pipeline phase meter across Board, Console, and Runs.
- Show the exact provider reason accessibly without making the commission terminal.
- Clear the presentation naturally when the next provider event clears or supersedes the error.
- Add focused unit, markup, and built-dashboard E2E regression coverage with visual evidence.

## Non-goals

- No provider lifecycle emission, artifact inspection, approval inference, or filesystem polling.
- No change to provider event discriminants, ingest envelope, revision rules, or SQLite schema.
- No terminal failure transition for `engineer_land_refused`.
- No lifecycle command instructions in the Mission Control dispatch prompt.
- No automatic artifact repair, rename, land retry, or spec merge.

## Verified repository findings and inherited contracts

- `reduceKnownEvent` clears `commission.error` at the start of each accepted event before applying
  the new event. A later retry or success already removes stale refusal state, but the commission
  does not retain which event kind produced a current generic error.
- `engineer_step_failed` stores a failed step and error. `engineer_step_retried` stores an in-progress
  step and reason. `engineer_land_refused` stores an error while leaving the run authoring.
- `pipelineRunForCommission` currently creates a halt only for terminal commission failure, so the
  Board meter cannot expose recoverable refusal.
- `pipelineCommissionLine` falls back to `Engineer authoring` when no current step exists, even when
  a land refusal reason is present.
- `PipelinePhaseMeter` already has accessible, keyboard-reachable halt UI and is shared by the
  relevant commission surfaces.
- The E2E continuity fixture emits real versioned Engineer events through the daemon while fake
  agents prevent model use.

## Implementation steps

### 1. Preserve explicit blocker provenance in the commission projection

Extend `PipelineCommission` with one optional, bounded blocker projection whose discriminated kinds
are exactly `step_failed` and `land_refused`. Carry the provider reason and the canonical step only
for the failed-step variant. Keep this field Mission Control-owned; do not add it to AI Conductor's
event schema or ingest envelope.

Update commission creation, database JSON decoding, persistence round trips, and the reducer so:

- legacy rows with no blocker decode to `null`;
- `engineer_step_failed` sets `step_failed` provenance;
- `engineer_land_refused` sets `land_refused` provenance;
- a retry, accepted completion, successful land reconciliation, or later successful transition
  clears the blocker through the normal event fold;
- terminal cancellation/failure keeps its existing lifecycle-based halt rather than being recast as
  a recoverable blocker;
- unknown events cannot manufacture, retain past a known recovery event, or reinterpret a blocker.

Do not derive blocker kind from reason text, a generic `commission.error`, the absence of a current
step, or the absence of a running retry.

### 2. Define the recoverable blocked view in the shared model

Add one focused predicate or fold in `src/web/pipelines/pipeline-run-model.ts` that distinguishes:

- terminal run failure;
- an explicit `step_failed` blocker whose step is still failed;
- an explicit `land_refused` blocker;
- a retry whose current step is `in_progress`, which remains running even if the retry event carries
  a reason.

Use that fold in `pipelineRunForCommission` to supply a synthetic unclassified halt and `halted`
group only while the explicit recoverable blocker is current. Keep the commission's lifecycle and
attempt state nonterminal.

Update `pipelineCommissionLine` so the short status does not say ordinary authoring while the shared
model says blocked. Preserve the exact reason in the existing halt presentation rather than
truncating or replacing it with guessed remediation.

### 3. Reuse the existing accessible meter presentation

Keep `PipelinePhaseMeter` as the single rendering seam. Adjust it only if the shared synthetic run
cannot expose the exact reason through the existing keyboard-reachable `halted` control and tooltip.
Do not add a second alert component with independent status logic.

Verify Board card width, narrow-card wrapping, Console detail, and Runs detail. Treat clipping,
ambiguous color-only status, or inaccessible refusal details as defects in scope.

### 4. Add focused persistence, reducer, and view-model tests

Extend existing pipeline commission, runs-view, and phase-meter tests to prove:

- legacy persisted commissions with no blocker remain readable and do not synthesize one;
- land refusal remains authoring in persisted lifecycle, records `land_refused`, and renders blocked
  with its exact reason;
- failed current step records `step_failed` and renders blocked;
- an unrelated generic commission error with the same shape does not render blocked;
- retry-in-progress renders running rather than halted;
- the next accepted completion or retry event clears stale blocker and refusal presentation;
- terminal failure behavior is unchanged;
- a future unknown provider step remains visible and does not break the fold.

Prefer direct fold assertions for semantics and static markup only for DOM shape and accessible copy.

### 5. Reproduce and verify in the built browser

Extend the existing conductor planning continuity E2E or add a narrowly named spec using the same
fixture. Drive a real commission through the built daemon and dashboard with fake agents:

1. start the Engineer run and one authoring step;
2. emit `engineer_land_refused` with the reproduced stem-mismatch reason;
3. assert Board, Console, and Runs visibly show a blocked state and expose the exact reason;
4. verify keyboard access to the reason and inspect wide and narrow card geometry;
5. emit `engineer_step_retried` or a later valid transition and assert the stale blocked treatment is
   gone.

Capture a gitignored screenshot and focused Playwright transcript under `e2e/.artifacts/` for review
and workflow evidence. Never commit the evidence files.

### 6. Align product documentation

Update `docs/pipelines.md` only as needed to state that recoverable Engineer refusals are visible as
blocked without becoming terminal, and that later provider events clear them. Preserve the existing
provider-ownership and replay model.

## Data, API, and compatibility details

- No SQLite migration. `PipelineCommission` gains one optional discriminated blocker field in its
  persisted JSON and browser wire projection; missing legacy values normalize to `null`.
- No new SSE event, route, ingest field, or provider adapter command.
- The browser derives presentation from the explicitly typed blocker delivered in the existing
  `PipelineCommission` projection.
- Unknown future step names continue through the existing tolerant model.
- Recovery relies on the existing reducer's per-event error reset, not a new cleanup timer or polling
  path.

## Tests and verification

Use the required test preload for every focused Node test:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/pipeline-commission.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/pipeline-runs-view.test.ts test/pipeline-phase-meter.test.ts
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npm run test:e2e -- e2e/specs/conductor-planning-continuity.spec.ts --workers=1
```

If the scenario moves to a new E2E file, run that exact file instead. On macOS under the seatbelt,
use the repository-approved scoped outside-sandbox execution for Electron geometry tests rather than
bypassing the preflight.

## Merge and exit criteria

- The reproduced land refusal no longer looks like ordinary authoring on any shared commission
  surface.
- The exact provider reason is reachable by keyboard and assistive technology.
- Retry and recovery do not retain a stale halted state.
- No provider lifecycle or persistence ownership moved into Mission Control.
- Focused checks, required gates, built E2E, and visual review pass.
- Only Mission Control is changed, and its pull request is reviewable and green.

## Downstream handoff

Later work may reuse the recoverable-block fold for new provider error events that share the same
projected facts. It must not broaden that fold by parsing reason strings, inspecting artifacts, or
turning every informational retry reason into a halt.

## Cross-phase audit record

- 2026-08-31, ownership audit: Mission Control presents existing provider facts and emits none.
- 2026-08-31, recovery audit: the commission remains nonterminal; a later provider event clears the
  error through the existing reducer.
- 2026-08-31, compatibility audit: no provider event, ingest, replay, route, or SQLite contract
  changes; the additive commission blocker defaults safely for legacy JSON.
- 2026-08-31, Inspector audit: generic `commission.error` shape is not provenance. Only explicit
  reducer branches for step failure and land refusal may set a recoverable blocker.
- 2026-08-31, repository audit: AI Conductor is context-only and must remain unchanged.
