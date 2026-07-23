# Phase 8 — Extension Proof, Hardening, and Release

## 1. Outcome

Prove that the Ensemble kernel supports materially different multi-agent patterns without schema, route, SSE, Session, or layout forks; integrate Ensemble transitions into existing cost/alert operations; document the safety and extension contracts; and pass the full build, packaging, restart, and adversarial release gate.

Best-of-N remains the only enabled production preset. Alternative strategies are test fixtures and design examples until separately productized.

## 2. Entry Conditions and Dependencies

- Depends directly on Phase 7.
- The complete backend and dashboard flow is green.
- Every production run is compiled from an enabled registered strategy and every effect is restart-safe.
- No release claim is made until this phase’s extension, mixed-harness, fault, build, and packaging gates pass.

## 3. Scope and Non-Goals

In scope:

- injectable test-only fixed-matrix, adaptive-halving, pairwise, panel, and synthesis strategy fixtures;
- source/contract tests proving no kernel or surface forks are required;
- full restart/race/fault/adversarial/resource-limit matrix;
- shared alert-engine and cost presentation integration;
- README, operator, recovery, retention, security, and extension documentation;
- `AGENTS.md` registry/surface guidance for future changes;
- full typecheck/test/build/smoke/package validation.

Out of scope:

- enabling or persisting new production strategy ids;
- shipping automatic finalization, PR creation, publishing, or merging;
- background/time-based ref deletion;
- claiming strong adversarial isolation among local worktrees;
- repository-owned arbitrary validation commands;
- Workflows before comparison;
- changing Electron asar or moving skills into `dist`.

## 4. Repository Findings That Shape the Work

- `src/shared/alerts.ts` is the one pure transition-to-alert engine used by both browser notification delivery and daemon Away buffering. Ensemble attention must extend its `AlertScope`, not add a notifier.
- App currently constructs alert scope from Sessions, Tasks, and Stalls. `ensembleSummaries` can join that same snapshot-derived scope.
- `LLM_JOB_IDS`, strategy ids, artifact kinds, and any persisted driver ids are append-only.
- `npm run build` already bundles web, daemon, Electron main/preload, MCP, and both hook satellites. No new entry point is required.
- `electron-builder.yml` intentionally ships un-asared external MCP/hook bundles. Launch tests must verify the existing `dist/mcp/server.mjs` path rather than moving or duplicating it.
- The codebase uses exhaustive Records and negative source/contract tests to keep registries honest. The extension proof should establish the same enforcement for strategies, drivers, adapters, and result renderers.
- Cost telemetry distinguishes authoritative monetary cost from call/session estimates. Ensemble totals must not manufacture prices for runners that do not report them.

## 5. Implementation Steps

1. Build a reusable test strategy harness.
   - Add test helpers that inject a generic `StrategyCatalog<TestStrategyKey>`, driver registries, fake TaskManager/Dispatcher, artifact adapters, evaluator results, and deterministic clock/id sources.
   - Persist compiled snapshots with bounded test keys through the same store/parser used by production, while production create schemas continue to accept only `ENSEMBLE_STRATEGY_IDS`.
   - Prove a missing test/newer strategy or driver blocks recovery visibly and never falls back to current Best-of-N/default compilation.

2. Prove distinct launch-count policies.
   - **Fixed matrix:** compile explicit roles/harness/model/effort combinations, including duplicates, into one bounded wave.
   - **Successive halving:** launch an initial range, evaluate once, advance a top fraction into a later wave, and stop at the hard member/wave cap.
   - **Adaptive stop:** begin with the minimum roster and append a wave only when a deterministic confidence predicate remains inconclusive.
   - Verify preview estimates distinguish exact initial count, maximum count, concurrency, and waves without changing the create route or run table.

3. Prove distinct comparison/collaboration patterns.
   - **Pairwise tournament:** schedule a deterministic bounded pair set, persist each comparison separately, resume only missing pairs, and derive standings through generic stage outputs.
   - **Panel consensus:** run multiple review attempts over the same immutable subject set, preserve individual ballots, and aggregate agreement without adding member score columns.
   - **Critique/revision or synthesis:** create a later Task whose explicit parent artifact ids are its inputs, launch it at a verified artifact commit, and emit a synthesized outcome with lineage.
   - **Retain/no-consensus:** complete non-destructively without a single winner or Workflow handoff.
   - Keep every fixture tool-less/deterministic where model behavior is not the subject under test.

