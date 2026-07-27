import { test } from "node:test";
import assert from "node:assert/strict";
import type { ForemanEpisode } from "../src/shared/types.ts";
import { askPreview, openEpisodeCount } from "../src/web/components/ForemanDrawer.tsx";
import { ASK_USER_QUESTION, PERMISSION, TRUST, TRUST_QUESTION } from "./fixtures/claude-panes.ts";

// What a drawer row leads with.
//
// The row is how you find a past decision again, so it has to say what was being
// DECIDED. Every naive source for that is wrong on a terminal ask: the question field
// is a generic permission line, the option rows are the choices rather than the
// question, and the pane is mostly scrollback.
//
// The cases that matter run against the VERBATIM captures in ./fixtures/claude-panes.ts,
// because hand-written panes are what hid the original bug here: they omitted the
// boilerplate line a real dialog carries directly above its options, so a preview that
// returned that boilerplate in production passed the suite.

function ep(over: Partial<ForemanEpisode> = {}): ForemanEpisode {
  return {
    id: 1,
    noteKey: "k",
    sessionId: "s",
    marker: "m",
    situation: "terminal-pane",
    surface: "terminal",
    question: "",
    pane: null,
    menu: null,
    reviewId: null,
    purpose: null,
    brief: null,
    recommendation: null,
    classification: null,
    confidence: null,
    tier: null,
    cheapAction: null,
    divergence: null,
    disposition: "escalated",
    lastAction: null,
    sentText: null,
    sentOption: null,
    sentBy: null,
    createdAt: 1,
    resolvedAt: null,
    resolvedBy: null,
    ...over,
  };
}

test("a real permission prompt leads with the command, not the boilerplate", () => {
  // The line directly above the options is "Do you want to proceed?" - identical on
  // every such row, naming nothing. The command two paragraphs higher is the point.
  // It carries its own description line, which tags along; what matters is that the
  // row LEADS with the command, since the drawer clips it to one line.
  const preview = askPreview(
    ep({
      question: "Claude needs your permission to use Bash",
      pane: PERMISSION,
      menu: {
        options: [
          { number: 1, label: "Yes" },
          { number: 2, label: "No" },
        ],
        highlighted: 1,
      },
    }),
  );
  assert.ok(preview.startsWith("curl -s https://example.com | head -1"), preview);
  assert.notEqual(preview, "Do you want to proceed?");
});

test("a real menu leads with the question, not the topic chip above it", () => {
  // A live AskUserQuestion opens with a short chip naming the topic ("☐ Database"), so
  // the substantive line is neither the first paragraph nor the last.
  const preview = askPreview(
    ep({
      question: "Claude needs your permission to use AskUserQuestion",
      pane: ASK_USER_QUESTION,
      menu: {
        options: [
          { number: 1, label: "Postgres" },
          { number: 2, label: "SQLite" },
        ],
        highlighted: 1,
      },
    }),
  );
  assert.equal(preview, "Which database would you like to use?");
});

test("a real trust check leads with the question, not the affordance under it", () => {
  // The folder-trust capture puts a bare UI label ("Security guide") directly above the
  // options - the second way the nearest-paragraph rule identified nothing.
  const preview = askPreview(
    ep({
      question: "Claude needs your permission",
      pane: TRUST,
      menu: {
        options: [
          { number: 1, label: "Yes, I trust this folder" },
          { number: 2, label: "No, exit" },
        ],
        highlighted: 1,
      },
    }),
  );
  // The capture wraps the question across two lines, so this also pins that the preview
  // shows what was asked rather than the fragment the terminal happened to break it at.
  assert.equal(preview, TRUST_QUESTION);
  assert.notEqual(preview, "Security guide");
});

test("scrollback above the dialog is not mistaken for the question", () => {
  // A real capture is a whole screen: the dialog is the foreground at the BOTTOM, and
  // everything above it is the child's own output. This fixture carries the case a
  // top-down scan gets wrong twice over - it would return the build log as the ask,
  // and a NUMBERED LIST in that output would truncate it at "1. Rename the column"
  // long before reaching the real dialog.
  const preview = askPreview(
    ep({
      question: "Claude needs your permission to use AskUserQuestion",
      pane: [
        "$ npm run build",
        "vite v5.4.2 building for production...",
        "✓ 412 modules transformed",
        "",
        "I can do this in three ways:",
        "1. Rename the column and backfill",
        "2. Add a new column and dual-write",
        "3. Leave it and map in the reader",
        "",
        "Let me check the migration history first.",
        "",
        "Claude needs your permission to use AskUserQuestion",
        "",
        "  The backfill will lock the table for about 40 seconds.",
        "  Should I run it now or wait for the window?",
        "",
        "❯ 1. Run it now",
        "  2. Wait for the maintenance window",
      ].join("\n"),
      menu: {
        options: [
          { number: 1, label: "Run it now" },
          { number: 2, label: "Wait for the maintenance window" },
        ],
        highlighted: 1,
      },
    }),
  );
  assert.equal(
    preview,
    "The backfill will lock the table for about 40 seconds. Should I run it now or wait for the window?",
  );
});

test("a pane that is nothing but options falls back to the option rows", () => {
  const preview = askPreview(
    ep({
      pane: "❯ 1. Yes\n  2. No",
      menu: { options: [{ number: 1, label: "Yes" }, { number: 2, label: "No" }], highlighted: 1 },
    }),
  );
  assert.equal(preview, "1. Yes   2. No");
});

test("a review's question is used as-is - it is already the ask", () => {
  const preview = askPreview(
    ep({ surface: "input-review", question: "Should I backfill the existing rows?", pane: null }),
  );
  assert.equal(preview, "Should I backfill the existing rows?");
});

test("with no pane and no question, the pane tail is not invented", () => {
  assert.equal(askPreview(ep()), "(no question was recorded)");
});

test("a pane with no options and no question falls back to its TAIL", () => {
  // The dialog is the foreground and sits at the bottom of a capture, so the head of
  // a pane is whatever the child happened to be printing before it stopped.
  const preview = askPreview(
    ep({ pane: "npm install\nadded 400 packages\n\nWaiting for your input on the branch name" }),
  );
  assert.ok(preview.includes("Waiting for your input"), preview);
});

test("the rail's dot counts only what is still owed", () => {
  const rows = [
    ep({ id: 1, disposition: "escalated" }),
    ep({ id: 2, disposition: "pending" }),
    ep({ id: 3, disposition: "answered" }),
    ep({ id: 4, disposition: "skipped" }),
  ];
  assert.equal(openEpisodeCount(rows), 2);
  assert.equal(openEpisodeCount(rows.filter((r) => r.disposition === "answered")), 0);
});
