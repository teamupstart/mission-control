# Phase 1: Conflict-safe guidance contract

## Outcome and value

Foreman's existing standing-guidance route becomes a complete, conflict-safe document contract
without changing where guidance is stored or which model calls receive it.

After this phase, an HTTP client can distinguish built-in, custom, and intentionally empty guidance;
read the exact effective document and shipped default; replace or reset it only from a current ETag;
receive the current view after a stale write; and rely on a bounded request body. The existing Foreman
worker continues reading one `text` value per evaluation and otherwise behaves exactly as it does
today. There is intentionally no dashboard editor yet.

## Entry criteria and direct dependencies

- Direct dependency: this planning session has merged
  `docs/plans/editable-foreman-profile/` to the default branch.
- The scheduled Phase 1 task is still in the backlog and disabled. A human explicitly enables it when
  implementation should start.
- No other implementation phase is a prerequisite.
- Required context:
  - `docs/plans/editable-foreman-profile/plan.md`
  - `docs/plans/editable-foreman-profile/phased-plan.md`
  - this phase file
- Confirm the current default branch still has the string-or-null
  `app_config["foreman.instructions"]` storage and the GET/PUT route described below. If it does not,
  adapt the route to the repository and record the deviation in the pull request rather than adding a
  parallel path.

## Scope

- shared browser-safe source, view, update, and conflict contracts;
- source-aware exact-text views and stable ETag generation in the daemon;
- synchronous compare-and-swap update and reset behavior over the existing config key;
- a schema-shaped request-body limit and explicit stale-write response;
- source-only metadata on `ForemanStatus` for later read-only summaries;
- preservation of the worker's text projection and per-evaluation capture;
- focused storage, route, client, status, and prompt-boundary tests.

## Explicit non-goals

- no Library row, profile editor, Settings card, cross-link, or CSS;
- no Persona row, Persona schema change, workflow graph change, ensemble change, or SSE document;
- no database migration, immutable history, activation step, or second text key;
- no change to `instructionsSection()`, its trimming behavior, safety framing, prompt placement, or
  the set of roles that receive guidance;
- no change to Foreman provider/model, posture, Trust, or authority writes;
- no UI or Playwright work in this phase.

## Repository findings and inherited contracts

- `src/server/foreman/instructions.ts` currently reads the shipped seed once, returns a stored string
  whenever one exists, stores empty exactly, and resets by writing `null`. Preserve that storage
  compatibility.
- `src/shared/protocol.ts` currently exports `ForemanInstructionsSchema` for a permissive
  `{ text?, reset? }` body. There is no response schema or conflict type.
- `GET /api/foreman/instructions` currently returns `{ text, default }`; PUT accepts a write without a
  revision. No current browser code calls either route. `ForemanClient.instructions()` reads only the
  `text` key, so it remains compatible with the expanded view.
- Hono `bodyLimit` is applied per route elsewhere in `routes.ts`; `parseBody` alone is not a stream
  limit. The schema counts JavaScript string length while the middleware counts UTF-8 request bytes.
- `foremanStatus()` already resolves the effective runner and four model roles on the daemon. It may
  safely add a small source discriminator, but never the guidance document.
- The worker calls `readInstructions()` once in each evaluation input-gathering path. Shadow triage
  and full review share the captured result. Verification captures its own one result.
- `instructionsSection()` calls `trim()` only for prompt rendering. Do not reuse the trimmed string for
  persistence or ETag calculation.

## Implementation steps

### 1. Define the shared document contract

In `src/shared/protocol.ts`:

1. Export one shared maximum for the accepted standing-guidance string and use it in the schema. The
   existing semantic ceiling remains 64,000 JavaScript characters/code units.
2. Add a source schema and inferred type for exactly `"builtin" | "custom" | "none"`.
3. Add `ForemanInstructionsViewSchema` and its inferred type with:
   - `text: string`;
   - `defaultText: string`;
   - `source` from the shared source schema;
   - `etag: string`.
