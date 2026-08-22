# Phased implementation: capacity-first Worktrees pane

- **Source plan:** [`plan.md`](plan.md) (rendered: [`plan.html`](plan.html))
- **Date:** 2026-08-21
- **Phases:** 1
- **Tasks:** 1

## Incorporated human decisions

All four were submitted in Mission Control on 2026-08-21 and are treated as requirements, not open
questions.

| Decision | Selection |
| --- | --- |
| Layout direction | **B - Capacity-first** |
| Safety callout | **Demote it to the lead paragraph** |
| Scope | **Restyle plus empty and loading states** |
| Follow-up | **Create phased implementation plan** |

## Repository findings

Investigated at `HEAD` on this session's branch. Three findings changed the shape of the plan.

1. **No backend work is required, and the source plan's assumption holds.**
   `WorktreeRepositoryView` in `src/shared/worktrees.ts:56-73` already carries
   `policy.maxSlots` and `counts { total, leased, available, quarantined, overCapacity }` - every
   input the capacity bar needs. Nothing in `src/shared/`, `src/server/`, the routes, or the
   database is touched by this change. It is entirely browser-side.

2. **The "inventory unavailable" state already has a wire representation.**
   `WorktreeRepositoryView.status` is `"ready" | "attention" | "unavailable"`
   (`src/shared/worktrees.ts:71`), and `useWorktrees` exposes `error` separately from a resolved
   empty `repositories` array (`src/web/useWorktrees.ts:32-45`). The three states the scope
   decision asks for - loading, empty, and unavailable - are therefore all distinguishable today.
   The gap is presentational only: the panel renders nothing for them.

3. **The blast radius is two files plus their tests.**
   `src/web/components/WorktreeSettingsPanel.tsx` (382 lines) and the `wt-` block in
   `src/web/styles.css` (lines 403-781, 379 lines). `SlotCard` and `ActionDialog` inside the panel
   are structurally unaffected and only inherit the radius and token corrections. The three
   `data-anchor` values in `src/web/lib/settings-search.ts:175,184,193` keep their slugs; only the
   order of the sections they point at changes, so no registry edit is needed.

## Sizing and phase-count rationale

**Estimate: 400-500 gross non-test implementation lines added or materially changed.**

Assumptions behind the range: the `wt-` CSS block is largely rewritten (~280 lines materially
changed, of 379), and the panel's top-level structure, the pool row, the new capacity bar, and the
three states account for ~180 lines of TSX. `SlotCard` and `ActionDialog` are assumed to survive
with token-level edits only. Tests are excluded from the count.

That is above the 200-line one-shot threshold, so a split was considered and rejected. **One phase.**

- There is **no layer boundary to split on.** Verified above: no shared contract, server, route,
  schema, or migration work exists in this change. The usual foundation-then-consumer boundary has
  nothing to separate.
- Splitting the capacity bar from the pane would **create a dead surface** - a component nothing
  renders - which is exactly the split the phasing rules forbid.
- Splitting the empty and loading states from the restyle would touch the same two files twice in
  sequence, guarantee a conflict between the two pull requests, and produce no independently
  valuable intermediate state. The states are presentation of the same pane.
- The CSS block and the component that consumes it **must move together.** Landing either alone
  leaves unstyled markup or dead rules on the default branch.
- One pane, one CSS block, one e2e spec, and one component test is well within what a mid-tier
  model can implement, verify, and explain in one session.

## Phases

| # | Phase | File | Direct prerequisites | Repository |
| --- | --- | --- | --- | --- |
| 1 | Capacity-first Worktrees pane | [`phase-1-capacity-first-worktrees-pane.md`](phase-1-capacity-first-worktrees-pane.md) | None (beyond this planning session) | `ai-harness` only |

## Dependency graph

```mermaid
graph LR
  P[Planning session PR<br/>publishes the artifacts] --> A[Phase 1<br/>Capacity-first Worktrees pane]
```

There is one phase, so there is no concurrency group and no merge ordering beyond the planning
session's own pull request. The phase task is gated on this session so it cannot start before the
phase file it names exists on the default branch.

## Cross-phase contracts

With a single phase there are no inter-phase contracts. The contracts the phase must **preserve**
are inherited from the source plan and from
`docs/plans/native-worktree-management/phase-4-settings-worktree-operations.md`:

- Preview-first mutation: preview, server-supplied acknowledgement keys, opaque token, `409` as a
  stale preview rather than a failure.
- No `data-testid`; selection by role, label, and placeholder.
- The three `data-anchor` slugs keep resolving.
- Colour never carries state without a word beside it.
- Inventory stays out of `MissionState`; only `worktreesRevision` lives there.
- Lowering the maximum never prunes as a side effect.

## Final verification strategy

Owned by Phase 1 in full, since it is the only phase:

- `e2e/specs/settings-worktrees.spec.ts` extended to cover the loading, empty, and unavailable
  states, a populated pool's bar and legend counts, an over-capacity pool offering the prune
  preview, the disclosure into slot detail, and one preview-and-cancel round trip.
- `test/worktree-settings-panel.test.ts` extended with a `renderToStaticMarkup` case pinning the
  bar's segment widths and its composed `role="img"` label against a known inventory.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run test:e2e`.
- Screenshots of the pane loading, empty, populated, and over capacity, attached to the pull
  request rather than committed.
