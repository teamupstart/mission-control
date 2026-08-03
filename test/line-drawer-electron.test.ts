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
import { ReviewDrawer } from "../src/web/components/line/ReviewDrawer.tsx";
import { BacklogDrawer } from "../src/web/components/line/BacklogDrawer.tsx";
import type { BacklogPlan, Task } from "../src/shared/types.ts";
import type { WorkflowRunSummary } from "../src/shared/workflow.ts";
import { LADDER_SUMMARY } from "./helpers/workflow-ladder.ts";
import { mkTask } from "./helpers/session-fixture.ts";
import { assertElectronGuiLaunchAllowed } from "./helpers/electron-gui.ts";

/**
 * What an open drawer does to the fleet's height.
 *
 * Three promises this surface makes, and not one of them is checkable from markup:
 *
 *  1. **It is hard-capped and scrolls inside itself.** Three rows, or 38vh on a short window.
 *     A body that sized to its content would turn "twelve runs are live" into a page with no
 *     board on it - and the board is the thing being triaged FOR. `scrollHeight` past
 *     `clientHeight` is the only way to say "it scrolls"; a markup test sees a `<div>`.
 *  2. **The board moves down by the drawer and no more.** `.app-console` is a `height: 100dvh`
 *     flex column whose comment says outright that it does not scroll, so a drawer that was
 *     not `flex: none` above a `flex: 1` body would push the shell past the window with no
 *     scrollbar to get it back - the reply box would simply be off the screen.
 *  3. **Cards never resize.** The plan's third decision, in as many words. `.card.expanded`
 *     is `calc(100dvh - var(--topbar-h) - ...)`, and `--topbar-h` is MEASURED off the topbar
 *     at runtime - so the way this breaks is by putting the drawer somewhere that changes
 *     that measurement, which is invisible until a card is a line shorter than it was.
 *
 * And one that is a fact about the row rather than the panel: a row is the SAME height
 * whatever it is saying. Three rows is a cap you can state only if a row is one height.
 *
 * createElement, not JSX, because the runner's glob only matches .test.ts.
 */

const require = createRequire(import.meta.url);

/** Same backstop the other geometry tests use: a hung browser fails, slowly. */
const ELECTRON_TIMEOUT_MS = 240_000;

/**
 * The cap, as used height, in a 900px window.
 *
 * `min(38vh, 3 rows)` at 900px is 38vh = 342px against three 58px rows = 174px, so the ROW
 * budget binds here and the band is around it. A band rather than a number for the strip
 * test's reason: pinning an exact pixel would fail on a font metric nobody chose. What the
 * claim actually is - a panel you can see the board underneath - stops being true well
 * before it doubles.
 */
const BODY_CAP = { min: 150, max: 200 };

const run = (over: Partial<WorkflowRunSummary>): WorkflowRunSummary => ({
  ...LADDER_SUMMARY,
  ...over,
});

/** Twelve live runs, which is well past the cap and the point of the exercise. */
const MANY = Array.from({ length: 12 }, (_, i) =>
  run({
    id: `run-${i}`,
    noteKey: `session-${i}`,
    status: i === 3 ? "blocked" : "running",
    updatedAt: 1000 - i,
  }));

/** One row whose every field is far too long for the width it is given. */
const WORDY = [run({
  id: "wordy",
  noteKey: "a-session-name-nobody-would-choose-but-everybody-eventually-has",
  workflowName: "No-Mistakes Review With A Name Long Enough To Need Somewhere To Go",
  activePersonaNames: [
    "Test Evidence Auditor",
    "Documentation Steward",
    "Code Risk Reviewer",
    "Interface Consistency Reviewer",
  ],
  gate: "waiting_inspector",
  actionWait: "needs_operator",
})];

/**
 * A pile that folds, and ordinary rows beside it.
 *
 * Four blocked runs sharing a reason become ONE group bar, which is the geometry claim this
 * file is the only layer that can check: the drawer's cap is
 * `calc(var(--line-drawer-row-h) * 3)`, so a bar that laid out at any other height would stop
 * the cap landing on a row boundary. The names are deliberately far too long for the bar's
 * middle column, so "it clips rather than growing" is a claim with something behind it.
 */
const PILED = [
  ...Array.from({ length: 4 }, (_, i) =>
    run({
      id: `gone-${i}`,
      noteKey: `gone-${i}`,
      sessionName: `Improve Foreman Context And Table Scrolling, Attempt ${i} Of Several`,
      sessionId: null,
      status: "blocked",
      phase: "session_disappeared",
      activePersonaNames: [],
      updatedAt: 2000 - i,
    })),
  ...Array.from({ length: 2 }, (_, i) =>
    run({ id: `live-${i}`, noteKey: `live-${i}`, status: "running", updatedAt: 100 - i })),
];

