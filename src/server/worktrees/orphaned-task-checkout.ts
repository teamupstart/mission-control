import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { ORPHANED_WORKTREE_RECLAIM_FLAG_ID } from "@shared/feature-flag-registry.ts";
import type { TaskRepoRef } from "@shared/task-repos.ts";
import { envVar } from "../config.ts";
import { featureEnabled } from "../feature-flags/index.ts";
import { isolatedGitEnvironment } from "../git/worktree-tree.ts";
import { run, type RunResult } from "../util/exec.ts";
import { observeWorktreeLink } from "./orphan.ts";

// Positive, read-only evidence about a disposable task checkout that Git no longer knows.
//
// A re-clone of the main checkout leaves every disposable task checkout with a `.git` file
// that names `<repo>/.git/worktrees/<taskId>`, an administrative directory the new clone never
// created. Every Git command run inside such a checkout fails, so the ordinary activity probe
// answers `unknown` and the retention ledger holds it for ever. That `unknown` is correct and
// stays: this module adds a separate, narrow finding beside it, modelled on the native
// "Orphaned slots" rules in docs/worktrees-and-checks.md.
//
// Three properties are load-bearing, because the retention sweep deletes directories on them:
//
//  1. **Only a positive finding counts.** The exact task slot path, provider `git`, no symbolic
//     link at or above the slot, a regular-file `.git` whose administrative directory is
//     verifiably absent and sits in the recorded repository's own `worktrees` directory, and a
//     `git worktree list` that answered and does not name it. Any read that fails is
//     `unproven`, which authorizes nothing.
//  2. **The user's repository is never written.** Every comparison runs in a throwaway bare
//     repository under the system temp directory that borrows the recorded repository's
//     objects through `objects/info/alternates`, with its own index file. A pull request head
//     the repository lacks is fetched into that scratch repository, never into the user's.
//  3. **Only the work-tree column counts.** The scratch index is read from the proof commit, so
//     status column 1 would compare it with a HEAD that means nothing here. Only the work-tree
//     column and untracked files say how the checkout differs from the commit.

/** Ignored directories an orphan may carry without holding: every one of them is rebuilt. */
export const REGENERABLE_IGNORED_DIRECTORIES: readonly string[] = [
  "node_modules", "dist", "test-results", ".evidence", ".pipeline",
];
/** Directory names starting with this are scratch output and are regenerable too. */
export const REGENERABLE_IGNORED_PREFIX = ".tmp";

const GIT_TIMEOUT_MS = 60_000;
const GIT_OUTPUT_LIMIT = 64 * 1024 * 1024;
const FILE_READ_LIMIT = 1024 * 1024 * 1024;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Read on every call so a flag switched off in Settings applies to the next decision. */
export function worktreeCleanupReportOnly(value = envVar("WORKTREE_CLEANUP_PREVIEW")): boolean {
  return Boolean(value && value !== "enforce");
}

/**
 * Whether orphaned checkouts and provably absent terminal homes are evaluated, and whether
 * they may be removed. `report-only` evaluates them with read-only evidence whatever the flag
 * says, which is what lets an operator preview the class before switching it on.
 */
export type OrphanReclaimMode = "off" | "report-only" | "enforce";

export function orphanedWorktreeReclaimMode(): OrphanReclaimMode {
  if (worktreeCleanupReportOnly()) return "report-only";
  return featureEnabled(ORPHANED_WORKTREE_RECLAIM_FLAG_ID) ? "enforce" : "off";
}

/** What a checkout is, as far as this class is concerned. */
export type TaskCheckoutClass =
  /** Anything this module does not positively recognize. The ordinary rules apply to it. */
  | { kind: "registered" }
  /** Nothing is at the exact slot path, and the place it would be is physical. */
  | { kind: "absent" }
  /**
   * A positively proven orphan. `commonDir` is the recorded repository's Git directory and
   * `gitDir` the absent administrative directory its `.git` file names.
   */
  | { kind: "orphaned"; commonDir: string; gitDir: string }
  /** It looks like an orphan, but a proof step failed. Held with this bounded reason. */
  | { kind: "unproven"; reason: string };

/** One file only this checkout holds. Paths are checkout-relative and Git-style (`/`). */
export interface LocalOnlyFile {
  path: string;
  sha256: string;
  bytes: number;
}

