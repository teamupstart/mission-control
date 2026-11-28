// One private temp root per test process, and the sweep that clears the roots of dead ones.
//
// Why this exists: fixture directories made with a bare `mkdtemp(join(tmpdir(), ...))` live in
// the user's temp dir until something removes them, and "something" was each caller. A file
// that forgot, a helper that left removal to its callers, a worker killed by a timeout or an
// aborted run: each left its directories behind, and on a machine running several suites a
// day that reached 124,400 entries and 50 GB. The operating system's own cleaner did not
// help - most of those entries were far older than its three-day threshold.
//
// So the owner is the process, not the caller. `installTempRoot` makes one directory per test
// process, stamps it with who owns it, points `TMPDIR` (and so `os.tmpdir()` here and in every
// child that inherits the environment) inside it, and removes it when the process
// exits. A process that cannot run its exit handler - SIGKILL, a crash, a power cut - leaves
// a root whose marker names a dead owner, and `sweepTempRoots` removes exactly those.
//
// The contract is stated once, in docs/test-temp-dirs.md. Plain `.mjs` with only Node
// built-ins, because `test/setup-state.mjs` imports it before any TypeScript loader exists,
// and `e2e/playwright.config.ts`, the npm scripts under `scripts/` and test files share it.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { hostname, tmpdir, userInfo } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The root's name is `ROOT_PREFIX` plus mkdtemp's six characters. Short on purpose: macOS
 * limits a Unix socket path to 104 bytes, its `$TMPDIR` already spends 49 of them, and every
 * fixture socket now sits one directory deeper.
 */
export const ROOT_PREFIX = "mctmp-";
const ROOT_NAME = /^mctmp-[A-Za-z0-9]{6}$/;

/** The ownership marker inside every root. */
export const MARKER = ".mission-test-root.json";

/** The root of the process that owns this environment; children inherit it. */
export const ROOT_ENV = "MISSION_TEST_TEMP_ROOT";

/** The temp dir as it was before any root redirected it; shared caches and leases live here. */
export const SYSTEM_TMP_ENV = "MISSION_TEST_SYSTEM_TMPDIR";

/** How old a dead owner's root must be before a sweep removes it. */
export const DEFAULT_SWEEP_MIN_AGE_MS = 30 * 60_000;

/**
 * Two readings of one process's start time agree within this window. `ps` prints whole
 * seconds and `performance.timeOrigin` is taken a little after exec, so they differ by up to
 * about a second for the same process; a reused pid differs by however long the machine ran
 * between the two processes.
 */
const START_TOLERANCE_MS = 3_000;

const ROOT_GLOBAL = "__missionControlTestTempRoot";

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

/** This process's start time, in epoch milliseconds. */
export function processStartedAt() {
  return Math.round(performance.timeOrigin);
}

function writeMarker(root, kind) {
  const marker = {
    version: 1,
    kind,
    pid: process.pid,
    startedAt: processStartedAt(),
    createdAt: Date.now(),
    host: hostname(),
    uid: currentUid() ?? null,
  };
  // Written beside its final name and renamed, so a sweep never reads half a marker.
  const partial = join(root, `${MARKER}.${process.pid}.partial`);
  writeFileSync(partial, JSON.stringify(marker) + "\n", { mode: 0o600 });
  renameSync(partial, join(root, MARKER));
  return marker;
}

/**
 * Caches that are meant to outlive one process, kept shared by linking them into each root.
 *
 * `tsx` names its transform cache `join(os.tmpdir(), "tsx-<uid>")` when it loads, which is
 * after the preload has moved `TMPDIR`. Without the link every worker would start with a cold
 * cache and compile the server graph again. The link points into this checkout's
 * `node_modules/.cache`, not the machine temp dir, so a run creates nothing in `os.tmpdir()`
 * and the cache goes away with the checkout. Removing the root unlinks the link and never
 * follows it.
 */
function sharedCacheNames() {
  const uid = currentUid();
  return [`tsx-${uid ?? userInfo().username}`];
}

const CHECKOUT_CACHE = fileURLToPath(new URL("../node_modules/.cache/", import.meta.url));

function linkSharedCaches(root) {
  for (const name of sharedCacheNames()) {
    try {
      const target = join(CHECKOUT_CACHE, name);
      mkdirSync(target, { recursive: true, mode: 0o700 });
      if (!lstatSync(target).isDirectory()) continue;
      symlinkSync(target, join(root, name), "dir");
    } catch {
      // No link means a private cache for this process: slower, never wrong.
    }
  }
}

