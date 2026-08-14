# Phase 1: Durable scout prompt context

## Outcome

Mission Control can identify the exact work-episode boundary, visible session name and authorship of
prompts delivered during a scout, even after a daemon restart. The phase adds no archive or UI
behavior yet; it provides a bounded, tested foundation that Phase 2 consumes.

## Entry criteria and dependencies

- **Direct phase dependencies:** none.
- The planning pull request containing `plan.md`, `phased-plan.md` and all phase files is merged.

## Scope

- Add the scout prompt context and turn journal schema, store and lifecycle.
- Record task-delivery boundaries at both existing delivery seams.
- Record successful human and attributed non-human user-role deliveries.
- Add bounded forward transcript paging from a byte offset.
- Unit-test restart, delivery and paging semantics.

### Non-goals

- No archive manifest, capture-job, search, route or Scouts UI changes.
- No report fallback and no completed-bundle mutation.
- No assistant, tool, system or hidden-reasoning capture.
- No change to task/session title generation.

## Repository findings

- `src/server/task-contract.ts` composes the final scout delivery, including the report appendix.
  `src/server/dispatcher.ts` delivers it to a fresh session and `src/server/tasks.ts` assigns it to
  an existing one. Both must record a boundary; changing only dispatch would miss assigned scouts.
- `src/server/pending-turns.ts` owns durable human-turn acceptance. A queued row is still editable;
  SDK acceptance and verified terminal pickup are the first safe journal points.
- `/api/sessions/:id/inject` in `src/server/routes.ts` also has an immediate, non-buffered delivery
  arm. It records non-human attribution only after `r.ok`, which is the journal precedent.
- `src/server/injections.ts` deliberately keeps attribution in memory. This phase changes that only
  for active scout episodes; the live transcript's generic behavior and its bounded maps stay.
- `TranscriptMessages.window` is head plus tail, `since` caps turns, and `appended` reads an
  unbounded remainder. None is a safe archival walk. `before` already proves bounded page anchors,
  so `after` should be its forward counterpart.
- `src/server/db.ts` is the only schema and migration owner. Tests must use the required
  `test/setup-state.mjs` preload.

## Implementation steps

### 1. Add the local coordination schema

In `src/server/db.ts`, create and migrate:

```sql
scout_prompt_contexts(
  task_id TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  session_id TEXT,
  session_name TEXT NOT NULL,
  transcript_path TEXT,
  transcript_offset INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(task_id, episode_id)
)

scout_prompt_turns(
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  origin TEXT NOT NULL,
  text TEXT,
  fingerprint TEXT NOT NULL,
  delivered_at INTEGER NOT NULL,
  UNIQUE(task_id, episode_id, seq)
)
```

Use append-only origin values `human`, `foreman`, `workflow` and `harness`. Human rows retain exact
text. Non-human rows may retain only the existing normalized fingerprint plus origin, because their
payload is needed for exclusion, not archival. Bound row text and per-episode row counts at write
time using constants shared with the collector; refuse or mark a context truncated rather than
letting a transcript create unbounded SQLite state.

Do not add foreign keys to disposable or frequently rotated session rows. The `(task, episode)` key
matches `archive_capture_jobs` idempotency and survives session eviction.

### 2. Add one store and one task-episode resolver

Create a focused server module under `src/server/scouts/` that owns context upsert, name refresh,
turn append, bounded list and cleanup. It may use `openDb`; no Foreman worker or browser code touches
SQLite.

Resolve the current task and episode through Registry's existing task/work-episode ownership. A
delivery with no active scout is a no-op. Never infer a scout from a repository or session name.

The turn append is idempotent for runtime retries. Use a stable delivery id where one exists, such
as `PendingTurn.id`; otherwise generate an id at the successful delivery boundary. A repeated HTTP
response must not create two prompt entries.

### 3. Freeze the delivery boundary at both seams

Immediately before the composed task prompt crosses into the runtime:

