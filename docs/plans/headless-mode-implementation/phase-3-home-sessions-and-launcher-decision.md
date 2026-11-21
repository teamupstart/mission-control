# Phase 3: Home sessions and launcher decision (WP2a)

> **Status: merged on main.** Built; no work remains in this phase. See `phased-plan.md` section 1.

Source: `plan.md`, `phased-plan.md`. Common rules: `phased-plan.md` section 3. Spec v18.

**1. Outcome.** The daemon registers a home session, answers who is allowed to do what, decides whether to offer the launcher, and detects dispatch intent. These are the home-session rules every other route relies on.

**2. Entry and dependencies.** Direct prerequisite: P2.

**3. Scope.** `src/server/home-dispatch/sessions.ts`, `launcher.ts`, and the `dispatchIntentFor` body (spec 7.2, 7.4, 7.20 detector). Registration answer fields: `offerLauncher`, `counts`, `daemonVersion`, `minModApi`, `dashboardUrl`. Worker versus home rule, repository scoping and the `cli` caller rules. Non-goals: dialogs, drafts, the mod's use of the answer. The registration answer's `counts` is a zero for every state until P4 merges, and P4 fills it from the inbox (same shape); P3 tests the interim.

**4. Findings.** Only SDK launches set `MISSION_SESSION_ID`, so a client-side worker check is never enough and the daemon's rule is the authority (L29). After `/clear` the session id changes (L2). Entrypoint `cli` versus `sdk-cli` decides interactivity (L6). Home-dispatched tasks must be created through the dashboard path with no runtime override (Focus guard 1, tested in P5).

**5. Steps.** Implement registration (with `interactive`, `beforeFirstPrompt`, `client_version`), the home-session predicate shared with P4, P9 and P7, the launcher decision, and the intent detector with reserved words matching only as the whole argument (L20). Fill the P1 stubs without changing their shapes.

**6. Data and API.** Uses the P1 tables. No new tables. Route: `POST /dispatch/sessions`.

**7. Tests.** Registration, worker refusal, `cli` caller limits, launcher decision table, intent detector phrases, a check that registration and the session record never set a runtime (the runtime and Focus test is P5's, where the first task is started).

**8. Merge and exit.** Registration answer is real behind the flag; flag off is unchanged; tests pass.

**9. Handoff.** P4 merges after this phase and, with P5, P9, P7 and P8, calls the home-session predicate; none may re-implement it. P11 uses the detector and launcher decision.

**10. Cross-phase audit.** Registration shape matches P1 and the fake daemon in P2. No overlap with P4 (inbox) or P5 (drafts).
