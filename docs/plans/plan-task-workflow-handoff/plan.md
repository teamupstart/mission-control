# Plan task PR ownership

Status: implemented in this worktree on 2026-09-15 after the operator approved implementing the proposed fixes. Publication remains deferred to the task completion handoff. The initial investigation is retained in `docs/reports/plan-task-workflow-handoff/report.html` as a historical report.

## Desired behavior

A plan task with a bound workflow finishes its planning work and yields. Foreman starts the selected workflow at its normal completion boundary, and the workflow owns PR creation. Without a bound workflow, the phased-plan skill creates the planning PR itself.

Publication still matters: implementation tasks must remain blocked until the planning artifacts land on the default branch. Finishing the planning turn, passing the review workflow, opening a PR, and merging it are separate events.

## Why a skill edit alone is insufficient

The investigation baseline at `c25b29ef` contained three conflicting pieces:

- `skills/phased-plan/SKILL.md` requires committing and pushing before scheduling, then unconditionally opening a PR and monitoring it.
- `src/server/plans/prompt.ts` tells every plan task to commit and expect a PR. `src/shared/task-completion.ts` gives plan tasks no trusted completion boundary, so Foreman's verifier receives no policy deferring PR work.
- `src/server/workflows/builtin-workflows.ts` defines Plan Validation v1 with four judges and no PR action. Its completion policy is also `none`.

Foreman's workflow claim already uses the current active binding. It runs after completion verification. The implementation repairs the contract feeding that path and supplies the missing PR stage. It reuses the existing workflow trigger.

## Alternatives

| Approach | Benefit | Limitation | Effort |
| --- | --- | --- | --- |
| Edit only phased-plan | Stops its explicit instruction to create a PR when bound | Leaves conflicting delivered instructions, no verifier deferral, and no PR stage in Plan Validation | Small; incomplete |
| Align skill, trusted completion policy, and Plan Validation | Delivers both requested ownership paths and keeps the publication gate | Requires coordinated contract and workflow-version tests | Medium; recommended |
| Make all plans use the Ship handoff | Reuses unconditional deferral to Mission Control | Moves unbound PR creation out of the skill and conflicts with its push-before-scheduling gate | Medium; different behavior from the request |

## Accepted contract

Use one server-owned decision for plan publication ownership. Represent the current state explicitly as workflow-owned, skill-owned, or unavailable. Resolve it from Mission Control's selected task workflow at delivery and authoritative active binding at runtime. An unavailable binding read must not mean no workflow.

Do not use Persona evidence eligibility as the ownership test. Workflows without Personas still own their PR behavior. Likewise, no workflow run yet does not mean no binding: a binding can be waiting for this very turn to finish.

The shared completion-policy resolver should accept this plan-specific context. Ship and Bugfix keep their existing kind-based contract. The plan prompt and Foreman's trusted verification policy must render the same plan boundary and deferred-action set.

| State | Initial planning turn | PR owner |
| --- | --- | --- |
| Automatic workflow bound | Approve/refine the plan, finish artifacts, commit and push before scheduling, create requested dependent tasks, register applicable plan evidence, then end the turn | Workflow PR action after successful review |
| No workflow bound | Same planning and scheduling work, then create the PR and follow its checks under existing authorization | Phased-plan skill |
| Manual workflow bound | Finish planning and yield; retain the manual submission boundary | Workflow after manual submission |
| Binding state unavailable or changed | Refresh authoritative context before taking publication action | Never infer an unbound direct path from a failed read |

For workflow-owned plans, defer PR creation/update, PR review follow-through, CI waiting, and merge out of the initial turn. Do not blindly copy Ship's commit/push deferral: phased-plan currently needs pushed artifacts before it creates path-only tasks. Retain that durability requirement in this scoped fix. A later workflow PR action can commit any review repairs before publishing the PR.

The plan completion requirements must include actual human review and incorporated decisions, valid Markdown and HTML, requested phases and task IDs, the audited dependency graph, and any applicable plan-text evidence. If the human declines phasing, phase files and tasks are not required. A dismissed review is not approval. Missing required planning work remains blocking; the deferred PR alone does not.

## Implementation

### 1. Establish authoritative ownership context

Extend the existing Workflow manager's binding projection and task contract inputs, rather than storing a second workflow flag. Both delivery seams in `src/server/dispatcher.ts` and `src/server/tasks.ts` already use `withTaskKindContract`; its plan branch now reads the selected task workflow without a second stored flag.

Foreman should read the current binding context before verifying and recheck binding identity/version and ownership after verification, before consuming the work generation. Reuse its existing freshness discipline. If a workflow selected at delivery failed to bind, surface that failure instead of silently treating the task as unbound.

Expose a narrow read-only Mission Control MCP projection of this same completion context for the skill to refresh immediately before direct PR work. The implemented tool is `get_plan_publication_context`, backed by the shared `PlanPublicationContextSchema` and authenticated `/mcp/plan-publication` route. Foreman reads the same projection at `/api/sessions/:id/plan-publication`. It must resolve the calling session server-side, use the Workflow manager's active binding, and avoid agent reads of SQLite. It also lets a manually invoked skill honor an active binding without guessing from transcript text. Binding changes during an already-running external PR operation are not made atomic by a read; preserve existing workflow ownership restrictions and explicitly test refusal before the direct action starts.

### 2. Align prompt, verifier, and skill

Add the plan-specific completion contract in `src/shared/task-completion.ts` and render it in `src/server/task-contract.ts` / `src/server/plans/prompt.ts`. Generalize the verifier's implementation-only wording in `src/server/foreman/queue-prompt.ts` so it can judge planning deliverables without requiring application code.

