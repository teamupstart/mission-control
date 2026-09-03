import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * Code Design Reviewer, the sixth shipped review role, in the two surfaces it is visible in.
 *
 * Two facts, and neither is a markup shape:
 *
 * - the Persona rail lists it under `Built-in` and opens it read-only, carrying the exact
 *   document this build was made from. `test/builtin-personas.test.ts` proves the catalog holds
 *   it and `test/builtin-personas-web.test.ts` proves the library renders a row per role, but
 *   neither can click the row, and this role reaches an operator through that click or not at
 *   all;
 * - the shipped No-Mistakes Review draws it as the THIRD member of stage 3, beside Code Risk
 *   Reviewer and Code Quality Judge. That placement is the whole cost argument for the version:
 *   three reviewers on one submission and one repair packet, rather than a stage of its own and a
 *   second round. `test/builtin-workflows.test.ts` pins the graph, and a graph that pins
 *   correctly can still fail to draw - which is what a strip of stage cards, laid out and
 *   scrolled, is the only thing that can answer.
 *
 * The load-bearing sentence in the document is asserted rather than the whole of it: this role
 * sits in a BLOCKING stage of the flagship built-in, and it is safe there only because its
 * findings are scoped to the submitted change. Shipping it with that rule missing would be a
 * repair loop arguing about code the task never touched.
 *
 * No agent is launched and none is needed. The Library authors; it does not run.
 */

const EVIDENCE = artifactsDir("code-design-reviewer");

const DESIGN = "Code Design Reviewer";

/** The rule that makes a design reviewer safe to put in front of a repair loop. */
const SCOPE_RULE = "The finding must be in the submitted change, or in code this change directly extends.";

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

test("the design reviewer ships as a read-only built-in carrying its scope rule", async ({
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
  const builtInGroup = rail.getByRole("heading", { name: /^Built-in\s+\d+$/ });
  await expect(builtInGroup).toBeVisible();
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
  await shoot(dashboard, "01-builtin-code-design-reviewer");
});

test("the shipped workflow draws the design reviewer as stage 3's third member", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/workflows`);
  await dashboard.getByRole("button", { name: /No-Mistakes Review/ }).click();

  const strip = dashboard.locator(".wf-pipeline-strip");
  await expect(strip).toBeVisible();
  const stages = strip.locator("section.wf-pipeline-stage");
  // Five stages, unchanged: the design reviewer joined an existing stage rather than adding
  // one, which is what keeps the version's cost at one model call and no extra wall clock.
  await expect(stages).toHaveCount(5);

  const codeReview = stages.nth(2);
  await expect(codeReview.locator(".wf-pipeline-stage-name")).toHaveText("Stage 3");
  await expect(codeReview.locator(".wf-pipeline-reviewer-name")).toHaveText([
    "Code Risk Reviewer",
    "Code Quality Judge",
    DESIGN,
  ]);

  // And it is genuinely BEFORE the evidence stage and the pull request, not merely present:
  // the order is what decides which findings share a repair packet.
  const order = await strip.locator("li.wf-pipeline-reviewer").allTextContents();
  const at = (text: string) => order.findIndex((entry) => entry.includes(text));
  expect(at(DESIGN)).toBeGreaterThan(at("Intent Conformance Judge"));
  expect(at(DESIGN)).toBeLessThan(at("Test Evidence Auditor"));
  expect(at(DESIGN)).toBeLessThan(at("Pull Request"));

  // Stage 3 has to fit inside its own strip once it has three members, which is the fault a
  // graph assertion cannot see: a card that overflows is drawn but unreadable.
  if ((dashboard.viewportSize()?.width ?? 0) > 900) {
    await codeReview.evaluate((element) => {
      const host = element.closest(".wf-pipeline-strip");
      if (!(host instanceof HTMLElement)) throw new Error("Stage 3 left its pipeline strip");
      host.scrollLeft += element.getBoundingClientRect().left - host.getBoundingClientRect().left;
    });
    const inside = await codeReview.evaluate((element) => {
      const host = element.closest(".wf-pipeline-strip");
      if (!(host instanceof HTMLElement)) throw new Error("Stage 3 left its pipeline strip");
      const item = element.getBoundingClientRect();
      const bounds = host.getBoundingClientRect();
      return item.left >= bounds.left && item.right <= bounds.right;
    });
    expect(inside).toBe(true);
  }
  await shoot(dashboard, "02-no-mistakes-stage-3-three-reviewers");
});
