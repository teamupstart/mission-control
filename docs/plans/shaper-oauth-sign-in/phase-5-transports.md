# Shaper sign-in - Phase 5: Transports

## Outcome

A marked `mcp` or `http` shaper whose connection is signed in is called with the access
token, sent to its server's origin only. The token is removed from whatever the server
sends back (S7). A marked shaper that is not signed in is not called and answers
`unavailable`, and a `401` answers `unavailable` and starts one background refresh (S2). A
shaper with no marker sends exactly what it sends today (S10), and the carriers are
unchanged on every call (S9).

After this phase a sign-in made in a test reaches a server. An operator still cannot make
one, because the routes are Phase 6 and the control is Phase 7.

## Entry criteria and dependencies

- Phase 4 is merged. It can be built at the same time as Phase 6.

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

- `src/server/shaping/transports/remote.ts`: one helper both transports use.
- `src/server/shaping/transports/mcp.ts` and `http.ts`: use it, and notice a `401`.
- `docs/task-shaping.md`: what a call does.

Not here: the service, routes, the event, Settings. `carriers.ts`, `references.ts` and
`origin-fetch.ts` do not change.

## Repository findings and inherited contracts

- From Phase 4: `shaperSignIns.accessToken(target)`, synchronous, answers a token or a
  reason by flag and by state, and `shaperSignIns.noteRefused(target)`. From Phase 3:
  `shaperSignInTarget`, `SIGN_IN_REASONS`, and the guard this phase replaces. From Phase 1:
  the fixture's two protected resources, `/mcp` for the `mcp` transport and `/shape`, which
  answers a shaping result, for the `http` transport.
- `callHeaders` (`remote.ts:52-80`) resolves a shaper's configured headers and returns them
  with `resolved`, the values to scrub from whatever comes back.
- In `openHttp` (`mcp.ts:548-643`) the configured headers ride every request through
  `fetchOnOrigin`, to the server's origin only, and are set over the client's own. The
  carriers ride through `requestInit`. One connection is shared per run, keyed by the
  server, the folder and the headers (`connectionKey`, `mcp.ts:163-165`).
- `callHttp` (`http.ts`) sends one `POST` through `fetchOnOrigin`.
- `failure`, `quoted` and `dataReply` (`remote.ts`) scrub every resolved value from a
  reason and from a reply, and mark the reply `redacted`. `markerFor`
  (`references.ts:446-451`) writes `[NAME redacted]` from a value's name.
- Without an auth provider the SDK reports a `401` as an error whose text carries the
  status. The scout's probe saw it surface as "did not complete its handshake".
- A shaping call is never retried within one dispatch. That is a non-goal of the
  task-shaping plan and stays one.

## Steps

1. **The helper.** `signInFor(shaper)` in `remote.ts` returns one of three things: nothing,
   for a shaper with no target; a refusal with the service's reason; or the header
   `authorization: Bearer <token>` with a resolved value named `sign-in token` and the
   target. It asks the service once per call and holds the token no longer than the call.
2. **`mcp`.** Remove Phase 3's guard. For an `http` server, after `callHeaders`:
   - a refusal answers `unavailable` with its reason, and nothing is opened or sent;
   - otherwise the header joins the configured headers and the value joins `resolved`, so
     every request of the connection carries the token to the server's origin, and every
     reply and reason is scrubbed of it.
3. **`http`.** The same, in `callHttp`.
4. **A `401`.** Wrap the fetch each transport already builds so that it notes a response
   with status 401, read from the response itself and not from the SDK's error. When a
   marked shaper's call ends and a `401` was noted for it, during the handshake or the call,
   it calls `noteRefused(target)` once and answers `unavailable` with
   `SIGN_IN_REASONS.refused`. It does not retry. A shaper with no marker is not touched: its
   `401` stays `failed`, with today's reason.
5. **Docs.** In `docs/task-shaping.md`, under "A shaper that signs in", the table below and
   the sentence that a dry run takes the same path.

## Data, API and compatibility

What a call does, for every state. Dispatch continues in every row.

| The shaper's connection | Requests made | Outcome |
| --- | --- | --- |
| No marker | Today's, with today's headers | As it is today, a `401` included |
| Marker, either flag off | None | `unavailable`, `flagOff` |
| Marker, signed out or pending | None | `unavailable`, `signedOut` |
| Marker, renewing | None | `unavailable`, `renewing` |
| Marker, signed in | The call's, each with the token, to the server's origin only | By the reply |
| Marker, signed in, the server answers `401` | The ones made before the `401` | `unavailable`, `refused`. One `noteRefused`. |

- The token is in the connection key for the run, as a resolved header value already is.
  The key lives in the run's scope and is never logged or recorded.
- A token that changes during a run opens a second connection for later calls. Both close
  when the run ends.
- No stored data changes. A record written before this phase is read as it is.
- The carriers (`traceparent`, `tracestate`, `x-work-unit-id`, `params._meta`) are added by
  the same code as before, for marked and unmarked shapers alike.

## Tests and verification

`test/shaping-transport-mcp.test.ts` and `test/shaping-transport-http.test.ts`, against the
Phase 1 fixture. The `mcp` tests call its protected `/mcp`, and the `http` tests its
protected `/shape`. Each uses a service signed in for that URL through the memory store.

- Signed in: the fixture saw `authorization: Bearer <fake token>` on every request of a
  call, and the reply is the guidance the resource returned. For `mcp` that is the handshake,
  the `tools/call` and the session's end. For `http` it is the one `POST`.
- The same call still carries `traceparent`, `tracestate` and `x-work-unit-id`, and
  `params._meta` for `mcp`, with the values an unmarked call carries.
- A redirect off the origin is refused as today, and the other origin received nothing.
- Echo: a reply that repeats the token comes back with `[sign-in token redacted]` and is
  marked `redacted`. So does a tool error and an HTTP error body.
- Each "None" row of the table: the fixture received no request.
- A `401`: `unavailable` with `refused`, `noteRefused` called exactly once, and no second
  attempt at the fixture.
- An unmarked shaper against a server that answers `401`: `failed`, with the same reason
  text as before this phase.
- The pinned request headers of an unmarked shaper, from Phase 3, still pass.

`test/shaping-http.test.ts`: a dry run of a marked, signed-in shaper returns guidance. The
reply, and the summary and section the engine returns for the same call, which are what a
task record stores, are searched for the fake token and do not hold it.

Run those three files, `npm run typecheck` and `npm run lint`.

## Merge and exit criteria

- A signed-in marked shaper is called with the token on every request, and only its
  server's origin receives it.
- The token appears in no reply, reason, dry-run result or record.
- A marked shaper that is not signed in makes no request.
- A `401` ends in `unavailable`, one `noteRefused` and no retry.
- An unmarked shaper's requests and outcomes are what they were.

## Handoff

Phase 7's browser spec may rely on a dry run of a signed-in shaper returning the protected
tool's guidance, and on the `unavailable` reasons being the sentences in `SIGN_IN_REASONS`.
No later phase edits the transports.

## Cross-phase audit

- Phase 3: the guard is gone and its two reasons now come from the service, which answers
  the same sentences for the same states. The header pin is kept.
- Phase 4: the transports call only `accessToken` and `noteRefused`. Neither waits.
- Phase 6: shares no file with this phase. Either may merge first.
- Phase 7: its spec is the first place a person sees a signed-in call.
