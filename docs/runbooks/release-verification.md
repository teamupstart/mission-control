# Release verification

How to prove, against a real GitHub Release, that someone can clone Mission Control, install it,
be offered an update, accept it, and come back running the new version - and that a failed update
leaves the previous app working.

This was first executed end to end on 2026-08-22 against `v1.0.0` and `v1.0.1`. Everything below
is what actually happened, not what was expected to.

Run it after any change to `scripts/install-app.mjs`, `scripts/apply-update.mjs`,
`src/main/updater.ts`, `release-please-config.json`, or the release workflow. The unit and e2e
suites cover those files against injected ports and a stubbed bridge; **no automated test exercises
the real `gh` call, the detached spawn, or the real clone-and-package build.** This procedure is
the only thing that does.

## What the mechanism actually is

Nothing is ever downloaded. The Release is used **only as a version oracle**: the app reads its
tag name, then rebuilds itself from source at that tag in a clone only the updater owns, and swaps
the resulting bundle into place. There is no dmg to fetch, no quarantine bit, and no Gatekeeper
step. See [desktop and packaging](../desktop-and-packaging.md) for the design.

The practical consequence is that **every update is a full `npm ci` plus Electron build on the
user's machine**, needing `git`, an authenticated `gh`, Xcode command line tools, and a system
Node on the login shell `PATH`.

## Prerequisites

- An Apple silicon Mac. The updater refuses Intel by design.
- `gh` authenticated, Xcode command line tools, and a system Node on the login shell `PATH`.
- Roughly 1-2 GB free for the updater-owned clone and its `release/` output.
- **Two stable releases must exist**, not one. `isNewerVersion` is strictly-newer only
  (`src/shared/update.ts`), so verifying an update needs the installed version *and* a successor.

Confirm the gate before starting anything else:

```sh
gh release list --repo teamupstart/mission-control --exclude-drafts --exclude-pre-releases
```

Empty output means the phase cannot begin. A stable release is created by merging the standing
release-please pull request on `main`; the tag and the Release follow from the next Release
workflow run, usually within a minute.

### Two prerequisites that will silently waste a run

**Quit any development Electron shell first.** `src/main/index.ts` takes
`app.requestSingleInstanceLock()`. A `make dev` / `make desktop` / `make start` shell already holds
it, so a packaged app launched while one is running **exits immediately and silently** - no window,
no error, empty stdout. It also means the updater's own post-update relaunch (`open <appPath>`) is
pre-empted: the update genuinely succeeded, but nothing comes back on screen. This is the single
most likely way to misread a good run as a broken one.

**Use `make install`, not `make install-app`.** `make app` and `make install-app` are the developer
path: they package the current worktree and write no receipt, so the updater is deliberately inert.
A verification run on one of those proves nothing.

## Isolating the run from live state

A managed install reads state from `~/.mission-control` and serves the dashboard on port 7317 - an
operator's real database and real daemon. To verify without touching either, give the run its own
state directory, port, and Electron user-data directory:

```sh
SB=~/phase4-sandbox
mkdir -p "$SB/state"
git clone git@github.com:teamupstart/mission-control.git "$SB/checkout"
cd "$SB/checkout"
MISSION_HOME="$SB/state" make install
```

Then launch the **binary directly** so the environment is inherited, never `open`:

```sh
MISSION_HOME="$SB/state" MISSION_PORT=7417 \
  "/Applications/Mission Control.app/Contents/MacOS/Mission Control" \
  --user-data-dir="$SB/electron-userdata" --remote-debugging-port=9333
```

