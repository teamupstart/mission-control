# Shaper sign-in - Phase 3: Flag and marker

## Outcome

The `shaper-sign-in` preview flag exists. A remote shaper's definition may carry the `auth`
marker (D5, D6, D7), and Settings says so wherever it states what a shaper calls and is
sent. A marked shaper is a known shaper that answers `unavailable` and is never called,
because nothing can sign it in yet. A shaper with no marker sends exactly the requests it
sends today, with the flag on or off.

One change here is not gated by the flag: the strict schema accepts `auth` whatever the flag
says, and a marked shaper answers `unavailable` either way.

## Entry criteria and dependencies

- The planning pull request is merged. No other phase is needed.
- It can be built at the same time as phases 1 and 2.

## Hard rules

- No reading, copying, exporting or passing of real credentials: no Keychain reads of other
  applications' items, no `auth.json`, no OAuth tokens or API keys other than this
  feature's own fake-valued test fixtures, and nothing under `~/.claude*` or `~/.codex*`.
- Tests use a loopback mock authorization server and fake values only.
- No real login against Okta or the gateway, and no request to either.
- The feature's own Keychain item names are unique. A test that writes an item removes it
  and verifies it is gone. This phase writes none.
- No full unit suite and no full end-to-end suite locally. Run this phase's own test files
  and its one focused browser test, with `npm run typecheck` and `npm run lint`. CI runs
  the full suites.

## Scope

- `src/shared/feature-flag-registry.ts`: the flag.
- `src/shared/shaping-registry.ts`: three tuples.
- `src/shared/shaping.ts`: the marker's schema, `shaperSignInTarget`, `SignInTarget`,
  `ShapingSignInView`, `SIGN_IN_REASONS`.
- `src/server/shaping/transports/mcp.ts` and `http.ts`: a guard, which Phase 5 replaces.
- `src/web/lib/shaping-settings.ts`: what a marked shaper calls and is sent.
- Docs: `docs/feature-flags.md`, `docs/task-shaping.md`, `docs/agent-guides/change-contracts.md`.

Not here: any sign-in, token, route, event or Settings control.

## Repository findings and inherited contracts

- **Strict schemas.** The `mcp` server's `http` shape is a `z.strictObject`
  (`src/shared/shaping.ts:259-267`), and so is the `http` transport (lines 283-287). The
  credential rules are a `superRefine` (`credentialsAreReferences`, lines 763-797).
  `ShaperManifestSchema` and `ShapingIntentSchema` build on the same definition, so the API,
  a Settings import and a folder manifest accept the marker together.
- **An older build** runs `classifyShaper` (line 959) against its own strict schema, so a
  stored shaper with `auth` is unsupported there: kept on every write and never called.
- **Tuples** in `src/shared/shaping-registry.ts` are append-only and each has a retired
  tuple beside it. `docs/agent-guides/change-contracts.md` lists them.
- **Flags.** `docs/feature-flags.md`: add a `preview` definition, gate every entry point,
  test off and on, and add the flag to "Shipped flags". `test/feature-flags.test.ts` checks
  the ids.
- **Settings copy.** `shaperReach` and `shaperReceives` in `src/web/lib/shaping-settings.ts`
  feed the import review (`ShaperReview`) and each row. `test/task-shaping-settings.test.ts`
  renders both.
- **A stale line.** `change-contracts.md` says the `shaping` backup domain is on the
  `runtime` surface. `src/shared/settings-backup-domains.ts` says `settings`.

## Steps

1. **Flag.** Add the definition from `plan.md`, stage `preview`. Add its row to "Shipped
   flags".
2. **Tuples.** `SHAPING_AUTH_KINDS` holding `oauth`, `SHAPING_SIGN_IN_STATES` holding
   `signed_out`, `pending`, `signed_in` and `renewing`, and `SHAPING_SIGN_IN_STORAGE`
   holding `keychain` and `memory`. Give `SHAPING_AUTH_KINDS` a retired tuple, as its
   neighbours have, because that id is stored.
