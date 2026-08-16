# Phase 2: System profile UI and owner cross-links

## Outcome and value

Foreman becomes a first-class, editable System profile in `Library -> Personas` while remaining
architecturally absent from workflow and ensemble Persona catalogs.

After this phase, an operator can open the canonical `#/library/personas/foreman` route, understand
which parts of Foreman are application-owned, edit and preview its exact standing Markdown, save with
conflict protection, clear it intentionally, reset it to the shipped default, copy or download it,
and follow precise links to the existing provider/model, posture, and Trust controls. Settings shows
the current guidance source and links back to the one editor. No workflow or ensemble can select the
System profile.

## Entry criteria and direct dependencies

- Direct dependency: Phase 1 has merged its shared view/update schemas, source-only status metadata,
  CAS route, conflict body, body limit, and worker compatibility.
- Direct dependency: this planning session has merged every file in
  `docs/plans/editable-foreman-profile/` to the default branch.
- The scheduled Phase 2 task remains disabled after those dependency edges are satisfied. A human
  explicitly enables it when implementation should begin.
- Read these files first:
  - `docs/plans/editable-foreman-profile/plan.md`
  - `docs/plans/editable-foreman-profile/phased-plan.md`
  - `docs/plans/editable-foreman-profile/phase-1-conflict-safe-guidance-contract.md`
  - this phase file
- Confirm Phase 1's exported names and 409 response on the current default branch. Consume what
  actually merged, and record any necessary adaptation in the pull request.

## Scope

- focused browser API and editor state management for standing guidance;
- the fixed System row and canonical route inside the existing Persona Library surface;
- one System card on the Library front-page Persona shelf;
- fixed identity, editable-boundary explanation, source state, model/authority summaries, and owner
  cross-links;
- save, refresh, conflict, clear, reset, preview, shortcut, copy, download, and dirty-navigation
  behavior;
- one read-only Standing guidance source card in Foreman Settings linking to the profile;
- regression coverage that Foreman never enters workflow or ensemble Persona choices;
- UI styles, README and technical documentation updates, and Playwright evidence.

## Explicit non-goals

- no backend storage, schema, ETag, status, or prompt changes beyond adapting to the contract Phase 1
  actually merged;
- no rename, editable description, duplicate, import, re-import, archive, delete, activation, or
  version-history action for Foreman;
- no provider/model, posture, top-bar, Trust, allowlist, scheduling, or authority write from the
  profile;
- no `PersonaView` extension, eligibility flag, Persona API row, Registry/SSE event, workflow graph
  migration, or ensemble schema change;
- no change to the roles that receive standing guidance;
- no backlog-planner prompt change;
- no per-repository or per-session guidance.

## Repository findings and inherited contracts

- `PersonaLibrary` owns selection, search, active/archived filtering, discard confirmation, and the
  route callback. Today every selected id is resolved against streamed `PersonaView[]`; `foreman`
  needs a local branch without entering that array.
- The Persona router already round-trips opaque ids. `foreman` is a valid asset id under the current
  grammar; changing `MissionRoute` or `missionRouteHash` is unnecessary.
- `PersonaEditor` directly owns Persona revisions and mutations, so it must not be parameterized into
  accepting Foreman's different data model. Its visual primitives are separately importable.
- App already owns `useForeman()`, whose `status` contains the resolved runner, four models, and after
  Phase 1 the guidance source. Do not add another polling hook for summary data.
- App's `settingsJump` already selects and flashes a Settings anchor after navigation. The profile can
  reach the Models tab through `foreman/provider`, posture through `foreman/cheap-tier`, and Trust
  through the existing Trust anchor without making anchors part of the URL grammar.
- `ForemanBar` owns its open state inside the component. A one-shot request prop can open the existing
  control from the profile without lifting its entire state or creating a second authority surface.
- `ForemanSettingsPanel` receives a Settings-only navigator. Opening the Library requires a new
  explicit callback passed through `SettingsPage` from App.
- `LibraryPage` and `personaCards()` currently project only workflow Personas. The local System card
  must be composed beside that projection and excluded from all workflow counts.
- The global dirty gate is driven by `onDirtyChange` from the mounted Library surface. A focused
  editor can reuse it without adding a second router guard.
- UI changes require a Playwright spec under `e2e/`, selected by roles, labels, or placeholders with no
  `data-testid`.

## Implementation steps

### 1. Add a focused browser API

Create a small Foreman-profile API module beside the Persona Library code rather than widening the
generic Persona request helper.

It should:

