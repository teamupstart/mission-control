import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { crc32, deflateSync } from "node:zlib";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The `mockups` skill tells an agent to write each mock-up into its checkout and present the
 * path on its own line. This spec holds the dashboard's half of that contract: the operator
 * watching the session sees the mock-up rendered in the conversation and can open it in
 * Files, without leaving or reloading the conversation first.
 */

const TASK = "draw the settings mockups";
const PAGE = "docs/mockups/settings-panel/mockup.html";
const IMAGE = "docs/mockups/settings-panel/mockup.png";
const BROKEN = "docs/mockups/settings-panel/broken.png";
const MOCKUP_TURN = `Both mock-ups are in the checkout.\nMockup: ${PAGE}\nScreenshot: ${IMAGE}`;
const IMAGE_WIDTH = 48;
const IMAGE_HEIGHT = 30;
const EVIDENCE = artifactsDir("conversation-mockup-artifacts");

const PAGE_SOURCE = `<!doctype html>
<html>
  <head>
    <style>
      body { margin: 0; padding: 24px; background: #111820; color: #edf5ff; font: 14px system-ui; }
    </style>
  </head>
  <body>
    <h1>Settings panel mockup</h1>
    <p>Two columns: categories on the left, the selected category's rows on the right.</p>
  </body>
</html>`;

function write(cwd: string, path: string, contents: string | Buffer): void {
  mkdirSync(join(cwd, dirname(path)), { recursive: true });
  writeFileSync(join(cwd, path), contents);
}

/** What the skill runs first: `docs/mockups/` ignores itself, so git never offers a mock-up. */
function ignoreMockups(cwd: string): void {
  write(cwd, "docs/mockups/.gitignore", "*\n");
}

/** The checkout's own answer to "is there anything to commit under docs/mockups?". */
function gitStatus(cwd: string): string {
  return execFileSync("git", ["-C", cwd, "status", "--porcelain", "--untracked-files=all", "--", "docs/mockups"], {
    encoding: "utf8",
  });
}

/** A real, decodable PNG of one flat colour, so the card has actual pixels to show. */
function png(width: number, height: number, rgb: readonly [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour RGB
  const row = Buffer.concat([
    Buffer.from([0]), // filter: none
    Buffer.from(Array.from({ length: width }, () => rgb).flat()),
  ]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
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
  const row = page.getByRole("navigation", { name: "Sessions" })
    .locator("button.rail-row").filter({ hasText: TASK });
  await expect(row.locator(".rail-state")).toHaveText("idle");
}

async function session(daemon: DaemonHandle): Promise<{ id: string; cwd: string }> {
  const read = async () => await (await fetch(`${daemon.baseURL}/api/sessions`)).json() as {
    id: string;
    cwd: string | null;
  }[];
  await expect.poll(async () => (await read())[0]?.cwd ?? null, {
    message: "the fake session never acquired a checkout",
  }).not.toBeNull();
  const rows = await read();
  return { id: rows[0]!.id, cwd: rows[0]!.cwd! };
}

async function inject(daemon: DaemonHandle, sessionId: string, text: string): Promise<void> {
  const replyCount = async () => {
    const transcript = await (await fetch(`${daemon.baseURL}/api/sessions/${encodeURIComponent(sessionId)}/transcript`)).json() as {
      messages?: { role: string; text: string }[];
    };
    return transcript.messages?.filter((message) => message.role === "assistant" && message.text === `Mock reply to: ${text}`).length ?? 0;
  };
  const repliesBefore = await replyCount();
  const response = await fetch(`${daemon.baseURL}/api/sessions/${encodeURIComponent(sessionId)}/inject`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, buffer: false }),
  });
  expect(response.ok, `POST /inject answered ${response.status}: ${await response.text()}`).toBe(true);
  await expect.poll(replyCount).toBeGreaterThan(repliesBefore);
  await expect.poll(async () => {
    const rows = await (await fetch(`${daemon.baseURL}/api/sessions`)).json() as { id: string; state: string }[];
    return rows.find((row) => row.id === sessionId)?.state;
  }).toBe("idle");
}

async function openConversation(page: Page, daemon: DaemonHandle, sessionId: string): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "console", conversationView: "chat" }),
  });
  expect(response.ok).toBe(true);
  await page.reload();
  // The conversation lists the checkout as it mounts. Wait for that listing to land, so the
  // files written after this point are provably absent from it.
  const listed = page.waitForResponse((answer) =>
    answer.request().method() === "GET"
    && answer.url().includes(`/api/sessions/${encodeURIComponent(sessionId)}/files`)
    && answer.ok());
  await page.getByRole("navigation", { name: "Sessions" })
    .getByRole("button", { name: new RegExp(TASK, "i") }).click();
  await listed;
}

