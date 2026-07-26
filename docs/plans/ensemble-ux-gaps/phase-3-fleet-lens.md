# Phase 3 - Fleet Lens: clusters, state-rich marks, badges

## 1. Outcome and value

The ensemble becomes legible where the operator already looks. Board columns and the console rail group sibling members under a live run header (title, strategy, stage word, progress dots, attention rollup, deep link); the grid sorts siblings adjacent; every ensemble mark (chip, tile flag, rail glyph) becomes stage- and blocked-aware; the Ensembles tab gets an attention badge; run list rows finally render the progress counts the SSE summary carries; the run detail header replaces the raw `activeStageId` code with the shared stage word. Closes G1-G3, G5 (badge half), G6 (vocabulary half), and the fleet half of G11/G13.

## 2. Entry criteria and dependencies

- Direct prerequisites: Phase 1 (consumes `membersNeedingInput`, `needsInput`, `ensembleStageWord`). Independent of Phase 2.

## 3. Scope and non-goals

In scope: layout ordering + cluster rendering (board, console rail, grid adjacency), session-bits marks, tab badge, list-row progress, detail-header stage word, CSS, tests, README. Non-goals: a topbar chip (deliberately deferred - Phase 4's attention inbox owns the topbar surface, so this phase does not build a chip that phase would delete); any grid group FRAME (see 4, nav risk); inline answering (Phase 5); any change to `groupByTone`'s empty-groups contract.

## 4. Repository findings this phase is built on (verified 2026-07-26)

- All three layouts consume the same `SessionViewProps` bundle (`App.tsx:1550-1552`; `layouts/types.ts:16-135`, "layouts render exactly these"); `onOpenEnsemble` already exists (`types.ts:129-134`). New layout-visible data goes on `SessionViewProps`, never an individual view.
- Grid order is App-owned (`App.tsx:542-548` tone sort) and grid arrow-nav is GEOMETRIC: `layoutNav.ts:44-55` walks `idx ± cols` against the live CSS track count via `gridRef` (`GridView.tsx:8-13`). Any header cell or multi-track frame breaks Up/Down silently. Therefore the grid gets adjacency sorting only, no frame.
- Board arrow-nav indexes flat per-column id arrays built by `App.tsx:629-632` from `groupByTone(visible, gateAlerts)`, contractually aligned with `BoardView.tsx:79`'s own `groupByTone` call (`tone.ts:37-49`). Clustering REORDERS tiles within a column (siblings are currently name/pid-sorted apart), so both sites must derive from one shared ordering function or Up/Down desyncs.
- Board tile list is a flat `.map` at `BoardView.tsx:232-252` inside `.board-col-body` - the natural wrap point; tiles are drag-drop targets (`draggingRepo`, `onDropConfirm`), so a wrapper must not intercept dragover.
- Console rail: `ConsoleView.tsx:23` drops empty groups; `.rail-group` headers (`:36-58`) are the precedent for non-session rows; rail nav (`layoutNav.ts:33-42`) walks session ids only, so header rows are nav-safe.
- Marks live in `session-bits.tsx:238-380` (`EnsembleChip`, `EnsembleTileFlag`, `EnsembleRailMark`), tone via `ensembleMemberTone`, labels via `ensembleMemberStateLabel`; all read `session.task.ensemble` (a `TaskEnsembleLink`). `session-leaf-parity.test.ts` pins the four drawings.
- The run list rows and filters: `src/web/workflows/EnsembleRuns.tsx:60-70` (attention-first sort exists; no counts rendered). Detail facts including the raw stage `<code>`: `src/web/ensembles/EnsembleDetail.tsx:167-228`.
- CSS section homes: grid cluster rules after `/* ---- grid ---- */` (`styles.css:1236`); board cluster rules as a new `/* ---- */` sub-section inside the board block (before `.board-tile` at `:12511`); rail additions near `.rail-group` (`:11162`); mark tweaks near `.ensemble-chip` (`:124`). No vendor names, no new floating layers (nothing here trips `desktop-drag-region.test.ts`).

## 5. Implementation steps

1. **Shared ordering** - new `src/web/lib/fleet-order.ts`: `orderSessions(sessions, gateAlerts)` returns the display order with sibling members adjacent within their tone group (cluster anchored at the position of its highest-priority member; members sorted by ordinal inside), plus the cluster spans `{ runId, startIndex, length }[]` per tone. Board and grid and rail all consume it. Rule it must keep: a cluster never crosses a tone boundary - a blocked member sits in the attention region with its cluster header repeated, rather than dragging working siblings into "needs you" (the column's meaning wins; the header's rollup line is what ties them back together).
2. **Props** - add `ensembleSummaries: EnsembleSummary[]` (or a `Map<string, EnsembleSummary>`) to `SessionViewProps` and `viewProps` in App; App already holds them (`useEventStream`).
3. **App ordering** - `App.tsx:542-548` (`sorted`) and `App.tsx:629-632` (`boardColumns`) both switch to `orderSessions`, so nav arrays and rendered order stay one fact.
4. **BoardView** - group the per-column `.map` by the cluster spans: members render inside a `.board-cluster` frame with a header row (`⧉ title · strategyLabel · ensembleStageWord(summary) · progress dots · "N needs you" when membersNeedingInput > 0`); header click calls `onOpenEnsemble(runId)`. The frame is presentational (a bordered wrapper + header div); tiles keep their exact props and DOM order; dragover passes through (no handlers on the wrapper).
5. **Progress dots** - one shared leaf `EnsembleProgressDots` in `session-bits.tsx` (per the shared-leaf rule): renders `maxMembers` squares from summary counts with a fixed precedence so no member is double-counted - `out` (from `membersOut`: failed/withdrawn/eliminated), then `blocked` (`membersNeedingInput`), then `done` (`readyArtifacts`), then `working` (`launchedMembers` minus the above, floored at 0), then `pending` (remainder to `maxMembers`). The counts are aggregates, not an ordered member list, so the dots claim only how MANY members are in each disposition, never which ordinal - the tooltip says so. Used by the board cluster header and the run list row.
6. **ConsoleView rail** - insert a `.rail-ensemble-group` header row per cluster span (title + stage word + dots), styled beside `.rail-group`.
7. **Marks** (`session-bits.tsx`) - `ensembleMemberStateLabel` prefers `needsInput` ("needs an answer", attention tone) over the status ladder; `EnsembleChip` gains the run-progress suffix ("· 3/5 in") from the link's `launchedMembers`/`maxMembers` plus summary `readyArtifacts` when the summary map is reachable (card surfaces receive it via props; where only the link is available, the link's counts suffice); `EnsembleRailMark` gains the tone class; `EnsembleTileFlag` renders `E 3/5`. Tooltip keeps the existing sentence plus the blocked note.
8. **Ensembles tab badge** - `WorkflowPage` tab label gains a count of `summaries.filter(s => s.attention).length` (threaded the same way `EnsembleRuns` already receives summaries).
9. **Run list rows** (`EnsembleRuns.tsx`) - add `EnsembleProgressDots` and a `readyArtifacts/launchedMembers/maxMembers` counts line; "N needs you" when `membersNeedingInput > 0`.
10. **Detail header** (`EnsembleDetail.tsx:167-228`) - the Active stage fact renders `ensembleStageWord` as the visible value with the raw `activeStageId` demoted to the `<code>` beside it (the timeline keeps full internals).
11. **CSS** - new rules in the section homes listed in 4; tokens only, accents via existing vars.

