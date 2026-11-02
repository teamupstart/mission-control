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
import type { ResidentProfile, ResidentRunSummary } from "../src/shared/residents.ts";
import { assertElectronGuiLaunchAllowed } from "./helpers/electron-gui.ts";
import { mkSession, mkTaskSummary } from "./helpers/session-fixture.ts";

/**
 * Where the Residents dock lands, measured in a real browser against the real top bar.
 *
 * The dock is a floating panel hung off a button in the title bar, and the ways it goes wrong
 * are all used-geometry facts no markup assertion can see: it pushes the bar onto a second
 * row, it opens over its own button, it runs off the window's left or bottom edge on a
 * narrow window, or a long profile name widens it. Each page renders the REAL `Topbar` with
 * the dock open and the REAL stylesheet; the fixture only sets the window size.
 *
 * createElement, not JSX, because the runner's glob only matches .test.ts.
 */

// The same fake storage and accepting fetch `topbar-items.test.ts` installs before the web
// modules load: `uiConfig.ts` seeds itself from the cache at import.
const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
});

const { DEFAULT_TOPBAR_LAYOUT } = await import("../src/web/lib/topbar-items.ts");
const { PREVIEW_FOREMAN, PREVIEW_TOPBAR_FLEET, previewFleetCost } = await import(
  "../src/web/lib/topbar-preview.ts"
);
const { Topbar } = await import("../src/web/components/Topbar.tsx");
const { UI_CONFIG_DEFAULTS } = await import("../src/shared/protocol.ts");
const { ResidentProfileRevisionSchema } = await import("../src/shared/residents.ts");

const require = createRequire(import.meta.url);
const ELECTRON_TIMEOUT_MS = 240_000;
const FIXTURE_BUDGET_MS = ELECTRON_TIMEOUT_MS - 30_000;
const noop = (): void => {};

function settings(name: string, colorId: string) {
  return ResidentProfileRevisionSchema.parse({
    identity: { name },
    persona: { personaId: "builtin:fleet-triage" },
    workspace: { defaultRepoRoot: "/work/mission-control" },
    board: { colorId },
  });
}

function profile(id: string, name: string, colorId: string): ResidentProfile {
  return { id, name, revision: 1, archivedAt: null, createdAt: 1, updatedAt: 1, settings: settings(name, colorId) };
}

function run(taskId: string, p: ResidentProfile): ResidentRunSummary {
  return {
    id: `run-${taskId}`,
    profileId: p.id,
    profileRevision: 1,
    taskId,
    launchState: "launched",
    personaName: "Fleet Triage",
    compaction: { betweenIterations: true, nativeBackstop: false },
    loopState: "waiting" as const, iteration: 1, lastSeq: 1, nextWakeAt: null, consumedGeneration: null, pauseReason: null, wakeReason: null,
    settings: p.settings,
    createdAt: 1,
  };
}

const LONG_NAME = "Release Watch for the Whole Monorepo and Every Downstream Consumer";

function bar(profiles: ResidentProfile[]): string {
  const runs = [run("t1", profiles[0]!), run("t2", profiles[1]!)];
  const sessions = runs.map((r) => mkSession({ id: `s-${r.taskId}`, state: "idle", task: mkTaskSummary({ id: r.taskId, kind: "resident" }) }));
  return renderToStaticMarkup(
    createElement(Topbar, {
      layout: DEFAULT_TOPBAR_LAYOUT,
      page: "fleet",
      onNavigatePage: noop,
      filter: "",
      onFilterChange: noop,
      connected: true,
      keepAwake: null,
      ...PREVIEW_TOPBAR_FLEET,
      onOpenInbox: noop,
      fleetCost: previewFleetCost(Date.now()),
      costView: "usd",
      onOpenCostSettings: noop,
      scheduleAttentionCount: 0,
      onOpenMissions: noop,
      foreman: PREVIEW_FOREMAN,
      onOpenModels: noop,
      onOpenForemanSettings: noop,
      residents: {
        runs,
        profiles,
        sessions,
        defaultOpen: true,
        onOpenSession: noop,
        onOpenLaunch: noop,
        onManage: noop,
      },
      onOpenDispatch: noop,
      onOpenFeedback: noop,
      gearDot: null,
      gearPhrase: null,
      onGear: noop,
      alertSettings: UI_CONFIG_DEFAULTS.alerts,
      updateAlerts: noop,
      away: null,
      setAway: async () => {},
      buffered: null,
    }),
  );
}

