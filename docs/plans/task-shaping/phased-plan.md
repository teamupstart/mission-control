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
   state is tested, and it is what a build reports for any transport it cannot run.
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
| Schemas and pure logic | 1 | `src/shared/shaping.ts`: `ShapingRequestSchema`, `ShapingResultSchema`, `ShaperSchema`, `ShaperManifestSchema`, `ShapingConfigSchema` (`caller`, `limits`, `shapers`, `overrides`, `order`), `ShapingIntentSchema`, `TaskShaping`, `resolveShapers(config, discovered, input)`, `applyShapingIntent`, `allocateBudget`, `composeShapingSection`, `summariseShaping` |
| Engine | 1 | `shapeTask(input)` in `src/server/shaping/engine.ts` resolves to `{ summary, section }`. It never throws. `summary` is null and `section` is empty when no shaper applied. |
| Transport | 1 | `call(request, shaper, ctx)` resolves to `{ kind: "data", data }` or `{ kind: "failed" or "timed_out" or "unavailable", reason }`. `ctx` carries the deadline, a signal and a per-run scope. One file per transport in `src/server/shaping/transports/`. |
| Enablement | 1 | In `resolveShapers`: a registered shaper runs when `overrides[id]` is true. A discovered one runs unless `overrides[id]` is false or its manifest says `"enabled": false`. |
| HTTP | 1 | `GET /api/shaping` returns `{ config, discovered, references }`. `PUT /api/shaping` takes one intent. `POST /api/shaping/test` dry-runs one shaper. |
| Task record | 2 | `Task.shaping`, `TaskSummary.shaping`, column `tasks.shaping`, table `task_shaping_text`, `GET /api/tasks/:id/shaping` |
| Event | 3 | `shaping_config`, and the snapshot field `shaping` |
| Backup domain | 1, then 3 | Id `shaping`. Surface `runtime` after Phase 1, `settings` after Phase 3. |
| Folder | 4 | `shapers/<id>/shaper.json` under the state home, read by `discoverShapers()` in `src/server/shaping/discovery.ts` |
| References | 5 | `resolveReferences` and `referenceStatus` in `src/server/shaping/references.ts` |
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
| D8 and D9 budgets | 1 |
| D10 lesson promotion | Not built. 5 leaves the references and egress helpers reusable |
| D11 call site | 2 |

## Final verification

After the last phase merges: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`,
`npm run smoke` and `npm run test:e2e` pass. Then one walkthrough with the flag on: register a
`command` gatherer and an `mcp` selector against the fixture server, drop a third shaper into
the folder, dispatch a two-repository task, and confirm "Shaping context", the section in turn
one, the viewer's entries and origins, a `degraded` marker when the fixture is slow, and a
byte-identical launch with the flag off.
