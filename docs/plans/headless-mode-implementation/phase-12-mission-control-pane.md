# Phase 12: The Mission Control pane (WP17)

Source: `plan.md`, `phased-plan.md`. Common rules: `phased-plan.md` section 3. Spec v18, 7.9, 7.22 to 7.25.

**1. Outcome.** One pane in Claude Code with four tabs (Needs you, Tasks, Workflows, Residents) where every decision is answered and workers and residents are chatted with, with no tmux or herdr involved. Branches: chat uses the direct send or the `chat_first` path as S16 recorded; if S21 shows the Esc-reopen pattern keeps the keyboard, Esc returns to the list, otherwise Esc hands the keyboard back and only Back returns; if S22 shows the pane draws in the desktop app and VS Code it opens there, otherwise `/mission-dispatch pane` says the pane is terminal only; if S23 shows the polls too costly, chat polls every 3 s and the Tasks tab is capped at 30 rows, otherwise 1.5 s and the full list.

**2. Entry and dependencies.** Direct prerequisites: P8 (mod core, `Pane` and `ui.close` seams) and P9 (residents and chat routes). Gate: S16 and its fallback recorded in Commonroom; quote it and stop if absent. Soft spikes S21, S22, S23 with their documented fallbacks. S16 is a merge gate. A merge gate is satisfied only by the owner's answer posted to Commonroom: read it, quote it in the pull request, and stop without merging if none exists. Soft spikes never block a merge: when no answer is recorded the phase uses the fallback in plan 5.1 and its pull request says which answers it used or that none was recorded.

**3. Scope.** `src/mod/pane/*`, `src/mod/pane.test.tsx`, `test/home-dispatch-mod-pane.test.ts`, `test/home-dispatch-mod-chat.test.ts`: opening and placement (dock and inline; the widget placement is v1.1, so a reported `widget` draws the inline view), the four tabs, item views, two-press `Approve rev {hash}`, Write an answer, Esc and Back, the chat and follow view with its chat poll (1.5 s by default, 3 s under the S23 fallback), the Residents tab and actions, reviewer rows and the harness mark (read from the inbox `run.reviewers` and `run.agent` that P4 supplies), and two reserved subagent slots: the Tasks row text (reads the inbox item's `subagents` counts) and the follow view's header lines (reads `subagents` in the `GET /dispatch/tasks/{taskId}/transcript` response), both in `src/mod/pane/header.tsx`. Both render nothing while their field is absent or empty, and P15 fills them. Non-goals: dialogs (P11), new routes.

**4. Findings.** The pane opens only when asked (D52); no Alt hotkey (L32). `holdToasts` is never set (D53). Docked placement needs room; inline is the fallback (L33). Esc is refused with `ui.close`, then the pane is reopened with `focus` after 150 ms (L36, unguaranteed; S21). Buttons fire only while the pane holds the keyboard and no input has focus (L35). Chat polls one view at a time. Every row is cut to `bodyColumns`.

**5. Steps.** Read spec 7.22 to 7.25 and F19. Implement each tab and view as pure functions of state and placement, then the open, close and focus handling, then answers, approvals and chat through the P4 and P9 routes. Apply the shared renderer for worker text.

**6. Data and API.** Only `/dispatch/*` calls; never another `/api/*` route.

**7. Tests.** Every tab for dock and inline at 40, 71 and 120 columns; the inline five-row cap and fold; hotkey scope with a focused field; two-press approval and each way it disarms; Esc in each view; Back; opening routes; no `holdToasts`; flag off closes the pane; a reported `widget` placement draws the inline view. Run `claude plugin test` locally and attach output (Q17). Playwright cannot drive the pane. The chat poll interval is 1.5 s by default and 3 s under the S23 fallback, and the Tasks tab cap of 30 rows applies only under that fallback; the inbox poll stays at 5 s in both.

**8. Merge and exit.** All tabs and chat work against the fakes; S16 answer quoted. Tests cover both branches of each of S16, S21, S22 and S23.

**9. Handoff.** P15 fills the two reserved subagent slots (the only pane edit it makes, and P12's header tests keep passing with the slots empty); P17 documents keys. This phase replaces P8's placeholder view behind the existing `paneOpen` calls.

**10. Cross-phase audit.** P4 owns `workflowStages` and `residentLoopLabel`; this phase only reads them. P11 calls P8's `paneOpen`; this phase replaces P8's placeholder view behind that same call and adds no new entry point.
