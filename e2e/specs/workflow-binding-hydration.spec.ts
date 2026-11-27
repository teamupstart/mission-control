import { mkdirSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * When the bind dialog's Trigger, Delivery and repair-round controls take their values from a
 * binding, as an operator meets it.
 *
 * The rule the hydration effect keeps: the controls are seeded when the binding the dialog is
 * on changes IDENTITY - another session, another binding - and read that binding's values; a
 * REVISION of the binding already open never re-seeds them, so nothing the dialog learns about
 * that binding while it is open can rewrite what the operator is looking at or has edited.
 *
 * Both halves fail against the obvious regressions. Drop the trigger and switching sessions
 * leaves the first binding's values on the second session. Key it on every revision and the
 * untouched Delivery control below flips to the revised value the moment the dialog's own save
 * returns it.
 *
 * Everything is real except two replies. The sessions are dispatched fixture agents, the
 * workflow is published, and both bindings are created through the public route. The dialog
 * only learns of a revision through its own PATCH, so the revision is made there: the PATCH goes
 * to the daemon carrying Delivery `preview` instead of the dialog's `live` - the daemon stores
 * it and answers with it, a real revision of the same binding with an untouched field changed -
 * and the submit that follows is refused, which keeps the dialog open on that revision. No model
 * tokens: the workflow has no reviewer, and no run is ever started.
 */

const WORKFLOW = "E2E binding hydration";
const EVIDENCE = artifactsDir("workflow-binding-hydration");

/** Gated behind `MC_E2E_EVIDENCE`: the rendered state the assertions beside it just passed on. */
async function capture(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer.
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  console.log(`CAPTURED e2e/.artifacts/workflow-binding-hydration/${name}.png`);
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

/** Dispatch one fixture agent with no workflow armed, and return the new session once idle. */
async function dispatchIdleAgent(page: Page, daemon: DaemonHandle, goal: string): Promise<string> {
  const before = new Set((await api<Array<{ id: string }>>(daemon, "/api/sessions")).map((s) => s.id));
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(goal);
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let sessionId = "";
  await expect.poll(async () => {
    const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
    const fresh = sessions.find((session) => !before.has(session.id) && session.state !== "exited");
    sessionId = fresh?.id ?? "";
    return fresh?.state ?? "";
  }, { message: `the session for "${goal}" should settle`, timeout: 60_000 }).toBe("idle");
  return sessionId;
}

/** A selected `<select>`'s value, read off the DOM: a collapsed select renders no option text. */
const valueOf = (select: Locator): Promise<string> => select.inputValue();

test("the bind dialog seeds its controls from each binding it opens, and never from a revision of the open one", async ({
  dashboard,
  daemon,
}) => {
  // Live delivery needs live workflows on and the repository allowlisted.
  await api(daemon, "/api/workflows/config", { liveEnabled: true, repoAllowlist: [daemon.repo] }, "PUT");
  const liveSession = await dispatchIdleAgent(dashboard, daemon, "hold a live binding for the hydration spec");
  const previewSession = await dispatchIdleAgent(dashboard, daemon, "hold a preview binding for the hydration spec");

  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: WORKFLOW,
    draft: {
      nodes: [
        { id: "session", kind: "session", position: { x: 0, y: 0 } },
        { id: "end", kind: "end", outcome: "Approved", position: { x: 220, y: 0 } },
      ],
      edges: [
        { id: "done", source: "session", sourcePort: "submitted", target: "end", targetPort: "terminal" },
      ],
    },
  });
  const published = await api<{ version: { id: string } }>(
    daemon,
    `/api/workflows/${workflow.workflow.id}/publish`,
    { expectedDraftRevision: 1 },
  );
  const liveBinding = await api<{ id: string }>(daemon, "/api/workflow-bindings", {
    workflowVersionId: published.version.id,
    sessionId: liveSession,
    triggerMode: "manual",
    deliveryMode: "live",
    maxRepairRounds: 2,
  });
  await api(daemon, "/api/workflow-bindings", {
    workflowVersionId: published.version.id,
    sessionId: previewSession,
    triggerMode: "manual",
    deliveryMode: "preview",
    maxRepairRounds: 7,
  });

  // Unpinned, from the palette, so the dialog's own Session control decides which binding is open.
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await dashboard.keyboard.press("Meta+k");
  await dashboard.getByRole("combobox", { name: "Search everything" }).fill("bind a workflow");
  await dashboard.getByRole("option", { name: /Bind a workflow to a session…, command/ }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Bind workflow" });
  await expect(dialog).toBeVisible();
  const session = dialog.getByRole("combobox", { name: "Session", exact: true });
  const version = dialog.getByRole("combobox", { name: "Published workflow" });
  const delivery = dialog.getByRole("combobox", { name: "Delivery" });
  const rounds = dialog.getByRole("spinbutton", { name: "Maximum repair rounds" });

  // Identity changes seed the controls from the binding now open, each time.
  await session.selectOption(liveSession);
  await expect(version).toHaveValue(published.version.id);
  await expect.poll(() => valueOf(delivery)).toBe("live");
  await expect(rounds).toHaveValue("2");

  await session.selectOption(previewSession);
  await expect(version).toHaveValue(published.version.id);
  await expect.poll(() => valueOf(delivery)).toBe("preview");
  await expect(rounds).toHaveValue("7");
  await capture(dashboard, "bind-dialog-after-switching-session");

  await session.selectOption(liveSession);
  await expect.poll(() => valueOf(delivery)).toBe("live");
  await expect(rounds).toHaveValue("2");

  // Now revise the open binding. The operator edits the rounds and leaves Delivery alone; the
  // dialog's save PATCHes the binding, and the daemon's answer carries Delivery `preview`.
  await rounds.fill("4");
  let patched = false;
  await dashboard.route(
    (url) => url.pathname === `/api/workflow-bindings/${liveBinding.id}`,
    async (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
      expect(body, "the dialog sends the operator's edit and the Delivery it shows").toMatchObject({
        maxRepairRounds: 4,
        deliveryMode: "live",
      });
      patched = true;
      await route.continue({ postData: JSON.stringify({ ...body, deliveryMode: "preview" }) });
    },
  );
  await dashboard.route(
    (url) => url.pathname === `/api/workflow-bindings/${liveBinding.id}/submit`,
    (route) => route.fulfill({ status: 409, json: { error: "Held open by the hydration spec." } }),
  );
  const revision = dashboard.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/workflow-bindings/${liveBinding.id}`
      && response.request().method() === "PATCH",
  );
  await dialog.getByRole("button", { name: "Submit bound version" }).click();
  const revised = (await (await revision).json()) as { id: string; deliveryMode: string; maxRepairRounds: number };
  expect(patched).toBe(true);
  // A real revision of the SAME binding, with an untouched field changed.
  expect(revised).toMatchObject({ id: liveBinding.id, deliveryMode: "preview", maxRepairRounds: 4 });
  await expect(dialog.getByRole("alert")).toContainText("Held open by the hydration spec.");

  // The dialog stays on the same binding, and the revision re-seeds nothing: the edited rounds
  // keep the operator's value, and the untouched Delivery keeps what it showed.
  await expect(dialog).toBeVisible();
  await expect(session).toHaveValue(liveSession);
  await expect(version).toHaveValue(published.version.id);
  await expect(rounds).toHaveValue("4");
  await dashboard.waitForTimeout(500);
  expect(await valueOf(delivery)).toBe("live");
  await expect(dialog.getByRole("button", { name: "Submit bound version" })).toBeVisible();
  // Back up to the controls the claim is about, with the refusal still on screen below them.
  await delivery.scrollIntoViewIfNeeded();
  await capture(dashboard, "bind-dialog-after-same-binding-revision");

  // And a new IDENTITY still seeds: away to the other binding and back reads the stored values,
  // the revision included, because that is now what this binding holds.
  await session.selectOption(previewSession);
  await expect.poll(() => valueOf(delivery)).toBe("preview");
  await expect(rounds).toHaveValue("7");
  await session.selectOption(liveSession);
  await expect.poll(() => valueOf(delivery)).toBe("preview");
  await expect(rounds).toHaveValue("4");
});
