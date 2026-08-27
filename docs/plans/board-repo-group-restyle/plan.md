# Board: restyling the repository group

The Board's repository grouping works. An operator can fold a repository away while they read
the rest of a column, the count says how much of the repository is in this frame, and the
grouping is on out of the box. None of that is in question here, and none of it changes.

What is in question is how it is drawn. The frame is a tinted box with a tinted header band
inside a column, holding cards that are themselves boxes with their own coloured spines, and
the header's chevron is a text glyph sitting off the row's optical centre. Three nested boxes,
two translucent washes of the repository's hue, and 16px of a 250px column spent on the frame's
border and inset.

This plan proposes eight other ways to draw the same grouping, asks which one to ship, and
states what it costs to ship it.

## Where to look

Two sheets, both real. Neither is a drawing of a board - both are the shipping components and
the shipping stylesheet, so what they show is what the board will show.

- **[`mockups.html`](mockups.html)**, beside this file: nine board columns side by side at
  their real width, on fixture sessions. Committed, shareable, and **synthetic on purpose** -
  every path, repository name, task title and branch on it is invented (`/wt/acme-api` and
  friends), because a committed page carries no operator data. Regenerating it from a live fleet
  would put a checkout path and somebody's task titles into the repository, which is exactly
  what the boundary in `AGENTS.md` forbids.
- **`.evidence/repo-group-mockups/index.html`**, generated on the operator's machine: the same
  nine treatments, each drawn over **their own live fleet**, read from the running daemon. Every
  repository header folds and every column scrolls, so the disclosure and the sticky option can
  be tried rather than described. Gitignored, because a live board is operator data and never
  lands in the repository.

The live sheet is generated read-only: `GET /api/sessions` and `GET /api/tasks`, then
`renderToStaticMarkup(<BoardView …/>)`. Nothing is written back and the running app is never
driven.

## What does not change

Stated first, because the answer to "will this break the grouping" has to be "there is
nothing here that could".

- **The partition.** `orderSessions` / `fleetRows` (`src/web/lib/fleet-order.ts`) decide which
  sessions are in which frame. Untouched.
- **The counts and their prose.** `repoGroupHeadline` still returns `2 of 8` / `1 agent` and
  the same hover sentence.
- **The disclosure.** Still one button per frame, still `aria-expanded`, still the
  `Collapse <repo> - <path> - …` accessible name, still keyed per frame in
  `src/web/lib/repo-collapse.ts` so folding a repository in one column leaves its sibling in
  another alone.
- **The colour source.** Still one inline `--repo-c` from `lib/repo-color.ts`, still read only
  inside `.board-repo` / `.rail-repo`, which is what `test/styles-tokens.test.ts` pins.
- **The frame is still presentational.** No drag handlers, so a backlog card dragged over a
  card inside a frame behaves exactly as it does today.
- **Arrow-key navigation** over a folded frame, which `e2e/specs/board-repo-groups.spec.ts`
  already covers.

Every proposal also trades the `⌄` text glyph for a drawn caret, still rotated off
`aria-expanded` so the control and the glyph cannot disagree.

## The proposals

Letters match the columns in both sheets.

### A - Current (the control)

A tinted frame, a tinted header band, a text-glyph chevron.

- Three nested boxes, and the group's tint sits between the other two, so a card's tone spine
  competes with it.
- The hue is spent on area: 6% over the body plus 11% over the head. That is enough colour to
  read as a state, which is the one thing a repository must not read as.
- 16px of the column goes to the frame's border and inset, on every group.

### B - Flush rule (recommended)

No box. The header becomes a label with a hairline that fades out towards the column edge, and
the cards keep the column's full width.

- Nothing nests. A card inside a group sits at the same width and indent as an ungrouped card,
  so the group costs one 15px row and no horizontal space. Card titles that ellipsise inside
  today's frame fit.
- The colour becomes a line: the swatch, and the near end of the hairline.
- Weakest containment of the set. Where a group *ends* is read from the next header rather than
  from an edge, so it is the option least suited to a column of many small groups.

