# Settings > Worktrees: capacity-first layout

- **Status:** Approved for phased implementation planning
- **Date:** 2026-08-21
- **Scope:** Planning only. This document proposes no application changes by itself.
- **Surface:** `src/web/components/WorktreeSettingsPanel.tsx` and the `wt-` block in
  `src/web/styles.css` (lines 403-781).
- **Decision record:** All three plan choices and the phased implementation follow-up were
  submitted in Mission Control on 2026-08-21:
  - **Layout direction:** B - Capacity-first.
  - **Safety callout:** demote it to the lead paragraph.
  - **Scope:** restyle plus empty and loading states.

## Why the pane looks wrong

This is not a taste complaint. The pane breaks nine concrete conventions the rest of Settings
keeps, and each one is checkable.

| # | Break | Evidence |
| --- | --- | --- |
| 1 | **Square corners everywhere.** `--radius: 13px` is a global token and every neighbouring surface uses it. The 379-line `wt-` block contains **zero** `border-radius` declarations across 97 rules. | `styles.css:100`; `grep -c border-radius` over lines 403-781 returns `0` |
| 2 | **Oversized headings.** `.wt-section .settings-section-head h4` sets only `margin`, so the three sub-headings fall back to the user-agent default and render *larger* than the pane's own page title. House sizes are 13px for a section head and 12px for a subhead. | `styles.css:473`, `:16835` (`h3` 13px), `:17425` (`.harnesses-subhead h4` 12px) |
| 3 | **Numbered eyebrows.** `01 · POLICY`, `02 · NATIVE INVENTORY`, `03 · LEGACY DRAIN`. No other settings pane numbers its sections, and these three are not a sequence - nobody walks policy, then inventory, then drain, in order. The numbering encodes nothing true. | `WorktreeSettingsPanel.tsx:353-376`; no other panel uses the pattern |
| 4 | **The selection accent used as decoration.** `.wt-intro` and `.wt-kicker` paint themselves with `--select`, the keyboard-selection colour. `--select` and `--idle` are the same hex (`#35c08a`), and this pane *also* uses `--idle` to mean "slot is available" - so one green means three things on one screen. | `styles.css:26`, `:405-431` |
| 5 | **Mono boxes as headline numbers.** `0 native pools` / `0 native slots` / `0 legacy rows` render as square 11px monospace tiles. Elsewhere mono is for paths, SHAs, and small uppercase status pills - never for the primary count. | `styles.css:437-462` |
| 6 | **Two accent directions in one pane.** Repository cards take a 3px **left** border; slot cards take a **top** border. | `styles.css:526-528` vs `:671-674` |
| 7 | **A tinted callout with no precedent.** `.wt-intro` opens the pane with a gradient-filled, left-ruled box. Harnesses - its immediate neighbour in the rail - opens with a plain lead paragraph, which is the house pattern. | `styles.css:412-425` vs `HarnessesPanel.tsx:285-288` |
| 8 | **The wrong row shape for policy.** House style is a plain `.kb-row`: label and description left, control right, no box. Worktrees instead puts two filled cards in a `1.4fr / 0.6fr` grid, so the checkbox floats alone in a wide box while the number input crowds its own three-line description. | `styles.css:477-481` vs `:16871` and `HarnessesPanel.tsx:291-333` |
| 9 | **Full-width rules between sections.** `.wt-section` draws a `border-top` on every section. No other pane rules its sections apart; inside the 900px measure they read as table borders. | `styles.css:463-466` |

Two further gaps, both in scope for this change:

- **The empty state is blank.** With `inventory` still null, `02 · Native inventory / Pool ledger`
  renders a heading, a Refresh button, and nothing else - a heading over void. The
  "No native pool exists yet" hint only appears once the fetch resolves to an empty array.
- **It does not scale.** The source plan recorded a live pool of **54 slots** on this machine.
  The current design renders pools as a card grid and paginates slots 12 at a time inside each
  card, inside a 900px measure.

