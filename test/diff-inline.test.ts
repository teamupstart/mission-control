import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { InlineDiffViewer } from "../src/web/components/DiffViewer.tsx";
import { mkSession } from "./helpers/session-fixture.ts";

test("the detail-tab diff reader is not a screen overlay", () => {
  const html = renderToStaticMarkup(createElement(InlineDiffViewer, { session: mkSession() }));
  assert.match(html, /diff-viewer-inline/);
  assert.doesNotMatch(html, /modal-backdrop/);
  assert.doesNotMatch(html, /aria-label="Close"/);
});

test("Console and Board route diff opens to their shared detail tab", () => {
  const app = readFileSync(fileURLToPath(new URL("../src/web/App.tsx", import.meta.url)), "utf8");
  const detail = readFileSync(
    fileURLToPath(new URL("../src/web/components/layouts/ConsoleDetail.tsx", import.meta.url)),
    "utf8",
  );

  assert.match(app, /if \(layout === "grid"\)[\s\S]*?setDiffSessionId\(sessionId\)/);
  assert.match(app, /if \(layout === "board"\) setBoardOpen\(true\);[\s\S]*?setDiffTabRequest/);
  assert.match(detail, /view\.diffTabRequest[\s\S]*?setTab\("diff"\)/);
  assert.match(detail, /<InlineDiffViewer session=\{session\} commit=\{diffCommit\} \/>/);
  assert.doesNotMatch(detail, /Open the diff viewer/);
});
