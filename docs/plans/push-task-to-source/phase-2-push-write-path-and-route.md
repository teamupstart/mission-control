# Phase 2: Push write path and route

Part of [plan.md](plan.md) via [phased-plan.md](phased-plan.md). Read both, plus [phase-1-contract-and-gh-plumbing.md](phase-1-contract-and-gh-plumbing.md), before this file.

## 1. Outcome and value

After this phase, `POST /api/tasks/:id/push` works end to end: an HTTP client can push a backlog task through a configured github-issues source, the created issue's identity is recorded in `task_source_seen` and linked onto the task **in one transaction**, and every failure mode maps to the correct status code - including the duplicate-hazard distinction between "GitHub refused, retry safe" (502) and "outcome unknown, do NOT blindly retry" (504). The dashboard cannot reach it yet (phase 3); curl and tests can.

## 2. Entry criteria and dependencies

- Direct dependency: **Phase 1** merged (its types, `canPushTo`, `pushToSource`, and `pushResultFrom` semantics are the inputs here).
- Entry: `npm test` green on the default branch.

## 3. Scope and non-goals

In scope:

- `src/server/tasks.ts`: `attachSource(id, ref)`.
- NEW `src/server/task-sources/push.ts`: the push chokepoint (the only DB writer on this path).
- `src/shared/protocol.ts`: `PushTaskSchema`.
- `src/server/routes.ts`: `POST /api/tasks/:id/push` + the honesty update to the task-sources comment block (~line 3213).
- NEW `test/task-source-push.test.ts`; route coverage where the existing HTTP tests live.

Non-goals:

- No web change of any kind (phase 3). No e2e fixture/spec (phase 3): this route is server surface, exercised here by unit/HTTP tests; the click-to-DOM path is phase 3's e2e spec.
- No new SSE event type - `attachSource` re-emits `task_upsert` via the existing path; `src/web/useEventStream.ts` (controlled path) must not be touched.
- No change to sweep/ingest behavior.

## 4. Repository findings and inherited contracts

- From phase 1 (fixed): `PushDraft`/`PushResult`/`PushContext`; `canPushTo` / `pushToSource` as the only implementation entry points; `outcomeUnknown: true` is never retry-safe.
- `TaskManager` (`src/server/tasks.ts`): `CreateTaskInput.source` exists but `update()` cannot set `source`; `interface Ok` (~line 130) is the refusal shape to mirror. `registry.upsertTask` (`src/server/registry.ts` ~4354-4368) persists via the db upsert (which already writes `source_id/external_id/source_url`) and emits `task_upsert` - so `attachSource` is small and synchronous, which lets it run inside `inTransaction` (SQLite transaction fns are sync).
- Dedupe invariant (`src/server/db.ts:755-775` and `ingest.ts`): sweeps dedupe against `task_source_seen`, never live tasks; rows there outlive the task. `recordTaskSourceSeen(sourceId, externalId, url)` and `inTransaction` are the existing levers.
- `ingest.ts` is the style model: dep seams (`{resolveRepoRoot, seen, remember, transaction, log}`), single-transaction pairing of the seen row with the task write, refusals reported not thrown.
- Status-code precedent (`src/server/open-targets/index.ts:87-122`): 200 success, 409 state conflict, 502 upstream refused (retry safe), 504 outcome unknown ("may have taken effect").
- Route conventions (`src/server/routes.ts`): `parseBody(c, Schema)` (~line 306); task routes at ~3338-3506 return the `Task` object on success; `taskSourceById` (from `src/server/task-sources/config.ts`) resolves a source, 404 `{error: "no such task source"}` when missing; 400 bad input, 404 gone, 409 conflict.
- The sweeper's in-flight guard (`entry.sweeping` in `sweeper.ts`) is the precedent for the per-task in-flight push guard.

## 5. Implementation steps

1. `src/server/tasks.ts` - `attachSource(id: string, ref: TaskSourceRef): Ok & { task?: Task }`, synchronous:
   - Re-check guards under the caller's transaction: task exists ("no such task"); `status === "backlog"` (else "task is <status>, not in the backlog"); `source === null` (else "task is already linked to <externalId>"). Refusals are RETURNED, never thrown - a throw would roll back the seen row, and the deliberate rule (step 2.6 below) is that it must not.
   - On success: `this.registry.upsertTask({ ...t, source: ref, updatedAt: <now> })` and return `{ ok: true, task }`. No titling coordination needed: the async titling completion re-reads the row before writing, so either order survives.
