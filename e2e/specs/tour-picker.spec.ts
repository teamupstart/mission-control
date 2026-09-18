import { mkdirSync } from "node:fs";
import type { Page, Route } from "@playwright/test";
import { test, expect } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { startDevDashboard } from "../fixtures/dev-dashboard.ts";
import { TOUR_ENTRIES } from "../../src/web/tour/entries.ts";
import { TOUR_DEFINITIONS } from "../../src/web/tour/definitions.ts";

const NAME = "Explore Mission Control";
const PREFERENCE = "Show tours when Mission Control opens";
const ERROR = "Could not save your tour preference. Your previous setting still applies.";
const picker = (page: Page) => page.getByRole("dialog", { name: NAME });
const checkbox = (page: Page) => picker(page).getByRole("checkbox", { name: PREFERENCE });
const hash = (page: Page) => page.evaluate(() => location.hash);

test.use({ startupPicker: true });

async function config(daemon: DaemonHandle) {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`);
  expect(response.ok).toBe(true);
  return await response.json() as { configured: boolean; config: { showToursOnStartup: boolean; alerts: { notifications: boolean } } };
}
async function pin(daemon: DaemonHandle, patch: object) {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(patch),
  });
  expect(response.ok).toBe(true);
}
async function browse(page: Page) {
  await page.keyboard.press("Meta+k");
  const palette = page.getByRole("dialog", { name: "Search everything" });
  await palette.getByRole("combobox").fill("Browse tours");
  await palette.getByRole("option", { name: /Browse tours, command/ }).click();
  await expect(picker(page)).toBeVisible();
}
async function screenshot(page: Page, name: string) {
  if (!process.env.MC_E2E_EVIDENCE) return;
  const dir = artifactsDir("startup-tour-picker");
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}${name}.png`, animations: "disabled" });
}
async function holdWrite(page: Page) {
  let held!: Route;
  let received!: () => void;
  const pending = new Promise<void>((resolve) => { received = resolve; });
  await page.route("**/api/ui/config", async (route) => {
    if (route.request().method() === "PUT" && "showToursOnStartup" in route.request().postDataJSON()) {
      held = route;
      received();
    } else await route.continue();
  });
  return {
    pending,
    reject: async () => {
      await held.fulfill({ status: 503, json: { error: "temporarily unavailable" } });
      await page.unroute("**/api/ui/config");
    },
  };
}

test("fresh catalog previews every registry entry without launching or writing", async ({ page, daemon }) => {
  expect((await config(daemon)).configured).toBe(false);
  let writes = 0;
  page.on("request", (request) => {
    if (request.method() !== "GET" && /\/api\/(tours|tasks|ui\/config)/.test(request.url())) writes++;
  });
  await page.goto(`${daemon.baseURL}/#/library/commands/lint`);
  await expect(picker(page)).toBeVisible();
  await expectContentClearsBorder(picker(page));
  await expect(checkbox(page)).toBeChecked();
  await expect(picker(page).getByRole("radio").first()).toHaveAccessibleName("Set up this machine");
  await expect(picker(page).getByRole("radio")).toHaveCount(TOUR_ENTRIES.length);
  for (const entry of TOUR_ENTRIES) {
    await picker(page).getByRole("radio", { name: entry.title, exact: true }).check();
    const preview = picker(page).getByRole("region", { name: `${entry.title} preview` });
    await expect(preview.getByRole("heading", { name: entry.title, exact: true })).toBeVisible();
    await expect(preview.getByRole("listitem")).toHaveText([...entry.preview.outcomes]);
    await expect(picker(page).getByText(`${TOUR_DEFINITIONS[entry.id].steps.length} stops`, { exact: true })).toBeVisible();
    await expect(page.locator(".driver-popover")).toHaveCount(0);
    expect(await hash(page)).toBe("#/library/commands/lint");
  }
  await picker(page).getByRole("button", { name: "Dismiss", exact: true }).click();
  expect(writes).toBe(0);
  expect(await (await fetch(`${daemon.baseURL}/api/tasks`)).json()).toEqual([]);
});

