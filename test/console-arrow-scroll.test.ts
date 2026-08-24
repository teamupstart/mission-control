import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  adjacentFilePath,
  scrollActiveFileReader,
} from "../src/web/components/FileWorkspace.tsx";

// The browser path spans App's global key handler and two nested arrow owners. Pin
// that wiring here: a typecheck alone cannot tell that Preview gets first refusal before
// session movement, or that Files accidentally scrolls its non-scrolling shell.
const source = (relative: string): string => readFileSync(
  fileURLToPath(new URL(`../src/web/${relative}`, import.meta.url)),
  "utf8",
);

test("the open detail gets first refusal on vertical arrows before session navigation", () => {
  const app = source("App.tsx");
  const navigation = app.indexOf("const nextId = moveSelection");
  assert.ok(navigation >= 0, "rail navigation branch is gone");
  const branch = app.slice(0, navigation);
  // The detail receives whether focus is actually inside it. Preview can claim a rail-side
  // arrow for file selection, while Conversation returns false and lets the same key walk
  // the session rail.
  assert.match(branch, /const fromReader = Boolean\(target\?\.closest\("\.cdetail"\)\)/);
  assert.match(branch, /detailScrollers\.current\.get\(readerSession\.id\)/);
  assert.match(branch, /if \(detailScroll\?\.\([\s\S]*fromReader\)\) return/);
});

test("Conversation and Files register their actual arrow owners", () => {
  const detail = source("components/layouts/ConsoleDetail.tsx");
  assert.match(detail, /transcriptRef\.current\?\.scrollByArrow\(direction\)/);
  assert.match(detail, /filesRef\.current\?\.handleArrow\(direction, fromReader\)/);
  assert.match(detail, /if \(!fromReader\) return false/);

  const transcript = source("components/TranscriptPanel.tsx");
  assert.match(transcript, /logRef\.current[\s\S]*scrollBy\(\{ top:/);

  const files = source("components/FileWorkspace.tsx");
  assert.match(files, /scrollActiveFileReader\(root, direction\)/);
  assert.match(files, /previewable && mode === "preview"/);
  assert.match(files, /focusFileList: \(\) =>/);
  assert.match(files, /focusCurrentFileRow\(root\)/);
});

test("Preview Escape and Shift+Tab return to the selected file before the session rail", () => {
  const app = source("App.tsx");
  const escape = app.indexOf('case "Escape":');
  const railPeel = app.indexOf('readerSession && target?.closest(".cdetail")', escape);
  const branch = app.slice(escape, railPeel);
  assert.match(branch, /target\?\.closest\("\.file-preview-reader"\)/);
  assert.match(branch, /readerTabbers\.current\.get\(readerSession\.id\)\?\.\(-1\) === "moved"/);

  const detail = source("components/layouts/ConsoleDetail.tsx");
  assert.match(detail, /dir === -1 && filesRef\.current\?\.focusFileList\(\)/);
});

test("preview file arrows stop at list edges rather than leaking to session navigation", () => {
  const paths = ["a.html", "b.md", "c.html"];
  assert.equal(adjacentFilePath(paths, "b.md", -1), "a.html");
  assert.equal(adjacentFilePath(paths, "b.md", 1), "c.html");
  assert.equal(adjacentFilePath(paths, "a.html", -1), null);
  assert.equal(adjacentFilePath(paths, "c.html", 1), null);
  assert.equal(adjacentFilePath(paths, "missing.html", 1), "a.html");
});

function reader(height: number): { element: HTMLElement; moves: number[] } {
  const moves: number[] = [];
  return {
    element: {
      clientHeight: height,
      scrollBy: ({ top }: ScrollToOptions) => moves.push(top ?? 0),
    } as unknown as HTMLElement,
    moves,
  };
}

test("Files scroll visible content before the earlier sidebar node", () => {
  const content = reader(500);
  const list = reader(600);
  const root = {
    querySelectorAll: () => [content.element],
    querySelector: (selector: string) => selector === ".file-list" ? list.element : null,
  } as unknown as ParentNode;

  assert.equal(scrollActiveFileReader(root, 1), true);
  assert.deepEqual(content.moves, [90]);
  assert.deepEqual(list.moves, []);
});

test("Files page navigation moves by one whole preview height", () => {
  const content = reader(500);
  const root = {
    querySelectorAll: () => [content.element],
    querySelector: () => null,
  } as unknown as ParentNode;

  assert.equal(scrollActiveFileReader(root, 1, "page"), true);
  assert.equal(scrollActiveFileReader(root, -1, "page"), true);
  assert.deepEqual(content.moves, [500, -500]);
});

test("Files route HTML preview scrolling through its sandbox bridge", () => {
  const list = reader(600);
  const messages: unknown[] = [];
  const preview = {
    clientHeight: 500,
    contentWindow: {
      postMessage: (message: unknown) => messages.push(message),
    },
  } as unknown as HTMLIFrameElement;
  const root = {
    querySelectorAll: () => [],
    querySelector: (selector: string) => selector.includes("html-preview") ? preview : list.element,
  } as unknown as ParentNode;

  assert.equal(scrollActiveFileReader(root, -1), true);
  assert.deepEqual(messages, [{ type: "mission:file-preview-scroll", top: -90 }]);
  assert.deepEqual(list.moves, []);
});

test("Files route HTML preview pagination through its sandbox bridge", () => {
  const messages: unknown[] = [];
  const preview = {
    clientHeight: 500,
    contentWindow: {
      postMessage: (message: unknown) => messages.push(message),
    },
  } as unknown as HTMLIFrameElement;
  const root = {
    querySelectorAll: () => [],
    querySelector: (selector: string) => selector.includes("html-preview") ? preview : null,
  } as unknown as ParentNode;

  assert.equal(scrollActiveFileReader(root, 1, "page"), true);
  assert.equal(scrollActiveFileReader(root, -1, "page"), true);
  assert.deepEqual(messages, [
    { type: "mission:file-preview-scroll", top: 500 },
    { type: "mission:file-preview-scroll", top: -500 },
  ]);
});
