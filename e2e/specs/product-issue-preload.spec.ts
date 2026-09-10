import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { buildSync } from "esbuild";
import { expect, test } from "../fixtures/test.ts";
import { writeProductAuthorizationScript } from "../fixtures/fake-agents.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { startDevDashboard } from "../fixtures/dev-dashboard.ts";

test.skip(process.platform !== "darwin", "the real sandboxed desktop fixture requires the macOS GUI");

test("a real desktop Report click still publishes after the feedback module hot updates", async ({ daemon }) => {
  writeFileSync(daemon.ghProductPath, JSON.stringify({ preflight: "ok", issueCreate: "created" }));
  writeProductAuthorizationScript(daemon.home, { answer: "grant" });
  const dev = await startDevDashboard(daemon);
  try {
    const authorizationModule = join(daemon.home, "product-issue-authorization.cjs");
    buildSync({
      entryPoints: ["src/main/product-issue-authorization.ts"],
      outfile: authorizationModule,
      bundle: true,
      platform: "node",
      format: "cjs",
    });
    const application = await electron.launch({
      args: [
        fileURLToPath(new URL("../fixtures/desktop-product-issue.cjs", import.meta.url)),
        `${dev.origin}/#/fleet`,
        authorizationModule,
      ],
    });
    try {
      const page = await application.firstWindow();
      await page.getByRole("button", { name: "Report product feedback" }).click();
      const dialog = page.getByRole("dialog", { name: "Report product feedback" });
      await dialog.getByRole("textbox", { name: "Title", exact: true }).fill("Test");
      await dialog.getByRole("textbox", { name: "Details", exact: true }).fill("Test issue, do nothing.");
      await expectContentClearsBorder(dialog);
      const updated = page.waitForEvent("console", {
        predicate: (message) => message.text().includes("hot updated: /components/ProductIssueModal.tsx"),
      });
      const now = new Date();
      // Touch only the timestamp: exercise Vite's real React refresh without editing source.
      utimesSync(join(process.cwd(), "src/web/components/ProductIssueModal.tsx"), now, now);
      await updated;
      await expect(dialog.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Test");
      await expect(dialog.getByRole("textbox", { name: "Details", exact: true }))
        .toHaveValue("Test issue, do nothing.");
      await dialog.getByRole("button", { name: "Report publicly" }).click();
      await expect(dialog.getByRole("link", { name: "View GitHub issue" })).toBeVisible();
      if (process.env.MC_E2E_EVIDENCE === "1") {
        const dir = join(process.cwd(), "e2e/.artifacts/report-publicly");
        mkdirSync(dir, { recursive: true });
        await page.mouse.move(1, 1);
        await dialog.screenshot({ path: join(dir, "desktop-reported.png") });
      }
    } finally {
      await application.close();
    }
  } finally {
    dev.stop();
  }
});
