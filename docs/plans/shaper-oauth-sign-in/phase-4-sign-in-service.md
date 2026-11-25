# Shaper sign-in - Phase 4: Sign-in service

## Outcome

The daemon has one service that starts a sign-in, finishes it, keeps the tokens, refreshes
them in the background one at a time, signs out and reports status (S2, S3, S4, S6). It is
proved in tests against the mock. It is wired into the daemon's start and stop, but no route
and no transport reaches it yet, so no sign-in can exist outside a test until phases 5 and 6.

## Entry criteria and dependencies

- Phases 1, 2 and 3 are merged.

## Hard rules

- No reading, copying, exporting or passing of real credentials: no Keychain reads of other
  applications' items, no `auth.json`, no OAuth tokens or API keys other than this
  feature's own fake-valued test fixtures, and nothing under `~/.claude*` or `~/.codex*`.
- Tests use a loopback mock authorization server and fake values only.
- No real login against Okta or the gateway, and no request to either.
- The feature's own Keychain item names are unique. A test that writes an item removes it
  and verifies it is gone. This phase's tests use the memory store and write none.
- No full unit suite and no full end-to-end suite locally. Run this phase's own test files,
  with `npm run typecheck` and `npm run lint`. CI runs the full suites.

## Scope

- `src/server/shaping/sign-in/connection.ts`: `connectionId`.
- `src/server/shaping/sign-in/service.ts`: the service, with every dependency injected.
- `src/server/shaping/sign-in/index.ts`: the daemon's one instance, `shaperSignIns`.
- `src/shared/app-config-entries.ts` and `src/shared/shaping.ts`: the `shaping.signIn` key.
- `src/server/index.ts`: start and stop.
- `e2e/fixtures/daemon.ts`: the memory switch.
- `docs/agent-guides/change-contracts.md`: the new key, its limit and the rule in step 2.

Not here: routes, the event, the transports, Settings.

## Repository findings and inherited contracts

- From Phase 1: `discover`, `begin`, `exchange`, `refresh` and `revoke`, which keep no state
  and return failures as values, and `refresh`'s three answers.
- From Phase 2: `createSignInStore`, `SignInStore`, `SignInStoreError` and the record.
- From Phase 3: the flag, `SignInTarget`, `ShapingSignInView`, `SIGN_IN_REASONS`,
  `shaperSignInTarget`.
- `featureEnabled` and `onFeatureFlagsChanged` (`src/server/feature-flags/index.ts`), and
  `getShapingConfig` and `onShapingConfigChanged` (`src/server/shaping/index.ts`).
- `startDatabaseBackupLoop` (`src/server/database-backups/loop.ts`) takes `setTimer`,
  `clearTimer` and a clock, uses timers that do not hold the process open, and returns a
  stop that waits for work in flight. `test/database-backups.test.ts` drives it with fakes.
- `wholeEntry(key, schema, "operational", null)` keeps a key out of every settings backup.
  `test/settings-backup-coverage.test.ts` checks every entry's classification.
- `PORT` in `src/shared/harness-runtime.mjs` is the daemon's port.

## Steps

1. **`connectionId(target)`.** The first 32 hex characters of the SHA-256 of the target's
   canonical JSON. One sign-in per id.
2. **Client registrations.** `APP_CONFIG_ENTRIES.shapingSignIn`, key `shaping.signIn`,
   `{ clients: [{ issuer, clientId, redirectUri, scope, registeredAt }] }`, at most 16.
   A registration is reused only when its issuer, its redirect URI and its
   scope all match the sign-in being started, because the SDK sends the scope at
   registration and a server may hold a client to it. Otherwise the sign-in registers a new
   client. So two connections with different scopes on one authorization server
   each have a client, and two with the same scope share one. The key never holds two
   registrations with the same three values, because a sign-in registers only when none
   matches and one `begin` runs at a time (step 6).

   **At the limit.** A registration counts as named while a record the service holds, or
   a pending sign-in, carries its issuer and `clientId`. A named registration is never
   dropped to make room. When a sign-in needs a new registration and 16 are held, the
   first row that applies decides:

   | The 16 held registrations | What `begin` does |
   | --- | --- |
   | The last load of the store was incomplete (step 4) | Refuses with the code `store_unread`. The service cannot tell which clients the unread records name, so it drops nothing. |
   | At least one is not named | Runs the flow's `begin`, which registers. Then, in one write, it drops the oldest registration that is not named, by `registeredAt`, and saves the new one. A registration request that fails changes nothing. |
   | Every one is named | Refuses with the code `registration_limit`. No registration request is made, and nothing is dropped, saved or made pending. |

   A refusal is a returned failure with its code and one fixed sentence as its reason.
   `registration_limit` says that Mission Control keeps at most 16 client registrations,
   that a sign-in uses each one, and to sign out of one in Settings > Task shaping and sign
   in again. `store_unread` says that Mission Control could not read its stored sign-ins,
   and to restart it and sign in again.

   A registration stops being named when the last record and the last pending sign-in
   that name it are gone: after a sign-out, a cancelled or expired pending sign-in, or a
   sign-in that ended. It stays in the key, for reuse, until room is needed. So the
   sign-in that was refused has room once a sign-out leaves a registration that nothing
   names. A registration leaves the key in
   two ways only: dropped as above while not named, or removed when the authorization
   server rejects its client (step 9).
