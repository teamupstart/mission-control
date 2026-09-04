# Desktop shell and packaging

Mission Control can run as a local daemon during development or as a macOS Electron app.
The [Electron main process](../src/main/index.ts) starts the daemon and Foreman worker, then embeds the dashboard;
the [preload entrypoint](../src/preload/index.ts) keeps the renderer boundary explicit.

The build creates separate bundles for the web dashboard, daemon, Foreman worker, Electron main
and preload processes, MCP server, and hook bridges. The commands are defined in
[`package.json`](../package.json). [`electron-builder.yml`](../electron-builder.yml) packages
the built files and a small set of source assets that external tools read at runtime.

The package intentionally leaves `asar` disabled. Hook and MCP satellite scripts are launched
by an external Node process, and skills are read through filesystem links, so both require
plain files on disk. The Electron shell supervises the daemon and the HTTP-only Foreman worker;
it does not become a second state owner. Foreman never opens SQLite, and its daemon lease keeps
an independently started worker safe as a standby.

## Startup while SDK sessions restore

The packaged window loads the ordinary daemon-served dashboard as soon as the daemon owns its
resolved state home, has opened the database, and has bound HTTP. Persisted SDK conversations may
still be restoring serially at that point. The Board renders each readable live persisted row as a
provisional **Restoring** card, then replaces it with the real Registry session under the same
stable id when the driver is adopted.

Those provisional cards are display-only. They cannot be selected, messaged, dragged, assigned,
bound to a workflow, or counted as live work. `/api/health` likewise reports that the daemon and
authenticated API are reachable, not that all SDK drivers are ready. Terminal discovery and the
first startup reconciliation remain gated behind completion of the full SDK restore pass.

## Managed install and the receipt

`make install` ([`scripts/install-app.mjs`](../scripts/install-app.mjs)) is the user install
path; `make app` and `make install-app` remain the developer path that packages the current
worktree. The difference that matters is not the build - it is who owns the source tree the app
was built from, and whether an install left a record of itself.

A managed install builds in a clone **only the updater touches**, at `app-src` inside the state
directory (`~/.mission-control/app-src`). A developer's own worktree is never fetched, checked
out, or rebuilt by the install or by the updater, which is why the install can safely use a
forced checkout in that one location and nowhere else. The clone is a full checkout with its own
`node_modules` and `release/` output, so budget roughly 1-2 GB of disk for it. It is disposable:
deleting it costs the next install a fresh clone and nothing else.

Run `make install` as the signed-in account, never with `sudo`. Checkout, dependency installation,
packaging, and the receipt all stay unprivileged. If `/Applications` is not writable, macOS asks
for administrator authorization only when the complete, verified bundle is ready for its atomic
swap. The detached updater uses the same narrow prompt for installation and rollback.

The clone is also self-repairing after a historical privileged install. If `sudo make install`
left nested directories that the signed-in account cannot rewrite, the installer first creates a
complete fresh clone, atomically moves the unusable clone aside, and continues from the fresh one.
It removes the old clone when permissions allow. Otherwise it prints the preserved sibling path
for one-time administrator cleanup instead of letting `git checkout` fail halfway through an
automatic update. The broad privileged command is the legacy failure mode, not the remediation.

Two trust rules hold on the install path, not only in the updater:

- The clone is pinned to the canonical repository, exported once as `CANONICAL_REPO` from
  [`src/shared/install-receipt-schema.mjs`](../src/shared/install-receipt-schema.mjs). Only the
  *transport* comes from the caller's `origin`, so an SSH clone stays SSH and an HTTPS clone
  stays HTTPS. A checkout whose `origin` is a fork is refused, with `--from-origin` as the
  explicit way past it; such an install records its real repository in the receipt.
- Managed installs created before the move from `mancej-cyc/ai-harness` remain eligible for one
  migration. The next update normalizes the receipt to `teamupstart/mission-control` and rewrites
  the updater-owned clone's `origin` to the new canonical URL before fetching. No other historical
  or fork slug is accepted by that compatibility path.
- Every remote is compared as **host and repository**, never repository alone - the caller's
  `origin` and the existing clone's `origin` alike. `https://elsewhere.example/owner/name.git`
  carries the right owner and name, and the clone it names is about to be fetched and force
  checked out, so a slug-only comparison would trust whatever that host served. Only
  `github.com` is accepted, on either transport, because the releases being compared against are
  GitHub releases.
- Every release query passes the repository explicitly. Left implicit, the GitHub CLI infers it
  from whichever checkout it runs in, so the documented command run inside a fork would install
  fork-controlled code under the same tag name.
