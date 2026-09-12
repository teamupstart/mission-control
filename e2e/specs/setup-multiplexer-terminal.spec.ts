import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { artifactsDir } from "../fixtures/artifacts.ts";
import { expect, test } from "../fixtures/test.ts";
import { openSetupFamily, setupRow } from "../fixtures/setup-panel.ts";

/**
 * `MISSION_TMUX_BIN` points tmux at a file that certainly exists, so the tmux row reads Ready
 * on a developer's laptop and on a CI runner alike. Herdr stays at the fixture's known missing
 * path, which is the not-installed row these tests need. The terminal registry answer is
 * routed for the same reason the harness picker spec routes it: what is installed on the
 * machine running the browser must not decide what the menu contains.
 */

/** One terminal app available, one not, and each multiplexer's own `needsTerminalApp`. */
const TARGETS = [
  {
    id: "tmux",
    label: "tmux",
    glyph: "▤",
    blurb: "New session, raised in WezTerm.",
    detail: "new-session -c",
    unavailable: null,
    dispatchBlurb: "New persistent session for each dispatch.",
    dispatchUnavailable: null,
    needsTerminalApp: true,
  },
  {
    id: "herdr",
    label: "Herdr",
    glyph: "▦",
    blurb: "",
    detail: null,
    unavailable: "Herdr is not installed",
    dispatchBlurb: "New persistent session for each dispatch.",
    dispatchUnavailable: "Herdr is not installed",
    needsTerminalApp: true,
  },
  {
    // `attachArgv: null` on the adapter. The row says so instead of offering a choice.
    id: "cmux",
    label: "cmux",
    glyph: "▥",
    blurb: "New workspace in the worktree.",
    detail: null,
    unavailable: null,
    dispatchBlurb: "New persistent session for each dispatch.",
    dispatchUnavailable: null,
    needsTerminalApp: false,
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

test.use({ daemonEnv: { MISSION_TMUX_BIN: process.execPath } });

test("a multiplexer carries its own terminal app, chosen on its Setup row and kept", async ({
  page,
  daemon,
}) => {
  await page.route("**/api/terminal-targets", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ targets: TARGETS }),
    });
  });

  await page.goto(`${daemon.baseURL}/#/settings/setup`);
  await openSetupFamily(page, "terminals");
  const cmux = setupRow(page, "dependency-cmux");
  await expect(cmux).toContainText("Needs no terminal");
  await expect(cmux.getByRole("button", { name: /^Terminal app for cmux sessions/ })).toHaveCount(0);
  const herdr = setupRow(page, "dependency-herdr");
  const herdrTerminal = herdr.getByRole("button", { name: /^Terminal app for Herdr sessions/ });
  await expect(herdrTerminal).toContainText("Automatic");
  await expect(herdrTerminal).toBeDisabled();
  const tmux = setupRow(page, "dependency-tmux");
  await expect(tmux).toContainText("Opens in");
  const tmuxTerminal = tmux.getByRole("button", { name: /^Terminal app for tmux sessions/ });
  await expect(tmuxTerminal).toContainText("Automatic");
  await tmuxTerminal.click();

  const menu = page.getByRole("menu", { name: "Choose a terminal app for tmux sessions" });
  await expect(menu).toBeVisible();
  await expect(menu.getByText("Terminal apps", { exact: true })).toBeVisible();
  await expect(menu.getByText("Multiplexers", { exact: true })).toHaveCount(0);
  for (const name of ["tmux", "Herdr", "cmux"]) {
    await expect(menu.getByRole("menuitemradio", { name })).toHaveCount(0);
  }
  const automatic = menu.getByRole("menuitemradio", { name: /Automatic/ });
  await expect(automatic).toHaveAttribute("aria-checked", "true");
  await automatic.hover();
  await expect(page.locator(".tooltip")).toHaveText(
    "Let Mission Control choose the terminal app that opens tmux sessions",
  );
  await expect(menu.getByRole("menuitemradio", { name: /Ghostty/ })).toBeDisabled();
  await expect(menu.getByText("Ghostty is not installed", { exact: true })).toBeVisible();
  await expect(menu.getByText("Focus opens a new WezTerm window.", { exact: true })).toBeVisible();

  if (process.env.MC_E2E_EVIDENCE === "1") {
    const evidence = artifactsDir("multiplexer-focus-terminal");
    mkdirSync(evidence, { recursive: true });
    await page.screenshot({ path: join(evidence, "tmux-chooser-open.png"), fullPage: true });
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/.artifacts/multiplexer-focus-terminal/tmux-chooser-open.png");
  }

  await menu.getByRole("menuitemradio", { name: /WezTerm/ }).click();
  await expect(tmuxTerminal).toContainText("WezTerm");

  await expect
    .poll(async () => {
      const response = await page.request.get(`${daemon.baseURL}/api/terminals/config`);
      return (await response.json()).multiplexerTerminal;
    })
    .toEqual({ tmux: "wezterm", herdr: null, cmux: null });

  // The route, not just the schema: an outer key count reads this as one key.
  const empty = await page.request.put(`${daemon.baseURL}/api/terminals/config`, {
    data: { multiplexerTerminal: {} },
  });
  expect(empty.status()).toBe(400);
  const stillStored = await page.request.get(`${daemon.baseURL}/api/terminals/config`);
  expect((await stillStored.json()).multiplexerTerminal.tmux).toBe("wezterm");

  await page.reload();
  await openSetupFamily(page, "terminals");
  await expect(
    setupRow(page, "dependency-tmux").getByRole("button", {
      name: /^Terminal app for tmux sessions/,
    }),
  ).toContainText("WezTerm");

  if (process.env.MC_E2E_EVIDENCE === "1") {
    const evidence = artifactsDir("multiplexer-focus-terminal");
    mkdirSync(evidence, { recursive: true });
    await page.mouse.move(1, 1);
    await page.screenshot({ path: join(evidence, "terminals-family.png"), fullPage: true });
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/.artifacts/multiplexer-focus-terminal/terminals-family.png");
  }
});

