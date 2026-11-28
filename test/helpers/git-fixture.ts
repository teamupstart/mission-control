import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "../temp-root.mjs";

// Real git fixtures, built with as few git processes as the result allows.
//
// Endpoint security agents on developer Macs inspect every exec, so a fixture's cost is its
// process count, not its CPU. A one-commit repository used to take six or seven git
// processes - init, branch, two config writes, add, commit, and the `rev-parse` that read its
// sha back - and an origin-and-clone pair a dozen. Here a fixture's first request in a test
// worker builds it with the fewest commands that produce it and keeps a copy; every later
// request copies that copy, which is the repository those same commands would have made, and
// pays one `update-index --refresh` so the index's stat cache describes the new inodes.
// What git does to the repository afterwards is untouched; only how it came to exist changes.

/**
 * How every fixture copy is made. `preserveTimestamps` keeps mtimes, which the index refresh
 * compares. `verbatimSymlinks` keeps a committed relative symlink relative: by default Node
 * resolves it against the source, so a copy's `alias -> keep.txt` would point into the first
 * build and break once that is removed.
 */
const COPY = { recursive: true, preserveTimestamps: true, verbatimSymlinks: true } as const;

/** Run git in `dir`, returning trimmed stdout. */
export function gitIn(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" }).toString().trim();
}

/** One commit: the files it writes (relative to the repository root) and its message. */
export interface SeedCommit {
  files: Record<string, string>;
  message: string;
}

export interface RepoSeed {
  /** The base commit's files. Empty: an empty commit. */
  files?: Record<string, string>;
  /** The base commit's message. */
  message?: string;
  /** Commits made on top of the base, in order, each writing its files and staging everything. */
  later?: SeedCommit[];
  /** The branch HEAD names. Omitted, git's own default - exactly what a bare `git init` picks. */
  branch?: string;
  /** The identity every commit is made with, `user.email` and `user.name`. */
  email?: string;
  name?: string;
  /**
   * Whether that identity is also written to the repository's own config, as
   * `git config user.email ...` would (the default), or used only for the seed's commits, as
   * `git -c user.email=... commit` would.
   */
  storeIdentity?: boolean;
  /** More of the repository's own config, as `git config <key> <value>` would write it. */
  config?: Record<string, string>;
}

type FullSeed = Required<Omit<RepoSeed, "branch">> & Pick<RepoSeed, "branch">;

const DEFAULT_SEED: FullSeed = {
  files: { "keep.txt": "base\n" },
  message: "base",
  later: [],
  email: "t@test",
  name: "t",
  storeIdentity: true,
  config: {},
};

interface Template {
  path: string;
  /** The base commit's sha, then each `later` commit's. */
  shas: string[];
}

// One directory per worker for every template it keeps, inside the worker's temp root and so
// removed with it when the worker exits (see docs/test-temp-dirs.md). Never shared between workers: each test file is its own process, and a cache two processes could
// race to fill would trade exec churn for a flake.
let templateRoot: string | null = null;
const templates = new Map<string, Template>();

function templateDir(): string {
  if (templateRoot === null) {
    templateRoot = realpathSync(tempDir("mission-git-templates-"));
  }
  return mkdtempSync(join(templateRoot, "t-"));
}

/**
 * The sha HEAD's branch names: read from the loose ref the files backend writes, without
 * another git process. A repository on any other backend - reftable, which a global
 * `init.defaultRefFormat` can select - has no such file, and is asked.
 */
function headSha(dir: string): string {
  const gitDir = join(dir, ".git");
  const ref = readFileSync(join(gitDir, "HEAD"), "utf8").trim().replace(/^ref: /, "");
  const loose = join(gitDir, ...ref.split("/"));
  if (existsSync(loose)) return readFileSync(loose, "utf8").trim();
  return gitIn(dir, "rev-parse", "HEAD");
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
}

/**
 * Config entries in git's own file syntax: `a.b` is key `b` of section `[a]`, and `a.x.y.b` is
 * key `b` of subsection `[a "x.y"]`. A plain value is written bare, exactly as git writes it,
 * and only one git would have to quote is quoted.
 */
