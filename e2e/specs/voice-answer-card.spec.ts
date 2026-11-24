import type { Page, Locator } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import { captureCard, runningAgent, setupCards } from "../fixtures/voice-cards.ts";
import { say, voiceToken } from "../fixtures/voice.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";

async function selectedStyle(page: Page, design: string, selector: string, properties: string[]) {
  const reference = await page.context().newPage();
  try {
    await reference.goto(new URL(`../../docs/plans/voice-addressing-for-agents/mockup-${design}.html`, import.meta.url).href);
    return await reference.locator(selector).first().evaluate((el, props) =>
      Object.fromEntries(props.map(p => [p, getComputedStyle(el).getPropertyValue(p)])), properties);
  } finally {
    await reference.close();
    await page.bringToFront();
  }
}

async function expectStyle(element: Locator, styles: Record<string, string>) {
  for (const [property, value] of Object.entries(styles)) await expect(element).toHaveCSS(property, value);
}

test("answer, correct, cancel and submit through a question card or its countdown companion", async ({ dashboard: page, daemon }) => {
  test.setTimeout(150_000);
  await setupCards(page, daemon, 4);
  const steve = await runningAgent(page, daemon, "Steve");
  const title = "SQLite or Postgres for the cache?";
  const file = async (cwd: string, question: string, choices = true) => {
    const result = await page.request.post(daemon.baseURL + "/mcp/reviews", { headers: { "x-harness-token": voiceToken(daemon) },
      data: { kind: "input", env: {}, cwd, title: question, body: question, snoozable: true,
        ...(choices && { decisions: [{ id: "q", question, allowOther: true, options: [
          { id: "sqlite", label: "SQLite", detail: "One file, no service to run." },
          { id: "postgres", label: "Postgres", recommended: true, detail: "Already runs for the job queue." },
        ] }] }) } });
    expect(result.ok(), await result.text()).toBe(true);
    return (await result.json()).id as string;
  };
  const read = async (id: string) => (await page.request.get(daemon.baseURL + "/api/reviews/" + id)).json();
  const open = async () => {
    const report = page.waitForResponse(r => r.url().endsWith("/api/voice/open-cards") && r.request().postDataJSON().cards.length > 0 && r.ok());
    await page.locator("button.pulse-seg", { hasText: "to answer" }).click();
    await report;
    await expectContentClearsBorder(page.getByRole("dialog", { name: "Attention inbox" }));
  };
  const hintStyle = await selectedStyle(page, "voice-hints", "#a .vh-foot", ["gap", "padding-top", "border-top-style", "align-items"]);
  const footStyle = await selectedStyle(page, "answer-card-by-voice", "#d .av-foot", ["padding", "gap", "border-radius", "font-size"]);
  const keyStyle = await selectedStyle(page, "answer-card-by-voice", "#d .av-key", ["width", "height", "border-radius", "font-weight"]);
  const id = await file(steve.cwd, title);
  await open();
  const card = page.locator(".review").filter({ has: page.getByRole("heading", { name: title }) });
  const a = card.getByRole("radio", { name: /SQLite/ });
  const b = card.getByRole("radio", { name: /Postgres/ });
  await expect(card.locator(".vh-foot")).toContainText("Steve, option B");
  await expect(card.locator(".vh-foot")).toContainText("Steve, answer: …");
  const row = page.locator(".inbox-item").filter({ has: card });
  await expectStyle(card.locator(".vh-foot"), hintStyle);
  const sqliteBadge = card.locator("label").filter({ hasText: "SQLite" }).locator(".av-key");
  const postgresBadge = card.locator("label").filter({ hasText: "Postgres" }).locator(".av-key");
  await expect(sqliteBadge).toBeVisible();
  await expect(sqliteBadge).toHaveText("A");
  await expect(postgresBadge).toBeVisible();
  await expect(postgresBadge).toHaveText("B");
  await expectStyle(sqliteBadge, keyStyle);
  await captureCard(row, "answer-rest");
  await say(daemon, "Steve, option C");
  await expect(page.getByText("No matching option.", { exact: true })).toBeVisible();
  await expect(card.getByRole("textbox")).toBeEmpty();
  await expect(card.getByRole("button", { name: "Submit now" })).toHaveCount(0);
  await captureCard(page, "answer-unavailable-choice");
  await say(daemon, "option B");
  await expect(b).not.toBeChecked();
  await say(daemon, "Steve, option B");
  await expect(b).toBeChecked();
  const footer = card.getByRole("status").filter({ hasText: "Submit now" });
  await expect(footer).toContainText("B · Postgres");
  await expect(footer.getByRole("button", { name: "Cancel" })).toHaveAccessibleDescription("Cancel this pending voice answer");
  await expect(footer.getByRole("button", { name: "Submit now" })).toHaveAccessibleDescription("Submit this voice answer before the countdown ends");
  await expect(footer).toContainText(/submits in [1-4]s/);
  await expectStyle(footer, footStyle);
  await captureCard(row, "answer-countdown");
  await footer.getByRole("button", { name: "Cancel" }).hover();
  await expect(page.locator(".tooltip").filter({ hasText: "Cancel this pending voice answer" })).toBeVisible();
  await captureCard(row, "answer-cancel-tooltip");
  await a.click();
  await expect(footer).toHaveCount(0);
  await say(daemon, "reply, option B");
  await expect(b).toBeChecked();
  await say(daemon, "cancel");
  await expect(footer).toHaveCount(0);
  await expect(a).toBeChecked();
  await say(daemon, "Steve, option B");
  await say(daemon, "no, A");
  await expect(footer).toContainText("Changed to A · SQLite");
  await expect(a).toBeChecked();
  await captureCard(row, "answer-switched");
  await expect.poll(async () => (await read(id)).selections).toEqual([{ decisionId: "q", selected: ["sqlite"], other: null }]);
  if (await page.getByRole("dialog", { name: "Attention inbox" }).isVisible()) await page.keyboard.press("Escape");
  const next = await file(steve.cwd, title);
  await say(daemon, "Steve, do X");
  const message = page.getByRole("status").filter({ hasText: "do X" });
  await message.getByRole("button", { name: "Send now" }).click();
  await expect(page.getByText("Held for Steve")).toBeVisible();
  expect((await read(next)).status).toBe("pending");
  await say(daemon, "Steve, option B");
  const companion = page.getByRole("status").filter({ hasText: "Voice answer" });
  await expect(companion.getByRole("button", { name: "Submit now" })).toBeVisible();
  await captureCard(companion, "answer-companion");
  await expect.poll(async () => (await read(next)).selections).toEqual([{ decisionId: "q", selected: ["postgres"], other: null }]);

  const nameless = await runningAgent(page, daemon, "");
  const free = await file(nameless.cwd, "Which benchmark first?");
  await open();
  const text = page.getByRole("textbox", { name: "Other answer or context: Which benchmark first?" });
  await expect(page.locator(".vh-foot")).toContainText("No spoken name");
  await captureCard(page.locator(".inbox-item").filter({ has: text }), "answer-nameless-hint");
  await say(daemon, "reply, neither yet");
  await expect(text).toHaveValue("neither yet");
  await captureCard(page.locator(".inbox-item").filter({ has: text }), "answer-written");
  await page.getByRole("button", { name: "Submit now" }).click();
  await expect.poll(async () => (await read(free)).selections).toEqual([{ decisionId: "q", selected: [], other: "neither yet" }]);
});

