# Phase 4: Skill sources and per-profile skills

Part of [the phased plan](phased-plan.md) for [Residents](plan.md).

## Outcome

Mission Control indexes every global skill and any skill folders the operator registers, and a
resident profile chooses a subset. The subset reaches Claude Code and Codex launches, either
added to the harness's own skills or, where the harness offers a narrow enough per-launch
control, instead of them.

## Entry criteria and dependencies

- Phase 1 merged.

## Scope

- `residents.skillSources` setting (operator directories) and built-in sources.
- Skill index service and `GET /api/skill-index`, `POST /api/skill-index/rescan`.
- Profile section `skills`: `inheritDefaults` (default on) and `selected` skill ids.
- Per-run skill bundle and the harness launch seam for skills; measured isolation capability.
- Skill sources UI on the resident page rail and the skill picker in the editor.

### Non-goals

MCP servers (Phase 5); changing how Mission Control's own `mission-*` skills are linked globally;
Pi.

## Repository findings and inherited contracts

- Mission skills come from repository `skills/` (`src/server/skills/catalog.ts`) and reach
  harnesses as global `mission-<id>` links (`reconcileSkillLinks`,
  `src/server/skills/reconcile.ts`). Nothing reads other global skills or selects per session.
- Claude SDK sessions hard-code `settingSources: ["user","project","local"]`
  (`src/server/harness/claude/sdk.ts`); background jobs isolate with `settingSources: []`
  (`src/server/llm/claude-sdk.ts`). Dropping `user` also drops user settings, so it is not an
  acceptable skill switch on its own.
- `validateIndexedDirectories` (`src/server/repo-index-config.ts`) is the validation pattern.
- `SessionActionSkillControl` (`src/web/workflows/SessionActionEditor.tsx`) is the picker
  precedent. `SdkLaunchOptions` (`src/server/harness/types.ts`) has no skill field.
- Inherited: Phase 1 registries and launch composer.

## Implementation steps

1. **Probe, then build what passes.** For each harness and each cell (add extra skills; use only
   selected skills), probe the primary mechanism and then its fallback against a real
   installation. The probe confirms that selected skills load, unselected defaults do not, and
   `CLAUDE.md`, `AGENTS.md`, authentication, Mission's MCP server and the session files Mission
   Control reads all survive.
   - Claude, extra skills: the per-run bundle as a local plugin via the SDK's plugin option.
     Fallback: `--plugin-dir` through the SDK's extra-arguments option.
   - Claude, selected only: setting sources without `user` (`--setting-sources`), plus
     `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS`, plus the bundle. Mission Control supplies its permission
     mode and tool allowlist explicitly. Fallback: the same through extra arguments.
   - Codex, extra skills: `skills.config` path entries for the bundle. Fallback: a launch-scoped
     `CODEX_HOME` overlay with `auth.json` and `sessions/` linked to the operator's `CODEX_HOME`, a
     generated `config.toml`, and `skills/` holding the bundle.
   - Codex, selected only: `skills.config` disable entries for every unselected default skill the
     index found. Fallback: the same overlay.
   Record the mechanism that passed as a new `SkillSelectionSpec` in `HARNESS_CAPABILITIES`
   (`src/shared/harness-capabilities.ts`). **If both fail for a cell, stop before building that
   cell.** Ask the operator with `request_input` to choose between shipping that harness without
   it, or approving a wider mechanism, and record the answer in the pull request.
2. **Sources**: `residents.skillSources` in `APP_CONFIG_ENTRIES` with a backup domain; built-in
   source ids (append-only) `mission`, `claude-global` (`~/.claude/skills`, skipping
   `mission-*`), `agents-global` (`~/.agents/skills`), `codex-global` (`~/.codex/skills`).
   Operator directories validated like indexed repository directories.
3. **Index** in `src/server/residents/skill-index.ts`: reads `<dir>/<skill>/SKILL.md`
   frontmatter (`name`, `description`), records source, path and problems; identity
   `<source id>:<folder>`. Built on daemon start and on rescan; served by GET, never over SSE.
4. **Profile section** `skills` and `ResidentSkillsSection`: inherit switch (offered exactly where
   step 1 recorded a working mechanism), a picker filtered by search and source, duplicate-name
   conflict refused at save.
5. **Bundle and seam**: a `skills` contributor that materializes a per-run bundle under
   `$MISSION_HOME/residents/runs/<runId>/skills/` as links to the selected skill folders, and an
   optional `skills` field on `SdkLaunchOptions` that each driver renders with the mechanism step 1
   recorded. The bundle is built from the run's pinned revision, at launch and again on resume
   after a daemon restart, and removed with the run.
6. **Rail**: a **Skill sources** entry on the `#/residents` rail to add, remove and rescan
   directories, with problems shown per source.
7. **Documentation**: skill sources in `docs/skills-and-settings.md` and `docs/residents.md`;
   the capability in `docs/harnesses-and-terminals.md`.

## Tests and verification

- Unit: source validation, index parsing and problems, `mission-*` skipping, identity
  stability, section defaults, bundle creation and cleanup, per-driver option rendering for both
  primary and fallback mechanisms, and resume rendering from the pinned revision after the
  profile is edited.
- Harness tests against real installations for every capability recorded as supported.
- Playwright `e2e/specs/residents-skills.spec.ts`: add a source folder from a fixture, rescan,
  select a skill, launch, and see the selection in the launch summary.
- `npm run typecheck`, `npm run lint`, `npm run build`, `npm run test:e2e`.

## Exit criteria

Selected skills are available in a launched resident for each supported harness, and the
inherit switch behaves exactly as the measured capability says.

## Downstream handoff

Phase 5 reuses the measured-capability pattern and the optional-field approach on
`SdkLaunchOptions`, adding its own MCP field without changing `skills`.

## Cross-phase audit record

- Concurrent with Phases 2, 6 and 7; adds its own section, contributor, setting and rail entry.
- Owns the first extension of `SdkLaunchOptions`; Phase 5 depends on it to avoid parallel edits
  of the driver renderers.
- Repair round 1: selected-only is delivered through a probed primary or fallback mechanism, with
  an operator decision gate if both fail; the Codex overlay introduced here is reused by Phase 5.
