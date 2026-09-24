# Round context without the banners

## The problem

A workflow run scrubbed onto an earlier round draws two full-width amber panels between the
round scrubber and the pipeline:

> Evidence 2 of round 2, captured to repair evidence preflight gaps. This refinement does not
> spend a Persona repair round.

> Viewing an earlier round. The pipeline, verdicts and timeline below are that round's; the
> Inspector gate, deliveries and every recovery action are always the live run's.

They come from `segmentProvenanceSentence` in `src/web/workflows/run-model.ts` and the
`.wf-run-stale` paragraph in `src/web/workflows/WorkflowRuns.tsx`.

Three problems, in the order they cost a reader something.

**Most of it is already on screen.** "Evidence 2 of round 2" is the pressed round tile
(`Round 2`) plus the pressed tray chip (`evidence 2`), read back as a sentence. "Viewing an
earlier round" is the fact that the pressed tile is not the last one. Exactly two clauses are
new: this refinement spent no repair round, and the Inspector gate, deliveries and recovery
actions stay live while everything else on the page is a snapshot.

**It is expensive.** Measured in a browser at 1360px, the rounds block is **239px** tall with
both panels and **140px** without them. The banners are 41% of the run's most valuable
vertical space, and the pipeline is what that space is for.

**It is the wrong colour.** Both panels are `--attention` amber, which everywhere else in the
app means this needs you. Neither is actionable.

## Mockups

`docs/plans/round-context-disclosure/mockups.html` renders today's surface and four
alternatives using the product's own stylesheet and markup, so each one shows what would
actually ship. Every disclosure in the page is live; open the file and click.

Each option keeps every sentence and puts the explanation behind a click. None of them delete
a fact.

### A. One context line, one disclosure

The four facts collapse to a single muted line under the tray, `Snapshot · round 3 is live ·
no repair round spent`, followed by a `Why?` pill. The pill opens a popover carrying both
sentences verbatim and a `Go to round 3` button.

Measured: **168px**, saving 71px (30%).

The line keeps `role="status"`, so the state is still announced when the selection changes.
Only the explanation moves behind the click, never the state itself.

### B. The mark rides the thing it describes

No extra row at all. The selected evidence chip grows a `?` mark pinned to its corner, and the
popover opens from there. The live round tile wears a green `● LIVE` mark, which answers
"which round is the live one" positively instead of telling the reader which one is not.

Measured: **140px**, saving 99px (41%).

The disclosure is a sibling of the chip's button, never a child: the chip is a `<button>`, and
a `<details>` nested in one is invalid markup and unreachable by keyboard.

This is the largest saving and the weakest discoverability. Nothing announces the snapshot
state to a screen reader once the selection settles, and a 9px `?` is easy to miss.

### C. Two pills on the scrubber's own line

The state becomes two right-aligned pills sharing the row the scrubber already occupies:
`Snapshot` in amber and `Free refinement` in green. Each opens only its own sentence, so a
reader who wants one fact does not read the other.

Measured: **140px**, saving 99px (41%).

The saving is real but conditional: the scrubber wraps once a run passes roughly six rounds,
and the pills then land on a line of their own.

### D. One "About this view" panel

A `ⓘ About this view` control beside a new `ROUNDS` section heading opens a single panel
answering every question about the view at once: what is showing, why there is a second
evidence, what comes from this round, and what is always live.

Measured: **169px**, saving 70px (29%).

The smallest saving, and the only shape with room to grow. Inspector-only rounds,
verified-shipping segments and carried-stage provenance all want a line of explanation here,
and under today's design each would arrive as another banner.

## Comparison

| Option | Rows above the pipeline | Height | Snapshot state visible without clicking | Announced to a screen reader | Survives a long run | Room for the next sentence |
| --- | --- | --- | --- | --- | --- | --- |
| Today | 2 panels, 3 lines | 239px | Yes | Yes | Grows one panel per fact | Another banner |
| A, context line | 1 line | 168px | Yes | Yes | Fixed height | Popover grows, line does not |
| B, chip mark | None | 140px | Only as the LIVE mark elsewhere | No | Fixed height | Per-chip popover only |
| C, scrubber pills | None, until the scrubber wraps | 140px | Yes, as two words | Only if the pill group is a live region | Wraps past about 6 rounds | One more pill each time |
| D, about panel | 1 heading row | 169px | Only as the LIVE mark elsewhere | No | Fixed height | Another row in one panel |

## Decision

**Option A shipped.** The LIVE mark from B was not part of that decision and is still
available as an independent follow-up; the context line names the live round in words
(`Round 3 is live`), which covers the same question from the other side.

## Recommendation as written before the decision

**A, with B's LIVE mark on the live round tile.**

A keeps the one thing a banner is genuinely good at, a state that is announced and cannot be
missed, while dropping it from three lines to one and from alarm amber to muted text. B's mark
is nearly free and answers the question a reader actually has once they know they are not on
the live round. D is the better shape if more per-round explanation is coming, and it can be
layered on later without undoing A.