/**
 * Remove `root` when this process ends.
 *
 * `exit` covers a normal finish and an uncaught throw. SIGINT, SIGTERM and SIGHUP do not
 * reach `exit` under their default disposition, so each gets a handler that removes the root
 * and then re-raises the signal, unless something else in the process already handles that
 * signal: then that handler decides how the process ends, and if it exits, `exit` runs.
 * SIGKILL runs nothing; the sweep exists for that case.
 */
function removeOnExit(root) {
  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 2 });
    } catch {
      // Something still holds it open; the next sweep finds a dead owner and finishes.
    }
  };
  process.on("exit", remove);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const onSignal = () => {
      if (process.listenerCount(signal) > 1) return;
      remove();
      process.removeListener(signal, onSignal);
      process.kill(process.pid, signal);
    };
    process.on(signal, onSignal);
  }
}

/**
 * Point this process and its children at `root`. `os.tmpdir()` reads `TMPDIR` on every call
 * on POSIX and `TEMP`/`TMP` on Windows, so setting them is the whole redirect. The spelling is
 * kept as given, not canonicalized: on macOS `$TMPDIR` is `/var/folders/...`, a symlink into
 * `/private/var/folders/...`, and tests that compare stored paths already canonicalize with
 * `realpathSync` - changing which spelling `tmpdir()` returns would change what they test.
 */
function redirect(root, systemTmp) {
  process.env[SYSTEM_TMP_ENV] ??= systemTmp;
  process.env[ROOT_ENV] = root;
  if (process.platform === "win32") {
    process.env.TEMP = root;
    process.env.TMP = root;
  } else {
    process.env.TMPDIR = root;
  }
}

/**
 * Make this process's private root under the current temp dir, redirect the temp dir into
 * it, and remove it on exit. Called once per process by `test/setup-state.mjs` (each
 * `node --test` worker) and by `e2e/playwright.config.ts` (the Playwright runner, whose
 * workers inherit it). A process that is already the child of a root owner gets a nested
 * root inside its parent's, which the parent's exit removes as well.
 */
export function installTempRoot({ kind }) {
  const existing = globalThis[ROOT_GLOBAL];
  if (typeof existing === "string") return existing;
  const parent = resolve(tmpdir());
  const systemTmp = process.env[SYSTEM_TMP_ENV] ?? parent;
  const root = mkdtempSync(join(parent, ROOT_PREFIX));
  writeMarker(root, kind);
  linkSharedCaches(root);
  removeOnExit(root);
  redirect(root, systemTmp);
  Object.defineProperty(globalThis, ROOT_GLOBAL, {
    value: root,
    writable: false,
    configurable: false,
    enumerable: false,
  });
  return root;
}

/**
 * The root this process's fixtures belong in.
 *
 * The frozen value from `installTempRoot` first, because a test is free to move `TMPDIR`
 * and the root must not move with it. Then an inherited root, for a child of a root owner
 * that loaded no preload of its own. Last, a root of this process's own, so a helper that runs
 * somewhere neither applies still never writes to the bare temp dir.
 */
export function testTempRoot() {
  const owned = globalThis[ROOT_GLOBAL];
  if (typeof owned === "string") return owned;
  const inherited = process.env[ROOT_ENV];
  if (inherited && existsSync(join(inherited, MARKER))) return inherited;
  return installTempRoot({ kind: "lazy" });
}

/**
 * A fresh directory for a fixture, inside this process's root. It is removed with the root
 * when the process exits; a caller that wants it gone sooner may still remove it.
 */
export function tempDir(prefix) {
  return mkdtempSync(join(testTempRoot(), prefix));
}

/** `tempDir`, returning a promise, for call sites written against `fs/promises.mkdtemp`. */
export function tempDirAsync(prefix) {
  return mkdtemp(join(testTempRoot(), prefix));
}

/**
 * The temp dir as it was before any root redirected it. Only for state that is deliberately
 * shared between processes and runs: a host-wide lease, a downloaded model cache.
 */
export function systemTempDir() {
  return process.env[SYSTEM_TMP_ENV] ?? tmpdir();
}

// ---- process table -----------------------------------------------------------

/**
 * Every process with its start time and command line, from one `ps`. `null` when `ps` is
 * unavailable or prints something unexpected, which callers treat as "cannot tell".
 */
