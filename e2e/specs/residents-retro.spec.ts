import { mkdirSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { settled } from "../fixtures/settle.ts";
import type { ResidentProfile } from "../../src/shared/residents.ts";
import type { Persona } from "../../src/shared/workflow.ts";

/**
 * A resident's retro, from the operator's steering to the next profile and Persona revisions.
 *
 * What is real: two corrections typed into the resident's composer, the Complete dialog's offer,
 * the retro route, the packet the daemon types into the resident's conversation, the fake agent
 * reading that conversation back from the daemon's transcript route for the session the packet
 * names, its calls to the BUILT MCP server's `get_resident_instructions` and
 * `propose_resident_instruction_changes`, the `request_input` question that tool asks, the
 * operator's selection in the review modal, the daemon applying exactly that selection as a new
 * profile revision and a new Persona revision, and the band, the Residents page and the Persona
 * library showing them.
 *
 * No model tokens are spent: every agent binary is the fake from `fixtures/fake-agents.ts`. It
 * recognises the retro by the daemon's own first sentence and derives one change from each
 * steering turn it reads in the transcript: a new cadence edits the profile, anything else becomes
 * Persona guidance. Without steering it proposes nothing.
 */

const NAME = "Retro watcher";
const PERSONA = "Status Narrator";
const PERSONA_GUIDANCE = "# Status Narrator\n\nReport on the queue.";
const BRIEF = "Check the backlog every hour.";
/** Steering for the profile: a new cadence. */
const CADENCE = "From now on, check the backlog every 30 minutes, not every hour.";
/** Steering for the Persona: how every status should read. */
const STATUS_RULE = "Every status should lead with what changed since the last one.";
const EVIDENCE = artifactsDir("residents-retro");

async function capture(target: Locator | Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  const page = "page" in target ? target.page() : target;
  await page.mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
}

async function request<T>(daemon: DaemonHandle, path: string, body?: unknown): Promise<T> {
  const response = await fetch(daemon.baseURL + path, body === undefined ? {} : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}

const profileNamed = async (daemon: DaemonHandle): Promise<ResidentProfile | undefined> =>
  (await request<ResidentProfile[]>(daemon, "/api/residents/profiles")).find((profile) => profile.settings.identity.name === NAME);

/** Author a Persona and a profile naming it through the real routes, launch it, and wait for its loop. */
async function launch(daemon: DaemonHandle): Promise<{ profile: ResidentProfile; persona: Persona }> {
  const persona = await request<Persona>(daemon, "/api/personas", { name: PERSONA, guidanceMarkdown: PERSONA_GUIDANCE });
  const profile = await request<ResidentProfile>(daemon, "/api/residents/profiles", { settings: {
    identity: { name: NAME },
    persona: { personaId: persona.id },
    instructions: { markdown: BRIEF },
    workspace: { defaultRepoRoot: daemon.repo },
    execution: { model: "claude-fable-5" },
    // A long cadence keeps the resident waiting between steps instead of iterating under the test.
    loop: { delaySeconds: 3600, minDelaySeconds: 60, maxDelaySeconds: 3600 },
  } });
  await request(daemon, `/api/residents/profiles/${profile.id}/launch`, { repoRoot: daemon.repo, requestId: "launch-retro-watcher" });
  await expect.poll(() => withDaemonDb(daemon, (db) => (db.prepare(
    "SELECT COUNT(*) AS n FROM resident_runs WHERE ended_at IS NULL AND launch_state = 'launched' AND loop_state = 'waiting'",
  ).get() as { n: number }).n), { timeout: 60_000 }).toBe(1);
  return { profile, persona };
}

test("a resident's retro turns the operator's steering into selectable changes, and the selected ones become its profile's and Persona's next revisions", async ({
  dashboard: page,
  daemon,
}) => {
  const { profile, persona } = await launch(daemon);
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const card = page.locator(".console-detail");
  const band = page.getByRole("group", { name: `Resident ${NAME}` });
  await expect(band).toContainText("revision 1");

  // The operator steers the resident in its conversation, as they would on any day.
  const reply = card.getByPlaceholder(/^Reply to this session/);
  for (const turn of [CADENCE, STATUS_RULE]) {
    await expect(reply).toBeEnabled();
    await reply.fill(turn);
    await reply.press("Enter");
    await expect(card.getByText(`Mock reply to: ${turn}`)).toBeVisible();
  }
  await capture(card, "00-operator-steers-the-resident");

  // Complete offers the retro before completing, and says what it will do.
  const complete = card.getByRole("button", { name: "Complete" });
  await settled(complete);
  await complete.click();
  const dialog = page.getByRole("dialog", { name: "Complete task and close session" });
  const retro = dialog.getByRole("button", { name: "Run a retro first" });
  await expect(retro).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Complete & close" })).toBeVisible();
  // The accessible description `Tooltip` portals to the page, as `retro-offer.spec.ts` reads it.
  await expect(page.locator(".tt-desc", {
    hasText: "Ask this resident to review its conversation and propose changes to its standing instructions or its Persona.",
  })).toBeAttached();
  await expect(retro).toHaveAccessibleDescription(/You choose which changes to apply, and nothing changes until you do\./);
  await capture(dialog, "01-complete-offers-resident-retro");
  await retro.click();
  // Sending the retro completes nothing: the dialog steps aside and the resident stays live.
  await expect(dialog).toBeHidden();

  // The resident read its conversation back and proposes one change per steering turn, each
  // quoting the turn it came from, through the real tool's `request_input` question.
  const toReview = card.getByRole("button", { name: "to review" });
  await expect(toReview).toBeVisible({ timeout: 60_000 });
  await toReview.click();
  const form = page.locator(".review-modal");
  const question = form.locator(".question");
  await expect(form.locator(".kind-tag")).toHaveText("input");
  await expect(question).toContainText(`Which of these changes to ${NAME}'s standing instructions should Mission Control apply?`);
  await expect(question).toContainText("Proposed from 2 steering turn(s) in this conversation.");
  await expect(question).toContainText(`1. Check every 30 minutes\nWhere: Profile instructions\nWhy: You told me: "${CADENCE}"\nReplace:\n    every hour\nWith:\n    every 30 minutes`);
  await expect(question).toContainText(`Where: Persona guidance (${PERSONA})\nWhy: You told me: "${STATUS_RULE}"\nAppend:\n    ${STATUS_RULE}`);
  const cadence = form.getByRole("checkbox", { name: /1\. Check every 30 minutes/ });
  const statusRule = form.getByRole("checkbox", { name: /2\. Every status should lead with what/ });
  await expect(cadence).toBeVisible();
  await expect(statusRule).toBeVisible();
  await capture(form, "02-proposal-quotes-the-steering");
  await cadence.check();
  await statusRule.check();
  await capture(form, "03-both-changes-selected");
  await form.getByRole("button", { name: "Submit" }).click();
  await expect(form).toBeHidden();

  // Both selected changes landed: the profile at revision 2, the Persona at revision 2.
  await expect.poll(async () => (await profileNamed(daemon))?.revision, { timeout: 30_000 }).toBe(2);
  const updated = (await profileNamed(daemon))!;
  expect(updated.id).toBe(profile.id);
  expect(updated.settings.instructions.markdown).toBe("Check the backlog every 30 minutes.");
  const narrator = await request<Persona>(daemon, `/api/personas/${persona.id}`);
  expect(narrator.revision).toBe(2);
  expect(narrator.guidanceMarkdown).toBe(`${PERSONA_GUIDANCE}\n\n${STATUS_RULE}`);

  // The resident reads the outcome back in its own conversation.
  await expect(card).toContainText("outcome=applied", { timeout: 30_000 });
  await expect(card).toContainText(`Applied 2 changes: ${NAME} is now at profile revision 2, and the Persona ${PERSONA} is now at revision 2.`);
  // The running resident keeps revision 1 and says a newer one exists.
  await expect(band).toContainText("revision 1");
  await expect(band.getByRole("status")).toHaveText("Profile changed since launch (now revision 2)");
  await capture(card, "04-applied-and-reported");

  // The profile editor shows the new revision and its new instructions.
  await page.goto(`${daemon.baseURL}/#/residents/${profile.id}`);
  const editor = page.getByRole("region", { name: `Resident profile ${NAME}` });
  await expect(editor).toContainText("Revision 2");
  await expect(editor.getByLabel("Profile instructions")).toHaveValue("Check the backlog every 30 minutes.");
  await capture(page.locator("main.residents-page"), "05-profile-revision-2");

  // The Persona library shows the Persona's new guidance.
  await page.goto(`${daemon.baseURL}/#/library/personas/${persona.id}`);
  const guidance = page.getByRole("region", { name: "Persona guidance" });
  await expect(guidance).toContainText("Report on the queue.");
  await expect(guidance).toContainText(STATUS_RULE);
  await capture(page, "06-persona-guidance-updated");
});
