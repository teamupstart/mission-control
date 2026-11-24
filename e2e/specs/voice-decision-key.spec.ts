import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page, Route } from "@playwright/test";
import { expect, test as base } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { say, startDecisionServer, type DecisionServer } from "../fixtures/voice.ts";
import { voiceRoutingWithoutProvider } from "../../src/shared/voice-decide.ts";
import type { HeardEntry, VoiceCard } from "../../src/shared/voice-routing.ts";
import type { Task } from "../../src/shared/types.ts";

// The model step's settings and rungs (voice plan, Phase 4), end to end. Voice settings' "Faster
// routing" group saves a decision-model key per provider and never shows it again, says where each
// provider's key comes from, and names the provider in use and what is sent to it. With
// OPENAI_API_KEY in the daemon's environment and nothing chosen, OpenAI Decisions is in use and the
// group says so; Off stops it, and an ambiguous sentence is then settled by the `voice-routing`
// job, which the suite's fake `codex` answers for two Codex agents.
//
// No spec reaches a real provider: `startDecisionServer` answers both providers' documented
// endpoints and the daemon is pointed at it through `daemonEnv`. No microphone: `say` posts text.

const EVIDENCE = process.env.MC_E2E_EVIDENCE ? artifactsDir("voice-decision-key") : null;
const SAVED_OPENAI = "sk-e2e-saved-openai-0001";
const SAVED_JEV = "ts-e2e-saved-jev-0002";
const ENVIRONMENT_KEY = "sk-e2e-environment-0003";
const SPLIT = "Steve, check the build, and Alice, review the PR";

const test = base.extend<{ decisions: DecisionServer; environmentKey: string | null }>({
  environmentKey: [null, { option: true }],
  // The stand-in exists before the daemon starts: the daemon reads its address at launch.
  // eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixture dependencies.
  decisions: async ({}, use) => {
    const server = await startDecisionServer();
    try {
      await use(server);
    } finally {
      await server.close();
    }
  },
  daemonEnv: async ({ decisions, environmentKey }, use) => {
    await use({ ...decisions.env, ...(environmentKey ? { OPENAI_API_KEY: environmentKey } : {}) });
  },
});

