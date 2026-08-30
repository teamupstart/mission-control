import { mkdirSync } from "node:fs";

import type { Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import { expect, test } from "../fixtures/test.ts";

const EVIDENCE = artifactsDir("boot-loading-screen");

/**
 * The Fleet page's "the snapshot has not arrived yet" state.
 *
 * Before this existed, `sessions.length === 0` alone decided whether the page said "No agent
 * sessions detected" - true whether the daemon has confirmed zero sessions or simply has not
 * answered yet. On a cold daemon or a slow disk that ambiguity can sit on screen long enough
 * to read as the fleet genuinely having nothing, or as the app having failed to start - worse
 * than blank, because it is confidently wrong. This mirrors the distinction the Library
 * shelves already draw through `workflowCommandFact` ("Not configured" vs the daemon simply
 * not having answered yet), extended to the page that reads `hasSnapshot` first: the Fleet
 * page, which is where every session lands on arrival.
 */
const waiting = (page: Page) => page.getByRole("status", { name: "Loading sessions" });

/** Capture what a reviewer cannot get from `1 passed`: behind `MC_E2E_EVIDENCE`, per this
 * suite's standing rule, so an ordinary run writes nothing. */
async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/boot-loading-screen/${name}.png`);
}

test("a slow first snapshot on the fleet page says so, rather than claiming no sessions", async ({
  dashboard,
}) => {
  // Hold the stream open forever rather than dropping it: a daemon that never answers
  // `/events` and one that answers late look identical to the browser, and this is the more
  // honest of the two to reproduce, since `hasSnapshot` never having been true yet is exactly
  // the case this state exists for.
  await dashboard.route("**/events", (route) => route.abort());
  // A RELOAD, not a hash navigation. The EventSource opened before this route was installed
  // would otherwise survive it with its snapshot already in hand, and the window this test
  // exists to hold open would never occur.
  await dashboard.reload();

  await expect(waiting(dashboard)).toBeVisible();
  await expect(waiting(dashboard)).toContainText("Waiting for the daemon");
  await expect(dashboard.getByText("No agent sessions detected")).toBeHidden();
  // The shell around it is unaffected - this replaces one block inside the Fleet page, not
  // the page itself. An operator can still read the topbar and reach every other page while
  // this one is waiting on its own data.
  await expect(dashboard.getByRole("button", { name: "Dispatch" })).toBeVisible();
  await shoot(dashboard, "waiting-for-daemon");

  // Let the stream through. The browser's own EventSource reconnect brings the snapshot in
  // with no further action from the page, and the daemon's honest answer for a fresh install
  // - zero sessions - takes over from the "still arriving" state.
  await dashboard.unroute("**/events");
  await expect(waiting(dashboard)).toBeHidden({ timeout: 30_000 });
  await expect(dashboard.getByText("No agent sessions detected")).toBeVisible();
});
