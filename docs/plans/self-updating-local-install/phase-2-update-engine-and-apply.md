# Phase 2: Update engine and apply helper

**Source plan:** [`plan.md`](plan.md) - **Index:** [`phased-plan.md`](phased-plan.md)
**Direct prerequisites:** Phase 1
**Merge unit:** one pull request in `mancej-cyc/ai-harness`

## Outcome

The installed app knows when a newer release exists and can install it. A user picks
**Check for Updates...** from the app menu or tray, is told what is available, accepts, and the app
rebuilds itself from that release tag and relaunches on the new version. If anything fails, the
previous working app is still there and the user is told why.

This phase is independently shippable and complete for a keyboard-and-menu user. It adds no renderer
code; the prompt is a native dialog, which is also the permanent path for when the window is hidden -
the state this app is designed to sit in.

This is the highest-risk phase in the plan. A process that outlives the app, rebuilds it, and replaces
its own bundle has failure modes that no other phase has.

## Entry criteria

- Phase 1 merged.
- A GitHub Release exists to compare against.
- The receipt module, the updater-owned clone, and the idempotent `--ref`-accepting install script are
  all available as Phase 1 shipped them.

## Scope

1. `src/shared/update.ts`: the browser-safe `UpdateSnapshot` union and a version comparison helper.
2. `src/main/updater.ts`: the controller. Scheduling, `gh` invocation, eligibility, state fanout,
   safe logging, handoff to the helper.
3. `scripts/apply-update.mjs`: the detached helper. Wait, back up, rebuild, verify, swap, relaunch,
   roll back, record the outcome.
4. `electron-builder.yml`: ship the helper in the bundle.
5. `src/main/menu.ts` and `src/main/tray.ts`: a **Check for Updates...** command in both.
6. `src/main/index.ts` and `src/main/lifecycle.ts`: wire the controller, and make the update quit
   ordering explicit and testable.
7. `docs/desktop-and-packaging.md`: how updates are checked and applied, the updater-owned clone's
   role, the outcome marker, and the LaunchAgent boundary from the source plan's known boundaries.
   Note in `docs/overview.md` that an installed app keeps itself current.
8. Unit tests for the controller and the outcome record; an Electron-layer test for the quit ordering.

### Non-goals

- No renderer, preload, IPC, or `mission-desktop.d.ts` change. Phase 3 owns all of that.
- No progress percentage. A rebuild has no meaningful byte progress and the app is not running for
  most of it.
- No percentage rollout, no prerelease channel. Prereleases and drafts are filtered out and ignored.
- No downgrade, ever.
- No signing or notarization.

## Repository findings

- `src/main/index.ts:56-69` registers all IPC in one `registerIpc()` with a flat `mission:` prefix.
  Phase 3 extends it; this phase only needs the controller constructed in `whenReady`.
- `src/main/index.ts:82-86` is the existing quit path:

  ```ts
  app.on("before-quit", () => {
    setQuitting(true);
    destroyTray();
    daemon?.stop();
  });
  ```

  and `src/main/window.ts:110-115` hides instead of closing unless `isQuitting()`. So an
  update-driven quit must set the flag before requesting the quit, exactly as the tray's
  `onQuit` already does at `src/main/index.ts:125-128`.
- `src/main/integrations.ts:89-93` already has `findSystemNode()` using `execFileSync(shell, ["-ilc",
  "command -v node"])`, and `src/main/path-env.ts:59-63` provides `loginShellPath()`. The updater
  needs both: `gh` must be found on a login-shell PATH, and the helper must run under a system node
  because the app's own Electron binary is being replaced.
- `src/main/daemon.ts:84-112` shows the `utilityProcess.fork` daemon and its `stop()`. The daemon is
  stopped by the existing `before-quit` handler, so the update path inherits clean shutdown for free.
- `src/server/task-sources/github-issues.ts:170-225` is the existing model for reading a `gh`
  subprocess result and turning a failure into an actionable message. Match its phrasing.
- `electron-builder.yml:30-46` is an explicit allowlist; `asar: false` at line 14 means a shipped
  script stays a plain readable file. `skills/**/*` and `personas/FOREMAN.md` are the precedent for
  shipping source files rather than bundling them.
- `test/electron-daemon-policy.test.ts` imports `src/main/daemon-policy.ts` directly and asserts
  behavior with no Electron process. That is the template for testing this phase's policy.

## Inherited contracts

From Phase 1, consumed and not changed:

- receipt path, schema 1, reader returning `null` when absent or malformed;
- `sourceClone` is a clean, updater-exclusive checkout;
- `installedVersion` equals the packaged `app.getVersion()`;
- `scripts/install-app.mjs` is idempotent, accepts `--ref`, and exits non-zero on failure.

## Implementation steps

### 1. Shared state union

`src/shared/update.ts`. Browser-safe: no `node:` imports, because Phase 3's renderer imports it.
Follow the tagged-union conventions in `src/shared/alerts.ts` and the const-tuple pattern in
`src/shared/open-targets.ts`.

