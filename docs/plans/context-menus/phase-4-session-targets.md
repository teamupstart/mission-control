# Phase 4 - The triage surfaces: branch, checkout, session id, PR

Source plan: [`plan.md`](plan.md) · Index: [`phased-plan.md`](phased-plan.md)

## Outcome

Right-click a session anywhere it is drawn - the fleet card, the board tile, the console rail
row - and copy the thing you were about to select by hand: its branch, its checkout path, its
id, its pull request.

`SessionTile.tsx:27-36` already carries the comment *"Copying a branch name off a tile is a
fair thing to want on a triage board"*, and defends it with `isDragSelection` so that ending a
drag-select does not open the session. This phase is that instinct finished.

## Entry criteria and dependencies

**Direct dependency: Phase 2.** Consumes `resolveContextActions`, the `ContextTarget` shape,
the tier ordering, the dedupe rule and the host.

**Independent of Phase 3.** Different components, different registry entries, and Phase 3
deliberately narrowed its path matcher to transcript elements so this phase owns the card's
branch-before-path ordering outright. The two may merge in either order.

## Scope

- Tier 2 *session*: `Open` · `Copy branch` · `Copy checkout path` · `Copy session id` ·
  `Copy PR URL`, across all three drawings.
- Tier 1: branch and checkout-path elements on those surfaces.
- One `e2e/specs/` spec.

**Non-goals**

- Task and queue items (`.bl-card`, `.wq-item`) - in the source plan's registry but outside
  decision **D3**'s v1 scope. One registry entry each when wanted.
- Diff and Files - deferred by **D3**.
- No change to what a left-click does, and no change to `isDragSelection`.

## Repository findings

**One session, three drawings**, all fed from the same `Session`:

| Drawing | File | Root markup |
| --- | --- | --- |
| Fleet card | `src/web/components/SessionCard.tsx:273-278` | `article.card.tone-{tone}[data-agent]` |
| Board tile | `src/web/components/layouts/SessionTile.tsx:127-133` | `div.tile.tone-{tone}` |
| Console rail row | `src/web/components/layouts/RailRow.tsx:105` | `.rail-row.tone-{tone}` |

One tier-2 target should serve all three by matching the union, rather than three entries that
can drift.

**The data is on the session object.** `src/shared/protocol.ts` carries `cwd`, `branch`, and
both `prUrl` and `prUrls` - the latter added for multi-repo tasks, where a card's single chip
shows `prUrl` while the agent may have opened one PR per repository. `Copy PR URL` should
follow the chip: copy what the card is showing.

**The branch element is `dd.mono.branch`** (`SessionCard.tsx:415-420`), i.e. it carries *both*
`mono` and `branch`. A path matcher written as `.card-meta dd.mono` would therefore claim it.
**Register the branch matcher before the path matcher**, and scope the path matcher with
`:not(.branch)`. Phase 3 left `.card-meta dd.mono` unclaimed precisely so this ordering lives
in one phase.

Other markups for the same facts: `SessionTile.tsx:305` `span.tile-branch`,
`ConversationTerminal.tsx:185-190` `span.pty-stat.pty-branch`, and the cwd shortening helpers
`shortenCwd` / `repoLeaf` / `promptPath` in `src/web/lib/format.ts:223-254` - so here too the
visible path is not the pasteable one and `Copy checkout path` must copy the full `cwd`.

**Selection already matters on these surfaces.** `SessionTile.tsx:34-36`:

```ts
export function isDragSelection(sel: { isCollapsed: boolean } | null): boolean {
  return sel != null && !sel.isCollapsed;
}
```

and the tile's `onClick` returns early when it is true. The context menu must not disturb this:
Phase 2's rule is that a right-click **inside** a selection preserves it and one **outside**
collapses it, and neither should cause a card to open.

**`.pr-chip` is an anchor**, so Phase 2's link target already offers `Copy URL` on it; the
tier-2 `Copy PR URL` carries the same string and Phase 2's dedupe collapses the pair. That is
the dedupe rule working as intended, and the spec below should pin it.

## Implementation steps

1. **Tier 2 - session.** One registry entry matching `article.card, .tile, .rail-row`,
   resolving the session from the element (the card already carries `data-agent`; add a
   `data-session-id` in the same house style as Phase 3's `data-turn-id` rather than parsing
   anything out of the DOM).
   - `Open` - the existing open/expand action for that surface.
   - `Copy branch` · `Copy checkout path` (full `cwd`) · `Copy session id` · `Copy PR URL`
     (omit when there is no PR).
2. **Tier 1 - branch**, matching `.branch, .tile-branch, .pty-branch`, registered **before**
   the path matcher.
3. **Tier 1 - checkout path**, matching `.card-meta dd.mono:not(.branch)` and the tile's path
   element: `Copy path` (as shown) · `Copy absolute path` (the full `cwd`).
4. Confirm the six-item cap still holds on the busiest case - a right-click on the PR chip
   inside a card yields tier 1's three link rows plus tier 2's rows minus the deduped
   `Copy PR URL`.

## Tests and verification

- **`test/context-actions.test.ts`** (extends Phases 2-3): a card's branch resolves to
  `Copy branch` and **not** to the path actions; the checkout path resolves to path actions;
  the PR chip's `Copy URL` and the session's `Copy PR URL` collapse to one; the cap holds.
- **`e2e/specs/session-context-menu.spec.ts`** - dispatch a session, `settled(card)`, then
  right-click the branch line and assert `Copy branch` writes the branch. Grant clipboard
  permissions inside the test and read back, per `workflow-run-audit.spec.ts:243-250`. Select
  by role: `getByRole("menu", ...)` → `getByRole("menuitem", ...)`; no `data-testid`.
  - Assert a right-click on a tile does **not** open the session - the `isDragSelection`
    guarantee must survive.
  - `e2e/fixtures/fake-agents.ts` `writeGhPullRequests` seeds a PR if the spec covers
    `Copy PR URL`.

Commands: `npm test`, `npm run typecheck`, `npm run lint`,
`npm run build && npm run test:e2e -- e2e/specs/session-context-menu.spec.ts`.

## Merge and exit criteria

- Branch, checkout path, session id and PR URL are one right-click away on card, tile and rail
  row.
- Right-clicking a tile never opens the session.
- The branch line yields `Copy branch`, never `Copy absolute path`.
- Unit, typecheck, lint, build, and the new e2e spec green.

## Downstream handoff

Nothing depends on this phase. Task/queue items, diff and Files are each one registry entry
plus a test when they are wanted, following the matchers here.

## Cross-phase audit record

- Authored after Phases 1-3. Consumes Phase 2's resolver only; no dependency on Phase 3.
- **Reconciled with Phase 3:** Phase 3's path matcher was narrowed to transcript elements
  (`a.workspace-path`, `.pty-cwd`, path-shaped tool details) so this phase owns
  `.card-meta dd.mono` and its branch-before-path ordering. Verified that neither phase
  registers a matcher the other must reorder, which is what lets them merge in either order.
- Confirms the six-item cap is unbreached by the PR-chip case, the busiest menu in the plan.
