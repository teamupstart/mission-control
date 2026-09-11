import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * Choosing the provider and model for ONE reviewer occurrence, in the editor, and then having
 * that choice be what actually spawns.
 *
 * Only a browser reaches this. `test/workflow-pipeline-editor.test.ts` pins the pure edit,
 * `test/workflow-stages.test.ts` pins the round trip, `test/workflows-http.test.ts` pins the
 * routes and `test/workflow-engine.test.ts` pins the launch against a fake runner - and not
 * one of them can see a `<select>` an operator changes reach `PATCH /api/workflows/:id`,
 * survive Publish as a field separate from the Persona snapshot, come back on reload, and
 * then show up in the argv a CLI was launched with.
 *
 * Four claims:
 *
 * 1. Duplicate on the shipped workflow yields an editable copy whose reviewers can be routed
 *    individually, in either view, with the two views showing the same answer - and moving a
 *    reviewer, reloading, and duplicating again all keep it.
 * 2. The rules an author can get wrong are enforced on screen: a provider change demands a
 *    deliberate model, resetting restores inheritance, changing the Persona resets routing,
 *    and two occurrences of one Persona stay independent.
 * 3. Publishing freezes the override BESIDE the Persona snapshot, an override-only edit
 *    publishes a distinct version that leaves the first one exactly as it was, and the
 *    built-in stays read-only throughout. (A live PERSONA edit failing to reach a published
 *    version is `test/workflow-store.test.ts`' claim: the reviewers here are built-ins, which
 *    cannot be edited at all.)
 * 4. A run of a published override launches the CLI the node named, with the model the node
 *    named, and the run detail reports what actually ran rather than today's default.
 *
 * No model tokens: every reviewer is answered by `e2e/fixtures/fake-agents.ts`, which returns
 * a schema-valid pass for any Persona whose guidance carries `E2E_PASS_VERDICT`.
 */

const EVIDENCE = artifactsDir("workflow-persona-model-overrides");

const BUILTIN = "No-Mistakes Review";
const COPY = `${BUILTIN} copy`;

/**
 * One evidence frame, of the page or of one element.
 *
 * The element form is not a nicety: this app lays out at viewport height with its own
 * internal scrollports, so `fullPage` captures the viewport and nothing more - a panel that
 * has scrolled past the fold is simply absent from the image. Anything asserted below the
 * fold is shot as its own element instead.
 */
async function shoot(target: Page | Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.screenshot({
    path: `${EVIDENCE}${name}.png`,
    ...("mouse" in target ? { fullPage: true } : {}),
  });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/workflow-persona-model-overrides/${name}.png`);
}

async function api<T>(
  daemon: DaemonHandle,
  path: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

interface DraftNode {
  id: string;
  kind: string;
  personaId?: string;
  persona?: { name: string; runner: string | null; model: string | null };
  executionOverride?: { runner: string; model: string };
}

async function draftNodes(daemon: DaemonHandle, workflowId: string): Promise<DraftNode[]> {
  return (await api<{ workflow: { draft: { nodes: DraftNode[] } } }>(
    daemon,
    `/api/workflows/${workflowId}`,
  )).workflow.draft.nodes;
}

/** The workflow the copy landed as, whatever id the create route minted for it. */
async function copyId(daemon: DaemonHandle): Promise<string> {
  const summaries = await api<Array<{ id: string; name: string }>>(daemon, "/api/workflows");
  const copy = summaries.find((summary) => summary.name === COPY);
  expect(copy, `the duplicate should be listed as ${COPY}`).toBeTruthy();
  return copy!.id;
}

/** Open the builder on the shipped workflow and Duplicate it into an editable copy. */
async function duplicateBuiltin(page: Page, daemon: DaemonHandle): Promise<string> {
  await page.goto(`${daemon.baseURL}/#/workflows`);
  await page.getByRole("button", { name: new RegExp(BUILTIN) }).first().click();
  // The shipped workflow is read-only, and its routing is still READABLE: that split is the
  // whole reason Duplicate exists rather than an "unlock" control.
  await expect(page.locator(".wf-state.builtin, .workflow-state.builtin").first())
    .toContainText("Duplicate");
  await page.getByRole("button", { name: "Duplicate", exact: true }).click();
  await expect(page.getByRole("button", { name: new RegExp(COPY) }).first()).toBeVisible({
    timeout: 15_000,
  });
  return await copyId(daemon);
}