test("picker controls describe preview, start, preference and dismissal on hover and focus", async ({ page, daemon }) => {
  await page.goto(`${daemon.baseURL}/#/fleet`);
  const start = picker(page).getByRole("button", { name: "Start this tour" });
  const close = picker(page).getByRole("button", { name: "Close tour picker" });
  for (const [control, description] of [
    [picker(page).getByRole("radio", { name: "Set up this machine" }), "Preview Set up this machine"],
    [start, "Start Set up this machine from the beginning"],
    [checkbox(page), "Offer the tour picker in new dashboard windows and after reloads"],
    [close, "Close the picker without starting a tour"],
    [picker(page).getByRole("button", { name: "Dismiss", exact: true }), "Close the picker without changing your startup preference"],
  ] as const) {
    await control.hover();
    await expect(page.locator(".tooltip").filter({ hasText: description })).toBeVisible();
    await expect(control).toHaveAccessibleDescription(new RegExp(description));
  }
  await close.focus();
  await start.focus();
  await expect(page.locator(".tooltip").filter({ hasText: "Start Set up this machine from the beginning" })).toBeVisible();
  await screenshot(page, "picker-tooltips");
});

for (const method of ["Dismiss", "Close tour picker", "Escape", "backdrop"]) {
  test(`${method} preserves the deep link and preference and restores dashboard focus`, async ({ page, daemon }) => {
    await page.goto(`${daemon.baseURL}/#/library/commands/lint`);
    await expect(picker(page)).toBeVisible();
    if (method === "Escape") await page.keyboard.press("Escape");
    else if (method === "backdrop") await page.mouse.click(4, 4);
    else await picker(page).getByRole("button", { name: method, exact: true }).click();
    await expect(picker(page)).toBeHidden();
    expect(await hash(page)).toBe("#/library/commands/lint");
    expect((await config(daemon)).config.showToursOnStartup).toBe(true);
    await expect(page.locator(".gear-btn")).toBeFocused();
    await page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: /Fleet/ }).click();
    await page.evaluate(() => { window.dispatchEvent(new Event("focus")); });
    await expect(picker(page)).toBeHidden();
  });
}

test("reload and a second window offer again, but an SSE reconnect does not", async ({ page, daemon, context }) => {
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await picker(page).getByRole("button", { name: "Dismiss", exact: true }).click();
  await daemon.crash();
  await daemon.restart();
  await expect(page.getByRole("button", { name: "Dispatch", exact: true })).toBeVisible();
  await expect(picker(page)).toBeHidden();
  await page.reload();
  await expect(picker(page)).toBeVisible();
  const second = await context.newPage();
  await second.goto(`${daemon.baseURL}/#/library`);
  await expect(picker(second)).toBeVisible();
  await second.close();
});

test("opt-out persists across reload, daemon restart and a second window; both manual entries work", async ({ page, daemon, context }) => {
  await page.goto(`${daemon.baseURL}/#/settings/display`);
  await checkbox(page).uncheck();
  await expect(checkbox(page)).toBeEnabled();
  expect((await config(daemon)).config.showToursOnStartup).toBe(false);
  await page.reload();
  await expect(page.getByRole("button", { name: "Browse tours", exact: true })).toBeVisible();
  await expect(picker(page)).toBeHidden();
  await page.getByRole("button", { name: "Browse tours", exact: true }).hover();
  await expect(page.locator(".tooltip").filter({ hasText: "Preview all available tours and choose a walkthrough" })).toBeVisible();
  await page.getByRole("button", { name: "Browse tours", exact: true }).click();
  await expect(checkbox(page)).not.toBeChecked();
  await picker(page).getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(page.getByRole("button", { name: "Browse tours", exact: true })).toBeFocused();
  await daemon.crash();
  await daemon.restart();
  const second = await context.newPage();
  await second.goto(`${daemon.baseURL}/#/fleet`);
  await expect(second.getByRole("button", { name: "Dispatch", exact: true })).toBeVisible();
  await expect(picker(second)).toBeHidden();
  expect((await config(daemon)).config.showToursOnStartup).toBe(false);
  await second.close();
  await browse(page);
  await checkbox(page).check();
  await expect(checkbox(page)).toBeEnabled();
  await picker(page).getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(picker(page)).toBeHidden();
  await page.reload();
  await expect(picker(page)).toBeVisible();
});

test("upgraded profiles ignore the old consumption marker and issue no retry write", async ({ page, daemon }) => {
  await pin(daemon, { guidedTour: false });
  await page.addInitScript(() => localStorage.setItem("ai-harness.guided-tour-consumption-pending", "true"));
  const writes: string[] = [];
  page.on("request", (request) => { if (request.method() === "PUT" && request.url().endsWith("/api/ui/config")) writes.push(request.postData()!); });
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await expect(picker(page)).toBeVisible();
  await picker(page).getByRole("button", { name: "Dismiss", exact: true }).click();
  await page.waitForTimeout(1200); // The retired consumer's first retry interval.
  expect(writes).toEqual([]);
});

