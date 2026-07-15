# Foreman attribution - putting a byline on the fix log's reply

Status: backlog / designed, not started
Owner: ai-harness (Agent Wrangler)
Related: `docs/plans/no-mistakes-log/plan.md` (the fix log, which this completes - it defers
this as "phase 3"), PR #48 `mancej/foreman-sees-nomistakes-gates` (the integration this was
blocked on; now merged).

Code to read first: `src/server/nomistakes-fixes.ts` (the git-to-rounds join),
`src/web/components/NomistakesFixLog.tsx` (the card UI and its three lanes),
`src/server/foreman/pending.ts` (`classifyPending`, the gate marker, `findingsDigest`),
`src/server/foreman/verdict.ts` (`applyVerdict`, where a send would be logged).

The no-mistakes fix log shows, per fix, the findings that justified it and **the reply that
authorized it**. This doc is about the one thing it can't say: *who wrote that reply.*

## The goal

### What the fix log is (the thing this completes)

A session card can be gated by no-mistakes, and while a run is live the card carries a strip
showing the pipeline's progress. The **fix log** is a separate, quieter section beneath it: a
record of every fix no-mistakes actually *committed* on that session's branch. Collapsed it is
one row (`◇ fixed by no-mistakes · review 5 · document 3 · 8`); opened it is a bounded,
scrollable list - capped at 208px so the card's height is constant however many fixes land.
Clicking a fix expands, in place, a three-part narrative:

1. **no-mistakes found** - the findings that justified the fix: severity, `file:line`, and the
   pipeline's own reasoning, verbatim (these run 500-900 chars, clamped to 3 lines).
2. **replied / auto-fixed** - whether a human answered the gate or the pipeline fixed it under
   its own round limit, and if someone replied, *the text of that reply*.
3. **changed** - the sha, the diffstat, the files, and a **View diff** that opens the existing
   `DiffViewer` scoped to that one commit.

It is a join over data that already exists, not new recording: every fix self-commits as
`no-mistakes(<step>): <summary>`, so **git is the list of fixes**; no-mistakes' own
`step_rounds` table holds the findings and the reply, keyed by a `fix_summary` that is
character-for-character the commit subject. It is driven *from git*, so a fix with no matching
round still lists (just without the why), and it needs no reset bookkeeping - resetting a
session hard-resets to origin, which destroys the fix commits, so the log empties itself.

### Why it exists

The card already showed a findings tally like `2 awaiting, 20 auto-fix`, and that number
answers nothing you actually want to know. It doesn't survive the run (a fix round overwrites
`step_results.findings_json`, so a finding vanishes the moment it's fixed), and it never tells
you what those 20 fixes *did*. The ask was a log of fixes attributed to no-mistakes for a
single session, cleared when the session is reset - then, specifically, the reasoning
no-mistakes gave for each fix, plus the text a human or the foreman sent in response.

The underlying purpose: **a finished run stops being interesting to watch at exactly the moment
it starts being interesting to review.** The strip is for watching. The fix log is for
reviewing - for answering "the pipeline changed 493 lines across 11 files in my branch; why,
and who told it to?" without leaving the dashboard.

### What attribution adds

Everything above ships. Parts 1 and 3 of the narrative are complete, and part 2 is *half*
complete: the reply text is shown, but the card can only say **that** someone replied, never
**who**. Attribution finishes part 2 by turning one lane into three - *you typed this*, *the
foreman said this*, *the pipeline decided alone* - and by surfacing the foreman's own words
next to the reply they caused.

That matters because the foreman is an autonomous actor in this fleet. It answers blocked
sessions on your behalf, and once it can answer no-mistakes gates (PR #48), it can cause code
to change on your branch without you in the loop. The fix log is where you'd find that out. A
lane that says `replied` for both *"you decided this"* and *"a bot decided this while you were
away"* is the one place that distinction most needs to be visible.

## The problem

The reply is already on the card. Only the byline is missing.

When a no-mistakes gate parks, someone answers it with
`axi respond --action fix --instructions "<text>"`. That text is merged onto each selected
finding as `user_instructions`, and the fix log reads it back out and shows it verbatim. What
no-mistakes records about its origin is exactly one bit:

```
step_rounds.selection_source = 'user' | 'auto_fix'
```

`user` means *somebody answered*. It never means *who*. There are three somebodies:

1. **You**, typing in the dashboard's Fix box (`NomistakesStrip` → `POST /nomistakes/respond`
   → `respond()` in `nomistakes.ts`, which passes `--instructions`).
