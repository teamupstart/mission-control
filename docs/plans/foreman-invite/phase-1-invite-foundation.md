# Phase 1: Invite model foundation

## 1. Outcome

Every session carries a truthful, durable `foremanInvite` state - `"sdk"`,
`"dispatch"`, `"operator"`, or `null` - visible over `/api/sessions` and SSE, written
automatically by the dispatcher for its own sessions, and settable/withdrawable over
two new HTTP routes. No behavior changes: the Foreman worker does not read the field
yet. This phase is pure foundation; its value is that phases 2 and 3 can gate and
render against a field that already tells the truth.

## 2. Entry criteria and dependencies

- Direct prerequisites: none (first phase). The planning PR that publishes these
  documents must be merged so this file's path resolves on the default branch.
- Base: current `main`.

## 3. Scope and non-goals

In scope: the SQLite table, the shared `Session` field, registry resolution and
key-rotation handling, dispatcher auto-invite, the invite/withdraw routes, reset
key-move, pruning, fixtures, and tests for all of it.

Non-goals (owned by later phases - do not touch):

- Any Foreman worker gating (`authorization.ts`, `queue-machine.ts`,
  `review-followup.ts`, `backlog-machine.ts`) - phase 2.
- Any daemon-side refusal of Foreman-marked writes - phase 2.
- Any web UI, `ForemanSendBlock`, or e2e spec - phase 3. This phase has no UI surface,
  so the e2e requirement does not attach to it.

## 4. Repository findings and inherited contracts

Verified against the repo (line numbers from the planning base, `a6146ee`; re-locate
by symbol if drifted):

- `SESSION_FIELD_COMPARATORS` (`src/server/registry.ts:5808`, type at `:5789`) is a
  mapped type over `keyof Session` with `-?` - adding the field breaks the build until
  an entry is added. Helpers: `byValue` (`:5792`), `byJson` (`:5795`), `alwaysEqual`
  (`:5801`). Use `byValue` (scalar string|null). The record follows `Session`'s own
  field order.
- The registry already caches note-key-keyed state in memory: `this.notes` / `this.goals`
  maps (`registry.ts:478-480`), loaded in the constructor (`:595-596`), resolved via
  `noteSummaryFor` / `goalSummaryFor` and attached at five sites: `mergeDiscovered`
  (`:1287-1288`, deliberately after `rememberAgentSession` at `:1284` so the key is
  stable), `registerSdkSession` (`:1415-1416`), and the applyHook/status paths
  (`:1594-1595`, `:1820-1821`, `:1949-1950`). The invite cache follows this pattern
  exactly - a per-sweep SQLite read (the queue pattern, `:5066`) would add a SELECT per
  session to the ~1.5s sweep and is explicitly warned against (`registry.ts:1294-1301`).
