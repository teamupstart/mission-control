# Phase 2: Per-dispatch advisor override

Plan: `docs/plans/claude-advisor-mode/plan.md`. Index: `docs/plans/claude-advisor-mode/phased-plan.md`.

## Outcome

A Claude task can pin its advisor at dispatch: Inherit (default), Opus, Sonnet, or Off. The pin reaches terminal and SDK launches, survives resume, and never writes the operator's Claude settings files. This lets an operator pair a Sonnet executor with an Opus advisor for one task without changing every other session.

## Entry criteria

Phase 1 has merged. That gives this phase:

- `TranscriptMessage.advisor` and `SessionMeta.advisorModel`;
- the advisor trigger in `fake-claude.mjs`;
- the `### Advisor` docs section.

## Gate: confirm the terminal mechanism first

Before any other change, confirm that `--settings '{"advisorModel":"opus"}'` activates the advisor on a terminal launch. The human chose this mechanism over the hidden `--advisor` flag.

1. Run `claude --settings '{"advisorModel":"opus"}'` in a scratch directory, without editing `~/.claude/settings.json`.
2. Ask `/advisor` with no argument; it prints "Advisor: <model>" for the current setting.
3. Repeat with `--model sonnet` so the pairing rule allows activation.

This costs one interactive command and no task tokens. If the account lacks the advisor feature flag, `/advisor` reports "The advisor is not available". In that case set `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL=1` for the check only.

**If `--settings` does not activate the advisor,** stop and open no PR. Put the gate's output in your report back to the human, so they can decide on the hidden `--advisor` flag. Do not switch mechanisms on your own.

**If it does activate the advisor,** continue, and put the gate's output in the PR description.

## Scope

- Capability and type.
- Persistence on `tasks` and `sdk_sessions`.
- Wire schemas.
- Task manager validation.
- Resolver.
- Terminal and SDK launch rendering, including env for Off, on both first launch and resume.
- Dispatch modal and task edit select.
- Unit tests and an e2e spec.
- Docs.

## Non-goals

- Live control on a running session (`applyFlagSettings`).
- Fable.
- Kind, harness, schedule or bulk-edit defaults for the advisor.
- Codex or Pi.
- Validating advisor and executor pairing in Mission Control; the CLI owns that.
- Writing any settings file.

## Repository findings this phase relies on

The per-task `effort` pin is the template. Mirror each touch point:

| Area | Effort today |
|---|---|
| DDL | `tasks.effort` at `src/server/db.ts:378`, migration :4055-4057 |
| Row and parse | `:5507`, `:5780`, `:5838` |
| Upsert | `:5911`, `:5926`, `:5963` |
| SDK row | `sdk_sessions.effort` at `:1901` |
| Wire type | `Task.effort` at `src/shared/types.ts:2164-2170` |
| Schemas | `DispatchSchema` (`src/shared/protocol.ts:1040`, field :1071, refine :1090) and `UpdateTaskFieldsSchema` (:1347, field :1370, refine :1379); the MCP schemas derive from it |
| Task manager | `src/server/tasks.ts:237`, `:2827`, `:2853`, `:2882`, `:2947`, `:3751-3753` (reset on agent change), `:3871` |
| Resolver | `resolveDispatchEffort` (`src/server/harnesses.ts:211`) |
| Dispatcher | `src/server/dispatcher.ts:712-757`, `:835`, `:1773`, `:1862` |
| SDK supervisor and store | `src/server/sdk/supervisor.ts:362`, `:429`, `:481`, `:543`, `:593`, `:1244`, `:1316`; `src/server/sdk/store.ts` |
| Options type | `SdkLaunchOptions.effort` (`src/server/harness/types.ts:803`) |
| Capability | `src/shared/harness-capabilities.ts:567`, `:663-677` |
| UI | `DispatchModal.tsx:2948-2979`, `:1567`, `:2376`, `:2351`; `src/web/lib/task-draft.ts`; `src/web/lib/api.ts:1557` |

Environment:

- Terminal launches build their environment only from `agentSubprocessEnv({}, ...)` (`src/server/agent-subprocess-env.ts:119-237`) through `spawnUniquely` and `spawnManagedResume` (`dispatcher.ts:3046-3066`). There is no extra-env hook yet.
- SDK env is `withAgentTraceContext(withArtifactTool(deps.env(...)))` (`src/server/harness/claude/sdk.ts:1413`). `withArtifactTool` (:1277) is the precedent for adding one variable.