2. NEW `src/server/task-sources/push.ts` - header comment mirrors `ingest.ts` ("the only DB writer on the push path"). Exports:
   - `interface PushDeps { push?; remember?; transaction?; log? }` defaulting to `pushToSource`, `recordTaskSourceSeen`, `inTransaction`, console log - the I/O seams, not policy.
   - `type PushTaskOutcome = { ok: true; task: Task } | { ok: false; kind: "unpushable" | "conflict" | "upstream" | "unknown-outcome"; error: string }`.
   - `async function pushTask(inst: TaskSourceInstance, task: Task, tasks: TaskManager, deps: PushDeps = {}): Promise<PushTaskOutcome>`, in order:
     1. `canPushTo(inst)` false -> `unpushable`.
     2. `task.status !== "backlog"` -> `conflict`; `task.source` set -> `conflict` naming the existing link; `inst.repoRoot !== task.repoRoot` -> `conflict` ("this source files against A, the task is based on B"). String compare - both were resolved to git roots at storage time; re-resolving here could disagree with what the UI offered.
     3. Module-level `Set<string>` of in-flight task ids; already present -> `conflict` ("a push for this task is already running"). Add/remove in try/finally.
     4. `await push(inst, { title: task.title, intent: task.intent }, { sourceId: inst.id, repoRoot: inst.repoRoot, signal: new AbortController().signal })`. The signal is never aborted and exists only because `PushContext` shares `SweepContext`'s shape; nothing cancels an in-flight push today, and `run()` has no cancellation parameter. The ACTUAL bounds on a wedged push are `GH_TIMEOUT_MS` inside the implementation and the in-flight Set from step 3 (released in the same try/finally). Do not build an abort path here; if real cancellation is ever wanted, `run()` must grow signal support first, which is out of scope.
     5. `result.outcomeUnknown` -> `unknown-outcome` with the impl's message; `result.error || !result.ref` -> `upstream`.
     6. `transaction(() => { remember(inst.id, ref.externalId, ref.url); return tasks.attachSource(task.id, ref); })`. Attach ok -> `{ok: true, task}`. Attach refused (task moved between the guard and gh returning) -> `conflict` with "created <externalId>, but <reason> - the issue exists and will not be re-swept". The seen row committing anyway is the point: without it, the next sweep re-files the very issue this push just created.
3. `src/shared/protocol.ts` (grep wrapper misreads this file as binary - navigate with `command grep -a`): `export const PushTaskSchema = z.object({ sourceId: z.string().min(1) }); export type PushTask = z.infer<...>` with a doc comment naming the route.
4. `src/server/routes.ts` - `app.post("/api/tasks/:id/push", ...)` beside the sibling task routes:
   - `parseBody(c, PushTaskSchema)`; 404 for missing task; 404 `{error: "no such task source"}` for missing source (existing wording); then `pushTask(...)` and map: `unpushable` -> 400; `conflict` -> 409; `upstream` -> 502; `unknown-outcome` -> 504 with `{error, outcomeUnknown: true}`; success -> 200 with the updated `Task` (siblings return the row; the modal will read `source` from the body rather than racing the SSE).
   - Update the comment block at ~3213: sources pull work inward; the one outward write is this route, an explicit per-task operator action; still nothing dispatches, provisions, or types into a pane.

## 6. Data / API / migration notes

- No schema migration: `tasks.source_id/external_id/source_url` and `task_source_seen` already exist; this phase adds the first writer that sets `source` on an EXISTING task.
- API addition only (`POST /api/tasks/:id/push`); no existing route's contract changes.
- The 502/504 split is part of the API contract from day one; phase 3's UI keys its retry affordance off it and must not need a server change.

## 7. Tests and verification

- NEW `test/task-source-push.test.ts` (dep-seam style of `test/task-source-ingest.test.ts`; real-DB cases follow the HARNESS_HOME-preamble pattern - set env before any dynamic import, never a static import, per the settings-wipe lesson):
  - non-backlog / already-linked / repoRoot-mismatch refused before the push spy is invoked;
  - unpushable kind (jira instance) refused without invoking the spy;
  - upstream refusal writes nothing (no seen row, no attach);
  - unknown outcome writes nothing and is distinct from a refusal;
  - success records the seen row and the link in one transaction (transaction spy wraps both calls);
  - task dispatched mid-push: seen row kept, outcome is a conflict naming the created issue;
  - second concurrent push of the same task refused;
  - `attachSource` round-trip against a real db: persists the three columns, re-emits `task_upsert`, refuses non-backlog and already-linked.
- Route coverage in the existing HTTP test file that exercises task routes: 404s, 400 unpushable, 409 conflict, 200 returning the task with `source` set (impl seam stubbed via `PushDeps`).
- Commands: `npm run typecheck && npm run lint && npm test`; `npm run build && npm run smoke` before the PR.
- Manual proof (optional but cheap): with a real gh-authenticated repo configured as a source, `curl -X POST .../api/tasks/<id>/push -d '{"sourceId":"..."}'` creates the issue, and `POST /api/task-sources/:id/sweep` files zero new tasks.

