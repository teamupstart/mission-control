# Editable Foreman profile: phased implementation

## Source and approved decisions

Source plan: `docs/plans/editable-foreman-profile/plan.md`

The approved product decisions are requirements for every phase:

- Foreman is a fixed **System** guidance profile in `Library -> Personas`, not a workflow
  Persona and not a row in the Persona catalog.
- Operators edit one current exact-text standing-guidance document. Saves use compare-and-swap
  conflict protection; there is no immutable history or activation step.
- Editable guidance reaches only the current triage, review, queued verification, and prompted
  completion verification surfaces. Backlog planning stays unchanged.
- Typed model, operational, and authority controls remain in their current top-bar, Settings, and
  Trust owners. The profile cross-links to them instead of duplicating them.
- Every implementation task is scheduled disabled, uses Codex `gpt-5.6-sol`, and uses `xhigh`
  reasoning effort. A human must explicitly enable a task before it can run.

There are no unresolved product choices in this phased plan.

## Repository findings and reconciled decisions

1. `src/server/foreman/instructions.ts` already preserves the three required storage states in
   `app_config["foreman.instructions"]`: `null` or another non-string selects the shipped seed, a
   non-empty string is custom guidance, and an empty string means no standing guidance. No database
   migration or second storage path is needed.
2. The current `ForemanInstructionsSchema` accepts `{ text?, reset? }`, the route returns
   `{ text, default }`, and writes have no revision guard. Phase 1 replaces that mutation shape with
   strict reset-or-text variants carrying `expectedEtag`, and returns the approved
   `ForemanInstructionsView` from both GET and successful PUT.
3. `parseBody` validates JSON but does not limit the incoming stream. The instructions PUT is not
   wrapped in Hono `bodyLimit`, so Phase 1 adds a route-specific byte ceiling large enough for every
   legal 64,000-character JSON string, including escaped non-ASCII input, while the Zod schema remains
   the semantic character limit.
4. The worker's `ForemanClient.instructions()` projects only `text` from the GET response. Expanding
   that response is compatible with the worker and preserves its failure-to-empty behavior. No
   worker-side store import is needed.
5. `readInstructions()` already captures guidance once for each evaluation and hands the same string
   to shadow triage and full review. `instructionsSection()` trims only while deciding whether and how
   to render the prompt block. Storage, the API, conflict comparison, copy, and download must still
   preserve every original byte.
6. The existing four-second `ForemanStatus` poll already carries the resolved provider and all four
   resolved model roles. The profile can reuse it. The Settings summary also needs the current
   guidance source without fetching a 64 KB document, so Phase 1 adds only the source discriminator to
   `ForemanStatus`; the document itself remains absent from status and SSE.
7. The hash router already accepts opaque asset ids for the Persona Library, so
   `#/library/personas/foreman` needs no new route grammar. `PersonaLibrary` currently assumes every
   selected id resolves to a streamed `PersonaView`, so Phase 2 owns the special local selection and
   editor branch.
8. `PersonaEditor` is the wrong data model for Foreman, but its building blocks are already reusable:
   `FileEditor`, `Markdown`, `LibraryWorkspaceHeader`, `LibraryPropertyChip`, `useCopyFeedback`, the
   save shortcut rule, and the global dirty-navigation gate. Phase 2 composes those pieces in a focused
   `ForemanProfileEditor` without adding Persona mutation actions.
9. The Library front page derives ordinary reviewer cards only from `PersonaView[]`. Phase 2 adds one
   local System card beside that projection and leaves every workflow Persona count and collection
   unchanged.
10. Settings control anchors are transient UI state, not hash segments. To make the profile's Models,
    posture, and Trust links land precisely, Phase 2 reuses App's existing `settingsJump` mechanism
    through callbacks instead of extending the route grammar.
11. `ForemanBar` owns its popover-open state internally. Phase 2 adds a one-shot open request from App
    so the profile can reveal the existing top-bar authority control without moving or duplicating it.
12. `ForemanSettingsPanel` can navigate among Settings categories but cannot open the Library. Phase 2
    adds an explicit callback from App for its read-only Standing guidance card; it does not make the
    settings panel a second editor.
