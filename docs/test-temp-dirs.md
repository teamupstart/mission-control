# Test temp directories

This page is the contract for where test fixtures live on disk and how they are removed. The
preload that installs it, and the state isolation it sits beside, are described in
[AGENTS.md](../AGENTS.md#commands).

Before this contract, each test file created fixtures with `mkdtemp(join(tmpdir(), ...))` and
had to remove them itself. Files that forgot, shared helpers that left removal to callers, and
workers killed by a timeout or an aborted run all leaked. On one machine that ran several suites
a day, the user temp dir reached 124,400 entries and 50 GB. Do not rely on the operating system
to clear it: macOS's three-day cleaner left about 96,000 entries older than three days in place.

## One private root per test process

Each test process owns one directory, its **temp root**, directly under the machine temp dir:

- `npm test` and `npm run test:electron`: `test/setup-state.mjs` calls `installTempRoot` in
  every `node --test` worker before the test module loads.
- `npm run test:e2e`: `e2e/playwright.config.ts` calls it in the Playwright runner. Workers,
  browsers and fixture daemons inherit the runner's root.
- Any other process that calls `tempDir` without a root creates its own the first time.

The root is named `mctmp-` plus mkdtemp's six characters. The name is short because macOS
limits a Unix socket path to 104 bytes, and fixture sockets now sit one directory deeper. The
root holds `.mission-test-root.json`, its ownership marker: the owner's pid, the owner's start
time in epoch milliseconds, the host name, the uid and the creation time. A pid alone is not
proof of ownership because pids are reused.

`installTempRoot` then sets `TMPDIR` (`TEMP` and `TMP` on Windows) to the root, along with
`MISSION_TEST_TEMP_ROOT`, and records the original temp dir in `MISSION_TEST_SYSTEM_TMPDIR`.
On POSIX, `os.tmpdir()` reads `TMPDIR` on every call, so the process and every child that
inherits its environment create temp files inside the root. That includes daemons under test,
`git`, Playwright's artifact and browser profile directories, and Electron. The path keeps the
spelling the temp dir already had. On macOS, `$TMPDIR` is `/var/folders/...`, a symlink into
`/private/var/folders/...`. Tests that compare stored paths canonicalize with `realpathSync`,
as they did before.

The redirect cannot reach two kinds of process. macOS `mktemp` ignores `TMPDIR`. Apps started
through LaunchServices (`/usr/bin/open`) do not inherit the caller's environment. A test that
starts an app that way tears it down by path; see [Electron fixtures](#electron-fixtures).

A child that loads the preload itself, such as a `node --test` run started by a test, gets a
nested root inside its parent's. The parent's exit removes the nested root along with its own.

The `tsx` transform cache is meant to be shared between processes. Each root contains a
symlink, `tsx-<uid>`, pointing at `node_modules/.cache/tsx-<uid>` in the checkout, so workers
do not start cold and a run creates nothing in the machine temp dir. Removing the root removes
the symlink without following it.

npm's own CLI enables Node's module compile cache as its first act, before any script runs,
which creates `node-compile-cache` in the temp dir it was started with. The sweep that starts
`npm test`, `npm run test:electron`, `npm run test:e2e` and the nested `posttest` run takes that
directory back. It removes it only when it is a real directory owned by this user and born no
earlier than the start of the npm process the sweep runs under. A `node-compile-cache` that
was already there is the operator's shared cache and stays. Node does not recreate the
directory when it writes the cache at exit, so a run leaves nothing behind.

## Removal

The root is removed:

- on `exit`, which covers a normal finish and an uncaught exception;
- on SIGINT, SIGTERM or SIGHUP, which skip `exit` under their default handling. The handler
  removes the root and re-raises the signal. If another handler in the process already owns
  that signal, the root's handler steps aside, and `exit` removes the root if that handler
  exits.

SIGKILL, a native crash, or a power cut runs no handler and leaves the root behind. A native
crash includes a Node internal assertion, which calls `abort()`. The sweep removes the root.

The preload's fallback state dir, `mission-test-state-*`, is created inside the root and
removed with it. The guard in `src/server/state/isolation.ts` is unchanged. The preload
captures the machine temp dir as the temp root list before it moves `TMPDIR`, so "inside the
temp dir" still means inside the OS temp dir, and every worker root is inside it.
`test/db-isolation.test.ts` passes without changes to its refusals. Its bootstrap case now
asserts that a child's state dir is inside this worker's root.

## The sweep

`sweepTempRoots` runs before every `npm test` and `npm run test:electron` (from their `pre`
scripts), when the Playwright runner starts, and on demand:

```sh
npm run test:sweep-temp                       # remove roots whose owner died
npm run test:sweep-temp -- --dry-run --verbose  # show each decision and its reason
npm run test:sweep-temp -- --min-age-minutes 0
```

Several runs from different worktrees overlap on purpose, so the sweep removes only roots it
can prove are abandoned. It removes an entry only when all of these hold:

- its name is `mctmp-` plus six mkdtemp characters;
- it is a real directory, not a symlink, and it resolves to itself directly under the temp dir;
- it is owned by the current user;
- it holds a marker that is a regular file, is valid JSON and was written on this host;
- the owner is provably dead: no process has that pid, or the process with that pid started
  at a different time;
- neither the marker's creation time nor the directory's modification time is newer than the
  threshold. The threshold defaults to 30 minutes and can be set with `--min-age-minutes` or
  `MISSION_TEST_TEMP_SWEEP_MIN_AGE_MINUTES`.

The sweep keeps everything else and reports why. If `ps` cannot be run, a root whose pid is
still in use counts as unknown and is kept. Before it removes a root, it SIGKILLs any process whose
command line starts inside that root, such as an orphaned app copy.

## Writing tests

Create fixture directories with the helper, not with a bare `mkdtemp`:

```ts
import { tempDir } from "./temp-root.mjs";

const repo = tempDir("mission-example-repo-");
```

- `tempDir(prefix)` and `tempDirAsync(prefix)` create a directory inside this process's root.
  The directory is removed with the root. A test can still remove it earlier with `t.after`
  when it holds a lot of data.
- `testTempRoot()` returns the root itself. Use it for paths that must exist under the temp
  dir but must not be created, such as a missing file or a working directory.
- `systemTempDir()` returns the machine temp dir. Use it only for state that is shared between
  runs on purpose: the e2e host lease and the downloaded voice test model.

The git fixtures in `test/helpers/git-fixture.ts` (`mkOriginAndClone`, `mkCloneOnBranch`, and
the `cachedGitTree` templates) create their directories with `tempDir`, so callers no longer
need to remove them.

The Oxlint rule `repository/test-temp-dirs` rejects every `tmpdir()` and `os.tmpdir()` call
under `test/` and `e2e/`, except in `test/temp-root.mjs` and `test/setup-state.mjs`. A test
that checks the redirect itself, or a fake agent binary that must read the same path the
daemon writes, may suppress the rule on that line with
`// oxlint-disable-next-line repository/test-temp-dirs -- reason`.

## Electron fixtures

`test/detached-install-electron.test.ts` copies a complete Electron bundle for each case and
lets LaunchServices start the copy, its detached helper, and the relaunched target. Those
processes are not children of the test, and a failure before the handoff is read leaves their
pids unknown. Each case's `t.after` therefore calls `reapProcessesUnder([root], { anywhere:
true })`. That SIGKILLs every process whose command line names the case's tree. Teardown then
removes the tree and fails the case if any such process is still listed. A final test in the
file asserts that no process from any case's tree survived and that every tree is gone.
`test/temp-root.test.ts` covers reaping without a GUI.

## Electron GUI startup

Concurrent Electron GUI launches on macOS can hang before startup completes. The main thread
waits in a synchronous Mach message inside `ElectronMain` and never spawns a helper process.
Under load this failed most of the Electron geometry tests, while the same files launched one
at a time passed. Tests therefore serialize only that phase, through a host-wide startup slot
in `test/helpers/electron-startup-slot.mjs`:

- `execFileSync` launches use `electronGuiCommand(electron, args)` from
  `test/helpers/electron-gui.ts`. That runs Electron through `electron-gui-launch.mjs`, which
  passes output, exit status and a timeout's SIGTERM through.
- `spawn` launches call `acquireElectronStartupSlot()` before spawning and
  `releaseAfterStartup(child, release)` after.
- Playwright launches wrap `_electron.launch` in `withElectronStartupSlot`.

A launch gives the slot back once Electron has spawned its first helper, exits, or has held it
for 45 seconds, so fixture runs still overlap. The slot is the directory
`mission-electron-startup-<uid>.lock` in the machine temp dir. It exists only while a startup
holds it. A slot whose holder died is taken over rather than waited on.

## Playwright transform cache

Playwright compiles specs into `os.tmpdir()/playwright-transform-cache-<uid>` and never prunes
it. `npm run test:e2e` sets `PWTEST_CACHE_DIR` to `node_modules/.cache/playwright-transform`
in the checkout, unless it is already set. The cache then belongs to the worktree and is
removed with it. When the runner starts, it deletes cache files that have not been modified in
seven days. A bare `npx playwright test` still caches in the shared location for its runner
process, because Playwright reads the variable before it loads the config.

## Cleaning a machine that already leaked

Fixtures leaked before this contract existed carry no marker, so the sweep cannot prove they
are abandoned. `npm run test:clean-legacy-temp` is an opt-in cleaner for them. It runs as a dry
run by default:

```sh
npm run test:clean-legacy-temp                  # totals per prefix, and sizes
npm run test:clean-legacy-temp -- --list        # every path
npm run test:clean-legacy-temp -- --delete      # remove what was listed
```

An entry is selected only when all of these hold:

- its name is exactly a string literal from `test/`, `e2e/` or `scripts/` that ends in `-`,
  `_` or `.`, followed by mkdtemp's six characters. Generic literals such as `tmp-` are
  excluded;
- it is a directory owned by the current user;
- nothing in its top two directory levels was modified in the last three days
  (`--min-age-days`);
- its name appears in no running process's command line, and `lsof` shows nothing open
  inside it. If `lsof` cannot be run, the cleaner stops;
- it is not agent state, an agent capability directory, the e2e host lease, the voice model
  cache, or a shared cache.

The cleaner scans the machine temp dir and, on macOS, `/private/tmp`. It prints what it would
remove and the total size before deleting anything. In the Playwright transform cache and in
Node's `node-compile-cache` it removes only files older than the threshold. It also runs the
sweep for `mctmp-*` roots.
