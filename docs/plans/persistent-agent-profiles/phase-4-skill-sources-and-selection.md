# Phase 4: Skill sources and per-profile skills

Part of [the phased plan](phased-plan.md) for [Residents](plan.md).

## Outcome

Mission Control indexes every global skill and any skill folders the operator registers, and a
resident profile chooses a subset. The subset reaches Claude Code and Codex launches, either
added to the harness's own skills or, where the harness offers a narrow enough per-launch
control, instead of them. By the operator's decision to freeze inherited and selected skills, a
run's effective skills are captured at launch and never change on resume.

## Entry criteria and dependencies

- Phase 1 merged.

## Scope

- `residents.skillSources` setting (operator directories) and built-in sources.
- Skill index service and `GET /api/skill-index`, `POST /api/skill-index/rescan`.
- Profile section `skills`: `inheritDefaults` (default on) and `selected` skill ids.
- A per-run snapshot of the effective skill set, taken at launch, and the harness launch seam
  that loads only that snapshot; a measured isolation capability for both modes.
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
  (`src/server/llm/claude-sdk.ts`). Dropping `user` also drops user settings, so selected-only
  never drops it. Claude Code 2.1.310 instead offers the `skillOverrides` setting, where an
  entry set to off disables a skill, beside `disableBundledSkills`, and accepts launch-scoped
  settings through `--settings`. Its `--bare` mode stops reading OAuth and the keychain, and
  `--disable-slash-commands` disables every skill, the run's own included, so neither qualifies.
- `validateIndexedDirectories` (`src/server/repo-index-config.ts`) is the validation pattern.
- `SessionActionSkillControl` (`src/web/workflows/SessionActionEditor.tsx`) is the picker
  precedent. `SdkLaunchOptions` (`src/server/harness/types.ts`) has no skill field.
- Inherited: Phase 1 registries and launch composer.

## Implementation steps

1. **Probe, then build what passes.** The operator chose to freeze inherited and selected
   skills, so both modes need the same guarantee. The session loads exactly the run's snapshot
   (step 5), and nothing from a native skill source. For each harness, probe the primary
   mechanism and then its fallback against a real installation:
   - Claude primary: a per-run configuration overlay through `CLAUDE_CONFIG_DIR`. Its `skills/`
     holds only the snapshot, and its generated settings keep every non-skill user setting and
     turn installed plugins' skills off. Fallback: every setting source kept, with a
     launch-scoped `--settings` that turns each native skill source off wholesale, if the
     installed version offers such a setting, and the snapshot loaded through `--plugin-dir`.
   - Codex primary: the per-run `CODEX_HOME` overlay that Phase 5 also uses. Its `skills/` holds
     only the snapshot, and its generated `config.toml` keeps every setting except skill
     configuration. Fallback: a launch-scoped setting that turns native skill discovery off
     wholesale, with the snapshot added through `skills.config` path entries.
   - Name-by-name disables (`skillOverrides` for Claude, `skills.config` disable entries for
     Codex) may supplement a mechanism. They never qualify alone, because a skill added after
     the last name read would still load.
   The probe is an exact-set check:
   - fixture skills are placed in every native source the harness would otherwise load: the
     global skill directories (`~/.claude/skills`, `~/.agents/skills`, `$CODEX_HOME/skills`),
     project skill directories in the run's working directory, and installed plugins;
   - skills built into the harness are frozen like the rest. Where the check shows their
     content can be captured into the snapshot and loaded from it, with the harness's own copy
     turned off, they are snapshotted like any other skill. Otherwise the snapshot records a
     positively verifiable identity for them. That is each built-in skill's name with a content
     hash where the harness exposes the content, and otherwise the harness's version with the
     hash of its executable. The check must also show that the chosen identity covers the
     built-in content, so that any change to a built-in skill changes the identity. If it
     cannot show that, the built-in skills are unverifiable, and inherit on is not offered for
     that harness until the operator gate below decides. With inherit off they are not in the
     snapshot, and the check confirms they stay off;
   - after launch, one fixture is added, one edited and one deleted;
   - the check passes only if, at launch and after a restart and resume, the session offers
     exactly the snapshot's skills with the snapshot's content. It observes this both from the
     skills the session reports and by invoking fixtures. A skill outside the snapshot must be
     unavailable, and an edited one must still run its launch content;
   - the mechanism must keep authentication, `CLAUDE.md` and `AGENTS.md`, repository
     instructions, Mission's MCP server, every non-skill setting and the session files Mission
     Control reads, and Claude's effective user settings must match a launch without it.
   Record the mechanism that passed as a new `SkillSelectionSpec` in `HARNESS_CAPABILITIES`
   (`src/shared/harness-capabilities.ts`). **If both fail for a harness, stop before building
   resident skills for it.** Ask the operator with `request_input` to choose between shipping
   that harness without resident skill selection, or approving a wider mechanism, and record the
   answer in the pull request. A weaker mode, such as inherited skills that refresh on resume,
   never ships without that answer.
