# Grouping Board session cards by repository

## Why

The Board answers what every agent is doing. It does not answer **which project**. On a fleet
running one repository that costs nothing; on a fleet running four it is the first question an
operator asks and the last one the screen answers - the only clue on a card is the branch name,
and branch conventions are per-repository, so `harness/rotate-signing-key` and
`mission/fix-the-parser` are two guesses rather than two answers.

The board already knows how to say "these belong together": an ai-conductor run and an ensemble
each draw a framed cluster with a header naming the run. The repository is the level above that,
and it is missing.

## What is added

A **repository grouping level** inside each Board column: the cards in a column collect under a
coloured heading naming the repository their session belongs to. It is structurally the sibling
of the run cluster the board already draws, one level out - colour-coded so two projects are
told apart at a glance, titled with the repository's own directory name, and collapsible from
its heading.

On by default, with one checkbox to turn it off.

### Where the grouping comes from

`Session.repoRoot`, already shipped to the dashboard. It is the repo-level sibling of `gitRoot`:
for a linked worktree it points back at the **main repository** rather than at the worktree's own
directory, so two sessions in two checkouts of one project group as one project. That is exactly
the grouping being asked for, and it is why this is `repoRoot` and not `cwd`.

A session with a null `repoRoot` is not in a repository. Those stay ungrouped and last in the
column rather than being collected under an invented heading.

### Three rules this must not break

1. **A group never crosses a tone column.** `orderSessions` already refuses to let a run cluster
   drag a working sibling into "needs you", because a column that fills with agents nobody has to
   act on is a column that stops being read. A repository group inherits that rule, so a
   repository with six sessions appears in each column its sessions' own states put them in. Each
   heading therefore carries a rollup - `2 of 6 on the board` - which is the same device the
   ensemble head already uses to tie a split run's halves together, and it prints `N agents`
   instead when every session the repository has is in that one column.
2. **The run cluster stays inside the repository group, and stays a cluster.** An ai-conductor run
   is keyed by `(provider, repoRoot, slug)`, so it belongs to exactly one repository and the
   nesting is total rather than a case to handle. The engine's own frame is unaffected.
3. **One ordering, computed once.** `orderSessions` is the single fleet order, and the arrow keys
   walk index arrays derived from the same call - `moveSelection` indexes a per-column list on the
   board and a flat list in the console. Grouping that is applied while rendering rather than in
   the ordering is Up/Down landing somewhere other than where the eye is.

### Colour

The colour comes from a stable hash of `repoRoot` into a fixed palette, so a repository keeps its
colour across reloads and machines, and the palette is deliberately kept off every state hue -
`--working` blue, `--idle` green, `--attention` amber, `--danger` red, `--held` purple. A
repository colour that landed on one of those would teach the eye that a frame means a state. The
saturated end of the colour appears only in the heading's 7px swatch; the group itself is tinted,
so a card's own tone always wins inside it.

## Decided: candidate 1, the repository frame

**Built.** The operator chose the framed treatment, with one amendment made before it shipped:
the head is **one line**, with the count beside the title rather than under it, so a group costs
its column a single row of chrome instead of two. `2 of 7` replaced `2 of 7 on the board`; the
sentence it shortened moved to the header's hover copy and its accessible name, which is where a
count that needs explaining belongs.

Two things were learned in the building and are recorded here because they changed the design
rather than merely implementing it:

- **The palette shrank from seven entries to six.** The first version paired a gold with a clay
  (20 degrees of hue apart) and a teal with a steel (10 degrees), and two repositories landing on
  either pair drew two frames a person could not tell apart - which is the whole job of the
  colour. Perfect avoidance of the six state hues turned out to be unbuyable at that spacing, so
  the palette is now six entries at least 30 degrees apart, defended positionally instead: a
  repository colour appears only as a frame border tint and a 7px dot beside a monospace name,
  never as a card spine, a column swatch or a badge fill. `test/repo-color.test.ts` asserts the
  separation numerically, because a real board was the only thing that caught it.
- **The console rail groups too.** The board's focused column *becomes* that rail on drill-in, so
  a grouping that stopped at the morph would read as the fleet regrouping when only the layout
  moved - the same argument the free/held rule already makes for being drawn by one shared
  component in both places.

The three candidates and their trade-offs are kept below as the record of the decision.

## The choice: how strongly the grouping draws

**The mock-ups are [`mockups.html`](./mockups.html), beside this file.** Open that page: it draws
one fleet four times - today's board, then each candidate - across three real tone columns. The
cards, the column heads, the free/held section rules and the nested `ai-conductor` run frame are
the real components against the real stylesheet, reduced to the rules that actually match so the
page is small enough to live here. Only the repository grouping is new markup.

The fleet in it is deliberately awkward. `mission-control` has **seven** sessions spread across
all three columns *and* across the idle column's free/held boundary, so it is grouped four
separate times and every heading has to say which part you are looking at. `ai-conductor` has
four, two of them one engine run. `upstart-platform-services` has exactly one. Two sessions are in
no repository at all. In the idle column the `mission-control` group is drawn collapsed. The cards
carry the flags a real board carries - an escalated decision, a draft, a queue depth, an open and
a merged pull request, Inspector findings, a pending review, a held session - because a grouping
treatment that only looks right over bare cards is not a treatment that has been reviewed.

