import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * Code Design Reviewer, the sixth shipped review role, on its own surface.
 *
 * The Persona rail lists it under `Built-in` and opens it read-only, carrying the exact
 * document this build was made from. `test/builtin-personas.test.ts` proves the catalog holds
 * it and `test/builtin-personas-web.test.ts` proves the library renders a row per role, but
 * neither can click the row, and this role reaches an operator through that click or not at
 * all.
 *
 * The load-bearing sentences of the document are asserted rather than the whole of it: this
 * role sits in a BLOCKING stage of the flagship built-in, and it is safe there only because
 * its findings are scoped to the submitted change and an equally valid alternative shape is a
 * pass. Shipping it with either rule missing would be a repair loop arguing about code the
 * task never touched.
 *
 * Its place in the shipped graph is NOT asserted here. `no-mistakes-review-stages.spec.ts`
 * owns stage membership for the whole workflow, and restating it would give one fact two
 * owners that drift apart.
 *
 * No agent is launched and none is needed. The Library authors; it does not run.
 */

const EVIDENCE = artifactsDir("code-design-reviewer");

const DESIGN = "Code Design Reviewer";

/** The two rules that make a design reviewer safe to put in front of a repair loop. */
const SCOPE_RULE = "The finding must be in the submitted change, or in code this change directly extends.";
const NOT_A_ROUTE_AROUND = "That title is not a route around those rules.";

interface ListedPersona {
  id: string;
  name: string;
  builtin: boolean;
  description: string;
}

async function api<T>(daemon: DaemonHandle, path: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`);
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Persona library" });
const nameField = (page: Page) => page.locator("section.persona-fields").getByLabel("Name");

async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/code-design-reviewer/${name}.png`);
}

test("the design reviewer ships as a read-only built-in carrying its limits", async ({
  dashboard,
  daemon,
}) => {
  // Present in the catalog a fresh install serves, with no seeding gesture - which is what
  // "app data, not operator data" means for a role that has no row.
  const personas = await api<ListedPersona[]>(daemon, "/api/personas");
  const shipped = personas.find((persona) => persona.name === DESIGN);
  expect(shipped, "this build ships no Code Design Reviewer").toBeTruthy();
  expect(shipped!.builtin).toBe(true);

  await dashboard.goto(`${daemon.baseURL}/#/library/personas`);
  const rail = sidebar(dashboard);
  await expect(rail).toBeVisible();

  // Under `Built-in`, not `Yours`. A shipped role listed as the operator's own reads as
  // something they wrote and can be held to.
  await expect(rail.getByRole("heading", { name: /^Built-in\s+\d+$/ })).toBeVisible();
  const row = rail.getByRole("button", { name: new RegExp(DESIGN) });
  await expect(row).toBeVisible();

  await row.click();
  await expect(nameField(dashboard)).toHaveValue(DESIGN);
  // Read-only, and with no Save to press rather than a disabled one.
  await expect(nameField(dashboard)).toHaveAttribute("readonly", "");
  await expect(dashboard.getByRole("button", { name: "Save" })).toHaveCount(0);
  await expect(dashboard.getByRole("button", { name: "Duplicate to edit" })).toBeVisible();

  // The document itself, read the way the reviewer will read it. Preview rather than the
  // source editor, because a code editor is free to virtualize the line this asserts on.
  const guidance = dashboard.getByRole("region", { name: "Persona guidance" });
  await guidance.getByRole("button", { name: "Preview" }).click();
  await expect(guidance).toContainText("Composition over inheritance");
  await expect(guidance).toContainText("Anti-overreach rules");
  await expect(guidance).toContainText(SCOPE_RULE);
  await expect(guidance).toContainText(NOT_A_ROUTE_AROUND);
  await shoot(dashboard, "01-builtin-code-design-reviewer");
});