3. **State.** Per connection, in memory: the target, the record or none, where it is kept,
   a pending sign-in or none, the refresh in flight or none, the next refresh time, and a
   reason. Nothing else holds a token.
4. **`start()` and the flags.** While `task-shaping` and `shaper-sign-in` are both on, the
   service reads every stored record into memory and schedules its refresh. Each connection's
   target comes from its record, so a stored sign-in is listed with its URL and scope even
   when no shaper names it. A record stored under an id that its target does not hash to is
   ignored. If the store cannot be read, in whole or in part, the service holds the
   records it could read, and the load counts as incomplete until a later load reads all
   of it (step 2). While either is
   off it reads nothing, fetches nothing and runs no timer. Turning both on loads then.
   Turning one off clears the timers and keeps what is in memory and in the store.
5. **`accessToken(target)`.** Synchronous, memory only, never the network or the store.

   | State | Answer |
   | --- | --- |
   | Either flag off | No token, `flagOff` |
   | No record, or a sign-in pending | No token, `signedOut` |
   | A record whose access token has not expired | The token |
   | A record whose access token has expired, with a refresh token | No token, `renewing`. A refresh starts if none is running. |
   | A record whose access token has expired, with no refresh token | The record is removed. No token, `signedOut`. |

   A target that is asked for counts as in use.
6. **`begin(target)`.** Needs both flags. One `begin` runs at a time, after the load of
   step 4 has finished, and a later one waits its turn. So two sign-ins started together
   cannot register twice for the same three values, or both take the last place. It runs
   `discover`, then looks for a registration to reuse. With one, it runs the flow's
   `begin` with it, and no registration request is made. With none, it applies step 2:
   it refuses, or it runs the flow's `begin`, which registers, and saves the new
   registration. It keeps the pending `state` and
   verifier for 10 minutes. A new pending sign-in replaces an older one for the same
   connection, and at most eight are kept. The whole step is bounded at 20 seconds, the
   wait included. It
   returns the authorization URL and when it expires. The URL carries the client id, the
   `state` and the PKCE challenge. The verifier stays in the service. The redirect URI is
   `http://127.0.0.1:<PORT>/api/shaping/sign-in/callback`.
7. **`complete({ state, code, error, iss })`.** The values are the ones the browser's
   redirect carried to the callback. It finds the pending sign-in by comparing
   `state` in constant time, and removes it before anything else, so a `state` works once.
   An unknown or expired `state`, an `error` from the server, a missing `code`, or an `iss`
   that is not the pinned issuer ends in a fixed reason. Otherwise it runs `exchange`,
   stores the record, schedules the refresh and reports the change.
8. **Storing.** Every record is written to the store, with its target and the id of the
   client that obtained it, before it replaces the one in memory.
   When the write fails, the record is used from memory, the connection's storage reads
   `memory`, and its reason says a restart will need a new sign-in.
9. **Refresh.**
   - Due at 75% of the access token's lifetime. With no `expires_in`, only after
     `noteRefused`. At `start()`, at once for a record that has already expired.
   - One at a time per connection. Whatever asks while one runs shares it.
   - A refresh uses the client the record names, read from the record itself. While the
     record is held, the service does not drop that client's registration (step 2).
   - `sign_in_again`: the record is removed from the store and from memory, and the
     connection is `signed_out` with a reason that says to sign in again.
   - `client_rejected`: the authorization server no longer accepts the client. Every
     record that names it is removed the same way, a pending sign-in that names it is
     dropped, and then its registration is removed.
   - `retry`: tried again after 1, 2, 4 and 8 minutes, then every 15. The connection is
     `renewing` once the access token has expired.
   - Only connections in use are refreshed.
