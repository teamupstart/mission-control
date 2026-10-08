# Phase 2: Local plans and dependable task handoff

## Implementation baseline

This task owns its full scope below. Start from the merged planning PR and Phase 1 implementation; this planning
PR contains no settings, storage, prompt, skill, or test implementation. Earlier uncommitted
prototype work was excluded from delivery and must not be treated as a merged foundation.
Recheck the repository findings and adapt the proposed route while preserving the outcomes.

## Outcome and entry criteria

Let the operator retain complete plans outside Git and let future tasks find and consume the exact approved plans safely. Local planning finishes without an empty PR, while code and implementation-phase dependencies continue to require their normal publication by merge.

Read [plan.md](plan.md), [phased-plan.md](phased-plan.md), and the merged Phase 1 implementation first. This phase depends directly on this planning session's publication and Phase 1's merge. It changes only `mission-control`.

This is the proposed implementation route. Adapt names and factoring to the merged code, preserve the approved outcomes, and record material deviations and their reasons in the PR.

## Scope and non-goals

Own PS-06 and PS-08 through PS-11, extend PS-07 from durable previews to complete local bundles, and complete PS-12. Deliver the storage setting, local publication, precise task references, delivery context, completion/readiness, browser behavior, migrations, documentation, and tests together.

Do not add another writer, archive library, task-completion engine, or Foreman polling loop. Do not weaken ordinary task/session dependencies, auto-migrate tracked plans, reinterpret old task rows, or bypass an explicitly selected workflow. No remote synchronization, per-repository defaults, new general filesystem browser, or CI/release changes.

## Inherited contracts and source findings

- Phase 1 owns the namespace, immutable revisions, pinned policy, writer, scoped reader/preview, capture integration, and `commitPlanHtml` preference. Reuse the actual merged types and tools.
- `src/server/task-contract.ts` is used by both `src/server/dispatcher.ts` and live assignment in `src/server/tasks.ts`; implement discovery once there and supply context from both callers.
- `createMcpTask` in `src/server/routes.ts` resolves repository selectors and turns `dependsOnCurrentSession` into a task/session dependency. `src/mcp/server.ts` mirrors request schemas. Old schema-stripping behavior must not silently lose new plan references.
- `TaskDependency` in `src/shared/types.ts`, `declaredBlockers` in `src/shared/backlog.ts`, persistence in `src/server/db.ts`, and dependency reconciliation in `src/server/tasks.ts` share durable satisfaction semantics. The task-wide `satisfyDeclaredEdgesTo` helper is too broad for publishing one local plan.
- The current Plan Validation built-in includes a PR action. `WorkflowCompletionPolicy` concerns the Inspector gate, not generic task-publication semantics. Use current workflow run/receipt ownership and a suitable versioned validation graph rather than repurposing that policy union.
- `get_plan_publication_context` and `src/server/foreman/plan-publication.ts` guard current binding/version authority. Keep those guarantees when adding a storage-specific readiness contract.

## Implementation route

### 1. Enable the full-local policy through the existing owner

Add `planStorage: "repository" | "local"`, default repository, to the same saved skills config and patch owner used by Phase 1. Update its backup classification, API view, browser optimistic state, and search entry. Old values and historical plan rows remain repository-based; do not backfill them as local or approved.

Add the Plan storage control to Settings > Skills. In local mode, disable the HTML checkbox with a clear reason, retain its saved value, and return that value when the operator switches back. The effective artifact allowlist is empty in local mode regardless of the stored HTML preference. Render current destinations using daemon-resolved context rather than reconstructing state-home or repository paths in the browser.

Extend the pinned policy and writer from Phase 1 to place the complete bundle only in the local store. File bytes, source/phase links, revision identity, path validation, retry, and concurrency semantics do not fork by mode. Human-readable paths stay beneath `$MISSION_HOME/plans/<repo-name>/`, with the same collision-safe identity below that grouping directory.

