import { before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LineStrip } from "../src/web/components/LineStrip.tsx";
import type { LineStageSummary, LineSummary } from "../src/shared/line.ts";
import { assertElectronGuiLaunchAllowed } from "./helpers/electron-gui.ts";

/**
 * What the Line strip does to the fleet's height.
 *
 * A permanent strip above the session layouts is a geometry change, and the two ways it
 * goes wrong are both invisible to a markup assertion:
 *
 *  1. It eats the viewport. `.app-console` and `.app-board` are `height: 100dvh` flex
 *     columns whose comment says outright that they do not scroll. If the strip is not
 *     `flex: none` above a `flex: 1` body, the shell grows past the window and the detail
 *     pane's pinned reply box goes off the bottom of the screen - with no scrollbar to get
 *     it back, because the shell is the thing that does not scroll.
 *  2. It eats the expanded card. `.card.expanded` is
 *     `calc(100dvh - var(--topbar-h) - var(--cmdbar-clearance) - 28px)`, and `--topbar-h`
 *     is MEASURED off `<header class="topbar">` at runtime. Putting the strip inside that
 *     header - which is the obvious place, since the topbar is already the page's chrome -
 *     would silently take ~90px off every focus-expanded card on the grid, a surface with
 *     nothing to do with the Line. The strip is deliberately a sibling of the header, and
 *     the grid case here is what holds it there.
 *
 * And one that is only a fact about used height: the strip must be the SAME height whatever
 * it is saying. It sits directly above the board, so a stage whose sentence wrapped, or
 * whose sentence was empty, would move every card on the page.
 *
 * createElement, not JSX, because the runner's glob only matches .test.ts.
 */

const require = createRequire(import.meta.url);

/** Same backstop the other geometry tests use: a hung browser fails, slowly. */
const ELECTRON_TIMEOUT_MS = 240_000;

/**
 * The strip's design budget, as used height including the space it reserves beneath it.
 *
 * A band rather than a number: the phase calls for "~90px", and pinning an exact pixel
 * would fail on a font metric nobody chose. The band is what the claim actually is - a
 * strip you can read at a glance and never scroll to, which stops being true well before
 * it doubles.
 */
const HEIGHT_BUDGET = { min: 70, max: 110 };

const stage = (over: Partial<LineStageSummary> & { stage: LineStageSummary["stage"] }): LineStageSummary => ({
  count: 0,
  sentence: "",
  tone: "neutral",
  ...over,
});

const FULL: LineSummary = {
  stages: [
    stage({ stage: "intake", count: 2, sentence: "github-issues swept 4m ago · next mission in 3h", tone: "idle" }),
    stage({ stage: "backlog", count: 4, sentence: "next up: Fix pane focus stealing", tone: "idle" }),
    stage({ stage: "working", count: 5, sentence: "1 needs you · 4 working", tone: "attention" }),
    stage({ stage: "review", count: 5, sentence: "No-Mistakes Review v8 ×4 · 1 waiting on you", tone: "attention" }),
    stage({ stage: "decide", count: 1, sentence: "Best of N · waiting on you", tone: "attention" }),
    stage({ stage: "shipped", count: 3, sentence: "this week · ≈$4.05 per PR today", tone: "idle" }),
  ],
};

/** The sentence a real fleet eventually produces: a long workflow name and a long title. */
const LONG: LineSummary = {
  stages: FULL.stages.map((s) =>
    stage({
      ...s,
      sentence:
        "next up: Rework the transcript attribution window so a Codex rollout that is " +
        "99.7% tool output still resolves its session identity on restart",
    }),
  ),
};

const strip = (summary: LineSummary | null): string =>
  renderToStaticMarkup(createElement(LineStrip, { summary, onStage: () => {} }));

/**
 * A topbar stand-in of a realistic height.
 *
 * Deliberately NOT the real topbar markup: the header is ~120 lines of controls whose own
 * height is pinned by `topbar-ladder.test.ts`, and nothing here is a claim about it. What
 * these cases are about is the relationship between three boxes - header, strip, body - and
 * a fixed-height stand-in states the header's part of that relationship exactly.
 */
const TOPBAR = `<header class="topbar" style="height:88px;flex:none"></header>`;

interface Measured {
  lineHeight: number;
  lineBoxHeight: number;
  stages: number;
  bodyBottomOverflow: number | null;
  bodyHeight: number | null;
  cardHeight: number | null;
  subHeights: number[];
  subOverflows: number[];
}

