import { openSetupFamily, setupRow } from "../fixtures/setup-panel.ts";
import { expect, test } from "../fixtures/test.ts";

// Setup needs a detected multiplexer. This test saves a preference and never starts it.
test.use({ daemonEnv: { MISSION_TMUX_BIN: "/usr/bin/true" } });

test("macOS Terminal becomes a multiplexer focus option when the preview is enabled", async ({
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
  await expect(terminal).toBeDisabled();
  if (process.platform === "darwin") {
    await expect(terminal).toContainText("Choose a multiplexer for dispatch");
  } else {
    await expect(terminal).toContainText("Terminal.app is available on macOS only.");
  }

  const setup = await context.newPage();
  await setup.goto(`${daemon.baseURL}/#/settings/setup`);
  await openSetupFamily(setup, "terminals");
  const setupTerminal = setupRow(setup, "dependency-macos-terminal");
  await expect(setupTerminal.getByText("macOS Terminal", { exact: true })).toBeVisible();
  const focus = setupRow(setup, "dependency-tmux").getByRole("button", {
    name: /^Terminal app for tmux sessions/,
  });
  await focus.click();
  const focusOption = setup.getByRole("menuitemradio", { name: /macOS Terminal/ });
  await expect(focusOption).toBeVisible();
  if (process.platform === "darwin") {
    await expect(focusOption).toBeEnabled();
    await focusOption.click();
    await expect(focus).toContainText("macOS Terminal");
  } else {
    await expect(focusOption).toBeDisabled();
  }

  await previewOn.click();
  await expect(terminal).toHaveCount(0);
  await expect(setupTerminal).toHaveCount(0);
  await expect(menu.getByText("WezTerm", { exact: true })).toBeVisible();
});
