import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { SessionFileDocument } from "../src/shared/types.ts";
import {
  artifactStateEntryCounts,
  classifyArtifactPreview,
  conversationArtifacts,
  dropSessionArtifactState,
  readArtifactExpanded,
  retainDiscoveredArtifacts,
  resetArtifactState,
  writeArtifactExpanded,
} from "../src/web/lib/conversationArtifacts.ts";
import { ConversationArtifacts } from "../src/web/components/ConversationArtifacts.tsx";

const REPORT = "docs/reports/x/report.html";
const PLAN = "docs/plans/x/plan.htm";
const paths = new Set([
  REPORT,
  PLAN,
  "docs/plans/x/plan.md",
  "docs/reports/my notes/report.html",
  "docs/reports/x/report.HTML",
  "one.html",
  "two.html",
  "three.html",
  "four.html",
]);

const found = (text: string, listing: ReadonlySet<string> = paths): string[] =>
  conversationArtifacts(text, listing).map((artifact) => artifact.path);

test("detects an HTML artifact on its own line with or without a short label", () => {
  assert.deepEqual(found(`Finished.\nReport: ${REPORT}`), [REPORT]);
  assert.deepEqual(found(`Finished.\n${PLAN}`), [PLAN]);
});

test("detects bare and angle-bracketed Markdown link destinations", () => {
  assert.deepEqual(found(`[the report](${REPORT})`), [REPORT]);
  assert.deepEqual(found(`[the plan](<${PLAN}>)`), [PLAN]);
  assert.deepEqual(
    found("[notes](<docs/reports/my notes/report.html>)"),
    ["docs/reports/my notes/report.html"],
  );
});

test("deduplicates by first appearance and caps a turn at three artifacts", () => {
  assert.deepEqual(found(`${REPORT}\nReport: ${REPORT}`), [REPORT]);
  assert.deepEqual(found("one.html\ntwo.html\nthree.html\nfour.html"), [
    "one.html",
    "two.html",
    "three.html",
  ]);
});

test("does not promote incidental, placeholder, non-HTML, or absent paths", () => {
  assert.deepEqual(found(`I edited ${REPORT} in this change.`), []);
  assert.deepEqual(found("Report: docs/reports/<slug>/report.html"), []);
  assert.deepEqual(found("docs/plans/x/plan.md"), []);
  assert.deepEqual(found("image.png", new Set(["image.png"])), []);
  assert.deepEqual(found("Makefile", new Set(["Makefile"])), []);
  assert.deepEqual(found("missing.html"), []);
});

test("matches HTML extensions case-insensitively and strips source locations", () => {
  assert.deepEqual(found("docs/reports/x/report.HTML"), ["docs/reports/x/report.HTML"]);
  assert.deepEqual(found(`${REPORT}:42`), [REPORT]);
});

test("an unavailable checkout listing cannot confirm any artifact", () => {
  assert.deepEqual(found(`Report: ${REPORT}`, new Set()), []);
});

test("a turn retains only artifacts previously confirmed by the live listing", () => {
  resetArtifactState();
  const text = `Report: ${REPORT}`;
  assert.deepEqual(retainDiscoveredArtifacts("s1", "t1", text, []), []);
  assert.deepEqual(
    retainDiscoveredArtifacts("s1", "t1", text, conversationArtifacts(text, paths)),
    [{ path: REPORT }],
  );
  assert.deepEqual(retainDiscoveredArtifacts("s1", "t1", text, []), [{ path: REPORT }]);
  assert.deepEqual(retainDiscoveredArtifacts("s1", "t1", "The report was removed.", []), []);
  resetArtifactState();
});

