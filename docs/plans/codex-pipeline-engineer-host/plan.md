# Codex Pipeline Engineer Host

## Outcome

Mission Control will let an operator choose Claude or Codex as the managed Engineer host when dispatching a Pipeline task. A Codex Pipeline dispatch will start a managed Codex SDK session and invoke the installed Engineer skill with the task intent. It will not run `conduct-ts engineer`.

This plan changes Mission Control only. AI Conductor already exposes the Engineer skill and the deterministic `conduct-ts` primitives that the skill uses after launch. Conductor's downstream implementation agent, model, effort, daemon supervision, provider projection, and completion ownership remain independent of the Mission Control host choice.

## Why one phase

The UI selection, persisted runtime migration, provider-neutral prompt composition, and server-side launch validation form one dispatch contract. Splitting them would create an unsafe intermediate release where the dashboard can promise Codex while the dispatcher still launches Claude, or where the dispatcher accepts values the UI cannot explain. The estimated non-test change is about 190 lines, so the smallest coherent plan is one phase.

- Phase 1: [Provider-neutral Pipeline Engineer host](phase-1-provider-neutral-pipeline-engineer-host.md)
- Execution summary: [phased-plan.md](phased-plan.md)

## Confirmed current state

- Pipeline tasks already persist `agent`, `model`, and `effort` through the ordinary task schema and dispatch request. `src/shared/protocol.ts`, `src/server/tasks.ts`
- The Pipeline task-kind registry delegates launch to the Pipeline provider and excludes after-work workflows, attached repositories, and backlog autopilot. `src/shared/task.ts`
- Managed Pipeline dispatch currently ignores `task.agent`, hardcodes `agent: "claude"`, and sends the provider's Claude-specific `/engineer` prompt. `src/server/dispatcher.ts`, `src/server/pipelines/index.ts`, `src/server/pipelines/conductor/index.ts`
- The dispatch form disables Agent, Model, and Effort for Pipeline tasks and skips the Agent question in guided mode. `src/web/components/DispatchModal.tsx`
- Both Claude and Codex support the managed SDK runtime and typed skill invocation through the shared harness capability registry. `src/shared/harness-capabilities.ts`, `src/server/sdk/supervisor.ts`
- The global Pipeline launch runtime is stored as `claude-sdk` or `terminal`; the former name describes today's implementation rather than the intended provider-neutral contract. `src/shared/pipeline.ts`, `src/web/components/ConductorPanel.tsx`

## Product decisions

1. `task.agent` selects the managed Engineer host for Pipeline tasks.
2. Managed Pipeline dispatch offers only agents that have both an SDK driver and an invocable Engineer skill. That produces Claude and Codex from shared capabilities today without creating another agent list.
3. The persisted managed runtime becomes `agent-sdk`. Reads migrate the legacy `claude-sdk` value before validation; writes emit only `agent-sdk`.
4. Terminal remains an explicit compatibility runtime and continues to run `conduct-ts engineer --idea`. It is Claude-only in the dispatch form and server contract. Mission Control must reject a Terminal Pipeline task that claims a different host instead of silently ignoring the selection.
5. Model and effort stay disabled for Pipeline tasks in this release. The host uses its configured harness defaults, while Conductor continues to own downstream implementation model and effort.
6. The managed path has no Terminal fallback. A Codex SDK preflight or start failure fails the task visibly.
7. Provider-owned task completion, pipeline-run prebinding, cancellation, restart recovery, and Foreman exclusions do not change.

## Target flow

```text
Dispatch Pipeline task
  -> choose Agent: Claude or Codex
  -> persist task.agent
  -> resolve enabled Pipeline provider and reserve run identity
  -> validate selected host has SDK + Engineer skill invocation
  -> compose turn one with skillCommand(task.agent, "engineer") + task intent
  -> start supervisor with agent: task.agent and that agent's dispatch permission mode
  -> AI Conductor Engineer skill calls deterministic conduct-ts primitives
  -> provider projection owns task completion
```

The Terminal compatibility flow is separate:

```text
Launch runtime: Terminal
  -> Pipeline Agent is fixed to Claude
  -> conduct-ts engineer --idea <intent>
  -> provider projection owns task completion
```

