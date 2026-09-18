# Phase 7: cmux workspace identity and sibling safety

Source: [approved plan](plan.md), [phase index](phased-plan.md). Repository: Mission Control only. This is one ship task for one scout, using Codex `gpt-6-astra`, `xhigh`, and No-Mistakes Review (`builtin-workflow:no-mistakes-review`). It starts disabled; do not enable this or another task automatically.

## Outcome and scope

Verify that current cmux task cleanup and Kill preserve independent workspaces/surfaces, including a surface joining during a discovery gap; fix reproduced residuals and evaluate split attribution without weakening identity safety.

Non-goals: Attributing the missing baseline window to Mission Control, claiming real TUI paste semantics from surrogate tests, removing the split guard after three successful layouts, or restarting the shared cmux app. Do not implement a speculative fix or change terminal applications themselves.

## Entry criteria and direct dependencies

- The planning task's PR has merged these plan paths to `main`.
- Direct phase prerequisite: Phase 6, merged or explicitly accepted by the operator as a verified no-change completion. The planning task is also a direct dependency. No concurrent phase execution is allowed.
- Before **any reproduction**, pull latest `main` into the task branch, resolve conflicts, rebuild the code used by the probe, and record the exact tested SHA. Refresh again after a long pause or a newly merged prerequisite. Do not silently use the installed app's older daemon.
- Read `AGENTS.md`, repository memory, architecture/change contracts and the approved plan. Apply the debugging skill if a failure reproduces. Inspect existing changes and preserve unrelated work.

## Source evidence and bounded findings

Original scout task: `dde7015b-7926-4532-88b4-a7aeaf173f9d`. Original report: `docs/reports/cmux-lifecycle/report.html` in that scout's checkout. Archive key: `00c8ce79-080f-4d86-adb5-d791465c73e1~4e7b8456-f92e-4dbb-84c9-990002ac4edc`; primary artifact `report`. The final archive was verified complete before scheduling.

On unchanged `31c638e4` with cmux 0.64.22, Cancel closed an independent equal-title workspace in 3/3 fake Claude/Codex/Pi tasks. In 20/20 fresh fixtures, moving external agent B into A's workspace after discovery and immediately calling A's real Kill route closed B, inside the normal 1500ms poll interval. Waiting for discovery to clear shared-workspace handles preserved B. Ref-shaped stale-title cleanup and renamed-home false absence each reproduced 3/3 at helper level. Three initialized manual splits exposed correct distinct TTYs but Mission Control still suppressed both handles; that does not establish general attribution safety. Stale UUID/prefix control passed 20/20; 12/12 surrogate paste bodies arrived once. Cancel's separate process-metadata worktree-release refusal occurred after collateral closure. The original non-test cmux window was missing at final audit with no established cause; 177 fixture UUIDs were absent, but full baseline preservation was not proved. App quit/relaunch and GUI-click defect replay were not performed.

These are verified report contents, not fresh reproductions on phase-start `main`. Retrieve archived companions through Mission Control's Library/archive API. If an original fixture cannot be retrieved, reconstruct it from the procedure below and disclose the missing evidence. Never commit `report.html` or raw proof.

## Repository findings and inherited contracts

PR #1085 and Phases 1–4 may already fix broad group Kill and title-based cleanup. Recheck current `actions.ts`, `terminal/home.ts`, `dispatcher.ts`, `tasks.ts` and `terminal/cmux.ts`. Keep UUID targeting, environment target-selector scrubbing and conservative split attribution. Use Phase 5 availability semantics and Phase 6 target-contract changes where applicable; do not create cmux-specific alternate ownership state.

Keep actions as write-policy owner, terminal adapters as mechanisms, and registries as the capability source. `Registry.beginEviction` remains the sole durable removal path; transient `exited` is not cleanup authority. Preserve legacy/unknown target identities without name-based destructive fallback. No new parallel inventory or eviction path.

## Execution sequence

Steps 2–5 establish evidence and design a correction only. Do not change production behavior until Step 6 has established the failing regression where feasible.