4. Replace the permissive update schema with a strict union of exactly two operations:
   - `{ expectedEtag: string, text: string }`, where empty is valid and the shared length ceiling
     applies;
   - `{ expectedEtag: string, reset: true }`.
5. Reject a body carrying both `text` and `reset`, neither operation, an empty ETag, unknown keys, or
   an oversized string. Keep the exported `ForemanInstructionsUpdate` name for callers.

Do not place `node:` imports or hashing logic in `src/shared/`.

### 2. Make the instructions module source-aware and atomic

Refactor `src/server/foreman/instructions.ts` around one source-aware read and one synchronous CAS
mutation:

1. Read the config key once per view construction. Classify it as:
   - `builtin` when the stored value is not a string, with `text` equal to the cached seed;
   - `custom` when the stored value is a non-empty string;
   - `none` when the stored value is the empty string.
2. Return `defaultText` from the cached shipped seed in every view, including when the seed is
   missing and therefore empty.
3. Compute a stable ETag from a versioned namespace, the source discriminator, and the exact UTF-8
   bytes of the effective text. Use a server-only hash such as SHA-256. Include unambiguous separators
   or length framing so source and content cannot collide by concatenation.
4. Keep source in the hash. Custom text byte-identical to the default must have a different ETag from
   built-in; intentional none must differ from a missing-seed built-in empty document.
5. Add a synchronous mutation function that constructs the current view, compares
   `expectedEtag`, and performs no write on mismatch. On a match, write either the exact supplied text
   or `null` for reset, then return the new view.
6. Preserve the existing exported text helpers only where current worker or tests still need them, but
   implement them through the single source-aware owner rather than maintaining two readings of the
   config key.

The daemon remains the only SQLite writer. Do not import this module from the worker process.

### 3. Harden the HTTP route and status projection

In `src/server/routes.ts` and the existing Foreman status owner:

1. Change GET `/api/foreman/instructions` to return `ForemanInstructionsView`.
2. Wrap PUT in a route-specific `bodyLimit`. Size the byte ceiling from the maximum legal JSON
   representation, not as 64,000 raw bytes: a legal string may contain non-ASCII UTF-8 or `\uXXXX`
   escapes plus the JSON envelope. Return HTTP 413 with a short instructions-specific error.
3. Parse the strict update union and call the synchronous CAS mutation.
4. On success, return the new `ForemanInstructionsView` with HTTP 200.
5. On an ETag mismatch, return HTTP 409 with:

   ```json
   {
     "error": "Foreman standing guidance changed in another window",
     "code": "foreman_instructions_revision_conflict",
     "current": { "text": "...", "defaultText": "...", "source": "custom", "etag": "..." }
   }
   ```

6. Preserve the existing loopback middleware and ensure malformed, oversized, non-loopback, and stale
   requests perform no storage write.
7. Add only `instructionsSource` to `ForemanStatus`, derived from the same source-aware read. Do not
   add `text`, `defaultText`, or ETag to status, its poll, or SSE.

The response rename from `default` to `defaultText` is intentional. There is no current browser
consumer, and the worker projects only `text`; tests and any private/manual caller must adopt the new
document contract.

### 4. Preserve worker compatibility and capture semantics

In `src/server/foreman/client.ts`, keep `instructions()` returning `Promise<string>` and project only
the `text` member of the expanded response. Use the shared view type if it can be imported without
pulling server-only code into the worker.

Do not add a second GET, source branch, ETag cache, or worker write. Re-read the input-gathering sites
in `worker.ts` and retain exactly one `readInstructions()` call per evaluation. The existing
failure-to-empty transition logging remains unchanged.

### 5. Lock the contract with focused tests

Extend the existing tests rather than creating parallel fixtures:

- `test/foreman-instructions.test.ts`
  - built-in, custom, and none views;
  - exact whitespace, line-ending, and Unicode preservation;
  - stable ETag for identical state;
  - distinct ETags for built-in versus byte-identical custom and built-in empty versus none;
  - successful text and reset CAS;
  - stale mutation returns current and does not write;
  - missing seed remains built-in with empty `text` and `defaultText`.
