# Plan: Foreman — an auto-responder that triages the "needs you" queue

Status: proposed
Owner: ai-harness (Mission Control)
Related: realizes the "auto-supervisor / secondmate" that both `docs/plans/auto-pilot/plan.md`
and `docs/plans/dispatch/plan.md` explicitly deferred ("Auto-approving reviews / gates by
policy — deliberately deferred to keep a human in the loop").

> Naming: I'm calling it **Foreman** (fits the ranch theme: Mission Control → the Foreman
> makes routine calls for the boss and escalates the big ones). Easy to rename; the external
> inspiration calls this a "First Mate."

## Context

Mission Control already tells you *who needs you* (the `needs-you` bucket) and lets you answer
by hand from the dashboard. But when several sessions block at once, most of what they're
asking is routine: "should I do A, B, C, or D?" (implementation trade-offs) or "can I run
this / touch this?" (access/approval). You end up hand-triaging a queue of questions you'd
almost always answer the same way, and by the time you get to a card you've forgotten what
that session was even for.

Foreman is a new agent that drains that queue for you. It watches the `needs-you` list, and
for each blocked session it reads the full transcript, understands the goal, and:

- **auto-answers** the routine calls — implementation trade-offs (defaulting to the most
  correct / secure / robust / non-duplicative option) and non-destructive access requests;
- **escalates** the genuine forks — a design decision that hinges on your intent, or anything
  destructive/risky — as a framed *decision brief* with its recommendation, and pings you;
- writes a 1–2 sentence **Purpose** for every session it inspects, surfaced in the expanded
  card so you can re-orient instantly.

It reviews **one session per fresh process**, so its context is truly reset between reviews
(no cross-session bleed). It **ships OFF in dry-run**: when first enabled it only *drafts*
answers onto the card so you can see its judgment before it ever types into a live session.

### Decisions locked with the user
- **Runtime:** headless per-item loop — a worker maintains the queue and spawns a fresh
  `claude -p` per session; each review is a new process ⇒ clean context every item.
- **Autonomy:** dry-run first — off by default; drafts before it sends; you flip to live
  (globally or per-repo) once you trust it.
- **Escalation:** non-blocking decision brief on the card + a browser alert; it moves on.

## Reasoning policy (encoded in the Foreman review prompt/skill)

Straight from the request — this is the agent's judgment contract:

- **Implementation trade-offs** (A/B/C/D with effort trade-offs): **auto-answer**, choosing the
  most correct, most secure, technically robust option that is **not duplicative**. If the only
  way to satisfy several options is a duplicative implementation per case, do **not** pick one —
  answer by asking for a **single unified abstraction / one API** with the per-case details on
  the backend.
- **Access / approval requests**: **auto-approve** when non-destructive and not an obvious,
  serious security risk. Anything destructive or risky (e.g. `rm -rf`, force-push, secret/
  credential access, prod deploy, data-dropping, network exfil, disabling a safety check) ⇒
  **escalate**, never auto-approve.
- **Design fork where only one path is truly viable, or the call depends on the user's intent**
  ⇒ do **not** auto-answer; **escalate** with a brief + recommendation.
- **When Foreman is itself unsure of the user's intent** ⇒ escalate (prompt the user) rather
  than assume.
- **Always** emit the Purpose, even when it can't answer.

## Architecture

Four pieces: (1) a persisted **session note** (Purpose + brief + audit) on the server, exposed
over the existing session contract; (2) a small **Foreman config/state**; (3) the **worker
loop** that spawns per-item reviews and applies their verdicts through the API; (4) **UI** to
show the Purpose/brief and control Foreman. Answering reuses endpoints that already exist.

### 1. Server — session notes (Purpose + decision brief + audit)

Notes must survive polls and restarts and stay attached to the *same Claude session* even as
the synthetic discovery id churns, so key them on `agentSessionId` when present, else the
synthetic `session.id`.

