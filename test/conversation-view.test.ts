import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { UI_CONFIG_DEFAULTS } from "../src/shared/protocol.ts";
import {
  CONVERSATION_VIEW_OPTIONS,
  dropSessionView,
  readSessionView,
  resetSessionViews,
  resolveConversationView,
  writeSessionView,
} from "../src/web/lib/conversation-view.ts";

/**
 * The two switches that decide how a conversation is drawn, and the rule between them.
 *
 * Pure: the precedence is a function and the override store is a module-level map, so all
 * of this is checkable without a DOM. What a browser has to prove instead - that the
 * setting and the pane control actually reach the rendering - is
 * `e2e/specs/conversation-terminal-view.spec.ts`.
 */

beforeEach(() => resetSessionViews());

test("with no override, the dashboard's default decides", () => {
  assert.equal(resolveConversationView(null, "chat"), "chat");
  assert.equal(resolveConversationView(null, "terminal"), "terminal");
});

test("a session's own choice beats the default, in both directions", () => {
  // Both directions matter. An override that could only turn the terminal ON would leave
  // an operator who set the global default to terminal with no way to read one session as
  // a chat log - the switch has to be a switch.
  assert.equal(resolveConversationView("terminal", "chat"), "terminal");
  assert.equal(resolveConversationView("chat", "terminal"), "chat");
});

test("the shipped default is what an unconfigured dashboard resolves to", () => {
  assert.equal(resolveConversationView(null), UI_CONFIG_DEFAULTS.conversationView);
  assert.equal(UI_CONFIG_DEFAULTS.conversationView, "chat");
});

test("an override is per session, not per dashboard", () => {
  writeSessionView("s1", "terminal");
  assert.equal(readSessionView("s1"), "terminal");
  // The whole point of the per-session half: flipping one session says nothing about the
  // next one, which keeps reading however the settings page says to.
  assert.equal(readSessionView("s2"), null);
  assert.equal(resolveConversationView(readSessionView("s2"), "chat"), "chat");
});

test("an override survives the panel unmounting, which is why it is not component state", () => {
  // There is no mount here to lose - that IS the test. The map outlives every panel that
  // can end under it: a card collapsing, another card expanding, a nav filter dropping the
  // session. A `useState` in the panel would have taken this choice with it every time.
  writeSessionView("s1", "terminal");
  assert.equal(readSessionView("s1"), "terminal");
  assert.equal(readSessionView("s1"), "terminal");
});

test("a departed session's override is collected, so a reused id starts clean", () => {
  writeSessionView("s1", "terminal");
  writeSessionView("s2", "terminal");
  dropSessionView("s1");
  assert.equal(readSessionView("s1"), null, "the departed session kept its override");
  assert.equal(readSessionView("s2"), "terminal", "collecting one dropped another");
});

test("every shipped rendering is offered by the settings picker, exactly once", () => {
  // The picker is the only place the global default can be set, so a rendering missing
  // from it is a rendering an operator cannot choose.
  const ids = CONVERSATION_VIEW_OPTIONS.map((o) => o.id);
  assert.deepEqual([...ids].sort(), ["chat", "terminal"]);
  assert.equal(new Set(ids).size, ids.length);
  for (const o of CONVERSATION_VIEW_OPTIONS) {
    assert.ok(o.label.length > 0 && o.description.length > 0, `${o.id} has no prose`);
  }
});
