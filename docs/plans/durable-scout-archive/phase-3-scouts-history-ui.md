# Phase 3: Scouts history UI

## Outcome and value

Mission Control has a permanent top-level Scouts page where an operator can recover an old answer
without reopening the original agent. The page searches local and shared archives, deep-links one
selected scout, renders its static HTML report in the existing security boundary, exposes supporting
evidence and the local bundle path, refreshes after background discovery, and deletes one archive
only after explicit confirmation.

This phase completes the approved product experience. It does not change capture or storage
semantics established by Phases 1 and 2.

## Entry criteria and direct dependencies

- Direct dependency: Phase 2, `phase-2-scout-capture-and-completion.md`.
- Phase 1 and Phase 2 must be merged. The bounded scout API, `scoutsRevision`, stable archive key,
  complete and partial bundles, and mandatory capture flow must exist on the default branch.
- Read `e2e/README.md` before changing the UI or its browser fixture. Re-run the current topbar,
  router, overlay, keybinding, palette, and file-preview tests before editing their contracts.

## Scope

In scope:

- `#/scouts` list and `#/scouts/<archive-key>` detail routes with search and filters;
- a top-level **Scouts** topbar segment and global shortcut/action;
- a static command-palette page result;
- bounded API hooks and revision-driven refresh without browser polling;
- a three-part archive rail, report reader, and evidence spine;
- shared sandboxed HTML preview and verified companion-link navigation;
- supporting text, Markdown, image, HTML, download, and registered open behavior;
- complete, partial, unreadable, loading, empty, unavailable, and stale-deep-link states;
- **Delete scout** in the selected header and row overflow, typed confirmation, error recovery,
  focus restoration, and next-selection behavior;
- desktop and narrow layout, accessibility, keyboard operation, product docs, and Playwright coverage.

Explicit non-goals:

- changing the version 1 manifest, digest, producer identity, reconciliation, or capture jobs;
- joining historical archives back to task or session rows;
- loading the complete archive catalog into the SSE snapshot or command palette;
- adding annotations, editing, remote sync, trust badges, signing, retention settings, or bulk delete;
- executing archived JavaScript or allowing network requests from a report;
- deleting tasks, sessions, repositories, or external sync copies.

## Repository findings and inherited contracts

This phase inherits C1-C9 and the server half of C12. It owns C10-C11 and the visible half of C12.

- `src/web/workflows/useWorkflowRoute.ts` is the app's only router. `MissionRoute`, parser,
  serializer, dirty-draft gate, and `pageShortcutRoute` must remain one exhaustive contract.
- `src/web/components/AppPageShell.tsx` takes a `Record<MissionRoute["page"], ReactNode>`. Adding the
  route deliberately fails compilation until App provides the new page slot.
- `PAGE_SEGMENTS` in `src/web/App.tsx` is the topbar's typed reading order and currently contains
  Fleet, Library, and Runs. The approved top-level Scouts entry accepts the density cost. Its
  desktop one-row and responsive behavior must be measured, not assumed.
- `ActionId` and `ACTIONS` in `src/web/lib/keybindings.ts` persist IDs in UI configuration. Append a
  new `scouts` ID without renaming or reordering existing IDs. `shift+s` is currently unclaimed and
  is the proposed default for **Open Scouts**; verify that again at implementation.
- `src/web/lib/palette-index.ts` requires providers to derive from existing client stores and never
  fetch. Add one static page row only. Scout records remain searchable inside their owning page.
- `src/web/useEventStream.ts` already receives the Phase 1 `scoutsRevision`. App must pass it to the
  mounted page so reconnect and one archive invalidation refetch the current bounded query.
- `src/web/components/FileWorkspace.tsx` owns the current HTML preview source, CSP, hashed link
  bridge, and `sandbox="allow-scripts"`. Scripts are allowed only for the trusted bridge selected by
  its CSP hash; report scripts remain blocked. Extract a focused shared helper or component rather
  than duplicating policy in Scouts.
- The overlay registry in `src/web/components/Overlay.tsx` is the single source of truth for global
  shortcut stand-down and Escape ordering. The delete confirmation needs a declared overlay ID and
  the normal Overlay primitive.