const PROFILES = [
  profile("p1", "Triage Bot", "cyan"),
  profile("p2", "Docs Gardener", "violet"),
  profile("p3", "Release Watch", "amber"),
];
const LONG_PROFILES = [PROFILES[0]!, PROFILES[1]!, profile("p3", LONG_NAME, "amber")];

/**
 * Each case: a window size and the rungs `fitTopbar` would have applied at it. The ladder is
 * measured JavaScript the static page does not run, so the rung is stated; `topbar-one-row`
 * in `e2e/` is what drives the real fit with the dock in the bar, and owns the contract that
 * the bar never stacks while it still has a rung to shed.
 *
 * `tight` is past that point on purpose. On this, the busiest preview fleet, every rung spent
 * holds one row down to about 1040px with the dock's button (about 980px before it: one more
 * control's glyph and count). Below that the bar may stack, and the claim left to make there
 * is the one this file owns - the panel still opens inside the window.
 */
const VIEWPORTS = {
  wide: { width: 1400, height: 900, rung: "1 2 3 4", oneRow: true },
  narrow: { width: 1100, height: 560, rung: "1 2 3 4 5", oneRow: true },
  tight: { width: 900, height: 520, rung: "1 2 3 4 5", oneRow: false },
  // The narrowest window Settings > Worktrees is checked at. The dock's button made the
  // action cluster wider than this bar, and the page scrolled sideways until the cluster
  // was allowed to wrap its groups.
  phone: { width: 390, height: 844, rung: "1 2 3 4 5", oneRow: false },
} as const;

interface Rect { top: number; right: number; bottom: number; left: number; width: number; height: number }
interface Measured {
  barRows: number;
  bar: Rect;
  foreman: Rect;
  button: Rect;
  panel: Rect | null;
  panelPosition: string | null;
  rows: number;
  pageOverflowX: number;
  viewport: { width: number; height: number };
}

const measured: Record<string, Measured> = {};

function page(styles: string, rung: string, markup: string): string {
  const header = markup.replace('<header class="topbar"', `<header class="topbar" data-rung="${rung}"`);
  // `--topbar-h` published from the laid-out bar, as App's `fitTopbar` does: the narrow dock
  // is positioned from it.
  const publish = `<script>document.documentElement.style.setProperty("--topbar-h", document.querySelector("header.topbar").offsetHeight + "px")</script>`;
  return `<!doctype html><meta charset="utf-8"><style>${styles}</style><div class="app app-console">${header}</div>${publish}`;
}

before(() => {
  assertElectronGuiLaunchAllowed();
  const electron = require("electron") as string;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const styles = readFileSync(fileURLToPath(new URL("../src/web/styles.css", import.meta.url)), "utf8");
  for (const [size, viewport] of Object.entries(VIEWPORTS)) {
    const dir = mkdtempSync(join(tmpdir(), "mission-residents-dock-"));
    const userData = mkdtempSync(join(tmpdir(), "mission-residents-dock-profile-"));
    try {
      const paths = [
        ["dock", bar(PROFILES)],
        ["long", bar(LONG_PROFILES)],
      ].map(([name, markup]) => {
        const path = join(dir, `${size}-${name}.html`);
        writeFileSync(path, page(styles, viewport.rung, markup!));
        return path;
      });
      const output = execFileSync(electron, [
        ...(process.platform === "linux" ? ["--no-sandbox"] : []),
        `--user-data-dir=${userData}`,
        fileURLToPath(new URL("fixtures/residents-dock-browser.cjs", import.meta.url)),
        "--viewport",
        `${viewport.width}x${viewport.height}`,
        "--budget-ms",
        String(FIXTURE_BUDGET_MS),
        "--pages",
        ...paths,
      ], { encoding: "utf8", env, timeout: ELECTRON_TIMEOUT_MS });
      Object.assign(measured, JSON.parse(output.trim()) as Record<string, Measured>);
    } finally {
      rmSync(dir, { force: true, recursive: true });
      rmSync(userData, { force: true, recursive: true });
    }
  }
});

