# Task shaping: phased implementation plan

Source plan: `docs/plans/task-shaping/plan.md`. Its decisions D1 to D11 and D4a, submitted by
the operator on 2026-11-19, and D12 to D17, added on 2026-11-20, are requirements here, not
open questions. Seven phases, one pull request and one scheduled task each.

## What the repository looks like today

Each phase document cites the findings it depends on. The ones that shaped the split:

- `composeTurnOne` is a synchronous closure in `Dispatcher.dispatch`
  (`src/server/dispatcher.ts:721-731`), called at lines 732 and 743, after three awaits. One
  more await fits between lines 720 and 721. `withTaskKindContract` only appends.
- `TaskManager.assign` and `dispatchPipeline` compose their own first prompts. `assign` is
  shaped too (decision 21); pipelines are not.
- Dispatch is fire-and-forget, so a result can only live on the task record.
- The feature-flag registry ships empty, and a test asserts it.
- `test/settings-backup-coverage.test.ts` requires every `settings`-surface backup domain to
  be named by a Settings control.
- `VISIBLE_SETTINGS_CATEGORIES` is frozen at module load, and a flag-gated category must
  follow its flag live.
- `run()` cannot be aborted, and every direct child-process call is registered in
  `test/executable-contracts.test.ts`.
- The daemon has no generic MCP tool-calling client. `get_task` and `list_tasks` return JSON.
- FR-05 repository task skills (the same closure) and `mctl` are not on `main`. FR-05's open
  pull request #1565 appends the repository's task skill last in `composeTurnOne`.
- The after-work step starts in one place, `WorkflowEngine.activateSubmission`. A task with
  no workflow never reaches it: `claimCompletion` answers `no_binding`.
- Mission Control can check only the skills in its own catalog. `PendingTurnManager` already
  delivers turns the daemon wrote, when a session settles idle.

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
7. **Prompt-size measurement belongs to Phase 2**, which owns the seam. It also budgets each
   launch against its delivery path's byte ceiling, measured over the whole turn one, and a
   launch argument also against the platform's combined argument-and-environment limit,
   measured over the launch's actual argv and environment.
8. **A local `command` call is bounded by its timeout.** `run()` cannot be aborted, so the step
   deadline is enforced by giving each call the time that is left.
9. **Every `mcp` shaper receives the complete collected input.** `contextDelivery` is
   `folded`, exactly FR-02's three arguments with the rest of the input rendered into
   `task`, or `argument`, four arguments adding `context`. No mode omits any of it.
10. **A stored choice always wins over a manifest.** `plan.md` has the table, and
    `resolveShapers` is the only place the rule lives.
11. **Stored shapers are parsed in two layers**, a lenient envelope and the strict
    definition, so an entry this build does not understand is kept on every write and never
    called. `plan.md` states the rule under "Stored shapers this build does not understand".
12. **FR-06 lesson selection is a step after shaping, not a shaper.** It runs after the last
    shaping stage and before `composeTurnOne`, is not an id in `SHAPING_STAGES` or
    `SHAPING_BUILTINS`, is built by no phase here, and is allocated last from the one context
    budget. `plan.md` states the rule under "Lesson selection at dispatch (FR-06)".
13. **Rules from the review of the plan pull request**, each stated in `plan.md` and owned by
    the phases in brackets. The task record is committed once turn one is delivered, names
    its session, and keeps a failed run `degraded` (2). Credential values are redacted from
    every reply without changing a schema key (1, 5). The section fits a delivery path's byte
    ceiling and the combined argument-and-environment limit (1, 2). Every folder scan reads
    and hashes every manifest and checks a `./` executable's ownership (4). The built-in
    gatherer verifies the file it opened (6). Egress follows the resident MCP rule, and every
    MCP message is capped at 256 KiB (5). An `upsert` stores off for its id (1, 3). The
    shaping snapshot and event follow the flag and carry only the config view (1, 3).
    Phase 4 depends on Phases 2 and 3.