- fetch and parse `ForemanInstructionsView` from GET `/api/foreman/instructions`;
- PUT a typed `ForemanInstructionsUpdate` and return the new view;
- raise a typed error carrying HTTP status, the conflict code, and `current` when a 409 occurs;
- expose a Markdown blob helper if the existing Persona helper cannot be reused without implying a
  Persona data model;
- never trim, normalize, or otherwise transform document text.

Use the shared schemas/types from Phase 1. Do not hand-parse source strings or duplicate the
64,000-character constant.

### 2. Build `ForemanProfileEditor` from existing Library primitives

Add a focused component under `src/web/workflows/` using:

- `LibraryWorkspaceHeader` for the fixed identity and promoted Save action;
- `LibraryPropertyChip` for source, provider/model summary, authority summary, and character usage;
- `FileEditor` and `Markdown` for Editor and Preview modes;
- `useCopyFeedback` for Copy Markdown;
- the existing overlay confirmation contract for Reset;
- the same Cmd/Ctrl+S semantics as the Persona editor, suppressed while an overlay is open.

The fixed header and boundary copy are:

- name: **Foreman**;
- application-owned description explaining that Foreman reviews and coordinates Mission Control
  work;
- tags: **System profile** and **Not available to workflows or ensembles**;
- no editable name or description fields;
- no Persona revision label and no Persona-only action.

The editor state machine must have one authoritative loaded `ForemanInstructionsView`, a draft string,
an edit generation, dirty state, saving state, optional conflict view, and an error. Implement these
transitions:

1. **Initial selection:** fetch only when the Foreman profile is selected. Adopt the returned exact
   text, ETag, default, and source.
2. **Window focus:** refetch when the window regains focus while the profile remains selected.
   - clean and changed: adopt the new view;
   - dirty and same ETag: keep the draft with no warning;
   - dirty and changed ETag: keep every local byte and show a conflict.
3. **Save:** send `{ expectedEtag: loaded.etag, text: draft }`. Empty is a valid save. If no edit
   occurred while the request was in flight, adopt the reply and clear dirty; otherwise preserve the
   later local edits, update the acknowledged base to the reply, and remain dirty.
4. **Stale save/reset:** retain the local draft and show the 409 `current` view. Do not automatically
   retry.
5. **Reload latest:** replace the draft and loaded base with `current`, then clear dirty and conflict.
6. **Keep editing:** preserve the draft, adopt `current` only as the new comparison base and expected
   ETag, clear the conflict banner, and remain dirty. The next Save is the operator's explicit
   overwrite attempt against that known current state.
7. **Reset:** when source is custom or none, or a dirty draft would be discarded, require the existing
   Mission Control confirmation overlay. PUT `{ expectedEtag, reset: true }`; on success adopt the
   built-in view. Do not represent reset as an empty save.
8. **Copy and download:** operate on the exact local draft, including while conflicted. Download as
   `FOREMAN.md` with `text/markdown;charset=utf-8`.
9. **Character ceiling:** report `draft.length` against the shared 64,000-character contract and
   disable Save above it. Do not reuse the Persona guidance UTF-8 byte label, which is a different
   schema.
10. **Dirty navigation:** report dirty state through the parent so rail selection, Escape, hash
    navigation, page navigation, and browser unload use the existing discard path.

Show source labels exactly as **Built-in default**, **Customized**, and **No standing guidance**.
Reset is absent or disabled with a precise hint while the loaded built-in default is clean. A dirty
draft based on the built-in source may still Reset after confirmation so the operator can discard it.
Copy and download remain available in every source state.

### 3. Compose the fixed System row into `PersonaLibrary`

Keep `PersonaView[]`, `groupPersonas()`, streamed Persona selection, and Persona mutations unchanged.
Compose the fixed row locally:

1. Define one browser-local `FOREMAN_PROFILE_ID = "foreman"` and fixed identity metadata in a focused
   module or beside the surface. Do not export it from the shared workflow contract.
2. Render a **System** group before **Built-in** and **Yours**, with one Foreman row. The System row
   remains available above workflow Persona Active/Archived and search filtering because the System
   profile cannot be archived and is not a workflow catalog member.
3. Use the resolved runner from existing Foreman status and a detail such as
   `<provider> · 4 model roles`. Its tags/tooltips state System and workflow/ensemble exclusion.
4. Treat `initialPersonaId === "foreman"` as the fixed selection, mount `ForemanProfileEditor`, and
   report `foreman` through `onSelectionChange` so the canonical route remains in the address bar.
5. Switching between Foreman, a Persona, and a new/import draft goes through the existing
   `guardDiscard` flow. Never look up `foreman` through `ordered`, set `localPersona`, or pass it to
   `PersonaEditor`.