2. **The agent**, driving its own gate via the `/no-mistakes` skill - the common case. Live
   data is full of it: *"The user decided both ask-user findings. Apply all twenty-two."* is
   the agent relaying a decision you made in chat.
3. **The foreman**, which never touches no-mistakes at all.

That third one is the interesting one, and it is indirect. **The foreman does not answer
gates.** It classifies a parked gate as a `gate-parked` pending situation, then *types into
the session's pane* (`applyVerdict` → `sendText`); the agent reads that, decides, and runs
`axi respond` itself. So a foreman-caused reply is **already showing on the card today** - it
just reads `replied`, with the agent's phrasing, and nothing connects it back to the nudge
that caused it.

So the feature is: label the lane, and show the foreman's own text alongside the reply it
produced.

## Why it wasn't built with the fix log

Two reasons, one of which is now gone.

- **The key didn't exist.** Before PR #48 the foreman had no notion of a no-mistakes gate,
  so a fix and a foreman send shared nothing but a timestamp. Attribution would have been
  proximity-guessing: a send at 14:03 and a fix at 14:05 are *probably* related, and
  "probably" is the whole feature. **PR #48 fixed this** - see below.
- **The foreman's text still isn't recorded.** This is still true and is the bulk of the
  remaining work.

## What PR #48 gives us

`classifyPending` now returns a `gate-parked` situation for a parked run, with a marker keyed
precisely enough to name a single gate **round**:

```ts
// src/server/foreman/pending.ts
marker: `gate:${s.nomistakes.id}:${s.nomistakes.gateStep ?? "parked"}:${findingsDigest(s.nomistakes.findings)}`
```

Its own comment explains the care: keyed on the **run id**, not the branch, because successive
runs share a branch; and not on `awaitingAgent`, whose elapsed time ticks. The
`findingsDigest` separates a step's successive rounds.

That maps cleanly onto what the fix log already resolves. For any fix commit:

```
fix commit  --(step, summary)-->  round R (the round that RAN the fix)
round R     --(round - 1)------->  round R-1 (the round that was DECIDED)
round R-1   --step_result-------->  run_id, step_name
```

So `run_id` + `step_name` on our side is `gate:<runId>:<step>` on theirs. That is a real join,
not a heuristic.

## The catch: do not recompute `findingsDigest`

The obvious design - recompute the digest from `findings_json` and match the whole marker -
**does not work**, and this is the main thing to know before starting.

`findingsDigest` hashes `[id, description]` pairs of the findings *as `axi status` rendered
them*, and `axi status` truncates:

```go
// internal/cli/axi_render.go
const maxFindingDesc = 600
func truncate(s string, limit int) string {
    runes := []rune(s)
    if len(runes) <= limit { return s }
    return string(runes[:limit]) + fmt.Sprintf("… (truncated, %d chars total)", len(runes))
}
```

Descriptions routinely run 500-900 chars, so this fires often. The harness's
`NmFinding.description` is therefore the **truncated** string, and the digest hashes that -
while `loadRoundContext` reads the **full** description straight out of `findings_json`.
Matching would mean replicating a 600-rune cut *and* the exact `… (truncated, %d chars total)`
suffix, byte for byte, forever. That is a far worse coupling than the schema read the fix log
already takes: a display constant and a format string are free to change at any time, and
nothing would fail loudly when they did - the lane would just quietly stop matching.

**Use finding ids instead.** Ids are short, stable, and never truncated. They appear in the
gate's findings, in `findings_json`, and in `selected_finding_ids`. A set of ids identifies a
round at least as precisely as a digest of its text, and survives any rendering change.

## Design

Record the foreman's send against the gate it answered, then join.

### 1. Log the send

