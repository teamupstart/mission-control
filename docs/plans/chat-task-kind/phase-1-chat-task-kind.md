# Phase 1: The `chat` task kind from dispatch through completion

Source plan: [`plan.md`](./plan.md), rendered at [`plan.html`](./plan.html).
Index: [`phased-plan.md`](./phased-plan.md), rendered at
[`phased-plan.html`](./phased-plan.html).

## 1. Outcome and value

Mission Control offers **chat** as a fourth durable Kind when a person opens one immediate
single-agent session. The opener starts a normal isolated session, but the task promises no
change, report, or plan. It defaults to **After work: None**, remains open across conversational
idle, and ends when the human chooses **Complete & close**.

The same merge makes chat safe everywhere it is not offered. It cannot enter the backlog through
dependencies, direct HTTP, edits, schedules, sources, ensembles, MCP task creation, rescheduling,
or autopilot. A user who deliberately selects a Workflow after choosing chat opts into the
ordinary completion behavior; otherwise Foreman never offers shipping actions for that chat.

## 2. Entry criteria and direct phase dependencies

**Direct dependency: the planning pull request.** This task starts only after
`docs/plans/chat-task-kind/plan.md`, `phased-plan.md`, and this phase document resolve on the
default branch.

Entry criteria:

- Re-read the source plan and its incorporated decisions before editing.
- Re-check `TASK_KINDS`, every exhaustive `Record<TaskKind, ...>`, `DispatchSchema`,
  `TaskManager.create/update/dispatch/reschedule`, and all `automaticWrapupBlock` call sites in
  the current tree. Line numbers in this document describe the planning checkout, not an API.
- Preserve unrelated worktree changes and follow the test isolation command in `AGENTS.md`.

## 3. Scope and explicit non-goals

In scope:

- The append-only task-kind vocabulary, human copy, behavioral registries, mnemonic, badges, and
  persistence coverage.
- One shared policy for whether a Kind may enter the backlog, applied by schemas, editors, modal
  choices, and durable task-service boundaries.
- Fresh compact and guided Dispatch behavior: required opener, chat-specific prompt copy,
  reversible None default, reversible dependency clearing, and immediate launch only.
- Foreman's prompted and queue-drain behavior for human-ended chat, with explicit Workflow opt-in.
- Documentation, focused server and UI tests, and a Playwright spec using fake agents.

Explicit non-goals:

- No chat transcript archive, Library entry, export format, or new database table.
- No chat-specific prompt appendix, skill, Mission MCP tool, persona, Workflow, or runtime.
- No live conversion of a running task to or from chat.
- No chat option in backlog editing, Recurring Missions, task sources, ensembles, MCP
  `create_task`, dependencies, rescheduling, assignment, or Foreman backlog planning.
- No change to ordinary sessions that are not linked to a Mission Control task.
- No automatic publishing of files changed during a chat.

## 4. Repository findings and inherited contracts

Verified against the planning checkout. Re-check before editing.

- `src/shared/types.ts` defines `TASK_KINDS = ["ship", "scout", "plan"]` and derives
  `DEFAULT_TASK_KIND` from index 0. The tuple is append-only and feeds persisted reads plus wire
  schemas; append chat and never move ship.
- `src/shared/task.ts` owns `TASK_KIND_INFO` and `KIND_PRODUCES_A_DIFF`.
  `src/web/lib/guided-dispatch-steps.ts` owns `GUIDED_KIND_KEYS`. The server owns exhaustive
  registries in `task-contract.ts`, `mission-mcp.ts`, `archives/task-gateway.ts`, and
  `foreman/wrapup-eligibility.ts`. The compiler is expected to identify every missing chat answer.
- `src/shared/protocol.ts` uses the global tuple for both `DispatchSchema` and schedule template
  Kind. `src/shared/task-source.ts` does the same for source defaults. These two automated schemas
  need the backlog-eligibility refinement after the tuple grows.
- `src/web/components/DispatchModal.tsx` is both the fresh dispatcher and backlog editor.
  `launchMode === "ensemble"` shares the same crew fields. Its primary action changes an unmet
  dependency into `backlog: true`, so chat must clear dependencies before submit and the server
  must reject any that arrive anyway.
- `afterWorkForKind` already preserves a Workflow across diffless-kind switches with a ref. Add a
  separate dependency stash rather than overloading that ref; Workflow and scheduling are
  independent operator decisions and must restore independently.
- `TaskManager.create` is the durable convergence point for HTTP dispatch, schedules, task-source
  ingest, MCP-created tasks, and ensemble member creation. `update` can change the Kind of a
  backlog row. `dispatch`, `assign`, and `reschedule` are later defenses for old or malformed rows.