- A release lookup that **fails** is not an empty release list. "This repository has published no
  stable release yet" falls back to the default branch tip; "GitHub could not be asked" stops the
  install, because otherwise a transient outage silently installs unreleased code under someone
  who asked for a release. `--ref` skips the lookup entirely, so an explicit-ref install does not
  depend on GitHub being reachable.

The install ends by writing a **receipt** to `install-receipt.json` in the state directory:

```json
{
  "schema": 1,
  "repo": "teamupstart/mission-control",
  "releaseTag": "v0.1.0",
  "installedVersion": "0.1.0",
  "sourceClone": "/Users/you/.mission-control/app-src",
  "appPath": "/Applications/Mission Control.app",
  "installedAt": "2026-08-18T00:00:00.000Z"
}
```

The receipt is the packaged app's only evidence that it is updater-managed. It is split across
two modules on the I/O boundary:
[`install-receipt-schema.mjs`](../src/shared/install-receipt-schema.mjs) is browser-safe and
holds the shape, the trusted slug, and validation;
[`install-receipt.mjs`](../src/shared/install-receipt.mjs) resolves the path and does the
atomic temp-file-then-rename write.

Three contracts hold for readers:

- **Absent, malformed, or newer means `null`.** A missing receipt is the normal state of an
  install made outside the managed path - including every install made before it existed - and
  reads as "not updater-managed" rather than as an error. A receipt whose `schema` is higher
  than the reader knows is declined rather than partially believed.
- **`schema` is append-only.** Add optional fields under the same number, or increment it and
  keep accepting every earlier number.
- **`installedVersion` equals the packaged app's version.** The install verifies the packaged
  bundle's `CFBundleShortVersionString` against the source tree's `package.json` before it
  replaces anything in `/Applications`, so a build that did not come from the checked-out ref
  fails while the previous app is still in place.

The swap itself keeps the installed app until the new one is fully on disk. The new bundle is
copied to a hidden sibling of the destination first; only then is the existing app renamed aside
and the new one renamed into place, both renames within one directory and therefore atomic. A
failed copy leaves the installed app untouched, and a failed final rename puts the previous app
back. A user whose disk filled mid-install ends up with the app they already had, not with
none. On an account that cannot write `/Applications`, this transaction is the only command run
with administrator authorization. The updater source clone and state files remain owned by the
signed-in account.

## Updates from the installed app

A managed app checks the canonical repository's stable GitHub Releases through the already
authenticated `gh` CLI. When a newer version is available, the dashboard shows a full-width banner
with the version, a shortened plain-text release summary, and **Update Now** and **Later** controls.
Deferring hides the banner until the next scheduled check or launch. The banner is part of the
Electron-only preload capability: the plain browser dashboard has no update bridge, renders no
update banner, and starts no update check.

**Update Now** does not close anything. It starts the build, and Mission Control stays open and
usable while it runs: the banner becomes a progress bar with the stage the install script has
reached - prerequisites, source, release, checkout, dependencies, build, verify - and a **Cancel**
that stops the build and puts the offer back. When the new version is built and verified the banner
reads **ready to install** and offers **Restart and Install**, which is the only part of an update
that needs the app gone. That part takes seconds.

Choose **Check for Updates…** from either the application menu or the tray for an immediate manual
check. A native dialog reports that the app is current or offers the same **Update Now** and **Later**
choice, then asks about the restart once the build finishes; accepting from the menu bar also
reveals the dashboard, because that is where the progress is drawn. A manual check made while a
build is running reports the stage it has reached rather than starting a second one. This native
path remains available while the dashboard window is hidden. The app also checks after a short
startup delay, every six hours with jitter, and once after returning from a long sleep.

A build that has finished is kept if the person chooses **Later**, pinned to the release tag it was
built from, so accepting it afterwards installs immediately instead of spending those minutes
again. It is verified again at the moment of the restart: a bundle that has since been removed is
reported in the banner with a retry, before anything quits. Quitting Mission Control while a build
is running cancels it, along with the `npm` and `electron-builder` children it spawned, so nothing
keeps writing into the clone that the next attempt will check out.

Background failures stay quiet and are written to the local update log, with one exception. A
failure that will still be there in six hours and that only the operator can clear - `gh` missing,
or a lapsed `gh` credential - reaches the banner from a background check as well, because a
condition nobody is ever told about is a condition nobody fixes. Everything that clears itself
stays silent: a rate limit (which reads as a rate limit, not as a lapsed credential) and any other
transient failure return to idle exactly as before. A background check still never opens a native
dialog; only a manual check does.

