# Phase 2: Trust matrix over the three allowlists

Source plan: `docs/plans/settings-redesign/plan.md` (requirements R8-R11, decision D3).
Visual target: the Trust panel in `docs/plans/settings-redesign/prototype.html`.

## Outcome

One `trust` category renders a repository × grant matrix over the three existing
`repoAllowlist`s (Foreman sends live · Inspector posts reviews · YOLO merges). Cells
write to the owning subsystem's existing config route. The merge-without-review blind
spot is visible structurally. The Foreman, Inspector, and Shipping panels stop editing
repo lists and deep-link here instead.

## Entry criteria and dependencies

- Depends on: Phase 1 (page, group registry, anchor convention, panels receiving
  state as props).
- May run concurrently with Phases 3 and 4.

## Scope

In: the Trust panel, the `trust` registry entry, the three panels' repo-editor
replacement, deep-linked warnings, tests, README.

Non-goals: any new route or table (the blind-spot warning is computed client-side from
the two configs, mirroring the existing `untrustedByInspector` logic in
`ShippingSettingsPanel.tsx`; the staged-repo list below rides the existing `UiConfig`
blob); any change to allowlist storage, schemas, or the daemon's consent gates; search
entries (Phase 5 indexes what exists).

## Repository findings this phase builds on

- The three allowlists are `repoAllowlist: z.array(z.string().min(1)).default([])` in
  `src/shared/protocol.ts` (Foreman ~717, Inspector ~1033, Shipping ~1102), served and
  patched via `GET/PUT /api/foreman/config`, `/api/inspector/config`,
  `/api/shipping/config` (`src/server/routes.ts` ~1421, ~1543, ~1596). Stored paths are
  canonical repo roots - `resolveRepo` (`POST /api/repos/resolve`) canonicalizes before
  any write, so row identity is string equality.
- `repoAllowlisted` (`@shared/allowlist.ts`) is the shared membership predicate; the
  plan's rule "a third consent gate extends allowlist.ts; it does not start a matcher"
  refers to matching semantics - this phase adds no matcher, only a view.
- All three panels use the same add flow (`resolveRepo` → duplicate check → patch) and
  the same stale-closure guard (`allowlistRef`) against the 4s config poll. The Trust
  panel inherits both.
- State: after Phase 1, `SettingsPage` owns `useInspector`/`useShipping` and receives
  `foreman: ForemanState` from App. All three expose `config` and a patching `update`.
  Trust receives those three states as props - it must NOT instantiate a second
  `useForeman`, which would double-poll against App's copy.
- `ShippingSettingsPanel.tsx` already computes `untrustedByInspector` with
  `repoAllowlisted(p, null, inspectorConfig.repoAllowlist)` and explains the three
  mutually exclusive Inspector postures in order. That ordering logic stays on the
  Shipping panel; the matrix shows the repo-level view of the same fact.
- A repo added with no grants exists in no allowlist, so it needs a durable home of
  its own or it vanishes on the next reload before the operator returns to grant it.
  The `UiConfig` blob (`src/server/ui-config.ts`, `GET/PUT /api/ui/config`) is that
  home: a schema-validated KV blob where "a new key needs no migration", with shallow
  top-level-key ownership - exactly the shape a panel-owned staged list wants.

## Implementation steps

1. **Registry**: append `trust` to `SETTINGS_CATEGORIES` (group `outbound`, scope
   `github`, icon `⛨`), add the `renderCategory` case. Category ids are not persisted;
   append-only discipline still applies once shipped, because hash deep-links and Phase
   5 anchors will reference it.
2. **Staged repos** (`UiConfigSchema` in `src/shared/protocol.ts` gains
   `trustStaged: z.array(z.string().min(1)).default([])`): the durable home for a repo
   that has been added but granted nothing. The panel reads it with the existing
   `/api/ui/config` round-trip, appends the resolved root on add, prunes an entry when
   its repo gains a first grant or its row is removed, and ignores entries that have
   since gained a grant (the allowlists win). Owned whole by the Trust panel per the
   blob's shallow-merge rule. Once shipped the key name is persisted data on
   operators' machines - renaming it orphans staged rows, so treat it as append-only.
3. **Row composition** (pure helper, colocated with the panel or in
   `src/web/lib/trust.ts`): `trustRows(foremanList, inspectorList, shippingList,
   staged)` → sorted union of repos with `{ repo, foreman, inspector, merge }`;
   `mergeBlindSpots(rows, yoloArmed)` → rows where `merge && !inspector` when armed.
   Pure functions so the render test drives them without stubs.