async function capture(target: Locator, name: string): Promise<void> {
  if (!EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.page().mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
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

/** Voice and the three previews it needs, with a cancel window long enough that no card sends. */
async function turnVoiceOn(daemon: DaemonHandle): Promise<void> {
  for (const id of ["async-input", "inbox", "filed-plan-decisions", "voice"]) {
    await api(daemon, "/api/feature-flags", { kind: "flag", id, enabled: true }, "PUT");
  }
  await api(daemon, "/api/voice/config", { cancelWindow: { enabled: true, seconds: 30 } }, "PUT");
}

/** Two Codex agents with call signs, Steve and Alice, so a sentence to both runs on Luna. */
async function codexAgents(daemon: DaemonHandle): Promise<void> {
  for (const callSign of ["Steve", "Alice"]) {
    await api<Task>(daemon, "/api/tasks", {
      repoRoot: daemon.repo, intent: `${callSign}'s work`, title: `${callSign} works here`, kind: "ship",
      workflowId: null, agent: "codex", callSign,
    });
  }
  await expect.poll(async () => (await snapshot(daemon)).voice?.roster.map((r) => r.name).sort()).toEqual(expect.arrayContaining(["Alice", "Steve"]));
}

/** The daemon's snapshot, as the dashboard's event stream receives it first. */
async function snapshot(daemon: DaemonHandle): Promise<{ voiceCards?: VoiceCard[]; voice?: { roster: { name: string; agent: string }[] } }> {
  const controller = new AbortController();
  const response = await fetch(`${daemon.baseURL}/events`, { signal: controller.signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (!text.includes("\n\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    controller.abort();
  }
  const data = text.split("\n\n")[0]!.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
  return JSON.parse(data) as Awaited<ReturnType<typeof snapshot>>;
}

/** Say a sentence and wait for its model step to settle: its Recently heard entry and its card. */
async function sayAndSettle(daemon: DaemonHandle, text: string): Promise<{ entry: HeardEntry; card: VoiceCard | undefined }> {
  const id = crypto.randomUUID();
  expect((await say(daemon, text, { id })).status).toBe(200);
  let entry: HeardEntry | undefined;
  await expect.poll(async () => {
    entry = (await api<{ entries: HeardEntry[] }>(daemon, "/api/voice/heard")).entries.find((e) => e.id === id);
    return entry?.outcome;
  }, { timeout: 15_000 }).toMatch(/^(pending|unsure)$/);
  const card = (await snapshot(daemon)).voiceCards?.find((c) => c.id === id);
  await api(daemon, `/api/voice/cards/${id}/cancel`, {});
  return { entry: entry!, card };
}

const panel = (page: Page) => page.getByRole("tabpanel", { name: "Voice" });
const line = (page: Page) => panel(page).getByRole("status", { name: "Decision model in use" });
const row = (page: Page, provider: string) => panel(page).getByRole("group", { name: provider });
const keyField = (page: Page, provider: string) => panel(page).getByLabel(`${provider} key`, { exact: true });
const providerMenu = (page: Page) => panel(page).getByRole("combobox", { name: "Decision model provider" });
const NOT_SET = `Not set: ${voiceRoutingWithoutProvider()}`;
const using = (provider: string) =>
  `Using ${provider}. Sends the sentence with candidate names or the card question, options and option details.`;

async function openVoiceSettings(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 1400 });
  await page.goto(`${daemon.baseURL}/#/settings/voice`);
  await expect(page.locator('[data-anchor="voice/faster-routing"]')).toBeVisible();
}

async function saveKey(page: Page, provider: string, key: string): Promise<void> {
  await keyField(page, provider).fill(key);
  await row(page, provider).getByRole("button", { name: "Save" }).click();
  await expect(row(page, provider)).toContainText("Saved on this Mac");
  await expect(keyField(page, provider), "the field empties once the key is kept").toHaveValue("");
}

async function holdProviderRequest(page: Page, stage: "write" | "reservation" = "write") {
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route(stage === "write" ? "**/api/voice/config" : "**/api/voice/config/provider-intent", async route => {
    if (stage === "reservation" || (route.request().method() === "PUT" && route.request().postDataJSON().decisionProvider !== undefined)) {
      held.resolve();
      await release.promise;
    }
    await route.continue();
  });
  return { held: held.promise, release: release.resolve };
}

test("a saved key is never shown again: its row reads Saved on this Mac, the group names the provider, and Remove clears it", async ({ dashboard: page, daemon, decisions }) => {
  await turnVoiceOn(daemon);
  await openVoiceSettings(page, daemon);
  await expect(line(page)).toHaveText(NOT_SET);
  await expect(row(page, "OpenAI Decisions")).toContainText("Not set");
  await expect(row(page, "Jev")).toContainText("Not set");
  await expect(row(page, "OpenAI Decisions").getByRole("button", { name: "Remove" })).toHaveCount(0);

  await saveKey(page, "OpenAI Decisions", SAVED_OPENAI);
  await expect(line(page)).toHaveText(using("OpenAI Decisions"));
  await expect(row(page, "Jev")).toContainText("Not set");
  expect(await page.content(), "the page never holds the key once it is saved").not.toContain(SAVED_OPENAI);
  const report = await (await fetch(`${daemon.baseURL}/api/voice/decision-key`)).text();
  expect(report).not.toContain(SAVED_OPENAI);
  const file = join(daemon.home, "voice", "decision-key.json");
  expect(statSync(file).mode & 0o777, "the key file is private").toBe(0o600);
  await capture(panel(page).locator('[data-anchor="voice/faster-routing"]'), "01-openai-saved");

  // A reload reads the same: the report, never the key.
  await page.reload();
  await expect(row(page, "OpenAI Decisions")).toContainText("Saved on this Mac");
  await expect(keyField(page, "OpenAI Decisions")).toHaveValue("");

  await row(page, "OpenAI Decisions").getByRole("button", { name: "Remove" }).click();
  await expect(row(page, "OpenAI Decisions")).toContainText("Not set");
  await expect(line(page)).toHaveText(NOT_SET);
  expect(existsSync(file), "with no key left the file goes").toBe(false);
  expect(decisions.requests, "saving a key sends nothing to a provider").toEqual([]);
});

test("a pending save prevents the other key row from publishing a stale provider", async ({ dashboard: page, daemon }) => {
  await turnVoiceOn(daemon);
  await openVoiceSettings(page, daemon);
  await keyField(page, "Jev").fill(SAVED_JEV);
  await keyField(page, "OpenAI Decisions").fill(SAVED_OPENAI);
  let release!: () => void;
  let begin!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { begin = resolve; });
  await page.route("**/api/voice/decision-key", async route => {
    if (route.request().method() !== "PUT") return route.continue();
    const response = await route.fetch();
    begin();
    await held;
    await route.fulfill({ response });
  });
  await row(page, "Jev").getByRole("button", { name: "Save" }).click();
  await started;
  const saveOpenAI = row(page, "OpenAI Decisions").getByRole("button", { name: "Save" });
  try {
    await expect(saveOpenAI).toBeDisabled({ timeout: 1500 });
    await capture(panel(page).locator('[data-anchor="voice/faster-routing"]'), "09-key-save-in-progress");
  } finally {
    release();
  }
  await saveOpenAI.click();
  await expect(row(page, "Jev")).toContainText("Saved on this Mac");
  await expect(line(page)).toHaveText(using("OpenAI Decisions"));
});

test("with keys on both rows Automatic names OpenAI Decisions, choosing Jev names Jev, and a split sentence reaches Jev with its own key", async ({ dashboard: page, daemon, decisions }) => {
  await turnVoiceOn(daemon);
  await codexAgents(daemon);
  await openVoiceSettings(page, daemon);
  await saveKey(page, "OpenAI Decisions", SAVED_OPENAI);
  await saveKey(page, "Jev", SAVED_JEV);
  await expect(providerMenu(page)).toHaveValue("auto");
  await expect(line(page)).toHaveText(using("OpenAI Decisions"));

  await providerMenu(page).selectOption({ label: "Jev" });
  await expect(line(page)).toHaveText(using("Jev"));
  await expect.poll(async () => (await api<{ config: { decisionProvider: string | null } }>(daemon, "/api/voice/config")).config.decisionProvider).toBe("jev");
  await capture(panel(page).locator('[data-anchor="voice/faster-routing"]'), "02-jev-chosen");
  await capture(panel(page), "06-roster-first");

  const { entry, card } = await sayAndSettle(daemon, SPLIT);
  expect(entry.detail).toBe("Jev answered: split");
  expect(card?.parts.map((p) => [p.target?.name, p.text])).toEqual([["Steve", "check the build"], ["Alice", "review the PR"]]);
  expect(decisions.requests.map((r) => [r.path, r.key, r.model])).toEqual([["/v1/systemone", SAVED_JEV, "jev-1.14.0"]]);
});

test.describe("with OPENAI_API_KEY in the daemon's environment", () => {
  test.use({ environmentKey: ENVIRONMENT_KEY });

  for (const provider of ["OpenAI Decisions", "Off"] as const) {
    test(`${provider} keeps an earlier mention of Alice in Steve's message`, async ({ dashboard: page, daemon, decisions }) => {
      await turnVoiceOn(daemon);
      await codexAgents(daemon);
      await openVoiceSettings(page, daemon);
      await providerMenu(page).selectOption({ label: provider });
      await expect(line(page)).toHaveText(provider === "Off" ? NOT_SET : using(provider));

      const { entry, card } = await sayAndSettle(daemon, "Steve, ask Alice about the build, and Alice, review the PR");
      expect(card?.parts.map(part => [part.target?.name, part.text])).toEqual([
        ["Steve", "ask Alice about the build"], ["Alice", "review the PR"],
      ]);
      expect(entry.detail).toContain(provider === "Off" ? "job on codex answered" : "OpenAI Decisions answered");
      expect(decisions.requests).toHaveLength(provider === "Off" ? 0 : 1);
    });
  }

  test("Off takes effect while an unrelated Voice settings write is stalled", async ({ dashboard: page, daemon, decisions }) => {
    await turnVoiceOn(daemon);
    await codexAgents(daemon);
    await openVoiceSettings(page, daemon);
    await expect(line(page)).toHaveText(using("OpenAI Decisions"));
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await page.route("**/api/voice/config", async route => {
      const req = route.request();
      if (req.method() !== "PUT" || !req.postDataJSON().cancelWindow) return route.continue();
      const earlier = await route.fetch();
      held.resolve();
      await release.promise;
      await route.fulfill({ response: earlier });
    });
    const length = panel(page).getByRole("combobox", { name: "Cancel window length" });
    const previousResponse = page.waitForResponse(r => r.url().endsWith("/api/voice/config") &&
      r.request().method() === "PUT" && Boolean(r.request().postDataJSON().cancelWindow));
    try {
      await length.selectOption("8");
      await held.promise;
      await providerMenu(page).selectOption({ label: "Off" });
      await expect(line(page)).toHaveText(NOT_SET, { timeout: 1_500 });
      const { entry } = await sayAndSettle(daemon, SPLIT);
      expect(entry.detail).toBe("job on codex answered: split");
      expect(decisions.requests).toHaveLength(0);
      await capture(panel(page).locator('[data-anchor="voice/faster-routing"]'), "20-off-during-config-write");
    } finally {
      release.resolve();
      await (await previousResponse).finished();
    }
    await expect(length).toHaveValue("8");
    await expect(providerMenu(page)).toHaveValue("off");
    await expect(line(page)).toHaveText(NOT_SET);
    const { config } = await api<{ config: { decisionProvider: string; cancelWindow: { seconds: number } } }>(daemon, "/api/voice/config");
    expect([config.decisionProvider, config.cancelWindow.seconds]).toEqual(["off", 8]);
  });

  test("a delayed reservation cannot undo Off in another window", async ({ dashboard: page, context, daemon, decisions }) => {
    await turnVoiceOn(daemon);
    await codexAgents(daemon);
    await openVoiceSettings(page, daemon);
    await saveKey(page, "Jev", SAVED_JEV);
    await providerMenu(page).selectOption("openai");
    await expect(line(page)).toHaveText(using("OpenAI Decisions"));
    const other = await context.newPage();
    await openVoiceSettings(other, daemon);
    await expect(line(other)).toHaveText(using("OpenAI Decisions"));
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await page.route("**/api/voice/config/provider-intent", async route => {
      held.resolve();
      await release.promise;
      await route.continue();
    }, { times: 1 });
    const reservation = page.waitForResponse(r => r.url().endsWith("/api/voice/config/provider-intent"));
    try {
      await providerMenu(page).selectOption("jev");
      await held.promise;
      await providerMenu(other).selectOption("off");
      await expect(line(other)).toHaveText(NOT_SET);
    } finally {
      release.resolve();
    }
    expect((await reservation).status()).toBe(409);
    await expect(providerMenu(page)).toHaveValue("off");
    await expect(line(page)).toHaveText(NOT_SET);
    expect((await sayAndSettle(daemon, SPLIT)).entry.detail).toBe("job on codex answered: split");
    expect(decisions.requests).toHaveLength(0);
    await capture(panel(page).locator('[data-anchor="voice/faster-routing"]'), "22-stale-reservation");
    await providerMenu(page).selectOption("jev");
    await expect(line(page)).toHaveText(using("Jev"));
  });

  test("one explicit Off selection from a stale window stops decision-provider routing", async ({ dashboard: page, browser, daemon, decisions }) => {
    await turnVoiceOn(daemon);
    await codexAgents(daemon);
    await openVoiceSettings(page, daemon);
    await expect(line(page)).toHaveText(using("OpenAI Decisions"));
    // Hold the polling window's view at its original revision.
    await page.route("**/api/voice/config", route => route.request().method() === "GET" ? route.abort() : route.continue());
    const releaseReport = Promise.withResolvers<void>();
    await page.route("**/api/voice/decision-key", async route => {
      await releaseReport.promise;
      await route.continue();
    });
    // Separate browser storage exercises the fallback when the tabs cannot order their clicks together.
    const other = await browser.newPage();
    try {
      await openVoiceSettings(other, daemon);
      await expect(providerMenu(other)).toHaveValue("auto");
      await saveKey(other, "Jev", SAVED_JEV);
      await providerMenu(other).selectOption("jev");
      await expect.poll(async () => (await api<{ config: { decisionProvider: string } }>(daemon, "/api/voice/config")).config.decisionProvider).toBe("jev");
    } finally {
      await other.close();
    }
    const conflict = page.waitForResponse(r => r.url().endsWith("/api/voice/config/provider-intent") && r.status() === 409);
    try {
      await providerMenu(page).selectOption("off");
      await conflict;
    } finally {
      releaseReport.resolve();
    }
    await expect(line(page)).toHaveText(NOT_SET, { timeout: 2_000 });
    await expect(providerMenu(page)).toHaveValue("off");
    expect((await sayAndSettle(daemon, SPLIT)).entry.detail).toBe("job on codex answered: split");
    expect(decisions.requests).toHaveLength(0);
    await capture(panel(page).locator('[data-anchor="voice/faster-routing"]'), "23-stale-window-opts-out");
  });

  test("Jev supersedes the same window's Off when both selections precede either reservation", async ({ dashboard: page, daemon, decisions }) => {
    await turnVoiceOn(daemon);
    await codexAgents(daemon);
    await openVoiceSettings(page, daemon);
    await saveKey(page, "Jev", SAVED_JEV);
    await providerMenu(page).selectOption("openai");
    await expect(line(page)).toHaveText(using("OpenAI Decisions"));
    const requests = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const release = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    let count = 0;
    await page.route("**/api/voice/config/provider-intent", async route => {
      const index = count++;
      if (index < 2) {
        requests[index]!.resolve();
        await release[index]!.promise;
      }
      await route.continue();
    });
    try {
      await providerMenu(page).selectOption("off");
      await requests[0]!.promise;
      await providerMenu(page).selectOption("jev");
      await requests[1]!.promise;
      const first = page.waitForResponse(r => r.url().endsWith("/provider-intent"));
      release[0]!.resolve();
      expect((await first).status()).toBe(200);
    } finally {
      for (const gate of release) gate.resolve();
    }
    await expect(line(page)).toHaveText(using("Jev"), { timeout: 1_500 });
    expect((await sayAndSettle(daemon, SPLIT)).entry.detail).toBe("Jev answered: split");
    expect(decisions.requests).toHaveLength(1);
    await capture(panel(page).locator('[data-anchor="voice/faster-routing"]'), "33-same-window-supersedes");
  });

  for (const [earlier, later, title, screenshot] of [
    ["jev", "off", "an earlier Jev reservation arriving after another window reserved Off cannot send speech", "32-off-reserved-first"],
    ["off", "jev", "an earlier Off reservation cannot overtake another window's uncommitted Jev ticket", "34-held-jev-ticket"],
  ] as const) {
    test(title, async ({ dashboard: page, context, daemon, decisions }) => {
      await turnVoiceOn(daemon);
      await codexAgents(daemon);
      await openVoiceSettings(page, daemon);
      await saveKey(page, "Jev", SAVED_JEV);
      await providerMenu(page).selectOption("openai");
      await expect(line(page)).toHaveText(using("OpenAI Decisions"));
      const other = await context.newPage();
      await openVoiceSettings(other, daemon);
      await expect(providerMenu(other)).toHaveValue("openai");
      const held = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      await page.route("**/api/voice/config/provider-intent", async route => {
        held.resolve();
        await release.promise;
        await route.continue();
      }, { times: 1 });
      const laterPut = await holdProviderRequest(other);
      const reservation = page.waitForResponse(r => r.url().endsWith("/provider-intent"));
      try {
        await providerMenu(page).selectOption(earlier);
        await held.promise;
        await providerMenu(other).selectOption(later);
        await laterPut.held;
        release.resolve();
        expect((await reservation).status()).toBe(409);
        await expect(providerMenu(page)).toHaveValue("openai");
      } finally {
        release.resolve();
        laterPut.release();
      }
      await expect(line(other)).toHaveText(later === "off" ? NOT_SET : using("Jev"));
      expect((await sayAndSettle(daemon, SPLIT)).entry.detail).toBe(later === "off" ? "job on codex answered: split" : "Jev answered: split");
      expect(decisions.requests).toHaveLength(later === "off" ? 0 : 1);
      await capture(panel(other).locator('[data-anchor="voice/faster-routing"]'), screenshot);
    });
  }

  test("a later Off wins when both windows click before either reservation reaches the daemon", async ({ dashboard: page, context, daemon, decisions }) => {
    await turnVoiceOn(daemon);
    await codexAgents(daemon);
    await openVoiceSettings(page, daemon);
    await saveKey(page, "Jev", SAVED_JEV);
    await providerMenu(page).selectOption("openai");
    await expect(line(page)).toHaveText(using("OpenAI Decisions"));
    const other = await context.newPage();
    await openVoiceSettings(other, daemon);
    const firstReply = Promise.withResolvers<void>();
    const releaseReply = Promise.withResolvers<void>();
    const hold = async (tab: Page) => {
      const held = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      await tab.route("**/api/voice/config/provider-intent", async route => {
        held.resolve();
        await release.promise;
        if (tab === page) {
          const response = await route.fetch();
          firstReply.resolve();
          await releaseReply.promise;
          await route.fulfill({ response });
        } else {
          await route.continue();
        }
      }, { times: 1 });
      return { held: held.promise, release: release.resolve };
    };
    const first = await hold(page);
    const second = await hold(other);
    try {
      await providerMenu(page).selectOption("jev");
      await first.held;
      await providerMenu(other).selectOption("off");
      await second.held;
      first.release();
      await firstReply.promise;
      const saved = other.waitForResponse(r => r.url().endsWith("/provider-intent"));
      second.release();
      expect((await saved).status()).toBe(200);
      await expect.poll(async () => (await api<{ config: { decisionProvider: string } }>(
        daemon, "/api/voice/config")).config.decisionProvider).toBe("off");
    } finally {
      first.release();
      second.release();
      releaseReply.resolve();
    }
    await expect(providerMenu(page)).toHaveValue("off");
    await expect(line(other)).toHaveText(NOT_SET);
    expect((await sayAndSettle(daemon, SPLIT)).entry.detail).toBe("job on codex answered: split");
    expect(decisions.requests).toHaveLength(0);
    await capture(panel(other).locator('[data-anchor="voice/faster-routing"]'), "37-both-clicks-before-reservation");
  });

  test("an Off reservation delayed before reaching the daemon yields to a later Jev selection", async ({ dashboard: page, context, daemon, decisions }) => {
    await turnVoiceOn(daemon);
    await codexAgents(daemon);
    await openVoiceSettings(page, daemon);
    await saveKey(page, "Jev", SAVED_JEV);
    await providerMenu(page).selectOption("openai");
    await expect(line(page)).toHaveText(using("OpenAI Decisions"));
    const other = await context.newPage();
    await openVoiceSettings(other, daemon);
    await expect(providerMenu(other)).toHaveValue("openai");
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await page.route("**/api/voice/config/provider-intent", async route => {
      held.resolve();
      await release.promise;
      await route.continue();
    }, { times: 1 });
    const conflict = page.waitForResponse(r => r.url().endsWith("/provider-intent") && r.status() === 409);
    try {
      await providerMenu(page).selectOption("off");
      await held.promise;
      await providerMenu(other).selectOption("jev");
      await expect(line(other)).toHaveText(using("Jev"));
    } finally {
      release.resolve();
    }
    await conflict;
    await expect(providerMenu(page)).toHaveValue("jev", { timeout: 1_500 });
    await expect(line(page)).toHaveText(using("Jev"));
    expect((await sayAndSettle(daemon, SPLIT)).entry.detail).toBe("Jev answered: split");
    expect(decisions.requests).toHaveLength(1);
    await capture(panel(page).locator('[data-anchor="voice/faster-routing"]'), "30-delayed-off-reservation");
  });

  test("a delayed ticketed Off cannot overwrite another window's later Jev selection", async ({ dashboard: page, context, daemon, decisions }) => {
    await turnVoiceOn(daemon);
    await codexAgents(daemon);
    await openVoiceSettings(page, daemon);
    await saveKey(page, "Jev", SAVED_JEV);
    await providerMenu(page).selectOption("openai");
    await expect(line(page)).toHaveText(using("OpenAI Decisions"));
    const other = await context.newPage();
    await openVoiceSettings(other, daemon);
    await expect(providerMenu(other)).toHaveValue("openai");
    const off = await holdProviderRequest(page);
    let reservations = 0;
    page.on("request", req => { if (req.url().endsWith("/provider-intent")) reservations++; });
    const conflict = page.waitForResponse(r => r.url().endsWith("/api/voice/config") && r.status() === 409);
    try {
      await providerMenu(page).selectOption("off");
      await off.held;
      await providerMenu(other).selectOption("jev");
      await expect(line(other)).toHaveText(using("Jev"));
    } finally {
      off.release();
    }
    await conflict;
    await expect(providerMenu(page)).toHaveValue("jev", { timeout: 1_500 });
    await expect(line(page)).toHaveText(using("Jev"));
    expect(reservations).toBe(1);
    expect((await sayAndSettle(daemon, SPLIT)).entry.detail).toBe("Jev answered: split");
    expect(decisions.requests).toHaveLength(1);
    await capture(panel(page).locator('[data-anchor="voice/faster-routing"]'), "27-newer-jev-selection");
    await providerMenu(page).selectOption("off");
    await expect(line(page)).toHaveText(NOT_SET);
  });

  test("a delayed Off acknowledgment preserves a newer observed Jev routing report", async ({ dashboard: page, context, daemon, decisions }) => {
    await turnVoiceOn(daemon);
    await codexAgents(daemon);
    await page.clock.install();
    await openVoiceSettings(page, daemon);
    await saveKey(page, "Jev", SAVED_JEV);
    // A Jev banner later in the test must come from the other window's change.
    await providerMenu(page).selectOption("openai");
    await expect(line(page)).toHaveText(using("OpenAI Decisions"));
    const committed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await page.route("**/api/voice/config", async route => {
      if (route.request().method() !== "PUT") return route.continue();
      const response = await route.fetch();
      committed.resolve();
      await release.promise;
      await route.fulfill({ response });
    });
    const ack = page.waitForResponse(r => r.url().endsWith("/api/voice/config") && r.request().method() === "PUT");
    const resumeReads = Promise.withResolvers<void>();
    try {
      await providerMenu(page).selectOption("off");
      await committed.promise;
      const other = await context.newPage();
      await openVoiceSettings(other, daemon);
      await expect(providerMenu(other)).toHaveValue("off");
      await providerMenu(other).selectOption("jev");
      await expect(line(other)).toHaveText(using("Jev"));
      await page.clock.fastForward(5_000);
      await expect(line(page)).toHaveText(using("Jev"));
      await page.route("**/api/voice/decision-key", async route => {
        await resumeReads.promise;
        await route.continue();
      });
      release.resolve();
      expect((await ack).ok()).toBe(true);
      await expect(providerMenu(page)).toHaveValue("jev", { timeout: 1_500 });
      await expect(line(page)).toHaveText(using("Jev"));
      expect((await sayAndSettle(daemon, SPLIT)).entry.detail).toBe("Jev answered: split");
      expect(decisions.requests).toHaveLength(1);
      await capture(panel(page).locator('[data-anchor="voice/faster-routing"]'), "29-delayed-off-ack");
    } finally {
      release.resolve();
      resumeReads.resolve();
    }
  });

  test("a later Off can supersede a pending Jev even when its reservation response is slow", async ({ dashboard: page, context, daemon, decisions }) => {
    await turnVoiceOn(daemon);
    await codexAgents(daemon);
    await openVoiceSettings(page, daemon);
    await saveKey(page, "Jev", SAVED_JEV);
    await providerMenu(page).selectOption("openai");
    await expect(line(page)).toHaveText(using("OpenAI Decisions"));
    const other = await context.newPage();
    await other.clock.install();
    await openVoiceSettings(other, daemon);
    await expect(providerMenu(other)).toHaveValue("openai");
    const jev = await holdProviderRequest(page);
    const responded = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await other.route("**/api/voice/config/provider-intent", async route => {
      const response = await route.fetch();
      responded.resolve();
      await release.promise;
      await route.fulfill({ response });
    }, { times: 1 });
    try {
      await providerMenu(page).selectOption("jev");
      await jev.held;
      await providerMenu(other).selectOption("off");
      await responded.promise;
      await other.clock.fastForward(60_000);
      release.resolve();
      await expect(line(other)).toHaveText(NOT_SET, { timeout: 1_500 });
    } finally {
      release.resolve();
      jev.release();
    }
    await expect(providerMenu(page)).toHaveValue("off");
    expect((await sayAndSettle(daemon, SPLIT)).entry.detail).toBe("job on codex answered: split");
    expect(decisions.requests).toHaveLength(0);
    await capture(panel(other).locator('[data-anchor="voice/faster-routing"]'), "35-later-off-slow-response");
  });

  test("a later ticketed Off takes effect after an older Jev write commits", async ({ dashboard: page, context, daemon, decisions }) => {
    await turnVoiceOn(daemon);
    await codexAgents(daemon);
    await openVoiceSettings(page, daemon);
    await saveKey(page, "Jev", SAVED_JEV);
    await providerMenu(page).selectOption("openai");
    await expect(line(page)).toHaveText(using("OpenAI Decisions"));
    const other = await context.newPage();
    await openVoiceSettings(other, daemon);
    await expect(providerMenu(other)).toHaveValue("openai");
    const jev = await holdProviderRequest(page);
    const off = await holdProviderRequest(other);
    try {
      await providerMenu(page).selectOption("jev");
      await jev.held;
      await providerMenu(other).selectOption("off");
      await off.held;
      jev.release();
      await expect(line(page)).toHaveText(using("Jev"));
    } finally {
      jev.release();
      off.release();
    }
    await expect(line(other)).toHaveText(NOT_SET, { timeout: 1_500 });
    await expect(providerMenu(other)).toHaveValue("off");
    expect((await sayAndSettle(daemon, SPLIT)).entry.detail).toBe("job on codex answered: split");
    expect(decisions.requests).toHaveLength(0);
    await capture(panel(other).locator('[data-anchor="voice/faster-routing"]'), "28-newer-off-selection");
  });

  for (const [earlier, heldAt, screenshot] of [
    ["openai", "write", "31-newer-provider-switch"],
    ["off", "write", "36-observed-off-then-jev"],
    ["off", "reservation", "38-observed-off-before-reservation"],
    ["openai", "both reservations", "39-both-provider-reservations"],
  ] as const) {
    const title = heldAt === "both reservations" ? "a later Jev click survives an OpenAI commit when both reservations were held"
      : `a later Jev ${heldAt} takes effect after the observed ${earlier} selection commits`;
    test(title, async ({ dashboard: page, context, daemon, decisions }) => {
      await turnVoiceOn(daemon);
      await codexAgents(daemon);
      await openVoiceSettings(page, daemon);
      await saveKey(page, "Jev", SAVED_JEV);
      const other = await context.newPage();
      await openVoiceSettings(other, daemon);
      await expect(providerMenu(other)).toHaveValue("auto");
      const first = await holdProviderRequest(page, heldAt === "both reservations" ? "reservation" : "write");
      const jev = await holdProviderRequest(other, heldAt === "write" ? "write" : "reservation");
      try {
        await providerMenu(page).selectOption(earlier);
        await first.held;
        await providerMenu(other).selectOption("jev");
        await jev.held;
        const committed = page.waitForResponse(r => r.url().endsWith("/api/voice/config") && r.request().method() === "PUT");
        first.release();
        expect((await committed).status()).toBe(200);
        await expect(line(page)).toHaveText(earlier === "off" ? NOT_SET : using("OpenAI Decisions"));
      } finally {
        first.release();
        jev.release();
      }
      // The other window was already showing Jev while its PUT was pending.
      await expect.poll(async () => (await api<{ config: { decisionProvider: string } }>(
        daemon, "/api/voice/config")).config.decisionProvider, { timeout: 1_500 }).toBe("jev");
      await expect(providerMenu(other)).toHaveValue("jev");
      await expect(line(other)).toHaveText(using("Jev"));
      expect((await sayAndSettle(daemon, SPLIT)).entry.detail).toBe("Jev answered: split");
      expect(decisions.requests).toHaveLength(1);
      await capture(panel(other).locator('[data-anchor="voice/faster-routing"]'), screenshot);
    });
  }

  for (const heldAt of ["request", "response"] as const) {
    test(`Off supersedes an earlier provider selection with a stalled ${heldAt}`, async ({ dashboard: page, daemon, decisions }) => {
      await turnVoiceOn(daemon);
      await codexAgents(daemon);
      await openVoiceSettings(page, daemon);
      await saveKey(page, "Jev", SAVED_JEV);
      const held = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const earlierResponse = page.waitForResponse(r => r.url().endsWith("/api/voice/config") &&
        r.request().method() === "PUT" && r.request().postDataJSON().decisionProvider === "jev");
      await page.route("**/api/voice/config", async route => {
        const req = route.request();
        if (req.method() !== "PUT" || req.postDataJSON().decisionProvider !== "jev") return route.continue();
        if (heldAt === "request") {
          held.resolve();
          await release.promise;
          await route.continue();
        } else {
          const previous = await route.fetch();
          held.resolve();
          await release.promise;
          await route.fulfill({ response: previous });
        }
      });
      try {
        await providerMenu(page).selectOption("jev");
        await held.promise;
        await providerMenu(page).selectOption("off");
        await expect(line(page)).toHaveText(NOT_SET, { timeout: 1_500 });
        const { entry } = await sayAndSettle(daemon, SPLIT);
        expect(entry.detail).toBe("job on codex answered: split");
        if (heldAt === "request") await capture(panel(page).locator('[data-anchor="voice/faster-routing"]'), "21-off-supersedes-provider");
      } finally {
        release.resolve();
      }
      const response = await earlierResponse;
      await response.finished();
      expect(response.status()).toBe(heldAt === "request" ? 409 : 200);
      await expect(providerMenu(page)).toHaveValue("off");
      await expect(line(page)).toHaveText(NOT_SET);
      expect((await sayAndSettle(daemon, SPLIT)).entry.detail).toBe("job on codex answered: split");
      expect(decisions.requests).toHaveLength(0);
      await providerMenu(page).selectOption("jev");
      await expect(line(page)).toHaveText(using("Jev"));
    });
  }

  for (const mutation of ["save", "remove"] as const) {
    test(`Off stops provider routing before a pending key ${mutation} completes`, async ({ dashboard: page, daemon, decisions }) => {
      await turnVoiceOn(daemon);
      await codexAgents(daemon);
      await openVoiceSettings(page, daemon);
      await expect(line(page)).toHaveText(using("OpenAI Decisions"));
      if (mutation === "remove") await saveKey(page, "Jev", SAVED_JEV);
      const method = mutation === "save" ? "PUT" : "DELETE";
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      await page.route("**/api/voice/decision-key*", async route => {
        if (route.request().method() === method) {
          started.resolve();
          await release.promise;
        }
        await route.continue();
      });
      try {
        if (mutation === "save") await keyField(page, "Jev").fill(SAVED_JEV);
        await row(page, "Jev").getByRole("button", { name: mutation === "save" ? "Save" : "Remove" }).click();
        await started.promise;
        await expect(providerMenu(page)).toBeEnabled({ timeout: 1_500 });
        await providerMenu(page).selectOption({ label: "Off" });
        await expect(line(page)).toHaveText(NOT_SET);
        const { entry } = await sayAndSettle(daemon, SPLIT);
        expect(entry.detail).toBe("job on codex answered: split");
        expect(decisions.requests).toHaveLength(0);
        if (mutation === "save") await capture(panel(page).locator('[data-anchor="voice/faster-routing"]'), "17-off-during-write");
      } finally {
        release.resolve();
      }
      await expect(keyField(page, "Jev")).toBeEnabled();
      await expect(providerMenu(page)).toHaveValue("off");
      await expect(line(page)).toHaveText(NOT_SET);
    });
  }

  test("a broken key file still identifies the environment provider that receives speech", async ({ dashboard: page, daemon, decisions }) => {
    await turnVoiceOn(daemon);
    await codexAgents(daemon);
    const dir = join(daemon.home, "voice");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "decision-key.json"), "malformed fixture", { mode: 0o600 });
    await openVoiceSettings(page, daemon);
    await expect(line(page)).toHaveText(using("OpenAI Decisions"));
    await expect(row(page, "OpenAI Decisions")).toContainText("From the environment");
    await expect(row(page, "OpenAI Decisions")).toContainText("Saved key status unavailable");
    await expect(row(page, "Jev")).toContainText("Status unavailable");
    const { entry } = await sayAndSettle(daemon, SPLIT);
    expect(entry.detail).toBe("OpenAI Decisions answered: split");
    expect(decisions.requests.map(r => r.key)).toEqual([ENVIRONMENT_KEY]);
    await capture(panel(page).locator('[data-anchor="voice/faster-routing"]'), "15-unreadable-environment");
  });

  test("confirming Off refreshes the provider banner before the next poll and discards an older read", async ({ dashboard: page, daemon }) => {
    await turnVoiceOn(daemon);
    await page.clock.install();
    await openVoiceSettings(page, daemon);
    await expect(line(page)).toHaveText(using("OpenAI Decisions"));

    const commit = Promise.withResolvers<void>();
    const readStarted = Promise.withResolvers<{ provider: string; route: Route }>();
    const releaseRead = Promise.withResolvers<void>();
    const confirmedRead = Promise.withResolvers<void>();
    const releaseConfirmedRead = Promise.withResolvers<void>();
    await page.route("**/api/voice/config", async route => {
      if (route.request().method() === "PUT") await commit.promise;
      await route.continue();
    });
    await page.route("**/api/voice/decision-key", async route => {
      const old = await route.fetch();
      const provider = (await old.json()).provider;
      if (provider === null) {
        confirmedRead.resolve();
        await releaseConfirmedRead.promise;
        await route.fulfill({ response: old });
        return;
      }
      readStarted.resolve({ provider, route });
      await releaseRead.promise;
      await route.fulfill({ response: old });
    });
    const saved = page.waitForResponse(r => r.url().endsWith("/api/voice/config") && r.request().method() === "PUT");
    try {
      await providerMenu(page).selectOption({ label: "Off" });
      await page.clock.fastForward(5_000);
      const old = await readStarted.promise;
      expect(old.provider).toBe("openai");
      const cancelled = page.waitForEvent("requestfailed", request => request === old.route.request());
      await expect(line(page)).toHaveText(using("OpenAI Decisions"));
      commit.resolve();
      expect((await saved).ok()).toBe(true);
      await confirmedRead.promise;
      await expect(line(page)).toHaveText(NOT_SET, { timeout: 1_500 });
      await cancelled;
      await capture(panel(page).locator('[data-anchor="voice/faster-routing"]'), "18-off-before-status");
    } finally {
      commit.resolve();
      releaseRead.resolve();
      releaseConfirmedRead.resolve();
    }
    await page.clock.runFor(50);
    await expect(providerMenu(page)).toHaveValue("off");
    await expect(line(page)).toHaveText(NOT_SET);
    await capture(panel(page).locator('[data-anchor="voice/faster-routing"]'), "13-confirmed-off");
  });

  test("the key alone switches OpenAI Decisions on and the group says so; Off stops it and the job answers instead", async ({ dashboard: page, daemon, decisions }) => {
    await turnVoiceOn(daemon);
    await codexAgents(daemon);
    await openVoiceSettings(page, daemon);
    await expect(providerMenu(page)).toHaveValue("auto");
    await expect(line(page)).toHaveText(using("OpenAI Decisions"));
    await expect(row(page, "OpenAI Decisions")).toContainText("From the environment");
    await expect(row(page, "OpenAI Decisions").getByRole("button", { name: "Remove" }), "an environment key has nothing to remove").toHaveCount(0);
    await expect(row(page, "Jev")).toContainText("Not set");
    expect(await page.content()).not.toContain(ENVIRONMENT_KEY);
    await capture(panel(page).locator('[data-anchor="voice/faster-routing"]'), "03-environment-key");

    const viaProvider = await sayAndSettle(daemon, SPLIT);
    expect(viaProvider.entry.detail).toBe("OpenAI Decisions answered: split");
    expect(viaProvider.card?.parts.map((p) => p.target?.name)).toEqual(["Steve", "Alice"]);
    expect(decisions.requests.map((r) => [r.path, r.key, r.model])).toEqual([["/v1/decisions", ENVIRONMENT_KEY, "gpt-6-luna"]]);

    await providerMenu(page).selectOption({ label: "Off" });
    await expect(line(page)).toHaveText(NOT_SET);
    await expect(row(page, "OpenAI Decisions"), "Off leaves the key where it is").toContainText("From the environment");
    await capture(panel(page).locator('[data-anchor="voice/faster-routing"]'), "04-off");

    await expect(line(page)).toContainText("Mixed rosters use the Voice routing job");
    // Off: no request leaves for a provider, and the fake Codex answers the routing job.
    const viaJob = await sayAndSettle(daemon, SPLIT);
    expect(viaJob.entry.detail).toBe("job on codex answered: split");
    expect(viaJob.card?.parts.map((p) => [p.target?.name, p.text])).toEqual([["Steve", "check the build"], ["Alice", "review the PR"]]);
    const mention = await sayAndSettle(daemon, "Steve, ask Alice about the build");
    expect(mention.entry.detail).toBe("job on codex answered: mention");
    expect(mention.card?.parts.map((p) => [p.target?.name, p.text])).toEqual([["Steve", "ask Alice about the build"]]);
    expect(decisions.requests, "Off sent nothing more to the provider").toHaveLength(1);
  });

  test("an active provider can be turned Off before the first config read returns", async ({ dashboard: page, daemon, decisions }) => {
    await turnVoiceOn(daemon);
    await codexAgents(daemon);
    const releaseConfig = Promise.withResolvers<void>();
    await page.route("**/api/voice/config", async route => {
      if (route.request().method() === "GET") await releaseConfig.promise;
      await route.continue();
    });
    try {
      await openVoiceSettings(page, daemon);
      await expect(line(page)).toHaveText(using("OpenAI Decisions"));
      await expect(providerMenu(page)).toBeEnabled({ timeout: 1_500 });
      await providerMenu(page).selectOption("off");
      await expect(line(page)).toHaveText(NOT_SET);
      expect((await sayAndSettle(daemon, SPLIT)).entry.detail).toBe("job on codex answered: split");
      expect(decisions.requests).toHaveLength(0);
    } finally {
      releaseConfig.resolve();
    }
  });

  for (const next of ["openai", "off"] as const) {
    test(`a lost provider PUT response reconciles a switch to ${next} before the next poll`, async ({ dashboard: page, daemon, decisions }) => {
      await turnVoiceOn(daemon);
      await codexAgents(daemon);
      await openVoiceSettings(page, daemon);
      if (next === "openai") await providerMenu(page).selectOption("off");
      await expect(line(page)).toHaveText(next === "openai" ? NOT_SET : using("OpenAI Decisions"));
      const release = Promise.withResolvers<void>();
      const reads = new Set<string>();
      await page.route(/\/api\/voice\/(?:config|decision-key)$/, async route => {
        if (route.request().method() === "GET") {
          reads.add(new URL(route.request().url()).pathname);
          await release.promise;
          return route.continue();
        }
        expect((await route.fetch()).ok()).toBe(true);
        await route.abort("connectionreset");
      });
      try {
        await providerMenu(page).selectOption(next);
        await expect(line(page)).toHaveText("Reading…", { timeout: 1_500 });
        await expect(providerMenu(page)).toHaveValue("unknown");
        await expect(panel(page)).toContainText("The provider change could not be confirmed.");
        await expect.poll(() => reads.size, { timeout: 1_500 }).toBe(2);
      } finally {
        release.resolve();
      }
      await expect(providerMenu(page)).toHaveValue(next);
      await expect(line(page)).toHaveText(next === "openai" ? using("OpenAI Decisions") : NOT_SET, { timeout: 1_500 });
      expect((await sayAndSettle(daemon, SPLIT)).entry.detail).toBe(next === "openai" ? "OpenAI Decisions answered: split" : "job on codex answered: split");
      expect(decisions.requests).toHaveLength(next === "openai" ? 1 : 0);
      if (next === "openai") await capture(panel(page).locator('[data-anchor="voice/faster-routing"]'), "26-lost-provider-response");
    });
  }

  for (const stage of ["reservation", "write"] as const) {
    test(`an unanswered provider ${stage} expires and reconciles the window with the daemon`, async ({ dashboard: page, context, daemon }) => {
      await turnVoiceOn(daemon);
      await api(daemon, "/api/voice/config", { cancelWindow: { enabled: true, seconds: 4 } }, "PUT");
      const other = await context.newPage();
      await openVoiceSettings(other, daemon);
      await page.clock.install();
      await openVoiceSettings(page, daemon);
      const length = (tab: Page) => panel(tab).getByRole("combobox", { name: "Cancel window length" });
      await expect(length(page)).toHaveValue("4");
      const stalled = await holdProviderRequest(page, stage);
      try {
        await providerMenu(page).selectOption("off");
        await stalled.held;
        await expect(providerMenu(page)).toHaveValue("off");
        await providerMenu(other).selectOption("openai");
        await length(other).selectOption("8");
        await expect.poll(async () => (await api<{ config: { decisionProvider: string; cancelWindow: { seconds: number } } }>(daemon, "/api/voice/config")).config)
          .toMatchObject({ decisionProvider: "openai", cancelWindow: { seconds: 8 } });
        await page.clock.fastForward(75_000);
        await expect(providerMenu(page)).toHaveValue("openai", { timeout: 2_000 });
        await expect(line(page)).toHaveText(using("OpenAI Decisions"));
        await expect(length(page)).toHaveValue("8");
        await expect(panel(page)).toContainText("The provider change could not be confirmed.");
        if (stage === "write") await capture(panel(page).locator('[data-anchor="voice/faster-routing"]'), "42-expired-provider-write");
      } finally {
        stalled.release();
      }
    });
  }

  test("a fresh provider report discloses routing enabled in another window while config is stalled", async ({ dashboard: page, context, daemon, decisions }) => {
    await turnVoiceOn(daemon);
    await codexAgents(daemon);
    await page.clock.install();
    await openVoiceSettings(page, daemon);
    await providerMenu(page).selectOption({ label: "Off" });
    await expect(line(page)).toHaveText(NOT_SET);
    const writer = await context.newPage();
    await openVoiceSettings(writer, daemon);
    await expect(providerMenu(writer)).toHaveValue("off");
    const releaseConfig = Promise.withResolvers<void>();
    await page.route("**/api/voice/config", async route => {
      if (route.request().method() === "GET") await releaseConfig.promise;
      await route.continue();
    });
    try {
      await providerMenu(writer).selectOption({ label: "Automatic" });
      await expect(line(writer)).toHaveText(using("OpenAI Decisions"));
      const refreshed = page.waitForResponse(r => r.url().endsWith("/api/voice/decision-key"));
      await page.clock.fastForward(5_000);
      expect((await (await refreshed).json()).provider).toBe("openai");
      await expect(line(page)).toHaveText(using("OpenAI Decisions"), { timeout: 1_500 });
      const { entry } = await sayAndSettle(daemon, SPLIT);
      expect(entry.detail).toBe("OpenAI Decisions answered: split");
      expect(decisions.requests).toHaveLength(1);
      await capture(line(page), "19-fresh-active-provider");
      await expect(providerMenu(page)).toHaveValue("auto", { timeout: 1_500 });
      await capture(panel(page).locator('[data-anchor="voice/faster-routing"]'), "24-active-menu-during-config-stall");
      await providerMenu(page).selectOption("off");
      await expect(line(page)).toHaveText(NOT_SET, { timeout: 1_500 });
      await expect(providerMenu(page)).toHaveValue("off");
      expect((await sayAndSettle(daemon, SPLIT)).entry.detail).toBe("job on codex answered: split");
      expect(decisions.requests).toHaveLength(1);
    } finally {
      releaseConfig.resolve();
    }
  });
});

