import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

const TASK = "prepare an HTML artifact preview";
const REPORT = "docs/reports/conversation-card/report.html";
const LONG_REPORT = "docs/reports/conversation-card/a-very-long-artifact-name-that-must-stay-inside-the-preview-header.html";
const OTHER = "docs/reports/conversation-card/other.html";
const CSS = "docs/reports/conversation-card/report.css";
const REPORT_TURN = `The artifact is ready.\nReport: ${REPORT}`;
const EVIDENCE = artifactsDir("conversation-html-artifact-preview");

const REPORT_SOURCE = `<!doctype html>
<html>
  <head>
    <link rel="stylesheet" href="report.css">
    <style>
      body { margin: 0; padding: 28px; background: #fff; color: #17202a; }
      @media (prefers-color-scheme: dark) {
        body { background: #111820; color: #edf5ff; }
      }
    </style>
  </head>
  <body>
    <h1>Conversation artifact</h1>
    <p id="finding">The retry path needs a bounded backoff.</p>
  </body>
</html>`;

function write(cwd: string, path: string, contents: string): void {
  mkdirSync(join(cwd, dirname(path)), { recursive: true });
  writeFileSync(join(cwd, path), contents);
}

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(TASK);
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

async function session(daemon: DaemonHandle): Promise<{ id: string; cwd: string }> {
  await expect.poll(async () => {
    const rows = await (await fetch(`${daemon.baseURL}/api/sessions`)).json() as {
      id: string;
      cwd: string | null;
    }[];
    return rows[0]?.cwd ?? null;
  }, { message: "the fake session never acquired a checkout" }).not.toBeNull();
  const rows = await (await fetch(`${daemon.baseURL}/api/sessions`)).json() as {
    id: string;
    cwd: string | null;
  }[];
  return { id: rows[0]!.id, cwd: rows[0]!.cwd! };
}

async function inject(daemon: DaemonHandle, sessionId: string, text: string): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/sessions/${encodeURIComponent(sessionId)}/inject`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, buffer: false }),
  });
  expect(response.ok, `POST /inject answered ${response.status}: ${await response.text()}`).toBe(true);
}

async function commentThreadCount(daemon: DaemonHandle, sessionId: string): Promise<number> {
  const response = await fetch(
    `${daemon.baseURL}/api/sessions/${encodeURIComponent(sessionId)}/file-comments`,
  );
  expect(response.ok).toBe(true);
  const body = await response.json() as { threads: unknown[] };
  return body.threads.length;
}

async function setPresentation(
  page: Page,
  daemon: DaemonHandle,
  layout: "console" | "board",
  conversationView: "chat" | "terminal",
): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout, conversationView }),
  });
  expect(response.ok).toBe(true);
  await page.reload();
}

function artifactCard(
  page: Page,
  report = REPORT,
  reportTurn = REPORT_TURN,
): Locator {
  return page
    .getByRole("article", { name: "claude" })
    .filter({ hasText: reportTurn })
    .last()
    .getByRole("region", { name: `Preview of ${report}` });
}

async function capture(page: Page, target: Locator, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.screenshot({ path: `${EVIDENCE}${name}` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/conversation-html-artifact-preview/${name}`);
}

