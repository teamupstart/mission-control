import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

import type { Session } from "../../src/shared/types.ts";
import { resumeLeaseRoot } from "../../src/server/terminal/resume-lease.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { test, expect } from "../fixtures/test.ts";

/**
 * Issue #1733 on a path production reaches: after a restart, the bound session of a delivered
 * Pull Request action briefly reads `exited` while the action observer looks.
 *
 * Traced, not assumed. Three candidate paths were checked:
 *  - A clean restart restores SDK sessions before the observer's first sweep
 *    (`workflow-session-action-restart.spec.ts` passes on the pre-fix build).
 *  - A session-transfer hold keeps the binding active while its source is gone, but the
 *    observer skips any action whose conversation has an unresolved transfer
 *    (`resolveSessionAction` -> `transferForNote`), so it cannot block there either.
 *  - A TERMINAL session lives or dies by each discovery sweep. A completed sweep whose process
 *    inventory misses it marks it `exited` and arms the 8 s eviction linger; rediscovery inside
 *    that linger cancels the eviction, so the binding is never orphaned. An observer sweep in
 *    that window sees exactly the report's state: delivered action, active binding, `exited`
 *    session. This spec drives that path.
 *
 * The action is delivered into a real SDK session, which continues in a terminal (the
 * transfer is only how the binding comes to name a terminal session). The daemon is crashed and
 * restarted, the terminal agent is rediscovered, and then the fixture's scripted process
 * inventory (`discovery-block`, the terminal boundary the handoff spec uses) misses it for
 * 6 s at a time across two observer sweeps. Nothing about the run is written behind the daemon.
 *
 * Before the fix the first sweep inside a miss blocked the action as `session_lost`, and the
 * session's return could not unblock it. Now it waits out the gap and stays the run's live wait.
 */

test.use({ daemonEnv: { MC_E2E_TERMINAL_BOUNDARY: "1", MC_E2E_RESUME_TOOLS: "1", MISSION_POLL_MS: "100" } });

const EVIDENCE = artifactsDir("workflow-session-action-transfer-restart");
/** Two full observer sweeps (15 s each) and change, while discovery keeps missing the session. */
const FLAPPING_MS = 40_000;

