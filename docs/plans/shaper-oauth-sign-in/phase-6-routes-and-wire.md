# Shaper sign-in - Phase 6: Routes and wire

## Outcome

A sign-in can be started, finished and ended over the daemon's HTTP surface. There are three
routes, among them the loopback callback and the page it answers with (S4). The sign-in list
travels in `GET /api/shaping`, in a new event and in the snapshot, and the dashboard's event
stream holds it. Settings does not render it yet: that is Phase 7.

## Entry criteria and dependencies

- Phase 4 is merged. It can be built at the same time as Phase 5.

## Hard rules

- No reading, copying, exporting or passing of real credentials: no Keychain reads of other
  applications' items, no `auth.json`, no OAuth tokens or API keys other than this
  feature's own fake-valued test fixtures, and nothing under `~/.claude*` or `~/.codex*`.
- Tests use a loopback mock authorization server and fake values only.
- No real login against Okta or the gateway, and no request to either.
- The feature's own Keychain item names are unique. A test that writes an item removes it
  and verifies it is gone. The tests and the browser spec here use the memory store.
- No full unit suite and no full end-to-end suite locally. Run this phase's own test files
  and its one focused spec, with `npm run typecheck` and `npm run lint`. CI runs the full
  suites.

## Scope

- `src/server/shaping/sign-in/routes.ts`, registered from `registerShapingRoutes`, and
  `src/server/shaping/sign-in/callback-page.ts`.
- `src/server/shaping/routes.ts`: `signIns` in the `GET /api/shaping` reply.
- `src/server/shaping/sign-in/events.ts`, `src/server/registry.ts`, `src/server/index.ts`:
  the event and the snapshot field.
- `src/shared/types.ts`: the event and the snapshot field's types.
- `src/web/useEventStream.ts`: holds the list.
- `test/fixtures/route-surface.json`, and the route listing in
  `test/request-collection-bounds.test.ts`.
- Docs: `docs/task-shaping.md` ("The shaping API") and `docs/event-stream.md`.

Not here: any Settings control, the transports.

## Repository findings and inherited contracts

- From Phase 4: `begin`, `complete`, `signOut`, `view`, `onChanged`, `setInUse`, and the
  redirect URI `http://127.0.0.1:<PORT>/api/shaping/sign-in/callback`. From Phase 3: the
  flag, `shaperSignInTarget`, `ShapingSignInView`.
  `begin` returns two refusals of its own, with the codes `registration_limit` and
  `store_unread`, apart from a failure to reach a server.
- **Guards.** `/api/*` has a loopback `Host` check (`requireLoopback`,
  `src/server/routes.ts`). There is no API token. In `registerShapingRoutes` the flag gate
  comes first, then `trustedLoopbackJsonRequest` on writes, then `limitBody`. Bodies are
  read with `parseBody` and a Zod schema.
- **`GET /api/shaping`** scans the shapers folder and returns `config`, `discovered`,
  `folder` and `references`.
- **The event.** `wireShapingConfigEvents` (`src/server/shaping/events.ts`) follows the
  flag: it emits the view while on and a cleared one when switched off.
  `registry.emitShapingConfig` drops a frame identical to the last. The snapshot adds its
  field only while the flag is on.
- **The dashboard** handles every `ServerEvent` in one exhaustive switch
  (`src/web/useEventStream.ts`), so a new event type does not compile until it is handled.
- **Route tests.** `test/fixtures/route-surface.json` pins each gated route's 404.
- No response sets security headers globally. A route that needs them sets its own.

## Steps

1. **`POST /api/shaping/sign-in`**, body `{ shaper }`. Gates: `task-shaping`, then
   `shaper-sign-in`, then the loopback write check, then a 4 KiB body limit. It finds the
   shaper among the known registered ones and the folder's valid ones, reads its target,
   calls `begin` and answers `{ authorizationUrl, expiresAt, connection }`. The URL carries
   the client id, the `state` and the PKCE challenge, because the browser must present
   them, and it appears in this reply only. An unknown id is 404 and a shaper with no marker is 400. A `begin` that Phase 4 refused with the code `registration_limit` or `store_unread` is 409 with its reason, because the refusal is Mission Control's own. Any other failed `begin` is 502 with its reason.
2. **`POST /api/shaping/sign-out`**, body `{ connection }`. The same gates. It calls
   `signOut` and answers `{ signIns }`. An unknown id is 404.
3. **`GET /api/shaping/sign-in/callback`**. The two flag gates, and the loopback `Host`
   check it has from being under `/api`. It reads `state`, `code`, `error` and `iss` from
   the query, each at most 2 KiB, and nothing else, then calls `complete`. They arrive in the
   browser's redirect. The route persists none of them: it hands them to `complete`, which
   holds them in memory only, for the exchange.
   - It answers a static HTML page: 200 with "Signed in. You can close this tab and go back
     to Mission Control.", or 400 with "The sign-in did not finish." and one fixed sentence
     chosen by the kind of failure, ending "Start again from Settings > Task shaping."
   - The page has no script and loads nothing. It never contains the code, the `state`, a
     token, or text the authorization server sent.
   - Headers: `content-type: text/html; charset=utf-8`, `cache-control: no-store`,
     `referrer-policy: no-referrer`, `x-content-type-options: nosniff`, and
     `content-security-policy: default-src 'none'; style-src 'unsafe-inline'`.
