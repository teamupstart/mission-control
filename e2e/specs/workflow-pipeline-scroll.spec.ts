import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * That an overflowing pipeline scrolls, and that its last stage can be reached.
 *
 * A headless browser reserves no space for a scrollbar however it is styled, so whether one is
 * drawn is measured in `test/workflow-builder-electron.test.ts` instead. This layer asserts the
 * scrolling itself and that the served stylesheet still carries the rule.
 */

const EVIDENCE = artifactsDir("workflow-pipeline-scroll");

/** Kept in step with the height `test/workflow-builder-electron.test.ts` measures. */
const TRACK = "10px";

/**
 * One declaration of a scrollbar rule, as the browser parsed it out of the served bundle.
 *
 * Read from CSSOM because a grep of `styles.css` would not catch the build dropping it, and a
 * scrollbar pseudo-element has no computed style to read instead. Returns null when the rule
 * is absent and "" when it carries no such declaration, so the two are distinguishable.
 *
 * What these declarations PAINT is asserted in `test/workflow-builder-electron.test.ts`, which
 * samples the rendered thumb at rest and under the pointer. This layer only settles that the
 * built bundle still ships them.
 */
async function scrollbarRule(
  page: Page,
  selector: string,
  property: "height" | "background",
): Promise<string | null> {
  return page.evaluate(([wanted, declaration]) => {
    for (const sheet of document.styleSheets) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue; // A cross-origin sheet is not ours to read; the app's is same-origin.
      }
      for (const rule of rules) {
        const styleRule = rule as CSSStyleRule;
        if (styleRule.selectorText === wanted) {
          return styleRule.style.getPropertyValue(declaration!) || "";
        }
      }
    }
    return null;
  }, [selector, property] as const);
}

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

/** Dispatch one agent from the modal - the sanctioned way to get a live, bindable session. */
async function dispatch(page: Page, daemon: DaemonHandle): Promise<string> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // The repo combobox portals its listbox over the fields below, so close it before filling
  // the next one. Its handler stops propagation, so this closes the list, not the modal.
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?")
    .fill("hold a session for the pipeline scroll spec");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let sessionId = "";
  await expect.poll(async () => {
    const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
    const live = sessions.find((session) => session.state !== "exited");
    sessionId = live?.id ?? "";
    return live?.state ?? "";
  }).toBe("idle");
  return sessionId;
}

/**
 * A run of six sequential stages, wider than the shipped review so the strip still overflows
 * if a card's padding changes. Never driven to a verdict: the strip is drawn from the
 * immutable version as soon as the run exists, so no model tokens are spent.
 */
async function seedWideRun(page: Page, daemon: DaemonHandle): Promise<string> {
  const sessionId = await dispatch(page, daemon);

  const stages = 6;
  const nodes: unknown[] = [{ id: "session", kind: "session", position: { x: 0, y: 0 } }];
  const edges: unknown[] = [];
  let source = "session";
  let sourcePort = "submitted";
  for (let index = 0; index < stages; index += 1) {
    const persona = await api<{ id: string }>(daemon, "/api/personas", {
      name: `Pipeline width reviewer ${index + 1}`,
      guidanceMarkdown: `# Pipeline width reviewer ${index + 1}\n\nE2E_PASS_VERDICT`,
    });
    const id = `reviewer-${index}`;
    nodes.push({
      id,
      kind: "persona",
      personaId: persona.id,
      position: { x: 220 * (index + 1), y: 0 },
    });
    edges.push({ id: `pass-${index}`, source, sourcePort, target: id, targetPort: "activate" });
    edges.push({
      id: `fail-${index}`,
      source: id,
      sourcePort: "fail",
      target: "session",
      targetPort: "return_for_changes",
    });
    source = id;
    sourcePort = "pass";
  }
  nodes.push({
    id: "end",
    kind: "end",
    outcome: "Approved",
    position: { x: 220 * (stages + 1), y: 0 },
  });
  edges.push({ id: "approve", source, sourcePort, target: "end", targetPort: "terminal" });

  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E pipeline width",
    draft: { nodes, edges },
  });
  const published = await api<{ version: { id: string } }>(
    daemon,
    `/api/workflows/${workflow.workflow.id}/publish`,
    { expectedDraftRevision: 1 },
  );
  const binding = await api<{ id: string }>(daemon, "/api/workflow-bindings", {
    workflowVersionId: published.version.id,
    sessionId,
    deliveryMode: "preview",
  });
  const submitted = await api<{ run: { id: string } }>(
    daemon,
    `/api/workflow-bindings/${binding.id}/submit`,
    { requestId: "e2e-pipeline-scroll" },
  );
  return submitted.run.id;
}

