import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * Choosing the reasoning effort a workflow Persona call runs at, beside its model.
 *
 * `test/persona-effort.test.ts` pins the resolution order and the published snapshot, and
 * `test/workflow-engine.test.ts` pins the effort reaching a fake runner. Only a browser can see
 * the Effort `<select>` an operator changes reach the draft, come back on reload, freeze into a
 * published version, and then show up in the argv a CLI was launched with and in the run
 * detail beside the model that ran.
 *
 * No model tokens: every reviewer is answered by `e2e/fixtures/fake-agents.ts`.
 */

const EVIDENCE = artifactsDir("workflow-persona-effort");

const BUILTIN = "No-Mistakes Review (High Rigor)";
const COPY = `${BUILTIN} copy`;
const BUILTIN_BUTTON = /^No-Mistakes Review \(High Rigor\)\s*built-in\b/i;
const INTENT = "Intent Conformance Judge";

async function shoot(target: Page | Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.screenshot({
    path: `${EVIDENCE}${name}.png`,
    ...("mouse" in target ? { fullPage: true } : {}),
  });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/workflow-persona-effort/${name}.png`);
}

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

interface Override { runner: string; model: string; effort?: string }
interface DraftNode { id: string; kind: string; executionOverride?: Override }

async function overrides(daemon: DaemonHandle, workflowId: string): Promise<Override[]> {
  const nodes = (await api<{ workflow: { draft: { nodes: DraftNode[] } } }>(
    daemon,
    `/api/workflows/${workflowId}`,
  )).workflow.draft.nodes;
  return nodes.flatMap((node) => node.executionOverride ? [node.executionOverride] : []);
}

function reviewerRow(page: Page, name: string): Locator {
  return page.locator(".wf-pipeline-strip li.wf-pipeline-reviewer").filter({ hasText: name });
}

test("a workflow node's effort is chosen beside its model, persists, and is frozen on publish", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/workflows`);
  await dashboard.getByRole("button", { name: BUILTIN_BUTTON }).click();
  await dashboard.getByRole("button", { name: "Duplicate", exact: true }).click();
  await expect(dashboard.getByRole("button").filter({ has: dashboard.getByText(COPY, { exact: true }) }))
    .toBeVisible({ timeout: 15_000 });
  const workflowId = (await api<Array<{ id: string; name: string }>>(daemon, "/api/workflows"))
    .find((summary) => summary.name === COPY)!.id;

  const row = reviewerRow(dashboard, INTENT);
  await row.getByRole("button", { name: new RegExp(`^Model routing for ${INTENT}`) }).click();
  const effort = row.getByRole("combobox", { name: `Effort for ${INTENT}` });
  // Inheriting: the Effort control belongs to the override, like the provider and model.
  await expect(effort).toHaveCount(0);
  await row.getByRole("combobox", { name: `Model routing for ${INTENT}` }).selectOption("override");
  await row.getByRole("combobox", { name: `Provider for ${INTENT}` }).selectOption("codex");
  await row.getByRole("combobox", { name: `Model for ${INTENT}` }).selectOption("gpt-5.6-sol");

  // The levels offered are this provider and model's, from the shared capability table:
  // Codex offers `max` on gpt-5.6-sol but not on gpt-5.6-luna.
  await expect(effort).toBeVisible();
  await expect(effort.locator("option", { hasText: /^max$/ })).toHaveCount(1);
  await row.getByRole("combobox", { name: `Model for ${INTENT}` }).selectOption("gpt-5.6-luna");
  await expect(effort.locator("option", { hasText: /^max$/ })).toHaveCount(0);
  await row.getByRole("combobox", { name: `Model for ${INTENT}` }).selectOption("gpt-5.6-sol");
  await effort.selectOption("xhigh");
  await expect(row).toContainText("codex · gpt-5.6-sol · xhigh effort · this workflow");
  await shoot(dashboard, "node-effort");
  await expect
    .poll(() => overrides(daemon, workflowId), { message: "the effort should autosave", timeout: 15_000 })
    .toEqual([{ runner: "codex", model: "gpt-5.6-sol", effort: "xhigh" }]);

  // Reload: what comes back is what the daemon stored.
  await dashboard.reload();
  await dashboard.getByRole("button").filter({ has: dashboard.getByText(COPY, { exact: true }) }).click();
  await expect(reviewerRow(dashboard, INTENT)).toContainText("codex · gpt-5.6-sol · xhigh effort · this workflow");
  await reviewerRow(dashboard, INTENT)
    .getByRole("button", { name: new RegExp(`^Model routing for ${INTENT}`) }).click();
  await expect(reviewerRow(dashboard, INTENT).getByRole("combobox", { name: `Effort for ${INTENT}` }))
    .toHaveValue("xhigh");

  // Publish freezes it with the model, and the published detail reads it back.
  const publish = dashboard.getByRole("button", { name: "Publish" });
  await expect(publish).toBeEnabled({ timeout: 15_000 });
  await publish.click();
  await expect
    .poll(async () => (await api<unknown[]>(daemon, `/api/workflows/${workflowId}/versions`)).length,
      { timeout: 20_000 })
    .toBe(1);
  const version = await api<{ graph: { nodes: DraftNode[] } }>(daemon, `/api/workflows/${workflowId}/versions/1`);
  expect(version.graph.nodes.find((node) => node.executionOverride)!.executionOverride)
    .toEqual({ runner: "codex", model: "gpt-5.6-sol", effort: "xhigh" });
  await dashboard.getByRole("button", { name: /^Version 1/ }).click();
  const entry = dashboard.locator(".workflow-version-detail details.workflow-version-persona")
    .filter({ hasText: INTENT });
  await entry.locator("summary").click();
  const routing = entry.locator(".workflow-version-routing");
  await expect(routing).toContainText("Workflow override · codex · gpt-5.6-sol · xhigh effort");
  await routing.scrollIntoViewIfNeeded();
  await shoot(routing, "published-effort");
});