- `automaticWrapupBlock` is called in `queue-machine.ts`, `prompted-wrapup.ts`, and twice in
  `worker.ts`. It currently receives task kind but not Workflow identity. `Session.task` already
  carries `workflowId`, so no database or session-view expansion is needed.
- `prompted-wrapup.ts` retires an empty diff before the later review-artifact call. Tests must use a
  changed-file chat case as well as an empty conversation, or they can pass without exercising the
  new policy.
- `CompleteModal.tsx` and the existing task-completion route already implement the required manual
  exit. Do not add a parallel chat completion endpoint.
- `KIND_CONTRACT`, `KIND_MISSION_MCP_TOOLS`, and `CAPTURE_KIND` already express absence as `null`
  or an empty set. Chat follows those existing no-extra-behavior paths.

Inherited contracts:

- Ship remains the universal default and unknown persisted values degrade to ship.
- Kind is provisioning intent and cannot change after dispatch.
- `intent` is non-empty durable task text and turn one for terminal, embedded, and Pi delivery.
- UI behavior changes require a Playwright spec in `e2e/`, selected by role, label, or placeholder,
  with no `data-testid` and no real agent tokens.
- Foreman question triage is independent from completion eligibility and must keep working.

## 5. Implementation steps, in execution order

1. **Append the durable value.** Add `chat` after `plan` in `TASK_KINDS` and update comments that
   still describe three kinds. Keep `DEFAULT_TASK_KIND` derived from index 0 and the database read
   fallback unchanged.
2. **Define the shared lifecycle capability.** In the shared task policy module, add one exhaustive
   answer or predicate such as `taskKindAllowsBacklog(kind)`. Ship, scout, and plan return true;
   chat returns false. Derive picker/schema filtering from that predicate rather than spelling a
   second tuple of existing ids. Add an exhaustive matrix test so a future kind must answer.
3. **Complete every kind registry.** Add chat copy to `TASK_KIND_INFO`, set reviewable diff false,
   assign guided key `c`, and map chat to no task-contract appendix, no Mission MCP requirements,
   and no archive capture. Extend the Foreman classifier registry without weakening the ordinary
   safeguards used when chat has an explicit Workflow.
4. **Constrain automated definitions early.** Refine schedule templates and task-source defaults
   with the backlog capability; update their defensive persisted reads as needed. Filter
   `ScheduleEditor` and `TaskSourcesPanel` through the same predicate. Add protocol and render tests
   proving chat is omitted and a handcrafted chat value is refused rather than normalized to ship.
5. **Enforce the durable creation invariant.** At the HTTP and `TaskManager` seams, reject chat
   with `backlog: true`, any dependency, any internal/backlog producer, or a backlog update that
   would make the resulting Kind chat. Defend later backlog-only operations so an old or malformed
   chat row cannot be dispatched, assigned, or rescheduled through an unattended path. Return an
   operator-readable conflict that says chat must be launched immediately from Dispatch.
6. **Scope the Dispatch choice.** Offer chat only for `mode.kind === "new"` plus single launch.
   Backlog edit and ensemble mode derive their choices from backlog-compatible kinds. Guided
   choices use the same list as the visible select, so the `c` shortcut cannot select chat in a
   mode whose form cannot launch it.
7. **Make chat immediately dispatchable and reversible.** When entering chat, use the existing
   `afterWorkForKind` behavior to stash Workflow and select None. Separately stash and clear
   dependencies, hide the dependency picker and **Add to backlog**, and keep the primary action as
   **Dispatch now**. Restore the exact dependency list when returning to a backlog-compatible kind.
   Clear the dependency stash when the operator edits dependencies after restoration or the modal
   closes, matching the Workflow stash's one-uninterrupted-edit lifetime.
8. **Use conversational opener copy without changing delivery.** Keep `intent` required. For chat,
   label or placeholder the field **What would you like to talk about?**; retain the existing
   task-oriented copy for other kinds and edit mode. Do not inject a greeting or append a chat
   contract. The opener must still derive an untitled task name and travel through the normal
   dispatcher path.
9. **Add the human-ended completion policy.** Extend `AutomaticWrapupInput` with the linked task's
   `workflowId` and add a structured `chat` block when `taskKind === "chat"` and the Workflow is
   null. Pass the field at all four call sites. In queue drain, produce the existing
   `skip-wrapup` retirement only after settled idle; in prompted completion, retire the episode
   before verifier or Workflow claim. A non-null Workflow bypasses only this chat block and then
   follows all existing completion eligibility and evidence rules.
