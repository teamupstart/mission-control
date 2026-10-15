import { mkdirSync } from "node:fs";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";

const EVIDENCE = artifactsDir("document-kind");

test("the documentation panel's existing judges expose ownership, contract, and clarity guidelines", async ({ dashboard, daemon }) => {
  await dashboard.setViewportSize({ width: 1440, height: 1100 });
  await dashboard.goto(`${daemon.baseURL}/#/library/personas`);
  const roles = [
    { slug: "documentation-steward", name: "Documentation Steward", heading: "Consolidation is not loss", detail: "Verified claims need provenance" },
    { slug: "documentation-consistency-judge", name: "Documentation Consistency Judge", heading: "Names, deliverables, and dependency contracts", detail: "prerequisite slice-plan merges" },
    { slug: "conciseness-reference-judge", name: "Conciseness & Reference Judge", heading: "Clarity without another source of truth", detail: "Outcomes say what the caller or reader receives" },
  ];
  for (const role of roles) {
    await dashboard.getByRole("complementary", { name: "Persona library" })
      .getByRole("button", { name: new RegExp(`^${role.name} `) }).click();
    await expect(dashboard.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(role.name);
    await dashboard.getByRole("button", { name: "Preview", exact: true }).click();
    const preview = dashboard.getByRole("region", { name: "Persona guidance" });
    await expect(preview.getByRole("heading", { name: role.heading, exact: true })).toBeVisible();
    await expect(preview).toContainText(role.detail);
    if (process.env.MC_E2E_EVIDENCE) {
      mkdirSync(EVIDENCE, { recursive: true });
      await preview.getByRole("heading", { name: role.heading, exact: true }).scrollIntoViewIfNeeded();
      await dashboard.screenshot({ path: `${EVIDENCE}${role.slug}-guidelines.png` });
    }
  }
});

test("Documentation Review exposes its judges and preserves repair policy through both editors", async ({ dashboard, daemon }) => {
  await dashboard.setViewportSize({ width: 1440, height: 1100 });
  await dashboard.goto(`${daemon.baseURL}/#/workflows`);
  await dashboard.getByRole("button", { name: /^Documentation Review built-in/ }).click();
  const pipeline = dashboard.locator(".wf-pipeline-strip");
  await expect(pipeline.locator(".wf-pipeline-reviewer-name")).toHaveText([
    "Commanddocumentation", "Intent Conformance Judge", "Documentation Steward",
    "Documentation Consistency Judge", "Conciseness & Reference Judge", "Session actionPull Request",
  ]);
  const row = pipeline.locator("li.wf-pipeline-reviewer").filter({ hasText: "Documentation Consistency Judge" });
  await row.getByRole("button", { name: /^Model routing for Documentation Consistency Judge/ }).click();
  await expect(row.getByRole("checkbox", { name: /^Recheck Documentation Consistency Judge/ })).toBeChecked();
  await expect(row.getByRole("checkbox", { name: /^Recheck Documentation Consistency Judge/ })).toBeDisabled();
  await row.getByText("Recheck after repairs", { exact: true }).hover();
  await expect(dashboard.locator(".tooltip")).toHaveText(
    "Review this judge again after repairs, even when Settings reuses passing verdicts.",
  );
  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    await dashboard.screenshot({ path: `${EVIDENCE}repair-review-tooltip.png` });
  }
  await dashboard.mouse.move(0, 0);
  await expect(dashboard.locator(".tooltip")).toBeHidden();
  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    await row.scrollIntoViewIfNeeded();
    await dashboard.screenshot({ path: `${EVIDENCE}documentation-review.png` });
  }

  await dashboard.getByRole("button", { name: "Duplicate", exact: true }).click();
  await expect(dashboard.getByRole("button").filter({ has: dashboard.getByText("Documentation Review copy", { exact: true }) })).toBeVisible();
  const workflows = await (await fetch(`${daemon.baseURL}/api/workflows`)).json() as Array<{ id: string; name: string }>;
  const id = workflows.find(item => item.name === "Documentation Review copy")!.id;
  type Node = { id: string; kind: string; personaId?: string; recheckAfterRepair?: boolean };
  const nodes = async (): Promise<Node[]> => (await (await fetch(`${daemon.baseURL}/api/workflows/${id}`)).json()).workflow.draft.nodes;
  const consistency = (items: Node[]) => items.find(item => item.personaId === "builtin:documentation-consistency-judge")!;
  await row.getByRole("button", { name: /^Model routing for Documentation Consistency Judge/ }).click();
  await row.getByRole("checkbox", { name: /^Recheck Documentation Consistency Judge/ }).uncheck();
  await expect.poll(async () => consistency(await nodes()).recheckAfterRepair).toBe(false);
  const nodeId = consistency(await nodes()).id;
  await dashboard.getByRole("button", { name: "Graph", exact: true }).click();
  await dashboard.locator(`.react-flow__node[data-id="${nodeId}"]`).click();
  const rail = dashboard.getByRole("complementary", { name: "Workflow properties and validation" });
  const recheck = rail.getByRole("checkbox", { name: "Recheck Documentation Consistency Judge after repairs", exact: true });
  await expect(recheck).not.toBeChecked();
  await recheck.check();
  await expect.poll(async () => consistency(await nodes()).recheckAfterRepair).toBe(true);
  await dashboard.reload();
  await expect.poll(async () => (await nodes()).filter(item => item.kind === "persona").every(item => item.recheckAfterRepair)).toBe(true);
});

