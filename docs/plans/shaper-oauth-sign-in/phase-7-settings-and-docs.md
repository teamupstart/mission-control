# Shaper sign-in - Phase 7: Settings and docs

## Outcome

An operator signs a shaper in and out from **Settings > Task shaping** (S2, D3). Each marked
shaper's row shows its sign-in's state, live, and where the sign-in is kept. The dashboard
opens the authorization URL and also offers it as a link. A Playwright spec covers the
whole path, and the documentation says where the token lives (S8).

This is the phase that makes the feature usable. With `shaper-sign-in` off, Settings looks
as it does after Phase 3.

## Entry criteria and dependencies

- Phases 5 and 6 are merged.

## Hard rules

- No reading, copying, exporting or passing of real credentials: no Keychain reads of other
  applications' items, no `auth.json`, no OAuth tokens or API keys other than this
  feature's own fake-valued test fixtures, and nothing under `~/.claude*` or `~/.codex*`.
- Tests use a loopback mock authorization server and fake values only.
- No real login against Okta or the gateway, and no request to either. The real sign-in
  check is the operator's own step, with Tom, after this phase. No task does it.
- The feature's own Keychain item names are unique. A test that writes an item removes it
  and verifies it is gone. The browser spec's daemon uses the memory store.
- No full unit suite and no full end-to-end suite locally. Run this phase's own test files
  and its one focused spec, with `npm run typecheck` and `npm run lint`. CI runs the full
  suites.

## Scope

- `src/web/lib/api.ts`: `signInShaper` and `signOutShaper`.
- `src/web/lib/shaping-settings.ts`: what a row says for each state.
- `src/web/components/TaskShapingView.tsx` and `TaskShapingPanel.tsx`, and the wiring in
  `src/web/App.tsx` that hands them `shapingSignIns`.
- The stylesheet the shaping rows use.
- `e2e/specs/shaper-sign-in.spec.ts`.
- Docs: `docs/task-shaping.md`, `docs/security.md`, `docs/configuration.md`,
  `docs/skills-and-settings.md`.

Not here: any daemon change. If a daemon change seems needed, it belongs to an earlier
phase's contract: stop and report instead of adding one.

## Repository findings and inherited contracts

- From Phase 6: `POST /api/shaping/sign-in` answers
  `{ authorizationUrl, expiresAt, connection }`, `POST /api/shaping/sign-out` answers
  `{ signIns }`, and `useEventStream` exposes `shapingSignIns`. From Phase 3:
  `shaperSignInTarget`, `ShapingSignInView`, and the "Signs in" line each marked row
  already shows. From Phase 5: a dry run of a signed-in shaper returns the protected tool's
  guidance.
- **The row.** `TaskShapingView.tsx` renders each shaper as a `.shaping-row` with a copy
  column and an actions column. Buttons carry an `aria-label` that names the shaper, such
  as `Dry-run <label>`. A row's error is a paragraph with `role="alert"`. Dry run is offered
  only for a registered shaper.
- **Flags in the dashboard.** `useFeatureFlag` (`src/web/useFeatureFlag.ts`) follows a flag
  live.
- **Opening a link.** `openExternal` in `src/web/components/ContextMenu.tsx` uses
  `window.missionDesktop.openExternal` in the desktop app and `window.open` with `noopener`
  in a browser. The desktop bridge checks nothing about the URL (`src/main/index.ts`).
- **Browser specs.** `e2e/README.md` sets the rules: select by role, label or placeholder,
  never add `data-testid`, never spend model tokens. `setFlag` in
  `e2e/specs/task-shaping-settings.spec.ts` turns a flag on through the API. A spec that
  opens a new modal calls `expectContentClearsBorder`.
- `test/task-shaping-settings.test.ts` renders `TaskShapingView` with `renderToStaticMarkup`.

## Steps

1. **API client.** `signInShaper(id)` and `signOutShaper(connection)`, beside `getShaping`.
2. **Which sign-in a row shows.** A row's sign-in is the entry of `shapingSignIns` whose
   `shapers` holds the row's id. A marked shaper with no entry yet is shown as signed out.
3. **What a marked row says**, under its "Signs in" line, while `shaper-sign-in` is on:

   | State | Text | Controls |
   | --- | --- | --- |
   | `signed_out` | "Not signed in", and the reason when there is one | Sign in |
   | `pending` | "Waiting for the browser" | Open the sign-in page, Copy link, Cancel sign-in |
   | `signed_in`, kept in the Keychain | "Signed in. Kept in the macOS Keychain." | Sign out |
   | `signed_in`, kept in memory | "Signed in until Mission Control restarts. Kept in memory.", and the reason when there is one | Sign out |
   | `renewing` | "Renewing the sign-in", and the reason | Sign in, Sign out |

   Each control's `aria-label` names the shaper, such as `Sign in <label>`. The controls
   are offered for registered and for discovered shapers.
