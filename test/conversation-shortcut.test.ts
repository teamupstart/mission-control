/**
 * What is at stake: the conversation chord has to REVEAL the conversation in all three
 * layouts, and reveal is not toggle.
 *
 * The conversation is the one thing every layout shows and no two show the same way.
 * Cards has no tab strip at all - the transcript is simply part of the expanded card.
 * Console always has a detail, whose strip may have been walked off to Files. The Board
 * has both: an overview that draws no detail, and a drill-in that IS a console. So one
 * key means four different actions, and three of those four are reachable only in a
 * layout you are not currently looking at - which is exactly the shape of thing that
 * gets verified once by hand and then silently breaks.
 *
 * It is testable at all because the decision is a pure function (`conversationReveal`)
 * rather than four branches inside App's keydown handler. This repo renders with
 * `renderToStaticMarkup` and has no jsdom, so no test here can dispatch a keydown, mount
 * App, or run an effect; a keyboard behaviour left in the handler can only be checked by
 * grepping App.tsx for strings, which pins spelling and not conduct. The split is the
 * same one `schedules/policy.ts` makes on the server, for the same reason.
 *
 * So this file asserts the decision table directly, and then that App and ConsoleDetail
 * are still WIRED to it - the two halves that a source grep genuinely is the right tool
 * for, because what is at risk there is a connection, not a judgement.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { conversationReveal } from "../src/web/lib/conversationReveal.ts";
import { LAYOUT_MODES } from "../src/shared/protocol.ts";
import { ACTIONS } from "../src/web/lib/keybindings.ts";
import { detailTabs } from "../src/web/lib/detailTabs.ts";

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const app = read("../src/web/App.tsx");
const detail = read("../src/web/components/layouts/ConsoleDetail.tsx");

/** Every input the handler can hand the decision, with sane defaults. */
function reveal(over: Partial<Parameters<typeof conversationReveal>[0]> = {}) {
  return conversationReveal({
    layout: "console",
    hasSelection: true,
    selectedIsExpanded: false,
    boardDetailOpen: false,
    ...over,
  });
}

test("Cards expands the card, because that is where its transcript is", () => {
  // Cards draws no tab strip, so there is no tab to switch to. The transcript is part of
  // the expanded card and expanding is the only way to reach it.
  assert.equal(reveal({ layout: "grid", selectedIsExpanded: false }), "expand");
});

test("Cards never closes a card that is already showing its conversation", () => {
  // The regression this exists to stop: making the chord a toggle. Pressing it on the
  // card you are reading would then HIDE the conversation - the exact opposite of what
  // the key is named for. `e` owns the toggle.
  assert.equal(reveal({ layout: "grid", selectedIsExpanded: true }), "already");
  assert.notEqual(reveal({ layout: "grid", selectedIsExpanded: true }), "expand");
});

test("the Board overview opens the drill-in, which starts on the conversation", () => {
  // No detail is drawn at all on the overview, so a tab request would arrive at nothing.
  assert.equal(reveal({ layout: "board", boardDetailOpen: false }), "drill-in");
});

test("a Board already drilled in switches the strip, rather than closing the drill-in", () => {
  // The second-press bug in the other direction: treating the board as one state would
  // make `g` inside the drill-in toggle it shut.
  assert.equal(reveal({ layout: "board", boardDetailOpen: true }), "tab");
});

test("Console switches the strip - its detail is permanent, only the tab moves", () => {
  assert.equal(reveal({ layout: "console" }), "tab");
  // And `boardDetailOpen` is a board fact; it must not leak into the console's answer.
  assert.equal(reveal({ layout: "console", boardDetailOpen: true }), "tab");
});

test("coming back from another detail tab is the common case, in both tabbed layouts", () => {
  // The chord's real job: you walked off to Files or Diff and want the transcript back.
  // Both tabbed surfaces must answer `tab` so the request actually reaches the strip.
  for (const layout of ["console", "board"] as const) {
    assert.equal(
      reveal({ layout, boardDetailOpen: true }),
      "tab",
      `${layout} must be able to come back to the conversation`,
    );
  }
});

test("no selection means the chord is not ours, in every layout", () => {
  // Every selection-group chord returns early without one; a layout that instead acted
  // on "whatever was last open" would expand a card the cursor is not on.
  for (const layout of LAYOUT_MODES) {
    assert.equal(reveal({ layout, hasSelection: false }), "none", `${layout} with no selection`);
  }
});

test("every layout has an answer - a new one cannot silently do nothing", () => {
  // `conversationReveal` switches exhaustively on LayoutMode, so a fourth layout fails
  // typecheck rather than falling through to `undefined`. This pins the runtime half of
  // that: every shipped layout returns a real action for a selected session.
  for (const layout of LAYOUT_MODES) {
    const answer = reveal({ layout });
    assert.ok(
      ["expand", "drill-in", "tab", "already"].includes(answer),
      `${layout} returned ${answer} for a selected session`,
    );
  }
});

test("the handler still routes the chord through the decision, and performs each answer", () => {
  // A grep is the right tool for a CONNECTION: the decision above is worthless if App
  // stops calling it, or calls it and ignores a branch.
  assert.match(app, /chord === bindings\.conversation/, "the chord must still be handled");
  assert.match(app, /conversationReveal\(\{/, "the handler must ask the shared decision");
  assert.match(app, /reveal === "expand"[^\n]*toggleExpand\(sel\.id\)/);
  assert.match(app, /reveal === "drill-in"[^\n]*setBoardOpen\(true\)/);
  assert.match(app, /reveal === "tab"[^\n]*requestConversationTab\(sel\.id\)/);
  // The nonce is what makes a second press land after you have walked away and back.
  assert.match(app, /setConversationTabRequest\(\(request\) => \(\{ sessionId, nonce: \(request\?\.nonce \?\? 0\) \+ 1 \}\)\)/);
});

test("the detail honours the request, and the tab wears the chord it answers to", () => {
  assert.match(detail, /view\.conversationTabRequest\?\.sessionId === session\.id/);
  assert.match(detail, /setTab\("conversation"\)/);
  // The keycap on the tab is the same registry entry the handler matches on, so the tab
  // cannot advertise a key that does nothing. Asserted against the tab table itself rather
  // than ConsoleDetail's source: the table moved out to `detailTabs` when the Workflows tab
  // was added, and this pair is a fact about the tab, not about where it happens to be
  // written down.
  const conversation = detailTabs({ queueCount: 0 })[0];
  assert.equal(conversation?.id, "conversation", "the conversation is still the first tab");
  assert.equal(conversation.label, "Conversation");
  assert.equal(conversation.action, "conversation");
  assert.ok(
    ACTIONS.some((a) => a.id === conversation.action),
    "the tab names an action id that must exist in the registry",
  );
});
