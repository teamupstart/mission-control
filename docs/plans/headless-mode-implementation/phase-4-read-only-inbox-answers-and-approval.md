# Phase 4: Read-only inbox, answers and approval (WP2b)

Source: `plan.md`, `phased-plan.md`. Common rules: `phased-plan.md` section 3. Spec v18.

**1. Outcome.** `GET /dispatch/inbox` returns every item that needs the person, `POST /dispatch/answers` answers them with receipts, and plan and review approvals work with a revision hash.

**2. Entry and dependencies.** Direct prerequisite: P2. It consumes P3's home-session predicate when that lands; build against the P2 fakes until then.

**3. Scope.** `src/server/home-dispatch/inbox.ts`, `reviewers.ts`, `answers.ts`, `approval.ts`, `config.ts`; `src/shared/home-dispatch-inbox.ts` (`workflowStages`, `residentLoopLabel`); the `home-approval:` changes in `loadHumanResolvedReviews` and plan publication. Inbox items carry `pending`, `run` (with `reviewers` through `reviewerRowsFor`, `agent`, `runtime`), `pr`, `canMessage`, resident requests, the `blocked` state, `needsYouOrder` (age, not type) and `revisionHash`. Non-goals: chat and resident actions (P9), the pane (P12).

**4. Findings.** `WORKFLOW_RUN_STATUSES` is in `src/shared/workflow.ts`. `ResidentRunSummary` carries `taskId`, `loopState`, `iteration`, `nextWakeAt`, `pauseReason`. Every approvable item needs a `revisionHash`; every review approval is two presses in the pane and carries it. Worker text must go through the fenced renderer (L15).

**5. Steps.** Read spec 7.7, 7.8, 7.9, 7.24 (answers), 7.25 (reviewer rows). Build the inbox as a pure read. Implement answers and receipts, `chat_first`, plan approval with exact revision, and the config view. Keep the dashboard's decision behavior identical when the flag is off.

**6. Data and API.** Fill the P1 stubs for inbox, answers, approval, config. Receipts follow the P1 table. L17: an absent field and `null` differ; a 2xx with an unreadable receipt was delivered.

**7. Tests.** Inbox ordering and counts, blocked state, reviewer rows, answer routing per item type, approval with stale revision refused, no dashboard change, route tests without a browser.

**8. Merge and exit.** Inbox and answers real behind the flag; dashboard unchanged flag-off; tests pass.

**9. Handoff.** P8, P9, P10, P12 rely on the inbox and answer shapes and on `needsYouOrder`; P12 asks this phase's owner for changes to `workflowStages` or `residentLoopLabel`.

**10. Cross-phase audit.** Shapes match P1 and the P2 fake. Resident requests overlap P9 only through the shared inbox item; chat and run actions stay in P9.
