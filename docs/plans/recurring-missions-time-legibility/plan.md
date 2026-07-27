# Recurring Missions: make the surface about time

A design review of the Recurring Missions overlay (`RecurringMissionsPanel` and the five
components under `src/web/components/schedules/`) against the `frontend-design` skill, plus
three alternative directions for the part that most needs the work.

Reviewed at commit `35c27a2`, driven live at `localhost:5173` against the running daemon with
one real schedule ("UI Review", daily at 00:40 America/New_York). Every defect below was
observed in the running app, not read off the diff.

> **Decision (adopted, built).** Direction **A - The Spine**, plus all eight concrete
> defects and the shared work. B and C were not taken; B's cadence band remains the best
> standing idea for the editor, and C is still worth a separate prototype. The alternatives
> below are kept as the record of what was considered, not as open questions.

## What is already right

Worth stating, because the alternatives below must not break it.

- **The daemon owns every judgement and the UI reads it.** Health, the next instant, policy
  outcomes, runnability - all server words. The panel paints tone and nothing else.
- **`null` is handled as a real answer, not a stub.** An unreadable schedule renders an
  honest banner, Resume is disabled with a sentence explaining why, and Pause stays live.
  That is the schedule store's `T | null` contract surfacing correctly.
- **The copy is unusually careful about consequence.** "Files this mission's work now as a
  backlog task - it does not run an agent" is exactly the sentence an operator needs.
- **The quality floor holds.** It stacks to a single column at 700px without breaking, every
  mutation disables its own control in flight, the discard confirmation traps focus, and the
  overlay owns its Escape through the shared registry.

## The core finding

**Recurring Missions is a product about time, and its UI never draws time.**

Every temporal fact is a string. On the detail pane a single instant is printed five separate
ways - as the hero sentence "Monday, July 27 at 12:40 AM EDT", then again as `CADENCE`, again
as `EXACT CRON`, again as `TIME ZONE`, and a fifth time as `NEXT (UTC)`. Nowhere does the
surface show the one thing that makes a recurring mission a recurring mission: **its rhythm**.
You cannot see, anywhere in this feature, that this mission fires every night just after
midnight. You can only read that it does, four times, in four notations.

The `frontend-design` skill asks that the hero be a thesis - "the most characteristic thing in
the subject's world." For a scheduler that is the beat. The current hero is a date in a purple
box, which is the templated answer: a big value with a small eyebrow label above it.

There is a second characteristic thing here, and it is genuinely unusual. Most schedulers
promise wall-clock execution. **This one honestly cannot**, because it runs on a laptop that
sleeps, and it says so: "durable local catch-up · best effort". That honesty is the feature's
real character, and it is currently a paragraph of 10.5px body text in a grey box with a moon
glyph, sitting below the fold. The one structural fact that distinguishes this product from
cron is rendered as a disclaimer.

**The gap is the story.** A timeline that shows the beat *and* shows where the beat broke
because the machine was asleep is the design this feature has been describing in prose all
along.

## Structural findings

### 1. The layout is inverted

`.rm-catalog-layout` is `minmax(0, 1.15fr) minmax(0, 0.85fr)` - the list gets *more* width
than the detail. But a list row holds four short cells, while the detail holds an eleven-row
definition list that overflows its pane and scrolls. With one schedule configured, roughly
700px of the left column is empty while the right column scrolls. The proportions are backwards
for every fleet size a single operator will have.

### 2. The detail is an undifferentiated key-value dump

Eleven `dt`/`dd` pairs, all at 10-11px, all in a 118px label column, all weighted identically.
`TASK INTENT` - the actual mission, the sentence describing what an agent will spend an hour
doing - has exactly the same visual weight as `NEXT (UTC)`, a derived restatement of a value
printed 200px above it. Structure is supposed to encode what is true about the content; here
it encodes only "these are all fields."

### 3. Preview and History each spend a full screen on a small table

`Occurrence preview` and `Run history` are separate `Screen` routes that replace the catalog
entirely. History with one occurrence renders one table row and roughly 85% dead space. Both
are answers to questions about the *same* schedule the operator was just looking at, and both
force a round trip back through "← Catalog" to compare against the configuration.

### 4. The operator's own time zone is the least legible thing on screen

In `SchedulePreview`, `.rm-occurrence-time` - the local wall-clock instant, the only one a
human reasons in - is set at `10px var(--mono)` in `--dim`, the bottom of the text ramp. The
UTC restatement beside it is 10.5px in `--muted`. The local time is literally the smallest,
dimmest thing in the row.

`ScheduleHistory` does the same thing harder: the primary "Scheduled for" column leads with
`2026-07-26T04:40:00.000Z` and demotes the human answer to a secondary line prefixed
"Current zone (America/New_York):". An audit trail should keep UTC, but not as the headline.

### 5. Four names for one feature

