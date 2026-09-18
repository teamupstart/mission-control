# Terminal lifecycle scout follow-ups

Approved, 2026-09-18. Implementation repository: Mission Control. This task produces the plan and disabled backlog tasks; it does not implement terminal fixes.

## Outcome

Create one reproduction-first ship task for each of the eight recent terminal and multiplexer scouts below. Each task must manually verify its reported issues against the latest `main`, prove a verified defect with a failing regression test where feasible, fix it, and repeat the manual reproduction after the fix. A historical report establishes what the scout observed, not that the same bug still exists.

All unfinished scouts have now delivered their final reports; this completion gate was checked before scheduling. The operator explicitly included the unpublished standalone iTerm2 report and authorized continuing the existing cmux scout until finished.

## Fixed execution requirements

| Setting | Required value |
| --- | --- |
| Task kind | Ship |
| Agent and model | Codex, `gpt-6-astra` |
| Reasoning effort | Extra high, `xhigh` |
| Workflow | No-Mistakes Review High Rigor, `builtin-workflow:no-mistakes-review` |
| Backlog scheduling | Disabled, `enabled: false`, on every task |
| Dependencies | Every task depends on this planning task; tasks 2 through 8 also depend directly on the immediately preceding task |
| Parallel execution | None; the operator requested a serial chain |
| Starting code | Pull latest `main` into the task branch before any reproduction; resolve conflicts, build the code used for live probes, and record its exact SHA |
| Evidence | Manual reproduction first, focused failing test where feasible, fix, then repeat both; use fake agent processes rather than paid model calls |

Disabling is independent of dependencies. Merging the plan or a predecessor must not enable any task. The operator controls when to enable the next eligible task. Keep all work in Mission Control and use the requested workflow for any resulting repair.

## Scout coverage and proposed order

The order keeps shared Herdr work together, then addresses standalone emulators and cmux. Every row becomes one task, even where several scouts found the same shared defect. Later tasks revalidate merged fixes and repair only residual failures.

| Phase | Scout | Reported finding and verification scope |
| --- | --- | --- |
| 1 | tmux shutdown | Prefix-target race killed a similarly named session after the original exited; killing an agent could close sibling panes. Verify the repair already merged in PR #1085 and fix only a reproduced residual. |
| 2 | Herdr in WezTerm | Shared-workspace Kill, same-title replacement closed by task cleanup, and direct-exec agent missing its terminal handle. Own any still-needed shared Herdr/process-correlation repair. |
| 3 | Herdr in Ghostty | Recheck the shared findings after Phase 2. Also reproduce equivalent `/var` and `/private/var` cwd values causing creation to report an unknown outcome. Own canonical-path handling if still defective. |
| 4 | Herdr in iTerm2 | Recheck Kill, cancel/reclaim replacement safety across all three fake harnesses, and direct-exec discovery. Fix only host-specific or residual defects. |
| 5 | Ghostty standalone | Wrong-pane correlation when shell and child cwd disagree; inventory timeouts treated as absence; launch identity lost and live tasks failed after daemon restart. Own any required shared distinction between unavailable inventory and confirmed absence. |
| 6 | WezTerm standalone | Native mux server restart reused a numeric pane ID; stale direct workflow send reached its replacement. Verify server-incarnation identity at the write boundary. Normal GUI close/recreate wrong-recipient behavior remains an unconfirmed lead. |
| 7 | cmux lifecycle | Cancel closed an equal-title peer (3/3); Kill during a normal discovery gap closed a newly joined sibling (20/20). Recheck renamed-home false absence and the installed-version split guard. Verify prior identity/Kill repairs before changing anything. |
| 8 | iTerm2 standalone | Explicit operator inclusion: fresh panes sometimes failed input/readiness checks and failed enumeration could look like absence. The report did not establish a Mission Control defect; reproduce from clean, isolated state and fix only if verified. |

## Evidence sources

Reports and raw proof remain outside this commit. Each phase will carry a self-contained synopsis, source task ID, report path, and archive locator where available, so an implementing agent does not need the planning conversation. Resolve an archive through Mission Control's archive API or Library; a local original scout checkout is a fallback, not a default-branch dependency.

Archive producer for the published reports is `00c8ce79-080f-4d86-adb5-d791465c73e1`. Combine it with the archive ID using `~` for the archive API key. The primary artifact is `report`.

| Scout | Source task | Report path in its scout checkout | Archive ID |
| --- | --- | --- | --- |
| tmux | `139a7232-2be7-492c-8d31-21a079eb8e0a` | `docs/reports/tmux-session-kill/report.html` | `f4e95cfd-3350-49a7-a985-83a7a535aa63` |
| Herdr / WezTerm | `c0e5ef01-0f5a-4c33-9109-9860711fbe54` | `docs/reports/herdr-wezterm-lifecycle/report.html` | `46695d7a-4d9f-4405-8d57-d0133504340b` |
| Herdr / Ghostty | `c0a120ff-0967-49de-b75c-61d4f4b4119b` | `docs/reports/herdr-ghostty-lifecycle/report.html` | `06943904-199f-4d18-b047-8d986a2f05a6` |
| Herdr / iTerm2 | `e45b3e53-db0d-4349-ab10-9b481fc360af` | `docs/reports/herdr-iterm-lifecycle/report.html` | `b05a4a73-a883-47b6-a42b-5617b2604c17` |
| Ghostty | `75f02860-ed15-4e38-a4e5-53f14fd8cf63` | `docs/reports/ghostty-lifecycle/report.html` | `b9da4472-6671-42b8-896d-358b513955c4` |
| WezTerm | `a4ce2978-5874-4170-9971-a451f9045929` | `docs/reports/wezterm-lifecycle/report.html` | `0a56e666-c71a-4a14-b78e-6ca91be4f4b6` |
| cmux | `dde7015b-7926-4532-88b4-a7aeaf173f9d` | `docs/reports/cmux-lifecycle/report.html` | `4e7b8456-f92e-4dbb-84c9-990002ac4edc` |
| iTerm2 | `57cc2c5c-856f-489c-82d7-590ce1968139` | `docs/reports/iterm-lifecycle/report.html` | Unpublished, explicitly included |

