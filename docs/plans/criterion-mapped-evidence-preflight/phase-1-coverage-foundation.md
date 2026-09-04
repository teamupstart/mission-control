# Phase 1: Coverage foundation

## Outcome

Authors can declare which evidence proves each material acceptance criterion, stage those claims through the dashboard or `submit_workflow_evidence`, freeze the claims with the immutable submission, and inspect a deterministic readiness result. Every workflow remains non-blocking in this phase because all existing and built-in workflow versions resolve `evidenceReadinessPolicy` to `off`.

This phase creates the durable contracts and one complete authoring-to-inspection slice that Phase 2 can safely enforce.

## Repository references

This phase is grounded in:

- [`plan.md`](plan.md)
- [`phased-plan.md`](phased-plan.md)
- [`../../reports/test-evidence-auditor-first-pass/report.html`](../../reports/test-evidence-auditor-first-pass/report.html)
- `AGENTS.md`
- `docs/agent-guides/architecture.md`
- `docs/agent-guides/change-contracts.md`
- `docs/workflows.md`
- `e2e/README.md`

The phase file is a proposed route, not a substitute for repository judgment. Preserve the outcome and cross-phase contracts when the current code suggests a better local implementation.

## Entry criteria and dependencies

- Direct dependency: the planning PR containing this file is merged.
- No implementation phase dependency.
- Work only in the Mission Control repository.
- Begin from the then-current default branch and preserve unrelated changes.

## Scope

1. Add stable proof-class, proof-role, coverage-claim, readiness-result, and policy contracts.
2. Add mutable coverage staging and immutable submission coverage/readiness persistence.
3. Extend evidence registration and reservation so items and coverage freeze atomically.
4. Extend the existing configurable Workflow context call with bounded change and evidence metadata.
5. Add deterministic reconciliation and proof-shape validation.
6. Add dashboard authoring and read-only submission inspection.
7. Keep enforcement off for every workflow version.

## Non-goals

- Do not add a wait state, delivery kind, resumption path, or operator override.
- Do not publish a new No-Mistakes Review version.
- Do not count readiness as Auditor acceptance.
- Do not add another model job or Settings row.
- Do not run commands or capture screenshots on the author's behalf.
- Do not change Test Evidence Auditor guidance in this phase.

## Repository findings

### Shared evidence identity

`src/shared/workflow.ts` already defines staged image/text records and command evidence locators around caller-stable `clientItemId`. Coverage links must use that public identity, not internal staging IDs, paths, or generated submission evidence IDs.

### Evidence registration boundary

`SubmitWorkflowEvidenceSchema` in `src/shared/protocol.ts` validates the MCP payload and currently rejects calls without an image, artifact, or command output. Extend the at-least-one rule so coverage-only registration is valid. Keep existing callers source-compatible.

### Evidence persistence and capture

`src/server/db.ts` owns schema upgrades. `src/server/workflows/store.ts` owns staging generations, reservation, finalization, strict row parsing, export, pruning, and reset. `src/server/workflows/images.ts` owns the filesystem-safe evidence pipeline even though it now handles text too. Extend these owners rather than introducing a second registry.

### Context compaction

`src/server/workflows/context.ts` currently emits `constraints` and `acceptanceCriteria` from the raw goal, refined goal, and human decisions. Its `RawWorkflowContext` already carries diff and evidence. Extend the prompt with bounded changed paths, a clipped diff summary, evidence captions, and author claim metadata. Preserve the existing 45-second structured-call policy, retry behavior, runner/model ledger, and fallback.

### Browser authoring

`src/web/workflows/WorkflowEvidenceComposer.tsx` is shared by initial binding, submission confirmation, Work Queue, and run actions. Its controller already loads staged evidence through session/binding routes and produces upload locators. Coverage belongs in this controller and component so every entry surface stays consistent.

### Run detail

`WorkflowRunDetail` already returns submissions and grouped evidence images. Add bounded readiness and coverage projections per submission. Avoid expanding fleet-wide run summaries with full criterion text.

## Stable contract design

### Policy

Append:

```ts
type WorkflowEvidenceReadinessPolicy = "off" | "criterion_mapped_v1";
```

