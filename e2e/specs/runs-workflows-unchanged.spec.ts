import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import {
  seedConductorDaemon,
  seedConductorRun,
  writeConductorProjects,
} from "../fixtures/conductor.ts";

/**
 * The Workflows tab is today's Runs page, with the conductor integration switched ON.
 *
 * This is the regression spec the approved plan asks for, and its subject is an ABSENCE:
 * adding a second surface to this page must change nothing about the first one. That is a
 * claim no unit test can make - the shapes it would assert are the ones a refactor moves -
 * and no diff review can make either, because the failure mode is a shared class name, a
 * shared route or a shared piece of state quietly acquiring a second caller.
 *
 * So it drives the real thing: a real dispatched session, a real published workflow, a real
 * review round, and then reads the page a person lands on - with a pipeline provider enabled
 * and two fixture pipelines projected underneath, which is the configuration the rest of this
 * work exists to serve and the only one in which the regression could happen.
 *
 * What it pins, in the order a reader meets it:
 *
 *  - the rail: its state filter chips, its filter form, and a run row naming its workflow;
 *  - the reader: the run header, the horizontal strip drawn on the pipeline the run was
 *    authored on, the round scrubber, and the Review worklist below it;
 *  - `#/runs/:id` still resolving to that run, because every kept link and every notification
 *    in the product points at one.
 *
 * No model tokens: the reviewer is answered by `e2e/fixtures/fake-claude.mjs` through the
 * `E2E_PASS_VERDICT` marker its guidance carries, and the engine is the fake `conduct-ts`
 * that `e2e/fixtures/conductor.ts` installs.
 */

// The fastest pipeline watch cadence the daemon allows, so the fixture runs are projected
// while this spec is still looking - the integration being genuinely ON is the whole
// premise of the assertions below.
test.use({ daemonEnv: { MISSION_PIPELINE_TICK_MS: "1000" } });

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

/** Dispatch one agent from the modal - the sanctioned way to get a live, bindable session. */
async function dispatch(page: Page, daemon: DaemonHandle): Promise<string> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // The repo combobox portals its listbox over the fields below, so close it before filling
  // the next one. Its handler stops propagation, so this closes the list, not the modal.
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?")
    .fill("hold a session for the workflows-unchanged regression");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let sessionId = "";
  await expect.poll(async () => {
    const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
    const live = sessions.find((session) => session.state !== "exited");
    sessionId = live?.id ?? "";
    return live?.state ?? "";
  }, { message: "the dispatched session should settle before the workflow is bound" }).toBe("idle");
  return sessionId;
}

