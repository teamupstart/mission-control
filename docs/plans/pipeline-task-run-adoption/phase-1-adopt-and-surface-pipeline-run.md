# Phase 1: Adopt and Surface the Task-Owned Pipeline Run

## Objective

Add a secure, explicit adoption path for a managed Pipeline Engineer host that resumes an existing provider run, then project that durable task-run relationship onto every session surface without changing process ownership or composer behavior.

## End-user reproduction first

Use the built dashboard and the existing fake-agent and fake-Conductor environment:

1. Seed an existing halted Conductor run such as `deploy-health-and-rds-connectivity`.
2. Enable managed Agent SDK Pipelines for the fixture repository.
3. Dispatch a Pipeline task whose intent produces a different reserved slug.
4. Open the Engineer host on Board and Console.
5. Confirm the current failure:
   - the host has a Pipeline task but no Pipeline affordance;
   - the provider worker is separately visible under the existing run;
   - processing the existing run does not settle the task because its durable key remains the reserved slug.
6. Write the failing Playwright journey before production changes. The target journey adopts the seeded run through the same HTTP boundary the Mission MCP bridge uses, confirms the host link updates, and then processes the run to settle the task.

Keep every agent binary faked. Do not spend model tokens.

## Implementation sequence

### 1. Define the task-owned run projection

- Add `pipelineRun: PipelineRunLink | null` to `TaskSummary` in `src/shared/types.ts`.
- Populate it only from the bound `Task.pipelineRun` in `Registry.taskSummaryFor`.
- Do not add a new top-level Session field or comparator. `Session.task` is already compared structurally.
- Keep `Session.pipeline` unchanged. It continues to mean the provider drives this process.

### 2. Define a launch-attributed adoption protocol

- Add one strict shared request schema for the MCP bridge to `src/shared/protocol.ts`.
- Expose only `slug` in the MCP tool input. The bridge adds:
  - the captured session evidence;
  - the current cwd;
  - a launch-scoped task identity injected by Mission Control.
- Define the task-id environment key in one shared source. Do not hand-spell it in dispatcher and bridge.
- Register `adopt_pipeline_run` in `src/mcp/server.ts` and the canonical Mission MCP registry.
- Make the tool required for managed Pipeline dispatch and use the existing real `tools/list` bundle preflight so stale `dist/mcp/server.mjs` fails before launch.
- Return concise idempotent success and actionable refusal text. Never expose a way for the agent to name another task or repository.

### 3. Bind the managed Engineer host to the handshake

- Clone the managed Pipeline MCP descriptor with the daemon-issued task id in its environment. Do not mutate the shared descriptor object.
- Append a hidden instruction to the Engineer turn:
  - the expected reserved slug;
  - call `adopt_pipeline_run` before continuing whenever Engineer chooses to resume a different existing run;
  - no call is needed when Engineer creates the reserved run.
- Preserve `acceptedGoalPrompt: task.intent` and `launchPresentation.displayText: task.intent`, so the dashboard shows only the operator's intent.
- Preserve agent-specific `skillCommand(task.agent, "engineer")`, task agent selection, model and effort defaults, no Terminal fallback, and cancellation behavior.

### 4. Implement one guarded adoption primitive

Put the state transition with the task lifecycle owner in `src/server/tasks.ts`. It should accept a resolved Task, target link, and proof kind, then:

1. Return success without writing when current and target keys match.
2. Require the task to be active and kind `pipeline`.
3. Require target provider and repository to equal the current reservation's provider and the task's canonical repository.
4. Require the target run to exist in `Registry.listPipelineRuns()`.
5. Refuse when another active Pipeline task owns the target.
6. Refuse replacing a different current reservation that already exists in the provider projection.
7. For managed proof, require the live resolved caller to equal `task.sessionId`, require an SDK runtime host, and require that host not to carry `Session.pipeline`.
8. For Terminal proof, require the existing `taskResourceOwnerForSession` terminal-resource or home join and the candidate session's exact projected worktree link.
9. Persist through `Registry.upsertTask`, which refreshes the host's `TaskSummary`.
10. If the observed target is already `processed`, invoke the ordinary `settlePipelineTask` path immediately.

The route in `src/server/routes.ts` authenticates, parses, resolves the caller, and delegates. It does not duplicate lifecycle rules.

### 5. Surface task ownership without process-ownership copy

