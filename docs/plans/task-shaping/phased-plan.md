# Task shaping: phased implementation plan

Source plan: `docs/plans/task-shaping/plan.md`. Its decisions D1 to D11 and D4a, submitted by
the operator on 2026-11-19, are requirements here, not open questions. Six phases, one pull
request and one scheduled task each.

## What the repository looks like today

Each phase document cites the findings it depends on. The ones that shaped the split:

- `composeTurnOne` is a synchronous closure in `Dispatcher.dispatch`
  (`src/server/dispatcher.ts:721-731`), called at lines 732 and 743, after three awaits. One
  more await fits between lines 720 and 721. `withTaskKindContract` only appends.
- `TaskManager.assign` and `dispatchPipeline` compose their own first prompts.
- Dispatch is fire-and-forget, so a result can only live on the task record.
- The feature-flag registry ships empty, and a test asserts it.
- `test/settings-backup-coverage.test.ts` requires every `settings`-surface backup domain to
  be named by a Settings control.
- `VISIBLE_SETTINGS_CATEGORIES` is frozen at module load, and a flag-gated category must
  follow its flag live.
- `run()` cannot be aborted, and every direct child-process call is registered in
  `test/executable-contracts.test.ts`.
- The daemon has no generic MCP tool-calling client. `get_task` and `list_tasks` return JSON.
- FR-05 repository task skills (the same closure) and `mctl` are not on `main`.

## Decisions made while phasing

1. **Six phases, not the nine the source plan sketched.** Selection and budgets are part of the
   engine, the `http` transport shares everything with `mcp`, and documentation ships with the
   behaviour it describes, so there is no documentation-only phase. The `default-on` pull request
   is the flag lifecycle's second step and is outside this plan.
2. **Phase 1 declares all four transport ids and their config schemas.** Persisted id tuples
   are append-only, and three concurrent phases appending to one tuple would collide. Until its
   phase lands, `mcp`, `http` and `builtin` each answer `unavailable` from their own file. That
   state is tested. An id that is not in the tuple at all is a different case: such an entry
   is unsupported and is never called (decision 11).
3. **The backup domain starts on the `runtime` surface.** Phase 1 has no Settings control, so
   the `shaping` domain cannot be on the `settings` surface yet. Phase 3 moves it. The persisted
   id does not change. The feature-flag core did the same.
4. **The `GET /api/shaping` reply has its final shape from Phase 1**, with `discovered` and
   `references` empty, so phases 4 and 5 fill their own field without editing each other's.
5. **The guide has its section headings from Phase 1.** Each later phase fills only its own
   section of `docs/task-shaping.md`.
6. **Task reads carry a field, not a line.** The source plan described a text line in the MCP
   task reads. Those tools return JSON, so the record gains a `shaping` field with a one-line
   `summary`.
7. **Prompt-size measurement belongs to Phase 2**, which owns the seam.
8. **A local `command` call is bounded by its timeout.** `run()` cannot be aborted, so the step
   deadline is enforced by giving each call the time that is left.
9. **An `mcp` shaper always receives the complete collected input.** Plan validation found
   that the first version of `contextDelivery` had a mode that sent none of it and a default
   that folded only three fields into `task`. There are now two modes, `folded` and
   `argument`, and both carry everything constraint C2 lists. `folded` calls the tool with
   exactly FR-02's three arguments, so `get_guidance` is unchanged. `argument` calls it with
   four, adding `context`, and is for a server whose tool declares that argument.
10. **A stored choice always wins over a manifest.** Plan validation found two statements of
    the enablement rule that disagreed about a discovered shaper whose manifest says
    `"enabled": false` while the operator has switched it on. The stored choice wins, on or
    off. `plan.md` has the table, and `resolveShapers` is the only place the rule lives.
11. **Stored shapers are parsed in two layers.** A single strict schema could not preserve an
    entry whose stage or transport id this build does not know. The config stores a lenient
    envelope, the strict definition is checked per entry, and every write carries the other
    entries through unchanged. `plan.md` states the rule under "Stored shapers this build does
    not understand".
12. **FR-06 lesson selection is a step after shaping, not a shaper.** Plan validation found
    `plan.md` describing it twice, as a later stage and as a built-in selector. It has one
    placement: a step of its own after the last shaping stage and before `composeTurnOne`,
    which is where FR-06 puts it, because it selects only the lessons that `select` and
    `route` did not already deliver. It is not an id in `SHAPING_STAGES` or
    `SHAPING_BUILTINS`, and no phase here builds it. It shares the one context budget by being
    allocated last: it is given `limits.totalBytes` less the `bytes` the shaping summary
    records, and lessons are fitted into that remainder by `allocateBudget`. `plan.md` states
    the rule under "Lesson selection at dispatch (FR-06)".
