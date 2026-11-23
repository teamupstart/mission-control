import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { ResidentProfile } from "../../src/shared/residents.ts";

/**
 * A resident's card in the Residents drawer is edged in the color of the Board column its
 * session sits in: Working's color while it works, Needs you's while it waits on you, and its
 * own marker color otherwise. The colors are the skin's own `--working` and `--attention`, so
 * the card follows the theme.
 *
 * No model tokens are spent: every agent binary is redirected by `e2e/fixtures/fake-agents.ts`.
 * The resident is put to work by its `UserPromptSubmit` hook, and its question is posted on
 * `POST /mcp/reviews`, the channel its own `request_input` tool uses.
 */

const EVIDENCE = artifactsDir("residents-drawer-state-color");
const NAME = "Tone keeper";

async function capture(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
}

async function request<T>(daemon: DaemonHandle, path: string, body?: unknown, method = "POST"): Promise<T> {
  const response = await fetch(daemon.baseURL + path, body === undefined && method === "GET" ? {} : {
    method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}

function token(daemon: DaemonHandle): string {
  return readFileSync(join(daemon.home, "token"), "utf8").trim();
}

function waitingResidents(daemon: DaemonHandle): number {
  return withDaemonDb(daemon, (db) => (db.prepare(
    "SELECT COUNT(*) AS n FROM resident_runs WHERE ended_at IS NULL AND launch_state = 'launched' AND loop_state = 'waiting'",
  ).get() as { n: number }).n);
}

/** Author a profile and launch it through the real routes, and wait until its loop is waiting. */
async function launch(daemon: DaemonHandle, name = NAME): Promise<void> {
  const before = waitingResidents(daemon);
  const personas = await request<Array<{ id: string; name: string }>>(daemon, "/api/personas", undefined, "GET");
  const profile = await request<ResidentProfile>(daemon, "/api/residents/profiles", { settings: {
    identity: { name }, persona: { personaId: personas.find((p) => p.name === "Code Risk Reviewer")!.id },
    workspace: { defaultRepoRoot: daemon.repo },
    execution: { model: "claude-fable-5" },
    // A long cadence keeps the resident waiting between steps instead of iterating under the test.
    loop: { delaySeconds: 3600, minDelaySeconds: 60, maxDelaySeconds: 3600 },
  } });
  await request(daemon, `/api/residents/profiles/${profile.id}/launch`, {
    repoRoot: daemon.repo, requestId: `launch-${name.toLowerCase().replace(/\W+/g, "-")}`,
  });
  await expect.poll(() => waitingResidents(daemon), { timeout: 60_000 }).toBe(before + 1);
}

interface LiveSession { id: string; cwd: string | null; agent: string; agentSessionId: string | null }

async function residentSession(daemon: DaemonHandle, sessionId: string): Promise<LiveSession> {
  const sessions = await request<LiveSession[]>(daemon, "/api/sessions", undefined, "GET");
  const session = sessions.find((s) => s.id === sessionId);
  expect(session?.cwd, "the resident session has a workspace").toBeTruthy();
  return session!;
}

/** The resident's own lifecycle hook, as its agent would post it. */
async function hook(daemon: DaemonHandle, session: LiveSession, event: string): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/hooks/${event}`, {
    method: "POST", headers: { "content-type": "application/json", "x-harness-token": token(daemon) },
    body: JSON.stringify({ agent: session.agent, cwd: session.cwd, sessionId: session.agentSessionId ?? session.id, env: {}, prompt: "carry on" }),
  });
  expect(response.status, await response.clone().text()).toBe(204);
}

/** Stand in for the resident calling its bundled `request_input` tool. Returns the review id. */
async function askResident(daemon: DaemonHandle, session: LiveSession): Promise<string> {
  const response = await fetch(`${daemon.baseURL}/mcp/reviews`, {
    method: "POST", headers: { "content-type": "application/json", "x-harness-token": token(daemon) },
    body: JSON.stringify({
      env: {}, cwd: session.cwd, kind: "input", title: "Ship the nightly migration?", body: "Ship the nightly migration?",
      decisions: [{ id: "q", question: "Ship the nightly migration?", options: [
        { id: "yes", label: "Ship it" }, { id: "no", label: "Hold it" },
      ], allowOther: false }],
    }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { id: string }).id;
}

/** Opt this spec's dashboard into the Residents drawer, closed, on the Board, and land on the fleet. */
async function useDrawer(page: Page, daemon: DaemonHandle): Promise<void> {
  const config = { residentPlacement: "drawer", residentDrawerPinned: false, layout: "board" };
  await request(daemon, "/api/ui/config", config, "PUT");
  await page.evaluate((next) => {
    const raw = JSON.parse(window.localStorage.getItem("mission-control.ui") ?? "{}") as Record<string, unknown>;
    window.localStorage.setItem("mission-control.ui", JSON.stringify({ ...raw, ...next }));
  }, config);
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await page.reload();
  await expect(page.getByRole("button", { name: "Dispatch", exact: true })).toBeVisible();
}

const drawerOf = (page: Page): Locator => page.getByRole("complementary", { name: "Residents", exact: true });
const cardOf = (drawer: Locator, name = NAME): Locator =>
  drawer.getByRole("listitem").filter({ has: drawer.page().getByRole("button", { name: new RegExp(`^${name}, `) }) });
const edgeTab = (page: Page): Locator => page.getByRole("button", { name: /^Open the Residents drawer - / });

/** A skin custom property, resolved to the `rgb(...)` a border reports. */
async function skinColor(page: Page, property: "--working" | "--attention"): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, property);
}

/** The four edges of the card, which must all be one color. */
async function borderOf(card: Locator): Promise<string[]> {
  return card.evaluate((el) => {
    const style = getComputedStyle(el);
    return [style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor];
  });
}

test("a working resident's card is edged in the Working color, and one that needs you in the Needs you color, in each skin", async ({ dashboard: page, daemon }) => {
  await launch(daemon);
  await useDrawer(page, daemon);

  await page.getByRole("button", { name: "Residents - 1 live", exact: true }).click();
  const drawer = drawerOf(page);
  const card = cardOf(drawer);
  await expect(card).toBeVisible();
  const sessionId = await card.getAttribute("data-resident-card");
  const session = await residentSession(daemon, sessionId!);

  const working = await skinColor(page, "--working");
  const attention = await skinColor(page, "--attention");
  expect(working).not.toBe(attention);

  // Waiting between iterations, it is neither: its edge is not either column's color.
  for (const edge of await borderOf(card)) {
    expect(edge).not.toBe(working);
    expect(edge).not.toBe(attention);
  }

  await hook(daemon, session, "UserPromptSubmit");
  await expect(card.getByRole("button", { name: `${NAME}, working` })).toBeVisible();
  await expect.poll(() => borderOf(card)).toEqual([working, working, working, working]);
  await capture(page, "01-working");

  await askResident(daemon, session);
  await expect(card.getByRole("button", { name: `${NAME}, to review` })).toBeVisible();
  await expect.poll(() => borderOf(card)).toEqual([attention, attention, attention, attention]);
  await capture(page, "02-needs-you");

  // Another skin brings its own colors, and the card follows them. The drawer is still open on
  // the way back to Fleet: open lasts the page load, not just the page.
  await page.goto(`${daemon.baseURL}/#/settings/display`);
  await page.getByRole("radiogroup", { name: "Skin" }).getByRole("radio", { name: "Daylight", exact: true }).check();
  await expect(page.locator("html")).toHaveAttribute("data-skin", "daylight");
  await page.getByRole("button", { name: /Fleet/ }).first().click();
  await expect(card).toBeVisible();
  const daylightAttention = await skinColor(page, "--attention");
  expect(daylightAttention).not.toBe(attention);
  await expect.poll(() => borderOf(card)).toEqual([daylightAttention, daylightAttention, daylightAttention, daylightAttention]);
  await capture(page, "03-needs-you-daylight");
});

