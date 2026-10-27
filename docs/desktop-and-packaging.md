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

The shell immediately shows **Starting Mission Control** from a local page that does not
depend on the daemon. It checks for a compatible daemon before loading the dashboard. After
60 seconds, **Still starting Mission Control** explains the delay and offers **Retry now**.
Readiness checks continue once a second, including after this message, so a late daemon opens
the dashboard automatically. Retry starts a fresh wait; it does not launch a second daemon.
A failed dashboard navigation, including a completed HTTP error response, returns to a visible
reconnecting screen. Navigation itself also has a 60-second bound in case the daemon disappears
after its health response.
Local startup-page navigation uses the same bound and cancellation signal. If a local page
fails to load, the shell retries it too, including the first page before the window is visible.

Window startup owns this recovery loop. Successful dashboard loading, window destruction and
application quit stop it, so it cannot reload an active conversation. The native menu and
updater initialize independently of readiness, and update questions allow 65 seconds for a
dashboard host. Development checks the Vite origin instead of requiring its own health route.

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

### Binary installation and manual recovery

The standard [Bash installer](../scripts/install.sh) downloads canonical, immutable stable or
exact-SHA alpha assets. Native macOS tools verify the size, SHA-256, product identity,
arm64 executable, pinned Developer ID team and notarization before any downloaded code runs.
It mounts the DMG read-only, checks its roots and links, copies the complete app to a private
directory, verifies it again and unmounts the image. Only then does its embedded Electron Node
engine run [`install-binary.mjs`](../scripts/install-binary.mjs). No host Node, npm, npx, Git,
Python, jq or compiler participates. Native `gh` owns authentication and redirects. Missing
or incomplete assets fail with a retry/recovery message; there is no source fallback.

Use `--ref vX.Y.Z` for stable, `--ref FULL_SHA` for alpha, or `--channel alpha` to pin the
current main commit. An unavailable/retired alpha requires a new explicit selection. Fresh
installs default to the personal Applications directory. `--scope system` selects a fresh
system install; `--apps-dir DIR` requires an existing writable custom directory. A rerun
without destination flags keeps the exact receipt destination and scope. State follows
`MISSION_HOME` and its existing aliases. Malformed, newer or foreign receipts stop the installer.
Source-only flags explain how to use the explicit source command instead.

Quit the old app before replacement. The installer waits for its exact bundle's processes to
exit, refuses unsafe launch registrations, and probes the daemon's native state lock before
writing. It never signals an unrelated process or opens SQLite. Schema-1 receipts naming either
a clone or a retained compiled installer migrate through the existing in-place journal,
readiness, receipt commit and recovery boundary. Old source support is retained. A running old
GUI does not need a new handshake: only the newly installed target acknowledges readiness.
On interruption, rerunning uses the existing journal for recovery before another attempt.

This phase deliberately keeps legacy replacement at the existing destination. A request to
move an existing managed installation is refused with in-place recovery guidance; the existing
app relocation flow retains ownership of consent, login items and integration-path repair.
No integration path changes during an in-place replacement or enrollment, so JSONC, disabled
registrations, custom runtimes, login preferences and retained sessions remain untouched.

First installs reuse the direct staged installer and atomic receipt writer. With no prior app
to restore, receipt publication commits the install before the first verified GUI launch.
Launch failures retain the app and receipt for forward recovery. Existing-install transactions
retain their stronger pre-commit readiness and exact prior-receipt guarantees. A receipt-write
failure on a first install can leave an unreceipted verified app; `--enroll` can finish that
installation after verifying the exact published bytes again.

A signed DMG can be downloaded manually from the canonical GitHub Release and copied to your
personal Applications directory, `/Applications`, or a persistent custom folder. Open the
copied app, then use **Settings > Setup > Application updates > Enroll this copied app**.
Enrollment uses native `gh` to fetch and compare that exact publication, then writes a schema-2
binary receipt under the shared writer lock. It refuses a different managed destination or
modified copied bytes. The displayed destination makes system enrollment explicit. Launching
from a mounted DMG or App Translocation instead offers **Install Mission Control** before any
daemon starts; it never enrolls or updates the temporary copy. Developer/ad-hoc DMGs remain
unmanaged and use the source installer.

Binary receipts and canonical legacy source receipts use automatic binary updates. After enrolling
a copied app, reopen it to enable the updater. The signed installer remains the manual recovery
route. Phase 5 still owns the broader integration runtime change and universal Setup warning. Shell failures retain private material and print its path;
GUI-started enrollment records details in `$MISSION_HOME/binary-install.log`.

`install.sh` is generated from `install-bootstrap.sh` and the shipped publisher policy by
`npm run build:installer`. Edit that template/policy and regenerate; never change the generated
trust constants by hand. Packaging and the helper inventory include the complete installer
import closure.

**Qualification:** implementation proceeded with explicit operator approval before Phase 2's
signed publication. No ready canonical manifest or controlled signed macOS installation was
available. Fixture and browser checks do not establish minimum-macOS native-tool compatibility,
Gatekeeper, first launch, successful signed replacement or signed system/custom installation.
These remain release gates in [release verification](release-verification.md).