13. **Rules from the review of the plan pull request.** The operator chose each on
    2026-11-19. The task record describes the latest launch that reached a worker: it is
    committed when turn one has been handed over and names the session that
    received it, a launch that no shaper applied to clears
    what an earlier launch left, and a launch whose shapers all failed keeps its own degraded
    summary with no text (Phase 2). A resolved `{env:NAME}` value is redacted from every
    reply, data or failure, before it reaches the engine, and the shaper is marked `redacted`
    (Phases 1 and 5). Every folder scan reads and hashes every manifest instead of trusting
    its size and modification time (Phase 4). The built-in gatherer verifies containment and
    size on the file it opened, through a non-blocking open, not on a path checked beforehand
    (Phase 6). Egress follows the rule resident MCP servers already use: HTTPS, except plain
    HTTP to loopback (Phase 5).

## Size and phase count

Estimated non-test production lines, counting shared, daemon and dashboard code together.

| Phase | Estimate |
| --- | --- |
| 1. Shaping core | 1,100 to 1,450 |
| 2. Dispatch seam and visibility | 550 to 750 |
| 3. Settings panel | 650 to 900 |
| 4. Shaper folder | 350 to 500 |
| 5. Remote transports | 550 to 750 |
| 6. Repository-files gatherer | 220 to 320 |
| Total | 3,400 to 4,700 |

The total is far above the one-phase threshold. Why each boundary exists:

- **1 is not split.** The contract, the stored config and the engine are one decision. Splitting
  them would publish schemas with no reader.
- **2 is separate from 1.** It edits a hot file under byte-identical tests and adds dashboard
  surfaces. Phase 1 has neither, and is already the largest phase.
- **3 is separate from 2.** Settings is a different surface with its own exhaustive tests, and it
  can be built at the same time.
- **4 is separate from 3.** Enabled-on-discovery is the plan's most security-sensitive choice and
  should be reviewed alone, not inside a Settings pull request.
- **5 and 6 are separate leaves.** Network transports and worktree file reading share no code or
  risk, and neither blocks the first slice.

## Phases

| Phase | File | Depends on |
| --- | --- | --- |
| 1. Shaping core | `phase-1-shaping-core.md` | This plan merged |
| 2. Dispatch seam and visibility | `phase-2-dispatch-seam-and-visibility.md` | 1 |
| 3. Settings panel | `phase-3-settings-panel.md` | 1 |
| 4. Shaper folder | `phase-4-shaper-folder.md` | 3 |
| 5. Remote transports | `phase-5-remote-transports.md` | 1 |
| 6. Repository-files gatherer | `phase-6-repository-files-gatherer.md` | 1 |

- **Concurrency.** After Phase 1: phases 2, 3, 5 and 6 together. Phase 4 follows Phase 3.
- **Merge order.** Any order that respects the table's last column. Phases 1 and 2 are the
  first slice (D3).
- **Why concurrent phases do not collide.** Each owns its own files: Phase 2 the dispatcher and
  session surfaces, Phase 3 the Settings files, Phase 5 `transports/mcp.ts`, `transports/http.ts`
  and `references.ts`, Phase 6 `transports/builtin.ts` and `builtin/`. Shared tuples, schemas, the
  route reply and the guide's headings are fixed by Phase 1.

## Cross-phase contracts

