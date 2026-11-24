import { mkdirSync } from "node:fs";

import type { Locator } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expect, test } from "../fixtures/test.ts";
import type { ResidentProfile } from "../../src/shared/residents.ts";

/**
 * A resident's reference name, end to end (voice plan, Phase 2). With voice on, a resident
 * profile's Identity card offers a Reference name field with the same heard-as preview as a call
 * sign, checked against the other names on the roster. Saved, Settings > Voice lists the resident
 * by its profile name, saying the reference name; cleared, it says the profile name again.
 *
 * Real daemon, routes, SSE and the built dashboard. No agent is launched and nothing listens to a
 * microphone: a resident that is not running is still on the roster, marked not running.
 */

const EVIDENCE = artifactsDir("voice-reference-name");
const PERSONA_ID = "builtin:code-risk-reviewer";

async function shoot(target: Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  const page = target.page();
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await target.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // oxlint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/voice-reference-name/${name}.png`);
}

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

const setFlag = (daemon: DaemonHandle, id: string, enabled: boolean) =>
  api(daemon, "/api/feature-flags", { kind: "flag", id, enabled }, "PUT");

const referenceNameOf = (scope: Locator) => scope.getByRole("textbox", { name: "Reference name", exact: true });

test("a reference name set on a resident's profile is checked as it is typed, survives a restart, and the roster says it", async ({ dashboard: page, daemon }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1500, height: 1100 });
  const captain = await api<ResidentProfile>(daemon, "/api/residents/profiles", { settings: {
    identity: { name: "Release Captain", description: "Cuts the weekly release" },
    persona: { personaId: PERSONA_ID },
    board: { colorId: "violet" },
  } });
  await api<ResidentProfile>(daemon, "/api/residents/profiles", { settings: {
    identity: { name: "Steve", description: "Watches lint" },
    persona: { personaId: PERSONA_ID },
  } });

  // Off: the Identity card has no reference name.
  await page.goto(`${daemon.baseURL}/#/residents`);
  const editor = page.getByRole("region", { name: "Resident profile Release Captain" });
  await page.getByRole("complementary", { name: "Resident profiles" }).getByRole("button", { name: /Release Captain/ }).first().click();
  const identity = editor.getByRole("region", { name: "Identity", exact: true });
  await expect(identity.getByLabel("Name", { exact: true })).toHaveValue("Release Captain");
  await expect(referenceNameOf(identity)).toHaveCount(0);

  // On, with the page left open: the field appears, and its preview checks each name typed.
  for (const id of ["async-input", "inbox", "filed-plan-decisions", "voice"]) await setFlag(daemon, id, true);
  const field = referenceNameOf(identity);
  await expect(field).toBeVisible();
  await expect(field).toHaveAttribute("placeholder", "Said instead of Release Captain");

  await expect(identity.getByText("Residents are addressed by their profile name unless a reference name is set.")).toBeVisible();
  const nameBox = await identity.getByLabel("Name", { exact: true }).boundingBox();
  const referenceBox = await field.boundingBox();
  expect(nameBox).not.toBeNull();
  expect(referenceBox).not.toBeNull();
  expect(referenceBox!.x - (nameBox!.x + nameBox!.width)).toBeCloseTo(14, 0);
  expect(referenceBox!.y).toBeCloseTo(nameBox!.y, 0);

  await field.fill("Stevie");
  await expect(identity.locator(".voice-heard")).toHaveText("Stevie, cut the release");
  await expect(identity.locator(".voice-meter-bad")).toHaveText("Sounds like Steve");
  await expect(identity.getByText("It can be heard as Steve, which another agent answers to.", { exact: false })).toBeVisible();
  await shoot(identity, "01-sounds-like-another-resident");

  await field.fill("Sage");
  await expect(identity.getByRole("meter", { name: "Distinctiveness" })).toHaveAttribute("aria-valuenow", "2");
  await expect(identity.locator(".voice-meter-bad")).toHaveText("Everyday word");

  await shoot(identity, "05-sage-reference");

  await field.fill("Marlowe");
  await expect(identity.locator(".voice-meter-good")).toHaveText("Distinctive");
  await shoot(identity, "02-distinctive");

  // Saved: a new revision carries it, trimmed. The editor names the revision once the save is
  // back, which is when it stops holding unsaved changes.
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toContainText("Revision 2. Edits apply");
  await expect.poll(async () => {
    const profiles = await api<ResidentProfile[]>(daemon, "/api/residents/profiles");
    return profiles.find((profile) => profile.id === captain.id)?.settings.identity.referenceName ?? null;
  }).toBe("Marlowe");

  // Settings > Voice, after a daemon restart: the resident by its profile name, saying the
  // reference name, not running.
  await daemon.shutdown();
  await daemon.restart();
  await page.goto(`${daemon.baseURL}/#/settings/voice`);
  const roster = page.getByRole("table", { name: "Agents that answer to a spoken name" });
  const row = roster.getByRole("row").filter({ has: page.getByRole("cell", { name: "Marlowe", exact: true }) });
  await expect(row.getByRole("cell")).toHaveText(["Release Captain", "Resident", "Marlowe", "Not running", "Distinct"]);
  await expect(row.locator(".voice-roster-agent")).toHaveClass(/agent-name-resident/);
  const residentName = row.locator(".voice-roster-agent");
  const plainColor = await row.evaluate((element) => getComputedStyle(element).color);
  expect(await residentName.evaluate((element) => getComputedStyle(element).color)).not.toBe(plainColor);
  const steve = roster.getByRole("row").filter({ has: page.getByRole("cell", { name: "Steve", exact: true }) });
  await expect(steve.getByRole("cell")).toHaveText(["Steve", "Resident", "Steve", "Not running", "Distinct"]);
  await shoot(page.getByRole("tabpanel", { name: "Voice" }), "03-roster");

  // Cleared: saved blank, and the roster says the profile name again.
  await page.goto(`${daemon.baseURL}/#/residents`);
  await page.getByRole("complementary", { name: "Resident profiles" }).getByRole("button", { name: /Release Captain/ }).first().click();
  await expect(referenceNameOf(identity)).toHaveValue("Marlowe");
  await referenceNameOf(identity).fill("");
  await expect(identity.getByText("Type a name to see how you would say it.")).toBeVisible();
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toContainText("Revision 3. Edits apply");
  await expect.poll(async () => {
    const profiles = await api<ResidentProfile[]>(daemon, "/api/residents/profiles");
    const profile = profiles.find((candidate) => candidate.id === captain.id);
    return profile ? [profile.revision, profile.settings.identity.referenceName ?? ""] : null;
  }, { message: "a new revision with no reference name" }).toEqual([3, ""]);
  await page.goto(`${daemon.baseURL}/#/settings/voice`);
  await expect(roster.getByRole("row").filter({ has: page.getByRole("cell", { name: "Release Captain", exact: true }) }).getByRole("cell"))
    .toHaveText(["Release Captain", "Resident", "Release Captain", "Not running", "Distinct"]);
});