### Explicit source installation

`make install` and the [explicit source installer](../scripts/install-source.sh) both use
[`scripts/install-app.mjs`](../scripts/install-app.mjs) for managed installation;
`make app` and `make install-app` remain the developer path that packages the current
worktree. The difference that matters is not the build - it is who owns the source tree the app
was built from, and whether an install left a record of itself.

By default, `make install` builds in a clone **only the updater touches**, at `app-src` inside the state
directory (`~/.mission-control/app-src`). A developer's own worktree is never fetched, checked
out, or rebuilt by the install or by the updater. Forced checkout is confined to installer-owned
source directories. The managed clone is a full checkout with its own
`node_modules` and `release/` output, so budget roughly 1-2 GB of disk for it. It is disposable:
deleting it costs the next install a fresh clone and nothing else.

The source Bash entry point forwards destination options to the shared installer. A fresh install
defaults to `~/Applications`; a rerun preserves the location in an existing receipt. Moving
to another destination requires an explicit `--scope` or `--apps-dir` option.

It also passes `--temporary-source`: its bootstrap checkout and build clone are
temporary and removed on exit, including ordinary failure and interruption. It never deletes
an existing `app-src` cache or the caller's checkout. Before installing the app, esbuild bundles
the installer and its imported dependencies into one self-contained module under `installers/`
in the state directory, alongside its validated origin. The compiler comes from the build
clone's installed dependencies; no separate dependency manifest is maintained. The receipt's
`sourceClone` names that small directory, keeping the entry point
expected by already-released updaters available without retaining a Git repository,
`node_modules`, or packaged build output. A later update invokes it normally and recreates
`app-src`; that update's receipt then names the managed cache. `--temporary-source` cannot
be combined with `--stage-only` or `--from-staged`, which require durable build output.

A successful direct reinstall removes the previous retained installer only after committing
the new receipt, while holding the receipt-writer lock. Cleanup requires its ownership marker
and a direct directory under this state home's `installers/`; arbitrary sources, symlinks,
unmarked directories, and the currently referenced installer are preserved. Automatic update
helpers retain their previous installer because rollback can restore its receipt.

### Where the app is installed

A fresh managed install puts the app in **`~/Applications/Agent Mission Control.app`**, the signed-in
account's own Applications folder, and creates that folder if the Mac has never had one. That
destination needs no administrator password at any point.

| What you run | Destination | Recorded `installScope` |
| --- | --- | --- |
| Bash installer, no managed receipt or destination options | `~/Applications` | `user` |
| Bash installer, receipt already present, no destination options | wherever the receipt says | whatever the receipt says, unchanged |
| Bash installer with `--scope user` | `~/Applications` | `user` |
| Bash installer with `--scope system` | `/Applications` | `system` |
| Bash installer with `--apps-dir <dir>` | `<dir>`, which must already exist | `custom`, or preserved when it is the receipt's own directory |
| `make install`, no managed receipt yet | `~/Applications` | `user` |
| `make install`, receipt already present | wherever the receipt says | whatever the receipt says, unchanged |
| `make install ARGS="--scope user"` | `~/Applications` | `user` |
| `make install ARGS="--scope system"` | `/Applications` | `system` |
| `make install ARGS="--apps-dir <dir>"` | `<dir>`, which must already exist | `custom`, or preserved when it is the receipt's own directory |

`installScope` is an optional receipt field, added under schema 1. **Its absence means legacy,
not a preference for the system folder.** That distinction is load-bearing: every update helper
ever shipped forwards the receipt's own directory to the installer as `--apps-dir`, so reading
that argument as system consent would quietly convert every pre-existing install into a
deliberate one. `--scope system` and the migration confirmation's **Keep system installation** action record system consent.

The personal default and the administrator boundary are two different things and now live in two
different modules. [`install-destination.mjs`](../scripts/install-destination.mjs) resolves and
validates the destination; `SYSTEM_APPS_DIR` in
[`app-bundle-swap.mjs`](../scripts/app-bundle-swap.mjs) stays pinned to the exact
`/Applications/Mission Control.app` an administrator prompt may write to, so widening the default
cannot widen the privilege boundary. A personal or custom destination that cannot be written is
an actionable error - it never elevates, and it never silently falls back to `/Applications`.

Only the canonical personal folder is created automatically. A `--apps-dir` destination must
already exist, because `cp -R app dir` creates `dir` AS the bundle when it is missing, which
would turn a typo into an app named after the typo. A personal folder that is a file, is owned by
another account, is unwritable, or resolves through a symlink to somewhere outside this home -
`/Applications` above all - stops the install with the reason. Neither `--dry-run` nor
`--stage-only` creates a directory or writes a receipt.

Run `make install` as the signed-in account, never with `sudo`. Checkout, dependency installation,
packaging, and the receipt all stay unprivileged. For an install in `/Applications` that the
account cannot write, macOS asks for administrator authorization only when the complete, verified
bundle is ready for its atomic swap. The detached updater uses the same narrow prompt for
installation and rollback.

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
  "installedCommit": "0123456789abcdef0123456789abcdef01234567",
  "sourceClone": "/Users/you/.mission-control/app-src",
  "appPath": "/Users/you/Applications/Agent Mission Control.app",
  "installScope": "user",
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
  replaces the installed app, so a build that did not come from the checked-out ref fails while
  the previous app is still in place.
