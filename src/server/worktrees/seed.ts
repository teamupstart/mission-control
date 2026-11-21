import { spawn } from "node:child_process";
import type { Stats } from "node:fs";
import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join, matchesGlob } from "node:path";
import type { WorktreeClaimSeed } from "@shared/protocol.ts";
import { FIXED_OS_EXECUTABLES } from "../executables/catalog.ts";
import { run } from "../util/exec.ts";
import { killProcessGroup } from "./claim.ts";
import { trackOwnWorktreeProcess } from "./own-processes.ts";

// Seeding: a cold slot clones the pool's `seed.paths` copy-on-write from an idle sibling, so it
// inherits the sibling's installed dependency trees instead of paying a full install.
//
// Three rules hold everything here together:
//
//  - Copy-on-write or nothing. A filesystem that cannot clone gets no seed, never a byte copy:
//    a byte copy of a monorepo's `node_modules` is slower than the install it replaces.
//  - Only ignored paths. A seed path is placed, and an interrupted seed's paths are removed,
//    only where Git confirms the path is ignored and holds nothing tracked. A seed can
//    therefore never change what the final proof sees.
//  - Never a half tree. Each path is cloned into staging in the pool's directory, on the same
//    volume and outside the checkout, with exclusions removed there, and only then renamed into
//    place. A path in the checkout is the old tree, absent for one rename, or the whole new one.

/** Seed staging lives here, inside the pool's directory and outside every slot. */
export const SEED_STAGING_DIRECTORY = ".seed-staging";

/** Grace between SIGTERM and SIGKILL for a stopped clone. */
const CLONE_KILL_GRACE_MS = 2_000;
const MAX_REASON_BYTES = 1_024;

function boundedReason(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  return bytes.length <= MAX_REASON_BYTES ? value : bytes.subarray(0, MAX_REASON_BYTES).toString("utf8");
}

/**
 * The Stop and the claim's deadline a seed works within. Every phase of a seed's preparation
 * checks it between units of work and bounds its Git calls by what is left, so neither a Stop
 * nor the deadline waits on a large tree or a slow Git.
 */
export interface SeedBudget {
  signal: AbortSignal;
  deadline: number;
  now: () => number;
}

/** Thrown when a seed's Stop or deadline lands mid-preparation, and turned into its result. */
class SeedEnded extends Error {
  constructor(readonly ended: "stopped" | "timedOut") {
    super(`the dependency seed was ${ended === "stopped" ? "stopped" : "out of time"}`);
  }
}

function checkBudget(budget: SeedBudget | undefined): void {
  if (!budget) return;
  if (budget.signal.aborted) throw new SeedEnded("stopped");
  if (budget.now() >= budget.deadline) throw new SeedEnded("timedOut");
}

/** A Git call's limit: its own minute, or what is left of the claim's time if that is less. */
function gitTimeoutMs(budget: SeedBudget | undefined): number {
  return budget ? Math.max(1, Math.min(60_000, budget.deadline - budget.now())) : 60_000;
}

/** A checkout's Git administrative path, in any letter case: never a seed path. */
function gitAdministrative(name: string): boolean {
  return name.toLowerCase() === ".git";
}

/** One path a seed path glob matched, repository-relative, and whether it is a directory. */
export interface SeedEntry {
  path: string;
  directory: boolean;
}

/**
 * Expand seed path globs inside `root`, level by level. Each segment is a literal name or a
 * one-level `path.matchesGlob` pattern (the schema refuses `**`), so nothing is walked below
 * the depth a glob names. A wildcard does not match a name starting with a dot, as everywhere
 * `matchesGlob` is used. An intermediate segment must be a real directory: a symlink is never
 * followed out of the tree. A path inside another matched path is dropped, because cloning
 * the outer one already carries it. `.git` is never a seed path, in any
 * letter case and at any depth, whether named literally or matched by a pattern.
 */
