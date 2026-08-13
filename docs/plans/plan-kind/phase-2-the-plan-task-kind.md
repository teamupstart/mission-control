# Phase 2: The `plan` task kind

Source plan: [`plan.md`](./plan.md), rendered at [`plan.html`](./plan.html).
Index: [`phased-plan.md`](./phased-plan.md).

## 1. Outcome and value

`plan` becomes a real, durable, selectable task Kind everywhere a Kind is offered, read, drawn,
or described. After this phase a person can pick **plan** in the dispatch form, in the Recurring
Mission editor, and in a task source, see it on the backlog card and the session chip, and have
it persist and reload correctly.

The value is standalone and user-visible even before the delivery contract arrives in Phase 3: a
plan task is a task whose Kind records the intent of the work, which the backlog, the roundup
report, and Foreman's planner all read. What it does *not* yet do is change what the agent is
told, which is deliberately Phase 3's job and is what keeps this phase reviewable.

## 2. Entry criteria and direct phase dependencies

**Direct dependencies: none.** This phase touches the kind vocabulary and its presentation. It
shares no decision, schema, or file ownership with Phase 1, and the two may merge in either
order.

Entry criteria:

- The planning pull request has merged, so `docs/plans/plan-kind/` resolves on the default branch.

## 3. Scope and explicit non-goals

In scope:

- The `TASK_KINDS` tuple and both `Record<TaskKind, …>` registries.
- Every surface that presents, draws, colours, describes, or persists a kind.
- Read-path validation of the persisted column.
- The dispatch form's after-work rule for `plan`.
- Tests for all of the above, including a Playwright spec.

Explicit non-goals:

- **No prompt appendix.** A `plan` task dispatched after this phase is delivered its intent
  exactly as written, like a ship task. Phase 3 owns the contract.
- **No launch requirement changes.** `scoutMissionMcpRequirement` keeps its current behaviour and
  its current name until Phase 3.
- **No archive involvement.** Phase 4 owns capture.
- **No Foreman wrap-up change.** A completed `plan` task is classified by today's rules until
  Phase 3 changes them. This is stated so a reviewer does not read the omission as an oversight.
- **No MCP `create_task` kind parameter.** It continues to file ship tasks only.

## 4. Repository findings and inherited contracts

Verified against the planning checkout. Re-check before editing.

- `src/shared/types.ts:1426` holds `TASK_KINDS = ["ship", "scout"] as const`. Its comment states
  that array order is picker order and that `test/task-kinds.test.ts` fails on a second copy of
  the set. Append `"plan"`; do not reorder, because index 0 being `ship` is relied on.
- `src/shared/task.ts:41` `TASK_KIND_INFO` and `src/web/lib/guided-dispatch-steps.ts:203`
  `GUIDED_KIND_KEYS` are both `Record<TaskKind, …>` and will not compile until extended. Both
  carry comments naming this as the intended enforcement for a third kind.
- `GUIDED_KIND_KEYS` mnemonics are hand-chosen, not derived: `ship: "p"`, `scout: "t"`, because
  the words share a first letter. `test/guided-dispatch-steps.test.ts:207` asserts no two kinds
  claim the same letter and that the record's key count equals `TASK_KINDS.length`.
- `src/shared/task.ts:183` `taskPillParts` draws a kind badge only when `task.kind === "scout"`.
  Its comment gives the reason - every automated writer defaults to `ship`, so an unconditional
  badge would read `SHIP` on almost every session and say nothing.
- `src/web/styles.css:20459-20463` defines `.bl-kind-ship` and `.bl-kind-scout` and no fallback,
  while `src/web/components/layouts/BacklogColumn.tsx:305` renders
  `` className={`bl-kind bl-kind-${task.kind}`} ``. A third kind inherits body colour silently.
- `src/server/foreman/backlog-prompt.ts:68` describes the kind to the backlog-planner model as
  `` `kind: ${t.kind} (${t.kind === "ship" ? "deliver a change" : "investigate and report"})` ``.
  A third kind is actively mislabelled to the model, not merely omitted.
- `src/web/components/schedules/ScheduleEditor.tsx:365-372` and
  `src/web/components/TaskSourcesPanel.tsx:600-612` hand-write their `<option>` elements with
  different wording from each other and from the registry. They are the only two entries in
  `KNOWN_HAND_WRITTEN` (`test/task-kinds.test.ts:47-50`), a list the test allows to shrink and
  never grow.
