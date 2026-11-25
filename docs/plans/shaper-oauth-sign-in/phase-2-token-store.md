# Shaper sign-in - Phase 2: Token store

## Outcome

Mission Control can keep one sign-in record per connection in the macOS Keychain, or in
memory where there is no Keychain, behind one asynchronous interface (D1, D2). A token is
never written to a file, and never appears in an argument list or a tool's output.

Nothing calls the store yet. Phase 4 is its first caller.

## Entry criteria and dependencies

- The planning pull request is merged. No other phase is needed.
- It can be built at the same time as phases 1 and 3.

## Hard rules

- No reading, copying, exporting or passing of real credentials: no Keychain reads of other
  applications' items, no `auth.json`, no OAuth tokens or API keys other than this
  feature's own fake-valued test fixtures, and nothing under `~/.claude*` or `~/.codex*`.
- Tests use a loopback mock authorization server and fake values only.
- No real login against Okta or the gateway, and no request to either.
- The feature's own Keychain item names are unique. A test that writes an item removes it
  and verifies it is gone. The macOS test here uses a service name with a random suffix,
  never the product's own, and reads only the item it wrote.
- No full unit suite and no full end-to-end suite locally. Run this phase's own test files,
  with `npm run typecheck` and `npm run lint`. CI runs the full suites.

## Scope

- `native/keychain/`: a Node-API addon that calls the Security framework.
- `scripts/build-keychain-native.mjs`, and one more entry in `scripts/build-native.mjs`.
- `src/server/shaping/sign-in/keychain-native.ts`: finds, loads and validates the addon.
- `src/server/shaping/sign-in/store.ts`: `SignInStore`, its two backends and the choice
  between them.
- `docs/security.md` and `docs/configuration.md`.

Not here: what a record means, when it is written, refresh, routes, Settings. No change to
`electron-builder.yml` or any signing or release file. If packaging turns out to need one,
stop and report: those files are controlled.

## Repository findings and inherited contracts

- **The pattern exists.** `native/keep-awake/` is an Objective-C++ addon that links an Apple
  framework. `scripts/build-keep-awake-native.mjs` skips every platform but macOS, runs
  `node-gyp rebuild`, and publishes through `publishNativeAddon` to `dist/native/`.
  `src/server/keep-awake-native.ts` loads and validates it.
- **Publishing is a rename, never a copy.** `test/native-addon-publish.test.ts` refuses a
  builder that copies its artifact into `dist/native`.
- **Packaging needs no change.** `electron-builder.yml` packs `dist/**/*`.
- **The planning spike** (macOS 26, Node 24.19.0, a throwaway addon, fake values, one item
  under a unique name, deleted and verified gone): `SecItemAdd`, `SecItemUpdate`,
  `SecItemCopyMatching` and `SecItemDelete` on a generic password worked for 16 KiB and for
  64 KiB with no prompt. A lookup that finds nothing returns `errSecItemNotFound`, -25300.
  The first write took about 200 ms, on the calling thread.
- **Injected platform.** `KeepAwakeManager` (`src/server/keep-awake.ts`) takes its platform
  and its loader as arguments, so Linux CI runs its logic. The store does the same.
- **CI is Linux.** A macOS-only test is skipped there
  (`{ skip: process.platform !== "darwin" }`) and is run on a Mac by this phase's session.

## Steps

1. **The addon.** Four functions. Each returns a promise and does its Security call in
   Node-API async work, so a slow call, or a prompt macOS decides to show, never stops the
   daemon's event loop.
   - `get(service, account)`: the value as a string, or null when there is no item.
   - `set(service, account, value, label)`: adds the item, or replaces its value when it
     exists. A value over 256 KiB is refused.
   - `remove(service, account)`: true when an item was removed, false when there was none.
   - `accounts(service)`: the account of every item with that service.

   The item is a generic password in the login Keychain. It is never marked for iCloud
   sync. A failure rejects with the status code and fixed text, never with the value.
2. **The builder.** Copy the keep-awake builder's shape: skip off macOS, build for arm64 or
   x64, publish to `dist/native/keychain.node` through `publishNativeAddon`. Add it to
   `scripts/build-native.mjs`.
3. **The loader.** The addon's path, a check that the four functions exist, and a load that
   throws a clear error when either fails.
