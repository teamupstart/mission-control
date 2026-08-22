# Settings > Worktrees: three layout directions

- **Status:** Awaiting review. Planning only - this document proposes no application changes by itself.
- **Date:** 2026-08-21
- **Surface:** `src/web/components/WorktreeSettingsPanel.tsx` and the `wt-` block in
  `src/web/styles.css` (lines 403-781).
- **Trigger:** The pane does not read as part of Mission Control. This plan diagnoses why,
  in specifics, and offers three layouts to choose between.

## What is actually wrong

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

Two further gaps, visible the moment the pane is opened on a machine with no pools:

- **The empty state is blank.** With `inventory` still null, `02 · Native inventory / Pool ledger`
  renders a heading, a Refresh button, and nothing else - a heading over void. The
  "No native pool exists yet" hint only appears once the fetch resolves to an empty array.
- **It will not scale.** The source plan recorded a live pool of **54 slots** on this machine.
  The current design renders pools as a card grid and paginates slots 12 at a time inside each
  card, inside a 900px measure. That shape stops working an order of magnitude below the real number.

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

## The three directions

Each is a complete layout for the whole pane, not a palette swap. Mockups of all three are
rendered in `plan.html` beside this file.

### Direction A - Settings-native

**Thesis:** the pane should be unremarkable. It is a settings pane in a settings app; the pools are
the interesting thing, not the chrome. Adopt the Harnesses layout wholesale.

```
Worktrees                                         [THIS MACHINE]
Mission Control owns these checkouts. Policy changes affect future
leases only, and every cleanup is previewed and rechecked against
task, check, manual lease, Git, and process ownership first.

Defaults
  Use native worktrees                                    [ x ]
  New acquisitions get a pooled checkout...
  Default maximum slots                                  [ 16 ]
  Lowering this marks pools over capacity. It never prunes.

Pools                                              Refresh
  +--------------------------+  +--------------------------+
  | * ai-harness      12 / 16|  | * docs-site        3 / 8 |
  | Available   4            |  | Available   3            |
  | Leased      8            |  | Leased      0            |
  | Quarantined 0            |  | Quarantined 0            |
  | Disk        3.1 GB       |  | Disk        410 MB       |
  | > 12 slots               |  | > 3 slots                |
  +--------------------------+  +--------------------------+
  Pools are created lazily on first acquisition.

Treehouse
  Nothing left to drain. All 0 historical leases are returned.
```

- The safety promise becomes the lead sentence. No box, no kicker, no numbering.
- Policy becomes two `.kb-row`s, identical in shape to Harnesses' `Auto mode on dispatch`.
- Pools become `.harness-card`-shaped cards on the same `auto-fit / minmax(300px, 1fr)` grid,
  with a 3px left accent carrying the health tone and a rounded 10px corner.
- The ledger counts become a label/value grid inside the card instead of mono tiles.
- Slot detail lives behind the card's disclosure, as it does today.
- Treehouse is the last group and collapses to a single dim sentence when all four counts are zero.

**Cost.** At the 900px measure two cards per row leaves each ~440px, which is tight for a slot's
path, HEAD, and five actions - slot detail stays behind a disclosure and keeps its bounded scroll.
It does not fix the scale problem; it makes a small pool pleasant and leaves a large one paginated.

**Gain.** Lowest risk and smallest diff. Reuses `.kb-row`, `.harness-card`, `.skill-badge`,
`.skill-switch` and `.settings-hint` verbatim, so it inherits every future change to them. The pane
stops announcing itself.

### Direction B - Capacity-first

**Thesis:** an operator arrives at this pane with one question - *do I have room, and what is
holding the rest?* Answer it in the first 200 pixels, and give `Default maximum` a meaning a number
input cannot carry.

```
Worktrees                                         [THIS MACHINE]
Mission Control owns these checkouts. Every cleanup is previewed
and rechecked before it can mutate a path.

Pools                                              Refresh
  ai-harness                          8 leased · 4 free · 16 max
  [########====----------------|.....................]
   leased    free   room to grow     ^ max        > 12 slots

  docs-site                            0 leased · 3 free · 8 max
  [===--------------|...............]
   free    room to grow  ^ max                     > 3 slots

  overflowing-repo                  18 leased · 0 free · 16 max
  [############################!!]  OVER CAPACITY
   leased                    over    Preview safe prune >

Defaults           affects future acquisitions only
  Use native worktrees                                    [ x ]
  Default maximum slots                                  [ 16 ]

Treehouse
  Nothing left to drain.
```

- **Signature: the capacity bar.** One track per pool, segmented into leased (`--working`),
  available (`--idle`) and quarantined (`--danger`), The track's full width *is* the
  configured maximum, so the unfilled remainder reads directly as room to grow and is hatched to
  say so. A pool over its maximum spills past the track in `--attention` hatching, and the
  safe-prune preview surfaces on that row. Lowering the default maximum visibly reflows every bar,
  which is exactly the feedback the current number input withholds.
- Order inverts. Pools come first because they are the answer; `Defaults` moves below them,
  labelled with the constraint the plan already states - it affects future acquisitions only.
- Pools are full-width rows rather than a card grid, because the bar needs the width.
- Per-pool overrides live inside the pool's disclosure, next to the bar they change.
- Treehouse renders as one attention-toned row while anything is undrained, and one dim
  sentence once it is not.

**Cost.** The bar is a new component with no existing precedent in the app, so it is new CSS to
maintain and it needs an accessible text equivalent carrying the same counts (a `role="img"` with a
composed label, or a visually-hidden restatement). It is the largest new-invention risk of the three.

