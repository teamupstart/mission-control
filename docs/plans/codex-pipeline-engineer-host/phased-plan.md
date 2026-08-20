# Phased Plan: Codex Pipeline Engineer Host

## Goal

Let operators dispatch an AI Conductor Pipeline task through a managed Claude or Codex SDK host, selected per task, without requiring `conduct-ts engineer` on the managed path.

## Phase map

| Phase | Outcome | Non-test estimate | Dependency |
| --- | --- | ---: | --- |
| 1. Provider-neutral Pipeline Engineer host | The Dispatch UI, persisted runtime, and server launch contract all honor Claude or Codex as `task.agent`, with safe Terminal compatibility and full regression coverage. | 190 LOC | None |

One phase is intentional. All changed surfaces participate in the same launch promise, and no independently releasable boundary exists between selecting the host and launching it.

## Phase 1 delivery contract

Read [phase-1-provider-neutral-pipeline-engineer-host.md](phase-1-provider-neutral-pipeline-engineer-host.md) before editing. The implementation must:

1. Reproduce the current disabled-Agent Pipeline experience in the built dashboard.
2. Migrate the managed runtime name from legacy `claude-sdk` input to canonical `agent-sdk` output.
3. Derive eligible managed Pipeline hosts from shared SDK and skill capabilities.
4. Make `task.agent` authoritative in managed Pipeline dispatch.
5. Invoke Engineer with the selected agent's native skill grammar and preserve the task intent bytes.
6. Keep the Terminal path explicit, Claude-only, and unchanged at the `conduct-ts engineer --idea` boundary.
7. Keep model, effort, downstream Conductor routing, and provider-owned completion unchanged.
8. Add unit, HTTP, and Playwright coverage before updating user-facing documentation.
9. Finish with typecheck, lint, unit tests, build, and focused E2E tests.

## Scheduling contract

Schedule exactly one implementation task after these plan artifacts are merged to `main`:

- Agent: Codex
- Model: GPT-5.6-Sol
- Effort: high
- Repository: `ai-harness`
- Kind: Ship
- Backlog: enabled
- Dependencies: none after the planning pull request is merged

The task intent must link all three Markdown plan files and repeat the non-negotiable boundaries: no AI Conductor source change, no managed-to-Terminal fallback, no Recurring Missions work, and no change to provider-owned completion.

## Completion signal

The implementation task is complete only when its pull request is merged and the built UI proves a Codex Pipeline dispatch starts the fake Codex SDK with the Engineer skill invocation and original task intent.