The standalone iTerm2 source is the operator-provided file in the worktree identified by its source task ID. Its report SHA-256 is `4dd0fa231587e55285e4647fb2d3b01024c499288f955ed72cf38acc4df58065`. Missing archive publication does not exclude it. If the old checkout disappears, use the phase synopsis to reconstruct the probe and disclose the unavailable original evidence.

Older interrupt and launch-hook scouts outside this recent sibling investigation are excluded; they have separate repair history. No new scout tasks are created.

The cmux report also records an unresolved isolation limitation: the original non-test window was absent at the final audit, with no established cause. Fixture cleanup was checked, but full baseline preservation was not proved. Its follow-up must inventory unrelated resources before and after each bounded native batch, and must not claim the missing window was caused by either reproduced defect.

## Reproduction and repair contract

1. Pull current `main` before reproducing. Do this again after any long pause or newly merged prerequisite. Preserve unrelated changes and resolve conflicts before running probes. Record the merge base, tested commit, terminal versions, relevant configuration, and whether a rebuilt private daemon was used.
2. Read the source report and separate confirmed observations, injected faults, and unconfirmed leads. Run native terminal/multiplexer probes with private state, sockets, workspaces and fake agents. A unit test alone is not manual confirmation. Verify target and sibling identities, received bytes, process liveness and worktree retention as appropriate.
3. If it reproduces, record expected versus actual behavior and establish the responsible component before editing. Create a focused regression that fails before the fix and passes after it when practical. A bug reproduced through the dashboard requires a Playwright spec under repository rules. If automation is infeasible, document the limitation and preserve a repeatable manual procedure.
4. Fix within existing owners: actions own write policy, terminal adapters own mechanisms, registries own capabilities, and `Registry.beginEviction` remains the sole durable session-removal path. Preserve unknown liveness rather than turning a failed inventory into confirmed absence. Mutable titles and positional IDs do not authorize destructive cleanup or redirected writes.
5. Repeat the native reproduction and negative controls after the fix. Run focused tests and repository-required checks proportional to the actual change, and complete the selected workflow and PR checks. Keep screenshots, transcripts and `report.html` out of commits; attach evidence to the PR and expose required live evidence to workflow reviewers.

An already-fixed or unreproduced issue does not justify a speculative patch. The task must record the tested current SHA, bounded attempts, negative controls and any relevant merged repair. If no scoped change remains, provide the verification result without a fabricated PR. An operator must explicitly complete a verified no-change task with dependency satisfaction before its successor can become eligible. A normal done state alone is not a substitute for the merge/dependency gate.

No task may restart a shared terminal application or close unrelated sessions to improve its reproduction. Prefer isolated application/server instances. A shared application restart that affects the operator's existing panes requires explicit approval at that time.

## Publication and scheduling

After approval, write `phased-plan.md`, its HTML rendering, and eight detailed phase files beside this source. Audit compatibility in dependency order, commit and push those files, and verify every task pointer in that pushed commit before creating any task.

Create tasks in order with the current planning session as a prerequisite. Immediately set and verify the requested model, effort, workflow and disabled state before creating its successor. The unsatisfied planning dependency protects each newly created task while its settings are applied. Record the returned task IDs and direct edges in the implementation index.

Refresh Mission Control publication ownership before any planning PR work. With a workflow owner, hand off to that workflow. With skill ownership, open and verify the scoped planning PR; the operator retains merge control. Every phase path must reach `main` through that planning PR before a phase can start. Even then all tasks stay disabled until the operator enables them.

## Claims and uncertainty ledger

- **Verified:** the operator requested one task per reporting scout, serial dependencies, Astra extra-high effort, No-Mistakes workflow, latest-main reproduction and disabled backlog entries. Standalone iTerm2 was explicitly added.
- **Verified:** the completed source reports support the historical observations above; their limitations are retained. The cmux report is complete and its archived primary artifact matches the final local report; all eight reports have been reviewed.
- **Verified:** the inspected planning baseline is `7c009fe0`. PR #1085 is merged and introduced exact tmux targeting, conservative shared-session Kill and identity-based cleanup. This makes current reproduction necessary before duplicating repairs.
- **Verified by code inspection:** `ancestorDistances` currently excludes the root process, Herdr create verification compares cwd strings directly, and emulator launch results currently omit their returned target from `resourceId`. These are investigation entry points, not fresh proof of user-visible bugs.
- **Unverified by design:** which historical bugs survive future phase-start `main`. No fix or architecture choice is authorized on that assumption; each task must confirm it through manual reproduction.
- **Non-binding estimate:** repair size depends on fresh reproductions and will be bounded in the phase index. It changes scheduling estimates, not permission to invent defects.

Verdict: no unconfirmed assumption authorizes implementation. The final scout completion gate is satisfied. The operator approved the plan and phased implementation follow-up on 2026-09-18. Verdict: CLEAR.

## Review

The operator submitted **Approve plan** for the eight-scout coverage, serial order and reproduction-first contract, and **Create phased implementation plan** for the implementation follow-up on 2026-09-18. These are adopted requirements. The [implementation index](phased-plan.md) records phase files and scheduled task IDs; its [rendered page](phased-plan.html) is the implementation handoff.