14. **Every shaper call carries the launch's trace context**, the one the session's agent gets
    from `sessionTraceContext`, and a configured `traceparent` or `tracestate` is always
    removed first. Phase 1 owns `input.trace`, `ctx.trace` and the `command` carrier, Phase 2
    passes it in, and Phase 5 owns the `mcp` and `http` carriers. A trace value is never a
    credential. A Mission Control span for the shaping run is later work.
15. **A credential is never literal in config.** Phase 1's strict schema requires
    `{env:NAME}` references for credential-looking headers and refuses credentials in a URL,
    for the API, a Settings import and a folder manifest alike.

16. **Phase 7 was added on 2026-11-20**, when FR-04 published `route_skills` (D12). It is one
    phase: the route record, the section and the after-work prompt are one proof, and the
    browser test needs all three.
17. **Routed skills ride in Phase 2's summary, and prompt rows get their own table**, so
    `tasks.shaping` keeps one writer. Phase 7 takes the schema step after Phase 2's.
18. **Routed skills have a 3 KiB reserve.** The source plan fills the budget in pipeline
    order, so guidance that filled the total would drop every routed skill. The reserve is
    taken before entries are allocated, and only while a router applies.
19. **Every request names its repository by slot (D17).** The review of pull request #1546
    asked for it and the merge came first. Phase 1 owns the two fields and Phase 5 the folded
    line.
20. **The after-work prompt uses the daemon's existing outbox**, not a new delivery path. It
    waits for an idle session, is recorded as daemon-written, and survives a restart.
21. **Every launch is shaped, through `Dispatcher.dispatch` or `TaskManager.assign`.** The
    operator decided on 2026-11-20 to shape autopilot's handover of a backlog task to a running
    agent as well. Phase 2 owns both call sites, which share one input builder, one section
    helper and the one commit, under the receiving session's id once the inject succeeds.
    `shapingView(task)` beside `currentShaping(task)` reports `shaping` while either step runs.

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
| 7. Route stage | 850 to 1,150 |
| Total | 4,250 to 5,850 |

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
- **7 is separate from 2 and 5.** It needs both merged, its contract arrived after they were
  planned, and it adds the only behaviour after dispatch. Decision 16 says why it is not split.

## Phases

| Phase | File | Depends on |
| --- | --- | --- |
| 1. Shaping core | `phase-1-shaping-core.md` | This plan merged |
| 2. Dispatch seam and visibility | `phase-2-dispatch-seam-and-visibility.md` | 1 |
| 3. Settings panel | `phase-3-settings-panel.md` | 1 |
| 4. Shaper folder | `phase-4-shaper-folder.md` | 2 and 3 |
| 5. Remote transports | `phase-5-remote-transports.md` | 1 |
| 6. Repository-files gatherer | `phase-6-repository-files-gatherer.md` | 1 |
| 7. Route stage | `phase-7-route-stage.md` | 1, 2 and 5 |

- **Concurrency.** After Phase 1: phases 2, 3, 5 and 6 together. Phase 4 follows Phases 2
  and 3. Phase 7 follows Phases 2 and 5, beside 3, 4 and 6.
- **Merge order.** Any order that respects the table's last column. Phases 1 and 2 are the
  first slice (D3).
- **Why concurrent phases do not collide.** Each owns its own files: Phase 2 the dispatcher and
  session surfaces, Phase 3 the Settings files, Phase 5 `transports/mcp.ts`, `transports/http.ts`
  and `references.ts`, Phase 6 `transports/builtin.ts` and `builtin/`, Phase 7 `after-work.ts`, and it edits
  Phase 5's files only after Phase 5 has merged. Shared tuples, schemas, the
  route reply and the guide's headings are fixed by Phase 1.

## Cross-phase contracts