`--user-data-dir` is what lets this instance coexist with any other; `--remote-debugging-port`
is what makes the banner inspectable without a human at the keyboard (see
[Driving it without a human](#driving-it-without-a-human)).

Two limits are worth stating plainly:

- **Leave the app in `/Applications`.** `--apps-dir` exists as a verification aid, but before the
  fix in this phase the updater rebuilt into `/Applications` regardless, while the backup, the
  rollback, and the relaunch all followed the receipt's `appPath`. An install made elsewhere would
  report an update as applied while the app that relaunched was still the old one. With the fix,
  `--apps-dir` is carried through; on any build predating it, do not rely on that.
- **`open` does not carry the environment.** The updater relaunches with `open <appPath>`, which
  goes through LaunchServices, so a `MISSION_HOME` set in your shell is *not* inherited by the
  relaunched app. Set it with `launchctl setenv MISSION_HOME "$SB/state"` for the duration of the
  run if you need the relaunch to land in the sandbox, and `launchctl unsetenv MISSION_HOME`
  afterwards.

## The procedure

### 1. Install from the published release

```sh
MISSION_HOME="$SB/state" make install
```

Step 4 of its output must name the tag, not the branch:

```
4. Target ref
   ✓ v1.0.0 (newest stable release)
```

`~/.mission-control/install-receipt.json` (or `$SB/state/install-receipt.json`) must record the
tag, the canonical repo, and a version matching the bundle:

```sh
cat "$SB/state/install-receipt.json"
/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" \
  "/Applications/Mission Control.app/Contents/Info.plist"
```

**Observed:** 51s for a fresh clone, `npm ci`, Vite build, `electron-builder`, swap and receipt, on
an M-series Mac with a warm npm cache.

### 2. Confirm the app reports itself current

Launch it and read the snapshot. `phase` must be `up-to-date` with a non-null `checkedAt` - a
`checkedAt` proves a real `gh` call happened rather than the check silently never running.

A `phase: "disabled"` here means one of the five gates rejected the run; the `reason` says which.

### 3. Publish a second release

Merge the standing release-please pull request. Confirm both releases are listed and that the new
one is `Latest`.

> The one-time `release-as` pin used for `v1.0.0` must be absent from `release-please-config.json`,
> or release-please proposes `1.0.0` forever and no second release can be cut at all. This is the
> defect this phase found; see [desktop and packaging](../desktop-and-packaging.md).

### 4. Verify the manual path

**Check for Updates…** from the application menu, and again from the tray. Both call the same
seam. Confirm the native dialog offers **Update Now** and **Later**, and that **Later** dismisses
it without applying.

This step needs a real click. The dialog is a native `dialog.showMessageBox`, not DOM, so it is
unreachable from the remote debugging port, and driving the menu with `osascript` requires
Accessibility permission for the calling process.

### 5. Verify the background path

Restart the app and wait out the first check - 30s plus up to 60s of jitter - without touching
anything. The banner must appear, and **no dialog may open**. A background check that finds an
update only publishes the snapshot; the banner is its sole surface.

Confirm **Later** hides the banner. The snapshot returns to `idle`, which is intended: deferring
hides it until the next scheduled check or launch, not forever.

### 6. Apply the update

Click **Update Now**. The app quits, a detached helper waits for it to exit, rebuilds at the new
tag, swaps, and relaunches. Then confirm all four:

```sh
cat "$SB/state/update-outcome.json"          # result: success, targetVersion: <new>
cat "$SB/state/install-receipt.json"          # releaseTag and installedVersion rewritten
/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" \
  "/Applications/Mission Control.app/Contents/Info.plist"
git -C "$SB/state/app-src" describe --tags --exact-match
```

**Observed:** 70s from click to `result: "success"`. The helper allows 45 minutes
(`INSTALL_TIMEOUT_MS`) because a cold npm cache is far slower; treat a minute as the floor, not the
expectation.

### 7. Verify the negative path

Force a realistic build failure in the updater-owned clone. An unreachable registry is the
cleanest, because `.npmrc` is untracked and so survives the `git checkout --force` the install does:

```sh
printf 'registry=http://127.0.0.1:1/\nfetch-retries=0\n' > "$SB/state/app-src/.npmrc"
```

Apply an update and confirm every one of these:

- `update-outcome.json` records `result: "failure"` with a message naming the build.
- `/Applications/Mission Control.app` is back at the **previous** version and launches.
- `install-receipt.json` is restored to the previous tag - not left pointing at the target.
- `failed-update/` in the state directory retains `previous-app.bundle`, `previous-receipt.json`
  and `failed-app.bundle`.
- On next launch the snapshot's `lastOutcome` carries the failure, and the app shows it once.

Then `rm "$SB/state/app-src/.npmrc"`, apply again, and confirm it now succeeds and that the
success **clears** `failed-update/`.

### 8. Verify the disabled paths report accurately

Point a packaged app at a state directory with no receipt, and at one whose receipt names a
non-canonical repo:

| Condition | Expected `phase: "disabled"` reason |
| --- | --- |
| No receipt | `This app was not installed with the managed install command.` |
| Receipt names another repo | `Updates are disabled because this app was installed from <repo>.` |

The other three gates - unpackaged, non-arm64, no system Node - are refused the same way.

## Driving it without a human

Launch with `--remote-debugging-port=<port>`, then evaluate against the page target. The update
bridge is the real one, so this reads real state rather than a fixture:

```js
window.missionDesktop.updates.getState()   // the live snapshot
window.missionDesktop.updates.check()      // same code path as a background check, no dialog
```

The banner's **Update Now** and **Later** are ordinary DOM buttons and can be clicked this way, and
`Page.captureScreenshot` gives a clean image of the window without needing focus.

What this cannot reach: the native dialogs, the application menu, and the tray. `updates.check()`
is *not* the manual path - `mission:update-check` calls `check(true)` only, while the menu item
calls `checkForUpdates()`, which is what drives the dialogs. Step 4 is a genuine human step.

Note that the CDP port must be free at launch; a just-killed previous instance can still hold it,
and Electron logs `bind() failed: Address already in use` and starts with **no** debugging port
rather than failing outright.

## Failure signatures

| What you see | What it means |
| --- | --- |
| App exits instantly, no window, empty stdout | A development Electron shell holds the single-instance lock. Quit it. |
| `phase: "disabled"` | One of the five gates. The `reason` names which. |
| `phase: "up-to-date"` forever, `checkedAt` non-null | Genuinely current, or no *stable* release exists. Check the gate query. |
| `up-to-date` with `checkedAt: null` | The check never ran. Look in `update.log`. |
| No second release ever proposed | The `release-as` pin is still in `release-please-config.json`. |
| Release log says `commit could not be parsed`, then considers zero commits | A pre-validation run received non-Conventional Commit subjects. Current workflows reject these as `release input rejected`; rename the pull request with `type(optional-scope): description` before merge. |
| Update reported success, app still old | An install made outside `/Applications` on a build predating the `--apps-dir` fix. |
| Relaunch never appears after a successful update | The single-instance lock again, or `open` landed in a different `MISSION_HOME`. |
| Checkout reports `unable to unlink old` | A historical `sudo make install` left unwritable directories in `app-src`. Run an installer containing the repair as the signed-in account. It replaces the disposable clone, then requests macOS administrator authorization only for the final `/Applications` swap. Do not run the whole command with `sudo`. |

`update.log` in the state directory is the diagnostic of record. It rotates at 1 MB and redacts
credentials and absolute paths, so expect `<path>` where a directory would be.

## Cleaning up

```sh
launchctl unsetenv MISSION_HOME; launchctl unsetenv MISSION_PORT
pkill -f "Applications/Mission Control.app"
rm -rf "$SB"
rm -rf "/Applications/Mission Control.app"   # only if it was not there before the run
```

Evidence produced by a run - screenshots, logs, receipts - is attached to the pull request and
never committed. `.evidence/` is gitignored for exactly this.