`applyVerdict` (`src/server/foreman/verdict.ts`) already holds the text, the session, the
time, and the plan's marker. It only calls `putNote`, and `SessionNote` is **one upserted row
per session** - `handledMarker`, `purpose` and `lastAction` are all overwritten by the next
verdict, so by the time anyone reads a fix log the foreman's earlier text is gone. There is no
history to join against.

The store for it already exists and is unused for this:

```sql
-- src/server/db.ts
CREATE TABLE IF NOT EXISTS session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_session ON session_events(session_id, ts);
```

`logEvent(sessionId, ts, kind, payload)` is right there, durable and indexed, with exactly one
caller (`registry.ts`). Add a second:

```ts
logEvent(ctx.sessionId, Date.now(), "foreman_gate_reply", {
  runId, step, findingIds, text: plan.send.text,
})
```

`runId`/`step`/`findingIds` come from the session's live `nomistakes` at send time - the same
object `classifyPending` built the marker from - so nothing needs re-deriving. Log **only** for
`situation === "gate-parked"`; other verdicts aren't about a gate.

### 2. Carry `runId` through the fix log

`NmFixSummary`/`NmFixDetail` don't have it. `loadRoundContext` does - `run_id` is on the
`step_results` row it already joins. Thread it through, plus the round's finding ids.

### 3. Join

For a fix, look up `session_events` where `kind = 'foreman_gate_reply'`, `runId` matches, and
`step` matches; disambiguate a step's successive rounds by finding-id set. Fall back to the
newest reply before the fix's `committedAt` if the ids don't line up (a round can be re-run).

### 4. The third lane, nearly free

`respond()` in `nomistakes.ts` is where the dashboard's Fix box sends `--instructions`. It has
that text and throws it away. One more `logEvent` there distinguishes **you typed this** from
**the agent decided on its own** - the distinction no-mistakes structurally cannot make. Worth
more per line than the foreman lane, and it shares all the groundwork above.

### 5. UI

The lane already exists in the design. `NmFixDecision` is `"auto" | "replied"`; this adds a
`"foreman"` reading (and arguably `"you"`). `NomistakesFixLog` already colour-codes lanes -
amber for a human reply, green for auto - and the original mockups had a Claude-toned
foreman
lane. Show the foreman's own text as its own block, distinct from the reply it produced: they
are two different sentences by two different authors, and collapsing them would be its own
attribution bug.

## Remaining work

- [ ] `logEvent` in `applyVerdict` for `gate-parked` verdicts, with `{runId, step, findingIds, text}`.
- [ ] Thread `runId` + round finding ids through `loadRoundContext` → `NmFixSummary`/`NmFixDetail`.
- [ ] Join in the fix log; add `"foreman"` to the decision lanes.
- [ ] `logEvent` in `respond()` for dashboard-originated instructions → the "you" lane.
- [ ] Prune `session_events` for this kind, or confirm the existing retention covers it - the
      table is durable and this adds a row per gate verdict.
- [ ] UI lane + the foreman's text as its own block.
- [ ] Tests: the join with several rounds on one (run, step); a foreman reply with no matching
      fix; a fix with no reply; and - explicitly - that **no** part of this depends on
      `findingsDigest` or on description text.

## Risks and open questions

- **Attribution is inherently indirect.** The foreman types into a pane; the *agent* decides
  what to send to `axi respond`. So "the foreman authorized this fix" is really "the foreman
  said X about this gate, and the agent then answered it." The UI must not overclaim: show the
  foreman's text as context for the reply, not as the reply.
- **The agent can ignore the nudge.** A logged `foreman_gate_reply` for a gate does not prove
  the fix that followed reflects it. The honest label is *"the foreman said this about this
  gate"*, which is exactly what the data supports.
- **Retention.** The fix log is branch-scoped and self-clearing (reset destroys the commits).
  `session_events` is not - it is durable and keyed by session id. A fix log surviving a
  daemon restart would want these events to outlive the session, which cuts against any
  session-scoped pruning. Decide deliberately.
- **`findingsDigest` is private** to `pending.ts` and, per above, must stay unused here. If a
  future change makes the digest look tempting again, re-read the truncation section first.
