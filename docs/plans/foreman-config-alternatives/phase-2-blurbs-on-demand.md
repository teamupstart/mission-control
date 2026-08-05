# Phase 2 - the prose stops being printed twice

## Outcome

The per-field explanatory prose stops occupying the panel permanently and is spent when
asked for. Each tab also states how many settings it holds, so an unopened tab still says
how much is behind it.

The Models tab - the group that made the column long - drops from 380px to roughly 240px,
and no sentence is deleted or made unreachable.

## Entry criteria and dependencies

**Direct prerequisite: Phase 1.** This phase edits the same JSX Phase 1 regroups and adds a
count to the tab labels Phase 1 creates. It cannot run concurrently with Phase 1.

Inherited contracts, none of which this phase may change:

- `FOREMAN_SETTINGS_TABS` and `foremanTabForAnchor` in `src/web/lib/foreman-settings-tabs.ts`.
- The `jumpAnchor` prop, derived during render.
- All four tab panels mounted, inactive ones `hidden`.
- Posture line and Live repositories outside the strip.

## Scope

- Suppress the duplicated visible model blurb in the Foreman panel only.
- Fold the provider and safeguard descriptions into their existing tooltips.
- Add the settings count to each tab label.

### Non-goals

- Deleting any sentence. Every one stays reachable.
- Changing `ModelField`'s behaviour for Inspector, the LLM panel, or the persona editor.
- Any change to group membership, anchors, or the mounting strategy.
- A bespoke focus-reveal mechanism. See the finding below - the repository already has one.

## Repository findings

Read against the working tree. Two of these materially shrink this phase from what the
source plan implies.

### The blurb is already in a tooltip. It is rendered twice.

`ModelField.tsx:86-110` renders `spec.blurb` **twice**:

```tsx
<Tooltip label={spec.blurb}>
  <select id={id} ...>...</select>
</Tooltip>
<p className="settings-hint foreman-model-blurb">{spec.blurb}</p>
```

So the source plan's "move the blurb to a hover affordance" is already half-built. The work
is not to build a hover mechanism; it is to **stop printing the visible duplicate**. Seven of
the eleven Foreman settings are `ModelField`s, so this alone is most of the prose.

### `Tooltip` already satisfies the hover-and-focus requirement

`Tooltip.tsx:154-190` merges `onMouseEnter`, `onMouseLeave`, `onFocus` and `onBlur` onto the
child, so it fires on **focus as well as hover** - the file's header (`:22-25`) says replacing
native `title` was motivated precisely by `title` not firing on focus.

And `:32-40`: the label is **always** also rendered into a visually-hidden body-level portal
that the trigger points `aria-describedby` at, explicitly so that "because this codebase
renders components with `renderToStaticMarkup` and has no jsdom - a label that appears only on
hover cannot be asserted by any test".

Two consequences:

1. Requirement 7 of the source plan (reachable on hover **and** on focus) is met by the
   existing component. This phase must not invent a `:focus-within` reveal; that would be a
   second mechanism for a solved problem.
2. Removing the visible paragraph does not remove the sentence from the rendered markup, so
   prose assertions keep working.

### `ModelField` is shared by four panels

Consumers: `ForemanSettingsPanel.tsx:6`, `InspectorSettingsPanel.tsx:7`,
`LlmSettingsPanel.tsx:4`, `workflows/PersonaEditor.tsx:14`.

Suppressing the visible blurb unconditionally would silently restyle three unrelated
surfaces. **The suppression must be opt-in, defaulting to today's behaviour**, and only the
Foreman panel opts in.

### Which prose the tests actually assert

Checked in `test/foreman-settings-render.test.ts`:

| Assertion | Line | Text | Status |
| --- | --- | --- | --- |
| Backlog launch intro | `:129-130` | `already names one`, `existing session.{0,50}unchanged` | **Group intro - stays visible** |
| Safeguards intro | `:145` | `matching either enabled safeguard` | **Group intro - stays visible** |
| Tier sentences | `:59-64` | all three `TIER_LABEL` strings | Unaffected |
| Safeguard switches | `:134-170` | by `aria-label`, plus `checked` | Unaffected |
| Model fields | `:114-132` | select **ids** only, not blurb text | Unaffected |

No test asserts a `kb-row-desc` string or a model blurb string, and the two group intros this
phase keeps are exactly the two that are asserted. Nothing here needs a test rewritten.

## Implementation steps

1. **`src/web/components/ModelField.tsx`.** Add an optional prop, defaulting to today's
   behaviour:

   ```tsx
   /** Where the blurb is spent. `block` prints it under the field, as every panel but
    *  Foreman's does; `hover` leaves it to the Tooltip, which already carries it on hover,
    *  on focus, and in the hidden portal an assertion can reach. */
   blurb?: "block" | "hover";
   ```

   Render `<p className="settings-hint foreman-model-blurb">` only when `blurb !== "hover"`.
   Do not touch the `Tooltip` wrapper, the `data-anchor`, the label, or `modelSourceNote`.
   The `note` line (`:108`) is a *resolution* readout, not a blurb - it stays in both modes.

2. **`ForemanSettingsPanel.tsx` - the seven model fields.** Pass `blurb="hover"` to the four
   role `ModelField`s (`:540-558`) and the three backlog `ModelField`s (`:625-637`). No other
   consumer changes.

