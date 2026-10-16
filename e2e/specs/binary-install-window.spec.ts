import {mkdir, mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {buildSync} from "esbuild";
import {_electron as electron, type ElectronApplication} from "playwright";
import {expect, test} from "../fixtures/test.ts";
import {expectContentClearsBorder} from "../fixtures/modal-inset.ts";
import {assertElectronGuiLaunchAllowed} from "../../test/helpers/electron-gui.ts";

test.skip(process.platform !== "darwin", "the desktop shell requires the macOS GUI");

for (const choice of ["install", "quit", "escape", "close", "unrelated navigation"] as const) {
  test(`temporary installation consent handles ${choice} without a daemon or platform sheet`, async () => {
    assertElectronGuiLaunchAllowed();
    const directory = await mkdtemp(join(tmpdir(), "binary-consent-"));
    let application: ElectronApplication | undefined;
    try {
      const module = join(directory, "window.cjs");
      buildSync({entryPoints: ["src/main/binary-install-window.ts"], outfile: module,
        bundle: true, platform: "node", format: "cjs", external: ["electron"],
        alias: {"@shared": join(process.cwd(), "src/shared")}});
      application = await electron.launch({args: [
        fileURLToPath(new URL("../fixtures/binary-install-window.cjs", import.meta.url)), module, join(directory, "profile"),
      ]});
      const page = await application.firstWindow();
      const panel = page.getByRole("dialog", {name: "Install Mission Control"});
      await expectContentClearsBorder(panel);
      await expect(panel).toContainText("Destination: /Users/operator/Applications/Mission Control.app");
      expect(page.url()).toMatch(/^data:text\/html/);
      expect(await application.evaluate(() => Reflect.get(globalThis, "installationChoice"))).toBeNull();
      if (choice === "install") {
        if (process.env.MC_E2E_EVIDENCE === "1") {
          await mkdir("e2e/.artifacts/binary-enrollment", {recursive: true});
          await page.screenshot({path: "e2e/.artifacts/binary-enrollment/temporary-consent.png"});
        }
        await panel.getByRole("link", {name: "Install Mission Control"}).click();
      } else if (choice === "quit") await panel.getByRole("link", {name: "Quit"}).click();
      else if (choice === "escape") {
        // CDP keyboard events bypass Electron's before-input-event boundary.
        await application.evaluate(({BrowserWindow}) => {
          const window = BrowserWindow.getAllWindows()[0]!;
          window.focus(); window.webContents.focus();
          window.webContents.sendInputEvent({type: "keyDown", keyCode: "Escape"});
        });
      } else {
        if (choice === "unrelated navigation") {
          // A prevented navigation leaves CDP waiting for a navigation that cannot finish;
          // observe Electron's actual event and retained page instead of that CDP state.
          const prevented = application.evaluate(({BrowserWindow}) => new Promise<boolean>(resolve => {
            BrowserWindow.getAllWindows()[0]!.webContents.once("will-navigate", event => resolve(event.defaultPrevented));
          }));
          await page.evaluate(() => { location.href = "https://mission-control.invalid/unrelated"; });
          expect(await prevented).toBe(true);
          expect(await application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0]!.webContents.getURL())).toMatch(/^data:text\/html/);
          expect(await application.evaluate(() => Reflect.get(globalThis, "installationChoice"))).toBeNull();
        }
        await application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0]!.close());
      }
      await expect.poll(() => application!.evaluate(() => Reflect.get(globalThis, "installationChoice"))).toBe(choice === "install");
    } finally {
      try { await application?.close(); } finally { await rm(directory, {recursive: true, force: true}); }
    }
  });
}
