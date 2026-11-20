# Phase 3: Home sessions and launcher decision (WP2a)

Source: `plan.md`, `phased-plan.md`. Common rules: `phased-plan.md` section 3. Spec v18.

**1. Outcome.** The daemon registers a home session, answers who is allowed to do what, decides whether to offer the launcher, and detects dispatch intent. These are the home-session rules every other route relies on.

**2. Entry and dependencies.** Direct prerequisite: P2.

**3. Scope.** `src/server/home-dispatch/sessions.ts`, `launcher.ts`, and the `dispatchIntentFor` body (spec 7.2, 7.4, 7.20 detector). Registration answer fields: `offerLauncher`, `counts`, `daemonVersion`, `minModApi`, `dashboardUrl`. Worker versus home rule, repository scoping and the `cli` caller rules. Non-goals: dialogs, drafts, the mod's use of the answer.

**4. Findings.** Only SDK launches set `MISSION_SESSION_ID`, so a client-side worker check is never enough and the daemon's rule is the authority (L29). After `/clear` the session id changes (L2). Entrypoint `cli` versus `sdk-cli` decides interactivity (L6). Home-dispatched tasks must be created through the dashboard path with no runtime override (Focus guard 1).

**5. Steps.** Implement registration (with `interactive`, `beforeFirstPrompt`, `client_version`), the home-session predicate shared with P4, P9 and P7, the launcher decision, and the intent detector with reserved words matching only as the whole argument (L20). Fill the P1 stubs without changing their shapes.

**6. Data and API.** Uses the P1 tables. No new tables.

**7. Tests.** Registration, worker refusal, `cli` caller limits, launcher decision table, intent detector phrases, the Focus guard 1 test (terminal-default kind gets a pane and Focus returns what a dashboard task returns).

**8. Merge and exit.** Registration answer is real behind the flag; flag off is unchanged; tests pass.

**9. Handoff.** P4 merges after this phase and, with P9, P7 and P8, calls the home-session predicate; none may re-implement it. P11 uses the detector and launcher decision.

**10. Cross-phase audit.** Registration shape matches P1 and the fake daemon in P2. No overlap with P4 (inbox) or P5 (drafts).
