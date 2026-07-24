# Phase 4: Settings status on the live channel, rail dots, gear dot

Source plan: `docs/plans/settings-redesign/plan.md` (requirements R13-R14, decision
D6). Visual target: the rail dots and topbar gear dot in
`docs/plans/settings-redesign/prototype.html`.

## Outcome

The daemon emits a `settings_status` event (and snapshot field) whenever the small
status tuple changes; the rail shows per-category dots (Inspector live, YOLO armed,
failing task source, Foreman on) and the topbar gear inherits the worst one - visible
without opening Settings.

## Entry criteria and dependencies

- Depends on: Phase 1 (page and rail exist to carry the dots).
- May run concurrently with Phases 2 and 3.

## Scope

In: shared event type, daemon compose + emission, `useEventStream` reduction, rail and
gear dots, tests, README.

Non-goals: any new poll (the live channel is SSE only - house rule); Foreman status in
the payload (App already owns `ForemanState`; the Foreman dot derives from it); a hub
or rollup banner (out of scope in the source plan); Trust-specific dots beyond the
armed-trap dot derivable client-side.

## Repository findings this phase builds on

- `ServerEvent` (`src/shared/types.ts` ~1732) already carries scalar status frames -
  `cost_fleet` is the worked example, emitted via `registry.emitEvent(...)`
  (`src/server/registry.ts` ~2744) and included in `registry.snapshot()`. The
  compiler-enforced contract: a new variant needs a `case` in
  `src/web/useEventStream.ts`, and a snapshot-carried field extends the `snapshot`
  case, `registry.snapshot()`, and `MissionState`.
- Producers of the status facts: `PUT /api/inspector/config`,
  `PUT /api/shipping/config`, `PUT /api/task-sources/config` handlers
  (`src/server/routes.ts` ~1543, ~1596, ~1636), plus the task-source sweep path (the
  background loop and `POST /api/task-sources/:id/sweep`), whose status view
  (`taskSourcesView().status[].lastError`) defines "failing".
- The Foreman worker never touches the DB and is not involved; everything here is
  daemon-side reads of its own config stores.
- `SettingsPage` receives App-owned state as props (Phase 1 handoff); the dots' data
  arrives the same way (`MissionState.settingsStatus` + `foreman.config?.enabled`).

## Implementation steps

1. **Shared type** (`src/shared/types.ts`):
   `SettingsStatus = { inspector: { enabled: boolean; mode: "dry-run" | "live" },
   shipping: { autoMerge: boolean }, taskSources: { failing: number } }`;
   `ServerEvent` gains `{ type: "settings_status"; status: SettingsStatus }`; the
   snapshot variant gains `settingsStatus: SettingsStatus`.
2. **Daemon compose** (`src/server/settings-status.ts`): one pure-ish
   `settingsStatus()` reading `getInspectorConfig()`, `getShippingConfig()`, and the
   task-source status map; `registry.snapshot()` includes it; a
   `publishSettingsStatus(registry)` helper emits the event, called from the three
   config PUT handlers and wherever a sweep records or clears `lastError` (both the
   loop and the manual sweep route). Emission on every call is acceptable; suppressing
   no-change frames is optional polish, decided in-code with a comment.
3. **Web reduction** (`src/web/useEventStream.ts`): `MissionState.settingsStatus`
   (nullable until the snapshot lands - "unknown", not defaults); `snapshot` and
   `settings_status` cases.
4. **Dots**: rail items in `SettingsPage` render a dot slot -
   inspector: green when `enabled && mode === "live"`; shipping: amber when
   `autoMerge`; task-sources: red when `failing > 0`; foreman: purple when
   `foreman.config?.enabled` (from the App-owned state); trust (once Phase 2 is merged;
   guard on the category existing via the registry, not a literal): amber when armed
   with blind spots, derivable from `settingsStatus.shipping.autoMerge` plus the
   configs the page already holds. The topbar gear renders the worst dot
   (red > amber > green > none) from the same `MissionState` field - a null status
   renders no dot.
5. **CSS**: dot rules in the settings-page section (tones from the existing state
   ramp: `--idle`/`--attention`/`--danger`/`--foreman`; no new tokens).
6. **README**: one paragraph under the settings section - what each dot means and that
   the gear inherits the worst.

## Data / API / migration

New SSE variant only; no persistence, no route shape changes (the PUT handlers gain an
emission side-effect). Old dashboards ignore unknown event types by construction of the
`useEventStream` switch - verify the default case tolerates unknowns rather than
throwing, and say so in the test.

## Tests and verification

- `settings-status.test.ts` (server): compose reads the three stores correctly; the
  three PUT handlers and a sweep-error transition each emit `settings_status` (route
  tests via `buildApp` with stub registries, per house pattern); snapshot carries the
  field.
- `useEventStream` reduction test: snapshot seeds it, `settings_status` replaces it,
  absence renders null.
- Render test: dots appear per state matrix above; gear worst-dot ordering.
- `npm run typecheck && npm test && npm run build`; manual: flip Inspector mode and
  YOLO against a live daemon with the page closed, watch the gear dot change without
  any poll in the network tab.

## Merge and exit criteria

- Dots live end-to-end over SSE; no polling added; CI green.

## Downstream handoff (later phases rely on; do not change)

- `SettingsStatus` shape and the `settings_status` variant (append fields rather than
  reshaping; old values persist only in-flight, so the shape is cheap to extend but
  breaking to rename).
- `MissionState.settingsStatus` as the one client-side source for these facts - Phase 5
  and any future surface read it, never re-poll.

## Cross-phase audit record

- 2026-07-23: initial version. Merge-order independence with Phases 2/3 verified: the
  trust dot is guarded on the registry containing `trust`, so this phase merges cleanly
  before or after Phase 2; no shared files with Phase 3. Phase 1's prop-flow handoff is
  respected (status arrives via props/MissionState, no new hook in the page).