6. Keep New, import, upstream, active/archived, and ordinary Persona behavior intact. No System row
   action may call `/api/personas`.

Add render and routing tests for direct entry, reload-stable selection, row order, fixed identity,
allowed actions, forbidden Persona actions, and dirty selection behavior.

### 4. Add the System card to the Library front page

Add one local System card to the Persona shelf ahead of cards from `personaCards()`:

- name **Foreman**;
- fixed application-owned description;
- System tag;
- fact naming its resolved provider and four model roles;
- open hint saying it edits standing guidance and is unavailable to workflows and ensembles;
- click opens `{ page: "library", shelf: "personas", assetId: "foreman" }`.

Do not pass Foreman into `personaCards()`, change the workflow Persona count, or alter the Personas
shelf's New action.

### 5. Connect summaries to their existing owners

Use explicit App callbacks rather than raw hash assignment:

1. Add an App helper that navigates to a Settings category and, when supplied, sets the existing
   `settingsJump` anchor with a new nonce. Reuse it for profile links to:
   - Models: `settings/foreman`, anchor `foreman/provider` so the Models tab opens;
   - posture: `settings/foreman`, anchor `foreman/cheap-tier`;
   - Trust: `settings/trust`, anchor `trust/matrix`.
2. Give `ForemanBar` a one-shot open-request prop and keep its existing internal close behavior. App
   owns only a nonce and passes a callback to the profile's authority summary. Clicking it opens the
   existing top-bar Foreman control in place; it does not navigate or create a duplicate control.
3. Pass only read-only resolved Foreman summary data and navigation callbacks into `LibraryPage` and
   `PersonaLibrary`. Do not pass the config updater into the profile.
4. Extend `SettingsPage` and `ForemanSettingsPanel` with `onOpenForemanProfile`.
5. Add a compact **Standing guidance** `ConsoleCard` near the stable posture. Read
   `status.instructionsSource`, render the same three source labels, explain that judgment prose is
   edited in the System profile, and provide one button that opens
   `#/library/personas/foreman`.
6. Keep the existing Models, Posture, Launches, Safety, Live repositories, and ledger controls in
   place. The new card performs no write and no document fetch.

### 6. Lock workflow and ensemble exclusion

Add regression assertions at the boundaries that matter:

- the local System row/card does not increase or mutate the `PersonaView[]` input;
- `/api/personas` and `/api/personas/foreman` remain catalog-only, with the latter returning the
  ordinary unknown-Persona response;
- opening/saving/resetting the System profile emits no `persona_upsert` and changes no Registry
  Persona snapshot;
- workflow pipeline choices and graph validation still resolve only actual Persona ids, and a forged
  `foreman` id fails as unknown;
- ensemble evaluator choices still draw only from supplied `PersonaView[]`, and a forged Foreman
  reference is unavailable/invalid through the existing contract;
- palette indexing does not claim Foreman is an ordinary Persona unless a separate, explicitly local
  System-profile palette entry is intentionally added and tested. Adding that entry is optional and
  not required by the source plan.

Prefer tests over production filters. If implementation needs a `stageEligible` flag or starts
filtering Foreman out downstream, it has violated this phase's separation contract.

### 7. Add browser proof, visual verification, and documentation

Create `e2e/specs/foreman-profile.spec.ts` using the built dashboard and daemon with fake agents. It
must not launch a model or agent. Cover one coherent operator journey:

1. open the Library front page and the System Foreman card;
2. assert the canonical hash, fixed identity, source, and workflow/ensemble exclusion copy;
3. enter exact Markdown with meaningful whitespace, preview it, save it, reload, and observe the same
   content;
4. open the existing top-bar Foreman control from the authority summary, follow the Models link and
   prove the Foreman Models tab/anchor is reached, then follow the Trust link to its matrix and return
   to the profile;
5. clear the document and save, then assert **No standing guidance**;
6. reset through the Mission Control confirmation overlay and assert **Built-in default** plus the
   shipped content;
7. capture the final profile in `e2e/.artifacts/` for pull-request evidence.

Add focused tests for focus refresh, dirty conflict, Keep editing rebase, stale reset, in-flight edit
reconciliation, character limit, reset confirmation, copy/download content, Settings source labels,
owner navigation, one-shot top-bar opening, System group order, front-page card, and absence of
Rename, Duplicate, Archive, Delete, Re-import, and editable identity fields.

Update in the same pull request:

- `README.md` for the user-facing Library location and fixed System boundary;
- `docs/foreman.md` for source states, CAS behavior, runtime capture, editable versus fixed guidance,
  and the Library/Settings ownership split;
