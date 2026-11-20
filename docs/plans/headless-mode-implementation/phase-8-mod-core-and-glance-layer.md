# Phase 8: Mod core and glance layer (WP13)

Source: `plan.md`, `phased-plan.md`. Common rules: `phased-plan.md` section 3. Spec v18, 7.10, 7.12, 7.21.

**1. Outcome.** The mod loads, follows the flag, registers the session, polls the inbox, and shows toasts, the band with its `1` button, a quiet status entry, and the banner. It stays inert on a `modApi` mismatch.

**2. Entry and dependencies.** Direct prerequisites: P3 (registration) and P4 (inbox). Soft spikes S14, S18, S19; record them in Commonroom, and where S14 fails use its documented fallback. Soft spikes never block a merge: when no answer is recorded the phase uses the fallback in plan 5.1 and its pull request says which answers it used or that none was recorded.

**3. Scope.** `src/mod/register.ts`, `host.ts`, `client.ts`, `attention.ts`, `banner.ts`, `src/mod/types/index.d.ts`: the adapter (including the `Pane` render and `ui.close` seams), `ModHost`, the daemon client and token, flag following, the worker rule, the poll, toasts, the band, the status entry rules, the banner, the real `paneOpen` and `paneClose` host calls (open id `mission`, focus, size, close) drawing a placeholder view that reads `The Mission Control pane is not available in this build yet.`, and the `mod-calls` smoke check of plan 6.5. Non-goals: dialogs and the tool (P11), real pane content (P12), install (P14).

**4. Findings.** `$.http.fetch` returns whole bodies, so the mod polls every 5 seconds rather than following events. The mod calls only `/api/health` and `/dispatch/*`, reads only the token file, and never writes to the model's context beyond F18's list. `$.ui.status` is plain text and only set while something needs the person (L37). Alt hotkeys never reach `prompt.edit` (L32), so none is used.

**5. Steps.** Read spec 7.10, 7.12, 7.21 and L31 to L37. Implement the adapter as a thin layer over pure functions, the flag and `modApi` inert paths, then each glance surface. Add the `claude plugin validate` allowlist check to `npm run smoke`.

**6. Data and API.** Uses the P1 and P3 registration and the P4 inbox. No new routes.

**7. Tests.** `node:test` with the fake host: flag off shows nothing, daemon down message, toasts for new items only, band and status only while something needs you, banner text, inert on mismatch. Run `claude plugin test` locally and attach its output to the pull request (Q17).

**8. Merge and exit.** The mod builds and loads under the fake host; smoke allowlist passes; nothing is shown with the flag off; under the fake host `paneOpen` opens the placeholder and `paneClose` closes it.

**9. Handoff.** P11 and P12 add flows and panes with one registration line each; P8 keeps `register.ts` and `host.ts`. P12 replaces the placeholder view and changes no `paneOpen` signature.

**10. Cross-phase audit.** Registration and inbox shapes match P3 and P4. The pane seam matches P2's skeleton.
