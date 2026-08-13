# Global Command catalog

## Outcome

Move workflow command configuration out of the repository-by-repository table in Settings and
into a new **Commands** shelf in Library. The catalog keeps the four portable workflow slots that
already exist (`test`, `lint`, `typecheck`, and `build`), gives each slot an optional machine-wide
default command, and retains repository or subdirectory overrides for exceptions.

An operator should be able to answer two questions without choosing a repository first:

1. What does the `test` Command normally run on this machine?
2. Which repositories intentionally replace that default?

Workflows continue to name a portable slot rather than embedding an executable. A run resolves
the Command only after its repository and checkout-relative directory are known.

## Approved direction

This plan implements option 4 from the command-configuration investigation, **Global Slot
Catalog**, with **Command** as the user-facing noun.

The following decisions are already made:

- Add a question-led **Commands** shelf to Library.
- Keep the four existing slot identifiers. They are append-only persisted values.
- Add one optional global default per slot.
- Keep repository and monorepo-subdirectory overrides as exceptions.
- Keep workflow definitions repository-neutral. A workflow node stores only its slot.
- Use Command in visible product copy. Keep the internal and wire-level `check` node kind so old
  drafts, published versions, run attempts, and bookmarks continue to work.
- Follow the existing Library, editor, route, state, persistence, test, and styling patterns in
  this repository. Do not introduce a parallel router, client store, form system, or visual
  vocabulary.
- Schedule implementation as dependency-linked Mission Control tasks for Claude.

## Product model

### Library shelf

The Library index gains a sixth shelf in its append-only reading order:

| Shelf noun | Question heading | Purpose |
| --- | --- | --- |
| Commands | What does each standard gate run? | Define the machine-wide command behind each portable workflow slot and its explicit exceptions. |

The shelf always shows four cards. Commands are built-in slots, not creatable or archivable
assets, so there is no `+ New` card. Each card shows durable configuration state only:

- `Global default · 3 overrides`
- `Global default`
- `2 overrides · no global default`
- `Not configured`

The Library header changes from "Nothing here runs" to "Nothing runs from here." That distinction
keeps Library an authoring surface while accurately describing Commands: saving one does not
execute it, but a workflow can execute it later.

### Command editor

Opening a card uses `#/library/commands/<slot>` and mounts a Library-native split editor:

- fixed slot list on the left, using the same compact list and selection behavior as the existing
  Workflow, Persona, and Action surfaces;
- slot name, built-in badge, explanatory copy, save state, and revision conflict handling in the
  editor header;
- a **Default command** field, which is not tied to any repository;
- an **Overrides** section using the shared repository combobox, with free text retained for
  monorepo subdirectories;
- the existing command-line parser and formatter, including the exact argv preview;
- removal controls for the default and each override;
- a compact execution note near the form, not repeated warning banners around every control.

Commands are stored as argv and executed without a shell. The editor never offers pipes,
redirection, environment interpolation, or a shell-mode toggle.

### Workflow integration

Workflow palette, node, properties, pipeline, and run-detail copy use **Command** instead of
**Check**. The palette still offers the four slots and workflows may add one or more Command
nodes. It also shows whether the selected slot has a global default, overrides only, or no
configuration, and links to the corresponding Library card.

The persisted node remains:

```ts
{ kind: "check", slot: "test" }
```

No workflow migration or version republish is required. Type names may retain `WorkflowCheck*`
where changing them would create compatibility churn with no user value. New catalog-facing
types may use `WorkflowCommand*` to make their role clear.

## Resolution and execution contract

For a Command node at runtime, resolution is deterministic:

1. Find all overrides for the node's slot that apply to the session repository or
   checkout-relative subdirectory.
2. Choose the longest matching override path.
3. If no override matches, use the slot's global default.
4. If neither exists, record `skipped` and pass with a note.
5. If a command exists but workflow Commands are paused or the repository is outside the
   Workflows Trust grant, record `unavailable` and pass with a specific note.
