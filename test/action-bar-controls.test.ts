import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActionBar } from "../src/web/components/ActionBar.tsx";
import type { Session } from "../src/shared/types.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";
import { hasTooltip } from "./helpers/markup.ts";

// The shared Console and Board detail footer has one control set. Send lives in the
// conversation tab and Queue is a detail tab, while their keyboard handles remain
// registered by ActionBar.

function mkSession(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    pid: 1,
    agent: "claude",
    name: "session",
    nameSource: "tmux",
    terminals: [mkMuxHandle({ session: "dev", windowName: "@1" })],
    state: "idle",
    cwd: "/repo",
    startedAt: 0,
    lastActivity: null,
    instrumented: true,
    hooksSeen: true,
    activity: null,
    pendingReviews: 0,
    pendingTurns: [],
    ...over,
  } as Session;
}

function render(props: Record<string, unknown>): string {
  return renderToStaticMarkup(
    createElement(ActionBar, {
      session: mkSession(),
      onReset: () => {},
      onToggleQueue: () => {},
      // Complete and Kill open app-level dialogs, so like Reset they are drawn only
      // where the caller supplied a way to open one. Every real call site does, and
      // `kill-returns-to-overview.test.ts` is what holds them to it.
      onComplete: () => {},
      onKill: () => {},
      ...props,
    }),
  );
}

test("the detail footer exposes only the surviving Console and Board controls", () => {
  const html = render({ onDiff: () => {} });
  for (const label of ["focus", "diff", "reset", "interrupt", "complete", "kill"]) {
    assert.match(html, new RegExp(`(?:>|</kbd> )${label}`), `detail lost ${label}: ${html}`);
  }
  assert.doesNotMatch(html, /(?:>|<\/kbd> )Send/);
  assert.doesNotMatch(html, /(?:>|<\/kbd> )Queue/);
});

test("the detail does not start with a fallback compose box open", () => {
  assert.ok(!render({ hasReply: false }).includes("compose-input"));
  assert.ok(!render({ hasReply: true }).includes("compose-input"));
});

test("the footer explains why an idle session cannot be interrupted", () => {
  const html = render({ session: mkSession({ runtime: "sdk", terminals: [] }) });
  assert.ok(hasTooltip(html, "This session isn't running a turn, so there is nothing to stop"));
  assert.match(html, /act act-interrupt[^>]*disabled/);
});
