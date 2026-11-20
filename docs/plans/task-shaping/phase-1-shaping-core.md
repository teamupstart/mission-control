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
- **Trace context.** `src/server/agent-trace-context.ts` already hands agents a W3C trace
  context as `TRACEPARENT`, through `withAgentTraceContext`, which also strips one inherited
  from the daemon. `src/server/telemetry/session-trace.ts` decides each session's context.
  Reuse both rather than add a second source.

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
   ids, with header and env reference syntax checked but not resolved. It also enforces the
   credential rule in `plan.md`: a header whose name looks like a credential (`authorization`,
   `proxy-authorization`, `cookie`, or a name containing `token`, `secret`, `key`,
   `password`, `auth` or `credential`, without case) may hold only `{env:NAME}` references
   after an optional scheme word such as `Bearer`, and a URL may carry no username, password
   or query string. A refusal names the field, never its value. The `mcp` config's
   `contextDelivery` is `folded` or `argument`, with no value that omits the context.
   `classifyShaper(stored)` returns a known shaper, or an unsupported entry with its reason.
   `ShaperManifestSchema` is the strict definition plus an optional `enabled`.
   `ShapingConfigSchema` holds a list of envelopes, at most 32, with defaults (5 s, 10 s,
   16 KiB, 32 KiB) and maxima (30 s, 60 s, 64 KiB). `ShapingIntentSchema`: `upsert`, `remove`,
   `enable`, `reorder`, `settings`. `applyShapingIntent` accepts an `upsert` only when it
   passes the strict schema, and also stores off for that id in `overrides` in the same
   write, so writing a definition never switches it on. It refuses to switch an unsupported
   entry on, and carries every other entry through unchanged, unknown fields included. The pure functions each take their
   definitions as arguments so tests inject their own. `allocateBudget` likewise takes the
   total it may fill as an argument and reads no config, so a later step outside shaping can
   call it with what the shaping stages left (decision 12 in `phased-plan.md`).
   `resolveShapers` returns known shapers
   only, and implements the whole enablement and ordering rule now, including for a
   discovered list that stays empty until Phase 4. A stored choice in `overrides`, on or off,
   always wins. With no stored choice, a registered shaper is off, and a discovered one runs
   unless its manifest says `"enabled": false`. `shaperIsLocal(shaper)` says whether a shaper
   may be sent local paths. In the request's `context`, each `repositories` entry carries a
   `slot` and `target` is the slot of the repository the call is about (D17).
4. **Config entry and domain.** `shaping` in `APP_CONFIG_ENTRIES`, and a `shaping` backup
   domain.
5. **`src/server/shaping/index.ts`.** `getShapingConfig`, `applyShapingIntent`,
   `reloadShaping`, `onShapingConfigChanged`.
6. **`src/server/shaping/engine.ts`.** `shapeTask(input)`: resolve shapers, run gather then
   select, one call per shaper per repository in parallel, merge facts and summary for the
   selectors, cut a summary to 4 KiB, validate every reply with `ShapingResultSchema`, map
   every failure to an outcome, de-duplicate entries per repository, allocate the budget,
   compose the section, build the summary.
   A transport reply of any kind may carry `redacted: true`, which Phase 5 sets when it
   removed a credential value from the data or from a failure reason, and the summary records
   it for that shaper.
   Each call's timeout is the smaller of the shaper's and the time left in the step. Paths are
   put in a request only when `shaperIsLocal`. Slots are `repo-01` for the primary and then
   `repo-02` onward in attachment order. The summary records each shaper's origin and
   the SHA-256 of its definition, taken over canonical JSON for a registered shaper. The
   `TaskShaping` type also declares an optional `sessionId`, which the engine leaves unset
   and Phase 2 sets when it commits the record. An optional `input.maxSectionBytes` lowers
   the total for one launch: the section never exceeds the smaller of it and
   `limits.totalBytes`, and what does not fit is cut and recorded by the allocator's usual
   rules. Phase 2 passes it on a delivery path with a byte ceiling. An optional `input.trace`
   is the launch's W3C trace context, `{ traceparent, tracestate? }`, the shape of
   `AgentTraceContext` plus an optional `tracestate`. The engine hands it to every call
   unchanged as `ctx.trace`, and never logs or records it.
