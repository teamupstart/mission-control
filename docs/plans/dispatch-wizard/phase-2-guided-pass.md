# Phase 2 - The guided pass over Kind, Harness and After work

## Outcome

Pressing <kbd>+</kbd> with the preference on asks three keyboard questions inside the dispatch
modal - Kind, Harness, After work - and hands over the ordinary form with those answers set and
the cursor in the task box. The modal never changes size or reflows; a strip under the header
keeps the answers visible and reversible.

Opt-in in this phase: the preference still ships `false`, and the way you turn it on is the
**Guided** toggle in the modal header, which is present whether or not a pass is running.

## Entry criteria and dependencies

- Direct prerequisite: **Phase 1**.
- Inherited contracts: `TASK_KINDS` and its labels, `UiConfig.guidedDispatch` (default `false`),
  `useGuidedDispatch()`.

## Scope

1. The step machine and its state, inside `DispatchModal`.
2. The rail strip under the modal header.
3. In-place floating pickers over the Agent, Kind and After work controls.
4. Key handling: mnemonics, <kbd>↑</kbd><kbd>↓</kbd>, <kbd>↵</kbd>, position digits,
   <kbd>⌫</kbd>, <kbd>⇥</kbd>, <kbd>esc</kbd>.
5. The **Guided** header toggle.
6. Conditioning the mount autofocus.
7. **Pinning `guidedDispatch` in the e2e dashboard fixture.**
8. A Playwright spec, and the CSS.

### Non-goals

- **No Repo step.** The pass starts on Kind. Phase 4 inserts Repo in front.
- No Settings surface. Phase 3.
- The default stays `false`. Phase 5.
- No change to what dispatch submits, or to `DispatchDraft`'s shape.
- No rebindable mnemonics.

## Repository findings

**The modal unmounts per opening.** `DispatchLayer` does `if (!open) return null`
(`DispatchModal.tsx:532`) before rendering either modal, so `DispatchModal`'s own `useState`
resets every time the dialog opens. Wizard step state therefore belongs in `DispatchModal`, not
in `DispatchLayer` - unlike `launchMode`, which lives on the layer precisely because it must
survive a close. A fresh pass on every open is the wanted behaviour.

**The draft does survive.** `draft` lives on `DispatchLayer` and persists across close/reopen,
so a re-opened pass must seed each step's highlighted option from the current draft value rather
than from a hardcoded first entry.

**`afterWorkForKind` is reusable as-is.** It is a closure over `draft` and the
`stashedWorkflowId` ref inside `DispatchModal` (`:911-923`). The Kind step calls
`update({ kind, ...afterWorkForKind(kind) })`, byte-identical to what the `<select>` does at
`:1592-1595`. Do not extract it; do not reimplement the stash.

**The mount autofocus will eat the mnemonics.** `useEffect(() => {
intentRef.current?.focus(); }, [])` at `:925-927` focuses the Task textarea as the modal
mounts. `Overlay.onKeyDown` is a `window` listener (`Overlay.tsx:230-241`), so during a pass
<kbd>p</kbd> would advance the wizard *and* type `p` into the task box. This effect must not run
while a pass is starting; the focus moves to the textarea when the pass completes or is skipped.

**`onOverlayKeyDown` already exists and is already memoised** (`:1208-1220`), handling ⌘↵ and
deliberately opting out in Ensemble mode. Extend it. `Overlay` fires it only while topmost and
handles Escape before it (`Overlay.tsx:230-236`), and `closable={!busy}` already seals Escape
during a submit.

**Bare letters are safe here, for a stated reason.** <kbd>p</kbd>, <kbd>t</kbd> and <kbd>c</kbd>
are bound in App's global `selection` group, but `App.tsx:1522` stands down whenever any overlay
is open. That is why no capture-phase listener is needed; assert it rather than assume it.

**`.modal` is `overflow: hidden`** (`styles.css:3756`) and is shared by every modal in the app.
The dispatch modal's body is `.dispatch-body`, which has **no** `overflow` of its own (unlike the
generic `.modal-body`, which is `max-height: 74vh; overflow: auto`), so there is no scrollable
ancestor between a picker and the panel edge.

