import { mkdirSync } from "node:fs";
import { test, expect } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { startFakeOAuthServer, type FakeOAuthServer } from "../../test/fixtures/fake-oauth-server.mjs";

// Shaper sign-in's callback page, the one page of this phase a person sees. The authorization
// server is the unit suite's loopback mock, run in this process: it approves at once and sends
// the browser back to the daemon's callback. The daemon keeps the fake tokens in memory
// (`MISSION_SHAPER_SIGN_IN_STORE=memory` in the daemon fixture), so no Keychain is touched and
// no request leaves this machine.

const EVIDENCE = process.env.MC_E2E_EVIDENCE ? artifactsDir("shaper-sign-in-callback") : null;
const json = { "content-type": "application/json" };

async function setFlag(daemon: DaemonHandle, id: string, enabled: boolean): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/feature-flags`, {
    method: "PUT", headers: json, body: JSON.stringify({ kind: "flag", id, enabled }),
  });
  expect(response.ok).toBe(true);
}

let fake: FakeOAuthServer;
test.beforeEach(async () => { fake = await startFakeOAuthServer(); });
test.afterEach(async () => { await fake.close(); });

test("the callback page says Signed in after the authorization server's redirect, and did not finish for a state never issued", async ({ dashboard: page, daemon }) => {
  await setFlag(daemon, "task-shaping", true);
  await setFlag(daemon, "shaper-sign-in", true);
  const shaper = {
    id: "signed-guidance", label: "Signed guidance", stage: "select",
    transport: {
      type: "mcp", tool: "get_guidance",
      server: { type: "http", url: fake.resourceUrl, headers: {}, auth: { type: "oauth", scope: "mcp:context" } },
    },
  };
  const registered = await fetch(`${daemon.baseURL}/api/shaping`, {
    method: "PUT", headers: json, body: JSON.stringify({ kind: "upsert", shaper }),
  });
  expect(registered.status).toBe(200);

  const started = await fetch(`${daemon.baseURL}/api/shaping/sign-in`, {
    method: "POST", headers: json, body: JSON.stringify({ shaper: "signed-guidance" }),
  });
  expect(started.status).toBe(200);
  const { authorizationUrl, connection } = await started.json() as { authorizationUrl: string; connection: string };

  // The browser opens the link, the mock approves, and the daemon answers the redirect.
  await page.goto(authorizationUrl);
  await expect(page).toHaveURL(new RegExp(`^${daemon.baseURL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/api/shaping/sign-in/callback\\?`));
  await expect(page.getByRole("heading", { name: "Signed in. You can close this tab and go back to Mission Control." })).toBeVisible();
  await expect(page).toHaveTitle("Signed in - Mission Control");
  const code = new URL(page.url()).searchParams.get("code")!;
  expect(code).toMatch(/^fake-code-/);
  expect(await page.content()).not.toContain(code);
  if (EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    await page.screenshot({ path: `${EVIDENCE}signed-in.png` });
  }

  const listed = await (await fetch(`${daemon.baseURL}/api/shaping`)).json() as { signIns: Array<{ id: string; state: string }> };
  expect(listed.signIns.find((entry) => entry.id === connection)?.state).toBe("signed_in");

  const failed = await page.goto(`${daemon.baseURL}/api/shaping/sign-in/callback?state=never-issued&code=fake-code-never`);
  expect(failed?.status()).toBe(400);
  await expect(page.getByRole("heading", { name: "The sign-in did not finish." })).toBeVisible();
  await expect(page.getByText(/Start again from Settings > Task shaping\.$/)).toBeVisible();
  expect(await page.content()).not.toContain("never-issued");
  if (EVIDENCE) await page.screenshot({ path: `${EVIDENCE}did-not-finish.png` });
});
