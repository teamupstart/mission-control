import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActionBar } from "../src/web/components/ActionBar.tsx";
import type { Session } from "../src/shared/types.ts";

// Which controls a card offers, and when.
//
// The bar used to drop its Send button the moment the card expanded - the crude way to
// keep a second compose box off a card that already has the transcript's reply. It cost
// more than it bought: the row silently lost a control on the surface you're most likely
// to be working on, and it was the ONLY thing keeping the two boxes apart. Send stays put
// now and hands the cursor to the reply box instead (that handoff needs a real DOM, so
// it's driven end-to-end, not here); these guard the row it left behind.

function mkSession(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    pid: 1,
    agent: "claude",
    name: "card",
    nameSource: "tmux",
    tmux: { session: "dev", window: "@1", paneId: "%1" },
    state: "idle",
    cwd: "/repo",
    startedAt: 0,
    lastActivity: null,
    instrumented: true,
    hooksSeen: true,
    activity: null,
    pendingReviews: 0,
    nomistakesFixes: [],
    ...over,
  } as Session;
}

function render(props: Record<string, unknown>): string {
  return renderToStaticMarkup(
    createElement(ActionBar, {
      session: mkSession(),
      onReset: () => {},
      onToggleQueue: () => {},
      ...props,
    }),
  );
}

test("an expanded card keeps every control a collapsed one has", () => {
  // The regression in one line. Expanding is for reading a conversation; it is not a
  // reason to take away the buttons. `hasReply` is what an expanded card reports once
  // its transcript is carrying the reply box - the state the old `!expanded` gate used
  // to blank this row on.
  const html = render({ hasReply: true });
  for (const label of ["Send", "Focus", "Queue", "Reset", "Kill"]) {
    assert.match(html, new RegExp(`>${label}`), `expanded card lost ${label}: ${html}`);
  }
});

test("neither card starts with a compose box open", () => {
  // Both send surfaces are opened deliberately - by Send or the shortcut. A bar that
  // rendered its input unbidden would be the second box on an expanded card.
  assert.ok(!render({ hasReply: false }).includes("compose-input"));
  assert.ok(!render({ hasReply: true }).includes("compose-input"));
});

test("the queue button is a disclosure that reports whether the drawer is open", () => {
  // The panel is hidden by default now, so this button is the only thing on a collapsed
  // card saying the queue exists - and it has to read as pressed while it's showing, or
  // it's a button that does nothing visible on a card scrolled past the panel.
  const shut = render({ queueOpen: false });
  assert.match(shut, /class="btn btn-queue" aria-expanded="false" title="Show the work/, shut);
  const open = render({ queueOpen: true });
  assert.match(open, /class="btn btn-queue on" aria-expanded="true" title="Hide the work/, open);
});

test("the queue button carries the open count, so a waiting batch is visible unopened", () => {
  // The whole cost of hiding the panel: without this you'd have to press it to find out
  // whether anything is queued, on every card, every time.
  const html = render({ session: mkSession({ queue: { openCount: 3 } as Session["queue"] }) });
  assert.match(html, /btn-count">3</, html);
  // Nothing queued is not a "0" badge - an empty count is noise on every idle card.
  assert.ok(!render({}).includes("btn-count"));
});

test("a session with no pane can't send, but can still be queued for", () => {
  // Send needs a pty to type into; the queue is stored server-side and delivered later,
  // so a pane-less session is exactly the kind you'd want to load up in advance.
  const html = render({ session: mkSession({ tmux: undefined, wezterm: undefined }) });
  assert.match(html, /disabled="" title="No pane to send to">Send/, html);
  assert.match(html, /class="btn btn-queue"(?![^>]*disabled)/, html);
});
