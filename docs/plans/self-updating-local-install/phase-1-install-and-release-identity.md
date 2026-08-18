# Phase 1: Install path and release identity

**Source plan:** [`plan.md`](plan.md) - **Index:** [`phased-plan.md`](phased-plan.md)
**Direct prerequisites:** none
**Merge unit:** one pull request in `mancej-cyc/ai-harness`

## Outcome

A user installs Mission Control with one documented command from a fresh clone. The install
establishes a clone that only the updater will ever touch, builds and installs the app from it, and
records a receipt describing what was installed and from where. In parallel, the repository gains a
real release identity: merging a Release Please pull request produces a `vX.Y.Z` tag, a generated
`CHANGELOG.md`, and a GitHub Release whose version equals the packaged app's version.

Engineering value on its own: the install stops being a developer-only `make` target with a manual
quarantine workaround, and the repository gains versioning it has never had. Nothing in this phase
depends on the updater existing.

## Entry criteria

- None. This phase merges first.

## Scope

1. The receipt contract, deliberately split in two so nothing renderer-adjacent can pull in
   filesystem code:
   - `src/shared/install-receipt-schema.ts`: the receipt type, the schema constant, and a pure
     `validateReceipt` returning a reason string or `null`. Browser-safe, no `node:` imports.
   - `src/shared/install-receipt.mjs` (plus `.d.mts`): the path resolution and the read and write,
     importing the schema module for validation.
2. `scripts/install-app.mjs`: the install entry point. Prerequisites, clone establishment, checkout,
   build, package, verify, swap, receipt.
3. `Makefile`: a new `install` target for the user path. `make install-app` keeps its current
   developer meaning.
4. Release Please: `release-please-config.json`, `.release-please-manifest.json`, and
   `.github/workflows/release.yml`.
5. `scripts/assert-release-version.mjs`: proves tag, `package.json`, and lockfile agree. Wired into
   CI.
6. Docs: `docs/overview.md` install section and `docs/desktop-and-packaging.md`.
7. Unit tests for the receipt module, the version assertion, and the prerequisite messages.

### Non-goals

- No update checking, prompting, or applying. That is Phase 2.
- No renderer or IPC change at all.
- No signing, notarization, or hardened runtime.
- No change to `electron-builder.yml` targets. arm64-only stands.
- No change to how the daemon LaunchAgent is installed.

## Repository findings

- `Makefile:99-104` already has `app` and `install-app`:

  ```make
  install-app: app ## Build, package, and copy Mission Control.app into /Applications
  	@rm -rf "/Applications/Mission Control.app"
  	@cp -R "release/mac-arm64/Mission Control.app" /Applications/ && echo "installed to /Applications/Mission Control.app"
  ```

  This is the swap mechanic to reuse. Note it copies from `release/mac-arm64/`, the `dir` target
  output, not from the DMG.
- `scripts/install-service.mjs:11` imports `{ BASE_URL, stateDir }` from
  `../src/shared/harness-runtime.mjs`. That establishes both the state-dir accessor to use for the
  receipt and the convention that shared code consumed by `scripts/` lives in `src/shared/` as
  `.mjs`. `scripts/init-prerequisites.d.mts` and `scripts/db-shell.d.mts` establish the paired
  `.d.mts` typing convention.
- `scripts/init-prerequisites.mjs` already exports `nodePrerequisiteMessage` and `MIN_NODE_MAJOR`.
  Extend this module for the new prerequisites rather than writing a second checker.
- `scripts/init.mjs:1-25` establishes the house style for an idempotent bootstrap script: numbered
  headings, `✓`/`→`/`⚠` output helpers, a `--dry-run` flag, and a collected `problems` array. Follow
  it.
- `docs/overview.md:158-177` documents the current install and the
  `xattr -dr com.apple.quarantine` workaround. A locally built app installed by `cp` is not
  quarantined, so the new documented path should not need that note; verify before deleting it.
- `.github/workflows/ci.yml:335-359` is the only workflow and its `package` job is gated on
  `startsWith(github.ref, 'refs/tags/') || github.event_name == 'workflow_dispatch'`. Creating tags
  will start it, which is fine, but confirm it does not race the release workflow.
- `package.json:3` is `0.1.0` and no tag exists, so Release Please must be bootstrapped at that
  version rather than allowed to invent one.

## Inherited contracts

None. This phase defines the contracts the rest of the plan consumes.

## Implementation steps

### 1. Receipt modules

Two modules, split on the I/O boundary.

`src/shared/install-receipt-schema.ts` holds the type, the `schema` constant, and a pure
`validateReceipt(value)` returning a reason string or `null`. It must stay browser-safe with no
`node:` imports, so a renderer-adjacent import can never drag filesystem code into the web bundle.

`src/shared/install-receipt.mjs` holds `receiptPath()` derived from `stateDir()`, `readReceipt()`, and
`writeReceipt(receipt)`, delegating validation to the schema module.

