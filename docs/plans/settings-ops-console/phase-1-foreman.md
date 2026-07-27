# Phase 1 - Foreman becomes a console, and shadow mode becomes readable

Source plan: [`plan.md`](plan.md). Direct prerequisite: PR #283 (the planning session's
task), which shipped `outbound-console.tsx` and the Inspector/Shipping consoles.

## Outcome

**Settings → Foreman** stops being a seven-field form and becomes a console: posture and
knobs in the narrow column, a fleet-wide **episode ledger** in the wide one, under a count
strip whose tiles filter it. Two things become visible that no surface in the app shows
today:

1. **Whether Foreman is actually running.** `ForemanStatus.running` ("a leader holds the
   lease and renewed it recently") is already polled every 4s by `useForeman` and rendered
   nowhere. A Foreman whose worker is dead looks exactly like one that is idle.
2. **What the cheap tier decided, and whether it was right.** `shadow` mode's whole purpose.

## Scope

In:

- `recentEpisodes(limit)` in `db.ts` + `GET /api/foreman/episodes`.
- Two columns on `foreman_episodes` carrying the shadow comparison, written by the worker.
- The Foreman panel redrawn as a console, with the ledger, strip, posture line and health.
- The rename of the shared module and class vocabulary (D1) - **this phase owns it**.

Out:

- The topbar Foreman popover (`ForemanBar.tsx`), which owns the live knobs. Untouched.
- `ForemanDrawer` / `ForemanEpisodeCard` / the transcript's episode interleaving. The new
  ledger is a fleet-wide index; those stay the per-session reading surfaces.
- Any change to what Foreman decides. This phase reports; it does not re-tune.

## Repository findings this phase is built on

Verified against the tree at the time of writing:

- `ForemanState` (`src/web/useForeman.ts`) is `{ config, status, backlogPlan, update, error }`,
  polling `/api/foreman/config`, `/api/foreman/status` and `/api/backlog/plan` on a 4000ms
  tick. It carries **no** per-decision history.
- `ForemanEpisode` (`src/shared/types.ts`) already carries everything a ledger row wants:
  `createdAt`, `resolvedAt`, `disposition` (`answered | pending | escalated | skipped`),
  `sentBy` / `resolvedBy` (`foreman | you`), `tier` (0 structural, 1 cheap, 2 full review),
  `confidence`, `classification`, `situation`, `surface`, `question`.
- Storage is `foreman_episodes` (`src/server/db.ts`), unique on `(note_key, marker)`, indexed
  on `(note_key, created_at DESC)`. Written by the worker over
  `POST /api/sessions/:id/foreman-episode`; built by `episodeFromPlan()`
  (`src/server/foreman/verdict.ts`). Pruned at 30 days (`EPISODE_RETENTION_MS`).
- The **only** read is `episodesFor(noteKey, limit)` - `WHERE note_key = ?`. Nothing in
  `db.ts` selects across `note_key`.
- `shadowBoth()` (`src/server/foreman/worker.ts`) runs `triageSession` and `fullReview`
  concurrently, calls `classifyDivergence(cheap, r.verdict)` -> `Divergence` =
  `deferred | agree | cheap-over-eager | cheap-too-cautious | minor`, passes it to `log()`
  (which is `console.log`), and returns `{ verdict: r.verdict, tier: 2 }`. The cheap tier's
  own verdict is discarded on that line. `classifyDivergence` has exactly one non-test call
  site.
- `ForemanStatus` already carries `running`, `queueDepth`, `counts`, `lastActionAt` and
  `autopilot.*`; the panel reads only `runner` and `models`.
- **`status.counts` is scoped to LIVE sessions on purpose** (`src/server/foreman/config.ts`),
  because `registry.listNotes()` rehydrates every note ever stored. It is therefore *not*
  the ledger's tally and must not be used as one - see the strip rule below.

## Implementation

### 1. The shared vocabulary (do this first, in its own commit)

Rename `src/web/components/outbound-console.tsx` -> `settings-console.tsx`, the `oc-` class
prefix -> `sc-`, and `test/outbound-console.test.ts` -> `settings-console.test.ts`. Update
the three importers (`InspectorSettingsPanel`, `ShippingSettingsPanel`, and the test) and
the `styles.css` section header, whose comment currently argues the "outbound" framing -
rewrite it to argue the *shape* (a panel with a ledger), which is what is actually shared.
Mechanical: 89 class occurrences in `.tsx`, 94 rules in `styles.css`. `npm test` must be
green on this commit alone, with no visual change to either shipped panel.

Generalize two leaves while you are there:

- `PrLink` is PR-specific. Leave it, and add a sibling for an episode row's identity
  (session name + relative time), rather than widening it into something that takes a
  discriminated union.
- `ConsoleStat.tone` gains no new values. Foreman's four dispositions map onto the existing
  `attention | danger | ok | plain`.

### 2. The cross-session read

- `recentEpisodes(limit = 100): ForemanEpisode[]` in `db.ts`, ordered `created_at DESC, id DESC`,
  reusing `episodesFor`'s row mapper (including its per-field `?? 0` defence).
- **Add the index it needs**: `(created_at DESC)`. It goes in `migrate()`, not beside the
  `CREATE TABLE` - the create block runs before `migrate()`, and this is the rule
  `idx_tasks_schedule` exists to demonstrate. Test seeds a pre-feature database.
- `GET /api/foreman/episodes` in `routes.ts`, beside the other `/api/foreman/*` routes,
  returning `recentEpisodes(100)`. Modelled on `GET /api/inspector/prs`.
- `fetchForemanEpisodes()` in `src/web/lib/api.ts`; add it to `useForeman`'s existing
  `Promise.all` tick so it lands in the same 4s poll rather than a second timer. Extend
  `ForemanState` with `episodes: ForemanEpisode[]`.

### 3. The shadow measurement

- `addColumn(d, "foreman_episodes", "cheap_action", "TEXT")` and
  `addColumn(d, "foreman_episodes", "divergence", "TEXT")` in `migrate()`. Nullable, because
  every row written before this phase has no answer and `off`/`on` postures never produce
  one - `null` is "not measured", which is a different claim from "agreed".
- `shadowBoth` keeps the cheap outcome: return it alongside the verdict instead of dropping
  it after `log()`, and thread it into `episodeFromPlan` so the row carries
  `cheapAction` + `divergence`. The `log()` line stays - stdout is still useful - but it
  stops being the only sink.
- `ForemanEpisode` gains `cheapAction: string | null` and `divergence: Divergence | null`.
  `Divergence` moves to `@shared/` (it is currently in `src/server/foreman/triage.ts`) so
  the browser can name the values; the classifier itself stays server-side.
- **Do not** change `tier` for shadow decisions. It honestly reports which tier produced the
  verdict that was *used*, and that is 2 under shadow. The new columns carry the other half.

### 4. The panel

Left column, in order:

- `ConsoleCard "Foreman"` with a `ConsoleSwitch`? **No** - the enable switch lives in the
  topbar popover and stays there. The card's action slot is empty; the card carries the
  `ConsoleState` posture line instead, which is the honest split: this panel is the durable
  posture, not the live control. State reads from `status`: `unknown` (no config), `danger`
  when `enabled && mode === "live"`, `attention` for `semi-auto`/`dry-run`, `off` when
  disabled - **and `danger`-toned "not running" when `status.running === false` while
  `enabled` is true**, which outranks the mode, because a mode nothing is executing is not
  the fact you need first.
- Cheap tier: the three-way radio, as a `ConsoleSwitch`-style segmented control
  (`sc-seg`), keeping `data-anchor="foreman/cheap-tier"` and the full `TIER_LABEL` sentence
  as the selected-mode description beneath, exactly as Inspector's mode control does.
- Models: provider `<select>` + the four `FOREMAN_MODEL_ROLES` `ModelField`s, then the three
  backlog-launch fields in a second card. All seven anchors preserved. `ModelSuggestions`
  keeps its place above the group.
- Live repositories: `TrustGrantSummary`, unchanged, `data-anchor="foreman/live-repos"`.
- Health card: `running`, `queueDepth`, `lastActionAt` (through `ago()`), and the autopilot
  tuple. Read off `ForemanStatus`, which is already polled.

Right column - the ledger, `data-anchor="foreman/episodes"` (a new anchor; add it to
`settings-search.ts` with keywords "episode, decision, answered, escalated, shadow"):

- `episodeBucket(row)` -> `answered | escalated | pending | skipped`, one row lands in
  exactly one, mirroring `inspectionBucket`. Export it, plus `episodeTallies` folded over
  it, plus `FOREMAN_STRIP_BUCKETS`, so the "every bucket has a tile" test can be written the
  same way. **The strip is computed from the ledger rows, never from `status.counts`** - the
  two are different populations (historical vs live-sessions-only) and would visibly
  disagree.
- Columns: session/`noteKey`, the ask (`askPreview`-style truncation, reuse what
  `ForemanDrawer` uses), disposition, who decided (`resolvedBy`), tier, and `ago(createdAt)`.
- When the cheap tier is not `off`, a **shadow column**: `divergence`, with
  `cheap-over-eager` in the danger tone - the doc on `classifyDivergence` says it is *"the
  one that matters: the cheap tier would have auto-answered where Opus would not - that must
  stay near zero before flipping to `on`"*. Rows written before this phase, and rows from a
  posture that takes no measurement, render blank rather than "agree".
- Empty state: written out per bucket, not composed from the bucket id.

## Tests

- `foreman-episodes-db.test.ts`: `recentEpisodes` orders across sessions and respects the
  limit; the new index and columns land on a **pre-feature** database seeded before
  `migrate()` (the `schedule-db.test.ts` pattern), which is the only way the CREATE-block
  ordering bug shows up.
- `foreman-shadow-divergence.test.ts`: `shadowBoth` persists the cheap action and the
  divergence; an `off`/`on` posture writes `null` for both; `tier` still reports the tier
  that produced the used verdict.
- `foreman-console.test.ts`: every bucket has a tile and the tiles sum to the rows; the
  strip is not `status.counts`; the posture line says "not running" when
  `running === false` and enabled; all seven model anchors and the three existing panel
  anchors are present; `null` config renders "unknown", not "off".
- Keep `foreman-settings-render.test.ts` passing; update only what the markup genuinely
  changed.
- `settings-console.test.ts` (renamed) must be green on the rename commit alone.

## Exit criteria

- Foreman's panel shows a fleet-wide episode ledger with a working filter, verified against
  the live daemon with real episodes - not a fixture.
- Turning the cheap tier to `shadow` and letting Foreman answer something produces a row
  with a divergence you can read in the panel.
- `npm run typecheck`, `npm test`, `npm run build` green; README's settings-page section and
  Foreman section updated in the same change.

## Downstream handoff

Phase 2 may rely on: `settings-console.tsx` and the `sc-` vocabulary being the final names;
`ConsoleCard`'s `anchor` prop; `ConsoleState`'s five tones; and the rule that a strip
derived from rows must sum to them. Phase 2 must **not** rename anything in this module, and
must not assume Foreman's ledger route generalizes - it is Foreman-specific by design.
