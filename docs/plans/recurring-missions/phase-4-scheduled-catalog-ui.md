# Phase 4: Scheduled Catalog UI and Operational Proof

## Outcome and value

Ship the complete operator experience shown in the approved mockups:

- a live, searchable Scheduled Catalog with detail and attention badge;
- create/edit with presets and advanced cron;
- daemon-authored occurrence preview and standby simulation;
- explicit Save paused and Save & enable paths;
- pause/resume, Run now, archive, and paginated audit history;
- generated-task provenance links in backlog and every session layout; and
- honest documentation and verification for local standby catch-up.

This phase closes the feature vertically. It adds no new scheduling semantics: React
consumes Phase 3's live state and API, and every time/policy decision remains daemon-owned.

## Entry criteria and direct dependencies

Direct phase dependency: Phase 3 — HTTP and Live-State Surface.

Before implementation:

1. Confirm Phase 3 merged; rebase onto that merge.
2. Run all schedule foundation, manager, HTTP, and SSE suites unchanged.
3. Re-read [`plan.md`](plan.md), [`phased-plan.md`](phased-plan.md), all three prior phase
   files, and the approved
   [`../../mockups/recurring-missions/index.html`](../../mockups/recurring-missions/index.html).
4. Open all current session renderers before changing task metadata:
   `SessionCard`, `ConsoleDetail`, `SessionTile`, and `RailRow`.
5. Inspect then-current `App.tsx`, `SessionViewProps`/`cardProps`, overlay registry, topbar,
   Dispatch modal, Board backlog, Sitrep backlog, shared session leaves, and styles.
6. Preserve the Shift+O Files behavior and all overlays/workflows added after planning
   commit `35807b9`.

## Scope

### In scope

- Recurring Missions overlay registration and App state/wiring.
- Topbar Missions trigger and attention count.
- Catalog, detail, editor, preview, and history components.
- Presentation helpers only; no cron/DST/business-policy calculation.
- Generated-task provenance on Board backlog, Sitrep backlog/recent outcomes, task edit,
  Cards, Console detail, Board tile, and RailRow.
- Component/state/layout/overlay tests.
- README/operator documentation and a real sleep/wake dogfood runbook.
- Chrome DevTools functional and console/network verification.
- Full typecheck, tests, build, and bundle smoke.

### Explicit non-goals

- No schedule keyboard shortcut in V1.
- No new settings category.
- No `DraftKind`, attachment upload, reset nonce, or send chord.
- No polling for the catalog or history.
- No client cron parser, DST calculator, missed-policy engine, or health threshold.
- No direct schedule dispatch.
- No Electron IPC, `powerSaveBlocker`, OS wake job, or remote runner.
- No editing immutable provenance on a generated task.

## Repository findings and inherited contracts

- The overlay must be added to `OVERLAY_IDS` and rendered through `Overlay` inside
  `OverlayHost`. App's global shortcut stand-down comes from the registry.
- Session UI has four renderers across three layouts. A callback or schedule lookup needed
  by those renderers belongs on `SessionViewProps`/`cardProps`, not one component.
- Shared leaf pieces live in `session-bits.tsx`.
- A new session-visible mark must cover the three mark vocabularies: Card/detail chip,
  Board tile flag, and RailRow glyph.
- Console detail CSS uses descendant selectors into shared pieces; changing task-chip DOM
  requires checking Console and Board detail.
- Board backlog is rendered by `layouts/BacklogColumn.tsx`; Sitrep backlog and recent
  outcomes are rendered by `ReportPanel.tsx`.
- Phase 3's `MissionState.schedules` is the only live catalog source. Occurrence history is
  fetched on selection/open and never polled.
- An archived schedule disappears from live state. Its history response includes schedule
  context so old tasks can still deep-link.
- Schedule task provenance survives in `Task` and `TaskSummary`; no new top-level Session
  field or comparator is required.
- The editor is a settings-like form, not a compose surface.

## UI architecture

Add:

```text
src/web/components/RecurringMissionsPanel.tsx
src/web/components/schedules/ScheduleCatalog.tsx
src/web/components/schedules/ScheduleDetail.tsx
src/web/components/schedules/ScheduleEditor.tsx
src/web/components/schedules/SchedulePreview.tsx
src/web/components/schedules/ScheduleHistory.tsx
src/web/lib/schedules.ts
```

Use the approved mockups as visual direction, not a second state model. Reuse current
Mission Control buttons, fields, chips, panels, spacing, font, focus, and dark/light
variables so the feature looks native on the implementation branch.

`RecurringMissionsPanel` owns screen routing within one mounted overlay:

```text
catalog/detail → create/edit → preview → history
```

App owns only cross-surface state:

- whether the overlay is open;
- selected schedule id;
- optional initial screen/occurrence requested by a provenance link; and
- callbacks that close a currently open Sitrep/Dispatch surface before opening Missions.

Editor step state remains local while the overlay is mounted.

## File- and component-level implementation steps

### 1. Register and open the operational overlay

In `src/web/components/Overlay.tsx`, append:

```ts
recurringMissions: "recurring-missions"
```

In `App.tsx`:

1. Read `schedules` from `useEventStream`.
2. Add open/selected-screen state.
3. Render `RecurringMissionsPanel` through the current overlay host.
4. Add a **Missions** topbar button beside Dispatch and Sitrep.
5. Derive the attention badge from `schedule.health === "attention"`; do not reimplement
   health rules.
6. Close or transition from another overlay before opening a schedule deep link.
7. Keep all global shortcuts stood down through `overlays.anyOpen`.
8. Do not add an ActionId, keybinding, CommandBar keycap, KeyboardPanel row, or README
   shortcut.

The overlay owns Escape. Include accessible dialog labeling, close control, focus entry,
and tab order consistent with current overlays.

### 2. Implement catalog and detail

`ScheduleCatalog`:

- search by name, task title, repo, agent, and labels;
- filter All, Healthy, Paused, Attention;
- retain a valid selection when SSE upserts reorder rows;
- choose a sensible next row if a selected schedule is removed;
- show schedule name, shortened repo, agent, readable cadence, time zone, execution mode,
  next run, last outcome, and server-derived health;
- provide empty, no-match, disconnected, and loading states without fetching the live list.

`ScheduleDetail`:

- show template title/intent summary and canonical repo;
- show exact expression, readable cadence, time zone, next UTC/local instant;
- show missed, overlap, and local-catch-up guarantee;
- state explicitly: “No work runs while this laptop is asleep or powered off; overdue
  instants are accounted for when Mission Control resumes.”
- show last occurrence, delay, recent outcome totals if supplied;
- actions: Preview, Edit, Pause/Resume, Run now, History, Archive;
- confirm Archive and preserve generated tasks/history;
- show structured mutation errors and disable duplicate clicks while a request is active.

Run now must explain that it files a backlog task; it does not say “run agent now.”

### 3. Implement create/edit

`ScheduleEditor` has the five source-plan decision groups:

1. Task template.
2. Cadence and time zone.
3. Laptop availability.
4. Overlap and missed-run guardrails.
5. Preview and enable.

Task template:

- required schedule name, task title, and intent;
- repo picker/manual path using existing repo APIs;
- kind, agent, priority, labels, model, and effort controls that derive options from current
  shared registries/capabilities;
- immutable schedule provenance is not editable here.

Cadence:

- readable presets for common daily/weekday/weekly/monthly patterns;
- Advanced mode exposes the five-field expression;
- presets produce a deterministic expression, but all semantic validation and occurrence
  calculation comes from preview;
- default timezone is the browser's IANA zone; use available browser zone names for the
  picker without doing recurrence math.

Availability/guardrails:

- V1 shows Local durable catch-up as the only selectable execution mode;
- future OS wake and remote runner may be shown only as clearly disabled “not available”
  explanations, never saved values;
- missed policy and overlap policy explain task-count implications;
- show the create-all cap of 50.

Actions:

- Preview calls `previewSchedule`.
- Save paused persists disabled configuration.
- Save & enable must first obtain a successful preview for the current definition, then
  create/update enabled.
- A definition edit after preview invalidates that preview.
- Keep server field/conflict errors attached to the relevant step.
- Do not add draft persistence beyond component state; closing intentionally discards an
  unsaved schedule after confirmation if dirty.

### 4. Implement preview and standby simulation

`SchedulePreview` renders the exact Phase 3 response:

- 10–50 future instants;
- configured local time;
- UTC time;
- offset/DST indicator;
- advisory overlap with another enabled mission;
- local-catch-up lateness warning.

Add optional “simulate standby” inputs for sleep start and resume time. Render each missed
instant and its server-decided result, including coalesced coverage and the create-all cap.

The browser may format returned epochs for display. It may not generate additional
occurrences, infer missing ones, or apply missed policy itself.

Preview is safe from unsaved definitions and does not mutate catalog state.

### 5. Implement paginated history and audit detail

`ScheduleHistory`:

- fetches only when history opens or the user asks for the next page;
- cancels/ignores stale requests when selection changes;
- displays scheduled local/UTC time, trigger kind, claim time, delay, status, revision,
  generated task, covered-by/blocking task, and error;
- clearly distinguishes `scheduled` from `manual`;
- retains archived schedule context returned by the page;
- uses a stable “Load older” cursor and prevents duplicate page append;
- supports direct selection of a schedule/occurrence from task provenance.

Occurrence detail presents the durable audit facts available from the API. Do not fabricate
an “SSE emitted” timestamp if it was not persisted; phrase the live-update step as product
behavior and show only persisted timestamps.

