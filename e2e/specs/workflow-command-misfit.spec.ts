import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * A machine-wide default the repository does not provide asks for configuration, not a Makefile.
 *
 * The operator sets one global `test` Command for every checkout. In a repository with no
 * Makefile it fails before reaching the change, and the packet the run shows - the exact text
 * the session receives - must ask the session to find the repository's own command, confirm it
 * through `request_input`, and set it with `configure_workflow_command`, never to "fix the
 * failing test check" by writing the missing build file.
 *
 * The Command is the real `make test`, run in the fixture repository, which holds only a
 * README: the exact failure an adopter without a Makefile meets. No model tokens: the session
 * is the fake agent.
 */

const NODE = { session: "session-node", check: "check-node", end: "end-node" };
const EVIDENCE = artifactsDir("workflow-command-misfit");
// GNU make 3.81 (macOS) quotes the target `test'; 4.x (Linux CI) quotes it 'test'.
const MAKE_REFUSAL = /make: \*\*\* No rule to make target [`']test'\.\s+Stop\./;

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
    .fill("hold a session for the command misfit spec");
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

test("a machine-wide default the repository does not provide shows a configuration repair", async ({
  dashboard,
  daemon,
}) => {
  // The adopter this is for: a repository with no Makefile at all.
  for (const name of ["Makefile", "makefile", "GNUmakefile"]) {
    expect(existsSync(join(daemon.repo, name)), `${name} must not exist in the fixture repo`).toBe(false);
  }
  const sessionId = await dispatch(dashboard, daemon);

  // Commands are off by default and allowlisted per repository; no repository override exists.
  await api(daemon, "/api/workflows/config", {
    liveEnabled: true,
    checksEnabled: true,
    repoAllowlist: [daemon.repo],
    defaultWorkflowId: null,
    checkCommands: [],
  }, "PUT");
  // The machine-wide default, written through the route Library › Commands saves with.
  const slot = await api<{
    revision: number; maxRuns: number; timeoutMs: number | null;
    onUnavailable: string; onBudgetExhausted: string;
  }>(daemon, "/api/workflow-commands/test");
  await api(daemon, "/api/workflow-commands/test", {
    expectedRevision: slot.revision,
    defaultCommand: ["make", "test"],
    overrides: [],
    maxRuns: slot.maxRuns,
    timeoutMs: slot.timeoutMs,
    onUnavailable: slot.onUnavailable,
    onBudgetExhausted: slot.onBudgetExhausted,
  }, "PUT");

  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E command misfit",
    draft: {
      nodes: [
        { id: NODE.session, kind: "session", position: { x: 0, y: 0 } },
        { id: NODE.check, kind: "check", slot: "test", position: { x: 220, y: 0 } },
        { id: NODE.end, kind: "end", outcome: "Approved", position: { x: 440, y: 0 } },
      ],
      edges: [
        { id: "e-check", source: NODE.session, sourcePort: "submitted", target: NODE.check, targetPort: "activate" },
        { id: "e-check-pass", source: NODE.check, sourcePort: "pass", target: NODE.end, targetPort: "terminal" },
        { id: "e-check-fail", source: NODE.check, sourcePort: "fail", target: NODE.session, targetPort: "return_for_changes" },
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
    { requestId: "e2e-command-misfit" },
  );
  const runId = submitted.run.id;

  try {
    await expect
      .poll(async () => {
        const run = await api<{ deliveries: unknown[] }>(daemon, `/api/workflow-runs/${runId}`);
        return run.deliveries.length;
      }, { message: "the failed default should prepare one repair packet", timeout: 60_000 })
      .toBe(1);
  } catch (caught) {
    // eslint-disable-next-line no-console
    console.log(`DAEMON LOG TAIL:\n${daemon.readLog().split("\n").slice(-60).join("\n")}`);
    throw caught;
  }

  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  await dashboard.getByRole("tab", { name: /^Deliveries/ }).click();
  const ledger = dashboard.getByRole("tabpanel", { name: /^Deliveries/ });
  await expect(ledger).toBeVisible({ timeout: 40_000 });
  await ledger.getByRole("button", { name: "Show packet" }).click();
  const packet = ledger.locator("tr.wf-run-ledger-detail pre");
  await expect(packet).toBeVisible();

  // What the session is asked to do, in the words it receives.
  await expect(packet).toContainText("Configure the test Command for this repository; do not add files to satisfy it");
  await expect(packet).toContainText("The test gate ran `make test`, which is Mission Control's machine-wide default for this slot");
  await expect(packet).toContainText(MAKE_REFUSAL);
  await expect(packet).toContainText("Do not create a Makefile");
  await expect(packet).toContainText("Call request_input to ask the operator to confirm the exact command");
  await expect(packet).toContainText(`configure_workflow_command({ runId: "${runId}", slot: "test"`);
  await expect(packet).toContainText("resubmitUnchanged: true");
  // And what it is no longer asked to do.
  await expect(packet).not.toContainText("Fix the failing test check");

  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    await packet.screenshot({ path: `${EVIDENCE}configuration-repair-packet.png` });
    // eslint-disable-next-line no-console
    console.log(`REPAIR PACKET:\n${await packet.innerText()}`);
  }
});
