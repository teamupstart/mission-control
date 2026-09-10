import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The review worklist lists reviewers, and only reviewers.
 *
 * Every node in a graph owns attempt rows, including the three that are pure structure: the
 * engine writes a `completed` attempt for the Session when evidence is captured, one for each
 * all-pass join when it aggregates, and one for the End when the run terminates. Those fell
 * through the section's bare-attempt fallback and rendered as cards reading `Session completed ·
 * attempt 1`, `Stage 1 completed · attempt 1` and `Approved completed · attempt 1` - three
 * verdicts nobody gave, sitting under the two that somebody did, on the page a person opens to
 * find out who approved a change. Their real state is already drawn on the strip above the list.
 *
 * The section that held them is now the Blocker Worklist, and the requirement survived the
 * rebuild intact: a structural attempt is still not a thing a reviewer said, and it must not
 * appear in any of the three segments. This spec follows it there rather than being deleted with
 * the markup it used to read.
 *
 * Only a browser can prove it. The markup test pins the rendered shape from a hand-built detail;
 * this drives a real dispatch, a real published workflow, a real review run to completion, and
 * reads the rail a person actually lands on from the Console detail's chip.
 *
 * No model tokens: the reviewers are answered by `e2e/fixtures/fake-agents.ts`, which returns a
 * schema-valid pass verdict for any Persona whose published guidance carries `E2E_PASS_VERDICT`.
 */

const NODE = {
  session: "session-node",
  risk: "risk-node",
  evidence: "evidence-node",
  join: "join-node",
  end: "end-node",
};

const REVIEWER = {
  risk: "E2E risk reviewer",
  evidence: "E2E evidence auditor",
};
const EVIDENCE = artifactsDir("workflow-run-reviewer-verdicts");

const WORKFLOW = "E2E reviewer verdicts";
const OUTCOME = "Approved";

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : "POST",
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
    .fill("hold a session for the reviewer verdicts spec");
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
  return sessionId;
}

/**
 * A completed run over `Session -> two Personas -> all-pass join -> End`.
 *
 * The join is the point: it is the third structural attempt, and the one whose card said
 * `Stage 1 completed · attempt 1` - a stage name where a reviewer's name belongs.
 */
async function seedApprovedRun(page: Page, daemon: DaemonHandle): Promise<string> {
  const sessionId = await dispatch(page, daemon);
  const personaId = async (name: string): Promise<string> =>
    (await api<{ id: string }>(daemon, "/api/personas", {
      name,
      guidanceMarkdown: `# ${name}\n\nE2E_PASS_VERDICT`,
    })).id;
  const risk = await personaId(REVIEWER.risk);
  const evidence = await personaId(REVIEWER.evidence);
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: WORKFLOW,
    draft: {
      nodes: [
        { id: NODE.session, kind: "session", position: { x: 0, y: 0 } },
        { id: NODE.risk, kind: "persona", personaId: risk, position: { x: 220, y: 0 } },
        { id: NODE.evidence, kind: "persona", personaId: evidence, position: { x: 220, y: 140 } },
        { id: NODE.join, kind: "all_pass", position: { x: 440, y: 70 } },
        { id: NODE.end, kind: "end", outcome: OUTCOME, position: { x: 660, y: 70 } },
      ],
      edges: [
        { id: "e-risk", source: NODE.session, sourcePort: "submitted", target: NODE.risk, targetPort: "activate" },
        { id: "e-evidence", source: NODE.session, sourcePort: "submitted", target: NODE.evidence, targetPort: "activate" },
        { id: "e-risk-pass", source: NODE.risk, sourcePort: "pass", target: NODE.join, targetPort: "result" },
        { id: "e-risk-fail", source: NODE.risk, sourcePort: "fail", target: NODE.join, targetPort: "result" },
        { id: "e-evidence-pass", source: NODE.evidence, sourcePort: "pass", target: NODE.join, targetPort: "result" },
        { id: "e-evidence-fail", source: NODE.evidence, sourcePort: "fail", target: NODE.join, targetPort: "result" },
        { id: "e-join-pass", source: NODE.join, sourcePort: "pass", target: NODE.end, targetPort: "terminal" },
        { id: "e-join-fail", source: NODE.join, sourcePort: "fail", target: NODE.session, targetPort: "return_for_changes" },
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
    { requestId: "e2e-reviewer-verdicts" },
  );
  await expect
    .poll(async () =>
      (await api<{ run: { status: string } }>(
        daemon,
        `/api/workflow-runs/${submitted.run.id}`,
      )).run.status,
    { message: "both scripted reviewers should approve and complete the run", timeout: 40_000 })
    .toBe("completed");
  return submitted.run.id;
}

