import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../fixtures/test.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

// Only the agent is faked. Publication, session attribution, SSE and the reader are real.
test("a ship session publishes separate reports and its Scouts tab refreshes live", async ({ dashboard, daemon }) => {
  // Exercise archive cleanup with a disposable Git checkout, without depending on the
  // host-wide occupancy scan used to return native pool leases.
  const pool = await fetch(`${daemon.baseURL}/api/worktrees/config`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }),
  });
  expect(pool.ok, await pool.text()).toBe(true);
  await dashboard.getByRole("button", { name: "Dispatch", exact: true }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("Prepare to publish two requested scout reports");
  await dialog.getByLabel("Kind").selectOption("ship");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  let source: { id: string; state: string; agentSessionId: string | null } | undefined;
  await expect.poll(async () => {
    const rows = await (await fetch(`${daemon.baseURL}/api/sessions`)).json();
    source = rows.find((row: { runtime: string }) => row.runtime === "sdk");
    return !!source?.agentSessionId && source.state === "idle";
  }).toBe(true);
  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  await dashboard.keyboard.press("Shift+Y");
  const scoutsTab = dashboard.getByRole("tab", { name: /Scouts/ });
  await expect(scoutsTab).toHaveAttribute("aria-selected", "true");
  const tabOrder = [/Conversation/, /Work queue/, /Workflows/, /Scouts/, /Diff/, /Files/];
  await expect(dashboard.getByRole("tab")).toHaveText(tabOrder);
  await dashboard.setViewportSize({ width: 1160, height: 900 });
  await expect(scoutsTab).toBeVisible();
  const bounds = await scoutsTab.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1160);
  await dashboard.setViewportSize({ width: 1280, height: 720 });
  await expect(dashboard.getByText("No scout reports from this session yet.")).toBeVisible();

  const publish = async (marker: string) => {
    const response = await fetch(`${daemon.baseURL}/api/sessions/${source!.id}/inject`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: marker, origin: "human", buffer: false }),
    });
    expect(response.ok, await response.text()).toBe(true);
  };
  await publish("E2E_REPORT_FIRST");
  await expect(dashboard.getByRole("button", { name: "First finding", exact: true })).toBeVisible();
  await publish("E2E_REPORT_SECOND");
  await expect(dashboard.getByRole("button", { name: "Second finding", exact: true })).toBeVisible();
  await publish("E2E_REPORT_RETRY");
  await expect.poll(async () => {
    const body = await (await fetch(`${daemon.baseURL}/api/archives?session=${source!.id}`)).json();
    return body.archives.length;
  }).toBe(2);
  const tasks = await (await fetch(`${daemon.baseURL}/api/tasks`)).json();
  expect(tasks.find((task: { sessionId: string }) => task.sessionId === source!.id)?.status).toBe("running");
  // Exercise the recovery and paging controls against real archives, with one report per
  // page. The temporary refusal stays in place until the operator explicitly retries.
  let catalogAvailable = false;
  await dashboard.route("**/api/archives?**", async (route) => {
    const url = new URL(route.request().url());
    if (!url.searchParams.has("session")) return route.continue();
    if (!catalogAvailable) return route.fulfill({ status: 503, json: { error: "Catalog temporarily unavailable" } });
    url.searchParams.set("limit", "1");
    await route.fulfill({ response: await route.fetch({ url: url.href }) });
  });
  await dashboard.getByRole("tab", { name: /Conversation/ }).click();
  await scoutsTab.click();
  const retry = dashboard.getByRole("button", { name: "Try again", exact: true });
  await retry.hover();
  await expect(dashboard.locator(".tooltip")).toHaveText("Retry loading this session's scout reports");
  catalogAvailable = true;
  await retry.click();
  const reports = dashboard.getByRole("region", { name: "Session scout reports" });
  await expect(reports.getByRole("listitem")).toHaveCount(1);
  const loadMore = reports.getByRole("button", { name: "Load more" });
  await loadMore.hover();
  await expect(dashboard.locator(".tooltip")).toHaveText("Read the next page of reports from this session");
  await loadMore.click();
  await expect(reports.getByRole("listitem")).toHaveCount(2);
  await expect(loadMore).toHaveCount(0);
  await dashboard.unroute("**/api/archives?**");
  const firstReport = dashboard.getByRole("button", { name: "First finding", exact: true });
  // A pending archive event can replace the list after paging. Hover the current
  // button again if that replacement retired the tooltip's original anchor.
  //
  // Park the pointer first on every attempt. Clicking Load more leaves it where that button
  // was, and paging lays First finding out under that exact spot, so the button arrives under
  // a pointer that never entered it. `Tooltip` opens on `mouseenter`, and hovering the centre
  // of an element the pointer is already inside fires none - so without leaving first, every
  // retry hovers in place and the bubble never opens. That is how this failed on CI, where
  // the layout puts the two in the same place.
  await expect(async () => {
    await dashboard.mouse.move(0, 0);
    await firstReport.hover();
    await expect(dashboard.locator(".tooltip")).toHaveText("Open First finding in Files", { timeout: 1000 });
  }).toPass();
  const hoverColor = await firstReport.evaluate((element) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--working)";
    element.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  await expect(firstReport).toHaveCSS("border-top-color", hoverColor);
  await dashboard.mouse.move(0, 0);
  const directory = artifactsDir("multiple-scout-reports");
  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(directory, { recursive: true });
    await dashboard.screenshot({ path: join(directory, "session-reports.png"), fullPage: true });
  }
  await dashboard.route("**/api/archives/*", (route) => route.fulfill({ status: 503, json: { error: "Report metadata unavailable" } }));
  await dashboard.getByRole("button", { name: "Second finding", exact: true }).click();
  await expect(dashboard.getByRole("alert")).toContainText("Report metadata unavailable");
  await expect(scoutsTab).toHaveAttribute("aria-selected", "true");
  await expect(dashboard.getByRole("button", { name: "Open archived Second finding", exact: true })).toBeEnabled();
  await dashboard.unroute("**/api/archives/*");
  await dashboard.getByRole("button", { name: "Second finding", exact: true }).click();
  await expect(dashboard.getByRole("tab", { name: /Files/ })).toHaveAttribute("aria-selected", "true");
  await expect(dashboard.frameLocator('iframe[title="Preview of docs/reports/second-report/report.html"]')
    .getByText("the resume path never replayed the repository grant.")).toBeVisible();
  if (process.env.MC_E2E_EVIDENCE) {
    await dashboard.screenshot({ path: join(directory, "report-files.png"), fullPage: true });
  }
  await scoutsTab.click();
  await dashboard.getByRole("button", { name: "First finding", exact: true }).click();
  await expect(dashboard.frameLocator('iframe[title="Preview of docs/reports/first-report/report.html"]')
    .getByText("the resume path never replayed the repository grant.")).toBeVisible();
  await scoutsTab.click();
  await dashboard.getByRole("button", { name: "Open archived Second finding", exact: true }).click();
  await expect(dashboard).toHaveURL(/#\/scouts\/.*session=/);
  await expect(dashboard.getByText("Source session", { exact: true })).toBeVisible();
  await dashboard.locator(".scouts-source-session").getByRole("button").hover();
  await expect(dashboard.locator(".tooltip")).toHaveText("Show reports from this session");
  await expect(dashboard.frameLocator('iframe[title^="Report"]').getByText("the resume path never replayed the repository grant.")).toBeVisible();
  await dashboard.reload();
  await expect(dashboard.getByRole("button", { name: "Clear session filter" })).toBeVisible();
  await dashboard.getByRole("button", { name: "Clear session filter" }).hover();
  await expect(dashboard.locator(".tooltip")).toHaveText("Clear the source session filter");
  await dashboard.mouse.move(0, 0);
  const rail = dashboard.getByRole("complementary", { name: "Scout archives" });
  await expect(rail.getByRole("button", { name: /^First finding / })).toBeVisible();
  await expect(rail.getByRole("button", { name: /^Second finding / })).toBeVisible();
  if (process.env.MC_E2E_EVIDENCE) {
    await dashboard.screenshot({ path: join(directory, "report-library.png"), fullPage: true });
  }
  await dashboard.getByRole("region", { name: "Scout report" }).getByRole("button", { name: "Second finding", exact: true }).click();
  const rename = dashboard.getByLabel("Rename scout");
  await rename.fill("Second finding renamed");
  await rename.press("Enter");
  await expect(rail.getByRole("button", { name: /^Second finding renamed / })).toBeVisible();
  await expect(rail.getByRole("button", { name: /^First finding / })).toBeVisible();
  await dashboard.getByRole("button", { name: "Delete scout", exact: true }).click();
  const deletion = dashboard.getByRole("dialog", { name: /Delete the scout archive/ });
  await expectContentClearsBorder(deletion);
  await deletion.getByRole("textbox").fill("DELETE");
  await deletion.getByRole("button", { name: "Delete scout", exact: true }).click();
  await expect(deletion).toBeHidden();
  await expect(rail.getByRole("button", { name: /^First finding / })).toBeVisible();
  await expect(rail.getByRole("button", { name: /^Second finding renamed / })).toHaveCount(0);
  await rail.getByRole("button", { name: /^First finding / }).click();
  await expect(dashboard.frameLocator('iframe[title^="Report"]').getByText("the resume path never replayed the repository grant.")).toBeVisible();
  await dashboard.getByRole("button", { name: "Clear session filter" }).click();
  await expect(dashboard).not.toHaveURL(/session=/);
  const layout = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ layout: "board" }),
  });
  expect(layout.ok).toBe(true);
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  // A hash-only navigation does not reload config saved directly through the API.
  await dashboard.reload();
  await expect(dashboard.locator("main.board")).toBeVisible();
  await dashboard.locator("main.board .tile:not(.pend-tile)").first().click();
  await dashboard.getByRole("tab", { name: /Scouts/ }).click();
  await expect(dashboard.getByRole("tab")).toHaveText(tabOrder);
  await expect(dashboard.getByRole("button", { name: "First finding", exact: true })).toBeVisible();
  await expect(dashboard.getByRole("button", { name: "Second finding renamed", exact: true })).toHaveCount(0);
  await dashboard.getByRole("button", { name: "First finding", exact: true }).click();
  await expect(dashboard.getByRole("tab", { name: /Files/ })).toHaveAttribute("aria-selected", "true");
  await expect(dashboard.frameLocator('iframe[title="Preview of docs/reports/first-report/report.html"]')
    .getByText("the resume path never replayed the repository grant.")).toBeVisible();
  const owner = tasks.find((task: { sessionId: string }) => task.sessionId === source!.id);
  const cancelled = await fetch(`${daemon.baseURL}/api/tasks/${owner.id}/cancel`, { method: "POST" });
  expect(cancelled.ok, await cancelled.text()).toBe(true);
  await dashboard.goto(`${daemon.baseURL}/#/scouts`);
  await dashboard.reload();
  await expect(rail.getByRole("button", { name: /^First finding / })).toBeVisible();
  await expect(rail.getByRole("button", { name: /^Second finding / })).toHaveCount(0);
  const remaining = await (await fetch(`${daemon.baseURL}/api/archives?session=${source!.id}`)).json();
  expect(remaining.archives.map((archive: { title: string }) => archive.title)).toEqual(["First finding"]);
  if (process.env.MC_E2E_EVIDENCE) {
    await dashboard.screenshot({ path: join(directory, "deleted-after-cleanup.png"), fullPage: true });
  }
});
