# Guided dispatch - phased implementation

Implementation index for [`plan.md`](plan.md) ([rendered](plan.html)). Five phases, each an
independently reviewable pull request that leaves the repository operable.

## Source

- Approved plan: `docs/plans/dispatch-wizard/plan.md`
- Interaction mockups (interactive, self-contained): `docs/plans/dispatch-wizard/mockups/`,
  with [`d-rail-reveal.html`](mockups/d-rail-reveal.html) the chosen direction.

## Incorporated human decisions

These were submitted against the plan and are requirements here, not open questions.

| Decision | Answer | Owned by |
|---|---|---|
| Interaction model | **D · Rail + Reveal** - C's in-place reveal carrying A's rail as a horizontal strip | Phase 2 |
| Repo | **Asked, first**, as a filter over the field that already holds it | Phase 4 |
| Shipped default | **On**, with <kbd>⇥</kbd> as the one-key escape | Phase 5 |

## Investigated findings that shaped the phase boundaries

Five things the repository said that the plan did not know. Each moved a boundary.

**1. Shipping on by default breaks roughly 49 existing e2e specs.** Eleven specs treat the
dispatch modal as their subject and about thirty-eight more drive it only to get a session onto
the fleet, all of them by clicking **Dispatch**, filling the repo placeholder and tabbing
through native selects. A guided pass that intercepts keys and dims the form invalidates every
one of them. Splitting the flip into its own phase is not enough on its own - the fixture has
to stop depending on the shipped default *before* the default can move. **Phase 2 pins
`guidedDispatch` explicitly in `e2e/fixtures/test.ts`**, which turns Phase 5 into a one-line
change to `UI_CONFIG_DEFAULTS` plus its own spec, instead of a 49-file rewrite. This is the
single most important contract in this plan.

**2. `Settings → Dispatch` is the most expensive of the three toggle surfaces, not the
cheapest.** The plan called it "the only one that has to exist". In fact
`SETTINGS_CATEGORIES` (`src/web/lib/settings-registry.ts:90`) is a twelve-entry registry whose
new member must be contiguous within its group (the arrow keys walk the flat array while the
rail draws group-by-group, pinned by `test/settings-sidebar-render.test.ts:134`), must supply a
panel component to an exhaustive switch, must render at least one `data-anchor` under a static
render with no props, and must contribute at least one entry to `SETTINGS_CONTROLS`
(`test/settings-search.test.ts:116`). That is a phase's worth of work with its own test
surface, so it became **Phase 3** rather than a line item. The decision to keep it is recorded
below.

**3. The kind → after-work rule does not need extracting.** The plan hedged that it might
"move into a shared helper". It does not have to: `afterWorkForKind`
(`DispatchModal.tsx:911-923`) is a closure over `draft` and a `stashedWorkflowId` ref *inside*
`DispatchModal`, and the guided pass lives inside the same component, so it calls
`update({ kind, ...afterWorkForKind(kind) })` exactly as the Kind `<select>` already does. No
extraction, no second source of truth, and `e2e/specs/scout-after-work-default.spec.ts` keeps
covering the rule for both entry points.

**4. The modal autofocuses the Task textarea on mount, which would eat every mnemonic.**
`useEffect(() => { intentRef.current?.focus(); }, [])` (`DispatchModal.tsx:925-927`) runs at the
*start* of the opening. `Overlay.onKeyDown` is a window listener, so during a guided pass
pressing <kbd>p</kbd> would both advance the wizard and type `p` into the task box. The plan
read this effect as the thing that focuses the box at the *end* of the pass. It is the same
effect, but it has to become conditional - Phase 2 owns that.

