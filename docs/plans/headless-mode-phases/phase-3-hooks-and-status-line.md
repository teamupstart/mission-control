# Phase 3: Hooks and status line

Plan: `docs/plans/headless-mode/plan.md`. Spec section 6. Index: `docs/plans/headless-mode-phases/phased-plan.md`.

## 1. Outcome

Opening Claude shows the launcher banner; waiting worker questions surface on the next message; the status line shows `mc` counts. Hooks never block and never run inside workers.

## 2. Entry criteria and dependencies

Phase 1 merged (sessions, turns routes, inbox, banner field).

## 3. Scope and non-goals

In scope: `hooks/handoff-hook.mjs`, `hooks/harness-statusline.mjs` extension, the API writer for the status line cache. Not in scope: plugin packaging (phase 4), `mctl` (phases 5, 6), skills.

## 4. Repository findings and contracts

- Reuse `readStdin`, `readClientToken`, `BASE_URL` from `src/shared/hook-bridge.mjs` and `src/shared/harness-runtime.mjs`.
- `MISSION_HEADLESS` already means hooks stay silent; `MISSION_SESSION_ID` marks a worker (AC-HOOK-12).
- Spike S-05 (open): confirm `source` on `SessionStart`; fallback is a banner on every start.

## 5. Implementation steps

1. Hook entry per spec 6: 300 ms timeout, always exit 0, no `decision`, silent in workers and headless runs.
2. `SessionStart`: register, card summary in `additionalContext`, banner on `startup` and `clear`, kickstart on unreachable launchd instance via the injected runner, version mismatch message.
3. `UserPromptSubmit`, `Stop`, `PostToolUse` (`.*answer_task`) behaviours.
4. Status line segment with `shelved`, offline logic and cache reader.
5. API side: write the cache file whenever a repo's inbox changes.
6. If the hook spawns `launchctl`, it goes through the executable registry (`FIXED_OS_EXECUTABLES`, `CHILD_PROCESS_BOUNDARIES`); phase 6 finishes AC-SET-14.

## 6. Data, API and compatibility

Cache path `{stateDir}/handoff/statusline/{sha1(repoRoot)}.json`; format owned here. The banner text always comes from the API.

## 7. Tests and verification

Owns AC-HOOK-01 to AC-HOOK-12, AC-LAUNCH-01, AC-LAUNCH-02. Use stub HTTP servers and injected runners; set `MISSION_HEADLESS` and `MISSION_SESSION_ID` empty in tests.

## 8. Merge and exit criteria

Owned rows pass; typecheck, lint, tests, build and smoke green.

## 9. Downstream handoff

Phase 4 copies the built hook into the plugin; phase 6 points the status line at its copy. Neither may change the hook's CLI shape `handoff-hook.mjs {Event}`.

## 10. Cross-phase audit

Does not touch `src/cli/` or `plugin/`. Shares only phase 1's routes.