test("the voice preview gates the routing controls and background job live", async ({ dashboard: page, daemon }) => {
  await page.setViewportSize({ width: 1280, height: 1400 });
  await page.goto(`${daemon.baseURL}/#/settings/models`);
  const goal = page.getByRole("combobox", { name: "Goal provider", exact: true });
  const voice = page.getByRole("combobox", { name: "Voice routing provider", exact: true });
  await expect(goal).toBeVisible();
  await capture(page.locator('[data-anchor="models/jobs"]'), "08-models-preview-off");
  await expect(voice).toHaveCount(0);
  expect((await fetch(`${daemon.baseURL}/api/llm/config`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ runners: { "voice-routing": "codex" } }),
  })).status).toBe(404);
  await api(daemon, "/api/feature-flags", { kind: "flag", id: "background-reasoning-effort", enabled: true }, "PUT");
  await expect(page.getByRole("combobox", { name: "Goal effort", exact: true })).toBeVisible();
  const changeVoiceEffort = () => page.request.put(`${daemon.baseURL}/api/llm/config`, {
    data: { efforts: { "voice-routing": "high" } },
  });
  expect((await changeVoiceEffort()).status()).toBe(404);
  await turnVoiceOn(daemon);
  await expect(voice).toBeVisible();
  expect((await changeVoiceEffort()).status()).toBe(400);
  await voice.selectOption("codex");
  const routingRow = page.locator('[data-anchor="models/job-voice-routing"]');
  await expect(routingRow).toContainText("gpt-6-luna");
  await expect(routingRow.getByRole("combobox")).toHaveCount(1);
  await capture(page.locator('[data-anchor="models/job-voice-routing"]'), "05-models-row");
  await openVoiceSettings(page, daemon);
  await expect(providerMenu(page)).toBeVisible();
  await api(daemon, "/api/feature-flags", { kind: "flag", id: "voice", enabled: false }, "PUT");
  await expect(providerMenu(page)).toHaveCount(0);
  await page.goto(`${daemon.baseURL}/#/settings/models`);
  await expect(goal).toBeVisible();
  await expect(voice).toHaveCount(0);
});

