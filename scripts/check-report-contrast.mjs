// Contrast check for the self-contained HTML reports under docs/reports/.
//
// Mission Control's Files preview ALWAYS renders a report with `prefers-color-scheme: dark`,
// whatever the operator's OS says: the dashboard sets `color-scheme: dark` on :root, and
// Chromium propagates an embedder's used colour scheme into a nested browsing context. A
// report written and eyeballed in a browser on a light-mode machine therefore has a dark path
// nobody has ever looked at. That is the defect class this check exists to catch, so every
// file is rendered at BOTH schemes.
//
// CSS DETECTS, PIXELS CONFIRM. Neither half works alone, and each failed in its own way
// while this check was being written:
//
//   * CSS alone reads computed `color` and walks up for an ancestor `background-color`. It
//     cannot see SVG, where text is painted with `fill` and the surface beneath it is a
//     sibling <rect>, not an ancestor. It invented 12 findings in a diagram that measures
//     6.97:1 by comparing an inherited `color` against the <svg> background.
//   * Pixels alone cannot tell invisible text from absent text - both are "one flat colour"
//     in the histogram. Sparse short lines have too few glyph pixels to score, which put a
//     perfectly readable figcaption at 1.2:1. It also reported text inside a closed
//     <details> (laid out, never painted) and, in an earlier form, compared boxes and pixels
//     captured from two different layouts because `fullPage` screenshots resize the viewport
//     and every `vh` rule reflows.
//
// So CSS proposes a candidate from declared intent, and a pixel sample of that candidate's
// own rect throws it out if what actually got painted is fine.
//
// Usage:
//   node scripts/check-report-contrast.mjs                       # docs/reports/*/report.html
//   node scripts/check-report-contrast.mjs path/to/page.html ...