/** One single-reviewer run that passes, built through the routes the dashboard itself uses. */
async function seedRun(page: Page, daemon: DaemonHandle): Promise<string> {
  const sessionId = await dispatch(page, daemon);
  const persona = await api<{ id: string }>(daemon, "/api/personas", {
    name: "Unchanged reviewer",
    guidanceMarkdown: "# Unchanged reviewer\n\nE2E_PASS_VERDICT",
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E workflows unchanged",
    draft: {
      nodes: [
        { id: "session", kind: "session", position: { x: 0, y: 0 } },
        { id: "reviewer", kind: "persona", personaId: persona.id, position: { x: 220, y: 0 } },
        { id: "end", kind: "end", outcome: "Approved", position: { x: 440, y: 0 } },
      ],
      edges: [
        { id: "submit", source: "session", sourcePort: "submitted", target: "reviewer", targetPort: "activate" },
        { id: "pass", source: "reviewer", sourcePort: "pass", target: "end", targetPort: "terminal" },
        { id: "fail", source: "reviewer", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
      ],
    },
  });
  const published = await api<{ version: { id: string } }>(
    daemon,
    `/api/workflows/${workflow.workflow.id}/publish`,
    { expectedDraftRevision: 1 },
  );
  const binding = await api<{ id: string }>(daemon, "/api/workflow-bindings", {
    workflowVersionId: published.version.id,
    sessionId,
    deliveryMode: "preview",
  });
  const submitted = await api<{ run: { id: string } }>(
    daemon,
    `/api/workflow-bindings/${binding.id}/submit`,
    { requestId: "e2e-workflows-unchanged" },
  );
  try {
    await expect.poll(async () =>
      (await api<{ run: { status: string } }>(
        daemon,
        `/api/workflow-runs/${submitted.run.id}`,
      )).run.status,
    { message: "round 1 should settle completed", timeout: 40_000 }).toBe("completed");
  } catch (caught) {
    // The seeding failure that matters here is server-side and invisible to a browser trace.
    // eslint-disable-next-line no-console
    console.log(`DAEMON LOG TAIL:\n${daemon.readLog().split("\n").slice(-60).join("\n")}`);
    throw caught;
  }
  return submitted.run.id;
}

/**
 * Switch the integration on and put two features in flight, one of them halted.
 *
 * Written through the daemon's own consent route rather than into its database, so what the
 * page renders is downstream of exactly the act an operator performs in Settings.
 */
async function observePipelines(daemon: DaemonHandle): Promise<void> {
  writeConductorProjects(daemon.home, [{ name: "demo-repo", path: daemon.repo }]);
  seedConductorRun(daemon.repo, "add-widgets", {
    steps: { worktree: "done", memory: "done", explore: "in_progress" },
    lastStep: "explore",
    tier: "M",
    track: "product",
  });
  seedConductorRun(daemon.repo, "fix-the-thing", {
    steps: { worktree: "done", build: "done" },
    lastStep: "build",
    halt: "the build review found two blocking defects",
    haltClass: "needs-human",
  });
  seedConductorDaemon(daemon.repo, { pid: process.pid });

  const response = await fetch(`${daemon.baseURL}/api/pipelines/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      enabled: true,
      repos: [{ provider: "ai-conductor", repoRoot: daemon.repo, enabled: true }],
    }),
  });
  expect(response.ok, "the consent route should accept the seeded repository").toBeTruthy();

  await expect.poll(
    async () => {
      const view = await api<{ status: { runs: number }[] }>(daemon, "/api/pipelines/config");
      return view.status[0]?.runs ?? 0;
    },
    { message: "both fixture features should be projected before the page is read", timeout: 15_000 },
  ).toBe(2);
}

test("the Workflows tab renders today's rail and reader with pipelines enabled beside it", async ({
  dashboard,
  daemon,
}) => {
  const runId = await seedRun(dashboard, daemon);
  await observePipelines(daemon);

  await dashboard.goto(`${daemon.baseURL}/#/runs`);

  // The one addition to this page, and the proof that the assertions below are made in the
  // configuration where a regression could happen rather than in the shipped-off one.
  const workflowsTab = dashboard.getByRole("tab", { name: /Workflows/ });
  await expect(workflowsTab).toBeVisible();
  await expect(workflowsTab).toHaveAttribute("aria-selected", "true");
  await expect(dashboard.getByRole("tab", { name: /Pipelines/ })).toBeVisible();

  // The page still says what it is.
  await expect(dashboard.getByRole("heading", { name: "Workflow runs", exact: true }))
    .toBeVisible();
  await expect(dashboard.getByRole("button", { name: /Workflow settings/ })).toBeVisible();

  // The rail: its state filters, its filter form, and the run itself.
  await expect(dashboard.getByRole("group", { name: "Filter runs by state" })).toBeVisible();
  await expect(dashboard.getByRole("button", { name: "Running" })).toBeVisible();
  await expect(dashboard.getByRole("button", { name: "Completed" })).toBeVisible();
  // Named by the row's own text, which is what a screen reader announces: the workflow, its
  // version, its state, the session it reviewed and the repository it ran in.
  const row = dashboard.getByRole("button", { name: /E2E workflows unchanged v1 Completed/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText("demo-repo");

  // And nothing from the other surface has leaked into it.
  await expect(dashboard.getByRole("heading", { name: "Gate verdicts" })).toHaveCount(0);
  await expect(dashboard.getByText("add-widgets")).toHaveCount(0);

  // The reader, reached the way every kept link and every notification reaches it.
  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  await expect(dashboard.getByRole("tab", { name: /Workflows/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  // The header, the horizontal strip on the pipeline the run was authored on, and the
  // reviewer inside it - each named as a person reads them.
  await expect(dashboard.getByRole("heading", { name: "E2E workflows unchanged" })).toBeVisible();
  const strip = dashboard.getByRole("group", { name: "Workflow run pipeline" });
  await expect(strip).toBeVisible();
  await expect(strip.getByText("Session", { exact: true })).toBeVisible();
  // The reviewer's own row inside the stage, rather than the stage heading that shares its
  // name - a single-member stage is named after its member.
  await expect(strip.getByRole("listitem").filter({ hasText: "Unchanged reviewer" }))
    .toBeVisible();
  await expect(strip.getByText("Approved", { exact: true })).toBeVisible();
  await expect(strip.getByText("submitted")).toBeVisible();

  // The round scrubber, and the worklist that replaced the verdicts wall.
  await expect(dashboard.getByRole("group", { name: "Select a round" })).toBeVisible();
  await expect(dashboard.getByRole("button", { name: /Round 1/ })).toBeVisible();
  await expect(dashboard.getByRole("heading", { name: "Review worklist" })).toBeVisible();
  const segments = dashboard.getByRole("group", { name: "Worklist segment" });
  await expect(segments.getByRole("button", { name: /^Blocking/ })).toBeVisible();
  await expect(segments.getByRole("button", { name: /^Passed/ })).toBeVisible();
  await expect(segments.getByRole("button", { name: /^Archive/ })).toBeVisible();

  // Still the workflow reader, with none of the pipelines surface in it.
  await expect(dashboard.getByRole("group", { name: /^Pipeline for/ })).toHaveCount(0);
  await expect(dashboard.getByRole("heading", { name: "Attempts" })).toHaveCount(0);
});

test.describe("with no repository observed", () => {
  test("the Runs page is the one that shipped before pipelines existed", async ({
    dashboard,
    daemon,
  }) => {
    // The other half of the claim, and the one that covers every operator who will never
    // enable this: with nothing consented to, the page grows no chrome AND asks the daemon
    // nothing about pipelines. The tab is what starts the surface's reads, so its absence is
    // the mechanism rather than a decoration on top of one.
    const reads: string[] = [];
    dashboard.on("request", (req) => {
      if (req.url().includes("/api/pipelines/")) reads.push(req.url());
    });

    await dashboard.goto(`${daemon.baseURL}/#/runs`);
    await expect(dashboard.getByRole("heading", { name: "Workflow runs", exact: true }))
      .toBeVisible();
    // This daemon has run no workflow, so the page it shows is its own zero state - and the
    // claim is that nothing about that gained a tab strip.
    await expect(dashboard.getByRole("heading", { name: "No workflow runs yet" })).toBeVisible();
    await expect(dashboard.getByRole("tab", { name: /Pipelines/ })).toHaveCount(0);
    await expect(dashboard.getByRole("tab", { name: /Workflows/ })).toHaveCount(0);

    // A kept link into the surface finds the page it always found rather than an empty pane.
    await dashboard.goto(`${daemon.baseURL}/#/runs/pipeline`);
    await expect(dashboard.getByRole("heading", { name: "No workflow runs yet" })).toBeVisible();
    await expect(dashboard.getByRole("tab", { name: /Pipelines/ })).toHaveCount(0);

    // Longer than one turn of the surface's own 4s poll, so this is "it never started"
    // rather than "it had not got round to it yet".
    await dashboard.waitForTimeout(5000);
    expect(reads, "a Runs page with nothing observed must not read the pipelines routes")
      .toEqual([]);
  });
});