6. Otherwise execute the argv through the existing check runtime.

The chosen override also determines the command's working subpath. A global default and a
repository-root override run at the leased checkout root. A nested override runs at the matching
relative directory inside the commit-pinned checkout.

Existing execution protections are requirements, not optional warning copy:

- no shell process;
- command stored and passed as argv;
- commit-pinned leased worktree, never the operator's live checkout;
- credential-shaped environment variables scrubbed;
- bounded, tail-biased output;
- shared concurrency limit;
- durable process identity, process-group teardown, lease recovery, and startup reconciliation;
- Linux and macOS support rules unchanged.

## Safety and warning policy

This feature simplifies authorization copy but does not weaken the execution boundary.

- Keep `checksEnabled` as the machine-wide pause/authorization switch. Relabel it **Allow workflow
  Commands** or **Pause workflow Commands** in visible copy.
- Keep the existing Workflows Trust allowlist as the repository gate. Splitting delivery and
  command execution into separate Trust grants is a future policy project, not part of this move.
- Keep one confirmation when Commands are enabled for the first time or re-enabled after being
  paused.
- Replace the persistent red warning plus repeated tooltips with one concise explanation beside
  the authorization control and one neutral execution note in the Command editor.
- Do not imply that a configured global default runs in every repository. It runs only when a
  workflow reaches the slot and the repository is trusted.
- Do not add per-command acknowledgements. They would repeat a machine-wide authorization choice
  and make reusable defaults clunky again.

## Persistence and migration

The implementation should introduce one authoritative Command catalog behind a store and manager,
following the existing Persona and Session Action ownership pattern. The proposed durable shape is:

- one slot record keyed by the append-only `WorkflowCheckSlot`, with nullable default argv,
  revision, and timestamps;
- zero or more override records keyed by `(slot, repository path)`, with argv and timestamps;
- a bounded browser view that groups one slot and its overrides.

The exact normalized table names are implementation details, but these constraints are not:

- the daemon is the only SQLite writer;
- the four built-in slots are always projected even before they have a stored command;
- writes validate through Zod at the route boundary;
- updates use compare-and-swap revision semantics so two open windows cannot silently overwrite
  one another;
- duplicate `(slot, repository path)` overrides are refused;
- command and path limits remain at least as strict as the current schema;
- fresh databases and upgrades are both covered in `src/server/db.ts` and migration tests.

Upgrade migration groups existing `WorkflowConfig.checkCommands` by slot and copies every entry as
an override. It does **not** infer a global default, because an existing repository command is not
evidence that the same argv is safe or correct everywhere. Existing `checksEnabled`, Trust
allowlist, default workflow, delivery, and retention values remain unchanged.

During the backend phase, the current `/api/workflows/config` route may expose a compatibility
projection of catalog overrides so the existing Settings editor remains fully operable. Any legacy
write must update the catalog through the manager and must not persist a second copy. The catalog
is the only command source after migration. The dedicated Commands routes then become the browser's
normal authoring API in the UI phase.

## Live state and routes

Commands are another bounded Library catalog and should ride the dashboard's existing snapshot and
SSE channel:

- append the grouped Command views to the `snapshot` event;
- add an upsert event for a changed slot;
- initialize and mutate the collection through `Registry`;
- add it to `MissionState` and handle every event exhaustively in `useEventStream`;
- do not add browser polling or a second client-side source of truth.

The proposed HTTP surface is one list/read route and one CAS update route under
`/api/workflow-commands`. Exact route spelling may follow adjacent workflow route conventions, but
the write must replace the complete state for one slot atomically: default plus overrides.

## Compatibility boundaries

- `WORKFLOW_CHECK_SLOTS` values and order remain append-only.
- Draft and published graph nodes retain `kind: "check"` and `slot`.
- Stored `WorkflowCheckOutcome` values and statuses remain readable.
- Existing unconfigured, unavailable, passed, and failed semantics remain.
- Existing repository matching and nested working-directory behavior remain, with the global
  default added only after override resolution fails.