function configText(entries: Record<string, string>): string {
  const sections = new Map<string, string[]>();
  for (const [name, value] of Object.entries(entries)) {
    const first = name.indexOf(".");
    const last = name.lastIndexOf(".");
    if (first <= 0 || last === name.length - 1) throw new Error(`not a git config key: ${name}`);
    const section = name.slice(0, first);
    const header = first === last ? `[${section}]` : `[${section} ${JSON.stringify(name.slice(first + 1, last))}]`;
    const lines = sections.get(header) ?? [];
    const plain = /^[^\s"\\;#](?:[^"\\;#\n]*[^\s"\\;#])?$/.test(value);
    lines.push(`\t${name.slice(last + 1)} = ${plain ? value : JSON.stringify(value)}`);
    sections.set(header, lines);
  }
  return [...sections].map(([header, lines]) => `${header}\n${lines.join("\n")}\n`).join("");
}

/** `git init`, then an `add` and a `commit` per commit (just the commit when it is empty). */
function buildRepo(dir: string, seed: FullSeed): string[] {
  const branch = seed.branch === undefined ? [] : ["-b", seed.branch];
  execFileSync("git", ["init", "-q", ...branch, dir], { stdio: "pipe" });
  const config = { ...(seed.storeIdentity ? { "user.email": seed.email, "user.name": seed.name } : {}), ...seed.config };
  // The sections `git config <key> <value>` writes, without a process per key.
  writeFileSync(join(dir, ".git", "config"), configText(config), { flag: "a" });
  const identity = ["-c", `user.email=${seed.email}`, "-c", `user.name=${seed.name}`];
  const shas: string[] = [];
  for (const commit of [{ files: seed.files, message: seed.message }, ...seed.later]) {
    writeFiles(dir, commit.files);
    const empty = Object.keys(commit.files).length === 0;
    if (!empty) gitIn(dir, "add", "-A");
    gitIn(dir, ...identity, "commit", "-q", ...(empty ? ["--allow-empty"] : []), "-m", commit.message);
    shas.push(headSha(dir));
  }
  return shas;
}

/**
 * Copy a built repository to `dest` and refresh the index's stat cache, which still describes
 * the template's inodes. An empty commit has no index to refresh.
 */
function copyRepo(from: string, dest: string): void {
  cpSync(from, dest, COPY);
  if (existsSync(join(dest, ".git", "index"))) gitIn(dest, "update-index", "-q", "--refresh");
}

/**
 * A real repository at `dir`: a base commit holding `seed.files`, then each `seed.later` commit,
 * with HEAD on `seed.branch`. Returns every commit's sha, base first. `dir` must be empty or
 * absent.
 *
 * The first request for a seed builds it in place and keeps a copy; every later one copies
 * that. Repositories from one seed in one worker therefore share their shas, because they are
 * the same commits - which git itself produces for two identical seeds made inside one second.
 */
export function seedGitHistory(dir: string, seed: RepoSeed = {}): string[] {
  const full = { ...DEFAULT_SEED, ...seed };
  const key = JSON.stringify(full);
  const template = templates.get(key);
  if (template) {
    mkdirSync(dir, { recursive: true });
    copyRepo(template.path, dir);
    return [...template.shas];
  }
  const shas = buildRepo(dir, full);
  const path = templateDir();
  cpSync(dir, path, COPY);
  templates.set(key, { path, shas });
  return [...shas];
}

/** `seedGitHistory`, returning the sha HEAD ends on. */
export function seedGitRepo(dir: string, seed: RepoSeed = {}): string {
  return seedGitHistory(dir, seed).at(-1)!;
}

/**
 * The files in which git records an absolute path: a remote's URL (`config`), and the two
 * halves of a linked worktree's link - its `.git` file, and the `gitdir` its repository keeps.
 */
function isPathBearing(name: string, isFile: boolean, inGitDir: boolean): boolean {
  if (!isFile) return false;
  // `config` and `gitdir` only inside a git directory: a tracked file of the same name is the
  // test's content, and rewriting it would dirty a checkout the first build left clean. A `.git`
  // file is always git's own - a worktree cannot track one.
  return name === ".git" || (inGitDir && (name === "config" || name === "gitdir"));
}

/** Whether `dir` is a bare repository's git directory: HEAD and objects at its top. */
function isBareGitDir(dir: string): boolean {
  return existsSync(join(dir, "HEAD")) && existsSync(join(dir, "objects"));
}

/** Every working tree under `root`: each directory holding a `.git`, file or directory. */
function rerootTree(root: string, from: string, to: string, worktrees: string[] = [], inGitDir = false): string[] {
  const gitDir = inGitDir || isBareGitDir(root);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".git") worktrees.push(root);
      if (entry.name !== "objects") rerootTree(path, from, to, worktrees, gitDir || entry.name === ".git");
    } else if (isPathBearing(entry.name, entry.isFile(), gitDir)) {
      if (entry.name === ".git") worktrees.push(root);
      const text = readFileSync(path, "utf8");
      if (text.includes(from)) writeFileSync(path, text.split(from).join(to));
    }
  }
  return worktrees;
}