### C - Spine

One 2px rule down the left of the group carries the identity. No fill, no border box, 14px of
gutter.

- The group's extent stays visible without a box: the spine starts at the header and stops at
  the last card, which is the fact the frame was drawing.
- The colour lands on an edge, where a hue can run near full strength without reading as a
  fill.
- Two vertical rules 12px apart, the group's spine and the card's own tone spine. Kept at 48%
  so the saturated one stays the card's, but this is the honest weakness of the option.

### D - Quiet box

Today's containment without the wash: a neutral border, a solid `--panel` header band, the
repository colour spent once on the frame's 2px top edge, and the count as a tag.

- The smallest departure from what is on the board now. Scanning, containment and drag targets
  are unchanged.
- The colour goes on the top edge rather than the side, so it never reads as a second card
  spine.
- Still nests: 14px of column width per group, and a run cluster inside is still a box in a
  box.

### E - Sticky strip

A full-bleed strip pinned to the top of the scrolling column body, with the repository colour
on its lower edge. Cards keep the full width.

- The only proposal that answers "which repository is this card in" after the header has
  scrolled past. Verified on the live sheet: with the idle column scrolled 300px, the header
  still sits on the column body's own top edge.
- Full-bleed to the column's edges is what makes it read as a section band rather than as a
  floating pill.
- Costs opacity: the strip has to hide the cards passing under it, so it is the one proposal
  that puts a solid surface over the column background.

### F - Section label

The register the settings pages already use: a small letter-spaced uppercase label over a
full-width rule, no colour but the dot, cards at full width.

- Not a new invention. A repository group reads like every other group of things in the app.
- The rule runs the column's width and sits under the label, which is what makes it a section
  rather than a card with a title.
- The name gives up monospace and mixed case, which is the one identity cue it costs: a
  directory name in a sentence font is slightly less obviously a directory name.

### G - Chip

The header shrinks to a pill the width of its own words. Nothing spans the column, so the group
is announced rather than framed.

- The cards are the only full-width thing in the column, so the column's background reads
  through beside the header.
- The tint comes back, but on about 90px instead of a whole frame - small enough to carry the
  repository's hue without reading as a state.
- Smallest hit target of the set: a pill, not a row. Still 24px tall, but it is the one option
  where the control is not the column's width.

### H - Merged list

The group stops being a box around boxes and becomes ONE surface: the cards lose their own
borders and gaps and are separated by hairlines, keeping only their tone spine.

- Removes the nesting by removing the inner box. Two thirds of what makes today's frame look
  heavy is the card's own border repeating 8px inside the frame's, and this is the only
  proposal that addresses that directly.
- Densest of the set: the gaps between cards inside a group go to zero, so a four-card group is
  about 30px shorter.
- The only proposal that changes the card. A card inside a group stops looking like a card
  outside one, which is a real cost - the board teaches that a tile is a tile.

### I - Quiet box + spine

D and C together: the neutral border, the solid header band and the count tag, with the
repository colour on *both* edges - D's 2px top rule and C's 3px spine, meeting at the frame's
leading corner.

- Containment and identity, separately. The box is the group and the coloured bracket is the
  repository, so neither has to be read off a tint - which is the one thing today's frame asks a
  translucent wash to do twice.
- Both edges, one mix. The top and the spine are the same colour, so the miter where a 2px edge
  meets a 3px one is invisible and the two read as one bracket rather than as two marks that
  happen to share a hue.
- The swatch goes. A dot 9px from a 3px rule of the same hue is the same fact twice, and it
  costs the header's first cell.
- Two vertical rules again, about 10px apart - but unlike C there is a border and a background
  between them, and the spine is held at 78% so the saturated one stays the card's. This is the
  most colour of any proposal here.
- Costs the same 14px of column width per group that D does.

## What the live board already caught

Worth recording, because it is the reason the mockups were rebuilt on real data rather than on
three fixture cards.

