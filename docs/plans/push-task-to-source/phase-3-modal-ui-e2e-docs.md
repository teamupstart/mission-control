# Phase 3: Modal UI, e2e coverage, and docs

Part of [plan.md](plan.md) via [phased-plan.md](phased-plan.md). Read both, plus [phase-2-push-write-path-and-route.md](phase-2-push-write-path-and-route.md), before this file.

## 1. Outcome and value

The user-visible feature: from the edit-backlog-task modal, an operator clicks **Create GitHub issue** and the task is filed as an issue through a configured github-issues source; the same spot then renders the issue link (`owner/repo#123`), which also appears for tasks that were swept in - the first time `Task.source` is visible anywhere in the dashboard. Full Playwright coverage on faked gh, plus the documentation that makes the contract public.

## 2. Entry criteria and dependencies

- Direct dependency: **Phase 2** merged (`POST /api/tasks/:id/push` live with its exact contract).
- Entry: `npm run build` and `npm run test:e2e` green on the default branch.

## 3. Scope and non-goals

In scope:

- `src/web/lib/api.ts`: `pushTaskToSource(id, sourceId)`.
- `src/web/components/DispatchModal.tsx`: `PushToSourceBlock` (exported pure component) + integration; reword the line-~1046 "(conflict)" sentence.
- `src/web/components/TaskSourcesPanel.tsx`: wording sweep ("files backlog rows and nothing else" claims), keeping the pinned "never dispatches an agent" sentence verbatim.
- `e2e/fixtures/fake-agents.ts` (`FAKE_GH`), `e2e/fixtures/daemon.ts` (`MISSION_GH_BIN`), NEW `e2e/specs/push-task-to-github.spec.ts`.
- `test/backlog-edit-render.test.ts` additions.
- `docs/dispatch-and-backlog.md` task-sources section.

Non-goals:

- No server behavior change. If the UI seems to need one, stop: the phase-2 contract was designed for this UI and a mismatch is a phase-2 regression to raise, not patch around.
- No new SSE event; no `useEventStream.ts` edit.
- No delete affordance in the modal - that is the independent backlog task "Add a Delete button to the edit-backlog-task modal" (id 5b24172d-6807-4268-bd0c-90a85f264644), which touches the modal FOOTER. This phase touches the provenance-note area in the modal BODY. If that task lands first, rebase over it; the areas do not overlap structurally, only by file.

## 4. Repository findings and inherited contracts

- From phase 2 (fixed): route contract (200 -> updated `Task`; 409 conflicts; 502 retry-safe; 504 + `outcomeUnknown: true` never blind-retried), and the eligibility rule = exact string equality of `source.repoRoot` and `task.repoRoot` plus `canPush` on the kind.
- `DispatchModal.tsx`: edit mode has `ariaLabel="Edit a backlog task"`; the schedule provenance block (`rm-provenance-note`, lines ~1038-1064) is the placement anchor and holds the only existing `editing.source` reference (the "(conflict)" sentence to reword). The modal already does on-open fetches (~lines 750-764) - add the one-shot `fetchTaskSources()` there, gated on edit mode without `source`. `App.tsx` derives `editingTask` from the live tasks map, so a `task_upsert` re-renders `editing` mid-edit without reseeding the draft; the push response body is still stored locally (`pushedRef`) so the link never waits on SSE timing.
- `TASK_SOURCE_KIND_INFO` is browser-safe (`src/shared/task-source.ts` has no `node:` imports); the settings panel already imports it - the modal reads `canPush` from it directly.
- Error surfacing is local per surface (no toasts): the modal uses `dispatch-error`-styled inline text.
- Accessibility rules: never `data-testid`; visible text or `aria-label` is the accessible name; `Tooltip` merges `aria-describedby` only.
- e2e: fakes live in `e2e/fixtures/fake-agents.ts` (FAKE_CMUX is the model for an extension-less CJS fake recording argv to `MC_E2E_RECORD_DIR`); `startDaemon()` in `daemon.ts` builds the isolated env (`MISSION_CLAUDE_BIN` etc. - add `MISSION_GH_BIN`). Because phase 1 converted `pr.ts` and the Inspector to `ghBin()`, setting `MISSION_GH_BIN` points the PR poller at the fake too - `FAKE_GH` must answer `pr list` (and `issue list`) with `[]` so existing specs stay quiet. Model specs: `e2e/specs/line-drawers.spec.ts` (seedTask with the `workflowId: null` quirk; API read-backs) and `e2e/specs/settings-task-sources-jira.spec.ts` (seeding `PUT /api/task-sources/config`).

## 5. Implementation steps

