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
 *  2. It changes the topbar measurement. The strip is deliberately a sibling of the header,
 *     so the topbar and fleet body keep separate height budgets.
 *
 * And one that is only a fact about used height: the strip must be the SAME height whatever
 * it is saying. It sits directly above the board, so a stage whose sentence wrapped, or
 * whose sentence was empty, would move every fleet surface on the page.
 *
 * Every one of those is a comparison between pages that were loaded into the same window in
 * turn, which makes the window's size a premise rather than a detail - see `VIEWPORT` and
 * `at` below, and the note at the top of `fixtures/measuring-window.cjs`.
 *
 * createElement, not JSX, because the runner's glob only matches .test.ts.
 */

const require = createRequire(import.meta.url);

/** Same backstop the other geometry tests use: a hung browser fails, slowly. */
const ELECTRON_TIMEOUT_MS = 240_000;

/**
 * What the fixture gets of that, leaving the rest for launch and exit.
 *
 * Being killed by the timeout above is the one failure the fixture cannot explain - the test
 * gets "Command failed", naming no page and no call. So the fixture is handed a budget that
 * expires first, and spends what it has left saying which page it was on.
 *
 * A budget rather than a smaller per-call ceiling, because the fixture retries per PAGE: any
 * claim that a ceiling "leaves enough headroom" is really a claim about how many cases this
 * file has today, and it stops being true the moment somebody adds a sixth. This does not
 * care.
 */
const FIXTURE_BUDGET_MS = ELECTRON_TIMEOUT_MS - 30_000;

/**
 * The strip's design budget, as used height including the space it reserves beneath it.
 *
 * A band rather than a number: the phase calls for "~90px", and pinning an exact pixel
 * would fail on a font metric nobody chose. The band is what the claim actually is - a
 * strip you can read at a glance and never scroll to, which stops being true well before
 * it doubles.
 */
const HEIGHT_BUDGET = { min: 70, max: 110 };

/**
 * The window every number below is read in.
 *
 * The full-height Console cases are compared with each other, which says something about
 * the strip only while all were measured in the same window.
 *
 * So the size is stated here, handed to the fixture, and checked per case on the way back by
 * `at`. CI has already produced the failure that motivates it: `720 !== 693`, which is a
 * 900px window and an 873px one, reported as the strip stealing 27px from a layout it never
 * touched.
 */
const VIEWPORT = { width: 1400, height: 900 };

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
    stage({ stage: "review", count: 5, sentence: "No-Mistakes Review v8 ×4 · 1 needs you · 3 stalled", tone: "attention" }),
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
  subHeights: number[];
  subOverflows: number[];
  /** The viewport this case's rects were laid out in, read beside them. */
  viewport: { width: number; height: number };
}

function page(styles: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><style>${styles}</style>${body}`;
}

/** The console shell exactly as `App` composes it: header, strip, then the layout. */
const consoleShell = (summary: LineSummary | null): string =>
  `<div class="app app-console">${TOPBAR}${strip(summary)}
     <div class="console"><div class="console-rail"></div><div class="console-detail"></div></div>
   </div>`;

const CASES: Array<[string, string]> = [
  ["console", consoleShell(FULL)],
  ["console-empty", consoleShell(null)],
  ["console-long", consoleShell(LONG)],
];

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
    const paths = CASES.map(([name, body]) => {
      const path = join(dir, `${name}.html`);
      writeFileSync(path, page(styles, body));
      return path;
    });
    const output = execFileSync(electron, [
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      `--user-data-dir=${userData}`,
      fileURLToPath(new URL("fixtures/line-strip-browser.cjs", import.meta.url)),
      "--viewport",
      `${VIEWPORT.width}x${VIEWPORT.height}`,
      "--budget-ms",
      String(FIXTURE_BUDGET_MS),
      // Last, because it takes the rest of the line.
      "--pages",
      ...paths,
    ], { encoding: "utf8", env, timeout: ELECTRON_TIMEOUT_MS });
    measured = JSON.parse(output.trim()) as Record<string, Measured>;
  } finally {
    rmSync(dir, { force: true, recursive: true });
    rmSync(userData, { force: true, recursive: true });
  }
});

/**
 * A case's numbers, refused unless they were measured in the window that was asked for.
 *
 * Every assertion in this file goes through here, so a window that changed size can only
 * ever be reported as a window that changed size. It is the difference between the two
 * sentences CI can print about the same event: "the strip took height out of the layout",
 * which sends somebody to `LineStrip.tsx` and `styles.css` looking for a bug that is not
 * there, and "console-without-strip was measured in a 1400x873 window", which is true.
 */
function at(name: string): Measured {
  const m = measured[name];
  assert.ok(m, `the fixture measured no case called ${name}`);
  const got = `${m.viewport.width}x${m.viewport.height}`;
  const want = `${VIEWPORT.width}x${VIEWPORT.height}`;
  assert.equal(
    got,
    want,
    `${name} was measured in a ${got} window, not the ${want} it asked for - these numbers `
      + `describe the window, not the layout, and every 100dvh box in them is out by the `
      + `difference`,
  );
  return m;
}

test("every case is measured in the window the fixture asked for", () => {
  // Stated on its own, and not only as a precondition of the cases below, because it is the
  // one failure here that is about the harness rather than about the product. A viewport
  // that wobbled is a fact about the machine: reported, it costs one line to read; folded
  // into a `100dvh` height, it arrives as a geometry regression in a component that did
  // nothing, and the browser-level spec that covers the same invariant stays green while
  // this file insists otherwise.
  for (const [name] of CASES) at(name);
});

test("the strip is about ninety pixels, which is the whole point of it", () => {
  const m = at("console");
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
  const m = at("console");
  assert.ok(
    m.bodyBottomOverflow !== null && m.bodyBottomOverflow <= 1,
    `the console body ended ${m.bodyBottomOverflow}px past the viewport`,
  );
  // And it is a real body, not a collapsed one - the strip took its height out of the
  // layout, which is only meaningful if there is a layout left.
  assert.ok((m.bodyHeight ?? 0) > 600, `the console body collapsed to ${m.bodyHeight}px`);
});

test("the strip is the same height whatever it is saying", () => {
  // It sits directly above the board. A stage that grew a line when a workflow name got
  // long - or lost one when a stage went quiet - would move every fleet surface on the page.
  const full = at("console").lineBoxHeight;
  assert.equal(at("console-empty").lineBoxHeight, full, "an empty strip shrank");
  assert.equal(at("console-long").lineBoxHeight, full, "a wordy strip grew");
});

test("a sentence too long for its stage is clipped, not wrapped", () => {
  const long = at("console-long");
  const lines = new Set(long.subHeights);
  assert.equal(lines.size, 1, `sentences laid out at ${[...lines].join(", ")}px - one wrapped`);
  // And it really was too long, so the assertion above is not passing on a short string.
  assert.ok(
    long.subOverflows.every((overflow) => overflow > 0),
    `every stage's sentence should have overflowed, got ${long.subOverflows.join(", ")}`,
  );
});