`.board-col-body` is a flex column, so a frame that sets `overflow` to anything other than
`visible` loses its automatic minimum size and can be **shrunk** by the column. On a column with
eight idle sessions in it, D and H clipped the last card of a group. Both now carry `flex: none`
on the frame, and the current design gets away without it only because it never sets `overflow`.
Whichever option ships carries that declaration.

## Implementation

Small, and the same shape whichever letter wins.

1. **`src/web/styles.css`** - replace the `.board-repo` / `.board-repo-head` / `.brh-*` block
   (the "board column: the repository frame" section). The chosen variant block in the mockup
   sheet is written to drop in with its `.v-*` scope removed. `--repo-c` stays the single
   source of the tint.
2. **`src/web/components/session-bits.tsx`** - `RepoGroupHead` trades the `⌄` text glyph for an
   inline SVG caret, keeping the class so the existing `[aria-expanded="false"] .brh-chevron`
   rotation still drives it off the control's own state. B additionally adds one
   `<span class="brh-rule" aria-hidden>` between the count and the caret; C drops the swatch,
   since the spine is already the colour.
3. **The rail** - `.rail-repo-group` (Console layout, `ConsoleView`) takes the same caret and
   the same colour placement, so the Board's drill-in morph does not change what a repository
   looks like on the way from column to rail.
4. **`e2e/specs/board-repo-groups.spec.ts`** - the existing case asserts the frame's
   `borderTopColor` is mixed from `--repo-c`. That holds for D and has to be re-pointed at
   whichever element carries the colour in the others (the swatch, the spine, the strip's edge,
   the chip's border). A new case covers the chosen treatment's visible consequence: for B, F, G
   and E, that a card inside a group is the same width as one outside it; for C, D, H and I, that
   the frame draws its edge; for E, that the header is still in view after the column is
   scrolled; for H, that a card inside a group is not clipped by its frame.
5. **`test/styles-tokens.test.ts`** stays green by construction: every new rule reading
   `--repo-c` is inside `.board-repo` / `.rail-repo`.

## Risks

- **Reduced motion.** The caret keeps the existing `prefers-reduced-motion` rule that drops its
  transition.
- **E and scroll containers.** A sticky header inside a flex child needs the frame to keep
  `overflow: visible`; the live sheet confirms it pins, and the spec case above is what keeps it
  pinned.
- **H and the tile contract.** It is the one option that restyles a tile, and only inside a
  frame. A tile's own hover, selection and drop states have to keep working with no border of
  their own to draw on.
- **Contrast.** The header text is `color-mix(in oklab, var(--fg) 78%, var(--dim))` on the
  column background in B and C, and `--muted` in F, both of which clear 4.5:1. D, E, G and H
  keep `--fg`.

## Decision: I, adopted

**I - quiet box + spine** ships. The recommendation had been B; the operator chose the option
that keeps the frame and spends the hue on its two edges, after comparing all nine on their own
board. The alternatives are kept above rather than deleted, because what was rejected is the
reason the adopted look is shaped the way it is - and `mockups.html` still draws every one of
them, with A frozen as the "before" panel now that the frame it described has been replaced.

What landed:

- `.board-repo` goes neutral - a `--border-soft` border over a `--bg-2` body at 60% - with the
  repository colour on a 2px top rule and a 3px leading spine at the **same** 78% mix, so the
  miter where they meet is invisible and the pair reads as one bracket. `flex: none`, because
  the frame now clips its head's corners.
- `.board-repo-head` becomes a solid `--panel` band with flush corners and the count as a tag.
- The board hides the swatch (`.board-repo-head .brh-swatch`); the rail keeps it, because a rail
  row has no frame to carry an edge.
- `RepoGroupHead` draws the caret as inline SVG through a new `RepoGroupCaret`, keeping the
  `brh-chevron` class so the existing rotation rule still drives it off the button's own state.
- Covered by `test/repo-group-head-render.test.ts` for the markup, and four added claims in
  `e2e/specs/board-repo-groups.spec.ts`: both edges mixed from `--repo-c` at one strength,
  nothing else tinted by it, the board's hidden swatch against the rail's drawn one, and a frame
  that refuses to be shrunk by its column.