1. Establish the fresh-main baseline and native application/backend versions. Use a private daemon, temporary state/repository/socket where supported, harmless fake agents, and an exact allowlist of fixture PIDs/start times and terminal IDs. Inventory unrelated resources before and after each bounded native batch. Do not restart shared applications or close unrelated sessions.
2. Read the archive's rerun instructions, `core.test.ts`, daemon drivers, shared-race driver and source excerpts. Establish proven test-owned cmux workspaces/controller and exact allowlists. The installed app may enforce a single instance; `open -n` is not evidence of private isolation. Never quit the shared app.
3. Reproduce Cancel with equal-title independent peer, external rename, ref-shaped stale title and changed preference. Run at least three fresh fake-harness fixtures, assert UUID/resource identity, and prove every survivor accepts a fresh nonce. Distinguish terminal closure from a later worktree-release refusal.
4. Discover two independent agents, move B into A's group and immediately Kill A through the actual route. Run 20 bounded trials, recording timestamps; compare settled-discovery and exact-surface controls. Recheck renamed-home liveness. Investigate split attribution using installed capability/version plus unique live TTY/process evidence, including missing/ambiguous/initializing layouts.
5. Design repairs only for remaining proven identity/action-policy defects. A non-atomic fresh topology check alone cannot establish group-close safety. Propose split-guard refinement only with stronger attribution evidence; otherwise retain conservative refusal. Record unrelated-window inventory mismatches without attribution guesses.
6. If a defect is reproduced, add a focused failing regression where feasible before the fix, implement the smallest correction in existing owners, then repeat the native procedure and negative controls on the fixed build. Record failures/attempts, timeouts, tested SHA, expected versus actual behavior, and fresh acknowledgements from all expected survivors. An automation limitation needs an explicit reason and rerunnable manual proof.
7. Reconcile the phase's documentation and downstream contract with the actual implementation. The guide is a proposed route, not a specification: adapt to current code and record deviations and reasons in the PR. Only the approved outcome is fixed.

## Data, API and compatibility

Ordinary Kill cannot close a group containing unowned siblings, even when topology changes after discovery. UUIDs remain authoritative and titles/ref-like text remain labels. Preserve legitimate absent-UUID refusal/idempotence and unknown liveness. Split controls may return only when actual attribution is trustworthy; no optimistic fallback to current selection or cwd.

Do not rename persisted append-only IDs. If a proven fix needs a migration, ship its upgrade, consumers and compatibility tests together; otherwise retain existing storage. Keep Node-only logic out of `src/shared`. Unknown observations do not authorize worktree release.

## Tests and verification

Start with `test/cmux-adapter.test.ts`, `test/cmux-socket-control.test.ts`, `test/terminal-home.test.ts`, `test/dispatcher-cleanup.test.ts`, `test/correlate.test.ts` and real session-action route coverage. Add a focused Playwright spec for any dashboard Kill/Cancel defect fixed here; the old report's route driver is not browser coverage. Include stale snapshot, moved sibling, equal/ref-like title, rename and unavailable-inventory controls.

Run focused files with the exact invocation in `AGENTS.md`; its isolation setup is mandatory and must not be bypassed. A dashboard-visible behavior change or UI-reproduced bug requires a Playwright spec in `e2e/` using fake agents. Build before live runtime/E2E probes. Run `npm run typecheck`, `npm run lint`, and the required runtime/build/smoke/E2E checks for the actual change; complete the selected No-Mistakes workflow. During CI/reviewer repair use focused checks before pushing, resolve conflicts, and monitor CI. No paid model calls are needed.

## Merge and exit criteria

Every reported candidate is classified as reproduced-and-fixed, already fixed with fresh evidence, not reproduced within stated bounds, or blocked with the exact missing prerequisite. A blocked manual reproduction is not a verified repair. For changes, require failing-before/passing-after proof where feasible, repeated manual survivor checks, appropriate tests and a reviewable PR under the selected workflow. Attach uncommitted evidence to the PR and supply live evidence artifacts to workflow reviewers.

Blocked or unverified candidates are not eligible for no-change acceptance; resolve the missing prerequisite or obtain an explicit scope decision first. If no scoped change remains after bounded verification, report the tested SHA, attempts, controls, limits and relevant merged repair without inventing a patch or PR. Request operator completion with dependency satisfaction after evidence review; do not satisfy the edge yourself or treat ordinary done state as sufficient. A successor starts only after this phase's merge or that explicit no-change acceptance, and remains disabled until enabled by the operator.

## Downstream handoff

Phase 8 receives verified cmux consumers of the common ownership/availability contracts. Record which findings were already repaired on main, and keep the unresolved baseline-window disappearance and untested real-TUI/app-restart cells explicit. Do not assign them speculative fixes.

Keep every successor disabled and retain the serial dependency chain. Do not implement later scouts' live verification within this task, except cross-backend regressions needed to safely change a shared contract now.

## Cross-phase audit record

Compared with Phases 1–6: cmux consumes exact cleanup, conservative group Kill and shared target/availability contracts. Native topology and split attribution are the distinct verification scope here; no parallel identity store or optimistic TTY join is introduced.

The approved source, index and all earlier phase guides were reread during this reconciliation. Direct dependency direction is forward-only. Tests, migrations and documentation land with their owning behavior; no later phase is needed to make this merge operable.