test("an expired config write cannot restore an older cancel window", async ({ dashboard: page, daemon }) => {
  await turnVoiceOn(daemon);
  await api(daemon, "/api/voice/config", { cancelWindow: { enabled: true, seconds: 4 } }, "PUT");
  await openVoiceSettings(page, daemon);
  const length = panel(page).getByRole("combobox", { name: "Cancel window length" });
  await expect(length).toHaveValue("4");
  const stalled = Promise.withResolvers<Route>();
  await page.route("**/api/voice/config", route => {
    if (route.request().method() === "PUT" && route.request().postDataJSON().cancelWindow?.seconds === 8) stalled.resolve(route);
    else return route.continue();
  });
  await length.selectOption("8");
  const earlier = await stalled.promise;
  try {
    const committed = page.waitForResponse(r => r.request().method() === "PUT" && r.url().endsWith("/api/voice/config"));
    await length.selectOption("6");
    expect((await (await committed).json()).config.cancelWindow.seconds).toBe(6);
    expect((await page.request.fetch(earlier.request())).status()).toBe(409);
    await page.reload();
    await expect(length).toHaveValue("6");
    await capture(panel(page).locator('[data-anchor="voice/cancel-window"]'), "45-expired-config-write");
  } finally {
    await earlier.abort().catch(() => undefined);
  }
});

