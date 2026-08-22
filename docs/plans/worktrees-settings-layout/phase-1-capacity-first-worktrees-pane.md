# Phase 1: Capacity-first Worktrees pane

## Outcome

Settings > Worktrees reads as part of Mission Control, and answers the question an operator actually
brings to it - *do I have room, and what is holding the rest?* - in its first screenful.

Each pool gets a capacity bar whose track width **is** its configured maximum, so free capacity,
leased slots, quarantine, and overflow are all one glance. `Default maximum` stops being an
arbitrary number and becomes a value the operator can watch reflow every bar. The nine theme breaks
catalogued in the source plan are closed, and the pane's loading, empty, and unavailable states get
real copy instead of a heading over void.

**User-visible value:** the pane stops looking like a different application, and the one control it
has that was previously unreadable becomes readable.

## Entry criteria and direct phase dependencies

- **No phase dependencies.** This is the only phase.
- Gated on the planning session's pull request merging, so the documents named below exist on the
  default branch before the work starts.
- Re-read before starting:
  - [`plan.md`](plan.md) - the approved goal and the adopted direction.
  - [`phased-plan.md`](phased-plan.md) - sizing and why this is one phase.
  - `docs/plans/native-worktree-management/phase-4-settings-worktree-operations.md` - the safety,
    ownership, and preview contracts this pane must not weaken.
  - `e2e/README.md` before writing the spec.
  - `.agents/memory/MEMORY.md`.
- Read `src/web/components/HarnessesPanel.tsx` and the `.kb-row` / `.harness-card` / `.skill-badge`
  rules in `src/web/styles.css`. They are the house primitives this phase adopts, and reusing them
  verbatim is preferred over writing new equivalents.

## Scope

- Restructure `src/web/components/WorktreeSettingsPanel.tsx` to the capacity-first layout.
- Rewrite the `wt-` block in `src/web/styles.css` (lines 403-781) to the house style.
- Add the capacity bar component and its accessible text equivalent.
- Add loading, empty, and unavailable states.
- Extend `test/worktree-settings-panel.test.ts` and `e2e/specs/settings-worktrees.spec.ts`.
- Update any README or `docs/` prose that describes the pane's section names or ordering.

### Explicit non-goals

- **No changes to `src/shared/`, `src/server/`, routes, schemas, or the database.** Every input the
  bar needs is already on the wire; if this phase finds itself editing a server file, that is a
  signal to stop and re-check the assumption rather than to extend the contract.
- Do not change what any action does, what it sends, or which acknowledgements it requires. This is
  a presentation change over an unchanged mutation protocol.
- Do not opt out of the 900px measure. That was direction C, and it was not taken.
- Do not add `data-testid`.
- Do not change the `SETTINGS_CATEGORIES` entry or the three `data-anchor` slugs.
- Do not add a filterable cross-pool slot list. Slot detail stays behind the pool's disclosure.

## Repository findings and inherited contracts

Verified at `HEAD` while writing this plan. Treat these as starting facts, not as guarantees - check
them again, and record any that have moved.

- `src/shared/worktrees.ts:56-73` - `WorktreeRepositoryView` carries `policy.maxSlots` and
  `counts { total, leased, available, quarantined, overCapacity }`. The bar needs nothing more.
- `src/shared/worktrees.ts:71` - `status` is `"ready" | "attention" | "unavailable"`. The
  unavailable state is already representable.
- `src/web/useWorktrees.ts:32-45` - `WorktreesState` exposes `inventory`, `loading`, and `error`
  separately, so "still loading", "resolved to nothing", and "could not observe" are already three
  distinguishable conditions in the browser.
- `src/web/lib/settings-search.ts:175,184,193` - the anchors are `worktrees/policy`,
  `worktrees/native-pools`, `worktrees/legacy-drain`. Keep all three slugs. The Defaults group moves
  *below* the pools, so `worktrees/policy` moves with it; the slug does not change.
- `src/web/styles.css:100` - `--radius: 13px`. `.kb-row` uses `9px`, `.harness-card` uses `10px`,
  `.skill-badge` uses `5px`. Match the neighbour, not the root token, per element.
- `src/web/styles.css:26` - `--select` and `--idle` are both `#35c08a`. `--select` is the
  keyboard-selection accent and must not be used decoratively here.
