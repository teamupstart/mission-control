# Plan: Fleet Report + Backlog (`/bearings` analog)

Status: proposed
Owner: ai-harness
Depends on: [`../dispatch/plan.md`](../dispatch/plan.md) - reuses the `tasks` model,
the `session.task` binding, and the `/api/tasks` endpoints. Implement dispatch first.
Related: First Mate idea #4 (`/bearings` + `/stow` intent/outcome).

## Goal

Two surfaces that give you the whole fleet at a glance, the way First Mate's `/bearings`
does, plus a real **backlog**:

1. **Backlog** - see and manage tasks that are `queued` (created but not dispatched):
   dispatch one when you're ready, or drop it. Dispatch already supports "Add to backlog"
   (the `queue` flag); this plan builds the view and management around it.
2. **Fleet Report** - one click assembles a structured snapshot: who needs you, who's
   working, what's idle, the backlog, and recent outcomes. Available as a UI panel, as
   JSON (`GET /api/report`), and as copyable markdown (`GET /api/report.md`) so you can
   paste "current bearings" into a chat or notes.

Both are **pure reads over state that already exists** - no new polling, no new agents.
The report is a projection of `registry.snapshot()` (sessions + reviews + tasks) plus the
no-mistakes summaries already denormalized onto each session.

## Why it fits (and why it depends on dispatch)

- The **intent** side of `/bearings` ("what is each agent doing") is exactly
  `session.task`, delivered by dispatch. Without the tasks model there's nothing to report
  beyond raw session state - hence the hard dependency and serial build.
- The report needs no new data source: `Registry.snapshot()` already returns sessions
  (with state, activity, `nomistakes`, `pendingReviews`) and, after dispatch, `tasks`.
- "Needs you" is already computed per-card by `stateDisplay()` (attention tone from
  `awaiting_input` / pending reviews). The report reuses the same rules server-side so the
  UI and the markdown agree.

## Data model

Reuses `Task` / `TaskSummary` from the dispatch plan unchanged. Adds a read-only report
shape (no storage):

```ts
// src/shared/types.ts
export interface ReportItem {
  sessionId: string | null;
  name: string;                 // session name or task title
  kind: TaskKind | null;
  branch: string | null;
  activity: string | null;
  reason: string;               // e.g. "needs input", "2 to review", "gate parked at review"
  taskTitle: string | null;
  outcome: string | null;
  outcomeUrl: string | null;
}

export interface FleetReport {
  generatedAt: number;
  counts: { sessions: number; working: number; idle: number; needsYou: number; exited: number; queued: number };
  needsYou: ReportItem[];       // needs-input, pending reviews, parked no-mistakes gates
  working: ReportItem[];        // running tasks / busy sessions, with intent
  idle: ReportItem[];           // alive, waiting
  backlog: Task[];              // status === "queued"
  recent: Task[];               // status in done/failed/cancelled, newest first (capped)
}
```

## Backend changes

### `src/server/report.ts` (new) - pure functions
- `buildReport(snapshot): FleetReport` - buckets sessions using the **same** attention
  logic as `stateDisplay` (extracted into a shared helper in `src/shared/` or duplicated
  minimally with a comment linking the two, so UI and report never diverge). Joins each
  live session to its `task` summary; pulls parked-gate reasons from `session.nomistakes`.
- `renderReportMarkdown(report): string` - a compact, copy-pasteable digest:
  ```
  # Fleet bearings - 2026-07-11 14:03
  Needs you (2)
  - agent "auth-refactor" (ship) - 2 to review  [feat/auth]
  - "flaky-tests" - gate parked at review
  Working (3) ...
  Backlog (4) ...
  Recent outcomes (2)
  - "rate-limit" done - opened PR #123
  ```

### `src/server/routes.ts`
- `GET /api/report` -> `c.json(buildReport(registry.snapshot()))`.
- `GET /api/report.md` -> `c.text(renderReportMarkdown(...))`.
  Both localhost reads, no token, mirroring `GET /api/sessions`.

No new storage or endpoints for the backlog itself: it's `GET /api/tasks` filtered to
`queued`, and the management actions (`/dispatch`, `DELETE`) come from the dispatch plan.

## Frontend changes

- `src/web/App.tsx` topbar:
  - a **`Report`** button opening `ReportPanel`.
  - a **`Backlog (n)`** stat/button (n = queued tasks) opening the panel scrolled to the
    backlog section (or a dedicated tab within it).
- `src/web/components/ReportPanel.tsx` (new): slide-over rendering the `FleetReport`:
  - **Needs you** (attention-toned rows; each row deep-links: focus the session, or open
    its reviews via the existing `ReviewModal`).
  - **Working** (agent rows with intent chip + activity + branch).
  - **Idle**.
  - **Backlog**: each queued task with **Dispatch** (calls `api.dispatchQueued`) and
    **Delete**; a **`+ New`** shortcut into `DispatchModal` pre-set to "Add to backlog".
  - **Recent outcomes**: done/failed tasks with outcome + link.
  - **Copy as markdown** button (fetches `/api/report.md`, writes to clipboard).
  - Built from the live `tasks` + `sessions` already in `useEventStream` state; the panel
    can compute the buckets client-side from the same snapshot for instant/no-flicker
    updates, and use `/api/report.md` only for the copy action (single source of truth for
    the text digest). Client bucketing reuses the shared attention helper from `report.ts`.
- **Outcome capture** (the `/stow` intent/outcome bit): in the report's **Working**
  section, each agent row whose task is still `running`/`dispatching` gets a small
  **Mark done…** affordance that collects `{ outcome, outcomeUrl? }` and calls
  `api.completeTask`. (Kept in the panel rather than on the card to avoid cluttering the
  grid; the panel is where you review outcomes anyway.) This is what makes "recent
  outcomes" populate and closes the loop from intent -> result.
- `src/web/styles.css`: panel + section + row styles on the existing palette.

## Edge cases

- **No tasks yet**: report still works - `backlog`/`working` may be empty; sessions with no
  bound task appear in working/idle by their live state with `kind: null` (raw sessions the
  user started by hand are first-class in the report, not hidden).
- **UI/markdown drift**: both derive buckets from one shared attention helper; a unit test
  asserts a synthetic snapshot yields matching buckets in `buildReport` and the client
  helper.
- **Capping `recent`**: newest N (e.g. 20) so the digest and panel stay bounded; note the
  cap in the markdown footer if truncated (no silent truncation).
- **Clipboard**: `navigator.clipboard` may be blocked; fall back to selecting the text in a
  readonly area.

## Testing

- **Unit**:
  - `buildReport` over a synthetic snapshot (mix of needs-input, pending review, parked
    gate, running task, queued task, done task) -> correct buckets + counts.
  - `renderReportMarkdown` shape (sections present, counts match, truncation note).
  - shared attention helper parity (server bucket == client bucket) on the same input.
- **E2E (guardrailed)**: with a dispatched throwaway task (from the dispatch E2E) plus a
  synthetic pending review, open the panel: assert the task shows under Working with its
  intent, the review under Needs you, then Mark done -> it moves to Recent outcomes and
  `/api/report.md` reflects it. Clean up the repo/session/worktree afterward.

## Out of scope (future)

- `/stow` full knowledge-capture (sweeping a session's transcript into disk homes);
  scheduled/AFK digests (idea #2); historical/date-gated reports; multi-day trends.
```