test("an effort the node's model cannot run stays selected, is flagged, and blocks Publish", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/workflows`);
  await dashboard.getByRole("button", { name: BUILTIN_BUTTON }).click();
  await dashboard.getByRole("button", { name: "Duplicate", exact: true }).click();
  await expect(dashboard.getByRole("button").filter({ has: dashboard.getByText(COPY, { exact: true }) }))
    .toBeVisible({ timeout: 15_000 });
  const workflowId = (await api<Array<{ id: string; name: string }>>(daemon, "/api/workflows"))
    .find((summary) => summary.name === COPY)!.id;

  const row = reviewerRow(dashboard, INTENT);
  await row.getByRole("button", { name: new RegExp(`^Model routing for ${INTENT}`) }).click();
  await row.getByRole("combobox", { name: `Model routing for ${INTENT}` }).selectOption("override");
  await row.getByRole("combobox", { name: `Provider for ${INTENT}` }).selectOption("codex");
  const model = row.getByRole("combobox", { name: `Model for ${INTENT}` });
  const effort = row.getByRole("combobox", { name: `Effort for ${INTENT}` });
  await model.selectOption("gpt-5.6-sol");
  await effort.selectOption("max");
  await expect
    .poll(() => overrides(daemon, workflowId), { timeout: 15_000 })
    .toEqual([{ runner: "codex", model: "gpt-5.6-sol", effort: "max" }]);

  // Now move to a model that has no `max`. The choice is kept and flagged, never dropped.
  await model.selectOption("gpt-5.6-luna");
  await expect(effort).toHaveValue("max");
  await expect(effort.locator("option:checked")).toHaveText("max (unsupported)");
  await expect(row.getByRole("status").filter({ hasText: "do not support max effort" })).toBeVisible();
  // The row's routing line flags it too, rather than reading as a level the node will get.
  await expect(row).toContainText("codex · gpt-5.6-luna · max effort unsupported, provider default · this workflow");
  await expect
    .poll(() => overrides(daemon, workflowId), { message: "the flagged level is saved, not silently cleared", timeout: 15_000 })
    .toEqual([{ runner: "codex", model: "gpt-5.6-luna", effort: "max" }]);

  // And Publish refuses it. The workflow list counts the error, and the Graph view's validation
  // rail names the rule.
  await expect(dashboard.getByRole("button", { name: "Publish" })).toBeDisabled();
  await expect(dashboard.getByRole("button").filter({ has: dashboard.getByText(COPY, { exact: true }) }))
    .toContainText("1 errors");
  await shoot(dashboard, "node-effort-unsupported");
  await dashboard.getByRole("button", { name: "Graph", exact: true }).click();
  const rail = dashboard.getByRole("complementary", { name: "Workflow properties and validation" });
  await expect(rail).toContainText("codex · gpt-5.6-luna does not support max effort.", { timeout: 15_000 });
  await expect(rail.locator("code.workflow-diagnostic-code", { hasText: "unsupported_effort" })).toBeVisible();
  await expect(dashboard.getByRole("button", { name: "Publish" })).toBeDisabled();
  const diagnostic = rail.locator("li").filter({ hasText: "unsupported_effort" });
  await diagnostic.scrollIntoViewIfNeeded();
  await shoot(diagnostic.locator("xpath=.."), "node-effort-unsupported-diagnostic");
  // The publish route refuses it too, so the gate is not only a disabled button.
  const refused = await fetch(`${daemon.baseURL}/api/workflows/${workflowId}/publish`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedDraftRevision: (await api<{ workflow: { draftRevision: number } }>(daemon, `/api/workflows/${workflowId}`)).workflow.draftRevision }),
  });
  expect(refused.ok).toBe(false);
  expect(await refused.text()).toContain("unsupported_effort");
});

test("a Persona's own effort is edited beside its model and survives a save and a reload", async ({
  dashboard,
  daemon,
}) => {
  const persona = await api<{ id: string }>(daemon, "/api/personas", {
    name: "Effort reviewer",
    guidanceMarkdown: "# Effort reviewer\n\nReview the change.",
    runner: "claude",
  });
  await dashboard.goto(`${daemon.baseURL}/#/library/personas/${persona.id}`);
  const chip = dashboard.getByRole("button", { name: /^effort\b/ });
  await expect(chip).toContainText("provider default");
  await chip.click();
  const popover = dashboard.getByRole("group", { name: "Effort override" });
  await popover.getByRole("combobox", { name: "Effort for Effort reviewer" }).selectOption("max");
  await dashboard.keyboard.press("Escape");
  await expect(chip).toContainText("max");
  await dashboard.getByRole("button", { name: "Save" }).click();
  await expect(dashboard.locator("article.persona-editor p.workflow-eyebrow")).toHaveText("Revision 2");

  await dashboard.reload();
  await expect(dashboard.getByRole("button", { name: /^effort\b/ })).toContainText("max");
  const stored = await api<{ effort: string | null; execution: { effort?: { level: string | null } } }>(
    daemon,
    `/api/personas/${persona.id}`,
  );
  expect(stored.effort).toBe("max");
  expect(stored.execution.effort?.level).toBe("max");
  await shoot(dashboard, "persona-effort");

  // A built-in stays read-only: its effort is set per workflow node instead.
  const builtin = (await api<Array<{ name: string; builtin: boolean }>>(daemon, "/api/personas"))
    .find((candidate) => candidate.builtin)!;
  await dashboard.getByRole("complementary", { name: "Persona library" })
    .getByText(builtin.name, { exact: true }).click();
  await expect(dashboard.locator("section.persona-fields").getByLabel("Name")).toHaveValue(builtin.name);
  await dashboard.getByRole("button", { name: /^effort\b/ }).click();
  await expect(dashboard.getByRole("combobox", { name: `Effort for ${builtin.name}` }))
    .toBeDisabled();
});

