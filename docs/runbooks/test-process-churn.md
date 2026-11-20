# Test suite process churn

Endpoint security agents on developer Macs (CrowdStrike Falcon, Jamf Protect, Cyberhaven)
inspect every process exec and file write. Their CPU cost scales with how many short-lived
processes a workload starts, not with how heavy each one is, so a test suite that starts
tens of thousands of `git` processes drives them to several hundred percent CPU while it
runs. This runbook covers measuring that churn and keeping it down.

## Measuring

`test/spawn-trace.mjs` is an opt-in preload. With `MISSION_TEST_SPAWN_TRACE` pointing at
an empty directory, every test worker records its own start and one JSON line per process it
starts, with the test file and the first call site in this checkout - `test/...` for a
fixture, `src/...` for the code under test. It adds itself to `NODE_OPTIONS`, so node
processes a test starts (a spawned daemon, a script, a nested runner) are traced the same way.
Git's own trace2 stream counts every git process, including the ones git starts itself
(`git maintenance run --auto` after a commit, `upload-pack` behind a local clone), which an
in-process tracer cannot see.

The report's first line is a whole-run process total: test workers, every non-git process a
traced node process started (a shell-mode spawn counts once, as the shell), node processes a
non-node parent started, every git process, every xcrun shim exec in front of one, and every
shell git started. It is a lower bound. It cannot see what a non-node, non-git process starts
(a shell script's `ps` or `sed`), Electron's helper processes, or the test runner itself.
Counting those needs a kernel-level exec log such as `sudo eslogger exec`.

```sh
trace=$(mktemp -d)
mkdir "$trace/trace2"
GIT_TRACE2_EVENT="$trace/trace2" GIT_TRACE2_ENV_VARS=MISSION_TEST_SPAWN_TRACE_FILE \
MISSION_TEST_SPAWN_TRACE="$trace" \
  node --test --import ./test/setup-state.mjs --import ./test/spawn-trace.mjs --import tsx \
  'test/**/*.test.ts'
node scripts/test-spawn-report.mjs "$trace" --top 25
```

The report also ranks spawns by command, by test file, and by call site, and splits git
between test fixtures and the code under test. Compare git across runs by its trace2 count
(real git processes); the xcrun shim count is a separate, macOS-only figure. Name test files
instead of the glob to measure one suite.

The tracer records each spawn's executable, git subcommand and call site, never its arguments.
Git's trace2 files are git's own and do record git's full command lines, including any `-c`
values, so treat the trace directory as sensitive and delete it when the report is written.

Tracing adds its own overhead, so measure wall-clock time with an untraced run.

## Keeping it down

- **Build git fixtures with `test/helpers/git-fixture.ts`.** `seedGitRepo` and
  `seedGitHistory` build a seed once per worker and copy it for every later request, at one
  `git update-index --refresh` per copy instead of six or more processes per repository.
  `cachedGitTree` does the same for a whole world of repositories - bare origins, clones,
  linked worktrees - and re-roots the absolute paths git records in them. Use them for
  fixture setup; keep real git calls where what git does is the behavior under test.
- **Reset shared state per test, not per file.** The worktree manager observes every pool
  and slot in the database with several git reads each. A file that shares one database
  across tests and only clears it in `after` makes every test re-read every earlier test's
  slots - an n-squared cost. Clear it in `afterEach`.
- **Do not busy-poll a process with a spawn.** A loop that runs `ps` until a state changes
  starts hundreds of processes in a few hundred milliseconds. Pause between polls.
- **Leave the worker git environment alone.** `test/git-environment.mjs`, loaded by
  `test/setup-state.mjs`, does two things for every test worker. It sets
  `maintenance.auto=false` through `GIT_CONFIG_COUNT`, because every `git commit`, `merge`,
  `fetch`, `rebase` and `am` otherwise starts a second git process to consider maintenance a
  test repository never needs. And on a Mac whose `git` is Apple's `/usr/bin/git` xcrun
  shim, it puts the real developer-directory git first on `PATH` through a private prefix
  holding only `git`, so each git is one exec instead of two. A test that hands a child a
  hand-built `env` without `PATH` or the `GIT_CONFIG_*` variables only loses the saving.

The report's `of which started through Apple's xcrun shim` line counts gits whose recorded
`argv[0]` is the developer directory's own `git`, which is how a shim-started git appears;
after the bypass it should be close to zero.
