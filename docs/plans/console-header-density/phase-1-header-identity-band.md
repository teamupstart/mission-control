# Phase 1: Header identity band

## Outcome

The console detail's top band stops carrying constants and duplicates, and starts carrying the one
control that belongs there. A reader gets the same facts in less height, and the permission posture
becomes reachable without looking at the footer.

Delivers decisions **D2** (task pill reduction), **D3** (`ModePicker` promotion), and the objective
half of **D4**.

## Entry criteria and dependencies

None. This phase is first in the chain and depends on nothing unmerged.

## Scope

1. `.task-kind` renders only when `session.task.kind === "scout"`.
2. `.task-title` renders only when it differs from `session.name`.
3. `ModePicker` moves from `.detail-foot` to lead the header's right-hand cluster, giving
   `mode · model · context · cost`. It is removed from the footer.
4. `GoalLine`'s text moves into `.detail-title` as a second line under the `h2`, in `ConsoleDetail`
   only.

### Non-goals

- The activity line. Phase 2 owns it; it stays exactly where it is until then.
- The launcher strip and the tab row. Phase 3.
- `SessionCard`'s goal line. `test/session-card-goal.test.ts:123-129` records that moving the goal
  into the activity slot was tried and rejected on the card. The card keeps `GoalLine` where it is.
- `SessionTile`, `RailRow`, `EnsembleMembers`, and `ReportPanel`, which have their own vocabulary for
  these facts.

## Repository findings

- `ConsoleDetail.tsx:422-448` renders the task pill; `SessionCard.tsx:408-420` renders the same pill.
  Both must change together - `test/task-multi-session.test.ts:355-358` states the layout-parity rule
  explicitly: a session is drawn by four components and only one is `SessionCard`.
- **`.task-title` cannot simply be deleted.** `test/task-multi-session.test.ts:404-407` asserts the
  card and the console detail show the task *now executing* and not the finished one. A re-assigned
  session keeps the original task's title in `session.name`, so the pill's title is the only place the
  current task appears. Hence the conditional.
- `.task-kind` is unpinned by any test, but `ReportPanel.tsx:80` and `:526` also use the class. **Do
  not delete the CSS rule**, only stop emitting the span in these two components.
- `session-leaf-parity.test.ts:684-741` asserts `ScheduleOriginChip` is inside the card's and the
  detail's markup, and that chip is a sibling inside `.task-chip`. The pill container must survive
  even when both kind and title are suppressed.
- Moving `ModePicker` out of `.detail-foot` breaks **no** test - `detail-foot` appears nowhere in
  `test/` or `e2e/`, and `session-leaf-parity.test.ts:454-475` pins the tile and card only.
- `ModePicker` renders `null` when `pickableModes(session.agent).length === 0` (pi), and degrades to a
  non-clickable `<span>` when `canPick` is false. The header must tolerate both.
- `RuntimeMetaRow` (`session-bits.tsx:1452-1507`) owns `.card-runtime` and returns `null` when the
  session has no model, thinking level or context. The mode chip must not be placed inside it, or it
  disappears with it.
- Sizing: `styles.css:2984` (`.tile-runtime-line .mode`) is the treatment that makes the chip measure
  like an `.rt-pill` - 11px, `padding: 3px 7px`, `radius 6px`, tinted 1px border. Reuse it rather
  than inventing header metrics.

## Implementation steps

1. **Shared predicate for the pill.** Add a small pure helper next to the other shared predicates
   (not in a component) answering what the pill should show, taking the session and returning whether
   to render the kind badge and whether to render the title. Both call sites use it; neither branches
   on `kind` inline. Test it directly in `test/`.
2. **`ConsoleDetail.tsx:422-448`** - apply the helper. Keep `.task-chip`, `ScheduleOriginChip` and
   `.task-outcome` unconditionally as they are today.
3. **`SessionCard.tsx:408-420`** - apply the same helper, same way.
4. **`ConsoleDetail.tsx:395-406`** - render `<ModePicker session={session} />` immediately before
   `RuntimeMetaRow`, as a sibling inside the header, after `.detail-head-spacer`. Remove it from the
   footer at `:619`.
5. **`styles.css`** - give the header-cluster mode chip the `.tile-runtime-line .mode` metrics. Add
   the selector alongside the existing one rather than duplicating the declarations. Remove any
   footer-specific mode spacing left dangling at `styles.css:18506-18535`.
6. **`.detail-title` becomes a column.** In `ConsoleDetail.tsx`, move `GoalLine`'s text into the
   title block as a second line, and remove `<GoalLine session={session} />` from `.detail-conv:524`.
   The objective line is single-line with `text-overflow: ellipsis` and carries the full text as a
   tooltip using the shared `Tooltip`, not a `title` attribute.
   **Do not introduce a wrapper element around the remaining children of `.detail-conv`** - see the
   cross-phase contract; `.detail-conv > .pane-dialog` and `.detail-conv > .transcript` are child
   combinators in shipped CSS and in `test/pane-dialog-scroll.test.ts`.
7. **Docs** - `docs/sessions.md:627-629` names where the mode chip appears; it stays true only if the
   chip remains on all three surfaces, so verify the sentence and adjust the console-detail clause.

## Tests and verification

- Unit test the pill predicate directly: `ship` hides the badge, `scout` shows it, a title equal to
  `session.name` is hidden, a differing title is shown.
- `renderToStaticMarkup` assertions for `ConsoleDetail` and `SessionCard`: the badge is absent for a
  `ship` task and present for a `scout` one; the pill container and `ScheduleOriginChip` survive both.
- Keep `test/task-multi-session.test.ts` passing **without editing it**. If it fails, the conditional
  in step 1 is wrong - that test is the specification for F3, not an obstacle.
- **New Playwright spec** in `e2e/`, modelled on `e2e/specs/foreman-invite.spec.ts:141` for the
  console layout switch. Assert the mode chip is reachable in the console detail header by its
  accessible name, that it is no longer in the footer, and that a `ship` session shows no `SHIP`
  text in the pill. Select by role and accessible name; never add a `data-testid`; never pass
  `{ exact: true }` to a button name, because keycaps render inside the accessible name.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run test:e2e`.

## Merge and exit criteria

- The console detail header shows `mode · model · context · cost`, in that order.
- The footer no longer renders `ModePicker`.
- A `ship` task shows no kind badge anywhere; a `scout` task shows one on both card and detail.
- A session whose name equals its task title shows the title once, not twice.
- The objective is visible under the title in the console detail, ellipsed when long, with the full
  text on hover.
- Full suite green including a new e2e spec.

## Downstream handoff

Phase 3 may rely on:

- `.detail-title` being a column that holds the `h2` and an optional objective line. It may re-flow
  the head row but must not flatten this back to one line.
- The cluster order mode, model, context, cost. Its give-way ladder sheds from this cluster last, and
  never sheds the mode chip's accessible name - `topbarLadder`'s rule is that a shed label goes
  visually hidden, never `display: none`.
- The pill predicate existing as a shared helper, so no later phase re-derives it.

Phase 2 may rely on the leading children of `.detail-conv` being one item shorter, and must preserve
the no-wrapper rule.

## Cross-phase audit record

- Initial: no earlier phases. Confirmed that the two contracts phase 3 inherits (`.detail-title`
  column, cluster order) are introduced here and stated in the handoff above.