export async function expandSeedPaths(
  root: string,
  globs: readonly string[],
  budget?: SeedBudget,
): Promise<SeedEntry[]> {
  const found = new Map<string, boolean>();
  for (const glob of globs) {
    const segments = glob.split("/");
    let level: string[] = [""];
    for (const [index, segment] of segments.entries()) {
      const last = index === segments.length - 1;
      const next: string[] = [];
      for (const parent of level) {
        checkBudget(budget);
        const names = (/[*?[{]/.test(segment)
          ? await childNames(join(root, parent)).then((all) => all.filter((name) => matchesGlob(name, segment)))
          : [segment]
        ).filter((name) => !gitAdministrative(name));
        for (const name of names) {
          const relative = parent ? `${parent}/${name}` : name;
          let stat;
          try {
            stat = await lstat(join(root, relative));
          } catch (error) {
            if (absent(error)) continue;
            throw error;
          }
          if (last) found.set(relative, stat.isDirectory());
          else if (stat.isDirectory()) next.push(relative);
        }
      }
      level = next;
      if (level.length === 0) break;
    }
  }
  const paths = [...found.keys()].sort();
  return paths
    .filter((path) => !paths.some((other) => other !== path && path.startsWith(`${other}/`)))
    .map((path) => ({ path, directory: found.get(path)! }));
}

/**
 * Whether a filesystem error means the path is genuinely not there. Anything else, a
 * permission or an I/O failure, means the tree could not be inspected, and a seed that cannot
 * see a path must never conclude it has none: the error propagates, so staging is abandoned and
 * an interrupted wipe fails, keeping its obligation.
 */
function absent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** How a seed looks a path up. Injected, so a test can fail one lookup the way a disk can. */
export type SeedLstat = (path: string) => Promise<Stats>;

/**
 * A path's stat, or null when it is genuinely not there. Any other failure throws: a path the
 * seed cannot inspect is never treated as missing, excluded or empty.
 */
async function presentStat(path: string, inspect: SeedLstat = lstat): Promise<Stats | null> {
  try {
    return await inspect(path);
  } catch (error) {
    if (absent(error)) return null;
    throw error;
  }
}

/** A directory's entries, sorted. Empty only when the directory genuinely does not exist. */
async function childNames(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).sort();
  } catch (error) {
    if (absent(error)) return [];
    throw error;
  }
}

async function git(root: string, args: string[], input: string | undefined, budget: SeedBudget | undefined) {
  checkBudget(budget);
  const result = await trackOwnWorktreeProcess((onSpawn) =>
    run("git", ["-C", root, ...args], {
      timeoutMs: gitTimeoutMs(budget),
      maxBuffer: 16 * 1024 * 1024,
      ...(input !== undefined ? { input } : {}),
      onSpawn,
    }),
  );
  // A call cut short by the claim's time is the deadline, never a Git refusal.
  checkBudget(budget);
  return result;
}

export type IgnoredProof = { ok: true } | { ok: false; reason: string };

/**
 * Whether Git confirms every entry is ignored in `root` and holds nothing tracked. A directory
 * is asked about with a trailing slash, which is how `check-ignore` applies a `dir/` pattern to
 * a path that does not exist yet. `check-ignore` already reports a tracked path as not ignored;
 * `ls-files` also catches a tracked file inside an ignored directory.
 */
