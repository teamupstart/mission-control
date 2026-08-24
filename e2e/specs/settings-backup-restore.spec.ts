import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

const EVIDENCE = artifactsDir("settings-backup-restore");

async function request<T>(
  daemon: DaemonHandle,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, fullPage: true });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/settings-backup-restore/${name}.png`);
}

interface BackupList {
  snapshots: Array<{
    id: string;
    status: string;
    kind?: "daily" | "pre_restore";
    digest?: string;
    counts?: { personas: number; sessionActions: number; workflowDefinitions: number };
  }>;
}

test("verified restore reloads its window and invalidates other windows without losing drafts", async ({
  dashboard,
  daemon,
}) => {
  const desiredPersona = await request<{ id: string; revision: number }>(daemon, "/api/personas", {
    body: {
      name: "Snapshot reviewer",
      description: "The description stored in the snapshot.",
      guidanceMarkdown: "# Snapshot reviewer\n\nUse the verified snapshot guidance.",
    },
  });
  const desiredAction = await request<{ id: string; revision: number }>(daemon, "/api/session-actions", {
    body: {
      name: "Snapshot action",
      description: "The action stored in the snapshot.",
      promptMarkdown: "# Snapshot action\n\nRun the snapshot command.",
      completion: { kind: "session_turn" },
    },
  });
  const desiredWorkflow = await request<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    body: {
      name: "Snapshot workflow",
      description: "The workflow stored in the snapshot.",
      draft: {
        nodes: [
          { id: "session", kind: "session", position: { x: 0, y: 0 } },
          { id: "end", kind: "end", outcome: "Complete", position: { x: 220, y: 0 } },
        ],
        edges: [{
          id: "complete",
          source: "session",
          sourcePort: "submitted",
          target: "end",
          targetPort: "terminal",
        }],
      },
    },
  });
  const published = await request<{ version: { id: string } }>(
    daemon,
    `/api/workflows/${desiredWorkflow.workflow.id}/publish`,
    { body: { expectedDraftRevision: 1 } },
  );
  const lint = await request<{ revision: number; maxRuns: number }>(daemon, "/api/workflow-commands/lint");
  const desiredCommand = await request<{ revision: number; maxRuns: number }>(
    daemon,
    "/api/workflow-commands/lint",
    {
      method: "PUT",
      body: {
        expectedRevision: lint.revision,
        defaultCommand: ["npm", "run", "lint:snapshot"],
        maxRuns: lint.maxRuns,
        overrides: [],
      },
    },
  );
  await request(daemon, "/api/ui/config", {
    method: "PUT",
    body: { layout: "board", richText: false },
  });

  // Reboot after removing only today's disposable fixture snapshot. The production startup
  // loop then captures the desired values through the same service used outside tests.
  await daemon.crash();
  const backupDir = join(daemon.home, "backups", "settings");
  for (const filename of readdirSync(backupDir).filter((name) => name.endsWith(".json"))) {
    unlinkSync(join(backupDir, filename));
  }
  writeFileSync(join(backupDir, "daily-1999-01-01.json"), "{not-json");
  writeFileSync(join(backupDir, "daily-1999-01-02.json"), JSON.stringify({
    format: "mission-control-settings-backup",
    formatVersion: 2,
    domains: [],
  }));
  await daemon.restart();

  let snapshotId = "";
  await expect.poll(async () => {
    const backups = await request<BackupList>(daemon, "/api/settings-backups");
    const ready = backups.snapshots.find((item) => item.status === "ready");
    snapshotId = ready?.id ?? "";
    return ready?.counts;
  }).toMatchObject({ personas: 1, sessionActions: 1, workflowDefinitions: 1 });

  await request(daemon, "/api/ui/config", {
    method: "PUT",
    body: { layout: "console", richText: true },
  });
  await request(daemon, `/api/personas/${desiredPersona.id}`, {
    method: "PATCH",
    body: { expectedRevision: desiredPersona.revision, guidanceMarkdown: "# Current reviewer\n\nThis must be replaced." },
  });
  await request(daemon, `/api/session-actions/${desiredAction.id}`, {
    method: "PATCH",
    body: { expectedRevision: desiredAction.revision, promptMarkdown: "# Current action\n\nThis must be replaced." },
  });
  await request(daemon, `/api/workflows/${desiredWorkflow.workflow.id}`, {
    method: "PATCH",
    body: { expectedDraftRevision: 1, description: "The current description must be replaced." },
  });
  await request(daemon, "/api/workflow-commands/lint", {
    method: "PUT",
    body: {
      expectedRevision: desiredCommand.revision,
      defaultCommand: ["npm", "run", "lint:current"],
      maxRuns: desiredCommand.maxRuns,
      overrides: [],
    },
  });

  const now = Date.now();
  withDaemonDb(daemon, (db) => {
    db.prepare(`
      INSERT INTO tasks (id, title, intent, kind, agent, repo_root, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("restore-operational-task", "Operational task", "Must survive restore", "ship", "codex", daemon.repo, "done", now, now);
    db.prepare(`
      INSERT INTO workflow_bindings (
        id, workflow_version_id, note_key, session_agent, session_name, repo_root,
        trigger_mode, delivery_mode, state, max_repair_rounds, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "restore-operational-binding",
      published.version.id,
      "restore:operational",
      "codex",
      "Operational session",
      "",
      "manual",
      "manual",
      "completed",
      2,
      now,
      now,
    );
    db.prepare(`
      INSERT INTO workflow_runs (
        id, binding_id, workflow_version_id, status, current_phase, max_repair_rounds,
        trigger_source, trigger_key, started_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "restore-operational-run",
      "restore-operational-binding",
      published.version.id,
      "completed",
      "completed",
      2,
      "manual",
      "restore-operational-trigger",
      now,
      now,
      now,
    );
  });

  const otherWindow = await dashboard.context().newPage();
  await otherWindow.goto(`${daemon.baseURL}/#/library/personas/new`);
  const unsavedName = otherWindow.getByLabel("Name", { exact: true });
  await unsavedName.fill("Unsaved draft in another window");

  await dashboard.goto(`${daemon.baseURL}/#/settings/restore`);
  await expect(dashboard.getByRole("heading", { name: "Restore", exact: true })).toBeVisible();
  await expect(dashboard.getByLabel("Automatic backup status")).toContainText("90 daily + 10 safety");
  const unavailable = dashboard.getByRole("radio", { name: /Select Unavailable snapshot/ });
  await expect(unavailable).toHaveCount(2);
  for (let index = 0; index < 2; index += 1) await expect(unavailable.nth(index)).toBeDisabled();
  await expect(dashboard.getByRole("table", { name: "Settings snapshots, newest first" })
    .getByRole("row").nth(1).getByRole("radio"))
    .toHaveAccessibleName(/Select Daily snapshot from/);
  await dashboard.getByText("2 unavailable snapshots", { exact: true }).click();
  await expect(dashboard.getByRole("listitem").filter({ hasText: /requires a newer Mission Control/ })).toBeVisible();
  await expect(dashboard.getByRole("listitem").filter({ hasText: /Snapshot JSON is invalid/ })).toBeVisible();

  await dashboard.getByRole("radio", { name: /Select Daily snapshot from/ }).check();
  await dashboard.getByRole("button", { name: "Preview restore" }).click();
  const verifiedPreview = dashboard.getByRole("heading", { name: "What this restore changes" });
  await expect(verifiedPreview).toBeVisible();
  await expect(dashboard.getByLabel("Restore sequence")).toContainText("Capture safety snapshot");
  await expect(dashboard.getByText("Workflow commands", { exact: true })).toBeVisible();
  await verifiedPreview.scrollIntoViewIfNeeded();
  await shoot(dashboard, "verified-preview");

  await dashboard.getByRole("button", { name: "Restore settings" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Confirm settings restore" });
  const confirmation = dialog.getByLabel(/Type RESTORE SETTINGS to continue/);
  await expect(confirmation).toBeFocused();
  const finalRestore = dialog.getByRole("button", { name: "Restore settings" });
  await confirmation.fill("restore settings");
  await expect(finalRestore).toBeDisabled();
  await confirmation.fill("RESTORE SETTINGS");
  await expect(finalRestore).toBeEnabled();
  await shoot(dashboard, "exact-confirmation");

  await Promise.all([
    dashboard.waitForEvent("load"),
    finalRestore.click(),
  ]);
  await expect(dashboard.getByRole("heading", { name: "Restore", exact: true })).toBeVisible();
  await expect(dashboard.getByRole("radio", { name: /Select Safety snapshot from/ })).toBeEnabled();

  const ui = await request<{ config: { layout: string; richText: boolean } }>(daemon, "/api/ui/config");
  expect(ui.config).toMatchObject({ layout: "board", richText: false });
  await expect.poll(async () => dashboard.evaluate(() => {
    const raw = localStorage.getItem("mission-control.ui");
    return raw ? JSON.parse(raw) as { layout?: string; richText?: boolean } : null;
  })).toMatchObject({ layout: "board", richText: false });

  const persona = await request<{ guidanceMarkdown: string }>(daemon, `/api/personas/${desiredPersona.id}`);
  expect(persona.guidanceMarkdown).toBe("# Snapshot reviewer\n\nUse the verified snapshot guidance.");
  const action = await request<{ promptMarkdown: string }>(daemon, `/api/session-actions/${desiredAction.id}`);
  expect(action.promptMarkdown).toBe("# Snapshot action\n\nRun the snapshot command.");
  const workflow = await request<{ workflow: { description: string } }>(daemon, `/api/workflows/${desiredWorkflow.workflow.id}`);
  expect(workflow.workflow.description).toBe("The workflow stored in the snapshot.");
  const command = await request<{ defaultCommand: string[] | null }>(daemon, "/api/workflow-commands/lint");
  expect(command.defaultCommand).toEqual(["npm", "run", "lint:snapshot"]);

  expect(withDaemonDb(daemon, (db) => ({
    task: db.prepare("SELECT title FROM tasks WHERE id = ?").get("restore-operational-task"),
    run: db.prepare(`
      SELECT r.status, v.id AS version_id
      FROM workflow_runs r
      JOIN workflow_versions v ON v.id = r.workflow_version_id
      WHERE r.id = ?
    `).get("restore-operational-run"),
  }))).toEqual({
    task: { title: "Operational task" },
    run: { status: "completed", version_id: published.version.id },
  });

  const notice = otherWindow.getByRole("status").filter({ hasText: "Settings were restored in another window" });
  await expect(notice).toBeVisible();
  await expect(notice.getByRole("button", { name: "Reload now" })).toBeVisible();
  await expect(unsavedName).toHaveValue("Unsaved draft in another window");
  await shoot(otherWindow, "other-window-notice");

  const backups = await request<BackupList>(daemon, "/api/settings-backups");
  expect(backups.snapshots.some((item) => item.id === snapshotId && item.status === "ready")).toBe(true);
  expect(backups.snapshots.some((item) => item.kind === "pre_restore" && item.status === "ready")).toBe(true);
  await otherWindow.close();
});
