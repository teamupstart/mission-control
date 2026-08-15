import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ArchiveDetail } from "../src/shared/archives.ts";
import { ScoutReader } from "../src/web/components/scouts/ScoutReader.tsx";

const ORIGINAL = 'Trace <script>alert("initial")</script>\nwithout treating **this** as Markdown.';
const FOLLOW_UP = 'Also inspect /a/very/long/path?token=<private>&mode="literal".';
const DELIVERED_AT = "2026-08-14T15:18:00.000Z";

function detail(over: Partial<ArchiveDetail> = {}): ArchiveDetail {
  return {
    key: "00000000-0000-4000-8000-000000000000~11111111-1111-4111-8111-111111111111",
    producerId: "00000000-0000-4000-8000-000000000000",
    producerLabel: null,
    archiveId: "11111111-1111-4111-8111-111111111111",
    kind: "scout",
    status: "ready",
    captureStatus: "complete",
    title: "Concise reconnect finding",
    question: "A clipped compatibility preview",
    summary: null,
    tags: [],
    agent: "codex",
    model: "gpt-5.6",
    source: "manual",
    repositories: [],
    createdAt: Date.parse("2026-08-14T15:00:00.000Z"),
    completedAt: Date.parse("2026-08-14T15:20:00.000Z"),
    indexedAt: Date.parse("2026-08-14T15:20:01.000Z"),
    artifactCount: 0,
    bytes: 0,
    hasPrimaryReport: false,
    missingCount: 0,
    error: null,
    snippet: null,
    formatVersion: 1,
    contentDigest: null,
    bundlePath: "/tmp/archives/reader-test",
    relativePath: "00000000-0000-4000-8000-000000000000/11111111-1111-4111-8111-111111111111",
    primaryArtifactId: null,
    prompts: {
      entries: [
        { kind: "initial", text: ORIGINAL, at: null },
        { kind: "follow_up", text: FOLLOW_UP, at: DELIVERED_AT },
      ],
      truncated: true,
    },
    artifacts: [],
    missing: [],
    ...over,
  };
}

function render(archive: ArchiveDetail): string {
  return renderToStaticMarkup(
    createElement(ScoutReader, {
      detail: archive,
      state: "ready",
      error: null,
      libraryPath: "/tmp/archives",
      onDelete: () => {},
      onBack: () => {},
    }),
  );
}

test("the scout reader leads with the concise title and renders ordered prompt context as escaped text", () => {
  const html = render(detail());

  assert.match(html, /<h1 class="scouts-question">Concise reconnect finding<\/h1>/);
  assert.match(html, /<h2[^>]*>Prompt context<\/h2>/);
  assert.ok(html.indexOf("Original request") < html.indexOf("Follow-up"));
  assert.ok(html.indexOf("Original request") < html.indexOf("scouts-doc"));
  assert.match(html, new RegExp(`dateTime="${DELIVERED_AT}"`));
  assert.match(html, /This trail is incomplete/);
  assert.match(html, /Older or oversized prompt text was omitted/);

  assert.ok(html.includes("&lt;script&gt;alert(&quot;initial&quot;)&lt;/script&gt;"));
  assert.ok(html.includes("&lt;private&gt;&amp;mode=&quot;literal&quot;"));
  assert.doesNotMatch(html, /<script>alert\("initial"\)<\/script>/);
  assert.doesNotMatch(html, /<strong>this<\/strong>/, "prompt Markdown stays literal text");
});

test("the scout reader keeps an older bundle's question visible without inventing a prompt trail", () => {
  const html = render(detail({
    title: "Older concise title",
    question: "Why did the old reconnect path lose its grant?",
    prompts: null,
  }));

  assert.match(html, /<h1 class="scouts-question">Older concise title<\/h1>/);
  assert.match(
    html,
    /<p class="scouts-legacy-question">Why did the old reconnect path lose its grant\?<\/p>/,
  );
  assert.doesNotMatch(html, /Prompt context/);
  assert.doesNotMatch(html, /Original request/);
});
