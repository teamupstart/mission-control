# Phase 5: Ghostty standalone identity and liveness

Source: [approved plan](plan.md), [phase index](phased-plan.md). Repository: Mission Control only. This is one ship task for one scout, using Codex `gpt-6-astra`, `xhigh`, and No-Mistakes Review (`builtin-workflow:no-mistakes-review`). It starts disabled; do not enable this or another task automatically.

## Outcome and scope

Prevent reproduced Ghostty wrong-pane input and false task death by preserving trustworthy target identity and distinguishing unavailable inventory from confirmed absence. Deliver each shared contract and all its consumers in this phase.

Non-goals: Assuming the diagnostic long-timeout replay proves the normal HTTP route, broad timeout increases without cause, premature-worktree-deletion claims, or implementing WezTerm incarnation policy. Do not implement a speculative fix or change terminal applications themselves.

## Entry criteria and direct dependencies

- The planning task's PR has merged these plan paths to `main`.
- Direct phase prerequisite: Phase 4, merged or explicitly accepted by the operator as a verified no-change completion. The planning task is also a direct dependency. No concurrent phase execution is allowed.
- Before **any reproduction**, pull latest `main` into the task branch, resolve conflicts, rebuild the code used by the probe, and record the exact tested SHA. Refresh again after a long pause or a newly merged prerequisite. Do not silently use the installed app's older daemon.
- Read `AGENTS.md`, repository memory, architecture/change contracts and the approved plan. Apply the debugging skill if a failure reproduces. Inspect existing changes and preserve unrelated work.

## Source evidence and bounded findings

Original scout task: `75f02860-ed15-4e38-a4e5-53f14fd8cf63`. Original report: `docs/reports/ghostty-lifecycle/report.html` in that scout's checkout. Archive key: `00c8ce79-080f-4d86-adb5-d791465c73e1~b9da4472-6671-42b8-896d-358b513955c4`; primary artifact `report`.

At `31c638e4`, shell OSC7 cwd A and agent child cwd B caused an unrelated pane with cwd B to be selected in 3/3 live correlation/action trials using a diagnostic 15-second inventory timeout; the ordinary HTTP mechanism replay was blocked by the normal 2.5-second timeout. Natural enumeration timed out in 20/20 polls with 15 surfaces while the same script with 15 seconds returned the same live IDs. `homeAlive` falsely returned absent for writable panes in 3/3 probes. Emulator spawn UUIDs were not retained: three Claude and one Codex task failed initial delivery; Pi launched via argv but lacked a handle, and three Pi tasks became falsely failed after a private daemon restart while agents still accepted input. No premature worktree deletion was established. Companions include `natural-cwd.test.ts`, `enumeration.ts`, `daemon.ts`, `restore-scout.ts`, `helpers.ts` and `faults.test.ts`.

These are verified report contents, not fresh reproductions on phase-start `main`. Retrieve archived companions through Mission Control's Library/archive API. If an original fixture cannot be retrieved, reconstruct it from the procedure below and disclose the missing evidence. Never commit `report.html` or raw proof.

## Repository findings and inherited contracts

Inspect `src/server/discovery/correlate.ts` and `pairUniquely`, `terminal/ghostty.ts` list/spawn, `terminal/home.ts` launch/liveness, `terminal/types.ts`, `terminal/enumerate.ts`, `shared/pane.ts`, `dispatcher.ts` and task persistence/restore. Phase 2's exact process correlation must remain valid. This phase is the earliest owner for a needed shared inventory-unknown result and emulator spawn target retention. Coordinate all affected adapters/callers in this merge; later phases verify native behavior, not repair an incomplete interface migration.

Keep actions as write-policy owner, terminal adapters as mechanisms, and registries as the capability source. `Registry.beginEviction` remains the sole durable removal path; transient `exited` is not cleanup authority. Preserve legacy/unknown target identities without name-based destructive fallback. No new parallel inventory or eviction path.

## Execution sequence

Steps 2–5 establish evidence and design a correction only. Do not change production behavior until Step 6 has established the failing regression where feasible.