/**
 * Dispatch a session, bind a published version to it, submit, and wait for the run to finish.
 * Returns the run id and the `codex exec` argv lines the fake recorded.
 */
async function runPublished(
  page: Page,
  daemon: DaemonHandle,
  versionId: string,
  requestId: string,
): Promise<{ runId: string; codexExecs: string[] }> {
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("hold a session for the effort spec");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let sessionId = "";
  await expect
    .poll(async () => {
      const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
      const live = sessions.find((session) => session.state !== "exited");
      sessionId = live?.id ?? "";
      return live?.state ?? "";
    }, { message: "the dispatched session should settle before the workflow is bound" })
    .toBe("idle");

  const binding = await api<{ id: string }>(daemon, "/api/workflow-bindings", {
    workflowVersionId: versionId,
    sessionId,
    deliveryMode: "preview",
  });
  const submitted = await api<{ run: { id: string } }>(
    daemon,
    `/api/workflow-bindings/${binding.id}/submit`,
    { requestId },
  );
  await expect
    .poll(async () => (await api<{ run: { status: string } }>(
      daemon,
      `/api/workflow-runs/${submitted.run.id}`,
    )).run.status, { message: "the reviewer should approve", timeout: 40_000 })
    .toBe("completed");

  const codexDir = join(daemon.recordDir, "codex");
  expect(existsSync(codexDir), "the Codex fake should have been launched").toBeTruthy();
  const codexExecs = readdirSync(codexDir)
    .filter((name) => name.startsWith("invocation-"))
    .map((name) => JSON.parse(readFileSync(join(codexDir, name), "utf8")) as { argv: string[] })
    .map((record) => record.argv.join(" "))
    .filter((argv) => argv.startsWith("exec"));
  return { runId: submitted.run.id, codexExecs };
}

