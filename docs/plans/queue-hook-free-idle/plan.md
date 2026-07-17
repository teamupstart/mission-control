# Work-queue delivery deadlock: hook-free idle detection

## The bug

Two items queued for the **"3 New UIs"** session were never delivered. They are not a
one-off: the same state stalls **every** queue whose session goes quiet or whose daemon
restarts.

The work queue only delivers when `settledIdle(session)` is true, and that predicate
requires `session.instrumented`:

```ts
export function settledIdle(s: Session, now: number, settleMs: number): boolean {
  if (!s.instrumented) return false;            // <-- the gate
  if (s.state !== "idle") return false;
  const since = s.lastActivity ?? s.firstSeen;
  return now - since >= settleMs;
}
```

`instrumented` is true only while a **hook overlay is fresh** - a hook has arrived within
`OVERLAY_TTL_MS` (30 min). Hook overlays are the daemon's *only* source of session
`state`: they live in memory, and when one is missing or stale, `mergeDiscovered` rebuilds
the session with a **hardcoded default**:

```ts
const base: Session = {
  ...
  state: "working",       // registry.ts - a placeholder, not an observation
  instrumented: false,
  lastActivity: prev?.lastActivity ?? null,
  ...
};
```

So a session that is genuinely sitting idle at its prompt reports `state: "working"`,
`instrumented: false`. `settledIdle` returns false, and `decideQueueTick` returns
`{ kind: "none" }` - **silently, forever**. Nothing escalates (the session isn't
`exited`, hooks *were* seen, there's no in-flight item to time out); the queue just never
advances.

### Reproduced

Feeding the live "3 New UIs" session shape (captured from `GET /api/sessions`) straight
into the real `decideQueueTick`:

| input | result |
| --- | --- |
| real session (`instrumented:false`, `state:"working"`, 2 queued items, has pane, hooks seen) | `{ kind: "none" }` |
| same session, simulated a week later | `{ kind: "none" }` - time does not heal it |
| same session with a fresh hook (`instrumented:true`, `state:"idle"`) | `{ kind: "send" }` |

The deadlock is permanent because the only thing that refreshes the overlay is a hook, an
idle session at a prompt fires no hooks, and the queue is the very thing that would give
it something to do that would fire one.

### Two triggers, one cause

1. **Daemon restart** wipes all in-memory overlays at once, so every session rebuilds
   `instrumented:false` until it *individually* fires a fresh hook.
2. **A long-quiet session** ages its overlay past the 30-min TTL and flips back to
   `instrumented:false` on its own.

Both are the same root cause: **session `state` has exactly one source (live hooks), and
that source is neither durable nor guaranteed.**

## The fix: make the transcript a durable, hook-independent state source

The daemon already reads every live Claude session's transcript **every 4 s** in the
passive runtime-meta poller (`startRuntimeMetaPoller`), today only to extract model /
context %. The transcript is an on-disk, append-only record of exactly what we're missing:
what the session did last and when. We make it a second source of session state, used
whenever a fresh hook overlay is absent.

Hooks stay the primary source - they are exact, instant, and carry permission mode. The
transcript is the fallback that makes idle detection **survive dropped hooks and daemon
restarts**, because it is re-derived from disk on every poll tick and needs no memory.

### Three changes

1. **`readSessionActivity(path)`** (new, `transcript.ts`, pure + unit-tested): from a
   bounded tail read, return `{ state: "idle" | "working"; lastActivity: number }`.
   *Idle* when the newest main-chain record is a completed assistant turn; *working* when
   a user / tool-result record is pending after it. `lastActivity` is that record's
   timestamp.

2. **Transcript resolution tolerant of a stale binding**
   (`resolveTranscriptPath`). Today it derives `‹cwd›/‹agentSessionId›.jsonl` and returns
   null if that file is missing - which is exactly what happens after a `/clear` re-mints
   the agent-session id while the daemon still holds the old one. Add a fallback: the
   newest recently-modified `.jsonl` in the cwd's project directory. This is what lets a
   live-but-stale-bound pane be read at all. (Headless Foreman `claude -p` runs write to a
   temp `/private/var/folders/.../T/` project dir, **not** the worktree's, so they do not
   pollute this fallback.)

3. **Registry applies the passive state** when no fresh hook overlay exists. In
   `mergeDiscovered`, instead of the hardcoded `state:"working"`, seed `state`,
   `lastActivity`, and `instrumented` from the transcript read. A fresh hook overlay still
   wins outright (unchanged precedence). Net effect: `instrumented` now means *"we have
   current session state from a hook **or** the transcript"*, and `settledIdle` can be
   satisfied without a live hook.

`settledIdle`, `decideQueueTick`, and every downstream invariant are **unchanged** - they
simply now receive a truthful `state`/`instrumented` for quiet sessions.

### Flow: where session state comes from

```
BEFORE
  hook event ──▶ in-memory overlay (30-min TTL) ──▶ session.state / .instrumented
  (no hook)  ──▶ hardcoded "working", instrumented:false ──▶ settledIdle = false ──▶ queue stalls

AFTER
  hook event ─────▶ in-memory overlay (fresh) ─────────────┐  (primary, wins)
                                                           ├─▶ session.state / .instrumented ─▶ settledIdle
  transcript poll ▶ readSessionActivity() (durable) ───────┘  (fallback, no fresh hook)
```

## This specific session

"3 New UIs" is also **identity-corrupted**, independent of the deadlock: its queue is keyed
to agent-session `726e0505`, which ended via `/clear`; the live pane (`%43`) now runs a
different session in the same worktree, and that pane has been firing no hooks since the
clear. Change 2 (stale-binding-tolerant resolution) is what lets the fix read its live
transcript despite the dead binding.

Its prompt box also currently holds stray text (`There are 2 items`); since delivery pastes
into the box, that must be cleared first or a send would concatenate and mangle the prompt.

After the fix lands and the daemon restarts, the plan is to verify the queue delivers on
its own; if the corruption still blocks it, deliver the two items into pane `%43` directly
(clear the stray text first) and reconcile the queue rows so the dashboard matches reality.

## Out of scope (noted, not fixed here)

- **Stale agent-session binding on `SessionEnd`.** A `/clear`'d session's binding is never
  invalidated, so its queue looks healthily attached instead of being offered for
  re-attach. Change 2 works around it for reads; the durable fix is a separate follow-up.
- **Why pane `%43` stopped firing hooks entirely.** An operational quirk of that one
  long-lived process (it reported normally until the `/clear`), not a harness code path.
  The whole point of this fix is that the queue no longer depends on that pane reporting.

## Testing

- Unit: `readSessionActivity` over fixture transcripts (idle tail, working tail, empty,
  malformed, sidechain-only).
- Unit: `resolveTranscriptPath` fallback (missing derived path → newest-in-dir; no
  candidates → null; stale/old candidate excluded by recency).
- Machine: the existing repro assertion - a quiet-but-alive session with a readable
  transcript now yields `{ kind: "send" }`, and one with no transcript still yields
  `{ kind: "none" }` (no false sends).
- E2E: restart the daemon against the live DB and confirm previously-stalled queues on
  genuinely idle sessions deliver.