test("a completed run lists its reviewers, and its tiles select their worklist data", async ({
  dashboard,
  daemon,
}) => {
  const runId = await seedApprovedRun(dashboard, daemon);

  // Console, then in from the detail's own chip - the route a person takes, because an approved run
  // is first seen as `⌁ Approved` on the session it reviewed.
  const config = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "console" }),
  });
  expect(((await config.json()) as { config?: { layout?: string } }).config?.layout).toBe("console");
  await dashboard.reload();

  await dashboard.getByRole("navigation", { name: "Sessions" })
    .locator("button.rail-row")
    .first()
    .click();
  const chip = dashboard.locator(".console-detail .workflow-chip");
  await expect(chip).toHaveText("⌁Approved", { timeout: 10_000 });
  await chip.click();
  await expect(dashboard).toHaveURL(new RegExp(`#/runs/${runId}$`));

  const section = dashboard.getByRole("region", { name: "Review worklist" });
  // The widget, not the section: the join packet under it prints the runtime's raw JSON, stage
  // name and all, so a negative assertion made against the section would be answered by that.
  const worklist = section.locator(".wf-run-worklist");
  await expect(worklist).toBeVisible();

  // An approved run asks for nothing, so the rail opens on the segment that has something in it.
  const segments = worklist.getByRole("group", { name: "Worklist segment" });
  await expect(segments.getByRole("button", { name: "Blocking 0" })).toBeVisible();
  await expect(segments.getByRole("button", { name: "Passed 2" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // Both reviewers, each with the verdict it gave, and nothing else. The Session, the join and
  // the End each used to produce a card here, which is the regression this pins.
  const rows = worklist.locator("button.wf-run-worklist-row");
  await expect(rows).toHaveCount(2);
  for (const name of [REVIEWER.risk, REVIEWER.evidence]) {
    const row = rows.filter({ hasText: name });
    await expect(row).toHaveCount(1);
    await expect(row.locator(".workflow-chip")).toHaveText("Passed");
  }
  await expect(worklist.locator("article.wf-run-attempt")).toHaveCount(0);
  await expect(worklist).not.toContainText("completed · attempt");
  await expect(worklist).not.toContainText("Stage 1");
  await expect(worklist).not.toContainText("No verdict in this round yet");

  // Nothing was hidden, only moved out of a list of opinions: the strip above still says what the
  // Session, the stage and the End each did, and the stage's own join packet is still here.
  const strip = dashboard.locator(".wf-pipeline-strip");
  await expect(strip).toContainText("Session");
  await expect(strip).toContainText(OUTCOME);
  await expect(section.locator("details.wf-run-packet").first())
    .toContainText("2 of 2 reviewers reported");

  // A settled member tile is a direct index into the worklist. Start on the first reviewer,
  // then click the second reviewer's pipeline tile and prove both the rail and full detail move.
  const riskRow = rows.filter({ hasText: REVIEWER.risk });
  const evidenceRow = rows.filter({ hasText: REVIEWER.evidence });
  await riskRow.click();
  await expect(riskRow).toHaveAttribute("aria-current", "true");
  const evidenceTile = strip.locator("li.wf-pipeline-reviewer")
    .filter({ hasText: REVIEWER.evidence });
  await evidenceTile.getByRole("button").click();
  await expect(evidenceRow).toHaveAttribute("aria-current", "true");
  await expect(riskRow).toHaveAttribute("aria-current", "false");
  await expect(worklist.locator("article.wf-run-verdict")).toContainText(REVIEWER.evidence);

  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    // eslint-disable-next-line no-console
    console.log("OBSERVED a completed reviewer tile selected that reviewer's full worklist data");
    await dashboard.screenshot({
      path: `${EVIDENCE}workflow-run-reviewer-verdicts.png`,
      fullPage: true,
    });
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/.artifacts/workflow-run-reviewer-verdicts/workflow-run-reviewer-verdicts.png");
  }
});