test("a delayed config poll shows the newer cancel window when it reaches the daemon last", async ({ dashboard: page, context, daemon }) => {
  await turnVoiceOn(daemon);
  await api(daemon, "/api/voice/config", { cancelWindow: { enabled: true, seconds: 4 } }, "PUT");
  const writer = await context.newPage();
  await openVoiceSettings(writer, daemon);
  await page.clock.install({ time: new Date("2026-01-01T12:00:00Z") });
  await page.clock.pauseAt(new Date("2026-01-01T12:00:01Z"));
  await openVoiceSettings(page, daemon);
  const length = (tab: Page) => panel(tab).getByRole("combobox", { name: "Cancel window length" });
  await expect(length(page)).toHaveValue("4");

  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route("**/api/voice/config", async route => {
    held.resolve();
    await release.promise;
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), "x-e2e-delayed-config": "yes" } });
  }, { times: 1 });
  try {
    await page.clock.fastForward(5_000);
    await held.promise;
    const second = page.waitForResponse(r => r.url().endsWith("/api/voice/config"));
    await page.clock.fastForward(5_000);
    expect((await (await second).json()).config.cancelWindow.seconds).toBe(4);
    await page.clock.runFor(50);
    const changed = writer.waitForResponse(r => r.url().endsWith("/api/voice/config") && r.request().method() === "PUT");
    await length(writer).selectOption("8");
    expect((await (await changed).json()).config.cancelWindow.seconds).toBe(8);
    const delayed = page.waitForResponse(r => r.headers()["x-e2e-delayed-config"] === "yes");
    release.resolve();
    expect((await (await delayed).json()).config.cancelWindow.seconds).toBe(8);
    await page.clock.runFor(50);
    await expect(length(page)).toHaveValue("8", { timeout: 2_000 });
    await capture(panel(page).locator('[data-anchor="voice/cancel-window"]'), "40-delayed-config-read");
  } finally {
    release.resolve();
  }
});