| Contract | Owner | Shape |
| --- | --- | --- |
| Flag | 1 | `task-shaping`, stage `preview` |
| Registry data | 1 | `src/shared/shaping-registry.ts`: `SHAPING_STAGES` (`gather`, `select`), `SHAPING_TRANSPORTS` (`command`, `mcp`, `http`, `builtin`), `SHAPING_BUILTINS` (`repository-files`), `SHAPING_OUTCOMES`, `SHAPING_ORIGINS`, `SHAPING_REFERENCE_KINDS` and retired tuples. Phase 7 appends `route` and adds `SHAPING_LIFECYCLE_POINTS`, `SHAPING_SKILL_STATES` and `SHAPING_PROMPT_STATES`. |
| Schemas and pure logic | 1 | `src/shared/shaping.ts`: `ShapingRequestSchema`, `ShapingResultSchema`, `StoredShaperSchema` (the stored envelope), `ShaperSchema` (the strict definition), `classifyShaper`, `ShaperManifestSchema`, `ShapingConfigSchema` (`caller`, `limits`, `shapers`, `overrides`, `order`), `ShapingIntentSchema`, `TaskShaping`, `resolveShapers(config, discovered, input)`, `applyShapingIntent`, `allocateBudget`, `composeShapingSection`, `summariseShaping` |
| Engine | 1 | `shapeTask(input)` in `src/server/shaping/engine.ts` resolves to `{ summary, section }`. It never throws. `summary` is null and `section` is empty when no shaper applied. An optional `input.maxSectionBytes` lowers the total for one launch, and an optional `input.trace` is the launch's W3C trace context. |
| Transport | 1 | `call(request, shaper, ctx)` resolves to `{ kind: "data", data, redacted? }` or `{ kind: "failed" or "timed_out" or "unavailable", reason, redacted? }`. `ctx` carries the deadline, a signal, a per-run scope and the run's trace context, `ctx.trace`, or null. One file per transport in `src/server/shaping/transports/`. `redacted` is true when the transport removed a resolved `{env:NAME}` value from the data or from the reason. |
| Enablement | 1 | In `resolveShapers` only. A stored choice in `overrides`, on or off, always wins. With no stored choice, a registered shaper is off, and a discovered one runs unless its manifest says `"enabled": false`. An `upsert` stores off for its id in the same write, so writing a definition never switches it on. |
| Context budget | 1 | One total, `limits.totalBytes`, filled in pipeline order by `allocateBudget`, which takes the total it may fill as an argument and reads no config. The summary's `bytes` is what the shaping stages used. A later step outside shaping, which is FR-06 lesson selection, is allocated last, from the remainder. |
| Unknown ids | 1 | The config stores `StoredShaperSchema` envelopes. An entry that fails the strict `ShaperSchema` is unsupported: never resolved or called, never switched on, and carried through every write unchanged. `upsert` accepts only a strict definition. |
| HTTP | 1 | `GET /api/shaping` returns `{ config, discovered, references }`, where `config` is the config view: known shapers in full, and each unsupported entry only as its id, label and a reason. The raw envelope never leaves the daemon. `PUT /api/shaping` takes one intent. `POST /api/shaping/test` dry-runs one shaper. |
| Task record | 2 | `Task.shaping`, `TaskSummary.shaping`, column `tasks.shaping`, table `task_shaping_text`, `GET /api/tasks/:id/shaping`. The record describes the latest launch that reached a worker. It is committed in one transaction when turn one has been handed to the worker: the summary is set, null when no shaper applied, and the text replaced, deleted when the section is empty. A dispatch that fails earlier writes nothing. Each record names the session it was delivered to (`sessionId`), and every reader, task reads and markers included, applies `currentShaping(task)` so it shows the record only while it names the task's current session. `currentShaping` stays exported from `src/shared/shaping.ts` with this signature, because FR-05's dispatch inbox builds its `shaping {state, summary}` from it. |
| Event | 3 | `shaping_config`, and the snapshot field `shaping`, both sent only while the flag is on and both carrying Phase 1's config view, never raw envelopes. Turning the flag on emits the config to open windows, and turning it off emits a cleared one. |
| Backup domain | 1, then 3 | Id `shaping`. Surface `runtime` after Phase 1, `settings` after Phase 3. |
| Folder | 4 | `shapers/<id>/shaper.json` under the state home, read by `discoverShapers()` in `src/server/shaping/discovery.ts`. Every scan reads and hashes every manifest, and only parsing is cached. |
| References | 5 | `resolveReferences`, `referenceStatus` and `scrubResolved` in `src/server/shaping/references.ts`. Every reply and reason is scrubbed of resolved `{env:NAME}` values before it reaches the engine. Schema keys are never changed, and a fact name or entry id that contains a value is dropped, not renamed. A literal credential never reaches a transport, because Phase 1's schema requires references for credential-looking headers. |
| MCP context delivery | 1 (schema), 5 (behaviour) | `contextDelivery` is `folded` or `argument`. `folded` calls the tool with exactly three arguments, `{ task, repo, version? }`, with every field of `context` except local paths rendered into `task` by one pure function. `argument` calls it with four, `{ task, repo, version?, context }`. Both deliver the complete collected input, and no mode omits it. |
| Repository slots | 1 (fields), 5 (folded line) | Each `context.repositories` entry has a `slot`, `repo-01` for the primary and then in attachment order. `context.target` is the slot a call is about (D17). |
| Route | 7 | `ShapingRouteResultSchema`: `{ version?, skills: [{ name, lifecycle_point, reason_id }], truncated?, degraded?, notes? }`. A route request adds `context.guidance`, `{ shaper, id }` per selected entry. The summary gains `skills`, and the engine's `section` ends with "Skills for this task". |
| After-work prompt | 7 | `promptAfterWorkSkills(sessionId)`, called when a submission is activated and when a completion claim finds no binding, where the prompt is held until Foreman's wrap-up is answered. Once per launch. Table `task_skill_prompts`, keyed by task and session, read as `shaping.afterWork`. |
| Turn-one order | 2, then 7 | Kind contract, task context, skills for this task, repository lessons (FR-06), FR-05's repository task skill last. Whichever of Phase 7 and FR-05's reader merges second wires `repositoryTaskSkills` (D14), and Phase 7's order test fails until it does. |
| Guide | 1 | `docs/task-shaping.md`, one section per phase |