- `docs/library-and-line.md` for the System group/card and why it is outside workflow Persona counts;
- `docs/workflows.md` for explicit workflow and ensemble exclusion;
- `personas/README.md` to replace the stale note that places the future editor in Settings with the
  shipped System-profile location.

Do not commit Playwright screenshots or transcripts. Attach evidence to the pull request.

## Data, API, migration, and compatibility details

- Consumes Phase 1's GET, PUT, shared types, 409 code/current body, status source, and character limit.
- Adds no database write path and no migration.
- Adds no global fetch of the guidance document. Only the selected editor fetches it, plus its window
  focus refresh.
- Uses existing `useForeman` state for resolved provider/models and source summaries.
- Adds no document field to `ForemanStatus`, SSE, Registry, or `PersonaView`.
- Keeps empty save and reset as distinct operations in every UI label and test.
- Keeps exact local bytes through dirty and conflict states. Markdown preview may render normalized
  HTML visually, but Save, Copy, and Download use the untouched draft string.
- Leaves workflow publication snapshots, workflow Persona revisions, and ensemble metadata unchanged.

## Verification commands

Run focused tests with the required preload, adjusting the file list only to match the implementation's
actual focused test owners:

```sh
node --test --import ./test/setup-state.mjs --import tsx \
  test/persona-editor-render.test.ts \
  test/library-page-render.test.ts \
  test/library-route.test.ts \
  test/foreman-settings-render.test.ts \
  test/foreman-settings-tabs.test.ts \
  test/workflow-pipeline-render.test.ts \
  test/ensemble-dispatch-render.test.ts \
  test/http-integration.test.ts
```

Then run the repository gates in this order:

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npm run test:e2e -- e2e/specs/foreman-profile.spec.ts
```

Visually inspect the profile at desktop width and a narrow supported viewport in both light and dark
schemes. Confirm the header actions, property chips, file toolbar, conflict banner, and confirmation
overlay remain usable without horizontal page overflow. Attach the evidence from the gitignored
artifact directory to the pull request.

## Merge and exit criteria

- Phase 1 is merged and this phase consumes its public contract without a duplicate dialect.
- All focused, full, build, smoke, and dedicated browser gates pass.
- The visual evidence is attached to the pull request and no evidence artifact is committed.
- `#/library/personas/foreman` opens directly, survives reload, and reports the fixed selection back to
  the router.
- Exact edit, preview, save, reload, empty save, conflict resolution, copy, download, and reset behavior
  matches the approved source plan.
- Settings reports source without fetching or editing the document and links to the one profile.
- Profile links land on the existing Models, posture, and Trust owners without creating duplicate
  controls.
- Foreman remains absent from Persona APIs, Registry/SSE, workflow choices and validation, and ensemble
  choices.
- README and technical docs describe the shipped surface and remove the stale Settings-editor note.
- Automated reviewer findings are checked against the repository, valid in-scope findings are fixed on
  the same pull request, and no approved boundary is weakened to satisfy an invalid comment.
- The pull request records and explains any deviation from this proposed route, is green, and merges.

## Downstream handoff

After this phase, future work may rely on:

- one canonical System profile route and one local System row/card;
- one exact-text CAS document editor with explicit built-in, custom, and none states;
- source summaries available without transporting the document globally;
- owner cross-links rather than duplicate model or authority writers;
- workflows and ensembles continuing to treat `PersonaView[]` as the complete eligible Persona
  catalog;
- the next Foreman evaluation reading a save while an in-flight evaluation keeps its captured value.

Future work must not infer that the System-profile pattern makes Foreman a general Persona. Immutable
history, new prompt roles, per-repository guidance, palette expansion, or workflow eligibility each
requires a separate approved change.

## Cross-phase audit record

- **Inherited contract audit:** this phase consumes Phase 1's exact view/update schemas, source field,
  status metadata, 409 body, and character ceiling. It adds no second response or local source enum.
- **Selection audit:** `foreman` is resolved before streamed Persona lookup and never inserted into the
  streamed list. Ordinary Persona creation, import, revision, archive, search, and upstream behavior
  remain unchanged.
- **Owner audit:** the profile writes guidance only. Settings and Trust remain the only typed writers;
  Settings reads source from status and links back without fetching the document.
- **Concurrency audit:** Phase 2 depends directly on Phase 1 and has no safe concurrent path because
  its editor and tests import the Phase 1 contract.
- **Final full-set audit:** every source-plan requirement is represented once: Phase 1 owns persistence
  and runtime safety; Phase 2 owns visible authoring, conflict UX, local composition, cross-links,
  exclusion proof, docs, and evidence. No cleanup phase or undocumented later repair is required.
