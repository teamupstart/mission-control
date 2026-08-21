import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MEMORY_DIR,
  MEMORY_INDEX_PATH,
  MEMORY_POINTER_LINE,
  MEMORY_REFERENCE_MARKER,
  withMemoryPointer,
} from "../src/shared/memory.ts";
import { hasRepoMemory, withRepoMemoryPointer } from "../src/server/memory.ts";
import { preparePiLaunch } from "../src/server/harness/pi/launch.ts";

// The `.agents/memory/` convention: where a repository's committed agent memory lives, and
// how a harness with no file channel of its own is told about it.
//
// The values are the interesting part. They become paths committed into repositories
// Mission Control does not own, so a rename here does not break a build - it orphans every
// memory anyone has already written, in every checkout, silently. That is what these pin.

const here = fileURLToPath(new URL(".", import.meta.url));

function mkRepo(): string {
  return mkdtempSync(join(tmpdir(), "repo-memory-"));
}

/** A repo carrying an index, the way a retro's first commit leaves it. */
function mkRepoWithMemory(body = "- [a-trap](a-trap.md) - the grep wrapper lies here\n"): string {
  const root = mkRepo();
  mkdirSync(join(root, MEMORY_DIR), { recursive: true });
  writeFileSync(join(root, MEMORY_INDEX_PATH), body);
  return root;
}

test("the convention's paths are frozen, because repos already hold them", () => {
  assert.equal(MEMORY_DIR, ".agents/memory");
  assert.equal(MEMORY_INDEX_PATH, ".agents/memory/MEMORY.md");
  assert.equal(MEMORY_INDEX_PATH.startsWith(`${MEMORY_DIR}/`), true);
  // The marker is what the retro greps AGENTS.md for to decide whether the reference line
  // is already there. It may diverge from the path later; today it is the path, and it has
  // to be a substring of the line every consumer writes or the check reads "missing" and a
  // second line is appended on every retro.
  assert.equal(MEMORY_REFERENCE_MARKER, MEMORY_INDEX_PATH);
  assert.ok(MEMORY_POINTER_LINE.includes(MEMORY_REFERENCE_MARKER));
});

