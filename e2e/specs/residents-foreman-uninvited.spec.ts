import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Locator } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

// A resident launches with Foreman OUT of its session. Every other embedded session is invited
// by construction, so the rail of a resident's console detail must read "Invite foreman" from
// the first frame - and the operator can still invite Foreman in by hand. No model tokens are
// spent: every agent binary is the fake from `fixtures/fake-agents.ts`.

const PERSONA_ID = "builtin:code-risk-reviewer";
const PROFILE = "Quiet Steward";
const EVIDENCE = artifactsDir("residents-foreman-uninvited");

async function capture(target: Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.screenshot({ path: join(EVIDENCE, `${name}.png`) });
  console.log(`CAPTURED e2e/.artifacts/residents-foreman-uninvited/${name}.png`);
}

async function send<T>(daemon: DaemonHandle, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

interface SessionRow { id: string; runtime: string; foremanInvite: string | null; task: { kind: string } | null }

test("a resident session launches without Foreman, and the operator can invite it in", async ({
  dashboard,
  daemon,
}) => {
  // Foreman on fleet-wide, so the only thing keeping it out of the session is the invite.
  await send(daemon, "PUT", "/api/foreman/config", { enabled: true });
  const profile = await send<{ id: string }>(daemon, "POST", "/api/residents/profiles", {
    settings: {
      identity: { name: PROFILE },
      persona: { personaId: PERSONA_ID },
      workspace: { defaultRepoRoot: daemon.repo },
    },
  });
  await send(daemon, "POST", `/api/residents/profiles/${profile.id}/launch`, {
    repoRoot: daemon.repo,
    requestId: "foreman-uninvited",
  });

  let resident: SessionRow | undefined;
  await expect.poll(async () => {
    resident = (await send<SessionRow[]>(daemon, "GET", "/api/sessions"))
      .find((s) => s.runtime === "sdk" && s.task?.kind === "resident");
    return resident?.id ?? null;
  }, { message: "the resident's SDK session should reach the registry", timeout: 60_000 }).not.toBeNull();
  // The daemon's own answer, which is what the Foreman worker gates itself on.
  expect(resident!.foremanInvite).toBeNull();

  await send(daemon, "PUT", "/api/ui/config", { layout: "console" });
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const tabs = dashboard.getByRole("tablist", { name: "Session detail" });
  await expect(tabs).toBeVisible();

  const invite = tabs.getByRole("button", { name: "Invite foreman" });
  const intent = tabs.getByRole("button", { name: "Foreman intent" });
  await expect(invite).toBeVisible();
  await expect(intent).toHaveCount(0);
  await capture(tabs, "rail-uninvited");

  // The work queue explains the silence rather than leaving the operator to guess.
  await tabs.getByRole("tab", { name: /Work queue/ }).click();
  const panel = dashboard.locator("section.work-queue");
  await expect(panel.getByText(/Foreman is not in this session/)).toBeVisible();

  // The operator's door still opens: an explicit invite lands and comes back over SSE.
  await invite.click();
  await expect(intent).toBeVisible();
  await expect(invite).toHaveCount(0);
  await expect(panel.getByText(/Foreman is not in this session/)).toHaveCount(0);
  await capture(tabs, "rail-invited");
  const after = (await send<SessionRow[]>(daemon, "GET", "/api/sessions")).find((s) => s.id === resident!.id);
  expect(after?.foremanInvite).toBe("operator");

  // Withdraw, then one click back in. A resident has no implicit grant for the cleared
  // tombstone to restore, so the re-invite must land as an explicit operator grant.
  await intent.click();
  await dashboard.getByRole("button", { name: "Withdraw invite" }).click();
  await expect(invite).toBeVisible();
  await expect(intent).toHaveCount(0);
  await invite.click();
  await expect(intent).toBeVisible();
  await expect(invite).toHaveCount(0);
  const reinvited = (await send<SessionRow[]>(daemon, "GET", "/api/sessions")).find((s) => s.id === resident!.id);
  expect(reinvited?.foremanInvite).toBe("operator");
});
