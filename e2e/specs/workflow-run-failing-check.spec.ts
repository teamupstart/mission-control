import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * A failed command gate is a blocker, and it keeps everything a person needs from it.
 *
 * This is the case the first draft of the Blocker Worklist dropped entirely. A check is not a
 * requested change and never will be - a row keyed on a title cannot carry an exit code or an
 * output tail - so a redesign that routed checks to "Passed" left a red gate with no segment at
 * all, and a run stopped only by a failing command would have presented as having nothing
 * outstanding. `checkOutcomeOf` is therefore asked first and its own status picks the segment.
 *
 * `e2e/specs/workflow-skipped-status.spec.ts` drives the OTHER half of this - a slot with no
 * command configured, which is a degraded pass - and asserts against the pipeline strip, which
 * this redesign does not touch. Neither spec covers the other.
 *
 * No model tokens: the Persona is answered by the fake agent, and the Command is `sh`.
 */

const NODE = { session: "session-node", check: "check-node", persona: "persona-node", end: "end-node" };
const REVIEWER = "E2E agreeable reviewer";

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

async function dispatch(page: Page, daemon: DaemonHandle): Promise<string> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?")
    .fill("hold a session for the failing check spec");
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
    }, { message: "the dispatched session should settle before evidence capture" })
    .toBe("idle");
  return sessionId;
}

/**
 * A run whose `test` Command really runs and really exits non-zero, with every Persona passing.
 *
 * The Persona is on the graph deliberately: a run blocked ONLY by a failing check is the
 * degenerate case, and it has to open on `Blocking` with that check selected rather than on a
 * rail full of approvals.
 */
async function seedFailingCheckRun(page: Page, daemon: DaemonHandle): Promise<string> {
  const sessionId = await dispatch(page, daemon);

  // Commands are off by default and allowlisted per repository, so both switches are thrown
  // through the route the settings panel writes rather than by seeding a row.
  await api(daemon, "/api/workflows/config", {
    liveEnabled: true,
    checksEnabled: true,
    repoAllowlist: [daemon.repo],
    defaultWorkflowId: null,
    checkCommands: [{
      repoRoot: daemon.repo,
      slot: "test",
      // `shell: false`, so `sh` is simply the executable being spawned. The stderr line is
      // what the retained output tail has to carry back to the pane.
      command: ["sh", "-c", "echo 'E2E CHECK BOOM' 1>&2; exit 3"],
    }],
  }, "PUT");

  const persona = await api<{ id: string }>(daemon, "/api/personas", {
    name: REVIEWER,
    guidanceMarkdown: `# ${REVIEWER}\n\nE2E_PASS_VERDICT`,
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E failing check",
    draft: {
      nodes: [
        { id: NODE.session, kind: "session", position: { x: 0, y: 0 } },
        { id: NODE.check, kind: "check", slot: "test", position: { x: 220, y: 0 } },
        { id: NODE.persona, kind: "persona", personaId: persona.id, position: { x: 220, y: 140 } },
        { id: NODE.end, kind: "end", outcome: "Approved", position: { x: 440, y: 70 } },
      ],
      edges: [
        { id: "e-check", source: NODE.session, sourcePort: "submitted", target: NODE.check, targetPort: "activate" },
        { id: "e-persona", source: NODE.session, sourcePort: "submitted", target: NODE.persona, targetPort: "activate" },
        { id: "e-check-pass", source: NODE.check, sourcePort: "pass", target: NODE.end, targetPort: "terminal" },
        { id: "e-check-fail", source: NODE.check, sourcePort: "fail", target: NODE.session, targetPort: "return_for_changes" },
        { id: "e-persona-pass", source: NODE.persona, sourcePort: "pass", target: NODE.end, targetPort: "terminal" },
        { id: "e-persona-fail", source: NODE.persona, sourcePort: "fail", target: NODE.session, targetPort: "return_for_changes" },
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
    { requestId: "e2e-failing-check" },
  );
  const runId = submitted.run.id;

  // The outcome the redesign has to route, read off the durable attempt rather than the screen,
  // so a UI miss below is never mistaken for the command not having failed.
  try {
    await expect
      .poll(async () => {
        const run = await api<{
          attempts: Array<{ nodeId: string; output: unknown }>;
        }>(daemon, `/api/workflow-runs/${runId}`);
        const check = run.attempts.find((attempt) => attempt.nodeId === NODE.check);
        const output = check?.output as { status?: string; exitCode?: number } | null | undefined;
        return output?.status ?? "";
      }, { message: "the configured command should run and exit non-zero", timeout: 60_000 })
      .toBe("failed");
  } catch (caught) {
    // eslint-disable-next-line no-console
    console.log(`DAEMON LOG TAIL:\n${daemon.readLog().split("\n").slice(-60).join("\n")}`);
    throw caught;
  }
  return runId;
}

/** The widget, not the section: the join and gate packets below it print raw verdict JSON. */
const worklistOf = (page: Page): Locator =>
  page.locator("section.wf-run-section")
    .filter({ has: page.getByRole("heading", { name: "Review worklist" }) })
    .locator(".wf-run-worklist");

test("a failed command gate is the blocker, and keeps its exit code and output", async ({
  dashboard,
  daemon,
}) => {
  const runId = await seedFailingCheckRun(dashboard, daemon);
  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  const worklist = worklistOf(dashboard);
  await expect(worklist).toBeVisible({ timeout: 40_000 });

  // Every Persona on this graph approved, so the only thing the run is stopped by is the
  // command - and the rail opens on it rather than on a page of approvals.
  const segments = worklist.getByRole("group", { name: "Worklist segment" });
  await expect(segments.getByRole("button", { name: "Blocking 1" })).toHaveAttribute(
    "aria-pressed",
    "true",
    { timeout: 40_000 },
  );
  await expect(worklist).not.toContainText("nothing outstanding");

  const row = worklist.locator("button.wf-run-worklist-row.is-check");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Command · test");
  await expect(row).toContainText("exit 3");
  await expect(row.locator(".workflow-chip")).toHaveText("Failed");
  // The chip and the left accent are read from the same outcome, so a red gate cannot draw
  // itself green - and a Command that never ran cannot draw itself red. The degraded half of
  // that pair is pinned in `test/workflow-runs-render.test.ts`, which can build one directly.
  await expect(row).toHaveClass(/is-tone-failed/);

  // The whole card the old section rendered, unchanged: the command, the sentence behind the
  // status, and the retained tail of what it printed.
  const card = worklist.locator("article.wf-run-check");
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("The configured command ran and exited non-zero");
  await expect(card.locator("pre.wf-run-check-output")).toContainText("E2E CHECK BOOM");
  await expect(card).toContainText("exit 3");

  // A command gate has no reviewer to give feedback to and no reviewer to switch off, so those
  // controls are absent rather than rendered dead.
  await expect(worklist.getByRole("button", { name: "Give this reviewer feedback" })).toHaveCount(0);
  await expect(worklist.getByRole("button", { name: /^Disable / })).toHaveCount(0);
  await expect(worklist.getByRole("button", { name: "Copy this change" })).toHaveCount(0);

  // And the approval it stopped is one line behind a count, exactly like every other pass.
  await segments.getByRole("button", { name: "Passed 1" }).click();
  await expect(worklist.locator("button.wf-run-worklist-row")).toHaveCount(1);
  await expect(worklist).toContainText(REVIEWER);
});
