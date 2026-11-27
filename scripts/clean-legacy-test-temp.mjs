#!/usr/bin/env node
// Clear fixture directories that test runs leaked into the temp dir before test temp roots
// existed (docs/test-temp-dirs.md). Opt-in, and a dry run unless `--delete` is given.
//
//   npm run test:clean-legacy-temp                 # print what would go, and its size
//   npm run test:clean-legacy-temp -- --delete     # then remove it
//   npm run test:clean-legacy-temp -- --list       # print every path, not just the totals
//   --tmp DIR (repeatable) scans DIR instead of the machine temp dir; --source DIR (repeatable)
//   reads the literals from DIR instead of test/, e2e/ and scripts/, for testing the selection.
//
// What counts as a leaked fixture is deliberately narrow:
//
// - its name is exactly a string literal from test/, e2e/ or scripts/ that ends in `-`, `_`
//   or `.`, plus mkdtemp's six-character suffix, and it is a directory owned by this user;
// - nothing in its top two directory levels was modified in the last `--min-age-days` (3);
// - its name appears in no running process's command line, and `lsof` shows nothing open
//   inside it;
// - it is not agent state, an agent capability directory or a shared cache.
//
// Test temp roots (`mctmp-*`) are left to the sweep, which can prove their owner is dead,
// and run here with the same `--delete` switch. The Playwright transform cache and Node's
// compile cache lose only files older than the same threshold.

import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { pruneStaleFiles, ROOT_PREFIX, sweepTempRoots, systemTempDir } from "../test/temp-root.mjs";

const DAY_MS = 24 * 60 * 60_000;
const SUFFIX = /^[A-Za-z0-9]{6}$/;
const SOURCE_DIRS = ["test", "e2e", "scripts"];
const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]sx?|sh)$/;

/** Literals too generic to claim a directory on their own, whatever their suffix. */
const GENERIC = new Set(["tmp-", "temp-", "test-", "tests-", "dir-", "cache-", "build-", "out-", "data-", "file-", "home-", "repo-", "root-", "work-", "run-", "node-", "npm-", "git-"]);

/**
 * Never removed, whatever matches: agent state and capability directories, the e2e host
 * lease, and caches that other runs share.
 */
const PROTECTED = [
  /^mission-control-agent-/,
  /^mission-control-resumes/,
  /^mission-control-e2e-/,
  /^mission-electron-startup-/,
  /^mission-control-go-build-/,
  /^mission-voice-test-model/,
  /^tsx-/,
  /^node-compile-cache/,
  /^playwright-transform-cache/,
  /^claude-/,
  /^codex/,
  new RegExp(`^${ROOT_PREFIX}`),
];

const CACHES = [/^playwright-transform-cache(?:-\d+)?$/, /^node-compile-cache$/];

const { values } = parseArgs({
  options: {
    delete: { type: "boolean", default: false },
    list: { type: "boolean", default: false },
    "min-age-days": { type: "string", default: "3" },
    tmp: { type: "string", multiple: true },
    source: { type: "string", multiple: true },
  },
});

const minAgeMs = Number(values["min-age-days"]) * DAY_MS;
if (!Number.isFinite(minAgeMs) || minAgeMs <= 0) {
  console.error("clean-legacy-test-temp: --min-age-days must be a positive number");
  process.exit(2);
}
const now = Date.now();
const checkout = fileURLToPath(new URL("..", import.meta.url));
const temps = values.tmp?.length
  ? values.tmp.map((dir) => resolve(dir))
  : [systemTempDir(), ...(process.platform === "darwin" ? ["/private/tmp"] : [])];

function sourceLiterals() {
  const literals = new Set();
  const pattern = /(["'`])([A-Za-z][A-Za-z0-9._-]*[-_.])\1/g;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && SOURCE_EXTENSIONS.test(entry.name)) {
        for (const match of readFileSync(path, "utf8").matchAll(pattern)) {
          const literal = match[2];
          if (literal.length >= 5 && /[A-Za-z].*[A-Za-z].*[A-Za-z]/.test(literal) && !GENERIC.has(literal)) literals.add(literal);
        }
      }
    }
  };
  for (const dir of values.source?.length ? values.source.map((dir) => resolve(dir)) : SOURCE_DIRS.map((dir) => join(checkout, dir))) walk(dir);
  return literals;
}

function matchingLiteral(name, literals) {
  if (name.length <= 6) return null;
  const literal = name.slice(0, -6);
  return literals.has(literal) && SUFFIX.test(name.slice(-6)) ? literal : null;
}

/** The newest mtime in `path` and its top two directory levels; symlinks are not followed. */
function newestChange(path) {
  let newest = lstatSync(path).mtimeMs;
  const visit = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(dir, entry.name);
      try {
        newest = Math.max(newest, lstatSync(child).mtimeMs);
      } catch {
        continue;
      }
      if (depth < 2 && entry.isDirectory()) visit(child, depth + 1);
    }
  };
  visit(path, 1);
  return newest;
}