| Phase | Renderer-visible data | Allowed actions |
|---|---|---|
| `disabled` | reason (not packaged, no receipt, no system node, arch mismatch) | none |
| `idle` | current version, last successful check time | check |
| `checking` | current version, whether manual | none |
| `up-to-date` | current version, check time | check |
| `available` | current version, new version, sanitized notes, published time | apply, defer |
| `applying` | new version, stage: `starting` or `handed-off` | none |
| `error` | safe message, manual or background origin, retryable flag | retry when manual |

The snapshot also carries `lastOutcome`: the result of the previous apply attempt, or `null`. This is
how a failed rebuild becomes visible at all, because the app that reports it is the old app relaunched
by the helper.

Never place artifact URLs, absolute paths, raw `gh` stderr, or exception stacks in the snapshot.

Add a version comparison helper here rather than taking a dependency. It must refuse to treat a lower
or equal version as an update, and must handle the `v` prefix on tags.

### 2. Controller

`src/main/updater.ts`, wrapping its outside world in an injected port so the state machine is testable
with no Electron, no network, and no subprocess:

```ts
interface UpdaterPort {
  currentVersion(): string;
  readReceipt(): Receipt | null;
  latestRelease(): Promise<ReleaseInfo | null>;   // gh
  systemNode(): string | null;
  spawnHelper(args: HelperArgs): void;
  now(): number;
  log(line: string): void;
}
```

Behavior:

- Run only when `app.isPackaged`. Otherwise publish `disabled` with the reason.
- Publish `disabled` when there is no receipt, when no system node can be found, or when the host is
  not arm64.
- Read the latest release with `gh release view --repo <slug> --json tagName,name,body,publishedAt,isDraft,isPrerelease`,
  invoked with a login-shell PATH. Ignore drafts and prereleases in v1.
- Compare against `app.getVersion()`. Equal or lower is `up-to-date`.
- At most one check and one apply in flight. A repeated action returns the live operation rather than
  starting a second.
- Check schedule: first background check 30 to 90 seconds after the window is ready, with jitter;
  then every 6 hours with up to 15 minutes of jitter; a manual check always allowed; one rate-limited
  check when the app becomes active after a long sleep.
- Background failures log and return to `idle` with no dialog. Manual failures publish `error` with an
  actionable message, reusing the `gh` phrasing from `github-issues.ts:224-225`.
- Sanitize release notes before they leave the main process: truncate, and strip anything that is not
  plain text.
- Log to a rotating file in the state dir. Redact absolute paths and any `Authorization` or token-like
  substring before writing.

The repository slug is a constant in v1, not a setting.

### 3. Apply handoff

When the user accepts:

1. Resolve the system node. If absent, publish `error` and stop.
2. Create a temp dir with `mkdtemp`.
3. **Copy `scripts/apply-update.mjs` out of the app bundle into that temp dir.** This is load-bearing:
   both the bundle and the clone are rewritten during the apply, so a helper running from either
   location would be replaced mid-run.
4. Spawn it detached and fully unparented, with stdio pointed at a log file, then `unref()` it:
   `spawn(node, [tempHelper, ...args], { detached: true, stdio: ["ignore", logFd, logFd] }).unref()`.
5. Publish `applying` with stage `handed-off`.
6. Call `setQuitting(true)` **before** `app.quit()`. Without this, `win.on("close")` hides the window
   and the quit never completes, so the helper waits forever on a process that will not exit.

Helper argv: the clone path, the target tag, the app path, the parent pid, the state dir, and the log
path. Keep it explicit so the helper is runnable by hand when debugging.

### 4. The helper

`scripts/apply-update.mjs`. Two hard constraints:

- **Zero imports except `node:` builtins.** It ships as a plain unbundled file, so it cannot import
  anything from `src/`.
- **It must never be the thing being replaced.** It only ever runs from the temp copy.

Sequence:

1. Record an `in-progress` outcome marker in the state dir immediately, so a machine that loses power
   mid-update is diagnosable.
2. Wait for the parent pid to exit, polling with a bounded timeout. If it never exits, abort and record
   the failure without touching anything.
3. Copy the existing app bundle aside as a backup inside the temp dir.
4. Run the clone's install script as a child process: `node <clone>/scripts/install-app.mjs --ref <tag>`.
   This deliberately reuses Phase 1 rather than duplicating build, verify, swap, and receipt logic.
5. On success, record a `success` outcome and relaunch with `open -a <appPath>`.
6. On any failure, restore the backup bundle, record a `failure` outcome carrying a short safe reason,
   and relaunch the restored app so the user is not left with nothing.
7. Remove the temp dir last, on both paths.

A note the implementer needs: Node loads a module's entire static graph before executing it, so the
install script running as a child is unaffected when the checkout it performs rewrites its own file on
disk. That safety depends on the install script using **static imports only**. It must not
`await import(...)` anything after the checkout step. State this in the install script's header
comment when this phase touches it.

### 5. Packaging

Add `scripts/apply-update.mjs` to the `files` allowlist in `electron-builder.yml`, with a comment
explaining that it must stay an unbundled plain file for the same reason `skills/` does, and that it
is copied out before use. `electron-builder.yml` is a controlled path; keep the change to this one
entry and do not touch targets, `asar`, or the signing keys.