function at(name: string, size: keyof typeof VIEWPORTS): Measured {
  const m = measured[name];
  assert.ok(m, `the fixture measured no case called ${name}`);
  const want = VIEWPORTS[size];
  assert.equal(`${m.viewport.width}x${m.viewport.height}`, `${want.width}x${want.height}`, `${name} was measured in the wrong window`);
  assert.ok(m.panel, `${name}: the dock panel did not render`);
  return m;
}

const CASES = (Object.keys(VIEWPORTS) as Array<keyof typeof VIEWPORTS>).flatMap((size) =>
  ["dock", "long"].map((name) => [`${size}-${name}`, size] as const));

test("the bar stays one row with the Residents button in it, immediately after Foreman", () => {
  for (const [name, size] of CASES) {
    const m = at(name, size);
    if (VIEWPORTS[size].oneRow) assert.equal(m.barRows, 1, `${name}: the bar wrapped onto a second row`);
    if (!VIEWPORTS[size].oneRow) continue;
    assert.ok(m.button.left >= m.foreman.right - 0.5, `${name}: the button is not after Foreman`);
    assert.ok(m.button.left - m.foreman.right < 16, `${name}: the button drifted away from Foreman`);
  }
});

test("the open dock floats under its button without moving the bar", () => {
  for (const [name, size] of CASES) {
    const m = at(name, size);
    if (size === "phone") {
      // Too narrow to hang off its button: it spans the window directly under the whole bar.
      assert.equal(m.panelPosition, "fixed", `${name}: the narrow dock is still anchored to its button`);
      assert.ok(m.panel!.top >= m.bar.bottom - 0.5, `${name}: the panel opens over the bar`);
      assert.ok(m.panel!.top - m.bar.bottom <= 12, `${name}: the panel hangs ${m.panel!.top - m.bar.bottom}px below the bar`);
    } else {
      assert.equal(m.panelPosition, "absolute", `${name}: the panel is in flow and would push the bar`);
      assert.ok(m.panel!.top >= m.button.bottom, `${name}: the panel opens over its own button`);
      assert.ok(m.panel!.top - m.button.bottom <= 12, `${name}: the panel hangs ${m.panel!.top - m.button.bottom}px below its button`);
    }
    assert.equal(m.rows, 5, `${name}: two live residents and three profiles should be five rows`);
  }
});

test("the dock stays inside the window at its left, right and bottom edges", () => {
  for (const [name, size] of CASES) {
    const m = at(name, size);
    assert.ok(m.panel!.left >= 0, `${name}: the panel runs ${-m.panel!.left}px off the window's left edge`);
    assert.ok(m.panel!.right <= m.viewport.width, `${name}: the panel runs off the right edge`);
    assert.ok(m.panel!.bottom <= m.viewport.height, `${name}: the panel runs ${m.panel!.bottom - m.viewport.height}px off the bottom`);
  }
});

test("the bar with the Residents button never makes the page scroll sideways", () => {
  for (const [name, size] of CASES) {
    const m = at(name, size);
    assert.equal(m.pageOverflowX, 0, `${name}: the page overflows ${m.pageOverflowX}px sideways`);
  }
});

test("a long profile name ellipsizes rather than widening the dock", () => {
  for (const size of Object.keys(VIEWPORTS) as Array<keyof typeof VIEWPORTS>) {
    const plain = at(`${size}-dock`, size);
    const long = at(`${size}-long`, size);
    assert.equal(Math.round(long.panel!.width), Math.round(plain.panel!.width), `${size}: the long name widened the dock`);
  }
});