## Implementation surfaces

| Surface | Planned change |
| --- | --- |
| `src/shared/pipeline.ts` | Rename the managed runtime to `agent-sdk`; migrate legacy config input; expose a provider-neutral label and type. |
| `src/shared/harness-capabilities.ts` | Add or reuse a shared predicate that proves an agent has an SDK driver and an invocable skill. Do not add a Pipeline-only handwritten agent list. |
| `src/server/pipelines/index.ts` | Resolve Pipeline consent and run identity without composing a Claude prompt. Return the runtime and provider identity needed by dispatch. |
| `src/server/dispatcher.ts` | Validate the selected Pipeline host, compose the agent-specific Engineer command, start `task.agent`, apply its dispatch permission mode, and preserve existing ownership and cancellation boundaries. |
| `src/web/components/DispatchModal.tsx` | Enable and filter Agent for managed Pipeline tasks, keep Model/Effort disabled, include Agent in guided mode, fix runtime-specific help, and prevent a stale invalid draft from submitting. |
| `src/web/components/ConductorPanel.tsx` | Relabel the default as Managed Agent SDK and explain that each Pipeline task chooses Claude or Codex. Keep Terminal explicitly compatible and Claude-only. |
| `docs/pipelines.md` | Document the two hosts, the per-task Agent selector, the no-fallback rule, and the boundary between Mission Control's host and Conductor's downstream agent. |

## Verification

Implementation starts with the current end-user reproduction in `e2e/specs/conductor-loops.spec.ts`: open Dispatch, choose Pipeline, observe that Agent is disabled and the launched session is always Claude. The changed E2E coverage must then prove:

- Managed Pipeline dispatch offers Claude and Codex, selects Codex, launches the fake Codex SDK, and delivers the Engineer skill plus the exact intent as turn one.
- Guided dispatch asks for an Agent on Pipeline tasks but still skips After work.
- Model and Effort remain disabled and explanatory copy distinguishes host defaults from Conductor's downstream choices.
- Terminal mode fixes the Pipeline host to Claude and keeps the existing `conduct-ts engineer --idea` behavior.
- A Codex SDK failure fails without spawning Terminal.
- Settings renders and persists Managed Agent SDK, including migration of an existing `claude-sdk` value.

Focused unit and HTTP tests should pin capability filtering, legacy config migration, prompt bytes, permission-mode routing, invalid-host refusal, run prebinding, cancellation, and restore behavior. Run focused tests first, then `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, and the focused Playwright specs against the built app.

## Acceptance criteria

- An operator can select Codex for a Pipeline task in both the standard and guided Dispatch experiences.
- The created task records `agent: "codex"` and the dispatcher starts a managed Codex SDK session.
- Codex receives an Engineer skill invocation and the unmodified task intent on turn one.
- The managed route never invokes `conduct-ts engineer` and never falls back to Terminal.
- Claude managed Pipeline dispatch continues to work through the same provider-neutral path.
- Terminal compatibility dispatch continues to invoke `conduct-ts engineer --idea` and cannot silently ignore a non-Claude Agent value.
- Existing Pipeline provider projection remains the only task-completion authority.
- Existing `claude-sdk` settings load as `agent-sdk` without operator intervention.
- User-facing documentation and Playwright coverage match the shipped UI.

## Out of scope

- Adding native Codex support to the standalone `conduct-ts engineer` launcher.
- Changing AI Conductor's downstream `llm_provider`, implementation model, effort, or daemon.
- Enabling Pipeline tasks for Recurring Missions or Foreman backlog autopilot.
- Adding Pi as a Pipeline Engineer host.
- Changing Pipeline provider completion semantics or supporting multiple providers per repository.

## Estimated size

| Area | Non-test LOC |
| --- | ---: |
| Shared runtime migration and capability contract | 35 |
| Pipeline launch and dispatcher | 55 |
| Dispatch and Settings UI | 75 |
| Documentation | 25 |
| **Estimated total** | **190** |

Test code is expected to add roughly 160 to 230 lines across focused unit, HTTP, and Playwright coverage.
