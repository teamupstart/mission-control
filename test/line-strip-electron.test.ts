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
import type { LineDensity } from "../src/shared/protocol.ts";
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
 * The condensed strip's budget, on the same terms: a band rather than a number, because
 * pinning 38.5px would fail on a font metric nobody chose.
 *
 * Its own constant rather than a widening of the one above. The claim being made is that
 * these are two DENSITIES with two budgets, and a single 30-110px band would have been
 * satisfied by a condensed strip that quietly drew at expanded's height - which is exactly
 * the regression this file exists to catch.
 */
const CONDENSED_BUDGET = { min: 28, max: 52 };

/**
 * The least the fold must be worth to be worth having.
 *
 * Measured at 47.5px (86 -> 38.5) in Chromium at 1512x900; asserted as a floor rather than
 * an equality for the budgets' reason, and because this window is 1400x900 rather than the
 * one the plan measured. A fold that saved 10px would pass every other test in this file
 * and be pointless, which no assertion on either budget alone can say.
 */
const MIN_FOLD_SAVING = 35;

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

const strip = (summary: LineSummary | null, density: LineDensity = "expanded"): string =>
  renderToStaticMarkup(createElement(LineStrip, { summary, density, onStage: () => {} }));

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
const consoleShell = (summary: LineSummary | null, density: LineDensity = "expanded"): string =>
  `<div class="app app-console">${TOPBAR}${strip(summary, density)}
     <div class="console"><div class="console-rail"></div><div class="console-detail"></div></div>
   </div>`;

const CASES: Array<[string, string]> = [
  ["console", consoleShell(FULL)],
  ["console-empty", consoleShell(null)],
  ["console-long", consoleShell(LONG)],
  // The shipped default, and the three states again. A case per density rather than a
  // widened budget: 70-110px is the claim for EXPANDED and stays that, and a band that can
  // be either would assert nothing about either.
  ["condensed", consoleShell(FULL, "condensed")],
  ["condensed-empty", consoleShell(null, "condensed")],
  ["condensed-long", consoleShell(LONG, "condensed")],
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

// ---- the fold, as used height ----
//
// A density is a claim about a BAND, and a band is the one thing a markup assertion cannot
// see. `line-strip-render.test.ts` pins that condensed drops the sentences and keeps the
// stages; only a laid-out window can say whether that bought anything.

test("the condensed strip is about forty pixels, which is what the fold is for", () => {
  const m = at("condensed");
  // Still all six. A fold that dropped a stage would shrink the band and pass a height
  // assertion on its own.
  assert.equal(m.stages, 6);
  assert.ok(
    m.lineHeight >= CONDENSED_BUDGET.min && m.lineHeight <= CONDENSED_BUDGET.max,
    `the condensed strip used ${m.lineHeight}px, outside ${CONDENSED_BUDGET.min}-${CONDENSED_BUDGET.max}px`,
  );
});

test("condensing hands the conversation the height it took, and it is worth having", () => {
  // The two facts that make this feature real, stated against each other rather than
  // against a constant: the band shrank, and the pane below grew by what the band lost.
  const expanded = at("console");
  const condensed = at("condensed");
  const saved = expanded.lineHeight - condensed.lineHeight;
  assert.ok(
    saved >= MIN_FOLD_SAVING,
    `condensing freed only ${saved}px (${expanded.lineHeight} -> ${condensed.lineHeight}), `
      + `which is under the ${MIN_FOLD_SAVING}px that makes the control worth its own setting`,
  );
  // `.app-console` is `height: 100dvh` and does not scroll, so every pixel the strip gives
  // up has to arrive here. If it does not, something else in the shell absorbed it and the
  // operator got a shorter strip for nothing.
  //
  // Within a pixel, NOT exactly equal, and the difference is the whole correctness of this
  // assertion. The fixture `Math.round()`s every measurement independently
  // (`test/fixtures/line-strip-browser.cjs`), and the real condensed band is 38.5px - so
  // `lineHeight` rounds to 39 while the body's own height rounds from a different fractional
  // part, and the two disagree by 1 depending only on where each landed. `assert.equal` here
  // therefore asserted that two roundings of one 47.5px number got lucky together: it passed
  // on macOS and failed on Linux CI with "the strip gave up 47px but the conversation gained
  // 48px", which says nothing about the layout.
  //
  // The tolerance costs nothing this case was defending. The failure it exists to catch is
  // the space being absorbed somewhere else in the shell, and that shows up as a discrepancy
  // the size of the whole band - tens of pixels - never as one.
  const gained = (condensed.bodyHeight ?? 0) - (expanded.bodyHeight ?? 0);
  assert.ok(
    Math.abs(gained - saved) <= 1,
    `the strip gave up ${saved}px but the conversation gained ${gained}px - the space went `
      + `somewhere other than the pane below it`,
  );
});

test("the condensed strip is the same height whatever it is saying", () => {
  // The expanded invariant, restated for the density that has no `ls-sub` to reserve a
  // line for. What holds it now is the urgent readout's `nowrap` and its ellipsis - and a
  // readout that wrapped would grow this band on exactly the busy fleet where the strip
  // matters most, which is the failure this case is here for.
  const full = at("condensed").lineBoxHeight;
  assert.equal(at("condensed-empty").lineBoxHeight, full, "an empty condensed strip shrank");
  assert.equal(at("condensed-long").lineBoxHeight, full, "a wordy condensed strip grew");
});

test("a condensed shell still ends at the viewport, so the reply box stays reachable", () => {
  // Same promise the expanded shell makes, and not inherited from it: condensed adds two
  // flex items to the nav (the readout and the caret) that expanded does not have, and
  // either could have pushed the shell past 100dvh.
  const m = at("condensed");
  assert.ok(
    m.bodyBottomOverflow !== null && m.bodyBottomOverflow <= 1,
    `the condensed console body ended ${m.bodyBottomOverflow}px past the viewport`,
  );
  assert.ok((m.bodyHeight ?? 0) > 600, `the condensed console body collapsed to ${m.bodyHeight}px`);
});
