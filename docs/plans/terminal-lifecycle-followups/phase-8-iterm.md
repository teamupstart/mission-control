# Phase 8: iTerm2 standalone readiness and inventory

Source: [approved plan](plan.md), [phase index](phased-plan.md). Repository: Mission Control only. This is one ship task for one scout, using Codex `gpt-6-astra`, `xhigh`, and No-Mistakes Review (`builtin-workflow:no-mistakes-review`). It starts disabled; do not enable this or another task automatically.

## Outcome and scope

Determine whether the standalone iTerm2 new-pane input/readiness and enumeration-as-absence symptoms remain reproducible from clean isolated state, and fix only a verified Mission Control defect. A bounded no-defect result is a valid outcome with evidence.

Non-goals: Calling injected failures natural bugs, attributing an unresolved terminal/Node/environment symptom to Mission Control, or restarting shared iTerm2 without explicit approval. Do not implement a speculative fix or change terminal applications themselves.

## Entry criteria and direct dependencies

- The planning task's PR has merged these plan paths to `main`.
- Direct phase prerequisite: Phase 7, merged or explicitly accepted by the operator as a verified no-change completion. The planning task is also a direct dependency. No concurrent phase execution is allowed.
- Before **any reproduction**, pull latest `main` into the task branch, resolve conflicts, rebuild the code used by the probe, and record the exact tested SHA. Refresh again after a long pause or a newly merged prerequisite. Do not silently use the installed app's older daemon.
- Read `AGENTS.md`, repository memory, architecture/change contracts and the approved plan. Apply the debugging skill if a failure reproduces. Inspect existing changes and preserve unrelated work.

## Source evidence and bounded findings

Original scout task: `57cc2c5c-856f-489c-82d7-590ce1968139`. Original report: `docs/reports/iterm-lifecycle/report.html` in that scout's checkout. This report is unpublished and explicitly included by the operator. Resolve the source task's original worktree through Mission Control; its checkout-relative report path above is the exact file supplied by the operator. Report SHA-256: `4dd0fa231587e55285e4647fb2d3b01024c499288f955ed72cf38acc4df58065`. Missing archive publication must not exclude the task.

The report found no confirmed Mission Control defect in its completed responsive-pane matrix. UUID writes, Kill, tab indexing and 20/20 Focus controls passed. Fresh panes failed acknowledgements in 20/20 attempts while an older control remained responsive; raw-mode setup blocked in one setup, and quiet startup reached raw mode without receiving bytes. Focus did not recover three checked cases. Onset was not reproduced from a clean application state, shared restart was not isolated, and native GUI verification was unavailable, leaving attribution unresolved. Injected AppleScript -1743/timeout failures returned empty inventory and false `homeAlive` in three cases each. A final simple native UUID/TTY list found an owned pane while production enumeration returned empty, but the failing property/timeout was not isolated. No natural premature worktree cleanup was proved.

These are verified report contents, not fresh reproductions on phase-start `main`. Retrieve archived companions through Mission Control's Library/archive API. If an original fixture cannot be retrieved, reconstruct it from the procedure below and disclose the missing evidence. Never commit `report.html` or raw proof.

## Repository findings and inherited contracts

Use the unpublished report without waiting for an archive. Inspect `src/server/terminal/iterm.ts` spawn readiness, session-marker/UUID normalization, input scripts and inventory parsing; trace through `terminal/home.ts` and dispatcher restore. Consume Phase 5's launch-identity/unknown-inventory contract and Phase 6's shared target changes. Phase 4's nested Herdr success does not establish standalone behavior.

Keep actions as write-policy owner, terminal adapters as mechanisms, and registries as the capability source. `Registry.beginEviction` remains the sole durable removal path; transient `exited` is not cleanup authority. Preserve legacy/unknown target identities without name-based destructive fallback. No new parallel inventory or eviction path.

## Execution sequence

Steps 2–5 establish evidence and design a correction only. Do not change production behavior until Step 6 has established the failing regression where feasible.

