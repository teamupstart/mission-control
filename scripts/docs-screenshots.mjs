#!/usr/bin/env node
/**
 * Regenerate the README's committed dashboard imagery from a fully isolated demo.
 *
 * The demo's local scenario players replace every agent binary, so this script drives the real
 * built daemon and dashboard without using model tokens. Its dedicated root is rebuilt and
 * removed for each run, which keeps an operator's normal demo and Mission Control state intact.
 */
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

import {
  prepareStateRoot,
  resetDocsScreenshotRoot,
} from "./demo/launch.mjs";
import { seedDemoFleet, waitFor } from "./demo/seed.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUTPUT_DIR = join(REPO_ROOT, "docs/images");
const VIEWPORT = { width: 1440, height: 900 };
const FROZEN_MOTION = `
  *, *::before, *::after {
    animation: none !important;
    transition: none !important;
    caret-color: transparent !important;
  }
`;
/**
 * The update snapshot `update-available.png` is a picture of.
 *
 * Shaped as the `available` arm of `UpdateSnapshot` in `src/shared/update.ts`. It is data, not
 * prose: every word the banner prints comes from `src/shared/update-copy.ts` by way of the real
 * component, so this cannot put a sentence on screen that the shipped app would not.
 */
const AVAILABLE_UPDATE = {
  phase: "available",
  currentVersion: "1.16.1",
  newVersion: "1.17.0",
  releaseTag: "v1.17.0",
  releaseName: "v1.17.0",
  releaseNotes:
    "Durable OTLP capture, export and a local Grafana stack. Setup now reports cmux socket "
    + "control and the Herdr server as separate facts from the binaries themselves.",
  publishedAt: "2026-09-14T00:00:00.000Z",
  // On the same day as `publishedAt` and after it. A check that predates the release it found
  // is a state the real updater cannot reach, and a fixture nobody can construct is a bad
  // fixture even where nothing renders it - the banner shows only the version and the notes.
  checkedAt: 1_789_376_400_000,
  lastOutcome: null,
};

/**
 * A stand-in for the Electron preload bridge, as source to run before the bundle loads.
 *
 * Returned as a STRING rather than a function so it can be handed to `addInitScript` without
 * closing over anything in this module: the page evaluates it in its own world, where nothing
 * from here exists. Every member the renderer calls unguarded is present - `onOpenSettings` is
 * reached through `window.missionDesktop?.onOpenSettings(...)`, so a bridge without it throws
 * inside a mount effect and takes the dashboard down instead of drawing a banner.
 */
function desktopUpdateBridgeScript(snapshot) {
  return `window.missionDesktop = {
    isDesktop: true,
    version: async () => ${JSON.stringify(snapshot.currentVersion)},
    openExternal: async () => {},
    installIntegrations: async () => ({ ok: true, message: "" }),
    removeIntegrations: async () => ({ ok: true, message: "" }),
    onOpenSettings: () => () => {},
    updates: {
      getState: async () => (${JSON.stringify(snapshot)}),
      check: async () => (${JSON.stringify(snapshot)}),
      apply: async () => true,
      install: async () => true,
      cancel: async () => {},
      defer: async () => {},
      onState: () => () => {},
    },
  };`;
}