/**
 * A directory of real repositories - bare origins, clones, linked worktrees, whatever `build`
 * makes inside `root` - built once per worker per `key` and copied for every later request.
 * Returns what `build` returned, with every occurrence of the first build's root re-rooted at
 * this `root`; it must therefore be JSON-serializable.
 *
 * A copied repository records the first build's absolute paths, so each copy has them
 * rewritten: remote URLs, and both halves of every worktree link. That is the whole list for
 * what these fixtures make, which is why `build` must keep everything it creates inside
 * `root` - a path outside it would still point at the first copy. Each working tree then pays
 * one `update-index --refresh`, for the same stat-cache reason a single repository does.
 *
 * Same key, same world: use it only for a `build` that takes no varying input.
 */
export function cachedGitTree<T>(key: string, root: string, build: (root: string) => T): T {
  const full = `tree:${key}`;
  const cachedTree = trees.get(full);
  mkdirSync(root, { recursive: true });
  const destination = realpathSync(root);
  if (!cachedTree) {
    const value = build(destination);
    const path = templateDir();
    cpSync(destination, path, COPY);
    trees.set(full, { path, builtAt: destination, value: JSON.stringify(value) });
    return value;
  }
  cpSync(cachedTree.path, destination, COPY);
  for (const worktree of rerootTree(destination, cachedTree.builtAt, destination)) {
    if (existsSync(join(worktree, ".git", "index")) || !statSync(join(worktree, ".git")).isDirectory()) {
      gitIn(worktree, "update-index", "-q", "--refresh");
    }
  }
  return JSON.parse(cachedTree.value.split(JSON.stringify(cachedTree.builtAt).slice(1, -1)).join(
    JSON.stringify(destination).slice(1, -1),
  )) as T;
}

const trees = new Map<string, { path: string; builtAt: string; value: string }>();

export interface OriginAndClone {
  /** The temp dir holding both, so a suite can remove what it made. */
  root: string;
  origin: string;
  clone: string;
}

/**
 * A real "origin" repo (a `main` branch with a base commit) plus a clone of it
 * whose `origin/main` tracks that base. Real git, so tests can advance origin,
 * diverge the clone, and exercise a genuine fetch/reset/clean rather than a mock
 * that can't show what a reset does to a branch name.
 *
 * `prefix` names the temp dir so a failing test says which suite made it. The directory is
 * in the worker's temp root, so it is removed when the worker exits whether or not the caller
 * removes it first.
 */
export function mkOriginAndClone(prefix: string): OriginAndClone {
  return originAndCloneAt(realpathSync(tempDir(prefix)));
}

/** `mkOriginAndClone` inside a directory the caller owns - for a `cachedGitTree` build. */
export function originAndCloneAt(root: string): OriginAndClone {
  return cachedGitTree("origin-and-clone", root, (dir) => {
    const origin = join(dir, "origin");
    const clone = join(dir, "clone");
    buildRepo(origin, { ...DEFAULT_SEED, branch: "main" });
    execFileSync("git", ["clone", "-q", origin, clone], { stdio: "pipe" });
    writeFileSync(join(clone, ".git", "config"), configText({ "user.email": "t@test", "user.name": "t" }), { flag: "a" });
    return { root: dir, origin, clone };
  });
}

/**
 * A clone sitting on `branch` with a local commit on top - the shape a session is
 * in when a review has just finished validating that work. Returns the
 * clone dir, which is also its worktree root.
 */
export function mkCloneOnBranch(prefix: string, branch: string): string {
  const { clone } = mkOriginAndClone(prefix);
  gitIn(clone, "checkout", "-qb", branch);
  writeFileSync(join(clone, "keep.txt"), "base\nthe work the run validated\n");
  gitIn(clone, "commit", "-qam", "work");
  return clone;
}

/**
 * A second worktree of `clone`'s repo, checked out on `branch` - a real linked
 * worktree (its `.git` is a FILE), which is how another checkout
 * differs from the session that drives it.
 */
export function mkLinkedWorktree(clone: string, branch: string, dir: string): string {
  gitIn(clone, "worktree", "add", "-q", "-b", branch, dir);
  return realpathSync(dir);
}