const drawer = (runs: WorkflowRunSummary[]): string =>
  renderToStaticMarkup(createElement(ReviewDrawer, {
    runs,
    sessions: [],
    onClose: () => {},
    onOpenRun: () => {},
    onOpenAllRuns: () => {},
    onBindWorkflow: () => {},
    onOpenEnsemble: () => {},
  }));

/**
 * A backlog past the cap, with both bands and every row's fields far too long for them.
 *
 * The Backlog drawer is the one that uses the frame's FOOTER slot, and the footer sits
 * outside the capped body - a placement whose consequences are all used height: the rows keep
 * their full three-row budget, the footer is always reachable without scrolling to the bottom
 * of a list it is not part of, and the drawer as a whole is still a panel you can see the
 * board underneath. It also carries the two band headings, which are `position: sticky` inside
 * that same scrolling body.
 */
const QUEUE: Task[] = [
  ...Array.from({ length: 6 }, (_, i) =>
    mkTask({
      id: `ready-${i}`,
      title: `Persist review verdicts across daemon restarts, part ${i} of several`,
      kind: "ship",
      agent: "claude",
      createdAt: 1000 - i,
      updatedAt: 1000 - i,
    })),
  mkTask({
    id: "parked",
    title: "Migrate every setting to a per-repository scope, eventually",
    enabled: false,
    createdAt: 1,
    updatedAt: 1,
  }),
];

/** Plan order for the queue above, so the ready band is what the machine would take. */
const QUEUE_PLAN: BacklogPlan = {
  entries: QUEUE.map((task) => ({ taskId: task.id, dependsOn: [], reason: null })),
  note: null,
  generatedAt: 1000,
};

const backlogDrawer = (tasks: Task[]): string =>
  renderToStaticMarkup(createElement(BacklogDrawer, {
    tasks,
    backlogPlan: QUEUE_PLAN,
    now: 100_000,
    onClose: () => {},
    onEditTask: () => {},
    onOpenSitrep: () => {},
  }));

const strip = (): string =>
  renderToStaticMarkup(createElement(LineStrip, {
    summary: null,
    openStage: "review",
    onStage: () => {},
  }));

interface Measured {
  rows: number;
  footHeight: number | null;
  footInsideBody: boolean | null;
  drawerHeight: number | null;
  bodyClientHeight: number | null;
  bodyScrollHeight: number | null;
  rowHeights: number[];
  rowOverflows: number[];
  firstRowTop: number | null;
  shellBodyHeight: number | null;
  shellBodyTop: number | null;
  shellBodyBottomOverflow: number | null;
  cardHeight: number | null;
  cardWidth: number | null;
}

