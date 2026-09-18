# Terminal lifecycle implementation phases

Approved source: [plan.md](plan.md), [rendered source](plan.html). The operator submitted **Approve plan** and **Create phased implementation plan** on 2026-09-18. All eight scout reports were reviewed before scheduling, including the final archived cmux report and the explicitly included unpublished iTerm2 report.

## Execution and sizing

One phase and one ship task per scout is an explicit operator requirement. All eight tasks use Codex `gpt-6-astra`, `xhigh`, and `builtin-workflow:no-mistakes-review`, and are disabled (`enabled: false`). Each pulls latest `main`, resolves conflicts, rebuilds before manual reproduction, and records the exact tested SHA. A regression test proves a verified defect where feasible before it is fixed. No task assumes the old scout result still holds.

Estimated gross production code added or materially changed: **0 to 1,800 lines**, excluding tests, documentation and evidence. A working estimate if the remaining candidates reproduce is 400 to 1,200 lines, mostly target identity, correlation and inventory handling. Confidence is approximately 60% because fresh reproduction can eliminate whole repairs. This estimate does not authorize any change. PR #1085 already removed several shared failure mechanisms; verification-only outcomes can be zero lines.

Eight phases are retained because the operator requested one task per scout. Combining adjacent phases would lose that independently reviewable scout-to-task mapping. Beyond that requirement, native tmux, each Herdr host, Ghostty AppleScript, WezTerm native mux incarnation, cmux surface topology and iTerm2 readiness have distinct environments and negative controls. The three Herdr phases deliberately share one early owner for common repairs, so separate verification tasks do not create competing implementations.

## Phase table

| Phase | Task guide | Production LOC range | Direct phase prerequisite | Shared ownership and merge value |
| --- | --- | --- | --- | --- |
| 1 | [tmux verification](phase-1-tmux.md) | 0–100 | None | Verify already-landed exact identity and scoped Kill; establish residual baseline. |
| 2 | [Herdr in WezTerm](phase-2-herdr-wezterm.md) | 0–250 | 1 | First owner for remaining shared Herdr cleanup/discovery fixes; preserve Phase 1. |
| 3 | [Herdr in Ghostty](phase-3-herdr-ghostty.md) | 0–150 | 2 | Own equivalent-path creation verification; consume common fixes. |
| 4 | [Herdr in iTerm2](phase-4-herdr-iterm.md) | 0–100 | 3 | Verify shared fixes across reclaim and all three harness shapes. |
| 5 | [Ghostty standalone](phase-5-ghostty.md) | 0–600 | 4 | Own trustworthy emulator correlation, launch identity retention and any shared inventory-unknown contract. |
| 6 | [WezTerm standalone](phase-6-wezterm.md) | 0–250 | 5 | Own stale numeric pane identity across native mux restart. |
| 7 | [cmux lifecycle](phase-7-cmux.md) | 0–200 | 6 | Verify shared identity/Kill fixes against live topology changes and cmux-specific limits. |
| 8 | [iTerm2 standalone](phase-8-iterm.md) | 0–150 | 7 | Reproduce unresolved readiness/inventory symptoms; reuse shared contracts. |

All phases touch only Mission Control. No attached repository is needed. Terminal applications and Herdr are test dependencies, not additional repositories authorized for edits.

## Dependency graph and release

Planning task `52df02cc-50da-4fc0-a32f-2f20c745e458` is a direct prerequisite of every phase. Phase dependencies are `1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8`. There are no concurrency groups with more than one task. Even phases with independent code remain serial by explicit operator instruction.

The planning PR must merge the referenced files to `main` before any phase starts. Each implementation PR then gates its successor. Disabled state remains in force when dependencies are satisfied; the operator separately enables the next eligible task. No task is enabled by this plan.

For a phase whose defects are already fixed or do not reproduce after bounded manual checks, produce a verification result with current SHA, controls and limits. Do not invent a patch or PR. The operator must explicitly complete that no-change task with dependency satisfaction after reviewing its evidence; ordinary completion alone does not release its successor. This is a documented execution path, not permission for agents to override unsatisfied dependencies.

## Investigated findings and compatibility decisions

Planning baseline: `7c009fe0`. Historical reports were mostly based on `31c638e4`; the tmux scout used `1cc9d41`. Read the source plan for every original task ID, archive ID and report locator.

