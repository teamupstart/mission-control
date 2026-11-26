import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { startFakeOAuthServer, type FakeOAuthServer } from "../../test/fixtures/fake-oauth-server.mjs";

// Settings > Task shaping's sign-in, end to end. The authorization server and the protected MCP
// server are the unit suite's loopback mock, run in this process: `/authorize` approves at once
// and sends the browser back to the daemon's callback. Every value is fake, the daemon keeps the
// tokens in memory (`MISSION_SHAPER_SIGN_IN_STORE=memory` in the daemon fixture), so no Keychain
// is touched, and no request leaves this machine.

const EVIDENCE = process.env.MC_E2E_EVIDENCE ? artifactsDir("shaper-sign-in") : null;
const json = { "content-type": "application/json" };

async function setFlag(daemon: DaemonHandle, id: string, enabled: boolean): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/feature-flags`, {
    method: "PUT", headers: json, body: JSON.stringify({ kind: "flag", id, enabled }),
  });
  expect(response.ok).toBe(true);
}

const panel = (window: Page): Locator => window.getByRole("region", { name: "Task shaping" });
const row = (window: Page): Locator => panel(window).getByRole("group", { name: "Signed guidance", exact: true });
const signIn = (window: Page): Locator => row(window).getByRole("group", { name: "Sign-in for Signed guidance" });

async function capture(window: Page, name: string): Promise<void> {
  if (!EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // The pointer and focus are left on the control just clicked: move both away, so its tooltip
  // does not cover the state the row shows.
  await window.mouse.move(0, 0);
  await window.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(window.locator(".tooltip")).toHaveCount(0);
  await row(window).screenshot({ path: `${EVIDENCE}${name}.png` });
}

/** Dry-run the shaper against the daemon's repository and hand back the result region. */
async function dryRun(window: Page, daemon: DaemonHandle): Promise<{ dialog: Locator; result: Locator }> {
  await window.getByRole("button", { name: "Dry-run Signed guidance" }).click();
  const dialog = window.getByRole("dialog", { name: "Dry-run Signed guidance" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Repository")).not.toHaveValue("");
  await dialog.getByLabel("Repository").fill(daemon.repo);
  await dialog.getByLabel("Prompt (optional)").click();
  await dialog.getByRole("button", { name: "Run", exact: true }).click();
  return { dialog, result: dialog.getByRole("region", { name: "Dry-run result" }) };
}

let fake: FakeOAuthServer;
test.beforeEach(async () => { fake = await startFakeOAuthServer(); });
test.afterEach(async () => { await fake.close(); });

test("an operator signs a shaper in and out from Settings, sees each state live, and the flag takes the controls away", async ({ dashboard: page, daemon }) => {
  test.setTimeout(120_000);
  await setFlag(daemon, "task-shaping", true);
  await setFlag(daemon, "shaper-sign-in", true);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`${daemon.baseURL}/#/settings/task-shaping`);

  await panel(page).getByRole("button", { name: "Import manifest…" }).click();
  const dialog = page.getByRole("dialog", { name: "Import a shaper" });
  await dialog.getByRole("textbox", { name: "Manifest" }).fill(JSON.stringify({
    id: "signed-guidance", label: "Signed guidance", stage: "select",
    transport: {
      type: "mcp", tool: "get_guidance",
      server: { type: "http", url: fake.resourceUrl, headers: {}, auth: { type: "oauth", scope: "mcp:context" } },
    },
  }, null, 2));
  await dialog.getByRole("button", { name: "Save switched off" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row(page)).toContainText(`Signs in: OAuth, scope mcp:context, at ${new URL(fake.issuer).origin}`);
  await expect(signIn(page)).toContainText("Not signed in.");
  await expect(signIn(page).getByRole("button")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Sign in Signed guidance" })).toBeEnabled();
  await capture(page, "1-not-signed-in");

  // 2. The tab the dashboard opens is kept from reaching the authorization server: Playwright
  // answers its `/authorize` with a stub page, so no code comes back and the sign-in stays
  // pending. (Holding the fixture's reply instead leaves a navigation in flight, which stalls
  // Chromium's popup and reload handling.)
  const authorizeUrl = `${new URL(fake.issuer).origin}/authorize`;
  await page.context().route(`${authorizeUrl}?**`, (route) => route.fulfill({
    status: 200, contentType: "text/html", body: "<!doctype html><title>Held</title><p>Held by the test.</p>",
  }));
  const heldTab = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Sign in Signed guidance" }).click();
  const held = await heldTab;
  await expect(signIn(page)).toContainText("Waiting for the browser.");
  await expect(signIn(page)).not.toContainText("Started in another window");
  await expect(page.getByRole("button", { name: "Open the sign-in page for Signed guidance" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy the sign-in link for Signed guidance" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel sign-in for Signed guidance" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in Signed guidance" })).toHaveCount(0);
  await held.waitForURL(`${authorizeUrl}?**`);
  // The tab cannot reach back into the dashboard: its opener was cut before the page ran.
  expect(await held.evaluate(() => window.opener === null)).toBe(true);
  const opened = new URL(held.url());
  expect(opened.searchParams.get("code_challenge_method")).toBe("S256");
  expect(opened.searchParams.get("scope")).toBe("mcp:context");
  await page.getByRole("button", { name: "Copy the sign-in link for Signed guidance" }).click();
  await expect(page.getByRole("button", { name: "Copy the sign-in link for Signed guidance" })).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(held.url());
  const again = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Open the sign-in page for Signed guidance" }).click();
  const reopened = await again;
  await reopened.waitForURL(held.url());
  expect(await reopened.evaluate(() => window.opener === null)).toBe(true);
  await capture(page, "2-pending-here");

  // A reload drops the link this window held.
  await page.reload();
  await expect(signIn(page)).toContainText("Waiting for the browser. Started in another window, or before this page was reloaded.");
  await expect(page.getByRole("button", { name: "Sign in Signed guidance" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel sign-in for Signed guidance" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open the sign-in page for Signed guidance" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Copy the sign-in link for Signed guidance" })).toHaveCount(0);
  await capture(page, "2-pending-elsewhere");

  const restartTab = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Sign in Signed guidance" }).click();
  const restarted = await restartTab;
  await restarted.waitForURL(`${authorizeUrl}?**`);
  const replacement = new URL(restarted.url());
  expect(replacement.searchParams.get("state")).toBeTruthy();
  expect(replacement.searchParams.get("state")).not.toBe(opened.searchParams.get("state"));
  expect(replacement.searchParams.get("code_challenge")).not.toBe(opened.searchParams.get("code_challenge"));
  await expect(signIn(page)).toContainText("Waiting for the browser.");
  await expect(signIn(page)).not.toContainText("Started in another window");
  await expect(page.getByRole("button", { name: "Open the sign-in page for Signed guidance" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy the sign-in link for Signed guidance" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in Signed guidance" })).toHaveCount(0);
  await page.getByRole("button", { name: "Copy the sign-in link for Signed guidance" }).click();
  await expect(page.getByRole("button", { name: "Copy the sign-in link for Signed guidance" })).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(restarted.url());
  await capture(page, "2-pending-restarted");
  // The replaced sign-in's link no longer works: the daemon's callback refuses its `state`.
  const stale = await fetch(`${daemon.baseURL}/api/shaping/sign-in/callback?state=${encodeURIComponent(opened.searchParams.get("state")!)}&code=fake-code-stale`);
  expect(stale.status).toBe(400);
  expect(await stale.text()).toContain("The sign-in did not finish.");
  await expect(signIn(page)).toContainText("Waiting for the browser.");

  await page.getByRole("button", { name: "Cancel sign-in for Signed guidance" }).click();
  await expect(signIn(page)).toContainText("Not signed in.");
  await held.close();
  await reopened.close();
  await restarted.close();
  await page.context().unroute(`${authorizeUrl}?**`);
  expect(fake.requests.some((request) => request.path === "/authorize")).toBe(false);

  const signInTab = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Sign in Signed guidance" }).click();
  const tab = await signInTab;
  await expect(tab.getByRole("heading", { name: "Signed in. You can close this tab and go back to Mission Control." })).toBeVisible();
  expect(tab.url().startsWith(`${daemon.baseURL}/api/shaping/sign-in/callback?`)).toBe(true);

  // No reload here: the row must follow the sign-in list event that the callback caused.
  await expect(signIn(page)).toContainText("Signed in until Mission Control restarts. Kept in memory.");
  await expect(page.getByRole("button", { name: "Sign out Signed guidance" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in Signed guidance" })).toHaveCount(0);
  await capture(page, "3-signed-in");
  await tab.close();

  const signedRun = await dryRun(page, daemon);
  await expect(signedRun.result).toContainText("OK", { timeout: 45_000 });
  await expect(signedRun.result.getByRole("article", { name: "Guide" })).toContainText("guidance for");
  await signedRun.dialog.getByRole("button", { name: "Close" }).click();
  await expect(signedRun.dialog).toHaveCount(0);
  expect(fake.requests.some((request) => request.path === "/mcp" && String(request.headers.authorization ?? "").startsWith("Bearer "))).toBe(true);

  await page.getByRole("button", { name: "Sign out Signed guidance" }).click();
  await expect(signIn(page)).toContainText("Not signed in.");
  await expect(page.getByRole("button", { name: "Sign in Signed guidance" })).toBeVisible();
  const signedOutRun = await dryRun(page, daemon);
  await expect(signedOutRun.result).toContainText("Unavailable", { timeout: 45_000 });
  await expect(signedOutRun.result).toContainText("Sign in at Settings > Task shaping.");
  await signedOutRun.dialog.getByRole("button", { name: "Close" }).click();
  await expect(signedOutRun.dialog).toHaveCount(0);

  await setFlag(daemon, "shaper-sign-in", false);
  await expect(signIn(page)).toContainText("Sign-in is switched off");
  await expect(signIn(page)).toContainText("(shaper-sign-in)");
  await expect(signIn(page).getByRole("button")).toHaveCount(0);
  await capture(page, "4-flag-off");
});

test("a window whose pending sign-in another window replaced stops offering its link, and offers Sign in again", async ({ dashboard: page, daemon }) => {
  test.setTimeout(120_000);
  await setFlag(daemon, "task-shaping", true);
  await setFlag(daemon, "shaper-sign-in", true);
  const put = await fetch(`${daemon.baseURL}/api/shaping`, {
    method: "PUT", headers: json, body: JSON.stringify({ kind: "upsert", shaper: {
      id: "signed-guidance", label: "Signed guidance", stage: "select",
      transport: { type: "mcp", tool: "get_guidance", server: { type: "http", url: fake.resourceUrl, headers: {}, auth: { type: "oauth", scope: "mcp:context" } } },
    } }),
  });
  expect(put.status).toBe(200);
  // Every tab either window opens is answered with a stub page, so each sign-in stays pending.
  const authorizeUrl = `${new URL(fake.issuer).origin}/authorize`;
  await page.context().route(`${authorizeUrl}?**`, (route) => route.fulfill({
    status: 200, contentType: "text/html", body: "<!doctype html><title>Held</title><p>Held by the test.</p>",
  }));
  const other = await page.context().newPage();
  await page.goto(`${daemon.baseURL}/#/settings/task-shaping`);
  await other.goto(`${daemon.baseURL}/#/settings/task-shaping`);
  await expect(signIn(page)).toContainText("Not signed in.");
  await expect(signIn(other)).toContainText("Not signed in.");

  // The first window starts a sign-in and holds its link.
  const firstTab = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Sign in Signed guidance" }).click();
  const first = await firstTab;
  await first.waitForURL(`${authorizeUrl}?**`);
  const firstState = new URL(first.url()).searchParams.get("state")!;
  await expect(signIn(page)).toContainText("Waiting for the browser.");
  await expect(page.getByRole("button", { name: "Open the sign-in page for Signed guidance" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy the sign-in link for Signed guidance" })).toBeVisible();
  await expect(signIn(other)).toContainText("Waiting for the browser. Started in another window, or before this page was reloaded.");

  // The second window signs in on the pending row, which replaces the first window's sign-in.
  const secondTab = other.waitForEvent("popup");
  await other.getByRole("button", { name: "Sign in Signed guidance" }).click();
  const second = await secondTab;
  await second.waitForURL(`${authorizeUrl}?**`);
  expect(new URL(second.url()).searchParams.get("state")).not.toBe(firstState);
  await expect(signIn(other)).toContainText("Waiting for the browser.");
  await expect(signIn(other)).not.toContainText("Started in another window");
  await expect(other.getByRole("button", { name: "Open the sign-in page for Signed guidance" })).toBeVisible();

  // The first window, with no reload, no longer offers its dead link: it reads as pending
  // elsewhere and offers Sign in and Cancel sign-in.
  await expect(signIn(page)).toContainText("Waiting for the browser. Started in another window, or before this page was reloaded.");
  await expect(page.getByRole("button", { name: "Open the sign-in page for Signed guidance" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Copy the sign-in link for Signed guidance" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign in Signed guidance" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Cancel sign-in for Signed guidance" })).toBeVisible();
  await expect(signIn(page).getByRole("alert")).toHaveCount(0);
  await capture(page, "8-replaced-elsewhere");
  // The link it dropped is the one the callback now refuses.
  const stale = await fetch(`${daemon.baseURL}/api/shaping/sign-in/callback?state=${encodeURIComponent(firstState)}&code=fake-code-stale`);
  expect(stale.status).toBe(400);
  expect(await stale.text()).toContain("The sign-in did not finish.");

  // Its Sign in starts a sign-in of its own again, and the link moves back to it.
  const thirdTab = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Sign in Signed guidance" }).click();
  await (await thirdTab).waitForURL(`${authorizeUrl}?**`);
  await expect(signIn(page)).toContainText("Waiting for the browser.");
  await expect(signIn(page)).not.toContainText("Started in another window");
  await expect(page.getByRole("button", { name: "Open the sign-in page for Signed guidance" })).toBeVisible();
  await expect(signIn(other)).toContainText("Waiting for the browser. Started in another window, or before this page was reloaded.");
  await expect(other.getByRole("button", { name: "Open the sign-in page for Signed guidance" })).toHaveCount(0);
  await expect(other.getByRole("button", { name: "Copy the sign-in link for Signed guidance" })).toHaveCount(0);

  await page.getByRole("button", { name: "Cancel sign-in for Signed guidance" }).click();
  await expect(signIn(page)).toContainText("Not signed in.");
  await expect(signIn(other)).toContainText("Not signed in.");
  await other.close();
});

test("an older sign-in reply that lands after a newer attempt on the same connection leaves the newer attempt's link in place", async ({ dashboard: page, daemon }) => {
  test.setTimeout(120_000);
  await setFlag(daemon, "task-shaping", true);
  await setFlag(daemon, "shaper-sign-in", true);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  // Two shapers on one server and scope share one connection, so one sign-in covers both rows.
  for (const [id, label] of [["signed-guidance", "Signed guidance"], ["signed-twin", "Signed twin"]]) {
    const put = await fetch(`${daemon.baseURL}/api/shaping`, {
      method: "PUT", headers: json, body: JSON.stringify({ kind: "upsert", shaper: {
        id, label, stage: "select",
        transport: { type: "mcp", tool: "get_guidance", server: { type: "http", url: fake.resourceUrl, headers: {}, auth: { type: "oauth", scope: "mcp:context" } } },
      } }),
    });
    expect(put.status).toBe(200);
  }
  const authorizeUrl = `${new URL(fake.issuer).origin}/authorize`;
  await page.context().route(`${authorizeUrl}?**`, (route) => route.fulfill({
    status: 200, contentType: "text/html", body: "<!doctype html><title>Held</title><p>Held by the test.</p>",
  }));
  await page.goto(`${daemon.baseURL}/#/settings/task-shaping`);
  const twin = panel(page).getByRole("group", { name: "Sign-in for Signed twin" });
  await expect(signIn(page)).toContainText("Not signed in.");
  await expect(twin).toContainText("Not signed in.");

  // The first row's sign-in reaches the daemon, which answers; the reply is held before this window sees it.
  let release!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  let answered!: () => void;
  const daemonAnswered = new Promise<void>((done) => { answered = done; });
  let first = true;
  await page.route("**/api/shaping/sign-in", async (route) => {
    if (route.request().method() !== "POST" || !first) return route.fallback();
    first = false;
    const response = await route.fetch();
    answered();
    await held;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Sign in Signed guidance" }).click();
  await daemonAnswered;
  await expect(twin).toContainText("Waiting for the browser. Started in another window, or before this page was reloaded.");

  // The twin row signs in too, which replaces the held attempt; its reply lands first and its link is shown on both rows.
  const tab = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Sign in Signed twin" }).click();
  const opened = await tab;
  await opened.waitForURL(`${authorizeUrl}?**`);
  await expect(twin).toContainText("Waiting for the browser.");
  await expect(twin).not.toContainText("Started in another window");
  await expect(page.getByRole("button", { name: "Open the sign-in page for Signed twin" })).toBeVisible();

  // Now the older reply lands. It names a replaced attempt, so it keeps no link of its own, and
  // it leaves the newer attempt's link where it is.
  const delivered = page.waitForResponse((response) => response.url().endsWith("/api/shaping/sign-in"));
  release();
  expect((await delivered).status()).toBe(200);
  await page.unroute("**/api/shaping/sign-in");
  await expect(page.getByRole("button", { name: "Open the sign-in page for Signed guidance" })).toBeEnabled();
  for (const label of ["Signed guidance", "Signed twin"]) {
    const rowSignIn = panel(page).getByRole("group", { name: `Sign-in for ${label}` });
    await expect(rowSignIn).toContainText("Waiting for the browser.");
    await expect(rowSignIn).not.toContainText("Started in another window");
    await expect(page.getByRole("button", { name: `Open the sign-in page for ${label}` })).toBeVisible();
    await expect(page.getByRole("button", { name: `Copy the sign-in link for ${label}` })).toBeVisible();
  }
  await page.getByRole("button", { name: "Copy the sign-in link for Signed guidance" }).click();
  await expect(page.getByRole("button", { name: "Copy the sign-in link for Signed guidance" })).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(opened.url());

  await page.getByRole("button", { name: "Cancel sign-in for Signed twin" }).click();
  await expect(twin).toContainText("Not signed in.");
  await expect(signIn(page)).toContainText("Not signed in.");
});

test("two sign-in replies on one connection that land before either list frame, the older last, leave the newer attempt's link", async ({ dashboard: page, daemon }) => {
  test.setTimeout(120_000);
  await setFlag(daemon, "task-shaping", true);
  await setFlag(daemon, "shaper-sign-in", true);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  for (const [id, label] of [["signed-guidance", "Signed guidance"], ["signed-twin", "Signed twin"]]) {
    const put = await fetch(`${daemon.baseURL}/api/shaping`, {
      method: "PUT", headers: json, body: JSON.stringify({ kind: "upsert", shaper: {
        id, label, stage: "select",
        transport: { type: "mcp", tool: "get_guidance", server: { type: "http", url: fake.resourceUrl, headers: {}, auth: { type: "oauth", scope: "mcp:context" } } },
      } }),
    });
    expect(put.status).toBe(200);
  }
  const authorizeUrl = `${new URL(fake.issuer).origin}/authorize`;
  await page.context().route(`${authorizeUrl}?**`, (route) => route.fulfill({
    status: 200, contentType: "text/html", body: "<!doctype html><title>Held</title><p>Held by the test.</p>",
  }));
  // The page's own event stream, with its sign-in list frames held on request and released in
  // the order the daemon sent them. Every other frame passes straight through.
  await page.addInitScript(() => {
    type Hold = { holding: boolean; queue: MessageEvent[]; release: () => void };
    const hold: Hold = { holding: false, queue: [], release: () => {} };
    (window as unknown as { signInFrames: Hold }).signInFrames = hold;
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        if (String(url) !== "/events") return;
        let handler: ((event: MessageEvent) => void) | null = null;
        const deliver = (event: MessageEvent) => handler?.call(this, event);
        hold.release = () => { hold.holding = false; for (const event of hold.queue.splice(0)) deliver(event); };
        super.onmessage = (event: MessageEvent) => {
          let type: unknown = null;
          try { type = (JSON.parse(String(event.data)) as { type?: unknown }).type; } catch { /* not JSON */ }
          if (hold.holding && type === "shaping_sign_ins") hold.queue.push(event);
          else deliver(event);
        };
        Object.defineProperty(this, "onmessage", {
          configurable: true,
          get: () => handler,
          set: (value: ((event: MessageEvent) => void) | null) => { handler = value; },
        });
      }
    };
  });
  await page.goto(`${daemon.baseURL}/#/settings/task-shaping`);
  await page.reload();
  const twin = panel(page).getByRole("group", { name: "Sign-in for Signed twin" });
  await expect(signIn(page)).toContainText("Not signed in.");
  await expect(twin).toContainText("Not signed in.");
  await page.evaluate(() => { (window as unknown as { signInFrames: { holding: boolean } }).signInFrames.holding = true; });
  const held = () => page.evaluate(() => (window as unknown as { signInFrames: { queue: unknown[] } }).signInFrames.queue.length);

  // Row A's sign-in begins first at the daemon; its reply is held before it reaches this window.
  let release!: () => void;
  const replyHeld = new Promise<void>((done) => { release = done; });
  let answered!: () => void;
  const daemonAnswered = new Promise<void>((done) => { answered = done; });
  let first = true;
  await page.route("**/api/shaping/sign-in", async (route) => {
    if (route.request().method() !== "POST" || !first) return route.fallback();
    first = false;
    const response = await route.fetch();
    answered();
    await replyHeld;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Sign in Signed guidance" }).click();
  await daemonAnswered;
  await expect.poll(held).toBe(1);

  // Row B's sign-in replaces A's at the daemon, and its reply lands first. The list frames are
  // still held, so both rows still read signed out.
  const tab = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Sign in Signed twin" }).click();
  const opened = await tab;
  await opened.waitForURL(`${authorizeUrl}?**`);
  await expect.poll(held).toBe(2);
  await expect(twin).toContainText("Not signed in.");

  // A's older reply lands next, still before either frame.
  const delivered = page.waitForResponse((response) => response.url().endsWith("/api/shaping/sign-in"));
  release();
  expect((await delivered).status()).toBe(200);
  await page.unroute("**/api/shaping/sign-in");
  await expect(page.getByRole("button", { name: "Sign in Signed guidance" })).toBeEnabled();
  await expect(signIn(page)).toContainText("Not signed in.");

  // The daemon's frames arrive in the order it sent them: A's attempt pending, then B's.
  await page.evaluate(() => { (window as unknown as { signInFrames: { release: () => void } }).signInFrames.release(); });
  for (const label of ["Signed guidance", "Signed twin"]) {
    const rowSignIn = panel(page).getByRole("group", { name: `Sign-in for ${label}` });
    await expect(rowSignIn).toContainText("Waiting for the browser.");
    await expect(rowSignIn).not.toContainText("Started in another window");
    await expect(page.getByRole("button", { name: `Open the sign-in page for ${label}` })).toBeVisible();
    await expect(page.getByRole("button", { name: `Copy the sign-in link for ${label}` })).toBeVisible();
  }
  // The link offered is B's, the attempt pending now.
  await page.getByRole("button", { name: "Copy the sign-in link for Signed guidance" }).click();
  await expect(page.getByRole("button", { name: "Copy the sign-in link for Signed guidance" })).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(opened.url());

  await page.getByRole("button", { name: "Cancel sign-in for Signed twin" }).click();
  await expect(twin).toContainText("Not signed in.");
});

test("a refused sign-in, an unsafe sign-in link and a refused sign-out each show in the row, open nothing, and leave the row usable", async ({ dashboard: page, daemon }) => {
  test.setTimeout(90_000);
  await setFlag(daemon, "task-shaping", true);
  await setFlag(daemon, "shaper-sign-in", true);
  const registered = await fetch(`${daemon.baseURL}/api/shaping`, {
    method: "PUT", headers: json, body: JSON.stringify({ kind: "upsert", shaper: {
      id: "signed-guidance", label: "Signed guidance", stage: "select",
      transport: {
        type: "mcp", tool: "get_guidance",
        server: { type: "http", url: fake.resourceUrl, headers: {}, auth: { type: "oauth", scope: "mcp:context" } },
      },
    } }),
  });
  expect(registered.status).toBe(200);
  await page.goto(`${daemon.baseURL}/#/settings/task-shaping`);
  await expect(signIn(page)).toContainText("Not signed in.");
  // Any tab the dashboard opens is counted: none may open for a refusal or an unsafe link.
  let tabs = 0;
  page.on("popup", () => { tabs++; });
  const signInButton = page.getByRole("button", { name: "Sign in Signed guidance" });

  await page.route("**/api/shaping/sign-in", (route) => route.fulfill({
    status: 409, contentType: "application/json",
    body: JSON.stringify({ error: "registration_limit", reason: "Refused for this test: sign out of another sign-in first." }),
  }));
  await signInButton.click();
  await expect(signIn(page).getByRole("alert")).toHaveText("Refused for this test: sign out of another sign-in first.");
  await expect(signIn(page)).toContainText("Not signed in.");
  await expect(signInButton).toBeEnabled();
  await page.unroute("**/api/shaping/sign-in");

  await page.route("**/api/shaping/sign-in", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ authorizationUrl: "http://login.attacker.example/authorize?state=fake-state", expiresAt: Date.now() + 600_000, connection: "0".repeat(32), attempt: 1 }),
  }));
  await signInButton.click();
  await expect(signIn(page).getByRole("alert")).toHaveText("The daemon's sign-in link is not https or this machine's loopback, so it was not opened. Start again, or check the shaper's server.");
  await expect(page.getByRole("button", { name: "Open the sign-in page for Signed guidance" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Copy the sign-in link for Signed guidance" })).toHaveCount(0);
  await expect(signInButton).toBeEnabled();
  await page.unroute("**/api/shaping/sign-in");
  expect(tabs).toBe(0);

  // A blocked new tab: window.open returns null.
  await page.evaluate(() => {
    const blocked = window as unknown as { realOpen?: typeof window.open };
    blocked.realOpen = window.open;
    window.open = () => null;
  });
  await signInButton.click();
  await expect(signIn(page)).toContainText("Waiting for the browser.");
  await expect(signIn(page).getByRole("alert")).toHaveText(
    "The sign-in page did not open. Use Open the sign-in page to try again, or Copy link to open it in another browser.");
  const openAgain = page.getByRole("button", { name: "Open the sign-in page for Signed guidance" });
  await expect(openAgain).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy the sign-in link for Signed guidance" })).toBeVisible();
  expect(tabs).toBe(0);
  await capture(page, "5-tab-blocked");
  await page.evaluate(() => {
    const blocked = window as unknown as { realOpen?: typeof window.open };
    window.open = blocked.realOpen!;
  });

  const signInTab = page.waitForEvent("popup");
  await openAgain.click();
  const tab = await signInTab;
  await expect(tab.getByRole("heading", { name: "Signed in. You can close this tab and go back to Mission Control." })).toBeVisible();
  await tab.close();
  await expect(signIn(page)).toContainText("Signed in until Mission Control restarts. Kept in memory.");
  await expect(signIn(page).getByRole("alert")).toHaveCount(0);

  await page.route("**/api/shaping/sign-out", (route) => route.fulfill({
    status: 404, contentType: "application/json",
    body: JSON.stringify({ error: "unknown_connection", reason: "Refused for this test: no sign-in has that connection id." }),
  }));
  const signOutButton = page.getByRole("button", { name: "Sign out Signed guidance" });
  await signOutButton.click();
  await expect(signIn(page).getByRole("alert")).toHaveText("Refused for this test: no sign-in has that connection id.");
  await expect(signIn(page)).toContainText("Signed in until Mission Control restarts. Kept in memory.");
  await expect(signOutButton).toBeEnabled();
  await capture(page, "5-sign-out-refused");
  await page.unroute("**/api/shaping/sign-out");
  const listed = await (await fetch(`${daemon.baseURL}/api/shaping`)).json() as { signIns: Array<{ id: string; shapers: string[]; state: string }> };
  const held = listed.signIns.find((entry) => entry.shapers.includes("signed-guidance"));
  expect(held?.state).toBe("signed_in");

  // Another window signs the shaper out.
  const elsewhere = await fetch(`${daemon.baseURL}/api/shaping/sign-out`, {
    method: "POST", headers: json, body: JSON.stringify({ connection: held!.id }),
  });
  expect(elsewhere.status).toBe(200);
  await expect(signIn(page)).toContainText("Not signed in.");
  await expect(signIn(page).getByRole("alert")).toHaveCount(0);
  await expect(signInButton).toBeEnabled();
  expect(tabs).toBe(1);
});

test("Sign out on a sign-in no shaper uses ends that connection's sign-in only, and its entry leaves the list", async ({ dashboard: page, daemon }) => {
  test.setTimeout(90_000);
  await setFlag(daemon, "task-shaping", true);
  await setFlag(daemon, "shaper-sign-in", true);
  // Two shapers on the same fake server with different scopes: two connections. Each is signed in
  // over the API, the fixture approving at once and fetch following its redirect to the callback.
  const scopes = { "context-guidance": "mcp:context", "other-guidance": "mcp:other" } as const;
  const connections: Record<string, string> = {};
  for (const [id, scope] of Object.entries(scopes)) {
    const put = await fetch(`${daemon.baseURL}/api/shaping`, {
      method: "PUT", headers: json, body: JSON.stringify({ kind: "upsert", shaper: {
        id, label: id, stage: "select",
        transport: { type: "mcp", tool: "get_guidance", server: { type: "http", url: fake.resourceUrl, headers: {}, auth: { type: "oauth", scope } } },
      } }),
    });
    expect(put.status).toBe(200);
    const started = await fetch(`${daemon.baseURL}/api/shaping/sign-in`, { method: "POST", headers: json, body: JSON.stringify({ shaper: id }) });
    expect(started.status).toBe(200);
    const { authorizationUrl, connection } = await started.json() as { authorizationUrl: string; connection: string };
    const callback = await fetch(authorizationUrl);
    expect(callback.status).toBe(200);
    connections[scope] = connection;
  }
  expect(connections["mcp:context"]).not.toBe(connections["mcp:other"]);

  await page.goto(`${daemon.baseURL}/#/settings/task-shaping`);
  const unused = panel(page).getByRole("group", { name: "Sign-ins no shaper uses" });
  await expect(panel(page).getByRole("group", { name: "Sign-in for context-guidance" })).toContainText("Signed in");
  await expect(unused).toHaveCount(0);

  // Removing both shapers leaves both sign-ins held and named by no shaper.
  for (const id of Object.keys(scopes)) {
    const removed = await fetch(`${daemon.baseURL}/api/shaping`, { method: "PUT", headers: json, body: JSON.stringify({ kind: "remove", id }) });
    expect(removed.status).toBe(200);
  }
  await expect(unused).toBeVisible();
  await expect(unused.getByRole("listitem")).toHaveCount(2);
  await expect(unused).toContainText("Scope mcp:context");
  await expect(unused).toContainText("Scope mcp:other");
  if (EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    await unused.screenshot({ path: `${EVIDENCE}6-unused-two.png` });
  }

  const otherEntry = unused.getByRole("listitem").filter({ hasText: "Scope mcp:other" });
  const contextEntry = unused.getByRole("listitem").filter({ hasText: "Scope mcp:context" });
  const otherSignOut = page.getByRole("button", { name: `Sign out ${fake.resourceUrl} (mcp:other)` });
  await page.route("**/api/shaping/sign-out", (route) => route.fulfill({
    status: 404, contentType: "application/json",
    body: JSON.stringify({ error: "unknown_connection", reason: "Refused for this test: that unused sign-in could not be ended." }),
  }));
  await otherSignOut.click();
  await expect(otherEntry.getByRole("alert")).toHaveText("Refused for this test: that unused sign-in could not be ended.");
  await expect(contextEntry.getByRole("alert")).toHaveCount(0);
  await expect(unused.getByRole("listitem")).toHaveCount(2);
  await expect(otherSignOut).toBeEnabled();
  if (EVIDENCE) {
    await page.mouse.move(0, 0);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(page.locator(".tooltip")).toHaveCount(0);
    await unused.screenshot({ path: `${EVIDENCE}6-unused-refused.png` });
  }
  await page.unroute("**/api/shaping/sign-out");
  const held = await (await fetch(`${daemon.baseURL}/api/shaping`)).json() as { signIns: Array<{ id: string }> };
  expect(held.signIns.map((entry) => entry.id).sort()).toEqual([connections["mcp:context"], connections["mcp:other"]].sort());

  await otherSignOut.click();
  await expect(unused.getByRole("listitem")).toHaveCount(1);
  await expect(unused).toContainText("Scope mcp:context");
  await expect(unused).not.toContainText("Scope mcp:other");
  const listed = await (await fetch(`${daemon.baseURL}/api/shaping`)).json() as { signIns: Array<{ id: string; state: string }> };
  expect(listed.signIns.map((entry) => entry.id)).toEqual([connections["mcp:context"]]);
  expect(listed.signIns[0]!.state).toBe("signed_in");
  if (EVIDENCE) await unused.screenshot({ path: `${EVIDENCE}6-unused-one.png` });

  await page.getByRole("button", { name: `Sign out ${fake.resourceUrl} (mcp:context)` }).click();
  await expect(unused).toHaveCount(0);
  const after = await (await fetch(`${daemon.baseURL}/api/shaping`)).json() as { signIns: unknown[] };
  expect(after.signIns).toEqual([]);
});

test("a sign-out refusal that lands after another window signed the connection out is not shown", async ({ dashboard: page, daemon }) => {
  test.setTimeout(90_000);
  await setFlag(daemon, "task-shaping", true);
  await setFlag(daemon, "shaper-sign-in", true);
  // Signed in over the API: the fixture approves at once and fetch follows its redirect to the callback.
  const put = await fetch(`${daemon.baseURL}/api/shaping`, {
    method: "PUT", headers: json, body: JSON.stringify({ kind: "upsert", shaper: {
      id: "signed-guidance", label: "Signed guidance", stage: "select",
      transport: { type: "mcp", tool: "get_guidance", server: { type: "http", url: fake.resourceUrl, headers: {}, auth: { type: "oauth", scope: "mcp:context" } } },
    } }),
  });
  expect(put.status).toBe(200);
  const started = await fetch(`${daemon.baseURL}/api/shaping/sign-in`, { method: "POST", headers: json, body: JSON.stringify({ shaper: "signed-guidance" }) });
  expect(started.status).toBe(200);
  const { authorizationUrl, connection } = await started.json() as { authorizationUrl: string; connection: string };
  expect((await fetch(authorizationUrl)).status).toBe(200);

  await page.goto(`${daemon.baseURL}/#/settings/task-shaping`);
  await expect(signIn(page)).toContainText("Signed in until Mission Control restarts. Kept in memory.");

  // This window's Sign out is held in flight, to be refused when released.
  let release!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  let seen!: () => void;
  const arrived = new Promise<void>((done) => { seen = done; });
  await page.route("**/api/shaping/sign-out", async (route) => {
    seen();
    await held;
    await route.fulfill({
      status: 404, contentType: "application/json",
      body: JSON.stringify({ error: "unknown_connection", reason: "Refused for this test: the late refusal." }),
    });
  });
  await page.getByRole("button", { name: "Sign out Signed guidance" }).click();
  await arrived;

  // Meanwhile another window signs the connection out.
  const elsewhere = await fetch(`${daemon.baseURL}/api/shaping/sign-out`, { method: "POST", headers: json, body: JSON.stringify({ connection }) });
  expect(elsewhere.status).toBe(200);
  await expect(signIn(page)).toContainText("Not signed in.");

  // The held request is refused only now.
  release();
  const signInButton = page.getByRole("button", { name: "Sign in Signed guidance" });
  await expect(signInButton).toBeEnabled();
  await expect(signIn(page)).toContainText("Not signed in.");
  await expect(signIn(page).getByRole("alert")).toHaveCount(0);
  await capture(page, "7-late-refusal-dropped");
  await page.unroute("**/api/shaping/sign-out");
});

test("in the desktop app the sign-in page goes to the desktop bridge, and a bridge that fails leaves the recovery message", async ({ dashboard: page, daemon }) => {
  test.setTimeout(90_000);
  await setFlag(daemon, "task-shaping", true);
  await setFlag(daemon, "shaper-sign-in", true);
  const put = await fetch(`${daemon.baseURL}/api/shaping`, {
    method: "PUT", headers: json, body: JSON.stringify({ kind: "upsert", shaper: {
      id: "signed-guidance", label: "Signed guidance", stage: "select",
      transport: { type: "mcp", tool: "get_guidance", server: { type: "http", url: fake.resourceUrl, headers: {}, auth: { type: "oauth", scope: "mcp:context" } } },
    } }),
  });
  expect(put.status).toBe(200);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`${daemon.baseURL}/#/settings/task-shaping`);
  await expect(signIn(page)).toContainText("Not signed in.");
  let tabs = 0;
  page.on("popup", () => { tabs++; });

  // A fake desktop bridge that records what it is asked to open. The dashboard reads the bridge
  // when it opens a link, so installing it now is the desktop app from here on.
  const bridge = (mode: "record" | "reject") => page.evaluate((how) => {
    const probe = window as unknown as { desktopOpened?: string[] };
    probe.desktopOpened ??= [];
    Object.defineProperty(window, "missionDesktop", {
      configurable: true,
      value: {
        isDesktop: true,
        openExternal: async (url: string) => {
          probe.desktopOpened!.push(url);
          if (how === "reject") throw new Error("no registered handler");
        },
      },
    });
  }, mode);
  const desktopOpened = () => page.evaluate(() => (window as unknown as { desktopOpened?: string[] }).desktopOpened ?? []);
  const recovery = "The sign-in page did not open. Use Open the sign-in page to try again, or Copy link to open it in another browser.";
  const authorizeUrl = `${new URL(fake.issuer).origin}/authorize`;

  await bridge("record");
  await page.getByRole("button", { name: "Sign in Signed guidance" }).click();
  await expect(signIn(page)).toContainText("Waiting for the browser.");
  await expect.poll(async () => (await desktopOpened()).length).toBe(1);
  const [handed] = await desktopOpened();
  const url = new URL(handed!);
  expect(`${url.origin}${url.pathname}`).toBe(authorizeUrl);
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("scope")).toBe("mcp:context");
  await page.getByRole("button", { name: "Copy the sign-in link for Signed guidance" }).click();
  await expect(page.getByRole("button", { name: "Copy the sign-in link for Signed guidance" })).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(handed);
  await expect(signIn(page).getByRole("alert")).toHaveCount(0);
  expect(tabs).toBe(0);
  expect(fake.requests.some((request) => request.path === "/authorize")).toBe(false);

  await bridge("reject");
  await page.getByRole("button", { name: "Open the sign-in page for Signed guidance" }).click();
  await expect(signIn(page).getByRole("alert")).toHaveText(recovery);
  expect((await desktopOpened()).at(-1)).toBe(handed);
  await expect(page.getByRole("button", { name: "Open the sign-in page for Signed guidance" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy the sign-in link for Signed guidance" })).toBeVisible();
  await capture(page, "8-desktop-bridge-failed");

  await page.getByRole("button", { name: "Cancel sign-in for Signed guidance" }).click();
  await expect(signIn(page)).toContainText("Not signed in.");
  await expect(signIn(page).getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Sign in Signed guidance" }).click();
  await expect(signIn(page).getByRole("alert")).toHaveText(recovery);
  await expect(signIn(page)).toContainText("Waiting for the browser.");
  expect((await desktopOpened()).length).toBe(3);
  expect(new URL((await desktopOpened()).at(-1)!).searchParams.get("state")).not.toBe(url.searchParams.get("state"));
  expect(tabs).toBe(0);
  await page.getByRole("button", { name: "Cancel sign-in for Signed guidance" }).click();
  await expect(signIn(page)).toContainText("Not signed in.");
});

async function registerSignedGuidance(daemon: DaemonHandle): Promise<void> {
  const put = await fetch(`${daemon.baseURL}/api/shaping`, {
    method: "PUT", headers: json, body: JSON.stringify({ kind: "upsert", shaper: {
      id: "signed-guidance", label: "Signed guidance", stage: "select",
      transport: { type: "mcp", tool: "get_guidance", server: { type: "http", url: fake.resourceUrl, headers: {}, auth: { type: "oauth", scope: "mcp:context" } } },
    } }),
  });
  expect(put.status).toBe(200);
}

test("a sign-in reply that lands after shaper-sign-in was switched off opens no page and holds no link", async ({ dashboard: page, daemon }) => {
  test.setTimeout(90_000);
  await setFlag(daemon, "task-shaping", true);
  await setFlag(daemon, "shaper-sign-in", true);
  await registerSignedGuidance(daemon);
  await page.goto(`${daemon.baseURL}/#/settings/task-shaping`);
  await expect(signIn(page)).toContainText("Not signed in.");
  let tabs = 0;
  page.on("popup", () => { tabs++; });

  // The daemon answers the sign-in, but its reply is held before it reaches this window.
  let release!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  let answered!: () => void;
  const daemonAnswered = new Promise<void>((done) => { answered = done; });
  await page.route("**/api/shaping/sign-in", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const response = await route.fetch();
    answered();
    await held;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Sign in Signed guidance" }).click();
  await daemonAnswered;

  await setFlag(daemon, "shaper-sign-in", false);
  await expect(signIn(page)).toContainText("Sign-in is switched off");
  await expect(signIn(page).getByRole("button")).toHaveCount(0);

  // The reply lands after the flag went off.
  const delivered = page.waitForResponse((response) => response.url().endsWith("/api/shaping/sign-in"));
  release();
  expect((await delivered).status()).toBe(200);
  await page.unroute("**/api/shaping/sign-in");

  // Switched on again: Sign in is free only once the reply has been handled.
  await setFlag(daemon, "shaper-sign-in", true);
  await expect(page.getByRole("button", { name: "Sign in Signed guidance" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Open the sign-in page for Signed guidance" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Copy the sign-in link for Signed guidance" })).toHaveCount(0);
  expect(tabs).toBe(0);
  expect(fake.requests.some((request) => request.path === "/authorize")).toBe(false);
});

test("a desktop bridge failure that lands after another window cancelled the sign-in is not shown", async ({ dashboard: page, daemon }) => {
  test.setTimeout(90_000);
  await setFlag(daemon, "task-shaping", true);
  await setFlag(daemon, "shaper-sign-in", true);
  await registerSignedGuidance(daemon);
  await page.goto(`${daemon.baseURL}/#/settings/task-shaping`);
  await expect(signIn(page)).toContainText("Not signed in.");

  // A desktop bridge whose call stays open until the test fails it.
  await page.evaluate(() => {
    const probe = window as unknown as { failBridge?: () => Promise<void>; bridgeCalls?: number };
    probe.bridgeCalls = 0;
    let fail!: (error: Error) => void;
    const pending = new Promise<void>((_, reject) => { fail = reject; });
    probe.failBridge = async () => {
      fail(new Error("no registered handler"));
      // Let the dashboard's handler for the rejection run before the test looks.
      await new Promise((done) => setTimeout(done, 50));
    };
    Object.defineProperty(window, "missionDesktop", {
      configurable: true,
      value: { isDesktop: true, openExternal: () => { probe.bridgeCalls! += 1; return pending; } },
    });
  });
  await page.getByRole("button", { name: "Sign in Signed guidance" }).click();
  await expect(signIn(page)).toContainText("Waiting for the browser.");
  await expect.poll(() => page.evaluate(() => (window as unknown as { bridgeCalls?: number }).bridgeCalls)).toBe(1);

  // Another window cancels the sign-in while the bridge call is still open.
  const listed = await (await fetch(`${daemon.baseURL}/api/shaping`)).json() as { signIns: Array<{ id: string; shapers: string[] }> };
  const connection = listed.signIns.find((entry) => entry.shapers.includes("signed-guidance"))!.id;
  const cancelled = await fetch(`${daemon.baseURL}/api/shaping/sign-out`, { method: "POST", headers: json, body: JSON.stringify({ connection }) });
  expect(cancelled.status).toBe(200);
  await expect(signIn(page)).toContainText("Not signed in.");

  // Only now does the bridge fail.
  await page.evaluate(() => (window as unknown as { failBridge: () => Promise<void> }).failBridge());
  await expect(signIn(page)).toContainText("Not signed in.");
  await expect(signIn(page).getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign in Signed guidance" })).toBeEnabled();
});

test("a sign-in refusal that lands after the flag went off and on again is not shown", async ({ dashboard: page, daemon }) => {
  test.setTimeout(90_000);
  await setFlag(daemon, "task-shaping", true);
  await setFlag(daemon, "shaper-sign-in", true);
  await registerSignedGuidance(daemon);
  await page.goto(`${daemon.baseURL}/#/settings/task-shaping`);
  await expect(signIn(page)).toContainText("Not signed in.");

  // The Sign in is held in flight, to be refused when released.
  let release!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  let seen!: () => void;
  const arrived = new Promise<void>((done) => { seen = done; });
  await page.route("**/api/shaping/sign-in", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    seen();
    await held;
    await route.fulfill({ status: 409, contentType: "application/json",
      body: JSON.stringify({ error: "registration_limit", reason: "Refused for this test: from an earlier activation." }) });
  });
  await page.getByRole("button", { name: "Sign in Signed guidance" }).click();
  await arrived;

  // Another window switches the feature off and on again while the request is in flight.
  await setFlag(daemon, "shaper-sign-in", false);
  await expect(signIn(page)).toContainText("Sign-in is switched off");
  await setFlag(daemon, "shaper-sign-in", true);
  await expect(signIn(page)).toContainText("Not signed in.");

  release();
  await expect(page.getByRole("button", { name: "Sign in Signed guidance" })).toBeEnabled();
  await expect(signIn(page)).toContainText("Not signed in.");
  await expect(signIn(page).getByRole("alert")).toHaveCount(0);
  await page.unroute("**/api/shaping/sign-in");
});

test("a sign-out refusal that lands after another window changed the shaper's scope is not shown on its new connection", async ({ dashboard: page, daemon }) => {
  test.setTimeout(90_000);
  await setFlag(daemon, "task-shaping", true);
  await setFlag(daemon, "shaper-sign-in", true);
  await registerSignedGuidance(daemon);
  const started = await fetch(`${daemon.baseURL}/api/shaping/sign-in`, { method: "POST", headers: json, body: JSON.stringify({ shaper: "signed-guidance" }) });
  expect(started.status).toBe(200);
  const { authorizationUrl } = await started.json() as { authorizationUrl: string };
  expect((await fetch(authorizationUrl)).status).toBe(200);
  await page.goto(`${daemon.baseURL}/#/settings/task-shaping`);
  await expect(signIn(page)).toContainText("Signed in until Mission Control restarts. Kept in memory.");

  // This window's Sign out is held in flight, to be refused when released.
  let release!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  let seen!: () => void;
  const arrived = new Promise<void>((done) => { seen = done; });
  await page.route("**/api/shaping/sign-out", async (route) => {
    seen();
    await held;
    await route.fulfill({ status: 404, contentType: "application/json",
      body: JSON.stringify({ error: "unknown_connection", reason: "Refused for this test: about the old connection." }) });
  });
  await page.getByRole("button", { name: "Sign out Signed guidance" }).click();
  await arrived;

  const rescoped = await fetch(`${daemon.baseURL}/api/shaping`, {
    method: "PUT", headers: json, body: JSON.stringify({ kind: "upsert", shaper: {
      id: "signed-guidance", label: "Signed guidance", stage: "select",
      transport: { type: "mcp", tool: "get_guidance", server: { type: "http", url: fake.resourceUrl, headers: {}, auth: { type: "oauth", scope: "mcp:other" } } },
    } }),
  });
  expect(rescoped.status).toBe(200);
  await expect(row(page)).toContainText("Signs in: OAuth, scope mcp:other");
  await expect(signIn(page)).toContainText("Not signed in.");
  const unused = panel(page).getByRole("group", { name: "Sign-ins no shaper uses" });
  await expect(unused).toContainText("Scope mcp:context");

  // The old connection's entry waits on the same request, so its Sign out comes free only once
  // the refusal has been handled.
  const oldSignOut = unused.getByRole("button", { name: `Sign out ${fake.resourceUrl} (mcp:context)` });
  await expect(oldSignOut).toBeDisabled();
  release();
  await expect(oldSignOut).toBeEnabled();
  await expect(signIn(page)).toContainText("Not signed in.");
  await expect(signIn(page).getByRole("alert")).toHaveCount(0);
  await expect(unused.getByRole("alert")).toHaveCount(0);
  await page.unroute("**/api/shaping/sign-out");
});

test("a sign-in reply that lands after another window changed the shaper's scope shows no refusal and opens no page", async ({ dashboard: page, daemon }) => {
  test.setTimeout(90_000);
  await setFlag(daemon, "task-shaping", true);
  await setFlag(daemon, "shaper-sign-in", true);
  await registerSignedGuidance(daemon);
  await page.goto(`${daemon.baseURL}/#/settings/task-shaping`);
  await expect(signIn(page)).toContainText("Not signed in.");
  let tabs = 0;
  page.on("popup", () => { tabs++; });
  const rescope = async (scope: string) => {
    const put = await fetch(`${daemon.baseURL}/api/shaping`, {
      method: "PUT", headers: json, body: JSON.stringify({ kind: "upsert", shaper: {
        id: "signed-guidance", label: "Signed guidance", stage: "select",
        transport: { type: "mcp", tool: "get_guidance", server: { type: "http", url: fake.resourceUrl, headers: {}, auth: { type: "oauth", scope } } },
      } }),
    });
    expect(put.status).toBe(200);
    await expect(row(page)).toContainText(`Signs in: OAuth, scope ${scope}`);
  };
  /**
   * Holds this window's next Sign in. `daemon` sends it on to the daemon before holding, so the
   * daemon answers for the shaper as it is now and only the delivery of that answer is held.
   */
  const holdSignIn = async (answer: { daemon: true } | { refuse: string }) => {
    let release!: () => void;
    const held = new Promise<void>((done) => { release = done; });
    let seen!: () => void;
    const arrived = new Promise<void>((done) => { seen = done; });
    await page.route("**/api/shaping/sign-in", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const response = "daemon" in answer ? await route.fetch() : null;
      seen();
      await held;
      if (response) await route.fulfill({ response });
      else await route.fulfill({ status: 409, contentType: "application/json",
        body: JSON.stringify({ error: "registration_limit", reason: (answer as { refuse: string }).refuse }) });
    });
    return { arrived, release };
  };

  const refused = await holdSignIn({ refuse: "Refused for this test: about the old scope." });
  await page.getByRole("button", { name: "Sign in Signed guidance" }).click();
  await refused.arrived;
  await rescope("mcp:other");
  refused.release();
  await expect(page.getByRole("button", { name: "Sign in Signed guidance" })).toBeEnabled();
  await expect(signIn(page)).toContainText("Not signed in.");
  await expect(signIn(page).getByRole("alert")).toHaveCount(0);
  await page.unroute("**/api/shaping/sign-in");

  // The daemon starts a sign-in for the scope the shaper has now, mcp:other, and its answer is held
  // while another window changes the scope back. Landing after that, it opens no page: the sign-in
  // it carries is for a connection the row no longer has.
  const started = await holdSignIn({ daemon: true });
  await page.getByRole("button", { name: "Sign in Signed guidance" }).click();
  await started.arrived;
  await rescope("mcp:context");
  started.release();
  await expect(page.getByRole("button", { name: "Sign in Signed guidance" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Open the sign-in page for Signed guidance" })).toHaveCount(0);
  await expect(signIn(page).getByRole("alert")).toHaveCount(0);
  expect(tabs).toBe(0);
  await page.unroute("**/api/shaping/sign-in");
});

test("a desktop bridge failure that lands after another window changed the shaper's scope is not shown on the row", async ({ dashboard: page, daemon }) => {
  test.setTimeout(90_000);
  await setFlag(daemon, "task-shaping", true);
  await setFlag(daemon, "shaper-sign-in", true);
  await registerSignedGuidance(daemon);
  await page.goto(`${daemon.baseURL}/#/settings/task-shaping`);
  await expect(signIn(page)).toContainText("Not signed in.");

  // A desktop bridge whose call stays open until the test fails it.
  await page.evaluate(() => {
    const probe = window as unknown as { failBridge?: () => Promise<void>; bridgeCalls?: number };
    probe.bridgeCalls = 0;
    let fail!: (error: Error) => void;
    const pending = new Promise<void>((_, reject) => { fail = reject; });
    probe.failBridge = async () => {
      fail(new Error("no registered handler"));
      // Let the dashboard's handler for the rejection run before the test looks.
      await new Promise((done) => setTimeout(done, 50));
    };
    Object.defineProperty(window, "missionDesktop", {
      configurable: true,
      value: { isDesktop: true, openExternal: () => { probe.bridgeCalls! += 1; return pending; } },
    });
  });

  // The sign-in reply is held until the row already shows the sign-in pending, so the bridge call
  // begins with the old connection pending: a later scope change leaves its state unchanged.
  let release!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  await page.route("**/api/shaping/sign-in", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Sign in Signed guidance" }).click();
  await expect(signIn(page)).toContainText("Started in another window, or before this page was reloaded.");
  release();
  await expect(signIn(page)).not.toContainText("Started in another window");
  await expect.poll(() => page.evaluate(() => (window as unknown as { bridgeCalls?: number }).bridgeCalls)).toBe(1);
  await page.unroute("**/api/shaping/sign-in");

  // Another window changes the shaper's scope while the bridge call is open; the old connection stays pending.
  const rescoped = await fetch(`${daemon.baseURL}/api/shaping`, {
    method: "PUT", headers: json, body: JSON.stringify({ kind: "upsert", shaper: {
      id: "signed-guidance", label: "Signed guidance", stage: "select",
      transport: { type: "mcp", tool: "get_guidance", server: { type: "http", url: fake.resourceUrl, headers: {}, auth: { type: "oauth", scope: "mcp:other" } } },
    } }),
  });
  expect(rescoped.status).toBe(200);
  await expect(row(page)).toContainText("Signs in: OAuth, scope mcp:other");
  await expect(signIn(page)).toContainText("Not signed in.");

  // Only now does the bridge fail.
  await page.evaluate(() => (window as unknown as { failBridge: () => Promise<void> }).failBridge());
  await expect(signIn(page)).toContainText("Not signed in.");
  await expect(signIn(page).getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign in Signed guidance" })).toBeEnabled();
});

test("a refusal shown on a row goes once another window changes what the shaper signs in to", async ({ dashboard: page, daemon }) => {
  test.setTimeout(90_000);
  await setFlag(daemon, "task-shaping", true);
  await setFlag(daemon, "shaper-sign-in", true);
  await registerSignedGuidance(daemon);
  await page.goto(`${daemon.baseURL}/#/settings/task-shaping`);
  await expect(signIn(page)).toContainText("Not signed in.");

  await page.route("**/api/shaping/sign-in", (route) => route.request().method() !== "POST" ? route.fallback()
    : route.fulfill({ status: 409, contentType: "application/json",
      body: JSON.stringify({ error: "registration_limit", reason: "Refused for this test: about mcp:context." }) }));
  await page.getByRole("button", { name: "Sign in Signed guidance" }).click();
  await expect(signIn(page).getByRole("alert")).toHaveText("Refused for this test: about mcp:context.");
  await page.unroute("**/api/shaping/sign-in");

  const rescoped = await fetch(`${daemon.baseURL}/api/shaping`, {
    method: "PUT", headers: json, body: JSON.stringify({ kind: "upsert", shaper: {
      id: "signed-guidance", label: "Signed guidance", stage: "select",
      transport: { type: "mcp", tool: "get_guidance", server: { type: "http", url: fake.resourceUrl, headers: {}, auth: { type: "oauth", scope: "mcp:other" } } },
    } }),
  });
  expect(rescoped.status).toBe(200);
  await expect(row(page)).toContainText("Signs in: OAuth, scope mcp:other");
  await expect(signIn(page)).toContainText("Not signed in.");
  await expect(signIn(page).getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign in Signed guidance" })).toBeEnabled();
});

test("the row shows a sign-in kept in the Keychain, and one being renewed with its reason", async ({ dashboard: page, daemon }) => {
  test.setTimeout(90_000);
  await setFlag(daemon, "task-shaping", true);
  await setFlag(daemon, "shaper-sign-in", true);
  await registerSignedGuidance(daemon);
  const started = await fetch(`${daemon.baseURL}/api/shaping/sign-in`, { method: "POST", headers: json, body: JSON.stringify({ shaper: "signed-guidance" }) });
  expect(started.status).toBe(200);
  const { authorizationUrl } = await started.json() as { authorizationUrl: string };
  expect((await fetch(authorizationUrl)).status).toBe(200);

  // The browser suite's daemon keeps sign-ins in memory, and renewing needs a server that
  // refuses a held token. Both states are shown by handing the page's own event stream one
  // sign-in list frame, built from the daemon's real entry for this connection: the real panel
  // renders it, and no Keychain is touched.
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        if (String(url) === "/events") (window as unknown as { signInStream: EventSource }).signInStream = this;
      }
    };
  });
  // A hash-only navigation keeps the document, so reload for the init script to take hold.
  await page.goto(`${daemon.baseURL}/#/settings/task-shaping`);
  await page.reload();
  await expect(signIn(page)).toContainText("Signed in until Mission Control restarts. Kept in memory.");
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { signInStream?: EventSource }).signInStream))).toBe(true);
  const listed = await (await fetch(`${daemon.baseURL}/api/shaping`)).json() as { signIns: Array<Record<string, unknown> & { shapers: string[] }> };
  const entry = listed.signIns.find((candidate) => candidate.shapers.includes("signed-guidance"))!;
  const deliver = (signIns: unknown[]) => page.evaluate((frame) => {
    const stream = (window as unknown as { signInStream: EventSource }).signInStream;
    stream.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }, { type: "shaping_sign_ins", signIns });

  await deliver([{ ...entry, state: "signed_in", storage: "keychain", reason: null }]);
  await expect(signIn(page)).toContainText("Signed in. Kept in the macOS Keychain.");
  await expect(signIn(page).getByRole("button")).toHaveText(["Sign out"]);
  await capture(page, "3-signed-in-keychain");

  // The daemon's fixed sentence for a token the server refused (SIGN_IN_REASONS.refused).
  const refused = "This shaper's server refused its sign-in, so its reply was not used. The sign-in is being renewed; if it does not recover, sign in again at Settings > Task shaping.";
  await deliver([{ ...entry, state: "renewing", storage: "keychain", reason: refused }]);
  await expect(signIn(page)).toContainText("Renewing the sign-in.");
  await expect(signIn(page)).toContainText(refused);
  await expect(signIn(page).getByRole("button")).toHaveText(["Sign in", "Sign out"]);
  await capture(page, "3-renewing");
});
