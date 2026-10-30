import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import type { ResidentProfile } from "../../src/shared/residents.ts";
import type { Task } from "../../src/shared/types.ts";

async function request<T>(daemon: DaemonHandle, path: string, body?: unknown, method = "POST"): Promise<T> {
  const response = await fetch(daemon.baseURL + path, body === undefined && method === "GET" ? {} : {
    method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}
type Run = { id: string; profile_revision: number; iteration: number; loop_state: string; pause_reason: string | null; next_wake_at: number | null };
function live(daemon: DaemonHandle): Run | undefined {
  return withDaemonDb(daemon, db => db.prepare("SELECT * FROM resident_runs WHERE ended_at IS NULL AND launch_state = 'launched'").get() as Run | undefined);
}
type Surface = "card" | "band" | "dock" | "page";
async function surface(page: Page, daemon: DaemonHandle, profile: ResidentProfile, kind: Surface): Promise<Locator> {
  await page.keyboard.press("Escape");
  if (kind === "page") {
    await page.goto(`${daemon.baseURL}/#/residents/${profile.id}`);
    return page.getByRole("region", { name: `Live run of ${profile.name}` });
  }
  await page.goto(`${daemon.baseURL}/#/fleet`);
  if (kind === "card") {
    const card = page.locator(".tile.is-resident");
    await expect(card).toContainText("Native backstop: unavailable");
    await card.getByRole("button", { name: "Resident controls" }).click();
    return page.getByRole("menu", { name: "Resident controls" });
  }
  await page.getByRole("button", { name: "Residents - 1 live", exact: true }).click();
  const dock = page.getByRole("dialog", { name: "Residents", exact: true });
  if (kind === "dock") return dock;
  await dock.getByRole("button", { name: `Open ${profile.name}` }).click();
  return page.getByRole("group", { name: `Resident ${profile.name}` });
}
async function capture(page: Page, name: string) {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  const dir = artifactsDir(process.env.MC_E2E_RESIDENT_EVIDENCE_TOPIC ?? "residents-loop"); mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}${name}.png` });
}

for (const kind of ["card", "band", "dock", "page"] as const) test(`${kind}: loop, guardrail, Pause, Resume, Run now and Restart on new profile`, async ({ dashboard: page, daemon }) => {
  const personas = await request<Array<{ id: string; name: string }>>(daemon, "/api/personas", undefined, "GET");
  const persona = personas.find(p => p.name === "Code Risk Reviewer")!;
  expect(persona).toBeTruthy();
  const profile = await request<ResidentProfile>(daemon, "/api/residents/profiles", { settings: {
    identity: { name: `Loop ${kind}` }, persona: { personaId: persona.id }, workspace: { defaultRepoRoot: daemon.repo },
    loop: { delaySeconds: 2, minDelaySeconds: 1, maxDelaySeconds: 3600, iterationCap: 3 },
  } });
  await request(daemon, "/api/ui/config", { layout: "board" }, "PUT");
  await page.reload();
  await request(daemon, `/api/residents/profiles/${profile.id}/launch`, { repoRoot: daemon.repo, requestId: `launch-${kind}` });
  // Real built daemon and fake CLI: each completion schedules the next turn, then cap three stops it.
  await expect.poll(() => live(daemon)?.loop_state, { timeout: 60_000 }).toBe("paused");
  expect(live(daemon)?.iteration).toBe(3); expect(live(daemon)?.pause_reason).toContain("Iteration guardrail");
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await page.locator("button.pulse-seg", { hasText: "to answer" }).click();
  const inbox = page.getByRole("dialog", { name: "Attention inbox" });
  await expect(inbox).toContainText("Iteration guardrail");
  await expectContentClearsBorder(inbox);
  await page.keyboard.press("Escape");
  let host = await surface(page, daemon, profile, kind);
  const role = kind === "card" ? "menuitem" as const : "button" as const;
  if (kind !== "card") await expect(host).toContainText("Iteration guardrail");
  await host.getByRole(role, { name: "Resume", exact: true }).click();
  await expect(host.getByRole("alert")).toContainText("Resume after");
  if (kind === "dock") {
    const row = host.locator(".residents-pop-row").filter({ has: page.getByRole("button", { name: `Open ${profile.name}`, exact: true }) });
    const name = await row.locator(".residents-pop-name").boundingBox();
    const status = await row.getByLabel("Resident loop status").boundingBox();
    const bounds = await row.boundingBox();
    expect(name!.width, "the live resident's name keeps readable room").toBeGreaterThan(80);
    expect(status!.width, "status spans the dock row rather than squeezing the name").toBeGreaterThan(bounds!.width * 0.9);
    expect(status!.y).toBeGreaterThanOrEqual(name!.y + name!.height);
  }
  await capture(page, `${kind}-guardrail`);
  // Move only the disposable fixture's counted window, then exercise the real control route.
  withDaemonDb(daemon, db => db.prepare("UPDATE resident_iterations SET claimed_at = ?").run(Date.now() - 86_400_001));
  await host.getByRole(role, { name: "Resume", exact: true }).click();
  await expect(host.getByRole(role, { name: "Pause", exact: true })).toBeEnabled();
  await host.getByRole(role, { name: "Pause", exact: true }).click();
  await expect.poll(() => live(daemon)?.loop_state).toBe("paused");
  const before = live(daemon)!.iteration;
  await host.getByRole(role, { name: "Run now", exact: true }).click();
  await expect.poll(() => live(daemon)?.iteration).toBe(before + 1);
  if (kind === "card") host = await surface(page, daemon, profile, kind);
  await host.getByRole(role, { name: "Pause", exact: true }).click();
  await expect.poll(() => live(daemon)?.loop_state).toBe("paused");
  await page.keyboard.press("Escape");

  // An actual editor save exercises the loop fields as well as the pinned-revision notice.
  await page.goto(`${daemon.baseURL}/#/residents/${profile.id}`);
  const editor = page.getByRole("region", { name: `Resident profile ${profile.name}`, exact: true });
  await expect(editor).toContainText("Native backstop: unavailable on this harness");
  await editor.getByLabel("Wake cadence (seconds)").fill("300");
  await editor.getByLabel("Iterations per 24 hours").fill("200");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toContainText("Revision 2");
  expect(live(daemon)?.profile_revision).toBe(1);
  // All four places expose the same restart on the old revision, before exercising this one.
  for (const check of ["card", "band", "dock", "page"] as const) {
    const view = await surface(page, daemon, profile, check);
    await expect(view.getByRole(check === "card" ? "menuitem" : "button", { name: "Restart on new profile", exact: true })).toBeVisible();
    if (check === "card") await page.keyboard.press("Escape");
  }
  host = await surface(page, daemon, profile, kind);
  const old = live(daemon)!.id;
  await host.getByRole(role, { name: "Restart on new profile", exact: true }).click();
  await expect.poll(() => live(daemon)?.profile_revision, { timeout: 60_000 }).toBe(2);
  expect(live(daemon)!.id).not.toBe(old);
  await expect.poll(() => live(daemon)?.loop_state).toBe("waiting");
  expect(live(daemon)?.iteration).toBe(1);
  host = await surface(page, daemon, profile, kind);
  await expect(host.getByRole(role, { name: "Restart on new profile", exact: true })).toHaveCount(0);
  if (kind === "card") await page.keyboard.press("Escape");
  else await expect(host).toContainText("next in");
  await capture(page, `${kind}-restarted`);
  // Leave the fixture paused at the end of the page scenario.
  if (kind === "page") {
    await page.goto(`${daemon.baseURL}/#/fleet`);
    await request(daemon, `/api/residents/runs/${live(daemon)!.id}/pause`);
  }
});

