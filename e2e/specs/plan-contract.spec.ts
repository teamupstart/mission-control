import { mkdirSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

const EVIDENCE = artifactsDir("plan-contract");

/**
 * What a dispatched `plan` task is actually told, and what happens when it cannot be told it.
 *
 * `plan-kind.spec.ts` covers the kind being OFFERED. This file covers what choosing it does,
 * which is the half no other layer can reach: the daemon composes a contract onto the intent,
 * hands it to a launched agent, and that agent's own conversation is the only place the
 * delivered text can be read back. The unit layer can assert the string the composer returns
 * and the HTTP layer can assert a 409 body, but neither can say the prompt made it out of the
 * daemon and into a session, or that the refusal reaches the form a person is standing in.
 *
 * Two things this proves that are invisible on a green suite otherwise:
 *
 * - The contract POINTS AT the `html-plans` skill instead of restating it, so the skill's
 *   invocation has to arrive rendered for THIS harness. A hardcoded `/html-plans` is exactly
 *   right on Claude and reaches nothing on Codex or Pi.
 * - Pointing at a skill makes it a launch requirement, so a dispatch that cannot invoke it is
 *   refused - and a refusal an operator cannot act on reads as a bug rather than as a setting.
 *
 * Every agent binary is the fake (`e2e/fixtures/fake-agents.ts`), which echoes the prompt it
 * received. No model tokens are spent, and the echo is what carries the delivered contract
 * back into the DOM.
 */

/**
 * One sentence, dispatched under two Kinds.
 *
 * Deliberately the SAME words in both tests, because the negative control at the bottom of
 * this file is only worth anything if the Kind is the one thing that differs.
 */
const TASK = "Plan how the archives library should be read from the dashboard";

/** By accessible name. Each select is wrapped in a `Tooltip`, which `getByLabel` walks past. */
const kindSelect = (dialog: Locator): Locator =>
  dialog.getByRole("combobox", { name: "Kind", exact: true });

/** A frame of the state the assertion beside it just proved, behind `MC_E2E_EVIDENCE`. */
async function shoot(page: Page, name: string, target?: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await (target ?? page).screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/plan-contract/${name}.png`);
}

/**
 * Switch the two planning skills on BEFORE anything is dispatched.
 *
 * Not incidental ordering. A fresh daemon starts with the master switch OFF (`SkillsConfig`
 * defaults), which is the state the refusal case below relies on - so the happy path has to
 * ask for the opposite explicitly rather than inheriting it.
 */
async function enablePlanningSkills(daemon: DaemonHandle): Promise<void> {
  const res = await fetch(`${daemon.baseURL}/api/skills/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true, skills: { "html-plans": true, "phased-plan": true } }),
  });
  expect(res.ok, "the skills panel should accept being switched on").toBeTruthy();
  const view = (await res.json()) as { skills: Array<{ id: string; enabled: boolean }> };
  for (const id of ["html-plans", "phased-plan"]) {
    // A build that stopped shipping one of these would otherwise fail later and obscurely,
    // as a refusal on a form this spec expected to submit cleanly.
    expect(
      view.skills.find((skill) => skill.id === id)?.enabled,
      `the ${id} skill has to be installable for this spec to mean anything`,
    ).toBe(true);
  }
}

/** Open Dispatch, fill everything except Kind, and hand back the dialog. */
async function openDispatch(page: Page, daemon: DaemonHandle, task: string): Promise<Locator> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // The repo combobox portals its listbox directly over the Task field below it.
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(task);
  // Pinned rather than left on the dispatch default: this repo is not allowlisted for Live
  // delivery, so the default would refuse the dispatch for a reason this spec is not about.
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  return dialog;
}

async function submit(dialog: Locator): Promise<void> {
  const go = dialog.getByRole("button", { name: "Dispatch now" });
  await expect(go).toBeEnabled();
  await go.click();
}