test("the closed drawer's ⌂ tab lights blue while a resident works, amber while one needs you, and both at once", async ({ dashboard: page, daemon }) => {
  const OTHER = "Bell keeper";
  await launch(daemon);
  await launch(daemon, OTHER);
  await useDrawer(page, daemon);

  // The session ids, read off the cards, then the drawer is closed so only the tab shows.
  await page.getByRole("button", { name: "Residents - 2 live", exact: true }).click();
  const drawer = drawerOf(page);
  const working = await residentSession(daemon, (await cardOf(drawer).getAttribute("data-resident-card"))!);
  const asking = await residentSession(daemon, (await cardOf(drawer, OTHER).getAttribute("data-resident-card"))!);
  await drawer.getByRole("button", { name: "Close", exact: true }).click();
  const tab = edgeTab(page);
  await expect(tab).toBeVisible();

  const workingColor = await skinColor(page, "--working");
  const attentionColor = await skinColor(page, "--attention");
  const tabColors = (): Promise<{ edge: string; glyph: string; shadow: string }> => tab.evaluate((el) => {
    const style = getComputedStyle(el);
    return { edge: style.borderTopColor, glyph: style.color, shadow: style.boxShadow };
  });
  const ring = (color: string): string => `${color} 0px 0px 0px 2px`;

  // Both residents waiting: the tab is unlit.
  expect((await tabColors()).edge).not.toBe(workingColor);
  expect((await tabColors()).edge).not.toBe(attentionColor);

  await hook(daemon, working, "UserPromptSubmit");
  await expect(tab).toHaveAccessibleName("Open the Residents drawer - 2 live, a resident is working");
  await expect.poll(tabColors).toMatchObject({ edge: workingColor, glyph: workingColor });
  expect((await tabColors()).shadow).not.toContain(ring(workingColor));
  await capture(page, "04-tab-working");

  // One needs you while the other works: Needs you takes the edge and the glyph, and Working
  // stays lit as a second edge around it.
  const reviewId = await askResident(daemon, asking);
  await expect(tab).toHaveAccessibleName("Open the Residents drawer - 2 live, a resident needs you, a resident is working");
  await expect.poll(tabColors).toMatchObject({ edge: attentionColor, glyph: attentionColor });
  expect((await tabColors()).shadow).toContain(ring(workingColor));
  await capture(page, "05-tab-needs-you-and-working");

  // Answered, the tab is back to Working alone.
  await request(daemon, `/api/reviews/${reviewId}/resolve`, { action: "dismiss" });
  await expect(tab).toHaveAccessibleName("Open the Residents drawer - 2 live, a resident is working");
  await expect.poll(tabColors).toMatchObject({ edge: workingColor, glyph: workingColor });
});
