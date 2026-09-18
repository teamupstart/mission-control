# Phase 2: Herdr in WezTerm lifecycle

Source: [approved plan](plan.md), [phase index](phased-plan.md). Repository: Mission Control only. This is one ship task for one scout, using Codex `gpt-6-astra`, `xhigh`, and No-Mistakes Review (`builtin-workflow:no-mistakes-review`). It starts disabled; do not enable this or another task automatically.

## Outcome and scope

Make the scout's Herdr-in-WezTerm Kill, task cleanup and direct-exec discovery cases safe on current main. Own any still-needed shared Herdr/process-correlation repair so the next two host-specific tasks can verify it without duplicating it.

Non-goals: Standalone WezTerm numeric-ID restart behavior, Ghostty path canonicalization, or unproven general terminal redesign. Do not implement a speculative fix or change terminal applications themselves.

## Entry criteria and direct dependencies

- The planning task's PR has merged these plan paths to `main`.
- Direct phase prerequisite: Phase 1, merged or explicitly accepted by the operator as a verified no-change completion. The planning task is also a direct dependency. No concurrent phase execution is allowed.
- Before **any reproduction**, pull latest `main` into the task branch, resolve conflicts, rebuild the code used by the probe, and record the exact tested SHA. Refresh again after a long pause or a newly merged prerequisite. Do not silently use the installed app's older daemon.
- Read `AGENTS.md`, repository memory, architecture/change contracts and the approved plan. Apply the debugging skill if a failure reproduces. Inspect existing changes and preserve unrelated work.

## Source evidence and bounded findings

Original scout task: `c0e5ef01-0f5a-4c33-9109-9860711fbe54`. Original report: `docs/reports/herdr-wezterm-lifecycle/report.html` in that scout's checkout. Archive key: `00c8ce79-080f-4d86-adb5-d791465c73e1~46695d7a-4d9f-4405-8d57-d0133504340b`; primary artifact `report`.

On `31c638e4`, shared-workspace Kill closed independent siblings in 3/3 adapter and 3/3 route checks. Cancel after renaming owner A and creating B under the old title closed B in 3/3 cases across the fake harnesses; helper replacement checks also failed 3/3. An exec-replaced shell agent lost its terminal handle and Focus returned HTTP 500 in 3/3 routes. Twenty stable-ID launch/close trials preserved prefix peers. Companion drivers include `reproduction.test.ts`, `fixture.ts`, `edges.test.ts`, `supplement.test.ts` and `daemon-gui.ts`.

These are verified report contents, not fresh reproductions on phase-start `main`. Retrieve archived companions through Mission Control's Library/archive API. If an original fixture cannot be retrieved, reconstruct it from the procedure below and disclose the missing evidence. Never commit `report.html` or raw proof.

## Repository findings and inherited contracts

Phase 1 and #1085 may already repair broad Kill/title cleanup. At the planning baseline Herdr exposes no `closeIfOnlyPane`, so current actions conservatively signal only. `src/server/discovery/correlate.ts` still builds ancestor distances from parents, excluding the root PID; inspect the actual `panePid` join before changing it. Trace `terminal/herdr.ts`, `herdr-client.ts`, `home.ts`, `actions.ts` and dispatcher cleanup. This phase owns shared direct-exec correlation; Phase 3 owns equivalent cwd verification.

Keep actions as write-policy owner, terminal adapters as mechanisms, and registries as the capability source. `Registry.beginEviction` remains the sole durable removal path; transient `exited` is not cleanup authority. Preserve legacy/unknown target identities without name-based destructive fallback. No new parallel inventory or eviction path.

## Execution sequence

Steps 2–5 establish evidence and design a correction only. Do not change production behavior until Step 6 has established the failing regression where feasible.