const SCREENSHOTS = [
  {
    name: "fleet-board",
    route: "#/fleet",
    needsFleet: true,
    ready: (page) => page.getByRole("button", { name: "Dispatch" }),
  },
  {
    name: "dispatch",
    route: "#/fleet",
    ready: (page) => page.getByRole("dialog", { name: "Dispatch an agent" }),
    prepare: async (page) => {
      await page.getByRole("button", { name: "Dispatch" }).click();
    },
    cleanup: async (page) => {
      // Press until the dialog is actually gone, rather than once.
      //
      // Escape is PROGRESSIVE inside the guided pass: `DispatchModal`'s `guidedRepoEscaped`
      // spends the first press ending the pass, and only the second reaches `Overlay` and
      // closes the dialog. A single press therefore left the modal up and this cleanup timed
      // out after 30s, which failed the whole run at the second frame - `npm run docs:screenshots`
      // has not completed since the guided pass shipped. Counting to two would fix today and
      // break on the next rung, so this waits on the dialog instead.
      const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
      for (let attempt = 0; attempt < 4 && (await dialog.isVisible()); attempt += 1) {
        await page.keyboard.press("Escape");
        await page.waitForTimeout(120);
      }
      await dialog.waitFor({ state: "hidden" });
    },
  },
  {
    name: "library",
    route: "#/library",
    ready: (page) => page.getByRole("heading", { name: "Library", exact: true }),
  },
  {
    name: "workflows",
    route: "#/library/workflows",
    ready: (page) => page.getByRole("heading", { name: "Workflows", exact: true }),
  },
  {
    // The Action detail screen, which `docs/library-and-line.md` describes in prose and which
    // is the one Library surface whose subject is a CONTRACT rather than a document: the two
    // property chips and the sentence they form are what the figure is of. It opens on the
    // shipped Pull Request action, so the frame needs no seeding of its own.
    name: "action-detail",
    route: "#/library/actions",
    ready: (page) => page.locator("p.wf-action-contract"),
  },
  {
    name: "foreman",
    route: "#/settings/foreman",
    ready: (page) => page.getByText("Foreman", { exact: true }).first(),
  },
  {
    name: "inspector",
    route: "#/settings/inspector",
    // The card heading, not a bare `getByText("Inspector")`: the panel's own copy says
    // "GitHub Inspector" everywhere and nothing on the page is ever exactly "Inspector", so
    // that predicate could only ever have matched by accident.
    ready: (page) =>
      page.getByRole("heading", { name: "GitHub Inspector", exact: true, level: 2 }),
  },
  {
    // The first-run reminder, over the board rather than on its own: what it interrupts is
    // half of what it is. This is the ONE frame that has to be taken before the run retires
    // the first-run chrome, which is why `dismissSetupBanner` is a separate step from
    // `disableGuidedTour` - a single `retireFirstRunChrome` had already dismissed this by the
    // time any browser existed.
    name: "first-run-reminder",
    route: "#/fleet",
    needsFleet: true,
    beforeBannerDismissal: true,
    ready: (page) => page.getByRole("status", { name: /machine setup/i }),
  },
  {
    // Settings > Setup, as the panel opens: the machine-wide verdict, the family rail, and
    // the rows of whichever family the daemon decided to open on. The setup guide's first
    // figure, and the reason it is captured rather than described - the verdict sentence and
    // the rail's per-family ready counts are the two things an operator reads before they
    // touch anything, and neither survives being retold in prose.
    name: "setup-panel",
    route: "#/settings/setup",
    ready: (page) => page.getByRole("navigation", { name: "Setup families" }),
    prepare: async (page) => {
      // Never inherit the opening family. It is derived from where THIS machine's gaps are,
      // so a capture that did not choose would document the capturing laptop rather than the
      // panel - the same trap `e2e/fixtures/setup-panel.ts` names for specs.
      await openSetupFamily(page, "agents", "Agent CLIs");
    },
  },
  {
    // The two REQUIRED rows, one satisfied and one not, which is the pair the setup guide's
    // required-versus-optional section is about. Deterministic for the same reason the frame
    // is worth taking: `gh` is found at a machine-wide location, and the disposable state root
    // carries no github.com login, so the second row is always the unsatisfied one.
    //
    // Terminals is deliberately NOT captured. Every row in it is discovered on the CAPTURING
    // machine, and a terminal installed under a home directory prints that home directory into
    // a committed figure - which is what one capture here did. `docs/setup-guide.html` covers
    // that family in prose instead.
    name: "setup-github",
    route: "#/settings/setup",
    ready: (page) => page.locator("#setup-pane"),
    prepare: async (page) => {
      await openSetupFamily(page, "github", "GitHub");
    },
  },
  {
    // Settings > Trust, with rows in it. An empty matrix is the true first-run state and says
    // only "no repositories yet", which teaches nothing about the thing the guide sends people
    // here for: that adding a repository grants NOTHING, and each cell is one deliberate click.
    // So the frame is staged through the panel's own add row and grant buttons, which is the
    // same path a person takes and therefore cannot drift from it.
    name: "settings-trust",
    route: "#/settings/trust",
    ready: (page) => page.getByRole("table", { name: "Repository trust grants" }),
    prepare: async (page, context) => {
      for (const repo of context.repos) {
        await page.getByPlaceholder("search repos or type a path").fill(repo);
        await page.getByRole("button", { name: "Add", exact: true }).click();
        await page.getByRole("button", { name: trustCell("Grant", "Foreman", repo) })
          .waitFor({ state: "visible" });
      }
      // One repository trusted with the two local-blast-radius grants, one with none. The
      // contrast is the lesson the guide sends people here for: a row can exist and still
      // allow nothing, because adding is configuration and enabling is consent.
      const [first] = context.repos;
      for (const column of ["Foreman", "Workflows"]) {
        await page.getByRole("button", { name: trustCell("Grant", column, first) }).click();
        await page.getByRole("button", { name: trustCell("Revoke", column, first) })
          .waitFor({ state: "visible" });
      }
    },
  },
  {
    // The update banner, which no browser can reach on its own: it is drawn only when the
    // Electron preload publishes `window.missionDesktop.updates`, and a plain dashboard has no
    // update bridge at all. So the bridge is faked and the REAL component renders the real
    // copy from `src/shared/update-copy.ts` against the real stylesheet. Nothing here invents
    // a sentence; the snapshot is the input the shell would hand it.
    //
    // Its own browser context, because `addInitScript` outlives the page it was added for and
    // a leaked `missionDesktop` would silently redraw every later frame as a desktop one.
    name: "update-available",
    route: "#/fleet",
    needsFleet: true,
    init: () => desktopUpdateBridgeScript(AVAILABLE_UPDATE),
    ready: (page) => page.getByRole("status", { name: "Mission Control update" }),
  },
  {
    // Settings > Models, framed on Foreman's grid rather than on the top of the page.
    // The figure's subject is the per-role provider and model rows - what the README calls
    // the answer to "what is this app spending, and on whose account?" - and the top of the
    // page is the app-wide picker and the background jobs, which it is not about.
    name: "models",
    route: "#/settings/models",
    ready: (page) => page.getByRole("combobox", { name: "Foreman Review provider" }),
    prepare: async (page) => {
      await page.locator('[data-anchor="models/foreman"]').scrollIntoViewIfNeeded();
    },
  },
];