- **`installScope` is optional, and absent means legacy.** A reader may not treat a missing
  scope as an explicit choice of any destination.

### Binary contract and receipt compatibility

The browser-safe [`binary-distribution.mjs`](../src/shared/binary-distribution.mjs) owns the
versioned manifest and signed build metadata shapes, with declarations beside it. It bounds
canonical repository, stable tag or exact alpha SHA, product/version/platform identity, helper
protocol range and immutable asset inventory. Archive hashes stay in the external manifest;
signed metadata never embeds its containing archive's digest.

Shape validation does not authenticate a publisher. A binary staged operation requires matching
signed metadata and a trusted caller-supplied Developer ID team and notarization policy. That
policy cannot come from the downloaded manifest. The [signed distribution producer](release-verification.md)
owns signing, notarization, immutable ZIP/DMG publication and manifest-last readiness. Its
trust policy pins the operator-approved Apple team `S2FPCQK39Z`. Credential provisioning
and real signed qualification remain required before that producer can advertise a release.

Receipt schema 1 remains the legacy source form, including retained compiled installers and
absent legacy scope. New readers also accept schema-2 `source` and `binary` forms. Binary receipts
carry immutable manifest and asset provenance and no invented `sourceClone`; unsupported future
schemas fail closed. Source writers continue writing schema 1. Identity, destination, relocation
and source-support cleanup readers accept the union. This does not enable binary release discovery
in the current source updater.

### The running app checks that it is the app in the receipt

The receipt names an absolute `appPath`, and until personal installs existed nothing compared it
to the bundle the running process came out of. One Mac can now hold two Mission Controls - a
retained shared copy and a personal one - so the packaged app classifies itself at startup
through [`install-identity.ts`](../src/main/install-identity.ts):

- **managed**: the running bundle is the one the receipt describes. Commit equality when the
  receipt carries `installedCommit`, version equality when it does not, so legacy receipts stay
  valid. Everything proceeds as before.
- **unmanaged**: no usable receipt, which is what the updater already reported.
- **mismatched**: a receipt describing some other bundle, or a different build at the receipt's
  own path. The app runs; the updater stands down and says why in **Settings → Setup →
  Application updates**, because the only bundle it could update is not this one.
- **redirect**: the one validated exception. The exact `/Applications/Mission Control.app`, whose
  trusted receipt names this account's own `~/Applications/Mission Control.app` and matches that
  bundle's identity, opens it and exits. This happens before the single-instance lock is taken,
  so the app being opened does not lose the lock to the copy handing over to it, and `open`
  reveals an already-running instance rather than starting a second daemon. A failed hand-over is
  not fatal: the old copy keeps running with the updater off.

The updater asks the same question again before it hands a bundle to the detached helper, since
another install can rewrite the receipt while the app sits with an update prepared.

New managed builds also embed the full Git SHA as `missionCommit` in the packaged app's
`package.json`, using electron-builder's extra metadata before signing. The installer checks
that the checkout has not moved during the build and that the packaged identity matches,
then records it as the optional `installedCommit` receipt field. Older receipts remain valid.
The running app reads its own embedded identity rather than the updater clone's current HEAD.

The swap itself keeps the installed app until the new one is fully on disk. The new bundle is
copied to a hidden sibling of the destination first; only then is the existing app renamed aside
and the new one renamed into place, both renames within one directory and therefore atomic. A
failed copy leaves the installed app untouched, and a failed final rename puts the previous app
back. A user whose disk filled mid-install ends up with the app they already had, not with
none. `make install-app` uses the same transaction, so a developer install cannot destroy a
working app either. On an account that cannot write `/Applications`, this transaction is the only
command run with administrator authorization, and it is restricted to that exact product bundle.
The updater source clone and state files remain owned by the signed-in account.

## The disk image is an unmanaged artifact

`make app` produces `release/Mission Control-<version>-arm64.dmg`. Its contents are stated in
[`electron-builder.yml`](../electron-builder.yml) rather than defaulted: the application and a
checked-in offline Read Me ([`build/dmg/readme.txt`](../build/dmg/readme.txt), which mounts as `Read Me.txt`), and no
`/Applications` alias. electron-builder's default layout supplies that alias, and it is wrong
here twice over - it points every recipient at the destination that needs an administrator
password, and a disk image is opened on somebody else's Mac, where no fixed link can name their
own Applications folder and nothing expands a literal `~`.

Dragging the app out of a disk image records no receipt, so that copy never updates itself. The
Read Me says so, names both destinations in words, and gives `make install` as the way to get
managed updates.

## Updates from the installed app

A managed app checks the canonical repository's stable GitHub Releases through the already
authenticated `gh` CLI. When a newer version is available, the dashboard shows a full-width banner
with the version, a shortened plain-text release summary, and **Update Now** and **Later** controls.
Deferring hides the banner until the next scheduled check or launch. The banner is part of the
Electron-only preload capability: the plain browser dashboard has no update bridge, renders no
update banner, and starts no update check.