4. **The store.**

   ```ts
   interface StoredSignIn {
     v: 1; target: { url: string; scope: string; issuer: string | null };
     issuer: string; clientId: string; accessToken: string; refreshToken: string | null;
     expiresAt: number | null; scope: string | null; obtainedAt: number;
   }
   interface SignInStore {
     readonly kind: "keychain" | "memory";
     read(id: string): Promise<StoredSignIn | null>;
     write(id: string, record: StoredSignIn): Promise<void>;
     remove(id: string): Promise<void>;
     ids(): Promise<string[]>;
   }
   ```

   - `createSignInStore(deps)` picks `memory` when `MISSION_SHAPER_SIGN_IN_STORE` is
     `memory`, when the platform is not macOS, or when the addon does not load. Otherwise it
     picks `keychain`. Its `deps` are the platform, the environment, the loader, the state
     home and, for tests, the service name.
   - Keychain backend: the service is `Mission Control shaper sign-in`. The account is the
     first 16 hex characters of the SHA-256 of the state home's real path, then `/`, then
     the id. `ids()` returns only the accounts that carry this home's tag. The value is the
     record as JSON. A value that is not a valid record reads as null.
   - A Keychain call that fails rejects with a `SignInStoreError` that carries the status
     code. Phase 4 decides what to do with it. The store itself never falls back in the
     middle of a call, so a caller always knows where a record went.
   - `target` is the connection the record belongs to. It is not a secret. It lets the
     service name a stored sign-in after a restart, when no shaper may name it any more.
   - `clientId` is the client that obtained the tokens. It is not a secret. Every refresh
     uses it, whatever registrations the daemon holds by then.
   - Memory backend: a map, gone when the daemon stops.
   - Nothing here logs a record or puts one in an error.
5. **Docs.** `docs/security.md`, under Task shaping: where a sign-in is kept, the item's
   service name, that it is not a boundary against a program running as the operator, that
   macOS asks once when a different program reads the item, and how to remove the item by
   hand in Keychain Access. `docs/configuration.md`: `MISSION_SHAPER_SIGN_IN_STORE`.

## Data, API and compatibility

- No route, no schema, no `app_config` key, no flag. The daemon's behaviour is unchanged.
- **Linux and other platforms.** The addon is not built, and the store is `memory`.
- **A daemon run from a checkout and the packaged app** use different state homes, so
  different accounts. Neither reads the other's items.
- **A record written by a later version** with a `v` this build does not know reads as null.
- The item's name is the feature's own and is fixed here. Later phases must not rename it,
  because a renamed item would strand every stored sign-in.

## Tests and verification

- `test/shaping-sign-in-store.test.ts`, on every platform, with a fake addon: the choice of
  backend for each input in step 4; the account's form; two state homes that do not see each
  other's ids; write, read, replace, remove and `ids()`, with the record's `target` and `clientId` read back unchanged; a corrupt value and an unknown `v`
  read as null; an addon failure rejects with `SignInStoreError`, and the fake token value
  is not in its message.
- `test/shaping-sign-in-keychain-native.test.ts`, macOS only, with the real addon and a
  service name `Mission Control shaper sign-in test <random>`: write a 16 KiB fake record,
  read it back equal, replace it, list it, remove it, read null, list nothing. A callback
  queued with `setImmediate` before a write runs before that write's promise settles, which
  shows the work is off the event loop. An `after` hook removes the item and asserts it is
  gone, whatever failed before it.
- `test/keychain-native-build.test.ts`: the builder skips off macOS and names its target,
  as `test/keep-awake-native-build.test.ts` does for its own.
- Check that `test/native-addon-publish.test.ts` covers the new builder, and extend its
  list if it names builders one by one.

Run `npm run build:native`, the files above, `npm run typecheck` and `npm run lint`. On a
Mac, register the macOS test's output as evidence, because CI cannot run it.

## Merge and exit criteria

- On macOS a fake record of 16 KiB is written, read back equal, replaced and removed
  through the real addon, and the item is verified gone.
- A queued callback runs while a Keychain write is still pending, so the Security work is
  not on the event loop.
- Off macOS, with the switch set to `memory`, and with an addon that does not load, the
  store is `memory`.
- No token value appears in an argument list, an error message or a log line.
- `npm run build:native` succeeds on macOS and skips cleanly on Linux.

## Handoff

Phase 4 may rely on `createSignInStore`, the `SignInStore` interface, `SignInStoreError`
and the record's shape. It must not write a record anywhere else. Phase 7 may rely on the
two documentation sections existing, and adds the operator's steps to them.

## Cross-phase audit

- Phase 1: the record holds what `exchange` and `refresh` return: both tokens, `expiresAt`,
  the scope and the issuer. Its `target` is the `SignInTarget` the sign-in was started for.
- Phase 3: `SHAPING_SIGN_IN_STORAGE` holds `keychain` and `memory`, the two values of
  `kind` here.
- Phase 4: writes before it swaps memory, and treats a `SignInStoreError` as "kept in memory
  only". It also sets the switch to `memory` for the browser suite.
- Phase 7: the Settings text for each `kind` matches the documentation written here.
