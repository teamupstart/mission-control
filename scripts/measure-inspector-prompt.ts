/**
 * Measure the Inspector review prompt on THIS checkout, pre-fix source against fixed
 * source, in the bytes that actually reach the API.
 *
 *   npx tsx scripts/measure-inspector-prompt.ts [<pre-fix-rev>]
 *
 * Why this exists as a committed script rather than a number in a commit message: the
 * defect it measures is invisible at every other altitude. `AGENTS.md` and `CLAUDE.md`
 * are both in `ROOT_NAMES`, and this repo ships the second as a symlink to the first,
 * so de-duplicating on the REQUESTED path emitted one file as two documents. Nothing
 * looked wrong - the bundle was well-formed, the prompt was well-formed, findings still
 * worked - and the second copy was simply paid for on every Inspector review and every
 * Foreman verify. Only a byte count says so, and a byte count nobody can re-run is a
 * claim rather than evidence.
 *
 * `test/standards-prompt-bytes.test.ts` is the hermetic regression guard and runs in
 * CI. It deliberately builds its own temp repository, so it cannot speak for THIS
 * checkout's real AGENTS.md; that is what this script is for. The two are complements.
 *
 * The pre-fix arm runs the REAL pre-fix code, not a reconstruction of it: both source
 * files are read out of git at `<rev>` and imported. That is only possible because
 * `standards.ts` imports nothing but `node:` builtins and `./util/repo-doc.ts`, so the
 * pair is self-contained - check that still holds before trusting a change here. The
 * working tree is never modified, so this is safe to run on dirty state.
 *
 * `buildReviewPrompt` is deliberately the SAME instance for both arms: the fix changed
 * which documents reach the prompt, never how a prompt is rendered, so holding the
 * renderer fixed is what isolates the duplicate.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildReviewPrompt } from "../src/server/inspector/prompt.ts";
import { readStandards } from "../src/server/standards.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The two files the fix touched - the whole of `readStandards`'s dependency cone. */
const SOURCES = ["src/server/standards.ts", "src/server/util/repo-doc.ts"];
/** Unique to the fixed `standards.ts`, so the pre-fix revision can locate itself. */
const FIX_MARKER = "doc.realPath";
/** A small, realistic PR: the prompt's other inputs are held constant across arms. */
const CHANGED_PATHS = SOURCES;

type ReadStandards = typeof readStandards;

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

/**
 * The revision to measure the "before" arm at: the parent of whichever commit first
 * introduced the fix. Derived rather than hardcoded to `HEAD~1`, which stops being the
 * pre-fix state the moment anything lands on top of the fix - including this script.
 */
function preFixRev(explicit: string | undefined): string {
  if (explicit) return explicit;
  const touched = git(["log", "--format=%H", "-S", FIX_MARKER, "--", "src/server/standards.ts"])
    .split("\n")
    .filter(Boolean);
  const introduced = touched.at(-1);
  if (!introduced) {
    throw new Error(
      `Could not find the commit that introduced ${FIX_MARKER} in standards.ts. ` +
        "Pass the pre-fix revision explicitly: npx tsx scripts/measure-inspector-prompt.ts <rev>",
    );
  }
  return `${introduced}^`;
}

/** Materialize the pre-fix pair out of git and import it. Never touches the worktree. */
async function readStandardsAt(rev: string): Promise<{ fn: ReadStandards; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "prefix-standards-"));
  mkdirSync(join(dir, "util"), { recursive: true });
  // Layout mirrors src/server/, so standards.ts's `./util/repo-doc.ts` resolves.
  writeFileSync(join(dir, "standards.ts"), git(["show", `${rev}:${SOURCES[0]}`]));
  writeFileSync(join(dir, "util", "repo-doc.ts"), git(["show", `${rev}:${SOURCES[1]}`]));
  const mod = (await import(pathToFileURL(join(dir, "standards.ts")).href)) as {
    readStandards: ReadStandards;
  };
  return { fn: mod.readStandards, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function promptFor(standards: ReturnType<ReadStandards>): string {
  return buildReviewPrompt({
    brief: { text: "Review this change.", source: "default", truncated: false },
    standards,
    prTitle: "fix(standards): de-duplicate symlinked repo docs",
    prBody: "A small pull request body.",
    diff: "diff --git a/src/server/standards.ts b/src/server/standards.ts\n@@ -1 +1 @@\n-a\n+b\n",
    diffTruncated: false,
    changedPaths: CHANGED_PATHS,
    open: [],
    round: 1,
  });
}

function report(label: string, standards: ReturnType<ReadStandards>): number {
  const bytes = Buffer.byteLength(promptFor(standards));
  console.log(`  ${label}`);
  for (const d of standards.docs) {
    console.log(`    doc: ${d.path.padEnd(12)} ${String(Buffer.byteLength(d.text)).padStart(6)} bytes`);
  }
  console.log(`    docs loaded:         ${standards.docs.length}`);
  console.log(
    `    standards bytes:     ${standards.docs.reduce((n, d) => n + Buffer.byteLength(d.text), 0)}`,
  );
  console.log(`    REVIEW PROMPT BYTES: ${bytes}`);
  console.log();
  return bytes;
}

const rev = preFixRev(process.argv[2]);
const { fn: readStandardsPreFix, cleanup } = await readStandardsAt(rev);
try {
  console.log(`checkout:    ${repoRoot}`);
  console.log(`root docs:   ${git(["ls-files", "-s", "AGENTS.md", "CLAUDE.md"]).trimEnd()}`);
  console.log(`pre-fix rev: ${rev} (${git(["rev-parse", "--short", rev]).trim()})`);
  console.log();

  const before = report("BEFORE - de-dup keyed on the REQUESTED path", readStandardsPreFix(repoRoot, CHANGED_PATHS));
  const after = report("AFTER  - de-dup keyed on the RESOLVED path", readStandards(repoRoot, CHANGED_PATHS));

  console.log(`  SAVED: ${before - after} bytes (${(((before - after) / before) * 100).toFixed(1)}% of the prompt)`);
  if (before <= after) {
    console.error("\nNo saving measured - is the pre-fix revision really pre-fix?");
    process.exitCode = 1;
  }
} finally {
  cleanup();
}
