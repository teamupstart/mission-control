import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SetupBanner } from "../src/web/components/SetupBanner.tsx";

const onDismiss = async (): Promise<null> => null;

test("the banner renders nothing before the shared checks read lands", () => {
  assert.equal(renderToStaticMarkup(createElement(SetupBanner, { view: null, onDismiss })), "");
});

test("first launch and broken-machine banners have distinct accessible summaries", () => {
  const firstLaunch = renderToStaticMarkup(createElement(SetupBanner, {
    onDismiss,
    view: {
      rows: [],
      banner: { visible: true, attentionRowIds: [], attentionCount: 0 },
    },
  }));
  assert.match(firstLaunch, /aria-label="Review machine setup"/);
  assert.match(firstLaunch, /Take a quick look/);

  const broken = renderToStaticMarkup(createElement(SetupBanner, {
    onDismiss,
    view: {
      rows: [],
      banner: {
        visible: true,
        attentionRowIds: [{ source: "dependency", id: "gh-cli" }],
        attentionCount: 1,
      },
    },
  }));
  assert.match(broken, /aria-label="Machine setup needs attention"/);
  assert.match(broken, /1 required setup check needs attention/);
  assert.match(broken, /href="#\/settings\/setup"/);
  assert.match(broken, /aria-label="Dismiss setup reminder"/);
});
