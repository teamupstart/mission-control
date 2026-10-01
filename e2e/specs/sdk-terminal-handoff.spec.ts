import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { Session, ServerEvent } from "../../src/shared/types.ts";
import type { SessionTransferSummary } from "../../src/shared/session-transfer.ts";
import type { TransferFacts } from "../../src/server/session-transfers/store.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { readResumeLease, revokeResumeLease, resumeLeaseRoot } from "../../src/server/terminal/resume-lease.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { test, expect } from "../fixtures/test.ts";

test.use({ daemonEnv: { MC_E2E_TERMINAL_BOUNDARY: "1", MC_E2E_RESUME_TOOLS: "1", MISSION_POLL_MS: "100" } });
const evidence = artifactsDir("sdk-terminal-handoff");

type TransferTestWindow = Window & {
  transferTestStream: EventSource;
  transferTestSnapshot: Extract<ServerEvent, { type: "snapshot" }>;
};

async function observeTransferStream(page: Page) {
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, config?: EventSourceInit) {
        super(url, config);
        if (String(url) !== "/events") return;
        const state = window as TransferTestWindow;
        state.transferTestStream = this;
        this.addEventListener("message", (event) => {
          const message = JSON.parse(event.data);
          if (message.type === "snapshot") state.transferTestSnapshot = message;
        });
      }
    };
  });
}

async function transferEvent(page: Page, event: ServerEvent) {
  await page.evaluate((message) => {
    const stream = (window as TransferTestWindow).transferTestStream;
    stream.close();
    stream.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }, event);
}

