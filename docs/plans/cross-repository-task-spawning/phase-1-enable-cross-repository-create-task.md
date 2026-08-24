# Phase 1: Enable cross-repository `create_task`

Source plan: [`plan.md`](plan.md)

Implementation index: [`phased-plan.md`](phased-plan.md)

Direct prerequisites: none beyond the planning session's own pull request

## Outcome

Mission MCP `create_task` can explicitly file work in another valid local repository and can attach
additional repositories to the same task. The current-repository default is unchanged, the complete
repository set is validated before storage, and the selected ship harness must support that set.

An older daemon can never silently ignore the new selector fields: selector-bearing calls verify an
advertised capability before they attempt creation. Foreman's separate unattended-launch allowlist
remains intact.

## Entry criteria

- The planning pull request containing `plan.md`, `phased-plan.md`, and this file has merged.
- The implementing agent has read all three files and the repository instructions named by
  `AGENTS.md`.
- No earlier implementation phase exists.

## Scope

1. Public `create_task` fields for an alternate primary and attached repositories.
2. Additive MCP transport fields and a token-authenticated capability advertisement.
3. Absolute-path and unique-basename selector resolution.
4. Shared dashboard/MCP preparation of canonical repository sets and effective harness capability.
5. Canonical repository-set echo in the tool result.
6. Shipped phased-plan guidance for other-repository and multi-repository phases.
7. Product documentation, focused unit/route tests, bundle smoke, and Playwright proof.

### Non-goals

- Removing or weakening Foreman's repository allowlist.
- Checking GitHub collaborator roles, probing pushes, caching credentials, or creating an MC grant.
- Cloning a remote-only repository or accepting a remote URL as a selector.
- Changing task persistence, dependencies, worktree provisioning, PR tracking, or completion.
- Adding dashboard controls or changing Pi's declared multi-repository capability.
- Retrofitting schedules, task sources, or other automated producers with selector fields.

## Repository findings and inherited contracts

- `src/mcp/server.ts` is the only public-tool schema. Its existing `repoRoot: process.cwd()` payload
  is the immediate boundary being removed.
- `McpCreateTaskSchema` in `src/shared/protocol.ts` currently appears before
  `MAX_TASK_EXTRA_REPOS`. Reusing that cap may require moving the constant earlier in the module;
  do not introduce a second numeric limit.
- `McpCreateTaskSchema` strips unknown keys. Do not depend on an old daemon refusing new selector
  fields. A capability request must succeed before a selector-bearing create request is sent.
- `resolveTaskRepoSet` in `src/server/repos.ts` is authoritative for main-checkout walk-back,
  primary/secondary collisions, duplicate attachments, and ordering. New short-name logic selects
  candidate paths but never replaces canonicalization.
- `POST /api/tasks` currently owns full-set resolution, effective-agent resolution, and the early
  `multiRepoDispatch` refusal. `POST /mcp/tasks` owns calling-session dependency attribution. Preserve
  both ownership boundaries while sharing the common repository preparation.
- `TaskManager.create` already stores `extraRepoRoots` and resolves an omitted agent through the
  ship-kind default. Pass the resolved agent explicitly so preparation and storage cannot observe
  different harness configuration.
- `BacklogColumn` already shows an attached-repository count and `ReportPanel` already names the
  primary and attachments. The UI consequence needs an end-to-end assertion, not a component rewrite.
- `taskReposAllowlisted` in `src/server/foreman/backlog-machine.ts` remains unchanged by approved
  decision.

## Implementation steps

### 1. Extend shared MCP contracts

In `src/shared/protocol.ts`:

- Add optional, trimmed, non-empty `targetRepository` and bounded
  `additionalRepositories` fields to `McpCreateTaskSchema`.
- Reuse `MAX_TASK_EXTRA_REPOS`; move its declaration earlier if needed rather than copying `8`.
- Add a small MCP capability response schema or typed constant that advertises repository-set task
  targeting. Keep it additive and browser-safe.
- Preserve `repoRoot` as the calling checkout. Omitted selectors continue to resolve that field.
- Preserve the existing dependency-count refinement.

No persisted schema changes and no append-only identifier changes are involved.

### 2. Add selector and shared preparation logic

Create a focused server helper, named for task-repository preparation, that both task-creation routes
can call. It should:

1. Accept a primary selector, secondary selectors, task kind, optional requested agent, and whether
   short names are allowed.
2. Treat absolute selectors as paths. For a non-absolute MCP selector, scan `listRepos()` and match
   only exact basenames.
3. Return 400 with an absolute-path correction when no basename matches.
4. Return 409 with every sorted canonical candidate when more than one basename matches.
5. Pass the selected paths through `resolveTaskRepoSet` as a set, preserving its existing 400
   messages for invalid roots, collisions, and duplicates.
6. Resolve the effective agent through `resolveTaskAgent`.
7. Refuse a nonempty secondary set when `capabilitiesFor(agent).multiRepoDispatch` is absent.
8. Return canonical `repoRoot`, ordered `extraRepoRoots`, and the resolved agent only after every
   check succeeds.

The dashboard calls the helper in path-only mode. MCP calls it in name-or-absolute-path mode with
`targetRepository ?? repoRoot`. Keep `repos.ts` as the owner of Git identity; the new helper may
coordinate it with harness policy but must not duplicate its Git commands.

### 3. Advertise capability and converge the routes

In `src/server/routes.ts`:

- Add a token-authenticated read-only MCP capability endpoint. Its response must clearly advertise
  repository-set `create_task` support.
- Replace the dashboard route's inline repo-set/effective-agent/capability block with the shared
  helper, keeping workflow and plan-dispatch checks in the dashboard route.
- Update `POST /mcp/tasks` to prepare `targetRepository ?? repoRoot` plus
  `additionalRepositories`, then pass canonical `extraRepoRoots` and the resolved agent into
  `TaskManager.create`.
- Keep dependency conversion and `registry.findSessionByEnv(env, sessionId, cwd)` in the MCP route.
  Targeting B must not make session lookup search B.
- Map selector ambiguity to 409 and invalid paths or unsupported harness capability to 400.
- Perform all preparation before `tasks.create`; a refusal creates no row and no dependency edge.

### 4. Extend the bundled public tool safely

In `src/mcp/server.ts`:

- Add optional `repository` and bounded `additionalRepositories` inputs. Describe the accepted
  absolute path or unique basename forms and the current-repository default.
- When either selector is explicitly supplied, call the capability endpoint first. If it is absent,
  malformed, or does not advertise repository targeting, return an actionable tool error and do not
  call `POST /mcp/tasks`.
- Map public names to `targetRepository` and `additionalRepositories`; continue sending caller
  `cwd` and `repoRoot: process.cwd()` for identity and the omitted-selector fallback.
- Parse the returned task's canonical `repoRoot` and `extraRepos`, and include the canonical primary
  and attachment paths in the tool result beside the id, status, and dependency echo.
- Do not add agent, model, effort, kind, backlog, or permission parameters.

Current-repository calls must send the same creation request they send today and skip the capability
round trip.

### 5. Update the phased-plan procedure

In `skills/phased-plan/SKILL.md`:

- Replace the statement that multi-repository phases cannot be scheduled.
- For a phase implemented only in B, set B as primary. When its plan files live in A, attach A and
  mark A context-only in the phase document and short task intent.
- For an inseparable A+B phase, create one task with a deliberate primary and the remaining
  repositories attached. Keep one pull request per repository actually changed.
- Keep `dependsOnCurrentSession: true` for every phase task so plan paths publish before dispatch.
- On resolution, capability, or creation failure, stop creating dependent tasks and report all ids
  already created plus the unscheduled phase. Never fall back to A or omit an attachment.
- Update the task-call checklist and example without pasting phase content into task intent.

Update `test/skills-catalog.test.ts` so the executable skill contract requires the new selectors and
no longer requires or tolerates the manual dashboard stop.

### 6. Update product documentation

Update the current behavior docs, not historical plans:

- `docs/sessions.md`: public signature, selector forms, canonical result, capability preflight, and
  push-time enforcement.
- `docs/dispatch-and-backlog.md`: main-checkout identity, alternate primary, attachments, ambiguity
  handling, and the distinction between creation/manual dispatch and Foreman auto-launch.
- `docs/skills-and-settings.md`: phased-plan scheduling behavior and context-only source-plan repo.

Do not edit `docs/plans/multi-repo-tasks/` or older phase files that accurately record their original
v1 scope.

### 7. Add focused tests and browser proof

