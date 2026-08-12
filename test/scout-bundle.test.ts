import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { verifyScoutBundle } from "../src/server/scouts/bundle.ts";
import { extractVisibleText, validateStaticReportHtml } from "../src/server/scouts/html.ts";
import { loadScoutProducer } from "../src/server/scouts/producer.ts";
import { mediaTypeForArchivePath, resolveArchiveFile, ScoutPathError } from "../src/server/scouts/paths.ts";
import { writeScoutBundle } from "./helpers/scout-fixture.ts";

/**
 * Verification: what turns a manifest's CLAIMS into facts, and what it refuses.
 *
 * Every case here runs against a real directory, because most of what verification protects
 * against - a symlink swapped in, a file still being copied, a path that escapes - does not
 * exist as a value that can be asserted on.
 */

const home = mkdtempSync(join(tmpdir(), "mission-scout-bundle-"));
after(() => rmSync(home, { recursive: true, force: true }));

function library(name: string): string {
  const root = join(home, name);
  mkdirSync(root, { recursive: true });
  return realpathSync(root);
}

test("a well-formed bundle verifies, and reports what it contains", async () => {
  const root = library("valid");
  const written = writeScoutBundle(root, {
    companions: { "permission-events.csv": "when,what\n1,grant lost\n" },
    supporting: { "repo-01/evidence/resume-debug.log": "reset() ran without a grant replay\n" },
  });
  const read = await verifyScoutBundle(root, { producerId: written.producerId, archiveId: written.archiveId });
  assert.equal(read.kind, "verified");
  if (read.kind !== "verified") return;
  assert.equal(read.bundle.status, "ready");
  assert.equal(read.bundle.key, written.key);
  assert.equal(read.bundle.relativePath, `${written.producerId}/${written.archiveId}`);
  assert.equal(read.bundle.manifest.artifacts.length, 3);
  assert.ok(read.bundle.contentBytes > 0);
  assert.match(read.bundle.reportText, /resume path never replayed/);
  assert.equal(
    read.bundle.reportText.includes("background"),
    false,
    "stylesheet text is not report content",
  );
});

test("a partial bundle verifies as partial and keeps its missing entries", async () => {
  const root = library("partial");
  const written = writeScoutBundle(root, { reportHtml: null });
  const read = await verifyScoutBundle(root, { producerId: written.producerId, archiveId: written.archiveId });
  assert.equal(read.kind, "verified");
  if (read.kind !== "verified") return;
  assert.equal(read.bundle.status, "partial");
  assert.equal(read.bundle.manifest.primaryArtifactId, null);
  assert.equal(read.bundle.manifest.missing[0]?.kind, "primary_report");
  assert.equal(read.bundle.reportText, "");
});

test("a bundle whose payload has not arrived is incomplete, never unreadable", async () => {
  const root = library("still-copying");
  const written = writeScoutBundle(root, {
    companions: { "chart.png": "not really a png" },
    omitFiles: ["report/chart.png"],
  });
  const read = await verifyScoutBundle(root, { producerId: written.producerId, archiveId: written.archiveId });
  assert.equal(read.kind, "incomplete", "a missing payload file must be retried, not condemned");
  if (read.kind !== "incomplete") return;
  assert.match(read.reason, /report\/chart\.png/);
});

test("a file whose bytes do not match the manifest is incomplete", async () => {
  const root = library("mismatch");
  const written = writeScoutBundle(root, { companions: { "notes.txt": "before" } });
  writeFileSync(join(written.dir, "report/notes.txt"), "after-and-longer");
  const read = await verifyScoutBundle(root, { producerId: written.producerId, archiveId: written.archiveId });
  assert.equal(read.kind, "incomplete");
  if (read.kind !== "incomplete") return;
  assert.match(read.reason, /report\/notes\.txt/);
});

test("a file of the right size with the wrong bytes is incomplete", async () => {
  const root = library("digest");
  const written = writeScoutBundle(root, { companions: { "notes.txt": "abcdef" } });
  writeFileSync(join(written.dir, "report/notes.txt"), "fedcba");
  const read = await verifyScoutBundle(root, { producerId: written.producerId, archiveId: written.archiveId });
  assert.equal(read.kind, "incomplete");
  if (read.kind !== "incomplete") return;
  assert.match(read.reason, /digest/);
});

test("a manifest that does not match the directory it sits in is unreadable", async () => {
  const root = library("wrong-identity");
  const written = writeScoutBundle(root, {
    manifestJson: (manifest) => ({
      ...manifest,
      producer: { ...(manifest.producer as object), id: "11111111-2222-3333-4444-555555555555" },
    }),
  });
  const read = await verifyScoutBundle(root, { producerId: written.producerId, archiveId: written.archiveId });
  assert.equal(read.kind, "unreadable");
  if (read.kind !== "unreadable") return;
  assert.match(read.reason, /does not match the directory/);
});