test("a workflow run's pipeline draws a scrollbar that reaches its last stage", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.setViewportSize({ width: 1280, height: 900 });
  const runId = await seedWideRun(dashboard, daemon);
  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);

  const strip = dashboard.locator(".wf-run-detail .wf-pipeline-strip");
  await expect(strip).toBeVisible();
  const stages = strip.locator("section.wf-pipeline-stage");
  await expect(stages).toHaveCount(6);

  // The precondition the case rests on: the strip holds more than it can show.
  const overflow = await strip.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow, "the seeded pipeline should be wider than the reader").toBeGreaterThan(0);
  const last = stages.last();
  const hidden = await last.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const scroller = el.closest(".wf-pipeline-strip")!.getBoundingClientRect();
    return Math.round(box.right - scroller.right);
  });
  expect(hidden, "the last stage should start out past the strip's right edge")
    .toBeGreaterThan(0);

  // The rule reached the page; its effect is measured in the Electron case.
  expect(
    await scrollbarRule(dashboard, ".wf-pipeline-strip::-webkit-scrollbar", "height"),
    "the served stylesheet should carry the strip's scrollbar rule",
  ).toBe(TRACK);
  // Both thumb states, and each with its declaration rather than merely present: a rule that
  // shipped empty would draw the platform's own thumb and satisfy a bare null check.
  const thumb = await scrollbarRule(
    dashboard, ".wf-pipeline-strip::-webkit-scrollbar-thumb", "background",
  );
  const thumbHover = await scrollbarRule(
    dashboard, ".wf-pipeline-strip::-webkit-scrollbar-thumb:hover", "background",
  );
  expect(thumb, "the thumb rule should ship a background").toBeTruthy();
  expect(thumbHover, "the thumb's hover rule should ship a background").toBeTruthy();
  expect(thumbHover, "hover should not repeat the resting background").not.toBe(thumb);

  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    await dashboard.screenshot({ path: `${EVIDENCE}01-run-strip-at-rest.png` });
  }

  // The trackpad gesture an operator makes, and the one a headless browser can perform.
  await strip.hover();
  await dashboard.mouse.wheel(200, 0);
  await expect.poll(async () => strip.evaluate((el) => el.scrollLeft),
    { message: "a horizontal wheel over the strip should scroll it" })
    .toBeGreaterThan(0);

  // Carried to the end, the off-screen stage sits fully inside the strip.
  await strip.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  await expect.poll(async () => last.evaluate((el) => {
    const stage = el.getBoundingClientRect();
    const scroller = el.closest(".wf-pipeline-strip")!.getBoundingClientRect();
    return Math.round(stage.right) <= Math.round(scroller.right);
  })).toBe(true);
  // Named, so "the card is inside the box" cannot be satisfied by the wrong card.
  await expect(last).toContainText("Pipeline width reviewer 6");

  if (process.env.MC_E2E_EVIDENCE) {
    await dashboard.screenshot({ path: `${EVIDENCE}02-run-strip-scrolled-to-end.png` });
  }
});

test("the builder's Pipeline view scrolls to its last stage too", async ({
  dashboard,
  daemon,
}) => {
  // Narrow enough that the shipped five-stage review cannot fit the builder's centre pane,
  // which is the state an operator authoring on a laptop is in.
  await dashboard.setViewportSize({ width: 1100, height: 900 });
  await dashboard.goto(`${daemon.baseURL}/#/workflows`);
  await dashboard.getByRole("button", { name: /No-Mistakes Review/ }).click();

  const strip = dashboard.locator(".wf-pipeline-strip");
  await expect(strip).toBeVisible();
  expect(await strip.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeGreaterThan(0);

  // The shared class carries the rule, so the surface an operator authors on gets it too.
  expect(
    await scrollbarRule(dashboard, ".wf-pipeline-strip::-webkit-scrollbar", "height"),
    "the builder serves the same scrollbar rule",
  ).toBe(TRACK);

  // And the far end is reachable here as well: the Pull Request stage is the last card.
  const stages = strip.locator("section.wf-pipeline-stage");
  await strip.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  await expect.poll(async () => stages.last().evaluate((el) => {
    const stage = el.getBoundingClientRect();
    const scroller = el.closest(".wf-pipeline-strip")!.getBoundingClientRect();
    return Math.round(stage.right) <= Math.round(scroller.right);
  })).toBe(true);
  await expect(stages.last().locator(".wf-pipeline-stage-name")).toHaveText("Pull Request");

  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    await dashboard.screenshot({ path: `${EVIDENCE}03-builder-strip.png` });
  }
});
