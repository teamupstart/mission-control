import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LINE_DOCK_STAGES, LineStageDock, LineStrip } from "../src/web/components/LineStrip.tsx";
import { type LineStageSummary, type LineSummary } from "../src/shared/line.ts";
import { lineStageHasDrawer } from "../src/web/lib/line-targets.ts";

// The Console's stage dock: the Line's drawer stages, carried by the rail while the Line is
// switched off. The browser spec proves a press opens the drawer; this pins what the markup
// says, which is the half a person reading the page cannot see - that the dock offers exactly
// the stages that open a drawer, and that each button says what the strip's button says.
//
// createElement, not JSX, because the runner's glob only matches .test.ts.

const stage = (over: Partial<LineStageSummary> & { stage: LineStageSummary["stage"] }): LineStageSummary => ({
  count: 0,
  sentence: "",
  tone: "neutral",
  ...over,
});

const full: LineSummary = {
  stages: [
    stage({ stage: "intake", count: 2, sentence: "github-issues swept 4m ago", tone: "idle" }),
    stage({ stage: "backlog", count: 4, sentence: "next up: Fix pane focus stealing", tone: "idle" }),
    stage({ stage: "working", count: 5, sentence: "1 needs you · 4 working", tone: "attention" }),
    stage({ stage: "review", count: 5, sentence: "No-Mistakes Review v8 ×4", tone: "working" }),
    stage({ stage: "decide", count: 1, sentence: "Best of N · waiting on you", tone: "attention" }),
    stage({ stage: "shipped", count: 3, sentence: "this week · ≈$4.05 per PR today", tone: "idle" }),
  ],
};

const dock = (
  summary: LineSummary | null,
  over: { openStage?: LineStageSummary["stage"] | null; orientation?: "row" | "column" } = {},
): string =>
  renderToStaticMarkup(createElement(LineStageDock, {
    summary,
    openStage: over.openStage ?? null,
    onStage: () => {},
    orientation: over.orientation,
  }));

const labels = (html: string): string[] =>
  [...html.matchAll(/<button[^>]*aria-label="([^"]*)"/g)].map((m) => m[1]!);

test("the dock carries every stage that opens a drawer, and only those", () => {
  // Read off the target table, so a stage retargeted away from a drawer leaves with it.
  assert.deepEqual(LINE_DOCK_STAGES, ["intake", "backlog", "review", "decide", "shipped"]);
  assert.ok(LINE_DOCK_STAGES.every(lineStageHasDrawer));
  const names = labels(dock(full)).map((label) => label.split(",")[0]);
  // Working is the rail the dock sits in: a button for it would clear a filter, not open a panel.
  assert.deepEqual(names, ["Intake", "Backlog", "Review", "Decide", "Shipped"]);
});

test("each button's name and tooltip are the strip's own, so the two doors say one thing", () => {
  const strip = renderToStaticMarkup(createElement(LineStrip, { summary: full, onStage: () => {} }));
  const html = dock(full);
  for (const label of labels(html)) assert.ok(strip.includes(`aria-label="${label}"`), label);
  assert.match(html, /aria-label="Backlog, 4 tasks waiting - next up: Fix pane focus stealing"/);
  assert.match(html, /role="group" aria-label="Line drawers"/);
});

test("the open stage is expanded and points at the drawer; the rest are collapsed", () => {
  const html = dock(full, { openStage: "backlog" });
  assert.match(
    html,
    /class="line-dock-stage tone-idle is-open" aria-label="Backlog,[^"]*" aria-expanded="true" aria-controls="line-drawer"/,
  );
  assert.equal((html.match(/aria-expanded="false"/g) ?? []).length, 4);
  assert.equal((html.match(/aria-controls=/g) ?? []).length, 1);
  assert.equal((dock(full).match(/aria-expanded="false"/g) ?? []).length, 5);
});

test("a stage keeps its tone, so an amber stage is still amber with the Line off", () => {
  const html = dock(full);
  assert.match(html, /class="line-dock-stage tone-attention" aria-label="Decide,/);
  assert.match(html, /class="line-dock-stage tone-working" aria-label="Review,/);
});

test("the row draws each stage's name; the folded strip's column has room for glyph and count only", () => {
  assert.equal((dock(full).match(/class="ld-name"/g) ?? []).length, 5);
  const column = dock(full, { orientation: "column" });
  assert.match(column, /class="line-dock is-column"/);
  assert.doesNotMatch(column, /ld-name/);
  // The name the column cannot print is still the first word of every accessible name.
  assert.deepEqual(labels(column).map((label) => label.split(",")[0]), ["Intake", "Backlog", "Review", "Decide", "Shipped"]);
});

test("before the first summary lands, every stage still draws, at zero", () => {
  const html = dock(null);
  assert.equal(labels(html).length, 5);
  assert.match(html, /aria-label="Backlog, 0 tasks waiting"/);
});