test("a manifest whose content digest does not describe its own contents is unreadable", async () => {
  const root = library("forged-digest");
  const written = writeScoutBundle(root, {
    manifestJson: (manifest) => ({ ...manifest, content_digest: `sha256:${"0".repeat(64)}` }),
  });
  const read = await verifyScoutBundle(root, { producerId: written.producerId, archiveId: written.archiveId });
  assert.equal(read.kind, "unreadable");
  if (read.kind !== "unreadable") return;
  assert.match(read.reason, /content digest/);
});

test("a manifest claiming a path outside the bundle is unreadable, and nothing is read", async () => {
  const root = library("traversal");
  const secret = join(home, "secret.txt");
  writeFileSync(secret, "not yours");
  const written = writeScoutBundle(root, {
    manifestJson: (manifest) => {
      const content = manifest.content as { artifacts: Array<Record<string, unknown>> };
      content.artifacts[0]!.archive_path = "report/../../../secret.txt";
      return manifest;
    },
  });
  const read = await verifyScoutBundle(root, { producerId: written.producerId, archiveId: written.archiveId });
  assert.equal(read.kind, "unreadable");
});

test("a symlinked artifact is refused even when it points inside the bundle", async () => {
  const root = library("symlink");
  const written = writeScoutBundle(root, { companions: { "notes.txt": "real" } });
  rmSync(join(written.dir, "report/notes.txt"));
  symlinkSync(join(written.dir, "report/report.html"), join(written.dir, "report/notes.txt"));
  const read = await verifyScoutBundle(root, { producerId: written.producerId, archiveId: written.archiveId });
  assert.notEqual(read.kind, "verified", "a symlink is never an archived file");
});

test("a bundle from a newer format version is unreadable and says so", async () => {
  const root = library("future");
  const written = writeScoutBundle(root, {
    manifestJson: (manifest) => ({ ...manifest, format_version: 99 }),
  });
  const read = await verifyScoutBundle(root, { producerId: written.producerId, archiveId: written.archiveId });
  assert.equal(read.kind, "unreadable");
  if (read.kind !== "unreadable") return;
  assert.equal(read.formatVersion, 99);
});

test("a report that could execute or fetch is unreadable however valid its digests are", async () => {
  const root = library("scripted");
  const written = writeScoutBundle(root, {
    reportHtml: `<!doctype html><html><body><h1>Findings</h1><script>fetch("https://x")</script></body></html>`,
  });
  const read = await verifyScoutBundle(root, { producerId: written.producerId, archiveId: written.archiveId });
  assert.equal(read.kind, "unreadable");
  if (read.kind !== "unreadable") return;
  assert.match(read.reason, /not a static report/);
});

test("a directory with no manifest is absent, not an error", async () => {
  const root = library("empty");
  const producerId = "7aa704fd-d2ab-48b3-a726-0c2643ed91d2";
  const archiveId = "9f5db6c8-79f5-4f9e-84aa-8b5dc15362f8";
  mkdirSync(join(root, producerId, archiveId), { recursive: true });
  const read = await verifyScoutBundle(root, { producerId, archiveId });
  assert.equal(read.kind, "absent");
});

// --- static HTML rules -----------------------------------------------------

test("version 1 allows static markup, inline CSS and SVG, fragments, and data: images", () => {
  const html = [
    "<!doctype html><html><head><title>t</title>",
    "<style>.a { color: #fff; background: url(data:image/png;base64,iVBORw0KGgo=); }</style>",
    "</head><body>",
    "<a href=\"#evidence\">jump</a>",
    "<a href=\"permission-events.csv\">the data</a>",
    "<img src=\"data:image/png;base64,iVBORw0KGgo=\" alt=\"chart\">",
    "<svg viewBox=\"0 0 10 10\"><title>flow</title><rect width=\"10\" height=\"10\"/></svg>",
    "<h2 id=\"evidence\" style=\"color:#939eae\">Evidence</h2>",
    "</body></html>",
  ].join("");
  const result = validateStaticReportHtml(html, new Set(["report.html", "permission-events.csv"]));
  assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.problems));
});

