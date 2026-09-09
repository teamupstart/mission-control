import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { recordsIn } from "../fixtures/records.ts";
import { expect, test } from "../fixtures/test.ts";

const EVIDENCE = artifactsDir("herdr-multiplexer");
const TASK = "Exercise the Herdr multiplexer from Mission Control";

interface HerdrRequest {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

interface FleetSession {
  id: string;
  name: string;
  runtime: string;
  cwd: string | null;
  terminals: Array<{
    backend: string;
    kind: string;
    paneId: string;
  }>;
}

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(TASK);
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

async function openDispatchedSession(page: Page): Promise<ReturnType<Page["locator"]>> {
  const row = page
    .getByRole("navigation", { name: "Sessions" })
    .locator("button.rail-row")
    .filter({ hasText: TASK });
  await expect(row).toBeVisible();
  await row.click();
  return page.locator(".console-detail");
}

function herdrRequests(daemon: DaemonHandle): HerdrRequest[] {
  try {
    return readFileSync(join(daemon.recordDir, "herdr-requests.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as HerdrRequest];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function weztermSpawns(daemon: DaemonHandle): string[][] {
  return recordsIn<{ argv?: unknown }>(daemon.recordDir, (file) => file.startsWith("wezterm-"))
    .map((record) => Array.isArray(record.argv)
      ? record.argv.filter((arg): arg is string => typeof arg === "string")
      : [])
    .filter((argv) => argv.includes("spawn"));
}

async function sessions(daemon: DaemonHandle): Promise<FleetSession[]> {
  return await (await fetch(`${daemon.baseURL}/api/sessions`)).json() as FleetSession[];
}

async function shoot(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: join(EVIDENCE, `${name}.png`), fullPage: true });
  console.log(`CAPTURED e2e/.artifacts/herdr-multiplexer/${name}.png`);
}

test.describe("compatible stable Herdr", () => {
  test.use({ daemonEnv: { MC_E2E_HERDR: "1", MISSION_POLL_MS: "100" } });

  test("launches, discovers, and focuses a default-server Herdr session", async ({
    dashboard,
    daemon,
  }) => {
    await dispatch(dashboard, daemon);
    const card = await openDispatchedSession(dashboard);
    const source = (await sessions(daemon)).find((session) => session.runtime === "sdk");
    expect(source?.cwd).toBeTruthy();

    await card.locator(".conv-launch").getByRole("button", { name: "Terminal", exact: true }).click();
    const menu = card.getByRole("menu", { name: "Open a shell in the worktree with" });
    await expect(menu).toBeVisible();

    const labels = await menu.locator(".launch-label").evaluateAll((elements) =>
      elements.map((element) =>
        [...element.childNodes]
          .find((node) => node.nodeType === Node.TEXT_NODE)
          ?.textContent?.trim() ?? ""),
    );
    expect(labels).toEqual(["tmux", "Herdr", "cmux", "WezTerm", "Ghostty", "iTerm2"]);

    const herdr = menu.getByRole("menuitem").filter({ hasText: "Herdr" });
    await expect(herdr).toBeEnabled();
    await expect(herdr.locator(".launch-note")).toHaveText(
      "Open a shell in Herdr. New session, raised in WezTerm.",
    );
    await shoot(dashboard, "herdr-launch-menu");
    await herdr.click();
    await expect(card.locator(".launch-flash")).toHaveText("Opened in Herdr");

    await expect
      .poll(() => herdrRequests(daemon).some((request) => request.method === "workspace.create"), {
        message: "the launch should create a workspace through the fake default Herdr server",
        timeout: 15_000,
      })
      .toBe(true);
    const create = herdrRequests(daemon).find((request) => request.method === "workspace.create")!;
    // Dispatch may author in a managed task worktree rather than the repository's source
    // checkout. The launcher must preserve the selected session's actual cwd either way.
    expect(create.params?.cwd).toBe(source!.cwd);
    expect(create.params?.focus).toBe(true);

    await expect
      .poll(() => herdrRequests(daemon).some((request) => request.method === "pane.send_input"), {
        message: "the launch should deliver its command through bracket-aware input",
      })
      .toBe(true);
    const delivery = herdrRequests(daemon).find((request) => request.method === "pane.send_input")!;
    expect(delivery?.params?.keys).toEqual(["enter"]);
    expect(String(delivery?.params?.text)).toContain("/bin/");

    let terminalSession: FleetSession | null = null;
    await expect
      .poll(async () => {
        terminalSession = (await sessions(daemon)).find((session) =>
          session.runtime === "terminal" &&
          session.terminals.some((handle) =>
            handle.backend === "herdr" && handle.kind === "multiplexer")) ?? null;
        return terminalSession !== null;
      }, {
        message: "PID ancestry should adopt the fake agent under its Herdr pane",
        timeout: 30_000,
      })
      .toBe(true);

    const terminalRow = dashboard
      .getByRole("navigation", { name: "Sessions" })
      .locator("button.rail-row")
      .filter({ hasText: terminalSession!.name });
    await expect(terminalRow).toBeVisible();
    await terminalRow.click();
    const terminalCard = dashboard.locator(".console-detail");
    const focus = terminalCard.locator(".conv-launch").getByRole("button", { name: /Claude Code/ });
    await expect(focus).not.toHaveAttribute("aria-haspopup", "menu");

    const raisedAtLaunch = weztermSpawns(daemon).length;
    expect(raisedAtLaunch).toBe(1);
    await focus.click();
    await focus.click();
    await expect
      .poll(() => herdrRequests(daemon).filter((request) => request.method === "agent.focus").length, {
        message: "each focus click should select the Herdr agent internally",
      })
      .toBe(2);
    await expect
      .poll(() => weztermSpawns(daemon).length, {
        message: "each focus click should open the ordinary full Herdr client in WezTerm",
      })
      .toBe(raisedAtLaunch + 2);

    for (const argv of weztermSpawns(daemon)) {
      expect(argv).toContain(join(daemon.home, "fake-bin", "fake-herdr"));
      expect(argv).not.toContain("attach");
      expect(argv).not.toContain("--takeover");
    }
    await shoot(dashboard, "herdr-session-focused");
  });
});

test.describe("incompatible stable Herdr", () => {
  test.use({
    daemonEnv: {
      MC_E2E_HERDR: "1",
      MC_E2E_HERDR_MODE: "incompatible",
      MISSION_POLL_MS: "0",
    },
  });

  test("shows the actionable compatibility refusal without starting a server", async ({
    dashboard,
    daemon,
  }) => {
    await dispatch(dashboard, daemon);
    const card = await openDispatchedSession(dashboard);
    await card.locator(".conv-launch").getByRole("button", { name: "Terminal", exact: true }).click();
    const menu = card.getByRole("menu", { name: "Open a shell in the worktree with" });
    await menu.getByRole("menuitem").filter({ hasText: "Herdr" }).click();

    await expect(card.locator(".launch-flash.is-error")).toContainText(
      "requires Herdr 0.8.2 or newer on protocol 20",
    );
    expect(herdrRequests(daemon)).toEqual([]);
    await shoot(dashboard, "herdr-incompatible-refusal");
  });
});

/**
 * Protocol 22, the generation stable Herdr 0.9.0 actually serves. The launch path reaches the
 * server through `probe`, and discovery reaches it again through `session.snapshot`, which
 * carries its own generation number and had its own equality check. Both are floors now, so
 * a newer Herdr opens a workspace and is adopted like any other.
 */
test.describe("stable Herdr on a newer protocol generation", () => {
  test.use({
    daemonEnv: { MC_E2E_HERDR: "1", MC_E2E_HERDR_MODE: "newer", MISSION_POLL_MS: "100" },
  });

  test("opens a workspace and adopts the discovered pane", async ({ dashboard, daemon }) => {
    await dispatch(dashboard, daemon);
    const card = await openDispatchedSession(dashboard);
    await card.locator(".conv-launch").getByRole("button", { name: "Terminal", exact: true }).click();
    const menu = card.getByRole("menu", { name: "Open a shell in the worktree with" });
    await menu.getByRole("menuitem").filter({ hasText: "Herdr" }).click();

    await expect(card.locator(".launch-flash")).toHaveText("Opened in Herdr");
    await expect(card.locator(".launch-flash.is-error")).toHaveCount(0);
    await expect
      .poll(() => herdrRequests(daemon).some((request) => request.method === "workspace.create"), {
        message: "a protocol 22 server should still be sent a workspace creation",
        timeout: 15_000,
      })
      .toBe(true);

    await expect
      .poll(async () => (await sessions(daemon)).some((session) =>
        session.runtime === "terminal" &&
        session.terminals.some((handle) =>
          handle.backend === "herdr" && handle.kind === "multiplexer")), {
        message: "the protocol 22 session snapshot should be read, not refused",
        timeout: 30_000,
      })
      .toBe(true);
    await shoot(dashboard, "herdr-newer-protocol-session");
  });
});
