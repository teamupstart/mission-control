import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The block-anchor route, end to end over a real checkout.
//
// It is a READ behind a POST, and the two things worth driving through `buildApp` are the
// ones a unit test on the resolver cannot see: that it reads the file at request time, so a
// stale render is refused rather than answered, and that a session with no such file, no
// working directory, or no session at all is turned away before parse5 is reached.

const home = mkdtempSync(join(tmpdir(), "mission-html-block-anchor-"));
process.env.MISSION_HOME = home;

const checkout = join(home, "checkout");
mkdirSync(join(checkout, "docs"), { recursive: true });

const { buildApp } = await import("../src/server/routes.ts");
const { htmlPreviewSource } = await import("../src/web/lib/htmlPreview.ts");
type Registry = import("../src/server/registry.ts").Registry;
type ReviewManager = import("../src/server/reviews.ts").ReviewManager;
type TaskManager = import("../src/server/tasks.ts").TaskManager;
type QueueManager = import("../src/server/queue.ts").QueueManager;

after(() => rmSync(home, { recursive: true, force: true }));

const registry = {
  getSession: (id: string) =>
    id === "live"
      ? { id, cwd: checkout }
      : id === "homeless"
      ? { id, cwd: null }
      : undefined,
  subscribe: () => () => {},
  onSessionsObserved: () => () => {},
} as unknown as Registry;

const stub = <T,>() => ({}) as unknown as T;
const app = buildApp({
  registry,
  reviews: stub<ReviewManager>(),
  tasks: stub<TaskManager>(),
  queues: stub<QueueManager>(),
});
const HEADERS = { host: "127.0.0.1:7317", "content-type": "application/json" };

const PAGE = [
  "<html>",
  "<head><title>Mockup</title></head>",
  "<body>",
  "<h1>The retry budget</h1>",
  "<p>Read <strong>this</strong> &amp; then the table.</p>",
  "<table>",
  "<tr><td>3</td><td>30s</td></tr>",
  "</table>",
  "</body>",
  "</html>",
].join("\n");

writeFileSync(join(checkout, "docs/page.html"), PAGE);

/** The path the bridge reports for the paragraph, as a browser's tree would index it. */
const PARAGRAPH = [{ index: 1, tag: "p" }];
/** The row inside the tbody the parser inserts for a table written without one. */
const ROW = [{ index: 2, tag: "table" }, { index: 0, tag: "tbody" }, { index: 0, tag: "tr" }];