Stable discovery selects the newest complete eligible release within a bounded canonical
inventory. A ready manifest must name both published ZIP and DMG assets with the expected IDs,
names and byte counts. A release object alone is not readiness. The offer pins the manifest
digest, channel, tag, full commit and asset identity. Missing assets leave **Update Now** disabled
with **Check again**; retry refreshes discovery. No desktop path probes host Node/npm, creates a
source checkout, or falls back to compilation. Canonical schema-1 source receipts and schema-2
binary receipts both use this path. Forks and source development retain explicit source commands.

**Update Now** keeps the app open. A worker launched by the installed app's embedded Electron
runtime downloads the ZIP through native authenticated `gh`, with a 15-minute transport limit,
an exact byte limit and SHA-256 verification. Credentials and redirected URLs never enter the
renderer or a second HTTP client. The download bar reports measured bytes; archive and publisher
verification report their stage without an invented percentage. The worker has a 20-minute
preparation limit. **Cancel** stays in *cancelling* until the owned worker and its subprocess group
settle and partial staging is removed. Neither cancellation nor verification failure changes the
installed app or its receipt.

The bounded ZIP reader checks the entire namespace before writing files. It rejects traversal,
absolute paths, conflicting names and Unicode/case aliases, non-directory ancestors, escaping or
cyclic symlinks, encrypted/special entries, excessive entry counts and size bombs. It streams
files with CRC and expanded-size checks, preserves executable modes, and creates internal
framework links last. AppleDouble entries from the publisher's ZIP are validated and discarded;
they are never executed. The app's signed files and embedded code signatures remain subject to
Developer ID and notarization checks. Free-space checks reserve the downloaded archive and its
validated expanded size, then the shared transaction budgets measured replacement/recovery copies.

After extraction, the worker verifies the pinned Developer ID team, notarization, bundle ID,
arm64 executable, minimum macOS, signed build metadata and helper/receipt protocol. It produces
the existing staged install descriptor, including a full content digest. **Restart and Install**
is offered only after this succeeds. **Later** keeps an intact prepared candidate for reuse in the
current app session, including when that exact remote asset has expired. A changed channel or a
new accepted target retires unused staging. On a later attempt, abandoned downloads are reclaimed
only with dead process identities and no outstanding handoff/recovery obligation.

Choose **Check for Updates…** from the app menu or tray for the same offer and restart question.
The shell reveals the existing themed dashboard modal. A manual check during preparation reports
the current stage and measured download progress. The notice follows cancellation and completion
without turning its acknowledgement into installation consent. Progress is pushed through the existing
preload subscription to both notice and banner; no polling or second update store is added. Stable checks
retain the startup delay, six-hour cadence and long-sleep check. Missing `gh` or authentication
surfaces during background checks; transient network and rate-limit failures remain quiet.

At handoff the current installation is read atomically, the accepted bundle is revalidated, and
the existing independent helper must acknowledge ownership before the app requests shutdown.
Legacy system-to-personal relocation, **Keep system installation**, explicit scope, daemon
ownership and durable recovery remain with the shared transaction below. Before commitment,
failure restores the prior app and exact receipt. After commitment, recovery proceeds forward
without guessing database compatibility. The next startup displays the durable outcome and repair
guidance. Missing assets, unsupported protocols or OS versions never select a source fallback.

### Alpha updates

Enable **Settings → Setup → Application updates → Alpha updates** to follow signed binaries for unreleased commits
on `main`. The setting defaults off, persists across restarts and upgrades, and starts an
immediate background check when changed. Alpha then checks every five minutes with up to
30 seconds of jitter, including a check after waking if that interval has elapsed. Checks
recommend an upgrade when the main SHA differs from the running app's embedded SHA, even when
the version number is unchanged. Multiple commits between checks produce one offer for the
latest tip. An older installation without source metadata is offered the latest main build
once to establish its identity.

**Check for updates** in Settings and **Check for Updates…** in the menu or tray query the
selected channel immediately. An alpha offer names the commit, shows its message, and includes
news and notes for a newer stable release when available. Every alpha upgrade installs the
selected main commit. A release-news lookup failure does not block a main update, while a
main lookup failure never substitutes a stable release. After installing the current tip,
checking again reports that it is up to date.

The offer pins a full SHA from the canonical repository's `commits/main` endpoint. The exact `alpha-<full SHA>` publication must be complete; otherwise the offer says pending or
unavailable. Preparation and installation carry that SHA even if main advances while downloading. The
staged bundle and installed app must match it. The detached helper also compares source
identity during rollback, so two alpha builds with the same version remain distinguishable.

Turn alpha off to resume stable-release recommendations. This clears the old offer and checks
releases again; it does not reinstall or downgrade the running app. A newer numeric stable
version is required for the next stable offer. During a check, download, or pending installation,
the toggle is unavailable; finish, cancel, or defer the current update first.