- **`src/server/db.ts`** — new table in the `openDb()` migration block:
  ```sql
  CREATE TABLE IF NOT EXISTS session_notes (
    note_key     TEXT PRIMARY KEY,   -- agentSessionId ?? synthetic session id
    purpose      TEXT,               -- 1–2 sentence "what is this session for + latest context"
    brief        TEXT,               -- decision brief markdown (escalated / dry-run proposal)
    recommendation TEXT,             -- Foreman's recommended answer
    disposition  TEXT NOT NULL,      -- 'answered' | 'escalated' | 'pending' | 'skipped'
    last_action  TEXT,               -- one-line audit ("approved Bash: npm test")
    handled_marker TEXT,             -- reviewId / last transcript turn id it acted on (idempotency)
    updated_at   INTEGER NOT NULL
  );
  ```
  Helpers mirroring the review/task ones: `upsertSessionNote`, `getSessionNote(key)`,
  `loadSessionNotes()` (rehydrate into the registry on start).
- **`src/shared/types.ts`** — add `SessionNote` + a compact `SessionNoteSummary`
  (`purpose, brief, recommendation, disposition, lastAction, updatedAt`) and a
  `note: SessionNoteSummary | null` field on `Session`. No new `ServerEvent` — the note rides
  the existing `session_upsert` (whole Session) just like `task`/`nomistakes` do.
- **`src/server/registry.ts`** — hold `notes: Map<noteKey, SessionNote>`; add `noteKeyFor(s)`
  and `noteSummaryFor(s)`; set `base.note` in `mergeDiscovered` (read-only over the map, like
  `taskSummaryForCwd`); add `upsertNote(...)` that persists + re-denormalizes onto every
  matching live session (like `syncSessionsForWorktree`) + emits; add `note` to `sessionEqual`.
- **`src/server/routes.ts`** (localhost-only, like the other actions):
  - `PUT /api/sessions/:id/note` — body `SetNoteSchema` (`purpose?, brief?, recommendation?,
    disposition?, lastAction?, handledMarker?`); resolves the note key from the session and
    upserts.
  - `GET /api/sessions/:id/transcript?turns=N` — **non-streaming** JSON transcript for the
    reviewer, returning `{ messages, truncated }` with the **head** (opening turns = the
    original goal) **and tail** (recent context). Thin wrapper over the existing tail reader.
- **`src/shared/protocol.ts`** — `SetNoteSchema` (all fields optional but at least one
  required).

### 2. Server — Foreman config + status

- Persisted config (a `foreman_config` single-row table, or a JSON file under `HARNESS_HOME`):
  `{ enabled: boolean; mode: 'dry-run' | 'live' | 'semi-auto'; repoAllowlist: string[];
  autoApproveAccess: boolean }`. Defaults: `enabled=false`, `mode='dry-run'`,
  `repoAllowlist=[]`, `autoApproveAccess=true` (still gated by the destructive-risk classifier).
- In-memory status for the dashboard: `{ running, queueDepth, lastRunAt, counts:{answered,
  escalated,skipped} }`.
- Routes: `GET/PUT /api/foreman/config`, `GET /api/foreman/status` (localhost-only).

### 3. The Foreman worker — `src/server/foreman/` + `npm run foreman`

