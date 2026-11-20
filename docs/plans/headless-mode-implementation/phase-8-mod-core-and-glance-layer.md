# Phase 8: Mod core and glance layer (WP13, minimal)

Source: `plan.md` (section 0), `phased-plan.md`. Common rules: `phased-plan.md` section 4. Spec v20 (sha256 `00677497ade4bb65c93457c3443849ac9b350b497b1efa82378d47d55d315ee2`). Branch from `main`; start only after the phase named under Entry has merged, then `git rebase --onto origin/main <old base>`.

**1. Outcome.** With the flag on, the mod loads in Claude Code, registers the session with the daemon, polls the inbox, and tells the person when something needs them: a toast for each new item, the band with its `1` button, a quiet status entry, and the start-up banner. With the flag off, or on a `modApi` mismatch, it shows nothing.

**2. Entry.** P5 merged (the banner builder in `src/shared/home-dispatch-banner.ts`). P3 and P4 are already on `main`. No hard gate. S14, S18 and S19 are soft: record the answer used in the pull request, or say none was recorded.

**3. Scope.** `src/mod/register.ts`, `host.ts`, `client.ts`, `attention.ts`, `banner.ts`, `src/mod/types/index.d.ts`, `src/mod/allowed-calls.json`, and the `mod-calls` check in `scripts/smoke-bundles.mjs`. The inbox poll is every 5 seconds. The mod calls only `/api/health` and `/dispatch/*`. Non-goals: dialogs and the tool (P11a, P11b), setup and install (P14), the pane (deferred). There is no `paneOpen` seam in this phase; the `1` button opens P11b's needs-you dialog through a one-line registration that P11b adds.

**4. Steps.** Read spec 7.10, 7.12, 7.21. Build the adapter as a thin layer over pure functions: flag follow, `modApi` check before anything registers, daemon-down message, poll, toast for new items only, band and status only while something needs the person. Add the allowlist check to `npm run smoke`.

**5. Tests.** `node:test` with the fake host and fake daemon: flag off shows nothing, daemon down message, toasts for new items only, band and status only while something needs you, banner text, inert on mismatch. Run `claude plugin test` locally and attach the output to the pull request.

**6. Exit.** The mod builds and loads under the fake host; the smoke allowlist passes; nothing is shown with the flag off.

**7. Handoff.** P11a and P11b add flows and dialogs with one registration line each in `register.ts`; P8 keeps `register.ts` and `host.ts`. Whichever merges second rebases; the merge is mechanical.
