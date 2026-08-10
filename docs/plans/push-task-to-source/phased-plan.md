# Phased plan: Push a backlog task to a task source

Implementation index for [plan.md](plan.md) (rendered: [plan.html](plan.html)). The phase files beside this index are the detailed sources; each scheduled task points at its phase file.

## Source plan and incorporated decisions

- Source: `docs/plans/push-task-to-source/plan.md` - create a GitHub issue from an existing backlog task through a configured `github-issues` task source. GitHub only; Jira is not forced to implement the new verb.
- Operator decisions incorporated as requirements:
  1. Push requires a configured github-issues source whose `repoRoot` matches the task's (no sourceless fallback).
  2. UI surface: the edit-backlog-task modal only; the same spot renders the issue link after a push and for swept-in tasks.
  3. Issue content: title = task title, body = task intent, labels = the source's `labelsAny` filter labels.
  4. The local task stays in the backlog, linked via `task.source`; the seen row prevents re-import.
  5. Plan-review decision: `ghBin()` converts **every** gh call site now (github-issues.ts, pr.ts, inspector/github.ts).
  6. The dashboard review initially chose "stop after this plan"; the operator later explicitly requested phasing - this index is that follow-up.

## Investigated findings (recorded discrepancies)

Verified against HEAD a6146ee before decomposition:

- There are exactly **14** literal `run("gh", ...)` sites: 3 in `src/server/task-sources/github-issues.ts`, 2 in `src/server/pr.ts` (~93-94, ~151), 9 in `src/server/inspector/github.ts` (~101, ~272, ~446, ~488, ~699, ~745, ~768, ~804, ~849). The Inspector has no internal gh wrapper to convert in one place; the substitution is 9 mechanical edits there.
- `envVar()` resolves `MISSION_/FLEET_/HARNESS_` prefixes, so `envVar("GH_BIN")` yields the `MISSION_GH_BIN` override with no new plumbing.
- `src/server/tasks.ts` has `interface Ok` (~line 130) as the established refusal shape for `attachSource`.
- Everything else in the source plan matched the repository as written.

## Phases

| # | Phase | File | Direct deps | Delivers |
|---|---|---|---|---|
| 1 | Contract and gh plumbing | [phase-1-contract-and-gh-plumbing.md](phase-1-contract-and-gh-plumbing.md) | none | `canPush`/`PushDraft`/`PushResult`/`push` verb, registry entry points, `ghBin()` at all 14 sites, github-issues push impl, contract + mapping tests. Zero behavior change with the env var unset. |
| 2 | Push write path and route | [phase-2-push-write-path-and-route.md](phase-2-push-write-path-and-route.md) | Phase 1 | `attachSource`, `push.ts` chokepoint (seen row + link in one transaction), `PushTaskSchema`, `POST /api/tasks/:id/push` with the 200/400/404/409/502/504 contract, push + route tests. API usable via curl. |
| 3 | Modal UI, e2e, docs | [phase-3-modal-ui-e2e-docs.md](phase-3-modal-ui-e2e-docs.md) | Phase 2 | `PushToSourceBlock` in the edit modal, `Task.source` rendered for the first time, wording sweeps, `FAKE_GH` + `MISSION_GH_BIN` fixtures, two Playwright specs, render tests, `docs/dispatch-and-backlog.md`. |

## Dependency graph and concurrency

```
phase-1  -->  phase-2  -->  phase-3
```

Strictly serial; no concurrency groups. Phase 2 consumes phase 1's types and registry entry points; phase 3 consumes phase 2's route contract and phase 1's env seam. Merge order equals phase order.

An **independent** backlog task exists outside this plan: "Add a Delete button to the edit-backlog-task modal" (5b24172d-6807-4268-bd0c-90a85f264644), touching the modal footer while phase 3 touches the modal body. No dependency edge; whichever lands second rebases over a same-file, different-region overlap.

## Cross-phase contracts

- **Phase 1 -> 2, 3**: `PushDraft`/`PushResult`/`PushContext` and `canPushTo`/`pushToSource` are frozen; `outcomeUnknown: true` is never retry-safe; exit-0-without-URL reads as unknown outcome, never success; `ghBin()` is the only gh seam and `MISSION_GH_BIN` its override.
- **Phase 2 -> 3**: route contract frozen (200 returns the updated `Task`; 504 body carries `outcomeUnknown: true`; 502 means retry-safe); eligibility = exact string equality of source and task `repoRoot` plus kind `canPush` - the UI filters by the identical comparison.
- **Safety invariant (all phases)**: the seen row and the task link are written in one transaction; no path writes them separately, except the deliberate moved-mid-push case which writes only the seen row and reports the created issue.

## Final verification strategy

Each phase carries its own bar (sections 7-8 of its file). After phase 3 merges, the end state is verified by:

1. `npm run typecheck && npm run lint && npm test && npm run build && npm run smoke && npm run test:e2e` on the default branch.
2. Manual round trip on a real repo: push a task, see the issue (title/body/labels), see the modal link, then "Sweep now" files zero new tasks; delete the task and sweep again - still zero (seen rows outlive tasks).
3. The two failure paths: missing repo label -> inline 502 error with the button retained; unknown outcome -> 504 wording with the button removed.
