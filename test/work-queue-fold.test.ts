import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkQueue } from "../src/web/components/WorkQueue.tsx";
import type { Session } from "../src/shared/types.ts";

// Folding the queue away, and the one rule that makes it work everywhere.
//
// The panel renders through four separate branches (loaded, nothing-queued, blocked,
// unreadable), and folding is deliberately NOT implemented in any of them - each builds
// the same shell and one CSS rule (`.wq-collapsed > :not(.wq-head)`) hides the body. That
// is the thing worth pinning: the marker has to be on the shell in every branch, or a
// queue would quietly refuse to fold in whichever state you happened to be in.
//
// (The layout half of the fix - the queue sitting BESIDE the conversation rather than
// above it, which is what stopped it pushing the log off an expanded card - is flexbox,
// and there is no layout engine here to ask. That part is verified in a real browser.)

function mkSession(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    pid: 1,
    agent: "claude",
    name: "card",
    nameSource: "tmux",
    state: "idle",
    cwd: "/repo",
    startedAt: 0,
    lastActivity: null,
    instrumented: true,
    hooksSeen: true,
    activity: null,
    pendingReviews: 0,
    ...over,
  } as Session;
}

function render(over: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(WorkQueue, {
      session: mkSession(),
      foremanMode: "dry-run",
      foremanEnabled: false,
      allowlisted: false,
      onToggleCollapsed: () => {},
      ...over,
    }),
  );
}

test("folding marks the shell, which is what hides the body", () => {
  assert.ok(!render({ collapsed: false }).includes("wq-collapsed"));
  assert.match(render({ collapsed: true }), /class="work-queue wq-collapsed"/);
});

test("every branch the panel renders through can fold", () => {
  // Same shell through the nothing-queued default and each harness's uninstrumented
  // refusal. They take different `return`s out of the component, and all must still
  // carry the marker.
  const branches: Array<[string, Session]> = [
    ["nothing queued", mkSession()],
    ["Codex without launch hooks", mkSession({ agent: "codex", hooksSeen: false })],
    ["Claude without hooks", mkSession({ hooksSeen: false })],
  ];
  for (const [name, session] of branches) {
    const html = render({ session, collapsed: true });
    assert.match(html, /class="work-queue wq-collapsed"/, `${name} branch can't fold: ${html}`);
  }
});

test("folding keeps the header - the row that carries the count - and drops the rest", () => {
  // The whole reason folding isn't just closing the drawer: you keep the panel, so you
  // keep the count. The number itself can't be asserted here - it comes from the FETCHED
  // queue, and no effect runs in a static render, so every branch reachable from here
  // reports zero and renders no count either way. What this can pin is that folding
  // leaves the header (and its count) standing while the body goes, which is the half a
  // regression would break. The count surviving a fold is measured in the browser.
  const html = render({ collapsed: true });
  assert.match(html, /<header class="wq-head">/, html);
  assert.match(html, /class="work-queue wq-collapsed"/, html);
});

test("the fold target is the whole header, not a lone chevron", () => {
  // The header is the only row a folded panel has, so it's also the only way back -
  // a 12px hit area for that is a trap.
  const html = render({ collapsed: true });
  assert.match(html, /<button[^>]*class="wq-head-btn"[^>]*aria-expanded="false"/, html);
  assert.match(html, /class="wq-head-btn"[^>]*>.*Work queue/s, html);
});

test("without a fold handler the header stays a plain label", () => {
  // The panel is used where folding makes no sense; it must not render a dead control.
  const html = render({ onToggleCollapsed: undefined });
  assert.ok(!html.includes("wq-head-btn"), html);
  assert.ok(!html.includes("wq-fold"), html);
  assert.match(html, /Work queue/);
});