Add it to workflow definitions, immutable versions, duplicate/create/update/publish schemas, run-pinned projections, exports, and built-in source declarations. Old rows and new custom workflows default to `off`. Every No-Mistakes Review version through version 11 explicitly remains `off`.

Do not expose an enforcing choice in the workflow editor during Phase 1. Create and duplicate default to `off`, all built-in literals remain `off`, and publish validation refuses an unsupported non-off draft until Phase 2 supplies the lifecycle. The persisted enum is established now so Phase 2 consumes one contract without letting Phase 1 publish a promise it cannot enforce.

### Proof classes and roles

Append-only values:

```ts
type WorkflowEvidenceProofClass =
  | "focused_execution"
  | "integration"
  | "visual"
  | "performance"
  | "rendered_artifact"
  | "state_confirmation";

type WorkflowEvidenceProofRole =
  | "execution"
  | "rendered_output"
  | "baseline_measurement"
  | "result_measurement"
  | "deliverable"
  | "state_snapshot";
```

Keep the version 1 proof-shape matrix in a shared, browser-safe pure function. It must return required roles and structural gaps without importing Node modules.

### Author coverage claim

Use a bounded structure equivalent to:

```ts
interface WorkflowEvidenceCoverageClaim {
  clientCriterionId: string;
  criterion: string;
  proofClass: WorkflowEvidenceProofClass;
  repositoryScope: WorkflowEvidenceRepositoryScope;
  links: Array<{
    clientItemId: string;
    role: WorkflowEvidenceProofRole;
  }>;
}
```

Enforce limits for claim count, criterion bytes, links per claim, unique criterion IDs, unique item/role pairs, and aggregate JSON bytes. Use one shared limit source for protocol, database validation, and browser error messages.

### Canonical readiness result

Persist and project a bounded result with:

- Evaluator version.
- Status: `not_evaluated`, `ready`, `gaps`, or `unavailable` in Phase 1.
- Canonical criterion ID and text.
- Matched `clientCriterionId` or null.
- Author proof class.
- Model-suggested proof class and warning when different.
- Linked evidence identities and roles.
- Deterministic gap codes.
- Compaction error metadata already allowed by the context snapshot.

Do not store prompt text, artifact bodies, absolute paths, or unbounded model rationale in readiness JSON.

## Persistence and migration

### Mutable staging table

Add `workflow_evidence_coverage_staging` with:

- `id`
- `note_key`
- `client_criterion_id`
- `criterion`
- `proof_class`
- `repository_scope`
- `links_json`
- `episode_key`
- `generation`
- `state`
- `reserved_group_key`
- `created_at`
- `updated_at`

Use a unique key on `(note_key, client_criterion_id)` and reservation indexes matching evidence staging. A claim update must identify every old and new repository scope affected and advance the existing owner/scope generation accordingly.

### Immutable submission table

Add `workflow_submission_evidence_coverage` keyed by submission plus client criterion ID. Freeze criterion, proof class, repository scope, links, generation, and timestamps. Link resolution happens against evidence reserved for the same submission.

Add a nullable bounded `readiness_json` column to `workflow_submissions`. Null means a historical submission or a submission captured under policy `off` with no coverage to evaluate; it does not mean ready. Coverage supplied while enforcement policy is `off` still produces an advisory readiness result. Phase 2 must never interpret null as ready under `criterion_mapped_v1`: absent coverage under that policy becomes a deterministic `missing_coverage` gap before activation.

### Workflow policy columns

Add non-null policy columns with safe `off` defaults to authored definitions and versions. Because built-ins are application data, add the value to their literal version source and duplicate seed as well as database rows.

### Lifecycle maintenance

Extend:

- Reservation rollback and stale-reservation recovery.
- Evidence deletion, pruning, and episode reset.
- Run deletion and retention.
- Settings backup/restore where workflow definitions are included.
- Workflow export and strict corruption reporting.

No new table may retain coverage after its owning evidence or submission is deleted.

## Context compaction and reconciliation

### Prompt input

Keep the current intent fields and add only bounded metadata:

- Changed paths with status and truncation flag.
- A clipped diff summary sufficient to distinguish changed components and visible behavior, not the full 800 KiB diff.
- Evidence `clientItemId`, kind, caption, repository scope, and command exit code where applicable.
- Author coverage IDs, criterion text, declared class, scope, and link roles.

