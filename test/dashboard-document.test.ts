import { test } from "node:test";
import assert from "node:assert/strict";
import { renderDashboardDocument } from "../src/server/dashboard-document.ts";

// What is at stake: a profile with no local preference cache - a first desktop launch after a
// skin was chosen in a browser - paints its first frame from the document alone. The skin has to
// be on `<html>` in the HTML the daemon serves, or that frame is Default: a dark dashboard
// between a light window and a light dashboard.

const SOURCE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
  </head>
  <body><div id="root"></div></body>
</html>`;

test("a stored Daylight is on <html> and in the seed meta before any script runs", () => {
  const html = renderDashboardDocument(SOURCE, "daylight");
  assert.match(html, /<html lang="en" data-skin="daylight" style="color-scheme: light">/);
  assert.match(html, /<head>\n {4}<meta name="mission-skin" content="daylight" \/>/);
  // Everything else is the built document, byte for byte.
  assert.equal(
    html.replace(' data-skin="daylight" style="color-scheme: light"', "").replace(/\n {4}<meta name="mission-skin"[^>]*>/, ""),
    SOURCE,
  );
});

test("Default is the absence of the attribute, with its dark scheme and its seed", () => {
  const html = renderDashboardDocument(SOURCE, "default");
  assert.match(html, /<html lang="en" style="color-scheme: dark">/);
  assert.doesNotMatch(html, /data-skin=/);
  assert.match(html, /<meta name="mission-skin" content="default" \/>/);
});

test("the rewrite touches only the opening <html> and <head> tags", () => {
  const html = renderDashboardDocument("<html><head></head><body><p>&lt;html&gt;</p></body></html>", "daylight");
  assert.equal(
    html,
    '<html data-skin="daylight" style="color-scheme: light"><head>\n    <meta name="mission-skin" content="daylight" /></head><body><p>&lt;html&gt;</p></body></html>',
  );
});
