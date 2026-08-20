import { spawn } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import { taskRepoRefs, type TaskRepoRef, type TaskRepoSource } from "@shared/task-repos.ts";

// "Has anything Git can SEE changed in this checkout since the last time we looked?"
//
// The activity clock behind automatic stale-worktree retention, and the entire reason it is
// asked of Git rather than of the filesystem: an mtime sweep cannot tell a warm `node_modules`
// from an agent's edit, and `tasks.updated_at` moves for pull request polling and title edits
// while an agent typing into a file moves nothing at all. What this produces is a digest over
// exactly the four things the approved policy names as work worth keeping - HEAD, the whole
// index, tracked worktree changes, and non-ignored untracked files - and nothing else.
//
// Three properties are load-bearing, because a downstream phase deletes trees on this answer:
//
//  1. **Unknown is a real answer.** Every failure - a missing path, a Git non-zero exit, output
//     too large to trust, a file kind that cannot be represented - returns `unknown` with a
//     bounded reason. It never degrades into a clean-looking digest, because a stable digest is
//     read as "quiet", and quiet is what eventually authorizes deletion.
//  2. **Nothing is silently truncated.** A very large visible file is streamed into the digest
//     in full or refused outright. A capped read would produce a digest that stops changing
//     once a file grows past the cap, which is the same failure as (1) wearing a hash.
//  3. **Nothing is stored but the digest.** No path, no file content, no Git output survives
//     this module. The ledger keeps a hash; a reader entitled to paths reads them off the task.
//
// It is also strictly READ-ONLY. `ls-files` and `status` are plumbing-grade reads; nothing here
// fetches, writes a ref, stages anything, or touches the index. A probe that refreshed the
// index would rewrite the very state it was asked to observe.

/** The dominant timeout for a local git read in this daemon (diff, actions, pool all use it). */
const GIT_READ_TIMEOUT_MS = 15_000;

/**
 * Bytes of a single git command's stdout we are willing to take.
 *
 * `ls-files --stage -z` is one line per tracked path, so a million-file monorepo is a few tens
 * of megabytes; 64MB is comfortably past any real checkout and still far short of anything that
 * would threaten the daemon. Crossing it is not truncated - it is `unknown`, per property (2).
 */
const GIT_OUTPUT_LIMIT = 64 * 1024 * 1024;

/**
 * Bytes of ONE worktree file we will stream into the digest.
 *
 * Deliberately generous (1GB): the point of a limit here is to refuse the pathological case
 * loudly, not to sample. A file past it reports `unknown`, leaving the clock exactly where it
 * was, which is the conservative direction - the tree keeps living.
 */
const FILE_READ_LIMIT = 1024 * 1024 * 1024;

/** Bytes of diagnosis carried out of a failed probe. */
const REASON_LIMIT = 200;

/**
 * How many checkouts deep this will follow a nested repository before refusing.
 *
 * A submodule is its own checkout and gets its own full fingerprint (see `pathContentIdentity`),
 * and a submodule may itself contain one. The bound exists so a pathological chain cannot turn
 * one observation into an unbounded walk; past it the answer is `unknown`, which holds the tree
 * rather than declaring a depth nobody looked at to be quiet.
 */
const MAX_NESTED_CHECKOUT_DEPTH = 8;

/**
 * One worktree's, or one task's, Git-visible identity.
 *
 * `known` carries a hex digest and nothing else. `unknown` carries a short internal reason and
 * is the answer to every question this module cannot settle - see property (1) above.
 */
export type ActivityFingerprint =
  | { kind: "known"; digest: string }
  | { kind: "unknown"; reason: string };

function unknown(reason: string): ActivityFingerprint {
  return { kind: "unknown", reason: reason.slice(0, REASON_LIMIT) };
}