1. Establish the fresh-main baseline and native application/backend versions. Use a private daemon, temporary state/repository/socket where supported, harmless fake agents, and an exact allowlist of fixture PIDs/start times and terminal IDs. Inventory unrelated resources before and after each bounded native batch. Do not restart shared applications or close unrelated sessions.
2. Reconstruct a private Herdr server and daemon whose production adapter actually targets that server; do not assume a named server selector survives environment scrubbing. Attach owned WezTerm clients, assert real Herdr handles and task resource IDs, and create fake Claude/Codex/Pi fixtures.
3. Manually repeat shared-workspace Kill and rename/replacement Cancel through real routes with fresh nonces on every survivor. Repeat deterministic failures in at least three fresh fixtures and include unchanged-preference versus changed-preference cleanup controls.
4. Launch an agent by replacing its shell with `exec`, prove the agent PID equals the pane root PID, and exercise discovery, Focus and input. Compare with an agent under a persistent shell and an ambiguous/unrelated PID control.
5. For a confirmed discovery defect, design the exact PID/ancestry correction with cycle and ambiguity checks. For a surviving cleanup defect, design a correction to recorded-identity routing that preserves Phase 1. Matching cwd or display name cannot establish ownership.
6. If a defect is reproduced, add a focused failing regression where feasible before the fix, implement the smallest correction in existing owners, then repeat the native procedure and negative controls on the fixed build. Record failures/attempts, timeouts, tested SHA, expected versus actual behavior, and fresh acknowledgements from all expected survivors. An automation limitation needs an explicit reason and rerunnable manual proof.
7. Reconcile the phase's documentation and downstream contract with the actual implementation. The guide is a proposed route, not a specification: adapt to current code and record deviations and reasons in the PR. Only the approved outcome is fixed.

## Data, API and compatibility

Exact root-process identity may be considered only with the same trust and uniqueness checks as existing ancestors. Preserve innermost target routing and outer-host Focus composition. Shared fixes must include affected backend consumers in this phase; no temporary breakage is delegated to Phase 3 or 4.

Do not rename persisted append-only IDs. If a proven fix needs a migration, ship its upgrade, consumers and compatibility tests together; otherwise retain existing storage. Keep Node-only logic out of `src/shared`. Unknown observations do not authorize worktree release.

## Tests and verification

Use `test/correlate.test.ts`, `test/pipeline-correlation.test.ts`, `test/herdr-adapter.test.ts`, `test/terminal-home.test.ts`, `test/dispatcher-cleanup.test.ts` and `test/multiplexer-focus-terminal-route.test.ts` as applicable. Extend `e2e/specs/herdr-multiplexer.spec.ts` for changed dashboard behavior. Cover root-PID equality, ancestry cycles, ambiguous candidates and absent process metadata alongside the live replay.

Run focused files with the exact invocation in `AGENTS.md`; its isolation setup is mandatory and must not be bypassed. A dashboard-visible behavior change or UI-reproduced bug requires a Playwright spec in `e2e/` using fake agents. Build before live runtime/E2E probes. Run `npm run typecheck`, `npm run lint`, and the required runtime/build/smoke/E2E checks for the actual change; complete the selected No-Mistakes workflow. During CI/reviewer repair use focused checks before pushing, resolve conflicts, and monitor CI. No paid model calls are needed.

## Merge and exit criteria

Every reported candidate is classified as reproduced-and-fixed, already fixed with fresh evidence, not reproduced within stated bounds, or blocked with the exact missing prerequisite. A blocked manual reproduction is not a verified repair. For changes, require failing-before/passing-after proof where feasible, repeated manual survivor checks, appropriate tests and a reviewable PR under the selected workflow. Attach uncommitted evidence to the PR and supply live evidence artifacts to workflow reviewers.

Blocked or unverified candidates are not eligible for no-change acceptance; resolve the missing prerequisite or obtain an explicit scope decision first. If no scoped change remains after bounded verification, report the tested SHA, attempts, controls, limits and relevant merged repair without inventing a patch or PR. Request operator completion with dependency satisfaction after evidence review; do not satisfy the edge yourself or treat ordinary done state as sufficient. A successor starts only after this phase's merge or that explicit no-change acceptance, and remains disabled until enabled by the operator.

## Downstream handoff

Phases 3 and 4 inherit the exact root/ancestor process contract and the shared Herdr Kill/cleanup fixes or fresh evidence that #1085 already fixed them. Document changed APIs and regression locations. Equivalent-path handling and standalone emulator identity remain downstream.

Keep every successor disabled and retain the serial dependency chain. Do not implement later scouts' live verification within this task, except cross-backend regressions needed to safely change a shared contract now.

## Cross-phase audit record

Compared with Phase 1: preserve exact resource cleanup and conservative Kill; no reintroduction of name authority. Shared Herdr/process correlation is owned here, while later host phases supply independent verification and residual fixes.

The approved source, index and all earlier phase guides were reread during this reconciliation. Direct dependency direction is forward-only. Tests, migrations and documentation land with their owning behavior; no later phase is needed to make this merge operable.
