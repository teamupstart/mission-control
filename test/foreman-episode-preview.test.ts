import { test } from "node:test";
import assert from "node:assert/strict";
import type { ForemanEpisode } from "../src/shared/types.ts";
import { askPreview, openEpisodeCount } from "../src/web/components/ForemanDrawer.tsx";

// What a drawer row leads with.
//
// The row is how you find a past decision again, so it has to say what was being
// DECIDED. Every naive source for that is wrong on a terminal ask: the question field
// is a generic permission line, the option rows are the choices rather than the
// question, and the pane is mostly scrollback.

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

test("a permission prompt leads with the command, not the boilerplate", () => {
  // "Claude needs your permission to use Bash" is identical on every such row and
  // names nothing. The command underneath is the whole point.
  const preview = askPreview(
    ep({
      question: "Claude needs your permission to use Bash",
      pane: "Claude needs your permission to use Bash\n\n  rm -rf node_modules/.vite\n\n❯ 1. Yes\n  2. No",
      menu: { options: [{ number: 1, label: "Yes" }, { number: 2, label: "No" }], highlighted: 1 },
    }),
  );
  assert.equal(preview, "rm -rf node_modules/.vite");
});

test("a menu leads with the sentence above the options, not the options", () => {
  const preview = askPreview(
    ep({
      question: "Claude needs your permission to use AskUserQuestion",
      pane:
        "Claude needs your permission to use AskUserQuestion\n\n" +
        "  The migration can target Postgres or SQLite.\n  Which should I write against?\n\n" +
        "❯ 1. Postgres\n  2. SQLite\n  3. Let me decide later",
      menu: {
        options: [
          { number: 1, label: "Postgres" },
          { number: 2, label: "SQLite" },
          { number: 3, label: "Let me decide later" },
        ],
        highlighted: 1,
      },
    }),
  );
  assert.equal(preview, "The migration can target Postgres or SQLite. Which should I write against?");
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