export function listProcesses() {
  const result = spawnSync("ps", ["-A", "-ww", "-o", "pid=,ppid=,lstart=,args="], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  const processes = [];
  for (const line of result.stdout.split("\n")) {
    // pid, ppid, then lstart as five fields ("Fri Nov 27 10:00:00 2026"), then the command line.
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s*(.*)$/.exec(line);
    if (!match) continue;
    const startedAt = Date.parse(match[3]);
    processes.push({ pid: Number(match[1]), ppid: Number(match[2]), startedAt: Number.isNaN(startedAt) ? null : startedAt, args: match[4] });
  }
  return processes.length > 0 ? processes : null;
}

/**
 * Whether the process a marker names is still running: `"alive"`, `"dead"`, or `"unknown"`.
 *
 * Dead means provably dead: no process has that pid, or one does but it started at a
 * different time, so the pid was reused. A pid alone is not enough - pids recycle, and a root
 * whose owner's pid now belongs to a browser would otherwise be kept forever, or worse, a
 * live owner mistaken for a dead one.
 */
export function ownerState(marker, processes) {
  const { pid, startedAt } = marker;
  if (!Number.isInteger(pid) || pid <= 0 || typeof startedAt !== "number") return "unknown";
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") return "dead";
    if (error?.code !== "EPERM") return "unknown";
  }
  // Signalable: something has that pid. Whether it is the owner turns on its start time.
  const entry = processes?.find((candidate) => candidate.pid === pid);
  if (!entry || entry.startedAt === null) return "unknown";
  return Math.abs(entry.startedAt - startedAt) <= START_TOLERANCE_MS ? "alive" : "dead";
}

/**
 * Processes started from inside one of `roots`: fixture binaries, such as a copied Electron
 * app that LaunchServices launched and nothing else tracks. A command line counts when it
 * begins with either spelling of a root - the executable's own path, which may contain
 * spaces. With `anywhere`, a command line that names a root in any argument counts too, for a
 * test tearing down a tree it alone owns. This process and its parent never count.
 */
export function processesUnder(roots, { anywhere = false, processes = listProcesses() } = {}) {
  if (!processes) return [];
  const spellings = new Set();
  for (const root of roots) {
    spellings.add(resolve(root));
    try {
      spellings.add(realpathSync(root));
    } catch {
      // Already gone: the lexical spelling is what the command lines still show.
    }
  }
  const prefixes = [...spellings].map((root) => (root.endsWith(sep) ? root : root + sep));
  return processes.filter(
    (entry) =>
      entry.pid !== process.pid &&
      entry.pid !== process.ppid &&
      prefixes.some((prefix) => (anywhere ? entry.args.includes(prefix) : entry.args.startsWith(prefix))),
  );
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * SIGKILL every process `processesUnder` finds for `roots` and wait for them to go. Returns
 * the ones still listed after `timeoutMs`, so a caller can fail on a survivor.
 */
export function reapProcessesUnder(roots, { anywhere = false, timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let survivors = processesUnder(roots, { anywhere });
  for (const entry of survivors) {
    try {
      process.kill(entry.pid, "SIGKILL");
    } catch {
      // Already exited.
    }
  }
  while (survivors.length > 0 && Date.now() < deadline) {
    sleepSync(100);
    const listed = processesUnder(roots, { anywhere });
    survivors = survivors.filter((entry) => listed.some((other) => other.pid === entry.pid && other.startedAt === entry.startedAt));
  }
  return survivors;
}

// ---- sweep -------------------------------------------------------------------

function readMarker(root) {
  const path = join(root, MARKER);
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return { missing: true };
  }
  if (!stat.isFile() || stat.size > 4096) return { invalid: "marker is not a small regular file" };
  try {
    const marker = JSON.parse(readFileSync(path, "utf8"));
    if (!marker || typeof marker !== "object") return { invalid: "marker is not an object" };
    return { marker };
  } catch {
    return { invalid: "marker is not JSON" };
  }
}

/**
 * Remove the temp roots of test processes that are provably dead.
 *
 * Several suites overlap on purpose - two worktrees running `npm test` at once is normal - so
 * the only roots this touches are ones it can prove are abandoned. An entry is removed only
 * when all of these hold, and is kept, with the reason, otherwise:
 *
 * - its name is `ROOT_PREFIX` plus six mkdtemp characters;
 * - it is a real directory, not a symlink, and resolves to itself directly under `tmp`;
 * - it belongs to this user;
 * - it holds a regular-file marker written on this host;
 * - the owner the marker names is dead, by pid and start time;
 * - neither the marker nor the directory changed in the last `minAgeMs`.
 *
 * Fixture processes still running from a removable root (an orphaned app copy) are killed
 * first, so the directory is not deleted under them and they do not run on without it.
 */
export function sweepTempRoots({
  tmp = systemTempDir(),
  minAgeMs = DEFAULT_SWEEP_MIN_AGE_MS,
  now = Date.now(),
  dryRun = false,
  processes,
} = {}) {
  const removed = [];
  const kept = [];
  let names;
  let realTmp;
  try {
    realTmp = realpathSync(tmp);
    names = readdirSync(tmp);
  } catch {
    return { removed, kept };
  }
  const uid = currentUid();
  const host = hostname();
  let table = processes;
  for (const name of names) {
    if (!ROOT_NAME.test(name)) continue;
    const path = join(tmp, name);
    const keep = (reason) => kept.push({ path, reason });
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) { keep("symlink"); continue; }
    if (!stat.isDirectory()) { keep("not a directory"); continue; }
    let physical;
    try {
      physical = realpathSync(path);
    } catch {
      keep("does not resolve");
      continue;
    }
    if (physical !== join(realTmp, name)) { keep("does not resolve to itself under the temp dir"); continue; }
    if (uid !== undefined && stat.uid !== uid) { keep("owned by another user"); continue; }
    const read = readMarker(path);
    if (read.missing) { keep("no marker"); continue; }
    if (read.invalid) { keep(read.invalid); continue; }
    const { marker } = read;
    if (marker.host !== host) { keep("marker is from another host"); continue; }
    if (table === undefined) table = listProcesses();
    const state = ownerState(marker, table);
    if (state !== "dead") { keep(state === "alive" ? "owner is alive" : "owner state unknown"); continue; }
    const lastChange = Math.max(Number(marker.createdAt) || 0, stat.mtimeMs);
    if (now - lastChange < minAgeMs) { keep("younger than the threshold"); continue; }
    if (dryRun) { removed.push(path); continue; }
    reapProcessesUnder([path, physical], { timeoutMs: 5_000 });
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 2 });
      removed.push(path);
    } catch (error) {
      keep(`removal failed: ${error?.code ?? error}`);
    }
  }
  return { removed, kept };
}

