# Phase 3 - An agent, model and effort per task kind

## Outcome

A dispatched `plan` task can run on a different agent and model from a `ship` task, chosen once on
Settings → Models instead of overridden by hand on every dispatch.

## Entry criteria and dependencies

- **Direct phase dependencies:** Phase 1 (`phase-1-background-job-providers.md`), for
  `SettingsMatrix` only. This phase does not depend on Phase 2 and may run concurrently with it.
- **Session dependency:** the planning session's pull request must merge.

## Scope

In scope: per-kind defaults for agent, model and effort; their resolution at launch; the agent seed
at task creation; the Task kinds matrix; the dispatch form following it.

Explicit non-goals:

- **Making `tasks.agent` nullable.** See the constraint below; it is deliberately not proposed.
- **`pipeline`.** Conductor owns its downstream agent, model and effort.
- Anything on the app-owned call path (Phases 1 and 2).

## Repository findings

- **Kind is already a registry.** `TASK_KINDS` (`src/shared/types.ts:1702`) is append-only and never
  reordered; `TASK_KIND_INFO` and `TASK_KIND_BEHAVIOR` (`src/shared/task.ts:61`, `:106`) carry copy
  and launch rules. Roughly eleven `Record<TaskKind, …>` registries exist, and each is an
  exhaustiveness gate - a new kind does not compile until it answers them. Add the per-kind defaults
  as another registry-driven record, and derive the row set from
  `TASK_KIND_BEHAVIOR[kind].launch === "harness"` rather than hardcoding a skip list.
- **The resolvers are a single funnel.** `resolveDispatchModel` (`src/server/harnesses.ts:86`) and
  `resolveDispatchEffort` (`:95`) are what every launch path goes through;
  `src/server/dispatcher.ts:449-450` is the caller.
- **The config blob takes new keys without migration.** `HarnessesConfigSchema`
  (`src/shared/protocol.ts:2043`); `setHarnessesConfig` (`src/server/harnesses.ts:56`) merges
  `defaultModel`, `defaultEffort` and `sessionRuntime` per key, and
  `HarnessesConfigPatchSchema` is spelled out rather than `.partial()`-derived, deliberately.
- **The browser merges optimistically too.** `mergeHarnessesPatch`
  (`src/web/harnesses-reconcile.ts`) must learn the new key, or an optimistic write replaces the
  whole record instead of one kind's row.
- **The constraint that shapes this phase.** `tasks.agent` is `TEXT NOT NULL`
  (`src/server/db.ts:617`) and `Task.agent` is `AgentType`, never null
  (`src/shared/types.ts:1881`), while `tasks.model` and `tasks.effort` are nullable
  (`:625-626`). So **model and effort resolve at launch; the agent is seeded at creation.**
  `DispatchSchema.agent` defaults to `"claude"` (`src/shared/protocol.ts:953`) and
  `EMPTY_DISPATCH_DRAFT.agent` is `"claude"` (`src/web/lib/task-draft.ts:71`); those two are the
  seeds to replace.
- **The triple already exists.** `EnsembleRoleSpec` (`src/shared/ensemble.ts:479`) stores
  `agent: AgentType | null`, `model: string | null`, `effort: ThinkingLevel | null`. Copy that
  shape.
- **The dispatch form already names its defaults.** `DispatchModal.tsx:2696` says "Defaults from
  Settings → Harnesses. Switching agent resets the model and effort overrides", and
  `defaultModelOptionLabel` / `defaultEffortOptionLabel` (`:336-355`) render them. Those strings
  must name the kind default when it is the one that applies, or the form will confidently state
  the wrong source.
- **Guided dispatch asks Kind before Harness** (`docs/dispatch-and-backlog.md`), so seeding the
  agent from the kind fits the existing question order.
- **Saving publishes an event.** `harnesses_config_changed` (`src/shared/types.ts:2955`) is how a
  second tab and an open dispatch form re-read defaults; the new key must ride it.

## Implementation steps

1. **`src/shared/protocol.ts`** - a `kindDefaults` key on `HarnessesConfigSchema` keyed by the
   harness-launched kinds, each entry `{ agent, model, effort }`, every field nullable, null meaning
   inherit. Add the counterpart to `HarnessesConfigPatchSchema`, spelled out per key like its
   siblings rather than derived.
2. **`src/server/harnesses.ts`** - merge `kindDefaults` per key in `setHarnessesConfig`. Add the
   kind tier to `resolveDispatchModel` and `resolveDispatchEffort`, both taking the task's kind.
   The tier sits **below** the launch-only Foreman backlog model and **above** the per-harness
   default, and its model applies **only when the task's agent equals the kind default's agent** - a
   `claude-opus-5` id is not something Codex can run.
