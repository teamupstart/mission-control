# Keep imported backlog tasks updated

Status: implemented in the checkout and validated on 2026-09-23, following the operator's implementation authorization after the task-source scout.

## Behavior

Add a per-source **Keep imported backlog tasks updated** checkbox, off by default. Scheduled sweeps and Sweep now refresh the same imported task while it is an unstarted backlog item. Title and generated intent move together; mapped priority and copied labels can update independently. Agent, kind, repositories, workflow, dependencies, rank and autopilot eligibility remain local. Source defaults are captured at import and are not reapplied when changed later.

Preserve local edits with a three-way comparison of the last accepted source content, current local content, and latest source content. Apply nonconflicting changes. Show conflicts in the source editor with the local/source values and explicit **Use source** and **Keep local** actions. A stale resolution is refused. Old tasks with no import baseline require explicit adoption when their origin cannot be proven; newly pushed tasks are never silently enrolled.

Deletion suppression remains in task_source_seen. Neither a missing issue nor a failed query deletes, completes, dispatches, or recreates a task. Never change a task that is assigned, has started, or has execution resources. Pause/off/configuration changes invalidate in-flight updates. Manual Sweep now still works while the schedule is paused.

## Data and request flow

Before: source discovery -> candidates -> seen ledger -> create new backlog task or skip.

After: source discovery plus bounded reads of linked identities -> daemon reconciliation -> atomic task and baseline write -> existing Registry task event -> dashboard. The seen ledger still governs creation. A task-linked sync table stores import provenance, fixed import defaults, accepted and pending projections, and refresh timestamps. The source editor reads persisted sync outcomes through the existing task-source view.

The current source registry owns linked-item reads. GitHub reads the linked issue URL; Jira searches a bounded list of validated issue keys on the original site, independent of the discovery JQL. Reuse candidates already returned by discovery. Select older unchecked tasks first, with a refresh budget separate from the creation cap. Authentication and query errors stay visible and retry on later sweeps.

## Work

1. **Shared contract and reconciliation policy.** Add the setting, typed projection schemas, status/result types, and pure three-way merge. Unit tests cover untouched fields, conflicts, unchanged values, local overrides, and coupled title/intent.
2. **Persistence and import provenance.** Add task-linked metadata with deletion cleanup. Save a normalized baseline with each newly imported task, including when the setting is off; mark newly pushed tasks as excluded. Tests cover migration, atomic import rollback, deletion tombstones, and fixed defaults.
3. **Task update boundary.** Add a narrow TaskManager operation for compare-and-apply source fields after waiting for titling. Recheck assignment, launch state, current content and source generation. Commit task and metadata together, publishing only after commit and only when the task changed. Tests cover concurrent edits and dispatch.
4. **Provider reads and sweep integration.** Add linked-read methods to the existing registry and both providers. Refresh fair bounded batches on the existing cadence, reusing discovery candidates and surfacing missing/error results. Tests cover out-of-filter items, timeout, source changes, fairness and disabled compatibility.
5. **Review API.** Expose pending conflicts and old-task adoption. Resolve with an opaque version of the shown local/source data; reject stale, deleted, started or disabled targets. Tests cover source/task ownership, validation, kept local edits and accepted source changes.
6. **Settings UI.** Add the checkbox, summary, and inline review with accessible controls and local/source text. Use the existing settings request lifecycle and existing task SSE. Browser specs prove persistence, source refresh, visible conflicts, resolution, off behavior and deletion suppression.
7. **Documentation.** Update task-source behavior and architecture documentation, including the stale statement about outbound resolution. Document polling, scope, conflicts, old-task adoption and provider limits.

Dependencies: 1 -> 2 -> 3; 1 -> 4; 2,3,4 -> 5 -> 6; 4,5,6 -> 7.

## Verification

Run focused unit/integration tests for each behavior as it is implemented. Finish with typecheck, lint, build, smoke, and relevant Playwright specs against the built daemon. Capture successful UI evidence in ignored e2e/.artifacts. Do not modify release or CI configuration. Do not commit scout reports or evidence.

Completed validation: 366 focused unit/integration cases passed, including source reconciliation, provider reads, persistence, lifecycle guards, writeback regressions and route ownership. The new task-source-sync browser spec and existing settings-task-sources-jira spec passed all 11 cases. Typecheck, lint, build and smoke passed; lint retained existing warnings. The rendered settings review was visually inspected, and this plan passed light/dark contrast checks. Tests use fake providers and isolated state; live GitHub/Jira credentials and the full repository test suite were not exercised.

## Boundaries and decisions

- Use the scout's recommended safe synchronization policy; automatic remote-wins replacement is not enabled.
- This is content synchronization, not status mirroring or live changes to an agent's instructions.
- A mapped intent retains the provider's current 4,000-character body limit.
- Query failure and absence are unknown states, not proof that upstream work was deleted.
- No new worker, browser polling loop, scheduler, event channel or parallel provider registry.
- The operator explicitly asked to plan and then implement in this session; no separate phased task scheduling or additional approval is needed.