- `src/server/db.ts:3232` reads the column back as `kind: r.kind as TaskKind` - an unvalidated
  cast. `src/server/schedules/store.ts:125` validates the same vocabulary with
  `readPersistedEnum(TASK_KINDS, …)` and returns `null` on an unknown value.
- `tasks.kind` is `TEXT NOT NULL` (`src/server/db.ts:136`) with no `CHECK` and no migration
  history. Adding a kind requires no migration.
- `src/web/components/DispatchModal.tsx:1049` `afterWorkForKind` implements the scout
  stash-and-restore. `:1051` is the branch keyed on `kind === "scout"`. `:2452` renders the
  contextual guided hint. `:285` is `KIND_FIELD_TIP`.
- `ReportPanel.tsx:82,559` already renders every kind unconditionally, so it needs no change.

## 5. Implementation steps, in execution order

1. **Extend the tuple.** `src/shared/types.ts:1426` becomes
   `export const TASK_KINDS = ["ship", "scout", "plan"] as const;`. Update the doc comment above
   it, which currently says "ship = deliver a change; scout = investigate/plan/audit and report"
   - note that it presently assigns "plan" to scout's description, which must change.
2. **Extend `TASK_KIND_INFO`** (`src/shared/task.ts:41`) with a `plan` entry. The `blurb` is what
   a person reads in the picker and must state both halves: that it produces a reviewed plan page
   and that it can schedule the work. Keep it one line and lowercase-labelled, matching the
   existing two. Update the module header comment at `:9`, which states "every task is a ship or
   a scout".
3. **Extend `GUIDED_KIND_KEYS`** (`guided-dispatch-steps.ts:203`) with `plan: "l"`, and extend
   the comment above it to record why `l` - `p` is `ship`'s, `t` is `scout`'s, and `l` is the
   free distinguishing letter in `plan`.
4. **Draw the badge.** `taskPillParts` (`src/shared/task.ts:183`) stops special-casing `scout`
   and instead draws any kind that is not `ship`. Update the comment, which currently justifies
   the rule by `TaskKind` having two values.
5. **Colour the chip.** Add `.bl-kind-plan` to `src/web/styles.css` beside its two siblings.
   Choose a token that is distinguishable from `--idle` (ship) and `--working` (scout) in both
   colour schemes.
6. **Fix the planner description.** Replace the ternary at `backlog-prompt.ts:68` with a lookup
   that cannot silently mislabel a future kind. Source the text from a registry rather than a
   second inline table; `TASK_KIND_INFO[kind].blurb` is the existing home for "what this kind
   means in one line" and should be reused unless its wording is wrong for a model prompt, in
   which case add a field to `TaskKindInfo` rather than a parallel record.
7. **Convert the two hand-written selects.** `ScheduleEditor.tsx:365` and
   `TaskSourcesPanel.tsx:600` render their options from `TASK_KINDS`/`TASK_KIND_INFO`. Then
   **empty `KNOWN_HAND_WRITTEN`** in `test/task-kinds.test.ts:47` and confirm the test still
   guards growth with an empty list.
8. **Validate on read.** `src/server/db.ts:3232` adopts `readPersistedEnum(TASK_KINDS, …)`.
   Decide and document the fallback for an unknown persisted kind. Unlike the schedule store,
   which can drop a whole template, a task row must still load - fall back to `ship` and treat it
   as the same forward-compatibility contract, since `ship` is the documented default of every
   writer.
9. **Extend the after-work rule.** `afterWorkForKind` (`DispatchModal.tsx:1049`) treats `plan`
   the way it treats `scout`: stash the current `workflowId` and clear it, restoring on a switch
   back. Express this as a predicate over kinds that have no reviewable diff rather than as
   `kind === "scout" || kind === "plan"`, so a fourth kind states its own answer. The guided
   pass at `:1192` calls the same function and needs no separate change.
10. **Update the two-kind prose.** `KIND_FIELD_TIP` (`:285`) and the guided hint (`:2452`), which
    currently reads "A scout has no diff, so None is preselected." The hint is per-kind and must
    say the right thing for `plan`.

## 6. Data, API, and compatibility

- **No migration.** The column is unconstrained `TEXT`.
- **Forward compatibility.** Step 8 is what makes a `plan` row written by this build load safely
  on an older build's read path - it does not, and cannot, but it makes the reverse case safe:
  this build reading a row whose kind it does not know degrades to `ship` instead of casting an
  unknown string into `TaskKind`.
