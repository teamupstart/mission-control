# Workflow run detail: consolidating delivery, evidence and intent

## What this plan was measured against

Every number and every mockup in this plan comes from one real record: **No-Mistakes Review v14,
run `2a8b89dc-32d1-4565-b505-d4b5f119bd86`, round 2**, which is the run in the screenshots that
prompted the work. Reviewer names, verdicts, requested changes, delivery hashes and timestamps, the
conversation key, the frozen author claims, the readiness result, the human decision count and the
snapshot facts are read from the daemon's own records rather than invented. The mockups inline the
application's real stylesheet, so they are the real components rather than lookalikes.

## The problem, measured

Rendered heights of the run detail page below the round scrubber, in a 1280x900 viewport at the run
column's 1120px width, with the real stylesheet and the unclipped records:

| Section | Height | What it is |
| --- | --- | --- |
| Review worklist | 220 px | Already bounded. Rail and detail are both capped at `min(52vh, 480px)`. |
| Repair delivery | 2,331 px | Four cards of **exactly 560 px each**. The payload `<pre>` is already capped at 340 px, so the cost is the card, not the text. |
| Image evidence | 79 px | Empty on this submission. A whole section to say "none". |
| Evidence readiness | 1,341 px | 621 px of frozen author claims plus 594 px of canonical reconciliation. On this submission the two agree and read as duplicates; on a submission with gaps they say different things, so the reconciliation cannot simply be merged away. |
| Captured intent and evidence | 3,947 px | **2,996 px of it is nine uncapped human decision bodies** (21,775 characters). The single largest block on the page. |
| **Total** | **7,997 px** | **8.9 screens** at a 900 px viewport, to carry three sentences of verdict. |

Two things that measurement corrected, and they change what a fix should target:

- **The delivery payloads are not the main cost.** They already scroll inside a 340 px cap. What
  costs 2,331 px is four fixed-height cards, each spending 220 px on a five-field definition list
  and a state sentence before the payload starts. Ten deliveries would cost 5,600 px without a
  single extra character of payload.
- **The Review worklist is the one section already doing the right thing.** It is a bounded
  rail-plus-detail at 220 px. It should be left alone, and it is the model the other three should
  follow.

The three questions the page should answer at a glance are: did the packets reach the session, is
the proof structurally complete, and what was this round trying to do. On this run the honest
answers are one sentence each - *all four delivered, newest 1:32:49 PM*; *ready, six claims all
linked, two proof-class warnings, no images*; *Phase 3 evidence carry-forward, nine human decisions,
HEAD 1665b769, tree dirty* - and none of them is on screen at the same time as the worklist.

## Constraints

- **No field is dropped.** Every payload, hash, timestamp, caption, MIME type, scope, digest, proof
  class, link chip, gap and warning that renders today still renders, somewhere reachable.
- **No action is dropped.** Retry refused delivery, the uncertain-delivery resolution buttons,
  "Continue despite gaps" with its reason and acknowledgement, "Use in next review" on a retained
  image, and the readiness retry all keep working and keep their confirm dialogs.
- **A blocking state cannot hide.** A refused or uncertain delivery, a readiness block that has
  parked the run, and a corrupt or unreadable context are surfaced without a click. Whichever
  container they land in opens itself and carries a count on its label.
- **The worklist stays primary**, keeping its position, its rail, its segment control and its tour
  anchor (`tourWorklistRef`).
- **The round scrubber still governs.** Everything under it belongs to the viewed round, and
  changing rounds does not silently change which surface you are looking at.
- **Accessibility.** Selection by role, label and placeholder only. No `data-testid`. Any new tab
  bar is a real `role="tablist"` with arrow-key movement; any new overlay uses `.modal` and
  therefore `--modal-inset`.
- **Every option ships a Playwright spec in `e2e/`**, plus `renderToStaticMarkup` cases for the new
  summary sentences, because a wrong count in a collapsed summary is the new failure mode this
  change introduces.

## The design: tabs under Review worklist

Review worklist keeps its section and becomes the first and default tab on a `.workflow-tabs` bar.
Deliveries, Evidence and Intent become three sibling tabs, each rewritten from a stack of cards into
a ledger.

- **Deliveries** becomes a four-stat strip (delivered 4, refused 0, uncertain 0, newest 1:32:49 PM)
  over one table row per packet carrying round, kind, state chip, delivered time, payload hash and
  character count, with "Show packet" expanding the payload inside the row. Four 560 px cards become
  four table rows.