Extend existing tests where they already own the contract:

- `test/mcp-create-task.test.ts`: omitted selectors, absolute B, unique basename, missing basename,
  ambiguous basename with candidate paths, B primary plus A attachment, canonical response, default
  ship harness, unsupported Pi multi-repo refusal, and A-session dependency on a B task.
- `test/task-repo-root.test.ts` or a focused helper test: linked-worktree owner resolution and valid
  absolute repositories outside workspace scan roots.
- `test/multi-repo-policy.test.ts`: cap, duplicate, primary collision, order, and capability
  invariants remain identical through MCP preparation.
- `test/mission-mcp.test.ts` and `test/dispatcher-runtime.test.ts`: public source schema, capability
  preflight behavior, required-tool registry, and built-bundle parity.
- `test/phased-plan-task-intent.test.ts`: a B-primary/A-context phase remains dependency-gated until
  the planning merge, then all referenced plan paths resolve from A's attached checkout.

Add `e2e/specs/cross-repo-plan-tasks.spec.ts` with two fixture repositories and fake agents:

1. establish a plan session in A;
2. send the bundled tool's token-authenticated request shape targeting B and depending on that
   session;
3. assert the Board shows the task under B and still waiting on its dependency;
4. create B primary plus A attached and assert the existing two-repository chip and detailed repo
   names;
5. prove an invalid and an ambiguous selector return actionable errors and create no card.

Use roles, accessible names, and visible repository text. Add no `data-testid` and spend no model
tokens.

## Data, API, and compatibility contract

- No database migration or Task type change.
- The MCP request change is additive. Old children continue using `repoRoot` only.
- Explicit selectors require advertised daemon capability before creation, preventing mixed-version
  silent stripping. Calls without selectors retain the previous single request.
- Short names are local workspace addresses, not durable repository identity. Stored values and tool
  results are canonical absolute main-checkout paths.
- The entire repository set and effective harness resolve atomically before task storage.
- Repository-host authorization remains deferred to ordinary push and PR operations.
- Foreman still requires every target repository to be allowlisted before unattended launch.

## Verification

Run focused tests while implementing:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/mcp-create-task.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/task-repo-root.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/multi-repo-policy.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/skills-catalog.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/phased-plan-task-intent.test.ts
```

Before opening the implementation pull request, run:

```sh
npm test
npm run typecheck
npm run lint
npm run build
npm run smoke
npm run test:e2e -- e2e/specs/cross-repo-plan-tasks.spec.ts
```

If the implementation changes shared e2e fixtures or behavior covered by the full browser suite,
run `npm run test:e2e` as the final browser gate.

## Merge and exit criteria

- [ ] Omitted selectors create the same canonical current-repository task as before.
- [ ] Absolute and unique-name primary selectors create exactly one task in the intended repository.
- [ ] Attachments are canonical, ordered, bounded, deduplicated, and capability-checked before
      storage.
- [ ] A selector-bearing call against an unadvertised or old daemon creates no task.
- [ ] Cross-repository current-session dependencies remain durable and merge-gated.
- [ ] Existing Board surfaces visibly render B and A+B tasks in Playwright.
- [ ] Foreman allowlist behavior is unchanged and documented distinctly from creation.
- [ ] Focused tests, full unit suite, typecheck, lint, build, smoke, and required e2e proof pass.
- [ ] The pull request explains any departure from this proposed route and why the repository made
      the alternative safer or simpler.

The phase exits only as one operable merge. There is no later phase that can repair a partial tool,
daemon, skill, or documentation contract.

## Downstream handoff

There are no later implementation phases. Future extensions may reuse the shared task-repository
preparation for schedules or task sources, but must not reinterpret the public selectors as remote
URLs, bypass `resolveTaskRepoSet`, or weaken Foreman's separately approved launch policy.

## Cross-phase audit record

- 2026-08-24: Created as the only implementation phase. All root-plan requirements and all three
  submitted decisions are owned here.
- 2026-08-24: Corrected the root plan's mixed-version assumption after confirming that the current
  Zod object strips unknown fields. Capability preflight now owns safe new-child/old-daemon behavior.
- 2026-08-24: Rechecked phase boundaries. Schema, route, bundled tool, shipped skill, docs, tests, and
  browser proof remain one vertical slice; no independent phase can merge operably.
