# Phase 1 - the tab strip, the group table, and the deep-link contract

## Outcome

The Foreman settings pane's control column becomes four tabbed groups instead of five stacked
cards. Its height stops being the sum of every card (1988px) and becomes the tallest group
(557-729px depending on the tab). Every existing deep link still lands on its control, and
the tab strip is operable from the keyboard and announced correctly.

This is the phase that carries the whole risk of the change. The prose compaction is Phase 2
and is worthless if this one is wrong.

## Entry criteria and dependencies

Direct prerequisites: **none.** This is the first phase.

Requires only the current working tree. No migration, no server change, no wire-contract
change.

## Scope

- A pure, exported tab table for the four groups and the anchors each owns.
- The tab strip in `ForemanSettingsPanel.tsx`, with rail-grade keyboard semantics.
- Regrouping the existing cards into four tab panels, **all four mounted**, inactive ones
  `hidden`.
- Anchor-to-tab routing, so a deep link selects the owning tab before the flash runs.
- Updating the two existing e2e specs that assume a click-free pane, and adding a new spec
  for the tab behaviour and the deep link.
- Updating and adding node tests.

### Non-goals

- Moving any field's blurb to a hover. That is Phase 2, in its entirety.
- Per-tab settings counts on the tab labels. Phase 2.
- Any change to the ledger, the strip, or their filtering.
- Any change to `InspectorSettingsPanel.tsx` or `ShippingSettingsPanel.tsx`.
- Any change to `ConsoleCard` or any other export of `settings-console.tsx`. Every one of
  them has three or more consumers; see the findings.
- Persisting the selected tab anywhere.

## Repository findings

Read against the working tree, not assumed from the plan.

### The constraint that decides the whole design

**Inactive tab panels must stay mounted.** Two node tests require every Foreman anchor to be
present in a single `renderToStaticMarkup` call, with no interaction possible:

- `test/foreman-console.test.ts:190-209` - *"every settings anchor survives the console
  rewrite"* asserts eleven literal `data-anchor` strings are present in one render, then
  asserts `(out.match(/data-anchor="foreman\/(model|backlog-model)-/g) ?? []).length === 7`.
- `test/settings-search.test.ts:106-114` - *"every control's anchor is one the page actually
  renders"* checks every entry in `SETTINGS_CONTROLS` against the union of anchors rendered by
  a default static render of its category.

Four of the five indexed Foreman anchors sit in three different groups
(`foreman/cheap-tier` in Posture, `foreman/provider` in Models, both
`foreman/skip-*-wrapup` in Safety), so no single paint can show them all if inactive panels
unmount.

Both tests are protecting something real - an anchor that silently stops rendering is a dead
search hit - so this phase satisfies them rather than rewriting them. **All four tab panels
render; the inactive ones carry `hidden`.** `hidden` keeps the element in the document (so
both tests pass unchanged and `document.querySelector` still finds it) and removes it from
layout (so the column actually gets shorter) and from the accessibility tree and tab order.

### The deep-link machinery, and why `hidden` alone is not enough

`SettingsPage.tsx:270-334` owns the one scroll-and-flash implementation. The relevant
mechanics:

- `:292-293` `findAnchor()` is a document-wide `document.querySelector('[data-anchor="..."]')`.
- `:286-291` `flash()` calls `el.scrollIntoView({ block: "center", behavior: "smooth" })` and
  adds `settings-flash` for `FLASH_MS = 3200` (`:50`).
- `:310-325` when the element is absent, a `MutationObserver` on `.settings-page` with
  `{ childList: true, subtree: true }` waits up to `ANCHOR_WAIT_MS = 5000` (`:60`) and then
  **gives up silently** - no error, no fallback scroll. The comment at `:299-309` states this
  is deliberate.
- `:277` the anchor's prefix is the category gate: `pending.anchor.split("/")[0] !== category`.

So with panels mounted-but-hidden, `findAnchor()` succeeds immediately and `flash()` runs
against a `display: none` element: `scrollIntoView` is a no-op and the animation is invisible.
The deep link would appear to do nothing, which is worse than the current behaviour.

The fix is ordering, and it needs no change to that effect. React commits a child's render
before running a parent's effect, so if the panel has already selected the owning tab by the
time `SettingsPage`'s flash effect runs, the element is visible and `scrollIntoView` works.
That is what this phase builds, and the e2e spec below is what proves it rather than assuming
it.

### Anchors this panel renders

Nine distinct anchors, eleven elements (`ForemanSettingsPanel.tsx`):

