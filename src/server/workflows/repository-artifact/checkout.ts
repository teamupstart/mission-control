import { createRequire } from "node:module";
import { nativeStateLockAddonPath } from "../../state-ownership-native.ts";
import { createHash } from "node:crypto";
import { constants, type BigIntStats, type Stats } from "node:fs";
import { open, realpath, lstat, readlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { checkoutGit, checkoutRecords, type CheckoutDirectories } from "./git.ts";
import { chargePaths, expansionBudget, expansionExceeded, type PathBudget } from "./path-budget.ts";
import { decodedPath, MAX_CAPTURE_OBJECT_BYTES, oid, readExactFile, RepositoryCaptureChanged, unavailable } from "./format.ts";
import { approvedPath } from "@shared/repository-policy.ts";

export type Entry = { mode: string; id: string };
/** Hex keys sort in raw byte order, without Unicode decoding or case folding. */
export type Layer = Map<string, Entry>;
export const allowed = (key: string) => approvedPath(decodedPath(key) ?? "");
export function validPath(raw: Buffer) {
  for (let start = 0; start <= raw.length;) {
    const slash = raw.indexOf(47, start);
    const end = slash < 0 ? raw.length : slash;
    if (end - start <= 4) {
      const part = raw.toString("latin1", start, end).toLowerCase();
      if (!part || part === "." || part === ".." || part === ".git") unavailable();
    }
    start = end + 1;
  }
  return raw.toString("hex");
}

function line(buf: Buffer) {
  if (buf.at(-1) !== 10 || !Buffer.from(buf.toString()).equals(buf)) unavailable();
  return buf.subarray(0, -1).toString();
}

async function checkoutDirectories(executable: string, cwd: string, signal: AbortSignal) {
  const discover = (args: string[], missing = false) => checkoutGit(executable, cwd, args, signal, missing);
  const root = await realpath(line(await discover(["rev-parse", "--show-toplevel"])));
  // core.worktree cannot broaden the submitted checkout past a nearer marker.
  for (let dir = await realpath(cwd); dir !== root; dir = dirname(dir)) {
    const marker = await lstat(join(dir, ".git")).catch(error => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (marker || dirname(dir) === dir) unavailable();
  }
  const dotGit = join(root, ".git");
  const marker = await lstat(dotGit);
  if (!marker.isDirectory() && !marker.isFile()) unavailable();
  const admin = marker.isDirectory() ? dotGit : await realpath(line(await discover(["rev-parse", "--absolute-git-dir"])));
  const common = await realpath(line(await discover(["--git-dir", admin, "rev-parse", "--path-format=absolute", "--git-common-dir"])));
  return { root, admin, common };
}

async function verifyOwner(executable: string, directories: CheckoutDirectories, signal: AbortSignal) {
  const { root, admin, common } = directories;
  const dotGit = join(root, ".git");
  const marker = await lstat(dotGit);
  if (!marker.isDirectory() && !marker.isFile()) unavailable();
  if (marker.isDirectory()) {
    if (admin !== dotGit || common !== dotGit) unavailable();
    return;
  }
  const target = await gitPathFile(dotGit, marker, "gitdir: ", signal);
  if (await realpath(resolve(root, target)) !== admin) throw new RepositoryCaptureChanged();
  if (admin === common) {
    // A separate Git directory (including an absorbed submodule) must itself
    // name this worktree. An ordinary repository selected by a gitfile cannot.
    const config = join(admin, "config");
    if (!(await lstat(config)).isFile()) unavailable();
    const owner = await checkoutGit(executable, root, ["config", "--file", config, "--no-includes", "--get", "core.worktree"], signal, true);
    if (!owner.length || await realpath(resolve(admin, line(owner))) !== root) unavailable();
  } else {
    if (dirname(admin) !== join(common, "worktrees")) unavailable();
    const backlink = join(admin, "gitdir");
    const stat = await lstat(backlink);
    if (!stat.isFile()) unavailable();
    const owner = resolve(admin, await gitPathFile(backlink, stat, "", signal));
    if (join(await realpath(dirname(owner)), basename(owner)) !== dotGit) unavailable();
  }
}

async function gitPathFile(path: string, stat: Stats, prefix: string, signal: AbortSignal) {
  const { data } = await readWorkingFile(Buffer.from(path), stat, signal, 16_384);
  const text = data.toString();
  if (!Buffer.from(text).equals(data) || !text.startsWith(prefix)) unavailable();
  const target = text.slice(prefix.length).replace(/\r?\n$/, "");
  if (!target || target.includes("\0")) unavailable();
  return target;
}

function directoryIdentity(stat: BigIntStats) {
  return [stat.dev, stat.ino, stat.birthtimeNs].join(":");
}

async function assertSameDirectory(path: string, before: BigIntStats) {
  const current = await lstat(path, { bigint: true }).catch(error => {
    if (["ENOENT", "ENOTDIR", "ELOOP"].includes(error.code)) throw new RepositoryCaptureChanged();
    throw error;
  });
  if (!current.isDirectory() || current.ctimeNs !== before.ctimeNs || directoryIdentity(current) !== directoryIdentity(before))
    throw new RepositoryCaptureChanged();
}

export type CheckoutState = Awaited<ReturnType<typeof sample>>;
export async function withCheckoutSample<T>(executable: string, cwd: string, signal: AbortSignal,
  limits: Partial<PathBudget> | undefined, read: (state: CheckoutState, commonFd: number) => Promise<T>) {
  const directories = await checkoutDirectories(executable, cwd, signal);
  const held = new Map<string, { handle: FileHandle; stat: BigIntStats }>();
  try {
    for (const path of new Set(Object.values(directories))) {
      const handle = await openChecked(Buffer.from(path), true);
      try { held.set(path, { handle, stat: await handle.stat({ bigint: true }) }); }
      catch (error) { await handle.close(); throw error; }
    }
    try {
      await verifyOwner(executable, directories, signal);
      const identities = [...held.values()].map(entry => directoryIdentity(entry.stat));
      return await read(await sample(executable, directories, identities, signal, limits), held.get(directories.common)!.handle.fd);
    } finally {
      // A rename can preserve every Git ID and every worktree byte. Checking the
      // original directory's change time also catches a switch away and back
      // during this read. Only the stable identity crosses prompt-read boundaries.
      for (const [path, { stat }] of held) await assertSameDirectory(path, stat);
    }
  } finally {
    await Promise.all([...held.values()].map(entry => entry.handle.close()));
  }
}

async function sample(executable: string, directories: CheckoutDirectories, identities: string[], signal: AbortSignal, limits?: Partial<PathBudget>) {
  const { root, common } = directories;
  const git = (args: string[], missing = false) => checkoutGit(executable, root, args, signal, missing, directories);
  const format = line(await git(["rev-parse", "--show-object-format"]));
  if (!["sha1", "sha256"].includes(format)) unavailable();
  const shallow = await shallowCommits(common, format, signal);
  const headBytes = await git(["rev-parse", "--verify", "-q", "HEAD"], true);
  const head = headBytes.length ? oid.parse(line(headBytes)) : null;
  if (!head) {
    const ref = line(await git(["symbolic-ref", "HEAD"]));
    if ((await git(["rev-parse", "--verify", "-q", ref], true)).length) unavailable();
  }
  const index: Layer = new Map();
  const skipWorktree = new Set<string>();
  const readBoolean = async (name: string) => {
    const setting = await git(["config", "--includes", "--type=bool", "--get", name], true);
    return !setting.length || line(setting) === "true";
  };
  const [fileMode, symlinks] = await Promise.all([readBoolean("core.fileMode"), readBoolean("core.symlinks")]);
  const excludes = await git(["config", "--includes", "--path", "-z", "--get", "core.excludesFile"], true);
  if (!Buffer.from(excludes.toString()).equals(excludes)) unavailable();
  const override = excludes.length ? ["-c", "core.excludesFile=" + excludes.subarray(0, -1).toString()] : [];
  const budget = expansionBudget(limits);
  // A staged record includes the mode, OID, stage and tag before the path.
  const maxRecordBytes = budget.pathBytes + 100;
  const records = (args: string[], accept: (row: Buffer) => void) =>
    checkoutRecords(executable, directories, args, signal, maxRecordBytes, accept);
  const paths = new Set<string>();
  const pathPrefixes = new Set<string>();
  function collectPath(raw: Buffer) {
    if (!chargePaths(budget, raw.length)) expansionExceeded();
    // Each implicit directory becomes a node when the worktree and index trees
    // are built. All ancestors above a known prefix have already been charged.
    for (let end = raw.lastIndexOf(47); end > 0; end = raw.lastIndexOf(47, end - 1)) {
      const prefix = raw.toString("hex", 0, end);
      if (pathPrefixes.has(prefix)) break;
      if (!chargePaths(budget, end)) expansionExceeded();
      pathPrefixes.add(prefix);
    }
    const key = validPath(raw);
    paths.add(key);
    return key;
  }
  // Neither command inspects file content. In particular no status/diff command
  // gets a chance to run an attribute-selected clean or textconv driver.
  await records([...override, "ls-files", "-z", "-t", "--stage"], row => {
    const tab = row.indexOf(9);
    if (tab < 0 || tab > 100) unavailable();
    const [tag, mode, id, stage] = row.toString("ascii", 0, tab).split(" ");
    if (stage !== "0" || !/^(100644|100755|120000|160000)$/.test(mode!)) unavailable();
    const key = collectPath(row.subarray(tab + 1));
    index.set(key, { mode: mode!, id: oid.parse(id) });
    if (tag === "S") skipWorktree.add(key);
  });
  // Intent-to-add has the id of the empty blob in ls-files, but no entry in the
  // staged tree. Ask Git for index names against its virtual empty tree only when
  // there is an ambiguous empty entry. A cached, names-only diff reads no worktree.
  const intentModes: Record<string, string> = {};
  const emptyBlob = createHash(format).update("blob 0\0").digest("hex");
  if ([...index.values()].some((e) => e.id === emptyBlob)) {
    const emptyTree = createHash(format).update("tree 0\0").digest("hex");
    const ambiguous = new Set([...index].filter(([, e]) => e.id === emptyBlob).map(([key]) => key));
    await records(
      [
        "diff",
        "--cached",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--ita-invisible-in-index",
        "--name-only",
        "-z",
        emptyTree,
        "--",
      ],
      row => { ambiguous.delete(row.toString("hex")); },
    );
    for (const key of ambiguous) {
      intentModes[key] = index.get(key)!.mode;
      index.delete(key);
    }
  }
  const embedded: string[] = [];
  await records([...override, "ls-files", "-z", "--others", "--exclude-standard"], raw => {
    // Git enumerates an untracked embedded repository as one trailing-slash entry.
    const directory = raw.at(-1) === 47;
    const key = collectPath(directory ? raw.subarray(0, -1) : raw);
    if (directory) embedded.push(key);
  });
  return { ...directories, identities, format, emptyBlob, head, shallow, fileMode, symlinks, index, skipWorktree, intentModes, embedded, paths: [...paths].sort() };
}

const require = createRequire(import.meta.url);
/** Darwin's O_NOFOLLOW_ANY checks every component atomically. On Linux confirm the
 * kernel's path for the held descriptor before reading anything through it. */
async function openChecked(path: Buffer, directory = false) {
  const noFollow = process.platform === "darwin" ? 0x20000000 : constants.O_NOFOLLOW;
  const fd = await open(
    path,
    constants.O_RDONLY | noFollow | constants.O_NONBLOCK | (directory ? constants.O_DIRECTORY : 0),
  );
  try {
    if (
      process.platform === "linux" &&
      !(await readlink(`/proc/self/fd/${fd.fd}`, { encoding: "buffer" })).equals(path)
    )
      throw new RepositoryCaptureChanged();
    return fd;
  } catch (error) {
    await fd.close();
    throw error;
  }
}

async function readWorkingFile(path: Buffer, observed: Stats, signal: AbortSignal, limit = MAX_CAPTURE_OBJECT_BYTES) {
  const fd = await openChecked(path).catch(error => {
    if (["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? ""))
      throw new RepositoryCaptureChanged();
    throw error;
  });
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || observed.dev !== stat.dev || observed.ino !== stat.ino)
      throw new RepositoryCaptureChanged();
    if (stat.size > limit)
      throw Object.assign(new Error("Worktree file exceeds capture limit"), { code: "worktree_file_too_large" });
    const data = await readExactFile(fd, stat.size, signal);
    if (data === null) throw new RepositoryCaptureChanged();
    return { data, mode: stat.mode & 0o100 ? "100755" : "100644" };
  } finally {
    await fd.close();
  }
}

async function shallowCommits(common: string, format: string, signal: AbortSignal) {
  const path = Buffer.from(join(common, "shallow"));
  const stat = await lstat(path).catch(error => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (!stat) return [];
  if (!stat.isFile()) return unavailable();
  const { data } = await readWorkingFile(path, stat, signal);
  if (!data.length) return [];
  const width = format === "sha1" ? 40 : 64;
  const revisions: string[] = [];
  for (let pos = 0; pos < data.length; pos += width + 1) {
    const id = data.toString("latin1", pos, pos + width);
    if ((pos + width < data.length && data[pos + width] !== 10) ||
        id.length !== width || !oid.safeParse(id).success) unavailable();
    revisions.push(id);
  }
  return revisions.sort();
}

export async function workingFile(
  executable: string,
  state: Awaited<ReturnType<typeof sample>>,
  key: string,
  embedded: boolean,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const { root, common, index } = state;
  const indexed = index.get(key);
  const prefix = Buffer.from(root + "/");
  const path = Buffer.concat([prefix, Buffer.from(key, "hex")]);
  const parent = path.subarray(0, path.lastIndexOf(47));
  try {
    // A non-directory ancestor removes the tracked child from this layer. Never
    // resolve a replacement symlink, including a dangling or self-referential one.
    for (let end = path.indexOf(47, prefix.length); end >= 0; end = path.indexOf(47, end + 1)) {
      if (!(await lstat(path.subarray(0, end))).isDirectory()) return null;
    }
    const st = await lstat(path);
    if (st.isDirectory()) {
      if (indexed?.mode !== "160000" && !embedded) return null;
      const sub = path.toString();
      if (!Buffer.from(sub).equals(path)) unavailable();
      const marker = join(sub, ".git");
      const stat = await lstat(marker).catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      if (!stat) {
        if (!indexed || embedded) return unavailable();
        return { entry: indexed };
      }
      let admin = marker;
      if (stat.isFile()) {
        const text = (await readWorkingFile(Buffer.from(marker), stat, signal)).data.toString("utf8").trimEnd();
        if (!text.startsWith("gitdir: ")) unavailable();
        admin = resolve(sub, text.slice(8));
      } else if (!stat.isDirectory()) unavailable();
      if (
        (await realpath(admin)) !== admin ||
        !(admin.startsWith(sub + "/") || admin.startsWith(join(common, "modules") + "/"))
      )
        unavailable();
      // Only inspect its gitlink identity. Never enumerate the nested worktree or copy its objects.
      const id = oid.parse(
        (await checkoutGit(executable, root, ["--git-dir", admin, "rev-parse", "--verify", "HEAD"], signal))
          .toString()
          .trim(),
      );
      if (id.length !== state.emptyBlob.length)
        throw Object.assign(new Error("Nested Git object format differs from parent"), { code: "gitlink_format_mismatch" });
      return { entry: { mode: "160000", id } };
    }
    if (st.isSymbolicLink()) {
      const parentFd = await openChecked(parent, true);
      try {
        const binding = require(nativeStateLockAddonPath()) as {
          readRepositoryLink(fd: number, name: Buffer): Buffer;
        };
        const data = binding.readRepositoryLink(parentFd.fd, path.subarray(parent.length + 1));
        return { data, mode: "120000" };
      } catch (error) {
        // lstat saw a link. If it vanished or became a different kind of entry,
        // repeat the entire submission read on the new checkout boundary.
        if (["ENOENT", "ENOTDIR", "EINVAL"].includes((error as NodeJS.ErrnoException).code ?? "")) {
          throw new RepositoryCaptureChanged();
        }
        throw error;
      } finally {
        await parentFd.close();
      }
    }
    if (!st.isFile()) unavailable();
    const file = await readWorkingFile(path, st, signal);
    const indexedMode = indexed?.mode ?? state.intentModes[key];
    if (!state.symlinks && indexedMode === "120000") file.mode = "120000";
    else if (!state.fileMode && indexedMode) file.mode = indexedMode === "100755" ? "100755" : "100644";
    return file;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Git projects an absent skip-worktree path from the index. Present files
    // were read above; an ordinary missing tracked path is still a deletion.
    if (code === "ENOENT" && indexed && state.skipWorktree.has(key)) return { entry: indexed };
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}
