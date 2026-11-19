# Phase 6 (WP4): owned hook and status line

## Outcome
The owned hook sends the extra session fields and prints the daemon's dispatch output; the status line shows the repository's task counts (F3, F4, F10).

## Entry and dependencies
Phases 2 and 3. Merge gated by spike S6 (hook output shown on SessionStart and UserPromptSubmit).

## Scope and non-goals
Spec 7.3 (hook side), 7.12. Owns `hooks/harness-hook.mjs`, `hooks/harness-statusline.mjs`, `src/server/home-dispatch/statusline-cache.ts`. Non-goals: a second hook entry.

## Repository findings
The hook posts every event and today prints only a `block` decision (L24); `MISSION_HEADLESS` must not be reused (L23).

## Steps
Add entrypoint, pid and terminal fields; print `dispatch.systemMessage` and `additionalContext`; keep exit fast and quiet when the daemon is slow or down and let `block` win; cache writer via `onFeatureFlagsChanged`; segment `● mc 2 running · 1 waiting · 1 queued`, `○ mc offline`.

## Tests and verification
`home-dispatch-hook` (execFile with stub daemon, exact stdout, exit 0), `home-dispatch-statusline`; built hook smoke; suite, typecheck, lint.

## Merge and exit
Flag off: hook output and status line unchanged. S6 recorded or fallback applied.

## Downstream handoff
Phase 11 installs and doctors these pieces.

## Cross-phase audit
Hot files `hooks/*` are owned only here.
