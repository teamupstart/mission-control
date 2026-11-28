import { mkdirSync } from "node:fs";

import type { Locator } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { beListener, enableVoice, say } from "../fixtures/voice.ts";
import { expect, test } from "../fixtures/test.ts";
import type { ResidentProfile } from "../../src/shared/residents.ts";
import { openVoiceTab } from "../fixtures/voice-settings.ts";

// The roster includes stopped residents, so these fixtures only need profiles.

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

  await page.goto(`${daemon.baseURL}/#/residents`);
  const editor = page.getByRole("region", { name: "Resident profile Release Captain" });
  await page.getByRole("complementary", { name: "Resident profiles" }).getByRole("button", { name: /Release Captain/ }).first().click();
  const identity = editor.getByRole("region", { name: "Identity", exact: true });
  await expect(identity.getByLabel("Name", { exact: true })).toHaveValue("Release Captain");
  await expect(referenceNameOf(identity)).toHaveCount(0);

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
  await expect(identity.locator(".voice-heard")).toHaveText('"Stevie", cut the release');
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

  // The revision changes when the editor has received the save response.
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toContainText("Revision 2. Edits apply");
  await expect.poll(async () => {
    const profiles = await api<ResidentProfile[]>(daemon, "/api/residents/profiles");
    return profiles.find((profile) => profile.id === captain.id)?.settings.identity.referenceName ?? null;
  }).toBe("Marlowe");

  await daemon.shutdown();
  await daemon.restart();
  await openVoiceTab(page, "Names & routing", daemon.baseURL);
  const roster = page.getByRole("table", { name: "Agents that answer to a spoken name" });
  const row = roster.getByRole("row").filter({ has: page.getByRole("cell", { name: '"Marlowe"', exact: true }) });
  await expect(row.getByRole("cell")).toHaveText(["Release Captain", "Resident", '"Marlowe"', "Not running", "Distinct"]);
  await expect(row.locator(".voice-roster-agent")).toHaveClass(/agent-name-resident/);
  const residentName = row.locator(".voice-roster-agent");
  const plainColor = await row.evaluate((element) => getComputedStyle(element).color);
  expect(await residentName.evaluate((element) => getComputedStyle(element).color)).not.toBe(plainColor);
  const steve = roster.getByRole("row").filter({ has: page.getByRole("cell", { name: "Steve", exact: true }) });
  await expect(steve.getByRole("cell")).toHaveText(["Steve", "Resident", "Steve", "Not running", "Distinct"]);
  await shoot(page.getByRole("tabpanel", { name: "Voice" }), "03-roster");

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
  await openVoiceTab(page, "Names & routing", daemon.baseURL);
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

  await openVoiceTab(page, "Names & routing", daemon.baseURL);
  const roster = page.getByRole("table", { name: "Agents that answer to a spoken name" });
  await expect(roster.getByRole("row").filter({ has: page.getByRole("cell", { name: '"Stevie"', exact: true }) }).getByRole("cell"))
    .toHaveText(["Release Captain", "Resident", '"Stevie"', "Not running", /Sounds like Steve$/]);
  await expect(roster.getByRole("row").filter({ has: page.getByRole("cell", { name: "Steve", exact: true }) }).getByRole("cell"))
    .toHaveText(["Steve", "Resident", "Steve", "Not running", /Sounds like "Stevie"/]);
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

test("the listening composer quotes a resident reference name and an ordinary name in different places", async ({ dashboard: page, daemon }) => {
  await enableVoice(daemon);
  const profile = await api<ResidentProfile>(daemon, "/api/residents/profiles", { settings: {
    identity: { name: "Sage" }, persona: { personaId: PERSONA_ID },
  } });
  await api(daemon, `/api/residents/profiles/${profile.id}/launch`, { repoRoot: daemon.repo, requestId: profile.id });
  const listener = await beListener(daemon);
  try {
    await openVoiceTab(page, "On screen", daemon.baseURL);
    await page.getByRole("checkbox", { name: "Composer microphone" }).check();
    await page.goto(daemon.baseURL);
    await page.getByRole("navigation", { name: "Sessions" }).getByRole("button", { name: /Sage/ }).click();
    const composer = page.locator(".transcript-compose");
    const reply = composer.getByRole("textbox");
    const ordinaryHint = 'Message to send… or say "Sage, …"';
    await expect(composer.getByText(ordinaryHint, { exact: true })).toBeVisible();
    await expect(reply).toHaveAccessibleDescription(ordinaryHint);
    await shoot(composer, "composer-ordinary-name");

    // Keep the spoken word identical so only the name's source changes.
    await api(daemon, `/api/residents/profiles/${profile.id}`, {
      expectedRevision: profile.revision,
      settings: { ...profile.settings, identity: { ...profile.settings.identity, referenceName: "Sage" } },
    }, "PATCH");
    const referenceHint = 'Message to send… or say "Sage", …';
    await expect(composer.getByText(referenceHint, { exact: true })).toBeVisible();
    await expect(reply).toHaveAccessibleDescription(referenceHint);
    await shoot(composer, "composer-reference-name");
  } finally {
    listener.stop();
  }
});

test("Recently Heard quotes the resident reference name after a near miss", async ({ dashboard: page, daemon }) => {
  await enableVoice(daemon);
  await api(daemon, "/api/residents/profiles", { settings: {
    identity: { name: "Release reviewer", referenceName: "Cat" }, persona: { personaId: PERSONA_ID },
  } });
  expect(await (await say(daemon, "Pat help")).json()).toEqual({ accepted: true });
  await openVoiceTab(page, "Recently heard", daemon.baseURL);
  const history = page.getByRole("region", { name: "Recently heard" });
  const row = history.getByRole("row").filter({ hasText: "Pat help" });
  await expect(row.getByRole("cell", { name: 'None. Closest is "Cat", a weak match', exact: true })).toBeVisible();
  await expect(row.getByRole("cell", { name: "near miss rejected", exact: true })).toBeVisible();
  await shoot(history, "near-miss-reference");
});

