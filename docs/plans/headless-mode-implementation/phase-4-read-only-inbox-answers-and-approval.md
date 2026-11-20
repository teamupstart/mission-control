# Phase 4: Read-only inbox, answers and approval (WP2b)

Source: `plan.md`, `phased-plan.md`. Common rules: `phased-plan.md` section 3. Spec v18.

**1. Outcome.** `GET /dispatch/inbox` returns every item that needs the person, `POST /dispatch/answers` answers them with receipts, and plan and review approvals work with a revision hash.

**2. Entry and dependencies.** Direct prerequisite: P3 (which itself follows P2). The inbox, answers (including its approval actions) and config routes call P3's home-session predicate, so this phase merges only after P3. You may start against the P2 fakes, but rebase on P3 and use the real predicate before merging.

**3. Scope.** `src/server/home-dispatch/inbox.ts`, `reviewers.ts`, `answers.ts`, `approval.ts`, `config.ts`; `src/shared/home-dispatch-inbox.ts` (`workflowStages`, `residentLoopLabel`); the `home-approval:` changes in `loadHumanResolvedReviews` (in `src/server/db.ts`, that one function only, after P1's schema change) and in `src/server/plans/publication.ts`. Inbox items carry `pending`, `run` (with `reviewers` through `reviewerRowsFor`, `agent`, `runtime`), `pr`, `canMessage`, resident requests, the `blocked` state, `needsYouOrder` (age, not type), `pending.revisionHash` and the `subagents` counts (`{running, finished}`). The counts come from `src/server/home-dispatch/subagent-state.ts`, which this phase creates from the session registry's subagent state (`SubagentStart` and `SubagentStop`); if the registry holds none, it adds the smallest in-memory tracking in the daemon's existing hook-event handler, never in `hooks/harness-hook.mjs` (D43). P9 reuses the module. Non-goals: chat and resident actions (P9), the pane (P12). It also fills the registration answer's `counts` from the inbox, replacing P3's zeros.

**4. Findings.** `WORKFLOW_RUN_STATUSES` is in `src/shared/workflow.ts`. `ResidentRunSummary` carries `taskId`, `loopState`, `iteration`, `nextWakeAt`, `pauseReason`. Every approvable item needs a `revisionHash`; every review approval is two presses in the pane and carries it. Worker text must go through the fenced renderer (L15).

**5. Steps.** Read spec 7.7, 7.8, 7.9, 7.24 (answers), 7.25 (reviewer rows). Build the inbox as a pure read. Implement answers and receipts, `chat_first`, plan approval with exact revision, and the config view. Keep the dashboard's decision behavior identical when the flag is off.

**6. Data and API.** Fill the P1 stubs for inbox, answers, approval, config. Receipts follow the P1 table. L17: an absent field and `null` differ; a 2xx with an unreadable receipt was delivered. Routes: `GET /dispatch/inbox?repo=&session=`, `POST /dispatch/answers` (actions `answer`, `approve_plan`, `request_changes`, `approve_review`, `reject_review`, `chat_first`) and `GET /dispatch/config`. Per-task subagent data has one path: `subagents` counts (`{running, finished}`) on each item of the `GET /dispatch/inbox` response (P4's route) and the per-subagent `subagents` lines in the `GET /dispatch/tasks/{taskId}/transcript` response (P9's route). `repo=*` returns every repository's items for a `cli` caller (spec 7.7, for `mctl get tasks --all`).

**7. Tests.** Inbox ordering and counts, blocked state, reviewer rows, answer routing per item type, approval with stale revision refused, no dashboard change, route tests without a browser. Inbox `subagents` counts for a task with recorded `SubagentStart` and `SubagentStop` events. `repo=*` for a `cli` caller and its refusal for a mod caller.

**8. Merge and exit.** Inbox and answers real behind the flag; dashboard unchanged flag-off; tests pass.

**9. Handoff.** P8, P9, P10, P12 rely on the inbox and answer shapes and on `needsYouOrder`; P12 asks this phase's owner for changes to `workflowStages` or `residentLoopLabel`.

**10. Cross-phase audit.** Shapes match P1 and the P2 fake. Resident requests overlap P9 only through the shared inbox item; chat and run actions stay in P9.