For a newly dispatched plan task, reserve its plan identity and policy before binding its publication workflow, so workflow choice and the writer cannot observe different defaults. That reservation is the plan's creation boundary. Newly created plans in existing registered sessions resolve current defaults once; an incompatible existing workflow causes a visible refusal, not a silent rebind or storage-mode fallback.

### 2. Preserve human approval and publication provenance

Introduce a distinct local publication operation through the plan service. It consumes an immutable saved revision, an explicit human approval associated with that revision, current task/session work-episode attribution, and the exact applicable workflow submission/run. Saving or previewing a revision cannot mint this receipt.

Extend the managed review request contract so a `request_plan_decisions` review can be bound to plan id and revision. Require an explicit acceptance of the complete final bundle; do not equate dismissal, arbitrary option resolution, or an agent-written "approved" string with approval. If phasing or repair changes the bundle after an earlier approval, a new revision needs approval before it can publish. This is final-bundle review, not another recursive invitation to phase each phase.

Persist approval and publication receipts through the daemon ledger. A receipt records mode, repo identity, plan/revision, human review identity, work episode, and applicable binding/version/submission identity. A new revision, stale expected revision, replaced binding, paused/orphaned binding, failed workflow, missing evidence, or missing artifact must refuse publication. Repeated valid calls return the same receipt; a restart reconciles an owed publication without rerunning an already completed human decision or satisfying edges twice.

Keep publication ownership separate from storage readiness. Evolve the storage/readiness schema as a versioned contract; do not make an older strict `PlanPublicationContextSchema` consumer silently misread extra fields. Foreman's trusted policy and the agent's task appendix must render the same storage-aware completion rules.

### 3. Support validation without a plan-only PR

Introduce an explicit built-in local-plan validation workflow using the existing plan reviewers and an ordinary successful end, without the PR action. Append a new durable built-in id/version through the current catalog; never mutate a published workflow version. Select it through the existing default-resolution path for newly created local plan tasks, and expose the selection in the normal workflow UI.

After the exact eligible submission succeeds, a daemon-owned integration with the existing workflow completion notification verifies the plan revision and approval and records publication. Startup reconciliation covers the same obligation. The workflow manager retains execution ownership; the plan service owns the receipt and publishes no model verdict itself. Do not overload Inspector-specific `WorkflowCompletionPolicy`, add an independent scheduler, or infer success from a transcript.

An explicitly selected custom workflow stays selected. Validate compatibility before starting a local-only plan: PR-requiring graphs or unavailable authority are refused with an actionable explanation rather than silently skipping a PR node. Compatible review-only workflows can produce the same verified receipt. With no workflow selected, explicit human approval plus verified durable storage can publish through the same daemon service. Manual bindings wait for explicit workflow submission and completion.

Update `src/shared/task-completion.ts`, `src/server/plans/prompt.ts`, `src/server/task-contract.ts`, Foreman's client/worker policy inputs, and the appropriate workflow handoff surfaces together. Local plan-only completion does not demand commit/push/PR. Repository plans still do. A ship or other mixed code-and-plan task retains its existing handoff and code shipping workflow; a local artifact receipt never marks that task or its code dependencies complete. Repository-based or mixed-task plan prerequisites continue to wait for the normal planning-task publication condition where code changes must land first.

### 4. Add typed plan inputs and a narrow publication prerequisite

Extend task creation with bounded structured plan references: canonical repository association, opaque plan id, immutable revision, and relative Markdown paths for source, index, and phase. The task prompt remains a concise goal and pointers; do not paste phase documents into the recorded human objective.

Store those references durably using the existing task persistence/migration owner. Old tasks read an empty reference set. Preserve the references through backlog editing, dispatch, assignment, retries, restart, and task snapshots. Runtime readiness data must be derived from verified plan records; a browser or agent cannot declare a plan reference satisfied.

Use a versioned task-creation route or explicit capability handshake that cannot silently strip plan-reference fields when a new MCP bundle reaches an older daemon. Mirror all arguments in `src/shared/protocol.ts` and `src/mcp/server.ts`; include new/changed required capabilities in the built-bundle handshake and smoke coverage.