test("the foreground dashboard can cancel an explicit answer to a background question", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  const steve = await runningAgent(page, daemon, "Steve");
  const title = "Which database?";
  const filed = await page.request.post(daemon.baseURL + "/mcp/reviews", {
    headers: { "x-harness-token": voiceToken(daemon) },
    data: { kind: "input", env: {}, cwd: steve.cwd, title, body: title },
  });
  expect(filed.ok(), await filed.text()).toBe(true);
  const { id } = await filed.json();
  const drawn = page.waitForResponse(r => r.url().endsWith("/api/voice/open-cards") && r.ok() &&
    r.request().postDataJSON().cards.some((card: { id: string }) => card.id === id));
  await page.locator("button.pulse-seg", { hasText: "to answer" }).click();
  await drawn;
  const inbox = page.getByRole("dialog", { name: "Attention inbox" });
  await expectContentClearsBorder(inbox);

  const foreground = await page.context().newPage();
  const focused = foreground.waitForResponse(r => r.url().endsWith("/api/voice/open-cards") && r.ok() &&
    r.request().postDataJSON().focused && !r.request().postDataJSON().cards.length);
  await foreground.goto(daemon.baseURL + "/#/fleet");
  await focused;
  await say(daemon, "Steve, answer: Postgres");
  const companion = foreground.getByRole("status").filter({ hasText: "Voice answer" });
  await expect(companion).toContainText("Postgres");
  await expect(companion.getByText(/^\d+s$/)).toBeVisible();
  await expect(companion.getByRole("button", { name: "Submit now" })).toBeVisible();
  await expect(inbox.getByRole("textbox")).toHaveValue("Postgres");
  await captureCard(companion, "answer-background-dashboard");
  await companion.getByRole("button", { name: "Cancel" }).click();
  await expect(inbox.getByRole("textbox")).toBeEmpty();
  await expect(inbox.getByRole("button", { name: "Submit now" })).toHaveCount(0);
  const review = await (await page.request.get(daemon.baseURL + "/api/reviews/" + id)).json();
  expect(review.status).toBe("pending");
});

