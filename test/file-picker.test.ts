import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { filterSessionFiles } from "../src/web/components/FilePicker.tsx";

const entries = [
  { path: "src/web/components/FileWorkspace.tsx" },
  { path: "src/server/session-files.ts" },
  { path: "test/session-files.test.ts" },
  { path: "README.md" },
];

test("file picker search ranks basename matches ahead of directory matches", () => {
  assert.deepEqual(
    filterSessionFiles(entries, "session").map((file) => file.path),
    ["src/server/session-files.ts", "test/session-files.test.ts"],
  );
  assert.deepEqual(
    filterSessionFiles(entries, "web").map((file) => file.path),
    ["src/web/components/FileWorkspace.tsx"],
  );
  assert.deepEqual(filterSessionFiles(entries, "missing"), []);
});

test("the picker owns arrow movement and Enter selection", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../src/web/components/FilePicker.tsx", import.meta.url)),
    "utf8",
  );
  assert.match(source, /event\.key === "ArrowDown"/);
  assert.match(source, /event\.key === "ArrowUp"/);
  assert.match(source, /onSubmit=\{\(event\) => \{[\s\S]*?chooseActive\(\)/);
  assert.match(source, /aria-activedescendant=/);
  assert.match(
    source,
    /useEffect\(\(\) => \{[\s\S]*?activeRef\.current\?\.scrollIntoView\([\s\S]*?\n\s*\}, \[activeIndex\]\)/,
    "scrollIntoView must not be implicitly returned as React's effect cleanup",
  );
  assert.doesNotMatch(
    source,
    /useEffect\(\(\) => activeRef\.current\?\.scrollIntoView/,
    "an expression-bodied scroll effect crashes Strict Mode when Chrome returns a thenable",
  );
});

test("file shortcuts route through the customizable registry and Files tab request", () => {
  const app = readFileSync(
    fileURLToPath(new URL("../src/web/App.tsx", import.meta.url)),
    "utf8",
  );
  const detail = readFileSync(
    fileURLToPath(new URL("../src/web/components/layouts/ConsoleDetail.tsx", import.meta.url)),
    "utf8",
  );
  assert.match(app, /chord === bindings\.files/);
  assert.match(app, /chord === bindings\.filePicker/);
  assert.match(app, /requestFilesTab\(sel\.id\)/);
  assert.match(detail, /view\.fileTabRequest\?\.sessionId === session\.id/);
  assert.match(detail, /setTab\("files"\)/);
});
