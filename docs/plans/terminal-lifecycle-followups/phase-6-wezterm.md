# Phase 6: WezTerm native mux incarnation safety

Source: [approved plan](plan.md), [phase index](phased-plan.md). Repository: Mission Control only. This is one ship task for one scout, using Codex `gpt-6-astra`, `xhigh`, and No-Mistakes Review (`builtin-workflow:no-mistakes-review`). It starts disabled; do not enable this or another task automatically.

## Outcome and scope

Ensure a stale WezTerm session cannot deliver input to a replacement pane after native mux restart, while preserving supported current-session delivery and no-auto-start behavior.

Non-goals: Claiming the GUI restart or queued-human-send path was reproduced, treating a one-off GUI close/recreate observation as confirmed, or restoring inherited stale socket routing. Do not implement a speculative fix or change terminal applications themselves.

## Entry criteria and direct dependencies

- The planning task's PR has merged these plan paths to `main`.
- Direct phase prerequisite: Phase 5, merged or explicitly accepted by the operator as a verified no-change completion. The planning task is also a direct dependency. No concurrent phase execution is allowed.
- Before **any reproduction**, pull latest `main` into the task branch, resolve conflicts, rebuild the code used by the probe, and record the exact tested SHA. Refresh again after a long pause or a newly merged prerequisite. Do not silently use the installed app's older daemon.
- Read `AGENTS.md`, repository memory, architecture/change contracts and the approved plan. Apply the debugging skill if a failure reproduces. Inspect existing changes and preserve unrelated work.

## Source evidence and bounded findings

Original scout task: `a4ce2978-5874-4170-9971-a451f9045929`. Original report: `docs/reports/wezterm-lifecycle/report.html` in that scout's checkout. Archive key: `00c8ce79-080f-4d86-adb5-d791465c73e1~0a56e666-c71a-4a14-b78e-6ca91be4f4b6`; primary artifact `report`.

The final scout reproduced numeric pane-ID reuse after a private native headless mux-server restart in 20/20 trials. A stale session's direct `/send` request with `origin: workflow` returned HTTP 200 and delivered the nonce to replacement pane 1. This was private HOME/default Unix socket, without a GUI or inner multiplexer. Same-server close/recreate refused old IDs 20/20 and stopped-server writes refused 20/20. Queued human send delivered zero bytes during a bounded 900ms control; this is not proof of all queued delivery behavior. A normal GUI close/recreate wrong-recipient observation was seen once, then not repeated in five GUI and twenty private trials. Native cleanup during Cancel hit a separate incomplete-process-scan refusal. Key fixture: `private-mux.ts --route`, with the report's `SCOUT_SERIES`/`SCOUT_TRIAL` settings.

These are verified report contents, not fresh reproductions on phase-start `main`. Retrieve archived companions through Mission Control's Library/archive API. If an original fixture cannot be retrieved, reconstruct it from the procedure below and disclose the missing evidence. Never commit `report.html` or raw proof.

## Repository findings and inherited contracts

Consume Phase 5's launch identity and inventory availability contract. Inspect `src/server/terminal/wezterm.ts`, `terminal/targets.ts`, `terminal/bin.ts`, `terminal/types.ts`, `shared/pane.ts`, discovery/registry composition and the final write path in `actions.ts`. At the planning baseline writes used numeric pane IDs with no established server-incarnation token. Preserve `--no-auto-start`, default endpoint selection and inherited `WEZTERM_UNIX_SOCKET` scrubbing.

Keep actions as write-policy owner, terminal adapters as mechanisms, and registries as the capability source. `Registry.beginEviction` remains the sole durable removal path; transient `exited` is not cleanup authority. Preserve legacy/unknown target identities without name-based destructive fallback. No new parallel inventory or eviction path.

## Execution sequence

Steps 2–5 establish evidence and design a correction only. Do not change production behavior until Step 6 has established the failing regression where feasible.