Build a separate task-run presentation in `src/web/components/session-bits.tsx`.

- Console chip: show the slug with accessible copy such as "This task continues in <slug>. Open its run in Runs." If the projection has not observed the reserved run yet, say "This task plans <slug>" rather than implying it is executing.
- Board tile flag: compact text that still includes or exposes the slug and stops click propagation before opening Runs.
- Rail mark: a compact glyph with the full statement in its tooltip and accessible name.
- Take `PipelineRunLink`, not `SessionPipelineLink`; there is no step on a task reservation.
- Keep the existing worker `PipelineChip` untouched. Its external-driver and no-input wording remains correct only for `Session.pipeline`.
- Widen `SessionViewProps.onOpenPipelineRun` to the base `PipelineRunLink`, then pass it into `SessionTile`, `RailRow`, and `ConsoleDetail`.
- Use `view.pipelineRunByKey` to distinguish a merely planned reservation from an observed/adopted run. Do not rederive provider state in the browser.

### 6. Pin the lifecycle and UI contract

Add focused coverage in existing homes:

- `test/mission-mcp.test.ts`: source registry and built-tool drift expectations include the adoption tool.
- A focused MCP or Pipeline HTTP test: schema rejection, authentication, caller attribution, missing launch identity, and response status mapping.
- `test/pipeline-phase6.test.ts` or its nearest owned successor:
  - idempotent same-run adoption;
  - observed different-run adoption when the reservation is absent;
  - immediate settlement for an already-processed target;
  - refusal when the reservation exists;
  - refusal for unknown target, competing active owner, wrong repository/provider, stale host, worker session, and non-Pipeline task;
  - strong Terminal proof succeeds while a merely similar session cannot rebind.
- Dispatcher and SDK supervisor coverage:
  - scoped task env reaches the MCP descriptor;
  - hidden adoption instruction names the reserved slug and exact tool;
  - launch display and accepted goal remain the unmodified intent;
  - stale bundle fails before SDK start.
- Rendering tests: task-owned chip/flag/mark copy differs from `PipelineChip`, and null task links render nothing.
- `e2e/specs/conductor-loops.spec.ts`:
  - reproduce through Dispatch in the built UI;
  - emulate the launch-attributed MCP adoption request;
  - verify host Board, rail, and Console links point to the existing run;
  - verify the host remains messageable and outside the provider cluster;
  - verify the worker still clusters from `Session.pipeline`;
  - process the adopted run and verify task settlement.

### 7. Document and verify

Update `docs/pipelines.md` with:

- task ownership versus process ownership;
- planned versus observed task-run labels;
- the managed adoption handshake and its refusal rules;
- unchanged provider-owned completion;
- Terminal's stronger evidence-only recovery.

Run focused tests first:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/mission-mcp.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/pipeline-phase6.test.ts
```

Add the exact focused route/render test commands selected during implementation, then run:

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npx playwright test e2e/specs/conductor-loops.spec.ts
```

Visually inspect the Board tile, Console rail, and Console detail at desktop and 420-pixel viewport widths. The new mark must not clip the session name, state, or existing PR/Inspector/Workflow marks.

## Non-negotiable boundaries

- Do not set `Session.pipeline` on the managed Engineer host.
- Do not disable or hide the host composer.
- Do not infer adoption from titles, prompts, transcripts, PR URLs, or repository run counts.
- Do not let the MCP caller choose a task, repository, or provider.
- Do not replace a different reservation that already exists in the provider projection.
- Do not let two active tasks own the same run.
- Do not mark a task complete from the MCP request.
- Do not modify AI Conductor.
- Do not add a managed-to-Terminal fallback.
- Do not change downstream Pipeline model, effort, daemon, Foreman, or cancellation semantics.
- Do not add `data-testid` selectors.

## Done when

- The original managed resume journey is covered in Playwright and passes against the built dashboard.
- The interactive host shows the task-owned adopted run and remains messageable.
- The provider worker remains the only session with `Session.pipeline` and the only one grouped as externally driven.
- The exact adopted provider projection settles the task.
- Every refusal path leaves the old durable binding unchanged.
- Focused checks, full unit tests, typecheck, lint, build, smoke, and focused Playwright pass.
- Browser evidence covers desktop and narrow layouts.
- The implementation pull request explains any mechanics that changed from this proposed route while preserving the outcome and safety boundaries.
