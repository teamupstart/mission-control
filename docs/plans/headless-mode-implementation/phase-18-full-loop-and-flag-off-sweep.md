# Phase 18: Full loop, flag-off sweep and walkthrough (WP12)

Source: `plan.md`, `phased-plan.md`. Common rules: `phased-plan.md` section 3. Spec v18, section 6.

**1. Outcome.** One test and a person's walkthrough prove the whole loop works on `main`: dispatch, an answer from the pane, a chat message, a resident question, with no tmux or herdr, no context cost beyond F18's list, and no change with the flag off.

**2. Entry and dependencies.** Direct prerequisites: P6, P13, P16, P17. Every other phase is already a transitive prerequisite.

**3. Scope.** `test/home-dispatch-loop.test.ts`, `test/home-dispatch-no-mux.test.ts`; the flag-off sweep; the context check (F18: the pane, chat transcripts and chat messages never reach the model); the Focus checks of plan 4.2 re-run against the whole stack; and a live walkthrough written up for the pull request. Non-goals: new behavior; fixes found here go back to the owning phase's files in their own small pull request.

**4. Findings.** CI runs eighty-seven checks; the mod adapter's `claude plugin test` output is local only (Q17). The walkthrough needs a person at a terminal, on a build packaged by P16.

**5. Steps.** Read spec section 6 and F10, F12, F18. Build the loop test on the fakes and the real daemon routes. Assert no `tmux` or `herdr` process or binary is required. Sweep every `/dispatch/*` route, health capability and mod surface with the flag off. Re-run the Focus guards: unchanged Focus route entries, no terminal imports, and a home-dispatched terminal task still focusable from the dashboard. Do the walkthrough and attach its record to the pull request, not the repository.

**6. Data and API.** None.

**7. Tests.** `MISSION_TEST_CONCURRENCY=4 npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm run smoke`, `npm run test:e2e`.

**8. Merge and exit.** All checks green on `main`; the walkthrough is attached; S28b has been dispatched or consciously deferred by the owner.

**9. Handoff.** The feature is ready for alpha. Default-on and retirement of the flag are separate pull requests under `docs/feature-flags.md`.

**10. Cross-phase audit.** Adds tests only. Confirms every source-plan requirement and decision has an owning phase: guards (P1, P18), checks (P14, P8), gates (P7, P9, P11, P12), S28 (outside the phases).
