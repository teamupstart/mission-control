import { mkdirSync } from "node:fs";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

/**
 * What a brand-new installation opens on, read where an operator reads it.
 *
 * Three defaults that each shipped wrong for a while, and each is a fact stated in more than
 * one place: the schema default, the client's first-paint cache, and the control that shows
 * it. Unit tests pin the schemas. Only a browser against a real daemon with an empty
 * database can show what a person who never opened Settings actually gets.
 *
 * - The dashboard layout is Board. Retiring Cards (#706) moved it to Console by accident,
 *   and new installs opened in Console from then on.
 * - Foreman's mode is Live. It still sends nothing until a repository is granted in Trust.
 * - A new workflow's binding delivers Live, matching the built-in workflows.
 *
 * The layout test uses the raw `page` fixture on purpose: the `dashboard` fixture pins
 * Console, so the suite written against that layout keeps saying what it always said.
 */

const EVIDENCE = artifactsDir("fresh-install-defaults");

async function capture(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/fresh-install-defaults/${name}`);
}

test("a new installation opens the dashboard on the Board layout", async ({ page, daemon }) => {
  // An empty fleet renders no layout at all, so give the board something to draw. A backlog
  // task is a Board column and is absent from the Console rail, which makes it the visible
  // difference between the two.
  const title = "Fresh install layout probe";
  const created = await fetch(`${daemon.baseURL}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repoRoot: daemon.repo,
      intent: "Confirm the dashboard opens on the Board layout.",
      title,
      backlog: true,
    }),
  });
  expect(created.ok, `creating the backlog task answered ${created.status}`).toBe(true);

  // The daemon fixture's startup-picker pin is this install's first preference write, and
  // any write persists the whole parsed config - so the layout it stored is the default a
  // real fresh install would have persisted on its first settings change.
  const stored = await fetch(`${daemon.baseURL}/api/ui/config`);
  expect(((await stored.json()) as { config: { layout: string } }).config.layout).toBe("board");

  await page.goto(`${daemon.baseURL}/#/fleet`);
  await expect(page.getByRole("heading", { level: 2, name: "Backlog" })).toBeVisible();
  await expect(page.getByRole("button", { name: title, exact: true })).toBeVisible();
  await capture(page, "01-board-layout.png");

  await page.goto(`${daemon.baseURL}/#/settings/display`);
  const picker = page.getByRole("radiogroup", { name: "Dashboard layout" });
  await expect(picker.getByRole("radio", { name: /^Board\b/ })).toBeChecked();
  await expect(picker.getByRole("radio", { name: /^Console\b/ })).not.toBeChecked();

  // Choosing Console persists, which proves the Board above was an unanswered default
  // rather than a stuck render.
  await picker.getByRole("radio", { name: /^Console\b/ }).check();
  await page.reload();
  await expect(
    page.getByRole("radiogroup", { name: "Dashboard layout" }).getByRole("radio", { name: /^Console\b/ }),
  ).toBeChecked();
});

test("a new installation runs Foreman in Live mode", async ({ dashboard, daemon }) => {
  await dashboard.goto(daemon.baseURL);
  await dashboard.getByRole("button", { name: /Foreman - the auto-responder/ }).click();
  const popover = dashboard.getByRole("dialog", { name: "Foreman settings" });
  await expect(popover).toBeVisible();

  const modes = popover.getByRole("group", { name: "Mode" });
  await expect(modes.getByRole("radio", { name: "Live - send on my behalf" })).toBeChecked();
  await expect(modes.getByRole("radio", { name: "Dry-run - draft only, never send" }))
    .not.toBeChecked();
  await capture(dashboard, "02-foreman-live.png");

  await modes.getByRole("radio", { name: "Dry-run - draft only, never send" }).check();
  await expect.poll(async () => {
    const config = await fetch(`${daemon.baseURL}/api/foreman/config`);
    return ((await config.json()) as { mode: string }).mode;
  }).toBe("dry-run");
});

test("a new workflow defaults its bindings to Live delivery", async ({ dashboard, daemon }) => {
  await dashboard.goto(`${daemon.baseURL}/#/library`);
  await dashboard.getByRole("button", { name: /New workflow/ }).click();
  await expect.poll(async () => dashboard.evaluate(() => location.hash))
    .toMatch(/^#\/library\/workflows\/(?!new$).+/);

  await expect(dashboard.getByLabel(/^Default delivery/)).toHaveValue("live");
  await capture(dashboard, "03-workflow-live-delivery.png");

  // The control reads the stored draft, so the daemon must hold the same answer.
  const id = decodeURIComponent((await dashboard.evaluate(() => location.hash)).split("/").pop() ?? "");
  const detail = await fetch(`${daemon.baseURL}/api/workflows/${encodeURIComponent(id)}`);
  expect(detail.ok, `reading the new workflow answered ${detail.status}`).toBe(true);
  const body = (await detail.json()) as { workflow: { bindingDefaults: { deliveryMode: string } } };
  expect(body.workflow.bindingDefaults.deliveryMode).toBe("live");
});
