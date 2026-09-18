# Phase 4: Herdr in iTerm2 lifecycle

Source: [approved plan](plan.md), [phase index](phased-plan.md). Repository: Mission Control only. This is one ship task for one scout, using Codex `gpt-6-astra`, `xhigh`, and No-Mistakes Review (`builtin-workflow:no-mistakes-review`). It starts disabled; do not enable this or another task automatically.

## Outcome and scope

Verify Herdr lifecycle safety with iTerm2, especially reclaim/cancel after title reuse across Claude, Codex and Pi launch shapes, and fix only reproduced residuals after the shared repairs.

Non-goals: Standalone iTerm2 new-pane readiness, broad AppleScript inventory changes, or reopening completed common Herdr designs without evidence. Do not implement a speculative fix or change terminal applications themselves.

## Entry criteria and direct dependencies

- The planning task's PR has merged these plan paths to `main`.
- Direct phase prerequisite: Phase 3, merged or explicitly accepted by the operator as a verified no-change completion. The planning task is also a direct dependency. No concurrent phase execution is allowed.
- Before **any reproduction**, pull latest `main` into the task branch, resolve conflicts, rebuild the code used by the probe, and record the exact tested SHA. Refresh again after a long pause or a newly merged prerequisite. Do not silently use the installed app's older daemon.
- Read `AGENTS.md`, repository memory, architecture/change contracts and the approved plan. Apply the debugging skill if a failure reproduces. Inspect existing changes and preserve unrelated work.

## Source evidence and bounded findings

Original scout task: `e45b3e53-db0d-4349-ab10-9b481fc360af`. Original report: `docs/reports/herdr-iterm-lifecycle/report.html` in that scout's checkout. Archive key: `00c8ce79-080f-4d86-adb5-d791465c73e1~b05a4a73-a883-47b6-a42b-5617b2604c17`; primary artifact `report`.

The scout reproduced shared-workspace Kill in three private servers, reclaim closing a same-title replacement in 9/9 tasks across three servers and all three fake harnesses, and direct-exec Focus failure in 3/3 routes. Full-client detach/close/reattach controls were safe. The defect replay used daemon routes via a Playwright API driver, not browser clicks. Companions include `reproduction.test.ts`, `exec-discovery.test.ts`, `dispatch.spec.ts`, `playwright.scout.config.ts`, `fixture.ts` and `probe-agent.mjs`.

These are verified report contents, not fresh reproductions on phase-start `main`. Retrieve archived companions through Mission Control's Library/archive API. If an original fixture cannot be retrieved, reconstruct it from the procedure below and disclose the missing evidence. Never commit `report.html` or raw proof.

## Repository findings and inherited contracts

Consume Phases 1–3 exactly: identity-based cleanup, conservative Kill, exact root/ancestor discovery and bounded local cwd equivalence. Trace `src/server/tasks.ts` cancel/reclaim paths into `dispatcher.ts` and `terminal/home.ts`, plus Herdr Focus composition. Do not infer that passing a Cancel test proves Reclaim, or that closing an iTerm client closes the Herdr server.

Keep actions as write-policy owner, terminal adapters as mechanisms, and registries as the capability source. `Registry.beginEviction` remains the sole durable removal path; transient `exited` is not cleanup authority. Preserve legacy/unknown target identities without name-based destructive fallback. No new parallel inventory or eviction path.

## Execution sequence

Steps 2–5 establish evidence and design a correction only. Do not change production behavior until Step 6 has established the failing regression where feasible.