export type OrphanComparison =
  | {
      kind: "compared";
      /** Changes whenever tracked or non-ignored untracked content changes. Ignored churn does not. */
      digest: string;
      localOnly: LocalOnlyFile[];
      /** Tracked files missing from the checkout. Their content is in the proof commit. */
      deletedTracked: number;
      /** Set when an ignored entry is outside the regenerable directories. */
      ignoredBlocker: string | null;
    }
  | { kind: "unknown"; reason: string };

/** The pull request the daemon recorded for this task in this repository. */
export interface RecordedPullRequest {
  url: string;
  headSha: string | null;
  merged: boolean;
}

export type RecordedPullRequestLookup = RecordedPullRequest | null | "ambiguous";

/** The return decision's evidence for one checkout. */
export type OrphanReturnEvidence =
  | { kind: "registered" }
  | { kind: "absent" }
  | { kind: "held"; reason: string }
  | {
      kind: "orphaned";
      /** `base` and `merged-pr` are exact matches; `local-only` needs its files archived. */
      proof: "base" | "merged-pr" | "local-only";
      commit: string;
      localOnly: LocalOnlyFile[];
    };

function bounded(reason: string): string {
  return reason.slice(0, 200);
}

function answered(result: RunResult): boolean {
  return result.code === 0 && !result.outcomeUnknown && !result.overflowed;
}

/** Every Git call here: no optional locks, no fsmonitor, no inherited repository selectors. */
function isolatedGit(args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<RunResult> {
  return run("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args], {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
    maxBuffer: GIT_OUTPUT_LIMIT,
    env: isolatedGitEnvironment({ GIT_TERMINAL_PROMPT: "0", ...extraEnv }),
  });
}

/** What a diagnostics response says is on disk at a checkout, read without Git. */
export type CheckoutDiagnosticClass = "registered" | "absent" | "dangling-link" | "no-link";

/**
 * What is on disk at one checkout right now, for `GET /api/worktrees`. Derived per response
 * from the filesystem alone, never cached, so it cannot describe an earlier task that used the
 * same slot. It is evidence for a reader, not a proof: `dangling-link` is what an orphan looks
 * like, and the retention blocker on the same row says whether the full proof passed.
 */
export async function checkoutDiagnosticClass(ref: TaskRepoRef, slotPath: string): Promise<CheckoutDiagnosticClass> {
  if (ref.provider !== "git" || !ref.worktreePath || ref.worktreePath !== slotPath) return "registered";
  const link = await observeWorktreeLink(slotPath);
  if (!link) return "registered";
  return link.kind === "absent" ? "absent" : link.kind;
}

/**
 * Classify one checkout. Read-only. `slotPath` is the exact path the git fallback derives for
 * this task and position (`worktreeSlotPath`); the caller supplies it so this module never
 * re-derives the layout.
 */