for (const resource of ["config", "devices", "decision-key"] as const) {
  test(`stalled ${resource} reads expire and leaving Voice cancels the remaining polls`, async ({ dashboard: page, daemon }) => {
    await turnVoiceOn(daemon);
    await page.clock.install({ time: new Date("2026-01-01T12:00:00Z") });
    await page.clock.pauseAt(new Date("2026-01-01T12:00:01Z"));
    await openVoiceSettings(page, daemon);
    await expect(line(page)).toHaveText(NOT_SET);
    const held: Route[] = [];
    const cancelled = new Set<Route>();
    await page.route(`**/api/voice/${resource}`, route => { held.push(route); });
    page.on("requestfailed", request => {
      const route = held.find(r => r.request() === request);
      if (route) cancelled.add(route);
    });
    try {
      for (let i = 1; i <= 4; i++) {
        await page.clock.fastForward(5_000);
        await expect.poll(() => held.length).toBe(i);
      }
      await expect.poll(() => cancelled.size, { timeout: 2_000 }).toBeGreaterThan(0);
      if (resource === "decision-key") {
        await expect(line(page)).toHaveText("Key status unavailable", { timeout: 2_000 });
        await capture(panel(page).locator('[data-anchor="voice/faster-routing"]'), "41-expired-status-poll");
      }
      await page.goto(`${daemon.baseURL}/#/settings/models`);
      await expect(panel(page)).toHaveCount(0);
      await expect.poll(() => cancelled.size).toBe(held.length);
    } finally {
      await Promise.all(held.map(route => route.abort().catch(() => undefined)));
    }
  });
}

