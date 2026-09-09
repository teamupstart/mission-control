# Workflow run detail: consolidating delivery, evidence and intent

## The problem

The workflow run detail page prints four full-width sections below the Review worklist, and each
one renders its raw material inline:

| Section | What it renders today | Cost on a repair round 6 run |
| --- | --- | --- |
| Repair delivery | One card per delivery packet, each with a five-field definition list and the entire payload in a `<pre>` | ~6 screens |
| Image evidence | A ledger with a thumbnail, caption, scope, MIME, size and full SHA-256 per image | ~0.3 screens when empty, more with images |
| Evidence readiness | One card per frozen author claim plus one per canonical criterion, each with its link chips | ~3 screens |
| Captured intent and evidence | The complete original prompt in a `<pre>`, the refined goal, every human decision with rationale, constraints, acceptance criteria, and a snapshot fact list | ~4 screens |

That is roughly eleven screens of scrolling for material an operator reads in one of two modes:
either they want the verdict, which is one sentence per section, or they want one specific payload,
which they currently reach by scrolling past five others. Neither mode is served. The three
questions the page should answer at a glance are:

1. Did the packets this round produced actually reach the session?
2. Is the proof structurally complete, and which criterion is short?
3. What was this round trying to do, and what did a human already decide about it?

Every one of those is answerable in a sentence, and today none of them is on screen at the same
time as the worklist.

## Constraints that hold for every option

These are not negotiable in any of the four approaches below.

- **No field is dropped.** Every payload, hash, timestamp, caption, MIME type, scope, digest,
  proof class, link chip, gap and warning that renders today still renders, somewhere reachable.
- **No action is dropped.** Retry refused delivery, the uncertain-delivery resolution buttons,
  "Continue despite gaps" with its reason and acknowledgement, "Use in next review" on a retained
  image, and the readiness retry all keep working and keep their confirm dialogs.
- **A blocking state cannot hide.** A refused or uncertain delivery, a readiness block that has
  parked the run, and a corrupt or unreadable context are surfaced without a click. Whichever
  container they land in opens itself, and carries a count on its label.
- **The worklist stays primary.** Review worklist keeps its position, its internal rail, its
  segment control and its tour anchor (`tourWorklistRef`).
- **The round scrubber still governs.** Everything under it belongs to the viewed round, and
  changing rounds does not silently change what surface you are looking at.
- **Accessibility.** Selection by role, label and placeholder only. No `data-testid`. Any new tab
  bar is a real `role="tablist"` with arrow-key movement; any new overlay uses `.modal` and
  therefore `--modal-inset`.
- **Every option ships a Playwright spec in `e2e/`**, plus `renderToStaticMarkup` cases for the
  new summary sentences, because a wrong count in a collapsed summary is the one new failure mode
  all four options introduce.

## Scale of the change, for comparison

Bar length is proportional to rendered height on a repair round 6 run.

- Review worklist: short
- Repair delivery (6 packets): very long
- Image evidence (0 images): short
- Evidence readiness (6 claims): long
- Captured intent and evidence: long

## Option A: tabs under Review worklist

Review worklist keeps its section and becomes the first and default tab on a `.workflow-tabs` bar.
Deliveries, Evidence and Intent become three sibling tabs. Each non-default pane is rewritten from
a stack of cards into a ledger:

- **Deliveries** becomes a four-stat strip (delivered, refused, uncertain, newest) over a table of
  one row per packet: round, kind, state chip, delivered time, payload hash, and a "Show packet"
  disclosure that expands the payload inside the row. Filtered to the viewed round, with a
  "Show all rounds" escape.
- **Evidence** merges Image evidence and Evidence readiness into one pane. A four-stat strip
  (readiness status, author claims, unlinked, images) sits over one compact row per frozen claim
  with a status dot and its execution artifacts. Canonical reconciliation and the image ledger are
  disclosures inside this pane rather than separate sections.
- **Intent** leads with the refined goal, then collapsed disclosures for the original goal, human
  decisions, acceptance criteria and constraints, with the snapshot facts as a chip row.

Tab labels carry counts, and an amber badge when the tab holds something blocking, so an unvisited
tab still reports. The selected pane is part of the route, so a link to a run can open on Evidence,
and changing rounds preserves the pane.

**Why:** one place to look, and the page below the worklist stops existing. Reuses `.workflow-tabs`,
already in the app.

**Costs:** three panes are invisible until clicked. The worklist already has an internal rail and a
segment control, so a tab bar above it is a second layer of navigation in the same section.
Screenshotting a whole run for a pull request now needs an expand-all.

## Option B: a persistent round record rail

