import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

import { expect, test } from "../fixtures/test.ts";

test.skip(process.platform !== "darwin", "the managed desktop updater is macOS-only");

test("the sandboxed desktop preload carries update progress into the dashboard", async ({ daemon }) => {
  const application = await electron.launch({
    args: [
      fileURLToPath(new URL("../fixtures/desktop-update-preload.cjs", import.meta.url)),
      `${daemon.baseURL}/#/fleet`,
    ],
  });
  try {
    const dashboard = await application.firstWindow();
    const status = dashboard.getByRole("status", { name: "Mission Control update" });
    const progress = dashboard.getByRole("progressbar", {
      name: "Preparing Mission Control 1.9.1",
    });

    await expect(status).toContainText("Building the new version");
    await expect(progress).toBeVisible();
    await expect(progress).toHaveAttribute("aria-valuenow", "55");

    if (process.env.MC_E2E_EVIDENCE === "1") {
      const evidenceDir = join(process.cwd(), "e2e/.artifacts/update-preload");
      await mkdir(evidenceDir, { recursive: true });
      await dashboard.screenshot({
        path: join(evidenceDir, "sandboxed-preload-progress.png"),
        fullPage: true,
      });
    }
  } finally {
    await application.close();
  }
});
