# Phase 13: mctl run, claude and daemon (WP6b)

Source: `plan.md`, `phased-plan.md`. Common rules: `phased-plan.md` section 3. Spec v18, 7.13.

**1. Outcome.** From a terminal, `mctl run` starts a dispatch, `mctl claude` starts Claude with no workspace and no added prompt, so the launcher the mod shows (P11) appears on its own when P11's launcher is enabled (S10 or S11 passed and was recorded) and P11 and P14 are in, while a plain Claude session is the expected result if P11 merged with its launcher switched off, and `mctl daemon` manages the background daemon.

**2. Entry and dependencies.** Direct prerequisites: P10 (client) and P5 (drafts and options). The launcher itself is P11's and does not gate this phase.

**3. Scope.** `src/cli/commands/run.ts`, `claude.ts`, `daemon.ts`. Non-goals: reads (P10), setup (P14), any tmux, herdr or terminal-runtime behavior (withdrawn by D50).

**4. Findings.** `mctl claude` no longer adds a prompt or a workspace (D40, D50); the launcher opens on its own through the mod when P11's launcher is enabled. `mctl run` creates tasks through the dashboard path with no runtime override (Focus guard 1). `mctl` never answers, approves, cancels or sends (D8). The daemon runs without the app via `install-service`, but Foreman is started only by the app (L25).

**5. Steps.** Read spec 7.13. Implement `run` over P5's draft flow, `claude` as a thin launcher that finds `claude` on `PATH` (P14 later swaps in its shared detection in one edit, see its section 5), and `daemon` start, stop and status through the existing service paths.

**6. Data and API.** Uses P5 draft routes. No new routes.

**7. Tests.** Each command against the fake daemon; `run` leaves no runtime override; `claude` adds no prompt; with no mod installed (the state before P11 and P14 merge) `mctl claude` still starts Claude and shows no launcher, which is the expected interim behavior; the same holds after P11 and P14 merge if P11's launcher is switched off because neither S10 nor S11 passed, and the test covers both states with the fake `claude` runner.

**8. Merge and exit.** The three commands work; before P11 and P14 merge, or after them with P11's launcher switched off, `mctl claude` starts a plain Claude session; the launcher appears only when P11's launcher is enabled; flag off reports the feature off.

**9. Handoff.** Keep `claude.ts` to one place where the `claude` binary is resolved, so P14 can replace it with its shared detection in one edit.

**10. Cross-phase audit.** `src/cli/claude-cli.ts` belongs to P14 and does not exist when this phase merges, so this phase imports nothing from it and resolves `claude` from `PATH`. P14 owns the one follow-up edit that makes `mctl claude` use the shared detection.
