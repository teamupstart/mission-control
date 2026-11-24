import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page, Locator } from "@playwright/test";
import type { Session } from "../../src/shared/types.ts";
import type { DaemonHandle } from "./daemon.ts";
import { expect } from "./test.ts";
import { artifactsDir } from "./artifacts.ts";
import { enableVoice } from "./voice.ts";

export async function setupCards(page: Page, daemon: DaemonHandle, seconds = 30) {
  await enableVoice(daemon);
  expect((await page.request.put(daemon.baseURL + "/api/voice/config", { data: { muted: false, cancelWindow: { enabled: true, seconds } } })).ok()).toBe(true);
  expect((await page.request.put(daemon.baseURL + "/api/voice/confirmation", { data: { confirmation: "toast" } })).ok()).toBe(true);
}

export async function allowStreamDisconnect(page: Page) {
  await page.addInitScript(() => {
    window.EventSource = class extends EventSource {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        window.addEventListener("disconnect-fixture-stream", () => this.close(), { once: true });
      }
    };
  });
}

export async function runningAgent(page: Page, daemon: DaemonHandle, callSign: string) {
  const created = await page.request.post(daemon.baseURL + "/api/tasks", { data: {
    repoRoot: daemon.repo, intent: "Inspect the build", title: callSign ? callSign + " on builds" : "Inspect the build", ...(callSign && { callSign }),
    kind: "ship", agent: "claude", runtime: "sdk", workflowId: null,
  } });
  expect(created.ok(), await created.text()).toBe(true);
  const task = await created.json();
  let session!: Session;
  await expect.poll(async () => {
    const sessions: Session[] = await (await page.request.get(daemon.baseURL + "/api/sessions")).json();
    session = sessions.find(s => s.task?.id === task.id)!;
    return session?.agentSessionId && session.state;
  }, { timeout: 60_000 }).toBe("idle");
  return session;
}

export async function captureCard(target: Page | Locator, name: string) {
  if (!process.env.MC_E2E_EVIDENCE) return;
  const dir = artifactsDir("voice-confirmation");
  mkdirSync(dir, { recursive: true });
  await target.screenshot({ path: join(dir, name + ".png") });
}

/** Compare the rendered box to the corresponding approved design at normal browser zoom. */
export async function expectCardGeometry(card: Locator, design: "confirmation-card" | "routing-exceptions", selector: string) {
  const reference = await card.page().context().newPage();
  try {
    await reference.goto(new URL(`../../docs/plans/voice-addressing-for-agents/mockup-${design}.html`, import.meta.url).href);
    const properties = ["width", "padding", "row-gap", "border-radius", "border-left-width", "box-sizing"];
    const expected = await reference.locator(selector).first().evaluate((element, properties) =>
      properties.map(property => getComputedStyle(element).getPropertyValue(property)), properties);
    for (const [index, property] of properties.entries()) await expect(card).toHaveCSS(property, expected[index]!);
  } finally {
    await reference.close();
    await card.page().bringToFront();
  }
}
