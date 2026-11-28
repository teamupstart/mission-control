import assert from "node:assert/strict";
import test from "node:test";
import { initialStatePath, isMarkdownStatePath } from "../src/web/residents/ResidentStateViewer.tsx";

test("the state viewer opens auto-memory first, then the first listed file", () => {
  const directory = "/state";
  assert.equal(initialStatePath({ directory, files: [{ path: "a.txt" }, { path: "MEMORY.md" }] }), "MEMORY.md");
  assert.equal(initialStatePath({ directory, files: [{ path: "ledger.md" }, { path: "notes/MEMORY.md" }] }), "ledger.md");
  assert.equal(initialStatePath({ directory, files: [] }), null);
});

test("only Markdown state files are rendered; everything else is shown verbatim", () => {
  for (const path of ["MEMORY.md", "notes/Ledger.MARKDOWN", "topic.mdx"]) assert.equal(isMarkdownStatePath(path), true, path);
  for (const path of ["watermark.txt", "state.json", "md", "README.md.bak"]) assert.equal(isMarkdownStatePath(path), false, path);
});