test("a daemon crash rearms one overdue wake and a second restart preserves the guardrail pause", async ({ daemon, dashboard: page }) => {
  const personas = await request<Array<{ id: string; name: string }>>(daemon, "/api/personas", undefined, "GET");
  const profile = await request<ResidentProfile>(daemon, "/api/residents/profiles", { settings: {
    identity: { name: "Restart watcher" }, persona: { personaId: personas.find(p => p.name === "Code Risk Reviewer")!.id },
    loop: { delaySeconds: 3, minDelaySeconds: 1, iterationCap: 2 },
  } });
  await request(daemon, `/api/residents/profiles/${profile.id}/launch`, { repoRoot: daemon.repo, requestId: "restart-probe" });
  await expect.poll(() => live(daemon)?.loop_state).toBe("waiting");
  expect(live(daemon)!.iteration).toBe(1);
  await daemon.crash();
  withDaemonDb(daemon, db => db.prepare("UPDATE resident_runs SET next_wake_at = ? WHERE ended_at IS NULL").run(Date.now() - 1));
  await daemon.restart();
  await expect.poll(() => live(daemon)?.loop_state, { timeout: 60_000 }).toBe("paused");
  expect(live(daemon)!.iteration).toBe(2);
  const deliveries = withDaemonDb(daemon, db => db.prepare("SELECT seq, delivery FROM resident_iterations ORDER BY seq").all());
  expect(deliveries).toEqual([{ seq: 1, delivery: "sent" }, { seq: 2, delivery: "sent" }]);
  await daemon.crash(); await daemon.restart();
  await page.goto(`${daemon.baseURL}/#/residents/${profile.id}`);
  await expect(page.getByRole("region", { name: "Live run of Restart watcher" })).toContainText("paused · iteration 2");
  expect(live(daemon)!.iteration).toBe(2);
  await capture(page, "daemon-restart-paused");
});