test("after voice restarts on the same dashboard, choosing a question opens and focuses it without answering", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon, 10);
  // Keep the feature-flag view at its enabled snapshot. The voice-state frames
  // alone must restart reporting when the daemon drops its dashboard on shutdown.
  await page.addInitScript(() => {
    window.EventSource = class extends EventSource {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        if (String(url) === "/events") this.addEventListener("message", event => {
          if (JSON.parse(event.data).type === "feature_flags") event.stopImmediatePropagation();
        });
      }
    };
  });
  const emptyReport = () => page.waitForResponse(r => r.url().endsWith("/api/voice/open-cards") && r.ok() &&
    r.request().postDataJSON().focused && !r.request().postDataJSON().cards.length);
  const initialReport = emptyReport();
  await page.reload();
  const initial = await initialReport;
  const toggleVoice = (enabled: boolean) => page.request.put(daemon.baseURL + "/api/feature-flags", {
    data: { kind: "flag", id: "voice", enabled },
  });
  await expect(page.locator("button.vi").first()).toBeVisible();
  expect((await toggleVoice(false)).ok()).toBe(true);
  await expect(page.locator("button.vi")).toHaveCount(0);
  const restoredReport = emptyReport();
  expect((await toggleVoice(true)).ok()).toBe(true);
  const restored = await restoredReport;
  expect(restored.request().postDataJSON().windowId).toBe(initial.request().postDataJSON().windowId);
  expect(Number(restored.request().headers()["x-voice-focus-at-us"])).toBeGreaterThan(
    Number(initial.request().headers()["x-voice-focus-at-us"]));
  const session = await runningAgent(page, daemon, "Steve");
  const titles = ["Where should I start?", "When should I stop?"] as const;
  for (const title of titles) {
    const response = await page.request.post(daemon.baseURL + "/mcp/reviews", { headers: { "x-harness-token": voiceToken(daemon) },
      data: { kind: "input", env: {}, cwd: session.cwd, title, body: title, ...(title === titles[0] && {
        decisions: [{ id: "q", question: title, allowOther: false, options: [{ id: "one", label: "Build" }, { id: "two", label: "Docs" }] }],
      }) } });
    expect(response.ok(), await response.text()).toBe(true);
  }
  await say(daemon, "Steve, answer");
  const pick = page.getByRole("status").filter({ hasText: "Which question?" });
  await expect(pick.getByRole("button", { name: /Where should I start/ })).toBeVisible();
  await expect(pick.getByRole("button", { name: /Where should I start/ })).toHaveAccessibleDescription("Choose this question for your voice reply");
  await captureCard(pick, "answer-question-picker");
  const report = page.waitForResponse(r => r.url().endsWith("/api/voice/open-cards") && r.ok() &&
    r.request().postDataJSON().cards.some((card: { focused: boolean }) => card.focused));
  await pick.getByRole("button", { name: /When should I stop/ }).click();
  const modal = page.getByRole("dialog", { name: "Review request" });
  await expectContentClearsBorder(modal);
  await report;
  const choiceOnly = modal.locator(".review").filter({ hasText: titles[0] });
  await expect(choiceOnly.locator(".vh-foot")).toHaveText("Say Steve, option B to select an option.");
  await captureCard(choiceOnly, "answer-choice-only-hint");
  const selected = modal.locator(".review").filter({ hasText: titles[1] });
  await expect(selected).toBeFocused();
  await expect(selected.getByRole("textbox")).toBeEmpty();
  await say(daemon, "reply, tomorrow");
  await expect(selected.getByRole("textbox")).toHaveValue("tomorrow");
  await selected.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(selected.getByRole("textbox")).toBeEmpty();
});