const NPM_COMMAND = /^(?:\S*\/)?npm(?:-cli\.js)?(?:\s|$)|\/npm-cli\.js(?:\s|$)/;

/**
 * Take back the `node-compile-cache` that the npm running this process created in `tmp`.
 *
 * npm's CLI calls `module.enableCompileCache()` as its first act, which creates
 * `<os.tmpdir()>/node-compile-cache` before any script runs, so `npm test` would otherwise
 * leave that one entry behind even though nothing the tests do writes to the temp dir. Node
 * does not recreate the directory when it writes the cache out at exit, so removing it here
 * keeps it gone.
 *
 * Removed only when it can be shown to be this run's: a real directory owned by this user,
 * born no earlier than the start of an npm process this process runs under. A cache that was
 * already there, which the operator's other npm commands share, is left alone, and so is
 * anything when the process table or the birth time cannot be read. Returns whether it removed
 * the directory.
 */
export function releaseNpmCompileCache({ tmp = systemTempDir(), processes = listProcesses(), pid = process.pid } = {}) {
  const dir = join(tmp, "node-compile-cache");
  let stat;
  try {
    stat = lstatSync(dir);
  } catch {
    return false;
  }
  const uid = currentUid();
  if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid) || !(stat.birthtimeMs > 0)) return false;
  if (!processes) return false;
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  let earliestNpm = Infinity;
  const seen = new Set();
  for (let cursor = byPid.get(pid); cursor && !seen.has(cursor.pid); cursor = byPid.get(cursor.ppid)) {
    seen.add(cursor.pid);
    if (NPM_COMMAND.test(cursor.args) && cursor.startedAt !== null) earliestNpm = Math.min(earliestNpm, cursor.startedAt);
  }
  // `ps` prints start times truncated to the second, so the npm started at or after the time
  // shown, and a directory it created was born no earlier than that.
  if (!Number.isFinite(earliestNpm) || stat.birthtimeMs < earliestNpm) return false;
  try {
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete files under `dir` whose mtime is older than `maxAgeMs`, then any directory that
 * leaves empty. Only for caches whose entries are recreated on demand. Symlinks are removed as
 * links and never followed. Returns the bytes and files removed.
 */
export function pruneStaleFiles(dir, { maxAgeMs, now = Date.now(), dryRun = false } = {}) {
  let bytes = 0;
  let files = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      let stat;
      try {
        stat = lstatSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(path);
        if (!dryRun) {
          try {
            if (readdirSync(path).length === 0 && now - stat.mtimeMs >= maxAgeMs) rmdirSync(path);
          } catch {
            // Repopulated or vanished meanwhile.
          }
        }
        continue;
      }
      if (now - stat.mtimeMs < maxAgeMs) continue;
      bytes += stat.size;
      files += 1;
      if (!dryRun) rmSync(path, { force: true });
    }
  };
  walk(dir);
  return { bytes, files };
}
