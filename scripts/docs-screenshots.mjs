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
/** How much room a DETAIL figure leaves around the elements it frames. */
const CLIP_PADDING = 14;
const CAPABILITIES = "**/api/session-actions/capabilities";

/**
 * Leave the completion-capability read in flight, for as long as the frame takes.
 *
 * A handler that neither fulfils nor continues is precisely the state being documented: the
 * request has left and no answer has arrived. Every editor passes through it on open, but it
 * lasts one round trip against a loopback daemon, which is far too short to photograph.
 */
async function holdCapabilities(page) {
  await page.route(CAPABILITIES, () => {});
}

/**
 * Answer with the daemon's OWN capability list, less one adapter.
 *
 * The screen keeps a stored completion whose adapter the daemon cannot prove, and says so -
 * behaviour the wire contract exists for, since `available` and `unavailableReason` are
 * carried per adapter precisely so one build can decline what another runs. No build ships
 * declining one today, so the figure substitutes the answer rather than the renderer: the
 * daemon's real reply, with a single arm withdrawn and given the reason such a daemon would
 * send. Everything downstream of the fetch is the product.
 */
async function withdrawCapability(page, kind, reason) {
  await page.route(CAPABILITIES, async (route) => {
    const answered = await route.fetch();
    const body = await answered.json();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...body,
        completions: body.completions.map((completion) =>
          completion.kind === kind
            ? { ...completion, available: false, unavailableReason: reason }
            : completion),
      }),
    });
  });
}

/** The action whose contract both completion figures are of, deep-linked. */
const PULL_REQUEST_ACTION = "#/library/actions/builtin%3Apull-request";
/** The chips and the sentence they form - the subject of a contract detail figure. */
const CONTRACT_REGION = (page) => [
  page.locator("div.lib-props"),
  page.locator("p.wf-action-contract"),
];

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
    /*
     * The two states the screen above cannot show at rest, and the reason they are figures at
     * all: both are decided by one HTTP read the page makes as it mounts, so what an operator
     * sees is a claim about a fact that may not have arrived yet. Cropped to the contract
     * region, because the difference between this pair is four elements wide and reading it
     * across two full-page frames is what a reader would have to do otherwise.
     */
    name: "action-completion-pending",
    route: PULL_REQUEST_ACTION,
    before: (page) => holdCapabilities(page),
    ready: (page) => page.locator("p.wf-action-contract"),
    clip: CONTRACT_REGION,
    cleanup: (page) => page.unroute(CAPABILITIES),
  },
  {
    name: "action-completion-unprovable",
    route: PULL_REQUEST_ACTION,
    before: (page) => withdrawCapability(
      page,
      "pull_request",
      "This build cannot verify a pull request yet.",
    ),
    // The sentence beside the chip, which exists only once the answer is in and is a refusal.
    ready: (page) => page.locator("p.lib-props-note"),
    clip: CONTRACT_REGION,
    cleanup: (page) => page.unroute(CAPABILITIES),
  },
  {
    name: "foreman",
    route: "#/settings/foreman",
    ready: (page) => page.getByText("Foreman", { exact: true }).first(),
  },
  {
    name: "inspector",
    route: "#/settings/inspector",
    ready: (page) => page.getByText("Inspector", { exact: true }).first(),
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
 * The frame for a DETAIL figure: the union of the boxes it names, padded and kept on screen.
 *
 * A figure of one region rather than of the viewport, for the states whose whole subject is a
 * few elements. Measured after `ready`, so it frames the laid-out page rather than a guess.
 */
async function clipFor(page, shot) {
  if (!shot.clip) return null;
  const boxes = [];
  for (const locator of shot.clip(page)) {
    const box = await locator.boundingBox();
    if (!box) {
      throw new Error(`[docs:screenshots] ${shot.name}: an element the figure frames is not on the page`);
    }
    boxes.push(box);
  }
  const left = Math.max(0, Math.min(...boxes.map((box) => box.x)) - CLIP_PADDING);
  const top = Math.max(0, Math.min(...boxes.map((box) => box.y)) - CLIP_PADDING);
  const right = Math.min(
    VIEWPORT.width,
    Math.max(...boxes.map((box) => box.x + box.width)) + CLIP_PADDING,
  );
  const bottom = Math.min(
    VIEWPORT.height,
    Math.max(...boxes.map((box) => box.y + box.height)) + CLIP_PADDING,
  );
  return { x: left, y: top, width: right - left, height: bottom - top };
}

async function capture(page, baseURL, shot) {
  // Before the navigation, not after: a figure of what one request answered - or has not
  // answered yet - has to be set up before the page makes it.
  if (shot.before) await shot.before(page);
  await page.goto(`${baseURL}/${shot.route}`, { waitUntil: "domcontentloaded" });
  // And such a figure needs a real document load, which `goto` to the SAME hash is not: two
  // frames of one screen under different answers navigate to one URL, Chromium treats the
  // second as a same-document hash change, nothing re-mounts and no second request is made -
  // so the second frame silently photographs the first one's state.
  if (shot.before) await page.reload({ waitUntil: "domcontentloaded" });
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
  const clip = await clipFor(page, shot);
  await page.screenshot({
    path: join(OUTPUT_DIR, `${shot.name}.png`),
    fullPage: false,
    ...(clip ? { clip } : {}),
  });
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