test("each executing, navigating, or fetching construct is refused by name", () => {
  const cases: Array<[string, string]> = [
    ["<script>alert(1)</script>", "forbidden_element"],
    ["<div onclick=\"go()\">x</div>", "event_handler"],
    ["<form action=\"/x\"><input></form>", "forbidden_element"],
    ["<iframe src=\"a.html\"></iframe>", "forbidden_element"],
    ["<object data=\"a.swf\"></object>", "forbidden_element"],
    ["<base href=\"https://example.com/\">", "forbidden_element"],
    ["<meta http-equiv=\"refresh\" content=\"0;url=b.html\">", "meta_refresh"],
    ["<img srcdoc=\"x\">", "forbidden_attribute"],
    ["<a href=\"https://example.com\">out</a>", "external_url"],
    ["<a href=\"//example.com\">out</a>", "protocol_relative_url"],
    ["<a href=\"javascript:go()\">out</a>", "external_url"],
    ["<a href=\"data:text/html,<b>x\">out</a>", "data_navigation"],
    ["<img src=\"../../secret.png\">", "escaping_link"],
    ["<style>@import url(https://example.com/x.css);</style>", "external_url"],
    ["<div style=\"background:url(https://example.com/x.png)\">x</div>", "external_url"],
    ["<template><script>x()</script></template>", "forbidden_element"],
  ];
  for (const [fragment, code] of cases) {
    const result = validateStaticReportHtml(`<!doctype html><html><body>${fragment}</body></html>`);
    assert.equal(result.ok, false, `${fragment} must be refused`);
    if (result.ok) continue;
    assert.ok(
      result.problems.some((problem) => problem.code === code),
      `${fragment} should report ${code}, got ${result.problems.map((p) => p.code).join(",")}`,
    );
  }
});

test("a relative link to a file that was never captured is refused", () => {
  const html = `<!doctype html><html><body><a href="missing.csv">data</a></body></html>`;
  const withCompanion = validateStaticReportHtml(html, new Set(["report.html", "missing.csv"]));
  assert.equal(withCompanion.ok, true);
  const without = validateStaticReportHtml(html, new Set(["report.html"]));
  assert.equal(without.ok, false);
  if (without.ok) return;
  assert.equal(without.problems[0]?.code, "missing_companion");
});

test("visible text skips code, styling, and hidden content and keeps SVG labels", () => {
  const html = [
    "<!doctype html><html><head><title>Resume permissions</title>",
    "<style>.x { color: red }</style></head><body>",
    "<h1>Finding</h1><p>The grant was never replayed.</p>",
    "<div hidden>internal note</div>",
    "<div aria-hidden=\"true\">decoration</div>",
    "<div style=\"display:none\">draft text</div>",
    "<noscript>enable javascript</noscript>",
    "<svg><title>the flow</title><metadata>rdf junk</metadata></svg>",
    "</body></html>",
  ].join("");
  const text = extractVisibleText(html);
  assert.match(text, /Resume permissions/);
  assert.match(text, /The grant was never replayed\./);
  assert.match(text, /the flow/);
  for (const absent of ["color: red", "internal note", "decoration", "draft text", "enable javascript", "rdf junk"]) {
    assert.equal(text.includes(absent), false, `${absent} must not be indexed`);
  }
});

test("visible text is bounded", () => {
  const long = "evidence ".repeat(5_000);
  const text = extractVisibleText(`<!doctype html><html><body><p>${long}</p></body></html>`, 200);
  assert.equal(text.length, 200);
});

// --- paths -----------------------------------------------------------------

test("an artifact path is resolved against the bundle, never joined blindly", async () => {
  const root = library("resolve");
  const written = writeScoutBundle(root, {});
  const resolved = await resolveArchiveFile(written.dir, "report/report.html");
  assert.ok(resolved.endsWith("report/report.html"));
  await assert.rejects(
    () => resolveArchiveFile(written.dir, "../../../etc/passwd"),
    (error: unknown) => error instanceof ScoutPathError,
  );
  await assert.rejects(
    () => resolveArchiveFile(written.dir, "/etc/passwd"),
    (error: unknown) => error instanceof ScoutPathError,
  );
  await assert.rejects(
    () => resolveArchiveFile(written.dir, "report/nothing-here.txt"),
    (error: unknown) => error instanceof ScoutPathError && error.status === 404,
  );
});

test("content types come from the archive path, and anything unknown is an opaque download", () => {
  assert.equal(mediaTypeForArchivePath("report/report.html"), "text/html; charset=utf-8");
  assert.equal(mediaTypeForArchivePath("report/data.csv"), "text/csv; charset=utf-8");
  assert.equal(mediaTypeForArchivePath("artifacts/repo-01/x.png"), "image/png");
  assert.equal(mediaTypeForArchivePath("artifacts/repo-01/thing.bin"), "application/octet-stream");
  assert.equal(mediaTypeForArchivePath("artifacts/repo-01/no-extension"), "application/octet-stream");
});

// --- producer identity -----------------------------------------------------

