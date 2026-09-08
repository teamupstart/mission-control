# Phase 3: the operator surface

Source plan: [`plan.md`](plan.md). Index: [`phased-plan.md`](phased-plan.md).

## Outcome

An operator can turn write-back on for a source, see what it has delivered and what it has not,
retry a queue that failed, and discard one they turned on by mistake - in **Settings -> Task
sources**, beside the switches that already govern that source. Until this phase, all of that is
reachable only by hand-writing the config through the API.

## Entry criteria and dependencies

Depends on **Phase 1**, and on nothing else. It needs the contract, the ledger, and
`countWritebacks(sourceId)`, all of which Phase 1 lands.

Concurrent with **Phase 2**. This phase renders capabilities rather than kinds, so it is correct
whether Jira can write back yet or not, and the two phases share no owned file.

## Scope

In scope:

- `TaskSourceWritebackStatus` computed and returned by `taskSourcesView()`.
- `POST /api/task-sources/:id/writeback/retry` and `DELETE /api/task-sources/:id/writeback`.
- The web fetch helpers, the `useTaskSources` additions, and the panel fieldset.
- `e2e/specs/task-source-writeback.spec.ts`.
- The operator-facing documentation.

Explicitly **not** in scope:

- Any change to `src/shared/task-source.ts`. Phase 1 owns it, and Phase 2 owns the two Jira
  boolean flips inside it. This phase reads.
- Any change to `jira.ts`, `github-issues.ts`, or `writeback.ts`.
- **Asserting either Jira capability boolean, anywhere.** Phase 2 flips them from false to true,
  so a spec or a unit test that pins Jira's current value would go red the moment the other
  phase merges. The disabled-with-a-reason rendering is pinned against a synthetic capability in
  `test/task-sources-panel.test.ts`, and the e2e spec drives a GitHub Issues source.
- A per-task write-back chip or override. Out of scope in the source plan.

## Repository findings

Verified against the current tree:

- `taskSourcesView()` (`src/server/routes.ts:5991-5997`) is a closure returning config, status
  and kinds in one GET, and the panel is its only consumer. Adding the write-back status there
  keeps the panel's read to one request, which is what `useTaskSources` is built around.
- Every write in that route block calls `publishSettingsStatus(registry)`
  (`routes.ts:6026`, `:6044`), because the gear and rail carry a dot derived from
  `settingsStatus()` (`src/server/settings-status.ts:30-52`), whose `taskSources: { failing }`
  is the field a stuck queue must reach.
- `parseBody(c, Schema)` (`routes.ts:638-654`) is the two-line convention for every write
  endpoint, and the retry body needs it for its one `includeUnknown` flag.
- `src/web/useTaskSources.ts:50-60` documents the one invariant that governs any addition here:
  a response may be written into the view **only if** the client's picture of the world has not
  moved since that response was requested. Four separate defects there were the same mistake.
  The two new actions are writes, so they follow the existing `writes` ref discipline rather
  than inventing a second one.
- `TaskSourcesPanel.tsx` composes per-kind fields through `GithubFields` (`:186`) and
  `JiraFields` (`:346`), selected by a `src.kind ===` branch at `:596-604`. The write-back
  fieldset is kind-agnostic apart from one field, so it goes in `SourceCard` (`:448`) with the
  kind-specific field delegated to those two components.
- `data-anchor="<category>/<slug>"` is load-bearing: `settings-sidebar-render.test.ts` fails on
  a duplicate anchor or one whose prefix is not a registered category. The existing task-sources
  anchors are `sources`, `directory`, `add`, `editor` (`:1065`, `:1105`, `:1119`, `:1175`), so
  this adds `task-sources/writeback`.
- `e2e/fixtures/modal-inset.ts` exports `expectContentClearsBorder`, required of any spec that
  opens a modal. This spec works in the settings panel rather than a modal, so it is needed only
  if a confirm dialog is introduced - and Discard should use one.
- The app has 229 `aria-label`s and 155 `role`s; `data-testid` is forbidden. Every selector here
  goes through a role, a label or a placeholder.

## Implementation steps

### 1. `src/server/routes.ts`

- `taskSourcesView()` returns `writeback: cfg.sources.map((s) => writebackStatusFor(s.id))`,
  built from Phase 1's `countWritebacks`.
- `POST /api/task-sources/:id/writeback/retry` - body
  `{ includeUnknown: z.boolean().default(false) }` through `parseBody`. Moves `failed` rows back
  to `pending` with `attempts` reset and `next_at` now; moves `unknown` rows only when the flag
  says so. Two flags rather than one because retrying an `unknown` is the operator asserting
  they have looked upstream, and that assertion should be something they made rather than
  something a button did for them. Responds with the refreshed view.
- `DELETE /api/task-sources/:id/writeback` - discards this source's rows. The counterpart to
  "Forget seen items", and the way out for somebody who turned a switch on by mistake.
- Both call `publishSettingsStatus(registry)`.
### 1b. `src/server/settings-status.ts`

Fold the write-back `failed` + `unknown` counts into `taskSources.failing`, so a stuck queue
lights the same dot a failing sweep does. A queue nobody notices is the failure mode this whole
surface exists to prevent. Phase 1's worker already triggers the recompute; this is what the
recompute then counts.

### 2. `src/web/lib/api.ts`

