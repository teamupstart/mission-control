# Setup panel rework: read one family at a time

> The Setup panel was a 1359px scroll of thirteen equal rows with no verdict. Ten of those
> rows were fine and cost 640px saying so. This reworks it into a verdict plus a family rail.

Four options were drawn over a sanitized, representative 13-check snapshot and rendered in
[mockups.html](mockups.html), which is script-free so it opens rendered in the Files tab.

## The decision

Put to the operator through Mission Control's `request_plan_decisions` tool, which blocks
until they submit or dismiss. Two questions, both answered:

| Question | Options offered | Submitted |
|---|---|---|
| Which direction should I implement? | A - Verdict first *(recommended)*, B - Family rail, C - Triage, D - Inventory grid, plus free text | **B - Family rail** |
| Should evidence paths render the home directory as `~/`? | Yes *(recommended)*, No - keep the absolute path | **Yes - show `~/.local/bin/claude`** |

A was the recommendation and was not chosen; B was, and B is what shipped. The trade B makes
against A is stated under [Known gaps](#known-gaps): a rail inside the Settings page's own
rail, in exchange for a fixed 541px frame instead of a 1131px scroll.

### What mockups.html is

**A frozen, sanitized decision record, and there is no tooling in this repository that rebuilds it.**
It sits alongside 102 other `docs/plans/*/plan.html` artifacts, none of which has a committed
generator either; a self-contained authored page is the convention here.

The decision-turn prototype was produced by a throwaway script in a gitignored working
directory. The committed page is an authored, sanitized version: it uses an operator placeholder
and representative install counts and versions rather than the raw setup response or the
operator's inventory. Its inlined pre-rework stylesheet preserves the baseline geometry without
committing the 892KB stylesheet copy or a second build path.

The page is a static record of the four options, not a view that re-reads machine state. Its
"Today" tab still measures 980x1359px because the inlined stylesheet predates the rework; that
is the baseline B was chosen against. There is no rebuild command in this repository.

The page carries no JavaScript, because Mission Control renders HTML in a sandboxed iframe
whose CSP blocks page scripts: every tab, the family rail in B, and the tile selection in D
are radio inputs plus `:checked ~` sibling selectors. That it carries no script, no external
stylesheet, no fetched asset and no em dash, and that each control still switches with
scripting disabled, was verified when the page was written, by the same throwaway script.
Those properties are inherent to the file as committed rather than enforced by a check in
this repository.

## What was wrong

Measured in Chromium at 1440x1000 with the 13-check layout represented in the sanitized
mockup (10 ready, 3 missing):

| | Height | Notes |
|---|---|---|
| Today | 1359px | 10 satisfied rows consume 640px; no verdict anywhere |
| A - verdict first | 1131px | verdict + satisfied rows collapsed to one line |
| **B - family rail** | **541px** | **fixed frame, one family at a time** |
| C - triage | 1059px | gaps first, inventory as a reference table |
| D - inventory grid | 661px | all 13 as tiles, needs a 1180px pane |

Each satisfied row carried a `READY` pill, a `RECOMMENDED` pill and a full
`/Users/<name>/...` path. None of the three told the operator anything actionable, and the
three rows that did need action sat in the middle of the ten that did not.

## What shipped

- A **verdict header** carrying the machine-wide claim, a tick per check in catalog order
  (amber for a gap you can live with, red for one you cannot), the ready count, and
  **Re-check**. It replaced a two-sentence intro paragraph that restated the question the
  verdict now answers; the intro's read-only promise is the header's note.
- A **five-family rail** with per-family ready counts and gap dots, beside a pane holding one
  family's rows. `.setup-panel` widened 980px → 1060px for the rail's 208px column.
- **Satisfied rows go quiet**: a dot, the name, and the evidence. No status pill, and
  `required` is the only requirement worth repeating on a row that is already fine.
- **Home-relative evidence**: `~/.local/bin/claude`, with the absolute path in the row's
  tooltip description. `SetupChecksView` gained a `home` field because only the daemon can
  read it; `homeRelative` matches an exact prefix plus separator, so `/home/jo` cannot
  rewrite `/home/jordan/bin` and a Linux home works the same as a macOS one.
- A `max-width: 860px` rung where the rail becomes a scrollable chip row above the pane.

## What a rail broke, and how

A rail is the one shape where "the row is on the page" and "the row is rendered at all" stop
being the same statement. Three things assumed the second:

1. **The guided tour** walked Agent CLIs and then GitHub as separate stops, which can no
   longer both be mounted. The targets became `setup:rail` and `setup:pane`; the two stops
   whose copy is about statuses and remedies now select GitHub first through a new
   `showSetupFamily`, because both of its rows are `required` on any machine.
2. **Deep links.** `SettingsPage` flashes a `data-anchor` and waits for a late-mounting
   control with a `MutationObserver`. A link to a row in an unselected family would wait out
   that timeout and silently light nothing. Rail items carry
   `data-anchor="setup/family-<id>"`, so the panel resolves an incoming anchor to its family
   and selects it - reusing the existing flash path rather than adding a second channel.
   `setup/recheck`, which the command palette links to, moved onto the verdict header.
3. **Four existing e2e specs** asserted rows across three families without selecting any.
   They now say which family they are reading, through `e2e/fixtures/setup-panel.ts`.

## Two defects the tests caught, worth keeping in mind

- **Selection settled in an effect** rendered the default family first and swapped on the
  next paint - a visible flash on every deep link, and the wrong family entirely where
  effects do not run. It is now applied during render *and* latched in the effect: render
  makes the first paint right, the effect makes it survive the prop being cleared.
- **The satisfied row's dot was `aria-hidden`.** Dropping the `READY` pill left colour as the
  only carrier of the state, so a screen reader heard no status at all on the one state with
  no pill, no amber wash and no impact sentence to fall back on. The dot is now
  `role="img"` with the status as its accessible name, which is also how the specs read it.

`nextSetupSelection` is a pure function precisely because its precedence - a deep link beats
the latch, the latch happens once, an unresolvable request is not consumed - is entirely
about transitions between renders, and `renderToStaticMarkup` only ever produces one. All
three rules are pinned by tests shown to fail when each defect is reintroduced.

## Known gaps

- The tour's authored copy for "Trust each status" still names Ready as one of four status
  words. A satisfied row now shows that state as a dot rather than the word, so the sentence
  is slightly ahead of the panel. Changing it means editing `src/web/tour/tours/*.md` and
  regenerating, which is a copy decision rather than part of this change.
- The rail sits inside the Settings page's own rail. It reads acceptably at 1060px, but it is
  the honest cost of option B and the reason A was the recommendation.