The SDK path already sends `settings: { disableClaudeAiConnectors: true }` for resident sessions (`sdk.ts:1310`, inside `claudeMcpOptions`). The advisor setting must merge with it, not replace it.

The e2e fake (`e2e/fixtures/fake-claude.mjs:323-349`) records argv and a fixed env list. Use the `recordsIn` and `argvValue` helpers (`e2e/fixtures/records.ts`). An SDK launch is identified by `argv.includes("--input-format")`.

## Implementation steps

1. **Gate** (above).
2. **Capability.** In `src/shared/harness-capabilities.ts`, add `advisor: AdvisorSpec | null` to the capability type. The spec has these fields:
   - `values: readonly AdvisorChoice[]`, where `AdvisorChoice = "opus" | "sonnet" | "off"`;
   - `launchArgs(choice)`, which returns `["--settings", JSON.stringify({ advisorModel: choice })]` for a model and `[]` for `off`;
   - `launchEnv(choice)`, which returns `{ CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1" }` for `off` and `{}` otherwise;
   - `sdkSettings(choice)`, which returns `{ advisorModel: choice }` for a model and `{}` for `off`.

   These helpers take a non-null `AdvisorChoice`. Inherit is `null` and never reaches them: for `null`, callers render no args, no env and no settings, and the protocol refine accepts `null` without calling `supportsAdvisor`. The same holds for `resolveDispatchAdvisor` and `SdkLaunchOptions.advisorModel`, which carry `AdvisorChoice | null`.

   Claude declares it; Codex and Pi declare `null`. Add `supportsAdvisor(agent, choice)` beside `supportsEffort`. Comment the measured CLI version and the gate result.
3. **Persistence.** In `src/server/db.ts`:
   - add `advisor_model TEXT` to the `tasks` DDL and `addColumn(d, "tasks", "advisor_model", "TEXT")` next to the effort migration;
   - extend the row type, a `parseAdvisor` built on `supportsAdvisor` (stale values read back as null), `rowToTask`, and the upsert;
   - add `sdk_sessions.advisor_model TEXT` the same way, so SDK resume keeps the pin.
4. **Wire.** In `src/shared/types.ts`, add `Task.advisorModel: AdvisorChoice | null`. In `src/shared/protocol.ts`:
   - add an optional `advisorModel` to `DispatchSchema` and a nullable optional one to `UpdateTaskFieldsSchema`, each with a `supportsAdvisor` refine mirroring effort's that runs only for a non-null value;
   - leave `BulkUpdateTasksSchema` unchanged.
5. **Task manager** (`src/server/tasks.ts`). Mirror effort on:
   - create input, validation and error text;
   - the idempotency comparisons;
   - persistence;
   - the update path, including reset to null when the agent changes.

   Also copy the field in the chat-retry re-file at `src/server/routes.ts:8350`.
6. **Resolver.** Add `resolveDispatchAdvisor(task)` in `src/server/harnesses.ts`. It returns the task pin or null. There is no kind or harness default in this phase.
7. **Terminal launch** (`src/server/dispatcher.ts`).
   - Compute `advisorArgs` and `advisorEnv` from `harnessFor(task.agent).advisor` next to `effortArgs`.
   - Spread `advisorArgs` into `agentArgs`.
   - Add an `extraEnv?: Record<string, string>` option to `AgentSubprocessEnvOptions` and `isolatedAgentArgv`, which writes extra `export` lines into the wrapper script. Thread it through `spawnUniquely` and `spawnManagedResume`, so a terminal resume carries the same args and env.
   - Confirm that no other code adds `--settings` to the terminal argv; the flag is single-valued. If anything does, merge the two objects into one flag value.
8. **SDK launch.**
   - Add `advisorModel: AdvisorChoice | null` to `SdkLaunchOptions` and carry it through `supervisor.start`, the durable row, and the resume and relaunch paths.
   - In `src/server/harness/claude/sdk.ts`, merge `sdkSettings(choice)` into `Options.settings` together with `claudeMcpOptions`' `disableClaudeAiConnectors`. Write one merged object; do not let either overwrite the other.
   - Add `launchEnv(choice)` beside `withArtifactTool`.
   - Add `advisorModel` to the `settings` type in `src/server/harness/claude/sdk-types.ts` if it is narrower than the vendor's.
