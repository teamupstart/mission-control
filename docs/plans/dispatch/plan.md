# Plan: Dispatch (agent launch)

Status: proposed
Owner: mission-control
Related: [First Mate](https://github.com/kunchenguid/firstmate) idea #1; shares its
task/backlog data model with [`../mission-report/plan.md`](../mission-report/plan.md) (idea #4).

## Goal

Turn the read-only dashboard into a launch pad. From the UI you pick a repo, type a
task, and hit **Dispatch**. The daemon provisions an **isolated git worktree**, opens a
**detached tmux session** running the agent (`claude`/`codex`) in that worktree, and
injects the task as the agent's first prompt. The new session shows up on the grid within
one poll, **bound to a persistent task record** that carries its intent (and later its
outcome).

This is First Mate's "dispatch an agent into its own session + worktree", built from
primitives this repo already has, and driven through the same dashboard the human already
watches.

## Why it fits this codebase (reuse, not rebuild)

- **Worktree isolation** already exists: `scripts/new-session.mjs` leases a treehouse
  worktree and `scripts/worktree-setup.mjs` warms + gates it. We reuse that machinery
  from the daemon instead of a human terminal.
- **Discovery is automatic**: `src/server/discovery/correlate.ts` joins process -> tty ->
  pane. A **detached** tmux session still owns a pty and appears in `tmux list-panes -a`
  and `ps`, so a dispatched agent is discovered with no extra plumbing (~1.5s poll).
- **Naming is free**: a session's name is its tmux session name
  (`correlate.ts`), so naming the tmux session after the task gives the card a good title.
- **Sending is solved**: `src/server/actions.ts#sendText` already types into a session's
  pane via `tmux send-keys`. We reuse it verbatim to inject the initial prompt.
- **Focus is solved**: `actions.ts#focus` already knows how to surface a detached tmux
  session in a wezterm tab (`spawnWeztermTab(["tmux","attach",...])`). So a dispatched
  headless session is one click from being visible.
- **Live contract is solved**: session summaries already carry denormalized side-data
  (`pendingReviews`, `nomistakes`) over SSE. The task summary rides the same channel.

The one new capability is **spawning** a session; everything else is composition.

## The shared task data model (spine for #1 and #4)

A task is a durable unit of intent that a session executes. Defined here because Dispatch
writes it; the mission-report plan reads and extends it.

### Type (`src/shared/types.ts`)

```ts
export type TaskKind = "ship" | "scout";          // ship = deliver a change; scout = investigate/report
export type TaskStatus =
  | "queued"        // in the backlog, not dispatched
  | "dispatching"   // worktree/session being provisioned
  | "running"       // bound to a live session
  | "done"          // completed with an outcome
  | "cancelled"
  | "failed";       // provisioning or launch failed (see error)

export interface Task {
  id: string;                 // uuid
  title: string;              // short label (slug source + card title); derived from intent if omitted
  intent: string;             // the full task prompt sent to the agent
  kind: TaskKind;
  agent: AgentType;           // "claude" | "codex"
  repoRoot: string;           // absolute path of the source repo
  worktreePath: string | null;// isolated worktree the agent runs in (correlation key); null while queued
  branch: string | null;      // worktree branch, once known
  tmuxSession: string | null; // the detached tmux session name we created
  sessionId: string | null;   // bound live session's synthetic id, once discovered
  status: TaskStatus;
  outcome: string | null;     // free text set on completion (e.g. "opened PR #123")
  outcomeUrl: string | null;  // optional link
  error: string | null;       // failure reason when status = failed
  createdAt: number;
  updatedAt: number;
  dispatchedAt: number | null;
  completedAt: number | null;
}

/** Compact task view denormalized onto a Session card (like NmRunSummary). */
export interface TaskSummary {
  id: string;
  title: string;
  kind: TaskKind;
  status: TaskStatus;
  outcome: string | null;
  outcomeUrl: string | null;
}
```

### Session gains a task pointer

```ts
export interface Session {
  // ...existing...
  task: TaskSummary | null;   // the task this session is executing, matched by cwd === worktreePath
}
```

### SSE contract (`ServerEvent`, snapshot)

```ts
export type ServerEvent =
  | { type: "snapshot"; sessions: Session[]; reviews: ReviewItem[]; tasks: Task[] }
  | { type: "session_upsert"; session: Session }
  | { type: "session_remove"; id: string }
  | { type: "review_upsert"; review: ReviewItem }
  | { type: "review_remove"; id: string }
  | { type: "task_upsert"; task: Task }
  | { type: "task_remove"; id: string };
```

### Storage (`src/server/db.ts`)

New `tasks` table alongside `reviews`/`session_events` (same `openDb()` migration block):

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  intent        TEXT NOT NULL,
  kind          TEXT NOT NULL,
  agent         TEXT NOT NULL,
  repo_root     TEXT NOT NULL,
  worktree_path TEXT,
  branch        TEXT,
  tmux_session  TEXT,
  session_id    TEXT,
  status        TEXT NOT NULL,
  outcome       TEXT,
  outcome_url   TEXT,
  error         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  dispatched_at INTEGER,
  completed_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_status   ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_worktree ON tasks(worktree_path);
```

Helpers: `insertTask`, `updateTask(patch)`, `getTask`, `listTasks`, `loadActiveTasks`
(status in queued/dispatching/running - reloaded into the registry on start so a restart
doesn't drop the backlog or a running agent's intent).

Rationale for storing the coarse *task* lifecycle only (not runtime state): the live
session already reports working/idle/needs-input. The task adds intent + kind + outcome.
"Blocked/working" stays a display concern derived from the live session, never duplicated.

## Backend changes

### `src/server/registry.ts`
- Add `private tasks = new Map<string, Task>()`; load `loadActiveTasks()` in the ctor.
- `snapshot()` returns `{ sessions, reviews, tasks }`.
- `upsertTask(task)` / `getTask(id)` / `getTaskByWorktree(cwd)` / `removeTask(id)`,
  emitting `task_upsert` / `task_remove`.
- In `mergeDiscovered`, attach `task`: `base.task = taskSummary(this.getTaskByWorktree(base.cwd))`
  for tasks in an active status. Read-only over the tasks map - no circular writes.
- Add `task` to `sessionEqual` so the card re-renders when intent/outcome changes.

### `src/server/tasks.ts` (new) - `TaskManager`
Mirrors `ReviewManager`: owns lifecycle, persists via db, publishes via `registry.upsertTask`.
- `create(input): Task` - status `queued` or `dispatching`.
- `patch(id, fields): Task | null` - update + persist + emit.
- `list()`, `get(id)`.

### `src/server/dispatcher.ts` (new) - the only genuinely new mechanism
`dispatch(task)` runs the provisioning pipeline (async, best-effort, always resolves; on
error sets the task `failed` with a reason):

1. **Provision an isolated worktree** via
   `provisionWorktree(repoRoot, taskId, slug, shortId, pins)`, where `pins` reads the
   worktrees the harness is already holding (live session cwds + task-held trees) so a
   reap here cannot evict a tree someone is standing in:
   - Fast path: if the repo opted into treehouse (a `treehouse.toml` at its root),
     `treehouse get --lease --lease-holder <LEASE_HOLDER>` (cwd = repoRoot) - a pre-warmed
     pooled tree. The holder label comes from the `LEASE_HOLDER` constant in
     `src/shared/harness-runtime.mjs` (currently `mission-control`), never a literal: it is
     the mark the reaper matches on, so a lease taken under any other label can never be
     reclaimed.
   - If the pool hands back nothing it is usually **leaked**, not empty - leases are
     durable, so agents that went away still hold slots. Reap them (`reapPool(repoRoot,
     pins)`) and ask once more before giving up on the pool.
   - Always-available fallback: `git -C <repoRoot> worktree add <MISSION_HOME>/worktrees/<taskId> -b harness/<slug>-<shortId> HEAD`,
     with a warning naming what the pool actually reported - the fallback is a throwaway
     checkout with none of the pool's pre-warming, so it must never be silent.
   - Returns `{ path (realpath), branch, provider }`. The path is stored as a **realpath**
     so it matches a pane's reported `cwd` exactly (macOS `/tmp`->`/private/tmp`).
   - Isolation is the harness's whole reason to exist, so a task **always** gets its own
     tree; treehouse is an optimization, not a requirement.
   - Deliberately **no** auto `npm install` / `no-mistakes init` here: dispatch stays fast
     and never gates or mutates an arbitrary repo behind the user's back (treehouse trees
     are already warm; the agent installs what it needs). Warm/gate remains available via
     `make session` for the opted-in treehouse workflow.
2. **Record** `worktreePath`, `branch`, status `dispatching`; emit.
3. **Spawn a detached tmux session**:
   `tmux new-session -d -s <tmuxSession> -c <worktreePath> <agentBin>`
   where `<tmuxSession>` = unique slug (`<title-slug>` or `<title-slug>-<shortid>` on
   collision, checked against `tmux list-sessions`). Record `tmuxSession`.
4. **Wait for readiness**: subscribe to the registry (or poll `snapshot()`) until a session
   with `cwd === worktreePath` appears (proves the pane + agent booted), then a short settle
   delay so the agent's input box is ready. Cap the wait (e.g. 20s); on timeout -> `failed`.
5. **Inject the prompt**: `sendText(session, task.intent, submit=true)` - reuses `actions.ts`.
6. **Bind + promote**: set `sessionId`, status `running`, `dispatchedAt`; emit.

Notes:
- Correlation is by **worktree path** (`cwd`), unique per task -> unambiguous binding with
  zero env plumbing. Discovery attaches the summary; the dispatcher owns the state
  transition (no registry->manager cycle).
- `send-keys` after a readiness check (not a blind sleep) is the robust way to seed the
  first prompt without depending on hooks or on agent-specific launch flags.

### `src/server/routes.ts` (localhost-only, like the other actions)
- `POST /api/tasks` - body `DispatchSchema`. `queue:true` -> create `queued` (backlog only).
  Else create `dispatching` and kick `dispatcher.dispatch(task)` (fire-and-forget; progress
  streams over SSE).
- `POST /api/tasks/:id/dispatch` - dispatch a queued task.
- `POST /api/tasks/:id/cancel` - if running, `kill(session)` + `tmux kill-session -t <name>`;
  status `cancelled`. Worktree removal is **opt-in** (`?removeWorktree=1`) so we never delete
  work by default.
- `POST /api/tasks/:id/complete` - `{ outcome, outcomeUrl? }`, status `done` (used by #4).
- `GET /api/tasks` - list (backlog + active + recent).
- `DELETE /api/tasks/:id` - remove a queued/terminal task from the list.

### `src/shared/protocol.ts`
```ts
export const DispatchSchema = z.object({
  repoRoot: z.string().min(1),
  intent: z.string().min(1),
  title: z.string().optional(),
  kind: z.enum(["ship", "scout"]).default("ship"),
  agent: z.enum(["claude", "codex"]).default("claude"),
  queue: z.boolean().optional().default(false),
});
export const CompleteTaskSchema = z.object({
  outcome: z.string().min(1),
  outcomeUrl: z.string().url().optional(),
});
```
Server validates `repoRoot` is an existing git repo before provisioning.

### `src/server/index.ts`
Instantiate `TaskManager` + `Dispatcher`, pass into `buildApp`.

## Frontend changes

- `src/web/lib/api.ts`: `dispatchTask`, `queueTask`, `listTasks`, `dispatchQueued(id)`,
  `cancelTask(id)`, `completeTask(id, outcome)`, `deleteTask(id)`.
- `src/web/useEventStream.ts`: maintain a `tasks` Map from `snapshot` + `task_upsert` /
  `task_remove`; expose `tasks` on `MissionState`.
- `src/web/App.tsx`: a **`+ Dispatch`** button in the topbar opens `DispatchModal`.
- `src/web/components/DispatchModal.tsx` (new): repo (datalist of repos the daemon already
  sees - distinct repo roots of live sessions - plus free text), agent, kind (ship/scout),
  optional title, intent textarea, and **Dispatch now** vs **Add to backlog**. Shows the
  provisioning/failed state inline.
- `src/web/components/SessionCard.tsx`: when `session.task` is set, render an **intent chip**
  (kind glyph + title + task status) under the title, and the outcome (with link) when done.
- `src/web/styles.css`: modal + intent chip styles, matching the existing token palette.

## Edge cases & safety

- **Unique tmux name** vs the user's real sessions: slug + short-id, checked against
  `tmux list-sessions`. Dispatched sessions are ours; we never send keys into the user's
  existing sessions (honors the project guardrail).
- **Provisioning failure** (bad repo, worktree add fails, agent binary missing): task ->
  `failed` with `error`, surfaced on the backlog/report; worktree cleaned only if we created
  it and it's empty.
- **Prompt-injection timing**: readiness is a discovery match + settle, not a fixed sleep;
  timeout -> `failed` (session may still be usable, so we keep it and report the miss).
- **Session exits while running**: task stays `running` (agent may have finished or crashed);
  completion is explicit (`/complete`) or via #4's outcome capture - we never guess success.
- **Restart-proof**: active tasks reload from db; `dispatching` tasks with no bound session
  after startup are re-reconciled (re-bind by cwd if the tmux session still exists, else
  mark `failed`).
- **No wezterm/tmux**: dispatch requires tmux (the harness's hard-default backend). If tmux
  is absent, `POST /api/tasks` returns a clear error. wezterm-tab dispatch is future work.

## Testing

- **Unit** (`node --test`, mirrors existing `test/`):
  - task db round-trip (insert/patch/load-active).
  - `DispatchSchema` defaults/validation; title slugging + collision suffix.
  - dispatcher state machine with an **injected spawner + fake registry**: simulate a
    discovered session at the worktree cwd -> asserts prompt sent once + status `running`;
    simulate timeout -> `failed`. No real tmux in unit tests.
  - `registry.mergeDiscovered` attaches the right `TaskSummary` by cwd; `sessionEqual`
    reacts to task changes.
- **E2E (guardrailed, manual/scripted)**: create a throwaway git repo under the scratchpad,
  `POST /api/tasks`, assert a detached tmux session appears on the grid named by the task,
  bound with the intent chip, and the prompt lands. Then `cancel?removeWorktree=1` and
  delete the repo. **Never** dispatch into or send keys to the user's real sessions.

## Out of scope (future)

- wezterm-tab dispatch backend; ship/scout behavioral differences beyond labeling;
  automatic outcome/PR detection; secondmates; the AFK auto-supervisor (idea #2).
```