async function dispatch(page: Page, daemon: DaemonHandle) {
  await page.getByRole("button", { name: "Dispatch", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expectContentClearsBorder(dialog);
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByLabel("Kind").selectOption("chat");
  await dialog.getByRole("textbox", { name: "What would you like to talk about?" }).fill("Keep Mission tools when continuing this conversation");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  const sessions = async () => await (await fetch(`${daemon.baseURL}/api/sessions`)).json() as Session[];
  await expect.poll(async () => (await sessions()).find((s) => s.runtime === "sdk")?.state, { timeout: 30_000 }).toBe("idle");
  const source = (await sessions()).find((s) => s.runtime === "sdk")!;
  await page.goto(`${daemon.baseURL}/#/session/${encodeURIComponent(source.id)}`);
  // The rail selects through the same production detail used by a person.
  const row = page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").filter({ hasText: source.name });
  if (await row.count()) await row.first().click();
  return source;
}

async function resume(page: Page, daemon: DaemonHandle, source: Session) {
  const response = page.waitForResponse((r) => r.url().includes(`/api/sessions/${encodeURIComponent(source.id)}/launch`) && r.request().method() === "POST");
  await page.getByRole("button", { name: /Claude Code/ }).filter({ has: page.locator(".launch-word") }).click();
  await page.getByRole("menuitem", { name: /Ghostty/ }).click();
  return await response;
}

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  expect(response.ok, `${path}: ${await response.clone().text()}`).toBe(true);
  return await response.json() as T;
}

async function awaitAdoption(daemon: DaemonHandle, id: string) {
  try {
    await expect.poll(async () => (await api<{ state: string }>(daemon, `/api/session-transfers/${id}`)).state, { timeout: 15000 }).toBe("adopted");
  } catch (error) {
    const transfer = withDaemonDb(daemon, (db) => {
      const row = db.prepare("SELECT state,reason,facts_json FROM session_runtime_transfers WHERE id=?").get(id)!;
      const facts = JSON.parse(String(row.facts_json));
      return { state: row.state, reason: row.reason, cwd: facts.cwd, repoRoot: facts.repoRoot, nativeId: facts.nativeId,
        resumeHookAt: facts.resumeHookAt, resource: facts.home?.terminalResourceId, sourceStopped: facts.sourceStopped };
    });
    const sessions = (await api<Session[]>(daemon, "/api/sessions")).map(({ id, agent, agentSessionId, cwd, repoRoot, terminals, state }) => ({ id, agent, agentSessionId, cwd, repoRoot, terminals, state }));
    throw new Error(`${String(error)}\nTransfer observation: ${JSON.stringify({ transfer, sessions })}`);
  }
}

async function bindReview(daemon: DaemonHandle, source: Session) {
  const persona = await api<{ id: string }>(daemon, "/api/personas", { name: "Continuity reviewer", guidanceMarkdown: "E2E_PASS_VERDICT" });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", { name: "Pinned continuation", draft: {
    nodes: [{ id: "session", kind: "session", position: { x: 0, y: 0 } },
      { id: "review", kind: "persona", personaId: persona.id, position: { x: 200, y: 0 } },
      { id: "end", kind: "end", outcome: "Approved", position: { x: 400, y: 0 } }],
    edges: [{ id: "submit", source: "session", sourcePort: "submitted", target: "review", targetPort: "activate" },
      { id: "pass", source: "review", sourcePort: "pass", target: "end", targetPort: "terminal" },
      { id: "fail", source: "review", sourcePort: "fail", target: "session", targetPort: "return_for_changes" }],
  } });
  const published = await api<{ version: { id: string } }>(daemon, `/api/workflows/${workflow.workflow.id}/publish`, { expectedDraftRevision: 1 });
  const binding = await api<{ id: string }>(daemon, "/api/workflow-bindings", { workflowVersionId: published.version.id, sessionId: source.id, deliveryMode: "preview" });
  const submitted = await api<{ run: { id: string } }>(daemon, `/api/workflow-bindings/${binding.id}/submit`, { requestId: "before-terminal" });
  await expect.poll(async () => (await api<{ run: { status: string } }>(daemon, `/api/workflow-runs/${submitted.run.id}`)).run.status, { timeout: 60000 }).toBe("completed");
  // A newer catalog publication is an initial condition, never the handoff result.
  withDaemonDb(daemon, (db) => {
    const old = db.prepare("SELECT * FROM workflow_versions WHERE id=?").get(published.version.id)!;
    const next = { ...old, id: `${published.version.id}-new`, version: 2, source_draft_revision: 2 };
    const keys = Object.keys(next);
    db.prepare(`INSERT INTO workflow_versions (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...Object.values(next));
    db.prepare("UPDATE workflow_definitions SET current_version_id=?,draft_revision=2 WHERE id=?").run(next.id, workflow.workflow.id);
  });
  return { bindingId: binding.id, versionId: published.version.id, runId: submitted.run.id };
}

function evidencePacket(daemon: DaemonHandle, source: Session) {
  appendFileSync(join(source.cwd!, ".gitignore"), "\n.evidence/\n");
  mkdirSync(join(source.cwd!, ".evidence"), { recursive: true });
  writeFileSync(join(source.cwd!, ".evidence", "continued.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGO44eAARAwQCgAoDgVhKrNqHwAAAABJRU5ErkJggg==", "base64"));
  writeFileSync(join(daemon.recordDir, "resume-evidence.json"), JSON.stringify({
    images: [{ clientItemId: "continued-image", path: ".evidence/continued.png", caption: "Continued terminal screenshot", repositoryScope: "repo-01" }],
    commandOutputs: [{ clientItemId: "continued-check", command: "node focused-check.mjs", exitCode: 0, output: "continued check passed", caption: "Continued terminal check", repositoryScope: "repo-01" }],
    coverage: [{ clientCriterionId: "continued-criterion", criterion: "The running task keeps its pinned review", proofClass: "visual", repositoryScope: "repo-01",
      links: [{ clientItemId: "continued-check", role: "execution" }, { clientItemId: "continued-image", role: "rendered_output" }] }],
  }));
}

test("managed resume registers mapped proof through built MCP on the same task and old pinned review", async ({ dashboard, daemon }) => {
  test.setTimeout(180000);
  const source = await dispatch(dashboard, daemon);
  const review = await bindReview(daemon, source);
  const frozen = withDaemonDb(daemon, (db) => db.prepare("SELECT * FROM workflow_submissions WHERE run_id=? ORDER BY id").all(review.runId));
  evidencePacket(daemon, source);
  writeFileSync(join(daemon.recordDir, "discovery-block"), "hold OS observation");
  let preparedHome: string | undefined;
  let guardPid: number | undefined;
  try {
    const responsePending = resume(dashboard, daemon, source);
    await expect.poll(() => existsSync(join(daemon.recordDir, "resume-hook.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(daemon.recordDir, "resume-hook.json"), "utf8")).status).toBe(204);
    expect((await api<Session[]>(daemon, "/api/sessions")).find((s) => s.id === source.id)?.state).toBe("exited");
    rmSync(join(daemon.recordDir, "discovery-block"));
    const response = await responsePending;
    expect(response.ok(), await response.text()).toBe(true);
    const transferred = await response.json();
    await awaitAdoption(daemon, transferred.transfer.id);
    const finalTransfer = await api<{ successorSessionId: string }>(daemon, `/api/session-transfers/${transferred.transfer.id}`);
    const successor = (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.id === finalTransfer.successorSessionId)!;
    expect(successor.runtime).toBe("terminal");
    expect(successor.task?.id).toBe(source.task?.id);
    expect(successor.task?.status).toBe("running");
    await expect(dashboard.locator(".detail-title-line > h2")).toHaveText(source.task?.title ?? source.name);
    withDaemonDb(daemon, (db) => {
      expect(db.prepare("SELECT workflow_version_id,session_id,state FROM workflow_bindings WHERE id=?").get(review.bindingId))
        .toMatchObject({ workflow_version_id: review.versionId, session_id: successor.id, state: "active" });
      expect(db.prepare("SELECT * FROM workflow_submissions WHERE run_id=? ORDER BY id").all(review.runId)).toEqual(frozen);
    });
    const proof = join(daemon.recordDir, "resume-mcp.json");
    await expect.poll(() => existsSync(proof), { timeout: 30_000 }).toBe(true);
    const observed = JSON.parse(readFileSync(proof, "utf8"));
    preparedHome = observed.missionHome;
    guardPid = JSON.parse(readFileSync(join(observed.missionHome, "terminal-launch.json"), "utf8")).pid;
    expect(observed.nativeId).toBe(source.agentSessionId);
    expect(observed.sdkIdentity).toBeNull();
    expect(observed.missionHome).not.toBe(daemon.home);
    expect(observed.tools).toContain("submit_workflow_evidence");
    expect(observed.evidenceResult.isError, JSON.stringify(observed.evidenceResult)).toBe(false);
    expect(JSON.stringify(observed.evidenceResult)).toContain("Registered 1 image(s), 1 text artifact(s), and 1 coverage claim(s)");
    expect(observed.scopeRefusal.isError).toBe(true);
    expect(JSON.stringify(observed.scopeRefusal)).toContain("repo-99");
    expect(observed.result.isError ?? false).toBe(false);
    expect(observed.result.content).toContainEqual({ type: "text", text: "ok" });
    expect(existsSync(join(observed.missionHome, "launch.json"))).toBe(true);
    // Neither the daemon's shutdown cleanup nor startup reconciliation owns a live wrapper.
    await daemon.crash(); await daemon.restart();
    expect(existsSync(join(observed.missionHome, "launch.json"))).toBe(true);
    await dashboard.goto(`${daemon.baseURL}/#/runs/${review.runId}`);
    await dashboard.reload();
    await dashboard.locator("header.wf-run-head").getByRole("button", { name: "Preview this review again" }).click();
    const tray = dashboard.getByRole("dialog", { name: "Preview this review again" });
    await expectContentClearsBorder(tray);
    await expect(tray.getByText("Registered by the session")).toBeVisible();
    await expect(tray).toContainText("Continued terminal screenshot");
    await expect(tray).toContainText("1 registered text artifact will be frozen with this submission");
    await expect(tray.getByRole("combobox", { name: "Execution evidence for acceptance criterion" }))
      .toContainText("continued-check-command-output.txt");
    await expect(tray).toContainText("The running task keeps its pinned review");
    if (process.env.MC_E2E_EVIDENCE) {
      mkdirSync(evidence, { recursive: true });
      await dashboard.screenshot({ path: join(evidence, "managed-terminal.png") });
    }
    await dashboard.keyboard.press("Escape");
    const layout = await fetch(`${daemon.baseURL}/api/ui/config`, { method: "PUT",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ layout: "board" }) });
    expect(layout.ok).toBe(true);
    await dashboard.goto(`${daemon.baseURL}/#/fleet`); await dashboard.reload();
    const tile = dashboard.locator("main.board .tile").filter({ hasText: source.task!.title });
    await expect(tile.locator(".tile-name")).toHaveText(source.task!.title);
    await expect(tile).toContainText("Pinned continuation");
    if (process.env.MC_E2E_EVIDENCE) await dashboard.screenshot({ path: join(evidence, "continued-board.png") });
    writeFileSync(join(daemon.recordDir, "resume-stop"), "stop");
    await expect.poll(() => {
      try { process.kill(guardPid!, 0); return false; } catch { return true; }
    }, { timeout: 10_000 }).toBe(true);
    // The replacement daemon is a new process under a shared ancestor. The guard cannot
    // distinguish it from an adopted descendant, so normal agent exit must retain the home.
    const status = await (await fetch(`${daemon.baseURL}/api/sessions/${encodeURIComponent(source.id)}/launch`)).json();
    expect(status.attempts).toContainEqual(expect.objectContaining({ state: "claimed" }));
    expect(existsSync(join(observed.missionHome, "loopback-token"))).toBe(true);
  } finally {
    // A failed daemon restart removes its fixture home. Still release the held fake and
    // preserve that original failure instead of replacing it with an ENOENT in teardown.
    mkdirSync(daemon.recordDir, { recursive: true });
    writeFileSync(join(daemon.recordDir, "resume-stop"), "stop");
    if (guardPid) await expect.poll(() => {
      try { process.kill(guardPid!, 0); return false; } catch { return true; }
    }, { timeout: 10_000 }).toBe(true);
    // This fixture's only agent and MCP client have exited. Remove its private retained
    // namespace explicitly; production reconciliation must not infer this from PID absence.
    if (preparedHome) rmSync(resumeLeaseRoot(daemon.home), { recursive: true, force: true });
  }
});