test("legacy browser settings are adopted without opting out of startup tours", async ({ page, daemon }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ai-harness.layout", "board");
    localStorage.setItem("ai-harness.rich-text", "0");
  });
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await expect(picker(page)).toBeVisible();
  await expect(checkbox(page)).toBeChecked();
  const saved = await config(daemon);
  expect(saved.configured).toBe(true);
  expect(saved.config.showToursOnStartup).toBe(true);
  expect(saved.config).toMatchObject({ layout: "board", richText: false, guidedTour: false });
});

test("failed and delayed hydration never flash cached defaults over a saved opt-out", async ({ page, daemon }) => {
  await pin(daemon, { showToursOnStartup: false });
  await page.addInitScript(() => localStorage.setItem("mission-control.ui", JSON.stringify({ showToursOnStartup: true })));
  let gets = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/ui/config", async (route) => {
    gets++;
    if (gets === 1) await route.fulfill({ status: 503, json: { error: "offline" } });
    else { await held; await route.continue(); }
  });
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await expect.poll(() => gets).toBe(2);
  await expect(picker(page)).toBeHidden();
  release();
  await browse(page);
  await expect(checkbox(page)).toBeEnabled();
  await expect(checkbox(page)).not.toBeChecked();
  await picker(page).getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(picker(page)).toBeHidden();
});

test("manual opening before hydration disables the preference and consumes the automatic offer", async ({ page, daemon }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/ui/config", async (route) => { await held; await route.continue(); });
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await browse(page);
  await expect(checkbox(page)).toBeDisabled();
  await expect(picker(page)).toContainText("Loading your saved preference");
  await picker(page).getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(page.locator(".gear-btn")).toBeFocused();
  release();
  await browse(page);
  await expect(checkbox(page)).toBeEnabled();
  await picker(page).getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(picker(page)).toBeHidden();
});

for (const startDirectly of [false, true]) {
  test(`pending startup ${startDirectly ? "is cancelled by a direct tour launch" : "waits for another overlay to close"}`, async ({ page, daemon }) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/ui/config", async (route) => { await held; await route.continue(); });
    await page.goto(`${daemon.baseURL}/#/fleet`);
    await page.keyboard.press("Meta+k");
    const palette = page.getByRole("dialog", { name: "Search everything" });
    await expect(palette).toBeVisible();
    if (startDirectly) {
      await palette.getByRole("combobox").fill("Start Author what runs tour");
      await palette.getByRole("option", { name: /Start Author what runs tour, command/ }).click();
      await expect(page.locator(".driver-popover")).toBeVisible();
    }
    release();
    await expect(picker(page)).toBeHidden();
    if (startDirectly) {
      await page.getByRole("button", { name: "Exit tour" }).click();
      await expect(page.locator(".driver-popover")).toBeHidden();
      await expect(picker(page)).toBeHidden();
    } else {
      await page.keyboard.press("Escape");
      await expect(picker(page)).toBeVisible();
    }
  });
}

