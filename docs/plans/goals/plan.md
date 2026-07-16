# Plan: Goal on every session card

Status: **phases 0-2 landed (plus an unplanned prerequisite, 1.5); phases 3-6 not started**
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
>
> **Sections 4-6 have been revised against reality as phases landed.** Where the original
> plan was wrong, the phase says so and section 8 lists every correction. Trust the DONE
> phases over the older prose above them.

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
| **Real `UserPromptSubmit` events that are `<task-notification>`** | **200 of 396 (51%)** | daemon's own `session_events`; measured in Phase 2 |
| Real `UserPromptSubmit` events that are human prose | 188 of 396 (47%) | same; slash commands 6, our own headless prompts 2 |
| Goals that would be scaffolding with no filter | **53%** | same |
| Filter's real-corpus result | 397 events → 197 goals, **0 scaffolding** | `substantivePrompt` over every logged event |
| `<local-command-caveat>` blocks that PRECEDE prose vs. replace it | 121 embedded / 115 whole | 1,891 user turns, 21-day window |
| `<command-args>` carrying a real ask | 17 of 387 pairs | e.g. `/no-mistakes the changes for tab select…` |
| Poisoned rows in live `session_agent_bindings` | **3 of 12** | headless runs impersonating cards; see Phase 1.5 |

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

**Understated, as Phase 2 measured.** The dominant noise is `<task-notification>` - a
background task reporting in through the same hook - which this list never mentioned and
which is **51% of all real `UserPromptSubmit` events**. Without the filter, 53% of goals
would be scaffolding. The filter is not a polish step; it is the difference between the
feature working and not.

### Trap 2b: the two input paths see different shapes of the same ask

The hook (`evt.prompt`, Tier 1) gets the flat text the human typed - `/no-mistakes fix the
arrow keys`. A transcript read (Tier 2) gets the same thing as
`<command-name>/no-mistakes</command-name>` + `<command-args>fix the arrow keys</command-args>`,
wrapped in a caveat block. The `<command-*>` tags **never reach the hook at all**.

So the filter unwraps those two tags rather than dropping them: it makes both paths yield
the same string, and a goal cannot change meaning purely by which tier last wrote it.

### Trap 2c: scaffolding is usually *inside* a turn, not the whole turn

A `<local-command-caveat>` block precedes real prose in **121** of 236 sampled cases and
is the entire turn in the other **115**. `<command-name>` was embedded in 265 of 265. A
filter that classifies whole turns handles half the corpus; one that strips blocks and
then looks at the remainder handles all of it. Hence "strip, then decide".

One exception, and it is load-bearing: a machine tag that opens a turn and never closes
means the text was **truncated** (`session_events` stores the 120-char trimmed activity,
so every notification logged there is cut mid-block). A closed-block rule silently does
nothing on that input and the whole block lands on the card. Anchoring the unclosed check
to the START is what keeps it safe next to prose that merely *mentions* a tag.

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

### Trap 5b: a headless `claude -p` also fires HOOKS - and they impersonate a real card

**The worst thing found so far, and the plan missed it entirely.** A headless run is Claude
Code, so it fires the same hooks a human's session does. The hook binds an event to a card
from `TMUX_PANE`/`WEZTERM_PANE` read out of its own process, and it is a child of `claude`,
which is a child of the daemon or the Foreman worker - so spawning with `env: process.env`
handed every headless run the pane identity of whatever card the spawner was launched from.

`applyHook` writes `agentSessionId: evt.sessionId ?? target.agentSessionId`, so the headless
uuid **becomes the real card's**: `noteKeyFor` rotates, the note and work queue keyed on the
old value orphan, `transcriptPath` repoints at the headless transcript, and `activity`
becomes our prompt. Measured on the live db: **3 of 12 bindings poisoned, two different real
cards fused onto one headless uuid.**