## 6. Data / compatibility

No wire changes (consumes Phase 1's fields). `SessionViewProps` addition follows the layouts contract. No Session field is added (no `SESSION_FIELD_COMPARATORS` entry needed).

## 7. Tests and verification

- New `test/fleet-order.test.ts` (comment: what is at stake is keyboard nav and rendered order staying one fact): siblings adjacent within tone; cluster never crosses tones; output order stable and total; board column id arrays derived from it match the rendered sequence.
- Extend `test/session-leaf-parity.test.ts` for the four marks' new states (blocked label, tone class, progress suffix) - it pins all four session drawings.
- Board render test (renderToStaticMarkup): cluster header renders title/stage word/dots; tiles inside keep order; a blocked member's cluster header shows "1 needs you".
- Rail render: header row present, not focusable as a session.
- `EnsembleRuns` row render: dots + counts; `ensemble-page-render` updated if it snapshots the detail facts.
- Grep `styles.css` for any removed/renamed className in the same change (house rule).
- Commands: `npm run typecheck`, `npm test`; manual: all three layouts opened, arrow-nav walked across a cluster in board and grid, drag-drop onto a clustered tile.

## 8. Merge and exit criteria

Suite green; every shortcut works in every layout (README invariant), verified manually for board arrow-nav across cluster boundaries and grid Up/Down with adjacency sort; README's layout section gains a paragraph on ensemble clusters; `docs/ensembles.md` "layout signals" section updated.

## 9. Downstream handoff

Later phases may rely on: `orderSessions` as the one fleet ordering; `EnsembleProgressDots` as the one progress leaf; marks reading `needsInput`; the tab badge; the absence of a topbar ensemble chip (Phase 4 owns the topbar). They must not: reorder board columns outside `orderSessions`, or introduce a second progress rendering.

## 10. Cross-phase audit record

- 2026-07-26 (round 2): dot formula reworked onto Phase 1's new `membersOut` aggregate with explicit precedence, after PR #263's Inspector showed the count-only formula rendered a failed member as working. Phase 1 owns the field; this phase owns the precedence.
- 2026-07-26: initial version. Two reconciliations against the source plan's Solution A: (a) the grid gets adjacency sorting, not a frame - grid arrow-nav is geometric off live CSS tracks and a frame breaks it silently; (b) the topbar ensemble chip is removed from this phase and ceded to Phase 4's inbox, so no interim chip is built and then replaced. Clusters do not cross tone boundaries - the source plan's "cluster lives in the column of its worst tone" was revised: moving working siblings into "needs you" would dilute that column's meaning, which `tone.ts` treats as load-bearing.