Deterministic control flow (Node), launched via `npm run foreman` (a `scripts/foreman.mjs`
entry, so it's "an agent in a terminal"); daemon-supervised auto-launch behind the dashboard
toggle is a fast follow. Talks to the daemon over localhost + the harness token (reuse
`@shared/harness-runtime.mjs` `BASE_URL`/`readToken`).

Loop:
1. Read `/api/foreman/config`; if disabled, idle-poll until enabled.
2. Maintain the **queue** from the shared `reportBucket` `needs-you` set (single source of
   truth), oldest-waiting first — every needs-you `claude` session, dispatched agents included
   (helping them is the point). Skip only a prompt already covered by `handled_marker`; the
   allowlist gates live *sends*, not queue membership (off-allowlist sessions still get a drafted
   note). Foreman's own worker is a plain Node process, so it never appears in the queue.
3. Process **one** session at a time. For each:
   1. Gather context via API: the `Session`, `GET /api/sessions/:id/transcript`, its pending
      reviews (`/api/reviews` filtered to the session), and the pending question — the review
      **body** for an `input` review, else `session.activity` + transcript tail for a terminal
      `awaiting_input`/permission prompt.
   2. Spawn a **fresh** review: `claude -p --output-format json` with the Foreman review
      skill/prompt; pass the gathered context via a temp file (keeps argv small). The
      subprocess reasons and returns a strict JSON **verdict**; being a new process, its
      context is reset. Enforce the schema (re-prompt / mark `skip` on malformed output).
   3. **Verdict schema:**
      ```ts
      {
        purpose: string;
        classification: 'implementation'|'access'|'design-fork'|'intent-unclear'|'other';
        action: 'answer'|'escalate'|'skip';
        answer?: { channel: 'send'|'review'; text: string; reviewId?: string; submit?: boolean };
        recommendation?: string;   // shown for escalate + dry-run
        brief?: string;            // decision brief markdown for escalate
        confidence: number;        // 0–1
      }
      ```
   4. **Apply** the verdict through the API:
      - always `PUT …/note` with `purpose` (+ `handledMarker`);
      - `answer` **live** → send via `POST /api/sessions/:id/send` (terminal) or
        `POST /api/reviews/:id/resolve` (`answer`); note `disposition='answered'`,
        `lastAction=<summary>`;
      - `answer` **dry-run** → note `disposition='pending'` + `recommendation` + a proposed-
        answer brief; **send nothing**;
      - `answer` **semi-auto** → note a confirmable pending action (UI one-click approves);
      - `escalate` → note `disposition='escalated'` + `brief` + `recommendation`, and fire a
        browser alert;
      - `skip` → note `disposition='skipped'` (couldn't understand — left for the human).
   5. Move on. The review subprocess has already exited ⇒ context is gone.
4. Idle-sleep when the queue is empty.

Idempotency: an answered `input` review leaves `pending`, so it won't reappear; a sent
terminal answer flips the session to `working` (a `UserPromptSubmit`), dropping it from
`needs-you`. `handled_marker` guards the brief window before state flips and prevents
re-answering the same terminal prompt.

### 4. Web UI

- **`src/web/components/SessionCard.tsx`** (expanded panel, above `TranscriptPanel`): a
  **Purpose** block; when `disposition` is `escalated` or `pending` (dry-run), render the
  **decision brief** + **recommendation** with a Foreman badge; in `semi-auto`, add
  **Approve / Edit / Dismiss** on the proposed answer; when `answered`, a subtle
  `✓ Foreman answered: <lastAction>` attribution line. A `needs-you` card carrying an
  escalated brief also gets a small "decision needed" affordance in the collapsed header.
- **Topbar Foreman control** (beside Dispatch / Report / the AlertBar): a status chip
  (`off` / `dry-run` / `live`, queue depth) with a popover for `mode`, `repoAllowlist`,
  `autoApproveAccess`. Minimal in v1 — status + mode toggle.
- **`src/web/lib/api.ts`**: `getForemanConfig`, `setForemanConfig`, `getForemanStatus`,
  `setSessionNote`, `confirmForemanAction` (semi-auto).
- **Escalation alert**: reuse the `docs/plans/auto-pilot` alert engine if built; otherwise a
  minimal `new Notification(...)` + chime on an `escalated` note transition (the note arrives
  via the SSE `session_upsert` the UI already consumes).

### 5. Tests

- **Unit** (`node --test`, mirrors `test/`): `session_notes` db round-trip; registry
  denormalization + `sessionEqual` reacting to note changes; the transcript JSON endpoint
  (head+tail, cap); **verdict application** — a `(verdict, mode)` table asserting exactly which
  API calls fire (dry-run sends nothing; live sends once; escalate writes brief + alert);
  allowlist / self-session filtering; `handled_marker` idempotency; queue ordering.
  (The *classification* itself is prompt-driven, so unit tests cover the deterministic plumbing;
  a couple of recorded-transcript fixtures exercise the prompt in a live-model smoke test.)
- **E2E (guardrailed, throwaway only):** a scratch git repo + a **throwaway** tmux Claude
  session driven to `awaiting_input`. Dry-run → assert Purpose + proposed answer appear on the
  card and **nothing** was sent. Live → assert the answer lands via `/send` and the session
  leaves `needs-you`. **Never** target the user's real sessions (honors the project guardrail):
  live *sends* are confined to allowlisted repos, and Foreman's own worker is a plain Node
  process that never appears in the queue.

## Key reuse (don't rebuild)

- `reportBucket` / `needsYouReason` — `src/shared/session.ts` — the queue definition.
- `readTail` / `parseLines` / `toMessage` — `src/server/transcript.ts` — the JSON transcript endpoint.
- `sendText` / `selectPaneOption` (`src/server/actions.ts`) + `ReviewManager.resolve`
  (`src/server/reviews.ts`) — answering. Which one is not a style choice: a session sitting on a
  MENU (a permission prompt, an `AskUserQuestion`) cannot be answered with `sendText`, because the
  dialog discards typed characters and the trailing Enter then confirms whatever row was already
  highlighted. Menus are answered by `selectPaneOption` (read the rows off the pane, walk the
  cursor, verify, Enter); prose is for a parked gate or an ordinary prompt.
- `ReviewManager` / `TaskManager` shape (`src/server/reviews.ts`, `tasks.ts`) — a `NotesManager`.
- Registry denormalization pattern (`taskSummaryForCwd`, `syncSessionsForWorktree`,
  `refreshPendingCount`) — `noteSummaryFor` / `upsertNote`.
- `openDb()` migration block — `session_notes` (+ `foreman_config`).
- `@shared/harness-runtime.mjs` (`BASE_URL`, `readToken`) — the worker's daemon client.
- Dispatcher/tmux spawn (`src/server/dispatcher.ts`) — optional daemon-managed worker launch (fast follow).

## Safety / guardrails

- Ships **OFF**, dry-run default; live requires an explicit flip + a repo allowlist.
- Foreman **never** *sends* for a session off the allowlist, and never re-acts on a prompt already
  covered by `handled_marker`. Its own worker is a plain Node process (not a discovered `claude`
  session), so it never appears in the queue. Dispatched agents are **intentionally in scope** -
  draining the queue's needs-you queue is the whole point - with their live sends still gated by
  the same repo allowlist.
- Destructive/risky access ⇒ escalate; duplicative implementation ⇒ ask for one abstraction.
- **Never confirm a row we did not verify.** A menu answer names a row, and that row is re-read off
  the live pane and matched by label before the Enter — so a repaint, a closed dialog or a reviewer
  that miscounted cancels the answer instead of confirming the wrong one. A verdict that names no
  row at all is escalated, never typed: typing at a menu is not a degraded answer, it is a
  different one delivered under the human's name.
- Full audit trail: every action in `session_events` + `note.last_action` + the card's
  "Foreman answered" attribution, so nothing it does is silent.
- Cost control: only (re)review a session on a **new** pending prompt (`handled_marker`), with a
  bounded head+tail transcript window; runs only while enabled.

## Verification

1. `npm run typecheck` and `npm test` green (new unit suites included).
2. `npm run dev`; drive a **throwaway** Claude session in a scratch repo to `awaiting_input`.
3. Enable Foreman in **dry-run**: confirm a Purpose + proposed answer render in the expanded
   card and the session is untouched.
4. Flip to **live** for the scratch repo: confirm Foreman sends the answer, the card shows
   `✓ Foreman answered: …`, and the session leaves `needs-you`.
5. Drive the session to a **design-fork** question: confirm Foreman escalates (brief +
   recommendation on the card + a browser alert) and does **not** answer.
6. Tear down the scratch session/repo. Never exercise against real sessions.

## Rollout / first step

Following the repo convention (plan docs land before code — e.g. `docs(plans): …` then
`feat: …`), the first commit is this plan at **`docs/plans/foreman/plan.md`**, then implement
server → worker → UI in that order (each independently testable).

## Out of scope (future)

Current harness support has moved beyond this original v1 scope; see
[Foreman](../../../README.md#foreman-auto-responder).

- Daemon-managed auto-launch of the worker (v1 is `npm run foreman`).
- ~~Auto-answering no-mistakes gates (that path already has `nomistakes/respond`; could fold in later).~~
  **Resolved:** folded in. A parked gate whose driving agent has stopped classifies as the
  `gate-parked` situation (see `foreman/pending.ts`) and reaches the full reviewer, which reads the
  relayed finding off the transcript and judges it against the session's goal. The cheap tier is
  never allowed to dispose one - see backstop 4 in `docs/plans/foreman-watcher/plan.md`.
- Learning/att­ribution memory of your past decisions to sharpen its defaults.
