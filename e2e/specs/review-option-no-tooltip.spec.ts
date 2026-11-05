import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * Picking an option leaves no tooltip behind, for `request_plan_decisions` and `request_input`
 * alike (both draw `DecisionForm`). Absences are read once after the click is confirmed, since
 * a retrying assertion would pass over a bubble that appeared and went away, and each test
 * first shows that "Chat about it", which keeps its tooltip, can still raise one.
 */

const EVIDENCE = artifactsDir("review-option-no-tooltip");
const TASK = "choose a rollout";

/** Opt-in reviewer pixels, gitignored under `e2e/.artifacts/`, never committed. */
async function evidence(target: Locator | Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
}

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // The repo combobox reopens over the Task field on every keystroke; Escape closes the list,
  // not the modal.
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(TASK);
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row")).toHaveCount(1);
}

/** Raise a review the way the agent's MCP child does, bound to the session by its checkout. */
async function ask(daemon: DaemonHandle, body: Record<string, unknown>): Promise<void> {
  let cwd: string | null = null;
  await expect
    .poll(
      async () => {
        const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as Array<{
          cwd: string | null;
        }>;
        cwd = sessions[0]?.cwd ?? null;
        return cwd;
      },
      { message: "the dispatched session is on the fleet, with a checkout to bind a review to" },
    )
    .toBeTruthy();
  const res = await fetch(`${daemon.baseURL}/mcp/reviews`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-harness-token": readFileSync(join(daemon.home, "token"), "utf8").trim(),
    },
    body: JSON.stringify({ env: {}, cwd, ...body }),
  });
  expect(res.status, `the review channel accepted the request: ${await res.clone().text()}`).toBe(200);
}

async function openReview(page: Page): Promise<Locator> {
  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  await page.locator(".console-detail").getByRole("button", { name: "to review" }).click();
  const modal = page.getByRole("dialog", { name: "Review request" });
  await expect(modal).toBeVisible();
  return modal;
}

const ROLLOUT = "How should I proceed on the rollout?";
const HARNESSES = "Which harnesses get it first?";
const REBASE_DETAIL =
  "Accepting makes the draft the text the owners review. A selector on a run with no GitHub call does nothing.";

const DECISIONS = {
  kind: "plan-decisions",
  title: "Rollout plan",
  body: "## Plan\n\nRoll the change out in stages.",
  decisions: [
    {
      id: "rollout",
      question: ROLLOUT,
      options: [
        { id: "rebase", label: "Rebase and accept it as provisional", detail: REBASE_DETAIL, recommended: true },
        { id: "wait", label: "Rebase but leave it pending", detail: "Waits for the owners to reply before anything ships." },
        { id: "plain", label: "Skip the rebase" },
      ],
    },
    {
      id: "harnesses",
      question: HARNESSES,
      multiSelect: true,
      options: [
        { id: "claude", label: "Claude", detail: "Reads JSONL transcripts." },
        { id: "codex", label: "Codex", detail: "Reads rollout files." },
      ],
    },
  ],
};

test("choosing an option leaves no tooltip over the question", async ({ dashboard, daemon }) => {
  await dispatch(dashboard, daemon);
  await ask(daemon, DECISIONS);
  const modal = await openReview(dashboard);
  const bubble = dashboard.locator(".tooltip");
  const rollout = modal.getByRole("group", { name: ROLLOUT });
  const rebase = rollout.getByRole("radio", { name: /^Rebase and accept it as provisional/ });
  const chat = rollout.getByRole("radio", { name: "Chat about it" });

  await chat.hover();
  await expect(bubble).toHaveText(/^Skip choosing for now/);
  await dashboard.mouse.move(0, 0);
  await expect(bubble).toHaveCount(0);

  const printed = rollout.getByText(REBASE_DETAIL);
  await expect(printed).toHaveCount(1);
  await expect(printed).toBeVisible();

  await rebase.hover();
  expect(await bubble.count(), "hovering an option row paints no bubble").toBe(0);

  await rebase.check();
  await expect(rebase).toBeChecked();
  await expect(rebase).toBeFocused();
  expect(await bubble.count(), "picking an option leaves no bubble behind").toBe(0);
  // The whole page, not the modal: the old bubble painted outside the modal's own box.
  await evidence(dashboard, "option-picked-no-tooltip");

  await expect(rebase).toHaveAccessibleName(new RegExp(`Rebase and accept it as provisional.*${REBASE_DETAIL.slice(0, 40)}`));
  await expect(rebase).toHaveAccessibleDescription("");

  await rebase.press("ArrowDown");
  const wait = rollout.getByRole("radio", { name: /^Rebase but leave it pending/ });
  await expect(wait).toBeChecked();
  await expect(wait).toBeFocused();
  await expect(rebase).not.toBeChecked();
  expect(await bubble.count(), "arrowing onto an option paints no bubble").toBe(0);

  const claude = modal.getByRole("group", { name: HARNESSES }).getByRole("checkbox", { name: /^Claude/ });
  await claude.check();
  await expect(claude).toBeChecked();
  await expect(claude).toBeFocused();
  expect(await bubble.count(), "ticking an option paints no bubble").toBe(0);

  await chat.focus();
  await expect(bubble).toHaveText(/^Skip choosing for now/);
});