test("an HTML artifact is previewed inline and hands commenting to Files", async ({
  dashboard: page,
  daemon,
}) => {
  await dispatch(page, daemon);
  const live = await session(daemon);
  write(live.cwd, REPORT, REPORT_SOURCE);
  write(live.cwd, CSS, "#finding { font-weight: 700; text-decoration: underline; }\n");
  write(live.cwd, OTHER, "<!doctype html><h1>Other artifact</h1>\n");
  await inject(daemon, live.id, REPORT_TURN);
  const incidentalTurn = `I edited ${OTHER} while preparing the report.`;
  const absentTurn = "Report: docs/reports/conversation-card/missing.html";
  await inject(daemon, live.id, incidentalTurn);
  await inject(daemon, live.id, absentTurn);
  await inject(daemon, live.id, "A later turn keeps the artifact from being the log tail.");
  await setPresentation(page, daemon, "console", "chat");

  const sessions = page.getByRole("navigation", { name: "Sessions" });
  await sessions.getByRole("button", { name: /Prepare an HTML Artifact Preview/i }).click();
  const card = artifactCard(page);
  await expect(card).toBeVisible();
  await expect(page.getByRole("article").filter({ hasText: incidentalTurn })
    .getByRole("region", { name: /Preview of/ })).toHaveCount(0);
  await expect(page.getByRole("article").filter({ hasText: absentTurn })
    .getByRole("region", { name: /Preview of/ })).toHaveCount(0);
  const disclosure = card.locator(".artifact-disclose");
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  const bodyId = await disclosure.getAttribute("aria-controls");
  expect(bodyId).toBeTruthy();
  const body = card.locator(`#${bodyId}`);
  await expect(body).toBeVisible();
  await expect(body).toHaveCSS("height", "420px");

  const frame = card.frameLocator(`iframe[title="Preview of ${REPORT}"]`);
  await expect(frame.getByRole("heading", { name: "Conversation artifact" })).toBeVisible();
  await expect(frame.locator("#finding")).toHaveCSS("font-weight", "700");
  await expect(card).toHaveAttribute("data-preview-source", "loaded");

  await page.evaluate(() => {
    (window as typeof window & { artifactBlockMessages?: number }).artifactBlockMessages = 0;
    window.addEventListener("message", (event) => {
      if ((event.data as { type?: unknown } | null)?.type === "mission:file-preview-block") {
        (window as typeof window & { artifactBlockMessages?: number }).artifactBlockMessages! += 1;
      }
    });
  });
  const threadCountBefore = await commentThreadCount(daemon, live.id);
  await frame.locator("#finding").click();
  await expect.poll(() => page.evaluate(() => (
    (window as typeof window & { artifactBlockMessages?: number }).artifactBlockMessages
  ))).toBe(0);
  await expect(page.getByRole("textbox", { name: /^Comment on line/ })).toHaveCount(0);
  await expect.poll(() => commentThreadCount(daemon, live.id)).toBe(threadCountBefore);

  await disclosure.click();
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await expect(body).toBeHidden();
  await expect(card.locator("iframe.artifact-preview")).not.toHaveAttribute("srcdoc", /./);
  await expect(card.locator(`#${bodyId}`)).toHaveCount(1);

  const tabs = page.getByRole("tablist", { name: "Session detail" });
  await tabs.getByRole("tab", { name: /Files$/ }).click();
  await tabs.getByRole("tab", { name: /Conversation$/ }).click();
  await expect(artifactCard(page).locator(".artifact-disclose")).toHaveAttribute("aria-expanded", "false");
  await artifactCard(page).locator(".artifact-disclose").click();
  await expect(artifactCard(page).frameLocator("iframe.artifact-preview").getByRole("heading", {
    name: "Conversation artifact",
  })).toBeVisible();

  await artifactCard(page).getByRole("button", { name: `Comment on ${REPORT} in Files` }).click();
  await expect(tabs.getByRole("tab", { name: /Files$/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("option", { name: REPORT })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "Preview", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const commentMode = page.getByRole("button", { name: "Comment mode" });
  await expect(commentMode).toHaveAttribute("aria-pressed", "true");

  await commentMode.click();
  await tabs.getByRole("tab", { name: /Conversation$/ }).click();
  await artifactCard(page).getByRole("button", { name: `Comment on ${REPORT} in Files` }).click();
  await expect(commentMode).toHaveAttribute("aria-pressed", "true");

  await commentMode.click();
  await page.getByRole("option", { name: OTHER }).click();
  await expect(page.getByRole("option", { name: OTHER })).toHaveAttribute("aria-selected", "true");
  await tabs.getByRole("tab", { name: /Conversation$/ }).click();
  await artifactCard(page).getByRole("button", { name: `Comment on ${REPORT} in Files` }).click();
  await expect(page.getByRole("option", { name: REPORT })).toHaveAttribute("aria-selected", "true");
  await expect(commentMode).toHaveAttribute("aria-pressed", "true");

  await page.frameLocator("iframe.html-preview").locator("#finding").click();
  const composer = page.getByRole("region", { name: /New comment on line/ });
  await expect(composer).toBeVisible();
  await composer.getByRole("textbox", { name: /Comment on line/ }).fill("Please make the retry bound explicit.");
  await composer.getByRole("button", { name: "Comment", exact: true }).click();
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  await expect(page.getByRole("button", {
    name: /MC-\w+ line \d+ queued Please make the retry bound explicit\./,
  })).toBeVisible();

  await tabs.getByRole("tab", { name: /Conversation$/ }).click();
  const restoredCard = artifactCard(page);
  await page.emulateMedia({ colorScheme: "light" });
  await capture(page, restoredCard, "console-light.png");
  await page.emulateMedia({ colorScheme: "dark" });
  await capture(page, restoredCard, "console-dark.png");

  unlinkSync(join(live.cwd, REPORT));
  await restoredCard.getByRole("button", { name: `Refresh preview of ${REPORT}` }).click();
  await expect(restoredCard.getByText("File no longer exists.")).toBeVisible();
  await expect(restoredCard.getByRole("button", { name: `Refresh preview of ${REPORT}` })).toBeVisible();
  await expect(restoredCard.getByRole("button", { name: `Comment on ${REPORT} in Files` })).toBeVisible();
});

test("a rejected preview read becomes retryable instead of loading forever", async ({
  dashboard: page,
  daemon,
}) => {
  await dispatch(page, daemon);
  const live = await session(daemon);
  write(live.cwd, REPORT, REPORT_SOURCE);
  write(live.cwd, CSS, "#finding { font-weight: 700; }\n");
  await inject(daemon, live.id, REPORT_TURN);

  let rejectDocumentReads = true;
  await page.route("**/api/sessions/*/file?*", async (route) => {
    const path = new URL(route.request().url()).searchParams.get("path");
    if (rejectDocumentReads && path === REPORT) {
      await route.fulfill({ status: 200, contentType: "application/json", body: "null" });
      return;
    }
    await route.continue();
  });
  await setPresentation(page, daemon, "console", "chat");

  const sessions = page.getByRole("navigation", { name: "Sessions" });
  await sessions.getByRole("button", { name: /Prepare an HTML Artifact Preview/i }).click();
  const card = artifactCard(page);
  await expect(card.getByText("Preview unavailable.")).toBeVisible();

  rejectDocumentReads = false;
  await card.getByRole("button", { name: `Refresh preview of ${REPORT}` }).click();
  await expect(card.frameLocator("iframe.artifact-preview").getByRole("heading", {
    name: "Conversation artifact",
  })).toBeVisible();
});

test("the card renders in Board terminal detail and wraps cleanly at narrow width", async ({
  dashboard: page,
  daemon,
}) => {
  await dispatch(page, daemon);
  const live = await session(daemon);
  const reportTurn = `The artifact is ready.\nReport: ${LONG_REPORT}`;
  write(live.cwd, LONG_REPORT, REPORT_SOURCE);
  write(live.cwd, CSS, "#finding { font-weight: 700; }\n");
  await inject(daemon, live.id, reportTurn);
  await setPresentation(page, daemon, "board", "terminal");

  const tile = page.getByRole("button", { name: /Prepare an HTML Artifact Preview/i });
  await tile.focus();
  await tile.press("Enter");
  let card = artifactCard(page, LONG_REPORT, reportTurn);
  await expect(card).toBeVisible();
  await expect(card.frameLocator("iframe.artifact-preview").getByRole("heading", {
    name: "Conversation artifact",
  })).toBeVisible();

  await page.emulateMedia({ colorScheme: "light" });
  await capture(page, card, "board-light.png");
  await page.emulateMedia({ colorScheme: "dark" });
  await capture(page, card, "board-dark.png");

  await page.setViewportSize({ width: 720, height: 900 });
  card = artifactCard(page, LONG_REPORT, reportTurn);
  await expect(card.locator(".artifact-head")).toHaveCSS("flex-wrap", "wrap");
  const name = card.locator(".artifact-name");
  await expect(name).toHaveCSS("text-overflow", "ellipsis");
  const nameWidths = await name.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(nameWidths.scrollWidth).toBeGreaterThan(nameWidths.clientWidth);
  await expect(card.locator(".artifact-dir")).not.toHaveCSS("width", "0px");
  await capture(page, card, "board-narrow.png");
});

test("the transcript root margin preloads nearby cards and releases distant source", async ({
  dashboard: page,
  daemon,
}) => {
  await dispatch(page, daemon);
  const live = await session(daemon);
  write(live.cwd, REPORT, REPORT_SOURCE);
  write(live.cwd, CSS, "#finding { font-weight: 700; }\n");
  const prelude = Array.from({ length: 80 }, (_, index) => `Prelude line ${index + 1}`).join("\n");
  const tail = Array.from({ length: 80 }, (_, index) => `Tail line ${index + 1}`).join("\n");
  await inject(daemon, live.id, prelude);
  await inject(daemon, live.id, REPORT_TURN);
  await inject(daemon, live.id, tail);
  await setPresentation(page, daemon, "console", "chat");
  await page
    .getByRole("navigation", { name: "Sessions" })
    .getByRole("button", { name: /Prepare an HTML Artifact Preview/i })
    .click();

  const card = artifactCard(page);
  const followingTurn = page
    .getByRole("article", { name: "claude" })
    .filter({ hasText: "Tail line 1" })
    .last();
  await expect(card).toHaveAttribute("data-preview-source", "released");
  const before = await card.evaluate((element, follower) => ({
    height: element.getBoundingClientRect().height,
    followerTop: (follower as HTMLElement).offsetTop,
  }), await followingTurn.elementHandle());

  await card.evaluate((element) => {
    const log = element.closest<HTMLElement>(".transcript-log")!;
    const contentBottom = element.getBoundingClientRect().bottom
      - log.getBoundingClientRect().top
      + log.scrollTop;
    log.scrollTop = contentBottom + 400;
  });
  const preloadGap = await card.evaluate((element) => {
    const log = element.closest<HTMLElement>(".transcript-log")!;
    return log.getBoundingClientRect().top - element.getBoundingClientRect().bottom;
  });
  expect(preloadGap).toBeGreaterThan(0);
  expect(preloadGap).toBeLessThan(600);
  await expect(card).toHaveAttribute("data-preview-source", "loaded");
  await expect(card.locator("iframe.artifact-preview")).toHaveAttribute("srcdoc", /Conversation artifact/);
  const after = await card.evaluate((element, follower) => ({
    height: element.getBoundingClientRect().height,
    followerTop: (follower as HTMLElement).offsetTop,
  }), await followingTurn.elementHandle());
  expect(after).toEqual(before);

  await card.evaluate((element) => {
    const log = element.closest<HTMLElement>(".transcript-log")!;
    const contentBottom = element.getBoundingClientRect().bottom
      - log.getBoundingClientRect().top
      + log.scrollTop;
    log.scrollTop = contentBottom + 800;
  });
  await expect.poll(() => card.evaluate((element) => {
    const log = element.closest<HTMLElement>(".transcript-log")!;
    return log.getBoundingClientRect().top - element.getBoundingClientRect().bottom;
  })).toBeGreaterThan(600);
  await expect(card).toHaveAttribute("data-preview-source", "released");
  await expect(card.locator("iframe.artifact-preview")).not.toHaveAttribute("srcdoc", /./);

  await card.scrollIntoViewIfNeeded();
  await expect(card).toHaveAttribute("data-preview-source", "loaded");
  await expect(card.frameLocator("iframe.artifact-preview").getByRole("heading", {
    name: "Conversation artifact",
  })).toBeVisible();
});