Generated task links:

- open the existing task editor for a backlog task;
- focus the bound session when appropriate; or
- show a retained terminal task/history result if it is no longer live.

### 6. Add task provenance to backlog surfaces

Create a reusable schedule-origin control, preferably in `session-bits.tsx` if it is shared
with session rendering, with inputs for:

- schedule id;
- occurrence id;
- scheduled time;
- optional live schedule name; and
- `onOpenSchedule(scheduleId, occurrenceId?)`.

In Board `BacklogColumn`:

- show “Scheduled by <name> · <time>” or a compact equivalent;
- keep the priority selector, labels, drag behavior, dependency/disabled state, and launch
  controls working;
- stop propagation so opening origin does not also open Dispatch or start a drag.

In Sitrep `ReportPanel`:

- show provenance in Backlog;
- retain it in Recent outcomes so a finished scheduled task can open history;
- close Sitrep before opening Missions.

In Dispatch task-edit mode:

- show provenance read-only;
- offer “Open schedule/history”;
- never include the three provenance fields in UpdateTask payloads.

External Task Source provenance continues to use its existing presentation. A task cannot
silently masquerade as both origins; if corrupted data contains both, show both read-only
facts or an explicit conflict rather than dropping one.

### 7. Preserve session layout parity

Use the existing `TaskSummary` fields.

Cards:

- show the shared schedule-origin control inside/beside the current task chip.

Console and Board detail:

- render the same shared leaf, checking descendant CSS around `.detail-sub` and
  `.task-chip`.

Board overview tile:

- add a compact tile flag for scheduled origin, with accessible tooltip/name and open
  callback.

Console rail and Board drilled-in rail:

- add an equivalent scheduled glyph to `RailRow.marks`, with tooltip and open callback.

Prop threading:

- add `onOpenSchedule` and any live schedule-name lookup to `SessionViewProps`/`cardProps`;
- carry them through Grid, Console, and Board;
- do not add layout-only props directly to one renderer.

Verify that clicking the provenance mark opens Missions rather than expanding/focusing the
underlying session. Check all three layouts explicitly.

### 8. Add presentation helpers and styles

`src/web/lib/schedules.ts` may contain:

- cadence labels from expression/preset metadata;
- schedule search/filter;
- time/delay formatting;
- occurrence status labels; and
- view models that use server-provided health/policy results.

It must not contain recurrence enumeration, cron validation, DST policy, missed-run policy,
or health thresholds.

Extend `src/web/styles.css` using existing variables. Cover:

- wide overlay at desktop sizes;
- usable single-column/mobile fallback;
- list/detail split;
- editor steps and dirty/disabled states;
- preview/history tables with their own horizontal overflow;
- attention, paused, success, skip, failure, and delay vocabulary;
- high-contrast focus-visible states; and
- long paths, intents, labels, time zones, and errors without page-wide horizontal scroll.

### 9. Add tests for behavior and parity

Add/extend:

- `test/overlay-registry.test.ts`;
- schedule presentation/helper tests;
- server-rendered component tests for Catalog, editor choices, preview, history, and
  provenance;
- `test/session-leaf-parity.test.ts`;
- layout/card prop contract tests;
- App/static topbar tests where current patterns allow; and
- no-poll/static source assertions only where behavior cannot be exercised.

Test both active and archived deep links. Test external-source and scheduled provenance
without conflating them.

### 10. Document and dogfood standby behavior

Update `README.md` with:

- what Recurring Missions creates;
- how to open the Scheduled Catalog;
- the local durable catch-up guarantee and non-guarantee;
- missed/overlap policy summaries;
- the fact that no V1 shortcut exists; and
- no claim of OS wake or powered-off execution.

Add `docs/runbooks/recurring-missions-standby.md` (or the repository's then-current runbook
location) with:

1. create/save paused;
2. preview expected instants;
3. enable a low-risk scout schedule in a disposable/test repo;
4. verify a normal occurrence;
5. restart the daemon across a due instant and record history;
6. sleep the laptop across a due instant, resume, and record actual delay/history;
7. confirm one task/occurrence only;
8. pause/archive cleanup; and
9. capture failures without changing the system clock manually.

The real sleep/wake receipt may be completed after merge by an operator. The PR must ship
the automated fake-clock proof and runnable checklist.

## Data/API/migration and compatibility details

- This phase adds no DB migration and no public route.
- Catalog live state is `MissionState.schedules`; do not add a `fetchSchedules` poll.
- History pages are component-local and discarded/refetched on explicit navigation.
- Save & enable is protected by a preview fingerprint or current-definition comparison so a
  stale preview cannot approve changed data.