export async function classifyTaskCheckout(ref: TaskRepoRef, slotPath: string): Promise<TaskCheckoutClass> {
  if (ref.provider !== "git" || !ref.worktreePath || ref.worktreePath !== slotPath) return { kind: "registered" };
  const link = await observeWorktreeLink(slotPath);
  if (!link) return { kind: "registered" };
  if (link.kind === "absent") {
    // A slot that is gone because an earlier removal set it aside and could not finish is not
    // gone: its files are beside it under a private name, and completing the row would forget
    // them. It stays held until that directory is resolved.
    const aside = await setAsideEntries(slotPath);
    if (aside === null) return { kind: "unproven", reason: "the checkout's parent directory could not be read" };
    if (aside.length > 0) return { kind: "unproven", reason: "an earlier removal left this checkout set aside" };
    return { kind: "absent" };
  }
  if (link.kind === "no-link") return { kind: "unproven", reason: "orphaned checkout has no Git link file" };

  const common = await isolatedGit(["-C", ref.repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"], ref.repoRoot);
  const commonText = common.stdout.trim();
  if (!answered(common) || !commonText) return { kind: "unproven", reason: "recorded repository could not be read" };
  let commonDir: string;
  try {
    commonDir = await realpath(commonText);
  } catch {
    return { kind: "unproven", reason: "recorded repository could not be read" };
  }
  const adminParent = resolve(dirname(link.gitDir));
  if (adminParent !== join(commonDir, "worktrees") && adminParent !== join(resolve(commonText), "worktrees")) {
    return { kind: "unproven", reason: "orphaned checkout links to a different repository" };
  }
  // Git names a linked worktree's administrative directory after the checkout's own directory,
  // which for a task slot is the task's id (and position). A link naming any other entry - a
  // sibling task's, or a de-duplicated name Git chose - is not provably this task's checkout.
  if (!linkNamesSlot(link.gitDir, slotPath)) {
    return { kind: "unproven", reason: "orphaned checkout links to another task's worktree" };
  }
  const listed = await isolatedGit(["-C", ref.repoRoot, "worktree", "list", "--porcelain", "-z"], ref.repoRoot);
  if (!answered(listed)) return { kind: "unproven", reason: "Git worktree registration could not be read" };
  const registered = listed.stdout.split("\0").filter((line) => line.startsWith("worktree "))
    .map((line) => resolve(line.slice("worktree ".length)));
  if (registered.includes(resolve(slotPath))) return { kind: "unproven", reason: "Git still lists this checkout" };
  // Re-read: the link must still dangle after the registration list answered.
  const again = await observeWorktreeLink(slotPath);
  if (again?.kind !== "dangling-link" || again.gitDir !== link.gitDir) {
    return { kind: "unproven", reason: "orphaned checkout changed while it was read" };
  }
  return { kind: "orphaned", commonDir, gitDir: link.gitDir };
}

interface Scratch {
  dir: string;
  gitDir: string;
  indexFile: string;
}

/** A throwaway bare repository borrowing `commonDir`'s objects. Removed when `fn` settles. */
async function withScratch<T>(commonDir: string, fn: (scratch: Scratch) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "mission-orphan-proof-"));
  try {
    const gitDir = join(dir, "repo.git");
    const init = await isolatedGit(["init", "--bare", "-q", gitDir], dir);
    if (!answered(init)) throw Object.assign(new Error("scratch repository could not be created"), { scratch: true });
    await mkdir(join(gitDir, "objects", "info"), { recursive: true });
    await writeFile(join(gitDir, "objects", "info", "alternates"), `${join(commonDir, "objects")}\n`);
    return await fn({ dir, gitDir, indexFile: join(dir, "index") });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function scratchGit(scratch: Scratch, args: string[], workTree?: string): Promise<RunResult> {
  return isolatedGit([`--git-dir=${scratch.gitDir}`, ...(workTree ? [`--work-tree=${workTree}`] : []), ...args],
    scratch.dir, { GIT_INDEX_FILE: scratch.indexFile });
}

async function commitPresent(scratch: Scratch, commit: string): Promise<boolean | null> {
  const result = await scratchGit(scratch, ["cat-file", "-e", `${commit}^{commit}`]);
  if (result.outcomeUnknown) return null;
  return result.code === 0;
}

/** An ignored path is tolerated only inside a regenerable directory. */
export function regenerableIgnoredPath(path: string): boolean {
  const directory = path.endsWith("/");
  const parts = path.replace(/\/+$/, "").split("/");
  const directories = directory ? parts : parts.slice(0, -1);
  return directories.some((part) =>
    REGENERABLE_IGNORED_DIRECTORIES.includes(part) || part.startsWith(REGENERABLE_IGNORED_PREFIX));
}

async function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += (chunk as Buffer).length;
    if (bytes > FILE_READ_LIMIT) throw new Error("file exceeds the read limit");
    hash.update(chunk as Buffer);
  }
  return { sha256: hash.digest("hex"), bytes };
}

