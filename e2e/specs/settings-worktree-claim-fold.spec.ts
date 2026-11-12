import { mkdirSync } from "node:fs";
import type { Locator, Page, Route } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

// Settings > Worktrees: each pool's dependency claim section starts folded, unfolds from its
// legend, and a save the route refuses opens it again even when the operator folded it while
// the save was in flight. Nothing is dispatched; every agent binary stays faked anyway.

const EVIDENCE = artifactsDir("settings-worktree-claim-fold");
const NAME = "Dependency claim, run on every task lease";

async function shoot(page: Page, target: Locator, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/settings-worktree-claim-fold/${name}.png`);
}

test("the claim section starts folded, unfolds on click, and opens itself on a refused save", async ({
  dashboard,
  daemon,
}) => {
  const acquired = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
    data: { repositoryPath: daemon.repo, label: "creates the pool" },
  });
  expect(acquired.status()).toBe(201);

  await dashboard.goto(`${daemon.baseURL}/#/settings/worktrees`);
  const pool = dashboard.locator(".wt-pool", { hasText: "demo-repo" });
  const disclosure = pool.getByRole("button", { name: /demo-repo/ });
  if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();

  const editor = pool.getByRole("group", { name: NAME, exact: true });
  const toggle = editor.getByRole("button", { name: NAME, exact: true });
  await expect(editor).toBeVisible();
  await expect(toggle).toContainText(NAME);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(editor.getByRole("button", { name: "Add step" })).toBeHidden();
  await expect(editor.getByText("No claim is configured. Add a step to set one up.")).toBeHidden();
  await shoot(dashboard, editor, "01-claim-folded");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(editor.getByText("No claim is configured. Add a step to set one up.")).toBeVisible();
  await shoot(dashboard, editor, "02-claim-unfolded");

  // A draft the route refuses, held in flight so the operator can fold the section first.
  await editor.getByRole("button", { name: "Add step" }).click();
  await editor.getByLabel("Step 1 command, one argument per line").fill("true");
  const variables = editor.getByLabel("Step 1 variable names");
  await variables.fill("bad-name");
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const holdPut = async (route: Route) => {
    if (route.request().method() === "PUT") await held;
    await route.continue();
  };
  await dashboard.route("**/api/worktrees/config", holdPut);
  const refused = dashboard.waitForResponse((response) =>
    response.url().endsWith("/api/worktrees/config") && response.request().method() === "PUT");
  await editor.getByRole("button", { name: "Save claim" }).click();
  await expect(editor.getByRole("button", { name: "Saving…" })).toBeDisabled();

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(variables).toBeHidden();

  release();
  expect((await refused).status()).toBe(400);
  await dashboard.unroute("**/api/worktrees/config", holdPut);
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(variables).toBeVisible();
  await expect(variables).toHaveAttribute("aria-invalid", "true");
  await expect(variables).toHaveAccessibleDescription("bad-name: a variable name is letters, digits and underscores");
  await expect(editor.getByRole("alert")).toHaveText("The claim was not saved. Fix the fields marked above.");
  await shoot(dashboard, editor, "03-claim-opened-on-refusal");
});