async function shoot(target: Page | Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  console.log(`CAPTURED e2e/.artifacts/workflow-session-action-transfer-restart/${name}.png`);
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

interface RunDetail {
  run: { status: string; currentPhase: string; gateState: { code?: string; detail?: string } | null };
  binding: { state: string; sessionId: string | null };
  summary: { actionWait?: string | null; round: number };
  deliveries: Array<{ kind: string; state: string }>;
  events: Array<{ kind: string }>;
}

const detail = (daemon: DaemonHandle, runId: string): Promise<RunDetail> =>
  api<RunDetail>(daemon, `/api/workflow-runs/${runId}`);

const sessions = (daemon: DaemonHandle): Promise<Session[]> => api<Session[]>(daemon, "/api/sessions").catch(() => []);

async function line(daemon: DaemonHandle, runId: string, sourceId: string): Promise<string> {
  const current = await detail(daemon, runId);
  const live = await sessions(daemon);
  const bound = current.binding.sessionId;
  const boundState = live.find((s) => s.id === bound)?.state ?? "missing";
  return `${current.run.status}/${current.run.currentPhase}/${current.summary.actionWait ?? "-"}`
    + ` binding=${current.binding.state}:${bound === sourceId ? "source" : bound ? "successor" : "none"}:${boundState}`
    + (current.run.gateState?.code ? ` code=${current.run.gateState.code}` : "");
}

/** Watch for `ms`, logging every change, and return everything seen. */
async function watch(daemon: DaemonHandle, runId: string, sourceId: string, label: string, ms: number): Promise<string[]> {
  const seen: string[] = [];
  const started = Date.now();
  while (Date.now() - started < ms) {
    const current = await line(daemon, runId, sourceId);
    if (seen.at(-1)?.replace(/^\+\d+ms /, "") !== current) {
      seen.push(`+${Date.now() - started}ms ${current}`);
      console.log(`${label} +${Date.now() - started}ms ${current}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return seen;
}

test("after a restart, brief discovery misses of a delivered Pull Request action's session do not strand the run", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(300_000);
  await api(daemon, "/api/workflows/config", { liveEnabled: true, repoAllowlist: [daemon.repo] }, "PUT");

  await dashboard.getByRole("button", { name: "Dispatch", exact: true }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByLabel("Kind").selectOption("chat");
  await dialog.getByRole("textbox", { name: "What would you like to talk about?" }).fill("Ship the reviewed change");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await sessions(daemon)).find((s) => s.runtime === "sdk")?.state, { timeout: 30_000 }).toBe("idle");
  const source = (await sessions(daemon)).find((s) => s.runtime === "sdk")!;

  // Unpublished work in the checkout: the Pull Request action then waits for a pull request
  // rather than completing as "no changes to publish", so nothing races the transfer.
  writeFileSync(join(source.cwd!, "shipped.txt"), "reviewed change\n");
  execFileSync("git", ["add", "shipped.txt"], { cwd: source.cwd! });
  execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "commit", "-q", "-m", "reviewed change"], { cwd: source.cwd! });

  const action = await api<{ id: string }>(daemon, "/api/session-actions", {
    name: "Pull Request across a transfer",
    description: "Open the pull request",
    promptMarkdown: "# Open the pull request\n\nPublish the reviewed work.\n",
    completion: { kind: "pull_request" },
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E transfer during a Pull Request action",
    draft: {
      nodes: [
        { id: "session-node", kind: "session", position: { x: 0, y: 0 } },
        { id: "action-node", kind: "session_action", sessionActionId: action.id, position: { x: 240, y: 0 } },
        { id: "end-node", kind: "end", outcome: "Approved", position: { x: 480, y: 0 } },
      ],
      edges: [
        { id: "e-submit", source: "session-node", sourcePort: "submitted", target: "action-node", targetPort: "activate" },
        { id: "e-complete", source: "action-node", sourcePort: "complete", target: "end-node", targetPort: "terminal" },
      ],
    },
  });
  const published = await api<{ version: { id: string } }>(
    daemon, `/api/workflows/${workflow.workflow.id}/publish`, { expectedDraftRevision: 1 },
  );
  const binding = await api<{ id: string }>(daemon, "/api/workflow-bindings", {
    workflowVersionId: published.version.id, sessionId: source.id, deliveryMode: "live", triggerMode: "manual",
  });
  const submitted = await api<{ run: { id: string } }>(
    daemon, `/api/workflow-bindings/${binding.id}/submit`, { requestId: "e2e-transfer-restart" },
  );
  const runId = submitted.run.id;
  await expect.poll(async () => {
    const current = await detail(daemon, runId);
    const delivered = current.deliveries.some((d) => d.kind === "session_action" && d.state === "delivered");
    return `${current.run.status}/${delivered}`;
  }, { message: "the Pull Request action should be delivered", timeout: 60_000 }).toBe("waiting_for_action/true");
  console.log(`DELIVERED ${await line(daemon, runId, source.id)}`);

  // Continue in terminal. The transfer itself is NOT where the report's state comes from: the
  // observer deliberately skips an action whose conversation has an unresolved transfer
  // (`resolveSessionAction`), and this spec once proved that by passing on the pre-fix build.
  // It is how a delivered action comes to be bound to a terminal session, whose liveness is
  // whatever the OS process inventory says on each discovery sweep.
  try {
    await dashboard.goto(`${daemon.baseURL}/#/session/${encodeURIComponent(source.id)}`);
    // The rail selects through the same production detail a person uses, as the handoff spec does.
    const row = dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").filter({ hasText: source.name });
    if (await row.count()) await row.first().click();
    const handoff = dashboard.waitForResponse((r) =>
      r.url().endsWith(`/api/sessions/${encodeURIComponent(source.id)}/handoff`) && r.request().method() === "POST");
    await dashboard.getByRole("button", { name: "terminal", exact: true }).click({ timeout: 30_000 });
    const response = await handoff;
    expect(response.ok(), await response.text()).toBe(true);
    const transfer = (await response.json()) as { transfer: { id: string; state: string } };
    await expect.poll(async () => (await api<{ state: string }>(daemon, `/api/session-transfers/${transfer.transfer.id}`)).state,
      { timeout: 30_000 }).toBe("adopted");
    const successorId = (await detail(daemon, runId)).binding.sessionId!;
    expect(successorId).not.toBe(source.id);
    console.log(`ADOPTED ${await line(daemon, runId, source.id)}`);

    // A real crash and restart. The terminal agent outlives the daemon, is rediscovered by the
    // first sweep, and keeps the binding.
    await daemon.crash();
    await daemon.restart();
    await expect.poll(async () => (await sessions(daemon)).find((s) => s.id === successorId)?.state ?? "missing",
      { timeout: 30_000 }).not.toMatch(/^(missing|exited)$/);
    console.log(`RESTARTED ${await line(daemon, runId, source.id)}`);

    // Then the inventory misses the live terminal process for a few seconds at a time - shorter
    // than the 8 s exit linger, so each miss ends in rediscovery rather than eviction, exactly
    // the "for a short time the bound session shows state exited" of the report. Repeated
    // across two observer sweeps (15 s each) so a post-restart sweep lands inside a miss.
    let flapping = true;
    const flaps = (async () => {
      while (flapping) {
        writeFileSync(join(daemon.recordDir, "discovery-block"), "transient inventory miss");
        await new Promise((resolve) => setTimeout(resolve, 6_000));
        rmSync(join(daemon.recordDir, "discovery-block"), { force: true });
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
    })();
    let seen: string[];
    try {
      seen = await watch(daemon, runId, source.id, "FLAPPING AFTER RESTART", FLAPPING_MS);
    } finally {
      // Stopped and joined even when a poll throws, so the loop cannot recreate the marker
      // after the outer cleanup removes it and run on into fixture teardown.
      flapping = false;
      await flaps;
      rmSync(join(daemon.recordDir, "discovery-block"), { force: true });
    }
    // The state existed: the binding stayed active while its session read `exited`.
    expect(seen.some((l) => l.includes("binding=active:successor:exited")), seen.join("\n")).toBe(true);
    expect(seen.filter((l) => l.includes("session_action_blocked")), seen.join("\n")).toEqual([]);

    const settled = await watch(daemon, runId, source.id, "SETTLED", 5_000);
    expect(settled.at(-1)).toMatch(/^\+\d+ms waiting_for_action\/session_action\/\S+ binding=active:successor:(idle|working)/);

    const final = await detail(daemon, runId);
    expect(final.events.map((e) => e.kind)).not.toContain("session_action_blocked");
    expect(final.summary.round).toBe(1);
    expect(final.deliveries.filter((d) => d.kind === "session_action")).toHaveLength(1);

    await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
    const header = dashboard.locator("header.wf-run-head");
    await expect(header).toContainText("Waiting for a session action");
    await expect(header.getByText("Blocked", { exact: true })).toHaveCount(0);
    await dashboard.mouse.move(0, 0);
    await shoot(header, "01-after-restart-and-discovery-misses");
  } finally {
    mkdirSync(daemon.recordDir, { recursive: true });
    rmSync(join(daemon.recordDir, "discovery-block"), { force: true });
    writeFileSync(join(daemon.recordDir, "resume-stop"), "stop");
    rmSync(resumeLeaseRoot(daemon.home), { recursive: true, force: true });
  }
});
