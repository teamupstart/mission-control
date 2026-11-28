import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  MARKER,
  ROOT_ENV,
  ROOT_PREFIX,
  listProcesses,
  ownerState,
  processesUnder,
  processStartedAt,
  pruneStaleFiles,
  reapProcessesUnder,
  releaseNpmCompileCache,
  sweepTempRoots,
  systemTempDir,
  tempDir,
  testTempRoot,
} from "./temp-root.mjs";

// The contract in docs/test-temp-dirs.md, pinned from the outside: each case builds its own
// stand-in for the machine temp dir inside this worker's root, so a regression here can only
// ever delete fixtures this file made.

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOUR = 60 * 60_000;
/**
 * Start a long-lived process whose command line begins with `path`, as a copied app bundle's
 * executable does. Node with `argv0` rather than a copied or linked system binary: macOS kills a
 * copied system binary on its signature, and a multicall coreutils `sleep` refuses to run under
 * any other name, so a linked one exits at once on such Linux hosts.
 */
function runFrom(path: string) {
  return spawn(process.execPath, ["-e", "setTimeout(() => {}, 600_000)"], { argv0: path, detached: true, stdio: "ignore" });
}

/** A pid that is certainly dead: a child that has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(child.status, 0);
  return child.pid;
}

/** A root as `installTempRoot` lays one out, with the marker fields given. */
function fakeRoot(tmp: string, marker: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmp, ROOT_PREFIX));
  writeFileSync(join(root, MARKER), JSON.stringify({ version: 1, kind: "fixture", host: hostname(), createdAt: Date.now() - 2 * HOUR, ...marker }));
  writeFileSync(join(root, "leftover.txt"), "fixture");
  const past = new Date(Date.now() - 2 * HOUR);
  utimesSync(join(root, MARKER), past, past);
  utimesSync(root, past, past);
  return root;
}

const sweep = (tmp: string, minAgeMs = HOUR) => sweepTempRoots({ tmp, minAgeMs });
const reason = (result: ReturnType<typeof sweep>, path: string) => result.kept.find((entry) => entry.path === path)?.reason;

