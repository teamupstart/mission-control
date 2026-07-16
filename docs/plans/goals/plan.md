# Plan: Goal on every session card

Status: **phases 0-1 landed; phases 2-6 not started**
Branch: `harness/goal-feature-ee517c`
Owner: ai-harness
Related: **Foreman's Purpose** (`session_notes.purpose`), which this supersedes in part -
see [Decision D1](#d1---relationship-to-purpose). Purpose answers "what is this session for,
plus context for the decision it is blocked on"; Goal answers only the first half, always,
for every card.

> **This document is written to survive a context compaction.** Everything needed to finish
> the work is here: the locked decisions and why, the measured facts behind them, the traps
> that already cost a wrong turn, and the exact anchors in the code. Line numbers were
> verified at commit `bc0b21d`; if one has drifted, grep the quoted symbol.

---

## 1. Goal

A one-sentence statement of **what this session is currently attempting to solve**, on
**every session card**, derived from the user's prompt(s), refreshed as the session takes
further input.

### Non-goals

- Not a summary of what the session *is doing right now*. That is `activity`, which already
  exists and is a different fact (see [Trap 1](#trap-1-the-activity-slot-is-a-ticker)).
- Not a decision brief. That is Foreman's Purpose, which stays (shrunk) for blocked sessions.
- Not Codex support, this pass - but the seam for it is required (see [D4](#d4---codex-coverage) / [Q5](#q5---do-we-run-codex)).

---

## 2. Why this shape

### Purpose already does a third of this job, at the wrong moment, invisibly

`session_notes.purpose` is real, populated, and current. Measured against the live daemon
(`127.0.0.1:7317`) and `~/.fleet-control/harness.db` while writing this: **19 stored notes,
all with a purpose; 4 of 7 live cards carrying one.** Foreman was `enabled: true`,
`mode: "live"`, `triage: "off"`.

It is nonetheless the wrong carrier for a Goal, for three independent reasons:

1. **Invisible by default.** The whole Foreman panel is gated behind `expanded`
   (`SessionCard.tsx:346`). The only collapsed-card hint is the `◆ decision` / `✎ draft`
   chip, which renders only for `escalated` or `pending` dispositions
   (`SessionCard.tsx:191`). Most notes are `skipped`, which shows **no chip at all** - so a
   collapsed card gives zero indication a purpose exists. Of the 4 cards carrying one,
   **0 showed it without a click.**
2. **Arbitrary coverage.** Written only for a `claude` session in the `needs-you` bucket
   (`tickTargets`, `queue-machine.ts:172`). Whether a card has one comes down to whether it
   ever happened to block while the worker held the lease. 3 of 7 never did.
3. **Never refreshes while working.** This is the real defect. A purpose persists once
   written (stored by note key, denormalised back onto the card), which is why all four
   `working` sessions showed one - but each sentence was written at a moment the session was
   *stuck*. Nothing updates it during work, so it describes where the session last got
   blocked, not what it is doing now.

The honest framing: **Purpose is a decision-time artifact being read as a status field.**

### The trigger and the raw material already exist and are being discarded

The `UserPromptSubmit` hook already fires into the daemon carrying the **full prompt text**
in `evt.prompt` (`HookIngestSchema`, `protocol.ts:17`; route `routes.ts:259`;
`Registry.applyHook`, `registry.ts:380`). It is then thrown away: `hookToState`
(`registry.ts:1648`) trims it to 120 chars, and only that truncated string survives as
`activity` (persisted at `registry.ts:441`). Nothing needs to be built to capture the prompt.

---

## 3. Measured facts (do not re-derive)

| Fact | Value | How it was measured |
|---|---|---|
| Live cards carrying a Purpose | 4 of 7 | `GET 127.0.0.1:7317/api/sessions` |
| Of those, visible without expanding | 0 | `SessionCard.tsx:346` gate + `:191` chip conditions |
| Stored notes, all with a purpose | 19 | `session_notes` in `~/.fleet-control/harness.db` |
| Transcripts opening with clean human prose | 26 of 250 | classified first user-role message, 14-day window |
| Transcripts opening with `<local-command-caveat>` | 66 of 250 | of those, **44 contain no human prose at all** |
| Transcripts that are Foreman's own headless calls | 153 of 250 | not discovered as sessions (no tty), but they dominate the dir |
| Clean first prompt length | p50 **371** chars, p90 **5,515**, 19/26 over 200 | truncation cannot produce a sentence |
| `claude -p` + Haiku, cold | **$0.0151**, ~5.4s wall | real probe, exit 0 |
| `claude -p` + Haiku, warm | **$0.0023**, ~4.8s wall | second probe, cache hit |
| Claude Code's own system prompt | **6,783 tokens**, cached 1h ephemeral | dominates cost; our prompt was 9 tokens |
| Codex sessions on this machine | **0**; no `~/.codex/sessions` dir at all | rollout parsing remains **unverified** |

**Cost model.** Our prompt is negligible. Cost is Claude Code's ~6.8k-token system prompt:
written to cache at 2x on a cold call ($0.0151), read at 0.1x when warm ($0.0023), with a
**1h cache TTL**. So cadence governs spend, and a fleet that refreshes at least hourly stays
warm and cheap.

**Probe command** (reproduce with):

```sh
claude -p --output-format json --tools "" --model claude-haiku-4-5 < prompt.txt
```

Returned, first try: `{"goal":"Implement a Goal feature on session cards that displays a
one-sentence summary of what the current session is attempting to accomplish."}` - good
enough to ship.

---

## 4. Traps found the hard way

### Trap 1: the `activity` slot is a ticker

**An earlier draft of this plan was wrong about this.** `UserPromptSubmit` does put the
trimmed prompt into `activity`, but `hookToState` (`registry.ts:1648`) overwrites it with
`running Bash` on the very next `PreToolUse`, then `Bash done`, then the next tool. The
prompt flashes through for milliseconds. **Activity is "what it is doing this second"; Goal
is "what it is trying to solve".** They are orthogonal and Goal must not take that slot.

### Trap 2: `role === "user"` does not mean "a human typed this"

`toMessage` (`transcript.ts:112`) already drops tool-result-only user turns, but **not**
slash-command scaffolding. A user-role message may be a `<local-command-caveat>` block, a
`<command-name>` tag, a `<system-reminder>`, or Claude's own local-command echo (e.g. "Set
effort level to high"). A noise filter is **mandatory in every option** - see
[Phase 2](#phase-2---capture-and-store).

### Trap 3: 44 of 66 slash-command sessions have no prompt to summarise

For those, *"a one-sentence statement based on the user's prompt"* is literally
unsatisfiable. The goal must be inferred from the command plus a transcript window. This is
why the tier-2 refiner reads a window and not just the prompt.

### Trap 4: the model fences its JSON even when told not to

Probe call 2 returned ```` ```json\n{...}\n``` ```` despite "no markdown fences". This is
exactly why `runStructured`'s parse-retry and the callers' fence-handling extractor ladder
exist (`review.ts` `unwrapEnvelope`, ~`:61`). **Reuse `runStructured`; do not hand-roll a
parse.**

### Trap 5: every `claude -p` writes a real transcript

Each call mints a session id and writes `~/.claude/projects/-private-tmp/<uuid>.jsonl` (the
dir is derived from the spawn's `cwd: tmpdir()`). This is already happening - 153 of 250
sampled transcripts were Foreman's. Goal refreshes multiply it. Addressed in
[Phase 6](#phase-6---prune-the-headless-transcript-dir).

### Trap 6: this worktree had no `node_modules`

Nothing had ever been typechecked or tested here. `npm install` was run during Phase 1. If a
fresh worktree behaves oddly, check this first.

---

## 5. Locked decisions

All 13 were put to the operator and answered. **Do not relitigate without new information.**

| # | Decision | Chosen |
|---|---|---|
| D1 | Relationship to Purpose | **C** - Goal is the durable field; Purpose sheds its "what it's for" half |
| D2 | Where generation runs | **C** - two tiers in the daemon |
| D3 | Model for the refiner | **A** - `claude-haiku-4-5` |
| D4 | Codex coverage | **B** - honest empty state |
| D5 | Shared service shape | **A** - shared module, per-process limiter |
| D6 | Migration approach | **A** - move and update imports, no shim |
| Q1 | Refresh cadence | **A** - substantive prompts, ~60s floor |
| Q2 | `/clear` wipes the goal | **A** - accept the wipe |
| Q3 | Kill switch | **B** - no config switch, always on |
| Q4 | Collapsed-card placement | **A** - second line under the title |
| Q5 | Do we run Codex | **C** - not now, but will |
| Q6 | Headless transcript pollution | **B** - prune the dir on a schedule |
| P0 | Fix the README overclaim | **A** - fix now, separate commit |

### D1 - relationship to Purpose

Goal becomes the durable, always-on field. Foreman **stops** writing the "what this session
is for" sentence and **reads Goal instead**, so Purpose shrinks to the decision brief it
actually is. One sentence, one owner, no duplicate model spend. Rejected: renaming Purpose
(it is welded to a pending decision - its prompt asks for "what this session is for **plus
the most relevant recent context for the upcoming decision**"); and a parallel field (two
near-identical sentences on a blocked card, paid for twice).

### D2 - where generation runs

Two tiers **in the daemon**:

- **Tier 1 (no model):** on `UserPromptSubmit`, store the noise-filtered prompt as a
  provisional goal. Instant, free, on every Claude card.
- **Tier 2 (Haiku):** a debounced `claude -p` call rewrites it to one sentence.

Rejected **the Foreman worker** even though it is enabled and live and already owns
`runClaudeText`: the worker only wakes for a **blocked** session, so a goal generated there
could never refresh during the work it describes. Reusing it would reproduce the exact bug
being fixed. Rejected **agent self-report**: the hook contract is fast, silent, 800ms abort -
it cannot call a model. Rejected **heuristic-only**: it is tier 1 anyway, and alone it ships
a truncated 371-char paragraph on the median card and nothing usable on the 44 prose-less
sessions.

### D3 - model

`claude-haiku-4-5` via **`claude -p`, not the Anthropic API**. There is no API key in this
path; usage bills through whatever the CLI is logged in as. Precedent already exists:
`DEFAULT_TRIAGE_MODEL` (`triage.ts:23`) pins the same model for the Tier 1 router. Passing
**no** `--model` inherits the CLI default, which is both priciest and least predictable - do
not inherit it by omission.

### D4 / Q5 - Codex

Codex has no hooks, and `codex-rollout.ts` parses only model / effort / token metadata - no
messages. Its session association is fuzzy (cwd + closest start time). No rollout file exists
on this machine, so **extraction is unverified and must not be promised**. Codex cards show
an honest empty state: *"No goal - Codex sessions aren't instrumented."*

> **Architectural consequence of Q5=C ("not now, but will"):** the goal source must be
> **pluggable per agent type from day one** - a `claude` implementation now, `codex`
> returning `null` into the empty state, and a seam to drop a reader into later. Cheap now,
> expensive to retrofit. **This is a requirement, not a nicety.**

### Q3 - no kill switch

No config flag; refinement always runs. **The silent fallback stays regardless** - that is
error handling, not configuration: if `claude` is missing, logged out, or times out, the goal
quietly remains the tier-1 heuristic and the card never breaks. What was given up is a
deliberate off switch, so **cost is governed by cadence alone**.

### Q2 - `/clear` wipes the goal

Goals key off `noteKeyFor` = `agentSessionId ?? id` (`registry.ts:1601`); a `/clear` mints a
fresh agent session id, so the goal orphans exactly like the work queue already does.
Accepted: tier 1 regenerates instantly on the next prompt, so exposure is one prompt of
blank. Rejected cwd-keying: it would wrongly fuse two different sessions sharing a worktree.

---

## 6. Phases

### Phase 0 - fix the README overclaim — **DONE** (`ac32f71`)

`README:39` claimed Foreman "writes a one-line Purpose on **every card**". On a live 7-session
fleet that was 4 of 7, none visible without expanding. Now reads "every session it inspects",
agreeing with `README:330`, which was always correct.

### Phase 1 - lift the `claude -p` runner out of `foreman/` — **DONE** (`bc0b21d`)

`src/server/foreman/structured.ts` → **`src/server/claude-cli.ts`**. Git tracked it as a
rename, so history follows. Moved **as-is**, not rewritten: the spawn discipline is
load-bearing and hard-won.

Exports: `runClaudeText`, `runStructured`, `killLiveClaudeRuns`, `createLimiter`,
`StructuredResult`.

What that module's comments protect (**do not "simplify" any of these away**):

- `--tools ""` - the prompt embeds untrusted transcript text; a compromised transcript must
  not be able to steer the model into invoking tools.
- `detached: true` - the child becomes its own process-group leader with no controlling tty,
  so the fleet poller never discovers the headless run as a **phantom session**.
- `setEncoding("utf8")` on the streams - `claude -p` streams, so multi-byte chars land across
  chunk boundaries; per-chunk coercion silently corrupts the JSON parse.
- `child.stdin.on("error", () => {})` - an unhandled stdin EPIPE **throws** and takes the
  process down; the `close` handler already reports the real diagnosis.
- `killTree` signalling the **negative pid** - kills the detached group, not just the leader.

Changes made in the move:

- **No global concurrency state.** The daemon and the Foreman worker are separate processes
  (`npm run foreman`), so a shared module *cannot* enforce a shared cap. Rather than pretend,
  it exports `createLimiter(n)` for each caller to build its own. The `while` (not `if`) in
  the limiter is deliberate: a released waiter re-checks the count, so two waiters resumed in
  the same tick cannot both claim one slot.
- **Env compat kept:** reads `FLEET_CLAUDE_BIN || FOREMAN_CLAUDE_BIN || "claude"` and
  `FLEET_CLAUDE_TIMEOUT_MS || FOREMAN_REVIEW_TIMEOUT_MS || 120_000`. The `FOREMAN_*` names
  predate the move and may be set in an existing environment; dropping them would break those
  silently. `test/foreman-review.test.ts` pins `FOREMAN_CLAUDE_BIN` at module load.
- `killLiveReviewers` → `killLiveClaudeRuns` (the daemon's refresher is not a reviewer).
- `runStructured` gained an optional 4th arg `opts: {model?, timeoutMs?}`; its `label`
  default changed to `"The model"`. Both existing callers pass explicit labels, so inert.
- Timeout rejection message is now `claude -p timed out` (still matches the test's `/timed out/`).

Call sites updated: `foreman/review.ts:4`, `foreman/queue-verify.ts:4`, `foreman/worker.ts:27`
(+ `:130` usage), `test/foreman-review.test.ts:29`.

Verified: typecheck clean; **678 tests pass, 0 fail**, including the two that drive the real
spawn + timeout + process-group-kill through the new path.

> Timing note: this was done first **on purpose**. Two other live sessions
> (`mancej/foreman-attribution`, `mancej/foreman-reads-the-pane`) are heading into `foreman/`.
> At the time of the move neither had touched it - no uncommitted changes, no commits vs main -
> so the clean move (D6=A) cost nothing. **If further `foreman/` edits are needed, check those
> branches first.**

---

### Phase 2 - capture and store — **NOT STARTED**

**Stop discarding the prompt.** In `Registry.applyHook` (`registry.ts:380`), `evt.prompt`
holds the full text. `hookToState` (`registry.ts:1648`) trims to 120 chars for `activity` -
leave that alone (it is the ticker, and correct) and capture the full prompt separately
before it is lost.

**Noise filter** (shared, used by both the hook path and any transcript read). Strip / skip a
user-role message that is:

- a `<local-command-caveat>` block,
- a `<command-name>` / `<command-message>` / `<command-args>` tag,
- a `<system-reminder>` block,
- a local-command echo (e.g. `Set effort level to …`, `Set model to …`),
- implausibly long to be a typed prompt (the Foreman headless prompts run 6k-23k chars).

Return the first/most recent **substantive** text, or `null`. `toMessage`
(`transcript.ts:112`) is the right neighbour for this logic; it already drops tool-result
noise and is the single place that knows the record shape.

**Schema.** Extend `session_notes` (`db.ts:89`), keyed by `note_key` = `noteKeyFor(s)`
(`registry.ts:1601`) - the same key Purpose uses, so it survives a daemon restart and orphans
on `/clear` per Q2:

- `goal TEXT` - the sentence shown on the card.
- `goal_source TEXT` - `'heuristic' | 'model'`, so the UI/debug can tell tier 1 from tier 2
  and the refiner knows what it is upgrading.
- `goal_updated_at INTEGER`.
- `goal_prompt TEXT` - the last substantive prompt the goal was derived from, so the refiner
  can be re-run without racing the transcript, and so a restart does not lose the input.

Follow the existing patterns: `getSessionNote` (`db.ts:543`), `loadSessionNotes` (`db.ts:550`,
rehydrates into the registry on start), and `Registry.upsertNote` (`registry.ts:1105`), which
**patch-merges** so a goal-only write never wipes a brief. Mirror that: a purpose-only write
must never wipe a goal.

**Types / protocol.** `SessionNote` (`types.ts:243`), `SessionNoteSummary` (`types.ts:429`,
denormalised onto `Session.note` by `noteSummaryFor`, `registry.ts:1085`), and `SetNoteSchema`
(`protocol.ts:177`). Goal rides the existing session snapshot over SSE - **no new event type
is needed**, exactly as Purpose does today.

### Phase 3 - tier 1 heuristic + render — **NOT STARTED**

- On a substantive `UserPromptSubmit`, write `goal` = filtered prompt (trimmed to a sane
  display length), `goal_source = 'heuristic'`. Instant, free, no model.
- **Render as a second line under the card title** (Q4=A). The activity ticker keeps its own
  slot - the two are different facts. This is *not* behind `expanded`; that is the entire
  point of the feature.
- **Codex cards:** honest empty state, *"No goal - Codex sessions aren't instrumented."*
  (D4=B). Implement the goal source as **pluggable per agent type** here (Q5=C), so a Codex
  reader can be dropped in without restructuring.
- Note: `~10%` of sessions open with clean prose, so on its own this tier is visibly rough on
  the rest. That is expected and is why Phase 4 exists.
- UI verification: per `[[dashboard-resists-browser-automation]]`, the SSE stream blocks
  Chrome automation - **verify with `react-dom/server` render tests**, not a browser.

### Phase 4 - tier 2 Haiku refiner — **NOT STARTED**

In the **daemon**, using `src/server/claude-cli.ts`:

```ts
const limit = createLimiter(2);
const r = await limit(() => runStructured<typeof GoalSchema>(
  buildGoalPrompt({ currentGoal, prompt, window }),
  extractGoal,                       // must handle the ```json fence - see Trap 4
  "Goal",
  { model: "claude-haiku-4-5", timeoutMs: 30_000 },
));
```

- **Cadence (Q1=A):** refresh on **substantive** prompts only (skip "yes" / "continue" by
  length + pattern), with a **~60s floor**. `EvaluationDebounce` (`foreman/debounce.ts`) is
  the existing shape to copy - 60s, in-memory, first sighting due immediately.
- **Pass the current goal into the prompt** so "unchanged" is the cheap, common path. Most
  follow-ups refine rather than redefine.
- **Read a small transcript window**, not just the prompt - the 44 prose-less slash-command
  sessions have no prompt to summarise (Trap 3). `readTranscriptWindow` /
  `resolveTranscriptPath` (`transcript.ts:44`) are the readers.
- On success: `goal_source = 'model'`. On any failure: **leave the heuristic goal in place**
  and do not retry-storm (Q3 - the silent fallback).
- Cap concurrency at 2 so a fleet answering prompts at once cannot fork a subprocess per card.

### Phase 5 - Foreman defers to Goal — **NOT STARTED**

Implements D1=C. Foreman stops writing the "what this session is for" sentence:

- `foreman/prompt.ts:46-93` (POLICY) and `foreman/triage-prompt.ts:10-45` both currently
  demand `"purpose"` in every reply, described as *"what this session is for + the key recent
  context"*. Drop the first half; Purpose becomes the **decision brief only**.
- Schemas requiring it: `verdict.ts` (`purpose: z.string().min(1)`) and `triage.ts` (same).
- Tier 0 canned strings live at `triage.ts:215-262`.
- Foreman should **read** Goal for context instead of re-deriving it.
- `ForemanNote.tsx:114` renders `note.purpose`; the card will now show Goal above the panel,
  so the panel must not repeat it.

> Sequencing: Phase 5 only pays off once Phase 4 is live everywhere Foreman looks. Landing it
> early leaves blocked cards with no "what it's for" sentence at all.

### Phase 6 - prune the headless transcript dir — **NOT STARTED**

Implements Q6=B. Every `claude -p` writes `~/.claude/projects/-private-tmp/<uuid>.jsonl`
(dir derived from the spawn's `cwd: tmpdir()`). Because they all land in **one** cwd-derived
directory, a periodic sweep of files older than N days is ~10 lines and **cannot** touch a
real session's transcript. Rejected `CLAUDE_CONFIG_DIR` isolation: it relocates auth too, so
calls could silently fail to authenticate.

---

## 7. Open items

- **Q4 placement is unbuilt.** "Second line under the title" is the decision; the card is
  already dense (title, state badge, chips, PR link, ticker). Expect to iterate against a
  real card.
- **Codex extraction is unverified.** Needs one real rollout file to inspect. Until then the
  seam exists and the reader does not.
- **Cold-cost exposure.** At $0.0151 a cold call, a fleet that goes quiet for >1h pays cold
  on the next prompt per session. Not addressed; watch it before optimising.

## 8. Provenance

Verified against: the live daemon at `127.0.0.1:7317` (7 sessions, all Claude);
`~/.fleet-control/harness.db` (19 notes; Foreman `enabled: true`, `mode: "live"`,
`triage: "off"`); two real `claude -p --model claude-haiku-4-5` probes (exit 0; $0.0151 cold,
$0.0023 warm); 250 transcripts under `~/.claude/projects` modified within 14 days. Line
numbers verified at `bc0b21d`.

Corrections made during scoping, recorded so they are not re-derived wrongly:

1. An early draft claimed **zero** cards carry a Purpose, reasoning from the shipped default
   `enabled: false` instead of reading the operator's database. The real figure was 4 of 7.
   The correction *sharpened* the case: the defect is staleness and invisibility, not absence.
2. An early draft claimed Goal should take the `activity` slot because a prompt already
   appears there. It does, for milliseconds - `activity` is a ticker (Trap 1).