## What the house style actually is

Taken from the two panes either side of Worktrees in the rail.

- **Page head:** `h3` at 13px, scope chip right-aligned (`THIS MACHINE`).
- **Lead:** one prose paragraph, `--muted`, with `<strong>` carrying the emphasis. No box.
- **Group label:** sentence case, 12px, `font-weight: 600` (`Per harness`, `Layout`, `Conversation`).
- **Control row:** `.kb-row` - `9px 10px` padding, `border-radius: 9px`, transparent border,
  `--panel-2` on hover. Label 12.5px / weight 540, description 11.5px `--muted`, control right.
- **Card:** `.harness-card` - `border-radius: 10px`, `1px solid --border`, `3px` **left** accent,
  `--bg-2` fill, `13px 16px 14px` padding, in a `repeat(auto-fit, minmax(300px, 1fr))` grid.
- **Badge:** `.skill-badge` - 9.5px uppercase, `border-radius: 5px`, tone via
  `color-mix(in oklab, <tone> 34%, var(--border))` border over a 9% fill.
- **Closing note:** `.settings-hint` at 11.5px `--dim`, explaining the consequence of the group above.
- **Measure:** `.settings-pane > .settings-section` is capped at `max-width: 900px`. Task sources
  opts out (`.ts-panel { max-width: none }`) because it is master-detail.

The pane already has a legitimate left-accent-bar precedent in `.harness-card`. What it does not
have precedent for is the square corners, the numbering, the tinted callout, and the mono count tiles.

## The adopted layout: capacity-first

**Thesis.** An operator arrives at this pane with one question - *do I have room, and what is
holding the rest?* Answer it in the first 200 pixels, and give `Default maximum` a meaning a number
input cannot carry.

The mockup is rendered in `plan.html` beside this file.

```
Worktrees                                         [THIS MACHINE]
Mission Control owns these checkouts. Every cleanup is previewed
and rechecked against task, check, manual lease, Git, and process
ownership before it can mutate a path.

Pools                                              Refresh
  ai-harness                          8 leased · 4 free · 16 max
  [########====----------------|.....................]
   8 leased   4 free   4 more may be created         > 12 slots

  docs-site                            0 leased · 3 free · 8 max
  [===--------------|...............]
   3 free    5 more may be created                    > 3 slots

  line-drawers                      17 leased · 0 free · 16 max
  [############################!!]
   17 leased  1 quarantined  2 over    [Preview safe prune]

Defaults           affects future acquisitions only
  Use native worktrees                                    [ x ]
  Default maximum slots                                  [ 16 ]

Treehouse
  Nothing left to drain.
```

### The signature: the capacity bar

One track per pool, segmented into leased (`--working`), available (`--idle`) and quarantined
(`--danger`). The track's full width **is** the configured maximum, so the unfilled remainder reads
directly as room to grow and is hatched to say so. A pool over its maximum spills past the track in
`--attention` hatching, and the safe-prune preview surfaces on that row. Lowering the default
maximum visibly reflows every bar, which is exactly the feedback the current number input withholds.

The bar is the pane's one new component and the only place its boldness is spent. Everything around
it is an existing house primitive.

**Accessibility.** The bar is decorative on its own, so it carries no meaning colour alone must
convey. Each segment's count is restated in the legend beneath it as text, and the bar itself takes
`role="img"` with a composed label naming every count and the maximum. The over-capacity state is
labelled with the words `over the maximum`, never by the amber hatching alone.

### Structure

1. **Lead paragraph.** The safety promise becomes the pane's opening sentence, in the shape
   Harnesses uses. The tinted box, the green `--select` kicker, and the three mono count tiles are
   all removed - the counts they carried are now visible per pool on the bars.
2. **Pools, first.** Full-width rows rather than a card grid, because the bar needs the width. Each
   row: tone dot, pool name, path in mono, counts, the bar, the legend, and a disclosure into slot
   detail and per-pool overrides. Slot detail keeps its existing bounded scroll and pagination.