/** The subprocess and filesystem seam, so a test can drive the real logic without a repository. */
export interface WorktreeActivityDeps {
  /**
   * Stream one git command's stdout, chunk by chunk, and report how it ended.
   *
   * A streaming spawn rather than this daemon's buffered `run`: `run` resolves with the whole
   * of stdout in a string, and the two commands here are exactly the ones whose output scales
   * with repository size. Streaming lets `ls-files` go straight into the digest without ever
   * existing as a value, and lets `status` be refused at a byte count instead of at an 8MB
   * default that surfaces as an ordinary non-zero exit.
   */
  gitStream: (
    cwd: string,
    args: string[],
    onChunk: (chunk: Buffer) => void,
  ) => Promise<GitStreamResult>;
  /** `realpath`, so the recorded path can be proven to still BE the checkout it names. */
  realpath: (path: string) => Promise<string>;
  /** `lstat` without following links - a symlink must be hashed as a link, not as its target. */
  lstat: typeof lstat;
  readlink: (path: string) => Promise<string>;
  /** Stream one file's bytes into a digest. Refuses rather than truncates past `limit`. */
  hashFile: (path: string, hash: Hash, limit: number) => Promise<void>;
}

export interface GitStreamResult {
  code: number | null;
  /** stderr, bounded - only ever used to explain an `unknown`. */
  stderr: string;
  /** The command produced more than `GIT_OUTPUT_LIMIT` bytes and was killed. */
  overflowed: boolean;
  /** The child died rather than answering (timeout, signal, spawn refusal). */
  died: boolean;
}

function gitStream(
  cwd: string,
  args: string[],
  onChunk: (chunk: Buffer) => void,
): Promise<GitStreamResult> {
  return new Promise((resolve) => {
    let seen = 0;
    let overflowed = false;
    let stderr = "";
    let settled = false;
    let child: ReturnType<typeof spawn>;
    const finish = (result: GitStreamResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child?.kill("SIGKILL");
      finish({ code: null, stderr, overflowed, died: true });
    }, GIT_READ_TIMEOUT_MS);
    timer.unref?.();
    try {
      child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      finish({ code: null, stderr: String(err), overflowed: false, died: true });
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      seen += chunk.length;
      if (seen > GIT_OUTPUT_LIMIT) {
        // Past the bound the output is not trustworthy and there is no partial answer worth
        // keeping: stop reading, kill the child, and let the caller report `unknown`.
        overflowed = true;
        child.kill("SIGKILL");
        return;
      }
      if (!overflowed) onChunk(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < REASON_LIMIT) stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      finish({ code: null, stderr: String(err), overflowed, died: true });
    });
    child.on("close", (code, signal) => {
      finish({
        code,
        stderr: stderr.slice(0, REASON_LIMIT),
        overflowed,
        died: signal !== null && !overflowed,
      });
    });
  });
}

async function hashFileInto(path: string, hash: Hash, limit: number): Promise<void> {
  let seen = 0;
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    const buf = chunk as Buffer;
    seen += buf.length;
    // Refuse rather than truncate: a digest that stops changing once a file passes a cap is a
    // stable-looking fingerprint over a file somebody is actively writing.
    if (seen > limit) {
      stream.destroy();
      throw new Error("file exceeds the activity read limit");
    }
    hash.update(buf);
  }
}

export const defaultWorktreeActivityDeps: WorktreeActivityDeps = {
  gitStream,
  realpath,
  lstat,
  readlink,
  hashFile: hashFileInto,
};

/** Split NUL-delimited git output, dropping the empty tail every `-z` stream ends with. */
function splitNul(text: string): string[] {
  return text.split("\0").filter((entry) => entry !== "");
}

