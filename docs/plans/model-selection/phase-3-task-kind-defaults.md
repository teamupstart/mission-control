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
- **Effort is a shared vocabulary with per-harness narrowing.** `THINKING_LEVELS`
  (`src/shared/types.ts:203`) is one list every harness reads, but
  `HARNESS_CAPABILITIES[agent].effort` (`src/shared/harness-capabilities.ts:418`) is null for a
  harness with no launch-time effort control, and `levelsFor(model)` (`:250`, `:599`) narrows per
  model - `CODEX_EFFORT_LEVELS` (`:426`) drops `max` for every Codex model but its newest two.
  `sessionEffortLevels` (`:762`) is the existing consumer of that pair. This is why effort takes a
  capability check rather than the model's agent match: a level chosen for one agent is usually
  meaningful on another, and the registry already says when it is not.
- **`resolveSessionRuntime`** (`src/shared/harness-capabilities.ts:790`) is the shape to copy for
  reporting a dropped value: it returns what it resolved to *and* what it had to drop, so a panel
  cannot render a fallback as the operator's own choice.
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
   **Refine the entry so a non-null `model` requires a non-null `agent`.** A model id is
   agent-namespaced, so a model stored against no agent is a value that can never apply, and the
   write schema should refuse it rather than saving a control that silently does nothing. `effort`
   carries no such constraint - it is a shared vocabulary and is deliberately settable on a row that
   inherits its agent. Keep the read side tolerant: an entry persisted by a newer build that breaks
   the rule drops its model and keeps the rest, rather than failing the whole config open.
2. **`src/server/harnesses.ts`** - merge `kindDefaults` per key in `setHarnessesConfig`. Add the
   kind tier to `resolveDispatchModel` and `resolveDispatchEffort`, both taking the task's kind.
   The tier sits **below** the launch-only Foreman backlog model and **above** the per-harness
   default in both. The two fields are guarded differently, and conflating them is the mistake to
   avoid:
   - **Model - agent match.** The kind's model applies **only when the task's agent equals the kind
     default's agent**; a `claude-opus-5` id is not something Codex can run. A row that inherits its
     agent cannot hold a model at all (step 1), so there is no case where a configured model
     silently never applies.
   - **Effort - capability check.** A blanket agent match would be wrong here: `high` chosen for
     planning is meaningful on any harness, and a row may set an effort while inheriting its agent.
     Apply the kind's effort to whichever agent the task runs on, then check it against
     `HARNESS_CAPABILITIES[agent].effort?.levelsFor(model)` using the model this launch actually
     resolved - so effort resolves **after** the model, not beside it. A harness with no `effort`
     spec, or one that does not offer the level, falls through to `defaultEffort[agent]` rather than
     launching with a flag the CLI will reject.
3. **`src/web/harnesses-reconcile.ts`** - teach `mergeHarnessesPatch` the new key.
4. **`src/server/dispatcher.ts:449-450`** - pass the task's kind to both resolvers.
5. **Task creation** - resolve an omitted agent from the kind default instead of defaulting to
   `"claude"`. Do it where every creator converges so MCP `create_task`, task sources and Recurring
   Missions inherit it without each learning about it. Once written, the agent is an ordinary pin.
   **The schema boundary is the trap here.** `DispatchSchema.agent` is
   `z.enum(AGENT_TYPES).default("claude")` (`src/shared/protocol.ts:953`), so by the time a route
   sees the parsed body an omitted agent has already become an explicit `"claude"` and no
   downstream resolution can recover the difference. The default has to move off the schema -
   `.optional()`, resolved once at the convergence point - or the kind default will never be
   consulted by any caller that goes through it, which is all of them. Expect the parsed type to
   widen to `AgentType | undefined` and the compiler to name every consumer; that list is the
   inventory of places that were silently relying on the default. `kind` keeps its
   `.default("ship")`, so the kind is always known when the agent is resolved.
6. **`src/web/components/LlmSettingsPanel.tsx`** - a Task kinds group rendered through Phase 1's
   `SettingsMatrix` with four columns (Kind, Agent, Model, Effort) and the muted inherited row on
   top. Rows come from the registry, so `pipeline` is absent because it declares
   `launch: "pipeline"`. The Model cell is disabled while that row's Agent is Inherit, and choosing
   an agent narrows both the model catalog and the effort options to what that harness offers
   (`levelsFor`) - the same narrowing `ModelField` already does. Say in the cell's title or hint why
   Model is unavailable; a control disabled without a reason reads as a bug. The panel also needs the `useHarnesses` state `SettingsPage.tsx` already
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
  applied when the task's agent differs, while its effort still is); a row that inherits its agent
  rejected on write when it carries a model, and accepted when it carries only an effort; an effort
  the target harness does not offer (`max` on a Codex model outside the newest two) falling through
  to `defaultEffort[agent]` rather than reaching the launch; a harness whose `effort` spec is null
  taking no effort from the kind tier; effort resolved against the model this launch resolved rather
  than the row's; **MCP `create_task` with no `agent` landing on the kind's agent rather than
  `"claude"`**, and with an explicit `agent: "claude"` still landing on Claude even when the kind
  says otherwise - the regression test for the schema-default trap; the row set derived from
  `TASK_KIND_BEHAVIOR` so
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
- A kind default whose agent does not match the task's agent falls through to the harness default
  **for the model**, while its effort still applies - unless the target harness does not offer that
  level, in which case the harness default does.
- A row that inherits its agent cannot be saved with a model, and its Model cell says why.
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
- Review round 1 also raised that `DispatchSchema`'s `.default("claude")` erases the omission the
  kind default needs to see. Step 5 now names that boundary and the type widening it causes.
- Review round 3 raised effort crossing the agent boundary, and round 1 raised a model-only row
  that could never apply. Both were real and both are fixed here rather than deferred, because they
  are properties of the resolver this phase introduces. The fix is deliberately **not** the
  symmetrical guard the review proposed: a blanket agent match on effort would discard a value that
  is portable by construction, so effort takes a capability check against the harness registry and
  the model keeps the agent match. The source plan's "Where it lands in the ladder" section carries
  the same split.