1. `src/web/lib/api.ts`: `pushTaskToSource(id, sourceId)` posting to `/api/tasks/:id/push`; success body is the `Task` (read `source` off it); failure body may carry `outcomeUnknown`.
2. `DispatchModal.tsx`:
   - On-open effect (edit mode, `!editing.source`): fetch `TaskSourcesView`, keep `sources: TaskSourceInstance[] | null` (null until landed).
   - `export function PushToSourceBlock(props)` - pure, per-state render, exactly one state at a time:
     | State | Render |
     |---|---|
     | task has `source` (or local `pushedRef`) | "Linked to GitHub issue" + `<a href={url} target="_blank" rel="noreferrer">owner/repo#123</a>`; plain `externalId` text when `url` is null |
     | sources `null` (not yet fetched) | nothing - no button flash |
     | none eligible | muted hint: add a GitHub Issues task source for this repo in Settings |
     | one eligible | button `Create GitHub issue` (visible text is the accessible name; Tooltip describes and names the source) |
     | many eligible | `<select aria-label="GitHub issue source">` + the button; defaults to first |
     | unsaved edits | button disabled; tooltip "Save your changes first - the issue carries the task's saved title and intent" |
     | busy | button disabled, "Creating issue..."; folded into modal `busy` so `closable={!busy}` seals dismissal mid-push |
     | failed, refused | inline error beside a still-enabled button (retry is safe by the 502 contract) |
     | failed, outcomeUnknown | warning "...the issue may already exist - check GitHub before retrying"; button removed for this opening |
   - Mount as a sibling after the schedule provenance block, reusing `rm-provenance-note` styling plus a `source-provenance-note` class. Eligibility filter: `TASK_SOURCE_KIND_INFO[s.kind].canPush && s.repoRoot === editing.repoRoot`.
   - Reword line ~1046: "This task is also linked to an external item below." (dual provenance is legitimate once push exists).
3. `TaskSourcesPanel.tsx`: soften the "and nothing else" phrasing; keep the pinned "never dispatches an agent" sentence byte-identical.
4. e2e fixtures: `FAKE_GH` records `{argv, cwd}` as `gh-*.json`; `issue create` prints `https://github.com/acme/demo-repo/issues/123` and exits 0; `issue list` and `pr list` print `[]`; anything else exits 0. Add `gh` to `FakeAgents.bins`; `daemon.ts` sets `MISSION_GH_BIN`.
5. NEW `e2e/specs/push-task-to-github.spec.ts`:
   - Spec 1 "pushing a backlog task creates the issue, links the task, and records it as seen": seed source (`repoRoot: daemon.repo`, `config: { labelsAny: ["mission", "triage"] }`) and a backlog task; open the board card into the edit modal; click `Create GitHub issue`; assert (a) the `acme/demo-repo#123` link renders with the fake URL, (b) `GET /api/tasks` read-back shows `source.externalId === "acme/demo-repo#123"`, (c) recorded argv contains `issue create --title <title> --body <intent> --label mission --label triage` with `cwd` = the repo (use `expect.poll` on the record file), (d) `GET /api/task-sources/config` status shows `seenCount === 1`.
   - Spec 2 "no eligible source hides the action": source configured for a different repo; the button is absent (make the absence possible first, per `e2e/README.md`) and the settings hint renders.
6. `test/backlog-edit-render.test.ts`: swept-in task renders its issue link statically (no fetch needed); no button before sources land; `PushToSourceBlock` direct renders for one/many/none eligible, busy, refused-keeps-button, unknown-removes-button.
7. `docs/dispatch-and-backlog.md`: name the one outward verb; a "Push a task to GitHub" paragraph - what the issue carries (title, intent, the source's `labelsAny` labels), the missing-label hard failure, the seen-row guarantee ("a pushed issue never re-files as a duplicate, and push-then-delete stays deleted"), the 504 "check GitHub before retrying" rule; Jira does not accept pushes.

## 6. Data / API / migration notes

None. Pure consumer of phase 2's route. `MISSION_GH_BIN` is a test-environment knob, not configuration.

## 7. Tests and verification

- `npm run typecheck && npm run lint && npm test` (render tests included).
- `npm run build && npm run smoke && npm run test:e2e` - the new spec plus the full existing suite (the FAKE_GH/`pr list` change must leave every existing spec green).
- Visual verification per AGENTS.md: run a dedicated vite port + daemon (the shared :5173 serves the main checkout) and screenshot the modal in the linked and pushable states for the PR.
- Manual failure path: a `labelsAny` label that does not exist on a real repo -> inline gh error, button retained.

## 8. Merge and exit criteria

- Section 7 green, including the full pre-existing e2e suite.
- The two e2e specs cover: click -> route -> daemon -> fake gh -> SSE/body -> DOM, and the hidden-action case.
- README/docs match the implementation; no unrelated edits in the worktree.
- Reviewable PR merged to the default branch.

## 9. Downstream handoff

Nothing downstream in this plan. For future work: `PushToSourceBlock` is the reusable rendering of `Task.source`; a later feature adding source links to board cards or Sitrep rows should reuse its linked-state rendering rather than reimplement it.

## 10. Cross-phase audit record

- 2026-08-09: initial version. Consumes phase 2's route contract verbatim (200 Task body, 502 vs 504 retry semantics) and phase 1's `canPush` + `MISSION_GH_BIN` seam. Owns the e2e consequence of phase 1's whole-codebase ghBin conversion (FAKE_GH answers `pr list` with `[]`). Merge-overlap note recorded against independent backlog task 5b24172d (modal footer Delete button): different modal regions, same file, rebase not redesign.
