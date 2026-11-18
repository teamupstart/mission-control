# Phase 6: Instances, setup and launcher

Plan: `docs/plans/headless-mode/plan.md`. Spec sections 9 and 9.5. Isolation rationale: `docs/plans/headless-mode-install/plan.md`. Index: `docs/plans/headless-mode-phases/phased-plan.md`.

## 1. Outcome

`mctl --instance spike setup` installs the instance's launchd services and the spike plugin into the instance's own Claude config folder; `mctl --instance spike claude` opens Claude with the instance env and the launcher command so the question appears with no typing; `doctor`, `daemon` and `uninstall` manage it. Nothing touches the desktop app's state, Claude config, launchd labels or port. The work is pushed to `feat/headless-mode-spike`.

## 2. Entry criteria and dependencies

Phases 3 (hook), 4 (plugin build) and 5 (CLI skeleton and `instance.json` resolver) pushed to `feat/headless-mode-spike`.

## 3. Scope and non-goals

In scope: `src/cli/instance.ts`, `src/cli/setup/`, `claude`, `doctor`, `daemon`, `uninstall`, the manifest, guards G-2 (for these commands), G-4, G-5 and G-6, the `agentSubprocessEnv` change, executable registry entries. Not in scope: plugin content, hook behaviour, v1.1 commands, default-instance install, attach mode, `OPERATOR_SATELLITES`, any PATH shim, any pull request or other upstream branch.

## 4. Repository findings and contracts

- The desktop app owns the default state, `~/.claude` hooks (ten events, `satellites/hook.mjs`), the `mission-control` MCP registration, `mission-*` skill links and the `statusline-inner` sidecar. Setup must never read, back up, edit or remove any of them (AC-ISO-01, AC-SET-08).
- `scripts/install-service.mjs` writes `com.mission-control.daemon` and removes two legacy labels; the instance uses suffixed labels and must never touch those.
- The existing source installer refuses a transient pooled checkout and bakes a stable Node path: reuse `transientCheckoutRoot` and `stableNodePath` from `hooks/install-checks.mjs` (G-4). A pooled worktree is exactly what this task runs in, so tests must use a fake checkout layout.
- The app's update check treats a launchd job that executes its own bundle binary as a blocker, so `runtimeRoot` must never be inside an `.app` bundle.
- Spike S-02 proved config-folder plugin install is isolated, so the instance uses installed mode; `--plugin-dir-mode` is a manual override.
- `launchctl` must be in `FIXED_OS_EXECUTABLES` (`src/server/executables/catalog.ts`) and declared in `CHILD_PROCESS_BOUNDARIES` (`test/executable-contracts.test.ts`).
- Spike S-05 decides whether the plugin command is also reachable as plain `/mc`.

## 5. Implementation steps

1. Start from the tip of `origin/feat/headless-mode-spike`.
2. Instance resolution and `instance.json` (spec 9.1) with first-free-port logic from 7417; refuse `default` and any missing name (G-2).
3. `setup`: build check, stable-checkout and `.app` refusal (G-4), create the instance folder and a fresh database location, plugin copy to `{state}/plugin/{version}/`, two suffixed plists, `launchctl bootstrap`, plugin install with the instance `CLAUDE_CONFIG_DIR`, optional `--statusline` with a sidecar inside the instance folder, manifest written last, idempotence. No default-config reads or edits, no default-instance branch, no `daemon.lock` refusal against the app.
4. `claude`: always sets `MISSION_HOME`, `MISSION_PORT` and `CLAUDE_CONFIG_DIR` from the instance; optional `--plugin-dir`; launcher command rule (TTYs, no prompt, no `-p`, `--print`, `--resume`, `--continue`, no `--no-launcher`).
5. `doctor` (checks in spec 9.3, including default-config and default-label checks, reporting the owner's repair command without fixing it), `daemon status|restart|kick`, `uninstall [--purge]` removing exactly the manifest (G-6).
6. `agentSubprocessEnv` passes `CLAUDE_CONFIG_DIR` (G-5).
7. Fetch, rebase on the branch tip, re-run verification, push fast-forward to `feat/headless-mode-spike`.

## 6. Data, API and compatibility

Every test sets `HOME`, `CLAUDE_CONFIG_DIR`, `MISSION_HOME` to temp folders, plants fake default Claude files and default launchd plists, and injects fake `launchctl` and `claude` runners. Never touch real files or labels.

## 7. Tests and verification

Owns AC-SET-01 to AC-SET-16, AC-LAUNCH-04, AC-ISO-06, 08 and 09, the setup half of AC-ISO-01 (phase 7 owns the combined run), `test/executable-contracts.test.ts`, and AC-DEL-05 for its own pushes.

## 8. Exit criteria

Owned rows pass; isolation holds against the planted default files; build and smoke green; commits pushed to `feat/headless-mode-spike`, no other upstream branch. The operator then releases dependents.

## 9. Downstream handoff

Phase 7 drives `setup` and `uninstall --purge` in its isolation test and writes the names table into the docs.

## 10. Cross-phase audit

Uses phase 4's plugin layout and names, and phase 3's hook path, unchanged; adds commands through phase 5's table and reads phase 5's `instance.json` contract.
