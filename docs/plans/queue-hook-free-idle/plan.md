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

### The changes

Two new pieces of plumbing feed the transcript-derived state in, and the predicate that
gates delivery is relaxed to honour it:

1. **`readSessionActivity(path)`** (new, `transcript.ts`, pure + unit-tested as
   `computeSessionActivity`): from a bounded tail read, return
   `{ state: "idle" | "working"; lastActivity: number }`. *Idle* only when the newest
   main-chain record is a cleanly-ended assistant turn (`stop_reason` `end_turn` /
   `stop_sequence`); *working* for every ambiguous tail - a pending user or tool-result
   record - so we never read idle mid-turn. `lastActivity` is that record's timestamp.

2. **Registry applies the passive state** when no fresh hook overlay exists. In
   `mergeDiscovered`, instead of the hardcoded `state:"working"`, seed `state` and
   `lastActivity` from the transcript read (`applyPassiveActivity`). A fresh hook overlay
   still wins outright (unchanged precedence). It deliberately does **not** touch
   `instrumented`: that stays *"a fresh hook exists"* for the UI "uninstrumented" badge
   and `reportBucket`.

And `settledIdle()` is relaxed to match: it **no longer requires `instrumented`** and now
trusts `state === "idle"` directly. That is safe because `idle` is only ever set from a
real source - a fresh hook overlay or the transcript-derived passive state - while the
rebuild default is `working`, so an `idle` is always a claim, never an absence of data.
The old `instrumented` gate was redundant while hooks were the sole source of `idle`, and
became wrong once the transcript was a second source: it stranded exactly the hook-free
idle this fix exists to honour. Because `settledIdle` is shared, this also heals the same
latent stall in skills-reload, which records its ack in the DB before typing (not via a
hook), so a hook-free session is never re-injected.

`decideQueueTick` and every downstream invariant are otherwise unchanged - they simply now
receive a truthful `state` for quiet sessions.

### Considered and rejected: a newest-sibling transcript fallback

An earlier draft added a third change - when the bound `agentSessionId` no longer names a
file (the `/clear` case, where a clear re-mints the id while the daemon still holds the old
one), `resolveTranscriptPath` would fall back to the newest recently-modified `.jsonl` in
the cwd's project dir. It was **dropped in review as unsafe**: two panes can share a cwd,
so "newest sibling" can resolve to a *different, busy* session's transcript, read it as
idle, and get a queued item typed into a pane that is mid-turn - violating the guarantee
that we never paste into a busy pane. Resolution now stops at the derived path and returns
null when it is missing; a `/clear`-corrupted binding simply reads no transcript (below).

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
clear. With the newest-sibling fallback dropped, the stale `726e0505` binding resolves to
**no transcript** (the derived path is gone), so this session is **not** auto-recovered by
this fix - its two items must be delivered by hand.

Its prompt box also currently holds stray text (`There are 2 items`); since delivery pastes
into the box, that must be cleared first or a send would concatenate and mangle the prompt.

So the two items are delivered into pane `%43` directly (clear the stray text first) and
the queue rows reconciled so the dashboard matches reality. The durable value of this fix
is elsewhere: every **correctly-bound** session now keeps delivering across daemon restarts
and long-quiet periods, which is the general failure this change removes. The stale-binding
case itself is left to a follow-up (below).

## Out of scope (noted, not fixed here)

- **Stale agent-session binding on `SessionEnd`.** A `/clear`'d session's binding is never
  invalidated, so its queue looks healthily attached instead of being offered for
  re-attach - and, with no newest-sibling fallback, its transcript can't be read either.
  Invalidating the binding on `SessionEnd` (so the queue is offered for re-attach) is the
  durable fix and a separate follow-up.
- **Why pane `%43` stopped firing hooks entirely.** An operational quirk of that one
  long-lived process (it reported normally until the `/clear`), not a harness code path.
  The whole point of this fix is that the queue no longer depends on that pane reporting.

## Testing

- Unit: `computeSessionActivity` over fixture transcripts (idle tail, pending-tool-call and
  unanswered-tool-result working tails, sidechain / undatable tails skipped, empty /
  malformed → null).
- Unit: `resolveTranscriptPath` resolution (hook-reported path verbatim, cwd-derived
  fallback, null when neither locates a file or the session is non-Claude / id-less /
  cwd-less).
- Machine: the existing repro assertion - a quiet-but-alive session with a readable
  transcript now yields `{ kind: "send" }`, and one with no transcript still yields
  `{ kind: "none" }` (no false sends).
- E2E: restart the daemon against the live DB and confirm previously-stalled queues on
  genuinely idle sessions deliver.
