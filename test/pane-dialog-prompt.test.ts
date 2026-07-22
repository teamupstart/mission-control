import { claudeTui } from "../src/server/harness/claude/tui.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PaneDialogPrompt } from "../src/web/components/PaneDialogPrompt.tsx";
import { TranscriptPanel } from "../src/web/components/TranscriptPanel.tsx";
import { parsePaneDialog } from "../src/server/discovery/pane-dialog.ts";
import { MULTI_SELECT } from "./fixtures/claude-panes.ts";
import { activePaneDialog, reportBucket, needsYouReason } from "../src/shared/session.ts";
import { stateDisplay } from "../src/web/lib/format.ts";
import type { PaneDialog, Session } from "../src/shared/types.ts";

// The dialog spec the REGISTRY actually holds, not a test-local copy: this suite exists to
// catch our model of a TUI drifting from the TUI, and a fixture checked against a spec the
// daemon does not use would certify a grammar nobody runs.
const CLAUDE_DIALOG = claudeTui.dialog!;


// Answering, from the dashboard, the option menu a session's terminal is parked on.
//
// Rendered to static markup rather than driven through a browser, like the other view
// tests here: the dashboard's SSE stream holds the connection open and hangs headless
// automation. The click path itself is not simulated - what these assert is that the rows
// reach the human intact and that the reply box is shut while a menu is up, which is the
// correctness half. (Delivery is `selectPaneOption`'s, covered in foreman-pane.test.ts.)

/** A verbatim `AskUserQuestion` capture, run through the real parser rather than hand-built. */
const CAPTURE = `
 ☐ Database

Which database should this project use?

❯ 1. Postgres (Recommended)
     Full-featured relational DB with strong JSON support.
  2. SQLite
     Zero-config embedded file database.
  3. Type something.
────────────────────────────────────────────────────────────────────────────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;

const dialog = parsePaneDialog(CAPTURE, CLAUDE_DIALOG)!;

function render(d: PaneDialog = dialog): string {
  return renderToStaticMarkup(createElement(PaneDialogPrompt, { sessionId: "s1", dialog: d }));
}

test("every row the terminal is showing is offered as a button", () => {
  const html = render();
  for (const label of ["Postgres (Recommended)", "SQLite", "Type something.", "Chat about this"]) {
    assert.ok(html.includes(label), `missing row: ${label}`);
  }
  // Anchored on the class's closing boundary: the <ul> is `pd-options`, so both a bare
  // `pd-option` and a `class="pd-option` prefix would count it as a fifth row.
  assert.equal((html.match(/class="pd-option[" ]/g) ?? []).length, 4);
});

test("the question is shown, because the labels alone are not one", () => {
  assert.ok(render().includes("Which database should this project use?"));
});

test("descriptions ride along with their row", () => {
  assert.ok(render().includes("Full-featured relational DB with strong JSON support."));
});

test("the row the terminal's cursor sits on is marked", () => {
  // Where an Enter typed in the terminal would land right now. The human may have a tab
  // open on this same session, and the two views disagreeing about the default is its own
  // small betrayal.
  const html = render();
  assert.ok(html.includes("pd-current"));
  assert.equal((html.match(/pd-current/g) ?? []).length, 1);
});

test("a menu with no question renders its rows rather than nothing", () => {
  const html = render({ options: [{ number: 1, label: "Yes" }], highlighted: 1 });
  assert.ok(html.includes("Yes"));
  assert.ok(!html.includes("pd-prompt"));
});

// ---- A multi-select is a FORM, and must not be dressed as a menu ----

const form = parsePaneDialog(MULTI_SELECT, CLAUDE_DIALOG)!;

test("a multi-select renders checkboxes carrying the terminal's own ticks", () => {
  const html = render(form);
  // Alpha and Beta are ticked on the pane, Gamma is not - the human starts from the state
  // the terminal is actually in, not from an empty form that would silently clear it.
  assert.equal((html.match(/aria-checked="true"/g) ?? []).length, 2);
  assert.equal((html.match(/aria-checked="false"/g) ?? []).length, 1, "Gamma, and only Gamma");
  for (const label of ["Alpha", "Beta", "Gamma", "Type something"]) {
    assert.ok(html.includes(label), `missing row: ${label}`);
  }
});

test("the free-text row is shown, but as a press rather than a box", () => {
  // It renders a box on the pane and is not one: ticked with nothing typed, Claude still
  // calls the question unanswered. Rendering it as a checkbox would let a human tick it,
  // submit, and be told they answered nothing - so it stays visible and reachable (it is
  // how they ask to type an answer instead) and is simply never part of the answer set.
  const row = render(form)
    .split("<li>")
    .find((li) => li.includes("Type something"))!;
  assert.ok(!row.includes("aria-checked"), row);
  assert.ok(row.includes("pd-num"));
});