/**
 * The Git-visible fingerprint of ONE checkout.
 *
 * Four reads, in a fixed order, each feeding one labelled section of a single digest:
 *
 *  1. `rev-parse HEAD` - which commit this tree is on. An unborn HEAD (a branch with no commit
 *     yet) is a legitimate state and is recorded as such rather than refused; `rev-parse`
 *     failing for any OTHER reason is not distinguishable from it by exit code alone, so the
 *     repository is confirmed first (step 0) and only then is a failure here read as unborn.
 *  2. `ls-files --stage -z` - the COMPLETE index: mode, blob id, merge stage and path for every
 *     entry. This is what makes `git add` visible: staging changes an entry's blob id even
 *     though HEAD and the file on disk both stand still.
 *  3. `status --porcelain=v1 -z -uall --no-renames --ignored=no` - which paths differ in the
 *     worktree, plus every non-ignored untracked path. `--ignored=no` is the policy: a warm
 *     `node_modules` or a build cache must never keep a tree alive. `--no-renames` is a
 *     determinism choice, see the note on `parseStatus`.
 *  4. For each path status reported as changed IN THE WORKTREE or untracked, its current
 *     content identity - streamed file bytes, a symlink's target, or an explicit marker for a
 *     deletion, a directory or a submodule. Status alone cannot supply this: a file edited
 *     twice is ` M` both times.
 *
 * Step 0 comes before all of it: `rev-parse --show-toplevel` must resolve to the path we were
 * asked about. A recorded worktree that has been removed, replaced, or nested inside some other
 * repository is `unknown`, never "clean".
 */
export async function worktreeActivityFingerprint(
  worktreePath: string,
  deps: WorktreeActivityDeps = defaultWorktreeActivityDeps,
  depth = 0,
): Promise<ActivityFingerprint> {
  const hash = createHash("sha256");

  // 0. This path still IS the checkout it claims to be.
  let canonical: string;
  try {
    canonical = await deps.realpath(worktreePath);
  } catch {
    return unknown("worktree path is not readable");
  }
  const top = await capture(deps, worktreePath, ["rev-parse", "--show-toplevel"]);
  if (top.kind === "unknown") return unknown(top.reason);
  let canonicalTop: string;
  try {
    canonicalTop = await deps.realpath(top.text.trim());
  } catch {
    return unknown("worktree toplevel is not readable");
  }
  if (canonicalTop !== canonical) return unknown("path is not the root of its own checkout");

  // 1. HEAD.
  const head = await capture(deps, worktreePath, ["rev-parse", "HEAD"]);
  if (head.kind === "unknown") {
    // The repository answered step 0, so the only ordinary reason `rev-parse HEAD` fails here
    // is an unborn HEAD - a branch that exists with no commit on it. That is a real state a
    // fresh worktree can sit in, and it must fingerprint stably rather than pin the tree
    // forever on an `unknown`.
    if (head.exitFailure) hash.update("head:unborn\0");
    else return unknown(head.reason);
  } else {
    hash.update(`head:${head.text.trim()}\0`);
  }

  // 2. The complete index, streamed straight into the digest - never materialised.
  hash.update("index:\0");
  const index = await deps.gitStream(worktreePath, ["ls-files", "--stage", "-z"], (chunk) =>
    hash.update(chunk));
  if (index.overflowed) return unknown("index listing exceeded the safe output bound");
  if (index.died) return unknown("index listing did not complete");
  if (index.code !== 0) return unknown(`index listing failed: ${index.stderr.trim()}`);

  // 3. Worktree status.
  const status = await capture(deps, worktreePath, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--no-renames",
    "--ignored=no",
  ]);
  if (status.kind === "unknown") return unknown(status.reason);
  const entries = parseStatus(status.text);
  if (entries === null) return unknown("status output could not be parsed");

  // 4. Content identity for everything status says differs on disk.
  hash.update("worktree:\0");
  for (const entry of entries) {
    hash.update(`${entry.code}\0${entry.path}\0`);
    if (!entry.readContent) continue;
    const content = await pathContentIdentity(join(worktreePath, entry.path), deps, depth);
    if (content.kind === "unknown") return content;
    hash.update(`${content.digest}\0`);
  }
  return { kind: "known", digest: hash.digest("hex") };
}

