# Phase 8: Mod core and glance layer (WP13, minimal)

Source: `plan.md` (section 0), `phased-plan.md`. Common rules: `phased-plan.md` section 4. Spec v20 (sha256 `00677497ade4bb65c93457c3443849ac9b350b497b1efa82378d47d55d315ee2`). Branch from `main`; start only after P5 has merged, then `git rebase --onto origin/main <old base>`.

**1. Outcome.** With the flag on, the mod loads in Claude Code, registers the session with the daemon, polls the inbox, and opens the Mission Control pane as Claude launches, with the start-up banner. It tells the person when something needs them: a toast for each new item, the band with its `1` button (which opens the pane on Needs you), and a quiet status entry. With the flag off, or on a `modApi` mismatch, it shows nothing. Until P12 lands the pane shows a placeholder.

**2. Entry.** P5 merged (the banner builder in `src/shared/home-dispatch-banner.ts`). P3 and P4 are already on `main`. No hard gate. S14, S18 and S19 are soft, and so is a new one: whether a pane can be opened from `session.start`. If it cannot, the banner and the band's `1` button open it and the pull request says so.

**3. Scope.** `src/mod/register.ts`, `host.ts`, `client.ts`, `attention.ts`, `banner.ts`, `src/mod/types/index.d.ts`, `src/mod/allowed-calls.json`, and the `mod-calls` check in `scripts/smoke-bundles.mjs`. The real `paneOpen` and `paneClose` host calls (open id `mission`, focus, size, close) drawing a placeholder view that reads `The Mission Control pane is not available in this build yet.`, and the call that opens the pane at session start. The inbox poll is every 5 seconds. The mod calls only `/api/health` and `/dispatch/*`. The banner and the band draw above the prompt through the `AbovePrompt` render hook; the banner text comes from P5's builder and names what the person can do (dispatch, open the pane). Review rules: no Alt+I and no second pane; the status entry is set only while something needs the person; the band's `1` button shows only while something waits. Non-goals: dispatch flows (P11), pane contents (P12), setup and install (P14).

**4. Steps.** Read spec 7.10, 7.12, 7.21 and the design review. Build the adapter as a thin layer over pure functions: flag follow, `modApi` check before anything registers, daemon-down message, poll, toast for new items only, band and status only while something needs the person, pane open at start.

**5. Tests.** `node:test` with the fake host and fake daemon: flag off shows nothing, daemon down message, pane opened once at start, toasts for new items only, band and status only while something needs you, banner text, inert on mismatch, `paneOpen` and `paneClose` under the fake host. Run `claude plugin test` locally and attach the output to the pull request.

**6. Exit.** The mod builds and loads under the fake host; the smoke allowlist passes; nothing is shown with the flag off.

**7. Handoff.** P11 adds flows and P12 replaces the placeholder view, each with one registration line in `register.ts`; P12 changes no `paneOpen` signature. Whichever merges second rebases; the merge is mechanical.