- Published built-in workflows are not republished solely for terminology.
- Internal execution modules such as `checks.ts`, `check-runtime.ts`, and lease tables need not be
  renamed. Visible labels and accessible names do change.
- Old `app_config` blobs remain readable. The migration is idempotent and never deletes a catalog
  that has already been edited.

## Repository-shaped implementation map

Likely touchpoints, to be re-verified by each implementer:

- shared contracts and validation: `src/shared/workflow.ts`, `src/shared/protocol.ts`,
  `src/shared/types.ts`;
- durable schema and upgrade path: `src/server/db.ts`;
- catalog ownership: a store/manager beside `src/server/workflows/personas.ts` and
  `src/server/workflows/session-actions.ts`;
- config compatibility and runtime resolution: `src/server/workflows/config.ts`,
  `src/server/workflows/checks.ts`, `src/server/index.ts`;
- routes and live state: `src/server/routes.ts`, `src/server/registry.ts`,
  `src/web/useEventStream.ts`;
- Library model, page, route, and App mounting: `src/web/library/library-model.ts`,
  `src/web/library/LibraryPage.tsx`, `src/web/workflows/useWorkflowRoute.ts`, `src/web/App.tsx`;
- Command surface: a focused component under `src/web/workflows/` or `src/web/library/`, reusing
  established editor primitives;
- Settings relocation: `src/web/components/WorkflowSettingsPanel.tsx`, settings search anchors,
  and Trust summary copy;
- workflow vocabulary: `WorkflowLibrary.tsx`, `WorkflowProperties.tsx`, `pipeline-bits.tsx`,
  `WorkflowLadderPeek.tsx`, `WorkflowRuns.tsx`, and associated tests;
- styling: extend the existing Library and workflow sections of `src/web/styles.css`;
- documentation: `docs/library-and-line.md`, the documentation index or workflow docs that teach
  configuration, and any README configuration references.

## Verification

Backend coverage must prove:

- fresh schema and upgrade migration;
- idempotent migration and no global default inference;
- strict route validation, duplicate refusal, revision conflicts, and fixed slot projection;
- exact resolution precedence for nested override, repository override, global default, and
  unconfigured fallback;
- policy blocks and existing runtime request shape;
- compatibility reads and writes have one authoritative persisted result;
- snapshot and upsert convergence.

UI coverage must include a Playwright spec that proves the visible flow end to end:

1. Open Library and find the Commands shelf with four cards.
2. Open `test`, configure a global default, and observe the card fact update without polling.
3. Add and remove a repository or subdirectory override and verify the argv preview.
4. Reload or navigate away and back, proving the route and persisted selection.
5. Open a workflow, add `Command · test`, and verify the configuration status/link.
6. Confirm the old command table is gone from Settings while the authorization control and Trust
   summary remain.

Each phase runs focused tests plus `npm run typecheck`, `npm run lint`, `npm test`, and the build
and smoke gates appropriate to its runtime surface. The UI phase runs `npm run build` before
`npm run test:e2e` and captures visual/runtime evidence outside the repository.

## Out of scope

- user-created slot names;
- renaming or deleting the four built-in slots;
- multiple Commands within one slot or saved command suites;
- per-workflow command overrides;
- environment-variable, secret, timeout, container, or shell-mode configuration;
- a separate Commands Trust grant;
- changing failed/skipped/unavailable workflow semantics;
- running a Command directly from Library;
- renaming internal check runtime files, database history, or wire kinds for cosmetic consistency.

## Delivery shape

Implementation is split into two serial phases:

1. **Authoritative catalog and runtime cutover** adds the durable catalog, migrates legacy
   overrides, exposes routes/live state, and changes runtime resolution while keeping today's
   Settings editor compatible.
2. **Library Commands and workflow vocabulary** adds the shelf/editor, removes command authoring
   from Settings, simplifies warning copy, updates visible workflow terminology, documentation,
   and browser coverage.

The rendered implementation index and detailed phase documents sit beside this source plan.