9. **UI.**
   - In `src/web/components/DispatchModal.tsx`, add an "Advisor" `<select>` next to Effort, rendered only when `capabilitiesFor(draft.agent).advisor` is non-null.
   - Give it the accessible name "Advisor for dispatched Claude Code session", matching the effort select's naming.
   - Options: "Inherit from Claude settings" (empty), "Opus", "Sonnet", "Off".
   - Reset it with model and effort on agent switch; include it in the submit body and in `taskUpdatePatch`.
   - Mirror effort in `src/web/lib/task-draft.ts` and the `src/web/lib/api.ts` create-body type.
10. **Fake agent.** In `fake-claude.mjs`, add `disableAdvisorTool: process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL ?? null` to the invocation record. Do not change Phase 1's advisor transcript trigger.
11. **E2e spec.** Add `e2e/specs/advisor-dispatch-override.spec.ts` with three cases:
    - terminal runtime, Advisor = Opus: `argvValue(argv, "--settings")` parses to `{ advisorModel: "opus" }`;
    - SDK runtime, Advisor = Sonnet: the SDK invocation's `--settings` value contains `advisorModel: "sonnet"`, plus `disableClaudeAiConnectors` when the launch is a resident session;
    - Advisor = Off: `disableAdvisorTool === "1"` and no `advisorModel`.

    Also assert:
    - Inherit leaves argv without `--settings` and the env without the variable;
    - the select is absent for a Codex agent;
    - re-opening the task for edit shows the saved choice.
12. **Docs.** Append `#### Per-dispatch override` under `### Advisor` in `docs/dispatch-and-backlog.md`, and remove Phase 1's "no override yet" sentence. Cover:
    - the values, and that Inherit is the default;
    - that the override uses Claude's session-scoped flag layer and never writes settings files;
    - that Off sets `CLAUDE_CODE_DISABLE_ADVISOR_TOOL`;
    - that pairing and availability are enforced by the CLI, with refusals shown as launch failures;
    - that Fable and live switching are not offered.

    Add migration notes to `docs/database-and-migrations.md` if that doc lists columns.

## Data and compatibility

- Both columns are nullable, and `NULL` means inherit, so existing databases open unchanged. `addColumn` sits next to its upgrade path, per the change contracts.
- An Inherit task produces argv and env identical to today's. Pin this in a unit test on the dispatcher argv.
- A stored value that is no longer valid (for example after a capability change) parses to null, and the task inherits.

## Tests and verification

Unit tests, run with `node --test --import ./test/setup-state.mjs --import tsx <file>`:

- capability rendering for each choice;
- the protocol refine accepting and rejecting values;
- task create and update, including reset on agent change;
- `parseAdvisor` stale-value handling and the migration on an old database fixture;
- dispatcher terminal argv and env for each choice, including resume;
- the SDK options merge with `disableClaudeAiConnectors`;
- the supervisor carrying the pin across relaunch.

Then:

```sh
npm run typecheck && npm run lint
npm run build && npx playwright test e2e/specs/advisor-dispatch-override.spec.ts e2e/specs/advisor-visibility.spec.ts
```

## Merge and exit criteria

- The gate passed and its output is in the PR description. (A failed gate never reaches merge: it ends the phase with a report back to the human and no PR.)
- Inherit is byte-identical to today's launch.
- All new unit tests and both advisor e2e specs pass.
- Typecheck, lint and CI are green.
- The docs are updated.

## Downstream handoff

No later phase. Future work (live control, Fable, kind or harness defaults) can extend `AdvisorSpec` and `resolveDispatchAdvisor`. It should not add a second source of truth for the pin.

## Cross-phase audit

- Consumes Phase 1's `fake-claude.mjs` and docs section only by appending, as the index contracts allow.
- Reads none of Phase 1's parser or meta shapes, and changes none of them.
- Re-checked after writing: this phase's file set and Phase 1's overlap only in `fake-claude.mjs` and `docs/dispatch-and-backlog.md`. That overlap is why the phases are serial.
- Repair round 1: clarified that a failed gate's output goes in the report back to the human (no PR), and a passing gate's output goes in the PR. Phase 1 now owns iteration-based spend attribution and a real-advisor probe; this phase depends on neither beyond the shared fake agent.
- PR #1326 review: stated that Inherit (`null`) bypasses the `AdvisorSpec` helpers and the `supportsAdvisor` refine, so their non-null signatures and the nullable task, options and resolver fields agree.
