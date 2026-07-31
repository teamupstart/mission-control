# Workflow runs, single run: pipeline labels read horizontally

The reported defect: on the workflow-runs page with one run open, the Session card drew
"Session" and "Submits the work" as a vertical column, one letter per line.

All measurements below come from the real dashboard against the live daemon - `RunPipeline` on
`#/workflows/runs/:id`, rendering a real blocked run whose Session carries `Changes requested`,
which is the status in the report.

## The capture

`workflow-pipeline-label-width.svg` beside this file is a VECTOR capture of that page: every
`x`, `y`, `width` and `height` in it was read off the rendered page with
`getBoundingClientRect()`. It is XML, so its contents can be read directly rather than only
viewed. The Session card in it is these four lines:

```xml
<rect x="2" y="104" width="176" height="84" rx="10" fill="#11151d" stroke="#2c3444"/>
<text x="37.7" y="128.7" fill="#e6ebf2" font-size="12.5" font-weight="700">Session</text>
<text x="37.7" y="143.4" fill="#8b95a5" font-size="10" font-weight="400">Submits the work</text>
<text x="97.8" y="167.0" fill="rgb(248, 81, 73)" font-size="11" text-anchor="middle">Changes requested</text>
```

Each label is ONE `<text>` element because each renders as one horizontal run. Were the label
still stacked, "Session" could not be one `<text>` at one `y` - it would need seven, one per
letter, which is what the before half of the HTML artifact produces.

`workflow-pipeline-label-width.png` is the same region as a raster screenshot.

## The layout, drawn from the measured boxes

The Session card, to scale, from the numbers above (card `x=2 y=104 w=176 h=84`):

```
 x=2                                                    x=178
  +--------------------------------------------------------+  y=104
  |                                                         |
  |         Session                                         |  "Session"          x 37.7 -> 86.6,  y 117
  |  ◇      Submits the work                                |  "Submits the work" x 37.7 -> 121.5, y 134
  | x=15    ( Changes requested )                           |  chip               x 37.7 -> 157.9, y 152
  |                                                         |  ◇ mark             x 15 -> 29.7,    y 136.5
  +--------------------------------------------------------+  y=188
```

The diamond holds the left column; the label, the subtitle and the chip stack as three rows of
the right column. Every one of them runs left-to-right.

The diamond is centred against the whole card: its box is `y 136.5 -> 155.5`, centre **146.0**,
and the card is `y 104 -> 188`, centre **146.0**.

That centring needs saying because the first version of this fix got it wrong. The mark carried
`grid-row: 1 / -1`, which reads as "span every row" and is not: `-1` counts back from the last
line of the EXPLICIT grid, and the chip's row here is implicit, so it resolved to row 1 alone and
drew the diamond 14.5px above the card's centre. The span is now written explicitly, and scoped
with `:has(.wf-pipeline-status)` to the cards that have a chip - spanning unconditionally would
add an empty second track to the editor's chipless terminus, which `row-gap` then makes 6px
taller (measured: 61px against 55px).

## Per-character proof

The decisive measurement: one bounding box per CHARACTER of "Session", taken from the live page
with a `Range` over each character.

```
char   x       y      w     h
 "S"  37.7    117    8.4   15
 "e"  46.1    117    7.5   15
 "s"  53.6    117    6.9   15
 "s"  60.5    117    7.1   15
 "i"  67.6    117    3.6   15
 "o"  71.1    117    7.7   15
 "n"  78.8    117    7.8   15

distinct y values: 1   (all seven glyphs share one baseline)
x advancing left-to-right: true
x span: 37.7 -> 86.6
```

Seven glyphs, one `y`, seven increasing `x`. That is horizontal text. The defect was the
transpose of this: one `x`, seven increasing `y`.

`"Submits the work"` measures the same way - 16 glyphs, 1 distinct `y`, x 37.7 -> 121.5.

## Every label on the page

Line boxes counted over each element's own text. One rect is one horizontal line.

```
lines/words  size            text
    1/1     127.3x15        "Session"
    1/3     127.3x12        "Submits the work"
    1/2     198x15          "Stage 1"
    1/6     198x12          "2 checks · all must pass"
    1/1     179x15          "Check typecheck"
    1/1     179x15          "Check test"
    1/3     198x15          "Intent Conformance Judge"
    1/2     198x12          "1 reviewer"
    1/3     179x13          "Intent Conformance Judge"
    1/3     179x12          "codex · gpt-5.6-terra"
    1/2     198x15          "Stage 3"
    1/6     198x12          "3 reviewers · all must pass"
    1/3     179x13          "Code Risk Reviewer"
    1/3     179x13          "Test Evidence Auditor"
    1/2     179x13          "Documentation Steward"
    1/1     127.3x15        "Complete"
    1/2     127.3x12        "Terminal outcome"

labels measured: 17, stacked (lines > words): 0
```

Counting line boxes over a whole element overstates the count for the two `Check` rows: the
nested `CHECK` mark has a taller box than the text beside it, so its rect reads as another line.
Those two rows were confirmed horizontal by measuring the mark and the text separately - the
mark occupies x 691-738 and the text x 744-803 on overlapping vertical extents, so they sit side
by side. The table above counts only each element's own text nodes.

## What was wrong

The status chip is `flex: none` and carries a whole phrase. `Changes requested` is 120px wide
inside a 176px card, which leaves nothing for the label once the diamond, the gaps, and the
padding are taken. The label could absorb the entire shortfall because `overflow-wrap: anywhere`
reports a min-content width of ONE CHARACTER, so flexbox shrank it to 8.8px - the width of one
letter - and "Session" stacked down the card.

The same squeeze broke `Intent Conformance Judge` mid-word as `Conforma / nce` in the member
rows, and would have folded a stage subtitle into three lines under a long stage chip.

## The fix

Each of the three cards that pairs a label with a chip - `.wf-pipeline-terminus`,
`.wf-pipeline-reviewer`, `.wf-pipeline-stage-head` - is a grid that gives the chip its own row,
and the labels use `overflow-wrap: break-word` rather than `anywhere`. On the terminus the
diamond spans the chip's row so it stays centred against the card.

The chip takes its own row unconditionally rather than only when it will not fit. A run is live,
and a member's chip travels `Not started` -> `Running` -> `Changes requested` while the operator
watches; sizing the row to whichever phrase is current would reflow the stage on every
transition and draw sibling members of one stage as two different row shapes.

## Reproducing the before and after

`workflow-pipeline-label-width.html` beside this file holds the same pipeline markup twice, as
literal HTML in both halves, against the dashboard's linked stylesheet. The first half restores
only the pre-fix declarations; the second reads `src/web/styles.css` unmodified. Each half
measures itself when the page opens:

```
--- BEFORE half (pre-fix declarations restored) ---
VERTICAL - a label is stacked, which is the reported defect.
"Session": 7 line(s), 8.8px wide x 131.3px tall
"Submits the work": 13 line(s) for 3 words
"Intent Conformance Judge": 4 line(s) for 3 words

--- AFTER half (shipped rules, nothing overridden) ---
HORIZONTAL - every label reads across the card.
"Session": 1 line(s), 127.3px wide x 18.8px tall
"Submits the work": 1 line(s) for 3 words
"Intent Conformance Judge": 1 line(s) for 3 words
```

The before half's 8.8px matches the width measured on the live page before the fix, so the
reproduction is faithful rather than an approximation.

Because the artifact links the real stylesheet, its after half follows `src/web/styles.css` as
those rules change; a regression shows up as a red verdict on that page.

Rules under test: `src/web/styles.css`. Contract: `test/workflow-pipeline-label-width.test.ts`.