test("a warned reference name is saved as typed, and the roster lists it with its warning", async ({ dashboard: page, daemon }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1500, height: 1100 });
  for (const id of ["async-input", "inbox", "filed-plan-decisions", "voice"]) await setFlag(daemon, id, true);
  const captain = await api<ResidentProfile>(daemon, "/api/residents/profiles", { settings: {
    identity: { name: "Release Captain", description: "Cuts the weekly release" },
    persona: { personaId: PERSONA_ID },
  } });
  await api<ResidentProfile>(daemon, "/api/residents/profiles", { settings: {
    identity: { name: "Steve", description: "Watches lint" },
    persona: { personaId: PERSONA_ID },
  } });

  // "Stevie" sounds like Steve, and Save goes ahead with it unchanged.
  await page.goto(`${daemon.baseURL}/#/residents`);
  await page.getByRole("complementary", { name: "Resident profiles" }).getByRole("button", { name: /Release Captain/ }).first().click();
  const editor = page.getByRole("region", { name: "Resident profile Release Captain" });
  const identity = editor.getByRole("region", { name: "Identity", exact: true });
  await referenceNameOf(identity).fill("Stevie");
  await expect(identity.locator(".voice-meter-bad")).toHaveText("Sounds like Steve");
  const saved = page.waitForResponse((r) => r.request().method() === "PATCH"
    && new URL(r.url()).pathname === `/api/residents/profiles/${encodeURIComponent(captain.id)}`);
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  const response = await saved;
  expect(response.ok(), await response.text()).toBe(true);
  const sent = JSON.parse(response.request().postData() ?? "{}") as { settings?: { identity?: { referenceName?: string } } };
  expect(sent.settings?.identity?.referenceName, "the warned name is sent as typed").toBe("Stevie");
  expect(((await response.json()) as ResidentProfile).settings.identity.referenceName, "and saved as typed").toBe("Stevie");
  await expect(editor).toContainText("Revision 2. Edits apply");
  const profiles = await api<ResidentProfile[]>(daemon, "/api/residents/profiles");
  expect(profiles.find((profile) => profile.id === captain.id)?.settings.identity.referenceName).toBe("Stevie");

  // The roster lists Release Captain said as Stevie, with the warning, and Steve warns back.
  await page.goto(`${daemon.baseURL}/#/settings/voice`);
  const roster = page.getByRole("table", { name: "Agents that answer to a spoken name" });
  await expect(roster.getByRole("row").filter({ has: page.getByRole("cell", { name: "Stevie", exact: true }) }).getByRole("cell"))
    .toHaveText(["Release Captain", "Resident", "Stevie", "Not running", /Sounds like Steve$/]);
  await expect(roster.getByRole("row").filter({ has: page.getByRole("cell", { name: "Steve", exact: true }) }).getByRole("cell"))
    .toHaveText(["Steve", "Resident", "Steve", "Not running", /Sounds like Stevie/]);
  await shoot(page.getByRole("tabpanel", { name: "Voice" }), "04-roster-warned-stevie");
});

test("saving with voice off preserves the stored reference name after a hidden edit", async ({ dashboard: page, daemon }) => {
  for (const id of ["async-input", "inbox", "filed-plan-decisions", "voice"]) await setFlag(daemon, id, true);
  const captain = await api<ResidentProfile>(daemon, "/api/residents/profiles", { settings: {
    identity: { name: "Release Captain", referenceName: "Marlowe" },
    persona: { personaId: PERSONA_ID },
  } });
  await page.goto(`${daemon.baseURL}/#/residents`);
  await page.getByRole("complementary", { name: "Resident profiles" }).getByRole("button", { name: /Release Captain/ }).first().click();
  const editor = page.getByRole("region", { name: "Resident profile Release Captain" });
  await referenceNameOf(editor).fill("");
  await setFlag(daemon, "voice", false);
  await expect(referenceNameOf(editor)).toHaveCount(0);
  await editor.getByLabel("Description", { exact: false }).first().fill("Cuts releases");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toContainText("Revision 2. Edits apply");
  const profiles = await api<ResidentProfile[]>(daemon, "/api/residents/profiles");
  const identity = profiles.find((p) => p.id === captain.id)?.settings.identity;
  expect(identity?.description).toBe("Cuts releases");
  expect(identity?.referenceName).toBe("Marlowe");
});