10. **Preserve conversation and manual exit semantics.** Confirm chat retirement leaves the task
    running and session live, later human messages establish later episode keys, needs-input triage
    still operates, and **Complete & close** marks done then closes through the existing route.
    Kill and failed-launch behavior remain ordinary unfinished-task behavior.
11. **Finish visible presentation.** Add a distinct `.bl-kind-chat` color beside the existing kind
    styles and rely on the shared non-default pill predicate for backlog, card, and console labels.
    Update any two/three-kind copy and accessible hints touched by the new choice.
12. **Update product documentation.** Amend `README.md`, `docs/dispatch-and-backlog.md`, and
    `docs/foreman.md`; touch `docs/ensembles.md` or UI docs only where they currently claim every
    Kind is supported. State the opener, manual-immediate limit, explicit Workflow exception,
    human-ended completion, no archive, and no automatic shipping.
13. **Add focused and browser coverage.** Prefer extending the existing task-kind, dispatch,
    schedule, source, queue, prompted-wrapup, and plan/scout UI suites over parallel fixtures. Add
    one `e2e/specs/chat-kind.spec.ts` when combining the end-to-end behavior would make an existing
    spec responsible for a different product contract.

## 6. Data, API, and compatibility

- **Persistence:** no SQLite migration. `tasks.kind` is unconstrained text and the reader already
  validates through `TASK_KINDS`. A chat row round-trips in this build; an unknown value still
  falls back to ship.
- **Dispatch API:** the existing request shape remains. `kind: "chat"` is valid only with
  `backlog: false` and an empty dependency list. Keep the existing non-empty `intent` rule and
  explicit-null Workflow semantics.
- **Automated schemas:** schedule templates and task-source defaults accept only kinds for which
  the shared backlog predicate is true. Their editors and server validation must agree.
- **Task service:** creation validates the resolved outcome, not just the caller's `backlog` bit,
  because unmet dependencies can force backlog. Update and recovery defenses refuse chat in a
  backlog-only lifecycle without deleting the row.
- **Foreman API:** `AutomaticWrapupInput` gains `workflowId: string | null`. This is process-local
  policy input, not a wire or database change. Every caller supplies the task summary value or
  null when no task is linked.
- **Downgrade:** older builds read chat as ship through the existing fallback. That preserves the
  row but not chat semantics, so release notes and docs should not promise semantic downgrade.
- **Existing behavior:** ship, scout, and plan remain backlog-compatible; their prompts, Workflow
  defaults, completion safeguards, schedules, sources, and archive behavior must be unchanged.

## 7. Tests and verification

Focused shared and server coverage:

- `test/task-kinds.test.ts`: exact tuple order, ship default, exhaustive copy and backlog
  capability, no hand-written substitute tuple, prompt/MCP/archive decisions, and distinct labels.
- `test/task-kind-persistence.test.ts`: chat write/read round trip plus the unchanged unknown-value
  fallback.
- `test/guided-dispatch-steps.test.ts`: `c` is unique and appears only when chat is available in
  the current launch mode.
- `test/backlog-edit-render.test.ts`, `test/dispatch-details-fold.test.ts`, and schedule/source UI
  render tests: fresh Dispatch offers chat; backlog edit, ensemble, Recurring Mission, and task
  source controls do not.
- Protocol and HTTP/task tests: immediate chat succeeds; backlog, dependency, backlog edit,
  schedule, source, internal creation, dispatch, assign, and reschedule variants fail closed with
  the expected status and no task/session side effects.
- `test/foreman-wrapup-eligibility.test.ts`: chat with null Workflow always returns the chat block,
  even with source-file changes and skip settings off; explicit Workflow returns to the existing
  kind/objective classifier behavior.
- `test/queue-machine.test.ts` and `test/queue-apply.test.ts`: settled chat drain retires once and
  leaves task/session live; pre-settle and later-message cases do not consume the next episode.
- `test/prompted-wrapup.test.ts` and worker coverage: a changed-file chat with no Workflow retires
  before verification and shipping; explicit Workflow can reach ordinary verification.
- `test/dispatcher-runtime.test.ts`, Pi harness coverage, task-contract, mission-MCP, and archive
  gateway tests: the opener is delivered unchanged in all runtimes and chat contributes no extra
  contract, tool, or capture.
- `test/task-pill.test.ts` and styles/render coverage: chat is visible as a non-default Kind with a
  distinguishable badge.

Playwright coverage in `e2e/specs/chat-kind.spec.ts`:

- Select chat in compact Dispatch and in the guided pass with `c`.
- Assert conversational opener copy, required input, **After work: None**, hidden dependency and
  backlog controls, and **Dispatch now**.
- Prove Workflow and dependency values restore exactly after a chat detour, while a Workflow
  selected after chat remains selected.