- `src/web/api.ts` is the browser request owner. The page should not issue raw fetches from several
  components or construct artifact paths itself.
- UI tests use static markup and source contracts for fast shape, but every visible change also
  requires a built-dashboard Playwright spec. Tests select by role, label, and placeholder, never a
  `data-testid`.

## Implementation steps

### 1. Add stable Scouts routing

Extend `MissionRoute` with a scouts variant containing:

- optional selected `archiveKey`;
- optional typed filters for literal query, producer, repository, agent, completion state, and date
  range;
- no task or session identity.

Parse and serialize these permanent shapes:

```text
#/scouts
#/scouts/<encoded-archive-key>
#/scouts/<encoded-archive-key>?q=...&producer=...&repo=...&agent=...&state=...&from=...&to=...
```

Use the Phase 1 opaque archive-key helper and the router's safe segment decoder. Invalid keys and
invalid filters fall back to a safe Scouts list state rather than throwing. Query and filter state
round-trips through the route; pagination cursor remains ephemeral because it is a continuation of
the current result window, not a stable destination.

Extend `pageShortcutRoute` for `scouts`. Update router tests for list, detail, encoded IDs, every
filter, malformed encoding, unknown parameters, legacy routes, and exact parse/serialize
round-trips. Keep all existing route outputs byte-compatible.

### 2. Wire the permanent entry points

Append `scouts` to `ActionId` and add an **Open Scouts** global action with the verified
nonconflicting `shift+s` default. Extend the persisted keybinding schema, settings display, shortcut
normalization, conflict tests, and README shortcut table without renaming existing action IDs.

Add a **Scouts** item to `PAGE_SEGMENTS` in the approved reading order after Runs. It navigates to
`{ page: "scouts" }`, uses existing segmented-control markup and visual tokens, and participates in
the same global typing, rename, and overlay guards. Update the type assertion, topbar layout tests,
and page action dispatch.

Add one static `page:scouts` row to `pageProvider` in `palette-index.ts`, with search language such as
investigations, findings, reports, research, evidence, and history. Extend `routeDestination` and
palette hint tests. Do not fetch archive summaries in the palette and do not add an archive provider.

Add the `scouts` slot to `AppPageShell` call sites and their exhaustive tests. It must mount
`ScoutsPage` only when the route is Scouts, so fleet and other pages do not fetch archive history.

### 3. Add the browser API boundary and page state

Extend `src/web/api.ts` with typed methods for list, detail, artifact body, registered open, and
delete. Reuse Phase 1 shared request and response types and archive-key encoding. Centralize error
parsing, abort signals, content type, binary body handling, and object-URL cleanup.

Build `src/web/components/ScoutsPage.tsx` with small focused helpers or hooks for:

- route-driven query and filters;
- debounced bounded list loading, cursor continuation, and cancellation of stale requests;
- selected detail and selected artifact loading;
- one loading model that distinguishes first load, background refresh, more-results load, and
  selected-detail failure;
- deterministic selection after search, invalid deep link, reconciliation, and deletion;
- status announcement and focus restoration.

When there is no selected key and results exist, select the newest result through normal route
navigation. When a deep-linked key is absent from the current bounded list, load its detail directly
and keep a stable return to the filtered list. An unreadable row may have only safe index metadata
and delete capability; never assume a valid manifest.

Pass `scoutsRevision` from `useEventStream` through App. While the page is mounted, a revision change
refetches the current bounded list and selected detail after coalescing with any request already in
flight. Reconnect uses the same path. Do not add an interval, a second SSE connection, or whole-app
preloading.

### 4. Build the archive rail and search controls

The left rail owns discovery:

- a labelled search input with placeholder **Search questions, findings, reports, files...**;
- compact source/producer, repository, agent, completion, and date filters;
- newest-first result groups with title, completion time, producer or repository, capture status,
  duration when present, artifact count, and escaped snippet;
- selected, hover, focus, partial, and unreadable semantics that do not rely on color alone;
- cursor-based **Load more**, explicit empty history, no results, loading, and unavailable states;
- a labelled row-overflow button with **Delete scout** for every local visible record.

