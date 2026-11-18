# Phase 3: Hooks and status line

Plan: `docs/plans/headless-mode/plan.md`. Spec section 6. Index: `docs/plans/headless-mode-phases/phased-plan.md`.

## 1. Outcome

In the `spike` instance, opening Claude tells the person Mission Control will ask how to start, and the first message of a new session triggers the launcher question without any command. Waiting worker questions surface on the next message; the status line shows `mc` counts. The hook never blocks, never runs inside workers, and never talks to the desktop app's daemon. The work is pushed to `feat/headless-mode-spike`.

## 2. Entry criteria and dependencies

Phase 1 pushed to `feat/headless-mode-spike` (sessions, turns routes with `launcher.offer`, inbox, banner field, the spike hook name).

## 3. Scope and non-goals

In scope: `hooks/handoff-spike-hook.mjs`, the status line segment code and its API cache writer, the launcher instruction, the `MISSION_HANDOFF_LAUNCHER` switch, and guard G-3. Not in scope: the offer decision (phase 1), the launcher question (phase 2), plugin packaging and skill text (phase 4), `mctl` (phases 5, 6), registering anything in `~/.claude/settings.json`, editing the desktop app's `harness-statusline.mjs` wrapper installation, any pull request or other upstream branch.

## 4. Repository findings and contracts

- Reuse `readStdin`, `readClientToken`, `BASE_URL` from `src/shared/hook-bridge.mjs` and `src/shared/harness-runtime.mjs`. `BASE_URL` defaults to port 7317, which is the desktop app's daemon, so this hook must take the port from the instance's `MISSION_PORT` and refuse to run without it (G-3).
- The app recognises its hooks by the substrings `harness-hook.mjs` and `satellites/hook.mjs` (`isMissionHookCommand`). This hook's name contains neither, and it is registered only in the plugin's `hooks.json`.
- `MISSION_HEADLESS` already means hooks stay silent; `MISSION_SESSION_ID` marks a worker (AC-HOOK-12, AC-LAUNCH-09).
- A hook cannot start a turn; the launcher is an `additionalContext` instruction on the first prompt, decided by the daemon.
- Spikes open: S-05 (`source` on `SessionStart`), S-06 (entrypoint value, and whether a plugin can submit a first prompt).

## 5. Implementation steps

1. Start from the tip of `origin/feat/headless-mode-spike`.
2. Hook entry per spec 6: instance guard first (no-op unless `MISSION_HOME` names a folder under `~/.mission-control-instances/`, never contacting 7317), 300 ms timeout, always exit 0, no `decision`, silent in workers and headless runs.
3. `SessionStart`: register with `source` and entrypoint, card summary in `additionalContext`, notice (server text) on `startup` and `clear`, kickstart on an unreachable instance through the injected runner using the instance's own label, version mismatch message naming `mctl --instance {name} setup`.
4. `UserPromptSubmit`: post the prompt; print question cards first; when `launcher.offer` is true add the launcher instruction last (call `read_dispatch_options` with `entry` `first-message` and the message as `brief`, ask the launcher question, keep the message, no work before the answer). `MISSION_HANDOFF_LAUNCHER=0` skips the instruction but still logs the turn.
5. `Stop` and `PostToolUse` (`.*answer_task`) behaviours.
6. Status line segment with `shelved`, offline logic and cache reader. Do not edit `hooks/harness-statusline.mjs` as the app installs it; the segment is a separate module the instance wraps only with `--statusline` (phase 6).
7. API side: write the cache file whenever a repo's inbox changes.
8. If the hook spawns `launchctl`, it goes through the executable registry; phase 6 finishes AC-SET-14.
9. Fetch, rebase on the branch tip, re-run verification, push fast-forward to `feat/headless-mode-spike`.

## 6. Data, API and compatibility

Cache path `{stateDir}/handoff/statusline/{sha1(repoRoot)}.json`; format owned here. The notice text always comes from the API; the hook holds no kind list.

## 7. Tests and verification

Owns AC-HOOK-01 to AC-HOOK-12, AC-LAUNCH-01, 02, 08, 09, 10, AC-ISO-05, and AC-DEL-05 for its own pushes. Use stub HTTP servers on an instance port and injected runners; set `MISSION_HEADLESS`, `MISSION_SESSION_ID` and `MISSION_HANDOFF_LAUNCHER` empty and `MISSION_HOME` to a temp folder under a fake `~/.mission-control-instances/`.

## 8. Exit criteria

Owned rows pass; typecheck, lint, tests, build and smoke green; commits pushed to `feat/headless-mode-spike`, no other upstream branch. The operator then releases dependents.

## 9. Downstream handoff

Phase 4 copies the built hook into the plugin and writes the skill entry that answers the instruction text; phase 6 wraps the status line only when asked. Neither may change the hook's CLI shape `handoff-spike-hook.mjs {Event}` or the instruction's reference to `read_dispatch_options` and `entry` `first-message`.

## 10. Cross-phase audit

Does not touch `src/cli/`, `plugin/` or any of the app's installers. Shares phase 1's routes, `launcher.offer` and hook name; the instruction text and phase 4's first-message entry reference the same bare tool name and `entry` value.
