# Phase 3: Herdr in Ghostty lifecycle

Source: [approved plan](plan.md), [phase index](phased-plan.md). Repository: Mission Control only. This is one ship task for one scout, using Codex `gpt-6-astra`, `xhigh`, and No-Mistakes Review (`builtin-workflow:no-mistakes-review`). It starts disabled; do not enable this or another task automatically.

## Outcome and scope

Verify the shared Herdr fixes with Ghostty as host and correct a reproduced false unknown-outcome result when a created workspace reports an equivalent local cwd spelling.

Non-goals: Standalone Ghostty inventory/correlation repairs, assuming every remote path can be resolved locally, or repeating a common repair already landed by Phase 2. Do not implement a speculative fix or change terminal applications themselves.

## Entry criteria and direct dependencies

- The planning task's PR has merged these plan paths to `main`.
- Direct phase prerequisite: Phase 2, merged or explicitly accepted by the operator as a verified no-change completion. The planning task is also a direct dependency. No concurrent phase execution is allowed.
- Before **any reproduction**, pull latest `main` into the task branch, resolve conflicts, rebuild the code used by the probe, and record the exact tested SHA. Refresh again after a long pause or a newly merged prerequisite. Do not silently use the installed app's older daemon.
- Read `AGENTS.md`, repository memory, architecture/change contracts and the approved plan. Apply the debugging skill if a failure reproduces. Inspect existing changes and preserve unrelated work.

## Source evidence and bounded findings

Original scout task: `c0a120ff-0967-49de-b75c-61d4f4b4119b`. Original report: `docs/reports/herdr-ghostty-lifecycle/report.html` in that scout's checkout. Archive key: `00c8ce79-080f-4d86-adb5-d791465c73e1~06943904-199f-4d18-b047-8d986a2f05a6`; primary artifact `report`.

The scout reported shared Kill and cleanup failures with real daemon routes in three trials each, direct-exec correlation at the correlator layer, and 3/3 real creations whose `/var` versus `/private/var` cwd values caused `outcomeUnknown`. The path finding was client-level; downstream UI impact was not proven. Companion drivers include `external.test.ts`, `identity.test.ts`, `daemon-scout.ts`, `common.ts`, `private-run.mjs`, `reproduce.md` and `gui.test.ts`. Supplementary standalone Ghostty timeout observations belong to Phase 5.

These are verified report contents, not fresh reproductions on phase-start `main`. Retrieve archived companions through Mission Control's Library/archive API. If an original fixture cannot be retrieved, reconstruct it from the procedure below and disclose the missing evidence. Never commit `report.html` or raw proof.

## Repository findings and inherited contracts

Phase 2 owns shared Herdr discovery and cleanup. Inspect `src/server/terminal/herdr-client.ts` creation-result validation, which compared `rootPane.cwd === spec.cwd` at the planning baseline, plus existing client schema and outcome-unknown handling. Use current Phase 2 behavior before diagnosing Ghostty-specific differences.

Keep actions as write-policy owner, terminal adapters as mechanisms, and registries as the capability source. `Registry.beginEviction` remains the sole durable removal path; transient `exited` is not cleanup authority. Preserve legacy/unknown target identities without name-based destructive fallback. No new parallel inventory or eviction path.

## Execution sequence

Steps 2–5 establish evidence and design a correction only. Do not change production behavior until Step 6 has established the failing regression where feasible.