13. Workflow and ensemble consumers already receive only `PersonaView[]` from `PersonaManager`,
    Registry/SSE, and `/api/personas`. Keeping Foreman local to the Library means no eligibility flag,
    graph migration, publish change, ensemble schema change, or catalog event is required.
14. The Mission Control `create_task` tool deliberately creates enabled Claude tasks with default
    model settings. The planning-session dependency prevents those tasks from dispatching before this
    plan merges. After creation, each task must be updated while still backlogged to `agent: codex`,
    `model: gpt-5.6-sol`, `effort: xhigh`, and `enabled: false`, then read back and verified before the
    planning pull request may merge.

## Sizing estimate and phase-count rationale

Estimated non-test implementation change: **570 to 880 lines**.

Assumptions behind the estimate:

- 150 to 230 lines for shared instruction schemas, source-aware views and ETags, atomic CAS mutation,
  the route body limit and conflict response, Foreman status metadata, and worker compatibility;
- 250 to 380 lines for the focused browser API and `ForemanProfileEditor`, including save
  reconciliation, refresh, conflict, reset, copy, download, preview, and keyboard behavior;
- 170 to 270 lines for Persona Library and Library-page composition, cross-page navigation callbacks,
  the Settings summary card, and styling.

Tests and documentation are excluded from the estimate. They are substantial because exact text,
concurrency, route limits, fixed identity, dirty navigation, workflow exclusion, and a full browser
save-clear-reset cycle all need coverage.

Two phases are justified. Phase 1 establishes a complete, independently testable HTTP contract that
the existing worker can continue using immediately. Phase 2 then consumes that stable contract while
changing several visible Library and Settings surfaces. Combining them would put storage concurrency,
worker compatibility, router selection, a full editor state machine, browser layout, and Playwright
coverage into one review of roughly 600 to 900 production lines. Splitting at the API boundary reduces
that risk without creating a dead or broken intermediate state.

A third phase is not justified. The Library profile, Settings cross-links, documentation, and browser
coverage form one user-visible vertical slice. Separating the summary card or documentation would
leave a merged UI that is knowingly incomplete without creating an independently useful contract.

## Phase graph

```text
Planning PR and active planning-session dependency
                       |
                       v
Phase 1: Conflict-safe guidance contract
                       |
                       v
Phase 2: System profile UI and owner cross-links

Both phase tasks remain disabled after their dependencies are satisfied.
```

## Phase table

| Phase | Outcome | Direct prerequisites | Estimated production change | Concurrency |
| --- | --- | --- | ---: | --- |
| 1. Conflict-safe guidance contract | Exact source-aware reads, CAS writes, bounded bodies, source-only status metadata, and unchanged worker capture behavior | Planning session | 150 to 230 lines | None |
| 2. System profile UI and owner cross-links | Editable fixed Foreman profile in the Library, Settings summary and cross-links, full exclusion regressions, docs, and browser proof | Phase 1; planning session | 420 to 650 lines | None |

## Dependency and merge order

1. This planning pull request merges every source, index, render, and phase file to the default
   branch. That merge satisfies the planning-session dependency on both implementation tasks, but
   their disabled state continues to prevent dispatch.
2. A human enables Phase 1 when implementation should begin. Its pull request establishes the shared
   view/update schema and server contract without adding a dashboard surface, and merges only after
   its focused and full unit gates pass.
3. A human enables Phase 2 after Phase 1 merges. It starts from the merged contract, adds the complete
   product surface, and merges after unit, build, smoke, browser, visual-evidence, and documentation
   checks pass.

There is no concurrency group. Phase 2 imports Phase 1's shared schemas, consumes its status metadata,
and relies on its exact conflict response.

## Cross-phase contracts

- Phase 1 owns the names and semantics of `ForemanInstructionsView`,
  `ForemanInstructionsUpdate`, the source discriminator, ETag generation, 409 conflict body, and
  status source metadata. Phase 2 consumes them and must not introduce a browser-only dialect.
- `app_config["foreman.instructions"]` remains the only durable value. `null`, non-empty string, and
  empty string remain distinct; no phase adds a Persona row or a migration.
