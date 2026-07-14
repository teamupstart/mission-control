import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStandards } from "../src/server/standards.ts";

// What the queue verifier is handed as "this repo's bar". Getting the file set wrong
// isn't cosmetic in either direction: too few and it misses the repo's contract, too
// many and it invents `standards` gaps from text the repo never asserted - and one of
// the ways to get it wrong reads files the repo never asserted anything about at all.

function mkRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "standards-"));
  mkdirSync(join(root, "packages", "app", "src"), { recursive: true });
  return root;
}

const paths = (r: { docs: Array<{ path: string }> }): string[] => r.docs.map((d) => d.path).sort();

test("reads the repo-root docs that always apply", () => {
  const root = mkRepo();
  writeFileSync(join(root, "AGENTS.md"), "# the contract");
  writeFileSync(join(root, "CLAUDE.md"), "# also the contract");

  const out = readStandards(root, ["packages/app/src/a.ts"]);
  assert.deepEqual(paths(out), ["AGENTS.md", "CLAUDE.md"]);
  assert.match(out.docs[0]!.text, /the contract/);
});

test("root-relative changed paths resolve from the TOPLEVEL, not a session's subdirectory", () => {
  // `changedPaths` parses `+++ b/...` out of the diff, and git emits those relative
  // to the toplevel wherever it was invoked from. Passing a session's cwd as the
  // root (say /repo/packages/app) looked for /repo/packages/app/AGENTS.md and
  // resolved a changed path to /repo/packages/app/packages/app/src/a.ts - a chain
  // that doesn't exist. The result was zero docs with `truncated: false`, so the
  // prompt didn't even print its "some standards were omitted" line: the verifier
  // judged against the repo's main contract without it, and nothing said so.
  const root = mkRepo();
  writeFileSync(join(root, "AGENTS.md"), "# the root contract");
  writeFileSync(join(root, "packages", "app", "CLAUDE.md"), "# the package's own");

  const out = readStandards(root, ["packages/app/src/a.ts"]);
  assert.deepEqual(paths(out), ["AGENTS.md", "packages/app/CLAUDE.md"]);

  // The bug's shape, pinned: rooted at the package, the repo's MAIN contract is
  // simply absent - and `truncated` stays false, so nothing anywhere says so.
  const wrong = readStandards(join(root, "packages", "app"), ["packages/app/src/a.ts"]);
  assert.equal(
    wrong.docs.some((d) => d.text.includes("the root contract")),
    false,
    "this is why the root has to be the git toplevel",
  );
  assert.equal(wrong.truncated, false, "and the silence is total - the prompt can't even flag it");
});

test("a nested doc governing an ancestor of a changed file is included", () => {
  const root = mkRepo();
  writeFileSync(join(root, "packages", "AGENTS.md"), "# governs everything below");

  const out = readStandards(root, ["packages/app/src/a.ts"]);
  assert.deepEqual(paths(out), ["packages/AGENTS.md"]);
});

test("a symlinked doc pointing OUTSIDE the repo is never read", () => {
  // The security case, and the reason it matters more here than it would elsewhere:
  // the verifier is spawned `--tools ""` precisely so untrusted repo content cannot
  // steer it into reading arbitrary files. A symlinked AGENTS.md let repo content
  // achieve exactly that through the daemon instead - which runs with the user's
  // full read access - and the contents would be embedded in the verify prompt and
  // sent to the API. `withinRoot` is a string check; readFileSync follows links, so
  // the containment test has to run on the resolved path.
  const root = mkRepo();
  const secrets = mkdtempSync(join(tmpdir(), "secrets-"));
  writeFileSync(join(secrets, "id_rsa"), "PRIVATE KEY MATERIAL");
  symlinkSync(join(secrets, "id_rsa"), join(root, "AGENTS.md"));

  const out = readStandards(root, []);
  assert.deepEqual(out.docs, [], "a link out of the repo is not a standard this repo asserts");
  assert.equal(
    JSON.stringify(out).includes("PRIVATE KEY MATERIAL"),
    false,
    "and nothing it points at reaches the prompt",
  );
});

test("a symlink that stays INSIDE the repo is still read", () => {
  // The guard is about leaving the repo, not about links: a repo that keeps its
  // contract in docs/ and links AGENTS.md at it is doing something ordinary.
  const root = mkRepo();
  writeFileSync(join(root, "packages", "app", "src", "real.md"), "# the linked contract");
  symlinkSync(join(root, "packages", "app", "src", "real.md"), join(root, "AGENTS.md"));

  const out = readStandards(root, []);
  assert.deepEqual(paths(out), ["AGENTS.md"], "cited by the path the repo uses, not the target");
  assert.match(out.docs[0]!.text, /the linked contract/);
});

test("a `..` escape in a changed path reads nothing outside the root", () => {
  const root = mkRepo();
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  writeFileSync(join(outside, "CLAUDE.md"), "# not this repo's");

  const out = readStandards(root, [`../${join(outside, "a.ts")}`, "../../etc/a.ts"]);
  assert.equal(
    out.docs.some((d) => d.text.includes("not this repo's")),
    false,
  );
});

test("an oversized doc is capped, and says so", () => {
  const root = mkRepo();
  // Past MAX_FILE_BYTES (24KB). The cap has to gate the READ, not just the prompt:
  // slicing after readFileSync still materializes the whole file, so a huge doc is
  // fully allocated per verify and one past ~512MB throws ERR_STRING_TOO_LONG -
  // which readDoc's catch would swallow as "not a standard that applies".
  writeFileSync(join(root, "AGENTS.md"), "x".repeat(30 * 1024));

  const out = readStandards(root, []);
  assert.equal(out.docs.length, 1);
  assert.equal(out.docs[0]!.truncated, true);
  assert.equal(out.docs[0]!.text.length, 24 * 1024);
});

test("a missing root, or a root that isn't there, is simply no standards", () => {
  assert.deepEqual(readStandards(null, ["a.ts"]), { docs: [], truncated: false });
  assert.deepEqual(readStandards("/nope/not/here", ["a.ts"]), { docs: [], truncated: false });
});
