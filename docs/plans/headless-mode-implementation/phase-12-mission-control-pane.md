# Phase 12: The Mission Control pane (WP17, cut to two tabs)

Source: `plan.md` (section 0), `phased-plan.md`. Common rules: `phased-plan.md` section 4. Spec v21 (sha256 `1fd49cff22923784a63151d622d0bcc3b83729f912dce2b6530d059821f661c3`). Design: the round 2 artifact (`2dJEKTxXd9Hzi9zDgDayZo`), R1 and D, with its spike review. Branch from `main`; start only after P8 has merged, then `git rebase --onto origin/main <old base>`.

**1. Outcome.** The pane P8 opens at launch shows the person's tasks. Two tabs, `n Needs you` first and `t Tasks`. Needs you lists waiting and blocked items with the question or plan, and the person answers an option, writes an answer, approves a plan or requests changes right there, and sees a receipt. Tasks lists running, ready and queued tasks with state glyphs, age, the workflow stage line from P4's `workflowStages`, the `shaping` marker when present, and a ready task's result (PR link or summary). It docks on the right at 110 columns or more and draws inline above the prompt below that, and each form is tested.

**2. Entry.** P8 merged (the real `paneOpen` and its placeholder). P4's routes are on `main`: `GET /dispatch/inbox` and `POST /dispatch/answers` (`answer`, `approve_plan`, `request_changes`). No hard gate. S21 and S22 are soft. P9 is deferred, so there is no chat and no follow.

**3. Scope.** `src/mod/pane/index.ts`, `needs-you.ts`, `tasks.ts`, `types.ts` and the reduced header; the render hook on `Pane` that branches on `placement` (dock or inline) and sizes to the body columns; the selected tab kept in state. Replaces P8's placeholder view and changes no `paneOpen` signature. Rules from the review: the inbox is the first tab and there is no second overlay pane; plan approval is a focused button confirmed with Enter, labelled with the revision, and a stale revision is refused and shown as such; answer buttons sit above any text field and take focus first; a visible Back button beside Esc (Esc closes via `ui.close` handling, with a refocus fallback); review decisions (`approve_review`, `reject_review`) are shown read-only with a pointer to the dashboard. Non-goals: Workflows and Residents tabs, chat, follow, subagent lines, new routes.

**4. Findings.** The pane reads only the inbox. The inbox lists the repository's home-dispatched tasks (see plan.md 0.4 (c)). Worker text is shown as plain text, never executed. Hotkeys fire only while the pane holds the keyboard.

**5. Tests.** Fake-host `node:test` files: both tabs render from a seeded inbox at 160 columns docked and 100 inline; tab switching by key; answering, writing an answer, approving with a matching revision, a stale revision refused, request changes; review items read-only; Esc and Back send nothing; empty inbox state; flag off draws nothing. `claude plugin test` locally, output attached to the pull request.

**6. Exit.** Against the fake daemon an item leaves Needs you after the answer and the receipt shows; Tasks rows update on the next poll.

**7. Handoff.** P14's loop proof reads and answers through this pane. Later iterations add the Workflows and Residents tabs and chat on the same render hook.
