# Phase 1: post-merge retro follow-up lifecycle

Source plan: [`plan.md`](plan.md) · phase index: [`phased-plan.md`](phased-plan.md)

## Outcome and user value

Clicking `Run retro` after the work pull request merges creates one separately tracked retro
task, starts it immediately when resources allow, and leaves the original task complete. If
the human approves memory changes, the retro session opens a new pull request and the new task
completes when that pull request merges. If no change is approved, the new task completes
without a commit or pull request.

Clicking `Run retro` while the work pull request is still open keeps the current behavior: the
same session commits approved memories onto the existing review.

## Entry criteria and dependencies

- The planning pull request containing this directory is merged into the default branch.
- Branch from that merged default branch. Do not build on the planning branch.
- Read `docs/agent-guides/architecture.md`, `docs/agent-guides/change-contracts.md`,
  `docs/repository-memory.md`, `e2e/README.md`, and the current retro and pull-request skills
  before implementation.
- Preserve unrelated worktree changes.

Direct implementation-task dependencies: the current planning session only. There are no
sibling implementation phases.

## Scope

1. Durable source-episode-to-retro-task identity and lookup.
2. Reliable open-versus-merged routing in the retro service.
3. Idempotent follow-up task creation with the source repository set and evidence context.
4. Immediate ordinary dispatch with a visible backlog fallback.
5. A narrow, verified no-change completion operation for retro follow-up sessions.
6. Retro skill and action wording that distinguishes riding an open review from shipping a
   post-merge task.
7. Additive API response arms and one shared dashboard outcome formatter.
8. Unit, migration, bundle, lifecycle, component, and Playwright coverage.
9. Product documentation updates for the new lifecycle.

### Non-goals

- Reopening, reassigning, or re-completing the source feature task.
- Creating a new Mission Control goal.
- Opening a second pull request when the source work pull request is open.
- Automatically merging the retro pull request.
- Letting the daemon edit, commit, push, or merge repository files.
- Replacing the existing dead-session backlog fallback where no durable merged task episode
  can be proven.
- Broadening a no-change operation into arbitrary task completion.

## Repository findings and contracts

### Retro delivery

- `src/server/retro.ts` sends the action to any messageable live session before considering
  the existing dead-session task fallback. Insert the durable pull-request posture decision
  before that live-delivery choice.
- The existing `retroRunner` chooses a harness that can invoke the retro skill. A post-merge
  follow-up also needs the normal pull-request shipping procedure. Resolve all required skills
  before creating the task so the route continues to fail closed.
- The existing dead-session intent is a useful evidence template, but the post-merge intent
  must also name the source task id, source work episode, merged pull request, source branch,
  and the fact that this is a new task whose own review is required.

### Pull request posture and episode identity

- `primaryRepoPrForTask` in `src/server/db.ts` deliberately lets any durable merged episode
  outrank an open pull request on the current episode. That is correct for task completion and
  card outcome, but wrong for retro routing: the current open review must receive the retro.
  Add a sibling durable query owned beside the binding readers. It returns the current episode's
  open pull request first; only when none exists does it return the newest merged binding from
  current or historical episodes. Do not change `primaryRepoPrForTask` or reconstruct posture
  from `Session.prUrl`.
- A source task can have historical episodes. Key the follow-up on `(source_task_id,
  source_episode_id)`, not only `source_task_id`, so a genuinely new work cycle can earn a new
  retro while retries within one cycle remain idempotent.
- Do not bind the retro task to the source pull request. The retro task's own work episode and
  pull-request bindings are the only merge evidence allowed to complete it.

### Task ownership and dispatch

- `TaskManager.create` owns task construction, dependency resolution, launch provisioning
  fields, repository sets, and Registry publication. Add a focused internal producer method or
  option for retro follow-ups rather than writing task rows in `retro.ts`.
- The durable follow-up relation and task row must be created in one daemon-owned transaction,
  or by an equivalent reserved-id recovery protocol that closes the crash window between
  them. A unique source-episode key is the final duplicate defense.
- Create the task in backlog first, then use the ordinary dispatch path. If dispatch cannot
  start, keep the same task available for retry and return its actual status. Do not create a
  replacement on the next click.
- Copy `repoRoot` and every `extraRepos[].repoRoot` from the source task before launch.
- Do not call `assign` on the source session. Assignment resets checkout and conversation
  context and would couple the retro back to the completed task.

### Completion

- Normal approved-change completion stays merge-driven. Existing task reconciliation must see
  only pull requests bound to the retro task's episode.
- A correct no-change retro has no git evidence. Add a purpose-specific MCP tool and daemon
  route that resolve the calling session, verify its task is the retro side of a durable
  relation, and complete that task with an explicit no-change outcome.