Explicitly fence this JSON as untrusted change/evidence metadata. Do not include evidence source locators, local paths, or artifact content.

### Structured response

Extend `CompactionSchema` with canonical criteria containing text, materiality, advisory proof class, and matched author claim IDs. Preserve constraints. Assign canonical IDs after parsing in deterministic code using normalized criterion text plus ordinal; never accept model-supplied IDs as durable identity.

### Fallback

Any spawn, timeout, parse, schema, or classification failure returns the current deterministic context plus readiness `unavailable`. Workflow activation is unchanged in Phase 1 and later phases must also treat unavailable as non-blocking.

### Deterministic validation

Implement a pure evaluator that:

1. Resolves claim links only to items frozen in the same submission.
2. Enforces repository scope compatibility.
3. Finds missing canonical mappings and duplicate matches.
4. Applies required roles from the author's declared proof class.
5. Records model/author class disagreement as a warning only.
6. Allows extra evidence without applying it to an unrelated claim.
7. Produces stable gap codes and ordering.

A non-UI claim never requires `rendered_output` unless the author declares `visual`. If the model suggests visual and the author does not, persist a warning for the author and Auditor; do not hard-block or rewrite the declaration.

## API and server work

### MCP registration

Extend `src/mcp/server.ts`, `src/shared/protocol.ts`, `src/server/routes.ts`, and `src/server/workflows/agent-contract.ts` so `submit_workflow_evidence` accepts `coverage` and documents its link semantics. Regenerate the MCP bundle through the repository generator/build path. Do not hand-edit generated outputs.

Agent staging remains authenticated and session-derived. The caller cannot name a note key, task, episode, source root, internal submission ID, or repository outside its issued scopes.

### Dashboard routes

Widen the existing session and binding evidence list responses to include staged coverage. Add bounded create/update/remove behavior through the current evidence endpoints or one adjacent evidence-coverage route when method clarity requires it. Preserve idempotency by `clientCriterionId`.

### Capture

Reserve coverage in the same transaction as evidence. After safe item capture, freeze coverage links, compact context, evaluate supplied coverage, and store the bounded result before setting the submission runnable. In this phase, policy `off` means the result is advisory; no result affects activation. A submission with no coverage retains null readiness for backward-compatible cost and display behavior only while the pinned policy is `off`. Phase 2 owns synthesizing `missing_coverage` before enforcing `criterion_mapped_v1`.

## Dashboard work

Extend `WorkflowEvidenceComposer` with accessible criterion rows:

- Criterion text.
- Proof-class selector.
- Repository-scope selector.
- Evidence-link controls grouped by required role.
- Immediate missing-role messages from the shared matrix.
- A visible warning that canonical reconciliation occurs during capture.

Coverage-only drafts may be saved even while incomplete. Submission confirmation must not pretend the provisional composer check is semantic acceptance.

Extend run detail to show the frozen coverage and readiness result for the selected submission:

- Canonical criteria and author claims.
- Linked evidence chips.
- Missing-role and scope gaps.
- Model suggestion warnings.
- `Unavailable` with the compaction failure summary.

Do not place full criteria on fleet cards or SSE run summaries.

## Files and components expected to change

- `src/shared/workflow.ts`
- `src/shared/protocol.ts`
- `src/shared/llm-jobs.ts` only if descriptions need clarification; no new job ID
- `src/server/db.ts`
- `src/server/workflows/store.ts`
- `src/server/workflows/images.ts`
- `src/server/workflows/context.ts`
- `src/server/workflows/manager.ts`
- `src/server/workflows/agent-contract.ts`
- `src/server/workflows/builtin-workflows.ts`
- `src/server/routes.ts`
- `src/mcp/server.ts`
- `src/web/workflows/WorkflowEvidenceComposer.tsx`
- `src/web/workflows/WorkflowProperties.tsx` only if compatibility copy is required; do not expose enforcement yet
- `src/web/workflows/WorkflowRuns.tsx`
- `src/web/lib/api.ts`
- `src/web/styles.css`
- Focused tests in `test/` and one new Playwright spec in `e2e/specs/`
- `docs/workflows.md`, `docs/models.md`, and change-contract documentation relevant to the new frozen fields