1. Establish the fresh-main baseline and native application/backend versions. Use a private daemon, temporary state/repository/socket where supported, harmless fake agents, and an exact allowlist of fixture PIDs/start times and terminal IDs. Inventory unrelated resources before and after each bounded native batch. Do not restart shared applications or close unrelated sessions.
2. Build an isolated Ghostty/daemon fixture with shell cwd A, child cwd B, an unrelated pane at B and a separate control. Manually exercise current normal-route delivery, recording exactly which pane acknowledges the nonce. Keep diagnostic long-timeout trials labeled separately.
3. Repeat inventory at realistic surface counts, comparing normal polling with a diagnostic complete inventory and direct fresh input. Establish natural timeout, permission/refusal and malformed-result controls separately; prove whether current liveness/restore callers confuse unknown with absent.
4. Dispatch fake Claude/Codex/Pi agents, inspect returned spawn identity and persisted task resource, then restart only the private daemon. Verify readiness/delivery and live-task reconciliation, event ordering and retained worktrees.
5. For verified defects, design positive identity or conservative correlation refusal, preserved spawn identity through the existing pipeline, and one shared unavailable-inventory contract. Include every affected adapter and consumer in the correction, with compatibility tests.
6. If a defect is reproduced, add a focused failing regression where feasible before the fix, implement the smallest correction in existing owners, then repeat the native procedure and negative controls on the fixed build. Record failures/attempts, timeouts, tested SHA, expected versus actual behavior, and fresh acknowledgements from all expected survivors. An automation limitation needs an explicit reason and rerunnable manual proof.
7. Reconcile the phase's documentation and downstream contract with the actual implementation. The guide is a proposed route, not a specification: adapt to current code and record deviations and reasons in the PR. Only the approved outcome is fixed.

## Data, API and compatibility

A failed inventory is unknown; a successful empty inventory can establish absence only under the existing ownership rules. Preserve readable legacy task records and avoid guessing missing identities. Any change to terminal result types, task resource encoding or persistence must include existing adapter/dispatcher/restore consumers now. A protocol-visible state change needs exhaustive event and UI handling in the same phase.

Do not rename persisted append-only IDs. If a proven fix needs a migration, ship its upgrade, consumers and compatibility tests together; otherwise retain existing storage. Keep Node-only logic out of `src/shared`. Unknown observations do not authorize worktree release.

## Tests and verification

Use `test/terminal-ghostty.test.ts`, `test/correlate.test.ts`, `test/terminal-emulator-spawn.test.ts`, `test/terminal-enumerate.test.ts`, `test/terminal-home.test.ts`, `test/dispatcher-cleanup.test.ts` and `test/dispatcher-runtime.test.ts`. Extend `e2e/specs/dispatch-restart-recovery.spec.ts` or the relevant dispatch/conversation spec for visible delivery and task-state changes. Test old tasks, successful empty results, timeouts, malformed inventory, ambiguous panes and restart on the same resource.

Run focused files with the exact invocation in `AGENTS.md`; its isolation setup is mandatory and must not be bypassed. A dashboard-visible behavior change or UI-reproduced bug requires a Playwright spec in `e2e/` using fake agents. Build before live runtime/E2E probes. Run `npm run typecheck`, `npm run lint`, and the required runtime/build/smoke/E2E checks for the actual change; complete the selected No-Mistakes workflow. During CI/reviewer repair use focused checks before pushing, resolve conflicts, and monitor CI. No paid model calls are needed.

## Merge and exit criteria

Every reported candidate is classified as reproduced-and-fixed, already fixed with fresh evidence, not reproduced within stated bounds, or blocked with the exact missing prerequisite. A blocked manual reproduction is not a verified repair. For changes, require failing-before/passing-after proof where feasible, repeated manual survivor checks, appropriate tests and a reviewable PR under the selected workflow. Attach uncommitted evidence to the PR and supply live evidence artifacts to workflow reviewers.

Blocked or unverified candidates are not eligible for no-change acceptance; resolve the missing prerequisite or obtain an explicit scope decision first. If no scoped change remains after bounded verification, report the tested SHA, attempts, controls, limits and relevant merged repair without inventing a patch or PR. Request operator completion with dependency satisfaction after evidence review; do not satisfy the edge yourself or treat ordinary done state as sufficient. A successor starts only after this phase's merge or that explicit no-change acceptance, and remains disabled until enabled by the operator.

## Downstream handoff

Phase 6 may rely on preserved emulator launch identity and a single documented inventory availability contract. Phase 7 and Phase 8 must reuse it if their adapters participate. Document exact return-type/encoding/migration changes and negative controls; do not claim later backends' live safety from mocked cross-adapter checks.

Keep every successor disabled and retain the serial dependency chain. Do not implement later scouts' live verification within this task, except cross-backend regressions needed to safely change a shared contract now.

## Cross-phase audit record

Compared with Phases 1–4: preserve exact PID correlation and identity-based cleanup. Any shared availability or spawn-result change is owned wholly here, with all compile/runtime consumers migrated before merge. This avoids competing Ghostty/iTerm liveness patches and leaves WezTerm incarnation policy to Phase 6.

The approved source, index and all earlier phase guides were reread during this reconciliation. Direct dependency direction is forward-only. Tests, migrations and documentation land with their owning behavior; no later phase is needed to make this merge operable.
