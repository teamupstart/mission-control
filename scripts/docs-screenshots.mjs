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
import { join } from "node:path";
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
const SCREENSHOTS = [
  {
    name: "fleet-board",
    route: "#/fleet",
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
      await page.keyboard.press("Escape");
      await page.getByRole("dialog", { name: "Dispatch an agent" }).waitFor({ state: "hidden" });
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

async function capture(page, baseURL, shot) {
  await page.goto(`${baseURL}/${shot.route}`, { waitUntil: "domcontentloaded" });
  // A README image is a still, not a timing-dependent animation frame. The dashboard already
  // honours reduced motion; this additionally freezes the few decorative effects that remain
  // active there, including a blinking attention badge, before taking the stable frame.
  await page.addStyleTag({ content: FROZEN_MOTION });
  if (shot.prepare) await shot.prepare(page);
  await shot.ready(page).waitFor({ state: "visible" });
  // Route changes leave the pointer over the top-bar Dispatch control in Chromium. Move it to
  // unused chrome before each frame so the capture documents the page, not its hover tooltip.
  await page.mouse.move(8, VIEWPORT.height - 8);
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(OUTPUT_DIR, `${shot.name}.png`), fullPage: false });
  console.log(`[docs:screenshots] captured ${shot.name}.png`);
  if (shot.cleanup) await shot.cleanup(page);
}

async function main() {
  const screenshots = requestedScreenshots(process.argv.slice(2));
  const needsFleet = screenshots.some((shot) => shot.name === "fleet-board");
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const root = resetDocsScreenshotRoot();
  const port = await freeLoopbackPort();
  let daemon;
  let browser;
  try {
    prepareStateRoot(root);
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

    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, reducedMotion: "reduce" });
    const page = await context.newPage();
    for (const shot of screenshots) await capture(page, daemon.baseURL, shot);
    await context.close();
  } finally {
    await browser?.close();
    await daemon?.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