- Server validation remains authoritative; browser required fields improve UX only.
- Archived schedule deep links work even though the schedule is absent from live state.
- Task provenance is immutable and nullable, so old/manual tasks render unchanged.
- If a generated task's schedule has been purged/corrupted, show the ids/time and a
  “history unavailable” error instead of hiding provenance.
- Layout callbacks must not change session state, expansion, focus, drag, or keyboard
  behavior.

## Tests and verification

Targeted:

```text
node --test --import tsx test/overlay-registry.test.ts
node --test --import tsx test/session-leaf-parity.test.ts
node --test --import tsx 'test/schedule-*.test.ts'
npm run typecheck
npm run build:web
```

Full gate:

```text
npm run typecheck
npm test
npm run build
npm run smoke
```

Chrome DevTools verification against the development dashboard:

1. Open Missions and confirm the overlay registers, Escape closes it, and global/session
   shortcuts do not act behind it.
2. Create a schedule, preview, Save paused, edit, Save & enable, pause/resume, Run now,
   view history, and archive.
3. Confirm Network shows mutations and the existing `/events` stream, with no repeating
   `/api/schedules` or history polling requests.
4. In EventStream/Network, verify schedule upsert/remove and generated task updates arrive
   live; disconnect/reconnect and verify the snapshot restores catalog state.
5. Force representative 400/404/409/server-unavailable paths and verify recoverable,
   non-blank error UI.
6. Open a scheduled task from Board backlog and Sitrep, then open its origin from Cards,
   Console detail, Board tile, and RailRow.
7. Verify external-source tasks retain their existing origin UI.
8. Exercise Cards, Console, and Board layouts, narrow viewport, light/dark preference, long
   content, and keyboard focus.
9. Check Console for uncaught errors, unknown events, React warnings, failed resources, and
   accessibility-critical issues.
10. Confirm Run now creates a backlog task only and does not provision or type into an
    agent.

Required automated/UI assertions:

- topbar attention count uses server-derived health;
- all catalog filters and selection reconciliation work;
- editor distinguishes Save paused and Save & enable;
- save-enabled refuses a stale/failed preview;
- local mode wording never promises on-time or asleep execution;
- preview and standby rows render daemon results;
- archive preserves deep-linked history;
- history pagination deduplicates and ignores stale requests;
- scheduled provenance appears on Board backlog and Sitrep;
- scheduled provenance is reachable in all four session renderers;
- overlay registry and session shortcut stand-down remain intact; and
- no catalog poll loop exists.

## Merge and exit criteria

Phase 4 may merge when:

- the approved catalog/detail/editor/preview/history flows are complete;
- every operator mutation has busy, success, validation, conflict, and unavailable states;
- the topbar attention badge and catalog update live over the existing SSE channel;
- all generated-task provenance links work before and after archive;
- Cards, Console detail, Board tile, and RailRow parity is verified;
- Board and Sitrep backlog provenance is verified;
- local catch-up language is honest and OS wake/remote execution remain unavailable;
- no shortcut, compose surface, Foreman change, Electron capability, or direct dispatch was
  introduced;
- targeted and full automated gates pass;
- Chrome DevTools verification is recorded in the PR description; and
- the standby dogfood runbook exists, with automated fake-clock proof complete.

## Downstream handoff

After Phase 4, the Recurring Missions V1 feature is implementation-complete.

Future OS wake work may rely on:

- the same durable SQLite cursor and occurrence ledger;
- local catch-up remaining the fallback;
- execution mode values already being parseable; and
- an explicit four-file Electron capability if UI control is added.

Future remote-runner work may rely on the occurrence model but must add shared lease
authority/fencing. It must not run an independent second SQLite scheduler.

Neither follow-up may:

- change the meaning of local-catchup;
- delete or rewrite existing occurrence history;
- make nullable task provenance mandatory for old tasks; or
- let a schedule bypass ordinary backlog/Foreman safety.

## Cross-phase audit record

- 2026-07-23: Re-read Phase 3 and consumed only its EventSource collection and typed API;
  no UI polling or client recurrence logic was introduced.
- 2026-07-23: Traced task presentation beyond SessionCard: Board backlog, Sitrep,
  ConsoleDetail, SessionTile, and RailRow are all explicitly owned here.
- 2026-07-23: Routed layout-visible callbacks through `SessionViewProps`/`cardProps` to
  prevent Grid from silently dropping them.
- 2026-07-23: Kept the editor outside compose/draft/reset contracts because it is a
  configuration workflow with no attachments or send chord.
- 2026-07-23: Converted real sleep/wake into a documented rollout receipt while retaining
  deterministic fake-clock correctness as the merge gate.
- 2026-07-23: Confirmed all source-plan V1 behavior is now owned by one of the four phases;
  Mode B and Mode C remain explicit follow-up projects rather than hidden Phase 4 scope.