## 8. Merge and exit criteria

- Section 7 green; no edits to `src/web/` or `e2e/` in the diff.
- The transaction invariant is test-pinned: no code path can write the seen row and the task link separately, and no failure path writes either (except the deliberate moved-mid-push case, which writes only the seen row and says so).
- Reviewable PR merged to the default branch.

## 9. Downstream handoff

Phase 3 may rely on, and must not change:

- The route contract exactly as tabled in section 5.4: 200 returns the updated `Task`; 504 carries `outcomeUnknown: true` in the body; 502 means retry-safe.
- `pushTask`'s guard order (cheap local refusals before any subprocess).
- The repoRoot eligibility rule (exact string equality between `inst.repoRoot` and `task.repoRoot`) - the UI must filter by the same comparison so the server never refuses what the UI offered.

## 10. Cross-phase audit record

- 2026-08-09: initial version. Consistent with phase 1's handoff: consumes `canPushTo`/`pushToSource`/`PushResult` without modification; `unknown-outcome` maps only from `outcomeUnknown: true`. Route naming (`/push`, body `{sourceId}`) and the 200-returns-Task shape are fixed here for phase 3.
- 2026-08-09 (Inspector round 1, PR #462): step 5.4 previously framed an `AbortController` as "the contract's escape hatch", but phase 1's `push()` never reads `ctx.signal` and `run()` has no cancellation parameter, so that path was not real. Reconciled by removing the cancellation claim here and naming the actual bounds (`GH_TIMEOUT_MS` + the in-flight guard); phase 1 now states explicitly that `push()` accepts the signal for shape parity only.
- 2026-08-09 (implementation): four deviations, none of which move phase 3's frozen contract (section 9).
  1. **`attachSource` does NOT guard on status.** Step 5.1 listed `status === "backlog"` as a re-checked guard. Under it, a task the operator dispatched during the seconds `gh` was running loses the created issue's ref for good - and with it the "already linked" guard, so a later cancel + reschedule + push files a SECOND issue while the first stays suppressed by its own seen row. That is the duplicate-creation class this whole phase exists to prevent, arriving through the exception meant to be safe. `update`'s status guard protects PROVISIONING fields (title and repo are cut into a branch name and a terminal home); nothing is provisioned from `source`, and the push itself already refuses a non-backlog task before publishing, so a link written here always records something that happened while the task was in the backlog. The two remaining refusals are "no such task" (deleted mid-push - the one case where the pair genuinely comes apart) and "already linked". Net effect: the seen-row/link invariant gets STRONGER, and the deliberate exception narrows from "the task moved" to "the task is gone".
  2. **Nothing on the publish path may throw its way past the 502/504 split.** Steps 5.2.4-6 assumed `push()` resolves to a `PushResult` and `transaction()` returns. Neither is guaranteed, and an escaped exception reaches the caller as a generic error carrying no `outcomeUnknown` - which is indistinguishable from a retry-safe refusal, and therefore the double-created issue this phase exists to prevent, arriving through the one door left open. Both are caught and both map to 504 with `outcomeUnknown: true`.
     - A `transaction()` that throws (a locked database) rolls both writes back while the issue is already upstream; the error names the issue and says "do not push again".
     - A `push()` that THROWS instead of resolving. Classified as unknown rather than as a refusal, and the asymmetry with `pushToSource`'s own catch is deliberate: that one wraps the implementation call and may conclude "nothing was published" because `run()` never throws, whereas this one wraps the SEAM (an injected `push`, the registry lookup, a future refactor of that guarantee) and an exception there says nothing about which side of the request it fell on. Reading it as retry-safe would be an optimistic default in the one place this feature cannot afford one.

     No phase 3 change for either: 504 with `outcomeUnknown: true` is a response phase 3 already handles.
  3. **The in-flight claim spans the writes, not just the subprocess.** Step 5.2.3 said try/finally around the push. It is held through the transaction as well, because "an issue exists but is not recorded yet" is exactly the state a second push must not observe.
  4. **Route coverage lives in a new `test/task-push-http.test.ts`, driven by a fake `gh` rather than a `PushDeps` stub.** There is no single existing HTTP file for task routes (`task-edit-repo`, `task-reschedule` and friends are each their own), and stubbing `PushDeps` at the route would have meant a seventeenth positional parameter on `buildApp` that production never passes. Pointing `MISSION_GH_BIN` at a fake - the seam phase 1 built - covers 200/502/504 through the real chain (route to `pushTask` to `pushToSource` to the implementation to `run()` to `pushResultFrom`), including a child killed by signal for the 504. The 400/404/409 cases need no fake, and that they need none is the property: they published nothing.