test("the producer identity is created once and reread, and losing it opens a new namespace", () => {
  const dir = join(home, "producer");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "scout-producer.json");
  const first = loadScoutProducer(file, join(dir, "scouts"));
  const again = loadScoutProducer(file, join(dir, "scouts"));
  assert.equal(first.id, again.id, "a second read must not open a second namespace");

  rmSync(file);
  const replaced = loadScoutProducer(file, join(dir, "scouts"));
  assert.notEqual(replaced.id, first.id, "a lost identity opens a NEW namespace rather than reusing one");
});

test("a corrupt producer identity is replaced rather than trusted", () => {
  const dir = join(home, "producer-corrupt");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "scout-producer.json");
  writeFileSync(file, "{ not json");
  const identity = loadScoutProducer(file, join(dir, "scouts"));
  assert.match(identity.id, /^[0-9a-f-]{36}$/);

  writeFileSync(file, JSON.stringify({ id: "../../elsewhere", label: "x" }));
  const rejected = loadScoutProducer(file, join(dir, "scouts"));
  assert.notEqual(rejected.id, "../../elsewhere", "an ungenerated id must never become a directory name");
});

// --- what an earlier version of the validator let through --------------------
//
// Every case below was reproduced against a real headless browser before it was fixed: the
// markup validated clean, and opening the report fetched from the network. They are kept as
// named cases rather than folded into the table above because each one is a different way of
// being missed - an attribute nobody listed, a regex that failed open, a parser mode.

test("a report cannot fetch through an attribute the URL list forgot", () => {
  const result = validateStaticReportHtml(
    `<!doctype html><html><head><link rel="preload" as="image" imagesrcset="http://evil/p.png"></head><body></body></html>`,
  );
  assert.equal(result.ok, false, "a preload carrying only imagesrcset still makes a request");
  if (result.ok) return;
  assert.equal(result.problems[0]?.code, "external_url");
});

test("a CSS url() containing a close paren is still a URL", () => {
  // The first implementation matched with `[^'")]*`, which cannot span the `)` inside the
  // quotes - the backreference then failed and the match was abandoned, so NO finding was
  // reported at all. Failing open is the only failure mode that matters here.
  for (const css of [
    `<style>.a{background:url("http://evil/a)b.png")}</style>`,
    `<div style="background:url('http://evil/y)z.png')"></div>`,
  ]) {
    const result = validateStaticReportHtml(`<!doctype html><html><body>${css}</body></html>`);
    assert.equal(result.ok, false, css);
    if (result.ok) continue;
    assert.equal(result.problems[0]?.code, "external_url");
  }
});

test("a URL in a CSS function this build has never heard of is still refused", () => {
  for (const css of [
    `<style>.b{background-image:image-set("http://evil/x.png" 1x)}</style>`,
    `<style>.c{background:-webkit-image-set("//evil/z.png" 1x)}</style>`,
    `<style>@import "https://evil/y.css";</style>`,
  ]) {
    const result = validateStaticReportHtml(`<!doctype html><html><body>${css}</body></html>`);
    assert.equal(result.ok, false, css);
  }
});

test("noscript content is validated, because a browser with JavaScript off runs it as markup", () => {
  const result = validateStaticReportHtml(
    `<!doctype html><html><body><noscript><img src="https://evil/a.png"></noscript></body></html>`,
  );
  assert.equal(result.ok, false, "with scripting enabled a parser reads this as raw text and sees nothing");
});

test("SMIL cannot rewrite an attribute after the document has been checked", () => {
  const result = validateStaticReportHtml(
    `<!doctype html><html><body><svg><a><set attributeName="href" to="javascript:go()"/></a></svg></body></html>`,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.problems[0]?.code, "forbidden_element");
});

test("an ordinary responsive image with an inline data: URL is still archivable", () => {
  // Splitting srcset on commas tore every base64 payload in half and refused the report,
  // making the standard responsive syntax unusable in an archive.
  const result = validateStaticReportHtml(
    `<!doctype html><html><body><img srcset="data:image/png;base64,iVBORw0KGgo= 1x, chart.png 2x" src="chart.png"></body></html>`,
    new Set(["report.html", "chart.png"]),
  );
  assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.problems));
});

test("ordinary stylesheet strings are not mistaken for references", () => {
  const result = validateStaticReportHtml(
    [
      `<!doctype html><html><head><style>`,
      `body{font-family:"Inter",sans-serif}`,
      `.a::after{content:"->"}`,
      `/* background:url(http://evil/x.png) */`,
      `.b{background:url(chart.png)}`,
      `</style></head><body></body></html>`,
    ].join(""),
    new Set(["report.html", "chart.png"]),
  );
  assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.problems));
});