2. **Sources**: `residents.skillSources` in `APP_CONFIG_ENTRIES` with a backup domain; built-in
   source ids (append-only) `mission`, `claude-global` (`~/.claude/skills`, skipping
   `mission-*`), `agents-global` (`~/.agents/skills`), `codex-global` (`~/.codex/skills`).
   Operator directories validated like indexed repository directories.
3. **Index** in `src/server/residents/skill-index.ts`: reads `<dir>/<skill>/SKILL.md`
   frontmatter (`name`, `description`), records source, path and problems; identity
   `<source id>:<folder>`. Built on daemon start and on rescan; served by GET, never over SSE.
4. **Profile section** `skills` and `ResidentSkillsSection`: the inherit switch, which decides
   what is captured at launch, a picker filtered by search and source, and a duplicate-name
   conflict refused at save. The section is offered, in either mode, only for a harness where
   step 1 recorded a working mechanism.
5. **Snapshot and seam**: a `skills` contributor that captures the run's effective skill set at
   launch under `$MISSION_HOME/residents/runs/<runId>/skills/`, and an optional `skills` field on
   `SdkLaunchOptions` that each driver renders with the mechanism step 1 recorded.
   - **Payload.** `skills` is a typed, driver-neutral value in `src/server/harness/types.ts`: the
     snapshot directory, and one entry per skill with its identity (source and folder), its
     effective name, its folder within the snapshot and its content hash. The run's snapshot
     is its only input, at launch and on every resume. A built-in skill recorded by identity
     also has an entry, with its name and the recorded identity and no folder, so the driver
     can confirm it without a snapshot copy.
   - **Mapping.** Each driver renders the payload through the `SkillSelectionSpec` that step 1
     recorded for its harness. For Claude that is the `CLAUDE_CONFIG_DIR` overlay's `skills/`,
     or the fallback's `--plugin-dir`. For Codex it is the `CODEX_HOME` overlay's `skills/`, or
     the fallback's `skills.config` path entries. No driver reads a native skill source.
   - **What is captured.** The pinned revision's `inheritDefaults` decides. With inherit on, the
     snapshot holds every default skill the harness would load for the run at launch, from
     every source step 1's check covers, plus the selected skills. With inherit off, it holds
     only the selected skills.
   - **Identity and collisions.** The snapshot is a set keyed by skill identity, the source and
     folder. A selected skill that is the same identity as an inherited default appears once.
     Two distinct identities that would share the harness's effective skill name refuse the
     launch with the reason, and nothing is renamed.
   - The snapshot is an immutable copy of each skill folder, with a content hash recorded per
     skill. Built-in skills are copied where step 1 showed they can be, and otherwise recorded by
     the verifiable identity step 1 defines.
   - **Copied built-in skills** are part of the isolated snapshot. A native change to them
     leaves the run's copies in effect, and the run resumes normally.
   - **Built-in skills recorded by identity hold the resume when they change.** Before a
     resumed session starts, the daemon recomputes their identity. The run is not resumed when
     the identity differs from the snapshot or cannot be computed: a built-in skill changed
     under the same name, disappeared, or a new one appeared. Its session is not started and
     no turn is sent.
     - The run shows "built-in skills changed since launch" and two ways forward: restore the
       harness version the run launched with, or start a new run that captures the current
       built-in skills. A new run means a new launch or, once Phase 3 has merged, **Restart on
       new profile**.
     - Mission Control never installs or downgrades a harness itself. A matching identity
       resumes normally.
     - This applies the operator's freeze decision to built-in skills. Only the operator can
       change it; the implementation does not relax it.
   - Every resume after a daemon restart renders from the snapshot alone and never rereads a
     native skill source. Adding, editing or deleting a skill natively after launch, an
     inherited default included, cannot change the run's effective skills.
   - A new launch, or **Restart on new profile**, captures a new snapshot and adopts those
     changes.
   - A skill folder over a fixed size cap, or one containing a link that leaves the folder, is
     refused at launch with the reason.
   - The snapshot is removed with the run.
