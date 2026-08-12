# Phase 4 - The Repo step

## Outcome

The guided pass gains its first step: which repository. It drives the `RepoCombobox` already
sitting at the top of the form, seeded on the last repo dispatched into, so <kbd>↵</kbd> alone
takes it and typing filters. A default dispatch becomes <kbd>+</kbd> <kbd>↵</kbd> <kbd>p</kbd>
<kbd>c</kbd> <kbd>↵</kbd>.

## Entry criteria and dependencies

- Direct prerequisite: **Phase 2**.
- Concurrent with Phase 3; they own disjoint files and may merge in either order.
- Inherited contracts: the data-driven step order, the pass living inside the existing dispatch
  overlay, and Phase 2's picker placement decision.

## Scope

1. Prepend Repo to the step machine.
2. Wire the step to the existing `RepoCombobox`.
3. Seed it from `readLastDispatchRepo()`.
4. Resolve Escape and the digit keys for this step.
5. Repo name matching.
6. Tests.

### Non-goals

- **No second repo picker.** The plan is explicit: the step drives `RepoCombobox`.
- **No multi-repo.** `+ Add another repo` stays a form control; this step picks the primary.
- No change to the other three steps' behaviour.
- No Settings change. Phase 3.

## Repository findings

`RepoCombobox` is an `<input role="combobox" aria-expanded aria-autocomplete="list">` with a
**portalled** `role="listbox"`, placeholder `"search repos or type a path…"`
(`RepoCombobox.tsx:48`, `:172-206`). It already filters, already arrow-navigates
(`:149-169`), and already positions its list with fixed coordinates so it clears any scrollable
ancestor. That is the control to drive.

Three of its existing behaviours constrain this phase:

- **It opens on focus and on every keystroke**, and its list is `z-index: 60` directly over the
  Task field below. `e2e/README.md` names this as trap #3 and every dispatch spec presses
  <kbd>esc</kbd> after filling the repo field for exactly this reason.
- **It owns Escape**, closing its own list with `stopPropagation()` so the modal does not close
  underneath an open list. This is deliberate.
- **It is used twice**: for the primary repo and for the `"repo to attach…"` field in multi-repo
  dispatch. Any change to its filtering is a change to both, and
  `e2e/specs/multi-repo-dispatch.spec.ts` covers the second.

`readLastDispatchRepo()` (`src/web/lib/lastRepo.ts`) already seeds `freshDispatchDraft()`
(`DispatchModal.tsx:74-80`) from `localStorage`, so the step has a starting value with no new
persistence. The e2e `dashboard` fixture clears `localStorage` precisely because of this seed
(`e2e/fixtures/test.ts`), so in tests the seed is empty unless a spec sets it.

## Decisions this phase takes

Two corrections to the source plan, both forced by `RepoCombobox` owning behaviour the plan
assigned elsewhere.

**Escape in the Repo step is progressive, not a cancel.** The plan says "<kbd>esc</kbd> cancels
the dispatch outright". In this step it cannot, because `RepoCombobox` swallows Escape to close
its list, by design, and the only way to change that is to stop using it - which the plan
forbids. So: the first Escape dismisses the list and ends the guided pass, leaving the operator
in the ordinary form with the repo field as typed; a second Escape closes the modal, which is
what Escape does everywhere else. This is the behaviour the form already has today, so it adds
no rule to learn. Escape in the other three steps is unchanged and still closes the modal.

**Digits type here; they do not pick.** The plan's step table says "type to filter, digits to
pick", which contradicts its own later sentence that in Repo "every letter is a letter".
Repository names contain digits, so a digit that selected by position would make a repo called
`service2` unfilterable. In this step, digits are characters and selection is
<kbd>↑</kbd><kbd>↓</kbd> plus <kbd>↵</kbd>. The three closed-set steps keep their position
digits.

## Implementation steps

1. **Prepend the step.** Add Repo at the front of the step order Phase 2 made data-driven. It
   writes `repoRoot`. The rail gains a fourth rung with no other change.

2. **Drive the existing control.** While the Repo step is active, focus `RepoCombobox` and let
   it own filtering, arrowing and selection. The guided layer contributes the rail rung, the
   step's question, and the fact that <kbd>↵</kbd> advances rather than merely closing the list.
   Do not render a second list beside the combobox's own.

