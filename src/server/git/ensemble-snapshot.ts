import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../util/exec.ts";

// Turning a live agent's working tree into an artifact you can compare, keep, and put back.
//
// The hard requirement is that capturing an agent's work must not DISTURB it. A member may
// be mid-task with a carefully staged index, an amended commit, or a rebase behind it; a
// capture that ran `git add`/`git commit` through the real index would rewrite the split
// between staged and unstaged, move the branch, and turn "we looked at your work" into "we
// edited your work". So everything here writes through a TEMPORARY index and reads the
// worktree, and the only ref it ever moves is one in our own generated namespace.
//
// The artifact is an ordinary commit, which is what makes it survive: the worktree it came
// from can be torn down, the branch deleted and the pool lease returned, and the tree is
// still exactly reproducible from the ref, because refs (unlike HEAD) live in the shared
// git dir that every linked worktree of a repo has in common.

/** The namespace every captured artifact lives under. */
export const ENSEMBLE_REF_PREFIX = "refs/mission-control/ensembles";

/** How much patch text one materialization returns before it starts telling you it stopped. */
export const DEFAULT_MAX_PATCH_BYTES = 400 * 1024;

/**
 * Buffer for the patch subprocess. Generous rather than tuned: exceeding it is not a
 * truncation we can report honestly (we would not know how much was left), so it is a
 * refusal, and a refusal should only ever happen for a genuinely absurd diff.
 */
const PATCH_MAX_BUFFER = 256 * 1024 * 1024;

/** A full commit id, which is the only form any function here accepts. */
const SHA = /^[0-9a-f]{40}$/;
/** A generated id - what every ref component must be. Never operator or agent text. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function requireSha(label: string, value: string): string {
  if (!SHA.test(value)) throw new Error(`${label} must be a full 40-character commit id, got "${value}"`);
  return value;
}

function requireGeneratedId(label: string, value: string): string {
  if (!UUID.test(value)) throw new Error(`${label} must be a generated UUID, got "${value}"`);
  return value;
}

/**
 * Where one captured artifact lives.
 *
 * Both components are validated as generated UUIDs before they reach a ref name, and that
 * is a boundary rather than a formality: a ref name is passed to `update-ref`, so anything
 * that could carry `../` or a caller's own text would let one artifact's capture move
 * another's ref - or something outside our namespace entirely.
 */
export function ensembleSnapshotRef(ensembleId: string, artifactId: string): string {
  return `${ENSEMBLE_REF_PREFIX}/${requireGeneratedId("ensembleId", ensembleId)}/${requireGeneratedId("artifactId", artifactId)}`;
}

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): ReturnType<typeof run> {
  return run("git", ["-C", cwd, ...args], { timeoutMs: 60_000, env });
}