/** Compare a checkout's content with one commit, inside an existing scratch repository. */
async function compareWith(scratch: Scratch, worktreePath: string, commit: string): Promise<OrphanComparison> {
  const unknown = (reason: string): OrphanComparison => ({ kind: "unknown", reason: bounded(reason) });
  const present = await commitPresent(scratch, commit);
  if (present === null) return unknown("orphaned checkout comparison commit could not be read");
  if (!present) return unknown("orphaned checkout comparison commit is unavailable");
  const tree = await scratchGit(scratch, ["ls-tree", "-r", "-z", "--full-tree", commit]);
  if (!answered(tree)) return unknown("orphaned checkout comparison tree could not be read");
  if (tree.stdout.split("\0").some((record) => record.startsWith("160000 "))) {
    return unknown("orphaned checkout comparison commit has submodules");
  }
  if (!answered(await scratchGit(scratch, ["update-ref", "--no-deref", "HEAD", commit]))) {
    return unknown("orphaned checkout comparison could not be prepared");
  }
  if (!answered(await scratchGit(scratch, ["read-tree", commit]))) {
    return unknown("orphaned checkout comparison index could not be prepared");
  }
  const status = await scratchGit(scratch, ["status", "--porcelain=v1", "-z", "--untracked-files=all",
    "--no-renames", "--ignored=matching", "--ignore-submodules=none"], worktreePath);
  if (!answered(status)) return unknown("orphaned checkout content could not be compared");

  // `run` decodes stdout as UTF-8; a path that did not survive that decode carries U+FFFD and
  // is refused below rather than approximated, because a lossy name could name another file.
  const localOnly: LocalOnlyFile[] = [];
  const entries: string[] = [];
  let deletedTracked = 0;
  let ignoredBlocker: string | null = null;
  for (const record of status.stdout.split("\0").filter(Boolean)) {
    if (record.length < 4 || record[2] !== " ") return unknown("orphaned checkout status could not be parsed");
    const code = record.slice(0, 2);
    const path = record.slice(3);
    if (path.includes("\uFFFD")) {
      return unknown("orphaned checkout holds a path that is not representable as text");
    }
    if (code === "!!") {
      if (!regenerableIgnoredPath(path)) ignoredBlocker = "orphaned checkout holds ignored files outside regenerable directories";
      continue;
    }
    const worktreeSide = code[1];
    if (code === "??" || worktreeSide === "M" || worktreeSide === "T") {
      if (path.endsWith("/")) return unknown("orphaned checkout holds a nested repository");
      const absolute = join(worktreePath, path);
      let info: Awaited<ReturnType<typeof lstat>>;
      try {
        info = await lstat(absolute);
      } catch {
        return unknown("a listed path vanished during the read");
      }
      if (!info.isFile()) return unknown("orphaned checkout holds local-only content that is not an ordinary file");
      let content: { sha256: string; bytes: number };
      try {
        content = await hashFile(absolute);
      } catch {
        return unknown("orphaned checkout holds a file that could not be read");
      }
      localOnly.push({ path, ...content });
      entries.push(`${code}\0${path}\0${(info.mode & 0o111) !== 0 ? "x" : "-"}${content.sha256}`);
    } else if (worktreeSide === "D") {
      deletedTracked += 1;
      entries.push(`${code}\0${path}`);
    } else if (worktreeSide !== " ") {
      return unknown("orphaned checkout status is not understood");
    }
  }
  entries.sort();
  localOnly.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const digest = createHash("sha256").update(`orphan:${commit}\0`).update(entries.join("\0")).digest("hex");
  return { kind: "compared", digest, localOnly, deletedTracked, ignoredBlocker };
}

/** Compare a proven orphan with one commit. Read-only; creates and removes its own scratch. */
export async function compareOrphanedCheckout(
  worktreePath: string,
  commonDir: string,
  commit: string,
): Promise<OrphanComparison> {
  if (!OBJECT_ID.test(commit)) return { kind: "unknown", reason: "orphaned checkout has no recorded base commit" };
  try {
    return await withScratch(commonDir, (scratch) => compareWith(scratch, worktreePath, commit));
  } catch {
    return { kind: "unknown", reason: "orphaned checkout comparison could not be prepared" };
  }
}

