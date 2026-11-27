import assert from "node:assert/strict";
import test from "node:test";
import {
  reportRelativeReferences,
  unlinkMissingCompanions,
  validateStaticReportHtml,
} from "../src/server/archives/html.ts";

// The two helpers that let Publish as scout archive a report page whose links name files beside
// it: one lists what the page links to inside its own directory, so a report stores those files
// when it is posted; the other unlinks what was never stored, so the page still publishes.

const page = (body: string, head = "") =>
  `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;

test("relative references are every in-directory path the page names, once, and nothing else", () => {
  const html = page(
    `<a href="variants.csv">variants</a> <a href="./variants.csv#row-2">again</a>
     <a href="data/phrases%20room.csv?x=1">nested</a>
     <img src="chart.png" srcset="chart.png 1x, chart@2x.png 2x">
     <div style="background:url('bg.png')"></div>
     <svg><image xlink:href="diagram.svg"/></svg>
     <a href="#limits">fragment</a> <a href="https://example.com/a.csv">external</a>
     <a href="../outside.csv">escapes</a> <a href="//cdn.example/x.js">protocol-relative</a>`,
    "<style>.x{background:url(sheet.png)}</style>",
  );
  assert.deepEqual(reportRelativeReferences(html).sort(), [
    "bg.png",
    "chart.png",
    "chart@2x.png",
    "data/phrases room.csv",
    "diagram.svg",
    "sheet.png",
    "variants.csv",
  ]);
});

test("unlinking removes only the attributes that name unstored files, and keeps every other byte", () => {
  const html = page(
    `<p>See <a class="file" href="variants.csv">variants.csv</a> and <a href="kept.csv">kept.csv</a>.</p>\n` +
      `<p><a href="#limits">Limits</a> <a href="https://example.com/doc">docs</a></p>`,
  );
  const result = unlinkMissingCompanions(html, new Set(["report.html", "kept.csv"]));
  assert.deepEqual(result.unlinked, ["variants.csv"]);
  assert.equal(result.html, html.replace(' href="variants.csv"', ""));
  assert.match(result.html, /<a class="file">variants\.csv<\/a>/, "the link text a person reads is still there");
  assert.deepEqual(validateStaticReportHtml(result.html, new Set(["report.html", "kept.csv"])), { ok: true });
});

test("unlinking reaches srcset, style and prefixed SVG attributes, and the result passes the checker", () => {
  const html = page(
    `<img alt="chart" src="kept.png" srcset="kept.png 1x, gone@2x.png 2x">` +
      `<div style="color:red;background:url(gone-bg.png)">styled</div>` +
      `<svg><image xlink:href="gone.svg" width="10"/></svg>`,
  );
  const targets = new Set(["report.html", "kept.png"]);
  assert.equal(validateStaticReportHtml(html, targets).ok, false);
  const result = unlinkMissingCompanions(html, targets);
  assert.deepEqual(result.unlinked, ["gone-bg.png", "gone.svg", "gone@2x.png"]);
  assert.match(result.html, /<img alt="chart" src="kept\.png">/);
  assert.match(result.html, /<div>styled<\/div>/);
  assert.match(result.html, /<image width="10"\/>/);
  assert.deepEqual(validateStaticReportHtml(result.html, targets), { ok: true });
});

test("a page whose links are all stored comes back unchanged, and refusals other than missing files are kept", () => {
  const html = page(`<a href="kept.csv">kept</a><a href="../outside.csv">out</a><script>1</script>`);
  const result = unlinkMissingCompanions(html, new Set(["kept.csv"]));
  assert.deepEqual(result, { html, unlinked: [] });
  const checked = validateStaticReportHtml(result.html, new Set(["kept.csv"]));
  assert.equal(checked.ok, false);
  assert.deepEqual(
    !checked.ok && checked.problems.map((problem) => problem.code).sort(),
    ["escaping_link", "forbidden_element"],
  );
});

test("an attribute that mixes a missing file with an escaping or fetching reference is kept whole, so the checker refuses it", () => {
  const html = page(
    `<img alt="x" srcset="../outside.png 1x, gone.png 2x">` +
      `<div style="background:url(gone-bg.png), url(https://tracker.example/p.png)">styled</div>` +
      `<a href="gone.csv">only missing</a>`,
  );
  const result = unlinkMissingCompanions(html, new Set(["report.html"]));
  assert.deepEqual(result.unlinked, ["gone.csv"], "only the missing-only attribute is unlinked");
  assert.match(result.html, /srcset="\.\.\/outside\.png 1x, gone\.png 2x"/);
  assert.match(result.html, /style="background:url\(gone-bg\.png\), url\(https:\/\/tracker\.example\/p\.png\)"/);
  const checked = validateStaticReportHtml(result.html, new Set(["report.html"]));
  assert.equal(checked.ok, false);
  const codes = !checked.ok ? checked.problems.map((problem) => problem.code) : [];
  assert.ok(codes.includes("escaping_link"), JSON.stringify(codes));
  assert.ok(codes.includes("external_url"), JSON.stringify(codes));
});

test("unlinking thousands of missing links in one pass keeps every other byte, and adjacent removed attributes collapse cleanly", () => {
  const count = 20_000;
  const links = Array.from({ length: count }, (_, index) => `<a href="m${index}.csv">m${index}</a>`).join("\n");
  const html = page(`${links}\n<a href="kept.csv" style="background:url(gone.png)">both</a>`);
  const result = unlinkMissingCompanions(html, new Set(["kept.csv"]));
  assert.equal(result.unlinked.length, count + 1);
  const expected = html.replace(/ href="m\d+\.csv"/g, "").replace(' style="background:url(gone.png)"', "");
  assert.equal(result.html, expected, "every missing link removed, every other byte kept");
  assert.match(result.html, /<a href="kept\.csv">both<\/a>/);
});

test("a <style> element that names an unstored file is not rewritten, and the checker still refuses it", () => {
  const html = page("<p>x</p>", "<style>.x{background:url(gone.png)}</style>");
  const result = unlinkMissingCompanions(html, new Set());
  assert.deepEqual(result, { html, unlinked: [] });
  assert.equal(validateStaticReportHtml(result.html, new Set()).ok, false);
});
