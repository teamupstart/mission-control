# Task worktree return

## Agreed behavior

Final task completion resets each task-owned checkout and returns its lease to the pool. The initial agent handoff to a shipping workflow is not final task completion and keeps its checkout. Completion authorizes discarding residual local changes after required archives are captured.

Kill requests keep their current prompt response and task outcome. After the session has actually left, an automatic return is allowed only when every attached checkout has no staged, unstaged, or untracked work, no unpublished commits, and no process still using it. Unknown evidence preserves the checkout. Otherwise the existing 30-day retention and manual Worktree Settings reconciliation remain available. A clean Reset followed by Kill qualifies even though Reset clears the task/session binding.

Reset and Cancel retain their existing behavior. Assigned sessions without task-owned worktrees are outside automatic pool return. Quarantine remains a safety hold, not an available pool slot; failed native resets continue to quarantine through the allocator.

## Lifecycle and ownership

The Complete UI or final workflow/merge completion reaches TaskManager's existing completion boundary. TaskManager records done synchronously and, for owned worktrees with a session, records the existing durable session-closure obligation in the same transaction. Registry remains the sole session-removal authority. After observed removal and runtime shutdown, TaskManager queues archive capture and provider-aware teardown. The native allocator checks the exact lease and ownership, resets, verifies the result, and marks the slot available. A failed or uncertain return preserves the unreleased resource records.

The Kill route captures the exact task resource identity before requesting stop. An accepted request installs a conditional cleanup intent; a refused request installs none. Registry removal consumes it. Reset-detached owners are found by exact recorded checkout path, including secondary repositories, with ambiguous ownership refused. A daemon restart may lose this best-effort Kill optimization, in which case existing retention remains the safe fallback. Completion recovery is durable and resumes after initial session discovery.

Background return uses the existing repository cleanup queue. Read-only eligibility checks run outside the task reservation so a refused safe-Kill attempt cannot block manual Clean up. The reservation protects archive capture and destructive return. It rereads task attempt, ordered repository paths, providers and leases after awaits, refuses another live session, checks all checkout occupants, and captures scout/ensemble archives before teardown. Kill additionally fetches origin refs and checks clean status and commit reachability, failing closed on errors. A guard is repeated at each provider's destructive boundary; the native allocator repeats it after its own fetch under its slot lock. Successful partial returns clear only those resources. Shutdown waits for queued cleanup before stopping the allocator.

## Implementation sequence

1. Add and test a bounded Git safety probe for clean status and commits reachable from freshly fetched origin refs. Include malformed/error responses, untracked files and local commits.
2. Add guarded teardown support to the existing provider path and native allocator. Keep manual cleanup, Cancel, Reset and retention defaults unchanged.
3. Connect final completion to durable closure and queued return. Connect accepted Kill to a conditional return after durable removal. Cover stopped runtimes, ownership changes, attached-only worktrees, reset-detached owners, archives and partial failures.
4. Update Complete, Kill and shipping-setting explanations to match the lifecycle. Preserve prompt Complete/Kill response while SDK teardown drains. Update product and lifecycle documentation.
5. Add focused unit/integration and browser tests, run typecheck, lint, build, smoke and affected Playwright specs. Capture rendered evidence and register focused results through Mission Control. No commit, push or pull request during this task turn.

## Acceptance and verification

| ID | Observable result | Proof |
| --- | --- | --- |
| complete-return | Final completion closes its owned session, archives required output, resets and makes every returned native slot reusable | Task lifecycle and real allocator tests; browser Complete and reuse |
| handoff-retains | Initial agent/workflow handoff retains its task resources | Existing prompted-completion/workflow tests |
| kill-safe-return | Accepted Kill returns clean, published, unoccupied checkouts after removal, including Reset then Kill | Git safety and lifecycle tests; browser Reset/Kill |
| kill-preserves | Dirty, untracked, unpublished, occupied, unknown, stale or refused-stop cases retain resources and existing retention | Negative lifecycle/Git tests and retained-worktree browser checks |
| lifecycle-compatibility | Reset, Cancel, archive refusal, multi-repo partial failure and quarantine remain safe | Existing focused regressions plus new cases |
| interface | Dialogs and settings accurately explain automatic return without waiting for SDK drain | Render assertions and Playwright |

## Limits and recovery

Git and process inspection are observations, not an operating-system lock against an unrelated process starting at the final instant. Existing allocator occupancy checks plus a repeated final guard narrow this window. Unknown inspection or failed provider reset never makes a slot available. Completion retry uses discovery and the existing durable closure/resource records; unsafe Kill attempts fall back to 30-day retention. The implementation adds no new session eviction path, database writer, provider, or cleanup scheduler.