export async function proveIgnored(
  root: string,
  entries: readonly SeedEntry[],
  budget?: SeedBudget,
): Promise<IgnoredProof> {
  if (entries.length === 0) return { ok: true };
  const tracked = await git(
    root,
    ["ls-files", "-z", "--cached", "--", ...entries.map((entry) => `:(literal)${entry.path}`)],
    undefined,
    budget,
  );
  if (tracked.code !== 0 || tracked.outcomeUnknown || tracked.overflowed) {
    return { ok: false, reason: `git ls-files failed: ${tracked.stderr.trim() || `exit ${tracked.code}`}` };
  }
  const trackedFiles = tracked.stdout.split("\0").filter(Boolean);
  const trackedEntry = entries.find((entry) =>
    trackedFiles.some((file) => file === entry.path || file.startsWith(`${entry.path}/`)));
  if (trackedEntry) return { ok: false, reason: `${trackedEntry.path} holds tracked files` };
  const asked = entries.map((entry) => (entry.directory ? `${entry.path}/` : entry.path));
  const ignored = await git(root, ["check-ignore", "-z", "--stdin"], `${asked.join("\0")}\0`, budget);
  // 0: some are ignored, 1: none are. Anything else is Git refusing to answer.
  if ((ignored.code !== 0 && ignored.code !== 1) || ignored.outcomeUnknown || ignored.overflowed) {
    return { ok: false, reason: `git check-ignore failed: ${ignored.stderr.trim() || `exit ${ignored.code}`}` };
  }
  const confirmed = new Set(ignored.stdout.split("\0").filter(Boolean));
  const notIgnored = entries.find((_, index) => !confirmed.has(asked[index]!));
  if (notIgnored) return { ok: false, reason: `${notIgnored.path} is not ignored by Git` };
  return { ok: true };
}

export type CloneResult =
  | { outcome: "cloned" }
  /** The filesystem or platform cannot clone. Never retried as a byte copy. */
  | { outcome: "failed"; reason: string }
  | { outcome: "stopped" | "timedOut" };

export interface CloneRequest {
  source: string;
  destination: string;
  signal: AbortSignal;
  timeoutMs: number;
}

/** Clones one path copy-on-write. Injected, so a test can refuse a clone like a plain disk. */
export type CloneTree = (request: CloneRequest) => Promise<CloneResult>;

/**
 * The `cp` argv that clones and only clones: `-c` is clonefile(2) on macOS. Null on any other
 * platform, which abandons the seed rather than copying bytes.
 */
export function copyOnWriteArgv(platform: NodeJS.Platform, source: string, destination: string): string[] | null {
  if (platform === "darwin") return ["-c", "-R", source, destination];
  return null;
}

/**
 * The production clone: the platform's own `/bin/cp` with its copy-on-write flag, in its own
 * process group. `cp` overrides the pinned path for a test's fake.
 */
export function copyOnWriteClone(
  options: { platform?: NodeJS.Platform; cp?: string } = {},
): CloneTree {
  const platform = options.platform ?? process.platform;
  const executable = options.cp ?? FIXED_OS_EXECUTABLES.cp;
  return (request) => {
    const argv = copyOnWriteArgv(platform, request.source, request.destination);
    if (!argv) return Promise.resolve({ outcome: "failed", reason: `copy-on-write cloning is not supported on ${platform}` });
    if (request.signal.aborted) return Promise.resolve({ outcome: "stopped" });
    if (request.timeoutMs <= 0) return Promise.resolve({ outcome: "timedOut" });
    return new Promise<CloneResult>((resolve) => {
      let ending: "stopped" | "timedOut" | null = null;
      let stderr = "";
      const timers: Array<ReturnType<typeof setTimeout>> = [];
      // The clone runs from the pool's directory, never from inside a slot, so the occupancy
      // check has nothing of ours to mistake for somebody working there.
      const child = spawn(executable, argv, {
        detached: true,
        cwd: dirname(request.destination),
        shell: false,
        stdio: ["ignore", "ignore", "pipe"],
      });
      const end = (why: "stopped" | "timedOut"): void => {
        if (ending) return;
        ending = why;
        try {
          if (child.pid) process.kill(-child.pid, "SIGTERM");
        } catch {}
        timers.push(setTimeout(() => killProcessGroup(child), CLONE_KILL_GRACE_MS));
      };
      const onAbort = (): void => end("stopped");
      const finish = (result: CloneResult): void => {
        for (const timer of timers) clearTimeout(timer);
        request.signal.removeEventListener("abort", onAbort);
        resolve(result);
      };
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < MAX_REASON_BYTES) stderr += chunk.toString("utf8");
      });
      child.once("error", (error) => finish({ outcome: "failed", reason: boundedReason(error.message) }));
      child.once("close", (code, signal) => {
        if (ending) finish({ outcome: ending });
        else if (code === 0) finish({ outcome: "cloned" });
        else {
          finish({
            outcome: "failed",
            reason: boundedReason(`cp ${argv.slice(0, -2).join(" ")} ${signal ? `was killed by ${signal}` : `exited with code ${code}`}: ${stderr.trim()}`),
          });
        }
      });
      timers.push(setTimeout(() => end("timedOut"), request.timeoutMs));
      request.signal.addEventListener("abort", onAbort, { once: true });
    });
  };
}

