# Phase 11: Mod dispatch flows and the tool (WP14, minimal)

Source: `plan.md` (section 0), `phased-plan.md`. Common rules: `phased-plan.md` section 4. Spec v20 (sha256 `00677497ade4bb65c93457c3443849ac9b350b497b1efa82378d47d55d315ee2`). Branch from `main`; start only after P8 has merged, then `git rebase --onto origin/main <old base>`.

**1. Outcome.** From Claude Code the person can dispatch a task: `/mission-dispatch` (fast path, or a described task, then a confirm), or mid-conversation through the `start_dispatch` tool. `/mission-dispatch inbox`, `check` and `pane` open the Mission Control pane (on Needs you, on Tasks, or as it was). A dismissed dialog counts as Cancel. The launcher on session start is offered only if S10 or S11 passed and was recorded.

**2. Entry.** P5 merged and P8 merged, both required (P5 supplies the options and drafts routes this phase calls; P5 is in review as #1582 and is not on `main` until it merges, and P8 itself waits for it). Gate: S10 or S11, for the launcher part only; without a recorded answer the launcher stays off and the rest merges. S8, S12 and S15 are soft. P7 is deferred, so the confirm summary has no Codex line.

**3. Scope.** `src/mod/flows/command.ts`, `dispatch.ts`, `tool.ts`, `index.ts`: the launcher, fast path, description and confirm dialogs over P5's options and drafts routes, the `start_dispatch` tool, the intent nudge, one registration line each. The `inbox`, `check` and `pane` arguments call P8's `paneOpen` with the tab or task id and nothing else, so they show the placeholder until P12 lands and the real pane after. Non-goals: pane contents and answering (P12), the Codex line (P7).

**4. Findings.** The mod never reorders or rewords daemon options. Home-dispatched tasks pass no runtime override (Focus guard 1). The brief sent to the daemon keeps the person's own words as the task and puts Claude's added context in the separate `context` field (decided by Ife; P5's draft route already carries both fields, but see plan.md 0.4 for the follow-up on how the shaper input is built).

**5. Tests.** Fake-host tests for each flow, each dismissal path, the quick path, the tool, launcher on and off, and each of `inbox`, `check`, `pane` and a task id recording one `paneOpen` with the right target; `claude plugin test` locally.

**6. Exit.** Dispatch works against the fakes: a task exists on the fake daemon after the confirm; the launcher follows the recorded answer; the pane arguments do not error with P8's placeholder in place.

**7. Handoff.** P14's loop proof starts a task through these flows.