/** One `git status -z` record: its two-letter code and the path it is about. */
interface StatusEntry {
  code: string;
  path: string;
  /** Whether the WORKTREE side of the code means "there are bytes on disk to identify". */
  readContent: boolean;
}

/**
 * Parse `--porcelain=v1 -z` records.
 *
 * `-z` and never a newline split: a filename may legally contain one, and a parser that splits
 * on newlines silently merges two paths into a nonsense entry - which then fingerprints
 * stably while real edits go unnoticed.
 *
 * `--no-renames` is passed so this never has to consume the second, origin-path record a
 * rename entry emits. That is a deliberate simplification and it costs nothing the policy
 * cares about: with detection off a rename is reported as a delete plus an add, both of which
 * change the fingerprint exactly as a rename would. What it buys is a record format with one
 * shape, so a malformed stream is detectable rather than an off-by-one that shifts every
 * subsequent path onto the wrong code.
 */
function parseStatus(text: string): StatusEntry[] | null {
  const records = splitNul(text);
  const entries: StatusEntry[] = [];
  for (const record of records) {
    // "XY <path>" - two status letters, one space, then the path verbatim.
    if (record.length < 4 || record[2] !== " ") return null;
    const code = record.slice(0, 2);
    const path = record.slice(3);
    const worktreeSide = code[1] ?? " ";
    // `D` is a deletion (nothing on disk to read, and the code itself is the change) and a
    // space means the worktree side is unchanged - the difference is staged, which the index
    // digest already carries. Everything else - modified, added, untracked, unmerged, typechange
    // - has bytes at that path whose identity is the only thing that distinguishes one edit
    // from the next.
    entries.push({ code, path, readContent: worktreeSide !== "D" && worktreeSide !== " " });
  }
  // Deterministic order regardless of locale or Git version, so two observations of an
  // unchanged tree cannot differ on ordering alone.
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

/**
 * What is at this path RIGHT NOW, as a digest.
 *
 * `lstat`, not `stat`: a symlink is hashed as its target string, because replacing a link's
 * target is a Git-visible change and following it would instead hash whatever it points at -
 * possibly outside the checkout entirely.
 *
 * A directory is a marker rather than a walk. Status with `-uall` already enumerates every
 * untracked FILE individually, so a directory reaching here is a submodule or a race, and
 * recursing would be a second, slower enumeration that disagrees with Git's.
 */
async function pathContentIdentity(
  path: string,
  deps: WorktreeActivityDeps,
  depth: number,
): Promise<{ kind: "known"; digest: string } | { kind: "unknown"; reason: string }> {
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await deps.lstat(path);
  } catch {
    // Status named it and it is gone: the tree changed under the read. Reporting `unknown`
    // leaves the clock untouched and the next pass sees a settled tree - which is right, since
    // a tree being written to is the opposite of an idle one.
    return { kind: "unknown", reason: "a listed path vanished during the read" };
  }
  if (stat.isSymbolicLink()) {
    try {
      const target = await deps.readlink(path);
      return { kind: "known", digest: createHash("sha256").update(`link:${target}`).digest("hex") };
    } catch {
      return { kind: "unknown", reason: "a symlink target could not be read" };
    }
  }
  if (stat.isDirectory()) {
    // A directory reaching here is a CHECKOUT, in both of the two ways status can produce one:
    // a submodule whose contents differ, and an untracked nested repository (`?? nested/`),
    // which Git reports as a single entry and refuses to descend into even with `-uall`.
    //
    // Both must be fingerprinted as the repositories they are. A constant digest here was a
    // real hole: once a submodule is dirty its parent's status stays ` M sub` and the parent's
    // gitlink stays put, so every later edit AND every commit inside it left the parent
    // fingerprint identical - an agent working steadily in a submodule looked exactly like an
    // abandoned tree, and a stable digest is what eventually authorizes deletion.
    //
    // Recursing gives the nested checkout the same four-part treatment as the top-level one -
    // its HEAD, its whole index, its tracked changes, its untracked files - so a commit inside
    // it moves the parent digest through the nested HEAD, and a dirty file through the nested
    // worktree section. Its own `.gitignore` still applies at its own level, so a submodule's
    // warm caches stay excluded exactly as the parent's are.
    if (depth >= MAX_NESTED_CHECKOUT_DEPTH) {
      return { kind: "unknown", reason: "nested checkouts are deeper than the probe follows" };
    }
    const nested = await worktreeActivityFingerprint(path, deps, depth + 1);
    if (nested.kind === "unknown") return nested;
    return { kind: "known", digest: `nested:${nested.digest}` };
  }
  if (!stat.isFile()) {
    // A fifo, socket or device is not something a digest can stand for, and pretending
    // otherwise would make it invisible to the clock forever.
    return { kind: "unknown", reason: "a path is not a regular file, link or directory" };
  }
  const hash = createHash("sha256");
  // The executable bit is Git-visible on its own: `chmod +x` with no content change is a
  // change, and every other stat field (size, mtime, inode) is deliberately excluded because
  // it moves without the content moving.
  hash.update(`file:${(stat.mode & 0o111) !== 0 ? "x" : "-"}:`);
  try {
    await deps.hashFile(path, hash, FILE_READ_LIMIT);
  } catch (err) {
    return { kind: "unknown", reason: `a file could not be read: ${String(err)}` };
  }
  return { kind: "known", digest: hash.digest("hex") };
}

