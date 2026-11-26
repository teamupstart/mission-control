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

  // 1. Import a manifest that carries `auth`. Its row reads "Not signed in".
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
  // The tab is on the authorization server's page, with the browser's half of PKCE and the scope.
  await held.waitForURL(`${authorizeUrl}?**`);
  const opened = new URL(held.url());
  expect(opened.searchParams.get("code_challenge_method")).toBe("S256");
  expect(opened.searchParams.get("scope")).toBe("mcp:context");
  // Copy link puts that same link on the clipboard, and says so.
  await page.getByRole("button", { name: "Copy the sign-in link for Signed guidance" }).click();
  await expect(page.getByRole("button", { name: "Copy the sign-in link for Signed guidance" })).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(held.url());
  // Open the sign-in page opens the same link in another tab.
  const again = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Open the sign-in page for Signed guidance" }).click();
  const reopened = await again;
  await reopened.waitForURL(held.url());
  await capture(page, "2-pending-here");

  // A reload drops the link: the row still waits, and offers only what needs no link.
  await page.reload();
  await expect(signIn(page)).toContainText("Waiting for the browser. Started in another window, or before this page was reloaded.");
  await expect(page.getByRole("button", { name: "Sign in Signed guidance" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel sign-in for Signed guidance" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open the sign-in page for Signed guidance" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Copy the sign-in link for Signed guidance" })).toHaveCount(0);
  await capture(page, "2-pending-elsewhere");

  // Sign in on that pending row starts a replacement: a new tab opens on a new authorization URL,
  // and this window, which now holds that link, offers it again.
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
  // Nothing reached the authorization server's `/authorize` while it was stubbed.
  expect(fake.requests.some((request) => request.path === "/authorize")).toBe(false);

  // 3. Sign in again: the new tab is sent back to the daemon's callback, which says it is done.
  const signInTab = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Sign in Signed guidance" }).click();
  const tab = await signInTab;
  await expect(tab.getByRole("heading", { name: "Signed in. You can close this tab and go back to Mission Control." })).toBeVisible();
  expect(tab.url().startsWith(`${daemon.baseURL}/api/shaping/sign-in/callback?`)).toBe(true);

  // 4. Back in Settings, with no reload, the row reads Signed in and offers Sign out.
  await expect(signIn(page)).toContainText("Signed in until Mission Control restarts. Kept in memory.");
  await expect(page.getByRole("button", { name: "Sign out Signed guidance" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in Signed guidance" })).toHaveCount(0);
  await capture(page, "3-signed-in");
  await tab.close();

  // 5. A dry run reaches the protected tool with the token and shows its guidance.
  const signedRun = await dryRun(page, daemon);
  await expect(signedRun.result).toContainText("OK", { timeout: 45_000 });
  await expect(signedRun.result.getByRole("article", { name: "Guide" })).toContainText("guidance for");
  await signedRun.dialog.getByRole("button", { name: "Close" }).click();
  await expect(signedRun.dialog).toHaveCount(0);
  expect(fake.requests.some((request) => request.path === "/mcp" && String(request.headers.authorization ?? "").startsWith("Bearer "))).toBe(true);

  // 6. Sign out: the row reads Not signed in, and a dry run says where to sign in.
  await page.getByRole("button", { name: "Sign out Signed guidance" }).click();
  await expect(signIn(page)).toContainText("Not signed in.");
  await expect(page.getByRole("button", { name: "Sign in Signed guidance" })).toBeVisible();
  const signedOutRun = await dryRun(page, daemon);
  await expect(signedOutRun.result).toContainText("Unavailable", { timeout: 45_000 });
  await expect(signedOutRun.result).toContainText("Sign in at Settings > Task shaping.");
  await signedOutRun.dialog.getByRole("button", { name: "Close" }).click();
  await expect(signedOutRun.dialog).toHaveCount(0);

  // 7. Switch shaper-sign-in off through the API: in this open window the controls go and the row says why.
  await setFlag(daemon, "shaper-sign-in", false);
  await expect(signIn(page)).toContainText("Sign-in is switched off");
  await expect(signIn(page)).toContainText("(shaper-sign-in)");
  await expect(signIn(page).getByRole("button")).toHaveCount(0);
  await capture(page, "4-flag-off");
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

  // The daemon refuses the start: its fixed reason is shown in the row, as an alert.
  await page.route("**/api/shaping/sign-in", (route) => route.fulfill({
    status: 409, contentType: "application/json",
    body: JSON.stringify({ error: "registration_limit", reason: "Refused for this test: sign out of another sign-in first." }),
  }));
  await signInButton.click();
  await expect(signIn(page).getByRole("alert")).toHaveText("Refused for this test: sign out of another sign-in first.");
  await expect(signIn(page)).toContainText("Not signed in.");
  await expect(signInButton).toBeEnabled();
  await page.unroute("**/api/shaping/sign-in");

  // The reply's link is plain http to another host: the dashboard refuses to open it.
  await page.route("**/api/shaping/sign-in", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ authorizationUrl: "http://login.attacker.example/authorize?state=fake-state", expiresAt: Date.now() + 600_000, connection: "0".repeat(32) }),
  }));
  await signInButton.click();
  await expect(signIn(page).getByRole("alert")).toHaveText("The daemon's sign-in link is not https or this machine's loopback, so it was not opened. Start again, or check the shaper's server.");
  await expect(page.getByRole("button", { name: "Open the sign-in page for Signed guidance" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Copy the sign-in link for Signed guidance" })).toHaveCount(0);
  await expect(signInButton).toBeEnabled();
  await page.unroute("**/api/shaping/sign-in");
  expect(tabs).toBe(0);

  // A real sign-in still works from the same row, and clears the earlier refusal.
  const signInTab = page.waitForEvent("popup");
  await signInButton.click();
  const tab = await signInTab;
  await expect(tab.getByRole("heading", { name: "Signed in. You can close this tab and go back to Mission Control." })).toBeVisible();
  await tab.close();
  await expect(signIn(page)).toContainText("Signed in until Mission Control restarts. Kept in memory.");
  await expect(signIn(page).getByRole("alert")).toHaveCount(0);

  // The daemon refuses the sign-out: the reason is shown, and the sign-in is still held and offered.
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

  // Another window signs the shaper out. The row follows the event, and the refusal it showed no
  // longer describes it, so it goes with no click here.
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

  // Removing both shapers leaves both sign-ins held and named by no shaper: listed apart, live.
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

  // The daemon refuses the mcp:other sign-out: its reason shows in that entry alone, both entries
  // stay, and its Sign out is still offered.
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

  // Sign out the mcp:other one again: it goes through, the alert clears with it, and the daemon no
  // longer holds that connection.
  await otherSignOut.click();
  await expect(unused.getByRole("listitem")).toHaveCount(1);
  await expect(unused).toContainText("Scope mcp:context");
  await expect(unused).not.toContainText("Scope mcp:other");
  const listed = await (await fetch(`${daemon.baseURL}/api/shaping`)).json() as { signIns: Array<{ id: string; state: string }> };
  expect(listed.signIns.map((entry) => entry.id)).toEqual([connections["mcp:context"]]);
  expect(listed.signIns[0]!.state).toBe("signed_in");
  if (EVIDENCE) await unused.screenshot({ path: `${EVIDENCE}6-unused-one.png` });

  // Signing out the last one removes the list.
  await page.getByRole("button", { name: `Sign out ${fake.resourceUrl} (mcp:context)` }).click();
  await expect(unused).toHaveCount(0);
  const after = await (await fetch(`${daemon.baseURL}/api/shaping`)).json() as { signIns: unknown[] };
  expect(after.signIns).toEqual([]);
});
