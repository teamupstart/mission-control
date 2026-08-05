# UpstartClaw integration: phased implementation plan

Source plan: [plan.md](plan.md) (rendered: [plan.html](plan.html)). This index turns its
approved scope into three independent implementation units.

## Incorporated decisions

All recorded in plan.md section 6; the ones that bind implementation:

- **Scope**: Tracks A, B, C. Tracks D and E are out of scope (D is the recorded future
  migration target for persona distribution; E's lessons are review criteria, not tasks).
- **Track B auth** (decision 9): default to the `jira` CLI (`ankitpokhrel/jira-cli`,
  `JIRA_API_TOKEN` + `JIRA_EMAIL`, site default `upstartnetwork.atlassian.net`), REST
  fallback on the same env vars; no token stored in MC; misconfiguration surfaces as a
  preflight sentence, never a silent empty sweep.
- **Track A** includes both the README section and the non-blocking dispatch-time warning
  (decision on preflight depth: "Docs + dispatch-time warning").
- **Track C** (decisions 11-12): import + provenance + drift badge; re-import is a new
  revision through CAS; published snapshots immutable; live reference rejected; source of
  truth starts MC-side.
- **Boundaries**: composition over absorption; no Claw content duplicated into `skills/`; no
  `if (upstart)` branches outside registry entries.

## Investigated findings that changed the plan's assumptions

1. **Track C is not "no code".** The `personas` table has no metadata column
   (`src/server/db.ts:351-367`, zero `addColumn` calls against it), so provenance requires a
   migration with a pre-feature-seeded upgrade test. The source plan's section 4 was already
   updated to the import+drift design; Phase 3 records the migration reality.
2. **Track A has no existing surface to extend.** There is no dispatch preflight route and no
   environment/doctor surface; the correct shape is a new small registry modeled on
   open-targets (`unavailable: string | null` vocabulary), read from disk per request, with a
   non-blocking warning in the dispatch modal. `SettingsStatus` and `ui-config` are
   explicitly wrong homes (both document why).
3. **Track B is exactly the extension the registry was built for.** Two
   `Record<TaskSourceKind, ...>` maps enforce completeness at typecheck; no migration, no new
   routes; the panel derives the add control from the server's kinds list; the contract test
   iterates all kinds automatically. The one hardcoded GitHub string is the preflight success
   sentence (`TaskSourcesPanel.tsx:556-562`).
4. **Persona drift has an in-repo precedent**: `personaSnapshotIsOutdated` and the
   `· outdated` rendering in `WorkflowVersionHistory.tsx:64-81` (about published snapshots).
   Phase 3's badge is the live-catalog sibling of that affordance.

## Phases

| Phase | File | Track | Size | Direct prerequisites |
|---|---|---|---|---|
| 1 | [phase-1-jira-task-source.md](phase-1-jira-task-source.md) | B | medium | planning session PR |
| 2 | [phase-2-environment-checks-dispatch-warning.md](phase-2-environment-checks-dispatch-warning.md) | A | small-medium | planning session PR |
| 3 | [phase-3-persona-import-provenance.md](phase-3-persona-import-provenance.md) | C | medium | planning session PR |

## Dependency graph and concurrency

```
planning session PR (this branch, merged)
        |── Phase 1: Jira task source
        |── Phase 2: Environment checks + dispatch warning + Upstart README
        └── Phase 3: Persona import + provenance + drift
```

All three phases depend **only** on the planning session's PR reaching the default branch.
They form one concurrency group: any subset may run in parallel and merge in any order. No
phase consumes another's files, schemas, routes, ids, or decisions.

The one shared file is `README.md`, edited in disjoint regions: Phase 1 in the Task sources
section (~1832-1908), Phase 2 in the Dispatch section (~1350-1408) plus a new section between
treehouse (~5459) and Configuration (~5697), Phase 3 in Workflows and Personas (~2522+).
Cross-references between phases' README text are deliberately merge-order-free (each phase's
audit record states how).

## Cross-phase contracts

- Phase 1 exports: the `jira` kind id (append-only), `JiraConfigSchema` field names
  (persisted in operator config), the env-var convention.
- Phase 2 exports: `ENVIRONMENT_CHECK_IDS` (append-only), `GET /api/environment/checks`
  returning per-check `warning: string | null`, and the "Running Mission Control at Upstart"
  README anchor.
- Phase 3 exports: `personas.import_provenance_json` (nullable TEXT JSON),
  `PersonaProvenance` field names (persisted), and the import/reimport/drift route shapes.
- Nothing imports across phases in this round; the exports above bind future work (notably
  Track D, which would change only where imported persona files come from).

## Final verification strategy

Each phase runs the project's full bar independently (typecheck, lint, `npm test`, build +
smoke, and `npm run test:e2e` with its new spec). Two whole-feature checks after all three
merge:

1. On an Upstart machine with UpstartClaw installed: add a Jira source against a real JQL
   filter (preflight names any missing credential), confirm the dispatch warning appears
   while `/upstartclaw-core:setup` is incomplete and disappears after, and import one
   `agent-team` role file as a persona, then edit the upstream file and confirm the drift
   badge and re-import path.
2. The statusline composition claim (plan decision 4) is verified **by hand** before Phase
   2's README states it: with Claw's statusline installed, run MC's statusline wrapper
   install and confirm Claw's line still renders while MC receives model/context/cost.

## Task schedule

One Mission Control task per phase, created after these artifacts are committed and pushed on
this session's branch. Each task depends on the planning session (released when its PR
merges) and on no other task. The task text points at this index and the phase file; the
phase file is the implementation guide.