import { existsSync, readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { chromium } from "playwright";

/** The floor, not the WCAG target. WCAG wants 4.5:1 for body text and 3:1 for large text;
 *  this catches "a reader cannot find the text at all", which is the failure that ships. */
const MIN_RATIO = 3;
const BUCKETS = 32;
const VIEWPORT = { width: 1400, height: 900 };

/**
 * A report that is ABOUT a contrast defect has to be able to show one. Any element carrying
 * `data-contrast-exempt="<reason>"` has its subtree skipped, and the count of skipped texts
 * is printed on every run, so an exemption is a line in the output rather than a silence.
 */
const EXEMPT = "[data-contrast-exempt]";

/** Candidates: text whose DECLARED colours fall below the floor, in viewport coordinates. */
const collect = (minRatio) => {
  const parse = (value) => {
    const text = value || "";
    const parts = text.match(/[\d.]+/g);
    if (!parts) return null;
    const channels = parts.slice(0, 3).map(Number);
    // A wide-gamut colour computes as `color(srgb r g b)` with 0-1 channels. Reading those
    // as 0-255 turns #eef4ec into near-black and invents low contrast.
    return /^color\(/i.test(text) ? channels.map((c) => c * 255) : channels;
  };
  const alpha = (value) => {
    const parts = (value || "").match(/[\d.]+/g);
    return parts && parts.length > 3 ? Number(parts[3]) : 1;
  };
  const lum = (rgb) => {
    const [r, g, b] = rgb.map((c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

  /** Nearest ancestor that actually paints a flat colour, the way the compositor sees it. */
  const backdrop = (el) => {
    let node = el;
    while (node) {
      const style = getComputedStyle(node);
      if (style.backgroundImage && style.backgroundImage !== "none") return null; // gradient
      if (alpha(style.backgroundColor) > 0.5) return parse(style.backgroundColor);
      node = node.parentElement;
    }
    return null;
  };

  const out = [];
  let exempt = 0;
  const push = (rect, meta) => {
    if (rect.width < 3 || rect.height < 3) return;
    if (rect.top < 0 || rect.bottom > window.innerHeight) return;
    if (rect.left < 0 || rect.right > window.innerWidth) return;
    out.push({
      ...meta,
      x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.width), h: Math.round(rect.height),
    });
  };

  for (const el of document.querySelectorAll("body *")) {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
    // Content inside a closed <details> still reports a client rect but is never painted,
    // so sampling its pixels reads whatever is drawn there instead.
    if (el.closest("details:not([open])")) continue;
    if (typeof el.checkVisibility === "function" && !el.checkVisibility({
      contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true,
    })) continue;
    if (el.closest("[data-contrast-exempt]")) {
      if (Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim())) exempt++;
      continue;
    }

    const label = el.tagName.toLowerCase()
      + (typeof el.className === "string" && el.className.trim()
        ? "." + el.className.trim().split(/\s+/).join(".") : "");
    const isSvg = el.namespaceURI === "http://www.w3.org/2000/svg";

    if (isSvg) {
      if (el.tagName.toLowerCase() !== "text") continue;
      const text = (el.textContent || "").trim();
      if (!text) continue;
      // SVG ink is `fill`. The surface is a sibling rect, so leave bg to the pixel pass.
      const fg = parse(style.fill);
      if (!fg || alpha(style.fill) < 0.5) continue;
      push(el.getBoundingClientRect(), {
        label, kind: "svg", text: text.slice(0, 44), fgLum: lum(fg), declared: null,
      });
      continue;
    }

    const fg = parse(style.color);
    if (!fg || alpha(style.color) < 0.5) continue;
    const bg = backdrop(el);
    for (const node of el.childNodes) {
      if (node.nodeType !== 3) continue;
      const content = node.textContent.trim();
      if (content.length < 2) continue; // a lone separator glyph has nothing to measure
      const declared = bg ? Math.round(ratio(lum(fg), lum(bg)) * 100) / 100 : null;
      // Only pursue what CSS says is already too low. A null backdrop (gradient, image, or
      // no opaque ancestor) is unknown rather than fine, so it goes to the pixel pass too.
      if (declared !== null && declared >= minRatio) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        push(rect, { label, kind: "html", text: content.slice(0, 44), fgLum: lum(fg), declared });
      }
    }
  }
  return { boxes: out, exempt };
};

/** Confirm each candidate against the pixels actually painted in its own rect. */
const confirm = async ({ b64, list, buckets }) => {
  const img = new Image();
  img.src = "data:image/png;base64," + b64;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);

  const lum = (r, g, b) => {
    const [R, G, B] = [r, g, b].map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * R + 0.7152 * G + 0.0722 * B;
  };

  const out = [];
  for (const box of list) {
    const x = Math.max(0, box.x - 1);
    const y = Math.max(0, box.y - 1);
    const w = Math.min(box.w + 2, canvas.width - x);
    const h = Math.min(box.h + 2, canvas.height - y);
    if (w < 3 || h < 3) continue;

    const data = ctx.getImageData(x, y, w, h).data;
    const hist = Array.from({ length: buckets }, () => 0);
    const sums = Array.from({ length: buckets }, () => 0);
    for (let i = 0; i < data.length; i += 4) {
      const l = lum(data[i], data[i + 1], data[i + 2]);
      const b = Math.min(buckets - 1, Math.floor(l * buckets));
      hist[b]++;
      sums[b] += l;
    }
    // Surface is the most populated luminance: inside a tight text rect the background
    // outnumbers the ink, because the rect includes counters, gaps and line spacing.
    let bgBucket = 0;
    for (let b = 1; b < buckets; b++) if (hist[b] > hist[bgBucket]) bgBucket = b;
    const painted = sums[bgBucket] / hist[bgBucket];
    // We know what ink to look for, so no glyph-share guessing: take the bucket nearest the
    // declared foreground luminance that has any pixels at all.
    let inkBucket = -1;
    for (let b = 0; b < buckets; b++) {
      if (hist[b] === 0) continue;
      const l = sums[b] / hist[b];
      if (inkBucket < 0 || Math.abs(l - box.fgLum) < Math.abs(sums[inkBucket] / hist[inkBucket] - box.fgLum)) {
        inkBucket = b;
      }
    }
    const ink = inkBucket < 0 ? box.fgLum : sums[inkBucket] / hist[inkBucket];
    const measured = (Math.max(ink, painted) + 0.05) / (Math.min(ink, painted) + 0.05);
    out.push({ ...box, measured: Math.round(measured * 100) / 100 });
  }
  return out;
};

// A path is required rather than defaulting to every report, because this is a gate on the
// report you just wrote, not an audit of the tree. Reports written before this check existed
// have their own pre-existing findings, and sweeping them by default would mean the command
// is red the first time anyone runs it - which is how a check gets ignored. `--all` is there
// when a sweep is what you actually want.
const args = process.argv.slice(2);
const sweep = args.includes("--all");
const paths = args.filter((a) => a !== "--all");
if (!sweep && paths.length === 0) {
  console.error("usage: node scripts/check-report-contrast.mjs <report.html>... | --all");
  process.exit(2);
}
const targets = sweep && paths.length === 0
  ? await Array.fromAsync(glob("docs/reports/*/report.html"))
  : paths;
if (targets.length === 0) {
  console.error("no report files matched");
  process.exit(1);
}

const browser = await chromium.launch();
let failures = 0;
let renders = 0;

for (const target of [...targets].sort()) {
  const path = resolve(target);
  const shown = relative(process.cwd(), path) || target;
  if (!existsSync(path)) {
    console.error("missing: " + shown);
    failures++;
    continue;
  }
  const html = readFileSync(path, "utf8");

  for (const scheme of ["light", "dark"]) {
    const page = await browser.newPage({ colorScheme: scheme, viewport: VIEWPORT });
    await page.setContent(html, { waitUntil: "load" });
    // `scroll-behavior: smooth` makes scrollTo animate, which would read boxes and pixels
    // from two different offsets.
    await page.addStyleTag({ content: "*{scroll-behavior:auto !important}" });

    const seen = new Map();
    let exempted = 0;
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let top = 0; top < Math.max(height, 1); top += VIEWPORT.height) {
      const landed = await page.evaluate((y) => {
        window.scrollTo({ top: y, left: 0, behavior: "instant" });
        return window.scrollY;
      }, top);
      await page.waitForFunction((y) => window.scrollY === y, landed);

      const { boxes: all, exempt } = await page.evaluate(collect, MIN_RATIO);
      exempted = Math.max(exempted, exempt);
      const fresh = all.filter((b) => !seen.has(b.kind + "|" + b.label + "|" + b.text));
      if (fresh.length === 0) continue;
      const shot = (await page.screenshot()).toString("base64");
      const rows = await page.evaluate(confirm, { b64: shot, list: fresh, buckets: BUCKETS });
      for (const row of rows) {
        const key = row.kind + "|" + row.label + "|" + row.text;
        if (!seen.has(key)) seen.set(key, row);
      }
    }
    await page.close();
    renders++;

    const bad = [...seen.values()]
      .filter((r) => r.measured < MIN_RATIO)
      .sort((a, b) => a.measured - b.measured);
    console.log(`${bad.length === 0 ? "ok  " : "FAIL"} ${shown} [${scheme}] `
      + `${seen.size} candidate${seen.size === 1 ? "" : "s"}, ${bad.length} confirmed below ${MIN_RATIO}:1`
      + (exempted ? `, ${exempted} exempt via ${EXEMPT}` : ""));
    for (const r of bad.slice(0, 8)) {
      const note = r.declared === null ? "" : ` declared ${r.declared}:1`;
      console.log(`       ${r.measured}:1  ${r.kind}  ${r.label}${note}  "${r.text}"`);
    }
    failures += bad.length;
  }
}

await browser.close();
console.log(`\n${renders} renders checked, ${failures} text${failures === 1 ? "" : "s"} below ${MIN_RATIO}:1`);
process.exit(failures > 0 ? 1 : 0);