test("documentation command configuration survives reload and reaches the catalog", async ({ dashboard, daemon }) => {
  await dashboard.keyboard.press("Meta+k");
  const palette = dashboard.getByRole("dialog", { name: "Search everything" });
  await expectContentClearsBorder(palette);
  await palette.getByRole("combobox", { name: "Search everything" }).fill("documentation");
  await expect(palette.getByRole("option", { name: /^What each Command runs, setting/ })).toBeVisible();
  await dashboard.keyboard.press("Escape");
  await dashboard.goto(`${daemon.baseURL}/#/library/commands/documentation`);
  await expect(dashboard.getByRole("heading", { name: "documentation", exact: true })).toBeVisible();
  const field = dashboard.getByLabel("Default command");
  await field.fill("npm run docs:check");
  await dashboard.getByRole("button", { name: "Save Command" }).click();
  await expect.poll(async () => {
    const slots = await (await fetch(`${daemon.baseURL}/api/workflow-commands`)).json() as Array<{ slot: string; defaultCommand: string[] | null }>;
    return slots.find(slot => slot.slot === "documentation")?.defaultCommand;
  }).toEqual(["npm", "run", "docs:check"]);
  await dashboard.reload();
  await expect(field).toHaveValue("npm run docs:check");
});

test("document tasks use their saved model settings in Dispatch", async ({ dashboard, daemon }) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/models`);
  const agent = dashboard.getByRole("combobox", { name: "Agent for document tasks" });
  await agent.selectOption("codex");
  await expect.poll(async () => (await (await fetch(`${daemon.baseURL}/api/harnesses/config`)).json()).kindDefaults.document.agent).toBe("codex");
  await dashboard.reload();
  await expect(agent).toHaveValue("codex");
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await expectContentClearsBorder(dialog);
  await dialog.getByRole("combobox", { name: "Kind", exact: true }).selectOption("document");
  await expect(dialog.getByRole("combobox", { name: "Agent", exact: true })).toHaveValue("codex");
});

test("document defaults to Documentation Review and persists as a schedulable task", async ({ dashboard, daemon }) => {
  await dashboard.setViewportSize({ width: 1280, height: 1000 });
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await expectContentClearsBorder(dialog);
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("Document the setup procedure");
  const kind = dialog.getByRole("combobox", { name: "Kind", exact: true });
  const workflow = dialog.getByRole("combobox", { name: "After work", exact: true });
  await kind.selectOption("document");
  await expect(workflow).toHaveValue("builtin-workflow:documentation-review");
  await expect(dialog.getByText("Foreman complete")).toBeVisible();
  await kind.selectOption("ship");
  await expect(workflow).toHaveValue("__default");
  await kind.selectOption("document");
  await expect(workflow).toHaveValue("builtin-workflow:documentation-review");
  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    await dialog.screenshot({ path: `${EVIDENCE}document-default.png` });
  }
  await workflow.selectOption("__default");
  const responsePromise = dashboard.waitForResponse((response) =>
    response.url().endsWith("/api/tasks") && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "Add to backlog" }).click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  const task = await response.json();
  expect(task.kind).toBe("document");
  expect(task.workflowId).toBe("builtin-workflow:documentation-review");
  expect(task.status).toBe("backlog");
  expect(task.enabled).toBe(true);
  await expect(dialog).toBeHidden();
  await dashboard.reload();
  await expect(dashboard.getByText("Document the setup procedure").first()).toBeVisible();
});

test("document can opt out of its default and keep the explicit choice", async ({ dashboard, daemon }) => {
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await expectContentClearsBorder(dialog);
  const kind = dialog.getByRole("combobox", { name: "Kind", exact: true });
  const workflow = dialog.getByRole("combobox", { name: "After work", exact: true });
  await kind.selectOption("document");
  await workflow.selectOption("__none");
  await expect(dialog.getByText("No handoff")).toBeVisible();
  await kind.selectOption("ship");
  await expect(workflow).toHaveValue("__none");

  await kind.selectOption("document");
  await workflow.selectOption("__none");
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("Document setup without review");
  const responsePromise = dashboard.waitForResponse((response) =>
    response.url().endsWith("/api/tasks") && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "Add to backlog" }).click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  const task = await response.json();
  expect(task.kind).toBe("document");
  expect(task.workflowId).toBe(null);
  await expect(dialog).toBeHidden();
  await expect.poll(async () => {
    const tasks = await (await fetch(`${daemon.baseURL}/api/tasks`)).json() as Array<{
      id: string; kind: string; workflowId: string | null;
    }>;
    return tasks.find((saved) => saved.id === task.id);
  }).toMatchObject({ id: task.id, kind: "document", workflowId: null });
});