4. Add architectural negative tests.
   - Assert `EnsembleEngine`, generic manager, store, router, SSE reducer, Session components, and Workflow engine contain no branch on `best_of_n`.
   - Assert adding an injected fixture requires no new database table/column, HTTP route, MCP tool, `ServerEvent`, `Session` field/comparator, layout prop, mark vocabulary, or page route.
   - Assert built-in strategy, driver, artifact-adapter, and result-renderer Records are exhaustive.
   - Assert production create rejects test/unknown/disabled ids while recovery reports unknown persisted keys honestly.
   - Assert compiled plans remain byte-stable when descriptor defaults later change.

5. Complete the fault/restart/race matrix.
   - Inject process failure immediately before and after every persist-before-act boundary: run/member creation, Task creation/dispatch, snapshot/ref creation, artifact ready, stage command, LLM call/result, decision, winner restore/replacement, loser cleanup, continuation, Workflow claim/bind/submit, completion, and deletion.
   - Race duplicate create, simultaneous submits, submit versus withdraw/cancel, evaluation completion versus cancel, duplicate decisions, and action retry versus startup recovery.
   - Restart from every nonterminal status and every finalization/deletion progress step.
   - Verify no duplicated Task/member/attempt/artifact/command/evaluation/decision/continuation/Workflow family and no lost private ref.

6. Run mixed-harness launch and attribution coverage.
   - Exercise one wave containing Claude and Codex fixtures with their real launch builders.
   - Verify pinned SHA, model/effort, role prompt, hooks, and one scoped Mission MCP registration for each.
   - Verify Claude ask-channel all-or-none behavior and Codex MCP/hooks/trust all-or-none composition.
   - Verify an operator-started/uninstrumented Codex session cannot claim a member submission.
   - Verify packaged resolver paths before and after bundling.

7. Harden adversarial and resource controls.
   - Cover malicious repo paths, ref-looking ids, huge configs, huge intent/guidance/claims/results, binary/renamed/deleted files, prompt injection in every evidence field, symlink/worktree edge cases, missing refs, and corrupt JSON rows.
   - Prove all Git/process calls use argument arrays and generated ref namespaces.
   - Prove maximum members, concurrent members, waves, attempts, evaluator calls, duration, patch/prompt/result bytes, events, and detail pagination cannot be exceeded by config or driver output.
   - Prove destructive actions require human confirmation even when a fixture strategy asks to finalize automatically.
   - Document that local worktrees are isolated inputs, not a security sandbox.

8. Integrate Ensemble transitions with the existing alert engine.
   - Extend `AlertKind` and `AlertScope` in `src/shared/alerts.ts` with compact Ensemble summaries.
   - Emit attention alerts on a transition into `awaiting_decision` and actionable blocked/finalizing remediation.
   - Emit informational alerts on completion/cancellation/failure as appropriate for the existing Away digest policy.
   - Pass `ensembleSummaries` through App’s alert scope and the daemon Away watcher; update summary/digest wording once.
   - Edge-trigger by stable run/kind identity so reconnect/recovery does not alert repeatedly.
   - Add no separate notifier, poller, or preferences panel.

9. Make cost and provenance reporting honest.
   - Aggregate member agent cost from authoritative Session telemetry at the documented observation boundary and preserve per-member attribution.
   - Show evaluator runner/model/call count/duration/bytes always; show monetary cost only when authoritative.
   - Show linked Workflow review cost separately and label it as Workflow-owned rather than folding it into Ensemble evaluation.
   - Preserve unknown/missing telemetry as unknown, not zero.
   - Verify no brand/model identity leaked into the anonymous evaluator packet even though operator detail shows it.

10. Write operator and recovery documentation.
    - Update `README.md` with what Ensembles do, how to launch Best-of-N, explicit local resource fan-out, no-push candidate rule, human promotion, Workflow placement, and where to inspect/recover.
    - Add `docs/ensembles.md` covering states, artifacts/private refs, retention/deletion, costs, restart semantics, cancellation, restoration, failure remedies, security limits, and Preview-only baseline handoff.
    - Document that Workflow owns post-selection review and that neither Ensemble completion nor a rank-1 recommendation means approved/shipped.
    - Document exact v1 limits and how they are surfaced before launch.

