# Phase 1: Provider-neutral Pipeline Engineer Host

## Objective

Replace the Claude-only managed Pipeline launch with a capability-driven host contract so a Pipeline task can start Engineer in either Claude or Codex while preserving every existing Pipeline ownership boundary.

## End-user reproduction first

Use the built dashboard and the existing fake-agent E2E environment:

1. Enable AI Conductor for a fixture repository and keep the managed SDK runtime selected.
2. Open Dispatch and choose Pipeline.
3. Confirm the Agent control becomes disabled and the help text promises a managed Claude host.
4. Submit the task and observe a Claude SDK session regardless of the draft's stored agent.

Extend `e2e/specs/conductor-loops.spec.ts` from this failing user path before changing production code. The target assertion is that choosing Codex results in one fake Codex SDK session whose accepted opener contains the Codex Engineer skill invocation and the exact intent.

## Implementation sequence

### 1. Make the runtime name truthful and backward compatible

- Change the canonical managed launch runtime from `claude-sdk` to `agent-sdk` in `src/shared/pipeline.ts`.
- Add an explicit schema transformation or migration that accepts a persisted legacy `claude-sdk` value and normalizes it to `agent-sdk` before the canonical enum validates.
- Keep `terminal` unchanged.
- Update server status, HTTP contracts, settings tests, and Pipeline tests to assert canonical output. Do not retain two live managed values after parsing.

### 2. Define eligible Pipeline hosts through shared capabilities

- Use the harness registry to answer whether an agent supports the SDK runtime and has an invocable Engineer skill.
- Expose a browser-safe shared predicate or list only if existing helpers cannot express both conditions cleanly.
- Derive the Dispatch options from `AGENT_TYPES`; do not spell `['claude', 'codex']` in UI or server code.
- Server validation is authoritative. UI filtering is guidance, not security.

### 3. Separate provider identity from host prompt composition

- Keep `pipelineTaskLaunch` responsible for repository consent, provider uniqueness, deterministic run identity, duplicate-run refusal, and Terminal argv resolution.
- For the managed runtime, return the resolved runtime, repository cwd, and pipeline run identity without a Claude-specific prompt.
- In the dispatcher, resolve `skillCommand(task.agent, 'engineer')`. Refuse a missing command or missing SDK driver with an operator-actionable error before starting a session.
- Compose turn one from the selected host's invocation grammar and the original task intent. Preserve the intent exactly after an unambiguous separator.

Expected examples:

```text
Claude: /engineer <intent>
Codex:  $engineer - run this skill now. <intent>
```

Tests, not comments, own the exact final byte contract.

### 4. Launch the selected SDK host safely

- Call the generic session supervisor with `agent: task.agent`.
- Apply the selected agent's standard dispatch permission mode rather than passing `null` unconditionally.
- Continue to pass no task-level model or effort override for Pipeline tasks, so configured harness defaults apply to the Engineer host.
- Preserve run prebinding before launch, late cancellation cleanup, session binding, provider-owned completion, and no-fallback failure behavior.
- On Terminal runtime, reject any non-Claude Pipeline agent instead of discarding it, then retain the existing `conduct-ts engineer --idea` argv and live stdin path.

### 5. Make Dispatch reflect the actual contract

- For managed Pipeline tasks, enable Agent and offer only capability-eligible hosts.
- When switching from a harness task to Pipeline, preserve an eligible Claude or Codex selection; otherwise normalize to the product default.
- In guided mode, ask the Agent question for managed Pipeline tasks, then skip only After work. For Terminal, explain and fix the Agent to Claude.
- Keep Model and Effort disabled. Change their tooltips or nearby help so the operator understands that Mission Control uses harness defaults for the Engineer host and Conductor separately chooses downstream implementation settings.
- Update the Pipeline constraint copy and Settings panel to say Managed Agent SDK, Claude or Codex per task, and no Terminal fallback.
- Ensure reopening a stale or legacy task cannot submit an agent/runtime mismatch.

### 6. Pin the contract with tests and documentation

Add focused coverage in the existing homes:

- `test/pipeline-contracts.test.ts`: legacy runtime migration, canonical enum, agent-specific skill prompt bytes, and capability eligibility.
- `test/pipeline-http.test.ts`: settings round-trip emits `agent-sdk`; Terminal remains unchanged.
- Pipeline dispatcher tests, currently in `test/pipeline-phase6.test.ts` or the nearest owned successor: selected agent reaches the supervisor; Codex permission mode is applied; invalid capabilities refuse; failure never spawns Terminal; prebinding and cancellation still hold.
- `test/conductor-panel.test.ts`: provider-neutral labels and settings state.
- `e2e/specs/settings-conductor.spec.ts`: managed runtime label and legacy migration are visible.
- `e2e/specs/conductor-loops.spec.ts`: standard and guided Codex selection, fake Codex SDK launch, exact turn one, disabled Model/Effort, Terminal Claude-only behavior, and no-fallback failure.
- `docs/pipelines.md`: describe the end-to-end managed and Terminal flows plus ownership boundaries.

## Required verification

Run in this order so failures stay attributable:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/pipeline-contracts.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/pipeline-http.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/pipeline-phase6.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/conductor-panel.test.ts
npm run typecheck
npm run lint
npm test
npm run build
npx playwright test e2e/specs/settings-conductor.spec.ts e2e/specs/conductor-loops.spec.ts
```

Visually inspect the Dispatch modal at desktop and narrow viewport widths. Agent selection, help copy, and the guided picker must remain legible without clipping or unexpected layout movement.

## Non-negotiable boundaries

- Do not modify AI Conductor.
- Do not add native Codex behavior to `conduct-ts engineer`.
- Do not fall back from a failed managed SDK launch to Terminal.
- Do not expose Pipeline task model or effort overrides.
- Do not enable Pipeline tasks in Recurring Missions or backlog autopilot.
- Do not change provider-owned task completion or run identity rules.

## Done when

- Both Claude and Codex pass the same managed Pipeline host contract.
- Terminal compatibility remains explicit and Claude-only.
- Existing settings migrate automatically.
- Focused and full checks pass.
- The implementation pull request is merged with browser-visible evidence attached to its verification notes.
