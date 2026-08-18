import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The Library detail footer through the real summary, SSE and router paths.
 *
 * The first three checks are authoring truths: a built-in reference opens its workflow, an
 * unused Persona says so, and an Action names its draft workflow. The last is the runtime
 * boundary no render test can reach: a preview run parks on the exact Action, the footer gains
 * its live mark, and a cancel upsert removes that mark without reloading the detail screen.
 */

const EVIDENCE = artifactsDir("library-asset-usage");

interface PersonaRow {
  id: string;
  name: string;
  builtin: boolean;
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
  return await response.json() as T;
}

const footer = (page: Page): Locator => page.locator("footer.lib-asset-usage");

async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
  await footer(page).screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/library-asset-usage/${name}.png`);
}

async function createPersona(daemon: DaemonHandle, name: string): Promise<string> {
  const persona = await api<{ id: string }>(daemon, "/api/personas", {
    name,
    guidanceMarkdown: `# ${name}\n\nJudge the change.\n`,
  });
  return persona.id;
}

async function createAction(daemon: DaemonHandle, name: string): Promise<string> {
  const action = await api<{ id: string }>(daemon, "/api/session-actions", {
    name,
    promptMarkdown: `# ${name}\n\nHold here for the usage spec.\n`,
    completion: { kind: "session_turn" },
  });
  return action.id;
}

async function createActionWorkflow(
  daemon: DaemonHandle,
  actionId: string,
  name: string,
): Promise<{ id: string; revision: number }> {
  const created = await api<{ workflow: { id: string; draftRevision: number } }>(
    daemon,
    "/api/workflows",
    {
      name,
      draft: {
        nodes: [
          { id: "session", kind: "session", position: { x: 0, y: 0 } },
          { id: "action", kind: "session_action", sessionActionId: actionId, position: { x: 240, y: 0 } },
          { id: "end", kind: "end", outcome: "Complete", position: { x: 480, y: 0 } },
        ],
        edges: [
          { id: "start", source: "session", sourcePort: "submitted", target: "action", targetPort: "activate" },
          { id: "done", source: "action", sourcePort: "complete", target: "end", targetPort: "terminal" },
        ],
      },
    },
  );
  return { id: created.workflow.id, revision: created.workflow.draftRevision };
}

/** Dispatch a fake-backed session and wait until its opening turn has settled. */
async function dispatch(page: Page, daemon: DaemonHandle): Promise<string> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?")
    .fill("hold a session for the Library asset usage spec");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let sessionId = "";
  await expect.poll(async () => {
    const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
    const session = sessions.find((candidate) => candidate.state !== "exited");
    sessionId = session?.id ?? "";
    return session?.state ?? "";
  }).toBe("idle");
  return sessionId;
}

test("a built-in Persona names and opens its built-in workflow", async ({ dashboard, daemon }) => {
  const personas = await api<PersonaRow[]>(daemon, "/api/personas");
  const builtIn = personas.find((persona) => persona.builtin && persona.name === "Code Risk Reviewer")
    ?? personas.find((persona) => persona.builtin);
  expect(builtIn, "this build ships no built-in Persona").toBeTruthy();

  await dashboard.goto(`${daemon.baseURL}/#/library/personas/${builtIn!.id}`);
  await expect(footer(dashboard).getByRole("heading", { name: "Used by" })).toBeVisible();
  const workflow = footer(dashboard).getByRole("link", { name: "No-Mistakes Review" });
  await expect(workflow).toBeVisible();
  await expect(footer(dashboard).getByLabel("Reference graphs")).toContainText("Published");
  await shoot(dashboard, "01-populated");

  await workflow.click();
  await expect.poll(() => dashboard.evaluate(() => location.hash))
    .toMatch(/^#\/library\/workflows\//);
  await expect(dashboard.locator(".workflow-builder-toolbar")
    .getByRole("heading", { name: "No-Mistakes Review" })).toBeVisible();
});

test("a Persona referenced by nothing shows the empty answer", async ({ dashboard, daemon }) => {
  const personaId = await createPersona(daemon, "Unused reviewer");
  await dashboard.goto(`${daemon.baseURL}/#/library/personas/${personaId}`);
  await expect(footer(dashboard)).toContainText("No workflows use this Persona.");
  await expect(footer(dashboard).getByRole("link")).toHaveCount(0);
  await shoot(dashboard, "02-empty");
});

test("an Action names the draft workflow that references it", async ({ dashboard, daemon }) => {
  const actionId = await createAction(daemon, "Usage action");
  await createActionWorkflow(daemon, actionId, "Action draft user");
  await dashboard.goto(`${daemon.baseURL}/#/library/actions/${actionId}`);

  const workflow = footer(dashboard).getByRole("link", { name: "Action draft user" });
  await expect(workflow).toBeVisible();
  await expect(footer(dashboard).getByLabel("Reference graphs")).toHaveText("Draft");
});

test("live Action gating retires from the footer through SSE without a reload", async ({
  dashboard,
  daemon,
}) => {
  const sessionId = await dispatch(dashboard, daemon);
  const actionId = await createAction(daemon, "Live usage action");
  const workflow = await createActionWorkflow(daemon, actionId, "Live action workflow");
  const published = await api<{ version: { id: string } }>(
    daemon,
    `/api/workflows/${workflow.id}/publish`,
    { expectedDraftRevision: workflow.revision },
  );
  const binding = await api<{ id: string }>(daemon, "/api/workflow-bindings", {
    workflowVersionId: published.version.id,
    sessionId,
    deliveryMode: "preview",
  });
  const submitted = await api<{ run: { id: string } }>(
    daemon,
    `/api/workflow-bindings/${binding.id}/submit`,
    { requestId: "library-usage-live" },
  );
  await expect.poll(async () => (
    await api<{ run: { status: string } }>(daemon, `/api/workflow-runs/${submitted.run.id}`)
  ).run.status, { timeout: 60_000 }).toBe("waiting_for_action");

  await dashboard.goto(`${daemon.baseURL}/#/library/actions/${actionId}`);
  const live = footer(dashboard).getByText("1 run is gating now", { exact: true });
  await expect(live).toBeVisible();
  await expect(footer(dashboard).getByRole("link", { name: "1 run gating now" }))
    .toHaveAttribute("href", `#/runs/${submitted.run.id}`);
  await shoot(dashboard, "03-live");

  // This request produces the ordinary `workflow_run_upsert`; the page is deliberately left
  // mounted so the disappearance below proves the live stream path rather than a reload.
  await api(
    daemon,
    `/api/workflow-runs/${submitted.run.id}/cancel`,
    { requestId: "library-usage-cancel" },
  );
  await expect(live).toHaveCount(0);
  await expect(footer(dashboard)).toContainText("Live action workflow");
});
