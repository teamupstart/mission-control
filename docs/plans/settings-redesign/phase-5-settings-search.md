# Phase 5: Settings search

Source plan: `docs/plans/settings-redesign/plan.md` (requirements R15-R17, decision
D5). Visual target: the ⌘K palette in `docs/plans/settings-redesign/prototype.html`
(including the `?search=` prefill behavior there being a prototype-only test hook -
the shipped surface opens from the shortcut, the rail box, and the gear).

## Outcome

A search palette over every settings control: type what you remember, land on the
control. Boolean controls flip inline in the results (except the risky set, which
always jumps to its consent copy); everything else jumps to the category and flashes
the anchored control.

## Entry criteria and dependencies

- Depends on: Phase 2 and Phase 3 (the index must cover Trust and the harness cards at
  ship; both also finalize the anchor set). Phase 1 arrives transitively.
- May run concurrently with Phase 4 (different regions of `SettingsPage`/`App`; no
  shared contracts).

## Scope

In: the control-level index beside the registry, the palette component, the rebindable
shortcut, jump+flash, inline toggles, tests, README.

Non-goals: inline editing of non-boolean scalars (they jump); fuzzy ranking beyond
substring matching (keep it deterministic; revisit only with evidence); indexing
runtime data (repo names, PR numbers - the index is controls, not content).

## Repository findings this phase builds on

- Registry and anchors from Phase 1: `SETTINGS_CATEGORIES` carries `keywords`; every
  control row carries a unique `data-anchor="<category>/<slug>"` pinned by a test.
- Keyboard shortcuts are a registry: `ActionId` + `ACTIONS` in
  `src/web/lib/keybindings.ts` (array order is panel order), a dispatch branch in
  `App.tsx`, a `CommandBar` keycap where applicable, a README table row, and a
  `keybindings.test.ts` case; a new group needs a `GROUPS` entry in `KeyboardPanel`.
  `chordFromEvent` already supports modifiers; reserved keys are bare
  arrows/Escape-class keys, so `⌘K` is bindable. Nothing binds `meta+k` today.
- Escape layering: the Keyboard panel's chord recorder runs a capture-phase listener
  that swallows keys mid-record; the palette must use a plain bubble-phase listener so
  recording wins - same contract the modal documented against its Overlay.
- The compose-parity rules do not apply: the palette input is not a compose box (no
  drafts, no attachments, no reply-box registration); say so in the component comment
  to head off the checklist.
- Phase 1's page owns Escape-to-fleet; the palette layers above it (palette open →
  Escape closes the palette only).

## Implementation steps

1. **Index** (`src/web/lib/settings-search.ts`, colocated conceptually with the
   registry): `SETTINGS_CONTROLS: SettingsControl[]` where
   `{ id, label, description, category: SettingsCategoryId, anchor, keywords,
   kind: "toggle" | "jump", risky?: true }`. Entries cover, at minimum: layout,
   format messages, keyboard (one entry), auto mode, per-harness cards, skills master,
   per-skill toggles are NOT indexed individually (catalog is dynamic; one "Skills
   catalog" entry), cost track/interval/lead-with, cheap tier, Foreman provider+models
   (one entry), task sources (one entry), background job models (one entry), Inspector
   enable (risky), Inspector mode (risky), review model, YOLO (risky), soak, merge
   method, Trust grants. Risky = the D5 set: flips only at the panel.
   The palette also offers "Jump to" hits for category-name matches via
   `SETTINGS_CATEGORIES.keywords`.
2. **Toggle bindings**: the page builds a `Map<controlId, { get(): boolean;
   set(v: boolean): void }>` for the non-risky toggle controls from the hooks it
   already owns, passed to the palette. The index stays static data; the bindings are
   runtime wiring - a control with `kind: "toggle"` and no binding renders as a jump
   (never a dead switch).
3. **Palette** (`src/web/components/SettingsSearch.tsx`): veil + panel per the
   prototype; substring match over label+description+keywords; grouped results
   (Settings / Jump to); roving selection with arrows, Enter opens/toggles per kind,
   Escape closes; mouse hover moves selection. Inline toggles re-render from the
   binding's `get()` after `set()` so the poll round-trip is visible honestly.
4. **Jump + flash**: palette closes, page navigates (`onNavigate`), then scrolls the
   anchor into view and applies a `flash` class (CSS animation in the settings-page
   section) - the Phase 1 anchor contract's consumer.
5. **Shortcut**: `settingsSearch` ActionId (group `global`, default `meta+k`, label
   "Search settings"); dispatch branch in `App.tsx` navigates to settings (if needed)
   and opens the palette; KeyboardPanel renders it via the existing registry walk;
   README keyboard table row; decide the CommandBar question by looking at whether
   global-group actions render keycaps there today and match that - state the answer
   in the PR.
6. **Entry points**: add the rail search box (Phase 1 deliberately shipped none - a
   dead box would lie) showing the current chord as its hint. The gear keeps
   navigating to the page as in Phase 1; the prototype's gear-opens-palette was a
   prototype convenience, resolved in the source plan (D5) in favor of the gear's one
   job.
7. **README**: search section (what is indexed, inline-toggle rule and the risky
   exemption, the shortcut).

## Data / API / migration

None. No daemon involvement.

## Tests and verification

- `settings-search.test.ts`: every control's `category` exists in
  `SETTINGS_CATEGORIES`; every `anchor` appears in the rendered page's anchor set
  (drive the Phase 1 collection helper); no duplicate control ids; risky controls
  never receive bindings; substring matching returns the soak entry for "soak" and the
  Trust entry for "allowlist".
- `keybindings.test.ts`: the new action registers, default chord `meta+k`, rebind and
  reset round-trip.
- Palette render test: results for a query, inline switch for a bound toggle, jump
  badge for the rest.
- `npm run typecheck && npm test && npm run build`; manual: ⌘K from the fleet and from
  inside settings; Escape layering against an in-progress chord recording; flash lands
  on the right control for a cross-category jump.

## Merge and exit criteria

- Palette shipped with the registry-derived index and the rebindable shortcut; anchor
  integrity test green against the full post-Phase-2/3 page; CI green.

## Downstream handoff (later phases rely on; do not change)

- `SETTINGS_CONTROLS` is the one control-level index; new settings add an entry beside
  their control (the integrity test fails on anchors without entries only in the
  curated set above - keep the test's expectations in that file, not scattered).

## Cross-phase audit record

- 2026-07-23: initial version. Depends-on tightened to Phases 2+3 (index completeness)
  rather than 1 alone; concurrency with Phase 4 verified (no shared contract; textual
  merge in `SettingsPage` rail area is expected and trivial). Phase 1's anchor
  uniqueness test is the load-bearing precondition and is already shipped by then.
