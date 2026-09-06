# One tile per round in the run scrubber

## The defect

A live No-Mistakes Review run captured evidence 3, 11 and 9 times across its three repair
rounds. The scrubber drew one tile per SUBMISSION, so it drew twenty-three - `Round 2 ·
evidence 7` and its twenty-two siblings - wrapping three rows deep across the top of the run
reader, directly under a header that had already said `ROUND 3 OF 6`.

Two things were wrong with that, and the second is the one that matters:

- It cost three rows of the reader's most valuable space to say one thing.
- **It read as twenty-three rounds.** A continuation segment spends no repair budget; that is
  the entire reason the segment model exists. Drawn as a tile beside its round's other tiles,
  every free continuation claimed to be a spent round.

The operator's ask: one tile per round, with a round's several trips for evidence shown some
other way.

## The three options

All three were built over the live daemon's own copy of the reported run - read-only, through
`GET /api/workflow-runs/<id>`, rendered through the app's real stylesheet, and interactive -
rather than as schematics or on fixture data, because the question is what each design does to
a round with ELEVEN captures in it. The generator and the rendered comparison are gitignored
(`.evidence/round-scrubber-options.html`) because a live run is operator data.

### A. Evidence pips inside the round tile

One tile per round, always. The snapshots become a row of small bars under the round's status,
each tinted by its own state and individually clickable, with a caption beside them.

- Constant header height: three tiles, one row, whatever the counts are.
- A failed capture inside a collapsed round stays visible without opening anything.
- One click to any snapshot - no disclosure step.
- Weakness: a pip carries no words.

### B. Round tile with an expandable evidence tray - CHOSEN BY THE OPERATOR

One tile per round with a count badge; selecting a round opens a tray listing that round's
captures as labelled chips.

- Keeps the words a pip gives up (`evidence 7`, `Under review`).
- Costs one extra click, and what sits below the strip changes height as the reader scrubs.
- The chips carry their segment's tone, so a failed capture is still visible at a glance.

### C. Round tiles with an evidence stepper on the selected tile

One tile per round; the selected tile grows `‹ evidence 9 of 9 ›` plus a select.

- The most compact, and the header never changes shape.
- The worst at overview: nothing shows that a capture inside round 3 failed until you step
  onto it, which is the one thing a collapsed round must not hide.

## How this was decided

The operator asked for the redesign, then interrupted the first pass with a second
instruction: *"beore implementing a fix, present 3 different mockup options, then you can plan
+ implement the fix in full"*.

The three options were built over the live run as clickable mockups. The first pass then
shipped **A** on the session's own judgement, which was the wrong call to make unilaterally.
When the three were put to the operator directly they chose **B**, and B is what is
implemented here.

B's two weaknesses, both named when the options were compared, are fixed rather than inherited
from the mockup:

- **Ragged chips.** A chip is as wide as its state sentence, so `Under review` beside `Waiting
  for evidence readiness` left the tray a jumble with no readable rows. The tray is now a grid
  of equal cells, so eleven chips have a shape.
- **A strip that moved under the reader.** The tile's badge is a static capture COUNT rather
  than a position that changes with the selection, so picking a chip moves nothing above it.
  The browser spec reads the strip's height and a neighbouring tile's geometry before the
  click that has to leave them alone.

The remaining cost is the one inherent to B and accepted with it: the tray's height depends on
how many captures the open round holds, so switching rounds changes what sits below the strip.
The strip itself - the tiles - is always one row.

## What shipped

- `runRoundGroups()` in `src/web/workflows/run-model.ts` folds `runRounds()` into one entry per
  round. The tile wears the newest snapshot's status because that is what the round is doing
  now; older snapshots keep their own, which is what the chips show. `runRounds()` is
  unchanged, so `submissionRoundLabel()` still cites `Round 1 · evidence 2` where a carried
  stage names a specific submission.
- `roundEvidenceCountLabel()`, `evidenceChipLabel()` and `openEvidenceTray()` own the badge
  wording, the chip wording, and which round's tray is open. `openEvidenceTray()` answers null
  for a round with one capture, so a lone snapshot never opens a one-chip panel.
- The tile in `WorkflowRuns.tsx` is a single button carrying the round, its status and its
  count badge, with `aria-expanded` when it owns the tray. The tray renders below the strip -
  never inside a tile, which would either widen that tile past its neighbours or wrap the
  strip - and its chips are buttons with `aria-pressed`, each wrapped in the app's one
  `Tooltip`, so the provenance sentence is reachable by pointer and by screen reader.
- A round with a single snapshot draws no badge and no tray.

One defect only a rendered check could have found: the tray's classes were first named after
evidence, and `wf-run-evidence` was already taken six hundred lines down `styles.css` by the
worklist's evidence list, which won on source order and broke the layout. The classes are now
`wf-run-tray`, `wf-run-tray-chips`, `wf-run-tray-chip` and `wf-run-round-count`.

## Verification

- `test/workflow-runs-model.test.ts` pins the fold, the tone-per-snapshot rule, the static
  badge wording, the chip wording, and that a lone snapshot opens no tray.
- `e2e/specs/workflow-round-scrubber.spec.ts` drives the built dashboard over a run grown to
  the reported 3/11/9 shape: three tiles with their count badges, the strip as one row
  (measured against a tile's own height), exactly one tray belonging to the round being read,
  a failed capture still visible as a chip inside a collapsed round, `aria-expanded` moving
  with the tray, the newest capture opening by default, nothing in the strip moving when a
  chip is picked, and every chip in the tray sharing one width.
- The three existing specs that asserted one tile per submission now assert one tile per
  round, its badge and its tray.
