# Phase 2 - Foreman's four roles and the Inspector, on the Models page

## Outcome

Foreman's Review, Verify, Triage and Backlog each choose their own provider instead of sharing
one, the Inspector stops ignoring the environment when its provider is unset, and every app-owned
model choice becomes visible on a single page.

After this phase, Settings → Models answers "what is this app spending, and on whose account?" in
one screen.

## Entry criteria and dependencies

- **Direct phase dependencies:** Phase 1 (`phase-1-background-job-providers.md`). This phase renders
  into `SettingsMatrix` / `ModelSlotRow` and applies the inherit and pinning rules Phase 1
  establishes.
- **Session dependency:** the planning session's pull request must merge.

## Scope

In scope:

1. A per-role provider for Foreman's four model calls, inheriting from Foreman's existing
   group-level `runner`.
2. Moving Foreman's and the Inspector's model controls onto Settings → Models, leaving pointer
   lines behind.
3. The Inspector's fallback fix.

Explicit non-goals:

- **Foreman's per-harness backlog dispatch models.** `foreman/backlog-model-claude|codex|pi` live
  on Foreman's **Launches** tab and are tier 2 of the *dispatch* ladder - a different thing from
  Foreman's own four model calls. They stay exactly where they are. Confusing the two would move a
  dispatch setting onto a page about app-owned calls.
- Every other Foreman and Inspector setting - mode, allowlist, timings, posture. Only the model and
  provider rows move.
- Task kinds (Phase 3) and the background jobs (Phase 1).

## Repository findings

- **Foreman already has one provider for all four roles.** `ForemanConfigSchema.runner` is
  `z.enum(LLM_RUNNER_IDS).optional()` (`src/shared/protocol.ts:1441`), documented as "Provider used
  for **every** Foreman model call". That comment stops being true in this phase; update it.
- **Foreman resolves it correctly.** `src/server/foreman/config.ts:253` is
  `cfg.runner ?? llmRunnerChoice().id`, with a comment explaining that a literal `"claude"` "would
  drop the env layer". That is the ladder to keep and to copy.
- **The worker holds one id per pass, deliberately.** `triageRunnerId`
  (`src/server/foreman/worker.ts:2434`) is a module-level `let` with the rationale "every triage in
  a pass runs on the same provider", refreshed once per loop pass from
  `cfg.runner ?? llmSelection?.runner`. That rationale expires here: the value becomes per role.
  The four call sites already take a runner id as a parameter - `foreman/review.ts:51`,
  `foreman/queue-verify.ts:187-195`, `worker.ts:2465`, `foreman/backlog-plan.ts:331-343` - so this
  is a change of what is passed, not of how.
- **The backlog planner freezes its identity.** `worker.ts:551-557` builds a planner-circuit
  identity from runner+model and reads it back at `:714-715`. A per-role runner must flow into that
  identity, or the circuit will compare against a stale provider.
- **`resolveForemanModel` already takes a runner** (`src/shared/foreman-models.ts:94`) and maps role
  to tier. It needs the role's own runner passed in.
- **The Inspector drops the env layer.** `inspectorModel` resolves `cfg.runner ?? "claude"`
  (`src/server/inspector/config.ts:38`), so an unset Inspector provider ignores
  `MISSION_LLM_RUNNER` and the app config. `src/server/inspector/worker.ts:191` makes the same
  `?? "claude"` choice when picking the runner instance. Both must move to
  `?? llmRunnerChoice().id`. The Inspector is the only subsystem still doing this.
- **Foreman settings has a Models tab.** `FOREMAN_SETTINGS_TABS` (`src/web/lib/foreman-settings-tabs.ts`)
  declares a `models` tab owning `foreman/provider`, `foreman/model-review`, `foreman/model-verify`,
  `foreman/model-triage`, `foreman/model-backlog`. Its header comment calls it "the one answer to
  which tab owns a settings anchor", and settings search selects the tab before scrolling - so
  moving those anchors means editing this table, not just the panel.
- **The search index points at Foreman.** `src/web/lib/settings-search.ts:279` is the
  `foreman-models` entry, "The provider and the four models behind Review, Verify, Triage, and
  Backlog." It must re-point to the `models` category, or ⌘K will scroll to a control that is no
  longer there.
- **The panel renders from the registry.** `ForemanSettingsPanel.tsx:671` maps `FOREMAN_MODEL_ROLES`
  over `ModelField`; the same rows move rather than being rewritten.
- **A second writer of the `foreman` blob is safe here, checkably.**
  `ForemanConfigPatchSchema` is `.partial()` (`src/shared/protocol.ts:1683`) and
  `setForemanConfig` merges the patch over a freshly read `cur` (`src/server/foreman/config.ts:113`),
  so a patch carrying only model and runner keys cannot disturb a sibling key. Note that
  `setForemanConfig` spreads at the top level rather than merging per key like `setLlmConfig` - so
  send only the keys being changed and never round-trip a whole sub-object from a stale poll.

## Implementation steps

1. **`src/shared/protocol.ts`** - add a nullable per-role `runner` beside each `*Model` key on
   `ForemanConfigSchema`, defaulting to inherit. Keep the existing top-level `runner` as the
   group-level default and correct its comment. Mirror in `ForemanConfigPatchSchema`.