Introduce a distinct plan-publication prerequisite with an exact plan/revision identity and durable receipt. Keep the existing task/session merge-edge kinds and their meaning unchanged. Update exhaustive consumers, DB readers, cycle/limit validation, readiness selectors, task summaries, dependency UI, and server events/comparators as needed. Unknown future prerequisite types are not silently dropped or considered satisfied. A persisted receipt remains meaningful after an originating task row is pruned, while dispatch still verifies that the referenced bytes exist and match.

In local plan-only phasing, attach that artifact prerequisite instead of an impossible planning-session PR edge, plus the direct implementation-phase task dependencies. In repository mode, retain the planning-session merge edge and attach plan references as exact inputs. A mixed code-and-plan source retains its task merge prerequisite even when its plan bytes are local. Do not call `complete(..., satisfyDependents: true)` or the broad task-edge satisfaction helper merely because a local plan published.

Use the existing TaskManager completion/eviction path when a local plan-only task actually finishes. Do not add a cleanup path or use `state === "exited"` as durable completion. Retain plan store bytes through normal worktree return and task/session cleanup.

### 5. Resolve inputs and notify every receiving task

At task creation, verify that referenced repositories are in the intended primary/attached set and that each plan/revision exists in an authorized scope. Scheduled tasks may wait for publication; they may not point to an invented plan or silently change repositories. Reuse canonical repository preparation and reject ambiguous short names.

At both fresh dispatch and live assignment, resolve pinned inputs before provisioning/resetting the checkout or delivering the prompt, then revalidate at the delivery boundary. Reject missing, damaged, unpublished, or cross-scope inputs with a visible readiness reason. Do not fall back to a newer revision with the same title. Preserve exact revision consumption even when the repository's default-branch plan later changes.

Compose one small discovery appendix for all managed task kinds, listing repository `docs/plans/` and the correctly scoped local store for each attached repository. Explain how to read a pinned reference through the MCP reader when filesystem sandbox access is unavailable. Do not enumerate all plan contents or unbounded history in launch context. Sessions without pinned inputs still receive both locations for historical discovery; ambiguity is reported rather than guessed away.

Use existing SSE/state mechanisms for changed readiness and publication status; add exhaustive event handling if introducing an event. Do not create a new browser polling loop or depend on a model noticing a setting change. Any new Task field must be carried through its actual comparators, snapshot, DB mapping, and UI projection, not merely added to an interface.

### 6. Complete skills, review UI, and documentation

Update the static HTML Plans and Phased Plan skills to use returned storage policy and references. Local scheduling requires durable saved artifacts and final approval, then creates blocked phase tasks using the new typed references/prerequisite. Workflow validation may still be pending at scheduling time. Repository scheduling continues requiring pushed Markdown paths and a planning-session merge dependency.

Both paths report actual task ids and direct edges. Tool capability/refusal failures stop creation of dependent tasks, preserve already created ids, and never fall back to an empty phase brief or guessed path. Missing daemon access is not permission to write plans into Git.

Extend the existing scoped preview and plan metadata affordance to make repository versus local publication, exact revision, waiting-for-review/workflow, and a missing/corrupt input understandable. Preserve working relative phase links and archived reading after worktree cleanup. Use existing task dependency UI rather than a parallel readiness page.

Update `README.md`, `docs/skills-and-settings.md`, `docs/dispatch-and-backlog.md`, `docs/archives.md`, `docs/agent-guides/architecture.md`, and affected change contracts. Explain machine-local retention, both discovery locations, new-plan-only policy, workflow compatibility, and the difference between a settings backup and plan-content backup. Update referenced technical diagrams with the final merged flow.

## Data and compatibility requirements

