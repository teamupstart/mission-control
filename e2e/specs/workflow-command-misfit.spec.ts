import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
 * the session receives - must ask the session to find the repository's own command and set it
 * with `configure_workflow_command`, which confirms it through `request_input`, never to "fix the
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
  await expect(packet).toContainText("asks the operator to confirm through a request_input card that Mission Control writes");
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

test("the session's configure_workflow_command shows the operator its card, and the confirmed command runs", async ({
  dashboard,
  daemon,
}) => {
  // A repository that runs its tests through npm and has no Makefile, committed and pushed so
  // the dispatched checkout carries it. The fake agent inspects that checkout, exactly as the
  // packet asks, and calls the real tool; nothing here writes the override for it.
  writeFileSync(join(daemon.repo, "package.json"), `${JSON.stringify({
    name: "demo-repo", version: "1.0.0", private: true,
    scripts: { test: "node -e \"console.log('E2E CONFIRMED SUITE RAN')\"" },
  }, null, 2)}\n`);
  const git = (...args: string[]) => execFileSync("git", ["-C", daemon.repo, "-c", "user.name=e2e",
    "-c", "user.email=e2e@example.com", ...args], { stdio: "pipe" });
  git("add", "package.json");
  git("commit", "-qm", "run tests through npm");
  git("push", "-q", "origin", "main");
  expect(existsSync(join(daemon.repo, "Makefile"))).toBe(false);

  const sessionId = await dispatch(dashboard, daemon);
  await api(daemon, "/api/workflows/config", {
    liveEnabled: true, checksEnabled: true, repoAllowlist: [daemon.repo], defaultWorkflowId: null, checkCommands: [],
  }, "PUT");
  const slot = await api<{ revision: number; maxRuns: number; timeoutMs: number | null;
    onUnavailable: string; onBudgetExhausted: string }>(daemon, "/api/workflow-commands/test");
  await api(daemon, "/api/workflow-commands/test", {
    expectedRevision: slot.revision, defaultCommand: ["make", "test"], overrides: [], maxRuns: slot.maxRuns,
    timeoutMs: slot.timeoutMs, onUnavailable: slot.onUnavailable, onBudgetExhausted: slot.onBudgetExhausted,
  }, "PUT");
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E command configuration",
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
    daemon, `/api/workflows/${workflow.workflow.id}/publish`, { expectedDraftRevision: 1 });
  // Live delivery, so the daemon types the repair packet into the session itself.
  const binding = await api<{ id: string }>(daemon, "/api/workflow-bindings", {
    workflowVersionId: published.version.id, sessionId, deliveryMode: "live",
  });
  const submitted = await api<{ run: { id: string } }>(
    daemon, `/api/workflow-bindings/${binding.id}/submit`, { requestId: "e2e-command-configuration" });
  const runId = submitted.run.id;

  // The session's tool call puts the daemon's confirmation card in front of the operator.
  try {
    await expect.poll(async () => {
      const reviews = await api<Array<{ sessionId: string; status: string; decisions?: Array<{ id: string }> | null }>>(
        daemon, "/api/reviews");
      return reviews.some((review) => review.sessionId === sessionId && review.status === "pending"
        && review.decisions?.[0]?.id.startsWith("configure-command:"));
    }, { message: "configure_workflow_command should raise the confirmation card", timeout: 90_000 }).toBe(true);
  } catch (caught) {
    // eslint-disable-next-line no-console
    console.log(`DAEMON LOG TAIL:\n${daemon.readLog().split("\n").slice(-80).join("\n")}`);
    throw caught;
  }
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  await dashboard.locator(".console-detail").getByRole("button", { name: /to review/ }).click();
  const modal = dashboard.locator(".review-modal");
  const configure = modal.getByRole("radio", { name: /^Configure this Command/ });
  await expect(configure).toBeVisible();
  // What the operator is confirming, in the daemon's words: this run, slot, repository and argv.
  await expect(modal).toContainText("Set the test workflow Command for this repository?");
  await expect(modal).toContainText(`Repository: ${daemon.repo}`);
  await expect(modal).toContainText(`Workflow run: ${runId}`);
  await expect(modal).toContainText('Command (exact argv, one JSON string per argument): ["npm","test"]');
  await expect(modal.getByRole("radio", { name: /^Don't configure it/ })).toBeVisible();
  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    await modal.screenshot({ path: `${EVIDENCE}confirmation-card.png` });
  }
  await configure.check();
  await modal.getByRole("button", { name: "Submit" }).click();
  await expect(configure).toHaveCount(0);

  // Only now is the override stored, and the resubmitted gate runs the confirmed command.
  await expect.poll(async () => {
    const view = await api<{ overrides: Array<{ repoRoot: string; command: string[] }>; defaultCommand: string[] }>(
      daemon, "/api/workflow-commands/test");
    return JSON.stringify({ overrides: view.overrides, defaultCommand: view.defaultCommand });
  }, { message: "the confirmed override should be stored", timeout: 30_000 })
    .toBe(JSON.stringify({ overrides: [{ repoRoot: daemon.repo, command: ["npm", "test"] }], defaultCommand: ["make", "test"] }));
  await expect.poll(async () => {
    const run = await api<{ run: { status: string } }>(daemon, `/api/workflow-runs/${runId}`);
    return run.run.status;
  }, { message: "the resubmitted run should pass with the confirmed command", timeout: 90_000 }).toBe("completed");
  const detail = await api<{ attempts: Array<{ nodeId: string; output: { command?: string[]; output?: string } | null }> }>(
    daemon, `/api/workflow-runs/${runId}`);
  const checks = detail.attempts.filter((attempt) => attempt.nodeId === NODE.check);
  expect(checks.map((attempt) => attempt.output?.command)).toEqual([["make", "test"], ["npm", "test"]]);
  expect(checks[1]?.output?.output).toContain("E2E CONFIRMED SUITE RAN");

  // The repair packet the session received, as the run's Deliveries tab shows it.
  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  await dashboard.getByRole("tab", { name: /^Deliveries/ }).click();
  const ledger = dashboard.getByRole("tabpanel", { name: /^Deliveries/ });
  await ledger.locator("tr.wf-run-ledger-row").first().getByRole("button", { name: "Show packet" }).click();
  const packet = ledger.locator("tr.wf-run-ledger-detail pre");
  await expect(packet).toContainText("Configure the test Command for this repository; do not add files to satisfy it");
  await expect(packet).toContainText(MAKE_REFUSAL);
  await expect(packet).not.toContainText("Fix the failing test check");
  if (process.env.MC_E2E_EVIDENCE) {
    await packet.screenshot({ path: `${EVIDENCE}delivered-repair-packet.png` });
  }
});