4. **With `shaper-sign-in` off**, a marked row shows one sentence instead: sign-in is
   switched off, and the flag's name. There are no controls. The row follows the flag live.
5. **Sign in.** The click calls `signInShaper`. On success the dashboard opens
   `authorizationUrl` through `openExternal`, only when it is an `https:` URL or an `http:`
   URL to loopback, and keeps it in the row for "Open the sign-in page" and "Copy link"
   until the state changes. A refusal is shown in the row with `role="alert"`. The daemon
   never opens a browser.
6. **Cancel and sign out** call `signOutShaper` with the connection's id.
7. **Sign-ins no shaper uses.** When `shapingSignIns` holds an entry whose `shapers` is
   empty, a short list under the shapers names its URL and scope with a Sign out button.
   With none, nothing is shown.
8. **No new modal.** Everything is in the row. If the work does add a modal, the spec calls
   `expectContentClearsBorder` for it.
9. **Docs.**
   - `docs/task-shaping.md`: "Signing in from Settings", with the states above, what a
     restart costs with each kind of storage, and the port-forward note: a dashboard
     reached through a forward works when the forward keeps the daemon's port number.
   - `docs/security.md`: the operator's view of where the token lives, added to what Phase 2
     wrote: what is kept, what is never written, who can read it, how to remove it.
   - `docs/configuration.md` and `docs/skills-and-settings.md`: the control and its flag.

## Data, API and compatibility

- No stored data and no route changes.
- A marked shaper imported before this phase gains the controls with no change to it.
- An older daemon that sends no `shapingSignIns` leaves the list empty, so every marked row
  reads "Not signed in" and its Sign in answers the daemon's 404 as a row error.
- The authorization URL is kept in the row's own state. It is not stored, and a reload
  drops it. The sign-in then still finishes in the browser tab already open, and the row
  shows the result from the event.

## Tests and verification

- `test/task-shaping-settings.test.ts`: each row of the table in step 3 renders its text and
  its controls with their labels; the flag-off sentence; an unmarked row shows none of it;
  the unused list appears only with an unused entry.
- A unit test of the URL check in step 5: `https:`, loopback `http:`, and refusals for
  `http:` to another host, `file:` and `javascript:`.
- `e2e/specs/shaper-sign-in.spec.ts`, against the Phase 1 fixture, with both flags on:
  1. Import a manifest that carries `auth`. Its row reads "Not signed in".
  2. Click Sign in. A new tab opens, the fixture redirects it, and it reads "Signed in".
  3. Back in Settings the row reads "Signed in" with no reload, and offers Sign out.
  4. Dry-run the shaper and read the protected tool's guidance.
  5. Sign out. The row reads "Not signed in", and a dry run now shows the reason that
     points to Settings > Task shaping.
  6. Switch `shaper-sign-in` off through the API. The controls go and the switched-off
     sentence shows, in the open window.

  Run only this spec, after `npm run build`. Look at the row at each step, attach a
  screenshot of each state to the pull request, and commit none of them.

Run those, `npm run typecheck` and `npm run lint`.

## Merge and exit criteria

- An operator can sign in, see it, use it in a dry run and sign out, all from Settings.
- The row's state changes without a reload when a sign-in finishes in another tab.
- With the flag off there is no control, and the row says why.
- The dashboard opens only an `https:` or loopback `http:` authorization URL.
- The documentation says where the token lives, what a restart costs and how to remove it.

## Handoff

Nothing in this plan follows. Left for later work, each named in `plan.md`: moving the flag
to `default-on`, a notice when a sign-in lapses, and the residents' bridge. The real
sign-in against the gateway is the operator's step with Tom, once the four outside items in
`plan.md` are done.

## Cross-phase audit

- Phase 2: the two storage sentences match the store's kinds and its documentation.
- Phase 3: the row keeps the "Signs in" line and adds to it. The flag is the same one.
- Phase 4: the row shows `state`, `storage` and `reason` as the view gives them, and adds no
  state of its own.
- Phase 5: the spec's dry run is the proof that a signed-in call reaches the tool.
- Phase 6: the spec's new tab lands on the callback page that phase serves, and reads its
  sentence.