11. Write the extension guide and repository guardrails.
    - Document the reusable axes separately:
      - roster/launch count: fixed, matrix, wave, adaptive;
      - information flow: isolated, shared artifact, critique, debate;
      - artifact adapter;
      - evaluation schedule: all-at-once, pairwise, panel, tests, aggregation;
      - advancement/barrier policy;
      - decision authority;
      - finalization outcome: select one/top K, synthesize, retain all, no consensus;
      - optional compatible Workflow placement.
    - Explain when a new approach is descriptor/config only, when it needs a new bounded driver/adapter/result renderer, and when a genuinely new operator authority must extend the action schema.
    - Update `AGENTS.md` with the strategy, driver, artifact, event/detail, TaskSummary/layout, MCP double-validation, Reset, ref retention, and Workflow ownership surfaces that must move together.
    - Include the “no strategy branch in EnsembleEngine” and “no Ensemble node in Workflow graph” invariants.

12. Run the release gate and packaging audit.
    - Run every focused suite from prior phases, then the complete gate.
    - Build all existing bundles and run smoke checks.
    - On macOS, run the local unsigned package build and verify:
      - `asar: false`;
      - `dist/mcp/server.mjs`, both satellites, daemon, web, main/preload, skills, and assets are present;
      - launched Claude/Codex processes resolve the packaged MCP path;
      - no source-only/test fixture is required at runtime.
    - Exercise a packaged or bundle-level restart flow with persisted nonterminal fixture data.

## 6. Data, API, and Migration Details

- No production schema, route, event, Session, or layout additions are permitted for the test-only strategy fixtures. If a fixture needs one, the reusable kernel contract is incomplete and must be corrected in its owning earlier phase.
- No test strategy id is appended to `ENSEMBLE_STRATEGY_IDS` or written by a production endpoint.
- Alert scope/event changes reuse compact `EnsembleSummary`; no detail or patch enters alerts/Away buffers.
- Documentation must name generated private-ref prefixes exactly as implemented and warn that explicit delete is irreversible.
- No new build entry point is expected. If implementation adds one anyway, update every package/build/path surface listed in `AGENTS.md`.

## 7. Tests and Verification

Focused release additions:

- fixed matrix, successive-halving/adaptive, pairwise, panel, synthesis, retain, and no-consensus fixtures;
- extension negative/source contract;
- unknown/downgraded strategy recovery;
- complete fault-injection/restart/race matrix;
- mixed Claude/Codex MCP/attribution;
- adversarial input/ref/path/prompt/cap cases;
- alert edge/digest/reconnect/Away behavior;
- cost/provenance distinctions;
- packaged resolver and file-presence tests.

Final commands:

```text
npm run typecheck
npm test
npm run build
npm run smoke
npm run package
```

If the implementation environment cannot produce the macOS package, the task must report that as an unverified release gate rather than silently omitting it.

## 8. Merge Criteria

- At least four materially different strategy fixtures execute through unchanged production persistence, engine, API shape, SSE summary, generic detail, and layout contracts.
- No fixture needs a Best-of-N branch or a new product surface.
- Every hard budget and human-authority boundary fails closed.
- Restart/race tests prove exactly-once durable identities and at-least-once idempotent effects.
- Claude and Codex member launches/submissions work through one packaged Mission MCP seam.
- Alerts, costs, evidence provenance, retention, and Workflow ownership are honest and documented.
- Typecheck, full tests, all bundles, smoke checks, and package verification pass or the release remains blocked with the exact missing proof.

## 9. Downstream Handoff Contract

After this phase, a future strategy should:

- add/extend a browser-safe descriptor and pure compiler;
- reuse existing stage/driver/adapter/action primitives wherever possible;
- add a bounded driver or result renderer only for genuinely new behavior/presentation;
- declare exact launch range, budgets, information flow, artifacts, evaluation, decision, finalization, and Workflow compatibility;
- add registry and extension-contract tests;
- require a separate product decision before becoming enabled.

It should not add a parallel multi-agent manager, database family, route family, EventSource, Session field, layout-specific state machine, or Workflow graph node.

## 10. Cross-Phase Compatibility Audit

Checked against repository baseline `57ea5bc` and Phases 1–7.

- Extends the existing shared alert/Away engine and authoritative cost conventions.
- Preserves append-only ids and packaged external MCP/hook paths.
- Keeps asar disabled and skills outside `dist`.
- Treats alternate strategies as injected tests, not permanent production ids.
- Turns the architectural extension promise into a merge-blocking test rather than documentation alone.
