# Task shaping - Phase 1: Shaping core

## Outcome

With the `task-shaping` flag on, an operator can register a `command` shaper through the API
and dry-run it against a repository. Mission Control calls it at the gather and select stages,
validates and caps what it returns, and reports the section it would inject and an outcome for
each shaper. Nothing is called at dispatch yet. That is Phase 2.

## Entry criteria and dependencies

- This plan is merged. No other phase.
- If FR-05's `headless-mode` flag merged first, the flag registry is not empty: add to it.

## Scope

- The flag, the shared registry, schemas and pure functions.
- `app_config.shaping`, its backup domain, the daemon store.
- `GET` and `PUT /api/shaping`, `POST /api/shaping/test`.
- The engine with both stages, the `command` transport, and placeholder files for the other
  three transports.
- The guide's skeleton, and the browser assertion a first real flag owes.

Not here: the dispatcher, any dashboard surface other than the flag's own row, the event
(Phase 3), the folder (Phase 4), reference resolution (Phase 5).

## Repository findings

- **Flags.** Follow `docs/feature-flags.md`, step 1. A test in `test/feature-flags.test.ts`
  asserts the shipped registry is empty. Change it to assert the id rules over real entries.
- **Config.** `APP_CONFIG_ENTRIES` uses `wholeEntry(key, schema, "setting", domain)` with
  `optionalInSnapshot: true`. The backup domain goes on the `runtime` surface for now
  (decision 3 in `phased-plan.md`).
- **Store.** `src/server/feature-flags/index.ts` is the model: a cache per SQLite connection,
  listeners in commit order, and a reload that a settings restore calls.
- **Routes.** Mutating routes use `parseBody` with a schema re-exported from
  `src/shared/protocol.ts`, and each needs a row in
  `src/shared/telemetry-sources/primary-actions.ts`. Every collection in a request or an
  external reply is bounded, and two tests enforce it.
- **Processes.** `run()` in `src/server/util/exec.ts` takes argv, `timeoutMs`, `input` and
  `maxBuffer`, and never throws. A direct `node:child_process` call must be registered in
  `test/executable-contracts.test.ts` as `operator-command`. The child environment starts from
  `executableChildEnv` and drops what `src/server/agent-subprocess-env.ts` drops.

## Steps

1. **Flag.** Add `task-shaping` to `FEATURE_FLAGS` with the definition in `plan.md`.
2. **`src/shared/shaping-registry.ts`.** Data only, no imports from `node:` or `protocol.ts`:
   the tuples listed under "Registry data" in `phased-plan.md`.
3. **`src/shared/shaping.ts`.** The request and result schemas from `plan.md`. Two schemas
   for a shaper, as `plan.md` sets out under "Stored shapers this build does not understand".
   `StoredShaperSchema` is the lenient envelope the config stores: `id`, `label`, `stage` and
   `transport.type` as bounded strings, every other field kept as bounded JSON, at most 16 KiB
   per entry. An unknown stage or transport id is valid in it. `ShaperSchema` is the strict
   definition: `stage` from `SHAPING_STAGES`, and a discriminated `transport` for all four
   ids, with header and env reference syntax checked but not resolved. The `mcp` config's
   `contextDelivery` is `folded` or `argument`, with no value that omits the context.
   `classifyShaper(stored)` returns a known shaper, or an unsupported entry with its reason.
   `ShaperManifestSchema` is the strict definition plus an optional `enabled`.
   `ShapingConfigSchema` holds a list of envelopes, at most 32, with defaults (5 s, 10 s,
   16 KiB, 32 KiB) and maxima (30 s, 60 s, 64 KiB). `ShapingIntentSchema`: `upsert`, `remove`,
   `enable`, `reorder`, `settings`. `applyShapingIntent` accepts an `upsert` only when it
   passes the strict schema, refuses to switch an unsupported entry on, and carries every
   other entry through unchanged, unknown fields included. The pure functions each take their
   definitions as arguments so tests inject their own. `allocateBudget` likewise takes the
   total it may fill as an argument and reads no config, so a later step outside shaping can
   call it with what the shaping stages left (decision 12 in `phased-plan.md`).
   `resolveShapers` returns known shapers
   only, and implements the whole enablement and ordering rule now, including for a
   discovered list that stays empty until Phase 4. A stored choice in `overrides`, on or off,
   always wins. With no stored choice, a registered shaper is off, and a discovered one runs
   unless its manifest says `"enabled": false`. `shaperIsLocal(shaper)` says whether a shaper
   may be sent local paths.
4. **Config entry and domain.** `shaping` in `APP_CONFIG_ENTRIES`, and a `shaping` backup
   domain.
5. **`src/server/shaping/index.ts`.** `getShapingConfig`, `applyShapingIntent`,
   `reloadShaping`, `onShapingConfigChanged`.
6. **`src/server/shaping/engine.ts`.** `shapeTask(input)`: resolve shapers, run gather then
   select, one call per shaper per repository in parallel, merge facts and summary for the
   selectors, cut a summary to 4 KiB, validate every reply with `ShapingResultSchema`, map
   every failure to an outcome, allocate the budget, compose the section, build the summary.
   A transport reply of any kind may carry `redacted: true`, which Phase 5 sets when it
   removed a credential value from the data or from a failure reason, and the summary records
   it for that shaper.
   Each call's timeout is the smaller of the shaper's and the time left in the step. Paths are
   put in a request only when `shaperIsLocal`. The summary records each shaper's origin and
   the SHA-256 of its definition, taken over canonical JSON for a registered shaper.
