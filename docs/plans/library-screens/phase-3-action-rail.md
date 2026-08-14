# Phase 3: The Action screen and its contract line

## Outcome

The Action detail screen adopts the rail grammar and, for the first time, states the contract it
enforces: which skill the bound session must have, and what Mission Control has to observe before a
stage may call the Action done. Two unlabelled selects in a row of four fields become a chip pair
with the sentence they form written beneath them.

## Entry conditions and dependencies

- **Depends on Phase 2**, merged and green. The rail group head, rail row, property chip and
  workspace header are inherited from `src/web/library/`.
- Phase 1 is a transitive prerequisite through Phase 2; do not depend on it directly.
- Runs concurrently with Phase 4. Neither consumes the other's files or decisions.
- Read [`plan.md`](plan.md), [`phased-plan.md`](phased-plan.md), and Phase 2's downstream handoff.
- Open [`mockups/actions.html`](mockups/actions.html), approach **A · Rail**.

## Scope

### Included

- `SessionActionLibrary` rail on the shared primitives, with `skill · completion` sub-labels;
- `SessionActionEditor` header with one promoted verb plus an overflow menu;
- property chips for the required skill and the completion condition;
- the contract line beneath the chips;
- visible, marked treatment for a completion kind this build cannot prove;
- CSS, render tests, and a Playwright spec.

### Excluded

- the "used by" footer (Phase 5); leave the slot Phase 2 established;
- any change to the completion capability contract, the skills catalog fetch, the three-way conflict
  merge, or the sparse update patch;
- any new completion kind, and any change to `SESSION_ACTION_COMPLETION_KINDS`;
- the Commands screen (Phase 4).

## Repository findings and inherited contracts

1. **The completion sentence has exactly one owner.**
   `test/session-action-completion-copy.test.ts` asserts that no browser surface re-derives the
   completion sentence from a two-armed test. The contract line must render the shared helper's
   string, not build its own from the kind.
2. **Completion choices are capability-gated.** The editor builds its options from what the daemon
   reports as available, plus a disabled arm retaining a stored kind this build cannot prove. The
   Rail direction requires that retained kind to stay **visible and marked** rather than hidden
   inside a closed dropdown - render it as a marked chip state, not as a silently disabled option.
3. **Save stands down while capabilities are unknown**, and `test/session-action-library-render.test.ts`
   pins it. The chip row must not make Save appear enabled before the capability fetch resolves.
4. **That same test file source-scans `SessionActionEditor.tsx`** with regexes asserting the
   conflict-reconciling effect reads `loadedRevisionRef.current` and that `dirty` goes through its
   wrapper. Restructuring the component must keep both true, or update the scan deliberately and say
   why in the pull request.
5. **`Cmd/Ctrl+S` stands down while an overlay is open**, pinned by the same file. The overflow menu
   and chip popovers inherited from Phase 2 count as overlays only if they route through `Overlay`;
   if they do not, verify the save chord still behaves.
6. **The library never speaks in a reviewer's vocabulary** - an existing assertion in the same file.
   An Action completes; it never judges. Keep that out of the contract line's wording.
7. **A run currently waiting on an Action is already derivable** from
   `WorkflowRunSummary.status === "waiting_for_action"` and `actionWait`, and the Library index
   already uses it for a shelf cross-link. This phase does **not** render it; Phase 5 owns the
   footer. Noted so it is not rediscovered as new work here.
8. Inherited from Phase 2: shared primitives are extended, never forked, and their accessible names
   are stable.

## Implementation steps

1. Rebuild the `SessionActionLibrary` rail on the shared group head and row. Group Built-in and
   Yours with counts, and keep the existing search and archived-state semantics unchanged.
2. Replace each row's sub-label with `skill · completion`, sourced from the shared skill-label and
   completion-label helpers rather than formatted locally.
3. Restructure the `SessionActionEditor` header on the shared workspace header: name, built-in tag
   and revision line on the left; Save or Duplicate promoted on the right; Archive behind the
   overflow menu. Preserve the existing status-line precedence and the three-button conflict banner
   exactly.
4. Replace the required-skill and completion selects with property chips, each opening its existing
   control in a popover. Keep the selects' options, disabled arms, validation and accessible names.
5. Render the contract line beneath the chips: what the stage sends, what the session must have, and
   what Mission Control observes before the stage is allowed to call it done. Compose it from the
   shared completion sentence plus the skill id; do not write a second copy of either.
6. Give a retained-but-unprovable completion kind a marked chip state and a short explanation
   beside it, so the condition is legible while closed.
7. Leave the Phase 5 footer slot in place, rendering nothing.
8. Extend the shared CSS from Phase 2 for the contract line. It is one new rule, not a new section.

## Compatibility

- No server, schema, route or persisted-identifier change.
- `SessionAction` wire types, the capability endpoint, and the save/patch contract are untouched.
- The prompt Markdown stays byte-exact through the editor, as today.

## Tests and verification

### Unit and render

- [ ] Update `test/session-action-library-render.test.ts` for the new markup, keeping every
      behavioural assertion, including the two source-scan regexes and the overlay stand-down case.
- [ ] Add cases for the contract line: it renders the shared completion sentence verbatim, and a
      retained-unprovable kind renders marked rather than hidden.
- [ ] `test/session-action-completion-copy.test.ts` and `test/palette-index.test.ts` stay green
      without edits.

### Playwright, required

- [ ] The rail sub-label shows skill and completion, and the two built-ins are told apart by it.
- [ ] A completion chip opens, changes the condition, and the change survives Save and reload.
- [ ] The contract line updates to match the chosen condition.
- [ ] The overflow menu reaches Archive and closes on Escape without leaving the page.
- [ ] Phase 1's exit spec and Phase 2's persona spec both still pass unedited.

### Commands

```
npm run typecheck
npm run lint
npm test
npm run build && npm run test:e2e
```

## Merge and exit criteria

- [ ] The Action screen matches approach A in the mockup at 1440 and at a narrow width.
- [ ] No Action behaviour changed: capabilities, conflict merge, save patch and archive all work as
      before.
- [ ] The full gate passes.
- [ ] Screenshots attached to the pull request from a gitignored location.

## Downstream handoff

Phase 5 fills the footer slot on this screen as well as on Personas, and will read
`WorkflowRunSummary.actionWait` for the live half. This phase must leave that slot present and empty,
and must not start rendering run state in the contract line.

Nothing here may be relied on by Phase 4, which is concurrent.

## Cross-phase audit record

- Reconciled with Phase 2: consumes its four primitives unchanged; the contract line is the only new
  shared-CSS addition and is scoped to this screen.
- Reconciled with Phase 4: both extend Phase 2's primitives and touch disjoint components
  (`SessionActionLibrary`/`SessionActionEditor` here, `CommandLibrary` there) and disjoint CSS rules.
  They may merge in either order. If either needs to change a Phase 2 primitive's signature, that
  change belongs in Phase 2's files and must be reconciled with the other before merging.
- Reconciled with the source plan: the plan's "used by" bullet for this screen is deferred to Phase 5
  per the repository finding in `plan.md`.
- No earlier phase required editing.
