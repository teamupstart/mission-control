# Phase 3: In-app prompt and controls

**Source plan:** [`plan.md`](plan.md) - **Index:** [`phased-plan.md`](phased-plan.md)
**Direct prerequisites:** Phase 2
**Merge unit:** one pull request in `mancej-cyc/ai-harness`

## Outcome

The update is discoverable without opening a menu. A dashboard banner tells the user a new version
exists, lets them read what changed, and lets them update or dismiss. If a previous update failed, the
banner says so. The plain browser build is completely unchanged: no bridge, no banner, no new network
call.

## Entry criteria

- Phase 2 merged, with the `UpdateSnapshot` union, the controller, and the action set in place.
- The quit ordering is already correct, so this phase does not re-solve it.

## Scope

1. `src/main/index.ts`: `ipcMain.handle` commands and the `mission:update-state` push.
2. `src/preload/index.ts`: the bridge surface.
3. `src/web/mission-desktop.d.ts`: the matching declaration.
4. `src/web/useDesktopUpdates.ts`: a guarded hook.
5. `src/web/components/UpdateBanner.tsx`: the banner.
6. `src/web/App.tsx`: mount it.
7. `src/web/styles.css`: banner styling.
8. `docs/desktop-and-packaging.md`: the in-app prompt, the actions a user has, and where a failed
   update is surfaced.
9. Render tests, an IPC and preload contract test, and a Playwright spec in `e2e/`.

### Non-goals

- No change to the controller's behavior, scheduling, or state shape. If the UI wants a field the
  snapshot does not have, that is a Phase 2 change and must be reconciled there, not patched here.
- No new updater capability. The banner exposes exactly check, apply, and defer.
- No `data-testid` anywhere. The repository forbids it.
- No settings page entry for updates in v1.

## Repository findings

- **The push-channel precedent, including its race guard**, is `src/main/index.ts:46-54`:

  ```ts
  if (wc.isLoading()) wc.once("did-finish-load", () => wc.send("mission:open-settings"));
  else wc.send("mission:open-settings");
  ```

  The update-state push needs the same treatment, or the first snapshot can be sent into a window that
  is still loading and silently lost.
- **The preload is flat today** (`src/preload/index.ts:1-24`): `isDesktop`, `version`,
  `openExternal`, `installIntegrations`, `removeIntegrations`, `onOpenSettings`. Its subscribe pattern
  is the one to copy exactly:

  ```ts
  onOpenSettings: (cb: () => void): (() => void) => {
    const listener = (): void => cb();
    ipcRenderer.on("mission:open-settings", listener);
    return () => ipcRenderer.removeListener("mission:open-settings", listener);
  },
  ```

  The wrapper deliberately drops the `IpcRendererEvent` so no Electron object crosses the bridge.
- **Adding six flat members would take the bridge from five to eleven.** Grouping them under an
  `updates` namespace is cleaner, but it is a departure from the existing flat shape, so the pull
  request must say so and justify it. Either choice is defensible; what is not acceptable is a silent
  departure.
- `docs/agent-guides/change-contracts.md:726-735` defines the required capability chain and states
  explicitly that "Push channels also need `webContents.send` plus preload subscribe and unsubscribe
  functions." All four links plus the push are in scope here.
- **No `useDesktop*` hook exists.** Renderer hooks are flat files directly under `src/web/`
  (`useConductor.ts`, `useCost.ts`, and so on). Follow that placement.
- **The only app-level mount seam** is between `</header>` and `<AppPageShell ... />` in
  `src/web/App.tsx` (around lines 2479 to 2481). `AppPageShell` itself
  (`src/web/components/AppPageShell.tsx`) is `({ page, overlays, ...slots }) => <>{slots[page]}{overlays}</>`
  with props typed `Record<MissionRoute["page"], ReactNode>` and has no banner slot.
- `AlertBar` (`src/web/components/AlertBar.tsx`) is the existing app-level status component, but it
  lives *inside* the topbar's `tb-group tb-tools` and is not full-width. It is a styling reference, not
  a mount location.
