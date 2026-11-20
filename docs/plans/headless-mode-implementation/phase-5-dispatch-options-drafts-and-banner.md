# Phase 5: Dispatch options, drafts and banner (WP3)

Source: `plan.md`, `phased-plan.md`. Common rules: `phased-plan.md` section 3. Spec v18.

**1. Outcome.** The daemon builds the dispatch dialog pages from shared registries, keeps the person's picks in a draft, and builds the banner text, so the mod never invents a list.

**2. Entry and dependencies.** Direct prerequisite: P3 (which itself follows P2). The options, drafts and banner routes call P3's home-session predicate, so this phase merges only after P3; you may start against the P2 fakes and rebase on P3 before merging.

**3. Scope.** `src/server/home-dispatch/options.ts`, `drafts.ts`; `src/shared/dispatch-options.ts`, `src/shared/after-work.ts` (the shared `kindAfterWork`), `src/shared/home-dispatch-banner.ts`; the import swap in `DispatchModal.tsx` so the dashboard and the daemon read one source (spec 7.5, 7.6, 7.20 draft, 7.21). Drafts include the quick path and repository names. Non-goals: the dialogs themselves (P11), starting a task beyond the draft contract.

**4. Findings.** The kind registry and after-work defaults already exist on `main`; the point is one source of truth, not a copy. Create the task disabled and start it with an override, so Foreman's autopilot cannot start it between the two calls (L16). Q12 (banner marks and colours) is decided here and recorded in the pull request.

**5. Steps.** Read spec 7.5, 7.6, 7.21. Extract `kindAfterWork` and `pageOptions` into `src/shared/`. Swap `DispatchModal.tsx` to import them. Implement draft create, update, confirm and start. Implement the banner builder with a plain version and the coloured one.

**6. Data and API.** Fill the P1 stubs for options and drafts. Start-now uses the dashboard create path with no runtime override (Focus guard 1). Routes: `POST /dispatch/dispatch-options`, `POST /dispatch/drafts`, `POST /dispatch/drafts/{id}` and `POST /dispatch/drafts/{id}/confirm`.

**7. Tests.** Page contents per kind, draft state transitions, banner text, a dashboard modal regression (unit and the existing e2e still pass), and a Playwright check if the modal's visible behavior changes. The runtime and Focus test (guard 1 of plan 4.2): a task started from a confirmed draft, of a kind whose default runtime is a terminal, gets a terminal pane, and `POST /api/sessions/:id/focus` on it returns what it returns for a dashboard task; it uses the existing fake agent helpers and spends no model tokens.

**8. Merge and exit.** Dashboard dispatch unchanged; daemon options match the dashboard's; tests pass. Guard 1 passes.

**9. Handoff.** P11 renders these pages and drafts; P13 reuses `kindAfterWork` and drafts for `mctl run`. Do not change page shape without a `contract:` commit.

**10. Cross-phase audit.** `src/shared/` files are P5's alone. No overlap with P3 (registration) or P6 (`composeTurnOne`).