3. **Schema.** `auth` is optional on the `mcp` server's `http` shape and on the `http`
   transport, and nowhere else.
   - `type`: an id from `SHAPING_AUTH_KINDS`.
   - `scope`: required, 1 to 256 characters, one or more scope tokens separated by single
     spaces. A token is visible ASCII with no `"` and no `\`.
   - `issuer`: optional. An HTTPS URL, or HTTP to loopback, with no username, password,
     query or fragment.
   - With `auth`, a header named `authorization`, in any letter case, is refused with a
     reason that says the sign-in sets that header.
   - `withoutLiteralCredentials` is not changed: the marker holds no credential.
4. **Target, view and reasons.** `shaperSignInTarget(shaper)` returns
   `{ url, scope, issuer }`, with `issuer` null when absent, or null for a shaper with no
   marker. `ShapingSignInView` and `SIGN_IN_REASONS` are declared as `phased-plan.md` states.
   The four reasons are fixed sentences that name Settings > Task shaping, and `flagOff`
   names the flag.
5. **Guard.** In `callMcp`, for an `http` server, and in `callHttp`: when the shaper has a
   target, answer `unavailable` before any header is resolved or any request is made. The
   reason is `SIGN_IN_REASONS.flagOff` while `shaper-sign-in` is off and
   `SIGN_IN_REASONS.signedOut` while it is on. A comment says Phase 5 replaces the guard.
6. **Settings copy.** For a marked shaper, `shaperReach` adds a line labelled "Signs in"
   that reads `OAuth, scope <scope>, at <origin>`, where the origin is the issuer's, or the
   server's own when there is no issuer. `shaperReceives` adds "An access token from your
   sign-in, sent only to the server's origin" to what is sent, and its last sentence names
   that token beside the header references.
7. **Docs.** In `docs/task-shaping.md`, under "Remote shapers", a section "A shaper that
   signs in" with the marker's fields and rules, saying that sign-in itself arrives with the
   later phases. In `change-contracts.md`, the three tuples, and the correction of the
   stale `runtime` line.

## Data, API and compatibility

| Case | Behaviour after this phase |
| --- | --- |
| A shaper stored before this phase | No marker. Its requests are unchanged. |
| A marked shaper, flag off | Known, listed, `unavailable` with `flagOff`. No request. |
| A marked shaper, flag on | Known, listed, `unavailable` with `signedOut`. No request. |
| A marked shaper read by an older build | Unsupported there. Kept on every write, never called. |
| `auth` on a `stdio` server or a `command` shaper | Refused by the schema |

- The marker can be stored through the API with the flag off. That is the ungated change
  named in the outcome.
- `ShapingConfigSchema` gains no key, so nothing an older build would drop is added.

## Tests and verification

- `test/shaping.test.ts`: the marker is accepted on both remote shapes and refused on the
  local ones; each `scope` and `issuer` rule; `authorization` beside `auth` in three letter
  cases; a manifest and an `upsert` intent that carry it; a stored marked shaper classifies
  as known; `shaperSignInTarget` for a marked shaper, an unmarked one, and one with an
  issuer.
- `test/shaping-transport-mcp.test.ts` and `test/shaping-transport-http.test.ts`: a marked
  shaper answers `unavailable`, with `flagOff` and with `signedOut`, and the fixture server
  received no request at all. **The direct path:** the full list of request headers an
  unmarked shaper sends is pinned, with the flag off and on.
- `test/task-shaping-settings.test.ts`: the review and the row of a marked shaper show the
  "Signs in" line and the access-token sentence, and an unmarked one shows neither.
- `test/feature-flags.test.ts`: the new id.
- One browser test added to `e2e/specs/task-shaping-settings.spec.ts`: paste a manifest that
  carries `auth`, and the review shows "Signs in" with the scope and the origin. Save it,
  and its row shows the same line. Run only that test, after `npm run build`.

Run those files and that one browser test, `npm run typecheck` and `npm run lint`.

## Merge and exit criteria

- The flag appears in Settings > Feature flags and in the documentation.
- A manifest with `auth` imports, and its review states the sign-in.
- A marked shaper is never called, with either flag state, and its reason says why.
- The pinned request headers of an unmarked `mcp` and `http` shaper are unchanged.

## Handoff

Phases 4 to 7 may rely on the flag id, the three tuples, the marker's shape,
`shaperSignInTarget`, `ShapingSignInView` and `SIGN_IN_REASONS`. They must not add a second
way to read a shaper's target or reword a reason outside `SIGN_IN_REASONS`.

## Cross-phase audit

- Phase 1: `SignInTarget` here has the shape `flow.ts` declares. Phase 1 enforces the
  `issuer` rule at sign-in, and this phase only validates its form.
- Phase 2: `SHAPING_SIGN_IN_STORAGE` matches the store's two kinds.
- Phase 4: fills `ShapingSignInView` and answers with these reasons.
- Phase 5: replaces the guard, and keeps the header pin.
- Phase 6: gates its routes with this flag after `task-shaping`.
- Phase 7: adds controls to the row whose text this phase starts.