For Goal this is fatal rather than untidy: goals key on `noteKeyFor`, and the Phase 4
refiner spawns `claude -p` **from the daemon**. Unfixed, the refiner would poison the key of
the very card it was summarising and then summarise its own prompt. Fixed in
[Phase 1.5](#phase-15---stop-headless-runs-impersonating-a-card--done-8f08364).

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

### Phase 0 - fix the README overclaim - **DONE** (`ac32f71`)

`README:39` claimed Foreman "writes a one-line Purpose on **every card**". On a live 7-session
fleet that was 4 of 7, none visible without expanding. Now reads "every session it inspects",
agreeing with `README:330`, which was always correct.

### Phase 1 - lift the `claude -p` runner out of `foreman/` - **DONE** (`bc0b21d`)

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

### Phase 1.5 - stop headless runs impersonating a card - **DONE** (`8f08364`)

**Unplanned, and a hard prerequisite for Phases 3-6.** See
[Trap 5b](#trap-5b-a-headless-claude--p-also-fires-hooks---and-they-impersonate-a-real-card)
for the mechanism and the measured damage (3 of 12 live bindings poisoned).

Two independent layers, because neither can be assumed:

- **`headlessEnv()` in `claude-cli.ts`** drops `TMUX_PANE`/`WEZTERM_PANE` (the only keys
  `overlayKeyFromEnv` matches) and sets `FLEET_HEADLESS=1`. This is what protects a hook
  script installed globally from a checkout that lags this code - the installed hook points
  at `~/workspace/ai-harness/hooks/`, not at this worktree.
- **Both forwarders decline to report a run carrying the marker**, so there is no POST at
  all rather than one the daemon must reject. `harness-statusline.mjs` suppresses only the
  *report*, never the delegation that renders the line - a stray marker must not be able to
  blank an interactive status line.

`applyStatusLine` binds and rebinds exactly as `applyHook` does; a non-interactive run has
no status line to render today, so that guard is insurance against the same silent failure
rather than a fix for an observed one.

Tests: `test/claude-cli-headless-env.test.ts` drives a real spawn through `runClaudeText`
with a fake bin that reports the env it was handed - which is exactly what the hook would
capture - and asserts through `overlayKeyFromEnv`, because a null key is the whole defence.

> **Not self-healing.** A poisoned row is corrected once the real session fires its next
> hook, but a note or queue keyed on the headless uuid stays orphaned. The 3 rows found were
> on dead sessions and left alone.

### Phase 2 - capture and store - **DONE** (`badb9d2`)

**The prompt is no longer discarded.** `Registry.applyHook` keeps the full `evt.prompt` via
`captureGoalPrompt`, called **last** in the hook path: `upsertGoal` re-denormalises and emits
through `syncSessionsForGoal`, so running it earlier would leave the main emit shipping the
pre-goal object. `hookToState`'s 120-char trim still feeds `activity` and was left alone (it
is the ticker, and correct).

**Noise filter** - `substantivePrompt` / `clampPrompt` in `transcript.ts`, next to
`latestEffortLevel`, which already scrapes Claude's local-command echoes. Three things
differ from what this section originally specified, each forced by measurement:

- **`<task-notification>` was missing from the list** and is the single biggest source at
  **51%** of real events. See [Trap 2](#trap-2-role--user-does-not-mean-a-human-typed-this).
- **It strips blocks, then decides** - it does not classify whole turns
  ([Trap 2c](#trap-2c-scaffolding-is-usually-inside-a-turn-not-the-whole-turn)) - and it
  **unwraps** `<command-name>`/`<command-args>` rather than dropping them
  ([Trap 2b](#trap-2b-the-two-input-paths-see-different-shapes-of-the-same-ask)).
- **The length rejection was dropped.** Its stated purpose was keeping Foreman's 6k-23k char
  headless prompts out; Phase 1.5 fixed that at the source, and real typed prompts run to a
  **5,515-char p90** - so the rule would now reject nothing but genuine asks, and the most
  detailed ones at that. `clampPrompt` bounds what is **stored** instead (4KB), keeping head
  **and** tail: `"here is the log: <8KB> - why does it break?"` puts the entire ask in the
  last line, so head-only truncation would store the log and lose the question.

**Schema - `session_goals`, a new table, NOT columns on `session_notes`.** This section
originally said to extend `session_notes`; its stated *reason* was the **key** (survives a
restart, orphans on `/clear` per Q2), and `session_goals` is keyed identically on
`noteKeyFor`, so every locked decision holds. What was not foreseen: a note has one
`disposition` and one `updated_at`, both meaning *"what Foreman decided, and when"*. A
goal-only write would have to invent a disposition - defaulting to `"pending"`, i.e.
*"Foreman drafted a reply it hasn't sent"* - and bump the stamp `foremanStatus` reports as
`lastActionAt`. On a live fleet that is **N phantom drafts in ForemanBar** and a Foreman
claiming to have acted on every keystroke. `QueueManager` (`queue.ts:14-18`) already declined
to build on `SessionNote` for this exact reason and says so; this follows that precedent.
Bonus: a new table needs **no migration**, so no pre-existing row has to be reasoned about.

    session_goals(note_key PK, text, source, prompt, updated_at)

- `text` - the sentence. Null while only a prompt has been captured, which is why
  `goalSummaryFor` reports a text-less row as **no goal** (an empty line on a card is worse
  than none).
- `source` - `'heuristic' | 'model'`. Narrowed on read, not cast, so a value a newer build
  wrote can't reach the UI unrenderable.
- `prompt` - the refiner's input. **Server-side only**; deliberately absent from
  `SessionGoalSummary`, which rides every snapshot for every card.
- `updated_at` - moves only when `text` **changes**. A re-derived identical goal is the
  common case and must not read as a session changing course.

**Types / protocol.** `SessionGoal` + `SessionGoalSummary` (`types.ts`), `SetGoalSchema`
(`protocol.ts`), `Session.goal` - a **sibling** of `Session.note`, not a field inside it,
since Foreman does not own the sentence and the card must show it without gating on anything
of Foreman's. Goal rides the existing session snapshot over SSE - **no new event type**,
exactly as Purpose does today. No route: every writer (Tier 1 and Tier 2) is in-daemon.

Verified: typecheck clean, **702 tests pass**. `test/substantive-prompt.test.ts` (every
fixture a real shape from the corpus), `test/session-goals.test.ts` (including a regression
test that a goal write does not fabricate a Foreman draft), and an end-to-end case in
`test/http-integration.test.ts` that POSTs the exact body `harness-hook.mjs` builds through
the real route. The filter was also run over the whole real corpus: **397 events → 197 goals,
0 scaffolding surviving**.

### Phase 3 - tier 1 heuristic + render - **NOT STARTED**

> Phase 2 landed the storage this builds on. The wiring point is `captureGoalPrompt`
> (`registry.ts`), which today stores only `prompt`; Phase 3 adds `text` + `source` beside
> it. `substantivePrompt` has already run at that point - do not filter twice.

- On a substantive `UserPromptSubmit`, write `text` = filtered prompt (trimmed to a sane
  display length), `source = 'heuristic'`. Instant, free, no model.
- **A card renders a goal only once `text` is set** - `goalSummaryFor` already reports a
  prompt-only row as `null`, so nothing is shown until this phase writes a sentence.
- **Open question this phase must answer:** whether a bare meta-command (`/clear`,
  `/compact`, `/exit`) should become a goal. The filter deliberately does not judge - it
  returns the human's words, and `/clear` is a real thing they typed. But "/clear" is not a
  goal, and deciding that is display policy, not noise filtering. (`/clear` also rotates the
  note key per Q2, so its own goal orphans immediately - the case may be self-solving.)
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

### Phase 4 - tier 2 Haiku refiner - **NOT STARTED**

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

> **The feedback loop is already closed** - see [Trap 5b](#trap-5b-a-headless-claude--p-also-fires-hooks---and-they-impersonate-a-real-card)
> and Phase 1.5. This call spawns `claude -p` **from the daemon**, whose hooks would
> otherwise land back on a card as a prompt. Do not undo `headlessEnv()`, and do not read
> `prompt` back out of a hook the refiner itself caused. `test/claude-cli-headless-env.test.ts`
> is what keeps this honest.

The stored `prompt` (Phase 2) is the refiner's input - already filtered and clamped, so it
needs neither again.

- **Cadence (Q1=A):** refresh on **substantive** prompts only (skip "yes" / "continue" by
  length + pattern), with a **~60s floor**. `EvaluationDebounce` (`foreman/debounce.ts`) is
  the existing shape to copy - 60s, in-memory, first sighting due immediately.
- **Pass the current goal into the prompt** so "unchanged" is the cheap, common path. Most
  follow-ups refine rather than redefine.
- **Read a small transcript window**, not just the prompt - the 44 prose-less slash-command
  sessions have no prompt to summarise (Trap 3). `readTranscriptWindow` /
  `resolveTranscriptPath` (`transcript.ts:44`) are the readers.
- On success: `source = 'model'`. On any failure: **leave the heuristic goal in place**
  and do not retry-storm (Q3 - the silent fallback). `upsertGoal` merges, so writing
  `{ text, source }` alone already preserves the stored `prompt`.
- Cap concurrency at 2 so a fleet answering prompts at once cannot fork a subprocess per card.

### Phase 5 - Foreman defers to Goal - **NOT STARTED**

Implements D1=C. Foreman stops writing the "what this session is for" sentence:

- `foreman/prompt.ts:46-93` (POLICY) and `foreman/triage-prompt.ts:10-45` both currently
  demand `"purpose"` in every reply, described as *"what this session is for + the key recent
  context"*. Drop the first half; Purpose becomes the **decision brief only**.
- Schemas requiring it: `verdict.ts` (`purpose: z.string().min(1)`) and `triage.ts` (same).
- Tier 0 canned strings live at `triage.ts:215-262`.
- Foreman should **read** Goal for context instead of re-deriving it. It runs in a separate
  process, so it reads `Session.goal` off the snapshot its client already fetches - no new
  route, and no access to `SessionGoal.prompt` (server-side only, by design).
- `ForemanNote.tsx:114` renders `note.purpose`; the card will now show Goal above the panel,
  so the panel must not repeat it.

> Sequencing: Phase 5 only pays off once Phase 4 is live everywhere Foreman looks. Landing it
> early leaves blocked cards with no "what it's for" sentence at all.

### Phase 6 - prune the headless transcript dir - **NOT STARTED**

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
- **Meta-commands as goals.** `/clear` and `/compact` survive the filter (they are words a
  human typed) but are not goals. Phase 3 owns the call - see its note.
- **The installed hook lags this repo.** `~/.claude/settings.json` runs
  `~/workspace/ai-harness/hooks/harness-hook.mjs`, not this worktree's copy, so the
  Phase 1.5 marker guard only takes effect once that checkout has these commits. The
  `headlessEnv()` half works regardless, which is why it exists.

## 8. Provenance

Verified against: the live daemon at `127.0.0.1:7317` (7 sessions, all Claude);
`~/.fleet-control/harness.db` (19 notes; Foreman `enabled: true`, `mode: "live"`,
`triage: "off"`); two real `claude -p --model claude-haiku-4-5` probes (exit 0; $0.0151 cold,
$0.0023 warm); 250 transcripts under `~/.claude/projects` modified within 14 days. Line
numbers verified at `bc0b21d`.

Phase 1.5 / 2 additionally verified against: the daemon's own `session_events` (396 real
`UserPromptSubmit` events); 1,891 user turns across 660 non-headless transcripts in a 21-day
window; `session_agent_bindings` (12 rows, 3 poisoned); 387 `<command-name>`/`<command-args>`
pairs. The filter was run over that whole corpus rather than only against fixtures.

Corrections made during scoping, recorded so they are not re-derived wrongly:

1. An early draft claimed **zero** cards carry a Purpose, reasoning from the shipped default
   `enabled: false` instead of reading the operator's database. The real figure was 4 of 7.
   The correction *sharpened* the case: the defect is staleness and invisibility, not absence.
2. An early draft claimed Goal should take the `activity` slot because a prompt already
   appears there. It does, for milliseconds - `activity` is a ticker (Trap 1).

Corrections made **while implementing** (the plan was wrong; the code is right):

3. **The noise filter's list was missing its biggest entry.** `<task-notification>` is 51%
   of real hook prompts; the plan named only the transcript-shaped scaffolding. Measured, not
   guessed - the two input paths see different mixes (Trap 2b).
4. **The "implausibly long" rejection was wrong and is gone.** It was aimed at Foreman's
   headless prompts, which Phase 1.5 stopped at the source; against real data it would have
   rejected only genuine asks (p90 = 5,515 chars). Bounding *storage* replaced it.
5. **Goals are their own table, not columns on `session_notes`.** The plan's reason for that
   table was the key, which is preserved; sharing the row would have invented a Foreman
   `disposition` and `lastActionAt` for every session with a goal. `queue.ts:14-18` had
   already reached the same conclusion for the same reason.
6. **Headless `claude -p` runs fire hooks and impersonate cards** (Trap 5b). Not in the plan
   at all, already poisoning 3 of 12 live bindings, and fatal to a Goal refiner that spawns
   `claude -p` from the daemon. Fixed in Phase 1.5 before anything was built on top of it.
