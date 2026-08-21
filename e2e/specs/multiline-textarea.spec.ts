import { mkdirSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expect, test } from "../fixtures/test.ts";

const FIVE_LINES = "line one\nline two\nline three\nline four\nline five";
const SIX_LINES = `${FIVE_LINES}\nline six`;
const EVIDENCE = artifactsDir("multiline-textarea");

interface TextareaGeometry {
  clientHeight: number;
  height: number;
  lineHeight: number;
  overflow: number;
  visibleRows: number;
}

async function geometry(field: Locator): Promise<TextareaGeometry> {
  return field.evaluate((element: HTMLTextAreaElement) => {
    const style = getComputedStyle(element);
    // `compose-input` inherits `line-height: normal`, which computed styles preserve as a
    // keyword. Let the browser resolve the same `lh` unit the product rule uses instead of
    // guessing a font multiplier in the test.
    const lineProbe = document.createElement("span");
    lineProbe.style.position = "fixed";
    lineProbe.style.visibility = "hidden";
    lineProbe.style.height = "1lh";
    lineProbe.style.fontFamily = style.fontFamily;
    lineProbe.style.fontSize = style.fontSize;
    lineProbe.style.fontWeight = style.fontWeight;
    lineProbe.style.lineHeight = style.lineHeight;
    document.body.append(lineProbe);
    const lineHeight = lineProbe.getBoundingClientRect().height;
    lineProbe.remove();
    const padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
    return {
      clientHeight: element.clientHeight,
      height: element.getBoundingClientRect().height,
      lineHeight,
      overflow: element.scrollHeight - element.clientHeight,
      visibleRows: (element.clientHeight - padding) / lineHeight,
    };
  });
}

async function expectFiveLineViewport(field: Locator, shouldGrow: boolean): Promise<void> {
  const initial = await geometry(field);
  await field.fill(FIVE_LINES);
  const five = await geometry(field);

  if (shouldGrow) {
    expect(five.height, "the textarea should grow as lines are added").toBeGreaterThan(
      initial.height + initial.lineHeight * 2,
    );
  }
  expect(five.visibleRows, "all five entered lines should fit in the viewport").toBeGreaterThanOrEqual(5);
  expect(five.overflow, "five lines should not be clipped inside the textarea").toBeLessThanOrEqual(1);

  await field.fill(SIX_LINES);
  const six = await geometry(field);
  expect(six.height, "a sixth line should use the textarea's five-line cap").toBeLessThanOrEqual(
    five.height + 1,
  );
  expect(six.visibleRows, "the capped textarea should keep a five-line viewport").toBeGreaterThanOrEqual(5);
  expect(six.overflow, "input beyond five lines should scroll inside the textarea").toBeGreaterThan(1);
}

async function captureEvidence(page: Page, surface: Locator, filename: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;

  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await surface.screenshot({ path: `${EVIDENCE}${filename}` });
  console.log(`CAPTURED e2e/.artifacts/multiline-textarea/${filename}`);
}

async function prepareDispatch(page: Page, daemon: DaemonHandle): Promise<Locator> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  return dialog;
}

test("multiline text boxes grow through five lines before scrolling", async ({
  dashboard,
  daemon,
}) => {
  const dialog = await prepareDispatch(dashboard, daemon);
  const task = dialog.getByPlaceholder("What should this agent do?");

  // The dispatch brief starts at five rows. It uses the same global contract as the compact
  // composers, but its empty-state floor should remain intact when content sizing turns on.
  await expectFiveLineViewport(task, false);
  await task.fill(FIVE_LINES);
  await captureEvidence(dashboard, dialog, "dispatch-brief-five-lines.png");
  await task.fill("exercise every multiline input size");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const card = dashboard.locator(".console-detail");
  const send = card.getByRole("button", { name: "Send" });
  await expect(send).toBeEnabled();
  await send.click();

  // The collapsed-card composer is the smallest variant: one line at rest, five when the
  // draft needs them, then an internal scrollbar for anything longer.
  const compactComposer = card.getByPlaceholder("Message to send…");
  await expectFiveLineViewport(compactComposer, true);
  await compactComposer.fill(FIVE_LINES);
  await captureEvidence(dashboard, card, "collapsed-card-composer-five-lines.png");
  await compactComposer.press("Escape");
  await expect(compactComposer).toHaveCount(0);

  await card.getByRole("button", { name: "Terminal view" }).click();
  const terminalComposer = card.getByPlaceholder("Send the next instruction to this process…");
  await expect(terminalComposer).toBeEnabled();
  await expectFiveLineViewport(terminalComposer, true);

  // Return to exactly five lines for the optional visual evidence. This is the reported
  // prompt-line rendering, with line five visible instead of line two being clipped.
  await terminalComposer.fill(FIVE_LINES);
  const promptOffset = await terminalComposer.evaluate((element) => {
    const prompt = element.closest(".compose-row")?.querySelector<HTMLElement>(".pty-prompt");
    if (!prompt) return Number.POSITIVE_INFINITY;
    return prompt.getBoundingClientRect().top - element.getBoundingClientRect().top;
  });
  expect(promptOffset, "the terminal prompt should stay beside the first input line").toBeLessThanOrEqual(6);
  await captureEvidence(dashboard, card, "terminal-composer-five-lines.png");
});
