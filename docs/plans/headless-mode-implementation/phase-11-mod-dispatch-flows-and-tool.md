# Phase 11: Mod dispatch flows and the tool (WP14)

Source: `plan.md`, `phased-plan.md`. Common rules: `phased-plan.md` section 3. Spec v18, 7.4, 7.11, 7.20.

**1. Outcome.** From Claude Code a person can dispatch a task through the launcher, the fast path, the description and the confirm, or from mid-conversation through the `start_dispatch` tool, with the confirm showing a Codex warning when reviews depend on Codex.

**2. Entry and dependencies.** Direct prerequisites: P8 (mod core and `paneOpen`), P5 (options and drafts), P7 (readiness route). Gate: S10 or S11 recorded in Commonroom before the launcher merges; if both fail, merge everything else with the launcher switched off and wait for the owner. S8, S12 and S15 are soft.

**3. Scope.** `src/mod/flows/*`: `/mission-dispatch` (launcher, fast path, description, confirm, and the `inbox`, `check`, `pane` and task-id arguments, which call the host's `paneOpen` from P8 with the tab or task id and nothing else), the `start_dispatch` tool, the intent nudge, the `create_task` description sentence, and the confirm summary's Codex line from the readiness route (six rows, Start now always stays). Non-goals: pane contents (P12), anything that answers or approves.

**4. Findings.** A dismissed dialog counts as Cancel, or Work in this session for the launcher. The mod never reorders or rewords daemon options. Reserved words are commands only as the whole argument (L20). No `mission-dispatch` skill exists for Claude (D42). Home-dispatched tasks must pass no runtime override (Focus guard 1). The confirm never claims `reviews ready` from a mod read when `CODEX_AUTH_MTIME_RELIABLE` is false.

**5. Steps.** Read spec 7.4, 7.11, 7.20, 7.25 (confirm). Implement each flow as pure functions over `ModHost` and register with one line each. Wire the Codex line. Phrase the tool description and nudge for S8.

**6. Data and API.** Uses P5 drafts and P7 readiness. No new routes.

**7. Tests.** Fake-host tests for each flow and dismissal path, the six confirm rows, the quick path; `claude plugin test` locally.

**8. Merge and exit.** Dispatch works end to end against the fakes; launcher gated by the recorded S10 or S11 answer. Interim pane behavior: with the fake host each of `inbox`, `check`, `pane` and a task id records one `paneOpen` with the right target, and none errors while P8's placeholder view is the pane.

**9. Handoff.** P15 owns subagent lines end to end (formatter, producer, field and the header slot fill in P12's pane); P12 replaces P8's placeholder view behind the same `paneOpen` calls.

**10. Cross-phase audit.** Registration lines do not collide with P12's. The Codex line matches P7's `CodexReadiness`.