test("this worker's temp dir, and its children's, is its private root", () => {
  const root = testTempRoot();
  // oxlint-disable-next-line repository/test-temp-dirs -- This case checks the redirect itself.
  assert.equal(tmpdir(), root);
  assert.equal(process.env[ROOT_ENV], root);
  assert.match(root, new RegExp(`/${ROOT_PREFIX}[A-Za-z0-9]{6}$`));
  assert.ok(existsSync(join(root, MARKER)), "the root carries its ownership marker");
  const marker = JSON.parse(readFileSync(join(root, MARKER), "utf8")) as { pid: number; startedAt: number };
  assert.equal(marker.pid, process.pid);
  assert.equal(marker.startedAt, processStartedAt());
  assert.ok(root.startsWith(systemTempDir()), `${root} is not inside the machine temp dir ${systemTempDir()}`);

  // A plain child inherits the environment and makes its temp dir with a bare mkdtemp, as a
  // daemon under test does.
  const child = spawnSync(
    process.execPath,
    ["-e", 'const fs = require("node:fs"), os = require("node:os"), path = require("node:path"); process.stdout.write(fs.mkdtempSync(path.join(os.tmpdir(), "child-fixture-")));'],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.ok(child.stdout.startsWith(root + "/"), `the child's temp dir ${child.stdout} escaped ${root}`);
  assert.ok(tempDir("helper-fixture-").startsWith(root + "/"));
});

test("a live owner is never swept", () => {
  const tmp = tempDir("sweep-live-");
  const root = fakeRoot(tmp, { pid: process.pid, startedAt: processStartedAt() });
  const result = sweep(tmp, 0);
  assert.deepEqual(result.removed, []);
  assert.equal(reason(result, root), "owner is alive");
  assert.ok(existsSync(join(root, "leftover.txt")));
});

test("a dead owner's root is swept", () => {
  const tmp = tempDir("sweep-dead-");
  const root = fakeRoot(tmp, { pid: deadPid(), startedAt: Date.now() - 3 * HOUR });
  assert.deepEqual(sweep(tmp).removed, [root]);
  assert.equal(existsSync(root), false);
});

test("a reused pid does not keep a dead owner's root alive", () => {
  // This process is alive, but it did not start an hour before it actually did: whoever wrote
  // this marker is gone and its pid now belongs to something else.
  const tmp = tempDir("sweep-reused-");
  const root = fakeRoot(tmp, { pid: process.pid, startedAt: processStartedAt() - HOUR });
  assert.equal(ownerState({ pid: process.pid, startedAt: processStartedAt() - HOUR }, listProcesses()), "dead");
  assert.equal(ownerState({ pid: process.pid, startedAt: processStartedAt() }, listProcesses()), "alive");
  assert.deepEqual(sweep(tmp).removed, [root]);
});

test("a root with no marker, an unreadable marker, or a marker from another host is left alone", () => {
  const tmp = tempDir("sweep-unmarked-");
  const unmarked = mkdtempSync(join(tmp, ROOT_PREFIX));
  const linked = fakeRoot(tmp, { pid: deadPid(), startedAt: 1 });
  const realMarker = join(tmp, "real-marker.json");
  writeFileSync(realMarker, readFileSync(join(linked, MARKER)));
  rmSync(join(linked, MARKER));
  symlinkSync(realMarker, join(linked, MARKER));
  const garbled = fakeRoot(tmp, { pid: deadPid(), startedAt: 1 });
  writeFileSync(join(garbled, MARKER), "{not json");
  const remote = fakeRoot(tmp, { pid: deadPid(), startedAt: 1, host: "some-other-host.invalid" });

  const result = sweep(tmp, 0);
  assert.deepEqual(result.removed, []);
  assert.equal(reason(result, unmarked), "no marker");
  assert.equal(reason(result, linked), "marker is not a small regular file");
  assert.equal(reason(result, garbled), "marker is not JSON");
  assert.equal(reason(result, remote), "marker is from another host");
});

test("a symlink named like a root does not resolve to itself under the temp dir, and is left alone with its target", () => {
  const tmp = tempDir("sweep-symlink-");
  const elsewhere = tempDir("sweep-symlink-target-");
  const target = fakeRoot(elsewhere, { pid: deadPid(), startedAt: 1 });
  const link = join(tmp, `${ROOT_PREFIX}abcDEF`);
  symlinkSync(target, link);
  const result = sweep(tmp, 0);
  assert.deepEqual(result.removed, []);
  assert.equal(reason(result, link), "symlink");
  assert.ok(existsSync(join(target, "leftover.txt")), "the link's target was touched");
});

test("a temp dir reached through a symlink, as macOS's /var is, still sweeps its own roots", () => {
  // `$TMPDIR` on macOS is `/var/folders/...`, and `/var` is a link to `/private/var`. A root
  // resolves to itself under the temp dir's physical path, so the link above it is no reason
  // to keep it; only a link AT the root's own name is.
  const real = tempDir("sweep-resolve-");
  const root = fakeRoot(real, { pid: deadPid(), startedAt: 1 });
  const alias = join(tempDir("sweep-resolve-alias-"), "tmp");
  symlinkSync(real, alias);
  assert.deepEqual(sweep(alias).removed, [join(alias, root.split("/").at(-1)!)]);
  assert.equal(existsSync(root), false);
});

test("a dead owner's root younger than the threshold is kept until it ages", () => {
  const tmp = tempDir("sweep-young-");
  const root = fakeRoot(tmp, { pid: deadPid(), startedAt: 1, createdAt: Date.now() });
  const now = Date.now();
  utimesSync(root, new Date(now), new Date(now));
  const early = sweepTempRoots({ tmp, minAgeMs: HOUR, now });
  assert.equal(reason(early, root), "younger than the threshold");
  assert.ok(existsSync(root));
  const later = sweepTempRoots({ tmp, minAgeMs: HOUR, now: now + HOUR + 1_000 });
  assert.deepEqual(later.removed, [root]);
});

test("a sweep kills fixture processes still running from a dead root before removing it", async () => {
  const tmp = tempDir("sweep-orphan-");
  const root = fakeRoot(tmp, { pid: deadPid(), startedAt: 1 });
  // A process started from inside the root, as the Electron suite starts a copied app bundle,
  // detached so nothing but its path ties it to the tree.
  const orphan = runFrom(join(root, "bin", "sleeper"));
  orphan.unref();
  await waitFor(() => processesUnder([root]).some((entry) => entry.pid === orphan.pid));
  assert.deepEqual(sweep(tmp, 0).removed, [root]);
  assert.deepEqual(processesUnder([root]), []);
  await exited(orphan);
  assert.equal(orphan.signalCode, "SIGKILL");
});

test("reaping a fixture tree leaves no process running from it", async () => {
  const tree = tempDir("reap-fixture-");
  const children = [runFrom(join(tree, "fixture-app")), spawn(process.execPath, ["-e", "setTimeout(() => {}, 600_000)", join(tree, "named-only")], { detached: true, stdio: "ignore" })];
  for (const child of children) child.unref();
  await waitFor(() => processesUnder([tree], { anywhere: true }).length === 2);
  assert.equal(processesUnder([tree]).length, 1, "only the copied executable runs from the tree");
  assert.deepEqual(reapProcessesUnder([tree], { anywhere: true }), []);
  assert.deepEqual(processesUnder([tree], { anywhere: true }), []);
  for (const child of children) {
    await exited(child);
    assert.equal(child.signalCode, "SIGKILL");
  }
});

test("npm's startup compile cache is taken back only when this npm run created it", () => {
  // npm enables Node's compile cache before any script runs, creating
  // <tmp>/node-compile-cache. The sweep takes it back when it was born after the npm the sweep
  // runs under started; an older one is the operator's shared cache and stays.
  const tmp = tempDir("npm-cache-");
  const cache = join(tmp, "node-compile-cache");
  mkdirSync(join(cache, "v26"), { recursive: true });
  writeFileSync(join(cache, "v26", "entry"), "x");
  const born = statSync(cache).birthtimeMs;
  // This process, under a shell, under npm: the shape of `npm test` running a script.
  const tree = (npmStartedAt: number | null, npmArgs = "npm test") => [
    { pid: process.pid, ppid: 4_000_001, startedAt: Date.now(), args: "node scripts/sweep-test-temp.mjs" },
    { pid: 4_000_001, ppid: 4_000_002, startedAt: Date.now(), args: "sh -c node scripts/sweep-test-temp.mjs" },
    { pid: 4_000_002, ppid: 1, startedAt: npmStartedAt, args: npmArgs },
  ];

  assert.equal(releaseNpmCompileCache({ tmp, processes: tree(born + 5_000) }), false, "took a cache older than this npm run");
  assert.equal(releaseNpmCompileCache({ tmp, processes: tree(born - 5_000, "/bin/zsh -c make") }), false, "took a cache with no npm above it");
  assert.equal(releaseNpmCompileCache({ tmp, processes: tree(null) }), false, "took a cache when the npm start time is unknown");
  assert.equal(releaseNpmCompileCache({ tmp, processes: null }), false, "took a cache without a process table");
  assert.ok(existsSync(join(cache, "v26", "entry")));

  const linked = tempDir("npm-cache-link-");
  symlinkSync(cache, join(linked, "node-compile-cache"));
  assert.equal(releaseNpmCompileCache({ tmp: linked, processes: tree(born - 5_000) }), false, "followed a symlink");
  assert.ok(existsSync(join(cache, "v26", "entry")));

  assert.equal(releaseNpmCompileCache({ tmp, processes: tree(born - 5_000) }), true);
  assert.equal(existsSync(cache), false, "this npm run's cache survived");
});

test("only stale files leave a cache", () => {
  const cache = tempDir("prune-cache-");
  mkdirSync(join(cache, "ab"));
  writeFileSync(join(cache, "ab", "old.js"), "old");
  writeFileSync(join(cache, "fresh.js"), "fresh");
  const past = new Date(Date.now() - 10 * 24 * HOUR);
  utimesSync(join(cache, "ab", "old.js"), past, past);
  utimesSync(join(cache, "ab"), past, past);
  assert.deepEqual(pruneStaleFiles(cache, { maxAgeMs: 3 * 24 * HOUR, dryRun: true }), { bytes: 3, files: 1 });
  assert.ok(existsSync(join(cache, "ab", "old.js")), "a dry run deleted something");
  assert.deepEqual(pruneStaleFiles(cache, { maxAgeMs: 3 * 24 * HOUR }), { bytes: 3, files: 1 });
  assert.deepEqual(readdirSync(cache), ["fresh.js"]);
});

// ---- whole test processes -----------------------------------------------------

const FIXTURE_SPEC = `
import test from "node:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("holds its root", async () => {
  writeFileSync(process.env.REPORT, tmpdir());
  writeFileSync(join(tmpdir(), "fixture.txt"), "leaked unless removed");
  if (process.env.HOLD) await new Promise((resolve) => setTimeout(resolve, 60_000));
});
`;

/** Run a real `node --test` worker over a fixture spec, with `tmp` as its machine temp dir. */
function startWorker(tmp: string, hold: boolean) {
  const dir = tempDir("worker-spec-");
  const spec = join(dir, "fixture.test.mjs");
  writeFileSync(spec, FIXTURE_SPEC);
  const report = join(dir, "report.txt");
  const env: Record<string, string | undefined> = { ...process.env, TMPDIR: tmp, REPORT: report, HOLD: hold ? "1" : undefined };
  delete env.NODE_TEST_CONTEXT;
  delete env[ROOT_ENV];
  const child = spawn(process.execPath, ["--test", "--import", "./test/setup-state.mjs", spec], { cwd: REPO_ROOT, env, stdio: "ignore" });
  return { child, report };
}

/** Resolves when `child` has exited, including when it already had. */
function exited(child: ChildProcess): Promise<unknown> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once("exit", resolve));
}