| Anchor | Line | Group after this phase |
| --- | --- | --- |
| `foreman/cheap-tier` | `:476` | Posture |
| `foreman/provider` | `:503` | Models |
| `foreman/model-{review,verify,triage,backlog}` | `:543` | Models |
| `foreman/backlog-model-{claude,codex,pi}` | `:628` | Launches |
| `foreman/skip-scout-wrapup` | `:569` | Safety |
| `foreman/skip-review-artifact-wrapup` | `:591` | Safety |
| `foreman/live-repos` | `:640` | **outside the tabs** |
| `foreman/health` | `:661` | **outside the tabs**, and conditional on `status` |
| `foreman/episodes` | `:692` | the ledger, untouched |

Two indirections to preserve: `ConsoleCard`'s `anchor` prop lands on its `<section>`
(`settings-console.tsx:65`), and `ModelField`'s lands on its `<div className="foreman-model-row">`
(`ModelField.tsx:87`), where the doc comment at `:65-72` records that the prop is required
because "a silently absent anchor is a control search can never reach".

### Foreman has no Trust setting

`TrustGrantSummary` (`TrustPanel.tsx:343-380`) renders a count plus a `settings-link` that
calls `onNavigate("trust", "trust/matrix")`. The allowlist is edited in the Trust category.
**Live repositories stays outside the tab strip and stays a sentence with a link.** No tab may
contain a repository editor.

### The pattern to follow

`SettingsPage.tsx:507-553` plus its `onTablistKey` at `:380-408` is the repository's only
full roving-tabindex tab implementation, and it is already pinned by
`test/settings-sidebar-render.test.ts:349-395`. Mirror it: `role="tablist"` on the strip,
`role="tab"` + `aria-selected` + `tabIndex={active ? 0 : -1}` on each button,
`role="tabpanel"` + `aria-labelledby` on each panel, arrows wrapping, Home and End, with
`preventDefault` and `stopPropagation` and `.focus()` on the new tab.

`src/web/lib/detailTabs.ts:19-52` is the precedent for keeping the tab table as a pure
exported value so the strip and any keyboard stepper cannot drift, "and makes the list itself
testable without a DOM" (`:1-11`). Follow it.

**Do not** copy `.sc-seg` / `.sc-seg-opt` for the strip. That is a radio group in a
`<fieldset>` and `test/settings-console.test.ts:269-277` pins it as one
(`/<fieldset class="sc-field sc-seg"[^>]*>\s*<legend/`). The cheap-tier control keeps using it
unchanged; the tab strip needs its own class.

### Tests that constrain this phase

| Test | Line | What it pins | Action |
| --- | --- | --- | --- |
| `test/foreman-console.test.ts` | `:190-209` | 11 anchors in one static render, 7 model anchors | Must pass **unchanged** |
| `test/settings-search.test.ts` | `:106-114` | every indexed anchor rendered by default | Must pass **unchanged** |
| `test/settings-sidebar-render.test.ts` | `:177-196` | anchor uniqueness and prefix | Must pass unchanged |
| `test/foreman-settings-render.test.ts` | `:66-82` | slices HTML **between** `foreman/cheap-tier` and `foreman/provider`, counts `checked` | Verify the slice still holds across the new panel boundary; nothing introduced between them may contain the string `checked` |
| `test/foreman-console.test.ts` | `:427-438` | `sc-split`, `sc-card`, `sc-state`, `sc-strip`, `sc-table`, `sc-ledger` present; `sc-switch` absent | Must pass unchanged |
| `test/settings-console.test.ts` | `:269-277` | `.sc-seg` is a fieldset+legend radio group | Must pass unchanged |

`aria-selected="true"` does not contain the substring `checked`, so the slice test is expected
to survive; confirm it rather than assume it.

### e2e specs that break without an update

- `e2e/specs/dispatch-and-converse.spec.ts:472-503` - navigates to `#/settings/foreman` and
  immediately asserts both safeguard checkboxes are visible and checked. Safety is not the
  default tab, so this **must** be updated to select the Safety tab first, by role.
- `e2e/specs/foreman-decision-ledger.spec.ts:175-181` - `openLedger` navigates and expects the
  ledger. The ledger is outside the tab strip, so this is expected to keep passing; its
  page-overflow budget at `:320-323` (`scrollHeight - innerHeight < 2000`) can only improve.
  Confirm both rather than assume.

## Implementation steps