Updates are deliberately inert in development, on Intel Macs, without a managed-install receipt,
without a system Node.js binary, or when `--from-origin` installed a non-canonical repository. A
manual check explains the applicable reason. A release is offered only when its numeric version is
strictly newer than the running app, so the updater never provides a downgrade path.

### Where the work happens, and why it splits

Steps 1 to 7 of [`scripts/install-app.mjs`](../scripts/install-app.mjs) - prerequisites, the
updater-owned clone, the release, the checkout, `npm ci`, `npm run package`, and version
verification - touch nothing but that clone. Only the bundle swap and the receipt need the
installed app gone. The update is therefore applied in two halves, selected by flags on the one
install script rather than by a second script:

- `--stage-only` runs everything up to and including verification and stops, printing the bundle
  it produced. `--progress` makes it emit a stage marker per step, which is what the app's progress
  bar reads. The live app runs this, so all the minutes are visible and cancellable.
- `--from-staged <bundle>` installs a bundle that was already built: the swap and the receipt, and
  nothing else. The detached helper runs this after the app has quit.

The install script remains the only owner of checkout, build, version verification, the atomic
bundle swap, and the receipt; a plain `make install` still runs both halves in one pass.

After the person accepts the restart, the Electron process copies
[`scripts/apply-update.mjs`](../scripts/apply-update.mjs) out of the bundle and starts it as a
detached system-Node process, handing it the staged bundle with `--staged-bundle`. The app marks
itself as quitting before calling Electron's quit API, which lets the hide-on-close window guard
close normally. The helper waits for the app process to exit, backs up the installed bundle and
receipt, and invokes the clone's `install-app.mjs --from-staged` path.

An install script that predates these flags says `unknown argument: --stage-only`, and the app then
falls back to the single-shot handoff it has always used: the helper builds as well as installs, with
no progress to show. That is reachable when the updater-owned clone is checked out at an older ref
than the running app - `--ref` allows exactly that - and an update applied without a progress bar is
better than one refused over it.

Each half carries its own bound, reported in its own words. The build gets 45 minutes, in the app
and in the helper alike; a staged install gets ten, which is generous for a copy and a receipt but
still allows for an administrator panel waiting to be answered. Both are separate from the
two-minute wait for the app to quit - a wedged `npm` and an app that will not close are different
failures, and a person reading either message should be told which one happened.

The helper relaunches the installed bundle by its exact path. A build, verification, swap, outcome,
or relaunch failure restores both the previous app and its receipt before relaunching it. A failure
also copies what it was holding to `failed-update/` in the state directory before its temp directory
is removed: the previous app bundle, the previous receipt, and the bundle that failed. That is the
evidence of how it broke and a second, by-hand rollback if the automatic one did not take. It keeps
one attempt's worth - the next update clears it as it starts, before anything that could fail,
so it holds the latest attempt however that attempt ended and cannot accumulate. If that copy cannot be made at all, because the state directory is full or unwritable,
nothing is deleted to compensate: the helper's temp directory is left in place holding the backup,
and the failed bundle stays beside the installed app. The operator whose state directory is too
broken to hold a second copy is exactly the one who must not lose the first.

The result is stored in the versioned `update-outcome.json` marker. On the next launch, the
native dialog and dashboard banner report a safe success or failure summary; a failure is
therefore visible without opening the local log. **Retry** runs a fresh check, while **Dismiss**
hides that result until update state changes. Diagnostic output remains only in the rotating
`update.log` in the state directory, with credentials, absolute paths, and remote URLs redacted
by [`src/main/update-log.ts`](../src/main/update-log.ts) - including every line the staged build
produced, because an `npm` or `electron-builder` failure is only ever diagnosable in its own
words. That build's output is the one update channel whose text this app did not write, so it is
redacted where it arrives as well as where it is written; the rule is idempotent, and neither
place is allowed to be the only one applying it.

Remote URLs are part of that rule, not an afterthought: a registry line is where a private host
and an embedded credential turn up (`npm warn registry https://user:secret@registry.internal/`),
and a path rule anchored on a preceding space or quote never fires on the `//` after a scheme's
colon. Both spellings of a git remote go the same way, `scheme://host/path` and
`git@host:path`, and whole URLs are replaced rather than just their credentials - which
registry a build reached is the fact worth hiding, exactly as which directory it built in
already was. `scripts/apply-update.mjs` carries a deliberate copy of the rule set, because the
detached helper is copied out of the bundle with exactly one sibling module and can import
nothing else; `test/update-log.test.ts` pins the two to identical output so the copy cannot
drift.