Update the repository source `skills/phased-plan/SKILL.md`, not the installed application copy. Preserve the commit/push, exact-path verification, and `dependsOnCurrentSession: true` requirements. Split the final shipping section by authoritative owner: yield with artifact paths and the phase-to-task map when bound; invoke the PR skill directly when unbound. Respect stronger explicit no-PR instructions and any task handoff that defers publication.

### 3. Append Plan Validation v2

Keep v1 immutable. Append a new version with the existing review stages followed by the existing `builtin:pull-request` Session Action, then End. Keep code checks out of this planning workflow. Update the current description and graph expectations to match.

Use the existing Session Action's PR proof and continuation mechanisms. Do not add an unconditional PR injection after arbitrary workflows end. Custom workflows own their authored behavior; a custom graph without a PR action must be corrected explicitly when publication is wanted.

### 4. Preserve publication and roll out deliberately

Keep phase-task dependencies unsatisfied after the planning handoff, successful review, and PR opening. Normal observed merge remains their release signal. Workflow completion does not authorize merging.

New bindings should select Plan Validation v2. Existing bindings stay pinned to v1 until explicitly upgraded or rebound. Existing custom copies remain custom. Recovering a previously held task needs a fresh completion opportunity or explicit workflow submission under its current lifecycle; do not clear consumed-generation guards as a shortcut.

Update `docs/dispatch-and-backlog.md`, `docs/foreman.md`, the architecture completion-contract section, and relevant workflow/skill documentation. Propagate the skill source through the normal application packaging and skill reconciliation process.

## Flow

Shared preparation: human-reviewed plan → write and audit artifacts → commit/push and verify named paths → schedule dependency-linked tasks if requested.

With a bound automatic workflow: prepared plan → end planning turn → Foreman verifies the plan boundary → claims the existing binding → plan judges → verified PR Session Action → End. Authorized merge later publishes the paths and releases dependent tasks.

Without a binding: prepared plan → phased-plan refreshes ownership → PR skill creates the PR and follows checks. Authorized merge later publishes the paths and releases dependent tasks.

## Acceptance and verification

| ID | Required proof |
| --- | --- |
| PLAN-BOUND | A bound plan whose goal mentions a PR can finish with approved artifacts and requested scheduling but no PR. Its delivered prompt and trusted verifier policy agree; Foreman claims the existing workflow once. |
| PLAN-DIRECT | With a confirmed absent binding, the skill retains direct PR creation. Ship/Bugfix and personal-session completion behavior remain unchanged. |
| PLAN-PUBLISH | The skill still requires pushed, resolvable artifacts before scheduling. Tasks remain blocked through review/PR opening and release on observed merge. |
| PLAN-GRAPH | Plan Validation v2 contains the existing judges followed by the PR action; v1's graph and persisted identity are unchanged. |
| PLAN-CONTEXT | Manual bindings do not auto-run. Persona-free bindings still defer PR work. Failed reads and binding changes cannot silently select the direct path. |
| PLAN-INCOMPLETE | Missing approval, missing requested phase/task artifacts, unresolved plan contradictions, or missing applicable evidence remain blocking. Declined phasing creates no task requirement. |

Extend focused tests in `test/task-completion.test.ts`, `test/plan-prompt.test.ts`, `test/skills-catalog.test.ts`, `test/dispatcher-runtime.test.ts`, `test/task-assign.test.ts`, `test/workflow-foreman-claim.test.ts`, `test/builtin-workflows.test.ts`, and `test/phased-plan-task-intent.test.ts`. Cover the new read-only context projection with isolated route/tool tests. Use a stub verifier to prove orchestration separately from assertions about prompt text. Add a fake-agent Playwright case for the visible Plan Validation graph and PR stage, following `e2e/README.md`.

Run focused tests with the repository's prescribed test loader, plus typecheck and lint. Because the implementation changes runtime contracts and a visible built-in graph, run build, smoke, and the relevant Playwright spec. Implementation checks are recorded below; the investigation report describes the earlier source baseline.

## Implementation evidence and limits

The final focused regression run passes 227 tests across 17 files covering delivery, context reads, verifier freshness, immutable workflow versions, phase publication dependencies, and the existing completion-claim route. The integration test supplies a verifier verdict, then exercises a real work cycle and HTTP claim: a plan whose goal requests a PR starts exactly one bound workflow before a PR exists. This proves orchestration; it does not simulate or score model reasoning.

All five cases in the review-presets Playwright spec pass. The updated case verifies the built Plan Validation v2, its review order, three stages, and reachable Pull Request stage. Build, bundle smoke, typecheck, and lint pass. The route-surface fixture is regenerated and replayed normally. Focused logs and a rendered PR-stage screenshot are registered as workflow evidence rather than committed.

The original incident's exact held verdict or execution history was not inspected. No installed application copy, live task binding, or custom workflow was altered. Existing bindings remain pinned to their immutable version; v1 owners need an explicit upgrade or rebind to gain the new PR stage. The skill source ships through the normal application packaging and reconciliation path.

A read cannot make an already-running external PR operation atomic with a later binding edit. The skill refreshes immediately before publication, and Foreman rejects changed or unreadable ownership around verification. Unknown context never grants the direct path. Custom workflows remain responsible for containing their desired publication action.

The work ends at this task's implementation handoff, without committing, pushing, creating a PR, or scheduling implementation tasks for this fix.