- `test/worktree-settings-panel.test.ts` already builds a full `WorktreesState` fixture with an
  over-capacity, quarantined pool. Extend that fixture rather than writing a second one.

## Implementation steps

### 1. Rewrite the `wt-` CSS block

Replace `src/web/styles.css` lines 403-781. The block should get materially shorter, because most
of what it declares is now inherited from house primitives.

Delete outright: `.wt-intro`, `.wt-kicker`, the `.wt-overview` / `.wt-ledger` /
`.wt-legacy-counts` mono-tile rules, and the `.wt-section` `border-top`. Their jobs are taken over
by a lead paragraph, the bars, and plain spacing.

Correct across everything that remains:

- Give every boxed surface a radius matching its house neighbour. No square corners remain.
- Give the panel's sub-headings the house size: reuse `.settings-section-head` and size the heading
  to 12px / weight 600, as `.harnesses-subhead h4` does. Do not leave a heading unsized.
- Drop `--select` from the panel's palette entirely. Pool and slot tones come from `--idle`,
  `--working`, `--attention`, `--danger` only, and each is paired with a word.
- Make slot cards use the same **left** accent as repository cards and `.harness-card`. The
  `border-top` variant goes.

Add the capacity bar rules. Segments are flex children of a rounded track; leased, available and
quarantined are solid tone fills, room-to-grow is a hatched `repeating-linear-gradient` in
`--border`, and overflow is a hatched `--attention`. Keep the hatch angles identical so the two
hatched states read as the same idea in two tones. Respect `prefers-reduced-motion` if any
transition is added to the segments; a width transition on a data change is optional and must not be
the only cue.

### 2. Restructure the panel

In `src/web/components/WorktreeSettingsPanel.tsx`, the top-level `WorktreeSettingsPanel` becomes,
in order:

1. **Lead paragraph.** The safety promise as one `.settings-hint`-weight sentence, with the
   load-bearing clause in `<strong>`, in the shape `HarnessesPanel.tsx:285-288` uses. The tinted
   callout, the green kicker, and the three mono count tiles are removed - the counts they carried
   are now on the bars.
2. **Pools** (`data-anchor="worktrees/native-pools"`), with the Refresh button in the group head.
   Pools become full-width rows rather than a card grid, because the bar needs the width.
3. **Defaults** (`data-anchor="worktrees/policy"`), two `.kb-row`s, under a group head qualified
   *affects future acquisitions only*.
4. **Treehouse** (`data-anchor="worktrees/legacy-drain"`), last.

No numbered eyebrows. No rules between sections; separate them with space.

`RepositoryCard` becomes a pool row: tone dot, name, path in mono, a counts summary, the bar, the
legend, and the existing disclosure into slot detail and per-pool overrides. `SlotCard` and
`ActionDialog` keep their structure and only inherit the corrected tokens.

### 3. Build the capacity bar

A small local component taking the repository's `counts` and `policy.maxSlots`.

Geometry - derive it in one place and export it so the test can assert it directly rather than
scraping markup:

- The denominator is `max(maxSlots, counts.total)`. When a pool is within its maximum the track's
  full width is the maximum; when it is over, the track extends to the actual slot count so the
  overflow has somewhere to be drawn.
- Segments in order: leased, available, quarantined, then either room-to-grow
  (`maxSlots - total`, when positive) or overflow (`total - maxSlots`, when positive). Never both.
- Guard `maxSlots <= 0` and a zero denominator rather than emitting `NaN%`.

Accessibility, which is a requirement and not a polish item:

- Every segment's count is restated in the legend beneath the bar, as text.
- The bar takes `role="img"` with a composed label naming each count and the maximum - for example
  `8 leased, 4 available, 4 more may be created, maximum 16`.
- Over capacity is labelled with the words `over the maximum`. The amber hatching is never the only
  cue.
- The safe-prune affordance on an over-capacity row is a real button with an accessible name, not
  an icon.

### 4. Add the three states

Under the Pools group head, so the group is never a heading over nothing:

- **Loading** (`loading && !inventory`): skeleton rows - a name-width block and a full-width track
  block per row - plus the existing "Observing Git, process, and provider state…" hint.
- **Empty** (`inventory` resolved, `repositories.length === 0`): "No pools yet. Mission Control
  creates one the first time something needs a checkout in a repository." An invitation to act.
