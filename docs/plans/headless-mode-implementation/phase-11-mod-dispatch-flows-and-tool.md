# Phase 11: Mod dispatch flows and the tool (WP14)

Source: `plan.md`, `phased-plan.md`. Common rules: `phased-plan.md` section 3. Spec v18, 7.4, 7.11, 7.20.

**1. Outcome.** From Claude Code a person can dispatch a task through the launcher, the fast path, the description and the confirm, or from mid-conversation through the `start_dispatch` tool, with the confirm showing a Codex warning when reviews depend on Codex. Branches (S10, S11): if S10 passed, the launcher opens from `classic.SessionStart`; if only S11 passed, it holds the first prompt; if both failed, the launcher is switched off, every other flow still works, and the owner decides.

**2. Entry and dependencies.** Direct prerequisites: P8 (mod core and `paneOpen`), P5 (options and drafts), P7 (readiness route). Gate: S10 or S11 recorded in Commonroom before the launcher merges; if both fail, merge everything else with the launcher switched off and wait for the owner; P13's `mctl claude` is unaffected, since it only starts a plain Claude session whether or not the launcher is on. S8, S12 and S15 are soft. S10 or S11 is a merge gate for the launcher part only. A merge gate is satisfied only by the owner's answer posted to Commonroom: read it, quote it in the pull request, and stop without merging the gated part if none exists (the whole phase, except that for P11 it is the launcher part only, and the rest of P11 then merges with the launcher switched off). Soft spikes never block a merge: when no answer is recorded the phase uses the fallback in plan 5.1 and its pull request says which answers it used or that none was recorded. The Codex gate on P7 reaches P11 through P7: until it is recorded P7 cannot merge, so neither can P11.

**3. Scope.** `src/mod/flows/*`: `/mission-dispatch` (launcher, fast path, description, confirm, and the `inbox`, `check`, `pane` and task-id arguments, which call the host's `paneOpen` from P8 with the tab or task id and nothing else), the `start_dispatch` tool, the intent nudge, the `create_task` description sentence (registered from the mod, touching no daemon file), and the confirm summary's Codex line from the readiness route (six rows, Start now always stays). Non-goals: pane contents (P12), anything that answers or approves.

**4. Findings.** A dismissed dialog counts as Cancel, or Work in this session for the launcher. The mod never reorders or rewords daemon options. Reserved words are commands only as the whole argument (L20). No `mission-dispatch` skill exists for Claude (D42). Home-dispatched tasks must pass no runtime override (Focus guard 1). The confirm never claims `reviews ready` from a mod read when `CODEX_AUTH_MTIME_RELIABLE` is false.

**5. Steps.** Read spec 7.4, 7.11, 7.20, 7.25 (confirm). Implement each flow as pure functions over `ModHost` and register with one line each. Wire the Codex line. Phrase the tool description and nudge for S8.

**6. Data and API.** Uses P5 drafts and P7 readiness. No new routes.

**7. Tests.** Fake-host tests for each flow and dismissal path, the six confirm rows, the quick path; `claude plugin test` locally.

**8. Merge and exit.** Dispatch works end to end against the fakes; launcher gated by the recorded S10 or S11 answer. Interim pane behavior: with the fake host each of `inbox`, `check`, `pane` and a task id records one `paneOpen` with the right target, and none errors while P8's placeholder view is the pane. Tests cover the launcher on (as recorded) and the launcher off, and in the off state the other flows are unaffected.

**9. Handoff.** P15 owns the subagent line formatter and the two slot fills in P12's pane (the data fields are filled by P4 and P9); P12 replaces P8's placeholder view behind the same `paneOpen` calls.

**10. Cross-phase audit.** Registration lines do not collide with P12's. The Codex line matches P7's `CodexReadiness`.
