# Phase 5 - The everything-palette

## 1. Outcome

`⌘K` stops being a settings-only search and becomes the app-wide palette: one input over Library
assets (workflows, Personas, actions, strategies, missions, sources), live execution objects
(runs, ensembles - with their live state in the row), and settings - grouped as **Jump to** /
**Do** / **Settings**, each row carrying a kind chip. It is the connective tissue between the two
homes: type three letters, land on the shelf card, the live run, or the setting.

Visual reference: `docs/archive/mockups/automation-prominence/4-palette.html` (round 1 concept 4, adopted
unchanged by the plan).

## 2. Entry criteria and dependencies

- Direct prerequisite: **phase 4** (final route table exists; phases 1-3 arrive transitively).
- Entry state: `#/library`, `#/runs`, `#/ensembles` live; legacy redirects in place.

## 3. Scope and non-goals

In scope:

- A provider registry over the existing settings index: each provider contributes typed rows
  (`kind`, title, live-state line, target route or action) from data already in the client's SSE
  stores - no new server calls for search.
- Palette UI: input, grouped results, keyboard navigation (arrows, enter, `esc`), kind filter
  (`tab` per the mockup), accessible listbox semantics.
- "Do" rows for the small set of high-value actions already reachable in one step elsewhere
  (open Dispatch, open Dispatch in ensemble mode, bind a workflow to a session).
- README: palette section; shortcut docs.

Non-goals:

- No server-side search endpoint; the palette reads client stores.
- No new actions that do not already exist as one-step affordances.
- No fuzzy-matching library additions without an explicit project decision; extend the existing
  matching in `settings-search.ts`.

## 4. Repository findings and inherited contracts

- `src/web/lib/settings-search.ts`: `buildSettingsBindings` + `searchSettings` - the existing
  index and matcher; the palette generalizes this into providers rather than replacing it.
- SSE stores exposed by `useEventStream.ts` already hold workflows, personas, session actions,
  runs (`WorkflowRunSummary`), ensembles (`EnsembleSummary`), schedules, and task sources - the
  live-state lines come from these.
- Keyboard entry point: the existing `⌘K` binding routes to settings search today; rebind to the
  palette (`keybindings.ts`).
- Inherited contracts: final route table from phase 4 (navigate only to published routes);
  Library shelf anchors from phase 2; `line_summary` store from phase 3 if a stage row is offered.

## 5. Implementation steps

1. `src/web/lib/palette-index.ts` (new): provider interface + providers for library assets,
   runs, ensembles, missions/sources, settings (wrapping the existing bindings), actions.
2. `src/web/components/Palette.tsx` (new): dialog + listbox per the mockup vocabulary (group
   headers, kind chips, live-state small text, footer hints); `esc` layering above drawers.
3. `App.tsx`: mount, rebind `⌘K`, remove the settings-only search entry point (its panel search
   keeps working inside Settings if it exists independently).
4. README + shortcut docs.
5. Tests:
   - `test/`: provider outputs from store fixtures (a run row carries status; an archived asset
     does not appear; settings rows still match).
   - e2e `e2e/specs/palette.spec.ts`: `⌘K` opens; typing a workflow name surfaces it with kind
     chip and enter lands on the Library card; a live run row navigates to `#/runs/:id`; a
     setting row navigates to its panel; `esc` closes without navigation.

## 6. Data / API / migration

None. Client-only; no wire or DB changes.

## 7. Verification

`npm run typecheck && npm run lint && npm test`; `npm run build && npm run smoke`;
`npm run test:e2e` including the new spec.

## 8. Merge and exit criteria

- `⌘K` opens the palette everywhere; all kinds searchable with live state; keyboard-complete.
- All checks green; README matches.

## 9. Downstream handoff

The palette's provider registry is the extension point for future kinds (e.g. sessions, tasks).
Later work must not fork a second search index; providers wrap stores.

## 10. Cross-phase audit record

- 2026-08-02: drafted against `81fd089`. Depends only on phase 4 directly; navigation targets
  audited against the final route table in phase 4's handoff. No conflicts with phases 1-3
  contracts; the palette reads, never recomputes, the `line_summary` store.