A note on why the I/O lives in `src/shared/` at all, since the directory is a controlled path: the
consumers are `scripts/install-app.mjs`, the Phase 2 apply helper, and the bundled main process, and
`src/shared/harness-runtime.mjs` is the established precedent for exactly this - it imports
`node:crypto`, `node:fs`, `node:os`, and `node:path`, and already performs atomic
`writeFileSync`-then-`renameSync` writes. `src/shared/claude-settings.ts` also imports `node:`. So a
node-using `.mjs` here is conventional rather than novel; the split above is defensive, keeping the
browser-safe half genuinely browser-safe rather than relying on callers to be careful.

The receipt's shape:

```js
{
  schema: 1,
  repo: "mancej-cyc/ai-harness",
  releaseTag: "v0.1.0",      // null when installed from an untagged HEAD
  installedVersion: "0.1.0",
  sourceClone: "/Users/<user>/.mission-control/app-src",
  appPath: "/Applications/Mission Control.app",
  installedAt: "2026-08-18T00:00:00.000Z"
}
```

`readReceipt()` returns `null` rather than throwing when the file is absent or malformed.
`writeReceipt()` writes atomically, temp file then rename, matching `harness-runtime.mjs`.

`schema` is append-only. A reader that meets a higher schema number than it knows must decline rather
than guess, because Phase 2 decides whether to run an update from this file.

### 2. Prerequisites

Extend `scripts/init-prerequisites.mjs` with message builders for: `git` present, `gh` present, `gh`
authenticated, and host architecture is `arm64`. Reuse the existing phrasing for `gh` from
`src/server/task-sources/github-issues.ts:224-225` so the app and the installer say the same thing:

- not installed: "the gh CLI is not installed - install it and run `gh auth login`"
- not authenticated: "gh is not authenticated - run `gh auth login`"

The arm64 check must fail the install with an explicit message, not warn. `electron-builder.yml`
pins `arch: arm64`, so an Intel host would otherwise build an app it cannot run.

### 3. Install script

`scripts/install-app.mjs`, following `scripts/init.mjs` style, with `--dry-run` and an optional
`--ref <git-ref>`:

1. Check prerequisites. Exit non-zero on any failure.
2. Resolve the updater-owned clone path: `join(stateDir(), "app-src")`.
3. Establish the clone. If absent, `git clone` from the current repository's `origin` remote URL so a
   user who cloned over SSH keeps SSH and one who used HTTPS keeps HTTPS. If present, `git fetch
   --tags --prune`. Refuse to proceed if the directory exists but is not a git repository whose
   `origin` matches, rather than deleting anything.
4. Resolve the target ref: `--ref` if given, else the newest **stable** release tag, else the default
   branch tip when no release exists yet. Record which was used in the output.

   Select that tag the same way the Phase 2 updater does, from an explicitly filtered list rather than
   by asking for "the latest" and filtering afterwards:

   ```sh
   gh release list --exclude-drafts --exclude-pre-releases --order desc --limit 1 --json tagName
   ```

   `gh release view` with no tag argument applies its own "latest release" rule, and its `--help` does
   not state whether that rule skips prereleases, so an install must not depend on it either. Both the
   install path and the update path resolve a release tag, so both need the same rule; if they
   disagree, a fresh install and an update can land on different versions from the same repository
   state.
5. `git -C <clone> checkout --force <ref>` and confirm the resulting tree is clean. This clone is
   updater-exclusive, so a forced checkout is correct here and only here.
6. `npm ci`, then `npm run package`, both in the clone.
7. Verify the packaged app: `release/mac-arm64/Mission Control.app` exists and its
   `Contents/Info.plist` version equals the clone's `package.json` version. Fail before touching
   `/Applications` if not.
8. Swap: remove the existing `/Applications/Mission Control.app` and copy the new one, matching the
   existing `install-app` recipe.
9. Write the receipt.
10. Print the installed version, the source clone path, and how to launch.

Idempotent by construction: every step detects its own completion, and re-running with the same ref
is a no-op apart from the rebuild.

### 4. Makefile

Add a `install` target that runs `node scripts/install-app.mjs $(ARGS)`, and add it to `.PHONY` and
the help text. Leave `app` and `install-app` alone: they remain the developer path that installs the
current worktree and deliberately writes no receipt, so the updater stays disabled for a
work-in-progress build.

### 5. Release Please

Add `release-please-config.json` with the `node` release type, `.release-please-manifest.json`
bootstrapped to `0.1.0`, and `.github/workflows/release.yml` that runs on pushes to the default
branch and opens or updates the release pull request.

`.github/workflows/` is a controlled path and this phase is explicitly authorized to change it. Keep
the change to adding the release workflow; do not restructure `ci.yml` beyond wiring the version
assertion.

Conventional-commit-compatible squash titles become the changelog input. `CHANGELOG.md` is generated
and must never be hand-edited.

### 6. Version assertion

