# Phase 2: Portable scout title and prompt projection

## Outcome

New scout bundles freeze the session card's short title plus a bounded, human-only prompt trail. The
portable manifest, derived index, detail API and search all understand that context. Existing bundles
and pre-migration capture jobs remain readable.

This phase makes short titles visible in the existing Scouts rail. It does not yet add the prompt
trail to the reader layout.

## Entry criteria and dependencies

- **Direct phase dependencies:** Phase 1.
- Requires the scout prompt context store, durable attribution and bounded transcript paging defined
  in `phase-1-durable-scout-prompt-context.md`.

## Scope

- Add the optional version 1 manifest prompt contract and bounds.
- Collect prompt history and freeze it onto capture jobs.
- Source archive titles from the session card name.
- Project prompt history into detail responses and literal search.
- Update archive documentation and compatibility tests.
- Add browser coverage for the visible title behavior.

### Non-goals

- No prompt-context layout in `ScoutReader` beyond data availability.
- No assistant, tool, system or hidden-reasoning capture.
- No backfill or rewrite of published archives.
- No new title model call.

## Repository findings

- `ArchiveManifestArchive`, `ManifestV1Schema`, parsing, serialization and read models all live in
  `src/shared/archives.ts`. Unknown version 1 fields are intentionally ignored, so this extension is
  additive.
- Persisted vocabularies are append-only. `prompt` must be appended to
  `ARCHIVE_SEARCH_SEGMENT_KINDS`, and every exhaustive switch and test must move with it.
- `src/server/scouts/task-gateway.ts` currently clips `task.title` and `task.intent` directly. It is
  the correct subject owner, but it needs the Phase 1 context and collector rather than a second
  transcript implementation.
- `ArchiveCaptureStore.reserve` freezes title and question before publication. Recovery is correct
  only if it also freezes the prompt trail; reading a live session in `capture.ts` would break
  restart recovery.
- `src/server/archives/store.ts` rebuilds SQLite entirely from verified bundles. Prompt search and
  detail must derive from the manifest, not the capture journal.
- The current rail already renders `archive.title` through `scoutLabel`. Changing the capture source
  changes visible behavior without a React edit, so the repository still requires an E2E assertion.

## Implementation steps

### 1. Extend the shared portable contract

In `src/shared/archives.ts`:

- append `prompt` to `ARCHIVE_SEARCH_SEGMENT_KINDS`;
- add append-only prompt kinds `initial` and `follow_up`;
- add `ArchiveManifestPromptEntry` and `ArchiveManifestPromptTrail`;
- add optional `archive.prompts` parsing with an empty-trail default for older manifests;
- add entry, per-entry UTF-8 byte and total UTF-8 byte limits from `plan.md`;
- require exactly one first `initial` entry whenever a trail is present;
- serialize `follow_up` and snake-case fields without rewriting old values.

String character counts are not byte counts. Use the repository's existing UTF-8 clipping pattern
or a focused browser-safe helper so the parser, capture and tests agree around multibyte text.

Keep `question` unchanged in the wire and read model. For new local captures it remains a clipped
preview of the initial prompt.

### 2. Add prompt trail to capture jobs

Add an additive `prompts_json` column to `archive_capture_jobs` and update
`ArchiveCaptureReservation`, row parsing, reserve idempotency and migration tests. Existing rows read
as an empty trail.

Reservation is immutable for a work episode. If a retry reaches an existing job, return the frozen
title and trail rather than refreshing them from a later session state.

### 3. Implement the scout prompt collector

Create a focused collector under `src/server/scouts/` that accepts the task, episode, live session
when available and Phase 1 context. It must:

1. make `task.intent` the first and only initial entry;
2. page the normalized transcript from the recorded byte anchor;
3. match durable journal origins before in-memory attribution;
4. exclude non-human user turns, the delivered task-plus-appendix turn and all non-user turns;
5. merge positively delivered human journal rows missing from the transcript;
6. preserve order and timestamps;
7. apply the portable bounds with an honest `truncated` flag.

