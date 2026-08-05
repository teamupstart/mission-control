import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIEF_PATHS, DEFAULT_BRIEF, readBrief } from "../src/server/inspector/brief.ts";

// Where the Inspector's brief comes from, which is a question about a repository that is not
// this one: `readBrief` resolves against the root of the pull request under review.
//
// What is at stake. Nothing observable fails when this lookup stops resolving. A repo whose
// brief has moved out from under the loader is not an error - it is a repo that "ships no
// INSPECTOR.md", so it gets the generic default brief and the reviews keep arriving, just
// held to general engineering judgement instead of the project's own rules. That is the
// failure this file exists to make loud, and it is why the order is pinned here rather than
// left to whichever location happened to be checked first.
//
// The containment case is the same one `standards.test.ts` makes for AGENTS.md, restated for
// the nested candidate: adding a subdirectory to the search means a `personas` SYMLINK is now
// on the path, and the resolve-then-check ordering has to survive that. What would leak is
// worse here than a wrong review - the brief goes into a prompt whose output is a public pull
// request comment.

function repo(): string {
  return mkdtempSync(join(tmpdir(), "inspector-brief-"));
}

/** Write `personas/INSPECTOR.md`, creating the directory the way a repo would have it. */
function writeNested(root: string, text: string): void {
  mkdirSync(join(root, "personas"), { recursive: true });
  writeFileSync(join(root, "personas", "INSPECTOR.md"), text);
}

test("the candidate order is personas/ first, then the repo root", () => {
  // Pinned as data, not just as behaviour: the fallback is the half that is easy to drop in
  // a later edit, and its absence would look exactly like a repo with no brief.
  assert.deepEqual([...BRIEF_PATHS], ["personas/INSPECTOR.md", "INSPECTOR.md"]);
});

test("personas/INSPECTOR.md is the brief when a repo has one", () => {
  const root = repo();
  writeNested(root, "# Brief\n\nThe nested one.");

  const brief = readBrief(root);
  assert.equal(brief.source, "repo");
  assert.match(brief.text, /The nested one/);
  assert.equal(brief.truncated, false);
});

test("a root INSPECTOR.md is still honored, so repos configured before the move keep theirs", () => {
  const root = repo();
  writeFileSync(join(root, "INSPECTOR.md"), "# Brief\n\nThe root one.");

  const brief = readBrief(root);
  assert.equal(brief.source, "repo");
  assert.match(brief.text, /The root one/);
});

test("a repo with both is reviewed against personas/INSPECTOR.md", () => {
  const root = repo();
  writeNested(root, "# Brief\n\nThe nested one.");
  writeFileSync(join(root, "INSPECTOR.md"), "# Brief\n\nThe root one.");

  const brief = readBrief(root);
  assert.match(brief.text, /The nested one/);
  assert.doesNotMatch(brief.text, /The root one/);
});

test("an empty personas/INSPECTOR.md does not shadow a root file that says something", () => {
  const root = repo();
  // The half-finished move: the new file exists, the prose has not arrived in it yet. A
  // loader that treated "the preferred candidate exists" as the answer would review this
  // repo against the default brief while both of its briefs sat on disk.
  writeNested(root, "   \n\n");
  writeFileSync(join(root, "INSPECTOR.md"), "# Brief\n\nThe root one.");

  const brief = readBrief(root);
  assert.equal(brief.source, "repo");
  assert.match(brief.text, /The root one/);
});

test("a repo with neither is reviewed against the default brief", () => {
  const brief = readBrief(repo());
  assert.equal(brief.source, "default");
  assert.equal(brief.text, DEFAULT_BRIEF);
  assert.equal(brief.truncated, false);
});

test("a missing repo root, or none at all, is the default brief rather than a throw", () => {
  for (const root of [null, join(tmpdir(), "inspector-brief-gone-a1b2c3")]) {
    const brief = readBrief(root);
    assert.equal(brief.source, "default");
    assert.equal(brief.text, DEFAULT_BRIEF);
  }
});

test("a blank brief in both locations is not a brief", () => {
  const root = repo();
  writeNested(root, "\n");
  writeFileSync(join(root, "INSPECTOR.md"), "   ");

  assert.equal(readBrief(root).source, "default");
});

test("a personas/INSPECTOR.md symlinked out of the repo is refused, not read", () => {
  const root = repo();
  const secrets = mkdtempSync(join(tmpdir(), "inspector-brief-secrets-"));
  writeFileSync(join(secrets, "id_rsa"), "PRIVATE KEY");
  mkdirSync(join(root, "personas"), { recursive: true });
  symlinkSync(join(secrets, "id_rsa"), join(root, "personas", "INSPECTOR.md"));

  const brief = readBrief(root);
  assert.equal(brief.source, "default", "an out-of-repo link must not become the brief");
  assert.doesNotMatch(brief.text, /PRIVATE KEY/);
});

test("a symlinked personas directory pointing out of the repo is refused too", () => {
  const root = repo();
  const outside = mkdtempSync(join(tmpdir(), "inspector-brief-outside-"));
  writeFileSync(join(outside, "INSPECTOR.md"), "# Brief\n\nSomebody else's rules.");
  // The escape the nested candidate newly makes reachable: the FILE at the end of the path
  // is an ordinary file inside an ordinary directory, and only resolving the whole path
  // shows that the directory is not in this repo.
  symlinkSync(outside, join(root, "personas"));

  const brief = readBrief(root);
  assert.equal(brief.source, "default");
  assert.doesNotMatch(brief.text, /Somebody else's rules/);
});

test("a personas/INSPECTOR.md symlinked WITHIN the repo is one document and is read", () => {
  const root = repo();
  // The convention this repo itself uses for CLAUDE.md -> AGENTS.md. Containment is judged
  // on the resolved path, and a link that lands inside the repo is contained, so the
  // symlink check must not be a blanket refusal of links.
  writeFileSync(join(root, "brief-source.md"), "# Brief\n\nLinked from inside.");
  mkdirSync(join(root, "personas"), { recursive: true });
  symlinkSync(join(root, "brief-source.md"), join(root, "personas", "INSPECTOR.md"));

  const brief = readBrief(root);
  assert.equal(brief.source, "repo");
  assert.match(brief.text, /Linked from inside/);
});

test("an enormous brief is capped rather than allowed to crowd out the diff", () => {
  const root = repo();
  const size = 24 * 1024;
  writeNested(root, "#".repeat(size + 1024));

  const brief = readBrief(root);
  assert.equal(brief.source, "repo");
  assert.equal(brief.truncated, true);
  assert.equal(Buffer.byteLength(brief.text, "utf8"), size);
});

test("this repository's own brief resolves through the preferred location", () => {
  // The end of the non-negotiable, asserted against the real checkout: the reason this file
  // exists is that moving `INSPECTOR.md` silently downgraded Mission Control's reviews OF
  // ITSELF, and only a test that reads this repo can see that.
  const brief = readBrief(join(import.meta.dirname, ".."));
  assert.equal(brief.source, "repo");
  assert.match(brief.text, /^# INSPECTOR\.md/);
});