7. **Transports.** `transports/index.ts` holds the exhaustive `Record`. Every `call` receives a
   `ctx` with the deadline, an abort signal, and a per-run scope (a `shared` map and `defer`)
   so a transport can reuse one connection during a run and close it afterwards. `command.ts` runs argv
   with the request on stdin and a 256 KiB output cap, in the repository for a gatherer and in
   an empty directory for a selector. `mcp.ts`, `http.ts` and `builtin.ts` each answer
   `unavailable` with a sentence naming the transport. `discovery.ts` exports
   `discoverShapers()` returning an empty list, and `references.ts` exports `referenceStatus()`
   returning an empty object, so the route reply already has its final shape.
8. **Routes.** One `requireFeature("task-shaping")` group. The test route takes a shaper id, a
   repository path and an optional prompt, and returns the engine's result for that one shaper.
9. **Docs.** `docs/task-shaping.md` with the contract for authors and these headings for later
   phases: "Seeing what was added", "Settings", "The shaper folder", "Remote shapers", "The
   built-in gatherer". Update `docs/README.md`, `docs/feature-flags.md`, `docs/security.md`
   (local execution and what is sent), `docs/glossary.md` and the append-only list in
   `docs/agent-guides/change-contracts.md`.

## Data, API and compatibility

- No migration. One `app_config` key, optional in older snapshots.
- A stored on or off for a shaper id lives in `overrides`. `order` lists ids. Both exist now
  so Phase 4 changes no schema.
- With the flag off the three routes answer 404 and nothing reads the config.

## Tests and verification

- `test/shaping.test.ts`: every pure function and every intent; the enablement table in
  `plan.md`, row for row; an entry with an unknown stage or transport id that survives a
  parse and every intent unchanged, is never resolved, cannot be switched on, and cannot be
  written by `upsert`; the id rules; no `node:` import in the shared modules.
- `test/shaping-engine.test.ts`: stage order, parallel calls, the hand-off, the summary cut,
  timeouts and the deadline, partial results, each outcome, and a `redacted` mark carried
  into the summary from a data reply and from a failed one.
- `test/shaping-transport-command.test.ts` with a fixture script under `test/fixtures/`: argv
  without a shell, the scrubbed environment, stdin and stdout, the cap, a timeout.
- `test/shaping-http.test.ts`: the three routes, each intent, 404 with the flag off, reload
  after a restore.
- The exhaustive tests that gain entries: feature flags, settings backup coverage, telemetry
  primary actions, collection bounds, executable contracts.
- `e2e/specs/task-shaping-flag.spec.ts`: the flag's row appears in Settings > Feature flags and
  a toggle reaches a second window without a reload.
- Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke` and
  that spec.

## Merge and exit criteria

- Registering and dry-running a `command` gatherer and selector works through the API.
- A slow, failing or malformed shaper yields an outcome and never an error reply.
- With the flag off, the daemon behaves exactly as before.

## Handoff

Later phases rely on every "Owner 1" row of the cross-phase contracts and must not rename or
reshape them. They replace the contents of their own transport file, `discovery.ts` or
`references.ts`, and fill their own section of the guide.

## Cross-phase audit

- Written first, then revised after each later phase was written.
- For Phase 4: the summary carries `origin` and `sha256`, the reply carries `discovered`, and
  the enablement and ordering rule for discovered shapers moved here, into `resolveShapers`,
  so that phase changes no shared function.
- For Phase 5: the reply carries `references`, the transport reply allows `unavailable` for a
  reference that fails closed, `ctx` gained the per-run scope for one MCP connection per run,
  and `shaperIsLocal` keeps local paths out of remote requests.
- For Phase 6: the built-in id and its options are declared here.
- Plan validation repair, 2026-11-19: `contextDelivery` lost its third value. Every shaper
  receives the complete collected input (constraint C2), so the schema must not offer a way
  to withhold it.
- Plan validation repair 2, 2026-11-19. The enablement rule here contradicted `plan.md`: it
  kept a discovered shaper off when its manifest said `"enabled": false` even with a stored
  on. A stored choice now always wins, here, in `plan.md`, in `phased-plan.md` and in
  Phase 4. And the single strict schema could not have preserved an entry with an unknown
  stage or transport id, so the stored envelope, `classifyShaper` and the write rule were
  added.
- Plan validation repair 4, 2026-11-19: step 3 now says `allocateBudget` takes its total as
  an argument. That is how FR-06's lesson step, which runs after shaping and is not a shaper,
  is allocated last from the one context budget. Nothing else in this phase changed.
- Review of the plan pull request, 2026-11-19: the transport's data reply gained an optional
  `redacted` mark and the per-shaper summary a `redacted` field, so Phase 5 can report a
  removed credential value without reshaping a Phase 1 contract afterwards.
- Review of the plan pull request, round 2, 2026-11-19: the mark is allowed on a failure
  reply too. A scrubbed failure reason could not otherwise be reported.
- Complete-set audit: every decision in `plan.md` is owned by exactly one phase. D1, D2, D8,
  D9 and the engine half of D3 are here.