This updates only the packaged application and its updater-owned clone. A separately installed
daemon LaunchAgent still runs from the repository path recorded in its plist and is not changed by
an application update.

## Release identity

Release Please owns the version, the generated `CHANGELOG.md`, the `vX.Y.Z` tag, and the GitHub
Release. Configuration is [`release-please-config.json`](../release-please-config.json) with
[`.release-please-manifest.json`](../.release-please-manifest.json) bootstrapped at the `0.1.0`
already in `package.json`; [`.github/workflows/release.yml`](../.github/workflows/release.yml)
keeps a single release pull request current on the default branch. Merging that pull request is
the release: the tag and the GitHub Release follow from the next run. Never hand-edit
`CHANGELOG.md`.

The action authenticates with a short-lived installation token minted for the
`mission-control-release` GitHub App on every run. `RELEASE_PLEASE_APP_CLIENT_ID` is a repository
Actions variable and `RELEASE_PLEASE_APP_PRIVATE_KEY` is a repository Actions secret. The App is
installed only on this repository with contents, issues, and pull-request write access. The
organization policy prevents the default `GITHUB_TOKEN` from opening pull requests, so replacing
the configured App token with the default token makes the Release workflow fail on every push to
`main`.

Release Please does not fail when it cannot parse a commit subject. It omits that commit and can
exit successfully after considering zero commits, without opening or updating the standing release
pull request. [`pull-request-title.yml`](../.github/workflows/pull-request-title.yml) checks every
pull request title when it is opened, edited, synchronized, or reopened. The Release workflow
independently rechecks each first-parent commit added to `main` before it mints the App token. Both
gates use [`scripts/assert-release-commit.mjs`](../scripts/assert-release-commit.mjs), whose
accepted shape is `type(optional-scope)!: description`. Use `fix:` for a patch and `feat:` for a
feature; other lowercase Conventional Commit types are parseable but may not create a release on
their own.
The title workflow runs as `pull_request_target` and executes the validator from the base SHA, so a
pull request cannot change its own gate. A pull request that first introduces the workflow or moves
its event ownership between `pull_request` and `pull_request_target` is not title-checked during
that transition; its merge subject is still checked by the release preflight on the resulting push
to `main`. Later pull requests run the base-owned title gate normally.

The first release was pinned to `v1.0.0` through the package's `release-as` setting. That one-time
pin was removed once `v1.0.0` published, so releases now resume normal version calculation from the
conventional-commit history. Leaving it in place is not a cosmetic oversight:
`release-as` forces the same version on every subsequent run, so with the manifest already at
`1.0.0` release-please proposes `1.0.0` again and no later release can be cut at all.

One equality is load-bearing and therefore enforced rather than assumed: the tag, `package.json`,
and both version fields in `package-lock.json` must name the same version.
[`scripts/assert-release-version.mjs`](../scripts/assert-release-version.mjs) proves it, and runs
both in the release workflow and in `ci.yml`'s `package` job, where it blocks a mismatched tag
from producing a dmg. A release the updater can compare against is exactly a release whose tag
equals the version the app reports. The accepted release-tag grammar is exactly a stable,
`v`-prefixed three-part version such as `v1.2.3`; bare versions, prereleases, and build metadata
are rejected because the install and update queries deliberately exclude prereleases.

Releases are selected - by the install path and by the updater alike - from an explicitly
filtered list:

```sh
gh release list --repo <owner/name> --exclude-drafts --exclude-pre-releases   --order desc --limit 1 --json tagName
```

Filtering after asking for "the latest" cannot recover: once a prerelease has been chosen, there
is no route back to the newest stable release, and every stable install silently stops updating
with nothing logged anywhere.

Tags created by the release workflow are pushed with the short-lived App installation token, so
they start a new `ci.yml` run. Its `package` job builds the macOS dmg, checks that the tag and
package versions agree, and uploads the dmg as a 90-day Actions artifact. This is a separate
release build check; the dmg is not attached to the GitHub Release. The package job can also be run
manually through `workflow_dispatch`.

Proving that the whole journey works - clone, install, be offered a real update, accept it, and
come back on the new version, plus a failed update that leaves the previous app running - is a
procedure rather than a test, because no automated layer touches the real `gh` call, the detached
spawn, or the real clone-and-package build. It is written down in the
[release verification runbook](runbooks/release-verification.md), along with the observed timings
and the failure signatures that are easy to misread.

See [Configuration and commands](configuration.md) for operating the app. Packaging and
build-surface rules are authoritative in the [Electron and build surfaces contract](agent-guides/change-contracts.md#electron-and-build-surfaces)
and [process-boundary guide](agent-guides/architecture.md#process-boundaries).
