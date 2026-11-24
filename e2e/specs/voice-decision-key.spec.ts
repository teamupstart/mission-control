import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
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
  `Using ${provider}. Ambiguous sentences and the roster's names and roles are sent to ${provider}.`;

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

  await expect.poll(async () => (await snapshot(daemon)).voice?.roster.map((r) => r.name).sort()).toEqual(expect.arrayContaining(["Alice", "Steve"]));
  const { entry, card } = await sayAndSettle(daemon, SPLIT);
  expect(entry.detail).toBe("Jev answered: split");
  expect(card?.parts.map((p) => [p.target?.name, p.text])).toEqual([["Steve", "check the build"], ["Alice", "review the PR"]]);
  expect(decisions.requests.map((r) => [r.path, r.key, r.model])).toEqual([["/v1/systemone", SAVED_JEV, "jev-1.14.0"]]);
});

test.describe("with OPENAI_API_KEY in the daemon's environment", () => {
  test.use({ environmentKey: ENVIRONMENT_KEY });

  test("confirming Off refreshes the provider banner before the next poll and discards an older read", async ({ dashboard: page, daemon }) => {
    await turnVoiceOn(daemon);
    await page.clock.install();
    await openVoiceSettings(page, daemon);
    await expect(line(page)).toHaveText(using("OpenAI Decisions"));

    const commit = Promise.withResolvers<void>();
    const readStarted = Promise.withResolvers<string | null>();
    const releaseRead = Promise.withResolvers<void>();
    await page.route("**/api/voice/config", async route => {
      if (route.request().method() === "PUT") await commit.promise;
      await route.continue();
    });
    await page.route("**/api/voice/decision-key", async route => {
      const old = await route.fetch();
      readStarted.resolve((await old.json()).provider);
      await releaseRead.promise;
      await route.fulfill({ response: old, headers: { ...old.headers(), "x-e2e-old-provider": "yes" } });
    }, { times: 1 });
    const saved = page.waitForResponse(r => r.url().endsWith("/api/voice/config") && r.request().method() === "PUT");
    const oldReport = page.waitForResponse(r => r.headers()["x-e2e-old-provider"] === "yes");
    try {
      await providerMenu(page).selectOption({ label: "Off" });
      await page.clock.fastForward(5_000);
      expect(await readStarted.promise).toBe("openai");
      commit.resolve();
      expect((await saved).ok()).toBe(true);
      await expect(line(page)).toHaveText(NOT_SET, { timeout: 1_500 });
    } finally {
      commit.resolve();
      releaseRead.resolve();
      await (await oldReport).finished();
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

    await expect.poll(async () => (await snapshot(daemon)).voice?.roster.map((r) => r.name).sort()).toEqual(expect.arrayContaining(["Alice", "Steve"]));
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

for (const mutation of ["save", "remove"] as const) {
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
  await expect(line(page)).toHaveText("Key status unavailable");
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
