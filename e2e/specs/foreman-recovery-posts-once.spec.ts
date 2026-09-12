import { mkdirSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { shipRecoveryBrief } from "../../src/server/foreman/ship-shepherd.ts";

/**
 * Foreman's pre-PR recovery, read the way the operator met it: one conversation, scrolled.
 *
 * The reported defect was that Foreman "double posts the same content". It did, and not by
 * sending twice - the claim/marker machinery in `ship-shepherd.ts` spends one attempt per
 * marker and `test/foreman-ship-shepherd.test.ts` pins that. What reached the screen twice
 * was one delivery drawn from two records that both carried the whole instruction: the
 * Foreman decision card, merged into the conversation by `mergeConversation`, and the
 * injected turn it is describing, drawn directly beneath it by `ForemanTerminalMessage`.
 * Both are stamped within the same minute, so nothing in the reading separates them.
 *
 * What only this layer can prove. `foreman-ship-shepherd.test.ts` pins the rule that
 * composes the body and `foreman-episode-resolution.test.ts` pins the card it produces, but
 * neither can see the card and the turn on one page - which is the whole of the complaint.
 * The two records travel completely different routes to get here (the episode over
 * `GET /api/sessions/:id/foreman-episodes`, the turn over the transcript stream), so only a
 * browser holding both at once can count what a person actually reads.
 *
 * Both halves are delivered through their real routes. The instruction goes through
 * `POST /inject` with `origin: "foreman"`, which is the route the worker uses and the one
 * that makes the daemon label the turn as Foreman's; the record goes through
 * `POST /foreman-episode`, carrying a body composed by `shipRecoveryBrief` itself rather
 * than by a literal here, so the spec cannot pass against a rule this repository no longer
 * has. The only thing invented is the trigger: an ambiguous-idle recovery needs a model
 * call, and this suite never spends a token.
 *
 * No model tokens: `MISSION_CLAUDE_BIN` points at the fake throughout.
 */

/**
 * One held-gap recovery instruction, in the shape `structuralPayload` builds.
 *
 * Long and multi-line on purpose. The card renders its body as markdown and the turn
 * renders it literally, so a one-line fixture could pass while a real instruction still
 * doubled - a numbered list is what the two renderings disagree about most.
 */
const INSTRUCTION = [
  "Foreman's completion review found blocking work that still belongs in this implementation turn:",
  "",
  "1. e2e/specs/conversation-html.spec.ts: The HTML preview pagination test failed on its first",
  "   attempt and passed only on retry in the final full Playwright run.",
  "",
  "Address only these implementation, documentation, test, or evidence gaps. Do not commit,",
  "push, create a pull request, merge, or expand repository scope.",
].join("\n");

/** A sentence from the instruction that survives both renderings unchanged. */
const PHRASE = "Address only these implementation, documentation, test, or evidence gaps.";

const MARKER = "ship-recovery:task-1:key:1:held_gaps:1";

/** The one-line headline `recordShipRecovery` writes, worded by the attempt's outcome. */
const purposeFor = (delivery: string, next: string): string =>
  `Pre-PR ship recovery: held completion gaps, attempt 1/3, ${delivery}, ${next}.`;

const EVIDENCE = artifactsDir("foreman-recovery-posts-once");

async function shoot(page: Page, card: Locator, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer, and it
  // lands on top of the card being photographed.
  await page.mouse.move(0, 0);
  await card.screenshot({ path: `${EVIDENCE}${name}.png` });
  console.log(`CAPTURED e2e/.artifacts/foreman-recovery-posts-once/${name}.png`);
}

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog
    .getByPlaceholder("What should this agent do?")
    .fill("keep a managed ship task moving before its first pull request");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

/** The dispatched fake, once it has a conversation Foreman could address. */
async function sessionId(daemon: DaemonHandle): Promise<string> {
  let id: string | null = null;
  await expect
    .poll(
      async () => {
        const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as Array<{
          id: string;
          agentSessionId: string | null;
          runtime: string;
        }>;
        id = sessions.find(
          (session) => session.runtime === "sdk" && session.agentSessionId !== null,
        )?.id ?? null;
        return id;
      },
      { message: "the dispatched session should bind a conversation", timeout: 30_000 },
    )
    .not.toBeNull();
  return id!;
}

async function post(daemon: DaemonHandle, path: string, body: unknown): Promise<void> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.ok, `POST ${path} answered ${response.status}: ${await response.text()}`).toBe(true);
}

/**
 * Replay one delivered recovery attempt: the turn, then its record, then the note.
 *
 * The worker writes the note before the episode. The order is reversed here because the
 * panel refetches episodes when the note's `updatedAt` moves (see `useEpisodes`), so
 * writing the note last is what makes the read deterministic in a spec rather than
 * dependent on which of two writes the stream carried first. Nothing about what is
 * written differs.
 */