Treat this as an inventory, not authorization to edit unrelated code. Follow actual ownership discovered during implementation.

## Tests

### Shared and model contracts

- Legacy evidence calls parse unchanged.
- Coverage-only and evidence-plus-coverage calls parse.
- Duplicate IDs, invalid roles, oversized criteria, oversized link sets, and aggregate overflow fail at the shared boundary.
- Every proof class returns the exact version 1 required roles.
- Model schema is valid for Claude and Codex structured output.
- The same configured Workflow context runner/model is recorded after the schema expansion.
- Model disagreement creates a warning, never a visual requirement.
- Compaction fallback produces `unavailable` without preventing activation.
- Null readiness is never treated as ready; the Phase 2 enforcement contract converts absent coverage under `criterion_mapped_v1` into `missing_coverage`.

### Database and evidence lifecycle

- Existing databases migrate with policy `off` and null readiness.
- Coverage staging is idempotent and advances only affected generations.
- Evidence and coverage reserve, finalize, and roll back atomically.
- Stale, cross-submission, and cross-repository links are refused.
- Reset, pruning, deletion, export, and restore leave no orphaned coverage.
- Strict row parsing reports corrupt enums and oversized JSON without hiding unrelated runs.

### Server and browser

- Agent registration derives authority and repository scopes server-side.
- Dashboard create/update/remove uses stable client IDs.
- Run detail returns frozen coverage only for the selected submission.
- Playwright creates a focused non-UI criterion, links command evidence, submits, and verifies no screenshot is requested.
- Playwright creates a visual criterion without rendered output and sees a provisional missing-role message.
- Capture shows the immutable readiness mapping in run detail while the workflow still activates normally because policy is off.

Use semantic roles, labels, and placeholders. Do not add `data-testid`.

## Verification commands

Select focused files based on the actual implementation. At minimum:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/llm-job-execution.test.ts test/workflow-image-evidence.test.ts test/workflow-agent-evidence-binding.test.ts test/workflow-store.test.ts
npm run typecheck
npm run lint
MISSION_TEST_CONCURRENCY=8 npm test
npm run build
npm run smoke
npm run test:e2e -- e2e/specs/workflow-evidence-readiness.spec.ts
```

Capture and register the exact focused output plus screenshots of the non-UI and visual composer states after the final run.

## Merge and exit criteria

- All new persisted values are additive and old rows read as policy off with no readiness result.
- No workflow version can publish an enforcing policy before Phase 2 implements its lifecycle.
- Dashboard and MCP can stage the same bounded coverage structure.
- Coverage and evidence freeze atomically into one submission.
- The existing configurable Workflow context job returns canonical criteria and advisory proof suggestions from bounded inputs.
- Deterministic evaluation is inspectable but cannot pause a workflow.
- A non-UI declaration does not request a screenshot because of model opinion alone.
- Run detail shows immutable coverage/readiness without inflating fleet summaries.
- Focused, full, build, smoke, and Playwright verification pass.
- The phase pull request is reviewable and independently mergeable.

## Downstream handoff

Phase 2 may rely on:

- Frozen policy, proof-class, proof-role, coverage, gap-code, and readiness shapes.
- Atomic evidence/coverage reservation and immutable capture.
- Persisted readiness results with `ready`, `gaps`, and `unavailable` semantics.
- `parent_submission_id` remaining the single submission lineage relation.
- Model suggestions remaining advisory.

Phase 2 must not rename these values, add a second coverage store, change model-only warnings into hard requirements, or overload SessionAction continuation fields.

## Cross-phase audit record

- 2026-09-03: Reused `parent_submission_id` and reserved the new reason field for Phase 2 instead of defining a second parent column.
- 2026-09-03: Assigned all coverage identity, matrix, compaction, and persistence shapes to this earliest consumer-owning phase.
- 2026-09-03: Kept policy enforcement and built-in opt-in out of Phase 1 so its migration and authoring slice can merge without changing workflow execution.
- 2026-09-03: Added a publish guard for non-off policy values so the foundational phase cannot publish unenforced behavior.
