import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The browser path spans App's global key handler and two nested scroll owners. Pin
// that wiring here: a typecheck alone cannot tell that ArrowDown still reaches
// moveSelection first, or that Files accidentally scrolls its non-scrolling shell.
const source = (relative: string): string => readFileSync(
  fileURLToPath(new URL(`../src/web/${relative}`, import.meta.url)),
  "utf8",
);

test("Console vertical arrows route to the active detail before session navigation", () => {
  const app = source("App.tsx");
  const route = app.indexOf('layout === "console" && selectedId');
  const navigation = app.indexOf("const nextId = moveSelection", route);
  assert.ok(route >= 0, "Console has no detail-scroll arrow branch");
  assert.ok(navigation > route, "session navigation still wins before detail scrolling");
  assert.match(app.slice(route, navigation), /detailScrollers\.current\.get\(selectedId\)/);
});

test("Conversation and Files register their actual nested scroll readers", () => {
  const detail = source("components/layouts/ConsoleDetail.tsx");
  assert.match(detail, /transcriptRef\.current\?\.scrollByArrow\(direction\)/);
  assert.match(detail, /filesRef\.current\?\.scrollByArrow\(direction\)/);

  const transcript = source("components/TranscriptPanel.tsx");
  assert.match(transcript, /logRef\.current[\s\S]*scrollBy\(\{ top:/);

  const files = source("components/FileWorkspace.tsx");
  assert.match(files, /\.cm-scroller, \.file-markdown-preview, \.file-compare pre, \.file-list/);
});
