# Phase 2: The Runs page Pipelines tab

## Outcome

The Runs page gains a page-level kind tab - Workflows | Pipelines. The Workflows tab is today's
Runs page, unchanged. The Pipelines tab shows conductor runs for enabled repos: a rail grouped
per repo under a daemon chip, and a run detail drawn in the same visual grammar as the workflow
run diagram - header with live eyebrow and status chips, attempt cards where the workflow detail
shows round tabs, a horizontal Spec / SETUP / UNDERSTAND / DECIDE / BUILD / SHIP / PR strip with
command-style step rows and gate-verdict chips, labeled wires, a kickback rule footer, and a
"Gate verdicts" section. A regression spec pins the Workflows tab.

## Entry criteria and dependencies

- Direct prerequisite: Phase 1 (shared contracts, `pipelineRuns` in browser state, fixtures).

## Scope

- **Approved decision, restated as the hard constraint of this phase: the existing workflow
  Runs surface is not modified.** The run rail, the horizontal workflow diagram (stage cards,
  command rows, reviewer member cards, round tabs, the repair-loop footer, "Reviewer
  verdicts"), and all workflow run controls render exactly as today. The only permitted change
  to the existing surface is mounting the page-level kind tab in the page chrome above both
  surfaces. A Playwright regression spec asserts the workflow rail and run detail render their
  current content with the conductor integration enabled and fixture pipelines present.
- Page-level tab in the Runs page shell (`src/web/workflows/WorkflowRuns.tsx` is the mount
  point; keep the pipelines surface in new files, for example `src/web/workflows/pipelines/`).
  Tab labels carry counts (workflow runs, pipeline runs). When the conductor integration is
  disabled or no provider is enabled, the tab strip does not render and the page is byte-for-byte
  today's page.
- Routing in `src/web/workflows/useWorkflowRoute.ts`, additive: `#/runs/:id` keeps meaning a
  workflow run; `#/runs/pipeline/:repo/:slug` addresses a pipeline run and selects the
  Pipelines tab. Export a helper that builds the pipeline hash so later phases link without
  restating the shape.
- Pipelines rail: grouped per enabled repo under a daemon chip (daemon state from the
  projection), groups by `PipelineRun.group` (building, halted, eligible, waiting, parked,
  processed), rows showing slug, current step or halt summary, tier chip.
- Pipeline run detail:
  - Header: live eyebrow (phase and step index), mono slug title, chips (tier, track, status,
    PR state from `prUrl`), started/updated line. Action buttons render in phase 4; this phase
    reserves the header slot without dead controls.
  - Attempt cards where the workflow detail shows round tabs: a kickback recorded in the gate
    evidence opens a new attempt card; the current attempt is highlighted.
  - The horizontal strip: a Spec terminus, one stage card per phase using MC's frozen step
    order from `src/shared/pipeline.ts`, then a PR terminus. Steps render as command-style
    rows with state and a verdict chip when `gates/<step>.json` reported one; skipped steps
    (tier S, track) render dashed like a disabled command; unknown step names render as an
    unknown-step chip after known ones. Wires carry boundary labels (for example the
    DECIDE-to-BUILD spec handoff); the kickback rule (targets: prd, architecture_review,
    stories, plan) is stated in the footer strip.
  - A "Gate verdicts" section below the strip, where the workflow detail places "Reviewer
    verdicts": one row per recorded verdict with satisfied state, reason, and kickback target
    when present.
- Styling in `src/web/styles.css` using existing tokens and the workflow diagram's class
  grammar as reference; no new colors, no new iconography language.
- Empty states: enabled but no runs; provider enabled but engine missing (surface the probe
  state, link to Settings).

## Non-goals

- No run actions or console (phase 4). No session correlation surfaces (phase 3). No live
  ingest (phase 5). No changes to workflow run components beyond mounting the tab.

## Repository findings

Verified at `dc2d99a`:

- The Runs page lives at `src/web/workflows/WorkflowRuns.tsx`; the workflow diagram grammar
  (`wf-pipeline-strip`, `wf-run-rail`) is in `src/web/workflows/pipeline-bits.tsx` and
  `src/web/styles.css`. Read them for grammar, do not edit their workflow rendering.
- Routing is hash-based in `src/web/workflows/useWorkflowRoute.ts`; `#/runs/:id` construction
  sits around line 417. Deep links are additive there.
- Naming note: the existing `pipeline-bits.tsx` and `RunPipeline.tsx` refer to the workflow
  builder's pipeline concept, not conductor. Name new files so the two do not blur (the
  `pipelines/` subdirectory plus a `Conductor` prefix on components is a reasonable route).
- `useEventStream.ts` already holds `pipelineRuns` state after phase 1; this phase only reads.

## Implementation steps

1. Write the failing regression spec first: with fixtures enabled, the Workflows tab renders
   today's rail and run detail (assert the user-visible content of the existing diagram - stage
   titles, round tabs, "Reviewer verdicts") and `#/runs/:id` deep links still resolve.
2. Add the kind tab to the Runs page shell, hidden when no provider is enabled.
3. Add the route extension and hash helper.
4. Build the rail projection from `pipelineRuns` state.
5. Build the run detail (header, attempts, strip, gate verdicts) from `PipelineRun` plus the
   frozen step map.
6. Empty and degraded states.
7. Playwright specs for the new surface.

## Data and compatibility

- Read-only over phase 1's browser state; no new server surface, no schema changes.
- Deep-link compatibility: every pre-existing `#/runs/...` URL resolves exactly as before.

## Tests and verification

