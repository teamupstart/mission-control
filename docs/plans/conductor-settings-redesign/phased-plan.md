# Conductor settings redesign - implementation index

Source plan: [`plan.md`](plan.md) (rendered: [`plan.html`](plan.html)).

The approved change gives the Conductor settings category the master-detail shape Task sources
already uses, opens its directory on the repositories Conductor manages rather than on all 202 in
the workspace, and lands three smaller drifts alongside it.

## Incorporated decisions

These arrived from the plan review and are requirements here, not open questions:

| Decision | Chosen |
| --- | --- |
| Page shape | Directory and detail - the master-detail shape Task sources uses |
| Default list contents | Managed repositories first; the rest one filter tile away |
| Rides along | Settings-search entries for all six anchors; a Conductor rail dot; dropping the borrowed and bespoke classes |
| Deferred | Trimming the lede, the commissioning ladder and the plugin prose |

## Investigated findings

Everything below was read in this repository, and two of them contradict what the plan or a
first reading assumed.

1. **All six `conductor/*` anchors already render.** `ConductorPanel` has one unconditional
   `return` (`src/web/components/ConductorPanel.tsx:385`), `.sc-controls` (`:438`) is not behind a
   config guard, and `ConsoleCard` always emits `data-anchor={anchor}`
   (`src/web/components/settings-console.tsx:77`). So `conductor/pipelines`, `/detection`,
   `/enabled`, `/launch-runtime`, `/foreman-triage` and `/repos` are all in the static markup
   today. The five new search entries can point at anchors that already exist, and need no new
   markup. *An initial reading claimed only two anchors render; it was checked against the source
   and rejected.*
2. **`renderToStaticMarkup` runs no effects.** `test/settings-search.test.ts:124-132` renders every
   category statically and fails any indexed anchor that no panel renders. Any anchor placed behind
   a "config has loaded" conditional would therefore fail the suite. New anchors, if any, stay
   unconditional.
3. **A repo-scoped pipelines deep link does not exist.** The route grammar has exactly two
   pipeline forms - `#/runs/pipeline` and `#/runs/pipeline/:repoKey/:slug`
   (`src/web/workflows/useWorkflowRoute.ts:352-362`, `:468-478`). There is no `:repoKey`-only form,
   and the panel holds no run slug (`PipelineRepoStatus` carries counts, not slugs). This is a
   genuine discrepancy with the approved mockup's "Open pipelines" button, resolved in the phase
   file: ship the tab-level link, which already exists, and leave repo scoping out of scope.
4. **`settingsRailDot` already accepts `"conductor"`.** Its `id` parameter is
   `SettingsCategoryId | "trust"` (`src/web/lib/settings-dots.ts:59-61`) and the registry has
   carried `conductor` since `settings-registry.ts:227`. No type widening is needed - only a `case`.
5. **`dotLabel` switches on tone before category** (`src/web/components/SettingsPage.tsx:81-108`).
   A Conductor dot reusing the `armed` or `live` tone without adding a `category === "conductor"`
   arm makes a screen reader announce "YOLO mode is armed" on the Conductor row.
6. **`risky` search entries are pinned by a deep-equal literal**
   (`test/settings-search.test.ts:296-302`). The new entries are `kind: "jump"` and non-risky, so
   that literal is untouched.
7. **`.sc-seg` has no CSS of its own** - the layout comes from `.sc-field` and `.sc-seg-row`
   (`src/web/styles.css:18881-18900`, `:18943-18988`). `InspectorSettingsPanel.tsx:307-326` is
   already a live two-option instance and is the direct copy target. `is-on` is applied by hand;
   there is no `:has(input:checked)` rule.
8. **`ConsoleSwitch` is the replacement for the borrowed `skill-switch`.** It is already exported
   (`settings-console.tsx:96`), already used by this panel, and part of the `sc-` vocabulary the
   panel is otherwise in. Its track is 38x22px against `skill-switch`'s 15x15px checkbox, so the
   row's `align-items: flex-start` needs a look.
9. **Selection is not addressable.** Task sources holds it as plain local state keyed by id
   (`TaskSourcesPanel.tsx:936`), and the settings route grammar is category-only by design
   (`settings-registry.ts:317-322`). Conductor does the same, keyed by
   `pipelineRepoKey(provider, repoRoot)`. Do not invent a hash form.
