# Phase 7: Codex readiness and fail-fast (WP18)

Source: `plan.md`, `phased-plan.md`. Common rules: `phased-plan.md` section 3. Spec v18, section 7.25.

**1. Outcome.** Mission Control checks, with no model tokens, that Codex can run the after-work reviews, shows the result through `GET /dispatch/readiness`, and fails a run fast when Codex is missing or signed out. Branches (S27): if the recorded value is `CODEX_AUTH_MTIME_RELIABLE = true`, a mod read detects an account change from the `auth.json` mtime; if `false`, a mod read never claims `reviews ready` and only `mctl doctor --live` verifies the account.

**2. Entry and dependencies.** Direct prerequisite: P3 (which itself follows P2). The readiness route applies P3's home-session rules, so this phase merges only after P3. Gate: S27's answer recorded in Commonroom as `CODEX_AUTH_MTIME_RELIABLE` before merge (either answer is acceptable); S24 to S26 are soft. Quote the recorded answer in the pull request and stop without merging if there is none. S27 is a merge gate and is satisfied only by the owner's answer posted to Commonroom: read it, quote it in the pull request, and stop without merging the gated part if none exists (the whole phase, except that for P11 it is the launcher part only, and the rest of P11 then merges with the launcher switched off). Soft spikes never block a merge: when no answer is recorded the phase uses the fallback in plan 5.1 and its pull request says which answers it used or that none was recorded.

**3. Scope.** `src/server/setup/codex-readiness.ts` (six checks, the `HOME_DISPATCH_READINESS_MAX_AGE_MS` 10-minute cache, `accountVerified`, `reviewsReady`), `src/server/home-dispatch/readiness.ts`, `src/cli/setup-steps/codex.ts` with its doctor checks (including the `mctl doctor --live` check and the `codex login` offer), the flag-gated reviewer-failure gate in `src/server/workflows/engine.ts` and its two classes (`not-installed`, `signed-out`) in `src/server/llm/provider-failure.ts`, and `test/home-dispatch-codex-readiness.test.ts`, `test/home-dispatch-codex-failfast.test.ts`. Fixtures: `test/helpers/fake-codex-cli.ts`, a fake `codex` CLI (`login status` exiting 0 or 1, a version, model ids) and a temporary `auth.json` with a controllable mtime.

**4. Findings.** A signed-out Codex today takes the 10-minute provider retry window before the run blocks (L41); `codex login status` exits 0 signed in and 1 not (L42). A mod read never probes: it returns the cache marked stale and detects binary or sign-in change by `stat`, never opening `auth.json`. Only `mctl` refreshes. The engine file is shared with the dashboard, so the change is called out in the pull request.

**5. Steps.** Read spec 7.25, D54 to D57, Q24 to Q26, L40 to L43. Build the readiness module and route. Implement invalidation (reviewer set, Codex version, account). Add the fail-fast gate under the flag only. Add the setup step and doctor lines.

**6. Data and API.** `CodexReadiness` shape from P1. `live=1` is for `mctl` only.

**7. Tests.** Every check; staleness by age; each invalidation case including an unchanged-mtime account switch; fail-fast classes; with the flag off every reviewer path keeps today's retries (Q25).

**8. Merge and exit.** Readiness route real behind the flag; dashboard behavior unchanged flag-off; S27 answer quoted. Tests cover both values of `CODEX_AUTH_MTIME_RELIABLE`.

**9. Handoff.** P11 draws the confirm summary's Codex line from this route; P17 documents it. The `codex` step is registered in P2's setup-step list; `mctl setup` and `mctl doctor` are P14's commands, so until P14 merges the step runs only under this phase's own tests, and once P14 merges, its `doctor` runs the step from the list and passes it `{ live }`.

**10. Cross-phase audit.** P14 does not own `codex.ts`; P15 does not own it either. The engine gate is the only change to the shared workflow engine in the whole plan.