- `test/http-integration.test.ts`
  - new GET response;
  - exact successful write, empty write, and reset;
  - stale 409 code and `current` view, followed by an unchanged read;
  - strict body refusals and exact-text behavior;
  - a legal high-Unicode document below the schema ceiling passes the byte guard;
  - an oversized body receives 413 before mutation;
  - GET and PUT remain loopback-only.
- `test/foreman-client.test.ts`
  - the worker projects `text` from the expanded response;
  - malformed or unavailable responses retain the current safe fallback.
- Existing Foreman prompt tests
  - the editable block is still inserted only by `instructionsSection()`;
  - adding guidance changes only that section;
  - empty guidance renders no section.
- Existing Foreman status render/contract tests
  - source metadata is present and the standing document is absent.

## Data, API, migration, and compatibility details

- Durable shape: unchanged `app_config` key, unchanged JSON string or `null` value.
- Migration: none. An older build can still read every value written by this phase.
- Read API: response expands and renames `default` to `defaultText`.
- Write API: every mutation now requires `expectedEtag`; stale and malformed callers fail closed.
- ETag: application-level opaque string, not a claim that HTTP conditional request headers are
  supported. Browser and server compare it exactly.
- Atomicity: current-view construction, ETag comparison, and config write stay synchronous in one
  daemon turn with no `await` between compare and write.
- Missing seed: safe empty built-in state, distinguishable from intentional none.
- Prompt behavior: effective text is captured once and remains immutable for that in-flight call.

## Verification commands

Run focused tests with the repository's required preload:

```sh
node --test --import ./test/setup-state.mjs --import tsx \
  test/foreman-instructions.test.ts \
  test/foreman-client.test.ts \
  test/foreman-prefs.test.ts \
  test/http-integration.test.ts
```

Then run:

```sh
npm run typecheck
npm run lint
npm test
```

No browser spec is required because this phase adds no visible UI.

## Merge and exit criteria

- All focused and full gates above pass.
- Storage remains string-or-null with no migration and no second key.
- GET and successful PUT return the shared view; stale PUT returns the exact 409 contract.
- Oversized, malformed, non-loopback, and stale requests cannot mutate storage.
- `ForemanStatus` exposes only the source discriminator, not guidance bytes.
- The worker still captures one string per evaluation and all existing prompt-safety tests remain
  green.
- The pull request records any repository-driven deviation from this proposed route and why it was
  safer.
- The pull request is reviewable and merged before Phase 2 is enabled.

## Downstream handoff

Phase 2 may rely on:

- `ForemanInstructionsView` and `ForemanInstructionsUpdate` as the only browser wire contract;
- the 409 body containing `code` and `current`;
- `ForemanStatus.instructionsSource` for read-only summaries;
- exact text and `defaultText` being safe for edit, preview, copy, download, clear, and reset;
- custom, none, and built-in remaining distinct after reload;
- the worker and prompt boundary requiring no UI-side synchronization.

Phase 2 must not rename the contract, add another endpoint or storage key, send document bytes through
status/SSE, or widen Foreman's prompt coverage. If the repository forces such a change, stop and
record it as a plan deviation rather than silently building a second dialect.

## Cross-phase audit record

- **Source ownership:** this phase owns every persistence, API, ETag, body-limit, source-metadata, and
  worker-compatibility requirement. It owns no visible behavior.
- **Compatibility reconciliation:** source metadata was added to the existing status projection
  because the approved Settings summary needs it while the approved design forbids putting the 64 KB
  document in the poll. Phase 2 consumes that metadata and performs no summary-only document fetch.
- **Boundary reconciliation:** exact bytes are used for ETag and round-trip behavior, while the
  existing prompt renderer may continue trimming only the rendered block. These are compatible and
  must not be collapsed.
- **Downstream audit:** Phase 2 has one response schema, one conflict code, one source field, and one
  limit to consume. No Phase 2 step is allowed to redefine them.
