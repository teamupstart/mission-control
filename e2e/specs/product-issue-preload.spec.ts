import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { buildSync } from "esbuild";
import { expect, test } from "../fixtures/test.ts";
import { writeProductAuthorizationScript } from "../fixtures/fake-agents.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { startDevDashboard } from "../fixtures/dev-dashboard.ts";
import { observeReactRefresh } from "../fixtures/react-refresh.ts";
import { recordsIn } from "../fixtures/records.ts";

test.skip(process.platform !== "darwin", "the real sandboxed desktop fixture requires the macOS GUI");

for (const surface of ["packaged dashboard", "hot-updated dashboard", "packaged dashboard after a held press"] as const) {
  test(`a real desktop Report click publishes from the ${surface}`, async ({ daemon }) => {
    writeFileSync(daemon.ghProductPath, JSON.stringify({ preflight: "ok", issueCreate: "created" }));
    writeProductAuthorizationScript(daemon.home, { answer: "grant" });
    const dev = surface === "hot-updated dashboard" ? await startDevDashboard(daemon) : null;
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
          `${dev?.origin ?? daemon.baseURL}/#/fleet`,
          authorizationModule,
        ],
      });
      try {
        const page = await application.firstWindow();
        await page.getByRole("button", { name: "Report product feedback" }).click();
        const dialog = page.getByRole("dialog", { name: "Report product feedback" });
        await dialog.getByRole("radio", { name: "Usability", exact: true }).check();
        await dialog.getByRole("textbox", { name: "Title", exact: true }).fill("Test");
        await dialog.getByRole("textbox", { name: "Details", exact: true }).fill("Test issue, do nothing.");
        await expectContentClearsBorder(dialog);
        if (dev) {
          const refresh = await observeReactRefresh(page);
          const now = new Date();
          // Touch only the timestamp: exercise Vite's real React refresh without editing source.
          utimesSync(join(process.cwd(), "src/web/components/ProductIssueModal.tsx"), now, now);
          await refresh.completed;
        }
        await expect(dialog.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Test");
        await expect(dialog.getByRole("textbox", { name: "Details", exact: true }))
          .toHaveValue("Test issue, do nothing.");
        const heldPress = surface === "packaged dashboard after a held press";
        const gesture = heldPress ? page.waitForEvent("console", {
          predicate: (message) => message.text().startsWith("report-gesture:"),
        }) : null;
        if (heldPress) {
          await page.evaluate(() => {
            window.addEventListener("click", (event) => {
              console.info(`report-gesture:${event.isTrusted}:${navigator.userActivation.isActive}`);
            }, { capture: true, once: true });
          });
        }
        await dialog.getByRole("button", { name: "Report publicly" }).click({
          // Chromium's transient activation begins on mouse-down, not the final trusted click.
          delay: heldPress ? 6_000 : 0,
        });
        if (gesture) expect((await gesture).text()).toBe("report-gesture:true:false");
        await expect(dialog.getByRole("link", { name: "View GitHub issue" })).toBeVisible();
        const creates = recordsIn<{ argv: string[] }>(daemon.recordDir, (file) => file.startsWith("gh-"))
          .filter(({ argv }) => argv[0] === "issue" && argv[1] === "create");
        expect(creates).toHaveLength(1);
        expect(creates[0]!.argv).toEqual(expect.arrayContaining(["usability", "Test", "source:dashboard"]));
        if (process.env.MC_E2E_EVIDENCE === "1") {
          const dir = join(process.cwd(), "e2e/.artifacts/report-publicly");
          mkdirSync(dir, { recursive: true });
          await page.mouse.move(1, 1);
          await dialog.screenshot({ path: join(dir, `desktop-${heldPress ? "held" : dev ? "hot-updated" : "packaged"}-reported.png`) });
        }
      } finally {
        await application.close();
      }
    } finally {
      dev?.stop();
    }
  });
}
