# Phase 16: App packaging of the mod (WP15)

Source: `plan.md`, `phased-plan.md`. Common rules: `phased-plan.md` section 3. Spec v18, 7.10a.

**1. Outcome.** The built mod ships inside the desktop app outside `asar`, and the app stages it at start through the same `mod-stage.ts` that `mctl setup` uses.

**2. Entry and dependencies.** Direct prerequisite: P14 (`src/server/mod-stage.ts`).

**3. Scope.** One entry in `electron-builder.yml` (named in the pull request) and one stage call at app start. Non-goals: any other release, signing or CI change; the mod is not published to claude-code-extensions (D44).

**4. Findings.** `electron-builder.yml` is a controlled path: change only what this task requires. `asar` must stay off and `skills/` must stay out of `dist` (CLAUDE.md boundaries). Staging publishes by rename, never by copying onto the published path.

**5. Steps.** Add the mod folder to the app's unpacked resources. Call the stage function once at app start, flag-gated. Confirm the staged folder matches `npm run build:mod` output. Run the packaging dry run locally if it is available.

**6. Data and API.** None.

**7. Tests.** A test that the stage call runs once and is a no-op with the flag off; the existing packaging and smoke checks; `npm run package` where the machine supports it, with its result attached to the pull request.

**8. Merge and exit.** The packaged app contains the mod outside `asar`; the diff touches `electron-builder.yml` by one entry only.

**9. Handoff.** P18's live walkthrough exercises the packaged app.

**10. Cross-phase audit.** Uses P14's stage function unchanged; no other phase edits `electron-builder.yml`.
