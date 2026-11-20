# Phase 11b: Mod answer and approve dialogs (new; replaces the pane for the loop)

Source: `plan.md` (section 0), `phased-plan.md`. Common rules: `phased-plan.md` section 4. Spec v20 (sha256 `00677497ade4bb65c93457c3443849ac9b350b497b1efa82378d47d55d315ee2`). Branch from `main`; start only after P8 has merged, then `git rebase --onto origin/main <old base>`.

**1. Outcome.** When the glance layer says something needs the person, they open it from Claude (the band's `1` button, or `/mission-dispatch inbox`) and get a dialog: the items that need them, then one item with its question or plan. They can answer a worker's question, approve a plan, or request changes, and a receipt confirms it. `/mission-dispatch check <task>` shows a task's state and, when finished, its result summary. No dashboard needed.

**2. Entry.** P8 merged. P4's routes (`GET /dispatch/inbox`, `POST /dispatch/answers` with `answer`, `approve_plan`, `request_changes`) are on `main`. No gate.

**3. Scope.** `src/mod/flows/needs-you.ts`, `answer.ts`, `check.ts` and one registration line each. Uses the inbox order the daemon returns and never re-orders. Plan approval sends the revision hash P4 returns, so a stale plan is refused and shown as such. A review decision (`approve_review`, `reject_review`) is shown read-only with a pointer to the dashboard; answering it from the mod is deferred. Non-goals: chat and follow (P9), residents, the pane (P12), `mctl`.

**4. Findings.** Answers carry the receipt shape from P4. A dismissed dialog answers nothing. Worker text is shown as plain text, never executed.

**5. Tests.** Fake-host tests: list order, answering, approving with a matching revision, a stale revision refused, request changes, review items read-only, dismissal sends nothing, `check` on a running and a finished task; `claude plugin test` locally.

**6. Exit.** Against the fake daemon an item leaves the inbox after the answer and the receipt is shown.

**7. Handoff.** P14's loop proof answers through these dialogs.