4. **`TrustPanel.tsx`**: matrix per the prototype - header row naming grants by what
   they permit; one row per repo; cells as toggle pills writing
   `update({ repoAllowlist: [...without/with repo] })` on the owning state, reading
   current lists through refs (the stale-closure guard); a per-row remove that revokes
   all three grants (one update per subsystem that held it) and drops the staged
   entry; the add row (`RepoCombobox` + `resolveRepo`, duplicate-checked against rows
   AND staged, writing to `trustStaged` - granting nothing); the dagger footnote with
   two links (Inspector cell fix in place; "revoke the merge" in place); the
   daemon-unreachable warning when any of the three configs is null ("unknown, not
   off" - D7). `data-anchor="trust/matrix"` on the matrix and `trust/add` on the add
   row.
5. **Panel replacement**: `ForemanSettingsPanel`, `InspectorSettingsPanel`,
   `ShippingSettingsPanel` drop their repo list editors (list, remove buttons, add
   row); each renders its grant count plus a deep-link ("Manage in Trust") through the
   page's `onNavigate`, so navigation is a route change, not a prose instruction.
   `candidateRepos` moves to the Trust module (its remaining consumer);
   `fetchRepos`/`RepoCombobox` imports leave the three panels. Keep each panel's
   scope-of-consent copy ("their worktrees count too...") next to the count, since that
   sentence is about the grant, not the editor.
6. **Warning links** (R11): Shipping's three Inspector-posture warnings gain links -
   Inspector-off and dry-run link to `inspector` (anchors `inspector/enabled`,
   `inspector/mode`), the not-allowlisted one links to `trust/matrix`. The link is the
   page's `onNavigate` + anchor flash (Phase 1 convention); the warning text stays.
7. **CSS**: matrix rules in a new subsection beside the Shipping section; grep removed
   classes (`foreman-repo-*` usages that no longer render anywhere - note the classes
   may stay if Trust reuses them; decide by reuse, not by copy).
8. **README**: Trust section (what a grant means per column, the view-over-three-stores
   design, worktree note); update the Foreman/Inspector/Shipping sections' repo-list
   sentences.

## Data / API / migration

No new routes or tables. Reads and patches existing configs, plus one new key on the
existing `UiConfig` blob (`trustStaged`) - the blob's design is that a new key needs no
migration, and the schema default covers machines that have never staged a repo.
Concurrent edits from another surface are absorbed by the existing poll + ref-guard
pattern; a cell click during a poll races no differently than today's add/remove
buttons.

## Tests and verification

- `trust-panel.test.ts`: row union and sorting (staged rows included, allowlist rows
  winning over stale staged entries); blind-spot detection (armed vs not); cell click
  produces a patch for exactly the owning subsystem containing the full new list; add
  row writes only `trustStaged` and grants nothing; first grant prunes the staged
  entry; daemon-unreachable renders the unknown warning; static render with three stub
  states.
- Update `foreman-settings`/`inspector`/`shipping` panel tests for the editor →
  summary+link change; assert the Shipping warnings render links now.
- Anchor uniqueness test (Phase 1) picks up the new anchors automatically.
- `npm run typecheck && npm test && npm run build`; manual: grant/revoke each column
  against a live daemon and confirm the corresponding panel and the daemon behavior
  (Foreman live gate, Inspector posting, merge eligibility) still read the same lists.

## Merge and exit criteria

- Trust category shipped; three panels link instead of edit; no daemon diff in this PR;
  CI green.

## Downstream handoff (later phases rely on; do not change)

- Category id `trust`, anchors `trust/matrix` and `trust/add`.
- The `trustStaged` `UiConfig` key: persisted on operators' machines once shipped, so
  append-only in practice; owned whole by the Trust panel.
- `trustRows`/`mergeBlindSpots` as the row/blind-spot vocabulary (Phase 5 indexes the
  Trust controls; Phase 4 does not consume these).
- The three panels no longer own repo editing - a later feature adding a fourth grant
  extends the matrix columns, not a panel.

## Cross-phase audit record

- 2026-07-23: initial version. Checked against Phase 1's handoff (uses `onNavigate` +
  anchors, receives states as props, appends to both registries). Checked against Phase
  4: no shared files beyond `SETTINGS_CATEGORIES` (append vs field-add - compatible in
  either merge order). Checked against Phase 5: anchors and category id recorded as
  index inputs.
- 2026-07-23 (Inspector round 1): "add grants nothing" was not durable - a row built
  only from the union of the three allowlists disappears on the next reload if it holds
  no grant. Resolved with the `trustStaged` `UiConfig` key (no new route or table;
  schema default covers existing machines); the row helper takes the staged list as a
  fourth input, and the source plan's R8 and out-of-scope wording were updated to
  match. Immediate-grant-on-add was rejected because it contradicts the plan's
  "adding is configuration; enabling is consent" requirement.
