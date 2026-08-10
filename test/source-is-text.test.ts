import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Every tracked source file is TEXT, byte for byte.
 *
 * This exists because it already happened: a template literal in `retro-worthiness.ts` was
 * written with a raw NUL as its separator. Nothing failed. `tsc` compiled it, `esbuild`
 * bundled it, the unit tests passed, the browser suite passed - and `git diff` reported
 * `Bin 0 -> 10145 bytes` for a 200-line TypeScript file, because a single NUL is all it
 * takes for git to classify a file as binary.
 *
 * What that costs is not cosmetic and is not caught by any other check here:
 *
 *  - The file cannot be code-reviewed. A pull request shows "binary file changed" and no
 *    diff, so a reviewer approves prose they were never shown.
 *  - Every `grep` over it stops matching, silently. This repository has a memory entry
 *    about exactly that failure mode on `protocol.ts` - a negative search result that was
 *    a tooling artifact rather than an answer.
 *  - The offending byte is invisible in every editor, so nobody finds it by looking.
 *
 * A control character in a string is a legitimate thing to want. Writing it as a
 * backslash-u escape produces the identical value and keeps the file text, so the rule
 * costs an author nothing. This comment deliberately spells that out in words rather than
 * demonstrating it: a doc comment showing the raw byte is how this very file first came to
 * fail its own assertion.
 *
 * Scoped by `git ls-files --cached --others --exclude-standard`, so a build output, a
 * fixture recording or anything gitignored is out of scope by construction - the claim is
 * about reviewable source.
 *
 * `--others` is not optional and is the second thing this file learned the hard way. Scoped
 * to tracked files alone, the guard cannot see a file that has just been WRITTEN and not yet
 * staged - which is precisely the moment the mistake is made and the only moment fixing it is
 * free. Run locally against an unstaged new file it passed; the same file failed in CI one
 * commit later.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Extensions this repository writes by hand and reviews as prose. */
const TEXT_SUFFIXES = [
  ".ts", ".tsx", ".mts", ".mjs", ".js", ".jsx",
  ".json", ".md", ".css", ".html", ".yml", ".yaml", ".sh",
];

test("no tracked source file contains a NUL byte", () => {
  const tracked = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  })
    .split("\0")
    .filter((path) => path.length > 0 && TEXT_SUFFIXES.some((suffix) => path.endsWith(suffix)));

  // A guard that scanned nothing would pass forever. `git ls-files` returns empty outside a
  // checkout, and a suffix list that stopped matching would empty this silently.
  assert.ok(tracked.length > 500, `expected the whole source tree, scanned ${tracked.length}`);
  // And it has to be able to see ITSELF, which is the property `--others` buys and the one
  // that actually failed. A file this test cannot find is a file it cannot vouch for.
  assert.ok(
    tracked.includes("test/source-is-text.test.ts"),
    "the scan must include this file, or it is not scanning what it claims to",
  );

  const binary = tracked.filter((path) => {
    try {
      return readFileSync(new URL(path, `file://${REPO_ROOT}`)).includes(0);
    } catch {
      // A path in the index with nothing on disk is somebody else's problem (a broken
      // symlink, a partially-applied checkout), not evidence about encoding.
      return false;
    }
  });

  assert.deepEqual(
    binary,
    [],
    `these are tracked as source but contain a NUL byte, so git diffs them as binary and`
      + ` grep skips them - write the control character as an escape instead:\n${binary.join("\n")}`,
  );
});
