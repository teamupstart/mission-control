# Plan: Foreman watcher — a cheap tier that spends the model only when it must

Status: Tiers 0 + 1 shipped (Step 0 previously shipped - see "Step 0" below). Ships in `shadow`
mode by default: the cheap tier runs alongside the full review and every divergence is logged, so
its accuracy is measured before `triage: 'on'` is ever flipped.
Owner: ai-harness (Agent Wrangler)
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
Runs inside `processSession` using data already in hand (the fleet snapshot, the reviews list,
the note, and the `classifyPending` surface). Disposes without any model call when the outcome is
structurally determined:

- Marker already handled ⇒ skip. *(Exists today via `handledMarker`.)*
- Surface is a non-`input` review (plan / diff / gate) ⇒ structurally human-only ⇒ `skip`. Today
  this still spends a full review just to write the Purpose; Tier 0 short-circuits the judgment
  and hands only the Purpose down to Tier 1.
- Answerable surface but no delivery channel (a terminal prompt with no tmux/wezterm pane) ⇒ would
  escalate regardless ⇒ route **up**. *(This bullet originally read "escalate directly when the
  question is short and self-contained, else route up". Implementation found the premise doesn't
  hold: on this surface the question is never self-contained. `awaiting_input` is set in exactly
  one place - the Notification branch of `hookToState` - whose activity line is a generic,
  120-char-capped notification ("Claude needs your permission") that never names the ask. A Tier 0
  escalation built from it names neither the goal nor the command, so the full reviewer frames it
  instead; no-pane sessions are rare, so the Opus cost is negligible.)*

### Tier 1 — cheap model triage (Haiku, trimmed transcript)
For sessions that reach here there IS an answerable surface (an `input` review or a terminal
prompt with a pane). Reuse the same `claude -p --tools ""` subprocess machinery from `review.ts`,
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

Two hard backstops in *code*, applied after Haiku, that Haiku cannot override:
1. The destructive denylist the `POLICY` already enumerates (`rm -rf`, force-push, drop/delete
   data, prod changes, secrets, exfiltration, disabling safety checks) — if it matches, force
   `escalate` regardless of Haiku.
2. Low-confidence default is route-up, never skip-answerable.

### Tier 2 — full review (unchanged)
The existing `reviewSession` + full `POLICY` + 48-turn window. Fires only for sessions Tier 1
routed up. This stays the sole place substantive auto-answers get decided, so current behavior is
preserved for exactly the hard cases it's good at. Delivery is unchanged: any auto-send from any
tier still flows through `applyVerdict` and the `sendStillValid` re-validation against a fresh
snapshot, so the mid-review safety net still applies.

## Where it hooks in

- New `src/server/foreman/triage.ts`: `triageSession(surface, snapshot, note, config) →
  { disposed: verdict } | { routeUp: true }`. Tiers 0 and 1 live here.
- `worker.ts`: `processSession` calls the Tier 0 checks, then `triageSession` when an answerable
  surface exists, and only reaches `reviewSession` when triage returns `routeUp`.
- `src/server/foreman/debounce.ts` (Step 0, shipped): the per-session evaluation cooldown, applied
  before any tier so a flapping marker can't burn work every loop.
- Config additions on `ForemanConfigSchema` (`src/shared/protocol.ts`): `triage: 'off' | 'shadow'
  | 'on'` (default `shadow` on first ship) and an optional `triageModel`. Env
  `FOREMAN_TRIAGE_MODEL` to override the model.
- Telemetry: stamp each session's note/audit with which tier disposed it and why, so hit rate and
  cost are measurable, and shadow-mode divergences are auditable.

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

If a busy fleet is ~40% human-only reviews (Tier 0/1, near-zero cost), ~20% routine access (Tier 1
Haiku), and ~40% real judgment (Tier 2), Opus reviews drop ~60%, replaced by far cheaper Haiku
calls on smaller transcripts — and the remaining Tier 2 reviews can start from Tier 1's trimmed
context. All failure modes are fail-safe: a cheap-tier miss costs a wasted Opus call or a hand-back
to you, never a wrong action.

## Non-goals

- No batching of multiple sessions into one triage call — it would break the fresh-context,
  injection-isolated "one session per process" guarantee Foreman deliberately built. Keep one
  session per subprocess.
- No change to delivery, the trust ladder, or the escalation/alert UX — this is purely a gate in
  front of the existing reviewer.
- Codex support is tracked separately (`todo/foreman-upgrades.md` #5); the tiers are agent-agnostic
  but depend on a transcript endpoint that Codex doesn't yet expose.

## Open questions

- How real is the flapping risk in practice? Depends on how `lastActivity` is computed upstream —
  worth measuring before tuning the debounce window or building Tier 1. (Step 0's floor is a safe
  default regardless.)
- Tier 1 model + prompt: is a single Haiku routing prompt reliable enough on `routine-access`
  classification, or does the destructive-denylist backstop need to carry most of the weight?
- Should Tier 0's "human-only" Purpose be written by Haiku (a summary) or skipped entirely when
  Foreman has nothing to add beyond "this is a plan review for you"?
