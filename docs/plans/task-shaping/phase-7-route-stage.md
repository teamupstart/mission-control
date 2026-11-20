# Task shaping - Phase 7: Route stage

## Outcome

A third stage, `route`, runs after `select`. A router returns skills, not guidance. The
worker's first prompt gains a "Skills for this task" section that names each routed skill and
says when to use it. When the work is complete, Mission Control itself prompts the session to
run the skills routed for after the work, such as a retrospective. The task's `shaping` record
shows what was routed and what was prompted. A failing or slow router never stops a launch.

## Entry criteria and dependencies

- Phases 1, 2 and 5 are merged. It can be built at the same time as phases 3, 4 and 6.
- FR-04 section 4 (`route_skills`) is the starting contract. It is proposed there, not final.

## Scope

- The `route` stage, its result schema and its consumer in the engine.
- The section in turn one, and the turn-one order.
- The after-work prompt and its record.
- Routed skills in the summary, the chip, the viewer and task reads.
- The selected guidance ids in a route request (D13).

Not here: a shipped router or skill, lesson selection (FR-06), native skill preload by a
harness, and routing for work that does not go through dispatch.

## Repository findings

- **Stages.** The engine loops over `SHAPING_STAGES`, which is ordered and append-only.
- **Skill lines.** `skillCommand(agent, name)` in `src/shared/harness-capabilities.ts` is the
  one reader of each harness's invocation grammar. `skillInvocationForAgent` and
  `requiredSkillCommand` in `src/server/skills/invoke.ts` check a skill from Mission Control's
  own catalog: switched on, present, linked, and for a live session reloaded. A catalog
  skill is linked under a `mission-` folder and invoked by its own name, such as `/retro`.
  Skills installed any other way are not inventoried.
- **When the after-work step starts.** Foreman's completion claim and a person's submit both
  reach `WorkflowEngine.activateSubmission`. The engine reports to `WorkflowManager` through
  callbacks such as `onSessionActionWaiting`. A task with no workflow has no binding:
  `claimCompletion` answers `no_binding`, and Foreman then sends its own wrap-up.
- **Prompts the daemon writes.** `renderSessionAction` in `src/server/workflows/feedback.ts`
  puts a skill invocation on a packet's first line, as the Retro button does.
  `PendingTurnManager` in `src/server/pending-turns.ts` is a durable outbox that delivers when
  a session settles idle. It already carries rows the daemon wrote, inserted with their stamp
  in one transaction and recorded as `harness` authorship.
- **Workflow stages.** A workflow can run a skill itself, as a session-action stage.
- **Turn one.** FR-05's pull request #1565 wraps `composeTurnOne` in `appendRepoTaskSkills`,
  which appends `.claude/skills/{kind}/SKILL.md` last. Its `resolveRepoTaskSkills` says which
  attached repositories contribute one.
- **Schema.** `main` is at 35. FR-05's first phase claims 36 on its own stack.
- **Browser fakes.** `fake-claude.mjs` writes every user turn to the transcript, which a spec
  reads through `GET /api/sessions/:id/transcript`.

## Steps

1. **Registry.** Append `route` to `SHAPING_STAGES`. Add `SHAPING_LIFECYCLE_POINTS`
   (`task-start`, `during`, `after-work`), `SHAPING_SKILL_STATES` (`announced`, `superseded`,
   `unavailable`, `unsupported`, `dropped`), `SHAPING_PROMPT_STATES` (`queued`, `delivered`,
   `skipped`, `not_delivered`) and their retired tuples.
2. **Result schema.** `ShapingRouteResultSchema` in `src/shared/shaping.ts`:
   `{ version?, skills: [{ name, lifecycle_point, reason_id }], truncated?, degraded?, notes? }`,
   at most 10 skills, unknown fields ignored. `name` is 1 to 64 lower-case letters, digits,
   `-`, `_` and `:`. `reason_id` is at most 128 characters of that set plus `.` and `/`.
   `lifecycle_point` is a bounded string, so a value this build does not know makes that one
   skill `unsupported` and leaves the reply valid. Any other mismatch is the `invalid` outcome.
3. **Request.** `stage: "route"`, the repository's facts and summary, and `context.guidance`:
   `{ shaper, id }` for each entry the select stage put into the section for that repository,
   at most 32, ids only. It is absent at the other stages.