/** The Pipeline row for one reviewer, addressed by the name a person reads. */
function reviewerRow(page: Page, name: string) {
  return page.locator(".wf-pipeline-strip li.wf-pipeline-reviewer").filter({ hasText: name });
}

/** Open a reviewer's routing form in the Pipeline view and return its fields. */
async function openRouting(page: Page, name: string) {
  const row = reviewerRow(page, name);
  await row.getByRole("button", { name: new RegExp(`^Model routing for ${name}`) }).click();
  return {
    row,
    mode: row.getByRole("combobox", { name: `Model routing for ${name}` }),
    provider: row.getByRole("combobox", { name: `Provider for ${name}` }),
    model: row.getByRole("combobox", { name: `Model for ${name}` }),
  };
}

test("a duplicated workflow routes one reviewer, and both views agree after a move and a reload", async ({
  dashboard,
  daemon,
}) => {
  const workflowId = await duplicateBuiltin(dashboard, daemon);

  const intent = "Intent Conformance Judge";
  const routing = await openRouting(dashboard, intent);
  // It opens on inheritance, and says so in the reviewer's own row rather than only in a form.
  await expect(routing.mode).toHaveValue("inherit");
  await expect(routing.row).toContainText("Persona default");
  await expect(routing.provider).toHaveCount(0);

  await routing.mode.selectOption("override");
  // Enabling seeds a COMPLETE pair from what the Persona resolves to today, so the choice is
  // already real - an empty form here would be a control that appears to do nothing.
  await expect(routing.provider).toBeVisible();
  await expect(routing.row).toContainText("this workflow");

  await routing.provider.selectOption("codex");
  // A provider change clears the model deliberately, and refuses to write half a pair.
  await expect(routing.model).toHaveValue("");
  await expect(routing.row).toContainText("Choose a model to apply this override");
  await expect
    .poll(async () => (await draftNodes(daemon, workflowId))
      .find((node) => node.executionOverride?.runner === "codex") ?? null,
    { message: "an unfinished pair must never reach the draft" })
    .toBe(null);

  await routing.model.selectOption("gpt-5.6-sol");
  await expect(routing.row).toContainText("codex · gpt-5.6-sol · this workflow");
  await shoot(dashboard, "pipeline-routing");

  const intentNodeId = await expect
    .poll(async () => {
      const node = (await draftNodes(daemon, workflowId))
        .find((candidate) => candidate.executionOverride?.model === "gpt-5.6-sol");
      return node?.id ?? "";
    }, { message: "the complete pair should autosave into the draft", timeout: 15_000 })
    .not.toBe("")
    .then(async () => (await draftNodes(daemon, workflowId))
      .find((candidate) => candidate.executionOverride?.model === "gpt-5.6-sol")!.id);

  // Exactly one node carries it. Every other reviewer still inherits.
  const routed = (await draftNodes(daemon, workflowId)).filter((node) => node.executionOverride);
  expect(routed.map((node) => node.id)).toEqual([intentNodeId]);

  // The Graph view is the same draft drawn differently, so it shows the same answer and edits
  // the same field.
  await dashboard.getByRole("button", { name: "Graph", exact: true }).click();
  const node = dashboard.locator(`.react-flow__node[data-id="${intentNodeId}"]`);
  await expect(node).toContainText("codex · gpt-5.6-sol · this workflow");
  await node.click();
  const rail = dashboard.getByRole("complementary", {
    name: "Workflow properties and validation",
  });
  await expect(rail.getByRole("combobox", { name: `Model routing for ${intent}` }))
    .toHaveValue("override");
  await expect(rail.getByRole("combobox", { name: `Model for ${intent}` }))
    .toHaveValue("gpt-5.6-sol");
  await shoot(dashboard, "graph-routing");

  // Reload the whole dashboard: what comes back is what the daemon stored, not what a
  // component happened to keep.
  await dashboard.reload();
  await dashboard.getByRole("button", { name: new RegExp(COPY) }).first().click();
  await expect(reviewerRow(dashboard, intent)).toContainText("codex · gpt-5.6-sol · this workflow");

  // Moving the reviewer into the stage above carries its choice with it. The compiler rebuilds
  // every route around a move, so this is the edit most likely to drop a node-owned field.
  await reviewerRow(dashboard, intent).click();
  await dashboard.locator('.wf-pipeline-strip [data-focus-key]:focus').press("Alt+ArrowUp");
  await expect(reviewerRow(dashboard, intent)).toContainText("codex · gpt-5.6-sol · this workflow");
  await expect
    .poll(async () => (await draftNodes(daemon, workflowId))
      .filter((candidate) => candidate.executionOverride?.model === "gpt-5.6-sol").length,
    { message: "the move must not drop the node's choice", timeout: 15_000 })
    .toBe(1);

  // Duplicating the copy carries it once more, through the ordinary create route.
  await dashboard.getByRole("button", { name: "Duplicate", exact: true }).click();
  await expect
    .poll(async () => {
      const summaries = await api<Array<{ id: string; name: string }>>(daemon, "/api/workflows");
      const second = summaries.find((summary) => summary.name === `${COPY} copy`);
      if (!second) return -1;
      return (await draftNodes(daemon, second.id))
        .filter((candidate) => candidate.executionOverride?.model === "gpt-5.6-sol").length;
    }, { message: "a duplicate of a routed workflow keeps its routing", timeout: 20_000 })
    .toBe(1);
});