test("saving and removing a key cancel earlier polls before refreshing the rows", async ({ dashboard: page, daemon }) => {
  await turnVoiceOn(daemon);
  await page.clock.install({ time: new Date("2026-01-01T12:00:00Z") });
  await page.clock.pauseAt(new Date("2026-01-01T12:00:01Z"));
  await openVoiceSettings(page, daemon);
  await expect(line(page)).toHaveText(NOT_SET);
  for (const action of ["Save", "Remove"] as const) {
    const held = Promise.withResolvers<Route>();
    await page.route("**/api/voice/decision-key", route => held.resolve(route), { times: 1 });
    await page.clock.fastForward(5_000);
    const poll = await held.promise;
    const cancelled = page.waitForEvent("requestfailed", request => request === poll.request());
    try {
      if (action === "Save") await keyField(page, "Jev").fill(SAVED_JEV);
      await row(page, "Jev").getByRole("button", { name: action }).click();
      await expect(line(page)).toHaveText(action === "Save" ? using("Jev") : NOT_SET);
      await cancelled;
    } finally {
      await poll.abort().catch(() => undefined);
    }
  }
});

test("an older poll cannot restore a provider removed in another window", async ({ dashboard: page, context, daemon }) => {
  await turnVoiceOn(daemon);
  const writer = await context.newPage();
  await openVoiceSettings(writer, daemon);
  await saveKey(writer, "OpenAI Decisions", SAVED_OPENAI);
  await page.clock.install();
  await openVoiceSettings(page, daemon);
  await expect(line(page)).toHaveText(using("OpenAI Decisions"));

  let release!: () => void;
  let held!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { held = resolve; });
  await page.route("**/api/voice/decision-key", async route => {
    const prior = await route.fetch();
    held();
    await gate;
    await route.fulfill({ response: prior, headers: { ...prior.headers(), "x-e2e-held-poll": "yes" } });
  }, { times: 1 });
  await page.clock.fastForward(5_000);
  await started;
  const stale = page.waitForResponse(response => response.headers()["x-e2e-held-poll"] === "yes");
  try {
    await row(writer, "OpenAI Decisions").getByRole("button", { name: "Remove" }).click();
    await expect(line(writer)).toHaveText(NOT_SET);
    await page.clock.fastForward(5_000);
    await expect(line(page)).toHaveText(NOT_SET);
  } finally {
    release();
  }
  await (await stale).finished();
  await page.clock.runFor(50);
  await expect(line(page)).toHaveText(NOT_SET, { timeout: 1_000 });
  await expect(row(page, "OpenAI Decisions")).toContainText("Not set");
  await capture(panel(page).locator('[data-anchor="voice/faster-routing"]'), "10-cross-window-removal");
});

for (const firstResponse of ["removed", "saved"] as const) {
  test(`key snapshots read in reverse request order keep a removal when the ${firstResponse} response arrives first`, async ({ dashboard: page, context, daemon }) => {
    await turnVoiceOn(daemon);
    const writer = await context.newPage();
    await openVoiceSettings(writer, daemon);
    await saveKey(writer, "OpenAI Decisions", SAVED_OPENAI);
    await page.clock.install({ time: new Date("2026-01-01T12:00:00Z") });
    await page.clock.pauseAt(new Date("2026-01-01T12:00:01Z"));
    await openVoiceSettings(page, daemon);
    await expect(line(page)).toHaveText(using("OpenAI Decisions"));

    const held = [Promise.withResolvers<void>(), Promise.withResolvers<void>()] as const;
    const release = [Promise.withResolvers<void>(), Promise.withResolvers<void>()] as const;
    const removed = Promise.withResolvers<void>();
    let requests = 0;
    await page.route("**/api/voice/decision-key", async route => {
      const index = requests++;
      if (index > 1) return route.continue();
      if (index === 0) {
        held[0].resolve();
        await removed.promise;
      }
      const response = await route.fetch();
      if (index === 1) held[1].resolve();
      await release[index]!.promise;
      await route.fulfill({ response, headers: { ...response.headers(), "x-e2e-key-state": index === 0 ? "removed" : "saved" } });
    });
    try {
      for (const gate of held) {
        await page.clock.fastForward(5_000);
        await gate.promise;
      }
      await row(writer, "OpenAI Decisions").getByRole("button", { name: "Remove" }).click();
      await expect(line(writer)).toHaveText(NOT_SET);
      removed.resolve();
      for (const state of [firstResponse, firstResponse === "removed" ? "saved" : "removed"]) {
        const arrived = page.waitForResponse(r => r.headers()["x-e2e-key-state"] === state);
        release[state === "removed" ? 0 : 1].resolve();
        expect((await (await arrived).json()).keys.openai.source).toBe(state === "removed" ? null : "settings");
        await page.clock.runFor(50);
        if (state === "removed") await expect(line(page)).toHaveText(NOT_SET);
      }
      await expect(line(page)).toHaveText(NOT_SET);
      await expect(row(page, "OpenAI Decisions").getByRole("button", { name: "Remove" })).toHaveCount(0);
      if (firstResponse === "removed") await capture(panel(page).locator('[data-anchor="voice/faster-routing"]'), "39-reverse-key-snapshots");
    } finally {
      removed.resolve();
      release.forEach(gate => gate.resolve());
    }
  });
}

test("a delayed local save cannot restore a key removed by another window", async ({ dashboard: page, context, daemon }) => {
  await turnVoiceOn(daemon);
  await page.clock.install();
  await openVoiceSettings(page, daemon);
  await expect(line(page)).toHaveText(NOT_SET);
  let release!: () => void;
  let saved!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const committed = new Promise<void>(resolve => { saved = resolve; });
  await page.route("**/api/voice/decision-key", async route => {
    if (route.request().method() !== "PUT") return route.continue();
    const response = await route.fetch();
    saved();
    await held;
    await route.fulfill({ response });
  });
  await keyField(page, "OpenAI Decisions").fill(SAVED_OPENAI);
  await row(page, "OpenAI Decisions").getByRole("button", { name: "Save" }).click();
  await committed;
  try {
    const other = await context.newPage();
    await openVoiceSettings(other, daemon);
    await expect(line(other)).toHaveText(using("OpenAI Decisions"));
    await row(other, "OpenAI Decisions").getByRole("button", { name: "Remove" }).click();
    await expect(line(other)).toHaveText(NOT_SET);
    const polled = page.waitForResponse(response =>
      response.url().endsWith("/api/voice/decision-key") && response.request().method() === "GET");
    await page.clock.fastForward(5_000);
    expect((await (await polled).json()).keys.openai.source).toBeNull();
  } finally {
    release();
  }
  await expect(keyField(page, "OpenAI Decisions")).toHaveValue("");
  await expect(line(page)).toHaveText(NOT_SET, { timeout: 1_000 });
  await expect(row(page, "OpenAI Decisions").getByRole("button", { name: "Remove" })).toHaveCount(0);
  await capture(panel(page).locator('[data-anchor="voice/faster-routing"]'), "11-delayed-save-after-removal");
});

test("a timed-out key replacement arriving after removal cannot restore the credential", async ({ dashboard: page, daemon }) => {
  await turnVoiceOn(daemon);
  await page.clock.install();
  await openVoiceSettings(page, daemon);
  await saveKey(page, "OpenAI Decisions", SAVED_OPENAI);
  const delayed = Promise.withResolvers<Route>();
  await page.route("**/api/voice/decision-key", route => {
    if (route.request().method() !== "PUT") return route.continue();
    delayed.resolve(route);
  });
  await keyField(page, "OpenAI Decisions").fill("synthetic-replacement-key");
  await row(page, "OpenAI Decisions").getByRole("button", { name: "Save" }).click();
  const replacement = await delayed.promise;
  try {
    await page.clock.fastForward(15_000);
    const remove = row(page, "OpenAI Decisions").getByRole("button", { name: "Remove" });
    await expect(remove).toBeEnabled();
    await remove.click();
    await expect(line(page)).toHaveText(NOT_SET);
    // Deliver the captured request independently of the browser's aborted connection.
    expect((await page.request.fetch(replacement.request())).status()).toBe(409);
    expect(existsSync(join(daemon.home, "voice", "decision-key.json"))).toBe(false);
    await page.clock.fastForward(5_000);
    await expect(row(page, "OpenAI Decisions")).toContainText("Not set");
    await expect(line(page)).toHaveText(NOT_SET);
    await capture(panel(page).locator('[data-anchor="voice/faster-routing"]'), "44-stale-key-replacement");
  } finally {
    await replacement.abort().catch(() => undefined);
  }
});