The setting is owned by Electron in `update-preferences.json` beside the receipt and update log.
It uses the existing desktop IPC update channel and does not require SQLite or a daemon route.
The plain browser dashboard and older desktop bridges have no alpha setting.

### Where the work happens, and why it splits

Explicit source preparation remains in [`scripts/install-app.mjs`](../scripts/install-app.mjs),
including `--stage-only --progress`. It requires host Node, npm and source build tools. The desktop
controller does not call it. [`update-binary-worker.ts`](../src/main/update-binary-worker.ts) owns
binary preparation in the installed runtime; the Bash bootstrap independently consumes a verified
DMG. Both reuse the shared staged transaction.

[`scripts/install-staged-app.mjs`](../scripts/install-staged-app.mjs) owns prepared-bundle
validation, destination policy, copying through the existing swap primitive, and receipt
publication for direct installs. Both the source installer and detached apply use it. An accepted
descriptor pins the receipt, bundle revision, full content digest and measured size. The final
copy is checked before publication on the ordinary swap path and again before launch. Hashing
includes modes, file bytes and internal framework symlinks; escaping links and oversized
inventories are refused. This also closes the old cross-filesystem isolation fallback's copy
race without consuming a developer's build output.

A direct reinstall restores its retained app if post-swap verification or receipt publication
fails, preserving the prior receipt bytes. Once the receipt commits, it reclaims that retained
app; a cleanup failure reports the remaining path without undoing the committed installation.