10. **`noteRefused(target)`.** A server refused the current token. The connection is
    `renewing` and one refresh starts. With no refresh token it is `signed_out`.
11. **`signOut(id)`.** Drops a pending sign-in and the timers, calls `revoke` with a 5
    second limit, removes the record from the store and from memory, and reports the
    change. The registration is kept, and is no longer named unless another record or a
    pending sign-in names it.
12. **`setInUse(list)`, `view()` and `onChanged`.** `setInUse` takes each target with the
    ids of the shapers that name it. `view()` lists every connection, sorted, as
    `ShapingSignInView`, with an unused one's `shapers` empty. It never holds a
    token, a code, a `state`, a verifier or an authorization URL. `onChanged` fires only when
    the view changed.
13. **Wiring.** `index.ts` builds `shaperSignIns` with the real store, clock, timers and
    flow. It calls `setInUse` at start, from the stored config and one scan of the shapers
    folder (`discoverShapers`), and again on every config change with the folder's last scan.
    `src/server/index.ts` starts it after the shaping events are wired and stops it in the
    shutdown sequence.
14. **The browser suite.** Add `MISSION_SHAPER_SIGN_IN_STORE: "memory"` to the daemon's
    environment in `e2e/fixtures/daemon.ts`, so no end-to-end run reaches a Keychain.

## Data, API and compatibility

- One new `app_config` key, `shaping.signIn`. It holds no secret. It is in no backup
  domain, so a settings snapshot and a restore never carry it. An older build does not read
  it.
- **A crash between a refresh reply and the store write** leaves the spent refresh token in
  the store. The next start gets `sign_in_again`, unless the server's reuse grace covers it.
- **A changed daemon port** changes the redirect URI. The next sign-in registers again.
  Records already held keep refreshing, and the registrations they name stay in the key
  however many sign-ins register under the new port.
- **Sixteen registrations, every one named**, refuse the next sign-in that needs another,
  with a reason and no registration request. Nothing held is lost, and a sign-out that
  leaves a registration with nothing naming it makes room.
- **The flag switched off** deletes nothing. Stored records may lapse meanwhile.
- With both flags off, which is the default, the daemon reads no store and makes no request.

## Tests and verification

`test/shaping-sign-in-service.test.ts`, with the Phase 1 fixture, a fake clock and timers,
the memory store, and a store that can be made to fail.

- A whole sign-in: `begin`, the fixture's redirect, `complete`, then `accessToken` answers
  the fake token and `view()` says `signed_in`.
- Two shapers on one connection share one sign-in, and `view()` lists both ids.
- **Two scopes on one authorization server.** Two connections with different scopes sign
  in. The fixture saw two registrations, each carrying its own connection's scope, and
  `shaping.signIn` holds both. A third connection, with the first one's scope on the
  fixture's other resource, signs in with no further registration. Each refresh carries
  the id of the client that obtained those tokens.
- **At the registration limit.** The key is seeded with 15 registrations for the fixture's
  issuer, each with its own scope, and the store with one fake record naming each. No shaper names those
  connections, so none is refreshed. A real sign-in for connection A begins and stays
  pending, which makes 16, every one named.
  - `begin` for connection B, with another scope, answers `registration_limit`. The
    fixture saw no second registration request, the key and the store are unchanged, and
    nothing is pending for B.
  - A's pending sign-in is cancelled. `begin` for B then registers, A's registration is
    the one dropped, and the 15 seeded ones are still in the key.
  - With 16 named again, `signOut` of one seeded connection lets a sign-in with a third
    scope begin, and the registration dropped is the one that sign-out freed. With two
    registrations not named, the one with the older `registeredAt` is dropped.
  - A registration request that the fixture refuses leaves the key as it was.
  - A store whose `ids()` rejects at `start()`, with 16 registrations held: `begin` for a
    new scope answers `store_unread`, the fixture saw no registration request, and the
    key is unchanged. A second service over the same key, whose store reads, begins that
    sign-in and drops only a registration that no record names.