function treeBytes(path) {
  let bytes = 0;
  const stack = [path];
  while (stack.length > 0) {
    const current = stack.pop();
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      continue;
    }
    bytes += stat.size;
    if (stat.isDirectory()) {
      try {
        for (const name of readdirSync(current)) stack.push(join(current, name));
      } catch {
        // Unreadable: counted as its own entry only.
      }
    }
  }
  return bytes;
}

function commandLines() {
  const result = spawnSync("ps", ["-A", "-ww", "-o", "args="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`ps failed: ${result.stderr || result.error}`);
  return result.stdout;
}

/** Every path any process has open, from one `lsof`. */
function openPaths() {
  const result = spawnSync("lsof", ["-n", "-P", "-w", "-F", "n"], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  if (result.error || (result.status !== 0 && !result.stdout)) {
    throw new Error(`lsof failed (${result.error?.message ?? result.stderr}); refusing to guess which entries are in use`);
  }
  return result.stdout.split("\n").filter((line) => line.startsWith("n/")).map((line) => line.slice(1));
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
const literals = sourceLiterals();
const processText = commandLines();
const open = openPaths();
const mode = values.delete ? "removing" : "would remove";
let totalBytes = 0;
let totalEntries = 0;

for (const temp of temps) {
  let names;
  let spellings;
  try {
    names = readdirSync(temp);
    spellings = [...new Set([resolve(temp), realpathSync(temp)])];
  } catch {
    continue;
  }
  const inUse = new Set();
  for (const path of open) {
    for (const spelling of spellings) {
      if (path.startsWith(spelling + sep)) inUse.add(relative(spelling, path).split(sep)[0]);
    }
  }

  const groups = new Map();
  const skipped = { recent: 0, running: 0, open: 0, foreign: 0 };
  for (const name of names) {
    if (PROTECTED.some((pattern) => pattern.test(name))) continue;
    const literal = matchingLiteral(name, literals);
    if (!literal) continue;
    const path = join(temp, name);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    if (uid !== undefined && stat.uid !== uid) { skipped.foreign += 1; continue; }
    if (processText.includes(name)) { skipped.running += 1; continue; }
    if (inUse.has(name)) { skipped.open += 1; continue; }
    if (now - newestChange(path) < minAgeMs) { skipped.recent += 1; continue; }
    const bytes = treeBytes(path);
    const group = groups.get(literal) ?? { count: 0, bytes: 0, paths: [] };
    group.count += 1;
    group.bytes += bytes;
    group.paths.push(path);
    groups.set(literal, group);
  }

  const entries = [...groups.values()].reduce((sum, group) => sum + group.count, 0);
  const bytes = [...groups.values()].reduce((sum, group) => sum + group.bytes, 0);
  console.log(`\n${temp}: ${mode} ${entries} leaked fixture dir(s), ${formatBytes(bytes)}, across ${groups.size} prefix(es)`);
  console.log(`  kept: ${skipped.recent} changed in the last ${values["min-age-days"]} day(s), ${skipped.running} named by a running process, ${skipped.open} open in lsof, ${skipped.foreign} owned by another user`);
  for (const [literal, group] of [...groups].sort((a, b) => b[1].bytes - a[1].bytes)) {
    console.log(`  ${literal}XXXXXX  ${group.count} dir(s)  ${formatBytes(group.bytes)}`);
    if (values.list) for (const path of group.paths) console.log(`    ${path}`);
  }

  for (const name of names) {
    if (!CACHES.some((pattern) => pattern.test(name))) continue;
    const cache = join(temp, name);
    try {
      if (!lstatSync(cache).isDirectory()) continue;
    } catch {
      continue;
    }
    const stale = pruneStaleFiles(cache, { maxAgeMs: minAgeMs, now, dryRun: !values.delete });
    console.log(`  cache ${cache}: ${mode} ${stale.files} file(s) older than ${values["min-age-days"]} day(s), ${formatBytes(stale.bytes)}`);
    totalBytes += stale.bytes;
  }

  const roots = sweepTempRoots({ tmp: temp, dryRun: !values.delete });
  if (roots.removed.length > 0) console.log(`  test temp roots with a dead owner: ${mode} ${roots.removed.length}`);

  if (values.delete) {
    for (const group of groups.values()) {
      for (const path of group.paths) rmSync(path, { recursive: true, force: true, maxRetries: 2 });
    }
  }
  totalBytes += bytes;
  totalEntries += entries;
}

console.log(`\nTotal: ${mode} ${totalEntries} leaked fixture dir(s) and stale cache files, ${formatBytes(totalBytes)}.`);
if (!values.delete) console.log("Nothing was deleted. Run again with --delete to remove the entries above.");