test("resetting, replacing the Persona, and a second occurrence each behave independently", async ({
  dashboard,
  daemon,
}) => {
  const workflowId = await duplicateBuiltin(dashboard, daemon);
  const intent = "Intent Conformance Judge";

  const first = await openRouting(dashboard, intent);
  await first.mode.selectOption("override");
  await first.provider.selectOption("codex");
  await first.model.selectOption("gpt-5.6-sol");
  await expect(first.row).toContainText("codex · gpt-5.6-sol · this workflow");

  // Add a SECOND occurrence of the same Persona, beside the first, and route it differently.
  // `stageMemberKey` falls back to the Persona id, so anything keyed that way would rewrite
  // both from one click - and inside a single stage those two keys are literally equal.
  //
  // `has:` rather than `hasText:` below, because every stage's Add picker lists every Persona
  // as an option, so a text filter matches all four stages instead of the one holding the row.
  const stage = dashboard.locator(".wf-pipeline-strip section.wf-pipeline-stage")
    .filter({ has: dashboard.locator("li.wf-pipeline-reviewer").filter({ hasText: intent }) });
  await stage.getByLabel(/^Add a reviewer or Command to /).selectOption({ label: intent });
  const rows = dashboard.locator(".wf-pipeline-strip li.wf-pipeline-reviewer")
    .filter({ hasText: intent });
  await expect(rows).toHaveCount(2);

  // Each Routing button carries its member's POSITION, so the two occurrences are separable
  // by accessible name rather than only by DOM order. That is the difference between a
  // screen-reader user being able to route the second reviewer and not, and the reason this
  // selects by name here instead of reaching for `rows.nth(1)`. Raised by GitHub Inspector.
  const firstRouting = `Model routing for ${intent}, reviewer 1 of 3 in Stage 2`;
  const secondRouting = `Model routing for ${intent}, reviewer 3 of 3 in Stage 2`;
  await expect(dashboard.getByRole("button", { name: firstRouting })).toHaveCount(1);
  await expect(dashboard.getByRole("button", { name: secondRouting })).toHaveCount(1);

  const second = rows.nth(1);
  await dashboard.getByRole("button", { name: secondRouting }).click();
  await second.getByRole("combobox", { name: `Model routing for ${intent}` })
    .selectOption("override");
  await second.getByRole("combobox", { name: `Provider for ${intent}` }).selectOption("claude");
  await second.getByRole("combobox", { name: `Model for ${intent}` })
    .selectOption("claude-opus-4-8");

  await expect(rows.nth(0)).toContainText("codex · gpt-5.6-sol · this workflow");
  await expect(rows.nth(1)).toContainText("claude · claude-opus-4-8 · this workflow");
  await expect
    .poll(async () => (await draftNodes(daemon, workflowId))
      .flatMap((node) => node.executionOverride ? [node.executionOverride.model] : [])
      .sort(),
    { message: "two occurrences of one Persona keep two choices", timeout: 15_000 })
    .toEqual(["claude-opus-4-8", "gpt-5.6-sol"]);
  await shoot(dashboard, "two-occurrences");

  // Reset the first one. Inheritance comes back, and the second is untouched.
  // One routing form is open at a time - opening the second closed this one - so it is
  // reopened here the way an operator would, from the row's own disclosure.
  await rows.nth(0).getByRole("button", { name: new RegExp(`^Model routing for ${intent}`) })
    .click();
  await rows.nth(0).getByRole("combobox", { name: `Model routing for ${intent}` })
    .selectOption("inherit");
  await expect(rows.nth(0)).toContainText("Persona default");
  await expect(rows.nth(1)).toContainText("claude · claude-opus-4-8 · this workflow");
  await expect
    .poll(async () => (await draftNodes(daemon, workflowId))
      .flatMap((node) => node.executionOverride ? [node.executionOverride.model] : []),
    { message: "clearing must remove the field, not empty it", timeout: 15_000 })
    .toEqual(["claude-opus-4-8"]);

  // Pointing the routed node at a DIFFERENT reviewer resets it. A model chosen for one
  // Persona is not a decision about another one.
  const nodeId = (await draftNodes(daemon, workflowId))
    .find((node) => node.executionOverride)!.id;
  await dashboard.getByRole("button", { name: "Graph", exact: true }).click();
  await dashboard.locator(`.react-flow__node[data-id="${nodeId}"]`).click();
  const rail = dashboard.getByRole("complementary", {
    name: "Workflow properties and validation",
  });
  // By id, from the catalog the daemon actually shipped: a built-in Persona's name comes from
  // its guidance heading, so hard-coding one here would break on a copy edit.
  const others = (await api<Array<{ id: string; name: string }>>(daemon, "/api/personas"))
    .filter((candidate) => candidate.name !== intent);
  expect(others.length, "the built-in catalog should offer another reviewer").toBeGreaterThan(0);
  await rail.getByLabel("Persona").selectOption(others[0]!.id);
  await expect(rail.getByRole("combobox", { name: /^Model routing for / })).toHaveValue("inherit");
  await expect
    .poll(async () => (await draftNodes(daemon, workflowId))
      .filter((node) => node.executionOverride).length,
    { message: "replacing the Persona resets the node to inheritance", timeout: 15_000 })
    .toBe(0);
});