- **A changed port.** A second service over the same store and key, built with another
  port, lists the held sign-in and refreshes it with the client its record names. A
  sign-in for another connection with the same scope registers again under the new port,
  and the registration that record names is still in the key.
- **Two sign-ins started together.** Two `begin` calls made at once, for two connections
  that share issuer and scope, send one registration request.
- `state`: a second use, an unknown value, an expired one, an `iss` that does not match, an
  `error` parameter. Each fails and leaves no record.
- Every row of the `accessToken` table.
- Refresh at 75% with the fake clock. Five triggers at once produce exactly one request at
  the fixture's token endpoint. The rotated pair is in the store before `accessToken`
  returns it. A failing write leaves `storage` as `memory`, with the reason.
- The retry schedule and `sign_in_again`.
- `client_rejected`: two connections share the client, and a third sign-in that reuses it
  is pending. Both records are removed, both connections are `signed_out`, the pending
  sign-in is gone, and the key no longer holds that registration.
- A connection that is not in use is not refreshed.
- A second service over the same store is `signed_in` with no request, and refreshes a
  record that expired while it was down. A spent refresh token ends `signed_out`.
- **Restart after the shaper was removed.** A second service over the same store, told that
  no shaper is in use, lists the connection with its URL and scope and with `shapers`
  empty, sends no request for it, and `signOut` removes its record from the store. A record
  stored under an id that its target does not hash to is not listed.
- Both flags off: no store read, no request, no timer, and `accessToken` answers `flagOff`.
- `signOut` removes the record, calls the fixture's `/revoke`, and keeps the registration.
- **No token leaves.** `view()`, every `onChanged` payload, the stored `app_config` value
  and a settings snapshot captured after the sign-in (`captureSettingsConfig`) are searched
  for the fake token values, the code, the `state` and the verifier, and none is found. The snapshot does not carry
  `shaping.signIn` either.

Also `test/settings-backup-coverage.test.ts` for the new key. Run those files,
`npm run typecheck` and `npm run lint`.

## Merge and exit criteria

- A sign-in completes against the fixture, and its record is written before it is used.
- Concurrent refresh triggers produce exactly one refresh request.
- Two connections with different scopes on one authorization server both sign in, each
  with its own registration, and a third with a scope already registered reuses it.
- With 16 registrations held, a sign-in that needs another drops only a registration that
  no held record and no pending sign-in names. When every one is named it is refused
  with a fixed reason and no registration request, nothing held changes, and it begins
  once a sign-out leaves a registration that nothing names. When the store could not be
  read it is refused the same way, with the reason that says to restart, and it begins
  after a restart that reads the store.
- After a port change, the registration that a held record names is still in the key.
  Two sign-ins started together for the same issuer and scope register once.
- After a restart, a stored sign-in that no shaper names is listed by its URL and scope, is
  not refreshed, and can be signed out.
- The record, the client registration and the view never hold a token outside the store and
  the service's own memory.
- With both flags off the service does nothing.
- The browser suite's daemon is forced to the memory store.

## Handoff

Phases 5 and 6 may rely on `shaperSignIns` and the methods in `phased-plan.md`. Phase 5
calls only `accessToken` and `noteRefused`. Phase 6 calls `begin`, `complete`, `signOut`,
`view`, `onChanged` and `setInUse`. Neither may read the store or the registration key.
Phase 6 answers `begin`'s two refusal codes, `registration_limit` and `store_unread`, with
their own status.

## Cross-phase audit

- Phase 1: the service is the only caller of the flow, and owns everything it remembers.
- Phase 2: the only caller of the store. Its `storage` values are the store's kinds. It
  writes the target into every record and reads it back at start.
- Phase 3: answers with `SIGN_IN_REASONS` and fills `ShapingSignInView`.
- Phase 5: `accessToken` is synchronous, so a call never waits. A `401` reaches
  `noteRefused`.
- Phase 6: serves the redirect URI built here, and also calls `setInUse` when Settings
  reads the shapers folder, which this phase cannot see. It answers the two refusals of
  step 2 with 409 and their reasons.
- Phase 7: shows `state`, `storage`, `reason` and `expiresAt` as the view gives them. It
  shows a refused `begin`'s reason in the row, and its Sign out, on a row or in the list
  of sign-ins no shaper uses, is how the operator makes room.