- The no-change route must not take an arbitrary task id from the agent. It must derive the
  task from authenticated session context, reject non-retro tasks, leave the source task
  untouched, and avoid satisfying unrelated dependency edges as if a pull request merged.
- Validate MCP arguments in `src/shared/protocol.ts` and `src/mcp/server.ts`, register the tool
  in `MISSION_MCP_TOOLS`, and ensure retro follow-up dispatch requires it. Rebuild before smoke
  because sessions execute `dist/mcp/server.mjs`.

### Shared response and dashboard

- Preserve the published `RetroResponse` arms `delivered` and `dispatched`.
- Append `started` for a launched post-merge retro task and `queued` for an existing/created
  task that remains backlogged. Include the task in both; include a bounded human-readable
  reason in `queued`.
- Put message generation in `src/web/lib/retro-offer.ts` or a sibling shared helper. The Action
  Bar, Complete dialog, and Workflow Ladder must not each interpret the union separately.
- Copy should distinguish `Retro started in a new task` from `Retro queued as a new task` and
  state that the original work remains complete. Preserve current delivered and dead-session
  wording where their behavior is unchanged.
- Do not add `data-testid`. Use roles, accessible names, and existing live regions or alerts.

## Implementation steps

### 1. Add the durable relation

- Extend the fresh database schema with a normalized retro-follow-up table containing the
  source task id, source episode id, source session id when known, retro task id, and timestamps.
- Add unique indexes for the source task/episode pair and retro task id after all referenced
  schema exists. Follow the repository's migration ordering rules.
- Add typed database helpers to read by source episode and by retro task. Keep raw SQLite out of
  `retro.ts` and out of the MCP layer.
- Add an upgrade test from a pre-feature database and a duplicate-key test.

### 2. Add a task-owned idempotent creation seam

- Add a TaskManager operation that receives the source session/task/episode, repository set,
  resolved agent, and complete intent.
- Reserve a retro task id and persist the ordinary named backlog task plus relation atomically,
  following the existing internal-producer collision checks where practical.
- On retry, validate that the existing relation still names a compatible task and return it
  without re-emitting, re-titling, or recreating dependencies.
- Expose enough result state for the retro service to know whether it created, reused, started,
  or left the task queued.

### 3. Route open and merged pull requests differently

- Resolve the source task and current episode before live action delivery. Use the dedicated
  current-open-first retro posture query, not the merged-first completion projection.
- When that query returns the current episode's open pull request, retain the existing skill
  reload check, render, injection lock, provenance recording, and `delivered` response.
- When a durable merged pull request is associated with the source episode, resolve a harness
  that can run the retro and shipping procedures, create or reuse the linked task, then invoke
  ordinary task dispatch.
- Convert a successful launch to `started`. Convert recoverable resource or provisioning
  failures to `queued` only after verifying the same task remains safely retryable. Unexpected
  failures stay errors and must not be mislabeled as queued.
- Preserve the existing unreachable-session fallback when no merged source-task posture is
  established.

### 4. Make the follow-up intent self-sufficient

- Include source session name/id, source task id, source episode id, branch/worktree evidence,
  merged pull request URL, and all repository roots.
- Require the retro skill's proposal and approval ceremony.
- State explicitly that approved commits belong on this task's fresh branches and must be
  shipped through new pull requests, one per changed repository.
- State explicitly that a no-change decision invokes the narrow no-change outcome and creates
  no empty commit or pull request.
- Do not assume the old transcript still exists. Keep the current evidence fallback to pull
  request diff, review conversation, and subsequent fixes, and require honest attribution.

### 5. Add verified no-change settlement

- Define the additive MCP tool name and its minimal input schema. Prefer no caller-supplied task
  identity.
- Register it in the bundled MCP server, route it through loopback HTTP, and add it to Mission
  Control's declared tool vocabulary and retro-follow-up launch requirement.
- In the daemon, derive the calling session and task, verify the retro-follow-up relation, and
  complete only that task with a durable no-change outcome.
- Update the retro skill so dismissal or zero approved proposals invokes this operation only
  when running as a follow-up task. The ordinary same-session retro still writes nothing and
  stops without changing its source task.

### 6. Extend the response and dashboard messaging

- Append the shared response arms and update the client API type without weakening it to an
  unstructured partial.
- Centralize outcome-to-message formatting and use it in `ActionBar.tsx`, `CompleteModal.tsx`,
  and `WorkflowLadder.tsx`.
- Keep the Complete dialog open or close it according to the existing action-result convention,
  but do not mark the source task complete from the retro click. The source task status is
  unchanged on every arm.
