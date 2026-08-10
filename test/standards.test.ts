import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStandards } from "../src/server/standards.ts";
import { MEMORY_DIR, MEMORY_INDEX_PATH } from "../src/shared/memory.ts";
import { StandardsRequestSchema } from "../src/shared/protocol.ts";

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

test("CLAUDE.md symlinked to AGENTS.md is ONE document, not two copies of it", () => {
  // The shape this repo itself ships, and both names are in ROOT_NAMES - so the bundle
  // asked for both, resolved both to the same file, and emitted it twice. The
  // de-duplication was keyed on the REQUESTED path, which cannot see that two names are
  // one file. A whole second copy of the doc, byte-identical, paid on every Inspector
  // review and every queue verify - min(fileSize, MAX_FILE_BYTES) of it, so the figure
  // moves with the root doc. See docs/agent-guides/inspector-prompt-bytes.md.
  const root = mkRepo();
  writeFileSync(join(root, "AGENTS.md"), "# the one contract");
  symlinkSync(join(root, "AGENTS.md"), join(root, "CLAUDE.md"));

  const out = readStandards(root, ["packages/app/src/a.ts"]);
  assert.deepEqual(paths(out), ["AGENTS.md"], "one file is one document, whatever it's named");
  assert.equal(out.docs.length, 1);
  // ROOT_NAMES order decides the survivor, so the citation is deterministic rather
  // than whichever name the filesystem happened to hand back first.
  assert.equal(out.docs[0]!.path, "AGENTS.md");
  assert.match(out.docs[0]!.text, /the one contract/);
  assert.equal(out.truncated, false, "nothing was omitted - the duplicate was never a second doc");
});

test("a nested CLAUDE.md symlinked to its AGENTS.md sibling is also ONE document", () => {
  // The climb pushes both NESTED_NAMES per directory, so the same defect lives on the
  // nested path - and a monorepo linking the two in each package pays it per package.
  const root = mkRepo();
  writeFileSync(join(root, "packages", "app", "AGENTS.md"), "# the package's own");
  symlinkSync(join(root, "packages", "app", "AGENTS.md"), join(root, "packages", "app", "CLAUDE.md"));

  const out = readStandards(root, ["packages/app/src/a.ts"]);
  assert.deepEqual(paths(out), ["packages/app/CLAUDE.md"], "NESTED_NAMES order picks the survivor");
  assert.equal(out.docs.length, 1);
});

test("two root docs that are genuinely DIFFERENT files are both still read", () => {
  // The other side of the same fix, and the reason it keys on the resolved path rather
  // than on the text: a repo that really does ship two different root docs asserts two
  // contracts, and dropping one because it shares a name list with the other would lose
  // half the bar the verifier judges against. Over-dedup fails silently - the prompt
  // looks well-formed with a document missing.
  const root = mkRepo();
  writeFileSync(join(root, "AGENTS.md"), "# the agent contract");
  writeFileSync(join(root, "CLAUDE.md"), "# a genuinely separate contract");

  const out = readStandards(root, []);
  assert.deepEqual(paths(out), ["AGENTS.md", "CLAUDE.md"]);
  assert.equal(out.docs.length, 2);
});