async function foremanRecovers(daemon: DaemonHandle, id: string, sent: boolean): Promise<string> {
  const session = `/api/sessions/${encodeURIComponent(id)}`;
  if (sent) await post(daemon, `${session}/inject`, { text: INSTRUCTION, origin: "foreman", buffer: false });
  const delivery = sent ? "delivered" as const : "confirmed undelivered" as const;
  const next = sent ? "next attempt after 40 minutes" : "same attempt ready to retry";
  const purpose = purposeFor(delivery, next);
  const brief = shipRecoveryBrief({
    detail: INSTRUCTION,
    decisionSummary: null,
    quietMinutes: 0,
    delivery,
    next,
    sentText: sent ? INSTRUCTION : null,
  });
  await post(daemon, `${session}/foreman-episode`, {
    marker: MARKER,
    situation: "ship-recovery",
    surface: "terminal",
    question: "Keep managed ship task moving before its first pull request: held completion gaps.",
    pane: null,
    purpose,
    brief,
    classification: `held completion gaps; attempt 1/3; ${delivery}`,
    confidence: 1,
    tier: 0,
    disposition: sent ? "answered" : "skipped",
    lastAction: sent ? "Sent bounded held completion gaps recovery attempt 1/3" : `Pre-PR recovery ${delivery}`,
    sentText: sent ? INSTRUCTION : null,
    sentBy: sent ? "foreman" : null,
  });
  const note = await fetch(`${daemon.baseURL}${session}/note`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      purpose,
      brief,
      disposition: sent ? "answered" : "skipped",
      lastAction: sent ? "Sent bounded held completion gaps recovery attempt 1/3" : `Pre-PR recovery ${delivery}`,
      handledMarker: MARKER,
    }),
  });
  expect(note.ok, `PUT note answered ${note.status}`).toBe(true);
  return purpose;
}

/**
 * Select the dispatched session and wait for its conversation.
 *
 * Waits on `.transcript-log`, which is the one element both renderings share - the two
 * composers below it do not (the terminal frame asks you to "send the next instruction to
 * this process"), and a helper keyed to either placeholder works in one rendering only.
 */
async function openConversation(page: Page): Promise<Locator> {
  const row = page
    .getByRole("navigation", { name: "Sessions" })
    .locator("button.rail-row")
    .first();
  await expect(row).toBeVisible();
  await row.click();
  const card = page.locator(".console-detail");
  await expect(card.locator(".transcript-log")).toBeVisible();
  return card;
}

/**
 * Set the dashboard's rendering, so both are read rather than whichever is default.
 *
 * Written to the daemon rather than to `localStorage`, because the web store hydrates from
 * `GET /api/ui/config` at boot and overwrites the local cache - the same idiom
 * `conversation-terminal-view.spec.ts` uses. The reload is what makes it take.
 */
async function useRendering(page: Page, daemon: DaemonHandle, view: "chat" | "terminal"): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationView: view }),
  });
  const body = (await response.json()) as { config?: { conversationView?: string } };
  expect(body.config?.conversationView, "the daemon accepted the rendering").toBe(view);
  await page.reload();
}

/**
 * Everything in this conversation that Foreman itself put on screen.
 *
 * Deliberately not the whole log. The fake agent echoes each turn back as "Mock reply to:
 * <the turn>", so a count over the transcript would be counting the CHILD quoting Foreman -
 * which is the agent reading its instruction, not Foreman saying it twice. Both selectors
 * hold across the chat and terminal renderings: the decision card is `.foreman-episode` in
 * each, and an attributed turn wears `aria-label="foreman"` in each.
 */
function foremanSpeech(log: Locator): Locator {
  return log.locator('.foreman-episode, article[aria-label="foreman"]');
}

/** How many times Foreman puts this sentence in front of the operator. */
async function timesPosted(log: Locator, phrase: string): Promise<number> {
  const texts = await foremanSpeech(log).allTextContents();
  return texts.reduce((total, text) => total + text.split(phrase).length - 1, 0);
}

test("a delivered recovery instruction is posted to the conversation once", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);
  const id = await sessionId(daemon);
  const purpose = await foremanRecovers(daemon, id, true);

  let card = await openConversation(dashboard);
  let log = card.locator(".transcript-log");

  // Both records reached the browser: the decision, and the turn it describes.
  await expect(log.getByText(purpose)).toBeVisible();
  await expect(log.locator('article[aria-label="foreman"]')).toHaveCount(1);

  // And Foreman puts the instruction in front of the operator once, not twice.
  await expect.poll(() => timesPosted(log, PHRASE), {
    message: "the delivered instruction should be posted exactly once",
  }).toBe(1);

  // The card still says everything the turn cannot: which attempt this was, how long the
  // session had been quiet, and when the next one is due.
  await expect(log.getByText(/Quiet age: \d+ minutes\. Delivery: delivered\./)).toBeVisible();
  await shoot(dashboard, card, "00-recovery-posted-once-chat");

  // The terminal rendering is where this was reported, and it merges the same two records
  // through a completely separate branch of `TranscriptPanel` - so it is counted too.
  await useRendering(dashboard, daemon, "terminal");
  card = await openConversation(dashboard);
  log = card.locator(".transcript-log");
  await expect(log.locator(".pty-foreman-badge").first()).toBeVisible();
  await expect(log.locator(".pty-foreman-status").first()).toHaveText("automated turn");
  await expect.poll(() => timesPosted(log, PHRASE), {
    message: "the terminal rendering posts it exactly once as well",
  }).toBe(1);
  await expect(log.getByText(/Quiet age: \d+ minutes\. Delivery: delivered\./)).toBeVisible();
  await shoot(dashboard, card, "01-recovery-posted-once-terminal");
});

test("a recovery that reached nobody still posts its instruction, in the card that holds it", async ({
  dashboard,
  daemon,
}) => {
  // The other side of the same rule, and the one a narrower fix would have broken: nothing
  // was typed into the session, so the decision card is the ONLY copy of what Foreman chose
  // and must keep it whole.
  await dispatch(dashboard, daemon);
  const id = await sessionId(daemon);
  const purpose = await foremanRecovers(daemon, id, false);

  const card = await openConversation(dashboard);
  const log = card.locator(".transcript-log");

  await expect(log.getByText(purpose)).toBeVisible();
  await expect.poll(() => timesPosted(log, PHRASE), {
    message: "an undelivered instruction survives in its record",
  }).toBe(1);
  await expect(log.locator('article[aria-label="foreman"]')).toHaveCount(0);
  await shoot(dashboard, card, "02-undelivered-recovery-kept");
});
