import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";

// The repo's own standards docs - what the queue verifier judges an item's diff
// against when it asks "was this actually finished, to this repo's bar?".
//
// Getting the file set wrong is not cosmetic: too few and the verifier misses the
// repo's contract, too many and it invents `standards` gaps from text the repo
// never asserted.

/** Cap per file, so one enormous AGENTS.md can't crowd out the diff in the prompt. */
const MAX_FILE_BYTES = 24 * 1024;
/** Cap on the whole bundle - the verify prompt also carries a diff + transcript. */
const MAX_TOTAL_BYTES = 64 * 1024;
/**
 * Cap on how many changed paths we'll walk for nested docs. The list comes from a
 * patch capped at 1.2MB, so it has no small bound of its own; this one is generous
 * enough that no real change reaches it (paths collapse to a handful of unique
 * directories long before this), and exists so a pathological diff can't make the
 * daemon walk a directory chain per file. Exceeding it is REPORTED through the
 * bundle's `truncated` flag, never swallowed: a verifier that judges an item
 * against the repo's contract having silently read less of it than it thinks
 * invents gaps, which is the one outcome worse than saying "some docs are missing".
 */
const MAX_CHANGED_PATHS = 1000;
/** Nested docs to collect from directories the item's diff touched. */
const NESTED_NAMES = ["CLAUDE.md", "AGENTS.md"];
/** Repo-root docs that always apply. */
const ROOT_NAMES = ["AGENTS.md", "CLAUDE.md"];

export interface StandardsDoc {
  /** Repo-relative path, so the verifier can cite it in a gap. */
  path: string;
  text: string;
  /** True when the file was capped for size. */
  truncated: boolean;
}

export interface StandardsBundle {
  docs: StandardsDoc[];
  /**
   * True when whole docs may be missing - dropped at the total cap, or governing a
   * changed path past `MAX_CHANGED_PATHS`. The prompt says so when this is set, so
   * the verifier never judges against a contract it silently didn't read.
   */
  truncated: boolean;
}

/**
 * Read the standards that apply to a diff touching `changedPaths` in `repoRoot`:
 * the repo-root AGENTS.md + CLAUDE.md, plus any nested CLAUDE.md/AGENTS.md under a
 * directory the diff actually touched.
 *
 * The operator's global ~/.claude/CLAUDE.md is deliberately EXCLUDED. It is
 * personal preference (one machine's "no em dash" rule), not a contract the repo
 * asserts, and the ask is explicitly "standards established for the repository".
 * The asymmetry is real and accepted: the agent obeys the global while the
 * verifier cannot see it, so the verifier may miss something the global mandates.
 * That stays harmless because standards findings are `advisory`, and advisory gaps
 * never drive a fix round - they surface on the card and stop there.
 */
export function readStandards(repoRoot: string | null, changedPaths: string[]): StandardsBundle {
  if (!repoRoot || !existsSync(repoRoot)) return { docs: [], truncated: false };
  const root = resolve(repoRoot);
  // Containment is judged real-path against REAL-path. Resolving only the file side
  // would reject every doc in a repo whose own path runs through a symlink - which is
  // not exotic: /tmp is one on macOS, and so is many a home directory or checkout.
  // Paths are still reported relative to `root`, so a gap cites the file the repo
  // knows it by, not wherever the links happen to land.
  const realRoot = realpathOr(root);
  const wanted: string[] = [];

  for (const name of ROOT_NAMES) wanted.push(join(root, name));

  // Over the cap, the docs governing the dropped paths' directories are missed, so
  // the bundle must say so - the root docs still load, and `truncated` is what tells
  // the prompt to print its "some standards docs were omitted" line.
  const walk = changedPaths.slice(0, MAX_CHANGED_PATHS);
  const droppedPaths = changedPaths.length > MAX_CHANGED_PATHS;

  // Walk each changed file's directory chain up to the root, so a doc governing
  // an ancestor directory (not just the file's own) is included.
  const seenDirs = new Set<string>();
  for (const p of walk) {
    let dir = dirname(resolve(root, p));
    while (dir.startsWith(root) && dir.length >= root.length) {
      if (!seenDirs.has(dir)) {
        seenDirs.add(dir);
        if (dir !== root) for (const name of NESTED_NAMES) wanted.push(join(dir, name));
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  const docs: StandardsDoc[] = [];
  const seen = new Set<string>();
  let total = 0;
  let truncated = false;
  for (const abs of wanted) {
    if (seen.has(abs)) continue;
    seen.add(abs);
    const doc = readDoc(root, realRoot, abs);
    if (!doc) continue;
    if (total + doc.text.length > MAX_TOTAL_BYTES) {
      truncated = true;
      continue;
    }
    total += doc.text.length;
    docs.push(doc);
  }
  return { docs, truncated: truncated || droppedPaths };
}

/** True when `abs` is at or under `root` (defeats a `..` escape in a diff path). */
function withinRoot(root: string, abs: string): boolean {
  const rel = relative(root, normalize(abs));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Read one standards doc, or null when it isn't one we may read.
 *
 * The containment check runs on the REAL path, after symlinks are resolved, and that
 * ordering is the whole point: a path check is string work, while reading follows
 * links. A repo shipping `AGENTS.md` as a symlink to `~/.ssh/id_rsa` satisfies a
 * check on the literal path and is then read anyway - and the contents go straight
 * into the verify prompt, which is sent to the API.
 *
 * That matters more here than the same bug would elsewhere. The verifier is spawned
 * `--tools ""` precisely so that untrusted repo content cannot steer it into reading
 * arbitrary files; this handed repo content that exact result through the daemon
 * instead, which runs with the user's full read access. The `..` guard shows the
 * escape class was already considered - the symlink just walked around it.
 *
 * MAX_FILE_BYTES caps the READ, via `stat` and a bounded `readCapped`, rather than
 * capping a string that was already materialized. An enormous AGENTS.md would
 * otherwise be allocated in full on every verify, and one past ~512MB would throw
 * ERR_STRING_TOO_LONG - which the catch below would swallow as "not a standard that
 * applies", silently dropping the repo's contract instead of truncating it.
 */
function readDoc(root: string, realRoot: string, abs: string): StandardsDoc | null {
  try {
    // Resolve first: a link's own path tells us nothing about what we'd read.
    const real = realpathSync(abs);
    if (!withinRoot(realRoot, real)) return null;
    const stat = statSync(real);
    if (!stat.isFile()) return null;
    return {
      // Cite the path the repo asked for, not the link target: that's the file the
      // verifier can name in a gap.
      path: relative(root, abs) || abs,
      text: readCapped(real, Math.min(stat.size, MAX_FILE_BYTES)),
      truncated: stat.size > MAX_FILE_BYTES,
    };
  } catch {
    return null; // missing, unreadable, or a dangling link - not a standard that applies
  }
}

/** The resolved path, or the input when it can't be resolved (a root that's gone). */
function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Read at most `n` bytes off the front of a file - never more than we'll use. */
function readCapped(path: string, n: number): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(n);
    const read = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}