3. **Defaults, below the pools.** Two `.kb-row`s identical in shape to Harnesses'
   `Auto mode on dispatch`, under a group label qualified `affects future acquisitions only` -
   which is the constraint the source plan already states, surfaced where it applies.
4. **Treehouse, last.** One `--attention`-toned row while anything is undrained; one dim sentence
   once nothing is.

No numbering, no section rules, no square corners. Sections are separated by space, as they are
everywhere else in Settings.

### Empty and loading states

In scope by decision, and each state gets real copy rather than a blank region.

- **Loading, first open.** The Pools group renders skeleton rows - a name-width and a bar-width
  block per row - so the group has shape while Git, process, and provider state are observed. It
  never renders a heading over void.
- **No pools yet.** "No pools yet. Mission Control creates one the first time something needs a
  checkout in a repository." An invitation to act, not a report of absence.
- **Nothing to drain.** "Nothing left to drain. All historical leases have been returned, and new
  work never acquires Treehouse resources." The four classification counts appear only when at
  least one is non-zero.
- **Inventory unavailable.** The manager returning `503` is distinguished from an empty inventory:
  the group states that state could not be observed and offers Refresh, rather than claiming zero
  pools.

## Alternatives considered and not taken

Both were rendered as full mockups and reviewed alongside the adopted direction.

- **A - Settings-native.** Adopt the Harnesses layout wholesale: pools as rounded left-accent cards
  on the existing `auto-fit / minmax(300px, 1fr)` grid, counts as a label/value grid inside each
  card. Smallest diff and zero new primitives. **Not taken** because it fixes the theme breaks and
  nothing else - `Default maximum` stays an arbitrary number, and over-capacity stays a word in a
  chip.
- **C - Master-detail.** Opt out of the 900px measure the way `.ts-panel` already does, and render
  one filterable list of every slot across every pool beside a sticky detail-and-actions column.
  The only direction that scales cleanly to the ~54 slots this machine actually produces.
  **Not taken** for cost: a new layout shell, selection state, list-then-detail push navigation at
  narrow widths, re-cut `settings-search.ts` anchors, and a wholesale rewrite of
  `e2e/specs/settings-worktrees.spec.ts`. Worth revisiting if pool counts keep growing - the
  capacity bar composes with it rather than blocking it.

## What does not change

These are contracts from the source plan and must survive the restyle intact.

- Every mutation stays preview-first: request a preview, show affected paths, blockers and
  consequences, require the server-supplied acknowledgement keys, execute against the opaque token,
  and treat a `409` as a stale preview rather than a failure.
- No `data-testid`. Selection stays by role, label, and placeholder.
- The three `data-anchor` values feeding settings search must keep resolving. `worktrees/policy`
  moves down the pane with the Defaults group; it does not disappear.
- Colour never carries state alone. Every tone is paired with a word.
- Inventory stays out of `MissionState`; only the `worktreesRevision` counter lives there.
- Legacy rows without provable identity get an explanation, never a disabled `Force` button.
- Lowering the maximum never prunes as a side effect. The bar makes the over-capacity state
  visible; it does not make it self-correcting.

## Verification

- A Playwright spec in `e2e/`, extending `e2e/specs/settings-worktrees.spec.ts`: the loading and
  empty states, a populated pool with its bar and legend counts, an over-capacity pool offering the
  prune preview, the disclosure into slot detail, and one preview-and-cancel round trip.
- A `renderToStaticMarkup` case pinning the bar's segment widths and its composed `role="img"`
  label against a known inventory, since those are arithmetic and cheap to assert directly.
- The Electron geometry test for the pane at a narrow width, since overflow behaviour is the part
  most likely to regress.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run test:e2e`.
- Screenshots of the pane loading, empty, populated, and over capacity, attached to the pull
  request rather than committed.
