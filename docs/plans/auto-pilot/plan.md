# Plan: Auto-pilot / AFK alerts (zero-token supervision)

Status: proposed
Owner: ai-harness
Related: First Mate idea #2 (the zero-token watcher + `/afk`). Reuses the shared
bucketing from [`../fleet-report/plan.md`](../fleet-report/plan.md).
Note: per the request, **no SMS / phone push** - alerts are a **browser notification
+ a sound** only.

## Goal

Stop having to watch the grid. The dashboard actively **alerts you when the fleet
needs you** - a desktop (Chrome) notification plus a sound - the moment a session
goes to `needs-input`, a review lands, a no-mistakes gate parks, or a dispatched
task finishes. An **AFK mode** escalates (alerts on more, and sends periodic
digests) so you can step away.

This is First Mate's "a bash watcher sleeps on the fleet and wakes you only when
something needs you" - but the watcher is **the daemon we already run** (it detects
every one of these events and streams them over SSE), and the browser turns those
events into alerts. Zero extra tokens, no new agent, no polling.

## Why it fits (and why it's almost all client-side)

- The daemon already emits precise state over SSE: a session flipping to
  `awaiting_input`, a `review_upsert`, a `nomistakes` gate parking, a `task_upsert`
  reaching `done`/`failed`. The browser is already a live subscriber
  (`useEventStream`). So the alert layer is a **consumer of the existing stream** -
  no server changes required.
- "Who needs you" is already defined once in `@shared/session.ts`
  (`reportBucket` / `needsYouReason`, built for the fleet report). The alert engine
  reuses it, so alerts and the report agree on what "attention" means.
- The daemon runs as a login LaunchAgent and the dashboard is meant to be open, so
  a browser Notification from the open tab (foreground or background) is exactly the
  right delivery for a local, single-user fleet - which is why SMS/phone push isn't
  needed here.

## Architecture

All new code is in `src/web` (plus one reused shared helper). No server changes.

### `src/web/lib/alerts.ts` (new) - the alert engine (pure, unit-tested)
```ts
export type AlertKind = "needs-input" | "review" | "gate" | "task-done" | "task-failed" | "idle";
export interface Alert {
  id: string;          // stable per (kind, subject) so re-fires de-dupe via Notification tag
  kind: AlertKind;
  title: string;       // "auth-refactor needs you"
  body: string;        // one-line detail
  sessionId: string | null;
  severity: "attention" | "info";
}
export interface AlertSettings {
  notifications: boolean;
  sound: boolean;
  afk: boolean;
  digestMinutes: number;
}
/** Diff the previous vs current fleet snapshot and return only the NEW alerts. */
export function detectAlerts(prev: Fleet, next: Fleet, s: AlertSettings): Alert[];
/** Compact "3 need you · 2 working · 1 done" digest line (reuses report bucketing). */
export function digestLine(next: Fleet): string;
```
- **What fires when:**
  - Always (watching + AFK): a session entering `awaiting_input`; a new pending
    review; a no-mistakes gate newly parked; a dispatched task reaching `failed`.
  - AFK also fires on: a task reaching `done`; a session going `idle` after working;
    and a **periodic digest** every `digestMinutes`.
- **Transition-only**: alerts fire on the *edge* (not-attention → attention), computed
  by diffing `prev` vs `next` using `reportBucket`, so a session sitting in
  `awaiting_input` across many SSE ticks alerts once, not every tick.

### `src/web/useNotifier.ts` (new hook)
- Takes the live `sessions/reviews/tasks` + `AlertSettings`, keeps a `ref` of the
  previous snapshot, and on each change runs `detectAlerts`.
- For each new alert (when enabled + permitted):
  - **Browser notification**: `new Notification(title, { body, tag: alert.id })` -
    `tag` collapses repeats. Clicking focuses the window (`window.focus()`), and for
    a session alert scrolls/selects that card.
  - **Sound**: a short **Web Audio** chime (no asset file, so no CSP/bundle concern)
    - a two-note tone for `attention`, a single soft note for `info`. Rate-limited
    (≤ one chime / ~1.5s) so a burst doesn't machine-gun.
- **Digest timer** (AFK only): every `digestMinutes`, a `Fleet digest` notification
  with `digestLine(...)`.

### `src/web/lib/alertSettings.ts` (new) - persistence
- `AlertSettings` in `localStorage` (per-machine), with a `useAlertSettings()` hook.
  Defaults: notifications off (until permission), sound on, afk off, digest 15 min.

### `src/web/useAudioChime.ts` (or folded into the notifier)
- Lazily creates one `AudioContext`; `playChime(severity)` schedules a couple of
  oscillator+gain envelopes. `resume()` is called from the enable-click gesture to
  satisfy the browser autoplay policy.

### UI - a bell control in the topbar
- `src/web/components/AlertBar.tsx` (new): a bell button showing state
  (`alerts on` / `off` / `blocked`) with a small popover:
  - **Enable alerts** → `Notification.requestPermission()` (this click also
    unlocks/`resume()`s the AudioContext).
  - toggles: notifications, sound, **AFK mode**, digest interval.
  - AFK toggle also shows in the header as a mode chip (`🌙 AFK` / `👁 watching`) and
    plays a distinct confirm tone on switch.
- Wired in `App.tsx` beside the Dispatch / Report controls; the notifier hook lives
  at the `App` level so it sees every update.

## Permission & autoplay handling

- `Notification` needs a secure context - `127.0.0.1` / `localhost` qualify, so the
  daemon's origin is fine.
- Browsers block audio until a user gesture: the **Enable alerts** button is that
  gesture (it `resume()`s the AudioContext), so the first chime isn't swallowed.
- If permission is **denied**: sound still plays, and an in-page toast is the
  fallback surface (so alerts degrade rather than vanish).
- A **closed** tab can't receive `new Notification` (that needs a Service Worker +
  Push + a push server - out of scope); the dashboard is expected to stay open.

## De-dup, rate-limit, edge cases

- Notification `tag = alert.id` (e.g. `needs-input:<sessionId>`), so a repeat replaces
  the old toast instead of stacking.
- `detectAlerts` only returns edges, so no re-alert while a condition persists; when a
  session leaves and re-enters attention, it alerts again (correct).
- On first connect (`snapshot`), seed the "previous" state **without** alerting, so
  opening the dashboard doesn't dump a notification per already-waiting session.
- Sound is rate-limited; digests are coalesced (one per interval).

## Testing

- **Unit** (`node --test`, jsdom-free pure logic):
  - `detectAlerts`: session→`awaiting_input` fires once; steady state fires nothing;
    new review / parked gate / `failed` fire; `done` + `idle` fire only in AFK;
    initial snapshot (no prev) fires nothing.
  - `digestLine` counts match the shared buckets.
  - settings gating (sound/notifications/afk flags flip what's produced).
- **DOM-level** (mocked `Notification` + `AudioContext` spies): the notifier hook
  calls `new Notification` with the right tag and `playChime` with the right severity
  for a synthetic transition; respects the enabled flags.
- **Manual/browser** (guardrailed): with the isolated daemon + a fake session driven
  to `needs-input`, confirm a real Chrome notification + chime. (Browser-notification
  assertions are unreliable under automation + the SSE-page injection limits seen
  earlier, so the pure/DOM tests carry the coverage.)

## Out of scope (future)

- Closed-tab delivery (Service Worker + Web Push + a push endpoint).
- **Auto-approving** reviews / gates by policy - deliberately deferred to keep a human
  in the loop; AFK only *alerts*, it doesn't act.
- SMS / phone push (explicitly excluded).