/**
 * One small, bounded git read.
 *
 * `exitFailure` distinguishes "git ran and said no" from "we never got an answer", which is
 * the difference between an unborn HEAD and a broken repository - see step 1 above. Every
 * other caller treats both as `unknown` and does not have to look.
 */
type Captured =
  | { kind: "text"; text: string }
  | { kind: "unknown"; reason: string; exitFailure: boolean };

async function capture(
  deps: WorktreeActivityDeps,
  cwd: string,
  args: string[],
): Promise<Captured> {
  const chunks: Buffer[] = [];
  const result = await deps.gitStream(cwd, args, (chunk) => chunks.push(chunk));
  const fail = (reason: string, exitFailure = false): Captured => ({
    kind: "unknown",
    reason: reason.slice(0, REASON_LIMIT),
    exitFailure,
  });
  if (result.overflowed) return fail(`git ${args[0]} exceeded the safe output bound`);
  if (result.died) return fail(`git ${args[0]} did not complete`);
  if (result.code !== 0) {
    return fail(`git ${args[0]} exit ${result.code}: ${result.stderr.trim()}`, true);
  }
  return { kind: "text", text: Buffer.concat(chunks).toString("utf8") };
}

/**
 * ONE fingerprint for a whole task, across its primary and every attached repository.
 *
 * Combined in persisted repository-position order - `taskRepoRefs`' order - because the
 * approved policy gives a task ONE retention boundary: whichever tree moved most recently
 * protects the whole set. Position is included in the digest alongside the path so that
 * attaching a second repository is itself a change rather than a silent reshuffle.
 *
 * Any single tree reporting `unknown` makes the aggregate `unknown`. There is no partial
 * answer worth persisting: a digest over three of four checkouts is stable while the fourth
 * is being worked in.
 */
export async function taskActivityFingerprint(
  task: TaskRepoSource,
  deps: WorktreeActivityDeps = defaultWorktreeActivityDeps,
): Promise<ActivityFingerprint> {
  const refs = taskRepoRefs(task).filter(
    (ref): ref is TaskRepoRef & { worktreePath: string } => ref.worktreePath !== null,
  );
  if (refs.length === 0) return unknown("task holds no worktree");
  const hash = createHash("sha256");
  for (const ref of refs) {
    const one = await worktreeActivityFingerprint(ref.worktreePath, deps);
    if (one.kind === "unknown") return one;
    hash.update(`${ref.position}\0${ref.worktreePath}\0${one.digest}\0`);
  }
  return { kind: "known", digest: hash.digest("hex") };
}
