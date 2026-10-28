import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { snapshotWebBuild } from "../fixtures/web-build.ts";
import { expect, test } from "../fixtures/test.ts";

test("a rebuild cannot remove JavaScript from a dashboard already being loaded", async ({page, daemon}) => {
  const source = join(daemon.home, "mutable-web-output");
  cpSync(process.env.MC_E2E_WEB_SNAPSHOT ?? resolve("dist/web"), source, {recursive: true});
  const frozen = snapshotWebBuild(source);
  const baseline = process.env.MC_E2E_REPRO_LIVE_WEB === "1";
  let replaced = false;
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  try {
    await daemon.crash();
    await daemon.restart({MISSION_WEB_DIR: baseline ? source : frozen.directory});
    await page.route("**/assets/*.js", async (route) => {
      // Same ordering as Vite's emptyOutDir: HTML was received, its module request
      // is in flight, and the next build removes the previous generation's assets.
      if (!replaced) { replaced = true; rmSync(join(source, "assets"), {recursive: true, force: true}); }
      await route.continue();
    });
    await page.goto(`${daemon.baseURL}/#/fleet`);
    expect(replaced).toBe(true);
    console.log(JSON.stringify({boundary: "real daemon and browser, private mutable build output", baseline, errors}));
    if (process.env.MC_E2E_EVIDENCE) {
      mkdirSync("e2e/.artifacts/update-relaunch", {recursive: true});
      await page.screenshot({path: `e2e/.artifacts/update-relaunch/build-isolation-${baseline ? "before" : "after"}.png`});
    }
    await expect(page.getByRole("button", {name: "Dispatch", exact: true})).toBeVisible({timeout: 5000});
    expect(errors).toEqual([]);
  } finally {
    await page.unrouteAll({behavior: "wait"});
    frozen.dispose();
  }
});