test("a refused preference write is taken back, and the row says why", async ({
  page,
  daemon,
}) => {
  await page.route("**/api/terminal-targets", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ targets: TARGETS }),
    });
  });

  // A prior choice that is not the shipped default: Automatic would pass this test for the
  // wrong reason, being also what a hook that dropped the value would show.
  const seeded = await page.request.put(`${daemon.baseURL}/api/terminals/config`, {
    data: { multiplexerTerminal: { tmux: "iterm" } },
  });
  expect(seeded.status()).toBe(200);

  // Only the WRITE is refused. The read has to keep working, or the panel would have no
  // prior value to put back and this would pass without the rollback existing.
  await page.route("**/api/terminals/config", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "the daemon refused" }),
    });
  });

  await page.goto(`${daemon.baseURL}/#/settings/setup`);
  await openSetupFamily(page, "terminals");
  const trigger = setupRow(page, "dependency-tmux").getByRole("button", {
    name: /^Terminal app for tmux sessions/,
  });
  await expect(trigger).toContainText("iTerm2");

  await trigger.click();
  await page
    .getByRole("menu", { name: "Choose a terminal app for tmux sessions" })
    .getByRole("menuitemradio", { name: /WezTerm/ })
    .click();

  await expect(page.getByText("That change didn't stick: the daemon refused")).toBeVisible();
  await expect(trigger).toContainText("iTerm2");
  await expect(trigger).not.toContainText("WezTerm");

  // Read back through the GET this spec never intercepted.
  await page.reload();
  await openSetupFamily(page, "terminals");
  await expect(
    setupRow(page, "dependency-tmux").getByRole("button", {
      name: /^Terminal app for tmux sessions/,
    }),
  ).toContainText("iTerm2");
});

test("two quick changes reach the daemon in the order they were made", async ({
  page,
  daemon,
}) => {
  await page.route("**/api/terminal-targets", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ targets: TARGETS }),
    });
  });

  // The first PUT is HELD so the second can overtake it. Both still reach the real route and
  // the real per-key merge, which is what decides the stored value when they arrive out of
  // order - and why the assertion below is on that value rather than on the control.
  const arrived: string[] = [];
  let held = 0;
  await page.route("**/api/terminals/config", async (route) => {
    const request = route.request();
    if (request.method() !== "PUT") return route.continue();
    const chosen = JSON.stringify(request.postDataJSON()?.multiplexerTerminal?.tmux);
    if (held === 0) {
      held += 1;
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    arrived.push(chosen);
    await route.continue();
  });

  await page.goto(`${daemon.baseURL}/#/settings/setup`);
  await openSetupFamily(page, "terminals");
  const tmux = setupRow(page, "dependency-tmux");
  const trigger = tmux.getByRole("button", { name: /^Terminal app for tmux sessions/ });
  await expect(trigger).toContainText("Automatic");

  const choose = async (name: RegExp): Promise<void> => {
    await trigger.click();
    await page
      .getByRole("menu", { name: "Choose a terminal app for tmux sessions" })
      .getByRole("menuitemradio", { name })
      .click();
  };

  await choose(/WezTerm/);
  await expect(trigger).toContainText("WezTerm");
  await choose(/iTerm2/);
  // Drawn at once, ahead of the queue.
  await expect(trigger).toContainText("iTerm2");

  await expect.poll(() => arrived).toEqual(['"wezterm"', '"iterm"']);
  await expect
    .poll(async () => {
      const response = await page.request.get(`${daemon.baseURL}/api/terminals/config`);
      return (await response.json()).multiplexerTerminal.tmux;
    })
    .toBe("iterm");
  await expect(trigger).toContainText("iTerm2");
});

test("a terminal-target read that fails says so, and Re-check retries it", async ({
  page,
  daemon,
}) => {
  // Refused once, then served. Without the retry the panel would keep the dead reading for
  // the life of the mount, with every chooser simply absent.
  let refusals = 0;
  await page.route("**/api/terminal-targets", async (route) => {
    if (refusals === 0) {
      refusals += 1;
      return route.abort("connectionrefused");
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ targets: TARGETS }),
    });
  });

  await page.goto(`${daemon.baseURL}/#/settings/setup`);
  await openSetupFamily(page, "terminals");

  const tmux = setupRow(page, "dependency-tmux");
  const trigger = tmux.getByRole("button", { name: /^Terminal app for tmux sessions/ });
  await expect(page.getByText("Mission Control could not check terminal availability", {
    exact: false,
  })).toBeVisible();
  await expect(trigger).toHaveCount(0);

  await page.getByRole("button", { name: "Re-check", exact: true }).click();

  await expect(trigger).toContainText("Automatic");
  await expect(page.getByText("Mission Control could not check terminal availability", {
    exact: false,
  })).toHaveCount(0);
});
