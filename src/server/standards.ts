import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readRepoDoc, realpathOr } from "./util/repo-doc.ts";
import type { RepoDoc } from "./util/repo-doc.ts";
import { utf8Bytes } from "./util/utf8.ts";

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
/**
 * Cap on how many distinct directories the climb will collect, across ALL paths.
 *
 * MAX_CHANGED_PATHS bounds how many paths are walked and REQUEST_PATH_MAX bounds how
 * deep any ONE of them goes, but the climb's real cost is the PRODUCT, which neither
 * touches: 1000 paths x ~512 levels is ~512k iterations pushing ~1M candidates, each
 * of which then costs a `readRepoDoc` with a `realpathSync` syscall - on the daemon's one
 * synchronous handle, the same one serving SQLite, SSE and hook ingest.
 *
 * Real changes are nowhere near this: paths collapse to a handful of unique
 * directories (that's what `seenDirs` is for), and a deep monorepo tree is maybe 15
 * levels. Like MAX_CHANGED_PATHS, exceeding it is REPORTED through `truncated` rather
 * than swallowed - a verifier that judges against a contract it silently didn't read
 * invents gaps, which is worse than admitting a doc is missing.
 */
const MAX_WALKED_DIRS = 4000;
/** Nested docs to collect from directories the item's diff touched. */
const NESTED_NAMES = ["CLAUDE.md", "AGENTS.md"];
/** Repo-root docs that always apply. */
const ROOT_NAMES = ["AGENTS.md", "CLAUDE.md"];

/**
 * One standards doc. Structurally a `RepoDoc` - the shape the shared reader returns -
 * kept as a named alias so a gap can still talk about "a standards doc" rather than
 * leaking the reader's vocabulary into the verifier's.
 */
export type StandardsDoc = RepoDoc;

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
  let droppedDirs = false;
  for (const p of walk) {
    let dir = dirname(resolve(root, p));
    while (dir.startsWith(root) && dir.length >= root.length) {
      // Already seen means its WHOLE ancestor chain was already walked to the root -
      // that's what this loop does on the way past - so there is provably nothing
      // above it left to collect. Climbing on anyway re-walked the identical chain
      // once per changed file, which is the exact redundancy `seenDirs` exists to
      // remove: the common shape (many files under one deep tree) paid for it every
      // time.
      if (seenDirs.has(dir)) break;
      if (seenDirs.size >= MAX_WALKED_DIRS) {
        droppedDirs = true;
        break;
      }
      seenDirs.add(dir);
      if (dir !== root) for (const name of NESTED_NAMES) wanted.push(join(dir, name));
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  const docs: StandardsDoc[] = [];
  // Two sets, because "did we already ASK for this path" and "is this the same
  // DOCUMENT" are different questions and only the second one is about content.
  //
  // `requested` is the cheap first pass: the climb pushes the same nested name once
  // per changed file, and skipping those costs no syscall. It cannot answer the second
  // question, though, because one file can be reached by more than one name - this
  // repo ships CLAUDE.md as a symlink to AGENTS.md, and BOTH are in ROOT_NAMES. Keyed
  // on the requested path alone, that read as two documents and put a whole second copy
  // of the doc into every Inspector review and Foreman verify prompt. The waste is
  // min(fileSize, MAX_FILE_BYTES) per duplicated doc, so it tracks whatever the root doc
  // currently weighs rather than being a fixed figure - it was 24,576 bytes per prompt
  // when the defect was found. See docs/evidence/inspector-prompt-bytes.md.
  //
  // `identity` keys on the path the read RESOLVED to, which `readRepoDoc` already
  // computed and now reports. Deliberately not a second `realpathSync` here: this
  // module would then be resolving paths the containment check inside `readRepoDoc`
  // never saw, which is the check standing between a symlinked AGENTS.md and the
  // contents of ~/.ssh/id_rsa going into a prompt.
  //
  // Whichever name comes first in ROOT_NAMES (then NESTED_NAMES) order wins and is what
  // the bundle cites, so the surviving name is deterministic rather than filesystem
  // order.
  const requested = new Set<string>();
  const identity = new Set<string>();
  let total = 0;
  let truncated = false;
  for (const abs of wanted) {
    if (requested.has(abs)) continue;
    requested.add(abs);
    const doc = readRepoDoc(root, realRoot, abs, MAX_FILE_BYTES);
    if (!doc) continue;
    // Marked before the size gate, not after: a second name for a document already
    // dropped at the cap is still that same document, and re-reporting it as another
    // omission would say two docs are missing when one is.
    if (identity.has(doc.realPath)) continue;
    identity.add(doc.realPath);
    // BYTES, to match what the budget is named and what `MAX_FILE_BYTES` already
    // measures: `doc.text.length` is UTF-16 code units, so a bundle of CJK or
    // box-drawing docs undercounted itself and could pass ~3x this ceiling.
    const docBytes = utf8Bytes(doc.text);
    if (total + docBytes > MAX_TOTAL_BYTES) {
      truncated = true;
      continue;
    }
    total += docBytes;
    docs.push(doc);
  }
  return { docs, truncated: truncated || droppedPaths || droppedDirs };
}