The topbar button says **Missions**. The eyebrow says **Recurring Missions**. The heading says
**Scheduled Catalog**. The screens are **Occurrence preview** and **Run history**. The plan
directory says `recurring-missions`; the API says `schedules`. "An action keeps the same name
through the whole flow" is the rule being broken, and the vocabulary of an interface is how
someone learns their way around it.

### 6. Three separate paragraphs explain the same mechanic

"Every occurrence creates an ordinary backlog task from this immutable revision" (editor),
"Will create a normal backlog task. Foreman may dispatch it only after..." (detail), "Files
this mission's work now as a backlog task - it does not run an agent" (Run now tooltip). Each
is well written. Together they are the interface saying one thing three times because no
structural element carries it.

## Concrete defects

Each was reproduced in the running app.

| # | Where | What |
|---|---|---|
| 1 | `RecurringMissionsPanel.tsx:112` | `headingRef.current?.focus()` on mount puts a full-width browser focus ring across the `h2`. Verified live: `h2.matches(':focus-visible') === true`, computed outline `rgb(153, 200, 255) auto 1px`, `display: block`. A blue rectangle spans the panel on every open and every screen change. |
| 2 | `styles.css:13850` | `.rm-editor-foot` is `position: sticky` with `background: color-mix(in oklab, var(--panel) 92%, transparent)`. The form scrolls behind it and ghosts through - the "Repeats" select and time input are visible under the footer text. |
| 3 | `ScheduleCatalog.tsx:158` | `last: {last.status}` prints the raw enum (`last: created`). `occurrenceStatusView()` exists and `ScheduleDetail.tsx:234` already uses it. Two spellings of one fact. |
| 4 | `ScheduleCatalog.tsx:148` | `{schedule.executionMode ?? "unreadable"}` prints the raw enum `local-catchup`, which truncates mid-word to `local-catc…` at default width and `local-…` at 700px. Execution mode is also not per-row information yet - every schedule has the same one in V1. |
| 5 | `ScheduleCatalog.tsx:163` | `{schedule.health}` prints the raw lowercase enum in the pill. |
| 6 | `ScheduleCatalog.tsx:130` | `<button role="listitem">` inside `role="list"`. The explicit role *replaces* the implicit button role, so assistive tech announces a list item with no indication it is activatable. The row is the primary navigation control of the catalog. |
| 7 | `styles.css:13958` | `.rm-occurrence-list` is `max-height: 320px; overflow: auto` inside a sticky aside, so the preview clips mid-row with no visible scroll affordance - it reads as a rendering fault rather than a scroll region. |
| 8 | `ScheduleEditor.tsx:311` | `hint={`${repos.length} in workspace`}` renders as "Repository 202 in workspace", which parses as the repository being named 202. |

## Design direction

This is an in-app surface inside a locked design system, not a marketing page. `styles.css`
declares its tokens once and `CLAUDE.md` forbids naming a vendor or inventing a hue in it. So
the distinctiveness here has to come from **form and structure**, not from a new palette, and
saying that plainly is more honest than inventing a fifth accent to look bold.

**Color - give the existing accent a meaning it does not currently have.** `--purple` is
sprayed across this surface with no semantics: the eyebrow, the row icon, the selected row,
the segmented control, the next-run box, and the preview node are all purple, so purple means
"recurring missions" and nothing more. Proposal: on the time axis, **purple means future**,
`--muted` means past, and `--attention` appears in exactly one place - where the beat broke.
That makes the sleep gap the only warm thing on the surface, which is the correct emphasis.

**Type - mono earns a job.** `--mono` currently marks the cron expression, the ISO instant,
the repo path, and both columns of the preview, which is close to "mono means data." Proposal:
mono is reserved for **instants and expressions**, set with `font-variant-numeric: tabular-nums`
in a left-aligned column, so times stack into a scannable rail. That single change is most of
what makes a timeline readable. Prose stays in the UI face at the existing ramp.

**Signature.** Each alternative below names its own, and each is a single element the surface
is remembered by. The rest stays quiet.

## Three alternatives

All three are scoped to the *reading* surfaces (catalog, detail, preview, history). None
changes the schedule store, the four scheduler modules, the claim transaction, or the
`TaskManager.create` internal door. All three carry the same defect fixes.

### A - The Spine

One continuous vertical time rail through the detail pane. `NOW` is a bright divider; past
occurrences sit above it in `--muted` carrying their real outcomes, future occurrences below in
`--purple` as hollow nodes. **Where the daemon was not running, the rail breaks** - a dashed
segment with a moon marker and "Mission Control was not running · 7h 20m", and any coalesced
instants shown as ghosted nodes inside the break.

This merges Detail, Preview and History into one artifact: scroll up through what happened,
scroll down through what will. The eleven-row `dl` collapses into a compact identity strip
(name, one-sentence cadence, repo, agent) plus a "Configuration" disclosure holding cron,
timezone, policies and defaults. The list narrows to a 260px rail.

