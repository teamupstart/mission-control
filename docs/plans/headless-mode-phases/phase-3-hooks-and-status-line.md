# Phase 3: Hooks and status line

Plan: `docs/plans/headless-mode/plan.md`. Spec section 6. Index: `docs/plans/headless-mode-phases/phased-plan.md`.

## 1. Outcome

Opening Claude tells the person Mission Control will ask how to start, and the first message of a new session triggers the launcher question without any command. Waiting worker questions surface on the next message; the status line shows `mc` counts. Hooks never block and never run inside workers.

## 2. Entry criteria and dependencies

Phase 1 merged (sessions, turns routes with `launcher.offer`, inbox, banner field).

## 3. Scope and non-goals

In scope: `hooks/handoff-hook.mjs`, `hooks/harness-statusline.mjs` extension, the API writer for the status line cache, the launcher instruction and the `MISSION_HANDOFF_LAUNCHER` switch. Not in scope: the offer decision (phase 1), the launcher question (phase 2), plugin packaging and skill text (phase 4), `mctl` (phases 5, 6).

## 4. Repository findings and contracts

- Reuse `readStdin`, `readClientToken`, `BASE_URL` from `src/shared/hook-bridge.mjs` and `src/shared/harness-runtime.mjs`.
- `MISSION_HEADLESS` already means hooks stay silent; `MISSION_SESSION_ID` marks a worker (AC-HOOK-12, AC-LAUNCH-09).
- A hook cannot start a turn; the launcher is an `additionalContext` instruction on the first prompt, decided by the daemon.
- Spikes open: S-05 (`source` on `SessionStart`), S-06 (entrypoint value, and whether a plugin can submit a first prompt).

## 5. Implementation steps

1. Hook entry per spec 6: 300 ms timeout, always exit 0, no `decision`, silent in workers and headless runs.
2. `SessionStart`: register with `source` and entrypoint, card summary in `additionalContext`, notice (server text) on `startup` and `clear`, kickstart on unreachable launchd instance via the injected runner, version mismatch message.
3. `UserPromptSubmit`: post the prompt; print question cards first; when `launcher.offer` is true add the launcher instruction last (call `read_dispatch_options` with `entry` `first-message` and the message as `brief`, ask the launcher question, keep the message, no work before the answer). `MISSION_HANDOFF_LAUNCHER=0` skips the instruction but still logs the turn.
4. `Stop` and `PostToolUse` (`.*answer_task`) behaviours.
5. Status line segment with `shelved`, offline logic and cache reader.
6. API side: write the cache file whenever a repo's inbox changes.
7. If the hook spawns `launchctl`, it goes through the executable registry; phase 6 finishes AC-SET-14.

## 6. Data, API and compatibility

Cache path `{stateDir}/handoff/statusline/{sha1(repoRoot)}.json`; format owned here. The notice text always comes from the API; the hook holds no kind list.

## 7. Tests and verification

Owns AC-HOOK-01 to AC-HOOK-12, AC-LAUNCH-01, 02, 08, 09, 10. Use stub HTTP servers and injected runners; set `MISSION_HEADLESS`, `MISSION_SESSION_ID` and `MISSION_HANDOFF_LAUNCHER` empty in tests.

## 8. Merge and exit criteria

Owned rows pass; typecheck, lint, tests, build and smoke green.

## 9. Downstream handoff

Phase 4 copies the built hook into the plugin and writes the skill entry that answers the instruction text; phase 6 points the status line at its copy. Neither may change the hook's CLI shape `handoff-hook.mjs {Event}` or the instruction's reference to `read_dispatch_options` and `entry` `first-message`.

## 10. Cross-phase audit

Does not touch `src/cli/` or `plugin/`. Shares phase 1's routes and `launcher.offer`; the instruction text and phase 4's first-message entry reference the same tool and `entry` value.