`retryTaskSourceWriteback(id, includeUnknown)` and `discardTaskSourceWriteback(id)`, beside the
existing `sweepTaskSource` / `forgetTaskSourceSeen` helpers.

### 3. `src/web/useTaskSources.ts`

Two new actions on `TaskSourcesState`, going through the same `writes` guard the existing
mutations use, so an in-flight poll cannot clobber a just-made edit. Read the file's header
before touching it.

### 4. `src/web/components/TaskSourcesPanel.tsx`

A `WritebackFields` section in `SourceCard`, `data-anchor="task-sources/writeback"`:

- **Comment when a pull request opens** (switch, `aria-label` naming the source).
- **Comment when the task completes** (switch).
- **Also resolve the item upstream** (switch, nested, disabled with an explanatory hint until
  the completion trigger is on - which is also what the shared schema's `.refine` enforces
  server-side, so the UI and the server refuse the same thing).
- The kind's own field, delegated: **Close reason** in `GithubFields`, **Target status** and
  **Link style** in `JiraFields`.
- A `ConsoleState` line reading the source's `TaskSourceWritebackStatus`: what is waiting, what
  failed, what is unknown, and the last error. **Retry** beside it, and **Retry including
  unknown** as a distinct control whose hint says the item may already have been written and to
  check upstream first. **Discard queue** behind a confirm.

A switch whose kind capability is false renders **disabled with the reason**, never hidden: a
capability this build does not have and a switch you have not turned on are different things,
and hiding one makes them look alike.

### 5. Documentation

- `docs/dispatch-and-backlog.md`: a **new** `### Writing back to the source` section after
  `### Push a task to GitHub`, covering the two triggers, what each writes, the resolve consent
  and its settle window, the queue states, the retry and discard controls, and the "check before
  retrying" rule for an unknown outcome - kind-neutral, with GitHub's specifics (comment, close,
  close reason) since those exist from Phase 1. Per-kind specifics belong in each kind's own
  section: **Phase 2 owns the Jira paragraph**, in the existing `### Jira` section. Do not write
  into it, and do not cross-link it, so this section is true whichever phase merges first. The
  Task sources control table gains the write-back rows.
- `docs/database-and-migrations.md`: the `task_source_writeback` table, and why its rows outlive
  their tasks.
- `docs/security.md`: one line stating that a task source may now write to its upstream, under
  per-source consent, with the same egress guard the read path uses.

## Tests and verification

Extend `test/task-sources-panel.test.ts`: the fieldset's markup; the nested resolve switch
disabled while the completion trigger is off; and the disabled-with-a-reason rendering, driven
by a **synthetic** capability rather than by a real kind's current flags, so Phase 2's merge
cannot turn it red.

New `test/task-source-writeback-http.test.ts`, in the style of `test/task-push-http.test.ts`:
the two routes' success and refusal shapes, `includeUnknown` gating the `unknown` rows, and an
unknown source id refusing rather than silently succeeding.

New `e2e/specs/task-source-writeback.spec.ts`, driving a **GitHub Issues** source:

1. The fieldset is reachable in Settings -> Task sources, arrives with every switch off, and its
   values survive a reload - which is what proves they reached the daemon rather than component
   state, and is the claim no other layer can make.
2. **Also resolve the item upstream** cannot be turned on until the completion trigger is.
3. With the switches on, a completed task produces a delivery the panel reports, through the
   faked `gh` so nothing is published.
4. A refused delivery surfaces on the source with its reason, and **Retry** clears it.
5. `expectContentClearsBorder` on the Discard confirm.

Selected by role, label or placeholder throughout. No `data-testid`. No model tokens: nothing
here dispatches an agent.

Commands:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/task-sources-panel.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/task-source-writeback-http.test.ts
npm test
npm run typecheck
npm run lint
npm run build && npm run smoke
npm run test:e2e
```

## Merge and exit criteria

- Write-back can be configured, observed, retried and discarded entirely from Settings.
- A source with a failing queue lights the settings dot.
- The new spec passes, and every existing e2e spec still does.
- `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm run smoke`,
  `npm run test:e2e` pass.
- The documentation describes exactly what has shipped at this merge and nothing more. The Jira
  paragraph is Phase 2's, so this section stays kind-neutral plus GitHub's specifics and is true
  whether Phase 2 has merged or not.

## Downstream handoff

Nothing depends on this phase. It is the last merge in the graph.

## Cross-phase audit record

- Reconciled against Phase 1. `TaskSourceWritebackStatus` and `countWritebacks` are declared
  there and consumed here; `taskSourcesView()` returning `writeback: []` in Phase 1 is replaced
  here, so no client ever sees the field missing.
- Reconciled against Phase 2. Two shared files, disjoint regions: `e2e/README.md` and
  `docs/dispatch-and-backlog.md`, whose ownership split is recorded in both phase files.
- Documentation-order hazard, resolved during the audit. This phase originally documented the
  Jira write-back that Phase 2 implements, which would ship a promise the build did not keep if
  this phase merged first. The Jira paragraph moved to Phase 2; this section is kind-neutral plus
  GitHub, and is true at its own merge in either order.
- The explicit non-goal of asserting a Jira capability boolean is what keeps this phase's tests
  green when Phase 2 flips those booleans, and it is why the disabled-state assertion is driven
  by a synthetic capability rather than a real kind.
