# Global Command catalog: phased implementation

Source plan: [`plan.md`](plan.md) ([rendered](plan.html)). The approved direction is option 4,
Global Slot Catalog, with **Command** as the visible product noun.

Each phase file beside this index is the authoritative task brief for one merge unit. The proposed
route and type names are implementation guidance, not a substitute for re-reading the adjacent
repository patterns before editing.

## Incorporated decisions

| Decision | Selection | Consequence |
| --- | --- | --- |
| Product shape | Global Slot Catalog | Keep the four portable slots and add global defaults plus optional path overrides |
| Visible noun | Command | Library, Settings, workflow authoring, and run-detail copy say Command; persisted `kind: "check"` does not change |
| Home | Library | Add a question-led Commands shelf and slot editor; remove command authoring from Settings |
| Repository scope | Optional exception | A global default needs no repository; longest matching repository or subdirectory override wins |
| Safety posture | Simplify copy, keep enforcement | Preserve authorization, Trust gating, argv execution, commit-pinned worktrees, environment scrubbing, and teardown |
| Implementation style | Existing repository patterns | One daemon-owned store/manager, existing routes/SSE/router/editor primitives, existing CSS sections, no parallel sources of truth |
| Scheduled agent | Claude | Mission Control's task-creation route stores these scheduled tasks with `agent: "claude"` |

## Repository findings that shaped the phases

- `WorkflowConfig.checkCommands` is a machine-wide `app_config` field, but every row requires a
  `repoRoot`. `checkCommandFor` chooses the longest matching path, so the runtime already owns the
  exact override rule the catalog needs.
- The four slot values in `WORKFLOW_CHECK_SLOTS` and graph nodes `{ kind: "check", slot }` are
  persisted append-only identifiers. Changing either would invalidate drafts, published workflow
  versions, attempts, and built-ins. The user-facing noun can change without that migration.
- `runCheck` asks resolution before authorization, treats unconfigured and unavailable Commands as
  passing outcomes with notes, and delegates actual execution through an injected runtime. The new
  global default belongs in resolution only; it must not change verdict or process behavior.
- The execution runtime is already substantive: no shell, commit-pinned leased worktrees,
  credential-shaped environment scrubbing, bounded output, concurrency, durable process identity,
  group teardown, and startup reconciliation. Warning-copy changes never weaken these contracts.
- Library is data-driven and question-led. Its cards consume the live collections already owned by
  `App`; a sixth bounded catalog must join the existing snapshot/SSE path rather than fetch or poll
  independently.
- `LIBRARY_SHELVES` and route segments are append-only. `LIBRARY_SURFACES` currently names the three
  authoring surfaces, and `App.tsx` is the single place that mounts them. Commands extend those
  registries rather than creating a router.
- Persona and Session Action catalogs demonstrate the ownership pattern: shared views and schemas,
  daemon store/manager, route validation, Registry initialization/upsert, snapshot events,
  exhaustive `useEventStream`, then Library cards and a focused editor.
- The current Settings form owns command parsing, repository selection, exact argv preview, and
  enablement confirmation. Phase 1 must keep that form working while persistence moves, or the
  repository would be broken between merges.
- One Workflows Trust allowlist currently gates both repair delivery and Commands. Splitting that
  capability is larger than a relocation and remains out of scope. The machine-wide
  `checksEnabled` switch also remains, with shorter visible copy.
- UI changes require Playwright coverage in `e2e/`; render and HTTP tests supplement that coverage
  but do not replace it.

## Phases

| # | Phase | File | Direct prerequisites |
| --- | --- | --- | --- |
| 1 | Authoritative catalog and runtime cutover | [`phase-1-command-catalog-runtime.md`](phase-1-command-catalog-runtime.md) | none |
| 2 | Library Commands and workflow vocabulary | [`phase-2-library-commands.md`](phase-2-library-commands.md) | 1 |

## Dependency graph and concurrency

```mermaid
flowchart LR
  P1[1 · Catalog + runtime] --> P2[2 · Library + vocabulary]
```