1. Establish the fresh-main baseline and native application/backend versions. Use a private daemon, temporary state/repository/socket where supported, harmless fake agents, and an exact allowlist of fixture PIDs/start times and terminal IDs. Inventory unrelated resources before and after each bounded native batch. Do not restart shared applications or close unrelated sessions.
2. Recover report companions from the original scout checkout where available. Establish a clean test-owned pane/daemon setup, known application version and faithful harmless process shapes. Preserve the responsive control and explicitly distinguish raw-mode initialization, AppleScript acceptance, byte delivery and application acknowledgement.
3. Manually create fresh panes, send unique nonces using direct native and production paths, and compare quiet startup, delayed readiness, direct-exec and persistent-shell controls. Repeat clean failures at least three times; record onset and platform state. If only a shared app restart can establish a clean baseline, obtain explicit operator approval before affecting existing panes; otherwise mark that scope blocked.
4. Compare minimal UUID/TTY enumeration with production inventory on the same live pane. Isolate expensive/failing properties and natural timeout/refusal separately from labeled injected faults. Prove how liveness and private daemon restart behave while direct input still works.
5. If a Mission Control defect is verified, design a correction in the responsible readiness, AppleScript or availability consumer using the inherited contract. Avoid global timeout changes that hide an unisolated symptom. Preserve unresolved attribution without speculative code.
6. If a defect is reproduced, add a focused failing regression where feasible before the fix, implement the smallest correction in existing owners, then repeat the native procedure and negative controls on the fixed build. Record failures/attempts, timeouts, tested SHA, expected versus actual behavior, and fresh acknowledgements from all expected survivors. An automation limitation needs an explicit reason and rerunnable manual proof.
7. Reconcile the phase's documentation and downstream contract with the actual implementation. The guide is a proposed route, not a specification: adapt to current code and record deviations and reasons in the PR. Only the approved outcome is fixed.

## Data, API and compatibility

Preserve exact iTerm session UUID addressing and normalization across tab renumbering. Unknown inventory and uncertain spawn outcomes remain distinct from confirmed absence/failure. No new persistence or liveness contract should duplicate Phase 5; extend existing interfaces compatibly only when proven necessary.

Do not rename persisted append-only IDs. If a proven fix needs a migration, ship its upgrade, consumers and compatibility tests together; otherwise retain existing storage. Keep Node-only logic out of `src/shared`. Unknown observations do not authorize worktree release.

## Tests and verification

Use `test/terminal-iterm.test.ts`, `test/terminal-emulator-spawn.test.ts`, `test/terminal-home.test.ts`, `test/terminal-enumerate.test.ts` and relevant dispatch-readiness/restart tests. Cover UUID normalization, partial/malformed inventory, permission failures, timeouts and genuine empty results where the fix applies. Add required focused `e2e/` coverage for any visible dispatch/readiness change, while preserving native manual proof and its limitations.

Run focused files with the exact invocation in `AGENTS.md`; its isolation setup is mandatory and must not be bypassed. A dashboard-visible behavior change or UI-reproduced bug requires a Playwright spec in `e2e/` using fake agents. Build before live runtime/E2E probes. Run `npm run typecheck`, `npm run lint`, and the required runtime/build/smoke/E2E checks for the actual change; complete the selected No-Mistakes workflow. During CI/reviewer repair use focused checks before pushing, resolve conflicts, and monitor CI. No paid model calls are needed.

## Merge and exit criteria

Every reported candidate is classified as reproduced-and-fixed, already fixed with fresh evidence, not reproduced within stated bounds, or blocked with the exact missing prerequisite. A blocked manual reproduction is not a verified repair. For changes, require failing-before/passing-after proof where feasible, repeated manual survivor checks, appropriate tests and a reviewable PR under the selected workflow. Attach uncommitted evidence to the PR and supply live evidence artifacts to workflow reviewers.

Blocked or unverified candidates are not eligible for no-change acceptance; resolve the missing prerequisite or obtain an explicit scope decision first. If no scoped change remains after bounded verification, report the tested SHA, attempts, controls, limits and relevant merged repair without inventing a patch or PR. Request operator completion with dependency satisfaction after evidence review; do not satisfy the edge yourself or treat ordinary done state as sufficient. A successor starts only after this phase's merge or that explicit no-change acceptance, and remains disabled until enabled by the operator.

## Downstream handoff

Complete the eight-scout matrix with a precise confirmed/fixed/already-fixed/unreproduced/blocked status for every iTerm2 observation. Document any residual prerequisite for clean-state reproduction. This final task does not retroactively enable predecessors or authorize unrelated cleanup.

Keep every successor disabled and retain the serial dependency chain. Do not implement later scouts' live verification within this task, except cross-backend regressions needed to safely change a shared contract now.

## Cross-phase audit record

Compared with Phases 1–7: standalone iTerm2 consumes existing exact identity, spawn and unknown-inventory contracts. Its explicit inclusion does not promote unresolved symptoms into confirmed bugs. No final catch-all repair is required for earlier phases to operate.

The approved source, index and all earlier phase guides were reread during this reconciliation. Direct dependency direction is forward-only. Tests, migrations and documentation land with their owning behavior; no later phase is needed to make this merge operable.
