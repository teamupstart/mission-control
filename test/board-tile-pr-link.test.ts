import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session } from "../src/shared/types.ts";
import { isDragSelection, SessionTile } from "../src/web/components/layouts/SessionTile.tsx";

/**
 * The board tile's PR flag has to be a real link, and the tile is not allowed to be a
 * button around it. That combination is the whole fix: while the tile was a <button>,
 * the flag could only be a <span>, so clicking a PR opened the console and you had to
 * find the chip in there and click it a second time.
 *
 * Asserted on markup because the failure is structural rather than visual - a tile
 * that wraps its content in a button still looks exactly right in a screenshot, and
 * the regression is one refactor away at any time.
 *
 * Rendered rather than driven through a browser: the dashboard's SSE stream holds the
 * connection open, which hangs headless automation.
 */

function session(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    agent: "claude",
    name: "s1",
    nameSource: "tmux",
    state: "idle",
    cwd: "/repo",
    gitBranch: null,
    gitRoot: "/repo",
    repoRoot: "/repo",
    nomistakesGated: false,
    pid: 1,
    tty: null,
    permissionMode: null,
    wezterm: null,
    tmux: null,
    agentSessionId: null,
    transcriptPath: null,
    instrumented: true,
    hooksSeen: true,
    activity: null,
    startedAt: null,
    firstSeen: 0,
    lastSeen: 0,
    lastActivity: null,
    pendingReviews: 0,
    nomistakes: null,
    nomistakesFixes: [],
    task: null,
    nomistakesNarration: null,
    prUrl: null,
    prNumber: null,
    prState: null,
    prChecks: null,
    meta: null,
    note: null,
    goal: null,
    queue: null,
    orphanedQueue: null,
    ...over,
  } as Session;
}

function render(over: Partial<Session> = {}): string {
  return renderToStaticMarkup(
    createElement(SessionTile, {
      session: session(over),
      gateNeedsYou: false,
      onOpen: () => {},
      draggingRepo: null,
      onDropped: () => {},
      onDropError: () => {},
    }),
  );
}

/**
 * Every anchor that sits between a <button> and its matching </button>. A regex can't
 * answer this - it has no notion of the closing tag - and getting it wrong is how the
 * first draft of this test passed against markup that was still nested.
 */
function anchorsInsideButtons(html: string): string[] {
  const found: string[] = [];
  let depth = 0;
  for (const m of html.matchAll(/<(\/?)(button|a)\b[^>]*>/g)) {
    const [tag, closing, name] = m;
    if (name === "button") depth += closing ? -1 : 1;
    else if (!closing && depth > 0) found.push(tag);
  }
  return found;
}

const withPr = { prUrl: "https://github.com/o/r/pull/7", prNumber: 7, prState: "open" } as const;

test("the PR flag is a link straight to GitHub, not a label you have to drill in for", () => {
  const html = render(withPr);
  assert.match(html, /<a[^>]+href="https:\/\/github\.com\/o\/r\/pull\/7"/);
  assert.match(html, /<a[^>]+target="_blank"/);
  // noreferrer, or the opened tab keeps a handle on this one.
  assert.match(html, /<a[^>]+rel="noreferrer"/);
});

test("the tile does not wrap its content in a button, which a link cannot live inside", () => {
  const html = render(withPr);
  // The open affordance is a stretched sibling of the content, so the anchor is not
  // nested inside it - invalid markup that browsers resolve by dropping the link.
  assert.match(html, /^<div class="tile /);
  const openBtn = html.match(/<button[^>]*class="tile-open"[^>]*>(.*?)<\/button>/s)?.[1];
  assert.ok(openBtn != null, "expected a stretched tile-open button");
  assert.equal(openBtn, "", "the open button must be empty, not a wrapper");
  assert.deepEqual(anchorsInsideButtons(html), []);
});

test("the open affordance is still reachable, and says which session it opens", () => {
  const html = render({ ...withPr, name: "auth-refactor" });
  assert.match(html, /<button[^>]+aria-label="Open auth-refactor"/);
});

test("the stretched open button does not eat the pointer, so tile tooltips survive", () => {
  // The tile's own `title` attributes - model, effort, context meter, gate diamonds -
  // sit on plain in-flow spans, which an absolutely positioned sibling hit-tests over
  // even at z-index 0. The button stays for the keyboard; the mouse falls through it to
  // the content and on to the root's onClick. Asserted against the stylesheet because
  // that is where the contract lives - the markup cannot show it.
  const css = readFileSync(fileURLToPath(new URL("../src/web/styles.css", import.meta.url)), "utf8");
  const rule = css.match(/\.tile-open \{([^}]*)\}/)?.[1];
  assert.ok(rule != null, "expected a .tile-open rule");
  assert.match(rule, /pointer-events:\s*none/);
});

test("a click that only ends a drag-select does not open the session", () => {
  // The tile root opens the console on click, so the mouseup ending a drag-select over
  // a branch name would too. Asserted on the predicate rather than through a click,
  // because that is the whole decision - the handler around it just supplies the
  // browser's selection.
  assert.equal(isDragSelection({ isCollapsed: false }), true, "a live selection is not a click");
  assert.equal(isDragSelection({ isCollapsed: true }), false, "an ordinary click still opens");
  assert.equal(isDragSelection(null), false, "no selection at all still opens");
});

test("a PR number with no URL yet stays a plain flag rather than a dead link", () => {
  const html = render({ prNumber: 7, prState: "open", prUrl: null });
  assert.match(html, /<span class="tile-flag pr-open">#7<\/span>/);
  assert.ok(!/<a /.test(html), "nothing to link to, so nothing should look clickable");
});

test("a failing check still rides along on the link rather than needing its own click", () => {
  const html = render({ ...withPr, prChecks: "failing" });
  const anchor = html.match(/<a [^>]*class="tile-flag tile-flag-link[^"]*"[^>]*>([^<]*)<\/a>/)?.[1];
  assert.ok(anchor != null, "expected the PR anchor");
  assert.match(anchor, /⚠/);
  assert.match(html, /title="A CI check failed on this pull request - open on GitHub"/);
});