/** The pull request number in a GitHub pull request URL, or null. */
function pullRequestNumber(url: string): number | null {
  const match = url.match(/\/pull\/(\d+)(?:[/?#]|$)/);
  return match ? Number(match[1]) : null;
}

/**
 * Make `commit` available in the scratch repository, fetching it from the recorded
 * repository's origin when it is not already borrowed. Never writes the user's repository.
 */
async function ensureCommit(
  scratch: Scratch,
  repoRoot: string,
  pr: RecordedPullRequest & { headSha: string },
  fetchRemote: boolean,
): Promise<boolean> {
  if (await commitPresent(scratch, pr.headSha)) return true;
  if (!fetchRemote) return false;
  const remote = await isolatedGit(["-C", repoRoot, "config", "--get", "remote.origin.url"], repoRoot);
  const url = remote.stdout.trim();
  if (!answered(remote) || !url) return false;
  const number = pullRequestNumber(pr.url);
  const refspecs = [...(number ? [`+refs/pull/${number}/head:refs/orphan-proof/pr`] : []), pr.headSha];
  for (const refspec of refspecs) {
    const fetched = await scratchGit(scratch, ["fetch", "--no-tags", "--no-recurse-submodules", "--quiet", url, refspec]);
    if (answered(fetched) && await commitPresent(scratch, pr.headSha)) return true;
  }
  return false;
}

/**
 * Everything the return decision needs for one checkout, gathered read-only.
 *
 * The proof order is the contract. Equality with the recorded base needs nothing else. If the
 * content differs and the daemon recorded a MERGED pull request for this branch, the content is
 * compared with that pull request's head, fetched into scratch when the repository lacks it;
 * an unreadable head holds. Whatever matches neither is local-only work, returned so the
 * caller can archive it before anything is removed. Ignored entries outside the regenerable
 * directories hold, whatever the proof.
 */
export async function orphanedCheckoutEvidence(input: {
  ref: TaskRepoRef;
  slotPath: string;
  fetchRemote: boolean;
  pullRequest: () => RecordedPullRequestLookup;
}): Promise<OrphanReturnEvidence> {
  const { ref } = input;
  const checkout = await classifyTaskCheckout(ref, input.slotPath);
  if (checkout.kind === "registered" || checkout.kind === "absent") return checkout;
  if (checkout.kind === "unproven") return { kind: "held", reason: checkout.reason };
  const base = ref.baseSha;
  if (!base || !OBJECT_ID.test(base)) return { kind: "held", reason: "orphaned checkout has no recorded base commit" };
  try {
    return await withScratch(checkout.commonDir, async (scratch): Promise<OrphanReturnEvidence> => {
      const against = await compareWith(scratch, input.slotPath, base);
      if (against.kind === "unknown") return { kind: "held", reason: against.reason };
      if (against.ignoredBlocker) return { kind: "held", reason: against.ignoredBlocker };
      if (against.localOnly.length === 0 && against.deletedTracked === 0) {
        return { kind: "orphaned", proof: "base", commit: base, localOnly: [] };
      }
      const pr = input.pullRequest();
      if (pr === "ambiguous") return { kind: "held", reason: "orphaned checkout pull request record is ambiguous" };
      if (!pr?.merged) return { kind: "orphaned", proof: "local-only", commit: base, localOnly: against.localOnly };
      if (!pr.headSha || !OBJECT_ID.test(pr.headSha)) {
        return { kind: "held", reason: "merged pull request head commit was not recorded" };
      }
      const head = pr.headSha;
      if (!(await ensureCommit(scratch, ref.repoRoot, { ...pr, headSha: head }, input.fetchRemote))) {
        return { kind: "held", reason: input.fetchRemote
          ? "merged pull request head could not be fetched"
          : "merged pull request head is not available locally" };
      }
      const merged = await compareWith(scratch, input.slotPath, head);
      if (merged.kind === "unknown") return { kind: "held", reason: merged.reason };
      if (merged.ignoredBlocker) return { kind: "held", reason: merged.ignoredBlocker };
      return merged.localOnly.length === 0 && merged.deletedTracked === 0
        ? { kind: "orphaned", proof: "merged-pr", commit: head, localOnly: [] }
        : { kind: "orphaned", proof: "local-only", commit: head, localOnly: merged.localOnly };
    });
  } catch {
    return { kind: "held", reason: "orphaned checkout comparison could not be prepared" };
  }
}

/**
 * The activity fingerprint of one checkout of this class, or null for a checkout the ordinary
 * probe owns. An absent checkout fingerprints as a constant: nothing there can change.
 */
export async function orphanedCheckoutFingerprint(
  ref: TaskRepoRef,
  slotPath: string,
): Promise<{ kind: "known"; digest: string } | { kind: "unknown"; reason: string } | null> {
  const checkout = await classifyTaskCheckout(ref, slotPath);
  if (checkout.kind === "registered") return null;
  if (checkout.kind === "absent") return { kind: "known", digest: createHash("sha256").update("absent-checkout").digest("hex") };
  if (checkout.kind === "unproven") return { kind: "unknown", reason: checkout.reason };
  const compared = await compareOrphanedCheckout(slotPath, checkout.commonDir, ref.baseSha ?? "");
  return compared.kind === "compared" ? { kind: "known", digest: compared.digest } : compared;
}

/** The private name prefix a removal sets a slot aside under. */
function setAsidePrefix(slotPath: string): string {
  return `.${basename(slotPath)}.reclaim-`;
}

/** Entries an earlier removal left set aside beside this slot, or null if the parent is unreadable. */
async function setAsideEntries(slotPath: string): Promise<string[] | null> {
  try {
    const prefix = setAsidePrefix(slotPath);
    return (await readdir(dirname(slotPath))).filter((name) => name.startsWith(prefix));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : null;
  }
}

/** Whether a `.git` link's administrative directory is the one Git would name for this slot. */
function linkNamesSlot(gitDir: string, slotPath: string): boolean {
  return basename(resolve(gitDir)) === basename(slotPath);
}

/**
 * Delete the exact slot directory of a proven orphan, or report that nothing is there.
 *
 * Git cannot remove what it does not know, so this is a recursive delete of the slot path. The
 * order is the safety argument:
 *
 *  1. Prove the orphan in full - including that its link names this task's own administrative
 *     directory - and require the content digest the cleanup claim was taken against, with no
 *     ignored file outside the regenerable directories.
 *  2. Check process occupancy at the slot, so a checkout somebody is in is never moved.
 *  3. Rename the slot, atomically and within its own parent, to a private name. From here
 *     nothing can reach it by the slot path, so nothing can add a file to it or swap it out
 *     unseen. The verification below therefore describes exactly what `rm` will delete.
 *  4. On the set-aside directory: check occupancy (a process inside moved with it), re-read the
 *     content against the claimed digest and the ignored-file rule, and require the link to
 *     name the proven administrative directory. Then check occupancy once more: it is the last
 *     awaited step before the delete.
 *  5. Delete it. Any refusal in step 4 renames it back to the slot first, and so does a delete
 *     that fails part-way, so the task keeps tracking whatever is left. If even that rename
 *     fails, the slot is never classified absent while the set-aside directory remains (see
 *     `classifyTaskCheckout`), so the ledger row cannot complete over it.
 *
 * Throws with a bounded reason on any refusal; the caller keeps the task's record of the
 * checkout.
 */
export async function removeOrphanedTaskCheckout(
  ref: TaskRepoRef,
  slotPath: string,
  /** The per-checkout digest the cleanup claim was taken against. */
  expectedDigest: string | undefined,
  occupied: (path: string) => Promise<string | null>,
  /** The recursive delete. A seam so a test can make it fail after the rename. */
  remove: (path: string) => Promise<void> = (path) => rm(path, { recursive: true, maxRetries: 2 }),
): Promise<"removed" | "absent"> {
  const changed = "orphaned checkout changed before its removal";
  const before = await classifyTaskCheckout(ref, slotPath);
  if (before.kind === "absent") return "absent";
  if (before.kind !== "orphaned") throw new Error(before.kind === "unproven" ? before.reason : changed);
  if (!expectedDigest) throw new Error("orphaned checkout has no claimed fingerprint");
  const unchanged = (content: OrphanComparison): string | null => {
    if (content.kind !== "compared") return changed;
    if (content.ignoredBlocker) return content.ignoredBlocker;
    return content.digest === expectedDigest ? null : changed;
  };
  const proven = unchanged(await compareOrphanedCheckout(slotPath, before.commonDir, ref.baseSha ?? ""));
  if (proven) throw new Error(proven);
  const blocker = await occupied(slotPath);
  if (blocker) throw new Error(blocker);

  const aside = join(dirname(slotPath), `${setAsidePrefix(slotPath)}${randomUUID()}`);
  try {
    await rename(slotPath, aside);
  } catch {
    throw new Error("orphaned checkout could not be set aside for removal");
  }
  const restore = async (reason: string): Promise<never> => {
    try {
      await rename(aside, slotPath);
    } catch {
      throw new Error(`${reason}; the checkout was kept beside its slot`);
    }
    throw new Error(reason);
  };
  const refusal = await (async (): Promise<string | null> => {
    const inside = await occupied(aside);
    if (inside) return inside;
    const content = unchanged(await compareOrphanedCheckout(aside, before.commonDir, ref.baseSha ?? ""));
    if (content) return content;
    const link = await observeWorktreeLink(aside);
    if (link?.kind !== "dangling-link" || link.gitDir !== before.gitDir) return changed;
    return occupied(aside);
  })();
  if (refusal) return restore(refusal);
  try {
    await remove(aside);
  } catch {
    return restore("orphaned checkout removal failed");
  }
  try {
    await lstat(aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "removed";
  }
  return restore("orphaned checkout removal could not be verified");
}