/** A one-reviewer draft whose single Persona node is `node`. */
function oneReviewerDraft(node: Record<string, unknown>) {
  return {
    nodes: [
      { id: "s", kind: "session", position: { x: 0, y: 0 } },
      { id: "r", kind: "persona", position: { x: 220, y: 0 }, ...node },
      { id: "e", kind: "end", outcome: "Approved", position: { x: 440, y: 0 } },
    ],
    edges: [
      { id: "a", source: "s", sourcePort: "submitted", target: "r", targetPort: "activate" },
      { id: "b", source: "r", sourcePort: "pass", target: "e", targetPort: "terminal" },
      { id: "c", source: "r", sourcePort: "fail", target: "s", targetPort: "return_for_changes" },
    ],
  };
}

test("a published node effort is the effort a run launches with and reports beside the model", async ({
  dashboard,
  daemon,
}) => {
  const persona = await api<{ id: string }>(daemon, "/api/personas", {
    name: "E2E effort reviewer",
    guidanceMarkdown: "# E2E effort reviewer\n\nE2E_PASS_VERDICT",
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E effort workflow",
    draft: oneReviewerDraft({
      personaId: persona.id,
      executionOverride: { runner: "codex", model: "gpt-5.6-sol", effort: "xhigh" },
    }),
  });
  const published = await api<{ version: { id: string } }>(
    daemon,
    `/api/workflows/${workflow.workflow.id}/publish`,
    { expectedDraftRevision: 1 },
  );

  const { runId, codexExecs } = await runPublished(dashboard, daemon, published.version.id, "e2e-node-effort");
  expect(codexExecs.some((argv) => argv.includes("model_reasoning_effort=xhigh"))).toBeTruthy();

  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  await expect(dashboard.locator(".wf-pipeline-reviewer").filter({ hasText: "E2E effort reviewer" }))
    .toContainText("codex · gpt-5.6-sol · xhigh effort", { timeout: 15_000 });
  await shoot(dashboard, "run-detail-effort");
});

test("an effort the run's model cannot run is not passed, and run detail says so beside the model", async ({
  dashboard,
  daemon,
}) => {
  // Every write path refuses this combination, so it is seeded the way a capability change or
  // a restored row would leave it: a Persona on gpt-5.6-luna whose stored effort is `max`.
  // Publish freezes it, and the run is what has to notice.
  const persona = await api<{ id: string }>(daemon, "/api/personas", {
    name: "E2E dropped effort reviewer",
    guidanceMarkdown: "# E2E dropped effort reviewer\n\nE2E_PASS_VERDICT",
    runner: "codex",
    model: "gpt-5.6-luna",
  });
  withDaemonDb(daemon, (db) => {
    db.prepare("UPDATE personas SET effort = 'max' WHERE id = ?").run(persona.id);
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E dropped effort workflow",
    draft: oneReviewerDraft({ personaId: persona.id }),
  });
  const published = await api<{ version: { id: string } }>(
    daemon,
    `/api/workflows/${workflow.workflow.id}/publish`,
    { expectedDraftRevision: 1 },
  );
  const version = await api<{ graph: { nodes: Array<{ kind: string; persona?: { effort?: string } }> } }>(
    daemon,
    `/api/workflows/${workflow.workflow.id}/versions/1`,
  );
  expect(version.graph.nodes.find((node) => node.kind === "persona")?.persona?.effort).toBe("max");

  const { runId, codexExecs } = await runPublished(dashboard, daemon, published.version.id, "e2e-dropped-effort");
  expect(codexExecs.some((argv) => argv.includes("gpt-5.6-luna"))).toBeTruthy();
  expect(
    codexExecs.some((argv) => argv.includes("model_reasoning_effort")),
    "an effort the model cannot run must not reach the CLI",
  ).toBe(false);

  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  await expect(dashboard.locator(".wf-pipeline-reviewer").filter({ hasText: "E2E dropped effort reviewer" }))
    .toContainText("codex · gpt-5.6-luna · max effort unsupported, provider default", { timeout: 15_000 });
  await shoot(dashboard, "run-detail-effort-unsupported");
});
