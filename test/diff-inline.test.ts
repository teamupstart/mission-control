import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { InlineDiffViewer } from "../src/web/components/DiffViewer.tsx";
import { mkSession } from "./helpers/session-fixture.ts";

test("the detail-tab diff reader is not a screen overlay", () => {
  const html = renderToStaticMarkup(
    createElement(InlineDiffViewer, { session: mkSession(), requestNonce: 1 }),
  );
  assert.match(html, /diff-viewer-inline/);
  assert.match(html, /role="region"/);
  assert.match(html, /tabindex="-1"/);
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
  assert.match(detail, /<InlineDiffViewer[\s\S]*?requestNonce=\{[\s\S]*?diffTabRequest\.nonce/);
  assert.match(detail, /useEffect\(\(\) => \{\s*setDiffCommit\(null\);\s*\}, \[session\.id\]\)/);
  assert.doesNotMatch(detail, /Open the diff viewer/);
});

test("explicit inline diff requests refetch and focus the reader", () => {
  const viewer = readFileSync(
    fileURLToPath(new URL("../src/web/components/DiffViewer.tsx", import.meta.url)),
    "utf8",
  );

  assert.match(viewer, /fetchSessionDiff\([\s\S]*?\[session\.id, commit, requestNonce\]/);
  assert.match(viewer, /contentRef\.current\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(viewer, /onKeyDown=\{inline \? \(e\) => onViewerKey\(e\.nativeEvent\)/);
  assert.match(
    viewer,
    /if \(!next && !previous\) return;\s*e\.preventDefault\(\);\s*if \(files\.length === 0\) return;/,
  );
});