- The ETag includes the source discriminator and exact effective bytes. A custom document identical
  to the seed does not become built-in, and missing-seed built-in empty does not become intentional
  none.
- The editor's 64,000-character meter follows the shared instructions limit. It must not copy the
  Persona editor's UTF-8 byte meter, which enforces a different shared contract.
- Editable text remains absent from SSE and `ForemanStatus`. Only the tiny source discriminator joins
  status so existing globally available state can render read-only summaries.
- The worker keeps one GET and one captured string per evaluation. No browser change may move storage
  access into the worker or alter the prompt framing, trim behavior, prompt roles, or safety ratchet.
- Foreman remains absent from `PersonaView[]`, `PersonaManager`, `/api/personas`, Registry snapshots,
  `persona_upsert`, workflow graph validation, published workflow snapshots, and ensemble evaluator
  choices. Phase 2 composes the System row locally.
- Settings and Trust remain the only writers for typed provider/model, posture, operational, and
  authority values. The profile contains summaries and links only.
- A dirty profile never adopts a focus refresh or 409 response automatically. Reload replaces the
  draft; Keep editing deliberately rebases the local draft onto the returned current ETag so the next
  Save is an explicit overwrite attempt.

## Final verification strategy

Phase 1 runs focused storage, route, client, and prompt-contract tests, followed by typecheck, lint,
and the full unit suite. Its review proves downgrade-readable storage, exact text, all three source
states, missing-seed behavior, stable and source-sensitive ETags, successful CAS, stale conflicts,
strict mutation variants, oversize refusal, loopback refusal, and unchanged per-evaluation capture.

Phase 2 runs focused render, routing, settings, workflow, and ensemble tests, then typecheck, lint, the
full unit suite, build, smoke, and the dedicated Playwright spec. Browser evidence is written only to
the gitignored `e2e/.artifacts/` location and attached to the phase pull request. The end-to-end path
opens the canonical System profile route, edits and previews Markdown, saves and reloads exact text,
clears to intentional none, resets to the built-in default, follows owner links, and confirms the
fixed workflow-exclusion copy.

The final audit must prove:

- every approved source-plan requirement belongs to exactly one phase;
- the Phase 1 contract leaves the current product operable before the UI exists;
- Phase 2 consumes rather than redefines that contract;
- the two phases cannot run concurrently and no hidden cleanup phase is required;
- every task path resolves on the pushed branch before scheduling and on the default branch before a
  disabled task is enabled;
- every scheduled task is read back as disabled, Codex `gpt-5.6-sol`, and `xhigh` before this planning
  pull request merges.

## Scheduled task map

The task ids are added here after the publication gate: all artifacts must first be committed and
pushed, then each task is created through `create_task`, updated to the approved execution settings,
and read back before merge.

## Cross-phase audit record

- **Initial source audit:** all editable and application-owned boundaries from the approved plan are
  assigned. Phase 1 owns data and runtime contracts; Phase 2 owns the local System profile, owner
  links, exclusion proof, documentation, and visible behavior.
- **Phase-count audit:** the API boundary is independently useful and keeps the existing worker
  functioning. No smaller UI, test-only, documentation-only, or cleanup merge unit is warranted.
- **Dependency audit:** Phase 2 directly consumes Phase 1 and cannot run concurrently. Both phases
  depend directly on the planning session so their path pointers cannot release before publication.
- **Compatibility audit:** the storage row remains downgrade-readable; the worker still projects
  `text`; the route change has no current dashboard consumer; and the browser adds no Persona catalog
  member.
- **Scheduling audit:** task creation occurs only after a pushed artifact commit. The session edge
  blocks early execution while the requested disabled setting, agent, model, and effort are applied
  and verified through the task update contract.
- **Final full-set audit:** Phase 1 and Phase 2 use one source vocabulary, one ETag contract, one fixed
  route, and one local composition rule. Empty versus reset, dirty conflicts, in-flight capture,
  owner separation, and workflow/ensemble exclusion each have one owner and no contradictory later
  step.

## Phase documents

- `docs/plans/editable-foreman-profile/phase-1-conflict-safe-guidance-contract.md`
- `docs/plans/editable-foreman-profile/phase-2-system-profile-ui.md`