test("the convention module stays browser-safe", () => {
  // `src/shared/` is a controlled path: the dashboard bundles it, so one `node:` import
  // takes the web build down. Phase 3 imports these constants into the browser.
  const source = readFileSync(`${here}../src/shared/memory.ts`, "utf8");
  assert.equal(/from "node:/.test(source), false, "shared code may not import node builtins");
});

test("the pointer names the index and the entries it links", () => {
  // An index is a table of contents. An agent that reads it and stops has the titles of
  // this repo's traps and none of the traps, which is the failure mode the line is worded
  // against - and the path in it is derived from the constant, never retyped.
  assert.ok(MEMORY_POINTER_LINE.includes(MEMORY_INDEX_PATH));
  assert.match(MEMORY_POINTER_LINE, /links/);
  assert.equal(MEMORY_POINTER_LINE.includes("\n"), false, "it is one line, ahead of the task");

  const composed = withMemoryPointer("Fix the login bug.");
  assert.equal(composed, `${MEMORY_POINTER_LINE}\n\nFix the login bug.`);
  assert.ok(composed.endsWith("Fix the login bug."), "the task is still the last word");
});

test("a repo carrying an index is found; one without it is simply not", () => {
  assert.equal(hasRepoMemory(mkRepoWithMemory()), true);
  assert.equal(hasRepoMemory(mkRepo()), false, "no memory yet is the normal state of a repo");
  assert.equal(hasRepoMemory(null), false);
  assert.equal(hasRepoMemory("/nope/not/here"), false);
});

test("an index that is a directory, or a dangling link, is not an index", () => {
  // Both would pass a bare `existsSync`-shaped check and hand a session a pointer at
  // something it cannot read - a failed tool call before turn one has begun.
  const asDir = mkRepo();
  mkdirSync(join(asDir, MEMORY_INDEX_PATH), { recursive: true });
  assert.equal(hasRepoMemory(asDir), false);

  const dangling = mkRepo();
  mkdirSync(join(dangling, MEMORY_DIR), { recursive: true });
  symlinkSync(join(dangling, "gone.md"), join(dangling, MEMORY_INDEX_PATH));
  assert.equal(hasRepoMemory(dangling), false);
});

test("an index symlinked INSIDE the repo counts; one pointing OUT does not", () => {
  // Same line `readRepoDoc` draws, for the milder reason: nothing here reads the file, but
  // a pointer at a link that leaves the tree sends the agent it is handed to off to read
  // whatever is on the far end - which is not something this repository asserts.
  const linked = mkRepo();
  mkdirSync(join(linked, MEMORY_DIR), { recursive: true });
  writeFileSync(join(linked, "docs-memory.md"), "- [a-trap](a-trap.md)\n");
  symlinkSync(join(linked, "docs-memory.md"), join(linked, MEMORY_INDEX_PATH));
  assert.equal(hasRepoMemory(linked), true, "a repo keeping its index elsewhere is ordinary");

  const escaping = mkRepo();
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  writeFileSync(join(outside, "notes.md"), "not this repo's memory");
  mkdirSync(join(escaping, MEMORY_DIR), { recursive: true });
  symlinkSync(join(outside, "notes.md"), join(escaping, MEMORY_INDEX_PATH));
  assert.equal(hasRepoMemory(escaping), false);
});

test("a repo whose own path runs through a symlink still finds its memory", () => {
  // Containment is real-path against real-path. Judging the resolved file against an
  // unresolved root rejects every index in a checkout reached through a link - which is
  // not exotic: /tmp is one on macOS, and so is many a home directory, and MC's own
  // worktrees live under both.
  const real = mkRepoWithMemory();
  const linkRoot = mkdtempSync(join(tmpdir(), "repo-memory-link-"));
  const link = join(linkRoot, "checkout");
  symlinkSync(real, link);
  assert.equal(hasRepoMemory(link), true);
});

test("the dispatch pointer is added only when there is memory to point at", () => {
  const withMemory = mkRepoWithMemory();
  assert.equal(withRepoMemoryPointer(withMemory, "Fix the login bug."), withMemoryPointer("Fix the login bug."));

  const bare = mkRepo();
  assert.equal(
    withRepoMemoryPointer(bare, "Fix the login bug."),
    "Fix the login bug.",
    "a repo with no memories gets its intent untouched, not a pointer at a missing file",
  );
  assert.equal(withRepoMemoryPointer(null, "Fix the login bug."), "Fix the login bug.");
});

test("pi's launch message carries the pointer, and stays positional either way", () => {
  // Pi's turn one rides the launch argv, so the pointer has to be composed before
  // `preparePiLaunch` - and that function's guard prefixes a newline when the message
  // opens with `-` or `@`, which Pi's parser would otherwise read as a flag or a file
  // operand. With a pointer in front, the guard correctly sees ordinary prose and the
  // hazard character lands mid-string, where it is unambiguous.
  const root = mkRepoWithMemory();
  const pointed = preparePiLaunch(withRepoMemoryPointer(root, "@src/main.ts is relevant"));
  assert.equal(pointed.args[2]?.startsWith(MEMORY_POINTER_LINE), true);
  assert.equal(pointed.args[2]?.startsWith("\n"), false, "no guard needed - it opens with prose");
  assert.ok(pointed.args[2]?.includes("@src/main.ts is relevant"));

  // And with no memory in the repo, the guard behaves exactly as it did before this phase.
  const bare = preparePiLaunch(withRepoMemoryPointer(mkRepo(), "@src/main.ts is relevant"));
  assert.equal(bare.args[2], "\n@src/main.ts is relevant");
});

test("the dispatcher composes pi's turn one through the pointer", () => {
  // The seam itself, pinned in source: everything above tests the composition, and this
  // tests that dispatch actually uses it. Pi is the only harness that needs it - Claude
  // and Codex load the worktree's root doc natively, and the committed reference line
  // rides in on that - so there is exactly one call site and it is easy to lose in a
  // refactor of a 600-line method with no test that would notice.
  //
  // The second argument is `intent` rather than `task.intent`: dispatch composes turn one
  // once - prepending the multi-repo manifest when the task attaches other repositories -
  // and every runtime path delivers that same string. Pi's pointer wraps the composed
  // intent, so a pi session reads the memory pointer first and the task second, whichever
  // shape the task has. (Pi declares no `multiRepoDispatch`, so today that composition is
  // always the identity for pi - but the seam is what this test pins, not the arithmetic.)
  const dispatcher = readFileSync(`${here}../src/server/dispatcher.ts`, "utf8");
  // Bound to a NAMED composition rather than to one nested call, because the composed text
  // now has a second reader: the launch-presentation marker fingerprints the exact string
  // pi was launched with, and fingerprinting a recomposed copy is how the two answers drift
  // apart. So what is pinned is that the pointer wraps the composed intent once, under a
  // name, and that `preparePiLaunch` is handed that same name.
  assert.match(
    dispatcher,
    /const piText\s*=[^;]*withRepoMemoryPointer\(\s*wt\.path,\s*intent,?\s*\)/,
    "pi's launch message must be composed through withRepoMemoryPointer",
  );
  assert.match(
    dispatcher,
    /preparePiLaunch\(\s*piText,?\s*\)/,
    "and preparePiLaunch must receive that exact composed string",
  );
});