1. **`src/web/lib/foreman-settings-tabs.ts` (new).** A pure module, no React import:
   - `FOREMAN_SETTINGS_TABS`: an ordered, `as const` array of `{ id, label, anchors }` for
     `posture`, `models`, `launches`, `safety`, where `anchors` lists the `data-anchor` values
     that group owns.
   - `ForemanSettingsTabId` type derived from it.
   - `foremanTabForAnchor(anchor: string): ForemanSettingsTabId | null` - the single answer to
     "which tab owns this anchor", returning `null` for anchors outside the strip
     (`foreman/live-repos`, `foreman/health`, `foreman/episodes`).
   - `FOREMAN_DEFAULT_TAB = "posture"`.

   Keep the anchors listed here rather than derived from the JSX; the test below holds the two
   against each other.

2. **`ForemanSettingsPanel.tsx` - the tab state.** Add
   `const [tab, setTab] = useState<ForemanSettingsTabId>(FOREMAN_DEFAULT_TAB)`.

   Add an optional prop `jumpAnchor?: string | null`. Derive the tab from it **during render**,
   not in an effect, keeping the previous value in a ref:

   ```tsx
   const lastJump = useRef<string | null>(null);
   if (jumpAnchor !== lastJump.current) {
     lastJump.current = jumpAnchor ?? null;
     const owner = jumpAnchor ? foremanTabForAnchor(jumpAnchor) : null;
     if (owner && owner !== tab) setTab(owner);
   }
   ```

   Deriving during render is what makes the deep link work: the tab is already selected in the
   committed DOM before `SettingsPage`'s flash effect runs, so `scrollIntoView` has a visible
   element. An effect would run too late and flash a hidden control.

3. **`ForemanSettingsPanel.tsx` - the strip and the panels.**
   - Render `ConsoleState` (the posture line) and the `!config` warning **above** the strip, so
     they are visible in every tab.
   - Render the strip as `role="tablist"` with `aria-label="Foreman configuration groups"`, one
     `role="tab"` button per entry, mirroring `SettingsPage.tsx:507-553`. New class `sc-tabs` /
     `sc-tab`; do not reuse `sc-seg`.
   - Render **all four** `ConsoleCard`s, each wrapped so the wrapper carries
     `role="tabpanel"`, `aria-labelledby`, and `hidden={tab !== id}`.
   - Group membership: Posture = the cheap-tier fieldset; Models = provider + the four
     `ModelField` roles (keep `ModelSuggestions` with them); Launches = the three backlog
     `ModelField`s and their intro paragraph; Safety = the two `kb-row` safeguards and their
     intro paragraph.
   - Leave the Live repositories card, the Right now card, and the ledger exactly where they
     are, outside the strip.

4. **Keyboard handling.** Add an `onKeyDown` on the tablist implementing ArrowLeft/ArrowRight
   (wrapping), Home, End, with `preventDefault()`, `stopPropagation()`, and focusing the newly
   selected tab through a `Map` of refs. `aria-orientation` is horizontal (the default), unlike
   the rail's vertical strip.

5. **`SettingsPage.tsx` - pass the anchor down.** The page already holds
   `pending: { anchor, id } | null` (`:254`). Pass `jumpAnchor={pending?.anchor ?? null}` to
   `ForemanSettingsPanel`. No other change to that file; the flash effect, the observer, and
   the timeouts stay exactly as they are.

6. **`src/web/styles.css` - the strip.** Add `.sc-tabs` / `.sc-tab` in the `sc-` block near the
   other console pieces. Do not modify any rule listed in the findings as shared by three or
   more panels - in particular `.sc-controls` (`:13272-13277`), `.sc-card*`
   (`:13283-13322`), `.sc-seg*` (`:13509-13554`).

7. **README.** The settings section documents the Foreman pane; update it to describe the four
   groups and that the posture line and Live repositories sit outside them.

## Tests and verification

### Node tests

- **New** `test/foreman-settings-tabs.test.ts`:
  - every anchor listed in `FOREMAN_SETTINGS_TABS` is unique across groups;
  - every anchor the panel renders is either owned by exactly one group or is one of the three
    deliberate outsiders - held against a `renderToStaticMarkup` harvest of `data-anchor`, so
    the table cannot drift from the JSX;
  - every Foreman entry in `SETTINGS_CONTROLS` resolves through `foremanTabForAnchor` to a
    group or is a known outsider;
  - `foremanTabForAnchor` returns `null` for `foreman/live-repos`, `foreman/health`,
    `foreman/episodes`.