**Gain.** The pane answers its actual question at a glance, and the one control that today reads as
an arbitrary number becomes legible. Over-capacity - which the source plan calls out as a real
lifecycle gap, since lowering the ceiling does not right-size a grown pool - becomes visible instead
of being a word in a chip.

### Direction C - Master-detail

**Thesis:** this is not a form with an inventory attached, it is an inventory with a form attached.
Task sources already opted out of the 900px measure for exactly this shape. Worktrees has the same
shape and more rows.

```
Worktrees                                                              [THIS MACHINE]
+----------------------------------------------+  +------------------------------+
| [All] [Leased] [Free] [Quarantined] [Legacy]  |  | ai-harness / slot 7          |
| filter paths...                               |  |                        LEASED|
|                                               |  | Path  ~/.mission-control/... |
| ai-harness                            12 slots|  | HEAD  9f3c1ad                |
|  o slot 1  ~/.mc/wt/ai-harness-1  free    -   |  | Base  2 commits behind main  |
|  * slot 2  ~/.mc/wt/ai-harness-2  leased  4h  |  | Work  3 dirty · 1 untracked  |
|  * slot 7  ~/.mc/wt/ai-harness-7  leased  12m |  | Procs 1 (node)               |
|  ! slot 9  ~/.mc/wt/ai-harness-9  quarant -   |  | Disk  260 MB                 |
|  ...                                          |  | Owner task #418 >            |
|                                               |  |                              |
| docs-site                              3 slots|  | Cleanup is previewed and     |
|  o slot 1  ~/.mc/wt/docs-site-1   free    -   |  | rechecked against ownership  |
|  ...                                          |  | before it can mutate a path. |
|                                               |  |                              |
| Treehouse (legacy)                     0 rows |  | [Copy] [Terminal] [Return]   |
+----------------------------------------------+  +------------------------------+
```

- Opt out of `max-width: 900px`, the way `.ts-panel` already does.
- **Left:** one scrolling list of every slot across every pool, grouped under pool headers. One row
  per slot: tone dot, slot id, path in mono, state, lease age. A filter strip above it, plus a text
  filter over paths and owners.
- **Right (sticky, ~320px):** the selected slot's full detail and its actions. With nothing
  selected, the column shows the global defaults and the selected pool's overrides - so policy is
  present without owning a section.
- The safety promise appears once, immediately above the actions, where it is load-bearing rather
  than decorative.
- Legacy Treehouse rows become a filter value in the same list, so `ownedExact`,
  `identityUnverifiable`, `foreign` and `unreadable` are inspected with the same affordances, with
  actions disabled and the reason shown in the detail column.

**Cost.** The largest change of the three. It needs a new layout shell, selection state, a narrow-width
story (list-then-detail push navigation), and a new answer for settings search: the three current
`data-anchor` values map to filters rather than to sections, so `settings-search.ts` anchors must be
re-cut. The existing `e2e/specs/settings-worktrees.spec.ts` is rewritten wholesale rather than adjusted.

**Gain.** The only direction that scales to the pool sizes this machine actually produces. It also
removes the pane's worst structural problem - that reaching one slot means expanding one pool, then
paging within it - and puts every slot one filter away.

## Comparison

| | A - Settings-native | B - Capacity-first | C - Master-detail |
| --- | --- | --- | --- |
| Fixes the nine theme breaks | Yes | Yes | Yes |
| New components to maintain | None | The capacity bar | Layout shell, selection, filters |
| Reuses `.kb-row` / `.harness-card` | Fully | Partly | Little |
| Scales to ~54 slots | No | Partly | Yes |
| Makes `Default maximum` legible | No | Yes | No |
| Keeps the 900px measure | Yes | Yes | No - opts out |
| Narrow-width work | None beyond today | Bar reflow | New push navigation |
| `e2e` spec impact | Selectors adjusted | Selectors adjusted, bar assertions added | Rewritten |
| Relative size | Small | Medium | Large |

## What does not change in any direction

These are contracts from the source plan and must survive the restyle intact.

- Every mutation stays preview-first: request a preview, show affected paths, blockers and
  consequences, require the server-supplied acknowledgement keys, execute against the opaque token,
  and treat a `409` as a stale preview rather than a failure.
- No `data-testid`. Selection stays by role, label, and placeholder.
- The three `data-anchor` values feeding settings search must keep resolving to something, whatever
  the layout does to sections.
- Colour never carries state alone. Every tone is paired with a word.
- Inventory stays out of `MissionState`; only the `worktreesRevision` counter lives there.
- Legacy rows without provable identity get an explanation, never a disabled `Force` button.

## Verification any direction owes

- A Playwright spec in `e2e/` for the new layout, extending `e2e/specs/settings-worktrees.spec.ts`.
  It covers the empty pane, a populated pool, the disclosure, and one preview-and-cancel round trip.
- The Electron geometry test for the pane at a narrow width, since the current design's overflow
  behaviour is the part most likely to regress.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run test:e2e`.
- Screenshots of the pane empty and populated, attached to the pull request rather than committed.

## Open choices

Three, presented in the dashboard rather than here:

1. **Which layout direction** - A, B, or C.
2. **What happens to the safety callout** - restyle the box, demote it to the lead paragraph, or
   move it beside the actions in the preview dialog where it is load-bearing.
3. **Scope** - theme conformance only, or also the empty and loading states, or also a full
   accessibility and narrow-width pass.