After restart acceptance, the app copies its **complete current app bundle**, including
frameworks, to a private attempt directory under `update-runtimes/` in the state home. It copies
the helper's full module inventory beside that runtime. The detached executable is the copy's
Electron with `ELECTRON_RUN_AS_NODE=1`, never a Node selected from PATH. A verified candidate can
supply the runtime to future bootstrap callers. Runtime, candidate, destination and recovery
backup are separate. Disk checks account for the runtime copy, old-app backup, new staging copy
and a possible rollback copy on each filesystem, without assuming copy-on-write.
If snapshot preparation fails before spawn, the lock holder removes the incomplete attempt it
created so the same transaction can retry. It never removes a pre-existing attempt this way.
The app marks itself as quitting before the quit request, so the hide-on-close guard closes
normally. The helper checks competing launchers and waits for all bundle executables to exit
before replacement, using the [launch safeguards below](#update-relaunch-safeguards).

The helper must acquire the existing receipt/update lock and acknowledge its nonce and process
identity before the app requests quit. Parent and target waits are bounded and use PID plus
start/command identity. GUI launches clear `ELECTRON_RUN_AS_NODE` and preserve the exact state
home. No helper opens SQLite or starts a second daemon.

Targets advertising `missionInstallTransaction` protocol 1 use the existing migration journal
and startup gate for in-place installation. Journal protocol 2 adds this mode; protocol-1
relocation journals and their append-only stages remain readable. Validation rejects a protocol
and transaction kind that disagree. The old receipt's exact bytes
and the installed bundle's identity are pinned at acceptance and checked again under the lock.
The target acknowledges its nonce, process, commit, bundle and state home before a daemon,
SQLite, session restore or agents start. Only then does the helper commit the receipt.

Before commitment, failure stops the exact target process and restores the prior bundle while
leaving the old receipt bytes intact. A restored in-place journal is archived with its backup
before relaunch, allowing an older app that understands only protocol 1 to start. After
commitment, recovery proceeds forward; it never guesses that an older app can read migrated
state. Unreadable receipts, changed destinations, failed outcome writes and unsuccessful recovery
retain material for inspection. A later launch recovering an interrupted in-place transaction
also uses an independent bundled helper before the launching app exits.

Snapshots stay on disk while their executable is mapped. A later update lock holder may remove
only a positively identified dead helper's completed snapshot with no pending journal obligation.
Unknown ownership and unfinished attempts are retained. A matching completed in-place journal
and committed receipt also permit reclamation of its verified recovery copy, after archiving
the journal. The journal records the swap's actual retained sibling and directory revision;
the same cleanup reclaims that exact sibling only when its revision and previous-app digest
still match. Older journals without this record remain readable and do not authorize guessing
which sibling to remove. Failed recovery material and old source support are not deleted by this cleanup.

Older source targets without the new transaction reader retain the compatible apply/rollback
behavior, but a staged handoff still uses the copied runtime and shared staged installer. The
handoff carries the accepted content digest, which the helper checks before installing even if
the candidate's root revision and package identity have not changed. Older handoffs without this
field remain readable. An old
source installer without staging support retains its explicit source-build fallback and host
prerequisites. Binary descriptors never take this fallback. Binary bootstrap and enrollment call this
shared transaction layer; they do not add another bundle-swap or receipt implementation.

The legacy source fallback also preserves its backup if a live process prevents safe rollback.
It retains the failed attempt in `failed-update/`; if retention cannot be written, its temporary
backup is kept instead. A subsequent legacy attempt clears the previous retained failure.

The result is stored in the versioned `update-outcome.json` marker. On the next launch, the
update modal and dashboard banner report a safe success or failure summary; a failure is
therefore visible without opening the local log. **Retry** runs a fresh check, while **Dismiss**
hides that result until update state changes. Success and failure outcomes are retired from disk
only after an actual operator answer. Renderer delivery is logged but never clears an outcome:
if the renderer hangs afterward, the notice returns on relaunch. Outcomes remain on disk across
renderer loss or a missing dashboard host. A newly launched
app waits asynchronously for its live helper to finish before interpreting the pending outcome,
including retries and rollback that take longer than 90 seconds. The dashboard stays usable
while this wait continues. Persistent lock-inspection errors are logged and the saved outcome
is read instead of silently abandoning it. Diagnostic output
from the build remains in the rotating
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
detached helper is copied out of the bundle with the dependencies in
`scripts/update-helper-files.mjs`; `test/update-log.test.ts` pins the two to identical output so the copy cannot
drift.

This updates only the packaged application and its updater-owned clone. A separately installed
daemon LaunchAgent still runs from the repository path recorded in its plist and is not changed by
an application update.

## Update relaunch safeguards

The app checks launch ownership before handing off an update. The detached helper checks again
under the existing helper lock before waiting for shutdown and immediately before installing.
`scripts/mac-app-lifecycle.mjs` owns the same read-only macOS inspection for both processes:

- Enumerate `launchctl list`, then inspect each job in `gui/<uid>` with `launchctl print`.
  Inspect its program and argument block, including shell wrappers that execute this bundle's
  `Contents/MacOS` binary. Resolve symlinked executable paths, including quoted or escaped paths
  inside shell commands, even for dormant jobs with no PID. Inspection never executes shell code.
  Executable positions are inspected, so an app path passed as ordinary data to a fixed executable
  does not block an update. Follow `nice` past its optional priority argument and `arch` past
  its architecture and environment options to the utility they execute. The utility's ordinary
  data arguments are not treated as executables.
  Also inspect `open` jobs that launch this bundle through LaunchServices, including bundle
  paths, symlinks, file URLs, and `-a` or `-b` application selectors. Arguments after `--args`,
  environment and I/O options, Finder-only `-R` reveals, and file operands sent to another
  explicitly selected application do not count as launches of this bundle.
  The launchd `program` selects the executable when present; its first
  argument is only the process's display name. For a shell's `-c`, inspection accepts a single
  printed source line. Additional lines are refused because `launchctl print` does not distinguish
  multiline source from later positional arguments. This can conservatively block a benign shell
  job with positional arguments; inspection never assumes those lines are inert data.
  Shells that instead execute a script file or read commands from stdin are refused because their
  execution source is outside the inspected job. Inspection does not read or execute those scripts.
  A shell executable that depends on variable or command expansion, starts another shell, or uses
  the shell's `eval`, `.` or `source` builtins is conservatively treated as a conflict because this
  inspection cannot establish its target. This includes `command` and `builtin` wrappers.
  The same refusal applies to `env -S` (`--split-string`), which interprets a command string
  using its own splitting and expansion rules, including attached or clustered short options.
  Variables used only as arguments to a fixed executable do not trigger that rule. Environment
  values stay private.
  Command substitutions (`$(...)` and backticks) are refused even in arguments, assignments, or
  redirects because the shell executes them before the outer command. Single-quoted or escaped
  substitution text remains literal data, as does non-shell launchd argv.
  Do not copy job environments or command lines into logs.
- Exempt the runningboard-owned job only when its PID is registered for this exact bundle as a
  Foreground application. A label that merely resembles an application job is not sufficient.
- Compare main executables with `lsappinfo list`. Electron helpers need not have their own
  Foreground registration. Any unregistered main instance blocks the update.

A conflict names the job and the exact, quoted `launchctl bootout 'gui/<uid>/<label>'` command.
Mission Control never removes the job itself. Inspection errors fail closed. A packaged start
without its own registration logs the same diagnostic to `daemon.log`, displays it on the local
startup page and offers it through the existing update error modal once the dashboard is ready.
This is diagnostic only: detecting an unmanaged start does not kill it. Parent PID 1 alone is not
evidence, since ordinary LaunchServices launches also have launchd as their parent.

After the parent exits, the helper waits up to two minutes for **all** processes whose executable
is beneath the bundle, including orphan helpers and utility processes. After replacement it runs
`lsregister -f` using macOS's LaunchServices utility and waits up to 25 seconds for old bundle
instances to disappear from `lsappinfo list`. It then rechecks launch conflicts and calls `open`
on the exact bundle. It never directly executes the application binary or requests a new instance
with `open -n`.

An `open` exit status does not establish success. For up to 25 seconds per attempt, the helper
requires all of the following: the exact bundle and `com.mission-control.app` appear as a Foreground
application in LaunchServices; that PID is running rather than stopped, stuck in uninterruptible
launch, or a zombie; and Electron has written an acknowledgment bound to this attempt's nonce,
bundle, PID and process start identity after its main loop ran JavaScript in a loaded renderer.
The local startup page can acknowledge this even while the daemon is recovering. This proves launch
responsiveness, not that every SDK session or workflow has recovered.

An `open` failure or an unverified launch gets one retry, after stopping only a process carrying this attempt's nonce
and rechecking its executable and process identity before any signal. All bundle processes must
exit and old registrations must clear again. An unrelated process blocks retry and automatic
rollback; no stale PID or process-group number authorizes a signal. A second unverified launch
records a sanitized failure and follows the same guarded bundle/receipt rollback path. Success
is written only after verification. Backup retention, atomic bundle replacement and the helper
lock remain the owners of recovery. The personal-install migration path also uses LaunchServices
and checks registration alongside its existing nonce-bound pre-commit readiness acknowledgment.

`daemon.log` receives timestamped main-process entries for renderer `unresponsive` and
`render-process-gone` events, update dialog sends, renderer delivery, and actual answers. Dialog
entries carry kind and ID, not release notes or raw diagnostic payloads. Logging applies the
existing credential/path redaction and cannot prevent startup or an answer. No outcome notice is
auto-closed or suppressed as a relaunch remedy.

The replay policy requires an actual operator answer for both success and failure, including a
verified success already delivered to the renderer. Neither launch verification nor delivery
retires the saved outcome. The notice returns after a restart if the renderer hangs before the
operator can answer it.

These barriers prevent the observed competing-launcher update sequence and refuse to claim success
when the OS cannot launch the app. They cannot repair a system-wide LaunchServices fault, prevent an
administrator from introducing a new launcher after inspection, or guarantee that an already
launched app never becomes unresponsive. See [launch conflict recovery](troubleshooting.md#mission-control-is-not-open-anymore-or-an-update-relaunch-fails).

### Evidence behind this change

The October 13, 2026 incident had a successful bundle install and a separate unmanaged respawn job.
The exact event that first wedged LaunchServices remains unproven; concurrent launchers around
bundle replacement are a hypothesis, not an established macOS defect. Current host inspection
confirmed that normal Dock applications use Submitted launchd jobs owned by runningboard, so job
type alone cannot identify the fault. In the incident daemon log, `listening` precedes
`recovery_complete`. The latter is the workflow manager's recovery milestone, not renderer or
HTTP readiness. Current startup serves HTTP before background SDK restore completes. The roughly
100-second recovery interval and database size therefore do not establish the cause of the frozen
modal. No operator database was copied, mutated or benchmarked for this change.

The browser regression in `e2e/specs/update-relaunch.spec.ts` also runs against the exact
`e00afcc` helper for before/after evidence. It scripts the incident's competing launchd job,
unregistered window owner and stopped LaunchServices copy at the helper's injected OS boundary;
the helper, outcome file, main controller, presenter and browser modal remain real. The old
helper replaces the bundle and publishes success under those conditions; the guarded helper
refuses before replacement and displays the remediation. This is a deterministic reproduction
of the helper's unsafe sequence, not a claim to reproduce or explain macOS's system-wide wedge.

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

Explicit source installations select stable releases from a filtered list:

```sh
gh release list --repo <owner/name> --exclude-drafts --exclude-pre-releases   --order desc --limit 1 --json tagName
```

The binary installer and desktop updater additionally require a complete ready manifest and both
published assets. The desktop consumer bounds release and asset pagination, excludes drafts and
prereleases from stable selection, and checks the accepted tag against the manifest commit.

Tags created by the release workflow are pushed with the short-lived App installation token, so
they start a new `ci.yml` run. Its `package` job builds the macOS dmg, checks that the tag and
package versions agree, and uploads the dmg as a 90-day Actions artifact. This is a separate
release build check; the dmg is not attached to the GitHub Release. The package job can also be run
manually through `workflow_dispatch`.

The separate [signed distribution producer](release-verification.md) consumes successful
canonical push CI, publishes a signed/notarized ZIP and DMG under an immutable identity,
and uploads the ready manifest last. It also owns exact-SHA alpha prereleases. This path
pins the approved Apple team and remains gated on credential provisioning and real
signing/publication qualification. The desktop consumer uses only complete published identities;
publication never authorizes installation without the operator's update and restart decisions.

The historical [source release runbook](runbooks/release-verification.md) records clone-and-build
timings and failure signatures. The current [binary release verification](release-verification.md)
requires real signed old/new apps, detached replacement and recovery with host runtimes absent or
trapped. Browser and simulated publisher fixtures cannot qualify that signed journey.

See [Configuration and commands](configuration.md) for operating the app. Packaging and
build-surface rules are authoritative in the [Electron and build surfaces contract](agent-guides/change-contracts.md#electron-and-build-surfaces)
and [process-boundary guide](agent-guides/architecture.md#process-boundaries).


## Moving an existing system installation

Automatic relocation is enabled for eligible legacy managed system installations. A fresh
personal install defaults to `~/Applications/Agent Mission Control.app`.
The binary naming transition preserves the existing directory and scope; it takes precedence
over offering a new relocation. This section also describes recovery of existing protocol-1
relocation records. See [app-name migration](app-name-migration.md) for the current binary route.

An eligible legacy managed `/Applications` installation shows both locations before restart.
**Install and restart** accepts the update and move;
**Later**, Escape, and the backdrop change no installation policy. **Keep system installation**
records explicit system scope and continues in place. A failure to save that choice stops the
update. Explicit system/custom installations, untrusted receipts, unsupported target builds,
and an occupied personal destination do not relocate.

Older running helpers and builds with relocation disabled install enabled code in place first,
even when skipping a release.
The subsequent accepted update can move. The transition update may still need the existing
system-folder authorization; relocation and later personal updates need no elevation.
The same account's state home, database, tasks and sessions remain in place. The system app is
retained for other accounts and already-running agents; it is never deleted or replaced with a
home-directory symlink. Replace an old Dock shortcut with the personal app after completion.

### Recovery and existing integrations

Before the receipt commits, the target checks its packaged modules and native lock addon without
starting a daemon or agents. A failure stops the verified attempt-owned process, removes only
its owned target, and reopens the unchanged system app. Reopen the system app after an interrupted
pre-commit attempt to run recovery. Invalid records stop startup with a recovery message.
Launch intent is durable before spawning, and the target records its own process identity
before readiness checks. If neither process record is available after an interruption,
recovery preserves both bundles and refuses to relaunch the system app. Close the personal
app and reopen the system app after its launch record appears; if it never appears, inspect
the interrupted installation manually. A failed recovery records the original failure and
the recovery failure together when the state directory remains writable.

Receipt commitment is the recovery boundary. After that, open or reinstall the personal app;
Mission Control will not automatically start an older system runtime against potentially upgraded
state. A receipt renamed just before helper failure is recognized and completed forward. Stop an
old standalone daemon if the personal app reports that it still owns the runtime port.

**Personal installation committed; integrations need repair** means the bundle and receipt
are already at the personal location. **Retry integration repair** rechecks every surface,
including prior successes, and repairs unresolved owned entries without moving the app again. Only inventoried Mission-owned hook/MCP paths change. JSONC
comments, unrelated hooks, custom runtimes, environment settings, disabled registrations and
other MCP options are preserved. Custom configuration syntax and concurrent edits are left for
manual attention. Each edited file retains its original inode in a private sibling directory
named `<config>.mission-migration-<attempt nonce>`. Publication never replaces a file created
concurrently, and retries detect late edits to those originals. If a conflict is reported,
merge the preserved edit into the active configuration before removing that recovery directory
and retrying. After verifying the migration, those private recovery directories can be removed.
A custom CLI configuration home blocks automatic inventory so the CLI cannot
read one file while migration changes another. MCP paths are read back through the configured
harness adapter.
MCP inventory stores file identity and owned bundle path locations, with no credentials or
credential-derived hashes. Configuration adapters reread credentials from their existing owner
and preserve them there. Only the packaged MCP entry point and app executable count as owned
MCP paths; other arguments and environment values remain untouched. A file changed before its first repair requires manual reconciliation;
later retries verify the owned destination paths without overwriting custom values. Skills stay
with the daemon's existing enabled/disabled configuration and reconciler; resolve reported
conflicts in **Settings > Skills**. Login startup preserves its prior on/off setting and is
reported as pending when the platform cannot verify it. On macOS a nonce-bound cleanup launch
of the verified retained app removes its own login registration and exits before normal startup;
the personal app then restores the saved preference. It does not use Windows-only path/status
fields to claim macOS verification. Existing external sessions keep using
the retained satellites until new sessions are started.

### Transaction ownership and release verification

`scripts/install-migration.mjs` owns the versioned, private `install-migration.json` journal.
The detached helper holds `update-helper.lock.d` for preparation and the receipt commit.
The target writes a separate nonce/PID/start-identity acknowledgment and waits. Startup recovery
and post-start integration repair take the same lock after the helper releases it. Managed
installers share that lock, including unchanged legacy helper invocations. Successful repair
clears the private integration inventory; the next ordinary install retires the completed journal.

The receipt-deferred path uses the existing bundle-swap primitive in a private sibling directory,
then publishes its verified Contents into an exclusively reserved target. It does not add a
public installer flag. All detached dependencies are listed in
`scripts/update-helper-files.mjs`, copied with their relative layout, and checked by bundle smoke.

Packaged builds carry `missionInstallMigration.automatic: true` in `electron-builder.yml`.
Eligibility reads that flag from the installed source app and requires a supported migration
protocol in both source and target. Alpha mode selects the target commit; it does not override
the source's migration capability. Explicit system/custom scope continues to opt out.

The [Phase 2 packaged macOS exercise](plans/user-scoped-install/phase-2-automatic-update-migration.md#required-packaged-macos-exercise)
remains the regression checklist for legacy bootstrap, personal launch, login on/off across
restart, old Dock launch, pre-/post-commit interruption, integration retry, and later personal
update/rollback. A successful normal migration establishes only the paths actually exercised;
fixture and browser results do not establish the remaining operating-system behavior.

## Installed app name

New ZIP and DMG packages contain Agent Mission Control.app. The executable, bundle identifier
and state home retain their existing identities. See [app-name migration](app-name-migration.md)
for the source-update bridge, legacy/bootstrap compatibility, same-folder transaction and recovery.
