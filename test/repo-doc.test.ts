import assert from "node:assert/strict";
import test from "node:test";
import { withinRoot } from "../src/server/util/repo-doc.ts";

test("withinRoot judges path segments, not string prefixes", () => {
  const root = "/work/repo";
  // Contained: the root itself, ordinary children, and names that merely begin with "..".
  assert.equal(withinRoot(root, "/work/repo"), true);
  assert.equal(withinRoot(root, "/work/repo/a/b.md"), true);
  assert.equal(withinRoot(root, "/work/repo/..ship.md"), true);
  assert.equal(withinRoot(root, "/work/repo/..hidden/SKILL.md"), true);
  // Escapes: the parent, a parent-directory segment, and a sibling sharing the root's prefix.
  assert.equal(withinRoot(root, "/work"), false);
  assert.equal(withinRoot(root, "/work/repo/../secret.md"), false);
  assert.equal(withinRoot(root, "/work/repo-evil/x.md"), false);
  assert.equal(withinRoot(root, "/elsewhere"), false);
});