async function resolve(
  sessionId: string,
  body: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await app.request(`/api/sessions/${sessionId}/html-block-anchor`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

async function target(
  sessionId: string,
  body: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await app.request(`/api/sessions/${sessionId}/html-block-target`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

test("a clicked paragraph comes back as its source lines and its source slice", async () => {
  const { status, data } = await resolve("live", {
    path: "docs/page.html",
    blockPath: PARAGRAPH,
  });
  assert.equal(status, 200);
  assert.equal(data.startLine, 5);
  assert.equal(data.endLine, 5);
  // Source, not DOM text. `Read this & then the table.` is what a browser shows and what a
  // text-matching resolver would have stored; it appears nowhere in the file.
  assert.equal(data.quote, "<p>Read <strong>this</strong> &amp; then the table.</p>");
  assert.deepEqual(data.blockPath, PARAGRAPH);
  assert.equal(data.blockQuote, "<p>Read <strong>this</strong> &amp; then the table.</p>");
  assert.ok(typeof data.revision === "string" && data.revision.length > 0);
});

test("a stored source range comes back as the rendered path the iframe can reveal", async () => {
  const { status, data } = await target("live", {
    path: "docs/page.html",
    startLine: 5,
    endLine: 5,
    quote: "<p>Read <strong>this</strong> &amp; then the table.</p>",
    blockPath: PARAGRAPH,
    blockQuote: "<p>Read <strong>this</strong> &amp; then the table.</p>",
  });
  assert.equal(status, 200);
  assert.deepEqual(data.blockPath, PARAGRAPH);
  assert.ok(typeof data.revision === "string" && data.revision.length > 0);

  const row = await target("live", {
    path: "docs/page.html",
    startLine: 7,
    endLine: 7,
    quote: "<tr><td>3</td><td>30s</td></tr>",
  });
  assert.equal(row.status, 200);
  assert.deepEqual(row.data.blockPath, ROW);
});

test("the revision is the one the daemon just read, so an anchor is not stamped with a guess", async () => {
  const first = await resolve("live", { path: "docs/page.html", blockPath: PARAGRAPH });
  writeFileSync(join(checkout, "docs/page.html"), `<!-- touched -->\n${PAGE}`);
  const second = await resolve("live", { path: "docs/page.html", blockPath: PARAGRAPH });
  assert.notEqual(first.data.revision, second.data.revision);
  // The file grew a line at the top, and the route answers about the file as it is NOW.
  assert.equal(second.data.startLine, 6);
  writeFileSync(join(checkout, "docs/page.html"), PAGE);
});

test("an edit that keeps the shape is still refused, because the words changed", async () => {
  // The staleness the tree walk CANNOT see, and the one that looks like success. Rewriting a
  // paragraph in place leaves the tag and the index exactly where they were, so the path from
  // the old render resolves perfectly - against words the reader never saw. Without the
  // revision check this returns 200 and the composer quotes the new sentence.
  const opened = await resolve("live", { path: "docs/page.html", blockPath: PARAGRAPH });
  const rendered = String(opened.data.revision);
  writeFileSync(
    join(checkout, "docs/page.html"),
    PAGE.replace(
      "<p>Read <strong>this</strong> &amp; then the table.</p>",
      "<p>Read <strong>that</strong> &amp; skip the table.</p>",
    ),
  );
  const stale = await resolve("live", {
    path: "docs/page.html",
    blockPath: PARAGRAPH,
    revision: rendered,
  });
  assert.equal(stale.status, 409);
  // The SAME sentence a path that no longer walks gets: same fact, same remedy.
  assert.match(String(stale.data.error), /Reload the preview/);
  // And a caller sending the revision the file actually holds is answered as before.
  const current = await resolve("live", { path: "docs/page.html", blockPath: PARAGRAPH });
  const fresh = await resolve("live", {
    path: "docs/page.html",
    blockPath: PARAGRAPH,
    revision: String(current.data.revision),
  });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.data.quote, "<p>Read <strong>that</strong> &amp; skip the table.</p>");
  writeFileSync(join(checkout, "docs/page.html"), PAGE);
});

test("omitting the revision keeps meaning do not check", async () => {
  // The field is optional so that a caller which has no revision to offer - a file that has
  // never been written, or anything not yet taught to send it - is not locked out.
  const { status } = await resolve("live", { path: "docs/page.html", blockPath: PARAGRAPH });
  assert.equal(status, 200);
});

test("a row inside an implicit tbody resolves, which a tag walk could not do", async () => {
  const { status, data } = await resolve("live", { path: "docs/page.html", blockPath: ROW });
  assert.equal(status, 200);
  assert.equal(data.startLine, 7);
  assert.equal(data.quote, "<tr><td>3</td><td>30s</td></tr>");
});

test("the preview document the browser parsed carries the same body path", async () => {
  // The prefix this route deliberately does not reproduce: the CSP meta and three bridge
  // scripts, all of which land in `<head>`. If any of them could reach `<body>`, the index
  // asserted above would be wrong in production and right in this file.
  const prefixed = htmlPreviewSource(PAGE);
  assert.ok(prefixed.includes("<body>"));
  assert.ok(prefixed.indexOf("mission:file-preview-scroll") < prefixed.indexOf("<body>"));
  assert.ok(prefixed.indexOf("mission:file-preview-block") < prefixed.indexOf("<body>"));
  assert.ok(prefixed.indexOf("mission:file-preview-link") < prefixed.indexOf("<body>"));
});

test("a path that no longer describes the file is a 409 naming the reload that fixes it", async () => {
  writeFileSync(
    join(checkout, "docs/page.html"),
    ["<body>", "<h1>The retry budget</h1>", "<h2>Rewritten</h2>", "</body>"].join("\n"),
  );
  const { status, data } = await resolve("live", { path: "docs/page.html", blockPath: PARAGRAPH });
  // 409 and not 400: the request was well formed, and the answer is that the file moved under
  // a render still on screen. That is a conflict a person resolves by reloading.
  assert.equal(status, 409);
  assert.match(String(data.error), /Reload the preview/);
  writeFileSync(join(checkout, "docs/page.html"), PAGE);
});

test("the route refuses what it cannot answer about, before it parses anything", async () => {
  assert.equal((await resolve("ghost", { path: "docs/page.html", blockPath: PARAGRAPH })).status, 404);
  assert.equal((await resolve("homeless", { path: "docs/page.html", blockPath: PARAGRAPH })).status, 400);
  assert.equal((await resolve("live", { path: "docs/missing.html", blockPath: PARAGRAPH })).status, 404);
  // Outside the checkout is the session-file boundary's refusal, not this route's.
  assert.ok((await resolve("live", { path: "../escape.html", blockPath: PARAGRAPH })).status >= 400);
  // A malformed message costs one schema check.
  assert.equal((await resolve("live", { path: "docs/page.html", blockPath: [] })).status, 400);
  assert.equal(
    (await resolve("live", { path: "docs/page.html", blockPath: [{ index: -1, tag: "p" }] })).status,
    400,
  );
  assert.equal(
    (await resolve("live", { path: "docs/page.html", blockPath: [{ index: 0, tag: "<script>" }] })).status,
    400,
  );
});

test("a file with no readable source is refused rather than parsed as empty", async () => {
  writeFileSync(join(checkout, "docs/binary.html"), Buffer.from([0x00, 0x01, 0x02, 0x00]));
  const { status } = await resolve("live", { path: "docs/binary.html", blockPath: PARAGRAPH });
  assert.equal(status, 400);
});
