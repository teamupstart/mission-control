# Phase 1: tmux shutdown and sibling safety

Source: [approved plan](plan.md), [phase index](phased-plan.md). Repository: Mission Control only. This is one ship task for one scout, using Codex `gpt-6-astra`, `xhigh`, and No-Mistakes Review (`builtin-workflow:no-mistakes-review`). It starts disabled; do not enable this or another task automatically.

## Outcome and scope

Verify that current Mission Control Kill preserves similarly named tmux sessions and independently owned sibling panes/windows, then fix only a reproducible residual from this scout. This task retains the required one-scout-to-one-task mapping even though PR #1085 has already landed a repair.

Non-goals: Reimplementing PR #1085, assigning a cause to the original operator incident, or changing other backend behavior without a shared regression requiring it. Do not implement a speculative fix or change terminal applications themselves.

## Entry criteria and direct dependencies

- The planning task's PR has merged these plan paths to `main`.
- Direct phase prerequisite: None. The planning task is also a direct dependency. No concurrent phase execution is allowed.
- Before **any reproduction**, pull latest `main` into the task branch, resolve conflicts, rebuild the code used by the probe, and record the exact tested SHA. Refresh again after a long pause or a newly merged prerequisite. Do not silently use the installed app's older daemon.
- Read `AGENTS.md`, repository memory, architecture/change contracts and the approved plan. Apply the debugging skill if a failure reproduces. Inspect existing changes and preserve unrelated work.

## Source evidence and bounded findings

Original scout task: `139a7232-2be7-492c-8d31-21a079eb8e0a`. Original report: `docs/reports/tmux-session-kill/report.html` in that scout's checkout. Archive key: `00c8ce79-080f-4d86-adb5-d791465c73e1~f4e95cfd-3350-49a7-a985-83a7a535aa63`; primary artifact `report`.

At `1cc9d41`, SIGTERM removed `work` before `kill-session -t work`; tmux selected the unique prefix peer `work-other`. The scout reproduced this 20/20 directly and 20/20 through the production wrapper. Closing the last two sessions explains the server's normal exit without a `kill-server` call. A separate shared-session case closed independent sibling panes/windows. Persistent-shell and side-pane controls prevented the first race, and exact targeting refused a missing target. The user's original incident was not conclusively attributed.

These are verified report contents, not fresh reproductions on phase-start `main`. Retrieve archived companions through Mission Control's Library/archive API. If an original fixture cannot be retrieved, reconstruct it from the procedure below and disclose the missing evidence. Never commit `report.html` or raw proof.

## Repository findings and inherited contracts

Planning baseline `7c009fe0` contains PR #1085 (`bb0dcf91`). Inspect `src/server/terminal/tmux-target.ts`, `tmux.ts`, `actions.ts`, `terminal/home.ts` and `dispatcher.ts`: exact server/session identity, `closeIfOnlyPane` and recorded resource cleanup now exist. Preserve those protections and the inherited socket scope; investigate current behavior before editing historical mechanisms.

Keep actions as write-policy owner, terminal adapters as mechanisms, and registries as the capability source. `Registry.beginEviction` remains the sole durable removal path; transient `exited` is not cleanup authority. Preserve legacy/unknown target identities without name-based destructive fallback. No new parallel inventory or eviction path.

## Execution sequence

Steps 2–5 establish evidence and design a correction only. Do not change production behavior until Step 6 has established the failing regression where feasible.