2. **`src/shared/foreman-models.ts`** - resolve each role's provider as: the role's own, else
   Foreman's group-level `runner`, else the app-wide ladder. Same rule as Phase 1, one extra rung.
3. **`src/server/foreman/config.ts`** - resolve per role and report each role's resolved provider so
   the panel and the worker cannot print different answers.
4. **`src/server/foreman/worker.ts`** - replace the single `triageRunnerId` with a per-role
   resolution, retire the now-false comment at `:2426-2433`, and thread the role's runner into the
   backlog planner identity (`:551-557`, `:714-715`). Preserve the existing behaviour of retaining
   the last known values when the HTTP status read fails.
5. **`src/server/inspector/config.ts:38` and `worker.ts:191`** - `?? "claude"` becomes
   `?? llmRunnerChoice().id`. This is a behaviour change for anyone relying on the broken fallback;
   call it out in the pull request.
6. **`src/web/components/LlmSettingsPanel.tsx`** - add Foreman and GitHub Inspector groups, rendered
   through Phase 1's `SettingsMatrix` / `ModelSlotRow`. Group headings keep the app-owned calls
   legible as distinct subsystems.
7. **`src/web/useLlm.ts` / `SettingsPage.tsx`** - the panel now reads and writes `llm`, `foreman` and
   `inspector`. Pass it the Foreman and Inspector state `SettingsPage` already holds rather than
   opening a second poller with its own idea of the truth.
8. **`ForemanSettingsPanel.tsx` / `InspectorSettingsPanel.tsx`** - replace the model controls with a
   pointer line naming Settings → Models. Leave every other setting untouched.
9. **`src/web/lib/foreman-settings-tabs.ts`** - remove the `models` tab's anchors, or the tab, and
   keep the table the single answer to anchor ownership. Whatever it now says must remain true for
   the keyboard walk and for settings search.
10. **`src/web/lib/settings-search.ts`** - re-point `foreman-models` and the Inspector's model entry
    to the `models` category with anchors that resolve there. A ⌘K result that scrolls nowhere is
    worse than no result.
11. **Docs** - `docs/foreman.md`, `docs/inspector-and-shipping.md`, `docs/models.md`, and
    `docs/configuration.md`. `docs/models.md` currently states that Foreman's four and the
    Inspector's one live with their subsystems "because each panel owns the config it writes"; that
    paragraph is now wrong and its replacement should say what was traded and why.

## Data and compatibility

- **No migration.** Per-role `runner` keys are additive and default to inherit.
- **An installation that already set Foreman's provider keeps it.** Its four roles inherit from the
  group-level value, so behaviour is unchanged until a role is overridden.
- **The Inspector fix changes behaviour** for an installation that set `MISSION_LLM_RUNNER` and left
  the Inspector's provider unset: the Inspector now honours it. That is the intended fix, and it is
  the one place in this phase where an upgrade is not a no-op.
- **Anchors move.** Any bookmark or deep link to `#/settings/foreman` expecting the models tab lands
  on a panel that now points elsewhere; the pointer line is what makes that recoverable.

## Tests and verification

- `test/` - per-role provider resolution including the three-rung ladder (role, Foreman group,
  app-wide); the Inspector honouring `MISSION_LLM_RUNNER` when its own provider is unset - a
  regression test for the exact bug; the backlog planner identity carrying the role's runner;
  `setForemanConfig` leaving sibling keys intact when patched with only model and runner keys.
- `test/` - the anchor-ownership contract: every anchor the search index names is owned by exactly
  one tab/category. Extend whatever test currently pins `FOREMAN_SETTINGS_TABS` rather than adding a
  parallel one.
- `e2e/` - **required.** Set two Foreman roles to different providers and assert both render;
  assert Foreman's settings page shows the pointer instead of the model controls; assert a ⌘K
  search for a Foreman model lands on the Models page.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build && npm run test:e2e`.

## Merge and exit criteria

- Foreman's four roles can run on different providers, and the worker spawns each on the one shown.
- An unset Inspector provider follows `MISSION_LLM_RUNNER` and the app config.
- Every app-owned model choice except Personas and Ensemble judges is visible on Settings → Models.
- Foreman and Inspector panels point at it; no anchor is orphaned.
- Docs corrected, gates green, Playwright spec covering the move.

## Downstream handoff

- Nothing depends on this phase. It is a leaf.
- If Phase 3 merges first, this phase rebases onto its `LlmSettingsPanel.tsx` group structure - the
  two add different groups and the conflict is positional, not semantic.

## Cross-phase audit record

- Reconciled with Phase 1: this phase consumes `SettingsMatrix`, `ModelSlotRow`, the inherit rule
  and the pinning invariant, and adds no second clear-on-change. The per-role ladder adds one rung
  (role → Foreman group → app-wide) to Phase 1's two; that is an extension of Phase 1's rule, not a
  competing one, and Phase 1's handoff is worded to allow it.
- Reconciled with Phase 3: both edit `LlmSettingsPanel.tsx`, `settings-search.ts` and
  `docs/models.md`. Ownership is by section; neither touches the other's group. Phase 3 owns the
  Models **category blurb** in `settings-registry.ts`; this phase does not edit that file.
- Boundary recorded during writing: Foreman's per-harness *backlog dispatch* models were initially
  in scope by association and are explicitly excluded, because they belong to the dispatch ladder
  Phase 3 extends, not to the app-owned calls this phase consolidates.