## Decisions this phase takes

Two questions the plan left open are resolved here, because this phase builds the surfaces they
concern.

**Pickers are ordinary absolutely-positioned children, and `.dispatch-modal` alone gets
`overflow: visible`.** Not a portal. `RepoCombobox` portals because it must escape a scrollable
ancestor; these pickers have none, so a portal would buy nothing and cost positioning math and a
lifecycle. Scope the override to `.dispatch-modal` - never to `.modal`, which every other dialog
shares - and move the corner radii onto `.dispatch-modal .modal-head` and
`.dispatch-modal .modal-foot` so nothing needs clipping. Phase 4's Repo step keeps using
`RepoCombobox`'s portal; the two coexist.

**Answered rungs are clickable and jump back to their step.** That is what makes the strip worth
the row it costs. Jumping back to Kind and re-answering runs `afterWorkForKind` exactly as the
`<select>` does - same stash, same hand-back, no special case. The honest answer to the plan's
open question is that the wizard has no opinion the form does not already have.

## Implementation steps

1. **Step machine.** A small module under `src/web/lib/` holding the ordered steps and the pure
   transitions (advance, back, skip-to-form), plus which draft keys each step writes. Keep it
   pure and free of React so `test/` can cover it in milliseconds. Phase 4 inserts a step at the
   front, so make the order a data structure, not a switch.

2. **Wizard state in `DispatchModal`.** A `useState` for the active step and the highlighted
   index. Enter the pass on mount when **all** of: `mode.kind === "new"`,
   `launchMode === "single"`, and `useGuidedDispatch()` is on. Leave it on completion,
   <kbd>⇥</kbd>, or a switch to Ensemble.

3. **Condition the autofocus.** Change the mount effect at `:925-927` so it focuses the intent
   textarea when no pass is running, and add an effect that focuses it when a pass ends. Keep
   `clearDraft()`'s refocus (`:1081`) as is.

4. **Key handling** in `onOverlayKeyDown`. While a pass is active: mnemonic letters, digits,
   arrows, <kbd>↵</kbd> to take the highlighted option, <kbd>⌫</kbd> to step back,
   <kbd>⇥</kbd> to leave the pass and keep every answer, and `preventDefault` on all of them.
   ⌘↵ keeps working. Escape stays `Overlay`'s and still closes the modal.

5. **The rail strip.** A component rendered between `.modal-head` and `.dispatch-body`, only
   while a pass is active. One rung per step: index or tick, name, and the chosen value once
   answered. Answered rungs are `<button>`s that jump back. The strip is removed entirely when
   the pass ends, so the finished modal has its normal shape.

6. **The pickers.** For the active step, render the existing control unchanged and add an
   absolutely-positioned list beneath it. Reuse the app's `::picker(select)` geometry - 4px
   offset, 8px radius, `--bg-2`, `var(--shadow)` - so it reads as that dropdown opened. Dim
   every field that is not the active one.

7. **The Guided header toggle.** In `.modal-head`, beside the Single agent / Ensemble
   radiogroup. Writes through `useGuidedDispatch()`. Present in both states - this is how the
   preference gets turned on the first time, and off mid-dispatch.

8. **Option sources.** Harnesses from `AGENT_TYPES` / `AGENT_IDENTITY`; kinds from
   `TASK_KINDS`; workflows from the same filtered `workflowSummaries` the `<select>` uses
   (`:831-837`), including the `__default` and `__none` sentinels and their existing labels. No
   parallel lists.

9. **Accessibility, which is also the test surface.** There are no `data-testid`s in this repo
   and none may be added, so the roles are what the spec selects by:
   - each picker is a `role="listbox"` whose accessible name is the step's question, with
     `role="option"` children carrying `aria-selected`;
   - each rung is a button whose accessible name names the step and, once answered, its value;
   - the strip is a `<nav>` or list with an `aria-label` naming it as the guided pass.

