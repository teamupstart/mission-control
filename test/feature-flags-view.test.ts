import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FeatureFlagsView } from "../src/web/components/FeatureFlagsView.tsx";
import { FEATURE_FLAGS } from "../e2e/fixtures/feature-flag-registry.ts";

test("empty registry retains master and explains alpha without a filter or Advanced", () => {
  const html = renderToStaticMarkup(createElement(FeatureFlagsView, { definitions: [], config: { enableAll: false, overrides: {} }, onSet() {} }));
  assert.match(html, /No preview features right now. New ones appear here./);
  assert.match(html, /Updating to an alpha build does not turn this on, or any flag./);
  assert.match(html, /data-anchor="feature-flags\/enable-all"/);
  assert.doesNotMatch(html, /Filter feature flags|aria-expanded/);
});
test("populated registry has unique anchors, resolved pills and collapsed Advanced with off count", () => {
  const html = renderToStaticMarkup(createElement(FeatureFlagsView, { definitions: FEATURE_FLAGS, config: { enableAll: true, overrides: { "compact-history": false } }, onSet() {} }));
  const anchors = [...html.matchAll(/data-anchor="([^"]+)"/g)].map(match => match[1]);
  assert.equal(anchors.length, 5);
  assert.equal(new Set(anchors).size, 5);
  assert.match(html, /Preview navigation: on/);
  assert.match(html, /Compact history: off/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /1 turned off/);
});