4. **`GET /api/shaping`** gains `signIns`: the service's view while `shaper-sign-in` is on,
   and an empty list while it is off. It also calls `setInUse` with the targets of the
   known registered shapers and of the folder's valid ones it has just scanned.
5. **The event and the snapshot.** `shaping_sign_ins` carries `signIns`. The list never
   holds an authorization URL, so a pending sign-in in it has no link. A wiring like
   `wireShapingConfigEvents` follows both flags: while both are on it emits the view and
   every change from `onChanged`, and when either goes off it emits an empty list. The
   snapshot carries `shapingSignIns` only while both are on. The registry drops a frame
   identical to the last.
6. **The dashboard.** `useEventStream` keeps the list from the snapshot and from the event
   and exposes it as `shapingSignIns`, empty by default.
7. **Docs.** The three routes, the new reply field, the event and the snapshot field.

## Data, API and compatibility

| Surface | `task-shaping` off | `shaper-sign-in` off | Both on |
| --- | --- | --- | --- |
| The three new routes | 404 | 404 | Served |
| `signIns` in `GET /api/shaping` | The route is 404, as today | Empty list | The view |
| `shaping_sign_ins` event | Not sent, except one empty list when a flag goes off | The same | Sent on every change |
| Snapshot `shapingSignIns` | Absent | Absent | Present |

- An older dashboard ignores an event type it does not know.
- No reply, event or snapshot carries a token, a code or a verifier. The `state` and the
  client id appear in one place: inside the authorization URL of the sign-in reply. The
  sign-in list, the event and the snapshot never hold that URL.
- A `state` works once. The callback of a daemon that restarted since the sign-in began
  answers the "did not finish" page, because pending sign-ins live in memory.
- A sign-in whose shaper is removed before the callback still completes. Its connection is
  then listed as unused.
- If this phase merges before Phase 5, a sign-in made through the API is held and listed,
  but no call uses it yet: Phase 3's guard still answers `unavailable` for a marked shaper.

## Tests and verification

`test/shaping-sign-in-http.test.ts`, with the routes in process and the Phase 1 fixture.

- The whole flow over HTTP: start, follow the fixture's redirect to the callback, read the
  success page, then `GET /api/shaping` lists the connection as `signed_in`.
- Gates: each new route is 404 with either flag off (`route-surface.json` too). A `Host`
  that is not loopback is 403. A `POST` with a foreign `Origin` is 403. A body over the
  limit is 413.
- Start: an unknown shaper, a shaper with no marker, a discovered shaper, and a `begin`
  that fails, which is 502. With the key seeded with 16 registrations and the store with
  one fake record naming each, a sign-in for a shaper with another scope is 409 with the
  `registration_limit` sentence, and the fixture saw no registration request.
- Callback: an unknown `state`, a replayed one, an `error` parameter and a missing `code`.
  Each is the failure page with status 400. Every page is searched for the code, the
  `state` and the fake tokens. The five headers are present.
- Sign-out: the list no longer shows the connection as signed in.
- Wire: the event is emitted when a sign-in completes and when it ends, an empty list is
  emitted when either flag goes off, and the snapshot carries the field only with both on.
- **No token leaves.** Every reply, event and snapshot in this file is searched for the
  fake token values, the code and the verifier, and none is found. The `state` is found
  only inside `authorizationUrl` in the sign-in reply.

One focused browser spec, `e2e/specs/shaper-sign-in-callback.spec.ts`, because the callback
page is a page a person sees: with both flags on and a marked shaper registered through the
API, start a sign-in with a request, open the authorization URL in the page, and read
"Signed in" on the page the fixture redirects to. Then open the callback with a `state`
that was never issued and read "The sign-in did not finish". Run only this spec, after
`npm run build`.

Run those two, `test/request-collection-bounds.test.ts`, `npm run typecheck` and
`npm run lint`.

## Merge and exit criteria

- A sign-in completes over HTTP against the fixture, and the callback page says so.
- Every new route is 404 with either flag off, and refuses a non-loopback `Host`.
- The callback accepts a `state` once, and its page never shows a value.
- The event carries the list on every change, and an empty list when a flag goes off.
  `useEventStream` handles the event and the snapshot field, which the type check enforces.
  Phase 7's spec is the first to show the list on screen.
- No token, code or verifier is in any reply, event or snapshot, and the `state` is only
  inside the sign-in reply's authorization URL.

## Handoff

Phase 7 may rely on the two `POST` routes and their replies, on `shapingSignIns` from
`useEventStream`, and on the callback page's two sentences. The authorization URL
reaches Phase 7 only in the sign-in reply, never in `shapingSignIns`. It must not add
another way to start or finish a sign-in.

## Cross-phase audit

- Phase 3: the flag gates every route, after `task-shaping`.
- Phase 4: the callback path is the redirect URI the service registers. `setInUse` is
  called here for folder shapers, which Phase 4's wiring sees only at start.
- Phase 5: shares no file. Either may merge first.
- Phase 7: renders `shapingSignIns`, and opens the `authorizationUrl` this phase returns.