**5. Escape inside the repo step is already spoken for.** `RepoCombobox` closes its portalled
listbox on Escape and calls `stopPropagation`, deliberately, so Escape does not close the modal
while the list is open (`e2e/README.md` names this as trap #3). The plan says "<kbd>esc</kbd>
cancels the dispatch outright". Both cannot be true in the repo step. Phase 4 owns resolving it
and states the resolution rather than inheriting a contradiction.

### Decisions taken against the repository

- **Keep `Settings → Dispatch` as a new category** (group `screen`, scope `browser`) despite
  finding 2. It is what the approved plan chose; `UiConfig` booleans live under browser-scope
  categories (`display`, `keyboard`), and neither of those fits a dispatch preference. The
  cheaper alternative - fold it into `harnesses`, which already owns `harnesses/auto-mode`
  ("Auto mode on dispatch") and whose keywords already include `dispatch` - is a scope
  mismatch: that category is `scope: "machine"` and daemon-backed. **This is the one decision
  here worth overturning cheaply if the reviewer disagrees**; it is isolated in Phase 3.
- **Do not extract a shared after-work helper**, per finding 3. The plan's `test/` line about
  covering "the kind → after-work resolution if it moves into a shared helper" is therefore
  satisfied by the existing e2e coverage, and Phase 2 adds no unit test for it.

## Phases

| # | Phase | Delivers | Direct prerequisites |
|---|---|---|---|
| 1 | [Shared task kinds and the guided-dispatch preference](phase-1-shared-contracts.md) | `TASK_KINDS` registry; `guidedDispatch` on `UiConfig` end to end. No UI change. | - |
| 2 | [The guided pass over Kind, Harness and After work](phase-2-guided-pass.md) | The feature, opt-in from the modal header toggle. Rail strip, floating pickers, key handling, e2e fixture pin. | 1 |
| 3 | [Settings → Dispatch, the durable home](phase-3-settings-home.md) | New settings category, panel, toggle, ⌘K indexing. | 2 |
| 4 | [The Repo step](phase-4-repo-step.md) | Repo becomes step 1, driving `RepoCombobox`. Resolves the Escape and filter questions. | 2 |
| 5 | [On by default, and the documentation](phase-5-default-on.md) | Flip `UI_CONFIG_DEFAULTS`; upgrade-path spec; README and docs. | 3, 4 |

## Dependency graph

```
        ┌──────────────┐
        │ 1 · contracts│
        └──────┬───────┘
               │
        ┌──────▼───────┐
        │ 2 · guided   │
        │     pass     │
        └──┬────────┬──┘
           │        │
   ┌───────▼──┐  ┌──▼────────┐
   │ 3 ·      │  │ 4 · repo  │
   │ settings │  │    step   │
   └───────┬──┘  └──┬────────┘
           │        │
        ┌──▼────────▼──┐
        │ 5 · default  │
        │     on + docs│
        └──────────────┘
```

## Concurrency groups

- **Group A:** Phase 1 alone.
- **Group B:** Phase 2 alone.
- **Group C:** Phases 3 and 4, concurrently.
- **Group D:** Phase 5 alone.

Phases 3 and 4 own disjoint files. Phase 3 owns `src/web/lib/settings-registry.ts`,
`src/web/components/SettingsPage.tsx`, a new settings panel, `src/web/lib/settings-search.ts`,
`src/web/App.tsx` and the settings tests. Phase 4 owns `src/web/components/DispatchModal.tsx`,
`src/web/components/RepoCombobox.tsx` and the dispatch e2e specs. They can merge in either
order.

The one file both may touch is `src/web/styles.css`. Ownership is by region: Phase 4 owns the
`.dispatch-*` block (from line 6874) and the guided-pass classes Phase 2 introduces beside it;
Phase 3 owns the settings block and should reuse the existing `settings-toggle` vocabulary
rather than adding classes at all. A conflict here is a textual one in a 23,000-line file, not
a semantic one.

Nothing else runs concurrently, and that is a property of the code rather than a scheduling
choice: phases 2, 4 and 5 all edit `DispatchModal.tsx`, and two agents rewriting the same
component's key handling is a merge no review can usefully check.

## Merge order

1 → 2 → (3 ∥ 4) → 5. Phase 5 must be last: it is the only phase whose merge changes behavior
for someone who has not opted in, and it should not do that until both the Settings home and
the Repo step are in.

## Cross-phase contracts

These are the interfaces later phases rely on. Changing one is a change to this index, not a
local decision.

| Contract | Introduced | Consumed by | Rule |
|---|---|---|---|
| `TASK_KINDS` (ordered tuple + labels) in `src/shared/` | 1 | 2 | The wizard and the Kind `<select>` both render from it. Order is the display order. |
| `UiConfig.guidedDispatch: boolean` | 1 | 2, 3, 5 | Default is `false` until Phase 5. Adding it to `UI_CONFIG_DEFAULTS`, `UiConfigSchema` **and** `uiCache.coerce()` is one atomic obligation - omitting the third resets it on every cold paint. |
| `useGuidedDispatch()` hook | 1 | 2, 3 | The only read/write path. Shaped like `useRichText` (`src/web/lib/rich-text.ts:23-29`). |
| The e2e fixture pins `guidedDispatch` explicitly | 2 | 5 | `e2e/fixtures/test.ts`'s `dashboard` fixture must set it, so no spec depends on the shipped default. Phase 5's flip is safe only because of this. |
| The guided pass is a phase of the existing `OVERLAY_IDS.dispatch` open | 2 | 3, 4 | No second overlay. The stand-down at `App.tsx:1522` keeps working untouched. |
| `afterWorkForKind` stays a `DispatchModal` closure | 2 | 4 | Not extracted. Both the wizard and the `<select>` call it. |
| Wizard step order and the step machine's shape | 2 | 4 | Phase 4 inserts Repo at the front; it does not redesign the machine. |
| Settings category id `dispatch`, anchor prefix `dispatch/` | 3 | 5 | Docs in Phase 5 name this path. |

## Final verification

After Phase 5 merges:

- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke`.
- `npm run test:e2e` in full, not a shard - the claim that the fixture pin protected the
  existing suite is only proved by running all of it after the default has moved.
- A manual pass through the four steps in the built app at the shipped default, including
  <kbd>⇥</kbd> at each step and <kbd>⌫</kbd> from each step.
- `docs/dispatch-and-backlog.md`, `docs/ui.md` and the README describe the pass, its keys and
  the preference, and no longer describe <kbd>+</kbd> as opening the form directly.

## Task mapping

Filled in when the implementation tasks are created; every task also depends on the planning
session that publishes these files.

| Phase | Task |
|---|---|
| 1 | _pending_ |
| 2 | _pending_ |
| 3 | _pending_ |
| 4 | _pending_ |
| 5 | _pending_ |
