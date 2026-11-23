import { createRequire } from "node:module";
import { nativeStateLockAddonPath } from "../../state-ownership-native.ts";
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { open, realpath, lstat, readlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { checkoutGit } from "./git.ts";
import { decodedPath, MAX_CAPTURE_OBJECT_BYTES, oid, RepositoryCaptureChanged, unavailable } from "./format.ts";
import { approvedPath } from "@shared/repository-policy.ts";

export type Entry = { mode: string; id: string };
/** Hex keys sort in raw byte order, without Unicode decoding or case folding. */
export type Layer = Map<string, Entry>;
export const allowed = (key: string) => approvedPath(decodedPath(key) ?? "");
export function validPath(raw: Buffer) {
  if (
    raw
      .toString("latin1")
      .split("/")
      .some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")
  )
    unavailable();
  return raw.toString("hex");
}

export async function sample(executable: string, cwd: string, signal: AbortSignal) {
  const git = (args: string[], missing = false) => checkoutGit(executable, cwd, args, signal, missing);
  const line = (buf: Buffer) => {
    if (buf.at(-1) !== 10 || !Buffer.from(buf.toString()).equals(buf)) unavailable();
    return buf.subarray(0, -1).toString();
  };
  const root = await realpath(line(await git(["rev-parse", "--show-toplevel"])));
  const checkout = await realpath(cwd);
  // core.worktree cannot broaden the submitted checkout into a containing directory.
  let nearest = checkout;
  for (;;) {
    const marker = await lstat(join(nearest, ".git")).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (marker) {
      if (!marker.isDirectory() && !marker.isFile()) unavailable();
      break;
    }
    if (dirname(nearest) === nearest) unavailable();
    nearest = dirname(nearest);
  }
  if (nearest !== root) unavailable();
  const common = await realpath(line(await git(["rev-parse", "--path-format=absolute", "--git-common-dir"])));
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
  const excludes = await git(["config", "--includes", "--path", "-z", "--get", "core.excludesFile"], true);
  if (!Buffer.from(excludes.toString()).equals(excludes)) unavailable();
  const override = excludes.length ? ["-c", "core.excludesFile=" + excludes.subarray(0, -1).toString()] : [];
  const list = (args: string[]) =>
    checkoutGit(executable, root, [...override, "ls-files", "-z", ...args], signal);
  // Neither command inspects file content. In particular no status/diff command
  // gets a chance to run an attribute-selected clean or textconv driver.
  for (const row of (await list(["-t", "--stage"])).toString("latin1").split("\0").filter(Boolean)) {
    const tab = row.indexOf("\t");
    const [tag, mode, id, stage] = row.slice(0, tab).split(" ");
    if (tab < 0 || stage !== "0" || !/^(100644|100755|120000|160000)$/.test(mode!)) unavailable();
    const key = validPath(Buffer.from(row.slice(tab + 1), "latin1"));
    index.set(key, { mode: mode!, id: oid.parse(id) });
    if (tag === "S") skipWorktree.add(key);
  }
  const paths = new Set(index.keys());
  // Intent-to-add has the id of the empty blob in ls-files, but no entry in the
  // staged tree. Ask Git for index names against its virtual empty tree only when
  // there is an ambiguous empty entry. A cached, names-only diff reads no worktree.
  const intent: string[] = [];
  const emptyBlob = createHash(format).update("blob 0\0").digest("hex");
  if ([...index.values()].some((e) => e.id === emptyBlob)) {
    const emptyTree = createHash(format).update("tree 0\0").digest("hex");
    const names = await checkoutGit(
      executable,
      root,
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
      signal,
    );
    const staged = new Set(
      names
        .toString("latin1")
        .split("\0")
        .map((p) => Buffer.from(p, "latin1").toString("hex")),
    );
    for (const [key, entry] of index)
      if (entry.id === emptyBlob && !staged.has(key)) {
        index.delete(key);
        intent.push(key);
      }
  }
  const embedded: string[] = [];
  for (const raw of (await list(["--others", "--exclude-standard"]))
    .toString("latin1")
    .split("\0")
    .filter(Boolean)) {
    // Git enumerates an untracked embedded repository as one trailing-slash entry.
    const directory = raw.endsWith("/");
    const key = validPath(Buffer.from(directory ? raw.slice(0, -1) : raw, "latin1"));
    if (directory) embedded.push(key);
    paths.add(key);
  }
  return { root, common, format, emptyBlob, head, shallow, index, skipWorktree, intent, embedded, paths: [...paths].sort() };
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

async function readWorkingFile(path: Buffer, observed: Stats, signal: AbortSignal) {
  const fd = await openChecked(path).catch(error => {
    if (["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? ""))
      throw new RepositoryCaptureChanged();
    throw error;
  });
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || observed.dev !== stat.dev || observed.ino !== stat.ino)
      throw new RepositoryCaptureChanged();
    if (stat.size > MAX_CAPTURE_OBJECT_BYTES)
      throw Object.assign(new Error("Worktree file exceeds capture limit"), { code: "worktree_file_too_large" });
    // The extra byte detects growth without extending the allocation. Short reads can
    // occur on a regular file, so only EOF establishes the final size.
    const buffer = Buffer.allocUnsafe(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      signal.throwIfAborted();
      const { bytesRead } = await fd.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new RepositoryCaptureChanged();
    return { data: buffer.subarray(0, offset), mode: stat.mode & 0o100 ? "100755" : "100644" };
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
  const path = Buffer.concat([Buffer.from(root + "/"), Buffer.from(key, "hex")]);
  const parent = path.subarray(0, path.lastIndexOf(47));
  try {
    if (!(await realpath(parent, { encoding: "buffer" })).equals(parent)) return null;
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
    return await readWorkingFile(path, st, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Git projects an absent skip-worktree path from the index. Present files
    // were read above; an ordinary missing tracked path is still a deletion.
    if (code === "ENOENT" && indexed && state.skipWorktree.has(key)) return { entry: indexed };
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}