test("publishing freezes the override beside the Persona snapshot, and a later edit cannot move it", async ({
  dashboard,
  daemon,
}) => {
  const workflowId = await duplicateBuiltin(dashboard, daemon);
  const intent = "Intent Conformance Judge";

  const routing = await openRouting(dashboard, intent);
  await routing.mode.selectOption("override");
  await routing.provider.selectOption("codex");
  await routing.model.selectOption("gpt-5.6-sol");
  await expect
    .poll(async () => (await draftNodes(daemon, workflowId))
      .filter((node) => node.executionOverride).length, { timeout: 15_000 })
    .toBe(1);

  const publish = dashboard.getByRole("button", { name: "Publish" });
  await expect(publish).toBeEnabled({ timeout: 15_000 });
  await publish.click();
  await expect
    .poll(async () => (await api<unknown[]>(daemon, `/api/workflows/${workflowId}/versions`)).length,
      { timeout: 20_000 })
    .toBe(1);

  const versionOne = await api<{ graph: { nodes: DraftNode[] } }>(
    daemon,
    `/api/workflows/${workflowId}/versions/1`,
  );
  const frozen = versionOne.graph.nodes.find((node) => node.executionOverride)!;
  expect(frozen.executionOverride).toEqual({ runner: "codex", model: "gpt-5.6-sol" });
  // The snapshot beside it still reports what the PERSONA recommends, which is nothing.
  expect(frozen.persona!.runner).toBe(null);
  expect(frozen.persona!.model).toBe(null);

  // The published detail draws the two facts separately, which is the only way a reader can
  // tell whether editing the Persona would change what runs.
  await dashboard.getByRole("button", { name: /^Version 1/ }).click();
  const detail = dashboard.locator(".workflow-version-detail");
  const entry = detail.locator("details.workflow-version-persona").filter({ hasText: intent });
  // OPENED, not merely present. A closed `<details>` still carries its text, so a
  // `toContainText` on the collapsed entry would pass for lines nobody can read.
  await entry.locator("summary").click();
  const routingLines = entry.locator(".workflow-version-routing");
  await expect(routingLines).toBeVisible();
  await expect(routingLines).toContainText("Persona default · App provider · Provider default");
  await expect(routingLines).toContainText("Workflow override · codex · gpt-5.6-sol");
  // Its OWN frame: the rail is an internal scrollport, so a page shot captures the viewport
  // and would prove nothing about two lines that have scrolled past the fold.
  await routingLines.scrollIntoViewIfNeeded();
  await shoot(routingLines, "published-version");

  // An override-only edit is an ordinary draft edit: it publishes a distinct version and
  // leaves version 1 exactly as it was.
  await routing.model.selectOption("gpt-5.6-terra");
  await expect(publish).toBeEnabled({ timeout: 15_000 });
  await publish.click();
  await expect
    .poll(async () => (await api<unknown[]>(daemon, `/api/workflows/${workflowId}/versions`)).length,
      { timeout: 20_000 })
    .toBe(2);
  const stillOne = await api<{ graph: { nodes: DraftNode[] } }>(
    daemon,
    `/api/workflows/${workflowId}/versions/1`,
  );
  expect(stillOne.graph.nodes.find((node) => node.executionOverride)!.executionOverride)
    .toEqual({ runner: "codex", model: "gpt-5.6-sol" });

  // And the shipped workflow is still read-only, with its routing still readable.
  await dashboard.getByRole("button", { name: new RegExp(BUILTIN) }).first().click();
  await expect(dashboard.getByRole("button", { name: "Publish" })).toBeDisabled();
  const builtinRow = reviewerRow(dashboard, intent);
  await expect(builtinRow).toContainText("Persona default");
  await builtinRow.getByRole("button", { name: new RegExp(`^Model routing for ${intent}`) })
    .click();
  await expect(builtinRow.getByRole("combobox", { name: `Model routing for ${intent}` }))
    .toBeDisabled();
});