| Contract | Owner | Shape |
| --- | --- | --- |
| Flag | 1 | `task-shaping`, stage `preview` |
| Registry data | 1 | `src/shared/shaping-registry.ts`: `SHAPING_STAGES` (`gather`, `select`), `SHAPING_TRANSPORTS` (`command`, `mcp`, `http`, `builtin`), `SHAPING_BUILTINS` (`repository-files`), `SHAPING_OUTCOMES`, `SHAPING_ORIGINS`, `SHAPING_REFERENCE_KINDS` and retired tuples |
| Schemas and pure logic | 1 | `src/shared/shaping.ts`: `ShapingRequestSchema`, `ShapingResultSchema`, `StoredShaperSchema` (the stored envelope), `ShaperSchema` (the strict definition), `classifyShaper`, `ShaperManifestSchema`, `ShapingConfigSchema` (`caller`, `limits`, `shapers`, `overrides`, `order`), `ShapingIntentSchema`, `TaskShaping`, `resolveShapers(config, discovered, input)`, `applyShapingIntent`, `allocateBudget`, `composeShapingSection`, `summariseShaping` |
| Engine | 1 | `shapeTask(input)` in `src/server/shaping/engine.ts` resolves to `{ summary, section }`. It never throws. `summary` is null and `section` is empty when no shaper applied. |
| Transport | 1 | `call(request, shaper, ctx)` resolves to `{ kind: "data", data, redacted? }` or `{ kind: "failed" or "timed_out" or "unavailable", reason, redacted? }`. `ctx` carries the deadline, a signal and a per-run scope. One file per transport in `src/server/shaping/transports/`. `redacted` is true when the transport removed a resolved `{env:NAME}` value from the data or from the reason. |
| Enablement | 1 | In `resolveShapers` only. A stored choice in `overrides`, on or off, always wins. With no stored choice, a registered shaper is off, and a discovered one runs unless its manifest says `"enabled": false`. |
| Context budget | 1 | One total, `limits.totalBytes`, filled in pipeline order by `allocateBudget`, which takes the total it may fill as an argument and reads no config. The summary's `bytes` is what the shaping stages used. A later step outside shaping, which is FR-06 lesson selection, is allocated last, from the remainder. |
| Unknown ids | 1 | The config stores `StoredShaperSchema` envelopes. An entry that fails the strict `ShaperSchema` is unsupported: never resolved or called, never switched on, and carried through every write unchanged. `upsert` accepts only a strict definition. |
| HTTP | 1 | `GET /api/shaping` returns `{ config, discovered, references }`. `PUT /api/shaping` takes one intent. `POST /api/shaping/test` dry-runs one shaper. |
| Task record | 2 | `Task.shaping`, `TaskSummary.shaping`, column `tasks.shaping`, table `task_shaping_text`, `GET /api/tasks/:id/shaping`. The record describes the latest launch that reached a worker. It is committed in one transaction when turn one has been handed to the worker: the summary is set, null when no shaper applied, and the text replaced, deleted when the section is empty. A dispatch that fails earlier writes nothing. Each record names the session it was delivered to (`sessionId`), and readers show it only for that session. |
| Event | 3 | `shaping_config`, and the snapshot field `shaping` |
| Backup domain | 1, then 3 | Id `shaping`. Surface `runtime` after Phase 1, `settings` after Phase 3. |
| Folder | 4 | `shapers/<id>/shaper.json` under the state home, read by `discoverShapers()` in `src/server/shaping/discovery.ts`. Every scan reads and hashes every manifest, and only parsing is cached. |
| References | 5 | `resolveReferences`, `referenceStatus` and `scrubResolved` in `src/server/shaping/references.ts`. Every reply and reason is scrubbed of resolved `{env:NAME}` values before it reaches the engine. |
| MCP context delivery | 1 (schema), 5 (behaviour) | `contextDelivery` is `folded` or `argument`. `folded` calls the tool with exactly three arguments, `{ task, repo, version? }`, with every field of `context` except local paths rendered into `task` by one pure function. `argument` calls it with four, `{ task, repo, version?, context }`. Both deliver the complete collected input, and no mode omits it. |
| Guide | 1 | `docs/task-shaping.md`, one section per phase |

## Who owns each decision

| Decision | Phase |
| --- | --- |
| D1 names | 1, and every phase uses them |
| D2 transports | `command` in 1, `mcp` and `http` in 5, `builtin` in 6 |
| D3 first slice | 1 (engine) and 2 (dispatch and visibility) |
| D4 install paths | Registered: the API in 1 and Settings in 3. Folder: 4 |
| D4a enabled on discovery | 4, using the rule 1 puts in `resolveShapers` |
| D5 skill routing | Not built. The stage tuple in 1 is where `route` is appended once FR-04 publishes a contract |
| D6 identity and references | Syntax in 1, the identity setting in 3, resolution in 5 |
| D7 where `degraded` shows | 2 |
| D8 and D9 budgets | 1. D9's total also bounds FR-06's later lesson step, which is allocated last (decision 12 above) |
| D10 lesson promotion | Not built. 5 leaves the references and egress helpers reusable. Lesson selection at dispatch is a different FR-06 step and is not a shaper (decision 12 above) |
| D11 call site | 2 |

## Final verification

After the last phase merges: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`,
`npm run smoke` and `npm run test:e2e` pass. Then one walkthrough with the flag on: register a
`command` gatherer and an `mcp` selector against the fixture server, drop a third shaper into
the folder, dispatch a two-repository task, and confirm "Shaping context", the section in turn
one, the viewer's entries and origins, a `degraded` marker when the fixture is slow, and a
byte-identical launch with the flag off.