- **New**, in `test/foreman-console.test.ts`: the tab a11y contract, mirroring
  `test/settings-sidebar-render.test.ts:349-395` - one `role="tablist"`, four `role="tab"`,
  exactly one `aria-selected="true"`, roving `tabindex` (one `0`, three `-1`), four
  `role="tabpanel"` each `aria-labelledby` its tab, and exactly three carrying `hidden`.
- **Existing, must pass unchanged**: the six rows in the constraint table above. Run
  `test/foreman-console.test.ts`, `test/foreman-settings-render.test.ts`,
  `test/settings-search.test.ts`, `test/settings-sidebar-render.test.ts`,
  `test/settings-console.test.ts`.

### e2e

- **New** `e2e/specs/foreman-settings-tabs.spec.ts`:
  - each tab reveals its own group and hides the others, selecting by
    `getByRole("tab", { name: ... })` and asserting on controls by their accessible names;
  - the posture line is visible in every tab;
  - keyboard: focus a tab, ArrowRight moves and selects, Home returns to the first;
  - **the deep link** - the load-bearing case. Drive it the way the palette does, then assert
    the owning tab became selected, the control is visible, and it carries `settings-flash`.
    `e2e/specs/palette.spec.ts:212-231` is the existing shape of that assertion
    (`toHaveClass(/settings-flash/)`); follow it for `foreman/skip-scout-wrapup`, which is in a
    tab that is not the default;
  - Live repositories renders a link and no editor: assert the "Manage in Trust" control is a
    link/button and that the Live repositories region contains no `combobox` or `checkbox`.
- **Update** `e2e/specs/dispatch-and-converse.spec.ts:472-503` to select the Safety tab by role
  before asserting on the two checkboxes. Keep everything else about that test, including the
  reload-and-re-assert, intact.
- **Confirm** `e2e/specs/foreman-decision-ledger.spec.ts` passes untouched.

No `data-testid` anywhere. Select by role, label, or placeholder.

### Commands

```sh
npm run typecheck
npm run lint
node --test --test-concurrency=2 --import tsx test/foreman-console.test.ts
node --test --test-concurrency=2 --import tsx test/foreman-settings-tabs.test.ts
npm test
npm run build && npm run smoke
npm run test:e2e
```

`npm run test:e2e` needs `npm run build` first and `npx playwright install chromium` once per
machine.

## Merge and exit criteria

- The control column measures under 800px on every tab, against 1988px today. Take the figure
  from the browser, not from the diff.
- All six constraint tests pass unchanged; the two new test files pass.
- The deep-link e2e case passes - this is the one that must not be waived.
- `dispatch-and-converse.spec.ts` passes with its tab click; `foreman-decision-ledger.spec.ts`
  passes untouched.
- Inspector and Shipping are untouched in the diff.
- README matches.

## Downstream handoff

Phase 2 may rely on:

| Contract | Shape | Notes |
| --- | --- | --- |
| `FOREMAN_SETTINGS_TABS` | ordered `as const` of `{ id, label, anchors }` in `src/web/lib/foreman-settings-tabs.ts` | Phase 2 adds the per-tab settings count. Add it as a derived value or a new field; **do not** reorder or rename the ids, and do not move an anchor between groups. |
| `foremanTabForAnchor(anchor)` | `(anchor: string) => ForemanSettingsTabId \| null` | The single answer to which tab owns an anchor. Phase 2 must not add a second one. |
| `jumpAnchor` prop on `ForemanSettingsPanel` | `string \| null`, derived during render | The deep-link contract. Phase 2 must not convert this to an effect. |
| All four panels mounted, inactive `hidden` | - | Load-bearing for two node tests and every deep link. Phase 2 must not switch to unmounting. |
| Posture line and Live repositories outside the strip | - | Phase 2 must not move them into a tab. |

Phase 2 must not change: the group membership, the anchor set, the tabpanel mounting strategy,
or anything in `settings-console.tsx`.

## Cross-phase audit record

- **Written first, no earlier phases to reconcile against.**
- Confirmed this phase leaves the repository operable on its own: the column is short, every
  deep link resolves, and the pane is fully keyboard operable. The blurbs are still printed
  under every field, exactly as today - verbose, and correct.
- Recorded the one discrepancy against the source plan: the plan's requirement 6 (each tab
  states how many settings it holds) is deliberately deferred to Phase 2, because it belongs
  with the prose work and is not needed for the tab strip to be correct. No other source-plan
  requirement is deferred.