- **Verified:** PR #1085 (`bb0dcf91`) added tmux identity checks and `closeIfOnlyPane`, made shared Kill conservative where that capability is absent, and carried recorded resource identity into cleanup. Old title-based cleanup and broad Kill reproductions must be rechecked, not reimplemented from obsolete source excerpts.
- **Verified:** `src/server/discovery/correlate.ts` excludes the root PID in `ancestorDistances`. Phase 2 owns any proven direct-exec correlation correction; later phases may rely on its exact process identity contract, not cwd guesses.
- **Verified:** `src/server/terminal/herdr-client.ts` compares the returned root pane cwd with the requested cwd as strings. Phase 3 owns a correction if the equivalent-path failure still reproduces. Remote path semantics and outcome uncertainty remain explicit.
- **Verified:** `src/server/terminal/home.ts` currently derives launch `resourceId` from multiplexer session output, omitting emulator spawn targets. Phase 5 owns a proven launch identity correction and its persistence/restore consumers together.
- **Verified:** emulator inventory failures can produce empty lists, and `homeAlive` consumes lists as absence. Phase 5 is the first owner of any shared availability contract. It must migrate all affected consumers atomically, including adapters whose live verification belongs to later phases. Later phases reuse this contract, not parallel booleans or eviction paths.
- **Verified:** WezTerm target operations use numeric pane IDs; the report proves reuse across private native mux restart. Phase 6 owns incarnation validation if the current route remains vulnerable, without restoring inherited stale socket routing.
- **Verified:** cmux still suppresses TTYs in multi-surface workspaces. Three initialized layouts on 0.64.22 are insufficient evidence to remove the guard. Phase 7 requires stronger live attribution evidence before changing it.
- **Unverified by design:** any candidate's continued existence at phase start. Fresh manual reproduction is the gate for each fix. No unconfirmed architecture assumption is used to authorize a repair. Claims verdict: CLEAR.

## Cross-phase contracts

1. Keep target identity separate from mutable display names. Missing or legacy identity must preserve resources or require explicit verification, never select a replacement by title/ref/prefix.
2. Ordinary Kill must preserve unowned siblings even during topology changes. Keep the existing single eviction owner and durable `session_remove` semantics; transient `exited` does not prove cleanup.
3. Use existing registries and capability interfaces. Actions own write policy; terminal adapters own backend mechanisms. Keep Node-only logic out of `src/shared`.
4. Phase 2 owns common Herdr/process correlation; Phase 3 owns canonical local-path creation verification; Phase 5 owns emulator launch identity and any shared unavailable-inventory contract; Phase 6 owns WezTerm incarnation safety. Backend-specific consumers may extend these only compatibly.
5. Persisted task fields and append-only IDs remain compatible. If a proven fix requires a migration, put the schema upgrade and all consumers/tests in that same phase. Prefer existing fields where they suffice; do not prescribe a speculative migration.
6. Tests, UI Playwright coverage, documentation and evidence belong to the phase changing behavior. There is no final cleanup phase needed to make earlier merges operable.

## Verification and publication

Every task manually repeats its report's minimal native scenario, with fresh nonces on all expected survivors and negative controls. Use isolated state, sockets and test-owned resources; fake Claude/Codex/Pi processes avoid model calls. Repeat deterministic candidates in fresh fixtures and timing-sensitive candidates in bounded repeated trials, recording counts and scheduling. A blocked probe is not a pass and injected faults alone do not prove natural occurrence.

Use the exact focused-test invocation in `AGENTS.md`. Each phase names relevant test files. Run `npm run typecheck` and `npm run lint` for changes; build and smoke when runtime/build surfaces change, and required Playwright coverage for UI behavior. Complete the selected No-Mistakes workflow. During CI or reviewer repair, use focused checks before pushing rather than rerunning the full suite, and keep resolving conflicts and monitoring CI.

Reports, screenshots and transcripts stay uncommitted. Attach proof to a resulting PR and provide live artifacts to workflow reviewers. No global terminal preferences, operator SQLite, shared application restart or unrelated session cleanup is authorized. The cmux missing-baseline-window limitation is not a diagnosed product defect.

Before creating tasks, commit and push every plan pointer and verify it in the pushed commit. Create each task with the planning dependency, set and verify its model/effort/workflow/disabled fields, then create its successor. Refresh publication ownership after scheduling and immediately before any direct PR action. Only the operator may merge the planning PR under this task's authorization.

## Scheduled task map

All eight tasks were created after artifact commit `8671cb83d0179a4c6f5d0a80d24360e28a333ad3` was pushed and all twelve artifact paths were verified in that remote branch. Each task was read back from the daemon after configuration. Every task is a disabled ship task using Codex `gpt-6-astra`, `xhigh`, and `builtin-workflow:no-mistakes-review` in Mission Control only. No phase has been dispatched.

Every row also depends directly on planning task `52df02cc-50da-4fc0-a32f-2f20c745e458`; all dependency edges were unsatisfied at creation.

