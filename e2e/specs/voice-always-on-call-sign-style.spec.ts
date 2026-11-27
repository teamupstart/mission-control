import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { beListener, enableVoice, say } from "../fixtures/voice.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { Session, Task } from "../../src/shared/types.ts";

/**
 * Always-on cards keep the session's title and draw its call sign beside it, in the style
 * chosen under Settings > Display > Board card > Call sign: Subtitle line by default, then
 * Trailing badge, Leading chip, Edge tab, or Off. Off hides the element only; the call sign is
 * still saved and voice still routes to it.
 *
 * No model tokens are spent: the agent binaries are faked and the listener is the hello-only
 * stand-in.
 */

const EVIDENCE = artifactsDir("voice-always-on-call-sign-style");
const TITLES = [
  "Migrate the billing reconciliation job to the new ledger schema and backfill three years of invoices",
  "Fix the flaky parser test",
  "Profile startup",
];
const STYLES = [
  { label: "Subtitle line", value: "subtitle", element: ".cs-mark.cs-sub" },
  { label: "Trailing badge", value: "badge", element: ".cs-mark.cs-badge" },
  { label: "Leading chip", value: "chip", element: ".cs-mark.cs-chip" },
  { label: "Edge tab", value: "tab", element: ".tile-edge-tabs .cs-mark.cs-tab" },
] as const;

async function capture(target: Page | Locator, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await ("mouse" in target ? target : target.page()).mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // oxlint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/voice-always-on-call-sign-style/${name}.png`);
}

async function json<T>(daemon: DaemonHandle, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(daemon.baseURL + path, { headers: { "content-type": "application/json" }, ...init });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}

/** Navigate inside the open document, the way the app's own links do: a hash, never a load. */
async function go(page: Page, hash: string): Promise<void> {
  await page.evaluate((next) => { window.location.hash = next; }, hash);
}

/** Launch the tasks without call signs, so each is given one, and wait until all are idle. */
async function launch(daemon: DaemonHandle): Promise<Session[]> {
  const tasks = await Promise.all(TITLES.map((title) => json<Task>(daemon, "/api/tasks", { method: "POST", body: JSON.stringify({
    repoRoot: daemon.repo, intent: title, title, kind: "ship", agent: "claude", runtime: "sdk", workflowId: null,
  }) })));
  let found: Session[] = [];
  await expect.poll(async () => {
    const sessions = await json<Session[]>(daemon, "/api/sessions");
    found = tasks.map((task) => sessions.find((session) => session.task?.id === task.id)!);
    return found.every((session) => session?.agentSessionId && session.state === "idle" && session.task?.callSign);
  }, { timeout: 90_000 }).toBe(true);
  return found;
}

function cardOf(page: Page, session: Session): Locator {
  return page.locator("main.board .tile").filter({ has: page.getByRole("button", { name: `Open ${session.name}`, exact: true }) });
}

test("Always-on cards keep the title and show the call sign in the style picked in Settings, previewed there", async ({ dashboard: page, daemon }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 960 });
  await enableVoice(daemon);
  await json(daemon, "/api/voice/config", { method: "PUT", body: JSON.stringify({ muted: false, cancelWindow: { enabled: true, seconds: 30 } }) });
  await json(daemon, "/api/ui/config", { method: "PUT", body: JSON.stringify({ layout: "board" }) });
  const sessions = await launch(daemon);
  const listener = await beListener(daemon);
  try {
    await page.reload();
    const status = page.locator(".app > .vi-status-line");
    await expect(status).toHaveAccessibleName("Voice: listening. Mute");

    // The default: every card keeps its own title, with "Say <call sign>" under it.
    for (const session of sessions) {
      const card = cardOf(page, session);
      await expect(card.locator(".tile-name")).toHaveText(session.name);
      await expect(card.locator(".cs-mark.cs-sub")).toHaveText(`Call sign Say ${session.task!.callSign}`);
    }
    await capture(page, "01-board-default-subtitle-line");

    // Settings: one radio group, Subtitle line checked, and a preview card drawing it.
    await go(page, "#/settings/display");
    const panel = page.locator('[data-anchor="display/board-card"]');
    const picker = panel.getByRole("radiogroup", { name: "Board card: Call sign" });
    await picker.scrollIntoViewIfNeeded();
    await expect(picker.getByRole("radio")).toHaveCount(5);
    await expect(picker.getByRole("radio", { name: "Subtitle line", exact: true })).toBeChecked();
    const preview = panel.locator(".board-card-preview-stage").first();
    await expect(preview.locator(".cs-mark.cs-sub")).toHaveText("Call sign Say Juniper");
    await capture(page, "02-settings-subtitle-line");

    for (const style of STYLES.slice(1)) {
      await picker.getByText(style.label, { exact: true }).click();
      await expect(picker.getByRole("radio", { name: style.label, exact: true })).toBeChecked();
      // Only one is on at a time, and the preview moves with it.
      await expect(picker.getByRole("radio", { checked: true })).toHaveCount(1);
      await expect(preview.locator(style.element)).toHaveText("Call sign Juniper");
      await expect(preview.locator(".cs-mark")).toHaveCount(1);
      await capture(panel.locator(".board-card-customizer").first(), `03-settings-${style.value}`);

      await go(page, "#/");
      for (const session of sessions) {
        const card = cardOf(page, session);
        await expect(card.locator(".tile-name")).toHaveText(session.name);
        await expect(card.locator(style.element)).toHaveText(`Call sign ${session.task!.callSign}`);
        await expect(card.locator(".cs-mark")).toHaveCount(1);
      }
      await capture(page, `04-board-${style.value}`);
      await go(page, "#/settings/display");
      await picker.scrollIntoViewIfNeeded();
    }
    expect((await json<{ config: { callSignCardStyle: string } }>(daemon, "/api/ui/config")).config.callSignCardStyle).toBe("tab");

    // Off: the title alone, while the call sign stays saved and voice still routes to it.
    await picker.getByText("Off", { exact: true }).click();
    await expect(picker.getByRole("radio", { name: "Off", exact: true })).toBeChecked();
    await expect(preview.locator(".cs-mark")).toHaveCount(0);
    await go(page, "#/");
    for (const session of sessions) {
      await expect(cardOf(page, session).locator(".tile-name")).toHaveText(session.name);
    }
    await expect(page.locator("main.board .cs-mark")).toHaveCount(0);
    await capture(page, "05-board-off");
    const [target] = sessions;
    const sign = target!.task!.callSign!;
    expect(await (await say(daemon, `${sign}, check the build`, { id: "off-routes" })).json()).toEqual({ accepted: true });
    await expect.poll(async () => {
      const entries = (await json<{ entries: { id: string; matchedName: string | null }[] }>(daemon, "/api/voice/heard")).entries;
      return entries.find((entry) => entry.id === "off-routes")?.matchedName ?? null;
    }, { timeout: 30_000 }).toBe(sign);

    // Back to the default after a reload, and the Console rail's compact pill beside the title.
    await json(daemon, "/api/ui/config", { method: "PUT", body: JSON.stringify({ callSignCardStyle: "subtitle", layout: "console" }) });
    await page.reload();
    const rail = page.getByRole("navigation", { name: "Sessions" });
    for (const session of sessions) {
      const row = rail.getByRole("button", { name: session.name, exact: true });
      await expect(row.locator(".rail-name-text")).toHaveText(session.name);
      await expect(row.locator(".cs-mark.cs-rail")).toHaveText(`Call sign ${session.task!.callSign}`);
    }
    await capture(page, "06-console-rail");
  } finally {
    listener.stop();
  }
});
