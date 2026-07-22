# Plan: Foreman watcher — a cheap tier that spends the model only when it must

Status: Tiers 0 + 1 shipped (Step 0 previously shipped - see "Step 0" below). Ships in `shadow`
mode by default: the cheap tier runs alongside the full review and every divergence is logged, so
its accuracy is measured before `triage: 'on'` is ever flipped.
Owner: ai-harness (Mission Control)
Related: `docs/plans/foreman/plan.md` (the shipped auto-responder), `todo/foreman-upgrades.md`
(item #1). Inspiration: [`firstmate`](https://github.com/kunchenguid/firstmate)'s
"zero-token supervision" bash watcher.

## Context

Today `processSession` in `src/server/foreman/worker.ts` does one thing when it sees a new
blocked episode: it spawns a full `claude -p` review (`reviewSession`) with a ~48-turn transcript
window and the whole `POLICY` prompt. That is a full Opus/Sonnet call **per new marker**, whether
the session is a genuine implementation fork or a plan-review that Foreman is structurally always
going to hand back to you.

firstmate avoids this by classifying every wake in pure bash and *absorbing the benign ones for
zero tokens*, waking a model only when a real decision exists. The distinction that matters is
**deterministic code vs. LLM inference**: a shell/Node check costs no tokens; a `claude -p` call
costs real money and latency. firstmate draws the "wake the brain" line high (bash filters
aggressively); Foreman draws it low (any new marker ⇒ a full review).

This plan raises Foreman's line, as a **cost gradient**: dispose of easy cases cheaply, spend the
expensive model only where judgment is required — without weakening the answer quality Foreman is
good at, and without ever taking a riskier action than the full review would.

### The cost shape we're attacking
- Reviews are serial (one session at a time, `worker.ts` for-loop) and each can run up to
  `FOREMAN_REVIEW_TIMEOUT_MS` (120s). A slow review blocks the whole queue behind it.
- The idempotency marker already skips an *unchanged* episode for free (`worker.ts:109`). The
  waste is the **first** look at each new marker, plus **flapping markers** (a terminal surface
  keyed on `await:<lastActivity>`, `worker.ts:269`) that change every loop with no time floor.

## The core safety invariant

The cheap tier can never make a *worse* call than the full review would. The tiering is
deliberately **asymmetric**:

- The cheap tier may route **down** to `skip` (leaves it for you — safe) or `escalate` (asks you
  — safe) freely.
- The cheap tier may take a substantive **auto-answer** only for a tightly bounded, allowlisted
  category (routine non-destructive access), under the *exact* config gate the full path already
  requires (`live` + repo allowlist + `autoApproveAccess`).
- For anything else — any implementation trade-off, anything ambiguous, any low confidence — it
  routes **up** to the full review. It is never trusted to invent an answer.

Net: the cheap tier can only *reduce* work or *defer up*. All non-trivial answers are still
decided by the expensive reviewer, so answer quality is unchanged. The worst a cheap-tier mistake
can do is waste one Opus call (routed up when it needn't) or hand you a session Foreman could have
handled (lost automation, never a wrong action).

## The tiers

### Tier 0 — structural gate (zero model, pure code)
Runs inside `processSession` using data already in hand (the session snapshot, the reviews list,
the note, and the `classifyPending` surface). Disposes without any model call when the outcome is
structurally determined:

- Marker already handled ⇒ skip. *(Exists today via `handledMarker`.)*
- Surface is a non-`input` review (plan / diff - `ReviewKind` has never had a `gate` member) ⇒
  structurally human-only ⇒ `skip`. This previously spent a full review just to write the Purpose;
  Tier 0 disposes it outright, naming the Purpose straight from the review's own kind and title.
  *(This resolves the third open question below in the cheap direction: the Purpose here is
  written by pure code, not handed down to Haiku - "this is a plan review for you" is all Foreman
  has to add, and it needs no model to say it.)*
- Answerable surface but no delivery channel (a terminal prompt with no tmux/wezterm pane) ⇒ would
  escalate regardless ⇒ route **up**. *(This bullet originally read "escalate directly when the
  question is short and self-contained, else route up". Implementation found the premise doesn't
  hold: on this surface the question is never self-contained. `awaiting_input` is set in exactly
  one place - the Notification branch of `hookToState` - whose activity line is a generic,
  120-char-capped notification ("Claude needs your permission") that never names the ask. A Tier 0
  escalation built from it names neither the goal nor the command, so the full reviewer frames it
  instead; no-pane sessions are rare, so the Opus cost is negligible.)*

### Tier 1 — cheap model triage (Haiku, trimmed transcript)
For sessions that reach here there IS an answerable surface (an `input` review, a terminal prompt
with a pane, or a parked no-mistakes gate - the last is why backstop 4 below has to exist).
Reuse the same `claude -p --tools ""` subprocess machinery from `review.ts`,
but with `--model claude-haiku-4-5` and a smaller window (fetch `turns=12` instead of 48). The
endpoint's `turns` turned out to be a *byte*-bound hint rather than a turn bound - under its byte
budget `readTranscriptWindow` returns the file whole - so the real bound is applied client-side in
`triageSession`, which also keeps the opening turns so the Purpose still describes what the session
is *for* rather than its last ten minutes. The denylist scan stays narrower than that (the recent
turns only), since its patterns over-match by design. A narrow routing prompt asks Haiku to *bucket*
the ask, not solve it:

- `human-only` (design fork, unclear intent, product preference) ⇒ `escalate` or `skip`; Haiku
  writes the Purpose. No Opus call.
- `routine-access` (non-destructive approval: run tests, read files, normal dependency, routine
  git) ⇒ hand to the access auto-approve path with Haiku's one-line reply, but only auto-*send*
  under the existing gates; otherwise draft/escalate.
- `needs-judgment` (implementation trade-offs, anything Haiku isn't confident on) ⇒ route **up**
  to Tier 2.

Five hard backstops in *code*, applied after Haiku, that Haiku cannot override:
1. The destructive denylist the `POLICY` already enumerates (`rm -rf`, force-push, drop/delete
   data, prod changes, secrets, exfiltration, disabling safety checks) — if it matches, force
   `escalate` regardless of Haiku. Scanned over what the child said and did (the pending ask, the
   recent window, Haiku's own reply), never over a question Foreman synthesized itself.
2. Low-confidence default is route-up, never skip-answerable.
3. An unscannable window withholds the auto-answer — the only outcome that acts. No prose for the
   denylist to have read (`hasProse`), or turns that can't be placed in the session
   (`boundaryUnknown`), means "unknown" rather than "safe", so it routes up.
4. A parked no-mistakes gate is never Tier 1's to answer or skip. The router is only ever taught
   permission prompts, so it has no notion of what a gate is; a gate may only be escalated (cheap,
   safe, in front of the human) or routed up to the tier that was taught.
5. An answer this tier cannot *deliver* is a route-up, not a decision (`menuBlocksAnswer`). A menu
   is answered by selecting a row, and the router's schema has no field to name one - so on a menu,
   which is what a permission prompt is, every answer it reaches is handed to the reviewer that can
   name a row. Route-up rather than escalate on purpose: escalating would put a human in front of
   every routine approval when the tier is `on`, having spent the cheap call to learn nothing. Falling
   back to typing the prose is the bug this exists to make unreachable - see the "never confirm a
   row we did not verify" invariant in `docs/plans/foreman/plan.md`.

### Tier 2 — full review (unchanged)
The existing `reviewSession` + full `POLICY` + 48-turn window. Fires only for sessions Tier 1
routed up. This stays the sole place substantive auto-answers get decided, so current behavior is
preserved for exactly the hard cases it's good at. Delivery is unchanged: any auto-send from any
tier still flows through `applyVerdict` and the `sendStillValid` re-validation against a fresh
snapshot, so the mid-review safety net still applies.

## Where it hooks in

- New `src/server/foreman/triage.ts`: `triageSession(deps, pending, session, config, pane) →
  TriageOutcome`, where an outcome is `{ kind: 'dispose'; tier: 0 | 1; verdict; reason }` or
  `{ kind: 'route-up'; reason }`. Tiers 0 (`tier0`, pure) and 1 (`mapTriage` over the router's
  report, also pure) both live here; `deps` injects the only two I/O edges (the transcript read
  and the router subprocess) so the whole safety contract is unit-testable without either. The
  child's screen is a *parameter*, not a dep: `processSession` captures it once and passes it to
  whichever tier reviews, so this tier's answer is checked against the same rows it was shown.
  `src/server/foreman/triage-prompt.ts` holds the bucketing prompt, mirroring `prompt.ts`.
- New `src/server/foreman/pending.ts`: `classifyPending`, lifted out of `worker.ts` (which runs a
  top-level loop on import, so `triage.ts` could not have imported it there) and given a richer
  `situation` discriminant - `input-review` / `non-input-review` / `terminal-pane` /
  `terminal-no-pane` / `gate-parked` / `no-question` - which is exactly what Tier 0 switches on.
- `worker.ts`: `processSession` delegates to `decide`, which switches over the posture and returns
  `{ verdict, tier }` - `fullReviewOnly` (off), `shadowBoth` (shadow), or `cheapTierDecides` (on).
  `reviewSession` is reached only when the cheap tier routes up, or on every session under `off` /
  `shadow`. Shadow runs the two concurrently (`Promise.all`), so the cheap call adds no serial
  latency to the already-serial queue.
- `review.ts`: `runClaude` → exported `runClaudeText(prompt, { model, timeoutMs })` and
  `extractVerdict` → generic `parseModelJson(raw, schema)`, so Tier 1 reuses the same tool-less,
  injection-isolated subprocess and the same envelope-unwrapping parser, only with a cheaper model
  and its own (30s) budget.
- `src/server/foreman/debounce.ts` (Step 0, shipped): the per-session evaluation cooldown, applied
  before any tier so a flapping marker can't burn work every loop.
- Config additions on `ForemanConfigSchema` (`src/shared/protocol.ts`): `triage: 'off' | 'shadow'
  | 'on'` (default `shadow` on first ship) and an optional `triageModel`. Env
  `FOREMAN_TRIAGE_MODEL` overrides the model, `FOREMAN_TRIAGE_TIMEOUT_MS` the router's budget.
  `ForemanClient.getConfig` now *parses* the daemon's response through the schema rather than
  casting it, so a daemon too old to serve `triage` yields the schema's own `shadow` default and a
  value outside the enum is rejected before it can reach the tier dispatch.
- Telemetry: **structured worker log lines**, not a note/audit stamp - `[tier N]` on every acted
  session, `tier N disposed -> action (reason)` / `routed up to full review (reason)` under `on`,
  and `shadow <divergence> (cheap=… opus=…)` under `shadow`. *(The plan originally proposed
  stamping the note. The log is the audit surface instead: a tier + reason is rollout telemetry
  with a natural half-life, and threading it onto the note would mean a schema column and card UI
  for a field that stops being interesting the moment `on` is trusted.)*

## Step 0 (shipped in this PR): per-session evaluation debounce

The smallest, safest slice of Tier 0's intent, landed first so the flapping-marker cost bleed
stops immediately and independently of the rest of the plan.

- `src/server/foreman/debounce.ts` — `EvaluationDebounce`, an in-memory, per-session minimum
  interval between full evaluations, with an injectable clock and a bounded (self-pruning) map.
- `worker.ts` — a top-level `EvaluationDebounce(EVAL_DEBOUNCE_MS)` (default **60s**, override with
  `FOREMAN_EVAL_DEBOUNCE_MS`), claimed in `processSession` right after the idempotency check and
  before any transcript fetch or review.
- Semantics: the marker idempotency check still skips an *unchanged* episode for free; the
  debounce adds a wall-clock floor so a *changed* marker on the same session triggers at most one
  review per window. A session seen for the first time is due immediately, so genuinely new work
  is never delayed; only re-evaluations inside the window are held off.
- Tests: `test/foreman-debounce.test.ts` (deterministic fake clock) covers first-sight due,
  in-window hold-off, boundary at exactly the interval, "measured from the last successful claim"
  (flap stays rate-limited), per-session independence, bounded/pruned map, and a custom interval.

Trade-off (intended): a legitimately new question on a session evaluated <60s ago waits up to the
window before Foreman looks. That's the point — it rate-limits flapping — and Tiers 0/1 will later
make the cheap look so cheap the floor matters less.

## Rollout: shadow mode first

This is Foreman's own dry-run→live trust ladder applied to the triage layer itself. In `shadow`
mode, run **both** the cheap tier and the full review and log every divergence (cheap said skip,
Opus would have answered, etc). Flip `triage: 'on'` only once the divergence rate on answerable
cases is near zero. That turns "trust me, Haiku is good enough" into measured evidence before it
short-circuits anything.

## Expected savings

If a busy set of sessions is ~40% human-only reviews (Tier 0/1, near-zero cost), ~20% routine access (Tier 1
Haiku), and ~40% real judgment (Tier 2), Opus reviews drop ~60%, replaced by far cheaper Haiku
calls on smaller transcripts. A routed-up session costs one extra Haiku call on top of the Opus one
it would have cost anyway: Tier 2 deliberately re-fetches its own 48-turn window rather than
inheriting Tier 1's trimmed context, which is what keeps it literally unchanged. All failure modes
are fail-safe: a cheap-tier miss costs a wasted Opus call or a hand-back to you, never a wrong
action.

## Non-goals

- No batching of multiple sessions into one triage call — it would break the fresh-context,
  injection-isolated "one session per process" guarantee Foreman deliberately built. Keep one
  session per subprocess.
- No change to delivery, the trust ladder, or the escalation/alert UX — this is purely a gate in
  front of the existing reviewer.

The tiers remain agent-agnostic. Current harness support and authorization boundaries are
documented in [Foreman](../../../README.md#foreman-auto-responder).

## Open questions

- How real is the flapping risk in practice? Depends on how `lastActivity` is computed upstream —
  worth measuring before tuning the debounce window or building Tier 1. (Step 0's floor is a safe
  default regardless.)
- Tier 1 model + prompt: is a single Haiku routing prompt reliable enough on `routine-access`
  classification, or does the destructive-denylist backstop need to carry most of the weight?
  *(Still open by design - this is precisely what the default `shadow` posture is there to
  measure. The `cheap-over-eager` divergence rate is the number that answers it.)*
- ~~Should Tier 0's "human-only" Purpose be written by Haiku (a summary) or skipped entirely?~~
  **Resolved:** neither - Tier 0 writes a structural Purpose in pure code, naming the review's kind
  and title, for zero tokens. See the Tier 0 bullet above.
- ~~The denylist can only read what a `TranscriptMessage` carries, and that is tool *names* without
  tool *inputs* (`toMessage` in `src/server/transcript.ts` drops the arguments). A command that
  appears only as a tool input and is never spoken about in prose is therefore invisible to
  backstop 1, leaving the router's own bucketing as the only thing in front of it. Closing this
  properly means carrying tool inputs through `TranscriptMessage` - worth doing before `on` is
  trusted on the terminal surface.~~
  **Resolved:** `TranscriptMessage.tools` now carries each call's input, capped at
  `TOOL_INPUT_CAP`, so backstop 1 scans real command strings. It also fixed a bigger problem than
  the one it was filed under: on the terminal surface the *reviewer* was blind too, since the
  pending question there is the generic "Claude needs your permission" and an `AskUserQuestion`
  rendered as a bare name. Tier 2 could not produce a usable verdict at all on that input.
- `hasProse` (backstop 3) is now deliberately narrower than what the denylist scans - it still
  requires *prose*, though a tool input is scannable too. That only ever routes up, so it is safe,
  but it means a prose-free window still buys an Opus call Tier 1 could now have answered.
  Widening it loosens a safety gate, so it wants its own change and its own measurement.
- Carrying tool *inputs* into `riskContextFrom` widened what the denylist sees from prose + tool
  names to file paths and file bodies, and the DESTRUCTIVE patterns are word-level, not
  command-level - so a payload that merely *discusses* a dangerous word now escalates. Measured
  over 205 real 12-turn scan windows from this machine's transcripts: escalation 22.9% before vs
  36.1% after (+13.2 points), leaving 63.9% still disposable by Tier 1 - so the feared "Tier 1's
  only substantive disposal collapses toward zero" does not hold. The new escalations come from
  `Bash` (25), `StructuredOutput` (5), `Write` (1); the hypothesised `Read`/`.env.example` and
  `Grep`/`api_key` trips did not occur at all in real data. The `Bash` trips are overwhelmingly
  benign scratch cleanup (`rm -f /tmp/...`) - backstop 1 over-matching exactly as its own comment
  says it is designed to, now meeting real commands for the first time; one genuine catch observed
  was `vercel deploy --prod`. The real noise is `StructuredOutput`/`Write` payloads discussing
  dangerous words (~2.9% of windows). *Accepted deliberately: the direction is safe (it can only
  route up), and `shadow`'s `cheap-over-eager` divergence is the instrument. Note for anyone
  tempted by the obvious fix - scoping the input scan to command-bearing tools would recover only
  ~6 of the 27 new escalations, because the bulk IS `Bash`. This is the data to weigh before
  flipping `triage` to `on`.*
