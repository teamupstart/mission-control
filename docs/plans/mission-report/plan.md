# Plan: Mission Report + Backlog (`/bearings` analog)

Status: proposed
Owner: ai-harness
Depends on: [`../dispatch/plan.md`](../dispatch/plan.md) - reuses the `tasks` model,
the `session.task` binding, and the `/api/tasks` endpoints. Implement dispatch first.
Related: First Mate idea #4 (`/bearings` + `/stow` intent/outcome).

## Goal

Two surfaces that give you every session at a glance, the way First Mate's `/bearings`
does, plus a real **backlog**:

1. **Backlog** - see and manage tasks that are `queued` (created but not dispatched):
   dispatch one when you're ready, or drop it. Dispatch already supports "Add to backlog"
   (the `queue` flag); this plan builds the view and management around it.
2. **Mission Report** - one click assembles a structured snapshot: who needs you, who's
   working, what's idle, the backlog, and recent outcomes. Available as a UI panel, as
   JSON (`GET /api/report`), and as copyable markdown (`GET /api/report.md`) so you can
   paste "current bearings" into a chat or notes.

## Why it fits (and why it depends on dispatch)

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

## Backend changes

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
- `src/web/components/ReportPanel.tsx` (new): slide-over rendering the `MissionReport`:
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
