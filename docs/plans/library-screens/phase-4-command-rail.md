# Phase 4: The Command screen as a resolution table

## Outcome

The Command slot editor stops presenting a default and its exceptions as two unrelated sections and
becomes one table of rules, with the default pinned at the top as the rule it actually is, the add
row visibly an add row, and every rule showing the argv it will really run. The screen that decides
what a gate executes finally shows its own precedence.

## Entry conditions and dependencies

- **Depends on Phase 2**, merged and green. The rail group head, rail row, property chip and
  workspace header are inherited from `src/web/library/`.
- Phase 1 is a transitive prerequisite through Phase 2; do not depend on it directly.
- Runs concurrently with Phase 3. Neither consumes the other's files or decisions.
- Read [`plan.md`](plan.md), [`phased-plan.md`](phased-plan.md), and Phase 2's downstream handoff.
- Open [`mockups/commands.html`](mockups/commands.html), approach **A · Rail**.

## Scope

### Included

- `CommandLibrary` rail on the shared primitives, with resolved-default and override-count
  sub-labels;
- the default and overrides rebuilt as one table with a header row;
- a visually distinct add row;
- a parsed-argv readout on every rule, not only the default;
- CSS, render tests, and a Playwright spec.

### Excluded

- **everything about how a Command runs.** No change to resolution order, authorization, Trust
  gating, argv execution, commit-pinned checkouts, environment scrubbing or teardown;
- the compare-and-swap save contract, which stays one `PUT` per slot replacing the default and the
  whole override list together;
- New, archive, duplicate, user-created slots, suites, environment fields or shell mode. There are
  four slots, forever;
- the resolver preview from approach B of the mockups. It was not the approved direction; do not
  smuggle it in;
- the "used by" footer. Commands has none in the approved design - do not add the slot here.

## Repository findings and inherited contracts

1. **`CommandLibrary` has no search, no state filter and no New**, because its four slots are fixed
   and come from the `WORKFLOW_CHECK_SLOTS` registry. The rail keeps that shape; grouping is a single
   "Built-in slots" head, not Built-in versus Yours.
2. **The slot values are persisted append-only identifiers.** Nothing in this phase renames a slot,
   reorders the registry, or touches the `kind: "check"` node shape.
3. **`test/command-library-render.test.ts` pins the behaviour to preserve**: the four slots render in
   registry order, an unknown slot falls back, the "saving executes nothing" copy is present,
   dirtiness is computed against the stored slot, the repo picker order is defined, the revision line
   has a specific form, an SSE revision is adopted only when newer, and a conflict outlives a stale
   stream. Expect to update markup expectations; keep all of these.
4. **The conflict banner has two buttons** - load newer and keep mine - and outlives a stale stream.
   The table rebuild must not disturb that.
5. **The add row's repository picker is `RepoCombobox`, which swallows Escape when its list is open**
   and reports the swallow through an `onEscape` callback `CommandLibrary` does not currently pass.
   With Phase 1's ladder now live, this matters: while that list is open, Escape must close the list
   and **not** leave the page. Wire `onEscape` or verify the combobox's `stopPropagation` is
   sufficient, and cover it in the Playwright spec.
6. **Phase 1 threaded `isOverlayOpen` into `CommandLibrary`.** It is available; use it rather than
   re-plumbing.
7. **The daemon stores one revision per slot.** The screen edits one slot at a time and saves one
   slot at a time. Do not introduce a cross-slot save.
8. Inherited from Phase 2: shared primitives are extended, never forked.

## Implementation steps

1. Rebuild the `CommandLibrary` rail on the shared group head and row, with one "Built-in slots"
   group of four. Keep registry order.
2. Give each rail row a sub-label carrying the resolved default and the override count, so the slot
   with exceptions is identifiable without opening it. Reuse the existing fact helper rather than
   formatting a second string.
3. Put the slot's purpose, revision line and the promoted Save on the shared workspace header, with
   read-only property chips for the override count and the execution note.
4. Replace the Default command section and the Overrides list with one table: a header row, the
   default pinned first and labelled as the rule that applies where nothing more specific matches,
   then each override with its repository name and path, then the add row.
5. Render the parsed argv beneath every rule, reusing the existing parser and preview helper that
   today serves only the default. A parse error renders where it does now.
6. Style the add row distinctly from a saved rule, and keep its Add control disabled until both
   fields are valid, as today.
7. Handle Escape inside `RepoCombobox` per finding 5, so the page-level ladder does not fire while
   the list is open.
8. Keep the trailing sentence about save replacing the default and the whole override list together.
9. Extend the shared CSS from Phase 2 with the table rules. Do not fork the master-detail grid.

## Compatibility

- No server, schema, route, migration or persisted-identifier change.
- `WorkflowCommandView` and `UpdateWorkflowCommandSchema` are untouched.
- The save remains one compare-and-swap per slot; conflict handling is unchanged.

## Tests and verification

### Unit and render

- [ ] Update `test/command-library-render.test.ts` for the new markup, keeping all nine behaviours in
      finding 3.
- [ ] Add cases for the table: the default renders as the first rule and is labelled as such, the add
      row is distinguishable from a saved rule, and every rule carries its parsed argv including the
      long override.
- [ ] Add a case for a rule whose command fails to parse.

### Playwright, required

Extend `e2e/specs/library-commands.spec.ts` rather than replacing it; every case it already carries
must keep passing.

- [ ] The default and both overrides render as rows of one table, each with its argv.
- [ ] Adding an override through the add row persists and survives reload.
- [ ] Removing an override persists and survives reload.
- [ ] With the `RepoCombobox` list open, Escape closes the list and stays on the slot route; a second
      Escape leaves for `#/library`.
- [ ] A dirty slot holds a hash move and the answer is honoured once - the existing case, still green.
- [ ] Phase 1's exit spec still passes unedited.

### Commands

```
npm run typecheck
npm run lint
npm test
npm run build && npm run test:e2e
```

## Merge and exit criteria

- [ ] The Command screen matches approach A in the mockup at 1440 and at a narrow width.
- [ ] Nothing about command execution, authorization or Trust changed.
- [ ] The full gate passes.
- [ ] Screenshots attached to the pull request from a gitignored location.

## Downstream handoff

Nothing depends on this phase. Phase 5 does not touch the Command screen: the approved design gives
Commands no "used by" footer, because a slot is referenced by a workflow's graph shape rather than by
identity, and answering it would be a different question from the one Phase 5 answers.

## Cross-phase audit record

- Reconciled with Phase 2: consumes its four primitives unchanged. The rail here has one group rather
  than two, which the shared group head already supports without a signature change.
- Reconciled with Phase 3: disjoint components and disjoint CSS rules; safe to merge in either order.
  Both extend Phase 2's primitives without altering them.
- Reconciled with Phase 1: finding 5 is a direct consequence of Phase 1 landing an Escape ladder on
  this route. The `RepoCombobox` interaction did not exist as a concern before Phase 1 and is owned
  here rather than retro-fitted into Phase 1, because the combobox only appears on this screen.
- Reconciled with the source plan: approach B's resolver is explicitly out of scope, recorded so a
  reader of the mockups does not treat it as approved.
