# Phase 17: Documentation (WP9)

Source: `plan.md`, `phased-plan.md`. Common rules: `phased-plan.md` section 3. Spec v18, 5 and 7.19.

**1. Outcome.** The docs describe headless mode as an alpha: what it is, how to set it up, the pane and its keys, residents, Codex readiness, and troubleshooting, and they match what actually merged.

**2. Entry and dependencies.** Direct prerequisites: P14, P15, P12, P7 (every user-facing package on `main`). Drafting can start after P2 but the final text is written against merged behavior.

**3. Scope.** `docs/` only: a headless-mode guide linked from `docs/README.md`; the pane and its keys including the `1` first-key note; residents and chat; Codex readiness and `mctl doctor --live`; the mods troubleshooting section of plan 6.5 (each switch, how doctor reports it, its fix, and that disabling the mod in `/plugin` lasts only until the next `mctl setup`); a statement that the pane's cost leaves out review calls (Q26); the unsupported runs (`claude -p`, `--bare`, `--safe-mode`, Codex non-interactive); and updates to `docs/feature-flags.md` and `docs/glossary.md` where they apply. Non-goals: code, and any new image committed as evidence.

**4. Findings.** The docs index is `docs/README.md`. `CHANGELOG.md` is generated and never hand-edited. Documentation images belong in `docs/images/` only as documentation, not evidence. No em dash in prose.

**5. Steps.** Read the merged code and the spec sections it cites. Write each section from the implementation, not from the spec alone. Cross-link, and run a link check if the repository has one.

**6. Data and API.** None.

**7. Tests.** Run any docs tests (`npm test` includes doc-contract tests if present) and `npm run lint`.

**8. Merge and exit.** Every user-visible behavior of P3 to P16 is documented accurately; README and linked docs match the implementation.

**9. Handoff.** P18's walkthrough follows these docs.

**10. Cross-phase audit.** Only P17 edits `docs/`; earlier phases listed the changes they needed in their pull requests.
