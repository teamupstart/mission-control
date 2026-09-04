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

function render(archive: ArchiveDetail, renaming = false): string {
  return renderToStaticMarkup(
    createElement(ScoutReader, {
      detail: archive,
      state: "ready",
      error: null,
      libraryPath: "/tmp/archives",
      onDelete: () => {},
      onBack: () => {},
      renaming,
      onRenameStart: () => {},
      onRenameClose: () => {},
      onRename: async () => ({ ok: true }),
    }),
  );
}

test("the scout reader leads with the concise title and renders ordered prompt context as escaped text", () => {
  const html = render(detail());

  assert.match(html, /<h1 class="scouts-question"[^>]*><button[^>]*>.*Concise reconnect finding.*<\/button>/);
  assert.match(html, /<h2 id="scouts-prompt-context-heading"[^>]*>.*Prompt context.*<\/h2>/);
  // Open on arrival, so the request someone is checking needs no click to read.
  assert.match(html, /class="scouts-prompt-disclosure" aria-expanded="true"/);
  assert.match(html, /2 prompts/);
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

  assert.match(html, /<h1 class="scouts-question"[^>]*><button[^>]*>.*Older concise title.*<\/button>/);
  assert.match(
    html,
    /<p class="scouts-legacy-question">Why did the old reconnect path lose its grant\?<\/p>/,
  );
  assert.doesNotMatch(html, /Prompt context/);
  assert.doesNotMatch(html, /Original request/);
});

test("the scout reader swaps its title for the shared inline rename editor", () => {
  const html = render(detail(), true);

  assert.match(html, /aria-label="Rename scout"/);
  assert.match(html, /value="Concise reconnect finding"/);
  assert.match(html, /aria-label="Save name"/);
  assert.match(html, /aria-label="Cancel rename"/);
});

test("the scout reader bounds the whole prompt ledger in one scroll container", () => {
  const html = render(detail());

  // The cap and the scroll live in `.scouts-prompt-scroll`; what the markup has to carry is
  // the keyboard reach into that scroll container, which CSS cannot add.
  const scrollers = html.match(/<div class="scouts-prompt-scroll" tabindex="0">/g) ?? [];
  assert.equal(scrollers.length, 1, "the ledger is one focusable scroll box, not one per prompt");

  const texts = html.match(/<p class="scouts-prompt-text">/g) ?? [];
  assert.equal(texts.length, 2, "each prompt body flows at its natural height inside it");
  assert.doesNotMatch(
    html,
    /class="scouts-prompt-text"[^>]*tabindex/,
    "no nested focusable scroller per prompt",
  );
});