7. **Transports.** `transports/index.ts` holds the exhaustive `Record`. Every `call` receives a
   `ctx` with the deadline, an abort signal, and a per-run scope (a `shared` map and `defer`)
   so a transport can reuse one connection during a run and close it afterwards. `command.ts` runs argv
   with the request on stdin and a 256 KiB output cap, in the repository for a gatherer and in
   an empty directory for a selector. Its child environment goes through `withAgentTraceContext`,
   so it carries `TRACEPARENT`, and `TRACESTATE` when present, exactly when `ctx.trace` is set,
   and never one inherited from the daemon. `mcp.ts`, `http.ts` and `builtin.ts` each answer
   `unavailable` with a sentence naming the transport. `discovery.ts` exports
   `discoverShapers()` returning an empty list, and `references.ts` exports `referenceStatus()`
   returning an empty object, so the route reply already has its final shape.
8. **Routes.** One `requireFeature("task-shaping")` group. The test route takes a shaper id, a
   repository path and an optional prompt, and returns the engine's result for that one shaper.
   `GET /api/shaping` returns the config view, `shapingConfigView(config)` in
   `src/shared/shaping.ts`: known shapers in full, and each unsupported entry only as
   `{ id, label, unsupported: reason }`, where the reason names the failing field and never a
   value. The raw envelope stays in the daemon's storage and its settings backup, and never
   leaves the daemon otherwise. Phase 3's snapshot field and event carry the same view.
9. **Docs.** `docs/task-shaping.md` with the contract for authors and these headings for later
   phases: "Seeing what was added", "Settings", "The shaper folder", "Remote shapers", "The
   built-in gatherer". Update `docs/README.md`, `docs/feature-flags.md`, `docs/security.md`
   (local execution and what is sent), `docs/glossary.md` and the append-only list in
   `docs/agent-guides/change-contracts.md`.

## Data, API and compatibility

- No migration. One `app_config` key, optional in older snapshots.
- A stored on or off for a shaper id lives in `overrides`. `order` lists ids. Both exist now
  so Phase 4 changes no schema.
- With the flag off the three routes answer 404 and nothing reads the config. Phase 3's
  snapshot field and event follow the same gate.

## Tests and verification

- `test/shaping.test.ts`: every pure function and every intent; the enablement table in
  `plan.md`, row for row; an entry with an unknown stage or transport id that survives a
  parse and every intent unchanged, is never resolved, cannot be switched on, and cannot be
  written by `upsert`; an `upsert` over an id whose stored choice is on, left there by a
  discovered shaper, which leaves it off; a literal credential in a credential-looking
  header, and a URL with a username, password or query string, refused by `upsert` and by
  `ShaperManifestSchema` before anything is stored, with a reason that does not contain the
  value; `Bearer {env:NAME}` and a static non-secret header accepted; an unsupported entry
  whose envelope holds a literal token, which `shapingConfigView` reduces to its id, label
  and a reason without the token; the id rules; no
  `node:` import in the shared
  modules.
- `test/shaping-engine.test.ts`: stage order, parallel calls, the hand-off, the summary cut,
  timeouts and the deadline, partial results, each outcome, two repositories whose entries
  share an id but differ, which both reach the section, two attached worktrees of one
  repository, whose requests differ only in `context.target`, and a `redacted` mark carried
  into the summary from a data reply and from a failed one, and a `maxSectionBytes` below
  `limits.totalBytes` that cuts the section and records it as truncated, and `input.trace`
  reaching every call of a run as `ctx.trace` unchanged while appearing in no summary or
  record.
- `test/shaping-transport-command.test.ts` with a fixture script under `test/fixtures/`: argv
  without a shell, the scrubbed environment, stdin and stdout, the cap, a timeout, and trace
  context: with `ctx.trace` set, `TRACEPARENT` is present and well-formed (`00-`, 32 hex,
  `-`, 16 hex, `-`, 2 hex) and `TRACESTATE` is present when the context has one; with none,
  both are absent, even when the daemon's own environment has a `TRACEPARENT`.
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
- For Phase 7: the stage tuple and the engine loop take `route` as an append, and
  `allocateBudget` already takes its total as an argument. D17's two fields are declared here.
- Complete-set audit: every decision in `plan.md` is owned by exactly one phase. D1, D2, D8,
  D9 and the engine half of D3 are here.
- Review history: plan validation and the review of pull request #1546 changed this phase
  in several rounds. The rules they produced are stated in the steps above and in
  `phased-plan.md` decisions 9 to 15, and the pull request's review threads record each
  finding and its change.