for (const mutation of ["save", "remove"] as const) {
  test(`an expired key ${mutation} arriving after reconciliation cannot change routing`, async ({ dashboard: page, daemon }) => {
    await turnVoiceOn(daemon);
    await openVoiceSettings(page, daemon);
    await expect(line(page)).toHaveText(NOT_SET);
    if (mutation === "remove") await saveKey(page, "OpenAI Decisions", SAVED_OPENAI);
    const stalled = Promise.withResolvers<Route>();
    await page.route("**/api/voice/decision-key*", route => {
      if (route.request().method() === "GET") return route.continue();
      stalled.resolve(route);
    });
    if (mutation === "save") await keyField(page, "OpenAI Decisions").fill(SAVED_OPENAI);
    await row(page, "OpenAI Decisions").getByRole("button", { name: mutation === "save" ? "Save" : "Remove" }).click();
    const late = await stalled.promise;
    try {
      const priorStatus = mutation === "save" ? NOT_SET : using("OpenAI Decisions");
      await expect(panel(page)).toContainText("The key change could not be confirmed.", { timeout: 20_000 });
      await expect(line(page)).toHaveText(priorStatus);
      expect((await page.request.fetch(late.request())).status()).toBe(409);
      await page.reload();
      await expect(line(page)).toHaveText(priorStatus);
      expect(existsSync(join(daemon.home, "voice", "decision-key.json"))).toBe(mutation === "remove");
      if (mutation === "save") await capture(panel(page).locator('[data-anchor="voice/faster-routing"]'), "46-expired-key-delivery");
    } finally {
      await late.abort().catch(() => undefined);
    }
  });

  test(`a stalled key ${mutation} releases both rows and reads the committed change`, async ({ dashboard: page, daemon }) => {
    await turnVoiceOn(daemon);
    await page.clock.install();
    await openVoiceSettings(page, daemon);
    await expect(line(page)).toHaveText(NOT_SET);
    if (mutation === "remove") await saveKey(page, "OpenAI Decisions", SAVED_OPENAI);
    const committed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await page.route("**/api/voice/decision-key*", async route => {
      if (route.request().method() === "GET") return route.continue();
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      committed.resolve();
      await release.promise;
      await route.fulfill({ response });
    });
    try {
      if (mutation === "save") await keyField(page, "OpenAI Decisions").fill(SAVED_OPENAI);
      await row(page, "OpenAI Decisions").getByRole("button", { name: mutation === "save" ? "Save" : "Remove" }).click();
      await committed.promise;
      await expect(keyField(page, "Jev")).toBeDisabled();
      await page.clock.fastForward(15_000);
      await expect(keyField(page, "Jev")).toBeEnabled({ timeout: 2_000 });
      await expect(keyField(page, "OpenAI Decisions")).toBeEnabled();
      await expect(keyField(page, "OpenAI Decisions")).toHaveValue("");
      await expect(panel(page)).toContainText("The key change could not be confirmed.");
      await expect(line(page)).toHaveText(mutation === "save" ? using("OpenAI Decisions") : NOT_SET);
      if (mutation === "save") await capture(panel(page).locator('[data-anchor="voice/faster-routing"]'), "43-expired-key-save");
    } finally {
      release.resolve();
    }
  });

  test(`a lost key ${mutation} response refreshes the provider disclosure immediately`, async ({ dashboard: page, daemon, decisions }) => {
    await turnVoiceOn(daemon);
    await codexAgents(daemon);
    await openVoiceSettings(page, daemon);
    await expect(line(page)).toHaveText(NOT_SET);
    if (mutation === "remove") await saveKey(page, "OpenAI Decisions", SAVED_OPENAI);
    const release = Promise.withResolvers<void>();
    await page.route("**/api/voice/decision-key*", async route => {
      if (route.request().method() === "GET") {
        await release.promise;
        return route.continue();
      }
      expect((await route.fetch()).ok()).toBe(true);
      await route.abort("connectionreset");
    });
    try {
      if (mutation === "save") await keyField(page, "OpenAI Decisions").fill(SAVED_OPENAI);
      await row(page, "OpenAI Decisions").getByRole("button", { name: mutation === "save" ? "Save" : "Remove" }).click();
      await expect(line(page)).toHaveText("Reading…", { timeout: 1_500 });
      await expect(row(page, "OpenAI Decisions")).toContainText("Reading…");
      await expect(panel(page)).toContainText("The key change could not be confirmed.");
      if (mutation === "save") await expect(keyField(page, "OpenAI Decisions")).toHaveValue("");
    } finally {
      release.resolve();
    }
    const saved = mutation === "save";
    await expect(line(page)).toHaveText(saved ? using("OpenAI Decisions") : NOT_SET, { timeout: 1_500 });
    await expect(row(page, "OpenAI Decisions")).toContainText(saved ? "Saved on this Mac" : "Not set");
    const { entry } = await sayAndSettle(daemon, SPLIT);
    expect(entry.detail).toBe(saved ? "OpenAI Decisions answered: split" : "job on codex answered: split");
    expect(decisions.requests).toHaveLength(saved ? 1 : 0);
    if (saved) await capture(line(page), "25-lost-save-response");
  });

  test(`a successful ${mutation} followed by a failed status read clears the stale key report`, async ({ dashboard: page, daemon }) => {
    await turnVoiceOn(daemon);
    await page.clock.install();
    await openVoiceSettings(page, daemon);
    await expect(line(page)).toHaveText(NOT_SET);
    if (mutation === "remove") await saveKey(page, "OpenAI Decisions", SAVED_OPENAI);

    let failReads = true;
    await page.route("**/api/voice/decision-key", route => route.request().method() === "GET" && failReads
      ? route.fulfill({ status: 503, body: "unavailable" }) : route.continue());
    if (mutation === "save") {
      await keyField(page, "OpenAI Decisions").fill(SAVED_OPENAI);
      await row(page, "OpenAI Decisions").getByRole("button", { name: "Save" }).click();
      await expect(keyField(page, "OpenAI Decisions")).toHaveValue("");
    } else {
      await row(page, "OpenAI Decisions").getByRole("button", { name: "Remove" }).click();
    }
    await expect(line(page)).toHaveText("Key status unavailable");
    for (const provider of ["OpenAI Decisions", "Jev"]) {
      await expect(row(page, provider)).toContainText("Status unavailable");
      await expect(row(page, provider).getByRole("button", { name: "Remove" })).toHaveCount(0);
    }
    expect(existsSync(join(daemon.home, "voice", "decision-key.json"))).toBe(mutation === "save");
    if (mutation === "remove") await capture(panel(page).locator('[data-anchor="voice/faster-routing"]'), "12-status-unavailable");
    failReads = false;
    await page.clock.fastForward(5_000);
    await expect(line(page)).toHaveText(mutation === "save" ? using("OpenAI Decisions") : NOT_SET);
  });
}

test("an unreadable key store shows unavailable while ambiguous speech still reaches the routing job", async ({ dashboard: page, daemon, decisions }) => {
  await turnVoiceOn(daemon);
  await codexAgents(daemon);
  await page.clock.install();
  await openVoiceSettings(page, daemon);
  await saveKey(page, "OpenAI Decisions", SAVED_OPENAI);
  const path = join(daemon.home, "voice", "decision-key.json");
  const saved = readFileSync(path);
  writeFileSync(path, "broken fixture credential file");
  await page.clock.fastForward(5_000);
  await expect(line(page)).toHaveText(`Saved key status unavailable: ${voiceRoutingWithoutProvider()}`);
  await expect(row(page, "OpenAI Decisions")).toContainText("Status unavailable");
  await expect(row(page, "Jev")).toContainText("Status unavailable");
  const { entry, card } = await sayAndSettle(daemon, SPLIT);
  expect(entry.detail).toBe("job on codex answered: split");
  expect(card?.parts.map(part => part.target?.name)).toEqual(["Steve", "Alice"]);
  expect(decisions.requests).toHaveLength(0);
  await capture(panel(page).locator('[data-anchor="voice/faster-routing"]'), "14-unreadable-store");
  writeFileSync(path, saved);
  await page.clock.fastForward(5_000);
  await expect(line(page)).toHaveText(using("OpenAI Decisions"));
  await expect(row(page, "OpenAI Decisions")).toContainText("Saved on this Mac");
});

for (const mutation of ["save", "remove"] as const) {
  test(`Off remains available during a stalled status refresh after a confirmed ${mutation}`, async ({ dashboard: page, daemon }) => {
    await turnVoiceOn(daemon);
    await openVoiceSettings(page, daemon);
    await expect(line(page)).toHaveText(NOT_SET);
    if (mutation === "remove") await saveKey(page, "Jev", SAVED_JEV);
    const refreshing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await page.route("**/api/voice/decision-key", async route => {
      if (route.request().method() !== "GET") return route.continue();
      const status = await route.fetch();
      refreshing.resolve();
      await release.promise;
      await route.fulfill({ response: status });
    });
    try {
      if (mutation === "save") await keyField(page, "Jev").fill(SAVED_JEV);
      await row(page, "Jev").getByRole("button", { name: mutation === "save" ? "Save" : "Remove" }).click();
      await refreshing.promise;
      await expect(providerMenu(page)).toBeEnabled({ timeout: 1_500 });
      await expect(keyField(page, "Jev")).toHaveValue("");
      const saved = page.waitForResponse(r => r.url().endsWith("/api/voice/config") && r.request().method() === "PUT");
      await providerMenu(page).selectOption({ label: "Off" });
      expect((await saved).ok()).toBe(true);
      if (mutation === "save") await capture(panel(page).locator('[data-anchor="voice/faster-routing"]'), "16-off-during-refresh");
    } finally {
      release.resolve();
    }
    await expect(line(page)).toHaveText(NOT_SET);
    await expect(providerMenu(page)).toHaveValue("off");
  });
}