Keep search literal and server-owned. The route updates after a short debounce or explicit submit
and remains copyable. Preserve current query and filters when background reconciliation adds a
foreign archive. Announce changed result counts politely without moving focus.

Use semantic list, option or link, heading, status, and form labels that Playwright and assistive
technology can reach. Do not add `data-testid`.

### 5. Render the report and evidence spine safely

The center reader opens the primary report by default. Extract the current Files HTML preview source
and trusted bridge into a focused shared web module, then migrate Files and Scouts to that one
implementation in the same commit. Preserve Files behavior and tests exactly.

The shared preview boundary must:

- emit the existing restrictive CSP with default and network connections disabled;
- permit only the known hashed bridge script, inline styles, data images, and safe static document
  rendering;
- keep iframe sandboxing limited to the bridge capability and never grant same-origin privileges;
- intercept all nonfragment navigation;
- send relative-link intent to the parent, where Scouts resolves it only to a Phase 1 verified
  report companion artifact ID;
- leave external, scheme, protocol-relative, escaping, missing, and unclaimed links inert;
- preserve fragment navigation inside the selected document.

Do not weaken the Files CSP to accommodate archived reports. Add shared regression fixtures proving
report-authored scripts, event handlers, forms, external images, and network requests do not execute.

The right evidence spine shows:

- the primary HTML stop first, then report companions and explicit supporting artifacts;
- ready, partial, missing, and unreadable states with text and iconography;
- repository slot and label, original relative path, media type, bytes, digest, and captured time;
- actions appropriate to the artifact: preview, download, registered **Open in Browser**, and copy
  path or bundle path.

Preview bounded UTF-8 text and Markdown with the existing safe renderers, images through fetched
blob URLs, and HTML through the shared sandbox. Unknown or binary media stays downloadable and
openable but is not rendered as text. Revoke blob URLs on selection and unmount.

The selected header names the question, title, producer claim, repositories, agent/model provenance,
completion and capture status, and exact local bundle directory. Clearly label foreign producer
metadata as descriptive, not verified identity. Partial archives are amber and enumerate every
`missing` reason. Unreadable records are red and show only the safe daemon diagnostic.

### 6. Implement explicit deletion in both UI locations

Add `scoutDelete` to `OVERLAY_IDS` and a focused `ScoutDeleteModal` using the shared Overlay. Open it
from both the selected-scout header and row overflow with the exact archive key and current display
metadata captured at invocation.

The modal must:

- name the scout, producer, size, and local bundle consequence;
- state that tasks, sessions, repositories, and remote services are untouched;
- explain that an operator-controlled sync may propagate deletion or restore the bundle later;
- require the literal text `DELETE` before enabling the destructive action;
- call the Phase 1 route with `confirmArchiveKey` exactly equal to the captured route key;
- disable duplicate submission while pending;
- show the daemon's specific safe failure above the actions and remain open on error;
- restore focus to the invoking control when closed or failed.

Use the existing `btn-danger-ghost` treatment for entry points and established danger styling for
the final button. The row action has an accessible name including the scout title.

After confirmed success, update local rows only after the daemon response, close the modal, announce
**Scout deleted**, and select the next visible row, or the previous row when the deleted item was
last. Preserve query, filters, and scroll position. If the deleted deep link was the only result,
navigate to the filtered `#/scouts` list and render the correct empty state. Another archive and any
source task remain untouched.

### 7. Complete the responsive layout and visual contract

Add Scouts styles in the matching section of `src/web/styles.css`, using existing canvas, panel,
line, foreground, muted, idle, attention, danger, font, focus, and spacing tokens. The report is the
visual focus; do not introduce KPI cards, gradients, or a second design system.

Desktop uses a bounded archive rail, flexible report dossier, and narrow evidence spine without
horizontal page overflow. Keep the topbar on one line at supported desktop widths after adding the
fourth segment, and preserve Electron drag/no-drag regions for every interactive control.

At narrow widths:

- the result rail is the first screen;
- selecting a scout replaces it with the report and a labelled Back control;
- the evidence spine folds below the report;
- filters remain reachable without covering the search input;
- modal actions, long paths, hashes, and titles wrap without clipping;
- focus order follows the visible reading order.