- **Signature**: the literal break in the rail where the laptop slept.
- **Fixes**: findings 1, 2, 3, 4 (the "occurrence creates a task" mechanic becomes a node
  label instead of three paragraphs), and defect 7.
- **Cost**: medium. Two `Screen` routes deleted; history's paginated read moves inline behind
  "Load older". No new server route - it composes the existing catalog `lastOccurrence`, the
  history page read, and the preview POST onto one axis.
- **Risk**: the sleep-gap rendering needs a source for "when was the daemon down." Occurrence
  `delayMs` and `triggerKind` imply it but do not state it; if that inference is not sound the
  break degrades to a plain "n missed" node, which is still better than today.

### B - The Beat

Keep the list/detail split, but replace the hero and the top four `dl` rows with a **cadence
band**: a horizontal strip of the coming week with a tick at every fire instant, a live `now`
cursor, past ticks filled and future ticks hollow. Below it, one sentence in the UI face:
"Every day at 12:40 AM - America/New_York (EDT, UTC-4)." That single element replaces `CADENCE`,
`EXACT CRON`, `TIME ZONE` and `NEXT (UTC)`; the cron expression moves behind an "Advanced"
disclosure where the operator who wants it can still copy it.

The same component becomes the **editor's control**. In `ScheduleEditor` the band sits where
the preview rail is now, and clicking a slot sets the time - so the thing you edit and the
thing you read are one visual, and the cadence preview stops being 900px below the cadence
fields.

- **Signature**: the band that is simultaneously the readout and the control.
- **Fixes**: findings 1, 2, 4, 6; the editor's biggest usability problem (cadence controls and
  cadence preview are not co-visible); and defects 1, 2, 7, 8.
- **Cost**: medium-low for the read side, medium for the editor control. Preview and History
  stay as they are, cleaned up.
- **Risk**: a band is honest for daily / weekdays / weekly and awkward for monthly and for
  arbitrary `advanced` cron. Needs a declared fallback - a compact "next 5 instants" list -
  rather than a band that lies about an expression it cannot draw.

### C - Tonight

Reframe the overlay's default screen. Instead of "a list of schedules," open on **what this
laptop is about to do**: one merged, time-ordered agenda of upcoming occurrences across every
mission, grouped by day (Tonight, Tomorrow, Wednesday...), each row naming its mission. Away
and sleep windows shade across it. A mission becomes a *filter* on the agenda rather than a
container for it; selecting one narrows the agenda and opens its configuration in a drawer.

This answers the question an operator actually opens this panel with. It also gives the empty
state something to say: "Nothing scheduled. Your laptop is free tonight."

- **Signature**: the merged agenda with the sleep window shaded across it.
- **Fixes**: findings 1, 2, 3, 5 (screens become sections of one board), 6.
- **Cost**: high. It changes the overlay's information model, and it needs upcoming instants
  for *all* schedules at once. `POST /api/schedules/preview` is per-definition, so this is
  either N calls on open or a new merged-upcoming route on the daemon - a real server change
  this review has not scoped.
- **Risk**: highest. It is the direction with the most product upside and the least certainty,
  and it partly duplicates the Sitrep's "what is happening" job. Worth prototyping before
  committing.

## Shared work, whichever direction is chosen

The defect table above, plus:

1. **One vocabulary.** Pick "Recurring missions" and use it in the topbar, the eyebrow, the
   heading and the plan docs. Screens become "Schedule", "Upcoming", "History" - nouns for
   places, not two different words for a run.
2. **Local time wins.** In `SchedulePreview` and `ScheduleHistory`, the operator's zone is the
   primary line at the top of the text ramp; UTC is the secondary audit line in mono. This is
   an inversion of two CSS rules and one JSX order, not a rewrite.
3. **Detail weight.** `TASK INTENT` stops being a `dd`. It is the mission; it gets prose
   treatment at readable size, and the derived restatements (`NEXT (UTC)`, and `EXACT CRON`
   unless the operator opens Advanced) come out of the primary column.
4. **`.rm-catalog-layout` proportions invert** to give the detail the larger share.

## Recommendation

**A, then the shared work, and prototype C separately.**

A is the direction that comes from the subject rather than from a layout catalogue: it draws
the beat, and it draws the break in the beat, which is the one structural fact that makes this
feature different from cron. It also does the most consolidation for the least new machinery -
three screens become one, and no server route changes.

B is the strongest *editor* idea in this review and its band is a genuinely good control, but
as a read surface it improves the hero without addressing the dead space, the split screens, or
the dump below it. Its editor half is worth taking regardless of which read direction wins.

C is the most interesting product question and the least certain design. It should not be
bundled with a visual cleanup; it deserves its own investigation, including whether it overlaps
the Sitrep.