| | Treatment | Costs | Reads best when |
| --- | --- | --- | --- |
| **1** ✅ | **Repository frame** - the run cluster's own box, one level out: rounded border, tinted body. Shipped with a one-line head rather than the cluster head's two | Nesting and width. A run inside a repository is a box inside a box, and the double inset takes ~16px off every card in it | You want the grouping to be unmistakable, and prefer one visual idiom on the board over a lighter second one |
| **2** | **Repository swimlane** - a 4px coloured rail down the group with a one-line title above it, no border around the cards | The rail sits 14px from each card's own 3px state spine, so a column has two stripes down its left edge | You want the group obvious but the run frame to stay the only box on the board, and want cards to keep their width |
| **3** | **Repository rule** - a coloured heading rule between groups, and the repository's colour as the lower third of each card's existing left spine | Subtlety. The split spine is a 3px strip and can read as an artifact until you know what it is; the ungrouped sessions need their own heading here, because with no container the cards after a heading belong to it | You want the colour on the cards themselves rather than on a container, so a card stays identifiable after its heading has scrolled away |

All three collapse from the heading, all three leave the engine's run frame intact, and all three
use the identical settings control.

## Implementation

1. `src/web/lib/fleet-order.ts` - the repository level joins the ordering, not the rendering. A
   tone group's `sessions` gain a repository partition ahead of the existing run clustering, and
   `fleetRows` grows one row kind so a column expands into `(repository heading, blocks…)` rather
   than `blocks…`. This is the controlled contract the whole feature turns on: `BoardView`,
   `ConsoleView` and `App`'s arrow-key columns all read this one call, so the partition happens
   here or the three disagree.
2. `src/web/components/layouts/BoardView.tsx` and `ConsoleView.tsx` - draw the new row kind, in
   the board's frame and the rail's one-line group. The card itself is untouched: the group is a
   wrapper, never a second rendering of a tile, which is why `sectioned` takes the already-
   rendered children and `ConsoleView` grew a `renderBlock` the frame and the top level share.
   Collapse state lives here, keyed per ROW rather than per repository, so folding a repository in
   `idle` cannot fold away its sibling waiting for you in `needs you`.
3. `src/web/components/session-bits.tsx` - a `RepoGroupHead`, beside `EnsembleClusterHead` and
   `PipelineClusterHead`, so the three heads share their box and cannot drift on what a frame
   header looks like.
4. `src/web/lib/repo-color.ts` - the hash and the palette, as one pure function, so the board and
   any later surface that colours a repository read the same answer.
5. `src/web/styles.css` - the group's classes, in the tile and cluster block they sit with.
6. `src/shared/protocol.ts` - one `UiConfig` boolean, `groupBoardByRepo`, defaulting **true**.
   Board grouping is not a card item, so it is deliberately NOT an entry in `DISPLAY_ITEMS`: that
   registry answers "what does a card draw", and this answers "how is a column arranged".
7. `src/web/components/LayoutPanel.tsx` and `src/web/lib/settings-search.ts` - the checkbox and
   its index entry, under a `display/board-grouping` anchor, `kind: "toggle"` so the command
   palette can flip it directly.

### Open, and deliberately not decided here

**Collapse state is local and un-persisted**, matching `revealed` and `wideCol` in `BoardView`:
collapsing a repository is "let me look at the rest of the board for a second", not a setting. On
a fleet with eight repositories that will probably want to persist; that is a follow-up with its
own storage decision, not a thing to smuggle into this change.

## Tests

- `test/fleet-order.test.ts` - the partition, in the same file that already pins the run-cluster
  spans: a repository group never crosses a tone boundary or the free/held boundary, a run
  cluster never straddles a repository, ungrouped sessions sort last, two frames for one
  repository in one column do not share a React key, the order is still idempotent, the rollup
  counts across the whole board rather than one column, and a fleet with the setting off comes
  out byte-identical to today's order. Plus the arrow keys walked through a frame with the real
  `moveSelection`, in both layouts - the assertion the whole placement decision exists for.
- `test/repo-color.test.ts` - new, and the file that would have caught the palette defect: every
  pair of entries is at least 30 degrees of hue apart, a family of sibling checkouts reaches
  every entry, the index is always in range, and no entry equals a state hue read out of
  `styles.css` rather than pasted into the test.
- `test/styles-tokens.test.ts` - `--repo-c` declared as a JS-set token, so the guard that catches
  a `var()` naming nothing keeps working.
- `e2e/specs/board-repo-groups.spec.ts` - new. Dispatches fake agents into two repositories,
  switches to the Board, and asserts the headings are present **without anybody opening
  Settings** (the on-by-default claim), that each names its repository's directory name, that a
  session's card is inside its repository's group, that the heading collapses and restores its
  cards, and that unchecking **Group by repository** returns the column to one flat list. Only a
  browser settles any of those.