| Phase | Task ID | Direct preceding phase task |
| --- | --- | --- |
| 1 | `0e168404-0216-43a5-9466-7d046c301528` | None |
| 2 | `b9cb6fa0-a10c-46a0-b957-6061e2daa3f5` | `0e168404-0216-43a5-9466-7d046c301528` |
| 3 | `357130a1-8ff6-40ab-b198-1204d6725ec2` | `b9cb6fa0-a10c-46a0-b957-6061e2daa3f5` |
| 4 | `e0857704-a887-47d8-ac66-be0df89e6474` | `357130a1-8ff6-40ab-b198-1204d6725ec2` |
| 5 | `e21ceb15-2328-4ad0-abb1-f6ab290c15f4` | `e0857704-a887-47d8-ac66-be0df89e6474` |
| 6 | `c6b7a972-3c46-4b1d-887c-07f7c38fc44f` | `e21ceb15-2328-4ad0-abb1-f6ab290c15f4` |
| 7 | `98cdfba1-b042-463e-a045-b35ab15c0e61` | `c6b7a972-3c46-4b1d-887c-07f7c38fc44f` |
| 8 | `d016f75e-6fe8-412d-b4dc-517b38f87773` | `98cdfba1-b042-463e-a045-b35ab15c0e61` |

## Cross-phase audit record

- Approved source requirements map once to eight source scouts. The original tmux scout remains included for verification despite its merged fix; iTerm2 remains included by explicit instruction despite unconfirmed product attribution.
- The operator's one-per-scout and serial requirements override generic phase minimization and parallelization defaults.
- Common contracts have a single earliest owner. Backend-specific phases verify inherited fixes instead of duplicating them. Every proposed API/storage change includes its consumers in the same merge unit.
- Per-phase reconciliation records are appended as guides are written. Final audit and verified task map are required before publication is complete.

- Phase 1 reconciliation: Phase 1 preserves the merged tmux repair as the baseline. Later Herdr and cmux phases must consume its Kill/cleanup contract and revalidate their own backend paths, not restore title-based teardown. No prior phase contract conflicts exist.

- Phase 2 reconciliation: Compared with Phase 1: preserve exact resource cleanup and conservative Kill; no reintroduction of name authority. Shared Herdr/process correlation is owned here, while later host phases supply independent verification and residual fixes.

- Phase 3 reconciliation: Compared with Phases 1–2: no overlapping cleanup or correlation implementation. Canonical-path validation is owned here, with all client consumers kept operable in this merge. Standalone Ghostty uncertainty remains assigned to Phase 5.

- Phase 4 reconciliation: Compared with Phases 1–3: this phase consumes shared contracts and owns only residual integration fixes and the independent reclaim matrix. It does not alter standalone emulator identity before its Phase 5 owner.

- Phase 5 reconciliation: Compared with Phases 1–4: preserve exact PID correlation and identity-based cleanup. Any shared availability or spawn-result change is owned wholly here, with all compile/runtime consumers migrated before merge. This avoids competing Ghostty/iTerm liveness patches and leaves WezTerm incarnation policy to Phase 6.

- Phase 6 reconciliation: Compared with Phases 1–5: WezTerm incarnation safety extends existing target ownership and Phase 5 availability semantics; it does not create a parallel liveness source or undo socket scrubbing. All affected target consumers remain operable at this phase's merge.

- Phase 7 reconciliation: Compared with Phases 1–6: cmux consumes exact cleanup, conservative group Kill and shared target/availability contracts. Native topology and split attribution are the distinct verification scope here; no parallel identity store or optimistic TTY join is introduced.

- Phase 8 reconciliation: Compared with Phases 1–7: standalone iTerm2 consumes existing exact identity, spawn and unknown-inventory contracts. Its explicit inclusion does not promote unresolved symptoms into confirmed bugs. No final catch-all repair is required for earlier phases to operate.

- Final audit: all eight scout IDs map to exactly one phase; every phase carries latest-main manual reproduction, conditional regression/fix, requested execution settings, publication gate and disabled-state instructions. Direct edges form one acyclic chain. Shared API consumers land with their earliest owner; no dangling source/test/phase pointers or deferred compatibility repair were found. Probe/design steps now explicitly precede regression and implementation. Blocked reproduction cannot be treated as no-change acceptance.

- Publication base refresh: the planning branch was fast-forwarded to `e76d21ac` before artifact publication. The intervening changes concern Foreman error display and task-source deletion; the inspected terminal lifecycle paths and phase ownership remain unchanged.

- Scheduling audit: eight returned task IDs, eight disabled-state/model/effort/workflow readbacks, eight planning edges and seven predecessor edges verified. Canonical repository is Mission Control with no additional repositories. All tasks remain in backlog.