- **Schedule templates.** `schedules/store.ts:125` already validates and drops unknown kinds, so
  a `plan` schedule template written here and read by an older build drops that template rather
  than corrupting it. Note this in the phase's handoff; it is pre-existing behaviour, not a
  regression introduced here.
- **Wire contract.** `TASK_KINDS` feeds `z.enum(TASK_KINDS)` at `src/shared/protocol.ts:619` and
  `:4355`. Both widen automatically. No route needs a hand edit.

## 7. Tests and verification

- `test/task-kinds.test.ts`: extend the tuple assertion to three kinds, keep `TASK_KINDS[0] ===
  "ship"`, extend the registry-completeness test, and empty `KNOWN_HAND_WRITTEN`. Note the
  detector `restatesThePair` at `:93-100` is hardcoded to look for the `ship`/`scout` pair on
  adjacent lines; it must be generalized to the full set or it will silently stop detecting.
- `test/guided-dispatch-steps.test.ts`: the key-count and no-collision assertions cover `plan`
  automatically once the record is extended; add an explicit assertion for `l`.
- `test/dispatch-details-fold.test.ts:38`: the option regex is `/(ship|scout)/` and must widen.
- `test/task-pill.test.ts`: add a case asserting a `plan` task draws its chip, and keep the case
  asserting `ship` draws none.
- `test/backlog-edit-render.test.ts`: add a `plan` round-trip through the backlog edit form.
- **Playwright spec** (required - this is a UI change): extend or add beside
  `e2e/specs/scout-after-work-default.spec.ts`. Assert selecting **plan** under Kind moves After
  work to None, that switching back to ship restores the exact prior selection, that a workflow
  picked by hand after choosing plan is not reverted, and that the kind chip renders. Select by
  role and label only; never add a `data-testid`.
- Commands: `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build && npm run
  test:e2e` for the spec.

## 8. Merge and exit criteria

- All three registries extended; the repository compiles with no `Record<TaskKind, …>` gaps.
- `KNOWN_HAND_WRITTEN` is empty and its test still guards growth.
- A `plan` task can be created, persisted, reloaded, edited in the backlog, drawn on a card and
  in the console header, and described correctly to the Foreman planner.
- No behaviour change for `ship` or `scout` anywhere. Existing scout tests pass unmodified.
- The Playwright spec passes.

## 9. Downstream handoff

Later phases may rely on:

- **C-K1**: `TASK_KINDS` contains `"plan"` and `TaskKind` includes it. `ship` remains index 0 and
  the universal default.
- **C-K2**: `TASK_KIND_INFO` is the single home for per-kind human copy, and any surface offering
  the choice reads from it. There are no hand-written kind option lists left.
- **C-K3**: `afterWorkForKind` expresses "this kind has no reviewable diff" as a predicate over
  kinds, which Phase 3 does not need to change.
- **C-K4**: The task read path validates the persisted kind and falls back to `ship`.

Later phases must not:

- Reorder `TASK_KINDS` or move `ship` off index 0.
- Reintroduce a hand-written kind option list.
- Change the meaning of the `plan` chip or its colour token without updating the spec that
  asserts it.

## 10. Cross-phase audit record

- **Against Phase 1 (kind-agnostic archives):** no shared decision. Phase 1 owns the archive
  format, root, tables and validator; this phase owns the kind vocabulary and its presentation.
  The one file both phases touch is `src/server/db.ts`, in different regions: Phase 1 adds table
  DDL, this phase changes the task row read at `:3232`. A textual merge conflict is possible and
  a semantic one is not. Recorded here so whichever merges second expects it.
- **Against Phase 3 (delivery contract):** Phase 3 consumes C-K1 and C-K3. This phase
  deliberately leaves `scoutMissionMcpRequirement` and the prompt seams untouched so Phase 3 owns
  that rename wholly, rather than this phase half-renaming it and Phase 3 finishing the job.
- **Against Phase 4 (capture):** no direct relationship. Phase 4 reaches this phase's work only
  through the kind value itself, via C-K1.
- **Deferred decision surfaced here:** whether `TASK_KIND_INFO.blurb` is the right source for the
  Foreman planner's per-kind description, or whether the model prompt needs its own wording. Step
  6 resolves it in this phase rather than leaving it to the implementer's discretion, because a
  second inline table is exactly the drift `test/task-kinds.test.ts` exists to prevent.