for (const scenario of [
  { title: "manual textarea edits survive a retry while cancellation is delayed", retry: true, withOptions: false },
  { title: "manual Other field edits survive a retry after cancellation fails", retry: true, withOptions: true },
  { title: "the footer identifies the answer sent when manual cancellation misses the deadline", retry: false, withOptions: false },
]) {
  test(scenario.title, async ({ dashboard: page, daemon }) => {
    const { withOptions } = scenario;
    await setupCards(page, daemon, scenario.retry ? 30 : 5);
    const steve = await runningAgent(page, daemon, "Steve");
    const title = "When should I stop?";
    const filed = await page.request.post(daemon.baseURL + "/mcp/reviews", {
      headers: { "x-harness-token": voiceToken(daemon) },
      data: { env: {}, cwd: steve.cwd, kind: "input", title, body: title,
        ...(withOptions && { decisions: [{ id: "q", question: title, allowOther: true,
          options: [{ id: "now", label: "Now" }] }] }) },
    });
    expect(filed.ok(), await filed.text()).toBe(true);
    const { id } = await filed.json();
    const startsClosed = scenario.retry && !withOptions;
    const companion = page.locator(".voice-card").filter({ hasText: "Voice answer" });
    if (startsClosed) {
      await say(daemon, "Steve, answer: tomorrow");
      await expect(companion.getByRole("button", { name: "Submit now" })).toBeVisible();
    }
    const report = page.waitForResponse(r => r.url().endsWith("/api/voice/open-cards") && r.ok() &&
      r.request().postDataJSON().cards.some((card: { id: string }) => card.id === id));
    await page.locator("button.pulse-seg", { hasText: "to answer" }).click();
    await report;
    const inbox = page.getByRole("dialog", { name: "Attention inbox" });
    await expectContentClearsBorder(inbox);
    const card = inbox.locator(".review").filter({ hasText: title });
    const input = card.getByRole("textbox");
    if (startsClosed) await expect(companion).toHaveCount(0);
    else await say(daemon, "reply, tomorrow");
    await expect(input).toHaveValue("tomorrow");

    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    let cancelRequests = 0;
    await page.route("**/api/voice/cards/*/cancel", async route => {
      cancelRequests++;
      if (cancelRequests === 1) {
        await hold;
        if (withOptions) return route.fulfill({ status: 503, json: { ok: false } });
      }
      await route.continue();
    });
    try {
      await input.selectText();
      await input.press("ArrowRight");
      await input.pressSequentially(" at noon");
      await expect(input).toHaveValue("tomorrow at noon", { timeout: 1500 });
      await expect.poll(() => cancelRequests).toBe(1);
      const footer = card.getByRole("status").filter({ has: page.getByRole("button", { name: "Submit now" }) });
      await expect(footer.getByText("tomorrow", { exact: true })).toBeVisible();
      await expect(footer).toContainText("Cancellation requested");
      if (withOptions) {
        release();
        await expect(footer).toContainText("Could not cancel");
      }
      await expect(footer).toContainText(/submits in \d+s/);
      await expect(page.getByRole("button", { name: "Submit now", includeHidden: true })).toHaveCount(1);
      await expect(footer.getByRole("button", { name: "Submit now" })).toBeDisabled();
      const retry = footer.getByRole("button", { name: "Retry cancel" });
      await expect(retry).toBeEnabled();
      if (!scenario.retry) {
        await expect(footer).toHaveCount(0);
        const review = await (await page.request.get(daemon.baseURL + "/api/reviews/" + id)).json();
        expect(review.response).toBe("tomorrow");
        const late = page.waitForResponse(r => r.url().endsWith("/cancel"));
        release();
        expect((await late).status()).toBe(409);
        return;
      }
      await captureCard(inbox.locator(".inbox-item").filter({ has: page.getByRole("heading", { name: title }) }),
        withOptions ? "manual-cancel-failed" : "manual-cancel-delayed");
      const cancelled = page.waitForResponse(r => r.url().endsWith("/cancel") && r.ok());
      await retry.click();
      const response = await cancelled;
      await expect(footer).toHaveCount(0);
      // A late submit of the original voice answer can no longer reach the review.
      expect((await page.request.post(response.url().replace(/\/cancel$/, "/send-now"))).status()).toBe(409);
      if (!withOptions) {
        const late = page.waitForResponse(r => r.url() === response.url());
        release();
        expect((await late).status()).toBe(409);
      }
    } finally {
      release();
    }
    await expect(card.getByRole("button", { name: "Submit now" })).toHaveCount(0);
    await expect(input).toHaveValue("tomorrow at noon");
    const review = await (await page.request.get(daemon.baseURL + "/api/reviews/" + id)).json();
    expect(review.status).toBe("pending");
    expect(cancelRequests).toBe(2);
  });
}