### 6. Menu and tray

Add **Check for Updates...** below the `{ role: "about" }` item in `src/main/menu.ts` and to the tray
menu in `src/main/tray.ts`, extending the existing `AppMenuHandlers` and `TrayHandlers` objects rather
than reaching into the controller from those modules.

The native prompt is a `dialog.showMessageBox` presenting the new version and its notes, with Update
Now and Later. A manual check that finds nothing says so; a background check that finds nothing stays
silent.

### 7. Lifecycle

Put the ordering in a small named function next to the controller and export it, so the Electron-layer
test can assert the order without launching a GUI, in the style of
`test/electron-daemon-policy.test.ts`. The existing `before-quit` handler already stops the daemon and
destroys the tray; do not add a second eviction or shutdown path.

## Data and compatibility details

- The outcome marker is new state in the state directory, written by the helper and read by the app on
  next launch. Give it the same versioned-schema treatment as the receipt, and have the reader decline
  an unknown higher schema rather than guess.
- The app clears the outcome marker once it has surfaced it, so a stale failure does not reappear
  forever.
- No SQLite schema change and no migration. The database lives outside the bundle and must reopen
  untouched; assert that in the manual acceptance run.
- No persisted append-only ID is added or reordered.
- The receipt schema is not changed. `installedVersion` is rewritten by the install script during the
  apply, which is Phase 1 behavior already.

## Tests and verification

Pure unit tests against the injected port, in `test/`:

- every transition: disabled for each reason, idle, checking, up-to-date, available, applying, error;
- equal and lower remote versions are not offered; the `v` prefix is handled;
- drafts and prereleases are ignored;
- a second check while one is in flight returns the live operation and does not spawn a second;
- a second apply while one is in flight is refused;
- background failure logs and returns to idle; manual failure publishes an actionable `error`;
- missing `gh`, unauthenticated `gh`, and missing system node each produce their specific message;
- release notes are truncated and sanitized;
- the log redacts absolute paths and token-like substrings;
- `lastOutcome` is surfaced once and then cleared.

Electron-layer test, following the pure-policy style rather than launching a GUI:

- the update quit path sets the quitting flag **before** requesting the quit, so the hide-on-close
  guard at `src/main/window.ts:110-115` cannot trap it. This is the regression that would silently
  break updates, so it is asserted directly.

Outcome-marker round trip, including the unknown-higher-schema refusal.

Commands that must pass: `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:electron`,
`npm run build`, `npm run smoke`.

No UI surface changes yet, so no `e2e/` spec is required by this phase; the native dialog is not
reachable from Playwright. Say so explicitly in the pull request.

Manual acceptance to record on the pull request, both runs required:

1. **Success path.** Install N-1 through `make install`, publish release N, use Check for Updates,
   accept, and show the rebuild, the swap, the relaunch on N, daemon health, and the existing database
   reopening with prior state intact.
2. **Failure injection.** Deliberately break the build at the target tag, run the same flow, and show
   that the previous app is restored, relaunches, and reports the failure.

## Merge and exit criteria

- A packaged app finds a newer release through `gh` with no stored credential.
- Check for Updates works from both the app menu and the tray.
- Accepting rebuilds, swaps, and relaunches into the new version.
- A failed build or failed verification leaves the previous app in place and reports why.
- The quitting flag ordering is asserted by a test, not just by inspection.
- The updater is inert in development and when no receipt exists.
- The database reopens with prior state after an update.
- All gates above pass.

## Downstream handoff

Phase 3 may rely on:

- the `UpdateSnapshot` union in `src/shared/update.ts`, including `lastOutcome`;
- the controller exposing the current snapshot synchronously and emitting on change;
- the action set: check, apply, defer;
- the quit ordering already being correct, so Phase 3's Restart action does not need to re-solve it.

Phase 3 must not add networking, subprocess spawning, or filesystem writes on the renderer side of the
bridge, and must not widen the snapshot to carry paths, URLs, or raw error text.

## Cross-phase audit record

- **2026-08-18, authored.** Reconciled against Phase 1. Three reconciliations made: the apply step
  reuses Phase 1's install script instead of duplicating build and swap logic; the constraint that the
  install script use static imports only was pushed back into Phase 1's ownership as a header comment,
  because Phase 1 owns that file; and the helper was given zero non-builtin imports so that shipping
  it unbundled is safe. No change to Phase 1's receipt schema was needed, so Phase 1 required no edit.
- **2026-08-18, after Phase 3.** Confirmed Phase 3 consumes the union and the action set unchanged and
  adds no new state phase. Confirmed the native dialog and the banner coexist rather than one
  replacing the other. No change.
- **2026-08-18, final set audit.** Documentation had been scoped only into Phase 1, which would have
  left this phase's updater behavior undocumented and violated the source plan's definition of done.
  Added `docs/desktop-and-packaging.md` and `docs/overview.md` to this phase's scope, per the rule that
  documentation is implementation work in the phase that introduces the behavior.