test("Recently Heard quotes only the reference name after exact resident matches", async ({ dashboard: page, daemon }) => {
  await enableVoice(daemon);
  await api(daemon, "/api/voice/config", { cancelWindow: { enabled: false, seconds: 30 } }, "PUT");
  const residents = [
    { identity: { name: "Release reviewer", referenceName: "Sage" }, utterance: "Sage, check the build", label: '"Sage"' },
    { identity: { name: "Robin" }, utterance: "Robin, check the tests", label: "Robin" },
  ];
  for (const { identity } of residents) {
    const profile = await api<ResidentProfile>(daemon, "/api/residents/profiles", {
      settings: { identity, persona: { personaId: PERSONA_ID } },
    });
    await api(daemon, `/api/residents/profiles/${profile.id}/launch`, { repoRoot: daemon.repo, requestId: profile.id });
  }

  await page.goto(daemon.baseURL + "/#/settings/voice");
  const roster = page.getByRole("table", { name: "Agents that answer to a spoken name" });
  const history = page.getByRole("region", { name: "Recently heard" });
  for (const { identity, utterance, label } of residents) {
    await openVoiceTab(page, "Names & routing");
    const resident = roster.getByRole("row").filter({ hasText: identity.name });
    await expect(resident.getByRole("cell", { name: "Running", exact: true })).toBeVisible();
    expect(await (await say(daemon, utterance)).json()).toEqual({ accepted: true });
    await openVoiceTab(page, "Recently heard");
    const row = history.getByRole("row").filter({ has: page.getByRole("cell", { name: utterance, exact: true }) });
    await expect(row.getByRole("cell", { name: `${label}, exactly`, exact: true })).toBeVisible();
    await expect(row.getByRole("cell", { name: `Routed to ${label}`, exact: true })).toBeVisible();
  }
  if (process.env.MC_E2E_EVIDENCE) {
    await expect(page.getByRole("status").filter({ hasText: "Sent to" })).toHaveCount(0);
    await shoot(history, "exact-resident-matches");
  }
});

test("Reports settings quotes a migrated muted resident reference name", async ({ dashboard: page, daemon }) => {
  await enableVoice(daemon);
  const profiles: ResidentProfile[] = [];
  for (const identity of [{ name: "Release reviewer", referenceName: "Sage" }, { name: "Lint watcher" }]) {
    profiles.push(await api<ResidentProfile>(daemon, "/api/residents/profiles", {
      settings: { identity, persona: { personaId: PERSONA_ID } },
    }));
  }
  await daemon.shutdown();
  // Recreate the pre-provenance schema in the stopped fixture. Restart runs the production upgrade.
  withDaemonDb(daemon, db => {
    db.exec(`ALTER TABLE reports DROP COLUMN author_is_reference_name;
      ALTER TABLE report_mutes DROP COLUMN author_is_reference_name;
      PRAGMA user_version = 64;`);
    const report = db.prepare(`INSERT INTO reports (id, session_id, author_key, author_resident_profile_id,
      author_name, author_spoken_name, title, body, root_id, version, created_at, root_created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'Reviewed', 'Done', ?, 1, ?, ?)`);
    const mute = db.prepare("INSERT INTO report_mutes (author_key, author_name, author_spoken_name, muted_at) VALUES (?, ?, ?, ?)");
    for (const profile of profiles) {
      const key = `resident:${profile.id}`;
      const id = `report-${profile.id}`;
      const spoken = profile.settings.identity.referenceName ?? null;
      const at = profile.createdAt + 1;
      report.run(id, profile.id, key, profile.id, profile.name, spoken, id, at, at);
      mute.run(key, profile.name, spoken, at + 1);
    }
  });
  await daemon.restart();
  await page.goto(daemon.baseURL + "/#/settings/reports");
  const list = page.getByRole("list", { name: "Muted agents" });
  for (const label of ['"Sage"', "Lint watcher"]) {
    const row = list.getByRole("listitem").filter({ has: page.getByRole("button", { name: `Unmute ${label}`, exact: true }) });
    await expect(row.getByText(label, { exact: true })).toBeVisible();
  }
  await shoot(page.locator("section").filter({ has: page.getByRole("heading", { name: "Muted agents" }) }).last(), "migrated-muted-residents");

  await list.getByRole("button", { name: 'Unmute "Sage"', exact: true }).click();
  await expect(list.getByText('"Sage"', { exact: true })).toHaveCount(0);
  await page.goto(daemon.baseURL + "/#/fleet");
  await page.locator("button.pulse-seg", { hasText: "to read" }).click();
  const inbox = page.getByRole("dialog", { name: "Attention inbox" });
  await expectContentClearsBorder(inbox);
  const card = inbox.getByRole("article", { name: "Report: Reviewed" });
  await card.getByRole("button", { name: "Reviewed", exact: true }).click();
  await expect(card.getByRole("button", { name: "Reviewed", exact: true })).toHaveAttribute("aria-expanded", "true");
  await expect(card.locator(".agent-report-meta strong")).toHaveText('"Sage"');
  await expect(card.locator(".vh-foot")).toHaveText('Say "Sage", mark read or "Sage", mute reports.');
  await expect(card.locator(".vh-foot q")).toHaveCount(0);
  await shoot(card, "quoted-report-author");
});