/**
 * Remove every path inside `stagedRoot` matching an exclusion glob. `relative` is the staged
 * tree's repository-relative path, so an exclusion is written as it would be in the checkout
 * (`**\/node_modules/.cache`). A matched directory is removed whole and not walked; a symlink is
 * never followed.
 */
async function removeExclusions(
  stagedRoot: string,
  relative: string,
  exclude: readonly string[],
  budget: SeedBudget,
  inspect: SeedLstat,
): Promise<void> {
  if (exclude.length === 0) return;
  const matches = (path: string): boolean => exclude.some((glob) => matchesGlob(path, glob));
  if (matches(relative)) {
    await rm(stagedRoot, { recursive: true, force: true });
    return;
  }
  const walk = async (directory: string, at: string): Promise<void> => {
    checkBudget(budget);
    let children;
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      // A directory that is gone has nothing left to exclude. Any other failure means its
      // excluded content may still be there, so it fails the seed rather than pass it.
      if (absent(error)) return;
      throw error;
    }
    for (const child of children) {
      checkBudget(budget);
      const path = join(directory, child.name);
      const childRelative = `${at}/${child.name}`;
      if (matches(childRelative)) await rm(path, { recursive: true, force: true });
      else if (child.isDirectory()) await walk(path, childRelative);
    }
  };
  // A staged root that cannot be looked up is not one with nothing to exclude.
  const stat = await presentStat(stagedRoot, inspect);
  if (stat?.isDirectory()) await walk(stagedRoot, relative);
}

/** One path cloned into staging, waiting to be renamed into place. */
export interface StagedSeedPath {
  path: string;
  staged: string;
}

export type SeedStageResult =
  /**
   * `complete` is false when what is placed is not exactly the source's tree over every seed
   * path the target has: an exclusion removed a whole matched path, a source path was left out
   * because the target lacks its parent, or the target holds a seed path the source does not
   * supply. The target must then not inherit the source's fingerprint.
   */
  | { kind: "staged"; staged: StagedSeedPath[]; complete: boolean }
  /** Nothing to seed, or the seed could not be prepared. The target was never touched. */
  | { kind: "abandoned"; reason: string }
  | { kind: "stopped" | "timedOut" };

/**
 * Clone every seed path the source has into `stagingDirectory`, and remove the exclusions from
 * the clone. The target checkout is only read: Git confirms each path is ignored there, and a
 * path whose parent directory the target's commit does not have is left out.
 */
export async function stageSeed(input: {
  sourceRoot: string;
  targetRoot: string;
  seed: WorktreeClaimSeed;
  stagingDirectory: string;
  clone: CloneTree;
  signal: AbortSignal;
  deadline: number;
  now: () => number;
  /** How the staged clone is looked up. The real `lstat` unless a test injects a failure. */
  lstat?: SeedLstat;
}): Promise<SeedStageResult> {
  try {
    return await stageWithin(input, { signal: input.signal, deadline: input.deadline, now: input.now });
  } catch (error) {
    if (error instanceof SeedEnded) return { kind: error.ended };
    return { kind: "abandoned", reason: boundedReason(`staging failed: ${error instanceof Error ? error.message : String(error)}`) };
  }
}