function requestedScreenshots(argv) {
  const onlyAt = argv.indexOf("--only");
  if (onlyAt < 0) return SCREENSHOTS;
  const raw = argv[onlyAt + 1];
  if (!raw) throw new Error("--only needs a comma-separated list of screenshot names");
  const names = new Set(raw.split(",").filter(Boolean));
  const selected = SCREENSHOTS.filter((shot) => names.has(shot.name));
  if (selected.length !== names.size) {
    const known = new Set(selected.map((shot) => shot.name));
    throw new Error(`unknown screenshot name: ${[...names].filter((name) => !known.has(name)).join(", ")}`);
  }
  return selected;
}

async function freeLoopbackPort() {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close(() => reject(new Error("could not choose a loopback port for documentation captures")));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

/**
 * One Trust grant cell's accessible name.
 *
 * The cell is labelled with the column's TITLE and not its header label - "Foreman sends
 * live", not "Foreman" - so the column name is matched as a prefix and the descriptive tail is
 * left free. That tail is prose about what the grant permits and is expected to be reworded;
 * the frame should not need recapturing when it is.
 */
function trustCell(action, column, repo) {
  return new RegExp(`^${action}: ${column}\\b.* for .*/${basename(repo)}$`);
}

/**
 * Select one Setup family and wait for its pane to be the one showing.
 *
 * `e2e/fixtures/setup-panel.ts` does the same for specs and is not imported here: this
 * script runs under plain Node with no TypeScript loader. The rail item's accessible name is
 * "<label>: N of M ready", or the bare label while its rows are still loading, so the
 * predicate accepts either - and the wait is on `aria-current`, not on the click, because the
 * pane the frame is of is the thing that has to have changed.
 */
async function openSetupFamily(page, family, label) {
  await page.getByRole("button", { name: new RegExp(`^${label}(:|$)`) }).click();
  await page.locator(`#setup-family-${family}[aria-current="true"]`).waitFor({ state: "attached" });
}

async function capture(page, baseURL, shot, context = { repos: [] }) {
  await page.goto(`${baseURL}/${shot.route}`, { waitUntil: "domcontentloaded" });
  // A README image is a still, not a timing-dependent animation frame. The dashboard already
  // honours reduced motion; this additionally freezes the few decorative effects that remain
  // active there, including a blinking attention badge, before taking the stable frame.
  await page.addStyleTag({ content: FROZEN_MOTION });
  if (shot.prepare) await shot.prepare(page, context);
  await shot.ready(page).waitFor({ state: "visible" });
  // Route changes leave the pointer over the top-bar Dispatch control in Chromium. Move it to
  // unused chrome before each frame so the capture documents the page, not its hover tooltip.
  await page.mouse.move(8, VIEWPORT.height - 8);
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(OUTPUT_DIR, `${shot.name}.png`), fullPage: false });
  console.log(`[docs:screenshots] captured ${shot.name}.png`);
  if (shot.cleanup) await shot.cleanup(page);
}

