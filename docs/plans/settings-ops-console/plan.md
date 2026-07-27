# Extending the settings console to Foreman and Workflows

The Inspector and Shipping panels were redrawn as an **ops console** - controls in a narrow
column, a per-item ledger in a wide one, under a strip of counts whose tiles are the
filters (PR #283, `src/web/components/outbound-console.tsx`). This plan takes that shape to
the two remaining subsystem panels, **Foreman** and **Workflows**.

It is deliberately not "apply the same layout twice". Investigating the two panels against
the repository turned up one finding per panel that changes what the work is:

- **Foreman's ledger data exists and is unreachable.** `foreman_episodes` holds a rich,
  append-only row per decision - disposition, author, tier, confidence, classification,
  resolution latency - and the only read path is `GET /api/sessions/:id/foreman-episodes`,
  one session at a time. There is no cross-session query anywhere.
- **Foreman's `shadow` cheap tier measures nothing you can read.** The panel offers
  *"Shadow - run the cheap tier alongside, measure it"*, the worker computes a typed
  `Divergence`, and the entire sink is `console.log`. It is not persisted, not routable,
  and cannot even be inferred from the episode row, because `shadowBoth` returns
  `tier: 2` for every shadow decision. This is strictly worse than the Inspector's dry run,
  which at least stored its findings and merely rendered them badly.
- **Workflows must NOT get a ledger.** `src/web/workflows/WorkflowRuns.tsx` (~1,560 lines)
  is already a run list with paging, SSE reconciliation, per-run actions and status filter
  chips, reachable from the Workflows page. A run table in the settings panel would be a
  second, worse copy of it, and the Workflows page header already links to these settings.
  What Workflows is missing is different, and named in Phase 2.

## What the shape actually is

Stating this precisely matters, because the two panels adopt different amounts of it and a
future panel will need to know which parts are load-bearing. The console is **three
separable things**:

| # | Piece | What it needs to be honest |
|---|---|---|
| 1 | **The shared leaves** - `ConsoleCard`, `ConsoleSwitch`, `ConsoleState`, the `sc-` class vocabulary | Nothing. Any settings panel can adopt these. |
| 2 | **The count strip** - tiles that are also the filter | Rows to filter, and a `bucket()` function every row lands in exactly once, so the tiles sum to the rows. |
| 3 | **The two-column split** - controls narrow, ledger wide | A ledger genuinely worth the width, that no other surface already owns. |

Foreman takes all three. Workflows takes 1, a **variant** of 2, and not 3. A panel with no
ledger keeps its single column; giving it a wide empty half to look like its neighbours
would be the layout imitating a shape rather than expressing one.

### The strip's contract, and the one place it is deliberately broken

On Inspector and Shipping the tiles are derived from the rows (`inspectionTallies` is a
fold over `inspectionBucket`), which is what makes "3 blocked" and the three rows you get
when you click it the same question asked once. `settings-console.test.ts` pins that every
bucket has a tile, after the first cut shipped a strip that ignored 49 rows out of 50.

Workflows has no rows in this panel, and its numbers are fleet-wide SQL scalars from
`WorkflowStatus`. Its tiles therefore **navigate** (to the Workflows page's run list,
using the nearest corresponding view and a status filter where one exists) instead of
filtering in place, and they do **not** claim to sum to anything. That difference has to be
visible in the code - a separate component, not an extra boolean on the existing one - or
the next person to touch it will "fix" the missing tally and be wrong.

## Decisions

**D1 - the vocabulary is renamed once, in Phase 1.** Before Phase 1 the module was
`outbound-console.tsx` and its classes were `oc-`, justified in its own header as *"the two
categories whose writes leave this machine"*. Foreman and Workflows are `machine`-scoped
(`SETTINGS_CATEGORIES`), so that name stops being true the moment either adopts it. Phase 1
renames the module to `settings-console.tsx`, the classes to `sc-`, and the test to
`settings-console.test.ts`; Phase 2 must not repeat the rename.

**D2 - Foreman's ledger gets one new read path, modelled on the Inspector's.**
`recentEpisodes(limit)` in `db.ts` + `GET /api/foreman/episodes`, the direct analogue of
`loadInspectorInspections(50)` + `/api/inspector/prs`. Not a new table, not SSE - the
registry's existing comment explains why episodes stay off the live channel (*"a card
carrying every pane it ever saw would put a screen capture into every SSE frame"*), and that
reasoning holds for a 4s poll too.

**D3 - the shadow measurement is persisted, in Phase 1, and is the reason that phase is not
just a UI change.** A mode whose stated purpose is measurement, that spends a second model
call per decision to produce it and then writes it to stdout, is a feature that does not
exist for anybody who is not tailing the worker. Two columns on `foreman_episodes` and the
three lines in `shadowBoth` that stop discarding the cheap verdict close it. If a reviewer
wants Phase 1 smaller, this is the seam to cut on - ship the ledger reading `tier` alone -
but then `shadow` stays unreadable and the panel keeps promising a measurement it does not
take.

**D4 - Workflows depends on Foreman.** Not because the subject matter overlaps but because
Phase 1 owns the rename and the generalization of the shared leaves. Run them concurrently
and they conflict in `settings-console.tsx` and `styles.css`.

## Phases

| Phase | File | Outcome | Direct prerequisites |
|---|---|---|---|
| 1 | [`phase-1-foreman.md`](phase-1-foreman.md) | Foreman becomes a console with a real episode ledger; shadow mode becomes readable; the shared vocabulary is generalized | PR #283 (this planning session's task) |
| 2 | [`phase-2-workflows.md`](phase-2-workflows.md) | Workflows adopts the shared leaves, a navigating health strip, and a retention readout against real history | Phase 1 |

```
PR #283 (console shipped)
        │
        ▼
   Phase 1 - Foreman  ──►  Phase 2 - Workflows
   (owns the rename)       (consumes the generalized leaves)
```

No concurrency: two phases, one edge. The graph is a line because the rename is a
whole-file rewrite of a module both phases import.

## Constraints both phases inherit

- **Anchors are a public contract.** `settings-search.ts` points at `foreman/cheap-tier`,
  `foreman/provider`, `workflows/live-delivery`, `workflows/allowlist`,
  `workflows/retention`, `workflows/health`, and `settings-sidebar-render.test.ts` fails on a
  duplicate anchor or one whose prefix is not a real category. `ConsoleCard` takes an
  `anchor` prop for exactly this reason. Every existing anchor must survive the rewrite,
  including the per-model ones (`foreman/model-*`, `foreman/backlog-model-*`).
- **`null` config is "unknown", never "off".** Both panels already say so
  (`.wf-settings-unknown`, and Foreman's absence of one is a gap Phase 1 closes). The
  posture line renders `unknown` before the daemon answers; disabled inputs are not a
  statement about what is running.
- **The daemon reports resolutions the browser cannot see.** Foreman's provider is
  `config?.runner ?? status?.runner ?? "claude"` because an unset runner falls through an
  env layer the browser has no access to. Do not simplify that to `config || default`.
- **`ModelField` is the model control**, everywhere, unchanged: a `<select>` over
  `modelChoicesFor(runner, value)` filtered by the provider above it. Foreman has seven of
  them and they stay seven.
- **Style rules go in the matching section of `styles.css`**, and a removed `className`
  means grepping that file in the same change. There is no unused-CSS check.
- **README in the same change.** The settings-page section already describes the console
  shape and says it is Inspector and Shipping; each phase updates that sentence and its own
  subsystem's section.

## Verification strategy

Each phase runs `npm run typecheck`, `npm test`, `npm run build`, and is checked in the
running app against the live daemon at 1500px and below 1080px - the two widths where the
split behaves differently. Static-markup tests (`renderToStaticMarkup`, no jsdom) are the
house pattern for panels; the existing suites that must keep passing are
`foreman-settings-render.test.ts`, `workflow-settings-panel.test.ts`,
`settings-sidebar-render.test.ts`, `settings-search.test.ts` and `settings-console.test.ts`
(renamed with its module).

**Verify against a real ledger, not a fixture.** Both defects found while building the
first two panels - a strip that ignored 49 of 50 rows, and an empty state that read "No
pull request is findings right now" - were invisible in tests and obvious the moment the
panel was pointed at the daemon's actual data. Neither phase is done on the strength of its
diff.

## Non-goals

- A run table in the Workflows settings panel. See Phase 2; `WorkflowRuns.tsx` owns that.
- Putting Foreman on the SSE channel. `SettingsStatus` excludes it deliberately.
- Touching the topbar Foreman popover, which owns the in-the-moment knobs (enable, mode,
  work queues, on-drain) while the panel owns the durable posture.
- Retiring `.sc-` in favour of a general design system. This is two panels adopting
  one existing shape, not a token overhaul.
