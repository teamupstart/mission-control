# Phased Plan: Pipeline Task Run Adoption and Card Visibility

## Goal

Make a managed Pipeline task's real provider run visible on its interactive Engineer host card, and safely repair the task binding when Engineer resumes an existing run instead of creating the prompt-derived reservation.

## Phase map

| Phase | Outcome | Non-test estimate | Dependency |
| --- | --- | ---: | --- |
| 1. Adopt and surface the task-owned Pipeline run | A launch-bound handshake can adopt a different observed run under strict ownership guards, `TaskSummary` carries the durable run, all host surfaces show a non-owning link, and the adopted provider projection settles the task. | 315 LOC | None |

One phase is intentional. Run adoption, task projection, visible attribution, and completion reconciliation are one atomic promise. No intermediate subset is independently safe to release.

## Phase 1 delivery contract

Read [phase-1-adopt-and-surface-pipeline-run.md](phase-1-adopt-and-surface-pipeline-run.md) before editing. The implementation must:

1. Reproduce the current managed-host card omission and mismatched resume binding in the built dashboard.
2. Preserve `Session.pipeline = null` on the interactive Engineer host.
3. Add a task-level `TaskSummary.pipelineRun` projection and distinct Board, rail, and Console affordances.
4. Add the launch-bound `adopt_pipeline_run` Mission MCP tool, hidden launch instruction, and stale-bundle preflight.
5. Derive task, repository, provider, and session authority on the daemon. Accept only the target slug from the agent.
6. Enforce observed-target, active-owner uniqueness, absent-current-reservation, exact-host, and idempotency guards.
7. Reuse the same guarded primitive for Terminal only under the current strong terminal-resource plus projected-worktree proof.
8. Keep provider projection as the sole completion authority and reconcile immediately after a valid adoption.
9. Add focused unit, route, rendering, and built Playwright coverage, plus desktop and narrow visual inspection.
10. Update `docs/pipelines.md`, then run the full verification bar.

## Scheduling contract

Schedule exactly one implementation task after these plan artifacts are merged to `main`:

- Agent: Codex
- Model: GPT-5.6-Sol
- Effort: high
- Repository: `ai-harness`
- Kind: Ship
- Backlog: enabled
- Dependencies: none after the planning pull request is merged

The task intent must point to `plan.md`, `phased-plan.md`, and the Phase 1 file. It must say that the phase is the proposed route, not an immutable specification: preserve the outcome and safety boundaries, adjust mechanics if current code or tests prove a better implementation, and document any material deviation in the pull request.

## Completion signal

The task is complete only when its implementation pull request is merged and the built browser journey proves that an interactive managed Engineer host links to the adopted existing run while the provider-driven worker stays separately clustered and the adopted processed projection settles the task.