function page(styles: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><style>${styles}</style>${body}`;
}

/** A topbar stand-in of a realistic height - the strip test's, for the same reasons. */
const TOPBAR = `<header class="topbar" style="height:88px;flex:none"></header>`;

/** The console shell exactly as `App` composes it: header, strip, drawer, then the layout. */
const consoleShell = (drawerHtml: string): string =>
  `<div class="app app-console">${TOPBAR}${strip()}${drawerHtml}
     <div class="console"><div class="console-rail"></div><div class="console-detail"></div></div>
   </div>`;

/** The grid page, with the two measured properties set to the values `App` publishes. */
const gridShell = (drawerHtml: string): string =>
  `<div class="app" style="--topbar-h:88px;--cmdbar-clearance:64px">${TOPBAR}${strip()}${drawerHtml}
     <div class="card expanded" style="width:900px"><div class="card-panels"></div></div>
   </div>`;

let measured: Record<string, Measured>;

before(() => {
  assertElectronGuiLaunchAllowed();
  const electron = require("electron") as string;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const dir = mkdtempSync(join(tmpdir(), "mission-line-drawer-"));
  const userData = mkdtempSync(join(tmpdir(), "mission-line-drawer-profile-"));
  try {
    const styles = readFileSync(fileURLToPath(new URL("../src/web/styles.css", import.meta.url)), "utf8");
    const cases: Array<[string, string]> = [
      ["console-many", consoleShell(drawer(MANY))],
      ["console-two", consoleShell(drawer(MANY.slice(0, 2)))],
      ["console-wordy", consoleShell(drawer(WORDY))],
      ["console-piled", consoleShell(drawer(PILED))],
      ["console-backlog", consoleShell(backlogDrawer(QUEUE))],
      ["console-closed", consoleShell("")],
      ["grid-open", gridShell(drawer(MANY))],
      ["grid-closed", gridShell("")],
    ];
    const paths = cases.map(([name, body]) => {
      const path = join(dir, `${name}.html`);
      writeFileSync(path, page(styles, body));
      return path;
    });
    const output = execFileSync(electron, [
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      `--user-data-dir=${userData}`,
      fileURLToPath(new URL("fixtures/line-drawer-browser.cjs", import.meta.url)),
      "--pages",
      ...paths,
    ], { encoding: "utf8", env, timeout: ELECTRON_TIMEOUT_MS });
    measured = JSON.parse(output.trim()) as Record<string, Measured>;
  } finally {
    rmSync(dir, { force: true, recursive: true });
    rmSync(userData, { force: true, recursive: true });
  }
});

test("twelve runs make a drawer no taller than three, and it scrolls inside itself", () => {
  const m = measured["console-many"]!;
  assert.equal(m.rows, 12, "every live run is in the DOM; the cap is on the panel, not the list");
  assert.ok(
    m.bodyClientHeight !== null
      && m.bodyClientHeight >= BODY_CAP.min
      && m.bodyClientHeight <= BODY_CAP.max,
    `the body used ${m.bodyClientHeight}px, outside ${BODY_CAP.min}-${BODY_CAP.max}px`,
  );
  // The rows really are past the cap, so the assertion above is not passing on a short list.
  assert.ok(
    (m.bodyScrollHeight ?? 0) > (m.bodyClientHeight ?? 0) + 100,
    `nothing to scroll: ${m.bodyScrollHeight} content in ${m.bodyClientHeight} of box`,
  );
});

test("a drawer with less in it than the cap is shorter, not padded out to it", () => {
  // The cap is a ceiling and not a height. A panel that always took its full budget would
  // spend a third of the viewport saying "two runs are live".
  const two = measured["console-two"]!;
  const many = measured["console-many"]!;
  assert.equal(two.rows, 2);
  assert.ok(
    (two.bodyClientHeight ?? 0) < (many.bodyClientHeight ?? 0),
    `two rows took ${two.bodyClientHeight}px, the same as twelve`,
  );
  assert.equal(two.bodyScrollHeight, two.bodyClientHeight, "a short drawer must not scroll");
});

test("every row is one height, and a row too wide for its columns clips", () => {
  // Three rows is a number you can put in a design budget only if a row is one height.
  const heights = new Set(measured["console-many"]!.rowHeights);
  assert.equal(heights.size, 1, `rows laid out at ${[...heights].join(", ")}px`);
  const wordy = measured["console-wordy"]!;
  assert.deepEqual(
    [...new Set(wordy.rowHeights)],
    [...heights],
    "a row with a long name, four reviewers and four chips grew",
  );
  // And it really was too wide, so the assertion above is not passing on a short row.
  assert.ok(
    wordy.rowOverflows.every((overflow) => overflow > 0),
    `the wordy row should have clipped something, got ${wordy.rowOverflows.join(", ")}`,
  );
});

test("a group bar is exactly one row high, so the three-row cap still lands on a boundary", () => {
  // The load-bearing fact behind the whole fold. `.line-drawer-body` is capped at
  // `calc(var(--line-drawer-row-h) * 3)`, which is a number you can state only while every
  // child of `.line-drawer-rows` is that one height - a bar carrying the mockup's two-line
  // explanatory paragraph would leave half a row peeking over the edge of the cap. No
  // assertion on markup can see this; it is used height in a laid-out engine.
  const piled = measured["console-piled"]!;
  // Four blocked runs became one bar, and the two live runs stayed rows. That is 3 children,
  // and the bar sorts first because a stopped run outranks one that is merely running.
  assert.equal(piled.rows, 3, "the four blocked runs did not fold into one bar");
  const heights = new Set(piled.rowHeights);
  assert.equal(
    heights.size,
    1,
    `the bar and the rows laid out at ${[...heights].join(", ")}px`,
  );
  assert.deepEqual([...heights], [...new Set(measured["console-many"]!.rowHeights)]);
  // And the bar really was too wide for its columns, so the height above is not passing on a
  // bar with nothing in it: three long titles and a `+1` clip rather than wrapping to line two.
  assert.ok(
    piled.rowOverflows[0]! > 0,
    `the bar should have clipped its member titles, got ${piled.rowOverflows[0]}px`,
  );
  // A folded drawer is SHORTER than the cap, which is the point: six runs that used to be six
  // rows now fit with room to spare instead of scrolling.
  assert.equal(piled.bodyScrollHeight, piled.bodyClientHeight, "a folded drawer must not scroll");
});

test("the footer sits under the cap, not inside it, and costs the rows nothing", () => {
  const backlog = measured["console-backlog"]!;
  const many = measured["console-many"]!;
  // Seven queued items across two bands, every one of them in the DOM: the cap is on the
  // panel and never on the list, on this drawer as on the others.
  assert.equal(backlog.rows, 7, "the whole queue is in the DOM, capped only by the panel");

  // Outside the scrolling body. Inside it, the footer would be reachable only after scrolling
  // past a list it is not part of - which is the exact failure `.line-drawer-alert` is placed
  // above the body to avoid, arriving from the other end.
  assert.equal(backlog.footInsideBody, false, "the footer is inside the scrolling body");
  assert.ok((backlog.footHeight ?? 0) > 0, "the footer laid out at no height at all");

  // And it took nothing from the rows: the body still gets the same three-row budget the
  // footerless drawers get, so the queue does not show two and a half rows because a link
  // lives under it.
  assert.ok(
    backlog.bodyClientHeight !== null
      && backlog.bodyClientHeight >= BODY_CAP.min
      && backlog.bodyClientHeight <= BODY_CAP.max,
    `the body used ${backlog.bodyClientHeight}px, outside ${BODY_CAP.min}-${BODY_CAP.max}px`,
  );
  assert.ok(
    (backlog.bodyScrollHeight ?? 0) > (backlog.bodyClientHeight ?? 0),
    `nothing to scroll: ${backlog.bodyScrollHeight} content in ${backlog.bodyClientHeight} of box`,
  );

  // Rows are the shared height, headings and marks notwithstanding - the same 58px the cap is
  // stated in, so a queue's three rows and a run list's three rows are the same three rows.
  const heights = new Set(backlog.rowHeights);
  assert.equal(heights.size, 1, `backlog rows laid out at ${[...heights].join(", ")}px`);
  assert.deepEqual([...heights], [...new Set(many.rowHeights)]);
  // And the rows really were too wide, so the one-height claim is not passing on short rows.
  assert.ok(
    backlog.rowOverflows.some((overflow) => overflow > 0),
    `the long titles should have clipped, got ${backlog.rowOverflows.join(", ")}`,
  );

  // The whole panel, footer and both band headings included, is still a drawer you can see the
  // board underneath - which is the promise the cap exists to keep.
  assert.ok(
    (backlog.drawerHeight ?? 0) < (many.drawerHeight ?? 0) + 60,
    `the footer added ${(backlog.drawerHeight ?? 0) - (many.drawerHeight ?? 0)}px to the panel`,
  );
});

test("the board moves down by the drawer, and the shell still ends at the viewport", () => {
  const open = measured["console-many"]!;
  const closed = measured["console-closed"]!;
  assert.ok(open.shellBodyTop !== null && closed.shellBodyTop !== null);
  // Down by exactly the drawer's footprint. A drawer that was not `flex: none` would take a
  // different amount, and one that overlaid would take none at all.
  assert.equal(
    open.shellBodyTop! - closed.shellBodyTop!,
    open.drawerHeight,
    "the board did not move down by exactly the drawer's height",
  );
  // `.app-console` does not scroll: if the drawer had pushed the shell past 100dvh there
  // would be no scrollbar to recover the bottom of it, and the detail pane's pinned reply
  // box would be off the screen.
  assert.ok(
    open.shellBodyBottomOverflow !== null && open.shellBodyBottomOverflow <= 1,
    `the console body ended ${open.shellBodyBottomOverflow}px past the viewport`,
  );
  // And it is a real body, not a collapsed one - the drawer took its height out of the
  // layout, which is only meaningful if there is a layout left.
  assert.ok((open.shellBodyHeight ?? 0) > 400, `the console body collapsed to ${open.shellBodyHeight}px`);
});

test("a session card is the same card with the drawer open", () => {
  // The plan's third decision, in as many words: no data changes, no layout changes, no
  // resizing in any drawer state. `.card.expanded` sizes itself off the MEASURED `--topbar-h`,
  // so this breaks by putting the drawer somewhere that changes that measurement.
  const open = measured["grid-open"]!;
  const closed = measured["grid-closed"]!;
  assert.ok(open.cardHeight && closed.cardHeight, "both grid cases must measure a card");
  assert.equal(open.cardHeight, closed.cardHeight, "the drawer took height out of the card");
  assert.equal(open.cardWidth, closed.cardWidth, "the drawer took width off the card");
});
