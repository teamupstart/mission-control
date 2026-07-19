import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PaneDialogPrompt } from "../src/web/components/PaneDialogPrompt.tsx";
import { TranscriptPanel } from "../src/web/components/TranscriptPanel.tsx";
import { parsePaneDialog } from "../src/server/discovery/pane-dialog.ts";
import { reportBucket, needsYouReason } from "../src/shared/session.ts";
import { stateDisplay } from "../src/web/lib/format.ts";
import type { PaneDialog, Session } from "../src/shared/types.ts";

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

const dialog = parsePaneDialog(CAPTURE)!;

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
  assert.equal(stateDisplay(base).tone, "neutral");

  const blocked = { ...base, paneDialog: dialog };
  assert.equal(reportBucket(blocked), "needs-you");
  assert.equal(stateDisplay(blocked).tone, "attention");
  assert.equal(stateDisplay(blocked).label, "needs an answer");
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
  assert.equal(stateDisplay(dead).tone, "exited");
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