10. **Test churn is smaller than the file sizes suggest.** 9 of 23 tests in
    `test/conductor-panel.test.ts` touch row markup, and 5 of 12 in
    `e2e/specs/settings-conductor.spec.ts`. `test/settings-sidebar-render.test.ts` fingerprints the
    panel by the string "Conductor commissioning progress", which survives only because trimming
    the ladder was deferred.

## Sizing

**Estimate: 620-780 gross non-test implementation lines**, counting lines added or materially
changed across every layer.

| Surface | Estimate | Assumption |
| --- | --- | --- |
| `ConductorPanel.tsx` - directory, detail pane, filter fold, selection | ~360 | Mirrors `SourceDirectory` + helpers (~147 lines) plus a richer detail pane than Task sources', which delegates to a separate `SourceCard`; replaces the 119-line list section |
| `styles.css` - master-detail, directory, tiles; minus old `.conductor-repo*` | ~180 | The `ts-*` directory and master-detail block is ~165 lines |
| `settings-search.ts` - five new entries | ~50 | Existing entries run 9-13 lines each |
| `settings-dots.ts` + `dotLabel` branch | ~25 | One `case` plus one tone arm |
| `SettingsPage.tsx` + `App.tsx` - the pipelines callback | ~18 | Mirrors the `onOpenRuns` precedent |
| `sc-seg` swap for the Engineer host radios | ~30 | Copy of `InspectorSettingsPanel.tsx:307-326` |
| `docs/pipelines.md` "five cards" section | ~40 | The section is `:110-140` |

Excluded from the estimate, and real: roughly 180 lines of unit-test rework and 220 of e2e rework
and new coverage.

## Phase count: one

Above the 200-line one-shot threshold, the rubric still defaults to one phase, and nothing here
overturns that. The work is a single panel plus the two registries that describe it - a vertical
slice that produces working behaviour, not a stack of layers.

Three splits were considered and rejected:

- **Ride-alongs as a second phase** (~75 lines: the search entries and the rail dot). It would be
  strictly serial - the search entries must point at anchors this change finalizes, and
  `settings-search.test.ts` fails an anchor that renders nowhere - so it buys no parallelism, only
  a second pull request. A sub-100-line trailing phase is the balance-making cleanup phase the
  rubric forbids.
- **A layer split** (shared registries, then the component). An application-layer boundary is not
  by itself a phase boundary, and both `skill-switch` and the Engineer host radios sit *inside* the
  exact regions the restructure rewrites - splitting them out puts two agents in one file.
- **A behavioural split** ("bound the list" first, "add the detail pane" second). This is a real
  vertical boundary, but it restyles the repository list twice and, because every UI change here
  requires a Playwright spec, pays for two full e2e rewrites to ship one approved design.

## Phases

| Phase | Name | File | Depends on | Repositories |
| --- | --- | --- | --- | --- |
| 1 | Directory and detail | [`phase-1-directory-and-detail.md`](phase-1-directory-and-detail.md) | This planning session's PR | `ai-harness` only |

## Dependency graph

```mermaid
flowchart LR
  P["Planning PR<br/>publishes plan.md, phased-plan.md, phase-1"] --> F1["Phase 1<br/>Directory and detail"]
```

There is one phase, so there is no concurrency group and no merge ordering beyond the planning
pull request. Phase 1's task is gated on this session and releases when the planning PR merges.

## Cross-phase contracts

With one phase there is nothing to hand downstream, but three contracts are recorded because
later work will meet them:

- **The row switch keeps `aria-label="Observe pipelines in <name>"`.**
  `e2e/specs/settings-conductor.spec.ts:253-254` reaches rows through it, and holding it steady is
  what keeps the stale-consent test from needing a rewrite.
- **Anchors stay unconditional and keep their current six names.** The search index points at them
  and the render test requires each to appear inside the Conductor panel and nowhere else.
- **The selected repository is keyed by `pipelineRepoKey(provider, repoRoot)`**, never by list
  index, because the view is polled every four seconds.

## Final verification

- `npm run typecheck` and `npm run lint`.
- `npm test`, with `test/conductor-panel.test.ts`, `test/settings-search.test.ts`,
  `test/settings-dots.test.ts` and `test/settings-sidebar-render.test.ts` all green.
- `npm run build`, then `npm run test:e2e` for `e2e/specs/settings-conductor.spec.ts`, including
  the new bound spec that seeds many repositories and asserts the page does not render all of them.
- `docs/pipelines.md` matches the shipped panel.