async function stageWithin(
  input: Parameters<typeof stageSeed>[0],
  budget: SeedBudget,
): Promise<SeedStageResult> {
  const matched = await expandSeedPaths(input.sourceRoot, input.seed.paths, budget);
  const placeable: SeedEntry[] = [];
  for (const entry of matched) {
    checkBudget(budget);
    const parent = dirname(entry.path);
    if (parent === ".") {
      placeable.push(entry);
      continue;
    }
    const stat = await presentStat(join(input.targetRoot, parent));
    if (stat?.isDirectory()) placeable.push(entry);
  }
  if (placeable.length === 0) return { kind: "abandoned", reason: "the source has none of the seed paths" };
  const proof = await proveIgnored(input.targetRoot, placeable, budget);
  if (!proof.ok) return { kind: "abandoned", reason: proof.reason };
  // The seed replaces the target's tree only if it replaces every seed path the target has. A
  // path the target holds that the source does not supply would keep the target's own, possibly
  // stale, tree beside the seed, and a source path left out for want of its parent is a part of
  // the source's tree the target never gets. Either way the seed is incomplete.
  const supplied = placeable.map((entry) => entry.path);
  const coveredBySeed = (path: string): boolean =>
    supplied.some((source) => path === source || path.startsWith(`${source}/`));
  const unreplaced = (await expandSeedPaths(input.targetRoot, input.seed.paths, budget))
    .filter((entry) => !coveredBySeed(entry.path));
  const staged: StagedSeedPath[] = [];
  let complete = placeable.length === matched.length && unreplaced.length === 0;
  for (const [index, entry] of placeable.entries()) {
    checkBudget(budget);
    const holder = join(input.stagingDirectory, String(index));
    await mkdir(holder, { recursive: true });
    const destination = join(holder, basename(entry.path));
    const cloned = await input.clone({
      source: join(input.sourceRoot, entry.path),
      destination,
      signal: input.signal,
      timeoutMs: input.deadline - input.now(),
    });
    if (cloned.outcome === "stopped" || cloned.outcome === "timedOut") return { kind: cloned.outcome };
    if (cloned.outcome === "failed") return { kind: "abandoned", reason: `${entry.path} could not be cloned: ${cloned.reason}` };
    const inspect = input.lstat ?? lstat;
    await removeExclusions(destination, entry.path, input.seed.exclude, budget, inspect);
    // An exclusion that matched the whole path leaves nothing to place, and the target's own
    // copy of that path is left as it is. The seed is then incomplete.
    if (await presentStat(destination, inspect)) staged.push({ path: entry.path, staged: destination });
    else complete = false;
  }
  // Nothing after the last clone may outlast the Stop or the deadline unseen.
  checkBudget(budget);
  // Every path excluded is no seed at all: the target was never touched, and the steps run.
  if (staged.length === 0) return { kind: "abandoned", reason: "the exclusions removed every seed path" };
  return { kind: "staged", staged, complete };
}

export type SeedPlaceResult =
  | { ok: true }
  /**
   * A rename failed. `touched` is false when nothing in the target had changed yet, as when a
   * tree on another volume refuses the very first rename with EXDEV: that is no seed at all,
   * and the steps run. Once anything was renamed in or aside, the seed paths are half placed.
   */
  | { ok: false; reason: string; touched: boolean }
  /** A Stop or the claim's deadline landed while placing: some paths may already be renamed. */
  | { ok: false; ended: "stopped" | "timedOut" };

/**
 * Rename each staged path into the target. An existing path is first renamed aside into
 * staging, so the path holds the old tree, nothing, or the whole new one, and never a mix.
 * What was renamed aside is removed with the staging directory afterwards.
 *
 * A Stop and the claim's deadline are observed before every rename and once more after the
 * last, so neither can land unseen while the target is being changed: a seed that ends that
 * way is never trusted, whatever it managed to place.
 */