Honor reduced motion. Validate 200 percent zoom, keyboard-only use, focus visibility, accessible
names, semantic statuses, and light/dark token behavior where the app supports it.

### 8. Update the durable scout documentation

Complete the Phase 1 product reference and documentation index with screenshots only if they are
normal committed product documentation, never test evidence. Document:

- the top-level Scouts entry point, shortcut, palette row, routes, search fields, filters, and deep
  links;
- the evidence spine, supported previews, sandbox behavior, downloads, open, and copied bundle path;
- automatic foreign-bundle discovery and revision-driven refresh without a reindex control;
- explicit local deletion, `DELETE` confirmation, no task/session cascade, and sync caveat;
- partial and unreadable meaning, local privacy, no conversation capture, and no automatic retention;
- database deletion and reconstruction from the directory bundle.

Update any topbar, keyboard, or navigation docs whose exhaustive page list changes.

## Data, API, migration, and compatibility details

- **No database migration:** this phase consumes the Phase 1 read model and Phase 2 capture output.
  It adds no archive fields or browser-only durable truth.
- **Route durability:** list and detail hashes use the composite portable key. Search filters are
  typed and round-trip; cursor and open artifact tab are ephemeral UI state.
- **Bounded browser state:** summaries, one detail, and one selected artifact body are held at a
  time. Archive history does not enter the opening snapshot or command-palette stores.
- **Refresh:** one existing event stream supplies an invalidation revision. The daemon's background
  cadence owns filesystem discovery; the browser does not poll.
- **Preview:** artifact identity, not paths, crosses the API. CSP and sandbox behavior are shared with
  Files and cannot be weakened per report.
- **Deletion:** UI confirmation binds to the same key the server verifies. Success removes local
  presentation after server confirmation; external restoration is handled by normal reconciliation.
- **Compatibility:** every existing page route, shortcut ID, palette destination, Files preview,
  overlay guard, and topbar action retains its behavior. New append-only cases make exhaustive
  contracts compile.

## Tests and verification

Add or update fast tests for:

- all Scouts route shapes, filters, malformed segments, serialization, `pageShortcutRoute`, and
  dirty-draft navigation;
- appended keybinding identity, default chord conflict detection, settings rendering, and global
  typing/overlay guards;
- topbar segment order, active state, one-row source contract, AppPageShell exhaustiveness, and page
  mounting only on the Scouts route;
- static palette page row, keywords, destination, hint, and a guard that no archive-fetching provider
  was introduced;
- `scoutsRevision` refetch and reconnect coalescing, request cancellation, deep-link detail, selection,
  pagination, and unavailable versus empty state;
- static markup and accessibility labels for search, filters, result rows, evidence status, artifact
  actions, Back navigation, and both delete controls;
- shared Files/Scouts HTML preview CSP, bridge hashes, fragment links, verified companion resolution,
  blocked authored scripts, blocked external requests, and Files regression parity;
- overlay registration, literal `DELETE`, bound key, pending, failure, next/previous selection, filter
  preservation, status announcement, and focus restoration;
- responsive source rules, long path wrapping, reduced motion, and any Electron geometry affected by
  the wider topbar.

Finish `e2e/specs/scout-archive.spec.ts` against the built daemon and fake agents. In one isolated
`MISSION_HOME`, cover:

1. Phase 2's skill-disabled scout dispatch, real submission, completion gate, stop, and reclaim.
2. Open Scouts from the topbar, the `shift+s` action, and the command palette.
3. Search text found only in `report.html` and a supporting artifact path, apply filters, copy the
   deep link, reload, and recover the same result and selection.
4. Read the sandboxed primary report by default; navigate fragments and verified companions; preview
   text, Markdown, image, and HTML artifacts; download, registered-open, and copy the bundle path.
5. Prove report JavaScript, event handlers, forms, and external requests cannot execute.
6. Restart with the same database and instrument the fixture to prove unchanged bundle bodies are
   not reindexed while the route and search survive.
7. Copy a valid foreign-producer bundle after the page opens and prove it appears after the short
   test cadence through SSE invalidation, with no browser polling or import action.
