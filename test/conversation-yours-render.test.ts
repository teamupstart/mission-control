import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TranscriptMessage } from "../src/shared/types.ts";
import { ConversationActivity } from "../src/web/components/ConversationActivity.tsx";

/**
 * The "Yours" rail's markup, at the layer where an exact shape is cheap to pin.
 *
 * The browser spec drives the tab a person actually uses - it is reachable, it lists what
 * they sent, it names and dims what was sent for them, and a row moves the log. What it
 * deliberately does NOT assert is the head count, because the count is a bare number
 * carrying no role and no label, and giving it one purely so a browser test could name it
 * would be furniture rather than accessibility. It is asserted here instead, where the
 * markup can be read directly.
 *
 * What the count means is the whole reason it is worth a test at all: it counts the
 * operator's own messages and NOT the ones sent on their behalf. A count that included
 * the dimmed rows would restate, in the one number the rail puts in its header, exactly
 * the conflation the tab exists to end.
 */

function msg(over: Partial<TranscriptMessage> & { id: string }): TranscriptMessage {
  return { role: "user", text: "", tools: [], ts: 0, ...over };
}

/** The rail as the Yours tab, over a fixed conversation. */
function render(messages: TranscriptMessage[]): string {
  return renderToStaticMarkup(
    createElement(ConversationActivity, {
      messages,
      open: true,
      onToggle: () => {},
      tab: "yours" as const,
      onTab: () => {},
      selectedTurnId: null,
      onSelectTurn: () => {},
    }),
  );
}

/** Two the operator typed, three typed for them, and an agent reply between. */
const CONVERSATION: TranscriptMessage[] = [
  msg({ id: "mine-1", text: "Investigate the ensemble failure.", ts: 1 }),
  msg({ id: "agent", role: "assistant", text: "Reading the run record.", ts: 2 }),
  msg({ id: "f", text: "Continue, you have approval.", origin: "foreman", ts: 3 }),
  msg({ id: "mine-2", text: "Do not run the build there.", ts: 4 }),
  msg({ id: "h", text: "/retro Mission Control session action", origin: "harness", ts: 5 }),
  msg({ id: "w", text: "Repair the failing stage.", origin: "workflow", ts: 6 }),
];

test("the head count is the operator's messages, not every turn the rail lists", () => {
  const html = render(CONVERSATION);
  // Two, not five: the three delivered turns are listed below and are not counted.
  assert.match(html, /<span class="activity-count">2<\/span>/);
  assert.doesNotMatch(html, /<span class="activity-count">5<\/span>/);
});

test("every delivered row is dimmed and says who sent it, and none of the operator's is", () => {
  const html = render(CONVERSATION);
  for (const who of ["foreman", "mission control", "workflow"]) {
    assert.match(
      html,
      new RegExp(`is-injected[^>]*>.*?<span class="yours-who">${who}</span>`, "s"),
      `a ${who} row should be dimmed and carry its byline`,
    );
  }
  // The operator's own rows carry neither: two rows, and both plain.
  assert.equal(html.match(/class="yours-row"/g)?.length, 2);
});

test("the delivered rows are drawn below the operator's, whatever order they arrived in", () => {
  // Foreman's turn landed BETWEEN the operator's two, and the harness and workflow turns
  // after them. Transcript order would interleave all five; the grouping is what puts the
  // operator's messages first, and that is the thing a reader is promised.
  const html = render(CONVERSATION);
  const at = (needle: string): number => {
    const i = html.indexOf(needle);
    assert.ok(i >= 0, `${needle} should be in the markup`);
    return i;
  };
  assert.ok(at("Do not run the build there.") < at("Continue, you have approval."));
  assert.ok(at("Continue, you have approval.") < at("/retro Mission Control session action"));
  assert.ok(at("/retro Mission Control session action") < at("Repair the failing stage."));
});

test("the caption is drawn only when there is something dimmed to explain", () => {
  const explained = render(CONVERSATION);
  assert.match(explained, /without it reading as yours/);
  // A conversation nobody has been driven through needs no footnote about turns that are
  // not there, and the rail does not spend a reader's height on one.
  const own = render([msg({ id: "mine-1", text: "Investigate the ensemble failure.", ts: 1 })]);
  assert.doesNotMatch(own, /without it reading as yours/);
  assert.match(own, /<span class="activity-count">1<\/span>/);
});