export async function placeSeed(input: {
  targetRoot: string;
  staged: readonly StagedSeedPath[];
  stagingDirectory: string;
  signal: AbortSignal;
  deadline: number;
  now: () => number;
  /** Called after each rename. A test injects a crash, a Stop or a late clock here. */
  afterRename?: (path: string) => Promise<void> | void;
  /** How a path is renamed. The real `rename` unless a test injects a failure such as EXDEV. */
  rename?: (from: string, to: string) => Promise<void>;
}): Promise<SeedPlaceResult> {
  const move = input.rename ?? rename;
  let touched = false;
  const ended = (): SeedPlaceResult | null =>
    input.signal.aborted
      ? { ok: false, ended: "stopped" }
      : input.now() >= input.deadline
        ? { ok: false, ended: "timedOut" }
        : null;
  for (const [index, entry] of input.staged.entries()) {
    const before = ended();
    if (before) return before;
    const target = join(input.targetRoot, entry.path);
    try {
      if (await presentStat(target)) {
        await move(target, join(input.stagingDirectory, `${index}.replaced`));
        touched = true;
      }
      await move(entry.staged, target);
      touched = true;
    } catch (error) {
      return {
        ok: false,
        reason: boundedReason(`${entry.path} could not be placed: ${error instanceof Error ? error.message : String(error)}`),
        touched,
      };
    }
    await input.afterRename?.(entry.path);
  }
  return ended() ?? { ok: true };
}

export type SeedWipeResult =
  | { ok: true; removed: string[] }
  | { ok: false; reason: string }
  /** The Stop or the claim's deadline landed mid-wipe: some seed paths may already be gone. */
  | { ok: false; ended: "stopped" | "timedOut" };

/**
 * Remove a seed path whole, one directory entry at a time, checking the budget between
 * entries: a monorepo's `node_modules` is too large to remove in one uninterruptible call.
 */
async function removeSeedPath(path: string, budget: SeedBudget | undefined): Promise<void> {
  checkBudget(budget);
  const stat = await presentStat(path);
  if (!stat) return;
  if (stat.isDirectory()) {
    for (const name of await childNames(path)) {
      checkBudget(budget);
      await rm(join(path, name), { recursive: true, force: true });
    }
  }
  await rm(path, { recursive: true, force: true });
}

/**
 * An interrupted seed's cleanup: remove every seed path in `root`, but only once Git confirms
 * each one is ignored and holds nothing tracked. A single path that fails the proof removes
 * nothing at all, so the claim fails with the reason instead of deleting work.
 */
export async function wipeSeedPaths(
  root: string,
  seed: WorktreeClaimSeed | undefined,
  budget?: SeedBudget,
): Promise<SeedWipeResult> {
  if (!seed) return { ok: true, removed: [] };
  try {
    return await wipeWithin(root, seed, budget);
  } catch (error) {
    if (error instanceof SeedEnded) return { ok: false, ended: error.ended };
    throw error;
  }
}

async function wipeWithin(root: string, seed: WorktreeClaimSeed, budget: SeedBudget | undefined): Promise<SeedWipeResult> {
  let entries: SeedEntry[];
  try {
    entries = await expandSeedPaths(root, seed.paths, budget);
  } catch (error) {
    if (error instanceof SeedEnded) throw error;
    // A seed path that cannot be seen cannot be confirmed gone. Nothing is removed.
    return { ok: false, reason: boundedReason(`seed paths could not be inspected: ${error instanceof Error ? error.message : String(error)}`) };
  }
  const proof = await proveIgnored(root, entries, budget);
  if (!proof.ok) return { ok: false, reason: proof.reason };
  try {
    for (const entry of entries) await removeSeedPath(join(root, entry.path), budget);
  } catch (error) {
    if (error instanceof SeedEnded) throw error;
    return { ok: false, reason: boundedReason(`seed paths could not be removed: ${error instanceof Error ? error.message : String(error)}`) };
  }
  return { ok: true, removed: entries.map((entry) => entry.path) };
}

/** The pool's seed staging root. */
export function seedStagingRoot(poolPath: string): string {
  return join(poolPath, SEED_STAGING_DIRECTORY);
}

/**
 * Remove every staging directory under the pool that no live seed owns: what a crash or a
 * failed cleanup left behind. Safe at runtime, because a seed in flight is named in `live`.
 * Returns the names removed.
 */
export async function removeLeftoverStaging(poolPath: string, live: ReadonlySet<string>): Promise<string[]> {
  const root = seedStagingRoot(poolPath);
  const removed: string[] = [];
  for (const name of await childNames(root)) {
    if (live.has(name)) continue;
    await rm(join(root, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}
