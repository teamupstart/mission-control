# Phased plan: Cross-repository task spawning

Status: Approved implementation decomposition on 2026-08-24

Source plan: [`plan.md`](plan.md) (rendered: [`plan.html`](plan.html))

Rendered index: [`phased-plan.html`](phased-plan.html)

## Approved goal

An agent working in repository A can use Mission MCP `create_task` to create a backlog task whose
primary repository is B, or whose repository set spans A and B. Mission Control validates local
repository identity and existing harness capability, while Git and the repository host retain
authority over the eventual push and pull request.

Omitting repository selectors remains exactly the current-repository behavior.

## Human decisions incorporated as requirements

The choices submitted in the root-plan review are requirements, not open questions:

| Decision | Approved behavior | Owner |
|---|---|---|
| Foreman policy | Keep the all-target-repositories allowlist for unattended launch. Creation and manual dispatch need no new MC repository grant. | Phase 1 documentation and regression coverage; no Foreman implementation change |
| MCP repository scope | Expose an optional alternate primary and optional attached repositories. | Phase 1 |
| Delivery | Publish a repository-verified phased plan and schedule its implementation behind the planning-session merge. | This index and Phase 1 task |

## What the repository investigation established

1. **The durable model is already complete.** `TaskManager.create` accepts canonical `repoRoot` and
   `extraRepoRoots`; `task_repos`, dispatcher provisioning, per-repository pull requests, and task
   completion already handle the full set. No schema migration or new task type is required.
2. **The restriction is at the MCP edge.** `src/mcp/server.ts` publishes no selector and sends
   `process.cwd()` as the requested root. `POST /mcp/tasks` resolves only that single path.
3. **Canonicalization already has one owner.** `resolveTaskRepoSet` resolves linked worktrees to
   owners and refuses primary/secondary collisions and duplicates. The new short-name layer must
   select an address, then delegate identity to that existing function.
4. **Harness choice must be resolved before storage.** The dashboard route resolves the effective
   agent and checks `multiRepoDispatch`; `TaskManager.create` resolves the agent but assumes its
   repository inputs were already validated. MCP and dashboard creation must share this preparation
   instead of maintaining two policy blocks.
5. **The existing Board already renders the result.** Backlog cards count attached repositories and
   Report rows name them. This feature needs browser proof of the new route-to-card consequence but
   no new React component or control.
6. **Foreman is a later, separate boundary.** `taskReposAllowlisted` is consulted by the backlog
   machine after task creation. The approved decision leaves that code unchanged.
7. **The initial mixed-version assumption was wrong.** `McpCreateTaskSchema` is not strict, so an
   older daemon strips unknown selector fields instead of refusing them. Selector-bearing calls need
   a capability preflight before creation. Otherwise an attached repository could be silently lost.
8. **The phased-plan procedure is the user-facing consumer.** Its current manual-stop branch is the
   procedural bottleneck. Once this phase lands it must supply explicit target and attachment fields,
   keep `dependsOnCurrentSession: true`, and stop safely on any refusal.

## Sizing and phase-count rationale

**Estimate: 170–240 gross non-test implementation lines.** Assumptions: 15–25 shared schema and
capability lines, 65–90 selector and task-repository preparation lines, 30–45 route changes, 30–45
MCP child changes, and 30–35 shipped-skill changes. Tests and documentation are excluded from this
estimate and remain part of the phase.

This is one phase and one one-shot task. The lower end is below the 200-line one-phase threshold;
even at the upper end the skill defaults to one phase unless another merge boundary materially
reduces risk. None does here:

- Schema, capability advertisement, tool preflight, and route handling are one compatibility
  contract. Landing only one side creates either a dead API or a selector that cannot be sent safely.
- Selector resolution and multi-repository harness validation must land together so no task can be
  stored with a repository set its eventual harness cannot reach.
- The shipped phased-plan update cannot land before the tool supports the calls it instructs agents
  to make, and separating it would temporarily publish false operational guidance.

Tests, browser proof, and documentation ship with that vertical slice. There is no preparation,
test-only, or cleanup phase.

## Phase

| # | Phase | Delivers | Direct prerequisites |
|---|---|---|---|
| 1 | [Enable cross-repository `create_task`](phase-1-enable-cross-repository-create-task.md) | Safe optional primary and attachment selectors, shared daemon validation, mixed-version preflight, phased-plan scheduling guidance, docs, focused tests, and browser proof | none beyond the planning-session PR |

## Dependency graph

```mermaid
flowchart LR
  P[Planning-session PR publishes artifacts] --> I[Phase 1: enable cross-repository create_task]
  I --> D[Complete feature]
```

**Concurrency groups:** none. There is one implementation task.

**Merge order:** this planning pull request, then Phase 1.

The Phase 1 task depends directly on the active planning session. That edge keeps it in the backlog
until the pull request publishing `plan.md`, this index, and the phase file merges to the default
branch.

## Cross-phase contracts

There is only one implementation phase, so these are feature contracts rather than handoffs:

- `repository` and `additionalRepositories` are optional public `create_task` fields. Omission keeps
  the caller checkout as the primary.
- Public selectors accept an absolute local path or a unique basename from `listRepos()`. Ambiguity
  is refused with canonical candidates; no first-match behavior is permitted.
- `resolveTaskRepoSet` remains the canonical identity and collision boundary.
- Selector-bearing calls verify daemon support before creation. Current-repository calls do not add
  a preflight request.
- The effective `ship` harness is resolved before storage; attached repositories require
  `multiRepoDispatch` and the dispatcher remains the launch backstop.
- The calling session is still identified by `env`, `sessionId`, and `cwd`, independently of the
  selected task repository.
- Foreman's all-repository allowlist is unchanged and applies only when autonomous launch is
  considered.
- No database, Task wire, worktree, dependency, pull-request, or completion migration is introduced.

## Final verification strategy

Phase 1 runs focused contract tests first, then the repository gates and browser proof:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/mcp-create-task.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/task-repo-root.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/multi-repo-policy.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/skills-catalog.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/phased-plan-task-intent.test.ts
npm test
npm run typecheck
npm run lint
npm run build
npm run smoke
npm run test:e2e -- e2e/specs/cross-repo-plan-tasks.spec.ts
```

The final browser bar is that a token-authenticated MCP-shaped request from a plan session in A
creates a dependency-gated B card and an A+B card, while an invalid or ambiguous selector creates no
card. Fake agents are used throughout.

## Final cross-phase audit

- Every root-plan requirement and submitted decision is owned by Phase 1 or explicitly preserved as
  unchanged infrastructure.
- The discovered mixed-version stripping behavior is reconciled in the earliest and only phase
  through a pre-creation capability check; the root plan records the correction.
- No concurrent merge claim exists and no later phase is expected to repair Phase 1.
- Historical multi-repository plans remain historical records; only current product docs and the
  shipped phased-plan skill change.
- The source-plan repository is the only implementation repository. No multi-repository phase is
  needed to deliver the Mission Control feature itself.
