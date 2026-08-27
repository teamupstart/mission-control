# Collapsing the Line - freeing vertical real estate for the conversation

Status: **shipped.** The adopted scope - Concept 1, Condensed, as the new default - is
implemented on this branch; see [Decisions taken](#decisions-taken) for what was chosen and
[Adopted scope](#adopted-scope) for what was built. The four unbuilt concepts below are kept
as the design record, not as pending work.

The implementation measured **exactly** what the mockups predicted: 86px expanded, 38.5px
condensed, 47.5px handed to the conversation, verified against the real component in
Chromium and pinned in `test/line-strip-electron.test.ts`.

| Where it lives | What is there |
| --- | --- |
| `src/shared/protocol.ts` | `LINE_DENSITIES`, and `lineDensity` on `UiConfig` defaulted to `condensed` |
| `src/web/lib/line-density.ts` | the store seam, the readout derivation, and the stale-proof toggle |
| `src/web/components/LineStrip.tsx` | both densities and the fold caret |
| `src/web/components/LineDensityPanel.tsx` | Settings → Display → The Line |
| `src/web/lib/keybindings.ts` | <kbd>Shift+L</kbd> |
| `test/line-strip-render.test.ts`, `test/line-strip-electron.test.ts`, `e2e/specs/line-density.spec.ts` | markup, geometry, and the wire |

The rendered page with the pixel-accurate artboards is
[`plan.html`](plan.html) - **open that, not this file.** The mockups are the deliverable and
the markdown cannot carry them.

## Decisions taken

Submitted through the dashboard. Recorded here as the adopted scope.

| Question | Decision |
| --- | --- |
| Which concepts to build | **Concept 1 - Condensed, the one-line ticker. Only that one.** |
| Default density on upgrade | **Condensed** |
| Whether Hidden keeps the attention hairline | **Keep the 3px segmented hairline** |

**The adopted scope is Concept 1 alone.** Condensed ships as the new default, which frees
**47.5px** of the 86px - a 6.3% taller conversation - for every operator on upgrade.

Concepts 2, 3 and 4 are **not in scope.** They are kept below rather than deleted, because
the ask was for mockups and ideas and the rejected shapes are the record of why the adopted
one won. Two things carry forward from them:

- **Hidden keeps the 3px segmented hairline** if it is ever built. That decision was taken
  now, on the mockup, so the question does not have to be reopened later. Note the mild
  inconsistency in the answers as submitted: the hairline governs Hidden, and Hidden was not
  selected - so this is a decision held in reserve, not one that ships with Concept 1.
- **Concept 4 stays deferred**, not rejected. It is the biggest win available and the guards
  it disturbs are the reason it is not first.

Since Hidden is not shipping, the density control is a **two-position** control in this
scope - Expanded and Condensed - not the three-position one the diagram draws. Keeping
`lineDensity` a named set rather than a boolean is what lets Hidden join later without
renaming a key that is already persisted on operators' machines.

## The ask

> Collapse the bar entirely. It should be expandable to show again (pinned?). So something
> like pinned or unpinned, or collapsed or expanded, beyond what it already has. We want to
> free up more vertical real estate for the chat window.

Two vocabularies are in that sentence - pinned/unpinned and collapsed/expanded - and they
are not the same axis. Naming them apart is most of the design work, so it is done up front
in [Two axes, one control](#two-axes-one-control) rather than left to the concepts.

## What the Line costs today, measured

Measured in Chromium at a 1512x900 viewport (a 14" MacBook Pro's logical size) against the
real `src/web/styles.css`, console layout:

| Band | Used height |
| --- | --- |
| `.topbar` | 57px |
| `.line` | **86px** |
| `.console` (rail + conversation) | 757px |

The 86px is `12px` padding, a `61px` `.line-stage`, `12px` padding and the `1px`
`border-bottom`. The stage itself is `11px` padding, a `17px` `.ls-head`, a `6px` gap, a
`14px` `.ls-sub`, `11px` padding and `2px` of border.

Two facts follow, and they are the whole reason this is worth doing:

1. **The Line is `flex: none` inside a `height: 100dvh` flex column.** `.app-console` and
   `.app-board` do not scroll, so every pixel the strip uses is a pixel taken directly off
   the conversation pane. There is no scrollback that gives it back.
2. **86px of 900px is 9.6% of the window.** Reclaiming it takes the console pane from 757px
   to 843px - an **11.4% taller conversation**, on the surface an operator spends the day in.

`.ls-sub` - the sentence line - is `14px` of content that costs `20px` of band once its gap
is counted, and it is the only part of the strip that is prose rather than a number. That is
the natural first thing to give up, and Concept 1 gives it up.

## What must survive a collapse

The strip is not decoration, and `src/web/components/LineStrip.tsx` says so in its own
header: it renders at a fixed height whatever it is saying, *including nothing*, because a
strip that vanished when the fleet went quiet "would stop being the place you look".
Collapsing it fights that intent directly. The proposal below only works if it keeps the
three things the strip actually exists for:

- **The amber read.** `tone-attention` is the one signal the strip was built to carry - "a
  session is stuck on you". A collapsed state that drops amber has freed 86px by deleting
  the feature. Every concept below keeps an amber path. The adopted Condensed state keeps it
  per stage; Hidden, if it is ever built, keeps a mark on screen even with nothing else left.
- **A stable board.** The strip holds its height so the cards underneath never step up and
  down. A collapse must be a deliberate act with a persisted result, never something that
  happens on its own while the operator is reading. This is why Concept 5 (auto-collapse on
  focus) is written down and then rejected.
- **One gesture back.** Collapsed must not mean buried.

## Two axes, one control

| Axis | Values | What it governs |
| --- | --- | --- |
| **Density** | Expanded / Condensed / Hidden | How much the strip *says* |
| **Pinning** | Pinned / Unpinned | Whether the strip *takes layout height* or floats over the board |

Crossed, that is six states, and a six-state chrome control is worse than the 86px it
saves. The full proposal collapsed it to **three positions on one control** - and the
adopted scope takes only the first two, Expanded and Condensed - because pinning is never
an independent choice:

- **Expanded** - today's two-line strip. Pinned by definition; a floating 86px panel over
  the board is strictly worse than the pinned one.
- **Condensed** - one line, counts and tones only. Pinned.
- **Hidden** - zero layout height. Unpinned by definition; the peek overlay is how you
  reach it.

So "pinned/unpinned" is not a switch the operator sets. It is implied by the density they
chose, which is the honest version of the two-axis model and needs one control instead of two.

## The concepts

All five are kept as the design record; the adopted one is Concept 1. Each is drawn in
`plan.html`. Heights below are measured off the artboards in the same
Chromium run as the baseline, not estimated.

### Concept 1 - Condensed: the one-line ticker - ADOPTED

Drop `.ls-sub` and the wires. Six inline segments - glyph, name, count - on a single row,
in the same `22px` gutters, with the fold caret at the right. The single most urgent
sentence ("1 needs you") is promoted to ride at the right of the row, so the one piece of
prose that is ever load-bearing is the one piece that survives.

- **Band: 38.5px. Frees 47.5px** (86 -> 38.5), a 6.3% taller conversation.
- Keeps all six drawers reachable - the segments stay buttons, `aria-expanded` and all.
- Keeps amber, per segment, so *which* stage needs you still reads.
- Costs the sentences. "next up: <task title>" and "~$47.75 per PR today" are gone until
  you expand or open the drawer.

### Concept 2 - Hidden: nothing, plus an attention hairline - NOT IN SCOPE

Zero layout height. In its place, a `3px` full-width bar rendered **only when a stage is
amber**, segmented into six so the amber segment's horizontal position still says which
stage it is. A calm fleet shows nothing at all.

- **Band: 0px calm / 3px when amber. Frees 86px / 83px.** The full 11.4%.
- This is the state that answers "collapse the bar entirely" literally.
- The hairline is what keeps it honest: hiding the strip must not hide the alert.
- Costs discoverability. Needs the peek gesture and a chord, or it is a one-way door.

### Concept 3 - Peek: the unpinned overlay - NOT IN SCOPE

How you read the strip from Hidden without giving the 86px back. The full two-line strip
floats over the top of the board - `position: absolute`, a shadow, the board unmoved
underneath - on hover of the top edge, on the chord, or on focus. A pin button in its
corner returns it to Expanded.

- **Band: 0px, always.** The strip costs nothing and is one gesture away.
- Not a standalone concept so much as the mechanism Hidden needs. Recommended *with*
  Concept 2, not against it.
- **The reveal lip has to be an overlay too, and this is easy to get wrong.** Drawing the
  hover target as a `14px` flex item in the shell costs 14px of band - a sixth of everything
  Hidden set out to free, spent on a strip whose only job is to be hovered. It has to be
  absolutely positioned over the top of the conversation. The mockup made this concrete: the
  first draft laid the lip out in flow and measured a 17px band for a state advertised at 3px.
- Costs: an overlay covers the top of the conversation while open, and hover-reveal is
  undiscoverable on its own - hence the pin button and the chord.

### Concept 4 - Fold into the topbar - DEFERRED

Delete the band entirely and ride the six counts in the topbar as a compact chip group
beside the fleet pulse.

- **Band: 0px. Frees 86px and adds no new chrome anywhere.** Strictly the best outcome.
- **And the highest risk in the set, which is why it is not recommended first.** The topbar
  is already on a responsive rung ladder (`fitTopbar`, `data-rung`) that sheds controls as
  width tightens, and `--topbar-h` is measured off that element and read by every
  full-height surface. Adding six counts fights the ladder for width and can change the
  measured height. This repository's agent memory also records that adding a segment to the
  title bar broke guards in four separate layers.
- Worth doing eventually. Not worth doing first, and not worth doing in the same change as
  the collapse.

### Concept 5 - Auto-collapse on conversation focus - REJECTED

Condense automatically the moment the conversation takes focus; expand on Esc. No manual
state at all.

Rejected, and recorded so it is not re-proposed: chrome that moves itself under the cursor
is exactly what the strip's fixed height exists to prevent. The operator would lose the
strip at the moment they clicked toward it. If it ships at all it ships as an opt-in, after
the manual control exists.

## Adopted scope

Ship **a two-position control** - Expanded and Condensed - with **Condensed as the new
default.** That is Concept 1 and nothing else.

- Condensed frees **47.5px** with no new gesture to learn, every drawer still reachable and
  amber intact per stage. Most of the available win, almost none of the risk.
- **Expanded remains reachable** and unchanged, so nothing is lost - only folded.
- Defaulting to Condensed changes what every existing operator sees on upgrade. That was
  asked and answered rather than assumed.

Held in reserve, with the design question already settled so it does not have to be
reopened: if **Hidden** is ever built it keeps the **3px segmented attention hairline**, and
the **peek overlay** is the mechanism it needs in order not to be a one-way door.
**Concept 4** - folding the counts into the topbar - is deferred rather than rejected.

### What that means for the build

Two consequences follow from the scope being Concept 1 alone, and both are cheaper than the
three-state version:

- **The guards move less.** `test/line-strip-electron.test.ts` needs one new case at 38.5px
  rather than a case per density, and nothing in this scope is 0px tall - so the tour's
  `see-work:line` target always exists and `e2e/specs/see-work-tour.spec.ts` needs no
  hidden-strip branch at all. That was the most awkward integration in the full proposal and
  this scope avoids it outright.
- **`lineDensity` stays a named set anyway.** Two states would fit in a boolean, and it
  should still not be one: the key is persisted on operators' machines, so a
  `lineCollapsed: boolean` would have to be renamed the day Hidden arrives. Following
  `CONVERSATION_VIEWS` costs nothing now and keeps that door open.

## How it would be built

Sketch only - enough to price the concepts, not an implementation plan.

- **State.** A `lineDensity: "expanded" | "condensed" | "hidden"` key on `UiConfig` in
  `src/shared/protocol.ts`, defaulted in `UI_CONFIG_DEFAULTS`. That blob is the established
  home for exactly this kind of per-machine display preference - `layout`,
  `conversationView` and `hiddenDisplayItems` already live there, and a new key needs no
  migration. A named set rather than a boolean, following `CONVERSATION_VIEWS`, because
  three states are already more than a boolean and a fourth reading is plausible.
- **Render.** `LineStrip` grows a density prop and a fold control. The `WorkQueue` fold is
  the precedent to follow: one `.wq-collapsed` class hides the body for every branch the
  panel renders, so no branch can forget to fold, and the header keeps reporting the count
  that is still there.
- **Gesture.** A caret in the strip plus a bindable chord through the existing keybindings
  table.

### Guards this will touch

Named so the cost is visible now rather than discovered mid-build:

- `test/line-strip-electron.test.ts` asserts the strip's used height falls in a
  `70-110px` band, that all six stages render, and that the height is identical whatever
  the strip is saying. Condensed at 38.5px and Hidden at 0px are both outside that band, so
  the file needs a case per density rather than a widened band - the band is the claim for
  Expanded and should stay that.
- `e2e/specs/line-strip.spec.ts` and `e2e/specs/line-drawers.spec.ts` drive the strip as it
  is drawn today.
- `e2e/specs/see-work-tour.spec.ts` and `src/web/tour/tours/see-work.ts` point a tour step
  at the `see-work:line` target. A hidden strip has nothing to point at, so the tour must
  either force Expanded for its duration or skip the step.
- Per this repository's rules, the new control needs its own Playwright spec in `e2e/`.

## Open decisions

Asked as selectable options in the dashboard, not answered here:

1. Which concepts to build.
2. What the default density is on upgrade.
3. Whether Hidden keeps the attention hairline or is truly empty.
