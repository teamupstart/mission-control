import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";

import type { Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import { expect, test } from "../fixtures/test.ts";
import { openSetupFamily } from "../fixtures/setup-panel.ts";

/**
 * Settings > Setup > Terminals: **Show sessions started outside Mission Control**.
 *
 * The first test runs with discovery off, as every spec does by default: the switch starts off
 * on a fresh state home, the warning is always on screen, and each change is stored by the
 * daemon rather than only drawn by the panel.
 *
 * The second turns discovery on and shows what the switch does to the Board, with two real
 * tmux panes running a fake `claude` (a symlink to node, so nothing spends tokens). One runs
 * beneath a launch wrapper in the exact shape `isolatedAgentArgv` writes for a dispatch; the
 * other is started directly, as a person would. That every real launch builder produces a
 * shape discovery recognizes is pinned by `test/mission-launch-process.test.ts`.
 */

const WARNING =
  "Off by default. When on, Mission Control also shows Claude, Codex, and Pi sessions you " +
  "started yourself in a terminal. This works poorly on some setups: cards can show the wrong " +
  "state, name, or pane, and sending to them can fail. Sessions Mission Control starts are " +
  "always shown.";

/**
 * Screenshot the switch once the rows above it have stopped moving. The machine check renders
 * its rows after the switch, and shifts it down; captured before that, the picture is of
 * whichever row slid into its place.
 */
async function settledShot(page: Page, path: string): Promise<void> {
  await expect(page.locator(".setup-pane .setup-loading")).toHaveCount(0);
  await expect(page.locator(".setup-pane .setup-row").first()).toBeVisible();
  const block = page.locator(".setup-external-sessions");
  await block.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  await block.screenshot({ path, animations: "disabled" });
}

test("the outside-sessions switch starts off, warns, and keeps each change across a reload", async ({
  page,
  daemon,
}) => {
  const open = async (): Promise<void> => {
    await page.goto(`${daemon.baseURL}/#/settings/setup`);
    await openSetupFamily(page, "terminals");
  };
  const toggle = () =>
    page.getByRole("checkbox", { name: "Show sessions started outside Mission Control" });
  const stored = async (): Promise<boolean> => {
    const res = await page.request.get(`${daemon.baseURL}/api/terminals/config`);
    expect(res.ok()).toBe(true);
    return ((await res.json()) as { externalSessions: boolean }).externalSessions;
  };

  await open();
  await expect(toggle()).toBeEnabled();
  await expect(toggle()).not.toBeChecked();
  await expect(page.getByText(WARNING, { exact: true })).toBeVisible();
  // Announced with the control, so the warning is read before anyone turns it on. Contained
  // rather than equal: the shared Tooltip appends its own hover description after it.
  await expect(toggle()).toHaveAccessibleDescription(new RegExp(WARNING.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  expect(await stored()).toBe(false);

  await toggle().check();
  await expect(toggle()).toBeChecked();
  await expect.poll(stored).toBe(true);

  if (process.env.MC_E2E_EVIDENCE === "1") {
    const evidence = artifactsDir("external-sessions-setting");
    mkdirSync(evidence, { recursive: true });
    await settledShot(page, join(evidence, "terminals-switch-on.png"));
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/.artifacts/external-sessions-setting/terminals-switch-on.png");
  }

  await page.reload();
  await openSetupFamily(page, "terminals");
  await expect(toggle()).toBeChecked();
  // Still shown while it is on: the warning is about what turning it on means.
  await expect(page.getByText(WARNING, { exact: true })).toBeVisible();

  await toggle().uncheck();
  await expect(toggle()).not.toBeChecked();
  await expect.poll(stored).toBe(false);

  await page.reload();
  await openSetupFamily(page, "terminals");
  await expect(toggle()).not.toBeChecked();

  if (process.env.MC_E2E_EVIDENCE === "1") {
    const evidence = artifactsDir("external-sessions-setting");
    await settledShot(page, join(evidence, "terminals-switch-off.png"));
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/.artifacts/external-sessions-setting/terminals-switch-off.png");
  }
});

test.describe("the Board with discovery on", () => {
  test.skip(spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0, "tmux is not installed on this machine");
  test.use({ daemonEnv: { MISSION_POLL_MS: "400" } });

  const cleanups: Array<() => void> = [];
  test.afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  /** A tmux session running a fake `claude` that idles forever, named for this test only. */
  function startPane(kind: "mission" | "outside"): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), `mc-e2e-${kind}-pane-`)));
    const bin = join(dir, "fake-bin");
    mkdirSync(bin);
    symlinkSync(execPath, join(bin, "claude"));
    const script = join(dir, "agent.mjs");
    writeFileSync(script, "setInterval(() => {}, 1 << 30);\n");
    const agent = `"${join(bin, "claude")}" "${script}"`;
    let command = agent;
    let home: string | null = null;
    if (kind === "mission") {
      // Where and how a dispatch's wrapper lives: one private home under the shared root, a
      // script that runs the agent without exec, started as `/bin/sh <script>`.
      const root = join(tmpdir(), "mission-control-agent-state");
      mkdirSync(root, { recursive: true, mode: 0o700 });
      home = mkdtempSync(join(root, "session-"));
      const wrapper = join(home, "launch-and-cleanup.sh");
      writeFileSync(wrapper, `#!/bin/sh\n${agent}\n`, { mode: 0o700 });
      command = `/bin/sh ${wrapper}`;
    }
    const session = `mc-e2e-${kind}-${process.pid}-${Date.now()}`;
    execFileSync("tmux", ["new-session", "-d", "-s", session, "-x", "120", "-y", "40", "-c", dir, command]);
    cleanups.push(() => {
      spawnSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
      rmSync(dir, { recursive: true, force: true });
      if (home) rmSync(home, { recursive: true, force: true });
    });
    return session;
  }

  test("an outside session has no card until the switch is on, and a Mission launch always does", async ({
    dashboard,
    daemon,
  }) => {
    const mission = startPane("mission");
    const outside = startPane("outside");
    const layout = await fetch(`${daemon.baseURL}/api/ui/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ layout: "board" }),
    });
    expect(layout.ok).toBe(true);
    const board = async (): Promise<void> => {
      await dashboard.goto(`${daemon.baseURL}/#/fleet`);
      // A hash change keeps the page's loaded layout; reload so it reads the Board layout.
      await dashboard.reload();
      await expect(dashboard.locator("main.board")).toBeVisible();
    };
    const tile = (name: string) => dashboard.locator("main.board .tile").filter({ hasText: name });
    const setSwitch = async (on: boolean): Promise<void> => {
      await dashboard.goto(`${daemon.baseURL}/#/settings/setup`);
      await openSetupFamily(dashboard, "terminals");
      const toggle = dashboard.getByRole("checkbox", { name: "Show sessions started outside Mission Control" });
      await expect(toggle).toBeEnabled();
      if (on) await toggle.check();
      else await toggle.uncheck();
      await expect.poll(async () =>
        ((await (await fetch(`${daemon.baseURL}/api/terminals/config`)).json()) as { externalSessions: boolean })
          .externalSessions).toBe(on);
    };
    const shoot = async (name: string): Promise<void> => {
      if (process.env.MC_E2E_EVIDENCE !== "1") return;
      const evidence = artifactsDir("external-sessions-setting");
      mkdirSync(evidence, { recursive: true });
      await dashboard.mouse.move(0, 0);
      await dashboard.locator("main.board").screenshot({ path: join(evidence, `${name}.png`) });
      // eslint-disable-next-line no-console
      console.log(`CAPTURED e2e/.artifacts/external-sessions-setting/${name}.png`);
    };

    // Off, the default. Both panes were running before the first sweep that carded the
    // Mission one, so that same sweep already passed over the outside one.
    await board();
    await expect(tile(mission)).toHaveCount(1, { timeout: 20_000 });
    await expect(tile(outside)).toHaveCount(0);
    await shoot("board-switch-off");

    await setSwitch(true);
    await board();
    await expect(tile(outside)).toHaveCount(1, { timeout: 20_000 });
    await expect(tile(mission)).toHaveCount(1);
    await shoot("board-switch-on");

    // Off again: the outside card leaves through the ordinary exit and eviction, and the
    // Mission card stays.
    await setSwitch(false);
    await board();
    await expect(tile(outside)).toHaveCount(0, { timeout: 30_000 });
    await expect(tile(mission)).toHaveCount(1);
  });
});