- **Evidence** merges Image evidence and Evidence readiness into one pane. A stat strip (readiness,
  author claims, gaps, images) sits over three blocks: any canonical criterion the reconciliation
  could not match, named with its gap code; the frozen images as a thumbnail strip; and one compact
  row per frozen author claim with a status dot, its artifact ids and any warning inline. The
  reconciliation keeps its own block rather than being folded into the claims, because a gap belongs
  to a canonical criterion that by definition has no author claim to sit under - on the four-image
  submission in the mockups, five of the six gaps are canonical criteria with no match at all.
- **Intent** leads with the refined goal, then collapsed disclosures for the original goal (2,566
  characters), the nine human decisions summarised as one row each with their source and size, the
  acceptance criteria and the constraints, with the snapshot facts as a chip row.

Tab labels carry counts, and an amber badge when a tab holds something blocking. On this run only
the worklist earns the badge, which is exactly what the record says.

**Why:** one place to look, and the page below the worklist stops existing. Reuses a component the
app already ships.

**Costs:** three panes are invisible until clicked, so the selected pane has to live in the route
for links and round changes to preserve it. The worklist already has an internal rail and a segment
control, so a tab bar above it is a second layer of navigation in one section. Screenshotting a
whole run for a pull request needs an expand-all.

## Image evidence in the Evidence pane

Frozen images stop being their own section and become a thumbnail strip inside the Evidence pane,
above the claims. This is the part of the design that is not just a rewrite of what exists: today an
image is only visible after scrolling past the deliveries into a section of its own, and its
relationship to the claim citing it is expressed as a bare `clientItemId` in a chip.

**The strip.** One card per frozen image: the thumbnail, the display name, the item id, the scope,
the size, and who cites it - the record already carries the relation, so a card can say "cited by 3
claims as rendered output" instead of leaving the reader to match ids. A pruned image keeps its card
and shows "Body pruned" in the frame rather than a broken thumbnail, exactly as
`LazyWorkflowEvidenceImage` does today. The existing `IntersectionObserver` lazy load stays, but has
to key off the pane becoming visible rather than the section scrolling into view, because a pane
that is not selected is not scrolled past.

**On the claim rows.** A claim that cites an image carries a small copy of that image at the end of
its row. The point of a screenshot as evidence is that a reader can see it beside the claim it
proves, and a 34px thumbnail is enough to tell one screenshot from another and to say "this claim
has a picture behind it".

**The preview.** Clicking a thumbnail opens the dispatch modal's own preview shape - `Overlay` with
`.modal attach-preview`, `.modal-head` carrying the name and the close control, and
`.modal-body attach-preview-body` whose own dark backdrop keeps a dark screenshot's edges visible
against the panel. Escape, the close control and the backdrop all dismiss it, and Escape closes only
this layer, so a preview opened over another overlay does not take that overlay with it. Focus is
captured on open and restored on close, as `AttachmentStrip` already does.

Two differences from the dispatch case, both forced by the data rather than chosen:

- The dispatch preview paints a local `previewUrl` blob that is already in memory. A frozen workflow
  image has to be fetched from `/api/workflow-runs/:runId/images/:imageId`, which is the route the
  ledger already uses. The preview should reuse the object URL the thumbnail already created rather
  than fetching the body twice.
- The dispatch preview has nothing to say about its image beyond the filename. A frozen image has a
  caption, an item id, a scope, a MIME type, a size, an availability and a SHA-256, and it has the
  "Use in next review" re-stage action. Those move into a `.modal-foot` on the preview. That is what
  lets the strip stay scannable without dropping a field.

**Gesture.** `AttachmentStrip` opens on double-click for a pointer, deliberately, because a
single-click there would land the second click of a double on the backdrop that just appeared. That
reasoning does not transfer: an evidence thumbnail has no second gesture competing for the single
click, and the ask is that clicking a thumbnail opens it. So this strip opens on a single click, and
keeps the `detail === 0` keyboard route so Enter and Space work. The two surfaces differing here is
a real inconsistency and worth stating rather than hiding; the alternative is making the common case
worse to match a constraint the common case does not have.

## Alternatives considered

These were mocked against the same record and set aside. The rail is the better end state on a wide
monitor but is the chosen design plus a rail, so it stays reachable later without rework.

### A persistent round record rail

The run body becomes two columns. The worklist gets the left column and never moves. The three
sections collapse into a docked right rail with its own scrollport, showing one of Deliveries,
Evidence or Intent at a time via a segmented control. Selecting a worklist row can point the rail at
what that reviewer was given. Below a width threshold the rail moves under the worklist and becomes
the chosen design's tab bar.

**Why:** nothing is hidden, because the rail always shows one of the three and the worklist never
scrolls past it. Cross-reading a verdict against the packet that produced it becomes possible for
the first time. Wide screens carry content instead of margin.

**Costs:** the most build of the four. A two-column run body is new layout, and the narrow fallback
is the tab bar anyway, so this is the chosen design plus a rail. The rail introduces a second scroll region, and a
7,996-character packet still needs an overlay to be readable in a 400 px rail. On a laptop the
worklist column narrows, and the worklist is the primary object.

