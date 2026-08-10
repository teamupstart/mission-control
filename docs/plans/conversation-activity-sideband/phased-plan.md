# Conversation observed activity sideband: phased implementation plan

Source plan: [plan.md](plan.md)

Approved visual direction: [Duplex Console mockup](../../archive/mockups/conversation-terminal/02-duplex-console.html)

Status: Ready to schedule after this planning branch is pushed

## Incorporated human decisions

The operator selected Scope 1 on 2026-08-06 and explicitly requested that the phased-plan workflow schedule it. Scope 1 means an observed-only browser projection over existing transcript tool calls. It excludes lifecycle telemetry and operating-system process monitoring.

No further product choice is open in this packet.

## Repository findings

- `TranscriptPanel` owns the loaded `TranscriptMessage[]` state and is shared by Console detail and expanded session cards.
- `transcriptRows()` folds consecutive tool-only messages for the main log, so the sideband must derive directly from messages to avoid omitting tools attached to prose turns.
- `toolChip()` already centralizes compact tool labels and target extraction.
- `.find-split` already allocates a secondary rail to Conversation Find and changes layout below a container-width breakpoint.
- The real Electron geometry test covers Conversation log, composer, Find rail, Console detail, and expanded cards. The new rail must extend that evidence rather than establish a parallel fixture.
- Browser behavior must be covered in `e2e/` with fake agent binaries. No live model invocation is permitted.
- README documentation must change with visible product behavior.

## Phase topology

| Phase | Outcome | Direct dependencies | Concurrency group |
| --- | --- | --- | --- |
| [1. Observed activity sideband](phase-1-observed-activity-sideband.md) | A tested, documented transcript-derived activity rail in both Conversation surfaces | Planning PR merged | A |

There is one implementation phase. The model, UI, responsive geometry, documentation, and user-visible tests form a single vertical slice with overlapping ownership in `TranscriptPanel`, transcript tools, and Conversation styles. A split would not be independently releasable.

## Merge order

1. Merge this planning PR so the scheduled task can resolve every plan and mockup link on its base branch.
2. Release and implement Phase 1.
3. Merge the Phase 1 implementation only after its complete exit gate passes.

The scheduled task must depend on the current planning session so Mission Control holds it until this PR merges.

## Shared contracts

- Existing `TranscriptMessage` and `ToolCall` types remain unchanged.
- The existing transcript SSE and scrollback semantics remain the only data source.
- Existing tool projection remains the source of display-safe labels and targets.
- Observed activity must not introduce lifecycle terminology unsupported by the normalized transcript.
- Find owns the secondary rail while open; activity returns when Find closes.
- The composer remains pinned and accessible in both host contexts.

## Cross-phase compatibility audit

Only one implementation phase exists, so there are no implementation-to-implementation handoffs. Compatibility is instead audited at the existing seams:

- **Shared types:** no wire or persisted schema change.
- **Server:** no new route, stream, poller, hook field, or database writer.
- **Web:** one derived projection from the canonical transcript state.
- **Layout:** reuse the current secondary-column model and its narrow-container transition.
- **Search:** transcript remains canonical; activity does not double-count matches.
- **Harness parity:** all harnesses degrade through the same existing normalized tool shape.
- **Delivery:** the implementation task remains blocked until this artifact commit is available on the base branch.

## Final verification

Phase 1 is the release candidate for this scope and runs the complete bar:

- focused projection tests;
- Electron Conversation geometry coverage;
- typecheck and lint;
- full unit test suite;
- production build and bundle smoke tests;
- focused and full Playwright coverage against fake agents;
- manual desktop and narrow-width visual verification;
- README consistency review.

## Scheduling record

The phase task is created only after this packet and its mockups are committed and pushed. The task ID and dependency mapping belong in the planning PR description so reviewers can verify that merging the PR releases the scheduled work.
