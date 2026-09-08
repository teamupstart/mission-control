import { mkdirSync } from "node:fs";

import type { Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import { expect, test } from "../fixtures/test.ts";

const EVIDENCE = artifactsDir("harness-terminal-picker");

const TARGETS = [
  {
    id: "tmux",
    label: "tmux",
    glyph: "▤",
    blurb: "",
    detail: null,
    unavailable: "tmux sessions open detached - install a terminal that can show one",
    dispatchBlurb: "New persistent session for each dispatch.",
    dispatchUnavailable: null,
  },
  {
    id: "herdr",
    label: "Herdr",
    glyph: "▦",
    blurb: "New workspace in the worktree.",
    detail: null,
    unavailable: null,
    dispatchBlurb: "New persistent session for each dispatch.",
    dispatchUnavailable: null,
  },
  {
    id: "cmux",
    label: "cmux",
    glyph: "▥",
    blurb: "New workspace in the worktree.",
    detail: null,
    unavailable: null,
    dispatchBlurb: "New persistent session for each dispatch.",
    dispatchUnavailable: null,
  },
  {
    id: "wezterm",
    label: "WezTerm",
    glyph: "▣",
    blurb: "New window in the worktree.",
    detail: null,
    unavailable: null,
    dispatchBlurb: "New terminal window in the worktree for each dispatch.",
    dispatchUnavailable: null,
  },
  {
    id: "ghostty",
    label: "Ghostty",
    glyph: "▧",
    blurb: "",
    detail: null,
    unavailable: "Ghostty is not installed",
    dispatchBlurb: "New terminal window in the worktree for each dispatch.",
    dispatchUnavailable: "Ghostty is not installed",
  },
  {
    id: "iterm",
    label: "iTerm2",
    glyph: "▨",
    blurb: "New window in the worktree.",
    detail: null,
    unavailable: null,
    dispatchBlurb: "New terminal window in the worktree for each dispatch.",
    dispatchUnavailable: null,
  },
];

async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, fullPage: true });
  // oxlint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/harness-terminal-picker/${name}.png`);
}

test("a terminal runtime exposes the detailed backend chooser and persists one exact choice", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.route("**/api/terminal-targets", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ targets: TARGETS }),
    });
  });

  await dashboard.goto(`${daemon.baseURL}/#/settings`);
  await dashboard.getByRole("tab", { name: /Harnesses/ }).click();

  const runtime = dashboard.getByRole("combobox", {
    name: "Session runtime for dispatched Claude Code sessions",
  });
  const terminal = dashboard.getByRole("button", {
    name: /Terminal preference for Claude Code/,
  });

  await expect(terminal).toHaveCount(0);
  await runtime.selectOption("terminal");
  await expect(terminal).toContainText("Automatic");
  await terminal.click();

  const menu = dashboard.getByRole("menu", {
    name: "Choose a terminal for dispatched Claude Code sessions",
  });
  await expect(menu).toBeVisible();
  await expect(menu.getByText("Multiplexers", { exact: true })).toBeVisible();
  await expect(menu.getByText("Terminal apps", { exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitemradio", { name: /Automatic/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  // The ordinary open-terminal menu cannot use this detached tmux without a raiser. A
  // background dispatch can, so this chooser must keep the row enabled.
  await expect(menu.getByRole("menuitemradio", { name: /tmux/ })).toBeEnabled();
  await expect(menu.getByRole("menuitemradio", { name: /Ghostty/ })).toBeDisabled();
  await expect(menu.getByText("Ghostty is not installed", { exact: true })).toBeVisible();
  await shoot(dashboard, "01-detailed-chooser");

  await menu.getByRole("menuitemradio", { name: /Herdr/ }).click();
  await expect(terminal).toContainText("Herdr");
  await expect
    .poll(async () => {
      const response = await dashboard.request.get(`${daemon.baseURL}/api/harnesses/config`);
      return (await response.json()).terminalBackend.claude;
    })
    .toBe("herdr");

  // SDK hides the terminal-only row but does not erase it. Switching back exposes the same
  // saved choice, which is the behavior an operator expects from a nested preference.
  await runtime.selectOption("sdk");
  await expect(terminal).toHaveCount(0);
  await runtime.selectOption("terminal");
  await expect(terminal).toContainText("Herdr");
  await shoot(dashboard, "02-herdr-saved");

  await dashboard.reload();
  await expect(
    dashboard.getByRole("button", { name: /Terminal preference for Claude Code/ }),
  ).toContainText("Herdr");
});
