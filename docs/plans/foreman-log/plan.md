# Plan: Foreman log

Status: implemented (all five phases)
Owner: ai-harness
Related: `ForemanNote` (`src/web/components/ForemanNote.tsx`), which showed the one note that
used to exist and now serves the grid card only. This makes notes durable, puts them in the
conversation, and reduces the console's always-on block to a single line.

## Goal

Three things, in one feature, because they share one missing record:

1. **The Foreman card stops covering the chat window.** Today it is an uncapped block pinned
   above the transcript; a long escalation fills the pane (see the screenshot that started this).
2. **Foreman speaks in the live chat**, as a turn in the conversation at the point it spoke,
   rather than as furniture above it.
3. **Every Foreman note is reviewable afterwards, with its context** - the question the agent
   was blocked on, what Foreman concluded, and what was actually sent back.

## Why this shape

The card conflates a **record** ("here is what Foreman concluded") with an **action** ("you need
to decide"), and pins both. Those two have opposite layout needs: a record wants to be as long as
it needs to be and to scroll away; an action wants to be tiny and never move. Welded together and
pinned, the record's length is inflicted on the action's position.

So: the record goes into the transcript at full length, and the action becomes a one-line strip
above the composer. The strip cannot eat the window because the prose is not in it.

### The record does not exist yet

`session_notes` is `note_key TEXT PRIMARY KEY`, upserted (`db.ts:120`, `db.ts:763`). There is one
row per session, ever. Every Foreman write destroys the previous one, and `approve()` /
`dismiss()` explicitly null `recommendation` and `brief` (`ForemanNote.tsx:88-93`, `:101-106`).
There is no history to show, and the moment the human acts, the text that was sent is erased.

### The question is *more* ephemeral than the note

For a terminal ask - a permission prompt, an `AskUserQuestion` menu - the question exists in
exactly one place: the pane capture at `worker.ts:624`. `prompt.ts:36-48` says so outright: Claude
appends the assistant turn only when the tool call *completes*, so a blocked dialog is **not in the
transcript**. The pane is read once, handed to the model, and discarded.

This is what forces the ordering below. Everything else here can be built later against data that
still exists. The pane cannot: every tick that runs without capturing it loses that episode's
question permanently.

### What Foreman already computes and throws away

All of it is live in memory at `worker.ts:642-684`, at the moment the note is written:

| Value | Where it is | Fate today |
| --- | --- | --- |
| `pending.question` | `classifyPending`, `pending.ts:143` | discarded |
| `pending.marker` | same | sent as `handledMarker` - **already a stable episode id** |
| `pending.situation` | same | discarded |
| `pane` | `paneFor`, `worker.ts:624` | discarded |
| `ctx.menu` (`PaneDialog`) | `parsePaneDialog`, `worker.ts:635` | discarded |
| `verdict.classification` | `VerdictSchema`, `verdict.ts:78` | branches `autoApproveAccess`, then discarded |
| `verdict.confidence` | `verdict.ts:92` | Tier 2 never reads it |
| `decision.tier` | `worker.ts:644` | log line only |
| `plan.send.text` / `.option` | `verdict.ts:265-271` | delivered, then discarded |

`marker` is the important one: episode identity costs nothing, because it is already computed and
already sent over the wire.

### Why an episode table, not columns on `session_notes`

`session_notes` is a **current state** row with one `disposition` and one `updated_at` meaning
"what Foreman decided, and when".
An append-only history has a different cardinality, a different key, and a different retention
rule. Sharing the row would corrupt both, and `CREATE TABLE IF NOT EXISTS` gives a new table a free
upgrade path where new columns would need ALTERs.

`session_notes` stays exactly as it is - the live pointer. Nothing that reads it changes.

## Schema

```sql
CREATE TABLE IF NOT EXISTS foreman_episodes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  note_key       TEXT NOT NULL,     -- noteKeyFor(session): same key as session_notes
  session_id     TEXT NOT NULL,     -- provenance only, never joined on (ids re-mint)
  marker         TEXT NOT NULL,     -- Pending.marker: this waiting episode's identity
  situation      TEXT NOT NULL,     -- PendingSituation
  surface        TEXT NOT NULL,     -- input-review | terminal
  question       TEXT NOT NULL,     -- the ask, verbatim
  pane           TEXT,              -- the child's screen at decision time (terminal only)
  menu           TEXT,              -- JSON PaneDialog: the rows the model chose among
  review_id      TEXT,              -- reviews.id when the ask arrived as a review
  purpose        TEXT,
  brief          TEXT,
  recommendation TEXT,
  classification TEXT,
  confidence     REAL,
  tier           INTEGER,
  disposition    TEXT NOT NULL,
  last_action    TEXT,
  sent_text      TEXT,              -- what was actually delivered
  sent_option    TEXT,              -- JSON {number,label} for a menu selection
  sent_by        TEXT,              -- foreman | you: who authored what was delivered
  created_at     INTEGER NOT NULL,
  resolved_at    INTEGER,
  resolved_by    TEXT               -- foreman | you: who DECIDED it (see below)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_foreman_episodes_marker
  ON foreman_episodes(note_key, marker);
CREATE INDEX IF NOT EXISTS idx_foreman_episodes_key
  ON foreman_episodes(note_key, created_at DESC);
```

The unique index on `(note_key, marker)` is what makes the write idempotent: the worker's own
idempotency check already refuses to re-handle a marker, and a human's later Approve updates that
same row rather than appending a second one.

`pane` is stored **only when the surface is terminal**. An `input` review's question is already
durable in `reviews.body`, and storing a screen capture for it would be a second copy that can
drift.

Retention is **30 days**. An episode row can carry a whole pane capture, so it is the fattest of
the aged tables, and the drawer is read for recent judgment rather than for a branch that may sit
open for months. `pane` is capped at 16k bytes on write for the same reason.

## Phases

### Phase 1 - capture (no UI)

The only lossy-in-one-direction step. Worth landing alone.

- `foreman_episodes` table + `recordEpisode` / `listEpisodes` / `resolveEpisode` in `db.ts`.
- `RecordEpisodeSchema` in `protocol.ts`.
- `POST /api/sessions/:id/foreman-episode` and `GET /api/sessions/:id/foreman-episodes` in
  `routes.ts`; `recordEpisode` on `ForemanClient`.
- `processSession` (`worker.ts:684`) records the episode after `applyVerdict` resolves. Everything
  it needs is already in scope: `pending`, `ctx`, `pane`, `decision.verdict`, `decision.tier`,
  `plan`.

Recorded **after** `applyVerdict`, not before, so `sent_text` reflects what was actually delivered.
A failed send throws out of `applyVerdict` and writes no episode, matching how it already writes no
`answered` note - a send that did not land is not an episode that happened.

### Phase 2 - stop erasing on Approve

`ForemanNote.approve()` nulls `recommendation` and `brief`. With Phase 1 in place the episode row
already holds Foreman's text, but not the human's act. Add `api.resolveEpisode(sessionId, {marker,
disposition, sentText})`, called before `setNote`, stamping `resolved_by: "you"`, `sent_text`
and `resolved_at`. Same for `dismiss()`, with no `sent_text`. Authorship is *derived* server-side
rather than passed: the dashboard says what it did, and `resolveEpisode` reads `sent_by` off
whether anything was actually sent (see the `resolved_by` note below).

The `setNote` nulling stays: `session_notes` is current state, and after you answer, there is no
current recommendation. The record lives in the episode now.

### Phase 3 - notes in the transcript

`TranscriptMessage` carries `ts` (`types.ts:1009`), so episodes merge into the stream by timestamp.

- `ConsoleDetail` passes the session's episodes to `TranscriptPanel`.
- `TranscriptPanel` merges them into its rendered rows by `created_at`, rendering each as a
  `ForemanNote`-styled block at full length, no clamp.
- Episodes with `created_at === 0` (shouldn't happen; defensive) sort last rather than first.

### Phase 4 - the strip

`ForemanStrip.tsx` replaces `ForemanNote` in `ConsoleDetail`'s leading block: one line, badge +
disposition + one-line purpose + `Approve & send` + a chevron. Expanding reveals the
recommendation and the actions; a "Jump to note in chat" scrolls the transcript to the inline
entry.

Rendered **only** for `escalated` and `pending`. On `answered` / `skipped` it unmounts entirely -
the inline entry is the whole story, and nothing is owed.

The grid card (`SessionCard.tsx:389`) keeps the full `ForemanNote`: it has no transcript to inline
into, and its `max-height: 30%` cap (`styles.css:2559`) already bounds it there.

### Phase 5 - the drawer

`ForemanDrawer.tsx`, opened from a rail on the right edge of the detail pane, dot = unanswered
count.

- **List**: episodes newest-first, each row leading with the *question* (two-line clamp), then the
  verdict. Live episode amber, answered green, skipped neutral.
- **Detail**: the ask verbatim (monospace - for a terminal episode the `❯` marker and column
  alignment are load-bearing), with the sent row marked; then purpose + brief; then the resolution
  with `sent_by` and `sent_text`. Metadata chips: situation, classification, confidence, tier.

A rail rather than a fifth tab: Work queue / Gate / Diff are things the session *has*; Foreman is
an observer talking *about* the session.

## Learned while building

**Two extractions the plan didn't anticipate, both forced by testability.**
`worker.ts` calls `main()` at import, so anything left inline in `processSession` can
never be unit-tested - which is exactly wrong for a mapping that decides what survives an
unrepeatable act. `episodeFromPlan` (`verdict.ts`) is now pure, beside `planFromVerdict`,
the same move `pending.ts` documents making for the same reason. Likewise
`closeForemanNote` (`web/lib/foreman.ts`): `ForemanNote` and `ForemanStrip` had the
record-then-clear sequence written out twice, two copies of an ordering constraint that
is invisible unless you know why it exists.

**Writing that test found a real bug.** The episode recorded `verdict.recommendation`
while the note records the *resolved* one, and for a draft those are different strings -
an escalation recommends `verdict.recommendation`, a draft recommends the `answer.text`
it would have sent. The record would have shown a recommendation the human was never
shown, beside a purpose and brief that were. It now reads `plan.note.recommendation`.
The `brief` deliberately still comes from the verdict: the plan nulls it on the paths
where it stops being live, and outliving that is the whole point of the table.

Three more the plan had wrong or missing, found by driving the real UI:

**An unavailable transcript hid the episodes entirely.** `TranscriptPanel` returns early
with the reason line when the stream reports `unavailable`, so the merge below it never ran.
That is exactly backwards: a session whose JSONL can't be resolved is the one where
Foreman's record is the *only* account of what happened. The reason line now renders
*above* the episodes rather than instead of them.

**`answered` doesn't say who answered.** The note's label is "answered for you", which is
true because only Foreman ever writes a note. An episode outlives that: an escalation you
approve also ends up `answered`, and the note's wording then credits Foreman with your
decision. `episodeLabel` reads the author, not the disposition alone.

**And the author is two facts, not one.** Reading it off `sent_by` was the obvious move and
was wrong: a **dismissal** resolves an episode without delivering a word, so `sent_by` is null
on exactly the paths where a human still made the call - and the card then read "You approved"
above a header saying you had dismissed it. `resolved_by` (who decided) is therefore split
from `sent_by` (who authored what reached the child), added by an `addColumn` migration rather
than by the `CREATE TABLE` alone, because the table already existed on the dbs this was built
against.

**Every naive source for a row's preview is wrong on a terminal ask.** `question` is the
notification line ("Claude needs your permission to use Bash"), identical on every such row;
the menu rows are the choices, not the question; the pane is mostly scrollback. What a
reader remembers is the sentence *between* the permission header and the first numbered row,
so `askPreview` reaches for that first. This is what turns a row from "a decision was
needed" into "rm -rf node_modules/.vite".

Picking *which* sentence took a second pass. Position doesn't work from either end: a Claude
dialog opens with a short chip naming the tool ("Bash command") and closes with a generic
confirmation ("Do you want to proceed?"), and choosing the nearest paragraph or the furthest
gets two of the three verbatim captures in `foreman-pane-dialog.test.ts` wrong. `panePrompt`
takes the **longest** paragraph above the option rows instead - the substantive line is the
one with something to say - capped at four paragraphs so scrollback isn't weighed as dialog.

## Testing

- `test/foreman-episodes.test.ts` - the DB layer: append, the `(note_key, marker)` upsert, list
  ordering, the sweep.
- `test/foreman-episode-capture.test.ts` - `processSession` records the pane, menu and verdict
  fields for a terminal ask; records `review_id` and no pane for an input review; records nothing
  when the send throws.
- `test/foreman-note.test.ts` - `closeForemanNote`: `resolveEpisode` fires before `setNote`, and
  a note with no marker skips it rather than failing the human's decision.
- `test/foreman-episode-resolution.test.ts` - a dismissal stamps `resolved_by` without inventing
  a `sent_by`, which is the bug the split was made for.
- `test/foreman-episode-merge.test.ts` - the merge ordering in `TranscriptPanel`.
- `test/foreman-episode-preview.test.ts` - `askPreview` against the verbatim captures in
  `test/fixtures/claude-panes.ts`.

## Open risks

- **Pane size.** A capture is a full screen; at one row per episode this is bounded by the sweep,
  but worth watching. **Resolved:** capped at 16k bytes on write, and the sweep is 30 days.
- **`/clear` re-mints `note_key`**, orphaning an episode history the same way it orphans a note.
  Acceptable for now - the drawer is session-scoped, and a cleared session is a new session.
- **Fleet-wide view** is the obvious next step once episodes are durable (same list, unfiltered by
  session). Deliberately out of scope here.