test("a published override is the provider and model a run actually launches and reports", async ({
  dashboard,
  daemon,
}) => {
  // A one-reviewer workflow, so the run is short and exactly one CLI launch is attributable.
  const persona = await api<{ id: string }>(daemon, "/api/personas", {
    name: "E2E routed reviewer",
    guidanceMarkdown: "# E2E routed reviewer\n\nE2E_PASS_VERDICT",
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E routed workflow",
    draft: {
      nodes: [
        { id: "s", kind: "session", position: { x: 0, y: 0 } },
        {
          id: "r",
          kind: "persona",
          personaId: persona.id,
          position: { x: 220, y: 0 },
          // Codex, while the app default provider is Claude: a run that ignored the node
          // would launch the wrong binary entirely, which the recorded argv can see.
          executionOverride: { runner: "codex", model: "gpt-5.6-sol" },
        },
        { id: "e", kind: "end", outcome: "Approved", position: { x: 440, y: 0 } },
      ],
      edges: [
        { id: "a", source: "s", sourcePort: "submitted", target: "r", targetPort: "activate" },
        { id: "b", source: "r", sourcePort: "pass", target: "e", targetPort: "terminal" },
        { id: "c", source: "r", sourcePort: "fail", target: "s", targetPort: "return_for_changes" },
      ],
    },
  });
  const published = await api<{ version: { id: string } }>(
    daemon,
    `/api/workflows/${workflow.workflow.id}/publish`,
    { expectedDraftRevision: 1 },
  );

  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?")
    .fill("hold a session for the routed reviewer spec");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
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
    workflowVersionId: published.version.id,
    sessionId,
    deliveryMode: "preview",
  });
  const submitted = await api<{ run: { id: string } }>(
    daemon,
    `/api/workflow-bindings/${binding.id}/submit`,
    { requestId: "e2e-node-routing" },
  );
  await expect
    .poll(async () => (await api<{ run: { status: string } }>(
      daemon,
      `/api/workflow-runs/${submitted.run.id}`,
    )).run.status, { message: "the routed reviewer should approve", timeout: 40_000 })
    .toBe("completed");

  // The argv the fake CLI recorded. This is the claim no other layer can make: the node's
  // model reached a process, on the provider the node named.
  const codexDir = join(daemon.recordDir, "codex");
  expect(existsSync(codexDir), "the Codex fake should have been launched").toBeTruthy();
  const invocations = readdirSync(codexDir)
    .filter((name) => name.startsWith("invocation-"))
    .map((name) => JSON.parse(readFileSync(join(codexDir, name), "utf8")) as { argv: string[] })
    .map((record) => record.argv.join(" "))
    .filter((argv) => argv.startsWith("exec"));
  expect(invocations.length, "the reviewer should have run through Codex").toBeGreaterThan(0);
  expect(invocations.some((argv) => argv.includes("gpt-5.6-sol"))).toBeTruthy();

  // And the run detail reports what RAN, off the attempt row rather than off today's catalog.
  await dashboard.goto(`${daemon.baseURL}/#/runs/${submitted.run.id}`);
  await expect(dashboard.locator(".wf-pipeline-reviewer").filter({ hasText: "E2E routed reviewer" }))
    .toContainText("codex · gpt-5.6-sol", { timeout: 15_000 });
  await shoot(dashboard, "run-detail");
});