- E2E: the regression spec from step 1; the Pipelines tab renders fixture runs grouped
  correctly; tab hidden when disabled; `#/runs/pipeline/:repo/:slug` deep link selects the run;
  a halted fixture renders its halt state; a tier-S fixture renders skipped steps dashed;
  an unknown step name renders the unknown chip. Selectors by role and label.
- Unit (`test/`): `renderToStaticMarkup` shape tests for the strip only if a precise markup
  contract is worth pinning; route parser cases for the new hash in the existing route tests.
- Commands: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`,
  `npm run smoke`, `npm run test:e2e`.

## Merge and exit criteria

- Definition of done per AGENTS.md; README and `docs/ui.md` cover the tab.
- The regression spec passes and is wired into the suite permanently.
- One reviewable PR; its merge releases phase 3.

## Downstream handoff

- The `#/runs/pipeline/:repo/:slug` route and its exported hash helper (phases 3 and 4 link to
  it; the shape is frozen once merged).
- The reserved header action slot in the pipeline run detail (phase 4 fills it).
- The Pipelines tab visibility rule (enabled providers only); later phases must not add other
  entry points that bypass it.

## Cross-phase audit record

- 2026-08-14: initial version. Route helper placed here rather than `src/shared/` because only
  the web layer consumes it; phase 3 and 4 import it from the workflows module. Header action
  slot reserved so phase 4 does not restructure this phase's detail layout.
- 2026-08-15, on implementation. Seven deviations from the route above, each because the
  repository disagreed with it. **Later phases should read these rather than the prose above.**
  1. **Gate verdicts had no transport, and are fetched rather than projected.** Phase 1 ships
     `readGateVerdicts` with no production consumer, and `PipelineRun` carries no gates: the
     projection rides every reconnect for every run on the fleet, and
     `test/pipeline-sse.test.ts` pins one run under 2kB with the answer to growth written into
     its failure message - *fetch step detail on demand for the Pipelines detail view*. So
     this phase adds `PipelineRunDetail` plus `GET /api/pipelines/run`, guarded by the same
     consent the watcher is behind (the argument is a repository path off a URL) and resolving
     the slug by listing the repository rather than joining it onto a root.
  2. **The daemon chip needed a channel.** The phase file says "daemon state from the
     projection"; it is not there. `PipelineRepoStatus` reaches the browser only through the
     Settings panel's route, which awaits an engine PROBE. So this phase adds
     `GET /api/pipelines/repos` - a config read and a map lookup, no subprocess - polled only
     while the tab is on screen.
  3. **The tab's visibility rides `settingsStatus.pipelines.observing`**, a new count beside
     phase 1's `present`. The page has to decide on its first paint, and this is the tuple
     already in the connect snapshot. `present` could not answer it: it is true whenever a
     repository is merely *configured*.
  4. **The tab mounts in `App.tsx`, not in `WorkflowRuns.tsx`.** That component is the rail
     and reader grid with no chrome above it, and the strip has to sit above BOTH surfaces -
     so mounting it there was impossible without modifying the file this phase promises not
     to touch. `WorkflowRuns.tsx` is unchanged by this work. The strip revives the orphaned
     `.workflow-tabs` CSS the retired Workflows page left behind.
  5. **The pipelines surface lives in `src/web/pipelines/`**, not `src/web/workflows/
     pipelines/`, and takes a `pipelines-` class prefix - the call `EnsembleRuns` and the Ship
     log already made. It shares the strip leaves from `pipeline-bits.tsx` deliberately: that
     module exists so two surfaces drawing one shape cannot fork, and this detail is the same
     shape on purpose. Nothing in those leaves was modified; every slot used was one they
     already offered, including `disabled` for the dashed skipped step. The one thing the
     shared grammar could not carry unchanged is the strip's `align-items: stretch`: a
     workflow stage holds one to three reviewers so its cards come out close in height, while
     this engine's phases are 1, 1, 9, 5 and 6 steps, and stretching drew SETUP as a single
     row of content in a card nine rows tall. `.pipelines-run .wf-pipeline-strip` overrides it
     to `center` - scoped to this surface, which is what the separate class family is for, and
     pinned by a test that also asserts the shared rule still says `stretch`.
  6. **"Reviewer verdicts" no longer exists** - PR #578 replaced it with the Blocker Worklist -
     so the regression spec pins what the page actually renders today, and the pipelines
     surface's own section is "Gate verdicts" below the strip, where the worklist sits.
  7. **The header shows no "started" time.** `PipelineRun` carries only `updatedAt`; the
     engine records no run start, and deriving one from the projection would be an invention.
  8. **The tab is documented in `docs/pipelines.md` and `docs/workflows.md`, not
     `docs/ui.md`.** The exit criteria above name `docs/ui.md`, but that file documents the
     app's chrome - the palette, the layouts, message rendering, shortcuts, tooltips, context
     menus - and has no Runs page section to extend. The Runs page's own behaviour is
     documented in `docs/workflows.md`, which now says in "Watching a run" that the page has a
     second tab and points at `docs/pipelines.md § Runs → Pipelines` for it. Putting the
     paragraph in `docs/ui.md` would have created the first product-surface section in a file
     about interaction chrome.
- 2026-08-15, found while implementing: `Registry.emitSettingsStatus` never compared the
  `pipelines` half of the tuple, so a frame that moved only there was dropped - which made
  phase 1's promise that installing the engine reveals the Settings row "while you are still
  looking for it" depend on some unrelated setting moving next. Fixed here, with a test that
  walks the composed tuple so the next field cannot repeat it.