test("default Continue keeps an uncertain transfer visible after source removal and restart, then adopts its late hook", async ({ dashboard, daemon }) => {
  test.setTimeout(180000);
  const source = await dispatch(dashboard, daemon);
  writeFileSync(join(daemon.recordDir, "discovery-block"), "hold discovery");
  writeFileSync(join(daemon.recordDir, "hook-block"), "hold hook until source removal");
  let guardPid: number | undefined;
  try {
    const responsePending = dashboard.waitForResponse((r) => r.url().endsWith(`/api/sessions/${encodeURIComponent(source.id)}/handoff`) && r.request().method() === "POST");
    await dashboard.getByRole("button", { name: "terminal", exact: true }).click();
    const response = await responsePending;
    expect(response.ok(), await response.text()).toBe(true);
    const pending = await response.json();
    expect(pending.transfer.state).toBe("awaiting_successor");
    expect((await api<Session[]>(daemon, "/api/sessions")).some((s) => s.id === source.id)).toBe(false);
    rmSync(join(daemon.recordDir, "hook-block"));
    await expect.poll(() => existsSync(join(daemon.recordDir, "resume-hook.json"))).toBe(true);
    await expect.poll(() => existsSync(join(daemon.recordDir, "resume-mcp.json"))).toBe(true);
    const observed = JSON.parse(readFileSync(join(daemon.recordDir, "resume-mcp.json"), "utf8"));
    guardPid = JSON.parse(readFileSync(join(observed.missionHome, "terminal-launch.json"), "utf8")).pid;
    // Move the observation deadline, not ownership or launch results, to exercise recovery.
    withDaemonDb(daemon, (db) => {
      const row = db.prepare("SELECT facts_json FROM session_runtime_transfers WHERE id=?").get(pending.transfer.id)!;
      const facts = JSON.parse(String(row.facts_json)); facts.launchAt -= 180000;
      db.prepare("UPDATE session_runtime_transfers SET facts_json=? WHERE id=?").run(JSON.stringify(facts), pending.transfer.id);
    });
    await api(daemon, `/api/session-transfers/${pending.transfer.id}/recheck`, {});
    await daemon.crash(); await daemon.restart(); await dashboard.reload();
    await dashboard.keyboard.press("Shift+P");
    const sitrep = dashboard.getByRole("dialog", { name: "Sitrep" });
    await expectContentClearsBorder(sitrep);
    const transfer = sitrep.getByRole("group", { name: `Terminal transfer: ${source.name}` });
    await expect(transfer).toContainText("Could not verify the terminal");
    await expectContentClearsBorder(sitrep);
    expect(await transfer.locator(".report-sub").evaluateAll((nodes) => nodes.every((node) => node.scrollWidth <= node.clientWidth + 1))).toBe(true);
    await expect(transfer.getByRole("button", { name: "End transfer", exact: true })).toHaveCount(0);
    await expect(transfer.getByRole("button", { name: "Check again" })).toHaveAccessibleDescription("Look for the original terminal attempt without launching another agent");
    await transfer.getByRole("button", { name: "Check again" }).hover();
    await expect(dashboard.locator(".tooltip")).toHaveText("Look for the original terminal attempt without launching another agent");
    if (process.env.MC_E2E_EVIDENCE) {
      mkdirSync(evidence, { recursive: true });
      await dashboard.screenshot({ path: join(evidence, "recheck-tooltip.png") });
    }
    await transfer.getByRole("button", { name: "Check again" }).click();
    await expect(transfer.getByRole("status")).toHaveText("Transfer checked.");
    expect(readFileSync(join(daemon.recordDir, "terminal-launches.log"), "utf8").trim().split("\n")).toHaveLength(1);
    expect((await api<Session[]>(daemon, "/api/sessions")).filter((s) => s.runtime === "sdk")).toHaveLength(0);
    if (process.env.MC_E2E_EVIDENCE) {
      mkdirSync(evidence, { recursive: true });
      await dashboard.screenshot({ path: join(evidence, "pending-restart.png") });
    }
    await dashboard.keyboard.press("Shift+P");
    await dashboard.getByRole("button", { name: "Library", exact: true }).click();
    const destination = dashboard.url();
    rmSync(join(daemon.recordDir, "discovery-block"));
    await awaitAdoption(daemon, pending.transfer.id);
    await expect(dashboard).toHaveURL(destination);
    await dashboard.keyboard.press("Shift+P");
    await expect(dashboard.getByRole("group", { name: `Terminal transfer: ${source.name}` })).toHaveCount(0);
    const successors = (await api<Session[]>(daemon, "/api/sessions")).filter((s) => s.runtime === "terminal");
    expect(successors).toHaveLength(1);
    expect(successors[0]!.task?.id).toBe(source.task?.id);
    expect(successors[0]!.task?.status).toBe("running");
  } finally {
    mkdirSync(daemon.recordDir, { recursive: true });
    rmSync(join(daemon.recordDir, "hook-block"), { force: true });
    writeFileSync(join(daemon.recordDir, "resume-stop"), "stop");
    if (guardPid) await expect.poll(() => { try { process.kill(guardPid!, 0); return false; } catch { return true; } }, { timeout: 10000 }).toBe(true);
    rmSync(resumeLeaseRoot(daemon.home), { recursive: true, force: true });
  }
});