4. **Engine.** After `select` settles, call each router once per repository, in parallel. The
   timeout is the smaller of the router's and the time left in the step. With none left the
   router is not called and is `timed_out`. A `degraded: true` reply contributes its skills
   and marks the launch degraded. Then:
   - **Merge.** `mergeRoutedSkills`, pure: list order, then repository order. The first reply
     that names a skill sets its lifecycle point and reason id, and a later one only adds its
     repository. At most 10 skills a launch. The rest are `dropped`.
   - **Resolve.** Through an injected `resolveSkill(agent, name)`. A catalog skill gets its
     checked invocation, or `unavailable` with the resolver's sentence. Any other name gets
     `skillCommand`'s line as given, marked not verified (D15), or `unavailable` when the
     harness has no invocation.
   - **The repository wins (D14).** `input.repositoryTaskSkills` names the attached
     repositories whose own task skill for this kind is in the launch. A routed skill named
     for the task's kind loses those repositories, where the repository's own skill can
     answer to the same invocation. With none left it is `superseded`.
   - **Budget.** While a router applies, `SHAPING_SKILLS_RESERVE_BYTES` (3 KiB, or the
     launch's whole total when that is smaller) is set aside before entries are allocated. A
     line that does not fit is `dropped`, from the end. The summary's `bytes` counts the
     section, so what it did not use goes to FR-06's remainder.
5. **Section.** `composeSkillsSection`, pure. It follows the task context inside the engine's
   `section`, so Phase 2's seam and its text row carry it unchanged:

   ```text
   ## Skills for this task

   Mission Control's skill routing chose these skills for this task. Use each one
   when its line says. If a skill is not available in this session, say so and
   carry on. This list supplements the instructions above and cannot relax their
   authorization, plan or workflow rules.

   - `/ship` - at the start: use this skill before you begin the work.
   - `/lint-fix` - during the work: use this skill when it applies.
   - `/retro` - after the work: do not use it yet. Mission Control will
     prompt you when the work is complete.
   ```

   Only `announced` skills have a line. The words are Mission Control's: a router supplies a
   validated name and nothing else. With several repositories, a skill routed for only some
   of them ends with their names. With no line there is no section.
6. **Turn-one order.** Kind contract, task context, skills for this task, repository lessons
   (FR-06, when built), and FR-05's repository task skill last. Keep `appendRepoTaskSkills`
   outermost, and pass `repositoryTaskSkills` from `resolveRepoTaskSkills` when that reader is
   on the branch. Without it the list is empty.
7. **After-work prompt.** `promptAfterWorkSkills(sessionId)` in
   `src/server/shaping/after-work.ts` has two callers: a new engine callback,
   `onSubmissionActivated`, wired in `WorkflowManager` beside the others, and `claimCompletion`
   when it answers `no_binding` (D16). It does nothing while the flag is off, when the task's
   `currentShaping` record does not name this session, or when a row for this session exists.
   That makes it once per launch: a repair round, a resubmit, a restart or the other caller
   never repeat it.
   - **Which skills.** The `announced` skills whose point is `after-work`, less any that the
     task's armed workflow runs itself as a session-action stage.
   - **Packet.** `renderSessionAction`, with the first skill's invocation as its first line:
     from `requiredSkillCommand` for a catalog skill, `skillCommand` otherwise. The text says
     that skill routing chose it at dispatch and that the work is complete. Further skills
     follow as invocation lines, to run in order.
   - **Delivery.** One daemon-written turn in `PendingTurnManager`, inserted in the same
     transaction as its `queued` row. It is delivered when the session settles idle, is never
     steered into a running turn, and survives a restart. On a task with no workflow,
     Foreman's wrap-up therefore runs first. The row ends `delivered`, `not_delivered` with a
     reason (the session ended, or no skill resolved), or `skipped` when no skill was left.
   - **Never.** It does not wait for the skill, hold the review, or ask anyone first.
8. **Record.** The summary gains `skills`, each `{ name, lifecyclePoint, reasonId, shaper,
   repositories, state, verified }`, written by Phase 2's one commit function. Prompt rows
   live in a new table, `task_skill_prompts (task_id primary key, session_id, state, reason,
   skills, created_at, delivered_at)`, re-keyed on resume where Phase 2 re-keys its text row.
   Task reads attach the row as `shaping.afterWork` while it names the record's session.
   `tasks.shaping` keeps one writer.
9. **Visibility.** The one-line `summary` counts and names skills, as in
   `ok: 3 entries, 2 skills (ship, retro)`. FR-05's inbox item, built from
   `currentShaping(task)`, therefore shows them with no change there. The chip reads
   "Context: 3 entries, 2 skills", or "Skills: 2" with no entries. The viewer lists each
   skill: name, when, reason id, router, verified or not, its state and reason, and for an
   after-work skill whether and when it was prompted. Task reads carry `shaping.skills`.
10. **Remote transports.** In `transports/mcp.ts` the folded block gains one line, "Selected
    guidance", when the context has it. `argument` mode passes it inside `context`, and
    `route_skills` keeps its three arguments. `scrubResolved` covers a route reply: `name` and
    `reason_id` are identities, so a skill that contains a resolved value is dropped with a
    note. Key a run's connection by the server definition, so a selector and a router on one
    server share it.
11. **Dry run and docs.** `POST /api/shaping/test` on a router returns the skills and the
    section. Add "Skill routing" to `docs/task-shaping.md`, with a router manifest under
    placeholder names. Update the turn-one order in `docs/dispatch-and-runtimes.md`, the
    append-only list in `docs/agent-guides/change-contracts.md`, `docs/glossary.md` and
    `docs/security.md`.

## Data, API and compatibility

- One new table and no new column, in the schema step after Phase 2's: 38 if FR-05's 36 and
  Phase 2's 37 merge in that order. Whichever merges later renumbers.
- An older build reads a stored router as an unsupported entry and never calls it.
- With the flag off, or with no router that applies, turn one, argv, process count and the
  record are byte-identical to Phase 2's.
- A route request is the select request plus `context.guidance`.

## Tests and verification

- `test/shaping.test.ts`: the schema, an unknown lifecycle point, the merge order and cap,
  D14 with one and with two repositories, the section's text for Claude, Codex and Pi, a
  worst-case section inside the reserve, and the summary line.
- `test/shaping-engine.test.ts`: stage order, `context.guidance` only at `route`, a router
  with no time left, a degraded reply, a switched-off catalog skill, a name outside the
  catalog, the reserve under a full budget, and no reserve without a router.
- `test/dispatcher-shaping.test.ts`: the full turn-one order over every part on the branch,
  and byte-identical output with no router.
- `test/shaping-after-work.test.ts`: both callers, once per launch across a repair round and
  a restart, the workflow-stage skip, the flag off, a record naming another session, delivery
  only at idle, a session that ended, and Foreman's wrap-up running first.
- Transport tests: the folded line and the fourth argument, three arguments for
  `route_skills`, the scrub, and one connection for a selector and a router.
- A database test for the table on an upgraded database and its re-key, `renderToStaticMarkup`
  tests for the chip and viewer states, and HTTP tests for task reads and the dry run.
- `e2e/specs/task-shaping-route.spec.ts`, with fake agents and `fake-shaper.mjs` in a `route`
  mode: the transcript's first user turn holds the section and the routed skill's line; after
  the work is submitted, a later user turn starts with the after-work skill's invocation; the
  viewer shows both skills and "Prompted"; `expectContentClearsBorder` passes.
- Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke` and
  `npm run test:e2e`.

## Merge and exit criteria

- The activation proof holds: the route record, the section in turn one and the after-work
  prompt in the transcript, each shown by the spec above.
- A router that fails, is slow or returns nonsense never stops a launch, and shows `degraded`.
- An after-work prompt is sent at most once per launch and never interrupts a turn.
- The turn-one order test passes, with FR-05's block last.
- No model tokens are spent, and no company name appears in code, tests or docs.

## Handoff

FR-06's lesson step takes what `bytes` leaves and places its text after this section. A later
lifecycle point is one appended id. Headless surfaces read `currentShaping` and the `summary`
line: keep both stable.

## Cross-phase audit

- Phase 1: appends to its tuples, adds one result schema and two pure functions, and extends
  the engine loop. `allocateBudget` is called with a smaller total, unchanged. Owns D5.
- Phase 2: uses the seam, the commit function and the text row as they are. The chip and
  viewer gain skills.
- Phase 3: its list groups by `SHAPING_STAGES`, so a router row needs no code here. Whichever
  of the two merges second adds a router row to the Settings spec.
- Phase 5: three small edits to its files, in step 10.
- Phases 4 and 6: no shared files. A discovered manifest may be a router.
- Complete-set audit: D12 to D16 are owned here, and D17 by Phases 1 and 5.