3. **`ForemanSettingsPanel.tsx` - the provider field.** The select is already wrapped in a
   `Tooltip` (`:507`) whose label is the short "Which model provider Foreman's own calls are
   spawned with". Fold the full paragraph at `:531-536` into that label and delete the visible
   `<p>`, so the sentence survives on hover, on focus, and in the hidden portal.

4. **`ForemanSettingsPanel.tsx` - the two safeguards.** Each `kb-row` has a `Tooltip` on its
   switch (`:577`, `:602`) and a visible `<span className="kb-row-desc">` (`:572-575`,
   `:594-599`). Fold each description into its switch's tooltip label and drop the visible
   span. Keep the `kb-row-label` and the `aria-label` exactly as they are - the tests select on
   them.

5. **Keep both group intro paragraphs.** The backlog launch intro (`:620-624`) and the
   safeguards intro (`:563-567`) explain a group rather than a field, they are one per tab
   rather than one per control, and both are asserted by name. They stay visible.

6. **The per-tab count.** Add the number of settings each group holds to its tab label, from
   `FOREMAN_SETTINGS_TABS`. Derive it from the table rather than hard-coding: Posture 1,
   Models 5, Launches 3, Safety 2. Keep it out of the tab's accessible name if it reads badly
   when announced - if so, mark it `aria-hidden` and leave the tab name as the group name.

7. **`src/web/styles.css`.** Any rule that only existed to space the removed paragraphs
   (`.sc-model .foreman-model-row` and neighbours, `:13473-13486`) may need its gap adjusted.
   This range is Foreman-only, so it is safe to change; do not touch the shared rules Phase 1
   lists.

8. **README.** Update the Foreman settings description to say the per-field explanations are
   on hover and focus.

## Tests and verification

### Node tests

- **Existing, must pass unchanged**: `test/foreman-settings-render.test.ts` in full - all five
  assertion groups in the table above - plus `test/foreman-console.test.ts`,
  `test/settings-search.test.ts`, `test/settings-sidebar-render.test.ts`.
- **New**, in `test/foreman-settings-render.test.ts`:
  - the Foreman panel renders **no** `foreman-model-blurb` element, and still contains each
    role blurb's text (proving the Tooltip's hidden portal carries it, not that it was
    deleted);
  - the two safeguard descriptions still appear in the markup while no `kb-row-desc` element
    does;
  - both group intros still render as visible paragraphs.
- **New**, in whichever test file covers the Inspector and LLM panels: `ModelField` still
  prints the visible blurb by default, so the opt-in did not leak. This is the regression that
  matters most and it is cheap.
- **Extend** `test/foreman-settings-tabs.test.ts` (Phase 1): each tab's declared count equals
  the number of settings its anchors cover.

### e2e

- **Extend** `e2e/specs/foreman-settings-tabs.spec.ts` (Phase 1):
  - focusing a model select reveals its explanation, asserted by role/accessible description
    rather than by class;
  - each tab shows its count;
  - the Models tab is measurably shorter than it was, if the spec already takes a measurement.

### Commands

```sh
npm run typecheck
npm run lint
node --test --test-concurrency=2 --import tsx test/foreman-settings-render.test.ts
npm test
npm run build && npm run smoke
npm run test:e2e
```

## Merge and exit criteria

- The Models tab measures visibly shorter than after Phase 1; record the figure from the
  browser.
- Every sentence removed from view is still in the rendered markup and still announced.
- Inspector, the LLM settings panel, and the persona editor render identically to before -
  verify in the browser, not only in tests.
- All the constraint tests pass unchanged.
- README matches.

## Downstream handoff

No later phase. What a future change must not break:

- `ModelField`'s `blurb` prop defaults to `"block"`. A future consumer gets today's behaviour
  unless it opts out.
- A sentence may be moved out of view only into a `Tooltip` label, never deleted - that is
  what keeps it announced and assertable.

## Cross-phase audit record

- **Written after Phase 1.** Re-read `plan.md` and `phase-1-tab-strip-and-anchors.md` before
  starting. Confirmed this phase adds no anchor, moves no anchor between groups, changes no
  group membership, and does not touch the mounting strategy or `jumpAnchor` - so every Phase 1
  contract holds.
- **Reconciliation applied to Phase 1.** Source-plan requirement 6 (per-tab settings count) was
  deferred out of Phase 1 into this phase and recorded in Phase 1's audit record, because the
  count is presentation of the prose work rather than a correctness property of the strip.
  Phase 1's downstream handoff already anticipates this phase adding the count to
  `FOREMAN_SETTINGS_TABS`.
- **Discrepancy recorded against the source plan.** The plan describes the blurb work as
  "moves to a hover affordance and prints in full under whichever field currently has focus",
  which implies building a focus-reveal. The repository disproves the need: `Tooltip` already
  fires on focus and already renders a hidden portal copy, and `ModelField` already wraps every
  model select in one. The work is therefore *removing a duplicate*, not *adding a mechanism*,
  and this phase does the former. The user-visible outcome the plan asked for is unchanged.
- **Final pass over both phases.** Every source-plan requirement is owned by exactly one phase:
  1-5 and 8-10 by Phase 1, 6 and 7 by Phase 2. The dependency direction is single and forward.
  Phase 1 leaves the repository operable on its own - a correct, keyboard-navigable, fully
  deep-linkable tab strip with today's verbose prose. Phase 2 depends on nothing that Phase 1
  does not publish, and no phase relies on a later one to repair an intermediate state.