async function waitFor(condition: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("a worker that finishes removes its root", async () => {
  const tmp = tempDir("worker-exit-");
  const { child, report } = startWorker(tmp, false);
  const status = await exited(child);
  assert.equal(status, 0);
  const root = readFileSync(report, "utf8");
  assert.ok(root.startsWith(join(tmp, ROOT_PREFIX)), root);
  assert.equal(existsSync(root), false, `${root} outlived its worker`);
  assert.deepEqual(readdirSync(tmp), []);
});

test("a worker stopped with SIGTERM removes its root", async () => {
  const tmp = tempDir("worker-term-");
  const { child, report } = startWorker(tmp, true);
  await waitFor(() => existsSync(report));
  const root = readFileSync(report, "utf8");
  const marker = JSON.parse(readFileSync(join(root, MARKER), "utf8")) as { pid: number };
  process.kill(marker.pid, "SIGTERM");
  await waitFor(() => !existsSync(root));
  child.kill("SIGKILL");
  await exited(child);
});

test("a run killed with SIGKILL leaves a root the next sweep removes", async () => {
  const tmp = tempDir("worker-kill-");
  const { child, report } = startWorker(tmp, true);
  await waitFor(() => existsSync(report));
  const root = readFileSync(report, "utf8");
  const marker = JSON.parse(readFileSync(join(root, MARKER), "utf8")) as { pid: number };

  // While it runs, a concurrent run's sweep must leave it alone.
  assert.equal(reason(sweep(tmp, 0), root), "owner is alive");

  // kill -9 on the worker and its runner: no handler of any kind runs.
  process.kill(marker.pid, "SIGKILL");
  child.kill("SIGKILL");
  await exited(child);
  await waitFor(() => {
    try {
      process.kill(marker.pid, 0);
      return false;
    } catch {
      return true;
    }
  });
  assert.ok(existsSync(join(root, "fixture.txt")), "SIGKILL ran cleanup, so this case proves nothing");

  assert.deepEqual(sweep(tmp, 0).removed, [root]);
  assert.deepEqual(readdirSync(tmp), []);
});