test("a dispatched plan is told to invoke the planning skill, in this harness's own syntax", async ({
  dashboard,
  daemon,
}) => {
  await enablePlanningSkills(daemon);

  const dialog = await openDispatch(dashboard, daemon, TASK);
  await kindSelect(dialog).selectOption("plan");
  await submit(dialog);
  await expect(dialog).toBeHidden();

  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const card = dashboard.locator(".console-detail");
  await expect(card).toBeVisible();
  // Expanded rather than read from the card face: a card shows an ACTIVITY line while a turn
  // runs and drops it when the turn ends, so an assertion there races the turn boundary. The
  // conversation is read from the real transcript by the real SSE stream, and the fake echoes
  // the prompt it was handed - so the delivered contract arrives back here verbatim.

  // The operator's own words, unmodified. Nothing about the contract rewrites the request.
  await expect(card).toContainText(TASK, { timeout: 30_000 });
  // And the contract behind them. `toContainText` reads the card's whole text rather than one
  // element, so a marker split across rendered nodes still counts.
  await expect(card).toContainText("Mission Control plan");
  // THE assertion this file exists for: the invocation is rendered through the harness
  // registry, not hardcoded. Claude spells it `/html-plans`; Codex and Pi spell it differently
  // and a literal would be inert on both.
  await expect(card).toContainText("/html-plans");
  await expect(card).toContainText("/phased-plan");
  // The review is asked with the tool, not in prose - and the launch pre-approved that tool,
  // which is the drift that turns into an agent sitting on a permission prompt.
  await expect(card).toContainText("request_plan_decisions");
  // Where the artifacts belong, so the plan lands somewhere the phase tasks can point at.
  // The directory rather than the whole shape: `<name>` is the skill's own placeholder and
  // this assertion should not turn into a claim about how a renderer treats angle brackets.
  await expect(card).toContainText("docs/plans/");
  // And a plan is not handed a scout's contract.
  await expect(card).not.toContainText("submit_scout_artifacts");

  await shoot(dashboard, "plan-contract-delivered", card);
});

test("a plan dispatch with the planning skills off is refused on the form, naming the toggle", async ({
  dashboard,
  daemon,
}) => {
  // No `enablePlanningSkills` here: a fresh daemon has the master switch off, which is the
  // real state an operator meets this in.
  const dialog = await openDispatch(dashboard, daemon, TASK);
  await kindSelect(dialog).selectOption("plan");
  await submit(dialog);

  // The daemon's own sentence, where every other refusal from this form lands.
  const refusal = dialog.locator(".dispatch-error");
  await expect(refusal).toContainText("Enable Skills and the html-plans skill");
  // Naming the toggle is not enough on its own - a refusal an operator cannot act on reads
  // as a bug - so it also says where the toggle lives and why a dispatch failed over it.
  await expect(refusal).toContainText("Settings → Skills");
  await expect(refusal).toContainText("invokes the planning skills");

  await shoot(dashboard, "plan-dispatch-refused", dialog);

  // Refused UP FRONT: the form is still open with the same words in it, and no task, worktree
  // or agent was created for work that could not have been done.
  await expect(dialog).toBeVisible();
  await expect(dialog.getByPlaceholder("What should this agent do?")).toHaveValue(TASK);
  await expect(dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row")).toHaveCount(0);

  // The negative control, and the reason it is in the same test: same form, same repository,
  // same words, one field different. A gate written as a dispatch-wide check rather than a
  // per-kind one would refuse this too, and every ship dispatch on a machine with skills
  // switched off would stop working.
  await kindSelect(dialog).selectOption("ship");
  await submit(dialog);
  await expect(dialog).toBeHidden();

  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const shipCard = dashboard.locator(".console-detail");
  await expect(shipCard).toBeVisible({ timeout: 30_000 });
  await expect(shipCard).toContainText(TASK, { timeout: 30_000 });
  // And its intent is the operator's words and nothing else. The kind decides whether a
  // contract is composed at all, so a ship task on the same sentence carries none of it.
  await expect(shipCard).not.toContainText("Mission Control plan");
  await expect(shipCard).not.toContainText("/html-plans");
});