- **Unavailable** (`error`, or a repository whose `status` is `"unavailable"`): say that state could
  not be observed and offer Refresh. Never render this as zero pools - an outage and an empty pool
  set must not look alike.

For Treehouse: render the four classification counts only when at least one is non-zero. Otherwise
one dim sentence - "Nothing left to drain. All historical leases have been returned, and new work
never acquires Treehouse resources."

### 5. Update the documentation

Update whatever `docs/` prose names the pane's sections or their order, since `01 · Policy` /
`02 · Native inventory` / `03 · Legacy drain` cease to exist and Defaults moves below Pools. Search
`docs/` for those strings rather than assuming which file carries them. Documentation imagery, if
any is added, goes in `docs/images/` and is documentation - not evidence.

## Data, API, and compatibility details

None. This phase adds no field, changes no route, and runs no migration. The inventory contract,
the action protocol, the SSE invalidation, and `useWorktrees` are all consumed exactly as they
stand.

The one compatibility note is presentational: a pool whose `maxSlots` is smaller than its `total`
must render as over capacity, not as a full bar, and lowering the maximum must never trigger a
prune as a side effect. The bar makes the over-capacity state visible; it does not make it
self-correcting.

## Tests and verification

- **`test/worktree-settings-panel.test.ts`** - extend the existing fixture. Pin the bar's segment
  widths and its composed `role="img"` label for a within-maximum pool and for the over-capacity
  pool already in the fixture. Assert the `maxSlots <= 0` guard emits no `NaN`. Assert the three
  `data-anchor` values are still present. Assert the Treehouse counts are absent when all four
  totals are zero.
- **`e2e/specs/settings-worktrees.spec.ts`** - extend rather than replace. Cover: the loading
  state's skeleton and hint; the empty state's copy; the unavailable state offering Refresh; a
  populated pool's bar with its legend counts as text; an over-capacity pool exposing the safe-prune
  preview; the disclosure into slot detail; and one preview-and-cancel round trip proving the
  mutation protocol is unchanged. Select by role, label, and placeholder only. Keep every agent
  binary faked - this spec must never spend model tokens.
- **Electron geometry** - measure the pane below 760px. Overflow is the part most likely to
  regress, and no markup assertion can produce a used height.
- **Commands:** `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run test:e2e`.
- **Evidence:** screenshots of the pane loading, empty, populated, and over capacity. Produce them
  in a gitignored location and attach them to the pull request. Never commit them.

## Merge and exit criteria

- The nine breaks in the source plan's table are each closed, and `grep -c border-radius` over the
  new `wt-` block is greater than zero.
- No `--select` reference remains in the panel's styles.
- The pane renders correct loading, empty, unavailable, populated, and over-capacity states.
- All three `data-anchor` slugs still resolve through settings search.
- The preview-first mutation protocol is byte-for-byte unchanged in behaviour.
- Every command above passes; the e2e spec covers the new behaviour.
- Documentation matches the implementation; the worktree contains no unrelated edits.
- One pull request against `mancej-cyc/ai-harness`, green, reviewed, merged.

## Downstream handoff

There is no later phase. What a future change may rely on:

- The bar's geometry helper is the single place slot-count-to-width arithmetic lives. Reuse it
  rather than recomputing.
- The pane's section order is Pools, Defaults, Treehouse, and the three anchor slugs are bound to
  those groups in that order.
- The panel remains inside the 900px measure. Direction C - opting out for a master-detail
  inventory - was considered and deferred, and the capacity bar composes with it rather than
  blocking it. If pool counts keep growing, that is the documented next move.

## Cross-phase audit record

- **2026-08-21, initial.** Single-phase plan; no inter-phase contracts to reconcile. Audited against
  the source plan: all four submitted decisions are owned by this phase - direction B (steps 1-3),
  the callout demoted to the lead paragraph (step 2.1), empty and loading states (step 4), and the
  phased follow-up (this document). Audited against
  `docs/plans/native-worktree-management/phase-4-settings-worktree-operations.md`: no preview,
  ownership, or acknowledgement contract is modified, and the non-goals restate its `data-testid`
  and anchor constraints. Verified the plan's no-backend-work assumption directly against
  `src/shared/worktrees.ts` rather than inheriting it from the source plan.