- Existing banner CSS is feature-scoped: `.rm-banner` and `.rm-banner-attention` at
  `src/web/styles.css:26271,26278`, plus schedule-provenance banners at `:27205,27258`. There is no
  generic app-banner class to reuse, so this phase creates one.
- **Geometry risk.** `--topbar-h` is measured off the topbar at runtime and is load-bearing for card
  geometry, and the `--cmdbar-clearance` effect sits at `src/web/App.tsx:3130-3142`. The Electron
  geometry tests compare used height across pages (see the height-invariant commentary in
  `test/line-drawer-electron.test.ts:20-45`). A new full-width element below the header changes
  available height on every page.
- **The fake-bridge precedent** is `e2e/specs/context-menu.spec.ts:138-172`: a partial
  `window.missionDesktop` defined with `Object.defineProperty(..., { configurable: true, value: {...} })`
  via `page.evaluate` after load, with `configurable: true` being what allows a second redefinition for
  the failure-path variant. It asserts a visible `getByRole("status")`.

## Inherited contracts

From Phase 2, consumed and not changed: the `UpdateSnapshot` union including `lastOutcome`, the
synchronous snapshot read, the change emission, and the check/apply/defer action set.

## Implementation steps

### 1. Main process

In `registerIpc()`, add handlers using the existing flat `mission:` channel style: a state read, and
check, apply, and defer commands. Push snapshot changes on `mission:update-state`, guarded by the
`isLoading()` / `did-finish-load` pattern above.

Subscribe to the controller once, in `whenReady`, and fan out to the current window. Do not let the
renderer drive scheduling.

### 2. Preload and declaration

Expose the surface and return an unsubscribe closure from the subscription, copying `onOpenSettings`.
Mirror it exactly in `src/web/mission-desktop.d.ts`, keeping the existing method-shorthand style and
leaving `missionDesktop` optional on `Window`.

Nothing beyond the sanitized snapshot may cross. No paths, no URLs, no raw error text, no
`IpcRendererEvent`.

### 3. Hook

`src/web/useDesktopUpdates.ts`. Guard on `window.missionDesktop` so the browser build gets a stable
"no updates surface" result. Return the unsubscribe from the effect, in the style of the existing
`onOpenSettings` effect at `src/web/App.tsx:424-430`.

**Subscribe first, then read the snapshot.** Either order leaves a window; only this one leaves a
window that is harmless. Subscribing first means a change landing during the read is still delivered,
and because every message is a whole snapshot rather than a delta, the redundant delivery is
idempotent - the worst case is rendering the same state twice. Reading first means a change landing
between the read and the subscription is delivered to nobody, and the banner stays stale until the
next scheduled check, which can be six hours away.

Guard against the resulting out-of-order risk rather than ignoring it: a snapshot that arrives while
the initial read is still in flight must win over that read's result. Sequence the two so the
subscription's value is never overwritten by an older read.

### 4. Banner

`src/web/components/UpdateBanner.tsx`, rendering nothing unless there is something to say. States to
cover: available, applying, error on a manual check, and a `lastOutcome` failure or success.

- Available: the new version, a short truncated note summary, Update Now, and Later.
- Applying: a non-alarming "preparing to update" message. The app is about to quit, so this state is
  brief by nature and must not imply progress it cannot report.
- Error and previous-failure: a plain safe message and, when the origin was manual, Retry.
- Success after update: a brief confirmation that clears once dismissed or on the next state change.

Accessibility: use `role="status"` for the informational states, as the existing context-menu error
toast does, give every control a real accessible name, and never rely on color alone. Truncate release
notes in the renderer as well as the main process.

### 5. Mount and style

Mount between `</header>` and `<AppPageShell ... />` in `src/web/App.tsx` so the banner spans the full
width above every page. Do not add a slot to `AppPageShell`; its exhaustive `Record` typing exists to
force a body per page and should not be diluted.

Add a generic app-banner class in `src/web/styles.css`, taking visual cues from `.rm-banner`. In
Electron the top bar is a drag region, so confirm the banner's buttons are clickable and add the
desktop `no-drag` rule if they sit in a drag area (`docs/agent-guides/change-contracts.md:752`).

