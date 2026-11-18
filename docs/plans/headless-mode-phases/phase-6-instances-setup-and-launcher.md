# Phase 6: Instances, setup and launcher

Plan: `docs/plans/headless-mode/plan.md`. Spec section 9. Index: `docs/plans/headless-mode-phases/phased-plan.md`.

## 1. Outcome

`mctl setup` installs launchd services, the Claude Code plugin and the status line for the default or a named instance; `mctl claude` opens Claude with the instance env and the launcher prompt so the question appears with no typing; `doctor`, `daemon` and `uninstall` manage it. Nothing touches another instance.

## 2. Entry criteria and dependencies

Phases 3 (hook and status line), 4 (plugin build) and 5 (CLI skeleton) merged.

## 3. Scope and non-goals

In scope: `src/cli/instance.ts`, `src/cli/setup/`, `claude`, `doctor`, `daemon`, `uninstall`, the `agentSubprocessEnv` change, executable registry entries. Not in scope: plugin content, hook behaviour, v1.1 commands.

## 4. Repository findings and contracts

- Spike S-02 proved config-folder plugin install is isolated, so every instance uses installed mode; `--plugin-dir-mode` is a manual override.
- `launchctl` must be in `FIXED_OS_EXECUTABLES` (`src/server/executables/catalog.ts`) and declared in `CHILD_PROCESS_BOUNDARIES` (`test/executable-contracts.test.ts`).
- Status line wrap reuses the JSONC edit and sidecar from `hooks/install.mjs`.
- Workers load the instance plugin; phases 3 and 4 already silence them (decision 25).
- Spike S-05 decides the exact first-prompt spelling (`/mc` or `/mission-control:mc`). Because it starts with `/`, the daemon's first-message launcher never fires a second time (phase 1).

## 5. Implementation steps

1. Instance resolution and `instance.json` (spec 9.1) with first-free-port logic.
2. `setup`: build check, plugin copy to `{state}/plugin/{version}/`, plists, `launchctl bootstrap`, plugin install with the instance `CLAUDE_CONFIG_DIR`, status line wrap, default-instance duplicate backup and removal, `daemon.lock` refusal, idempotence.
3. `claude`: env, optional `--plugin-dir`, launcher prompt rule (TTYs, no prompt, no `-p`, `--print`, `--resume`, `--continue`, no `--no-launcher`).
4. `doctor`, `daemon status|restart|kick`, `uninstall [--purge]`.
5. `agentSubprocessEnv` passes `CLAUDE_CONFIG_DIR`.

## 6. Data, API and compatibility

Every test sets `HOME`, `CLAUDE_CONFIG_DIR`, `MISSION_HOME` to temp folders and injects fake `launchctl` and `claude` runners. Never touch real files or labels.

## 7. Tests and verification

Owns AC-SET-01 to AC-SET-16, AC-LAUNCH-04, plus `test/executable-contracts.test.ts`.

## 8. Merge and exit criteria

Owned rows pass; isolation holds for named instances; build and smoke green.

## 9. Downstream handoff

Phase 7 drives `setup` and `uninstall --purge` in its isolation test.

## 10. Cross-phase audit

Uses phase 4's plugin layout and phase 3's hook path unchanged; adds commands through phase 5's table.
