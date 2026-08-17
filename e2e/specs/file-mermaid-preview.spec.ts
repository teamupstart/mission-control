import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

const EVIDENCE = artifactsDir("file-mermaid-preview");
const TASK = "verify Mermaid preview";
const MARKDOWN_PATH = "docs/mermaid-preview.md";
const SENTINEL = "mermaid-sentinel.invalid";

const MARKDOWN = [
  "# Checkout flow",
  "",
  "```mermaid",
  "flowchart LR",
  "  Inbox[Inbox] --> Review[Review]",
  "```",
  "",
  "```ts",
  "export const ordinaryCode = true;",
  "```",
  "",
  "```mermaid title=source-only",
  "flowchart LR",
  "  Metadata --> Source",
  "```",
  "",
  "```mermaid",
  "flowchart LR",
  "  Broken[",
  "```",
  "",
  "The prose after the malformed block stays visible.",
  "",
  "```mermaid",
  "flowchart LR",
  `  Remote@{ img: "https://${SENTINEL}/pixel.png", label: "Remote image" }`,
  `  click Remote "https://${SENTINEL}/click"`,
  "```",
  "",
  "```mermaid",
  "sequenceDiagram",
  "  participant Agent",
  "  participant Human",
  "  Agent->>Human: Original label",
  "```",
].join("\n");

async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/file-mermaid-preview/${name}.png`);
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

async function sessionCwd(daemon: DaemonHandle): Promise<string> {
  await expect.poll(async () => {
    const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as {
      cwd: string | null;
    }[];
    return sessions[0]?.cwd ?? null;
  }).not.toBeNull();
  const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as {
    cwd: string | null;
  }[];
  return sessions[0]!.cwd!;
}

async function openMarkdown(page: Page, daemon: DaemonHandle): Promise<void> {
  await dispatch(page, daemon);
  const cwd = await sessionCwd(daemon);
  mkdirSync(join(cwd, "docs"), { recursive: true });
  writeFileSync(join(cwd, MARKDOWN_PATH), MARKDOWN);

  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "console" }),
  });
  expect(response.ok).toBe(true);
  await page.reload();
  await page
    .getByRole("navigation", { name: "Sessions" })
    .getByRole("button", { name: /Verify Mermaid Preview/i })
    .click();
  await page.getByRole("tablist", { name: "Session detail" }).getByRole("tab", { name: /Files$/ }).click();
  await page.getByRole("listbox", { name: "Session files" }).getByRole("option", { name: MARKDOWN_PATH }).click();
}

test("Files Preview renders isolated Mermaid diagrams while Editor keeps exact source", async ({
  dashboard,
  daemon,
}) => {
  const sentinelRequests: string[] = [];
  dashboard.on("request", (request) => {
    if (request.url().includes(SENTINEL)) sentinelRequests.push(request.url());
  });
  await openMarkdown(dashboard, daemon);

  const preview = dashboard.locator("article.file-markdown-preview");
  const first = preview.getByRole("figure", { name: "Mermaid diagram 1" });
  const malformed = preview.getByRole("figure", { name: "Mermaid diagram 2" });
  const hostile = preview.getByRole("figure", { name: "Mermaid diagram 3" });
  const second = preview.getByRole("figure", { name: "Mermaid diagram 4" });

  await expect(first).toHaveAttribute("data-mermaid-state", "rendered");
  await expect(preview.locator("pre code.language-ts")).toContainText("ordinaryCode");
  await expect(preview.locator("pre code.language-mermaid").filter({ hasText: "Metadata" })).toContainText(
    "Metadata --> Source",
  );
  await malformed.scrollIntoViewIfNeeded();
  await expect(malformed).toHaveAttribute("data-mermaid-state", "error");
  await expect(malformed.getByRole("alert")).toContainText("Diagram could not render");
  await expect(malformed.locator("pre code.language-mermaid")).toContainText("Broken[");
  await expect(preview.getByText("The prose after the malformed block stays visible.")).toBeVisible();
  await hostile.scrollIntoViewIfNeeded();
  await expect.poll(() => hostile.getAttribute("data-mermaid-state")).toMatch(/^(rendered|error)$/);
  await second.scrollIntoViewIfNeeded();
  await expect(second).toHaveAttribute("data-mermaid-state", "rendered");

  const firstFrame = dashboard.frameLocator('iframe[title="Mermaid diagram 1"]');
  const secondFrame = dashboard.frameLocator('iframe[title="Mermaid diagram 4"]');
  await expect(firstFrame.getByRole("img", { name: "Mermaid diagram 1" })).toBeVisible();
  await expect(secondFrame.getByRole("img", { name: "Mermaid diagram 4" })).toBeVisible();
  if (await hostile.getAttribute("data-mermaid-state") === "rendered") {
    const hostileFrame = dashboard.frameLocator('iframe[title="Mermaid diagram 3"]');
    await expect(hostileFrame.locator("a")).toHaveCount(0);
  }
  expect(sentinelRequests, "diagram-controlled URLs never reach the network").toEqual([]);

  const modes = dashboard.getByRole("group", { name: "File view mode" });
  await modes.getByRole("button", { name: "Editor" }).click();
  const editor = dashboard.getByLabel(`Editor for ${MARKDOWN_PATH}`);
  await expect(editor).toBeVisible();
  expect((await editor.locator(".cm-line").allTextContents()).join("\n")).toBe(MARKDOWN);

  const updated = MARKDOWN.replace("Original label", "Updated label");
  await editor.click();
  await dashboard.keyboard.press("ControlOrMeta+a");
  await dashboard.keyboard.insertText(updated);
  await modes.getByRole("button", { name: "Preview" }).click();
  await second.scrollIntoViewIfNeeded();
  await expect(second).toHaveAttribute("data-mermaid-state", "rendered");
  await expect(secondFrame.getByText("Updated label")).toBeVisible();
  await expect(secondFrame.getByText("Original label")).toHaveCount(0);
  await shoot(dashboard, "integrated-mermaid-preview");

  await dashboard.getByRole("button", { name: "Extract files window" }).click();
  const extracted = dashboard.getByRole("dialog", { name: /Files for / });
  await expect(extracted.getByRole("figure", { name: "Mermaid diagram 1" })).toHaveAttribute(
    "data-mermaid-state",
    "rendered",
  );
  await shoot(dashboard, "extracted-mermaid-preview");
});