## Who owns each decision

| Decision | Phase |
| --- | --- |
| D1 names | 1, and every phase uses them |
| D2 transports | `command` in 1, `mcp` and `http` in 5, `builtin` in 6 |
| D3 first slice | 1 (engine) and 2 (dispatch and visibility) |
| D4 install paths | Registered: the API in 1 and Settings in 3. Folder: 4 |
| D4a enabled on discovery | 4, using the rule 1 puts in `resolveShapers` |
| D5 skill routing | 7, which appends `route` to the stage tuple 1 declares |
| D6 identity and references | Syntax in 1, the identity setting in 3, resolution in 5 |
| D7 where `degraded` shows | 2 |
| D8 and D9 budgets | 1. D9's total also bounds FR-06's later lesson step, which is allocated last (decision 12 above) |
| D10 lesson promotion | Not built. 5 leaves the references and egress helpers reusable. Lesson selection at dispatch is a different FR-06 step and is not a shaper (decision 12 above) |
| D11 call site | 2 |
| D12 delivery, D13 guidance ids, D14 the repository's skill wins, D15 skill names, D16 prompt timing | 7 |
| D17 repository slots | 1 (the fields), 5 (the folded line) |
| Trace context (decision 14) | 1 (`input.trace`, `ctx.trace`, the `command` carrier), 2 (passes it in), 5 (the `mcp` and `http` carriers) |

## Final verification

After the last phase merges: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`,
`npm run smoke` and `npm run test:e2e` pass. Then one walkthrough with the flag on: register a
`command` gatherer, an `mcp` selector and a router against the fixture server, then switch all
three on, since registration stores each off. Drop a fourth shaper into the folder, dispatch a
two-repository task, and confirm "Shaping context", both sections in turn one, an outcome
recorded for each of the three registered shapers as well as the discovered one (a section the
discovered shaper could produce alone is not evidence that any registered shaper ran), the
viewer's entries, skills and origins, the after-work prompt once the work is submitted, a
`degraded` marker when the fixture is slow, and a byte-identical launch with the flag off.
