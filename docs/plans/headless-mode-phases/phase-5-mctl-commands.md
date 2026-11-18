# Phase 5: mctl commands

Plan: `docs/plans/headless-mode/plan.md`. Spec section 8. Index: `docs/plans/headless-mode-phases/phased-plan.md`.

## 1. Outcome

`mctl` can list, describe, follow and run tasks from a terminal, using the same API as a home session. The work is pushed to `feat/headless-mode-spike`.

## 2. Entry criteria and dependencies

Phase 1 pushed to `feat/headless-mode-spike` (inbox, answers, task origin, launcher setting).

## 3. Scope and non-goals

In scope: `src/cli/` commands `get`, `describe`, `logs`, `status`, `config view` (including `handoff.launcher.prompt`), `run`, global flags, `--instance` plumbing input only. Not in scope: `setup`, `doctor`, `daemon`, `uninstall`, `claude` (phase 6); guided questions in `mctl run` (it stays the scripted path); `--grill`; any pull request or other upstream branch.

## 4. Repository findings and contracts

- Stubs from Phase 0: `src/cli/index.ts`, `command.ts`, `commands.ts`, `commands/*.ts`.
- Shared HTTP client: move the request helper from `src/mcp/server.ts` into `src/shared/handoff-client.ts` only if it has no `node:` imports, else `src/cli/client.ts`.
- Transcript routes: `/api/sessions/:id/transcript/stream` and `/events` SSE.
- Exit codes in spec 8.3, including 3 and 130.

## 5. Implementation steps

1. Start from the tip of `origin/feat/headless-mode-spike`.
2. Command table and global flags; the table must equal spec 8.2 (AC-CLI-13).
3. Read commands from the inbox route; `logs -f` over SSE with no polling.
4. `run`: TTY rule, kind and after-work resolution on the server, harness-registry validation, create then dispatch with surface `cli`, `--shelve`, `--dry-run`, `-f`, no stdin brief, `--watch` with inline prompting and exit codes.
5. `--instance` and `MCTL_INSTANCE` select port and token via a small resolver that phase 6 completes.
6. Fetch, rebase on the branch tip, re-run verification, push fast-forward to `feat/headless-mode-spike`.

## 6. Data, API and compatibility

No schema change. `mctl` never answers home-session tasks.

## 7. Tests and verification

Owns AC-CLI-01 to AC-CLI-13, and AC-DEL-05 for its own pushes. Use injected `isTTY`, stdout and runners; no model tokens.

## 8. Exit criteria

Owned rows pass; `npm run build` produces `dist/cli/mctl.mjs`; smoke passes; commits pushed to `feat/headless-mode-spike`, no other upstream branch. The operator then releases dependents.

## 9. Downstream handoff

Phase 6 adds commands through `command.ts` and completes instance resolution without changing existing command behaviour.

## 10. Cross-phase audit

Only `src/cli/` and the shared client are touched, disjoint from phases 2 and 3, so concurrent pushes rebase cleanly.
