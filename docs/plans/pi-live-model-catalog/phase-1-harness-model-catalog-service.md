# Phase 1: Harness model catalog service

Part of [phased-plan.md](phased-plan.md); source plan [plan.md](plan.md). Read both and the
[planned request sequence](../../../.docs/architecture/sequences/pi-model-catalog.md) before
starting. This file is the proposed route, not a specification: follow it where the repository
agrees, use your own judgement where it does not or where a better implementation presents itself,
and record any deviation and its reasoning in the pull request.

## 1. Outcome and value

Mission Control's daemon can return one complete, browser-safe model catalog for every harness.
Claude and Codex answer explicitly with their shipped lists. Pi asks the configured installation
for its account-aware available models through a bounded, prompt-free RPC child and degrades to a
last successful or shipped list on every failure. This phase delivers a tested generic API without
changing any visible picker, so the repository remains operable while the risky process boundary is
reviewed independently.

## 2. Entry criteria and dependencies

- No phase prerequisites; this is the root implementation phase.
- Start from the approved source and phased plans published on the default branch.
- Reconfirm the installed Pi protocol only as a compatibility reference. Tests must use injected
  transports or fixture executables and must never depend on `/opt/homebrew/bin/pi`.

## 3. Scope and non-goals

In scope:

- shared bounded response schemas and model presentation types;
- a required `Harness.models` capability with explicit answers from all three harnesses;
- Pi RPC discovery, validation, cleanup, and safe diagnostics;
- a daemon-owned in-memory cache and concurrent-probe deduplication;
- aggregate `GET /api/harnesses/models` wiring and HTTP tests;
- refreshing the compact shipped Pi fallback to current verified provider-qualified ids;
- focused documentation comments that remove the false static-catalog premise.

Non-goals:

- no browser consumer changes, fallback notice, provider grouping, or Playwright work;
- no dynamic Claude or Codex probe;
- no SQLite table, migration, app-config blob, or SSE event;
- no changes to model selection persistence or launch arguments;
- no human-table parsing and no model prompt.

## 4. Repository findings and inherited contracts

- `ModelChoice`, `MODEL_CATALOG`, and `modelChoicesFor` live in browser-safe
  `src/shared/model.ts`. Keep that module free of `node:` imports and usable by pure render tests.
- `ModelIdSchema` in `src/shared/protocol.ts` already accepts interior `/` and refuses leading
  flags, traversal, whitespace, and shell punctuation. Reuse it for every derived full id instead
  of creating a looser Pi regex.
- `Harness` in `src/server/harness/types.ts` is the exhaustive server-only capability interface.
  Its comment already reserves `models`; adding the required slot makes every harness answer at
  compile time.
- `resolveAgentBin("pi")` is the one binary resolver used by dispatch. Discovery must use it so
  `MISSION_PI_BIN` and the historical override chain select the same installation in both paths.
- `spawnAppServer` in `src/server/harness/codex/sdk-deps.ts` is the local framing precedent: a thin
  subprocess boundary, drained stderr, explicit lifecycle, chunk-safe JSONL parsing, and injected
  protocol logic above it. Pi discovery is one short request, not a reusable SDK session.
- Pi 0.84.2 documents `get_available_models` as a JSONL RPC command returning full model objects.
  Its CLI flags include `--mode rpc`, `--no-session`, `--offline`, `--no-extensions`, `--no-skills`,
  `--no-prompt-templates`, `--no-themes`, `--no-context-files`, `--no-tools`, and `--no-approve`.
  Use the smallest verified isolation set that prevents arbitrary project resources from loading.
- `buildApp` appends optional daemon services to preserve many positional test constructors. A
  singleton catalog service belongs in `src/server/index.ts` and is appended to `buildApp`; the
  route returns 503 in legacy focused apps where it is absent.
- The aggregate route is loopback-protected automatically by `app.use("/api/*", requireLoopback)`.
  It returns every agent, so there is no path-parameter validation or per-picker request fan-out.