test("a form offers one Submit, because ticking a box answers nothing", () => {
  // The bug this closes: every row rendered as a button that looked like an answer, while
  // pressing one only toggled its box in the terminal - so a human clicked an option,
  // nothing was sent, and the same question sat there. The send is its own control now.
  const html = render(form);
  assert.ok(html.includes("Submit answers"));
  assert.ok(html.includes("pd-submit"));
  assert.ok(!html.includes("pd-current"), "a form has no default row to press");
});

test("a form's unboxed row stays a press, not a tick", () => {
  // "Chat about this" is not part of the answer set - it is the way out of the question.
  const row = render(form)
    .split("<li>")
    .find((li) => li.includes("Chat about this"))!;
  assert.ok(!row.includes("aria-checked"), row);
  // Rendered as the numbered row it is on the pane, which is also how it is pressed.
  assert.ok(row.includes("pd-num"));
});

test("a menu is still a menu - the split does not reach single-select", () => {
  const html = render();
  assert.ok(!html.includes("aria-checked"));
  assert.ok(!html.includes("pd-submit"));
  assert.ok(html.includes("pd-current"));
});

// ---- The board has to SHOW that the session is blocked ----

const base = {
  state: "idle",
  pendingReviews: 0,
  instrumented: false,
  nomistakes: null,
  paneDialog: null,
} as unknown as Session;

test("a session parked on a menu needs you, with or without hooks", () => {
  // The gap this closes: `awaiting_input` is hook-reported and gated on `instrumented`,
  // so an UNINSTRUMENTED session sitting on a permission prompt reported idle forever
  // while being the most definitively blocked thing on the board.
  assert.equal(reportBucket(base), "idle");
  assert.equal(stateDisplay(base, false).tone, "neutral");

  const blocked = { ...base, paneDialog: dialog };
  assert.equal(reportBucket(blocked), "needs-you");
  assert.equal(stateDisplay(blocked, false).tone, "attention");
  assert.equal(stateDisplay(blocked, false).label, "needs an answer");
});

test("the reason counts the ways out, so a prompt reads apart from a question", () => {
  assert.equal(needsYouReason({ ...base, paneDialog: dialog }), "4 options to pick from");
  assert.equal(needsYouReason(base), null);
});

test("a review still outranks a menu - it is the more specific ask", () => {
  const both = { ...base, paneDialog: dialog, pendingReviews: 1 } as Session;
  assert.equal(needsYouReason(both), "to review");
  assert.equal(reportBucket(both), "needs-you");
});

test("an exited session is not resurrected by a menu left on its screen", () => {
  const dead = { ...base, state: "exited", paneDialog: dialog } as Session;
  assert.equal(reportBucket(dead), "exited");
  assert.equal(stateDisplay(dead, false).tone, "exited");
  // The field outlives the pane: a vanished session is marked exited field-by-field, so
  // the last menu rides along for the whole exit-linger window. Every reader that offers
  // to ACT on one goes through this, which is what keeps the card from showing buttons
  // aimed at a dead pane (and the composer from staying shut against it).
  assert.equal(activePaneDialog(dead), null);
  assert.equal(needsYouReason(dead), null);
  assert.equal(activePaneDialog({ ...base, paneDialog: dialog } as Session), dialog);
});

// ---- The reply box has to be SHUT while a menu is up ----

test("the reply box is closed while a menu is up, and says why", () => {
  // The bug this closes, from the human's side. Prose sent at a dialog is swallowed -
  // nothing is focused to receive it - and the trailing Enter confirms whichever row was
  // already highlighted. So a reply typed here would not fail; it would silently answer
  // the question with the default, under the human's name. Foreman was taught to answer
  // menus by cursor-walk; this is the same fix for the reply box.
  const open = renderToStaticMarkup(
    createElement(TranscriptPanel, {
      sessionId: "s1", agent: "claude", canSend: true, dialogOpen: true,
    }),
  );
  assert.match(open, /Waiting on a menu - pick an option above/);
  // Both controls, not just the textarea: the Send button is its own way in.
  assert.equal((open.match(/disabled=""/g) ?? []).length >= 2, true, open);
});

test("the reply box reopens once the menu is gone", () => {
  const closed = renderToStaticMarkup(
    createElement(TranscriptPanel, {
      sessionId: "s1", agent: "claude", canSend: true, dialogOpen: false,
    }),
  );
  assert.match(closed, /Reply to this session/);
  assert.ok(!closed.includes("Waiting on a menu"));
});
