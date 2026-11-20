# Phase 13: mctl run, claude and daemon (WP6b)

Source: `plan.md`, `phased-plan.md`. Common rules: `phased-plan.md` section 3. Spec v18, 7.13.

**1. Outcome.** From a terminal, `mctl run` starts a dispatch, `mctl claude` starts Claude with no workspace and no added prompt, so the launcher the mod shows (P11) appears on its own once P11 and P14 are in, and `mctl daemon` manages the background daemon.

**2. Entry and dependencies.** Direct prerequisites: P10 (client) and P5 (drafts and options). The launcher itself is P11's and does not gate this phase.

**3. Scope.** `src/cli/commands/run.ts`, `claude.ts`, `daemon.ts`. Non-goals: reads (P10), setup (P14), any tmux, herdr or terminal-runtime behavior (withdrawn by D50).

**4. Findings.** `mctl claude` no longer adds a prompt or a workspace (D40, D50); the launcher opens on its own through the mod. `mctl run` creates tasks through the dashboard path with no runtime override (Focus guard 1). `mctl` never answers, approves, cancels or sends (D8). The daemon runs without the app via `install-service`, but Foreman is started only by the app (L25).

**5. Steps.** Read spec 7.13. Implement `run` over P5's draft flow, `claude` as a thin launcher that finds `claude` with P14's detection when available (otherwise `PATH`), and `daemon` start, stop and status through the existing service paths.

**6. Data and API.** Uses P5 draft routes. No new routes.

**7. Tests.** Each command against the fake daemon; `run` leaves no runtime override; `claude` adds no prompt; with no mod installed (the state before P11 and P14 merge) `mctl claude` still starts Claude and shows no launcher, which is the expected interim behavior.

**8. Merge and exit.** The three commands work; before P11 and P14 merge `mctl claude` starts a plain Claude session; flag off reports the feature off.

**9. Handoff.** P14 may reuse `claude`'s detection helper; keep its signature stable.

**10. Cross-phase audit.** `src/cli/claude-cli.ts` belongs to P14; this phase imports it only after P14 lands, so until then it uses `PATH`.