Not mocked: moving the sentences into the existing chip tooltips alone. They are already there
(`Tooltip` wraps every tile and chip in `WorkflowRuns.tsx`). A hover-only fact is unreachable
on a touch device and invisible to anyone who does not hover, which is what makes a click
target the ask rather than a tooltip.

## What option A actually touched

- `src/web/workflows/run-model.ts`: added `roundContext`, which returns the short `clauses`
  the line prints and the full `sections` the popover opens, built in one pass so the two
  cannot drift into different orders or different claims. `segmentProvenance` classifies a
  segment ONCE and returns both readings of it, long and short;
  `segmentProvenanceSentence` is now a projection of that rather than a second classifier,
  and still feeds both the popover and the tray chip tooltips.
- `src/web/workflows/WorkflowRuns.tsx`: `.wf-run-notice` (provenance) and `.wf-run-stale` are
  replaced by one `.wf-run-context` line carrying a `<details>` disclosure. `role="status"`
  sits on the clause group rather than on the whole line, so scrubbing to another round is
  still announced while opening the disclosure does not read both paragraphs aloud. The four
  other `.wf-run-notice` call sites on this page are unrelated and untouched.
- `src/web/styles.css`: added `.wf-run-context` and the `.wf-run-disclose` popover, and
  registered that popover in the `.is-desktop` no-drag rule. Deleted `.wf-run-stale`.
- `test/session-action-run-render.test.ts`: focused cases for `roundContext`, covering the
  live round, the scrubbed-back snapshot, and the common case that renders no line at all.
- `test/workflow-runs-render.test.ts`: the assertions on `Viewing an earlier round` now pin
  the new line, plus the regression that the live round says nothing about itself.
- `e2e/specs/workflow-round-scrubber.spec.ts`: the collapsed line, the sentences being
  hidden until `Why?` is clicked, the popover's content and ordering, the jump back to the
  live round and the popover closing behind it, the measured claim that the line is shorter
  than one round tile, and a narrow-viewport check that the popover stays inside the window.
- `e2e/specs/workflow-session-action-run.spec.ts` and
  `e2e/specs/workflow-session-action-evidence.spec.ts`: the continuation provenance now reads
  from the line and its disclosure rather than from the removed banner.

`expectContentClearsBorder` does not apply: the disclosure is a popover anchored in the page,
not a modal.

Two defects the existing suite caught rather than a reviewer:

- `test/desktop-drag-region.test.ts` refused the popover as an unregistered floating layer.
  In the desktop shell the macOS titlebar drag region would have eaten its clicks, and this
  popover holds the only copy of both the explanation and the button back to the live round.
- `test/tooltip-coverage.test.ts` refused the jump button for having no hover description.

Both are fixed. They are recorded here because neither was visible in the mockups: a mockup
renders in a browser tab, not in the Electron shell, and it has no tooltip contract.

Two more the mockups could not have shown, because a mockup has no state that outlives a
click:

- The `<details>` survives a round change, so taking the jump button left the popover open
  over the pipeline, re-explaining the round the reader had just left. The button now closes
  its own disclosure, the way the pipeline's item menus close on a chosen item.
- `role="status"` on the whole line meant opening the disclosure read both paragraphs aloud,
  which is the opposite of putting the explanation behind a click. The live region is now the
  clause group only.

Two the review round found, both real:

- **The disclosure closed on one route out of four.** Closing it from the popover's own jump
  button covered only the path that starts inside the popover. A round tile, an evidence chip
  and a carried stage's provenance link all change the same selection from outside it, and
  each left a stale explanation standing over a round it was not describing. All four now go
  through one `selectRound` boundary that closes the disclosure first, so a fifth route
  cannot be added without it. The e2e spec checks each route from a freshly opened
  disclosure, because a route that closed nothing would otherwise be covered by whichever
  route ran before it.
- **Provenance was classified twice.** The compact clause decided "is this verified shipping"
  independently of the sentence, so a new provenance case added to one and missed in the
  other would put a collapsed line on screen contradicting the disclosure it opens, which is
  the exact inconsistency `roundContext` exists to prevent. One classifier now returns both
  readings.

## Decisions resolved during implementation

1. **Which option**: A, as instructed.
2. **The jump button**: kept. It reads `Go to Round 3, the live round`, and it is the one
   piece of new behavior here rather than a restatement. A reader who has just learned they
   are on a snapshot should not have to work out which tile is the live one.
3. **The LIVE mark**: not shipped. It belonged to option B and was never a standalone
   decision the human made.

## Still open

- Whether B's `● LIVE` mark on the live round tile should follow. It is independent of this
  change and would not undo it.

## Status

Implemented. The mockups stay as the record of what was compared and why A won.
