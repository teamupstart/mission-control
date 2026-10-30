# CodeRabbit workflow Commands: phased implementation

## Source and decisions
Authoritative source: [plan.md](plan.md). Operator discussion MC-caf4.1-MC-caf4.3 established that CodeRabbit remains a Command in Library, can be added to any workflow, needs durable output access and semantic result handling, and should be optional in No-Mistakes. The operator explicitly requested phased scheduling. This index does not reopen that selection.

The implementation documents are proposed routes; agents must verify against the merged repository and document justified deviations. The outcome and scope in plan.md remain fixed.

## Investigation and sizing
Estimated gross non-test production changes: **2,200-3,800 lines**, excluding documentation and tests.
- Phase 1: 1,100-1,900 lines across bounded artifact capture/storage/read service, command policy persistence/runtime and existing UI.
- Phase 2: 1,100-1,900 lines across executable/config integration, pinned comparison, structured results, custom workflow authoring and the No-Mistakes version.

Assumptions: reuse the existing supervisor, process/lease registry, artifact safety/retention primitives, workflow authorization, command CAS catalog and blocked recovery path. These are inspected source seams, not claims that the new APIs already exist. Tests are substantial because streaming, crash recovery, mutable policy, semantic completeness and browser/MCP authorization meet here.

Two phases are justified by independent operability: generic Command output/policy improvements can ship and be exercised without CodeRabbit. Combining durable output storage and lifecycle changes with third-party result interpretation and opt-in UX would make a single review substantially harder to verify. Splitting further by schema/server/UI would create dead surfaces or small cleanup phases, so each phase remains vertical.

## Phase table
| Phase | Outcome | Direct merge prerequisites | Owned requirements |
| --- | --- | --- | --- |
| [1: Command output and policy](phase-1-command-output-and-policy.md) | Bounded retained output with session/dashboard retrieval and configurable execution policy | Planning PR | R2, R3, generic R8/R9 |
| [2: CodeRabbit workflow integration](phase-2-coderabbit-workflow-integration.md) | Reusable opt-in CodeRabbit Command and new optional No-Mistakes stage | Planning PR; Phase 1 PR | R1, R4-R7, reviewer-specific R8/R9 |

Both phases touch only mission-control and produce one PR each. No context-only attached repository is required.

## Dependency graph and scheduling
Planning PR merge -> Phase 1 -> Phase 2.
Planning PR merge also directly gates Phase 2, because every task must receive published plan paths.

There is no implementation concurrency between phases. Phase 2 consumes Phase 1's artifact reader, capture sink, timeout/policy and action-required blocking contracts. Every task uses dependsOnCurrentSession true; Phase 2 additionally depends directly on the returned Phase 1 task id. Schedule after the exact required plan Markdown paths are committed/pushed and verified. Do not schedule an agent against unpushed checkout-only files.

Task ids are execution receipts reported in the planning session and PR, not guessed in these documents. Do not create duplicate tasks to fill this table.

## Cross-phase contracts
1. Wire kind remains check and existing persisted vocabularies are append-only.
2. The catalog is the single execution-config authority; complete-state writes use CAS and legacy writes preserve new fields.
3. Artifact ownership is attempt -> submission -> run -> repository. Short tails remain 4,000/2,000 bytes. Bodies never enter fleet SSE.
4. Proposed limits are raw 2 MiB/attempt, normalized findings 4 MiB and 1,000 records, combined retained command bodies 64 MiB/run, and 64 KiB/read. Structured record cap is 256 KiB. Truncation and availability are explicit.
5. Phase 1 provides generic timeout (nullable/default or 1 minute-2 hours), skip/block policies, artifact kinds stdout/stderr and attributed read_workflow_command_output. Phase 2 appends findings and CodeRabbit-specific configuration/interpretation.
6. Existing slot defaults remain unchanged. CodeRabbit's fresh defaults are 45 minutes, major threshold, 21 executions and block-on-required-unavailability/exhaustion. No repository is opted in automatically.
7. The runtime/supervisor remains the sole launch/teardown path. Incomplete reviews are not code-defect verdicts.
8. CodeRabbit comparison identity is frozen per submission and reused for retry. New repair submissions refresh head/base; dirty submissions cannot be passed using an older commit.
9. False positives are reasoned operator decisions using existing explicit controls, never silent verdict rewrites.
10. Built-in versions/bindings are immutable; custom workflows are independent of No-Mistakes identity.

## Coverage and compatibility audit
R1: Phase 2 catalog and arbitrary-workflow E2E.
R2: Phase 1 streaming/retention/MCP/UI E2E, consumed by Phase 2 findings.
R3: Phase 1 policy migration, CAS, timeout and blocked recovery tests.
R4: Phase 2 parser truth table and repair-vs-block tests.
R5: Phase 2 no-rule/no-subprocess and per-repository isolation tests.
R6: Phase 2 pinned comparison, dirty refusal, new-head repair and allowance tests.
R7: Phase 2 immutable-version/binding tests and No-Mistakes E2E.
R8/R9: generic ownership, authorization and recovery remain Phase 1 responsibilities; Phase 2 verifies reuse with CodeRabbit. There is no duplicate requirement owner or unowned final acceptance case.

2026-10-30 final reconciliation: reviewed the root and both phase files in dependency order. Root limits, typed CodeRabbit rule, committed scope, no-auto-spend policy, operator false-positive decision and required-vs-optional semantics agree. The Phase 1 read API uses immutable opaque ids; Phase 2 does not depend on discarded raw output. No earlier phase needs later code to pass. No concurrent phase pair is claimed.

## Verification and publication
Each phase owns its documentation, migrations, tests and UI runtime verification. Run the repository's isolated unit suite, typecheck, lint, build, smoke and E2E as described in the phase documents. Fake all agent/CodeRabbit/GitHub paths. Keep evidence out of Git.

Repository plan policy is storage=repository and commitPlanHtml=false. Only plan.md, phased-plan.md and the two phase Markdown files are published in the planning PR. The eight-file Markdown/HTML bundle is saved as one managed revision; HTML remains in the retained preview store. The investigation report is excluded from commits.

The planning task opens a PR only while publication ownership remains skill. If ownership changes to workflow, register complete plan evidence and yield to that owner. Existing user authorization permits scoped commit/push/PR creation; it does not authorize merge. Plan tasks remain blocked until publication by merge, then Phase 2 additionally waits for Phase 1's merge.