The run body becomes two columns. The worklist gets the left column at full height and never moves.
The three sections collapse into a docked right rail with its own scrollport, showing one of
Deliveries, Evidence or Intent at a time via a segmented control, with the round's verdict stated in
the rail header. Selecting a reviewer in the worklist can point the rail at what that reviewer was
given: its delivered packet, the claims it read, the intent it judged against. Below a width
threshold the rail moves under the worklist and becomes Option A's tab bar, so there is one
behaviour to learn.

**Why:** nothing is hidden, because the rail always shows one of the three and the worklist never
scrolls past it. Cross-reading a verdict against the packet that produced it becomes possible for
the first time. Wide screens finally carry content instead of margin.

**Costs:** the most build of the four. A two-column run body is new layout, and the narrow fallback
is Option A anyway, so this is A plus a rail. The rail introduces a second scroll region, and long
payloads still need an overlay to be readable in it. On a laptop the worklist column narrows, and
the worklist is the primary object on the page.

## Option C: one Round record section with rows that expand in place

No new navigation. The three sections merge into a single "Round record" section holding three
collapsed rows. Each row's closed state is a full sentence carrying the counts and a status chip:

- *Deliveries - All 6 packets reached the session. Newest 1:17:32 PM, nothing refused.* `delivered`
- *Evidence - 6 frozen author claims, 5 linked, 1 with no canonical match. No images attached.* `1 gap`
- *Intent - Phase 3 evidence carry-forward. Compacted, 1 human decision, HEAD 4f1c9ab clean.* `captured`

Reading the page top to bottom answers all three questions without opening anything. Opening a row
expands it in place. Rows default to collapsed, except one that is blocking, which opens itself.

**Why:** the smallest change and the least new concept. The page still reads top to bottom, closed
rows still answer the question, and printing or screenshotting a run for a pull request still works
by expanding rows.

**Costs:** expanding two rows puts you straight back into a long scroll. There is no cross-reading:
a delivery and the claims it argues about cannot be on screen together. It is the least ambitious of
the four, and defers the raw-payload problem rather than solving it.

## Option D: a round dossier, with raw material in a full-screen reader

The three sections stop being sections. What survives on the page is one three-column dossier
*above* the worklist, carrying only what changes a decision: the refined goal with its decision
count and snapshot facts; the readiness verdict with linked-claim counts and the named gap; the
delivery state counts with the newest packet and conversation. Each column ends in one link.

Every raw payload leaves the page entirely: repair packets, the original prompt, the image ledger,
the reconciliation table and the snapshot facts all live in a full-screen reader with its own left
nav, keyboard next and previous, and a close that returns you to your scroll position. The run page
becomes short by construction and cannot regrow, because raw text no longer has anywhere on it to
be printed.

**Why:** it fixes the actual cause. Raw payloads are what make the page eleven screens, and they
leave. The dossier reads as one sentence per column, the fastest scan of the four. A full-width
reader with its own nav is a better place to read a 2,000-word repair packet than a page section
ever was.

**Costs:** the biggest behavioural change; everything raw is now two clicks away, and some of it is
glanced at in place today. It adds a new full-screen surface to build, route and keep accessible.
The dossier's summaries are derived values, and every derived value is a new thing that can be
wrong or stale.

## Recommendation

**Option A**, with two borrowings. It is the approach that was asked for, it is the cheapest of the
three that actually shorten the page, and it reuses a tab component the app already ships. From C,
take the summary sentence: each tab label carries counts and an amber badge so an unvisited pane
still reports, which is the one real weakness of tabs. From D, take the ledger-plus-disclosure
treatment of payloads, so the Deliveries pane is a table of six rows rather than a stack of six
cards even before anything is expanded.

Option B is the better end state on a wide monitor but is Option A plus a rail, so it is reachable
later from A without rework. Option D is the most correct diagnosis and the largest build; it is
worth choosing deliberately, not by default.

## Non-goals

- No change to what the daemon stores, to `WorkflowContextSnapshotSchema`, to delivery records, or
  to any wire contract in `src/shared/`. This is a rendering change over data that already arrives.
- No change to the Review worklist's own internals: its rail, segment control, change detail pane
  and Persona directive controls are untouched.
- No change to evidence readiness policy, delivery retry semantics, or override recording.

## Verification

- A Playwright spec in `e2e/` covering: the default surface on load, reaching each of the three
  consolidated surfaces, a blocking delivery or readiness state being visible without a click, the
  counts on the labels, and one action (retry or override) still reaching its route from its new
  home.
- `expectContentClearsBorder` from `e2e/fixtures/modal-inset.ts` for any new modal or reader.
- `renderToStaticMarkup` cases for the summary sentences and counts.
- Electron geometry coverage only if a fixed-height scrollport is introduced, which applies to
  Options B and D.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke`, `npm run test:e2e`.

## Mockups

Four interactive mockups are in `docs/plans/workflow-run-detail-consolidation/mockups.html`, styled
with the app's own tokens and populated with data from a real repair round 6 run. Open that file
directly to click through Option A's tabs and Option B's rail segments.
