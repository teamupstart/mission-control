import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { scrollActiveFileReader } from "../src/web/components/FileWorkspace.tsx";

// The browser path spans App's global key handler and two nested scroll owners. Pin
// that wiring here: a typecheck alone cannot tell that ArrowDown still reaches
// moveSelection first, or that Files accidentally scrolls its non-scrolling shell.
const source = (relative: string): string => readFileSync(
  fileURLToPath(new URL(`../src/web/${relative}`, import.meta.url)),
  "utf8",
);

test("Console vertical arrows scroll the active detail only once focus is in it", () => {
  const app = source("App.tsx");
  const route = app.indexOf('layout === "console" && selected && (e.key');
  const navigation = app.indexOf("const nextId = moveSelection", route);
  assert.ok(route >= 0, "Console has no detail-scroll arrow branch");
  assert.ok(navigation > route, "rail navigation still runs when the detail is not focused");
  const branch = app.slice(route, navigation);
  // The scroll is gated on the reader zone: in the rail zone the same arrows fall
  // through to moveSelection and walk the rail instead.
  assert.match(branch, /consoleZone === "detail"/);
  assert.match(branch, /detailScrollers\.current\.get\(selected\.id\)/);
  assert.match(branch, /if \(detailScroll\)[\s\S]*detailScroll\([\s\S]*return/);
});

test("Conversation and Files register their actual nested scroll readers", () => {
  const detail = source("components/layouts/ConsoleDetail.tsx");
  assert.match(detail, /transcriptRef\.current\?\.scrollByArrow\(direction\)/);
  assert.match(detail, /filesRef\.current\?\.scrollByArrow\(direction\)/);

  const transcript = source("components/TranscriptPanel.tsx");
  assert.match(transcript, /logRef\.current[\s\S]*scrollBy\(\{ top:/);

  const files = source("components/FileWorkspace.tsx");
  assert.match(files, /scrollActiveFileReader\(root, direction\)/);
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