8. Stop the daemon, remove only the isolated fixture's `harness.db`, restart, and prove search and
   detail reconstruct automatically from bundle directories.
9. Seed a partial filesystem transfer, finish its payload, and prove no visible corrupt flash before
   the two-observation settle succeeds.
10. Seed a valid partial archive and prove its amber state and missing-evidence explanation never
    present it as complete.
11. Delete through the selected header, requiring `DELETE`; prove next selection, preserved filters,
    and no source-task effect.
12. Delete through row overflow, force one route failure, prove the modal and report remain readable,
    then succeed and prove another archive is untouched.
13. Exercise narrow viewport list-to-detail navigation, folded evidence, keyboard focus, Escape, and
    the desktop topbar in `e2e/specs/topbar-one-row.spec.ts`.

Use role, label, text, and placeholder selectors. Keep all fixture archives, screenshots, traces, and
videos in gitignored test evidence locations.

Relevant commands:

```sh
node --test --import tsx test/workflow-route.test.ts
node --test --import tsx test/palette-index.test.ts
node --test --import tsx test/scouts-page.test.ts
node --test --import tsx test/overlay-registry.test.ts
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npm run test:e2e -- e2e/specs/scout-archive.spec.ts e2e/specs/topbar-one-row.spec.ts
npm run test:e2e
```

Perform runtime and visual verification at desktop and narrow widths. Inspect the report reader,
evidence spine, partial and unreadable states, delete modal, long paths, focus order, and topbar. The
pull request must attach evidence rather than commit it.

## Merge and exit criteria

- **Scouts** is a permanent top-level page with stable list and detail routes, a working global
  action, and a static palette entry.
- Search finds bounded manifest metadata, visible HTML text, and supporting paths. Foreign bundles
  appear after daemon reconciliation without browser polling or user action.
- The selected report renders by default in the shared sandbox. Supporting artifacts are readable or
  safely openable by generated ID, and no archived content executes with dashboard privileges or
  reaches the network.
- Complete, partial, unreadable, loading, empty, failed, and stale-link states are honest and
  accessible.
- Both delete entry points require literal confirmation and the bound archive key. Success preserves
  filters and chooses the next record; failure preserves the modal and readable archive.
- SQLite removal and daemon restart reconstruct the same UI from bundle directories.
- Desktop topbar, report layout, narrow navigation, keyboard flow, zoom, focus, and reduced motion
  are verified in the running application.
- Focused tests, the feature Playwright spec, topbar spec, full E2E suite, and repository gates are
  green with no committed evidence artifacts.

## Downstream handoff

The approved feature is complete after this phase. Future format versions may add append-only
readers and migrations, but they must preserve version 1 identity, digest, preview, and deletion
behavior. Future sync integrations may place bundles in the same library but must not turn SQLite
into evidence authority or treat descriptive producer labels as authenticated identity.

Future UI work may add derived views or annotations only if they can be reconstructed or are clearly
local nonportable state. It must not silently edit a final bundle, archive conversations, bypass the
daemon's artifact-ID routes, add browser polling, or weaken the shared HTML security boundary.

## Cross-phase audit record

- 2026-08-12: initial draft consumes Phase 1 routes and invalidation without joining the page to
  Phase 2 job or task rows.
- 2026-08-12: the source plan, phased index, and Phases 1-2 were re-read before drafting. The top-level
  entry point, explicit retention, directory bundle, and report-plus-explicit-files decisions remain
  unchanged.
- 2026-08-12: shared preview extraction keeps Files and Scouts on one CSP instead of creating a
  scout-only sandbox that could drift.
- 2026-08-12: the command palette receives only a static page destination, preserving its no-fetch
  provider contract and keeping archive search inside the bounded Scouts page.
- 2026-08-12: deletion consumes the Phase 1 server transaction and adds only UI confirmation,
  selection, and focus behavior. There is no second removal path or task cascade.
- 2026-08-12: final UI verification owns the root plan's full fake-agent E2E flow, including sharing,
  reindex after database loss, partial-copy settle, sandboxing, and both delete entry points.