- Current values are consumer-local and cannot be globally merged here. The response owns catalog
  quality only; Phase 2 owns off-catalog selection retention.

## 5. Implementation steps

1. **Define the shared wire contract.** Add a focused schema near the existing model and Harnesses
   contracts, using `ModelIdSchema` for `id` and bounded schemas for every string and collection.
   The exhaustive response is keyed by `AGENT_TYPES` and each catalog carries:
   - validated choices with `id`, display label, optional provider, context-window size,
     reasoning support, and an allowlisted set of input modes;
   - one source discriminant covering shipped, live, cached, and fallback states;
   - the last successful refresh time when one exists;
   - a small problem-code union or `null`, never raw child output.
   Keep `ModelChoice` structurally compatible or extract a shared base without introducing a
   runtime import cycle through `protocol.ts`.
2. **Make model behavior an exhaustive harness capability.** Add a `ModelCatalogSpec` to
   `src/server/harness/types.ts` and a required `models` field on `Harness`. The spec exposes the
   shipped fallback and either a discovery function or an explicit `null`. Populate Claude and
   Codex with their shipped catalog and no discoverer; populate Pi with the shipped fallback and
   its adapter. Add a focused accessor only if callers otherwise reach into `HARNESSES` directly.
   Extend the registry contract tests so a future harness cannot omit this decision.
3. **Implement Pi's adapter in `src/server/harness/pi/`.** Separate framing and process ownership
   enough that tests can inject a scripted child or executable. The production path:
   - resolves the configured Pi binary with no shell;
   - starts one isolated, offline, no-session RPC process in a non-project working directory;
   - writes one JSON line with a unique correlation id and `type: "get_available_models"`;
   - decodes arbitrary stdout chunks into bounded lines, ignores unrelated event frames, and accepts
     only the matching successful response for the expected command;
   - allowlists provider, model id, display name, context window, reasoning flag, and supported input
     modes; constructs `provider/id`; validates the full id; bounds and normalizes labels; preserves
     first-seen Pi order; and deduplicates by full id;
   - treats an empty valid result as unavailable rather than replacing a useful fallback;
   - closes stdin and terminates the child on success, timeout, excessive stdout or stderr, invalid
     framing, spawn error, and early exit, escalating to a hard kill only after a short grace;
   - maps failures to stable problem codes and logs bounded daemon diagnostics without forwarding
     credentials, environment data, raw model objects, stdout, or stderr to the browser.
4. **Measure and centralize bounds.** Use the observed 38-row response as a lower-bound sample, not
   as the cap. Measure serialized bytes and startup time against the configured test fixture and the
   installed reference, choose conservative named limits for time, stdout, stderr, rows, label
   length, provider length, and input modes, and pin boundary tests. Feature-detect protocol support;
   do not declare Pi 0.84.2 a minimum from one sample.
5. **Add the daemon cache service.** Create one `HarnessModelCatalogService` under the server
   harness boundary. It resolves all harnesses through their specs, returns static results without
   spawning, deduplicates simultaneous Pi reads, and stores only the last successful Pi result plus
   its refresh time in memory. A fresh cached result avoids a probe; a failed refresh returns the
   stale successful result with its problem code; a failure before any success returns the shipped
   fallback. Inject clock and discovery functions for deterministic tests. Never write SQLite.
6. **Wire the aggregate route.** Construct the service once in `src/server/index.ts`, append it to
   `buildApp`, and add `GET /api/harnesses/models` beside the existing Harnesses config routes. Parse
   the service result through the shared response schema before returning it. Do not add a Pi branch
   or expose a refresh timer through SSE. Support `?refresh=1` as a schema-validated forced refresh
   for Phase 2's operator retry, using the same in-flight deduplication and process bounds rather
   than a second endpoint.
7. **Refresh fallback comments and rows.** Rewrite the obsolete `MODEL_CATALOG` comment so it states
   that the list is the synchronous browser and failure fallback, not the primary Pi authority.
   Replace the verified-stale `openai/gpt-5-codex` fallback row with a compact set currently present
   in the measured Pi catalog, including the Sol, Terra, and Luna tiers. Do not copy all 38 rows into
   source; full mirroring comes from the live response.