3. **`src/web/harnesses-reconcile.ts`** - teach `mergeHarnessesPatch` the new key.
4. **`src/server/dispatcher.ts:449-450`** - pass the task's kind to both resolvers.
5. **Task creation** - resolve an omitted agent from the kind default instead of defaulting to
   `"claude"`. Do it where every creator converges so MCP `create_task`, task sources and Recurring
   Missions inherit it without each learning about it. Once written, the agent is an ordinary pin.
6. **`src/web/components/LlmSettingsPanel.tsx`** - a Task kinds group rendered through Phase 1's
   `SettingsMatrix` with four columns (Kind, Agent, Model, Effort) and the muted inherited row on
   top. Rows come from the registry, so `pipeline` is absent because it declares
   `launch: "pipeline"`. The panel also needs the `useHarnesses` state `SettingsPage.tsx` already
   holds (L258); share that instance rather than opening a second poller.
7. **State the asymmetry in the panel.** One line under the group: the model and effort are read
   when a task launches, so a change reaches a task already in the backlog; the agent is written
   when the task is created, so it reaches the next task filed. An operator who expects a shelved
   task to pick up a changed agent has no other way to find out they are wrong.
8. **`src/web/lib/settings-registry.ts`** - the Models category's blurb and keywords say "the app's
   own calls" and would be describing part of the page. **This phase owns that file**; Phases 1 and
   2 do not touch it.
9. **`DispatchModal.tsx` / `src/web/lib/task-draft.ts`** - choosing a Kind moves the Agent select,
   and the model/effort hint strings name the kind default when it applies. Respect the existing
   rule that a choice made by hand is never reverted by a later kind switch - the same rule the
   kind-to-after-work behaviour already follows.
10. **`src/web/lib/settings-search.ts`** - entries so "plan model" reaches the row.
11. **Docs** - `docs/models.md`, `docs/harnesses-and-terminals.md`, and
    `docs/dispatch-and-backlog.md`, whose "Which model wins" section enumerates the tiers and would
    be wrong by one.

## Data and compatibility

- **No migration.** `kindDefaults` is additive with a default, so an untouched installation resolves
  exactly as today.
- **`TASK_KINDS` is append-only**, so a record keyed by kind id is safe to persist: a key can be
  added but never means something else later.
- **A task already dispatched is untouched.** A running session keeps the model it launched with.
- **Downgrade** ignores `kindDefaults` and falls back to the per-harness default.

## Tests and verification

- `test/` - the four-tier ladder; the agent-mismatch fall-through (a kind default's model is **not**
  applied when the task's agent differs); the row set derived from `TASK_KIND_BEHAVIOR` so
  `pipeline` is absent and a future harness-launched kind appears without an edit; `setHarnessesConfig`
  and `mergeHarnessesPatch` merging `kindDefaults` per key; an omitted agent resolving from the kind
  at creation across every creator.
- `e2e/` - **required.** Set a kind default, open Dispatch, choose that kind, and assert the Agent
  select moved and the model hint names the kind default. Select by role/label; no `data-testid`;
  agents stay faked.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build && npm run test:e2e`.

## Merge and exit criteria

- A `plan` task dispatches on its configured agent and model without touching the form.
- A backlogged task picks up a changed kind **model**; its agent stays as filed - and the panel says
  so.
- A kind default whose agent does not match the task's agent falls through to the harness default.
- `pipeline` has no row. Docs updated, gates green, Playwright spec present.

## Downstream handoff

- Nothing depends on this phase. It is a leaf.
- If Phase 2 merges first, rebase onto its `LlmSettingsPanel.tsx` group structure; the conflict is
  positional, not semantic.

## Cross-phase audit record

- Reconciled with Phase 1: consumes `SettingsMatrix` and extends it to four columns, which Phase 1's
  handoff explicitly permits ("extend by adding column definitions, never by forking"). The inherit
  rule is the same; the pinning invariant does not apply here because a dispatch model is pinned to
  an *agent*, not a provider, and the agent-match guard is the equivalent protection.
- Reconciled with Phase 2: no shared contracts. Both add a group to `LlmSettingsPanel.tsx` and both
  touch `settings-search.ts` and `docs/models.md`; ownership is by section and either merge order
  works. `settings-registry.ts` is owned by this phase alone, so the category blurb has one writer.
- Concurrency claim checked: this phase touches `harnesses`; Phase 2 touches `foreman` and
  `inspector`. No shared schema, resolver, worker or migration.