- Defaults are repository storage and HTML false for all missing new fields. Existing unmanaged plans and old tasks keep their publication semantics; no inferred approvals or historical receipts are backfilled.
- Persisted vocabularies are append-only. Add migrations next to fresh schema definitions, and test old databases plus retained dependency rows after task pruning.
- The plan receipt satisfies only its exact publication prerequisite. Ordinary task/session edges, repository-mode merges, and phase-code merges keep their meaning.
- Current binding/version and exact submission evidence are rechecked before consuming a validation result. Pending, paused, missing, or incompatible bindings cannot be treated as unbound.
- Mixed code-and-plan tasks cannot avoid PR/merge through local plan publication. A local plan-only workflow may finish without any PR observation.
- The daemon owns storage, approvals, receipts, and DB writes. Foreman and MCP use HTTP. The main task lifecycle and archive owner remain unchanged.

## Verification and evidence

Extend the Phase 1 plan-store tests and add focused coverage for storage defaults/restore, all three policy combinations, same-name repositories, linked worktrees, concurrent saves, complete bundle survival after checkout removal, explicit approval/dismissal, stale revisions, idempotent publication, and restart after each publication boundary.

Exercise task-reference persistence, versioned MCP refusal against an older contract, repository scope enforcement, both task delivery seams, reference damage/missing files, plan-only receipt satisfaction, preservation of code merge edges, mixed tasks, and dependency state after source-task pruning. Relevant existing starting points are `test/plan-publication.test.ts`, `test/plan-completion-guard.test.ts`, `test/task-dependencies.test.ts`, `test/plan-prompt.test.ts`, `test/multi-repo-dispatch.test.ts`, `test/phased-plan-task-intent.test.ts`, `test/settings-backup-coverage.test.ts`, and `test/workflow-completion-http.test.ts`.

Extend `e2e/specs/plan-storage.spec.ts` and relevant `plan-kind`, `plan-contract`, and `cross-repo-plan-tasks` specs. Prove Settings > Skills local mode disables and preserves the HTML preference, the local rendered plan opens, a reviewed local plan can complete without a PR, and a dependent phase remains blocked until the correct publication and implementation prerequisites are satisfied. Use the built daemon and fake agents; do not spend model tokens. Include paused/failed workflow and corrupted-reference refusal paths in the layer best suited to them.

Use the repository's isolated single-file runner from AGENTS.md for focused tests. Run `npm run typecheck`, `npm run lint`, `npm run build`, `npm run smoke`, and the appropriate E2E checks; complete initial repository-required validation in proportion to the final code. During CI/workflow repair, use only issue-specific tests before pushing.

Register concise exact outputs and screenshots for PS-06 through PS-12. Include a lifecycle trace of the actual local publication receipt and the still-unsatisfied ordinary merge edge; a mocked UI label alone does not prove the dependency boundary. Keep evidence gitignored and register it through Mission Control.

## Merge and exit criteria

All source acceptance criteria are covered across both phases. The local option is usable from settings through plan review, durable retention, exact task creation, workflow validation, and task execution. No plan-only local flow waits for an empty PR, and no mixed/code flow is accidentally released. Old settings, plans, dependencies, and published workflows remain compatible.

Follow the assigned task's handoff for the implementation turn, then its authorized PR workflow. Keep the branch conflict-free and finish the later required review/CI follow-through. Completion of this phase leaves no separate integration or cleanup phase needed for the feature to operate.

## Downstream handoff

This is the final phase. Document the actual policy schema, managed tool contract, namespace/revision format, task-reference representation, publication receipt, workflow compatibility rules, and evidence commands. A later author must be able to distinguish a saved draft, approved revision, locally published plan, and merged repository plan without reading prompt prose.

## Cross-phase audit record

2026-10-06: Reconciled with Phase 1's pinned policy, writer, revision ids, preview, and archive adapter. Retained repository-only operation through Phase 1, then added the local setting and complete scheduling lifecycle together. Corrected the earlier generic publication wording: the current default plan workflow includes a PR action and needs an explicit local-compatible counterpart. Kept Inspector completion policy separate, and required plan-specific prerequisite receipts rather than broad task-edge satisfaction. Confirmed that local HTML exclusion never weakens code-merge dependencies or migrates tracked files.

2026-10-08: Restored this phase's full implementation scope for the operator-requested plans-only PR. Removed the prototype-baseline exception; the original task brief and direct dependencies remain unchanged.