- read `sessionMessages(session)` when available;
- store its exact path and current byte size;
- store `session.name` and the task episode;
- for Pi's positional launch prompt, use its located path when available and otherwise offset zero.

Hook this into the fresh-dispatch and assignment seams only after all preflight refusals have passed.
If delivery itself fails, remove or invalidate the unconsumed context so a failed task does not look
like an episode the agent saw.

Refresh the frozen session name from the existing successful rename path. Do not create a second UI
title or rename mechanism.

### 4. Journal accepted user-role deliveries

Add a small injected callback at the common acceptance boundaries:

- `PendingTurnManager`: after SDK acceptance or `completePickup` for a terminal turn, append a human
  row using `PendingTurn.id`; do not append on submit, recall, refusal, retry setup or uncertainty.
- immediate `/inject`: append after `r.ok` with the parsed origin;
- existing Foreman, Workflow and harness injection paths: append their attributed fingerprint after
  success through the same helper.

An option selection or form answer is not a prose prompt and stays out. A `/send` with
`submit: false` is a composer draft and stays out. These distinctions must be tests, not comments
alone.

### 5. Add bounded forward transcript paging

Extend `TranscriptMessages` with a forward page operation anchored at a byte offset. Its result
reports `messages`, `start`, `end` and `atEnd`, mirroring `before` in the other direction. For JSONL
harnesses:

- read at most the existing scan ceiling per page;
- start and end only on complete record boundaries;
- return an empty page that still advances across a long stretch of tool-only records;
- preserve Codex batch repair rules and stable ordering;
- never allocate the whole remaining transcript.

All harnesses currently reach the common JSONL reader. Keep the capability generic and do not branch
on agent names in scout code.

### 6. Cleanup policy

Keep context through daemon restart and task/session eviction until Phase 2 freezes it onto an
archive job. Expose an explicit store cleanup operation for the capture manager and for final task
cleanup after a published job exists. Do not add a timer or age-based sweep.

## Tests

Add focused tests for:

- fresh and upgraded database schema, including old rows and idempotent open;
- context creation at fresh dispatch, assignment and Pi launch-time delivery;
- session rename updating the frozen name;
- a human pending turn journaling only after positive acceptance;
- recalled, refused, failed and uncertain turns not journaling;
- non-human attribution surviving a reconstructed store after in-memory injections are cleared;
- a non-scout session producing no rows;
- forward paging over long Claude, Codex and Pi fixtures, including tool-only gaps, no overlap and no
  omission;
- bounded row and byte limits reporting truncation rather than growing without limit.

Run the narrow files with the repository's mandatory preload, then the full gates.

## Verification

```sh
node --test --import ./test/setup-state.mjs --import tsx test/scout-prompt-context.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/transcript-scrollback.test.ts
npm run typecheck
npm run lint
npm test
```

No build, smoke or Playwright run is required because this phase changes no browser or runtime bundle
surface.

## Merge and exit criteria

- Both task-delivery seams create one context for one scout episode.
- Accepted human and non-human deliveries are journaled with correct attribution and ordering.
- Delivery failures and editable drafts create no false prompt history.
- A restart can reconstruct attribution from SQLite.
- Forward transcript paging reaches every normalized turn without an unbounded read.
- Existing dispatch, assignment, pending-turn and transcript tests stay green.

## Downstream handoff

Phase 2 may rely on:

- a bounded `listContext(taskId, episodeId)` returning the frozen session name and transcript anchor;
- a bounded ordered turn journal with durable origin;
- a forward transcript paging capability;
- explicit context cleanup after capture-job freezing.

It must not bypass the store and read the new tables directly.

## Cross-phase audit record

- The title snapshot, prompt boundary, durable attribution and bounded transcript walk are all owned
  here.
- No portable archive contract is introduced early, so Phase 1 is additive and operable while its
  first consumer waits for Phase 2.
- Phase 2 has no need to modify delivery semantics if this handoff is complete.