test.describe("Sitrep pagination", () => {
  test.use({ daemonEnv: { MISSION_POLL_MS: "0" } });

  test("paged actions refresh without an SSE update and distinguish Check from End", async ({ dashboard }) => {
    await observeTransferStream(dashboard);
    await dashboard.reload();
    await expect.poll(() => dashboard.evaluate(() => Boolean((window as TransferTestWindow).transferTestSnapshot))).toBe(true);
    const transfer: SessionTransferSummary = { id: "paged-action", revision: 1, sourceSessionId: "held-source",
      sourceName: "Paged recovery", taskId: null, successorSessionId: null, state: "recovery_required",
      reason: "Waiting for process inventory", createdAt: 1, updatedAt: 1, canEnd: false };
    // A bounded HTTP/SSE fixture isolates lost notifications from daemon recovery policy.
    // The production page fetch and row controls must still converge after a successful action.
    await transferEvent(dashboard, { type: "session_transfers", page: { transfers: [{ ...transfer, id: "first-page", sourceName: "First page" }], overflow: 1 } });
    let current = { ...transfer };
    let pageReads = 0;
    let ended = false;
    let releaseEndPage!: () => void;
    const endPage = new Promise<void>((resolve) => { releaseEndPage = resolve; });
    await dashboard.route("**/api/session-transfers?*", async (route) => {
      pageReads++;
      if (ended) await endPage;
      await route.fulfill({ json: { transfers: ended ? [] : [current], overflow: 0 } });
    });
    await dashboard.route("**/api/session-transfers/paged-action/recheck", async (route) => {
      current = { ...current, revision: 2, reason: "Absence verified; transfer may end", canEnd: true };
      await route.fulfill({ json: { ok: true, transfer: current } });
    });
    await dashboard.route("**/api/session-transfers/paged-action/resolve", async (route) => {
      ended = true;
      await route.fulfill({ json: { ok: true, transfer: { ...current, state: "failed" } } });
    });
    await dashboard.keyboard.press("Shift+P");
    const sitrep = dashboard.getByRole("dialog", { name: "Sitrep" });
    await expectContentClearsBorder(sitrep);
    await sitrep.getByRole("button", { name: "More transfers" }).click();
    const row = sitrep.getByRole("group", { name: "Terminal transfer: Paged recovery" });
    await expect(row).toContainText("Waiting for process inventory");
    await row.getByRole("button", { name: "Check again" }).click();
    await expect(row.getByRole("status")).toHaveText("Transfer checked.");
    await expect(row).toContainText("Absence verified; transfer may end");
    expect(pageReads).toBeGreaterThan(1);
    if (process.env.MC_E2E_EVIDENCE) {
      mkdirSync(evidence, { recursive: true });
      await sitrep.getByRole("heading", { name: "Terminal transfers", exact: true }).hover();
      await expect(dashboard.locator(".tooltip")).toHaveCount(0);
      await dashboard.screenshot({ path: join(evidence, "paged-action-feedback.png") });
    }
    try {
      await row.getByRole("button", { name: "End transfer", exact: true }).click();
      await row.getByRole("button", { name: "Confirm end transfer" }).click();
      await expect(row.getByRole("status")).toHaveText("Transfer ended.");
    } finally { releaseEndPage(); }
    await expect(row).toHaveCount(0);
    expect(pageReads).toBeGreaterThan(2);
  });

  for (const boundary of ["ended event", "reconnect snapshot"] as const) test(`a ${boundary} releases selection of a missing transfer source`, async ({ dashboard, daemon }) => {
    await observeTransferStream(dashboard);
    await fetch(`${daemon.baseURL}/api/ui/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ layout: "board" }) });
    await dashboard.reload();
    const source = await dispatch(dashboard, daemon);
    await dashboard.locator(".tile").filter({ hasText: source.name }).click();
    await expect(dashboard.locator(".board-detail .detail-title-line > h2")).toBeVisible();
    const snapshot = await dashboard.evaluate(() => (window as TransferTestWindow).transferTestSnapshot);
    const transfer: SessionTransferSummary = { id: "selection-transfer", revision: 1, sourceSessionId: source.id,
      sourceName: source.name, taskId: source.task?.id ?? null, successorSessionId: null, state: "recovery_required",
      reason: "Waiting for terminal", createdAt: 1, updatedAt: 1, canEnd: false };
    await transferEvent(dashboard, { type: "session_transfers", page: { transfers: [transfer], overflow: 0 }, changed: transfer });
    await transferEvent(dashboard, { type: "session_remove", id: source.id });
    await expect(dashboard.locator(".board-detail .detail-title-line > h2")).toHaveCount(0);
    if (boundary === "ended event") {
      await transferEvent(dashboard, { type: "session_transfers", page: { transfers: [], overflow: 0 }, changed: { ...transfer, state: "failed" } });
    } else {
      await transferEvent(dashboard, { type: "session_transfers", page: { transfers: [], overflow: 0 }, changed: { ...transfer, state: "adopted", successorSessionId: "absent-successor" } });
      await transferEvent(dashboard, { ...snapshot, sessions: [], sessionTransfers: { transfers: [], overflow: 0 } });
    }
    // Flush the removal's effects before rediscovery; otherwise React can batch both
    // frames into a session that never disappeared from the rendered collection.
    await dashboard.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    // Rediscovery must not reopen an old drill-in whose owner disappeared while offline.
    await transferEvent(dashboard, { type: "session_upsert", session: source });
    await expect(dashboard.locator(".tile").filter({ hasText: source.name })).toBeVisible();
    await expect(dashboard.locator(".board-detail .detail-title-line > h2")).toHaveCount(0);
  });

  test("More transfers shows transfer 101 and Previous transfers restores the first page", async ({ dashboard, daemon }) => {
    // Seed durable unresolved records without launching 101 agents. The snapshot, page
    // endpoint and browser controls below all use their production paths.
    withDaemonDb(daemon, (db) => {
      const insert = db.prepare(`INSERT INTO session_runtime_transfers
        (id, revision, source_session_id, note_key, task_id, state, reason, successor_session_id, facts_json, created_at, updated_at)
        VALUES (?, 1, ?, ?, NULL, 'recovery_required', 'Terminal launch outcome is unknown', NULL, ?, ?, ?)`);
      const now = Date.now();
      for (let index = 1; index <= 101; index++) {
        const number = String(index).padStart(3, "0");
        const id = `pagination-${number}`;
        const facts: TransferFacts = {
          agent: "claude", nativeId: id, sourceName: `Pending transfer ${number}`, sourceRuntime: "sdk",
          sourceEpisodeId: null, cwd: daemon.repo, repoRoot: daemon.repo, taskIdentity: null, taskEpisodeId: null,
          bindings: [], leaseRoot: join(daemon.home, "pagination-resume-leases"), leaseId: id,
          backend: null, home: null, sourceStopped: true, stopStarted: true, sourceProcess: null,
          launchAt: now - 180000, launchOutcome: "unknown", canEnd: false,
        };
        insert.run(id, `source-${id}`, id, JSON.stringify(facts), now + index, now + index);
      }
    });
    await dashboard.reload();
    await dashboard.keyboard.press("Shift+P");
    const sitrep = dashboard.getByRole("dialog", { name: "Sitrep" });
    await expectContentClearsBorder(sitrep);
    const transfers = sitrep.getByRole("region", { name: "Terminal transfers" });
    const rows = transfers.getByRole("group", { name: /^Terminal transfer:/ });
    const first = transfers.getByRole("group", { name: "Terminal transfer: Pending transfer 001", exact: true });
    const last = transfers.getByRole("group", { name: "Terminal transfer: Pending transfer 101", exact: true });
    const more = transfers.getByRole("button", { name: "More transfers" });
    const previous = transfers.getByRole("button", { name: "Previous transfers" });
    await expect(rows).toHaveCount(100);
    await expect(first).toBeVisible();
    await expect(rows.last()).toHaveAccessibleName("Terminal transfer: Pending transfer 100");
    await expect(previous).toHaveCount(0);
    await expect(more).toHaveText("More transfers (1)");
    await expect(more).toHaveAccessibleDescription("Show the next page of unresolved terminal transfers");

    await more.click();
    await expect(rows).toHaveCount(1);
    await expect(last).toBeVisible();
    await expect(first).toHaveCount(0);
    await expect(more).toHaveCount(0);
    await expect(previous).toBeVisible();
    await expect(previous).toHaveAccessibleDescription("Show the previous page of unresolved terminal transfers");
    if (process.env.MC_E2E_EVIDENCE) {
      mkdirSync(evidence, { recursive: true });
      await dashboard.screenshot({ path: join(evidence, "transfers-second-page.png") });
    }

    await previous.click();
    await expect(rows).toHaveCount(100);
    await expect(first).toBeVisible();
    await expect(last).toHaveCount(0);
    await expect(rows.last()).toHaveAccessibleName("Terminal transfer: Pending transfer 100");
    await expect(previous).toHaveCount(0);
    await expect(more).toHaveText("More transfers (1)");
    await first.scrollIntoViewIfNeeded();
    await expect(first).toBeInViewport();
    if (process.env.MC_E2E_EVIDENCE) await dashboard.screenshot({ path: join(evidence, "transfers-first-page-restored.png") });
  });
});

test.describe("safe resolution", () => {
  test.use({ daemonEnv: { MC_E2E_TERMINAL_BOUNDARY: "1", MC_E2E_RESUME_TOOLS: "0", MISSION_POLL_MS: "100" } });
  test("End transfer requires positive absence and confirmation, and keeps a changed task", async ({ dashboard, daemon }) => {
    const source = await dispatch(dashboard, daemon);
    const response = await resume(dashboard, daemon, source);
    expect(response.ok(), await response.text()).toBe(true);
    const pending = await response.json();
    const lease = withDaemonDb(daemon, (db) => {
      const row = db.prepare("SELECT facts_json FROM session_runtime_transfers WHERE id=?").get(pending.transfer.id)!;
      const facts = JSON.parse(String(row.facts_json));
      // A concurrent new task attempt invalidates automatic adoption, even in the same cwd.
      db.prepare("UPDATE tasks SET dispatched_at=dispatched_at+1 WHERE id=?").run(source.task!.id);
      return readResumeLease(facts.leaseRoot, facts.leaseId);
    });
    expect(revokeResumeLease(lease)).toBe(true, "this OS fixture never starts the wrapper");
    await api(daemon, `/api/session-transfers/${pending.transfer.id}/recheck`, {});
    await dashboard.keyboard.press("Shift+P");
    const dialog = dashboard.getByRole("dialog", { name: "Sitrep" });
    await expectContentClearsBorder(dialog);
    const row = dialog.getByRole("group", { name: `Terminal transfer: ${source.name}` });
    await expect(row).toContainText("Task ownership or work attempt changed");
    await expect(row.getByRole("button", { name: "End transfer", exact: true })).toHaveAccessibleDescription("Review ending this transfer while retaining its checkout");
    await row.getByRole("button", { name: "End transfer", exact: true }).click();
    await expect(row.getByRole("button", { name: "Confirm end transfer" })).toBeVisible();
    await expect(row.getByRole("button", { name: "Confirm end transfer" })).toHaveAccessibleDescription("End this transfer after rechecking absence and retain its checkout");
    await expect(row.getByRole("button", { name: "Keep transfer" })).toHaveAccessibleDescription("Leave this transfer available for recovery");
    await expectContentClearsBorder(dialog);
    expect(await row.getByText("End this transfer and retain its checkout?", { exact: true })
      .evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    if (process.env.MC_E2E_EVIDENCE) {
      mkdirSync(evidence, { recursive: true });
      await dashboard.screenshot({ path: join(evidence, "end-confirmation.png") });
    }
    await row.getByRole("button", { name: "Keep transfer" }).click();
    await expect(row.getByRole("button", { name: "End transfer", exact: true })).toBeVisible();
    await row.getByRole("button", { name: "End transfer", exact: true }).click();
    await row.getByRole("button", { name: "Confirm end transfer" }).click();
    await expect(row).toHaveCount(0);
    expect((await api<{ state: string }>(daemon, `/api/session-transfers/${pending.transfer.id}`)).state).toBe("failed");
    const task = (await api<Array<{ id: string; status: string; worktreePath: string }>>(daemon, "/api/tasks")).find((task) => task.id === source.task!.id)!;
    expect(task.status).toBe("running"); expect(task.worktreePath).toBe(source.cwd);
    expect(existsSync(source.cwd!)).toBe(true);
  });
});

test.describe("preflight refusal", () => {
  test.use({ daemonEnv: { MC_E2E_TERMINAL_BOUNDARY: "1", MC_E2E_RESUME_TOOLS: "1", MISSION_POLL_MS: "100", MC_E2E_RESUME_PRIVATE_MCP: "1" } });
  test("a missing bundle leaves the SDK usable and renders the remedy", async ({ dashboard, daemon }) => {
    const source = await dispatch(dashboard, daemon);
    // A private copy avoids touching dist/ shared by another test or daemon.
    writeFileSync(join(daemon.home, "resume-mcp.mjs"), "throw new Error('fixture stale bundle');\n");
    const response = await resume(dashboard, daemon, source);
    expect(response.status()).toBe(409);
    await expect(dashboard.getByText(/MCP server.*could not be interrogated/)).toBeVisible();
    const refusal = dashboard.getByText(/MCP server.*could not be interrogated/);
    await expect(refusal).toContainText("npm run build");
    const bounds = await refusal.boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(dashboard.viewportSize()!.width);
    expect(existsSync(join(daemon.home, "terminal-boundary.json"))).toBe(false);
    const sessions = await (await fetch(`${daemon.baseURL}/api/sessions`)).json() as Session[];
    expect(sessions.find((s) => s.id === source.id)?.state).toBe("idle");
    if (process.env.MC_E2E_EVIDENCE) {
      mkdirSync(evidence, { recursive: true });
      await dashboard.screenshot({ path: join(evidence, "preflight-refusal.png") });
    }
    const sent = await fetch(`${daemon.baseURL}/api/sessions/${encodeURIComponent(source.id)}/send`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "The original SDK still accepts turns", origin: "human", submit: true }),
    });
    expect(sent.ok, await sent.text()).toBe(true);
    copyFileSync("dist/mcp/server.mjs", join(daemon.home, "resume-mcp.mjs"));
  });
});