6. **Rail**: a **Skill sources** entry on the `#/residents` rail to add, remove and rescan
   directories, with problems shown per source.
7. **Documentation**: skill sources in `docs/skills-and-settings.md` and `docs/residents.md`;
   the capability in `docs/harnesses-and-terminals.md`.

## Tests and verification

- Unit: source validation, index parsing and problems, `mission-*` skipping, identity
  stability, section defaults, snapshot creation, hashes and cleanup, per-driver option rendering
  for both primary and fallback mechanisms, and resume rendering from the pinned revision after
  the profile is edited. Claude's mechanism leaves the effective user settings unchanged.
- Effective-set tests, for each harness, with inherit on and with inherit off:
  - with fixture skills in every source step 1 covers, the snapshot holds exactly the inherited
    defaults present at launch plus the selections with inherit on, and exactly the selections
    with inherit off;
  - a selected skill that is also inherited, with the same identity, appears once and does not
    refuse the launch. Two distinct skills with the same effective name do refuse it;
  - after launch, each of these is followed by a daemon restart and resume, and leaves the
    run's effective skills byte-identical to its launch snapshot: adding a native skill,
    editing an inherited default, deleting an inherited default, and editing, and separately
    deleting, a selected source skill;
  - a new launch, and **Restart on new profile**, adopt each of those changes;
  - copied built-in skills: changing, removing or adding a built-in skill natively after
    launch leaves the run's copies in effect, and the run resumes normally;
  - built-in skills verified by identity:
    - a resume on an unchanged harness resumes normally;
    - each of these holds the resume with the recovery reason: a built-in skill that changes
      content under the same name, one that disappears, one newly added, and an identity that
      cannot be computed;
    - an identity the probe cannot show to cover built-in content leaves inherit on unoffered
      for that harness;
  - the `skills` payload carries an identity-only entry, with no folder, for each built-in
    skill recorded by identity;
  - the `skills` payload for a snapshot renders to each harness's recorded mechanism, and the
    same payload is produced at launch and on resume.
- Harness tests against real installations for every capability recorded as supported,
  including the step 1 exact-set check, saved as a fixture.
- Playwright `e2e/specs/residents-skills.spec.ts`: add a source folder from a fixture, rescan,
  select a skill, launch, and see the selection in the launch summary.
- `npm run typecheck`, `npm run lint`, `npm run build`, `npm run test:e2e`.

## Exit criteria

Each supported harness runs a resident with exactly its launch snapshot. With inherit on that
is the inherited defaults plus the selected skills; with inherit off, the selected skills alone.
The snapshot is unchanged across restarts until a new launch or **Restart on new profile**.

## Downstream handoff

Phase 5 reuses the measured-capability pattern and the optional-field approach on
`SdkLaunchOptions`, adding its own MCP field without changing `skills`.

## Cross-phase audit record

- Concurrent with Phases 2, 6 and 7; adds its own section, contributor, setting and rail entry.
- Owns the first extension of `SdkLaunchOptions`; Phase 5 depends on it to avoid parallel edits
  of the driver renderers.
- Repair round 1: selected-only is delivered through a probed primary or fallback mechanism, with
  an operator decision gate if both fail; the Codex overlay introduced here is reused by Phase 5.
- Pull request review (CodeRabbit): Claude selected-only keeps user settings and turns skills
  off through `skillOverrides`, and runs use immutable skill snapshots instead of links.
- Operator decision, "Freeze inherited and selected skills": `inheritDefaults` decides what is
  captured at launch, and both modes resume from that snapshot alone. The mechanism must pass an
  exact-set check across every native skill source, and name-by-name overrides no longer
  qualify alone. Effective-set tests cover additions, edits and deletions after launch.
- Pull request review (CodeRabbit, third batch, applied to skills): the snapshot is a set keyed
  by skill identity. An identical inherited and selected skill is kept once, and only distinct
  skills that share an effective name are refused.
- Pull request review (CodeRabbit, fourth batch):
  - built-in skills are copied into the snapshot where possible, and otherwise verified by a
    content or artifact identity;
  - copied built-in skills stay in effect across native changes, while built-in skills recorded
    by identity hold the run's resume when changed, missing, added or unverifiable, with a
    recovery path. Nothing is installed or downgraded;
  - the driver-neutral `skills` payload and its mapping are defined.