1. Establish the fresh-main baseline and native application/backend versions. Use a private daemon, temporary state/repository/socket where supported, harmless fake agents, and an exact allowlist of fixture PIDs/start times and terminal IDs. Inventory unrelated resources before and after each bounded native batch. Do not restart shared applications or close unrelated sessions.
2. Reconstruct the private native mux fixture through the actual production adapter path. Prove no operator GUI/server/socket is addressed. Start owner A, discover it, and record pane identity plus the server/endpoint/process evidence available to production.
3. Stop only the private server, restart it so a different agent receives the old numeric ID, then issue the original direct workflow send through the real daemon route. Repeat 20 bounded restart trials and capture replacement bytes and route status.
4. Run same-server closed-pane, server-unavailable, unchanged live target, queued-human-send and unrelated survivor controls. Keep the GUI one-off lead separate unless independently reproduced from clean setup.
5. For a confirmed failure, design trustworthy incarnation/ownership validation at the final write boundary. Plan conservative stale/unknown refusal and fresh discovery without merely moving an unchecked restart race earlier. Choose representation from current backend evidence and include every affected consumer.
6. If a defect is reproduced, add a focused failing regression where feasible before the fix, implement the smallest correction in existing owners, then repeat the native procedure and negative controls on the fixed build. Record failures/attempts, timeouts, tested SHA, expected versus actual behavior, and fresh acknowledgements from all expected survivors. An automation limitation needs an explicit reason and rerunnable manual proof.
7. Reconcile the phase's documentation and downstream contract with the actual implementation. The guide is a proposed route, not a specification: adapt to current code and record deviations and reasons in the PR. Only the approved outcome is fixed.

## Data, API and compatibility

Numeric pane ID alone is insufficient across server replacement. Unknown legacy handles must fail conservatively until rediscovered; do not guess an incarnation or send via inherited socket state. Any persisted identity extension needs backward-compatible decoding and upgrade tests in this phase, preserving Phase 5's common result types.

Do not rename persisted append-only IDs. If a proven fix needs a migration, ship its upgrade, consumers and compatibility tests together; otherwise retain existing storage. Keep Node-only logic out of `src/shared`. Unknown observations do not authorize worktree release.

## Tests and verification

Extend relevant coverage in `test/terminal-adapters.test.ts`, `test/terminal-target-contract.test.ts`, `test/terminal-targets-memo.test.ts`, `test/session-actions-http.test.ts` and `test/workflow-delivery-actions.test.ts`, adding a focused WezTerm restart regression if needed. Use `e2e/specs/workflow-session-action.spec.ts` or an appropriate focused spec for changed visible action behavior. The real native restart route proof is mandatory; stubbing two identical numeric IDs alone is not manual reproduction.

Run focused files with the exact invocation in `AGENTS.md`; its isolation setup is mandatory and must not be bypassed. A dashboard-visible behavior change or UI-reproduced bug requires a Playwright spec in `e2e/` using fake agents. Build before live runtime/E2E probes. Run `npm run typecheck`, `npm run lint`, and the required runtime/build/smoke/E2E checks for the actual change; complete the selected No-Mistakes workflow. During CI/reviewer repair use focused checks before pushing, resolve conflicts, and monitor CI. No paid model calls are needed.

## Merge and exit criteria

Every reported candidate is classified as reproduced-and-fixed, already fixed with fresh evidence, not reproduced within stated bounds, or blocked with the exact missing prerequisite. A blocked manual reproduction is not a verified repair. For changes, require failing-before/passing-after proof where feasible, repeated manual survivor checks, appropriate tests and a reviewable PR under the selected workflow. Attach uncommitted evidence to the PR and supply live evidence artifacts to workflow reviewers.

Blocked or unverified candidates are not eligible for no-change acceptance; resolve the missing prerequisite or obtain an explicit scope decision first. If no scoped change remains after bounded verification, report the tested SHA, attempts, controls, limits and relevant merged repair without inventing a patch or PR. Request operator completion with dependency satisfaction after evidence review; do not satisfy the edge yourself or treat ordinary done state as sufficient. A successor starts only after this phase's merge or that explicit no-change acceptance, and remains disabled until enabled by the operator.

## Downstream handoff

Phases 7–8 inherit the shared target contract with any explicit incarnation support, without adopting WezTerm-specific numeric-ID assumptions for stable UUID backends. Document how stale handles are refused and renewed, plus any compatible persisted encoding.

Keep every successor disabled and retain the serial dependency chain. Do not implement later scouts' live verification within this task, except cross-backend regressions needed to safely change a shared contract now.

## Cross-phase audit record

Compared with Phases 1–5: WezTerm incarnation safety extends existing target ownership and Phase 5 availability semantics; it does not create a parallel liveness source or undo socket scrubbing. All affected target consumers remain operable at this phase's merge.

The approved source, index and all earlier phase guides were reread during this reconciliation. Direct dependency direction is forward-only. Tests, migrations and documentation land with their owning behavior; no later phase is needed to make this merge operable.