- Key rotation: only `pending_turns` auto-rekeys today
  (`PendingTurnManager.moveConversationKey`, `src/server/pending-turns.ts:387-421`,
  driven by `observeSession` `:317-322`). Notes and goals strand their rows
  (`claude-cli.ts:260` documents the resulting incident). The registry detects noteKey
  rotation at **four** sites, and the invite move must cover all of them: the three
  inline cost-recompute comparisons (`registry.ts:1596`, `:1829`, `:3550-3551`,
  `noteKeyFor(next) !== noteKeyFor(s)`) **and** `bindLaunchedAgentSession`
  (`registry.ts:1933-1954`), which the dispatcher calls at `dispatcher.ts:282` for
  every Pi launch carrying a pre-assigned `piLaunch.sessionId` - it swaps
  `agentSessionId` and already re-resolves note/goal/cost/queue off the new key.
  Because the dispatcher writes the `'dispatch'` invite under the pre-rebind synthetic
  key (`:267-271`), missing this fourth site would strand a Pi-dispatched session's
  invite and silently un-invite Foreman from a session Mission Control just dispatched
  (Pi's runtime is `terminal`, so no implicit grant catches it).
- `Dispatcher` has no db import; all persistence goes through `this.registry`
  (`dispatcher.ts:610-614`). `waitForSessionAtCwd` returns `Session | null`
  (`registry.ts:4429`) and fires the moment the process exists - `agentSessionId` is
  almost certainly null there, so the invite lands on the synthetic key and the
  rotation move above is what carries it to the agent-session key. The embedded SDK
  branch returns at `dispatcher.ts:205-208` and never reaches `:267`.
- A brand-new table belongs in the main `db.exec` CREATE block (`db.ts:101-1427`),
  beside `session_goals` (ends `:344`) or `skills_acks` (`:860`); no `migrate()` entry
  is needed for a new table (`migrate` doc at `db.ts:1448-1451`; the AGENTS.md index
  hazard applies only to indexes over `addColumn`-added columns).
- Accessor template: `skills_acks` (`getSkillsAcks` `db.ts:5393`, `setSkillsAck`
  `:5406` with `INSERT ... ON CONFLICT ... DO UPDATE`); richer template
  `session_goals` (`upsertSessionGoal` `:3861`, `getSessionGoal` `:3884`,
  `loadSessionGoals` `:3891`, `pruneSessionGoals` `:3921`).
- Session reset tears down note-keyed state at `src/server/reset.ts:117-124`
  (`clearPendingTurns` for both pre- and post-reset keys).
- `Session` crosses the wire as plain JSON: `session_upsert` / `snapshot` carry whole
  objects (`types.ts:2118`, `:2173`; `sse.ts:21-49`; `useEventStream.ts:170`,
  `:200-202`; `routes.ts:643`). There is no Zod `SessionSchema`. **No new ServerEvent
  and no protocol schema for the field.**
- Neither new route needs a body: POST carries no options (source is always
  `operator`), DELETE is body-less like every existing DELETE (`routes.ts:2728`).
  **Therefore no `src/shared/protocol.ts` change at all in this phase** - the source
  plan's "POST schema in protocol.ts" is disproven by the route shapes; record this
  deviation in the PR.
- Route templates: `PUT /api/sessions/:id/note` (`routes.ts:2622-2630`) for the 404
  shape; `app.delete("/api/sessions/:id/queue/:itemId")` (`routes.ts:2728-2733`).
  DELETE-means-real-deletion convention at `routes.ts:1140` - the tombstone still
  removes the invite (the resource); note the reasoning in a route comment.
- Full-`Session` literals that must gain the field: `mergeDiscovered`
  (`registry.ts:1169-1245`), `registerSdkSession` (`registry.ts:1363-1408`), the shared
  test fixture `test/helpers/session-fixture.ts:68-114`, and the hand-rolled test
  literals in roughly: `test/queue-machine.test.ts:53`, `test/backlog-machine.test.ts`,
  `test/foreman-review-followup.test.ts:73`, `test/prompted-wrapup.test.ts:62`,
  `test/queue-apply-sdk.test.ts:72`, `test/session-card-goal.test.ts`,
  `test/away-watcher.test.ts`, `test/foreman-pending.test.ts`, `test/kill.test.ts`,
  `test/reset.test.ts`, `test/reset-sdk.test.ts`, `test/foreman-codex-runner.test.ts`,
  `test/foreman-reads-goal.test.ts`, `test/foreman-triage.test.ts`,
  `test/queue-apply.test.ts`, `test/alerts.test.ts`, `test/stall.test.ts`,
  `test/rename.test.ts`, `test/report.test.ts` (compile errors will enumerate the
  exact set).
- `test/session-contracts.test.ts` (`cases` array at `:42`) pins per-field emit
  behavior - add a `foremanInvite` case.

## 5. Implementation steps (execution order)

1. **`src/shared/types.ts`** - beside `SESSION_RUNTIMES` (`:98`), add the append-only
   tuple and type:
   - `export const FOREMAN_INVITES = ["sdk", "dispatch", "operator"] as const;`
   - `export type ForemanInvite = (typeof FOREMAN_INVITES)[number];`
   - `Session.foremanInvite: ForemanInvite | null;` placed beside `runtime` (`:375`)
     with a doc comment stating the resolution rule and that the persisted db domain
     additionally contains `'withdrawn'`, which never surfaces here (it resolves to
     `null`).
2. **`src/server/db.ts`** - `foreman_invites` table in the main CREATE block after
   `session_goals`, with the comment-style the neighbors use:
   ```sql
   CREATE TABLE IF NOT EXISTS foreman_invites (
     note_key   TEXT PRIMARY KEY,   -- noteKeyFor(s), same key as session_notes
     source     TEXT NOT NULL CHECK (source IN ('dispatch','operator','withdrawn')),
     created_at INTEGER NOT NULL
   );
   ```
   Accessors following the `session_goals` naming: `upsertForemanInvite(noteKey,
   source, now)`, `getForemanInvite(noteKey)`, `loadForemanInvites()`,
   `moveForemanInvite(fromKey, toKey)` (upsert-into-target, delete-source, in one
   transaction; target wins on conflict only if newer - keep it simple:
   last-write-wins with the moved row's `created_at`), `pruneForemanInvites(liveKeys,
   olderThanMs)` mirroring `pruneSessionGoals`.
3. **`src/server/registry.ts`**:
   - `private invites = new Map<string, "dispatch" | "operator" | "withdrawn">()`,
     loaded in the constructor beside notes/goals.
   - `private foremanInviteFor(s: Session): ForemanInvite | null` - `'withdrawn'` row
     → `null`; else row value; else `s.runtime === "sdk" ? "sdk" : null`.
   - Attach at the same five sites notes/goals resolve (`mergeDiscovered`,
     `registerSdkSession`, and the three applyHook/status re-resolves), after
     `rememberAgentSession` where that ordering exists.
   - Comparator entry `foremanInvite: byValue` in `SESSION_FIELD_COMPARATORS`, in
     `Session` field order.
   - Public `setForemanInvite(sessionId, source: "dispatch" | "operator")` and
     `withdrawForemanInvite(sessionId)` - resolve the session, upsert the row
     (`'withdrawn'` for withdraw), update the cache, then re-resolve and emit for
     every live session sharing the key (mirror `syncSessionsForNote`,
     `registry.ts:5041`). Return the new `ForemanInvite | null` or undefined when no
     session.
   - Key-rotation move: extract one small private helper (old key, new key →
     `moveForemanInvite` + cache move) and invoke it at **all four** rotation sites:
     the three existing `noteKeyFor(next) !== noteKeyFor(s)` comparisons (`:1596`,
     `:1829`, `:3550`) and `bindLaunchedAgentSession` (`:1933-1954`, beside its
     existing note/goal/cost re-resolution). Acceptable alternative if the fixed list
     proves fragile during implementation: rekey reactively off every session key
     change the way `PendingTurnManager.observeSession` does, which covers rotation
     sites by construction; record the choice in the PR.
   - Wire `pruneForemanInvites` wherever `pruneGoals` runs (`registry.ts:5017-5028`).
4. **`src/server/reset.ts`** - at `:117-124`, move the invite to the post-reset key
   (same from/to keys `clearPendingTurns` uses) instead of leaving it stranded.
5. **`src/server/dispatcher.ts`** - after `waitForSessionAtCwd` succeeds (`:267-271`),
   `this.registry.setForemanInvite(discovered.id, "dispatch")` beside the
   `terminalResourceId` patch.
6. **`src/server/routes.ts`** - beside the note routes:
   - `POST /api/sessions/:id/foreman-invite` → 404 when no session, else
     `registry.setForemanInvite(id, "operator")`, return the resolved state.
   - `DELETE /api/sessions/:id/foreman-invite` → 404 when no session, else
     `registry.withdrawForemanInvite(id)`, return the resolved state. Route comment
     explains the tombstone (withdrawal must beat the implicit SDK grant and survive
     restarts).
7. **Fixtures and tests**:
   - `test/helpers/session-fixture.ts`: `foremanInvite: "dispatch"` default (the
     fixture models a dispatched worktree session; preserves the meaning of every
     existing test). Add the field to each hand-rolled `Session` literal the compiler
     flags - use the value that matches what that test models (`"sdk"` for
     `mkSdkSession`-style literals, `"dispatch"` for dispatched-worktree literals);
     do not blanket-copy one value.
   - `test/session-contracts.test.ts`: add the `foremanInvite` emit case.
   - New `test/foreman-invite.test.ts` (or extend the db/registry suites): db
     accessor round-trip incl. tombstone upsert-over and CHECK rejection; rotation
     move (invite written under synthetic key survives a simulated binding to an
     agentSessionId); a Pi-shaped rotation case (invite written under the synthetic
     key survives `bindLaunchedAgentSession` rebinding to a pre-assigned id); prune
     keeps live keys; registry resolution matrix (sdk default, dispatch row, operator
     row, withdrawn row on sdk and on terminal, no row);
     `setForemanInvite`/`withdrawForemanInvite` emit `session_upsert`.
   - Dispatcher: extend the `test/dispatch.test.ts` family - a terminal dispatch ends
     with the discovered session carrying `foremanInvite: "dispatch"`; an SDK dispatch
     carries `"sdk"` with no row.
   - Routes: an in-process HTTP test for POST → `"operator"`, DELETE → `null`
     (including on an SDK session), 404s.
8. **Docs** - `docs/agent-guides/change-contracts.md`: record `foreman_invites.source`
   as an append-only persisted domain (`'withdrawn'` included) and
   `FOREMAN_INVITES` as an append-only tuple. README needs no user-facing change yet
   (no behavior or UI changed); phase 2 owns the behavioral README update.

## 6. Data / API / migration details

- New table only; safe on existing databases; no `migrate()` entry; no index needed
  (PK lookup only).
- Persisted domain `'dispatch' | 'operator' | 'withdrawn'` is append-only from the
  moment this merges - never rename or reorder; extend only by appending to the CHECK
  and the tuple with a fallback for unreadable values.
- API additions are the two routes above; both body-less; responses are small JSON
  (`{ foremanInvite: ... }`) plus the standard 404 shape.
- Upgrade behavior: no rows exist, so every live terminal session resolves `null` and
  SDK sessions resolve `"sdk"`. That is invisible in this phase (nothing reads the
  field) and becomes the documented quiet-on-upgrade behavior when phase 2 lands.

## 7. Tests and verification

- `node --test --test-concurrency=2 --import tsx test/foreman-invite.test.ts` (new)
- `node --test --test-concurrency=2 --import tsx test/session-contracts.test.ts`
- `node --test --test-concurrency=2 --import tsx test/dispatch.test.ts`
- Full: `npm run typecheck && npm run lint && npm test`
- `npm run build && npm run smoke` (runtime surface changed: db schema, routes).

## 8. Merge and exit criteria

- All of section 7 green; no e2e needed (no UI surface).
- `GET /api/sessions` shows `foremanInvite` on every session with the correct value
  for sdk, freshly dispatched, operator-invited, withdrawn, and plain discovered
  sessions.
- A daemon restart preserves invites; a hook binding (synthetic → agent session id)
  carries the invite with it; a session reset carries it to the post-reset key.
- Zero Foreman behavior change: the worker still targets exactly what it targeted
  before this merge.
- README unchanged is correct for this phase; change-contracts updated.

## 9. Downstream handoff (what later phases may rely on and must not change)

- **C1**: `Session.foremanInvite: "sdk" | "dispatch" | "operator" | null`, resolved by
  the registry with the tombstone rule; `'withdrawn'` never surfaces on the field.
- **C2**: `foreman_invites(note_key PK, source, created_at)` with the append-only
  source domain and note-key lifecycle (rotation move, reset move, prune).
- **C3**: `POST /api/sessions/:id/foreman-invite` → operator invite;
  `DELETE /api/sessions/:id/foreman-invite` → authoritative withdrawal (tombstone);
  both emit `session_upsert`; both 404 on unknown session; both body-less.
- **C4**: `Registry.setForemanInvite` / `Registry.withdrawForemanInvite` are the only
  write doors; the Foreman worker and the dispatcher never touch SQLite for invites.
- **C5**: `mkSession` defaults `foremanInvite: "dispatch"`; tests that need an
  uninvited session declare `foremanInvite: null` explicitly.

## 10. Cross-phase audit record

- 2026-08-09 (authoring): source plan's "POST schema in `src/shared/protocol.ts`"
  dropped - neither route carries a body, so this phase touches no protocol schemas.
  The plan's data-model item 5 parenthetical is superseded by this file.
- 2026-08-09 (authoring): decided the invite move rides the registry's existing
  noteKey-rotation points rather than a new `PendingTurnManager`-style subscriber,
  because the invite cache is registry-owned state (notes pattern) and the rotation
  points already exist inline.
- 2026-08-09 (Inspector round 1, confirmed against the repo): the rotation list was
  three sites and missed `bindLaunchedAgentSession` - the Pi-dispatch rebind that
  would have stranded a freshly dispatched Pi session's invite, reproducing the exact
  bug class this design exists to prevent. Fixed: four sites via one shared helper,
  with the reactive `observeSession`-style rekey named as the acceptable alternative;
  a Pi-shaped rotation test added to section 5 step 7. Source plan updated to match.
