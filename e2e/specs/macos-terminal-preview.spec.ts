import { expect, test } from "../fixtures/test.ts";

test("macOS Terminal appears in the dispatch chooser when the preview is enabled", async ({
  dashboard, context, daemon,
}) => {
  const flags = await context.newPage();
  await flags.goto(`${daemon.baseURL}/#/settings/feature-flags`);
  const previewOff = flags.getByRole("button", { name: "macOS Terminal: off" });
  await expect(previewOff).toBeVisible();

  await dashboard.goto(`${daemon.baseURL}/#/settings`);
  await dashboard.getByRole("tab", { name: /Harnesses/ }).click();
  await dashboard.getByRole("combobox", {
    name: "Session runtime for dispatched Claude Code sessions",
  }).selectOption("terminal");
  await dashboard.getByRole("button", { name: /Terminal preference for Claude Code/ }).click();
  const menu = dashboard.getByRole("menu", {
    name: "Choose a terminal for dispatched Claude Code sessions",
  });
  await expect(menu.getByText("WezTerm", { exact: true })).toBeVisible();
  const terminal = menu.getByRole("menuitemradio", { name: /macOS Terminal/ });
  await expect(terminal).toHaveCount(0);

  await previewOff.click();
  const previewOn = flags.getByRole("button", { name: "macOS Terminal: on" });
  await expect(previewOn).toBeVisible();
  await expect(terminal).toBeVisible();
  if (process.platform === "darwin") {
    await expect(terminal).toBeEnabled();
    await terminal.click();
    await expect(dashboard.getByRole("button", {
      name: "Terminal preference for Claude Code: macOS Terminal",
    })).toBeVisible();
    await dashboard.getByRole("button", {
      name: "Terminal preference for Claude Code: macOS Terminal",
    }).click();
  } else {
    await expect(terminal).toBeDisabled();
    await expect(terminal).toContainText("Terminal.app is available on macOS only.");
  }

  await previewOn.click();
  await expect(terminal).toHaveCount(0);
  await expect(menu.getByText("WezTerm", { exact: true })).toBeVisible();
});