test("artifact-free turns do not accumulate retained state", () => {
  resetArtifactState();
  for (let index = 0; index < 5_000; index += 1) {
    assert.deepEqual(
      retainDiscoveredArtifacts("long-session", `turn-${index}`, `Ordinary turn ${index}`, []),
      [],
    );
  }
  assert.deepEqual(artifactStateEntryCounts(), { expanded: 0, discovered: 0 });

  const text = `Report: ${REPORT}`;
  assert.deepEqual(
    retainDiscoveredArtifacts("long-session", "artifact-turn", text, [{ path: REPORT }]),
    [{ path: REPORT }],
  );
  assert.deepEqual(artifactStateEntryCounts(), { expanded: 0, discovered: 1 });
  assert.deepEqual(
    retainDiscoveredArtifacts("long-session", "artifact-turn", text, []),
    [{ path: REPORT }],
    "a live listing may drop the deleted file while its refusal card remains",
  );
  assert.deepEqual(artifactStateEntryCounts(), { expanded: 0, discovered: 1 });

  assert.deepEqual(
    retainDiscoveredArtifacts("long-session", "artifact-turn", "The report was removed.", []),
    [],
  );
  assert.deepEqual(artifactStateEntryCounts(), { expanded: 0, discovered: 0 });
  resetArtifactState();
});

test("retention never exceeds the per-turn artifact cap", () => {
  resetArtifactState();
  const text = "one.html\ntwo.html\nthree.html\nfour.html";
  const firstThree = [
    { path: "one.html" },
    { path: "two.html" },
    { path: "three.html" },
  ];

  assert.deepEqual(retainDiscoveredArtifacts("s1", "t1", text, firstThree), firstThree);
  assert.deepEqual(
    retainDiscoveredArtifacts("s1", "t1", text, [...firstThree, { path: "four.html" }]),
    firstThree,
  );
  resetArtifactState();
});

function document(over: Partial<SessionFileDocument> = {}): SessionFileDocument {
  return {
    path: REPORT,
    kind: "html",
    editable: true,
    text: "<h1>Report</h1>",
    size: 15,
    mtime: 1,
    language: "html",
    revision: "r1",
    error: null,
    ...over,
  };
}

test("classifies every required preview refusal without browser-sized fixtures", () => {
  assert.equal(classifyArtifactPreview({ ok: true, file: document() }).kind, "ready");
  assert.deepEqual(
    classifyArtifactPreview({ ok: true, file: document({ kind: "oversized", text: null }) }),
    {
      kind: "refusal",
      title: "Too large to preview.",
      explanation: "This file is over the 5 MiB preview cap. Open it in Files to inspect it there.",
      size: 15,
    },
  );
  assert.equal(
    classifyArtifactPreview({
      ok: true,
      file: document({ kind: "binary", text: null, error: "This file is not valid UTF-8" }),
    }).kind,
    "refusal",
  );
  const gone = classifyArtifactPreview({ ok: false, error: "file no longer exists" });
  assert.equal(gone.kind, "refusal");
  if (gone.kind === "refusal") assert.equal(gone.title, "File no longer exists.");
  const refused = classifyArtifactPreview({
    ok: false,
    error: "path resolves outside the session checkout",
  });
  assert.equal(refused.kind, "refusal");
  if (refused.kind === "refusal") assert.equal(refused.title, "Preview blocked for safety.");
});

test("expanded state survives remount-shaped reads and is collected by session", () => {
  resetArtifactState();
  assert.equal(readArtifactExpanded("s1", REPORT), true);
  writeArtifactExpanded("s1", REPORT, false);
  writeArtifactExpanded("s2", REPORT, false);
  assert.equal(readArtifactExpanded("s1", REPORT), false);
  dropSessionArtifactState("s1");
  assert.equal(readArtifactExpanded("s1", REPORT), true);
  assert.equal(readArtifactExpanded("s2", REPORT), false);
  resetArtifactState();
});