- Launch through a fake agent, observe the chat badge, wait through settled idle without a
  **Ship it** or Straight-to-PR surface, send a later conversational message, and finish with
  **Complete & close**.
- Visit Recurring Mission, task-source, backlog edit, and ensemble controls and assert chat is not
  an offered Kind. Use role, label, and placeholder locators only.

Commands, beginning with the most focused affected files:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/task-kinds.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/task-kind-persistence.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/foreman-wrapup-eligibility.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/queue-machine.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/prompted-wrapup.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/dispatcher-runtime.test.ts
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npm run test:e2e
```

Runtime evidence must use the built dashboard and fake agents. Do not commit screenshots or
transcripts; attach them to the implementation pull request if the review workflow asks for them.

## 8. Merge and exit criteria

- The four-kind tuple and every exhaustive registry compile, with ship still index 0.
- A fresh, single-session chat with a non-empty opener dispatches immediately and persists as
  chat; no supported or direct server path can put chat in the backlog.
- Compact and guided Dispatch agree on availability, `c`, copy, reversible Workflow and
  dependencies, and the absence of backlog controls.
- Normal chat idle never claims a Workflow, invokes a verifier, offers shipping, or completes the
  task. Needs-input triage and later conversation turns still work.
- A Workflow selected after chat opts into the ordinary completion path and does not bypass its
  existing safety checks.
- **Complete & close** records completion and closes the session through the existing mechanism.
- Schedule, source, ensemble, MCP, archive, and backlog behavior for existing kinds is unchanged.
- Required focused tests, full unit suite, typecheck, lint, build, smoke, and Playwright all pass.
- Product documentation matches the shipped behavior and the pull request carries its runtime
  evidence without committing evidence artifacts.

## 9. Downstream handoff

This is the only implementation phase. Future work may rely on:

- **C-K1:** `TASK_KINDS` includes chat after plan; ship remains the default and fallback.
- **C-K2:** one shared backlog-eligibility predicate is the source of truth for whether a kind may
  be scheduled, sourced, edited in backlog, or produced internally.
- **C-K3:** chat contributes no prompt appendix, Mission MCP requirement, archive capture, or
  reviewable-diff expectation.
- **C-D1:** fresh single-session Dispatch is chat's only creation surface and `intent` is its
  required opener.
- **C-D2:** chat defaults Workflow to None and clears dependencies reversibly; an explicit Workflow
  is the sole opt-in to inferred completion.
- **C-F1:** both Foreman completion entry paths use the same chat plus Workflow policy.
- **C-U1:** manual task completion is chat's ordinary exit and no transcript artifact exists.

Future changes must not:

- add chat to a backlog-producing surface by filtering locally around C-K2;
- infer a chat finish from idle without an explicit Workflow;
- append a generic chat prompt that changes the human's opener;
- treat changed files as authorization to publish them; or
- reuse chat as the identity for untracked operator-started sessions.

## 10. Cross-phase audit record

- **Against the source plan:** every outcome, incorporated decision, compatibility note, risk, and
  non-goal has an owning implementation step or an explicit prohibition above. No product choice
  remains open.
- **Against the phase index:** this file establishes C-K1 through C-U1 exactly once. No other phase
  consumes or mutates them because there is no other implementation phase.
- **Creation audit:** direct dispatch, dependency-induced backlog, explicit backlog, update,
  schedule, source, ensemble, MCP, assignment, reschedule, and autopilot paths were traced. They
  converge on C-K2 or are already fixed to ship. The phase keeps both early schema/UI feedback and
  final task-service enforcement.
- **Completion audit:** queue machine, prompted completion, and both worker evidence checks were
  traced to `automaticWrapupBlock`. All receive Workflow identity; no parallel chat-only Foreman
  branch is introduced.
- **Explicit Workflow reconciliation:** the source plan says ordinary completion may run. This
  phase interprets that narrowly: bypass the human-ended chat block only, then retain every normal
  review-artifact, evidence, and Workflow rule. This avoids making chat a shipping loophole.
- **Dependency-state reconciliation:** the source plan required incompatible draft state to clear
  and restore. Repository inspection showed dependencies, not just the backlog button, can silently
  change an immediate launch into scheduling. Step 7 records the needed separate reversible stash.
- **Negative audit:** no database, protocol field, runtime, archive format, completion endpoint, or
  new MCP tool is required. Each existing mechanism already carries the necessary kind, Workflow,
  opener, or manual completion data.
- **Merge-safety result:** a split was reconsidered after the consumer audit and rejected. No
  ordering of separate vocabulary/UI and completion/service pull requests leaves both an operable
  repository and a safe supported feature, so the single vertical phase is intentional.
