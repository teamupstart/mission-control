import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TranscriptMessage } from "../src/shared/types.ts";
import { UiConfigSchema } from "../src/shared/protocol.ts";
import { ConversationActivity, type ActivityTab } from "../src/web/components/ConversationActivity.tsx";

/**
 * The rail's wide-layout fold, at the markup layer. Which control is VISIBLE is the
 * stylesheet's call (it alone can see the container width), and the browser spec asserts
 * that; this pins what the markup hands the stylesheet to decide with.
 */

const WITH_ACTIVITY = [
  { id: "a", role: "assistant", text: "", ts: 1, tools: [{ name: "Read", input: { file_path: "/x/README.md" } }] },
  { id: "b", role: "user", text: "Look at the readme.", ts: 2, tools: [] },
] as TranscriptMessage[];

function render(
  collapsed: boolean,
  tab: ActivityTab = "activity",
  messages: TranscriptMessage[] = WITH_ACTIVITY,
): string {
  return renderToStaticMarkup(
    createElement(ConversationActivity, {
      messages,
      open: false,
      onToggle: () => {},
      tab,
      onTab: () => {},
      selectedTurnId: null,
      onSelectTurn: () => {},
      collapsed,
      onCollapsed: () => {},
    }),
  );
}

test("the rail states its fold for the stylesheet", () => {
  assert.match(render(false), /data-collapsed="false"/);
  assert.match(render(true), /data-collapsed="true"/);
});

test("both fold controls are in the markup, each named for what pressing it does", () => {
  const html = render(true);
  assert.match(html, /class="activity-strip"[^>]*aria-label="Expand conversation rail"/);
  assert.match(html, /class="activity-collapse"[^>]*aria-label="Collapse conversation rail"/);
});

test("the strip names the tab that is up and carries its count", () => {
  assert.match(render(true, "activity"), /<span class="activity-strip-label">Activity<\/span><span class="activity-strip-count">1<\/span>/);
  assert.match(render(true, "yours"), /<span class="activity-strip-label">Yours<\/span><span class="activity-strip-count">1<\/span>/);
});

test("an empty folded rail keeps its label and expand control, and draws no count", () => {
  for (const tab of ["activity", "yours"] as const) {
    const html = render(true, tab, []);
    assert.match(html, /class="activity-strip"[^>]*aria-label="Expand conversation rail"/);
    assert.match(html, new RegExp(`<span class="activity-strip-label">${tab === "yours" ? "Yours" : "Activity"}</span>`));
    assert.doesNotMatch(html, /activity-strip-count/);
    assert.doesNotMatch(html, /activity-count/);
  }
});

test("the preference defaults to a full column and keeps a stored fold", () => {
  assert.equal(UiConfigSchema.parse({}).conversationRailCollapsed, false);
  assert.equal(UiConfigSchema.parse({ conversationRailCollapsed: true }).conversationRailCollapsed, true);
});