If the transcript is missing, the exact task intent plus delivered human journal rows is a valid,
possibly truncated trail. If the task episode has no Phase 1 context because it predates the
migration, preserve the initial intent and set `truncated` when follow-up completeness cannot be
established.

### 4. Fix title projection at the task gateway

Change `ScoutSubject` to carry the collected prompt trail and derive title in this order:

1. live `session.name`;
2. Phase 1's frozen episode session name;
3. `task.title` as a legacy recovery fallback.

Apply `ARCHIVE_TEXT_LIMITS.title` once at the gateway. Do not generate, summarize or normalize a new
title during capture. The first two values are the same title the session card uses.

### 5. Publish and verify

Copy the job's frozen prompt trail into the manifest in `src/server/archives/capture.ts`. The existing
serializer, 4 MiB manifest limit, staged verification and final verification must all see the same
bytes before atomic rename.

After a successful job freeze, Phase 1 context may be cleaned only when capture recovery no longer
needs it. A failed publication keeps both the job and any context needed to retry.

### 6. Project detail and search

Extend `ArchiveSummary` or only `ArchiveDetail` according to payload cost. The trail belongs in
detail; list rows need only title, question preview and a prompt-derived search snippet.

In `ArchiveStore.searchSegments`, add bounded overlapping `prompt` segments for every entry. Update
`readSegmentKind` exhaustively. Reconciliation of a new bundle must rebuild prompt search from the
manifest after SQLite deletion.

### 7. Documentation

Update `docs/archives.md` in the same change:

- replace the blanket conversation exclusion with the narrower prompt-context contract;
- distinguish the report from prompt provenance;
- document title source, manifest shape, bounds, truncation and search;
- state that assistant output, tools, system text, hidden reasoning and old archives remain excluded.

Do not weaken the report requirement or describe prompts as a completion fallback.

## Tests

Add or extend tests for:

- manifest parse, serialize and round-trip with no trail, a complete trail, multibyte bounds and
  malformed ordering;
- append-only search vocabulary and `prompt` snippets;
- capture-store migration and existing-row fallback;
- task gateway choosing live name, frozen name and legacy task-title fallback;
- original intents longer than 1,000 characters remaining in prompt entries while `question` clips;
- transcript plus journal merging, restart attribution, missing transcript, rotated transcript,
  duplicate deliveries and truncation;
- capture replay returning the already-frozen title and prompt trail;
- reconciler/index rebuild preserving prompt search;
- no report, assistant or non-human content entering prompt entries.

Extend `e2e/specs/scout-archive.spec.ts` to assert that a deliberately long task title does not become
the archived rail title and that the rail title equals the live session card heading. Use fake
agents and accessible locators only.

## Verification

```sh
node --test --import ./test/setup-state.mjs --import tsx test/archive-format.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/scout-capture.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/archive-store.test.ts
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npm run test:e2e -- e2e/specs/scout-archive.spec.ts
```

## Merge and exit criteria

- New manifests verify with the exact short session title and bounded prompt trail.
- Old manifests and unfinished old jobs still parse and recover.
- The initial intent survives beyond the question preview, with honest truncation at explicit bounds.
- Human follow-ups remain searchable after index rebuild; non-human turns do not.
- The existing Scouts rail visibly matches the session card title in Playwright.
- Report capture, completion gating, immutable publication and bundle verification remain unchanged.

## Downstream handoff

Phase 3 may rely on `ArchiveDetail.prompts` being ordered, bounded, escaped data with one initial
entry when present. It must not re-read manifests, transcripts or capture tables in the browser.

## Cross-phase audit record

- This phase owns every portable, capture, recovery, index and search requirement.
- It consumes Phase 1 through the context-store interface only.
- It intentionally leaves one visible gap: the API carries prompt detail before the reader renders
  it. The data is already durable and searchable, so the intermediate merge is useful and green.