async function putJson(url, body) {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`[docs:screenshots] PUT ${url} answered ${res.status}: ${await res.text()}`);
  }
}

/**
 * Retire the first-run chrome, in two steps rather than one.
 *
 * These captures run against a state root this script rebuilds every time, so the profile is
 * always brand new - and a brand new profile auto-starts the `See the work` tour over whatever
 * route was asked for, and raises the machine-setup reminder above the dashboard. A tour card
 * centred on the fleet hides the one thing `fleet-board.png` exists to show.
 *
 * Both are retired through the routes their own controls call, rather than dismissed in the
 * browser or hidden in CSS: the tour flag is consumed when a tour starts, so a browser-side
 * exit races the frame it was meant to clear, and the reminder's dismissal is bound to the
 * exact attention set of the observation it came from.
 *
 * They are SEPARATE because the reminder is itself a documented surface. It is the first thing
 * a new operator sees and the guide has a figure of it, so the tour goes before any browser
 * exists and the reminder goes only after the frames that are of it.
 */
async function disableGuidedTour(baseURL) {
  await putJson(`${baseURL}/api/ui/config`, { guidedTour: false });
}

async function dismissSetupBanner(baseURL) {
  const checks = await (await fetch(`${baseURL}/api/setup/checks`)).json();
  if (!checks?.banner?.visible) return;
  await putJson(`${baseURL}/api/setup/checks`, {
    snapshotToken: checks.snapshotToken,
    acknowledged: checks.banner.attentionRowIds,
  });
}

/**
 * One capture in its own throwaway context.
 *
 * Used for a shot that injects a page init script, because `addInitScript` outlives the page
 * it was added for, and for the pre-dismissal frames, which are taken before the shared
 * context exists at all.
 */
async function captureIsolated(browser, baseURL, shot, runContext) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    reducedMotion: "reduce",
  });
  try {
    const page = await context.newPage();
    if (shot.init) await page.addInitScript(shot.init());
    await capture(page, baseURL, shot, runContext);
  } finally {
    await context.close();
  }
}

async function main() {
  const screenshots = requestedScreenshots(process.argv.slice(2));
  const needsFleet = screenshots.some((shot) => shot.needsFleet === true);
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const root = resetDocsScreenshotRoot();
  const port = await freeLoopbackPort();
  let daemon;
  let browser;
  try {
    const { repos } = prepareStateRoot(root);
    console.log("[docs:screenshots] seeding the deterministic demo fleet");
    const seeded = await seedDemoFleet({
      root,
      port,
      ...(needsFleet ? { readme: true } : { capture: true }),
      keepDaemonAlive: true,
      log: (line) => console.log(`[docs:screenshots] ${line}`),
    });
    daemon = seeded.daemon;
    if (needsFleet) {
      await waitFor(
        "the seeded fleet to restore",
        async () => {
          const sessions = await (await fetch(`${daemon.baseURL}/api/sessions`)).json();
          return Array.isArray(sessions) && sessions.length > 0;
        },
        { timeoutMs: 60_000 },
      );
    }

    await disableGuidedTour(daemon.baseURL);

    const runContext = { repos };
    browser = await chromium.launch();

    // The reminder's own frames first, while it is still raised, then the dismissal, then
    // everything else. Ordering is by this flag rather than by position in `SCREENSHOTS`, so
    // a `--only` naming one of each still gets both.
    for (const shot of screenshots.filter((s) => s.beforeBannerDismissal)) {
      await captureIsolated(browser, daemon.baseURL, shot, runContext);
    }
    await dismissSetupBanner(daemon.baseURL);

    const rest = screenshots.filter((s) => !s.beforeBannerDismissal);
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, reducedMotion: "reduce" });
    const page = await context.newPage();
    for (const shot of rest) {
      if (shot.init) await captureIsolated(browser, daemon.baseURL, shot, runContext);
      else await capture(page, daemon.baseURL, shot, runContext);
    }
    await context.close();
  } finally {
    await browser?.close();
    await daemon?.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Exported for `test/docs-screenshots.test.ts`, which walks the registry rather than running
 * it: a capture needs a build, a daemon and a browser, so what a unit test can hold is the
 * shape of the list and the selection rules around it.
 */
export {
  SCREENSHOTS,
  requestedScreenshots,
  openSetupFamily,
  trustCell,
  desktopUpdateBridgeScript,
  AVAILABLE_UPDATE,
  OUTPUT_DIR,
};

// Importing this module must not start a demo daemon. Same guard as `scripts/demo/launch.mjs`.
const isMain = import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