**Then re-run the Electron geometry tests.** If inserting the banner shifts measured height, fix the
clearance calculation rather than loosening the assertion, and record what changed in the pull request.

## Data and compatibility details

- No persisted state, no schema, no migration. The banner is derived entirely from the live snapshot.
- The browser build must be byte-for-byte unaffected in behavior: no bridge, no banner, no request.
- The IPC channel names become a contract the moment they ship. Pin them in a test.

## Tests and verification

Render tests with `renderToStaticMarkup` (no jsdom, no Testing Library):

- every banner state renders its expected copy and controls;
- accessible names are present;
- release notes are truncated;
- the banner renders nothing when there is nothing to report;
- the banner renders nothing in browser mode.

IPC and preload contract test:

- exact command and push channel names;
- the snapshot the renderer receives carries no path, URL, or raw error field;
- the subscription's unsubscribe actually removes the listener;
- **the hook subscribes before it reads**, and a snapshot pushed while the initial read is still in
  flight is not overwritten by that read's older result. Drive it with a deliberately slow fake read
  so the ordering is asserted rather than assumed.

Playwright spec in `e2e/` - **required, because this is a UI change**:

- inject a fake `window.missionDesktop` with `configurable: true` following
  `e2e/specs/context-menu.spec.ts:138-155`, exposing only the update members the spec drives;
- drive available, then Update Now, then the applying state;
- drive Later and assert the banner goes away;
- drive an error state and the manual Retry path;
- select by role, label, or placeholder only. No `data-testid`.
- Spend no model tokens and perform no real update. The fake bridge is the whole boundary; nothing in
  this spec may reach `gh`, a build, or `/Applications`.

Read [`e2e/README.md`](../../../e2e/README.md) before writing the spec. `npm run test:e2e` needs
`npm run build` first, and Chromium via `npx playwright install chromium` once per machine.

Commands that must pass: `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:electron`,
`npm run build`, `npm run smoke`, `npm run test:e2e`.

Visual verification: a screenshot of each banner state attached to the pull request, produced in a
gitignored location and never committed.

## Merge and exit criteria

- A user can see, defer, and accept an update from the dashboard.
- Deferring hides the banner until the next scheduled check or next launch, with no permanent ignore
  switch.
- A previous failed update is visible in the app rather than only in a log.
- The browser build renders no updater UI and makes no updater call.
- The Electron geometry tests pass, with any clearance change explained.
- The Playwright spec covers the full fake-bridge flow and spends no model tokens.
- All gates above pass.

## Downstream handoff

Nothing in v1 depends on this phase. If a later change adds a settings entry, an update channel
selector, or a canary ring, it consumes the hook and the banner rather than reaching into the bridge,
and it must not move update decisions into the renderer.

## Cross-phase audit record

- **2026-08-18, authored.** Reconciled against Phases 1 and 2. Confirmed this phase consumes Phase 2's
  union and action set without widening either, and that no new snapshot field is required: the
  previous-failure surface is served by `lastOutcome`, which Phase 2 already owns. Confirmed the native
  dialog from Phase 2 is retained rather than replaced, since it is the hidden-window path. Two risks
  found here and recorded rather than deferred: the flat-versus-namespaced preload departure, and the
  topbar geometry interaction. Neither required an edit to an earlier phase.
- **2026-08-18, final set audit.** Same documentation gap found across the set: added
  `docs/desktop-and-packaging.md` to this phase's scope so the prompt and the failure surface are
  documented by the phase that introduces them. No contract change to Phase 1 or Phase 2.
- **2026-08-18, Inspector round 1.** Corrected the subscription ordering. The plan said read the
  snapshot then subscribe, inherited from issue #642, and that loses any transition landing in the gap.
  Now: subscribe first, then read, which is safe precisely because every message is a whole snapshot
  rather than a delta, so a redundant delivery is idempotent. Added the out-of-order guard and a test
  that drives it with a slow fake read.