## 6. Data, API, and compatibility

- New API: `GET /api/harnesses/models`, returning one schema-validated catalog per `AgentType`;
  `?refresh=1` bypasses freshness once but still shares an already in-flight probe.
- No write API, persistent schema, migration, config default, or SSE payload changes.
- Existing model ids and selections remain authoritative. The catalog does not validate whether a
  task is allowed to launch and does not rewrite stored values.
- Older or wrapped Pi binaries that lack RPC, accounts with no configured provider, offline catalog
  gaps, and malformed custom-provider rows all return a usable fallback result with a bounded
  problem code.
- Claude and Codex remain static by explicit capability declaration. Their response order and
  labels match the current shipped catalog.

## 7. Tests and verification

Add focused Node tests, following the repository's setup-state preamble:

- Pi RPC success with chunked JSONL, events before the response, matching correlation and command,
  multi-provider rows, deterministic order, safe allowlisting, and clean process exit;
- malformed JSON, wrong correlation id, wrong command, unsuccessful response, empty result, spawn
  failure, non-zero exit, timeout, output-byte overflow, stderr overflow, row overflow, duplicate
  ids, invalid `provider/id`, oversized strings, and a child that ignores graceful termination;
- cache freshness, one in-flight probe for concurrent callers, success replacement, stale-cache on
  failure, fallback before first success, and static harnesses never spawning;
- exhaustive Harness model capability coverage and shared schema rejection at every bound;
- HTTP live, cached, stale, fallback, exhaustive-key, missing-service 503, and loopback protection.

Suggested focused command, adjusted to the final filenames:

```sh
node --test --import ./test/setup-state.mjs --import tsx \
  test/pi-model-catalog.test.ts \
  test/harness-model-catalog.test.ts \
  test/harness-model-http.test.ts
```

Then run:

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
```

No Playwright spec belongs in this phase because no browser-visible behavior changes. State that
reasoning in the pull request.

## 8. Merge and exit criteria

- The configured Pi binary is reached only through the harness capability and shared resolver.
- Every process exit path is bounded and tested; no failure can strand a child or block the route
  indefinitely.
- The response contains every safe discovered row and no raw, secret, or unbounded Pi field.
- Cache and fallback semantics are deterministic under concurrency and process failure.
- The aggregate route is schema-validated, loopback-protected, and does not mutate operator state.
- Focused tests and all listed repository gates pass.
- The phase pull request documents measured bounds and any deviation from this proposed route.

## 9. Downstream handoff

Phase 2 may rely on and must not change without updating both phase audit records:

- the aggregate route path and exhaustive response shape;
- source, refresh-time, and problem-code semantics;
- stable choice identity as the full provider-qualified id;
- deterministic provider and model ordering;
- stale-success-before-shipped-fallback precedence;
- explicit `?refresh=1` using the same service, route, deduplication, and bounds;
- Claude and Codex remaining shipped/static;
- no persistence or launch behavior in the catalog service.

Phase 2 owns all browser fetching, grouping, notes, retry controls, and current-value merging. Do not
add a Phase 1 picker that would become a temporary second source.

## 10. Cross-phase audit record

- 2026-08-18: initial phase boundary. Compared against the Phase 2 draft: the browser needs one
  aggregate response, stable provider metadata, deterministic order, source, refresh time, problem
  code, and an optional same-route refresh seam. These are all owned here.
- 2026-08-18: reconciled the source plan's global saved-value fallback with repository storage.
  Current values exist in several unrelated browser drafts and persisted objects, so this phase
  returns catalog data only and Phase 2 retains each current value locally.
- 2026-08-18: refreshed the small shipped Pi fallback but deliberately did not mirror all live rows
  into source. This preserves a useful failure path without recreating the maintenance burden the
  live capability removes.