- Ensure a queued launch gives the user enough information to find and retry the linked task.

### 7. Update the retro procedure and documentation

- Revise `skills/retro/SKILL.md` and `actions/retro.md` so their branch/PR rules are conditional:
  ride an open source review, ship a new follow-up review after merge.
- Document no-change settlement and the fact that the original task is not reopened.
- Update `docs/repository-memory.md` and the task/dispatch guide that describes multi-repository
  task completion if the new relation changes its explanation.
- Keep project prose free of machine-local paths and implementation artifacts.

## Data, API, migration, and compatibility details

- New table creation must be safe on existing databases. If it references new columns or
  indexes, create those only after their owning migrations.
- Persisted task statuses, task kinds, work-episode identifiers, and existing MCP tool names are
  unchanged.
- `RetroResponse` is additive. Older clients continue to understand existing routes; the
  in-repository client exhaustively handles all new arms.
- Source task completion remains untouched. The follow-up task has its own work episode and
  normal merge quorum.
- Multi-repository follow-ups copy repository identity only. They do not copy source task
  branches, leases, worktrees, or pull-request bindings.
- Repeated clicks and route retries converge on one relation and one task before dispatch.
- The no-change operation is an explicit terminal outcome, not merge evidence, and does not
  mutate the source relation after completion.

## Test strategy

### Focused unit and contract coverage

- `test/retro-dispatch.test.ts`: open session delivery remains unchanged; merged task creates
  and immediately dispatches a linked task; recoverable dispatch refusal queues it; duplicate
  click reuses it; dead-session fallback remains compatible; required skills fail closed.
- `test/retro-http.test.ts`: response status and each discriminated response arm, source task
  preservation, authenticated no-change route, and error mapping.
- Database migration tests: fresh and upgraded schema, uniqueness, lookup by both sides, and
  transaction/recovery behavior.
- Task lifecycle tests: source task remains done, old source merge cannot settle the retro
  task, retro pull-request merge completes only the retro task, and no-change completes only
  the retro task.
- Multi-repository tests: repository set is copied without old provisioning or pull-request
  state and completion still requires every changed repository's retro pull request.
- MCP tests: shared/bundled schemas agree, the tool is registered and pre-authorizable, a
  non-retro caller is refused, and bundle smoke resolves the built tool.
- UI tests: exhaustive outcome formatter and existing component render suites cover delivered,
  legacy dispatched, started, and queued copy.

### Browser regression

Extend `e2e/specs/retro-offer.spec.ts` or add a focused sibling spec that:

1. Enables all required skills before dispatch.
2. Uses the fake agent and local daemon only.
3. Creates a source task/session, records a pull request through the existing fake hook, and
   marks it merged through a public daemon seam or the established fixture mechanism.
4. Clicks the visible `Run retro` control.
5. Observes the new task/session or queued message and confirms the source task remains done.
6. Repeats the click and proves no duplicate follow-up appears.
7. Covers the no-change completion route in backend tests; only add a browser no-change branch
   if it materially exercises user-visible behavior beyond the route contract.

Do not contact GitHub, launch a real agent, spend model tokens, add `data-testid`, or seed
in-memory Registry state by writing SQLite behind the daemon.

## Merge and exit criteria

- All approved lifecycle decisions are implemented and documented.
- One post-merge click creates at most one linked retro task; duplicate clicks reuse it.
- The source task remains done throughout.
- Approved memory commits open a new pull request from the retro task's branch, and only that
  pull request can complete the retro task.
- A no-change retro completes the retro task without a commit or pull request.
- Open source pull requests still receive retro commits on their existing branch and review.
- Immediate dispatch failure leaves one honest, retryable backlog task.
- Multi-repository behavior follows one pull request per changed repository.
- Focused tests pass, then `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`,
  `npm run smoke`, and `npm run test:e2e` pass.
- The implementation pull request documents deviations from this proposed route and explains
  why the repository required them.

## Downstream handoff

There is no downstream phase. The implementation pull request is the complete product slice.
After it merges, validate one real operator flow for an open work pull request and one for a
merged work pull request. Any new operational lesson belongs in repository memory only through
the normal retro approval procedure.

## Cross-phase audit

- This phase owns every source-plan requirement and every approved human decision.
- It introduces no contract another phase must finish.
- Its database, shared wire, server, MCP, skill, UI, documentation, and browser changes land
  together, so the merged repository is internally consistent.
- Inspector review corrected one repository assumption: the retro route owns a
  current-open-first binding query and must not reuse the merged-first task completion query.
- The scheduled task must treat this phase file as a proposed route, not a specification. Use
  engineering judgment against the current repository and record material deviations in the
  pull request.
