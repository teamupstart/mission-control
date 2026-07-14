import { existsSync, readFileSync, statSync } from "node:fs";
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
  /** True when whole docs were dropped at the total cap (the prompt says so). */
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
  const wanted: string[] = [];

  for (const name of ROOT_NAMES) wanted.push(join(root, name));

  // Walk each changed file's directory chain up to the root, so a doc governing
  // an ancestor directory (not just the file's own) is included.
  const seenDirs = new Set<string>();
  for (const p of changedPaths) {
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
    // A changed path could escape the repo via `..`; never read outside the root.
    if (!withinRoot(root, abs)) continue;
    const doc = readDoc(root, abs);
    if (!doc) continue;
    if (total + doc.text.length > MAX_TOTAL_BYTES) {
      truncated = true;
      continue;
    }
    total += doc.text.length;
    docs.push(doc);
  }
  return { docs, truncated };
}

/** True when `abs` is at or under `root` (defeats a `..` escape in a diff path). */
function withinRoot(root: string, abs: string): boolean {
  const rel = relative(root, normalize(abs));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function readDoc(root: string, abs: string): StandardsDoc | null {
  try {
    if (!statSync(abs).isFile()) return null;
    const raw = readFileSync(abs, "utf8");
    const capped = raw.length > MAX_FILE_BYTES;
    return {
      path: relative(root, abs) || abs,
      text: capped ? raw.slice(0, MAX_FILE_BYTES) : raw,
      truncated: capped,
    };
  } catch {
    return null; // missing or unreadable - simply not a standard that applies
  }
}