for (const entry of TOUR_ENTRIES) {
  test(`catalog explicitly starts ${entry.title} once at its actual first stop`, async ({ page, daemon }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    // Library's own route also exercises accepted same-route preflight.
    const route = entry.id === "library" ? "library" : "fleet";
    await page.goto(`${daemon.baseURL}/#/${route}`);
    await picker(page).getByRole("radio", { name: entry.title, exact: true }).check();
    await expect(page.locator(".driver-popover")).toHaveCount(0);
    await picker(page).getByRole("button", { name: "Start this tour" }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await expect(picker(page)).toBeHidden();
    const first = page.locator(".driver-popover");
    await expect(first).toHaveCount(1);
    await expect(first).toContainText(TOUR_DEFINITIONS[entry.id].steps[0]!.title);
    await expect(first).toContainText(`Step 1 of ${TOUR_DEFINITIONS[entry.id].steps.length}`);
    await page.keyboard.press("Meta+k");
    await expect(page.getByRole("dialog", { name: "Search everything" })).toBeHidden();
    await first.getByRole("button", { name: "Exit tour" }).click();
    await expect(first).toBeHidden();
    await expect(picker(page)).toBeHidden();
    if (entry.id === "workflows") {
      // This tour's exit landing is the Runs rail's All chip. Whether the rail exists at
      // this instant depends on whether the demo-run seed has landed yet, so the focus
      // landing is timing-dependent here; what a fresh catalog can assert deterministically
      // is the handed-over route itself.
      await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/runs");
    } else {
      await expect(entry.exit ? page.locator("#settings-tab-trust") : page.locator(".gear-btn")).toBeFocused();
    }
    await expect.poll(async () => {
      const tasks = await (await fetch(`${daemon.baseURL}/api/tasks`)).json() as Array<{ status: string }>;
      return tasks.filter((task) => task.status !== "done");
    }).toEqual([]);
  });
}

test("keyboard selection, focus containment and manual dismissal preserve the invoker", async ({ page, daemon }) => {
  await page.goto(`${daemon.baseURL}/#/settings/display`);
  await picker(page).getByRole("button", { name: "Dismiss", exact: true }).click();
  const invoker = page.getByRole("button", { name: "Browse tours", exact: true });
  await invoker.click();
  const radios = picker(page).getByRole("radio");
  await expect(radios.first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(radios.nth(1)).toBeChecked();
  await page.keyboard.press("Tab");
  await expect(picker(page).getByRole("button", { name: "Start this tour" })).toBeFocused();
  await picker(page).getByRole("button", { name: "Dismiss", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(picker(page).getByRole("button", { name: "Close tour picker" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(picker(page).getByRole("button", { name: "Dismiss", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(invoker).toBeFocused();
  await browse(page);
  await page.keyboard.press("Escape");
  await expect(invoker).toBeFocused();
});

test("dirty draft Cancel and Leave keep the preview, requiring Start again", async ({ page, daemon }) => {
  await pin(daemon, { showToursOnStartup: false });
  await page.goto(`${daemon.baseURL}/#/library/personas/new`);
  const name = page.getByRole("textbox", { name: "Name", exact: true });
  await name.fill("Unsaved tour test");
  await browse(page);
  await picker(page).getByRole("radio", { name: "Author what runs" }).check();
  await picker(page).getByRole("button", { name: "Start this tour" }).click();
  const leave = page.getByRole("dialog", { name: "Leave with unsaved changes" });
  await expect(leave).toBeVisible();
  await expectContentClearsBorder(leave);
  await expect(page.locator(".driver-popover")).toHaveCount(0);
  await leave.getByRole("button", { name: "Cancel", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(leave.getByRole("button", { name: "Discard and leave" })).toBeFocused();
  await leave.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(name).toHaveValue("Unsaved tour test");
  await expect(picker(page).getByRole("radio", { name: "Author what runs" })).toBeChecked();
  await picker(page).getByRole("button", { name: "Start this tour" }).click();
  await leave.getByRole("button", { name: "Discard and leave" }).click();
  expect(await hash(page)).toBe("#/library");
  await expect(picker(page)).toBeVisible();
  await expect(page.locator(".driver-popover")).toHaveCount(0);
  await picker(page).getByRole("button", { name: "Start this tour" }).click();
  await expect(page.locator(".driver-popover")).toContainText("The Library");
  await page.getByRole("button", { name: "Exit tour" }).click();
});

test("rejected save after dismissal and navigation reports once without stealing route or focus; retry persists", async ({ page, daemon }) => {
  expect((await config(daemon)).config.alerts.notifications).toBe(false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${daemon.baseURL}/#/fleet`);
  const write = await holdWrite(page);
  await checkbox(page).uncheck();
  await write.pending;
  await expect(checkbox(page)).toBeDisabled();
  await expect(picker(page)).toContainText("Saving…");
  await picker(page).getByRole("button", { name: "Dismiss", exact: true }).click();
  const library = page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: /Library/ });
  await library.click();
  await library.focus();
  await write.reject();
  const notice = page.locator(".app-banner-error");
  await expect(page.getByRole("alert").filter({ hasText: ERROR })).toHaveCount(1);
  await expect(notice).toContainText(ERROR);
  await expect(picker(page)).toBeHidden();
  expect(await hash(page)).toBe("#/library");
  await expect(library).toBeFocused();
  expect((await config(daemon)).config.showToursOnStartup).toBe(true);
  await screenshot(page, "preference-rejected-narrow");
  for (const [name, description] of [
    ["Browse tours", "Reopen the tour picker to retry saving your preference"],
    ["Dismiss", "Dismiss this notice without changing your saved preference"],
  ] as const) {
    const control = notice.getByRole("button", { name, exact: true });
    await control.hover();
    await expect(page.locator(".tooltip").filter({ hasText: description })).toBeVisible();
    await expect(control).toHaveAccessibleDescription(description);
  }
  await notice.getByRole("button", { name: "Browse tours" }).click();
  await expect(checkbox(page)).toBeChecked();
  await expect(picker(page).getByRole("alert")).toHaveText(ERROR);
  await expect(notice).toHaveCount(0);
  await checkbox(page).uncheck();
  await expect(checkbox(page)).toBeEnabled();
  await expect(page.getByRole("alert").filter({ hasText: ERROR })).toHaveCount(0);
  expect((await config(daemon)).config.showToursOnStartup).toBe(false);
  await page.reload();
  await expect(page.getByRole("button", { name: "Dispatch", exact: true })).toBeVisible();
  await expect(picker(page)).toBeHidden();
});

test("reopening a pending save stays disabled; inline rejection survives dismissal and notice Dismiss only clears error", async ({ page, daemon }) => {
  await page.goto(`${daemon.baseURL}/#/fleet`);
  const write = await holdWrite(page);
  await checkbox(page).uncheck();
  await write.pending;
  await picker(page).getByRole("button", { name: "Dismiss", exact: true }).click();
  await browse(page);
  await expect(checkbox(page)).toBeDisabled();
  await expect(picker(page)).toContainText("Saving…");
  await write.reject();
  await expect(checkbox(page)).toBeChecked();
  await expect(picker(page).getByRole("alert")).toHaveText(ERROR);
  await screenshot(page, "preference-rejected-inline");
  await picker(page).getByRole("button", { name: "Dismiss", exact: true }).click();
  const notice = page.locator(".app-banner-error");
  await expect(notice.getByRole("alert")).toHaveText(ERROR);
  await notice.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(notice).toHaveCount(0);
  expect((await config(daemon)).config.showToursOnStartup).toBe(true);
  await expect(picker(page)).toBeHidden();
});

for (const owner of ["tour", "overlay"]) {
  test(`a rejected pending save waits for the active ${owner} before showing the notice`, async ({ page, daemon }) => {
    await page.goto(`${daemon.baseURL}/#/fleet`);
    const write = await holdWrite(page);
    await checkbox(page).uncheck();
    await write.pending;
    if (owner === "tour") {
      await picker(page).getByRole("button", { name: "Start this tour" }).click();
      await expect(page.locator(".driver-popover")).toBeVisible();
    } else {
      await picker(page).getByRole("button", { name: "Dismiss", exact: true }).click();
      await page.keyboard.press("Meta+k");
      await expect(page.getByRole("dialog", { name: "Search everything" })).toBeVisible();
    }
    await write.reject();
    await expect(page.locator(".app-banner-error")).toHaveCount(0);
    if (owner === "tour") await page.getByRole("button", { name: "Exit tour" }).click();
    else await page.keyboard.press("Escape");
    await expect(page.locator(".app-banner-error").getByRole("alert")).toHaveText(ERROR);
    await expect(picker(page)).toBeHidden();
  });
}

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 1024, height: 600 }]) {
  test(`picker fits ${viewport.width}x${viewport.height}, light/dark OS modes and reduced motion`, async ({ page, daemon }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
    await page.goto(`${daemon.baseURL}/#/fleet`);
    await expect(picker(page)).toBeVisible();
    await expectContentClearsBorder(picker(page));
    await screenshot(page, `picker-${viewport.width}-dark`);
    await page.emulateMedia({ colorScheme: "light" });
    await expectContentClearsBorder(picker(page));
    // Browser zoom changes the CSS viewport; exercise a 125% equivalent reflow as well.
    await page.setViewportSize({ width: Math.round(viewport.width / 1.25), height: Math.round(viewport.height / 1.25) });
    await expectContentClearsBorder(picker(page));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await picker(page).getByRole("button", { name: "Start this tour" }).scrollIntoViewIfNeeded();
    await expect(picker(page).getByRole("button", { name: "Start this tour" })).toBeInViewport();
    await expect(picker(page).getByRole("button", { name: "Close tour picker" })).toBeInViewport();
    await expect(picker(page).getByRole("button", { name: "Dismiss", exact: true })).toBeInViewport();
    await screenshot(page, `picker-${viewport.width}-light-zoom`);
  });
}

test("development StrictMode replay offers only once per document", async ({ page, daemon }) => {
  const dev = await startDevDashboard(daemon);
  try {
    await page.goto(`${dev.origin}/#/fleet`);
    await expect(picker(page)).toHaveCount(1);
    await picker(page).getByRole("button", { name: "Dismiss", exact: true }).click();
    await page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: /Library/ }).click();
    await expect(picker(page)).toBeHidden();
    await page.reload();
    await expect(picker(page)).toHaveCount(1);
  } finally { dev.stop(); }
});