1. Establish the fresh-main baseline and native application/backend versions. Use a private daemon, temporary state/repository/socket where supported, harmless fake agents, and an exact allowlist of fixture PIDs/start times and terminal IDs. Inventory unrelated resources before and after each bounded native batch. Do not restart shared applications or close unrelated sessions.
2. Establish isolated daemon/Herdr state and owned iTerm2 clients. Assert actual inner Herdr and outer iTerm handles; create each fake harness through real terminal task dispatch.
3. Rename an owned workspace, create an independent replacement with the original title, then exercise Cancel and explicit Reclaim separately. Use three fresh private-server fixtures across all three harness shapes and prove replacement/control input after each action.
4. Recheck direct-exec discovery and Focus, independent siblings in one workspace, changed preference after launch, and closing/detaching/reopening only owned host clients. Verify worktree retention and durable removal events where cleanup is involved.
5. Diagnose any residual in task/home cleanup or host composition and design its correction without duplicating earlier correlation/cwd rules. Plan browser coverage for any dashboard-reachable defect.
6. If a defect is reproduced, add a focused failing regression where feasible before the fix, implement the smallest correction in existing owners, then repeat the native procedure and negative controls on the fixed build. Record failures/attempts, timeouts, tested SHA, expected versus actual behavior, and fresh acknowledgements from all expected survivors. An automation limitation needs an explicit reason and rerunnable manual proof.
7. Reconcile the phase's documentation and downstream contract with the actual implementation. The guide is a proposed route, not a specification: adapt to current code and record deviations and reasons in the PR. Only the approved outcome is fixed.

## Data, API and compatibility

Preserve recorded backend/resource routing through Cancel and Reclaim even when preferences or titles change. Keep client detach distinct from server/workspace termination. No storage/API change is expected; a required change must preserve the earlier contracts and land with all callers.

Do not rename persisted append-only IDs. If a proven fix needs a migration, ship its upgrade, consumers and compatibility tests together; otherwise retain existing storage. Keep Node-only logic out of `src/shared`. Unknown observations do not authorize worktree release.

## Tests and verification

Start with `test/dispatcher-cleanup.test.ts`, `test/terminal-home.test.ts`, `test/herdr-adapter.test.ts`, `test/multiplexer-focus-terminal-route.test.ts` and relevant task-route coverage. Extend the appropriate Herdr/dispatch `e2e/` spec for actual dashboard actions if behavior changes. Native iTerm2/Herdr client controls remain manual evidence.

Run focused files with the exact invocation in `AGENTS.md`; its isolation setup is mandatory and must not be bypassed. A dashboard-visible behavior change or UI-reproduced bug requires a Playwright spec in `e2e/` using fake agents. Build before live runtime/E2E probes. Run `npm run typecheck`, `npm run lint`, and the required runtime/build/smoke/E2E checks for the actual change; complete the selected No-Mistakes workflow. During CI/reviewer repair use focused checks before pushing, resolve conflicts, and monitor CI. No paid model calls are needed.

## Merge and exit criteria

Every reported candidate is classified as reproduced-and-fixed, already fixed with fresh evidence, not reproduced within stated bounds, or blocked with the exact missing prerequisite. A blocked manual reproduction is not a verified repair. For changes, require failing-before/passing-after proof where feasible, repeated manual survivor checks, appropriate tests and a reviewable PR under the selected workflow. Attach uncommitted evidence to the PR and supply live evidence artifacts to workflow reviewers.

Blocked or unverified candidates are not eligible for no-change acceptance; resolve the missing prerequisite or obtain an explicit scope decision first. If no scoped change remains after bounded verification, report the tested SHA, attempts, controls, limits and relevant merged repair without inventing a patch or PR. Request operator completion with dependency satisfaction after evidence review; do not satisfy the edge yourself or treat ordinary done state as sufficient. A successor starts only after this phase's merge or that explicit no-change acceptance, and remains disabled until enabled by the operator.

## Downstream handoff

Phase 5 receives the completed shared Herdr verification baseline, including separate Cancel/Reclaim coverage. Phase 8 owns standalone iTerm2 readiness and inventory; these nested-host checks do not prove those standalone paths safe.

Keep every successor disabled and retain the serial dependency chain. Do not implement later scouts' live verification within this task, except cross-backend regressions needed to safely change a shared contract now.

## Cross-phase audit record

Compared with Phases 1–3: this phase consumes shared contracts and owns only residual integration fixes and the independent reclaim matrix. It does not alter standalone emulator identity before its Phase 5 owner.

The approved source, index and all earlier phase guides were reread during this reconciliation. Direct dependency direction is forward-only. Tests, migrations and documentation land with their owning behavior; no later phase is needed to make this merge operable.