const LINTER = "Which linter should this repo use?";

/** The shape `request_input` sends (`src/mcp/server.ts`): no legend, so the group is named by aria-label. */
function requestInput(extra: { multiSelect?: boolean; allowOther?: boolean }): Record<string, unknown> {
  return {
    kind: "input",
    title: LINTER,
    body: LINTER,
    decisions: [
      {
        id: "q",
        question: LINTER,
        ...extra,
        options: [
          { id: "o0", label: "biome", detail: "One binary for lint and format; fewer plugins.", recommended: true },
          { id: "o1", label: "eslint", detail: "The widest rule ecosystem; slower and config-heavy." },
        ],
      },
    ],
  };
}

test("a request_input question's options leave no tooltip over the question either", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);
  await ask(daemon, requestInput({ allowOther: true }));
  const modal = await openReview(dashboard);
  const bubble = dashboard.locator(".tooltip");
  const group = modal.getByRole("group", { name: LINTER });
  const biome = group.getByRole("radio", { name: /^biome/ });
  const eslint = group.getByRole("radio", { name: /^eslint/ });

  await group.getByRole("radio", { name: "Chat about it" }).hover();
  await expect(bubble).toHaveText(/^Skip choosing for now/);
  await dashboard.mouse.move(0, 0);
  await expect(bubble).toHaveCount(0);

  const printed = group.getByText("One binary for lint and format; fewer plugins.");
  await expect(printed).toHaveCount(1);
  await expect(printed).toBeVisible();

  await biome.hover();
  expect(await bubble.count(), "hovering an option row paints no bubble").toBe(0);

  await biome.check();
  await expect(biome).toBeChecked();
  await expect(biome).toBeFocused();
  expect(await bubble.count(), "picking an option leaves no bubble behind").toBe(0);
  await evidence(dashboard, "request-input-option-picked-no-tooltip");

  await expect(biome).toHaveAccessibleName(/biome.*One binary for lint and format/);
  await expect(biome).toHaveAccessibleDescription("");

  await biome.press("ArrowDown");
  await expect(eslint).toBeChecked();
  await expect(eslint).toBeFocused();
  expect(await bubble.count(), "arrowing onto an option paints no bubble").toBe(0);

  await group.getByPlaceholder("Other…").fill("oxlint");
  expect(await bubble.count(), "the Other field paints no bubble").toBe(0);
  await expect(modal.getByRole("button", { name: /^Submit/ })).toBeEnabled();
});

test("a multi-select request_input question's checkboxes leave no tooltip either", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);
  await ask(daemon, requestInput({ multiSelect: true }));
  const modal = await openReview(dashboard);
  const bubble = dashboard.locator(".tooltip");
  const group = modal.getByRole("group", { name: LINTER });
  const biome = group.getByRole("checkbox", { name: /^biome/ });
  const eslint = group.getByRole("checkbox", { name: /^eslint/ });

  await group.getByRole("checkbox", { name: "Chat about it" }).hover();
  await expect(bubble).toHaveText(/^Skip choosing for now/);
  await dashboard.mouse.move(0, 0);
  await expect(bubble).toHaveCount(0);

  await biome.check();
  await expect(biome).toBeChecked();
  await expect(biome).toBeFocused();
  expect(await bubble.count(), "ticking the first option leaves no bubble behind").toBe(0);

  await eslint.check();
  await expect(eslint).toBeChecked();
  await expect(eslint).toBeFocused();
  await expect(biome).toBeChecked();
  expect(await bubble.count(), "ticking a second option leaves no bubble behind").toBe(0);
  await evidence(dashboard, "request-input-multiselect-no-tooltip");
});