The phases are deliberately serial. Phase 1 changes command ownership while preserving the old
Settings surface through a compatibility projection. Phase 2 consumes that catalog, removes the
old editor, and performs the visible terminology sweep. Running them concurrently would put both
tasks in `WorkflowSettingsPanel.tsx`, workflow config contracts, Library state, and route tests, and
would make it possible to merge a UI that writes the retired source.

## Cross-phase contracts

- **C1, fixed identity (owned by Phase 1):** `WORKFLOW_CHECK_SLOTS` values and order stay unchanged;
  workflow nodes keep `{ kind: "check", slot }`; outcome statuses and durable attempt JSON stay
  readable. Phase 2 changes visible copy and accessible names only.
- **C2, one authority (owned by Phase 1):** after migration, the Command catalog is the only
  persisted command source. The workflow-config compatibility shape is a projection and adapter,
  never a second stored list.
- **C3, resolution (owned by Phase 1):** longest matching subdirectory or repository override,
  then global default, then unconfigured skip. The winning nested override supplies the working
  subpath; the global default runs at checkout root.
- **C4, policy separation (owned by Phase 1):** `checksEnabled` and `repoAllowlist` remain workflow
  policy. They are checked after resolution and are not duplicated on catalog rows.
- **C5, live catalog (owned by Phase 1):** one bounded view per built-in slot rides the initial
  snapshot and one upsert event. `Registry` and `MissionState` are the sole daemon and browser
  collections; there is no polling.
- **C6, edit semantics (owned by Phase 1):** one CAS update replaces a slot's nullable default and
  complete override set atomically. Duplicate paths and invalid argv are refused before storage.
- **C7, migration (owned by Phase 1):** legacy rows become overrides only; no global default is
  inferred; policy fields are unchanged; the migration is idempotent and cannot overwrite a
  catalog already edited.
- **C8, visible model (owned by Phase 2):** Commands is the sixth question-led shelf, always four
  cards, no New/archive affordance. Route is `#/library/commands/<slot>` unless adjacent route
  conventions discovered during implementation require an equivalent spelling.
- **C9, terminology (owned by Phase 2):** visible product copy uses Command where it means the
  executable workflow node. Ordinary English uses of “check,” such as “Check upstream” or “Check
  it works,” do not change.
- **C10, authorization copy (owned by Phase 2):** Settings retains one authorization control and
  the Trust summary. The command table and repeated persistent warning move out; runtime safety and
  policy do not change.

## Compatibility audit

### After Phase 1

- Existing workflows and built-ins load without republishing because graph and attempt contracts
  are unchanged.
- Existing Settings UI still lists, adds, replaces, and removes repository overrides through the
  compatibility adapter, but those writes land in the catalog manager.
- Runtime behavior is complete: migrated overrides work exactly as before, while API-authored
  global defaults work when no override matches.
- Fresh installs project all four empty slots and continue to skip unconfigured nodes.
- An old config blob can be read and migrated; a catalog that already exists wins and is never
  replaced from stale config.

### After Phase 2

- Library is the normal authoring location and all four slots are reachable by durable hash routes.
- Settings no longer has a competing command editor. It retains only policy, health, retention,
  and the Trust summary.
- User-visible workflow surfaces agree on Command, while serialized graphs and outcomes remain
  compatible.
- Browser state converges through snapshot and upsert events across multiple windows.
- Documentation and settings search point to the new Library home.

## Merge order and verification

Merge Phase 1, then Phase 2. Every phase leaves the repository type-correct, lint-clean, tested,
built, and operable. Phase 2 additionally requires the built-dashboard Playwright suite and visual
runtime verification of the Library editor.

Final acceptance is the source plan's browser flow: configure a repository-neutral `test` default,
add a more specific override, author a `Command · test` workflow node, and see the runtime resolve
the override or default without command authoring returning to Settings.

## Phase audit record

- **Phase 1 audit:** the backend phase owns every data, migration, route, state, compatibility, and
  resolution contract needed by Phase 2. It leaves today's editor operational and has no dependency
  on new Library components.
- **Phase 2 audit:** the UI phase consumes only Phase 1's public catalog view, routes, and events. It
  does not alter runtime selection, database migration, execution safety, or wire-level workflow
  node identity.
- **Final audit:** every approved decision is owned once; no task depends on a later task to repair
  an invalid intermediate state; no open product choice remains for an implementer to invent.
