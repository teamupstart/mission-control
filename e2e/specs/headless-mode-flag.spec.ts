import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../fixtures/test.ts";

// The first real preview flag owes the browser assertion `docs/feature-flags.md` asks for: its
// Settings row appears, and switching it changes a second window without a reload. This spec
// also shows the daemon side of the same switch: the `/dispatch/*` routes and the health
// capability appear and disappear with it, with no restart.

test("headless mode: its Settings row toggles a second window and gates the daemon live", async ({ dashboard: page, context, daemon }) => {
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const capabilities = async () => ((await (await fetch(`${daemon.baseURL}/api/health`)).json()) as { capabilities: string[] }).capabilities;
  const inbox = () => fetch(`${daemon.baseURL}/dispatch/inbox?repo=${encodeURIComponent(daemon.repo)}`, { headers: { "x-harness-token": token } });

  await page.goto(`${daemon.baseURL}/#/settings/feature-flags`);
  const peer = await context.newPage();
  await peer.goto(page.url());
  let peerNavigations = 0;
  peer.on("framenavigated", frame => { if (frame === peer.mainFrame()) peerNavigations++; });
  const row = (window: typeof page) => window.getByRole("button", { name: /^Headless mode:/ });

  // Present, described, and off until the person switches it on.
  await expect(row(page)).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByText("Dispatch work to Mission Control from a Claude Code terminal session.")).toBeVisible();
  await expect(row(peer)).toBeEnabled();
  await expect(row(peer)).toHaveAttribute("aria-pressed", "false");
  expect(await capabilities()).not.toContain("home-dispatch-v1");
  const off = await inbox();
  expect(off.status).toBe(404);
  expect(await off.json()).toEqual({ error: "This feature is disabled.", feature: "headless-mode" });

  // On: the second window follows with no reload, and the daemon gates open.
  await row(page).click();
  await expect(row(page)).toHaveAttribute("aria-pressed", "true");
  await expect(row(peer)).toHaveAttribute("aria-pressed", "true");
  await expect.poll(capabilities).toContain("home-dispatch-v1");
  const on = await inbox();
  expect(on.status).toBe(501);
  expect(await on.json()).toEqual({ error: "not implemented", feature: "headless-mode" });
  expect((await fetch(`${daemon.baseURL}/dispatch/inbox`)).status).toBe(401);

  // The choice survives a reload, and the peer can switch it back off.
  await page.reload();
  await expect(row(page)).toHaveAttribute("aria-pressed", "true");
  await row(peer).click();
  await expect(row(peer)).toHaveAttribute("aria-pressed", "false");
  await expect(row(page)).toHaveAttribute("aria-pressed", "false");
  await expect.poll(capabilities).not.toContain("home-dispatch-v1");
  expect((await inbox()).status).toBe(404);
  expect(peerNavigations).toBe(0);
});