`scripts/assert-release-version.mjs` compares a tag argument against `package.json` and
`package-lock.json`, exiting non-zero with a precise message on mismatch. Call it from the release
workflow and from the existing `package` job so a mismatched tag cannot produce an artifact.

### 7. Documentation

Rewrite the install section of `docs/overview.md` around `make install`, keeping `make app` and
`make install-app` documented as the developer path and stating plainly that the updater is inactive
for those. Extend `docs/desktop-and-packaging.md` with the receipt, the updater-owned clone, and the
release identity contract. It currently says nothing about versions or releases.

## Data and compatibility details

- The receipt is new state in the existing state directory. No SQLite schema or migration is involved.
- No persisted append-only ID is added or reordered.
- An install performed before this phase leaves no receipt, which Phase 2 must treat as "updater
  disabled, installed outside the managed path". That is the intended reading, not an error.
- The updater-owned clone is a full checkout. Document the disk cost in
  `docs/desktop-and-packaging.md`.

## Tests and verification

Unit tests in `test/`, using `node:test` and `node:assert/strict`:

- receipt round-trip; malformed JSON returns `null`; unknown higher `schema` is declined; the write is
  atomic in the sense that a failed write leaves any previous file intact.
- `assert-release-version` accepts matching input and rejects each mismatch shape, including a
  lockfile that disagrees with `package.json`.
- new prerequisite message builders, including the arm64 refusal;
- the target-ref resolver prefers `--ref`, then the newest stable release tag, then the default branch
  tip, and **does not select a prerelease or draft** even when one is newer than the newest stable
  release. This is the same regression Phase 2 guards on the update side; both paths resolve a tag, so
  both are tested for it.

Tests that touch a state directory must carry the suite's state preload. Run a single file as:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/install-receipt.test.ts
```

Commands that must pass: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`,
`npm run smoke`.

No UI surface changes, so no `e2e/` spec is required by this phase. Record that reasoning in the pull
request so it is not mistaken for an omission.

Manual verification to record on the pull request:

- `make install` from a fresh clone against a temporary `MISSION_HOME`, showing the clone
  established, the app installed, the receipt written, and the app launching.
- A second `make install` run, showing idempotency.
- An install attempt with `gh` logged out, showing the actionable message.

## Merge and exit criteria

- `make install` works from a clean clone and writes a valid receipt.
- The updater-owned clone exists, is clean, and is distinct from the user's worktree.
- Merging a Release Please pull request produces a tag, a generated `CHANGELOG.md`, and a GitHub
  Release, and the filtered selection query returns it:
  `gh release list --exclude-drafts --exclude-pre-releases --order desc --limit 1 --json tagName`.
- Tag, `package.json`, and lockfile version equality is enforced in CI.
- `docs/overview.md` and `docs/desktop-and-packaging.md` match the behavior.
- All gates above pass.

## Downstream handoff

Phase 2 may rely on:

- the receipt path, schema, reader, and the `null`-on-absent contract;
- `sourceClone` naming a clean, updater-exclusive git checkout;
- `installedVersion` equalling the packaged `app.getVersion()`;
- `scripts/install-app.mjs` being idempotent, accepting `--ref`, and exiting non-zero on failure;
- at least one GitHub Release existing to compare against.

Phase 2 must not change the receipt schema shape, repoint the clone, or make the install script
non-idempotent. If Phase 2 needs another field, it is added as an optional field under the same
`schema` number, or `schema` is incremented with a reader that still accepts 1.

## Cross-phase audit record

- **2026-08-18, authored.** First phase written; no earlier phase to reconcile against.
- **2026-08-18, after Phase 2.** Confirmed the install script's `--ref` flag and non-zero exit
  contract are exactly what the apply helper needs, so Phase 2 reuses this script rather than
  duplicating build logic. Confirmed the receipt carries `sourceClone` and `appPath`, which are the
  two paths the helper operates on. No change required to this file.
- **2026-08-18, after Phase 3.** Phase 3 consumes nothing from this phase directly. No change.
- **2026-08-18, Inspector round 1.** Split the receipt into a browser-safe schema module and a
  separate I/O module, so nothing renderer-adjacent can pull filesystem code into the web bundle. The
  review's premise that node-using code cannot live in `src/shared/` is contradicted by
  `src/shared/harness-runtime.mjs` and `src/shared/claude-settings.ts`, so the I/O stays there by
  precedent; the split is defensive rather than mandated, and the reasoning is now recorded in the
  implementation step. No contract consumed by a later phase changed shape.
- **2026-08-18, Inspector round 4.** The round-4 comment was against the root plan's diagram, but
  chasing it surfaced the same defect here: this phase resolved its target ref with
  `gh release view --json tagName`, which would install a prerelease and could leave a fresh install on
  a different version than an update from identical repository state. Both paths now use the same
  explicitly filtered selection query, the exit criterion verifies with that query, and a test covers
  the install-side rule. Not flagged by the review.