test("Restart on new profile preserves a resident's no-repository workspace mode", async ({ daemon, dashboard: page }) => {
  const personas = await request<Array<{ id: string; name: string }>>(daemon, "/api/personas", undefined, "GET");
  const profile = await request<ResidentProfile>(daemon, "/api/residents/profiles", { settings: {
    identity: { name: "Workspace watcher" }, persona: { personaId: personas.find(p => p.name === "Code Risk Reviewer")!.id },
  } });
  await request(daemon, `/api/residents/profiles/${profile.id}/launch`, { repoRoot: null, requestId: "workspace-restart" });
  await expect.poll(() => live(daemon)?.loop_state).toBe("waiting");
  const old = live(daemon)!.id;
  await request(daemon, `/api/residents/runs/${old}/pause`);
  const oldTask = (await request<Task[]>(daemon, "/api/tasks", undefined, "GET")).find(task => task.kind === "resident")!;
  expect(oldTask.workspaceKind).toBe("resident-workspace");
  await page.goto(`${daemon.baseURL}/#/residents/${profile.id}`);
  const editor = page.getByRole("region", { name: "Resident profile Workspace watcher", exact: true });
  await editor.getByLabel("Wake cadence (seconds)").fill("600");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toContainText("Revision 2");
  const host = page.getByRole("region", { name: "Live run of Workspace watcher" });
  const [response] = await Promise.all([
    page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith(`/runs/${old}/restart`)),
    host.getByRole("button", { name: "Restart on new profile", exact: true }).click(),
  ]);
  expect(response.ok(), await response.text()).toBeTruthy();
  await expect.poll(() => live(daemon)?.profile_revision).toBe(2);
  const tasks = await request<Task[]>(daemon, "/api/tasks", undefined, "GET");
  const fresh = tasks.find(task => task.kind === "resident" && task.status === "running")!;
  expect(fresh.workspaceKind).toBe("resident-workspace");
  expect(fresh.repoRoot).not.toBe(oldTask.repoRoot);
  expect(fresh.branch).toBeNull();
  expect(tasks.find(task => task.id === oldTask.id)?.status).toBe("done");
  await expect(host).toContainText("iteration 1");
  await capture(page, "workspace-restarted");
});