### One Round record section with rows that expand in place

No new navigation. The three sections merge into a single "Round record" section holding three
collapsed rows, each closed state a full sentence with the real counts and a status chip:

- *Deliveries - All 4 packets reached the session. Newest 1:32:49 PM, nothing refused.* `delivered`
- *Evidence - 6 frozen author claims, all linked. 0 images. 2 proof-class warnings.* `ready`
- *Intent - Phase 3 evidence carry-forward. Compacted, 9 human decisions, HEAD 1665b769, tree dirty.* `captured`

Rows default to collapsed, except one that is blocking, which opens itself.

**Why:** the smallest change and the least new concept. The page still reads top to bottom, closed
rows still answer the question, and printing a run for a pull request still works by expanding rows.

**Costs:** expanding two rows puts you straight back into a long scroll, and the 2,996 px of human
decision prose is still 2,996 px once opened. There is no cross-reading. It is the least ambitious
of the four.

### A round dossier with a full-screen reader

The three sections stop being sections. What survives on the page is one three-column dossier
*above* the worklist, carrying only what changes a decision: the refined goal with its decision
count and snapshot facts; the readiness verdict with linked-claim counts, gaps and warnings; the
delivery state counts with the newest packet and conversation. Each column ends in one link.

Every raw body leaves the page: the four packets, the original prompt, the nine human decision
bodies, the reconciliation table, the image ledger and the snapshot facts all live in a full-screen
reader with its own left nav, keyboard next and previous, and a close that returns you to your
scroll position.

**Why:** it attacks the measured cause directly. The 2,996 px of decision prose and the 2,331 px of
delivery card chrome both leave the page, which is 66 percent of the total in one move. The dossier
reads as one sentence per column, the fastest scan of the four. A full-width reader is a better
place for a 7,996-character packet than a 340 px scrollport inside a card. The page cannot regrow,
because raw text no longer has anywhere on it to be printed.

**Costs:** the biggest behavioural change; everything raw is two clicks away. It adds a new
full-screen surface to build, route and keep accessible. The dossier's summaries are derived values,
and every derived value is a new thing that can be wrong or stale.

## What was decided, and what is still open

**Tabs under Review worklist is the chosen approach**, with the two borrowings above: counts and an
amber badge on every tab label so an unvisited pane still reports, and the ledger treatment of
Deliveries and Evidence so the two sections whose cost is chrome rather than content stop paying it.
Those two changes alone remove about 3,000 px without hiding anything.

Frozen images are visible as thumbnails in the Evidence pane and open in a preview modal, as above.

One thing the design does not settle. The largest single block on the page is the nine human
decision bodies at 2,996 px, and tabs alone do not bound them - the Intent pane only helps if each
decision collapses to a summary row that opens on demand. That is a real behaviour change for
content a reader can currently take in by scrolling, and it is the open question this plan carries
into review.

## Non-goals

- No change to what the daemon stores, to `WorkflowContextSnapshotSchema`, to delivery records, or
  to any wire contract in `src/shared/`. This is a rendering change over data that already arrives.
- No change to the Review worklist's internals. It is the section already behaving correctly.
- No change to evidence readiness policy, delivery retry semantics, or override recording.

## Verification

- A Playwright spec in `e2e/` covering: the default surface on load, reaching each consolidated
  surface, a blocking delivery or readiness state being visible without a click, the counts on the
  labels, and one action (retry or override) still reaching its route from its new home.
- A Playwright spec for the image path specifically: a thumbnail is present in the Evidence pane for
  a submission with frozen images, clicking it opens the preview, the preview carries the caption
  and digest, Escape closes only the preview, and focus returns to the thumbnail. Image bodies are
  served from a fixture, never fetched from a real run.
- `expectContentClearsBorder` from `e2e/fixtures/modal-inset.ts` on the image preview, which is a new modal.
- `renderToStaticMarkup` cases for the summary sentences and counts.
- Electron geometry coverage only if a fixed-height scrollport is introduced.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke`, `npm run test:e2e`.

## Mockups

`docs/plans/workflow-run-detail-consolidation/mockups.html` renders today's page, the chosen design
and the three alternatives against real records, with the application's own stylesheet inlined. Open
it directly to click through the tabs.

Round 2 of run `2a8b89dc` froze no images, so its Evidence pane shows the empty state. The image
frames in that file use a different real submission - run `c608ddc9` round 1, which froze four
images against seven claims and came back `gaps` - and the thumbnails are the real frozen bodies,
downscaled. Long free-text bodies are clipped in that file and marked where that happens; the
heights in the table above were measured against the unclipped render.