function page(styles: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><style>${styles}</style>${body}`;
}

/** The console shell exactly as `App` composes it: header, strip, then the layout. */
const consoleShell = (summary: LineSummary | null): string =>
  `<div class="app app-console">${TOPBAR}${strip(summary)}
     <div class="console"><div class="console-rail"></div><div class="console-detail"></div></div>
   </div>`;

/**
 * The grid page, with the two measured properties set to the values `App` publishes.
 *
 * They are set on `:root` here because the JavaScript that measures them lives in `App`,
 * which is not running - but the numbers are its numbers, and the whole point of the case
 * is that the strip must not change either of them.
 */
const gridShell = (summary: LineSummary | null): string =>
  `<div class="app" style="--topbar-h:88px;--cmdbar-clearance:64px">${TOPBAR}${strip(summary)}
     <div class="card expanded" style="width:900px"><div class="card-panels"></div></div>
   </div>`;

let measured: Record<string, Measured>;

before(() => {
  assertElectronGuiLaunchAllowed();
  const electron = require("electron") as string;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const dir = mkdtempSync(join(tmpdir(), "mission-line-strip-"));
  const userData = mkdtempSync(join(tmpdir(), "mission-line-strip-profile-"));
  try {
    const styles = readFileSync(fileURLToPath(new URL("../src/web/styles.css", import.meta.url)), "utf8");
    const cases: Array<[string, string]> = [
      ["console", consoleShell(FULL)],
      ["console-empty", consoleShell(null)],
      ["console-long", consoleShell(LONG)],
      ["grid", gridShell(FULL)],
      ["grid-without-strip", `<div class="app" style="--topbar-h:88px;--cmdbar-clearance:64px">${TOPBAR}
         <nav class="line"></nav>
         <div class="card expanded" style="width:900px"><div class="card-panels"></div></div>
       </div>`],
    ];
    const paths = cases.map(([name, body]) => {
      const path = join(dir, `${name}.html`);
      writeFileSync(path, page(styles, body));
      return path;
    });
    const output = execFileSync(electron, [
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      `--user-data-dir=${userData}`,
      fileURLToPath(new URL("fixtures/line-strip-browser.cjs", import.meta.url)),
      "--pages",
      ...paths,
    ], { encoding: "utf8", env, timeout: ELECTRON_TIMEOUT_MS });
    measured = JSON.parse(output.trim()) as Record<string, Measured>;
  } finally {
    rmSync(dir, { force: true, recursive: true });
    rmSync(userData, { force: true, recursive: true });
  }
});

test("the strip is about ninety pixels, which is the whole point of it", () => {
  const m = measured["console"]!;
  assert.equal(m.stages, 6);
  assert.ok(
    m.lineHeight >= HEIGHT_BUDGET.min && m.lineHeight <= HEIGHT_BUDGET.max,
    `the strip used ${m.lineHeight}px, outside ${HEIGHT_BUDGET.min}-${HEIGHT_BUDGET.max}px`,
  );
});

test("a full-height shell still ends at the viewport, so the reply box stays reachable", () => {
  // `.app-console` does not scroll. If the strip pushed the shell past 100dvh there would
  // be no scrollbar to recover the bottom of it - the detail pane's reply box would simply
  // be off the screen.
  const m = measured["console"]!;
  assert.ok(
    m.bodyBottomOverflow !== null && m.bodyBottomOverflow <= 1,
    `the console body ended ${m.bodyBottomOverflow}px past the viewport`,
  );
  // And it is a real body, not a collapsed one - the strip took its height out of the
  // layout, which is only meaningful if there is a layout left.
  assert.ok((m.bodyHeight ?? 0) > 600, `the console body collapsed to ${m.bodyHeight}px`);
});

test("the expanded card's height is the strip's business to stay out of", () => {
  // The regression this exists to catch: putting the strip inside `<header class="topbar">`
  // grows the measured `--topbar-h` and silently shortens every focus-expanded card on the
  // grid. Same page, same tokens, with and without a populated strip - the card must not
  // notice.
  const withStrip = measured["grid"]!.cardHeight;
  const without = measured["grid-without-strip"]!.cardHeight;
  assert.ok(withStrip && without, "both grid cases must measure a card");
  assert.equal(withStrip, without, "the strip took height out of the expanded card");
});

test("the strip is the same height whatever it is saying", () => {
  // It sits directly above the board. A stage that grew a line when a workflow name got
  // long - or lost one when a stage went quiet - would move every card on the page.
  const full = measured["console"]!.lineBoxHeight;
  assert.equal(measured["console-empty"]!.lineBoxHeight, full, "an empty strip shrank");
  assert.equal(measured["console-long"]!.lineBoxHeight, full, "a wordy strip grew");
});

test("a sentence too long for its stage is clipped, not wrapped", () => {
  const long = measured["console-long"]!;
  const lines = new Set(long.subHeights);
  assert.equal(lines.size, 1, `sentences laid out at ${[...lines].join(", ")}px - one wrapped`);
  // And it really was too long, so the assertion above is not passing on a short string.
  assert.ok(
    long.subOverflows.every((overflow) => overflow > 0),
    `every stage's sentence should have overflowed, got ${long.subOverflows.join(", ")}`,
  );
});