/** `git` failing is never a partial answer here - say which step, and say what git said. */
function requireOk(step: string, r: Awaited<ReturnType<typeof run>>): string {
  if (r.code !== 0) throw new Error(`${step} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  return r.stdout.trim();
}

export interface CapturedSnapshot {
  /** The ref that keeps this commit alive after its worktree is gone. */
  ref: string;
  /** The immutable artifact commit. */
  snapshotSha: string;
  /** Its tree - the complete submitted worktree. */
  treeSha: string;
  /** The member's own HEAD at capture, and the snapshot's parent. Null on an unborn branch. */
  parentSha: string | null;
}

/**
 * Capture a worktree - tracked edits, staged and unstaged alike, deletions, renames and
 * every nonignored untracked file - as one immutable commit under a generated ref.
 *
 * The algorithm is the whole design:
 *
 *   1. a temporary index file, pointed at by `GIT_INDEX_FILE` for these subprocesses ONLY;
 *   2. `read-tree HEAD` seeds it with what the member has committed;
 *   3. `add -A` stages the working tree over that - which is what folds the member's staged
 *      and unstaged edits into one picture, and what includes untracked files while still
 *      honouring `.gitignore`, so a warm `node_modules` is not the artifact;
 *   4. `write-tree` turns that index into a tree object;
 *   5. `commit-tree` parents it on the member's HEAD without moving any branch;
 *   6. `update-ref` names it in our namespace;
 *   7. the ref is read back and re-resolved before this returns.
 *
 * Step 1 is why the member's real `.git/index` is byte-identical afterwards, and steps 5-6
 * are why HEAD, the branch and the working tree are too. Nothing here writes into the
 * worktree at all.
 *
 * Identity is supplied rather than read from config: `commit-tree` refuses to run without
 * a `user.email`, and whether the operator happens to have set one globally is not a
 * reason for a capture to fail.
 */
export async function captureWorktreeSnapshot(input: {
  worktreePath: string;
  ensembleId: string;
  artifactId: string;
}): Promise<CapturedSnapshot> {
  const ref = ensembleSnapshotRef(input.ensembleId, input.artifactId);
  const { worktreePath } = input;

  // Outside the worktree on purpose: a stray index inside it would show up as untracked
  // content in the very snapshot we are taking.
  const indexDir = mkdtempSync(join(tmpdir(), "mission-snapshot-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_INDEX_FILE: join(indexDir, "index"),
    GIT_AUTHOR_NAME: "Mission Control",
    GIT_AUTHOR_EMAIL: "mission-control@localhost",
    GIT_COMMITTER_NAME: "Mission Control",
    GIT_COMMITTER_EMAIL: "mission-control@localhost",
  };
  // An INHERITED repository pointer would beat `-C`, so a daemon that happened to be
  // started from inside a git operation would capture somebody else's tree into our ref -
  // and it would look like it worked. Cheap to rule out, unpleasant to diagnose.
  for (const inherited of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY"]) {
    delete env[inherited];
  }

  try {
    const head = await git(worktreePath, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], env);
    const parentSha = head.code === 0 && SHA.test(head.stdout.trim()) ? head.stdout.trim() : null;

    // An unborn branch is a real state (a freshly `git init`ed tree), and it snapshots fine -
    // there is simply nothing to seed the index with and no parent to give the commit.
    requireOk(
      "git read-tree",
      await git(worktreePath, parentSha ? ["read-tree", parentSha] : ["read-tree", "--empty"], env),
    );
    requireOk("git add -A", await git(worktreePath, ["add", "-A"], env));
    const treeSha = requireSha(
      "the tree from git write-tree",
      requireOk("git write-tree", await git(worktreePath, ["write-tree"], env)),
    );

    const message = `mission-control ensemble snapshot ${input.ensembleId} ${input.artifactId}`;
    const snapshotSha = requireSha(
      "the commit from git commit-tree",
      requireOk(
        "git commit-tree",
        await git(
          worktreePath,
          ["commit-tree", treeSha, ...(parentSha ? ["-p", parentSha] : []), "-m", message],
          env,
        ),
      ),
    );

    requireOk("git update-ref", await git(worktreePath, ["update-ref", ref, snapshotSha], env));

    // Read it back before claiming it exists. Everything downstream - evaluation, restore,
    // finalization - trusts that this ref resolves to this commit, and the one moment we can
    // cheaply prove it is now.
    const stored = requireOk(
      "git rev-parse (verifying the snapshot ref)",
      await git(worktreePath, ["rev-parse", "--verify", `${ref}^{commit}`], env),
    );
    if (stored !== snapshotSha) {
      throw new Error(`snapshot ref ${ref} resolved to ${stored}, expected ${snapshotSha}`);
    }

    return { ref, snapshotSha, treeSha, parentSha };
  } finally {
    // The index file is scratch, and leaving it behind would leak a tree-sized file per
    // capture into the temp dir. `finally` rather than a success path: a failed capture is
    // exactly when the file is largest and least wanted.
    rmSync(indexDir, { recursive: true, force: true });
  }
}

/** Where a snapshot ref points now, or null when it is gone. */
export async function resolveEnsembleRef(repoPath: string, ref: string): Promise<string | null> {
  if (!ref.startsWith(`${ENSEMBLE_REF_PREFIX}/`)) {
    throw new Error(`${ref} is not a Mission Control ensemble ref`);
  }
  const r = await git(repoPath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  const sha = r.stdout.trim();
  if (r.code === 0 && SHA.test(sha)) return sha;
  if (r.code === 1 && !r.outcomeUnknown && r.stderr.trim() === "") return null;
  throw new Error(`git rev-parse failed: ${r.stderr.trim() || `exit ${r.code}`}`);
}

export interface SnapshotFileStat {
  path: string;
  /** Where the file came from, when this change is a rename. */
  oldPath: string | null;
  insertions: number;
  deletions: number;
  /** git reported no line counts, because there are none to report. */
  binary: boolean;
}

export interface SnapshotDiff {
  baseSha: string;
  snapshotSha: string;
  files: SnapshotFileStat[];
  filesChanged: number;
  insertions: number;
  deletions: number;
  /** The patch, up to the caller's budget. */
  patch: string;
  /** The budget was reached and `patch` is not the whole story. */
  truncated: boolean;
  /** Exactly how many bytes of patch were left out. Zero when `truncated` is false. */
  omittedBytes: number;
  /**
   * Which paths the returned `patch` covers, so a reader can tell a CUT from the whole thing.
   *
   * `null` is the whole difference - the historical behaviour and what a caller asking nothing
   * gets. A list is exactly the paths the patch was filtered to. An EMPTY list is "no patch was
   * rendered at all" (`patch: false`), which is the one reading that must not be confused with
   * "this artifact changed nothing": `files` is complete in every case, so it, not the patch
   * text, is what answers whether a file was touched.
   */
  patchPaths: string[] | null;
}

/**
 * The subprocess seam for one materialization - `run` in production, a recorder in a test.
 *
 * Same shape and same reason as `PaneDeps.pane`: a test drives the REAL code path - the argv,
 * the `--` separation, the literal-pathspec env, the numstat parse and the cap - and observes
 * only the spawns. That is what lets "asking for stats alone runs ONE git invocation" be an
 * assertion rather than a comment, and a skipped subprocess is the entire value of `filesOnly`.
 */
export interface SnapshotDiffDeps {
  run: typeof run;
}

export const defaultSnapshotDiffDeps: SnapshotDiffDeps = { run };

/**
 * Why one patch-filter path cannot be used, as a sentence, or null when it can.
 *
 * The rule is REFUSAL, never sanitization: a path that has been quietly rewritten still
 * returns a patch, and a caller comparing "the diff of src/a.ts" against a diff of something
 * else has no way to notice. Six things are refused - an empty path (names nothing), a NUL
 * byte (cannot be passed as an argv entry), an absolute path (names something outside the
 * repository's own vocabulary), a `..` segment (walks out of the tree the artifact is a
 * picture of), a `.` segment, and an empty segment.
 *
 * "Absolute" is taken to mean absolute ANYWHERE, not absolute here: `/x`, a drive-letter
 * `C:\x`, a current-drive-rooted `\x` and a UNC `\\server\share\x` are all refused on every
 * platform. Doing it per-platform would make the same request a refusal on one machine and a
 * 200 with an empty patch on another - and that empty patch is the failure, not the refusal,
 * because it reads as "this candidate did not touch that file". The cost is stated rather than
 * hidden: a POSIX file whose name genuinely begins with a backslash cannot be asked for
 * per-file. That is a loud 400 about an exotic name, against a quiet wrong answer.
 *
 * Those last two are the difference between two spellings of one file, and the reason they are
 * refused rather than normalized is what happens when they are not. `files` spells a path
 * exactly as git's `--numstat` does, so `./a.txt` matches no entry and reads as "not in this
 * difference" - while `<commit>:./a.txt` resolves to the very blob that changed (measured).
 * The answer would be a 200 with an empty patch for a file the candidate DID edit, labelled
 * with the caller's own spelling, which is the most convincing possible way to be wrong.
 * `a.txt/`, `a//b.txt` and `a/./b.txt` fail the other way - git resolves none of them - and
 * produce the same misleading emptiness. Normalizing would work here and would also be the
 * first crack in "refusal, never sanitization"; one canonical spelling per file keeps the
 * numstat list and the request talking about the same thing.
 *
 * `/` only for those two, because that is what git splits `<commit>:<path>` and its pathspecs
 * on: a backslash is an ordinary character in a POSIX filename, not a separator.
 *
 * Pathspec MAGIC (`:(glob)**`, `:!x`, `:/`) is deliberately NOT refused here: the invocation
 * that consumes these runs with `GIT_LITERAL_PATHSPECS=1`, so `:(glob)**` names a file called
 * `:(glob)**` and nothing else. Refusing it would deny a legal filename; reading it as magic
 * would turn a single-file request into a multi-file expansion, which is the failure this pairs
 * with the env var to rule out.
 */
export function snapshotPathRefusal(path: string): string | null {
  if (path === "") return "a patch path must name a file, not the empty string";
  if (path.includes("\0")) return "a patch path must not contain a NUL byte";
  if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(path)) {
    return `a patch path must be repository-relative, got "${path}"`;
  }
  if (path.split(/[\\/]/).includes("..")) {
    return `a patch path must not contain ".." segments, got "${path}"`;
  }
  const segments = path.split("/");
  if (segments.includes(".")) {
    return `a patch path must not contain "." segments, got "${path}"`;
  }
  if (segments.includes("")) {
    return `a patch path must not contain empty segments, got "${path}"`;
  }
  return null;
}

/**
 * A path this materialization will not filter on.
 *
 * Typed rather than a bare `Error` because the caller nearest the operator - the HTTP route -
 * has to answer 400 rather than 500: a query parameter nobody could have satisfied is the
 * caller's mistake, not the daemon failing.
 */
export class SnapshotPathRefused extends Error {
  readonly path: string;
  constructor(path: string, why: string) {
    super(why);
    this.name = "SnapshotPathRefused";
    this.path = path;
  }
}

function requirePatchPath(path: string): string {
  const why = snapshotPathRefusal(path);
  if (why) throw new SnapshotPathRefused(path, why);
  return path;
}

function fileStatPaths(file: SnapshotFileStat): string[] {
  return file.oldPath === null ? [file.path] : [file.oldPath, file.path];
}

/** How one changed entry reads in a refusal - a rename is one file with two names. */
function describeFileStat(file: SnapshotFileStat): string {
  return file.oldPath === null ? `"${file.path}"` : `the rename "${file.oldPath}" -> "${file.path}"`;
}

/**
 * Which changed entries the requested paths select, and which named nothing that changed.
 *
 * A path that names MORE THAN ONE entry is refused rather than resolved by list order. Today's
 * argv cannot produce that - with `--find-renames` alone, a path present in both commits is one
 * modify entry, and a rename's source is by definition absent from the snapshot, so no path
 * appears twice. But that is an argument about git's pairing rules, not a property of this
 * function's input: `files` is parsed data, and one flag away (`-B`, `--find-copies`) the
 * argument stops holding. Picking the first match would then answer "the diff of a" with one of
 * two entries, chosen by list order and indistinguishable from the other. Same rule as the
 * directory case: a per-file cut answers about exactly one file, or it does not answer.
 */
function exactPatchFiles(
  paths: string[],
  files: SnapshotFileStat[],
): { exact: SnapshotFileStat[]; unchanged: string[] } {
  const changedPaths = files.flatMap(fileStatPaths);
  const exact: SnapshotFileStat[] = [];
  const unchanged: string[] = [];
  for (const path of paths) {
    const matches = files.filter((candidate) => fileStatPaths(candidate).includes(path));
    if (matches.length > 1) {
      throw new SnapshotPathRefused(
        path,
        `a per-file patch path must name exactly one file; "${path}" names ${matches.map(describeFileStat).join(" and ")}`,
      );
    }
    const file = matches[0];
    if (file !== undefined) {
      if (!exact.includes(file)) exact.push(file);
      continue;
    }
    const directory = path.replace(/\/+$/, "");
    const prefix = directory === "." ? "" : `${directory}/`;
    const nested = changedPaths.find((candidate) => prefix === "" || candidate.startsWith(prefix));
    if (nested !== undefined) {
      throw new SnapshotPathRefused(
        path,
        `a per-file patch path must name exactly one file; "${path}" is a directory containing "${nested}"`,
      );
    }
    // Nothing in this difference is at or under it. That is either a file neither commit
    // touched - an honest empty patch - or a directory neither commit touched, which the
    // complete file list cannot tell apart. `refuseUnchangedDirectories` asks the trees.
    unchanged.push(path);
  }
  return { exact, unchanged };
}

/**
 * Refuse a path that names a DIRECTORY in either commit, even one this difference never
 * touched.
 *
 * The complete file list answers "is this a directory?" only when something under it changed.
 * A `src/` that both commits hold and neither modified matches no entry at all, so without
 * this it would take the absent-file path and come back 200 with an empty patch - a directory
 * masquerading as an untouched file, which is exactly the reading the one-file rule exists to
 * prevent. The trees are the only place that answer lives.
 *
 * `<commit>:<path>` rather than a pathspec, deliberately: it is a literal lookup, so a
 * filename that reads as pathspec magic cannot expand here either. Asked only for paths the
 * file list could not settle - never on the hot path, where the caller names a file it read
 * out of `files` - and the snapshot is asked first because a blob there ends the question.
 */
async function refuseUnchangedDirectories(
  paths: string[],
  input: { repoPath: string; baseSha: string; snapshotSha: string },
  deps: SnapshotDiffDeps,
): Promise<void> {
  for (const path of paths) {
    for (const [label, commit] of [["snapshot", input.snapshotSha], ["base", input.baseSha]] as const) {
      const probe = await deps.run(
        "git",
        ["-C", input.repoPath, "cat-file", "-t", `${commit}:${path}`],
        { timeoutMs: 60_000 },
      );
      // A path neither commit holds exits non-zero, and that is an answer: it names no file
      // and no directory, so the empty patch is the honest reply.
      const kind = probe.code === 0 ? probe.stdout.trim() : "";
      if (kind === "tree") {
        throw new SnapshotPathRefused(
          path,
          `a per-file patch path must name exactly one file; "${path}" is a directory in the ${label}`,
        );
      }
      if (kind === "blob") break;
    }
  }
}

const GIT_C_ESCAPES = new Map<number, string>([
  [0x07, "\\a"],
  [0x08, "\\b"],
  [0x09, "\\t"],
  [0x0a, "\\n"],
  [0x0b, "\\v"],
  [0x0c, "\\f"],
  [0x0d, "\\r"],
  [0x22, "\\\""],
  [0x5c, "\\\\"],
]);

export function quoteGitDiffPath(path: string): string {
  let quoted = false;
  let rendered = "";
  for (const char of path) {
    const codePoint = char.codePointAt(0)!;
    const escaped = GIT_C_ESCAPES.get(codePoint);
    if (escaped !== undefined) {
      quoted = true;
      rendered += escaped;
    } else if (codePoint < 0x20 || codePoint === 0x7f) {
      quoted = true;
      rendered += `\\${codePoint.toString(8).padStart(3, "0")}`;
    } else {
      rendered += char;
    }
  }
  return quoted ? `"${rendered}"` : rendered;
}

function diffHeaderFor(file: SnapshotFileStat): string {
  const oldPath = file.oldPath ?? file.path;
  return `diff --git ${quoteGitDiffPath(`a/${oldPath}`)} ${quoteGitDiffPath(`b/${file.path}`)}`;
}

function findDiffHeader(patch: string, from: number): number {
  const marker = "diff --git ";
  let index = patch.indexOf(marker, from);
  while (index !== -1 && index !== 0 && patch[index - 1] !== "\n") {
    index = patch.indexOf(marker, index + marker.length);
  }
  return index;
}

function sliceExactPatch(
  patch: string,
  files: SnapshotFileStat[],
  selectedFiles: SnapshotFileStat[],
  refusalPath: string,
): string {
  const filesByHeader = new Map<string, SnapshotFileStat[]>();
  for (const file of files) {
    const header = diffHeaderFor(file);
    const candidates = filesByHeader.get(header);
    if (candidates === undefined) filesByHeader.set(header, [file]);
    else candidates.push(file);
  }
  const selected = new Set(selectedFiles);
  const sections: string[] = [];
  let start = findDiffHeader(patch, 0);
  if (start === -1) {
    if (patch === "") return "";
    throw new SnapshotPathRefused(refusalPath, "a per-file patch contained no attributable diff header");
  }
  if (start !== 0) {
    throw new SnapshotPathRefused(refusalPath, "a per-file patch contained content before its first diff header");
  }
  while (start !== -1) {
    const lineEnd = patch.indexOf("\n", start);
    const headerEnd = lineEnd === -1 ? patch.length : lineEnd;
    const header = patch.slice(start, headerEnd);
    const candidates = filesByHeader.get(header);
    if (candidates === undefined) {
      throw new SnapshotPathRefused(
        refusalPath,
        `a per-file patch contained an unattributable diff header: "${header}"`,
      );
    }
    const selectedCount = candidates.reduce((count, file) => count + Number(selected.has(file)), 0);
    if (selectedCount > 0 && selectedCount !== candidates.length) {
      throw new SnapshotPathRefused(
        refusalPath,
        `a per-file patch contained an ambiguous diff header: "${header}"`,
      );
    }
    const next = findDiffHeader(patch, headerEnd);
    if (selectedCount > 0) sections.push(patch.slice(start, next === -1 ? patch.length : next));
    start = next;
  }
  return sections.join("");
}

/**
 * The exact difference between the pinned base and one artifact.
 *
 * `baseSha..snapshotSha` DIRECTLY, and never through the merge-base walk `computeSessionDiff`
 * does: a member may amend, rebase or reset before it submits, so the snapshot need not
 * descend from the base at all - and asking for "everything since they diverged" would then
 * answer with a different, larger and wrong diff under the right label. Two exact commits,
 * one exact difference.
 *
 * The statistics are always complete; only the patch is capped. `truncated` and
 * `omittedBytes` are the disclosure that goes with it, because an evaluator that cannot
 * tell a small change from a truncated one will happily call the second one tidy.
 *
 * That invariant is what `paths` and `patch` extend rather than bend. A filter narrows the
 * PATCH invocation only, so "which files did this member touch" is answered identically
 * whether the caller wanted one file's hunks, all of them, or none: `files` is the complete
 * list either way, and `patchPaths` says which of it the patch text covers.
 */
export async function materializeSnapshotDiff(
  input: {
    /** Any working directory inside the repository holding both commits. */
    repoPath: string;
    baseSha: string;
    snapshotSha: string;
    maxPatchBytes?: number;
    /**
     * Restrict the PATCH to these exact repository-relative files. Absent or empty is the
     * whole patch.
     *
     * Exactly one file, or a refusal: a directory is refused whether or not anything under it
     * changed, and so is a path that names more than one changed entry (a rename's source is
     * still a path, so `a` can name both the rename `a` -> `b` and a newly added `a`). A path
     * that names a file neither commit touched is NOT an error - it yields an empty patch,
     * because "this candidate did not touch that file" is a real answer. A rename is one file,
     * so either its old or new path selects the same rename diff, and `patchPaths` echoes the
     * path the caller requested. Each path is validated by `snapshotPathRefusal` and taken
     * LITERALLY - see below.
     */
    paths?: string[];
    /**
     * Render a patch at all. `false` skips the second git invocation entirely, which is the
     * whole point of asking: the file list and its statistics cost one `--numstat`, and a
     * caller that only needs to know WHICH files a candidate touched should not pay for the
     * bytes of every hunk to find out.
     */
    patch?: boolean;
  },
  deps: SnapshotDiffDeps = defaultSnapshotDiffDeps,
): Promise<SnapshotDiff> {
  const baseSha = requireSha("baseSha", input.baseSha);
  const snapshotSha = requireSha("snapshotSha", input.snapshotSha);
  const budget = input.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES;
  const filter = (input.paths ?? []).map(requirePatchPath);
  const wantPatch = input.patch ?? true;

  // `-z` rather than the default: a rename's two paths and any path needing quotes both
  // become unambiguous NUL-separated fields instead of something to un-escape by hand.
  //
  // NEVER filtered, however narrow the patch request was. The statistics are the answer to a
  // different question - what this artifact changed - and a reader given one file's hunks
  // beside one file's statistics cannot tell a focused candidate from a sprawling one.
  const numstat = await deps.run(
    "git",
    ["-C", input.repoPath, "diff", "--numstat", "-z", "--find-renames", baseSha, snapshotSha],
    { timeoutMs: 60_000 },
  );
  requireOk("git diff --numstat", numstat);
  const files = parseNumstatZ(numstat.stdout);
  const { exact: selectedFiles, unchanged } = exactPatchFiles(filter, files);
  // Before anything is rendered or skipped, so a directory is refused identically whether the
  // caller wanted its hunks or only the file list.
  if (unchanged.length > 0) {
    await refuseUnchangedDirectories(unchanged, { repoPath: input.repoPath, baseSha, snapshotSha }, deps);
  }
  const pathsInDifference = [...new Set(selectedFiles.flatMap(fileStatPaths))];

  const stats = {
    baseSha,
    snapshotSha,
    files,
    filesChanged: files.length,
    insertions: files.reduce((n, f) => n + f.insertions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  };

  if (!wantPatch) {
    // No second subprocess, and an empty `patchPaths` saying so. Nothing was rendered, so
    // nothing was cut short either - the truncation disclosure is about a patch that exists.
    return { ...stats, patch: "", truncated: false, omittedBytes: 0, patchPaths: [] };
  }

  if (filter.length > 0 && pathsInDifference.length === 0) {
    return { ...stats, patch: "", truncated: false, omittedBytes: 0, patchPaths: filter };
  }

  const filtered = filter.length > 0;
  const patchEnv = filtered ? { ...process.env } : undefined;
  if (patchEnv !== undefined) {
    delete patchEnv.GIT_GLOB_PATHSPECS;
    delete patchEnv.GIT_NOGLOB_PATHSPECS;
    delete patchEnv.GIT_ICASE_PATHSPECS;
    patchEnv.GIT_LITERAL_PATHSPECS = "1";
  }

  const patchRun = await deps.run(
    "git",
    [
      "-C", input.repoPath,
      ...(filtered ? ["-c", "core.quotePath=false"] : []),
      "diff",
      ...(filtered
        ? ["--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/"]
        : []),
      "--find-renames", baseSha, snapshotSha,
      // `--` first, so a path can never be read as a flag or a revision: a tracked file
      // named `--exploit` is a legal filename and an illegal argument, and only the
      // separator tells the two apart.
      ...(pathsInDifference.length > 0 ? ["--", ...pathsInDifference] : []),
    ],
    {
      timeoutMs: 60_000,
      maxBuffer: PATCH_MAX_BUFFER,
      // `--` stops flag parsing; it does NOT stop PATHSPEC parsing, and those are two
      // different readings of the same word. `:(glob)**`, `:!src` and `:/` are all magic
      // after the separator, so a "one file" request could quietly return hunks for many -
      // exactly the expansion a per-file cut exists to avoid. Literal pathspecs make every
      // path name literal, including the one whose name looks like magic. Set on this
      // invocation because it is the only one that ever carries a pathspec, and set
      // explicitly rather than inherited so an operator's exported value cannot decide it.
      // Git rejects literal pathspec mode when any other global pathspec mode is inherited.
      ...(patchEnv === undefined ? {} : { env: patchEnv }),
    },
  );
  if (patchRun.overflowed) {
    // Refuse rather than report a truncation whose size we would have to invent. A caller
    // that cannot get evidence must find that out, not receive plausible evidence.
    throw new Error(
      `the diff ${baseSha.slice(0, 12)}..${snapshotSha.slice(0, 12)} exceeds ${PATCH_MAX_BUFFER} bytes and cannot be materialized`,
    );
  }
  requireOk("git diff", patchRun);
  const renderedPatch = filter.length > 0
    ? sliceExactPatch(patchRun.stdout, files, selectedFiles, filter[0]!)
    : patchRun.stdout;

  const { patch, truncated, omittedBytes } = capPatch(renderedPatch, budget);

  return {
    ...stats,
    patch,
    truncated,
    omittedBytes,
    patchPaths: filter.length > 0 ? filter : null,
  };
}

/**
 * `--numstat -z` records: `<ins>\t<del>\t<path>\0`, except a rename, which ends its third
 * field early and follows with `<old>\0<new>\0`. A binary file reports `-` for both counts.
 */
function parseNumstatZ(stdout: string): SnapshotFileStat[] {
  const fields = stdout.split("\0");
  const out: SnapshotFileStat[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field) continue;
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(field);
    if (!m) continue;
    const binary = m[1] === "-" && m[2] === "-";
    const insertions = m[1] === "-" ? 0 : Number(m[1]);
    const deletions = m[2] === "-" ? 0 : Number(m[2]);
    if (m[3] === "") {
      const oldPath = fields[++i] ?? "";
      const path = fields[++i] ?? "";
      out.push({ path, oldPath, insertions, deletions, binary });
    } else {
      out.push({ path: m[3]!, oldPath: null, insertions, deletions, binary });
    }
  }
  return out;
}

/**
 * Cut the patch to `budget` BYTES, at a line boundary.
 *
 * Bytes rather than characters because the budget exists to bound what reaches a model's
 * context and a token bill, and a line boundary because half a hunk header reads to a
 * reader (human or model) as a malformed diff rather than as a stopped one.
 *
 * A budget too small for even the first line therefore yields NO patch rather than the
 * first few bytes of `diff --git`. "Line boundary" has to hold at every budget or it is not
 * a property a reader can rely on, and the numbers stay honest either way: `truncated` is
 * true and `omittedBytes` is the whole patch.
 */
function capPatch(patch: string, budget: number): { patch: string; truncated: boolean; omittedBytes: number } {
  const buf = Buffer.from(patch, "utf8");
  if (buf.length <= budget) return { patch, truncated: false, omittedBytes: 0 };
  const head = buf.subarray(0, Math.max(budget, 0));
  const lastNewline = head.lastIndexOf(0x0a);
  const kept = head.subarray(0, lastNewline + 1); // -1 when no line fits, so nothing is kept
  return {
    patch: kept.toString("utf8"),
    truncated: true,
    omittedBytes: buf.length - kept.length,
  };
}

/**
 * Return a worktree to one exact commit: hard reset, then drop untracked files that are
 * not ignored.
 *
 * `clean -fd`, NEVER `-fdx`, and that missing letter is the whole point. `-x` would also
 * delete ignored files, which in a pooled worktree means the warm `node_modules` and build
 * caches that the pool exists to keep - turning "start this member from a known commit"
 * into "re-pay every install". Untracked-but-nonignored content is different: it is work
 * that a previous occupant left behind, and leaving it would mean the tree is not the
 * commit we said it was.
 *
 * One owner for both callers - pinned provisioning before a launch, and restoring a
 * selected artifact after one - because the two are the same operation and only one of
 * them can afford to get the flag wrong.
 */
export async function resetWorktreeToCommit(worktreePath: string, commit: string): Promise<void> {
  const sha = requireSha("commit", commit);
  requireOk("git reset --hard", await git(worktreePath, ["reset", "--hard", sha]));
  requireOk("git clean -fd", await git(worktreePath, ["clean", "-fd"]));
  await verifyHeadIs(worktreePath, sha);
}

/**
 * Put a captured artifact back into a worktree, exactly.
 *
 * Takes the ref rather than only the sha so the caller's claim ("this artifact") and the
 * object it resolves to are checked against each other here, at the one moment a mismatch
 * is still cheap - before a hard reset over somebody's checkout.
 */
export async function restoreSnapshotIntoWorktree(input: {
  worktreePath: string;
  ref: string;
  snapshotSha: string;
}): Promise<void> {
  const expected = requireSha("snapshotSha", input.snapshotSha);
  const resolved = await resolveEnsembleRef(input.worktreePath, input.ref);
  if (!resolved) throw new Error(`snapshot ref ${input.ref} no longer resolves`);
  if (resolved !== expected) {
    throw new Error(`snapshot ref ${input.ref} resolves to ${resolved}, expected ${expected}`);
  }
  await resetWorktreeToCommit(input.worktreePath, expected);
}

/**
 * Prove a worktree's HEAD is the commit it was supposed to be left at.
 *
 * Exported because provisioning needs the same assertion: a pinned member that silently
 * started from a different commit is not a member of the comparison it was launched for,
 * and nothing downstream can tell afterwards.
 */
export async function verifyHeadIs(worktreePath: string, commit: string): Promise<void> {
  const head = await git(worktreePath, ["rev-parse", "HEAD"]);
  const at = head.stdout.trim();
  if (head.code !== 0 || at !== commit) {
    throw new Error(
      `${worktreePath} is at ${at || "an unreadable HEAD"} after provisioning, expected ${commit}`,
    );
  }
}