test("two root docs with IDENTICAL text but separate files are both still read", () => {
  // Sharpens the line: identity is the file, not the bytes. Two copies someone forgot
  // to link are two documents the repo asserts, and an editor may change one tomorrow -
  // de-duplicating on content would make them one and silently drop the divergence.
  const root = mkRepo();
  writeFileSync(join(root, "AGENTS.md"), "# byte for byte the same");
  writeFileSync(join(root, "CLAUDE.md"), "# byte for byte the same");

  const out = readStandards(root, []);
  assert.deepEqual(paths(out), ["AGENTS.md", "CLAUDE.md"]);
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

test("past the changed-path cap the bundle SAYS docs may be missing", () => {
  // The path list is derived from a patch capped at 1.2MB, so it has no small bound
  // of its own. Whatever we drop, the verifier has to be told: judging an item
  // against the repo's contract while silently having read less of it than it thinks
  // is how a verifier invents `standards` gaps against a doc it never opened.
  const root = mkRepo();
  writeFileSync(join(root, "AGENTS.md"), "# the root contract");
  mkdirSync(join(root, "packages", "late"), { recursive: true });
  writeFileSync(join(root, "packages", "late", "CLAUDE.md"), "# governs the tail");

  const many = Array.from({ length: 1000 }, (_, i) => `packages/app/src/a${i}.ts`);
  const out = readStandards(root, [...many, "packages/late/x.ts"]);

  assert.deepEqual(paths(out), ["AGENTS.md"], "the tail's doc was past the cap");
  assert.equal(out.truncated, true, "and the prompt must print its omitted-docs line");

  // Exactly at the cap nothing was dropped, so nothing may claim it was.
  const atCap = readStandards(root, many);
  assert.equal(atCap.truncated, false);
});

test("a missing root, or a root that isn't there, is simply no standards", () => {
  assert.deepEqual(readStandards(null, ["a.ts"]), { docs: [], truncated: false });
  assert.deepEqual(readStandards("/nope/not/here", ["a.ts"]), { docs: [], truncated: false });
});

// ---- the repository's committed agent memory ----
//
// `.agents/memory/MEMORY.md` is the index half of the memory convention, and this bundle is
// the ONLY way MC's own reviewers can see it: a dispatched session loads it through its
// harness's instruction-file loading, while the Inspector and the workflow personas read
// what this function returns and nothing else. A repo that has none is the normal case and
// must be affected in no way at all.

function writeMemoryIndex(root: string, body: string): void {
  mkdirSync(join(root, MEMORY_DIR), { recursive: true });
  writeFileSync(join(root, MEMORY_INDEX_PATH), body);
}

test("the committed memory index loads alongside the root contract", () => {
  const root = mkRepo();
  writeFileSync(join(root, "AGENTS.md"), "# the contract");
  writeMemoryIndex(root, "- [grep-wrapper-lies](grep-wrapper-lies.md) - negatives need `command grep`\n");

  const out = readStandards(root, ["packages/app/src/a.ts"]);
  assert.deepEqual(paths(out), [".agents/memory/MEMORY.md", "AGENTS.md"]);
  assert.match(out.docs.find((d) => d.path === MEMORY_INDEX_PATH)!.text, /grep-wrapper-lies/);
  // Cited by its repo-relative path, so a finding can name the file the repo knows.
  assert.equal(out.docs.some((d) => d.path === MEMORY_INDEX_PATH), true);
});

test("a repo with no memory is exactly the repo it was", () => {
  // The convention is opt-in and arrives with a repo's first retro. Until then nothing
  // about the bundle may change - not its contents, not its `truncated` flag.
  const root = mkRepo();
  writeFileSync(join(root, "AGENTS.md"), "# the contract");

  const out = readStandards(root, ["packages/app/src/a.ts"]);
  assert.deepEqual(paths(out), ["AGENTS.md"]);
  assert.equal(out.truncated, false);
});

test("the root contract is read FIRST, so it wins the budget and the citation", () => {
  const root = mkRepo();
  writeFileSync(join(root, "AGENTS.md"), "# the contract");
  writeMemoryIndex(root, "- [a-trap](a-trap.md)\n");

  const out = readStandards(root, []);
  assert.deepEqual(out.docs.map((d) => d.path), ["AGENTS.md", MEMORY_INDEX_PATH]);
});

test("at the total cap the memory index is dropped, and the root docs are not", () => {
  // Order is the whole mechanism: memory is the newer, cheaper, more disposable half of
  // the contract, so a repo whose root docs already fill the 64KB bundle keeps them. The
  // drop is still REPORTED - a reviewer judging against a contract it silently didn't read
  // invents gaps.
  const root = mkRepo();
  writeFileSync(join(root, "AGENTS.md"), `# agents\n${"x".repeat(24 * 1024)}`);
  writeFileSync(join(root, "CLAUDE.md"), `# claude\n${"y".repeat(24 * 1024)}`);
  writeMemoryIndex(root, `# memory\n${"z".repeat(24 * 1024)}`);

  const out = readStandards(root, []);
  assert.deepEqual(paths(out), ["AGENTS.md", "CLAUDE.md"], "the repo's own contract survives");
  assert.equal(out.truncated, true, "and the prompt must print its omitted-docs line");
});

test("an oversized memory index is capped like any other doc, and says so", () => {
  // The retro caps entry length so this never fires in practice; when it does, the index
  // must arrive short and honest rather than push the root contract out.
  const root = mkRepo();
  writeFileSync(join(root, "AGENTS.md"), "# the contract");
  writeMemoryIndex(root, "m".repeat(30 * 1024));

  const out = readStandards(root, []);
  assert.deepEqual(paths(out), [".agents/memory/MEMORY.md", "AGENTS.md"]);
  const memory = out.docs.find((d) => d.path === MEMORY_INDEX_PATH)!;
  assert.equal(memory.truncated, true);
  assert.equal(memory.text.length, 24 * 1024);
});

test("a memory index symlinked OUTSIDE the repo is never read", () => {
  // Memory is repo content, so it is untrusted input like every other file here, and this
  // path is newly readable by the daemon: a repo can ship `.agents/memory/MEMORY.md` as a
  // link to anything and the bytes would go straight into a review prompt.
  const root = mkRepo();
  const secrets = mkdtempSync(join(tmpdir(), "secrets-"));
  writeFileSync(join(secrets, "id_rsa"), "PRIVATE KEY MATERIAL");
  mkdirSync(join(root, MEMORY_DIR), { recursive: true });
  symlinkSync(join(secrets, "id_rsa"), join(root, MEMORY_INDEX_PATH));

  const out = readStandards(root, []);
  assert.deepEqual(out.docs, []);
  assert.equal(JSON.stringify(out).includes("PRIVATE KEY MATERIAL"), false);
});

test("a memory index symlinked to the root doc is ONE document", () => {
  // The degenerate repo that keeps everything in AGENTS.md and links the index at it. The
  // resolved-path dedupe already covers it; this pins that the new entry joined the list
  // that dedupe sees, and that ROOT_NAMES order keeps AGENTS.md as the citation.
  const root = mkRepo();
  writeFileSync(join(root, "AGENTS.md"), "# the one contract");
  mkdirSync(join(root, MEMORY_DIR), { recursive: true });
  symlinkSync(join(root, "AGENTS.md"), join(root, MEMORY_INDEX_PATH));

  const out = readStandards(root, []);
  assert.deepEqual(out.docs.map((d) => d.path), ["AGENTS.md"]);
  assert.equal(out.truncated, false);
});

// ---- the request boundary ----
//
// `readStandards` climbs `dirname` from every path to the repo root, pushing an entry
// per level, so its cost is quadratic in a path's DEPTH. MAX_CHANGED_PATHS bounds how
// many paths it walks and reports the drop, but nothing bounded how DEEP any one of
// them went - and the schema accepted an unbounded array of unbounded strings, so a
// ~16KB body could stall the daemon's event loop for seconds and a slightly bigger
// one exhaust its heap. The bound belongs at the boundary, where every sibling schema
// in protocol.ts already puts one.

test("the standards request refuses a pathologically DEEP path", () => {
  const deep = `${Array(8000).fill("a").join("/")}/x.ts`;
  assert.equal(StandardsRequestSchema.safeParse({ paths: [deep] }).success, false);
});

test("the standards request refuses an unbounded number of paths", () => {
  assert.equal(StandardsRequestSchema.safeParse({ paths: Array(6000).fill("src/a.ts") }).success, false);
});

test("the standards request still accepts the paths a real diff produces", () => {
  // The bound is only worth anything if it never fires on real input - including the
  // deep-ish paths a monorepo genuinely has.
  const r = StandardsRequestSchema.safeParse({
    paths: [
      "src/server/foreman/queue-machine.ts",
      "packages/app/src/components/settings/panels/deep/nested/Thing.tsx",
      "a/very/long/but/entirely/ordinary/path/that/a/monorepo/might/really/contain/file.ts",
    ],
  });
  assert.equal(r.success, true);
  assert.equal(r.success && r.data.paths.length, 3);
});

test("many files under one tree still collect every ancestor doc exactly once", () => {
  // The climb now BREAKS at the first already-seen directory rather than walking
  // past it, because any dir in `seenDirs` had its whole chain walked to the root
  // when it was added - so there is provably nothing above it left to collect. This
  // is the guard on that "provably": stopping early must not lose an ancestor doc.
  const root = mkRepo();
  writeFileSync(join(root, "AGENTS.md"), "# root");
  writeFileSync(join(root, "packages", "app", "CLAUDE.md"), "# app rules");
  writeFileSync(join(root, "packages", "app", "src", "AGENTS.md"), "# src rules");

  // 50 files under one tree: without the break this walks the same chain 50 times.
  const many = Array.from({ length: 50 }, (_, i) => `packages/app/src/f${i}.ts`);
  const out = readStandards(root, many);
  assert.deepEqual(paths(out), ["AGENTS.md", "packages/app/CLAUDE.md", "packages/app/src/AGENTS.md"]);
  assert.equal(out.truncated, false, "nothing was dropped - this is an ordinary change");
});

test("a pathological path set is bounded, and SAYS it was truncated", () => {
  // REQUEST_PATH_MAX bounds one path's depth and MAX_CHANGED_PATHS bounds how many
  // are walked; neither bounds the PRODUCT, which is what the climb actually costs.
  // The docs governing the dropped directories are then missed, so the bundle has to
  // say so - a verifier judging against a contract it silently didn't read invents
  // gaps, which is worse than admitting a doc is missing.
  const root = mkRepo();
  writeFileSync(join(root, "AGENTS.md"), "# root");

  // 1000 disjoint chains, each ~40 deep: ~40k distinct directories, well past the cap.
  const deep = Array.from({ length: 1000 }, (_, i) => {
    const chain = Array.from({ length: 40 }, (_, d) => `d${i}_${d}`).join("/");
    return `${chain}/file.ts`;
  });
  const started = Date.now();
  const out = readStandards(root, deep);
  assert.ok(
    Date.now() - started < 5000,
    "the daemon's one synchronous handle also serves SQLite, SSE and hook ingest",
  );
  assert.equal(out.truncated, true, "docs governing the dropped directories are missed");
  assert.deepEqual(paths(out), ["AGENTS.md"], "the root contract still loads");
});