async function capture(page: Page, name: string, target = page.locator("body")): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.screenshot({ path: `${EVIDENCE}${name}` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/conversation-mockup-artifacts/${name}`);
}

test("mock-ups written while the conversation is open are linked and previewed inline", async ({
  dashboard: page,
  daemon,
}) => {
  await dispatch(page, daemon);
  const live = await session(daemon);
  await openConversation(page, daemon, live.id);

  // Written after the conversation's own listing, while the operator is watching - which is
  // when a session actually produces a mock-up - into the self-ignoring directory the skill
  // sets up, so git has nothing to commit while the dashboard still shows every file.
  ignoreMockups(live.cwd);
  write(live.cwd, PAGE, PAGE_SOURCE);
  write(live.cwd, IMAGE, png(IMAGE_WIDTH, IMAGE_HEIGHT, [46, 125, 210]));
  expect(gitStatus(live.cwd), "git sees no mock-up to commit").toBe("");
  await inject(daemon, live.id, MOCKUP_TURN);

  const turn = page.getByRole("article", { name: "claude" })
    .filter({ hasText: "Both mock-ups are in the checkout." })
    .last();

  // Linked in the prose, so a click opens the file in Files...
  await expect(turn.getByRole("link", { name: PAGE, exact: true })).toBeVisible();
  await expect(turn.getByRole("link", { name: IMAGE, exact: true })).toBeVisible();

  // ...and rendered at the foot of the turn without a click at all.
  const pageCard = turn.getByRole("region", { name: `Preview of ${PAGE}` });
  await expect(pageCard.frameLocator(`iframe[title="Preview of ${PAGE}"]`)
    .getByRole("heading", { name: "Settings panel mockup" })).toBeVisible();
  await expect(pageCard.getByRole("button", { name: `Comment on ${PAGE} in Files` })).toBeVisible();

  const imageCard = turn.getByRole("region", { name: `Preview of ${IMAGE}` });
  const image = imageCard.getByRole("img", { name: IMAGE, exact: true });
  await expect(image).toBeVisible();
  // Decoded, not merely present: a broken image element is visible too.
  await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
    .toBe(IMAGE_WIDTH);
  await expect(imageCard).toHaveAttribute("data-preview-source", "loaded");
  await expect(imageCard.locator(".artifact-body")).toHaveCSS("height", "420px");
  await expect(imageCard.getByText(/^\d+ B$/)).toBeVisible();
  // Files has no comment mode for an image, so the card offers no Comment to hand off to.
  await expect(imageCard.getByRole("button", { name: /^Comment on / })).toHaveCount(0);
  if (process.env.MC_E2E_EVIDENCE === "1") {
    // The turn with two reserved 420px cards is taller than the default viewport, and an
    // element screenshot cannot see past the transcript's own scroll clip.
    await page.setViewportSize({ width: 1280, height: 1500 });
    await turn.evaluate((element) => element.scrollIntoView({ block: "end" }));
  }
  await capture(page, "mockups-inline.png", turn);

  await imageCard.getByRole("button", { name: `View ${IMAGE} in Files` }).click();
  const tabs = page.getByRole("tablist", { name: "Session detail" });
  await expect(tabs.getByRole("tab", { name: /Files$/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("option", { name: IMAGE })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "Preview", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const filesImage = page.locator(".file-image-preview").getByRole("img", { name: IMAGE, exact: true });
  await expect.poll(() => filesImage.evaluate((element) => (element as HTMLImageElement).naturalWidth))
    .toBe(IMAGE_WIDTH);
  await capture(page, "mockup-image-in-files.png");
});

test("Settings lists the shipped mockups skill, on by default, with the words that trigger it", async ({
  dashboard: page,
  daemon,
}) => {
  await page.goto(`${daemon.baseURL}/#/settings/skills`);
  await expect(page.getByRole("checkbox", { name: /^Enable \/mockups in every/ })).toBeChecked();
  const description = page.getByText(
    /Use whenever someone asks for mock-ups, mockups, mock ups, wireframes/,
  );
  await expect(description).toBeVisible();
  await capture(page, "mockups-skill-settings.png");
});

test("an image the browser cannot decode says so, and Refresh recovers once the file is fixed", async ({
  dashboard: page,
  daemon,
}) => {
  await dispatch(page, daemon);
  const live = await session(daemon);
  ignoreMockups(live.cwd);
  write(live.cwd, BROKEN, "this is not a PNG\n");
  const turnText = `The screenshot did not render.\nScreenshot: ${BROKEN}`;
  await inject(daemon, live.id, turnText);
  await openConversation(page, daemon, live.id);

  const card = page.getByRole("article", { name: "claude" })
    .filter({ hasText: "The screenshot did not render." })
    .last()
    .getByRole("region", { name: `Preview of ${BROKEN}` });
  await expect(card.getByText("Image could not be displayed.")).toBeVisible();
  await expect(card.getByRole("img")).toHaveCount(0);
  await expect(card.getByRole("button", { name: `View ${BROKEN} in Files` })).toBeVisible();
  const refresh = card.getByRole("button", { name: `Refresh preview of ${BROKEN}` });
  await expect(refresh).toBeVisible();

  // The decode failure is browser-side state, not part of the daemon's answer, so it must be
  // cleared by a re-read. Without that reset the card stays refused after the agent fixes
  // the file, however many times Refresh is pressed.
  write(live.cwd, BROKEN, png(IMAGE_WIDTH, IMAGE_HEIGHT, [46, 125, 210]));
  await refresh.click();
  await expect(card.getByText("Image could not be displayed.")).toHaveCount(0);
  const image = card.getByRole("img", { name: BROKEN, exact: true });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
    .toBe(IMAGE_WIDTH);
  await expect(card).toHaveAttribute("data-preview-source", "loaded");
});