1. Establish the fresh-main baseline and native application/backend versions. Use a private daemon, temporary state/repository/socket where supported, harmless fake agents, and an exact allowlist of fixture PIDs/start times and terminal IDs. Inventory unrelated resources before and after each bounded native batch. Do not restart shared applications or close unrelated sessions.
2. Run a private Herdr/daemon fixture with owned Ghostty host windows and verify actual nested handles. Repeat the report's shared Kill, rename/replacement cleanup and direct-exec cases against the merged common fixes.
3. Create real temporary directories reachable through equivalent `/var` and `/private/var` paths. Request workspace creation through the production client, inspect the returned UUID/root pane cwd and actual workspace, and compare success versus unknown outcome in at least three fresh trials.
4. Add negative controls for a different directory, inaccessible or missing path, unresolved symlink, remote path semantics if supported, and a genuinely incomplete creation response. Establish which equivalence can be proved without masking uncertainty.
5. If reproduced, design local-path equivalence handling in the Herdr creation verifier while preserving unknown outcomes when identity cannot be established. Reject blind retries that could duplicate an uncertain creation.
6. If a defect is reproduced, add a focused failing regression where feasible before the fix, implement the smallest correction in existing owners, then repeat the native procedure and negative controls on the fixed build. Record failures/attempts, timeouts, tested SHA, expected versus actual behavior, and fresh acknowledgements from all expected survivors. An automation limitation needs an explicit reason and rerunnable manual proof.
7. Reconcile the phase's documentation and downstream contract with the actual implementation. The guide is a proposed route, not a specification: adapt to current code and record deviations and reasons in the PR. Only the approved outcome is fixed.

## Data, API and compatibility

Keep existing client schemas and unknown-outcome response semantics. Resolve equivalent local paths using repository conventions only where local identity is meaningful; do not claim a remote filesystem is the daemon's filesystem. No new task schema is expected.

Do not rename persisted append-only IDs. If a proven fix needs a migration, ship its upgrade, consumers and compatibility tests together; otherwise retain existing storage. Keep Node-only logic out of `src/shared`. Unknown observations do not authorize worktree release.

## Tests and verification

Extend `test/herdr-client.test.ts` for equivalent and non-equivalent paths and uncertain outcomes. Reuse `test/herdr-adapter.test.ts`, `test/correlate.test.ts` and cleanup tests for inherited behavior. If correcting user-visible dispatch results, cover the visible outcome in a focused `e2e/` spec using existing Herdr/dispatch fixtures. A client-only test cannot substitute for manual native creation.

Run focused files with the exact invocation in `AGENTS.md`; its isolation setup is mandatory and must not be bypassed. A dashboard-visible behavior change or UI-reproduced bug requires a Playwright spec in `e2e/` using fake agents. Build before live runtime/E2E probes. Run `npm run typecheck`, `npm run lint`, and the required runtime/build/smoke/E2E checks for the actual change; complete the selected No-Mistakes workflow. During CI/reviewer repair use focused checks before pushing, resolve conflicts, and monitor CI. No paid model calls are needed.

## Merge and exit criteria

Every reported candidate is classified as reproduced-and-fixed, already fixed with fresh evidence, not reproduced within stated bounds, or blocked with the exact missing prerequisite. A blocked manual reproduction is not a verified repair. For changes, require failing-before/passing-after proof where feasible, repeated manual survivor checks, appropriate tests and a reviewable PR under the selected workflow. Attach uncommitted evidence to the PR and supply live evidence artifacts to workflow reviewers.

Blocked or unverified candidates are not eligible for no-change acceptance; resolve the missing prerequisite or obtain an explicit scope decision first. If no scoped change remains after bounded verification, report the tested SHA, attempts, controls, limits and relevant merged repair without inventing a patch or PR. Request operator completion with dependency satisfaction after evidence review; do not satisfy the edge yourself or treat ordinary done state as sufficient. A successor starts only after this phase's merge or that explicit no-change acceptance, and remains disabled until enabled by the operator.

## Downstream handoff

Phase 4 inherits the common Herdr fixes and the explicitly bounded local-path equivalence rule. Phase 5 owns standalone Ghostty enumeration and launch identity; leave those repairs and their live matrix to it.

Keep every successor disabled and retain the serial dependency chain. Do not implement later scouts' live verification within this task, except cross-backend regressions needed to safely change a shared contract now.

## Cross-phase audit record

Compared with Phases 1–2: no overlapping cleanup or correlation implementation. Canonical-path validation is owned here, with all client consumers kept operable in this merge. Standalone Ghostty uncertainty remains assigned to Phase 5.

The approved source, index and all earlier phase guides were reread during this reconciliation. Direct dependency direction is forward-only. Tests, migrations and documentation land with their owning behavior; no later phase is needed to make this merge operable.