test("the artifact header keeps the disclosure, size, and actions as sibling controls", () => {
  resetArtifactState();
  const html = renderToStaticMarkup(createElement(ConversationArtifacts, {
    sessionId: "s1",
    artifacts: [{ path: REPORT }],
    onOpenFile: () => true,
    onCommentInFiles: () => {},
    onViewInFiles: () => {},
  }));
  const header = html.match(/<header class="artifact-head">([\s\S]*?)<\/header>/)?.[1] ?? "";
  assert.equal((header.match(/<button/g) ?? []).length, 4);
  const disclosure = header.match(/<button[^>]*artifact-disclose[\s\S]*?<\/button>/)?.[0] ?? "";
  assert.equal((disclosure.match(/<button/g) ?? []).length, 1, "no button is nested in the disclosure");
  const disclosureAt = header.indexOf("artifact-disclose");
  const sizeAt = header.indexOf("artifact-size");
  const refreshAt = header.indexOf(`aria-label="Refresh preview of ${REPORT}"`);
  const commentAt = header.indexOf(`aria-label="Comment on ${REPORT} in Files"`);
  const viewAt = header.indexOf(`aria-label="View ${REPORT} in Files"`);
  assert.ok(disclosureAt < sizeAt && sizeAt < refreshAt && refreshAt < commentAt);
  assert.ok(commentAt < viewAt, "Comment precedes View");
  assert.match(html, /aria-label="Preview of docs\/reports\/x\/report\.html"/);
  assert.match(html, /aria-label="Refresh preview of docs\/reports\/x\/report\.html"/);
  assert.match(html, /aria-label="Comment on docs\/reports\/x\/report\.html in Files"/);
  assert.match(html, /aria-label="View docs\/reports\/x\/report\.html in Files"/);
  const controlled = html.match(/aria-controls="([^"]+)"/)?.[1];
  assert.ok(controlled);
  assert.match(html, new RegExp(`id="${controlled}"`));

  const withoutCommentHandler = renderToStaticMarkup(createElement(ConversationArtifacts, {
    sessionId: "s1",
    artifacts: [{ path: REPORT }],
    onOpenFile: () => true,
  }));
  assert.doesNotMatch(withoutCommentHandler, /Comment in Files/);
  assert.doesNotMatch(withoutCommentHandler, /aria-label="Comment on .* in Files"/);
});

test("each action renders only for the handler it needs, so neither implies the other", () => {
  // The two are independent props on purpose. A surface that can open Files but has no
  // comment path - and the reverse - must draw exactly the control it can honour, or the
  // card offers a button that silently does nothing.
  resetArtifactState();
  const viewOnly = renderToStaticMarkup(createElement(ConversationArtifacts, {
    sessionId: "s1",
    artifacts: [{ path: REPORT }],
    onViewInFiles: () => {},
  }));
  assert.match(viewOnly, new RegExp(`aria-label="View ${REPORT} in Files"`));
  assert.doesNotMatch(viewOnly, /aria-label="Comment on /);

  const commentOnly = renderToStaticMarkup(createElement(ConversationArtifacts, {
    sessionId: "s1",
    artifacts: [{ path: REPORT }],
    onCommentInFiles: () => {},
  }));
  assert.match(commentOnly, new RegExp(`aria-label="Comment on ${REPORT} in Files"`));
  assert.doesNotMatch(commentOnly, /aria-label="View /);
});

test("the visible labels are the bare verbs, and the paths live on the accessible names", () => {
  // Two artifacts in one turn, which is what makes the split necessary: the faces read
  // "Comment" and "View" four times over, so the only thing telling an operator's screen
  // reader WHICH report each one acts on is the aria-label.
  resetArtifactState();
  const other = "docs/reports/y/report.html";
  const html = renderToStaticMarkup(createElement(ConversationArtifacts, {
    sessionId: "s1",
    artifacts: [{ path: REPORT }, { path: other }],
    onCommentInFiles: () => {},
    onViewInFiles: () => {},
  }));

  assert.equal((html.match(/>Comment</g) ?? []).length, 2);
  assert.equal((html.match(/>View</g) ?? []).length, 2);
  // The old label is gone: it named the destination twice and left no room for a second
  // action that goes to the same place.
  assert.doesNotMatch(html, />Comment in Files</);
  for (const p of [REPORT, other]) {
    assert.match(html, new RegExp(`aria-label="Comment on ${p.replaceAll("/", "\\/")} in Files"`));
    assert.match(html, new RegExp(`aria-label="View ${p.replaceAll("/", "\\/")} in Files"`));
  }
});