1. Establish the fresh-main baseline and native application/backend versions. Use a private daemon, temporary state/repository/socket where supported, harmless fake agents, and an exact allowlist of fixture PIDs/start times and terminal IDs. Inventory unrelated resources before and after each bounded native batch. Do not restart shared applications or close unrelated sessions.
2. Retrieve `reproduction.test.ts`, its TAP transcript and wrapper check from the archive. Rebuild a private tmux server with owner `work`, prefix peer `work-other`, and an unrelated control; use direct-exec and production-wrapper process shapes.
3. Force owner exit in the signal-to-teardown interval, run the real Kill route, and prove the peer accepts a fresh nonce. Repeat the timing case for 20 bounded trials; include absent exact target, persistent-shell and side-pane controls.
4. Place independent fake agents in separate panes and windows of one session, then Kill only one through the dashboard/route. Verify sibling input, unrelated controls and task/worktree state. Inspect current `closeIfOnlyPane` topology and generation refusal behavior.
5. If a scenario fails, isolate the owner and design the smallest residual correction in target parsing, incarnation checks, action policy or cleanup. Reuse the exact-target regression rather than adding another teardown path.
6. If a defect is reproduced, add a focused failing regression where feasible before the fix, implement the smallest correction in existing owners, then repeat the native procedure and negative controls on the fixed build. Record failures/attempts, timeouts, tested SHA, expected versus actual behavior, and fresh acknowledgements from all expected survivors. An automation limitation needs an explicit reason and rerunnable manual proof.
7. Reconcile the phase's documentation and downstream contract with the actual implementation. The guide is a proposed route, not a specification: adapt to current code and record deviations and reasons in the PR. Only the approved outcome is fixed.

## Data, API and compatibility

Retain opaque socket/server/session identity and existing persisted-resource decoding. A missing or replaced server/session cannot redirect cleanup. Do not broaden ordinary Kill into a group action. Old task records without adequate identity stay conservative.

Do not rename persisted append-only IDs. If a proven fix needs a migration, ship its upgrade, consumers and compatibility tests together; otherwise retain existing storage. Keep Node-only logic out of `src/shared`. Unknown observations do not authorize worktree release.

## Tests and verification

Start with `test/tmux-kill.test.ts`, `test/tmux-target.test.ts`, `test/terminal-home.test.ts` and `test/dispatcher-cleanup.test.ts`. Extend `e2e/specs/session-kill-tmux.spec.ts` for a residual dashboard Kill defect. The manual native trials remain required even when these existing tests pass.

Run focused files with the exact invocation in `AGENTS.md`; its isolation setup is mandatory and must not be bypassed. A dashboard-visible behavior change or UI-reproduced bug requires a Playwright spec in `e2e/` using fake agents. Build before live runtime/E2E probes. Run `npm run typecheck`, `npm run lint`, and the required runtime/build/smoke/E2E checks for the actual change; complete the selected No-Mistakes workflow. During CI/reviewer repair use focused checks before pushing, resolve conflicts, and monitor CI. No paid model calls are needed.

## Merge and exit criteria

Every reported candidate is classified as reproduced-and-fixed, already fixed with fresh evidence, not reproduced within stated bounds, or blocked with the exact missing prerequisite. A blocked manual reproduction is not a verified repair. For changes, require failing-before/passing-after proof where feasible, repeated manual survivor checks, appropriate tests and a reviewable PR under the selected workflow. Attach uncommitted evidence to the PR and supply live evidence artifacts to workflow reviewers.

Blocked or unverified candidates are not eligible for no-change acceptance; resolve the missing prerequisite or obtain an explicit scope decision first. If no scoped change remains after bounded verification, report the tested SHA, attempts, controls, limits and relevant merged repair without inventing a patch or PR. Request operator completion with dependency satisfaction after evidence review; do not satisfy the edge yourself or treat ordinary done state as sufficient. A successor starts only after this phase's merge or that explicit no-change acceptance, and remains disabled until enabled by the operator.

## Downstream handoff

Phase 2 may rely on the verified exact-resource cleanup and conservative Kill capability contract. Record whether all findings were already fixed by #1085, and identify any new residual repair by merged commit. No Herdr/cwd policy is introduced here.

Keep every successor disabled and retain the serial dependency chain. Do not implement later scouts' live verification within this task, except cross-backend regressions needed to safely change a shared contract now.

## Cross-phase audit record

Phase 1 preserves the merged tmux repair as the baseline. Later Herdr and cmux phases must consume its Kill/cleanup contract and revalidate their own backend paths, not restore title-based teardown. No prior phase contract conflicts exist.

The approved source, index and all earlier phase guides were reread during this reconciliation. Direct dependency direction is forward-only. Tests, migrations and documentation land with their owning behavior; no later phase is needed to make this merge operable.