10. **CSS** in the `.dispatch-*` region of `src/web/styles.css`, beside the existing dispatch
    block from line 6874. Comment the `overflow` override with why it is scoped.

11. **Pin the preference in the e2e fixture.** In `e2e/fixtures/test.ts`'s `dashboard` fixture,
    set `guidedDispatch` explicitly to `false` after the `localStorage` clear and before the
    reload, so no existing spec depends on the shipped default. Comment it with the reason: the
    default moves in Phase 5, and roughly 49 specs drive this modal. Guided-dispatch specs opt
    in for themselves.

## Data, API and compatibility

None. No route, schema, migration or wire-contract change. The draft keys written -
`kind`, `agent`, `workflowId` - are the ones the form already writes, through the same `update`
call.

## Tests and verification

**`test/`** - the step machine: order, advance, back from the first step is a no-op, skip
preserves answered steps, and the machine names the draft keys each step writes.

**`e2e/specs/guided-dispatch.spec.ts`** - new. Follow
`e2e/specs/scout-after-work-default.spec.ts` structurally: a header comment saying why this must
be a browser test, a local `openGuided(page)` helper, and an explicit note that no test in the
file submits a dispatch, so nothing spends model tokens. Turn the preference on in-test through
the header toggle. Cover:

- each mnemonic lands its value in the form's own control;
- <kbd>↑</kbd><kbd>↓</kbd> plus <kbd>↵</kbd> reaches the same place;
- <kbd>⌫</kbd> steps back and the rung returns to unanswered;
- <kbd>⇥</kbd> leaves the pass with answered steps intact and the task box focused;
- scout preselects None **through the wizard**, and ship hands the stash back, mirroring the
  existing select-driven spec;
- a backlog task opened for edit never enters the pass;
- Ensemble mode never enters the pass;
- with the preference off, the modal is today's form.

Watch the traps `e2e/README.md` names: never `{ exact: true }` on the Dispatch button (the
keycap is part of its accessible name), and read a `<select>`'s chosen option with `evaluate`
rather than `toContainText`, because a collapsed select renders no option text.

Specs open the modal by clicking **Dispatch** today; zero specs press <kbd>+</kbd>. At least one
test here should press the chord, since the pass is the reason the chord matters.

Commands: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, then
`npm run test:e2e` in full - the fixture pin is only proved by the whole suite staying green.

## Merge and exit criteria

- All commands above pass, with the full e2e suite green and unmodified apart from the fixture.
- With the preference off, the dispatch modal is indistinguishable from today's.
- With it on, the three-step pass runs, and every answer is visible in the form's own controls
  when it finishes.
- The modal's width and the vertical position of every field are unchanged throughout a pass.
- No `data-testid` was added.

## Downstream handoff

Later phases may rely on:

- the step machine's data-driven order, which Phase 4 prepends to;
- the pass being a phase of the existing `OVERLAY_IDS.dispatch` open, with no second overlay;
- `.dispatch-modal { overflow: visible }` and the relocated corner radii;
- the e2e fixture pinning `guidedDispatch`, which is what makes Phase 5 a one-line flip;
- the listbox/option/rung roles, which later specs select by.

Later phases must not:

- extract or duplicate `afterWorkForKind`;
- widen the `overflow` override to `.modal`;
- remove the fixture pin;
- change the shipped default - Phase 5 owns it.

## Cross-phase audit record

- **Against Phase 1.** Consumes `TASK_KINDS`, its labels, and `useGuidedDispatch()` as
  published. No change requested to Phase 1.
- The e2e fixture pin was considered for Phase 1 and deliberately placed here: it has no meaning
  until something reads the preference, and this is where the specs that need the opposite value
  are written. Recorded in the index's cross-phase contracts as a Phase 5 dependency.
- Resolved both of the source plan's "Still open" items - picker placement and rung clickability
  - because this phase builds both surfaces. Phase 4 inherits the picker decision rather than
  re-taking it.
- The plan's line about the task textarea being focused "by the same `intentRef.current?.focus()`
  that already runs on mount" is corrected here: that effect runs at the *start* of the opening,
  so it is made conditional rather than relied on.
