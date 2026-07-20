import { test } from "node:test";
import assert from "node:assert/strict";
import { changedPaths, commentableLines } from "../src/server/inspector/diff-lines.ts";

// Posting a review with inline comments is ONE GitHub call, and GitHub 422s the WHOLE
// request if any single comment names a line that isn't in the diff. So one bad line
// number doesn't cost one comment - it costs the entire round, silently, after the
// model has already been paid for.
//
// A model asked for a line number will eventually produce a plausible wrong one, so
// this parser is the thing standing between "the reviewer found four issues" and "the
// reviewer posted nothing again".

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,6 @@
 import { x } from "./x.ts";
+import { y } from "./y.ts";

-const old = 1;
+const next = 2;
+const more = 3;
 export { x };
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -10,2 +12,3 @@
 keep();
+added();
 tail();
`;

test("added and context lines are both commentable; removed lines are not", () => {
  const lines = commentableLines(DIFF);
  // New-file numbering: 1 import, 2 import, 3 blank, 4 next, 5 more, 6 export.
  assert.deepEqual([...lines.get("src/a.ts")!].sort((p, q) => p - q), [1, 2, 3, 4, 5, 6]);
  // A comment often wants to point at unchanged code right beside a change, and GitHub
  // allows it - so context lines must be in the set, not just added ones.
  assert.ok(lines.get("src/a.ts")!.has(1), "context line should be commentable");
  assert.ok(lines.get("src/a.ts")!.has(4), "added line should be commentable");
});

test("a second file starts its own numbering from its own hunk header", () => {
  const lines = commentableLines(DIFF);
  assert.deepEqual([...lines.get("src/b.ts")!].sort((p, q) => p - q), [12, 13, 14]);
});

test("the changed-path list is what a finding has to name to be postable at all", () => {
  // This list IS leak-defence layer 4: a finding about a file outside it is dropped, so
  // "read a secret and repeat it" has nowhere to land.
  assert.deepEqual(changedPaths(DIFF).sort(), ["src/a.ts", "src/b.ts"]);
});

test("a deleted file offers nothing to comment on", () => {
  const deletion = `diff --git a/src/gone.ts b/src/gone.ts
--- a/src/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-const a = 1;
-const b = 2;
`;
  // Not "an empty set for src/gone.ts" - the path must be absent entirely, or a finding
  // about a file that no longer exists would pass the layer-4 check.
  assert.deepEqual(changedPaths(deletion), []);
});

test("a new file is commentable from its first line", () => {
  const added = `diff --git a/src/new.ts b/src/new.ts
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,3 @@
+const a = 1;
+const b = 2;
+const c = 3;
`;
  assert.deepEqual([...commentableLines(added).get("src/new.ts")!].sort((p, q) => p - q), [1, 2, 3]);
});

test("a single-line hunk header with no count still yields exactly one line", () => {
  // "@@ -1 +7 @@" means one line, not zero and not unbounded. Reading the absent count
  // as 0 loses the line; reading it as unbounded swallows the rest of the file.
  const one = `--- a/src/c.ts
+++ b/src/c.ts
@@ -1 +7 @@
+only();
`;
  assert.deepEqual([...commentableLines(one).get("src/c.ts")!], [7]);
});

test("a no-newline marker annotates the previous line rather than being one", () => {
  const noNewline = `--- a/src/d.ts
+++ b/src/d.ts
@@ -1,1 +1,1 @@
+const a = 1;
\\ No newline at end of file
`;
  assert.deepEqual([...commentableLines(noNewline).get("src/d.ts")!], [1]);
});

test("a rename anchors on the NEW path, the only one GitHub accepts", () => {
  const renamed = `diff --git a/src/old.ts b/src/new.ts
similarity index 90%
rename from src/old.ts
rename to src/new.ts
--- a/src/old.ts
+++ b/src/new.ts
@@ -1,2 +1,2 @@
 keep();
+changed();
`;
  assert.deepEqual(changedPaths(renamed), ["src/new.ts"]);
});

// We cap the diff we send to the model, so a final hunk whose header promises more
// lines than are actually present is an ordinary case, not a corrupt one. The trailing
// newline then leaves an empty string behind, which is indistinguishable from an empty
// context line - and counting it invents a line one past the end of the file. A comment
// anchored there is the 422 that discards the entire review.
test("a hunk header that over-counts does not invent a line past the end", () => {
  const truncated = `--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,5 @@
 import { x } from "./x.ts";
+const added = 1;
+const more = 2;
 export { x };
`;
  assert.deepEqual(
    [...commentableLines(truncated).get("src/a.ts")!].sort((p, q) => p - q),
    [1, 2, 3, 4],
    "five promised, four present - the fifth does not exist",
  );
});

test("an empty or junk diff yields nothing rather than throwing", () => {
  assert.deepEqual(changedPaths(""), []);
  assert.deepEqual(changedPaths("not a diff at all\njust some text\n"), []);
});