3. **Seed and confirm.** Open the step with the draft's `repoRoot` - already
   `readLastDispatchRepo()` - as the highlighted row, so <kbd>↵</kbd> with no typing takes it.
   Nothing new is persisted; `rememberDispatchRepo` keeps running on submit as it does now.

4. **Name matching.** Ensure a first keystroke narrows usefully: every path shares a long common
   prefix, so a substring match over the full path returns nearly everything for common letters.
   Match the repo's basename, falling back to the full path so a typed absolute path still
   resolves. **Check `RepoCombobox`'s current filter before changing it** - it is shared with the
   attach field, so if the change lands in the component rather than in this step's use of it,
   `e2e/specs/multi-repo-dispatch.spec.ts` must stay green and is the proof.

5. **Escape and digits** as decided above. Escape's first press must both close the list and end
   the pass, or the pass would continue over a step whose list has gone.

6. **Autofocus interaction.** Phase 2 made the mount autofocus conditional on a pass running.
   With Repo first, the pass now focuses the combobox on mount instead. Re-check that ending the
   pass still lands focus in the Task textarea from every exit: completion, <kbd>⇥</kbd>, and
   the new Escape route.

## Data, API and compatibility

None. `repoRoot` is an existing draft key written through the existing `update` call, and
`localStorage` seeding is unchanged.

## Tests and verification

**`test/`** - the step machine with Repo prepended: order, that Repo writes `repoRoot`, and that
back from Repo is a no-op because it is now first.

**`e2e/`** - extend `guided-dispatch.spec.ts`:

- <kbd>↵</kbd> with no typing takes the seeded repo and advances to Kind;
- typing narrows the list, and a name fragment that is not in the shared path prefix reaches the
  intended repo;
- the chosen repo appears in the form's own repo field when the pass ends;
- Escape once leaves the pass into the ordinary form with the field as typed; Escape again
  closes the modal;
- a digit typed in the Repo step filters rather than selecting;
- <kbd>⌫</kbd> from Kind returns to Repo with the previous answer intact.

The daemon fixture seeds two repos (`daemon.repo`, `daemon.secondRepo`), which is what makes the
name-matching assertion possible. Remember the fixture clears `localStorage`, so a spec that
wants a seeded repo must set it.

`e2e/specs/multi-repo-dispatch.spec.ts` must pass unmodified. If it needs edits, the filter
change went into the shared component when it should have stayed in this step's use of it.

Commands: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`,
`npm run test:e2e`.

## Merge and exit criteria

- All commands pass, with `multi-repo-dispatch.spec.ts` untouched and green.
- A default dispatch is <kbd>+</kbd> <kbd>↵</kbd> <kbd>p</kbd> <kbd>c</kbd> <kbd>↵</kbd> and the
  cursor is in the task box.
- Every exit from the pass lands focus in the Task textarea.
- The modal still never reflows during a pass.

## Downstream handoff

Phase 5 documents the four-step pass and its keys, including the Repo step's two exceptions:
Escape is progressive, and digits type.

Later phases must not reintroduce digit-selection in this step or make Escape cancel outright
here, without also removing `RepoCombobox` from the step - which the plan forbids.

## Cross-phase audit record

- **Against Phase 2.** Consumes the data-driven step order as published and prepends to it; no
  change requested. Inherits Phase 2's picker-placement decision unchanged - this step needs no
  floating picker of its own, because `RepoCombobox` already portals.
- **Against Phase 3.** Disjoint file sets, verified: this phase owns `DispatchModal.tsx`,
  possibly `RepoCombobox.tsx`, and the dispatch e2e specs; Phase 3 owns the settings registry,
  page, panel, search index and `App.tsx`. Either may merge first.
- Corrected two statements in the source plan - Escape and digit keys - rather than inheriting a
  contradiction. Both are recorded above with the reason, `plan.md` was updated so its step table
  and key prose state the corrected behaviour rather than contradicting this phase, and Phase 5's
  documentation must describe that same corrected behaviour.
- Phase 2's exit criterion that focus lands in the Task textarea is re-verified here rather than
  assumed, because prepending a step changes which control the pass focuses first.
