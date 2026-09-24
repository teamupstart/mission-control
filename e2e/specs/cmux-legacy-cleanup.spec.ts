import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../fixtures/test.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { Task } from "../../src/shared/types.ts";

test.use({ daemonEnv: { MC_E2E_CMUX_MODE: "renamed-home" } });

test("repeated Clean up preserves a legacy cmux task's checkout when its home was renamed", async ({ dashboard, daemon }) => {
  const title = "Legacy cmux work to preserve";
  const filed = await fetch(`${daemon.baseURL}/api/tasks`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ repoRoot: daemon.repo, title, intent: title, backlog: true, workflowId: null }),
  });
  expect(filed.ok).toBe(true);
  const { id } = await filed.json() as Task;
  const worktree = join(daemon.home, "legacy-cmux-worktree");
  execFileSync("git", ["-C", daemon.repo, "worktree", "add", "-qb", "legacy-cmux-task", worktree]);
  const unfinished = join(worktree, "unfinished.txt");
  writeFileSync(unfinished, "Uncommitted work must survive an unidentified terminal.\n");

  await daemon.crash();
  // Seed a pre-identity task row, which a current dispatch no longer creates. The
  // actual cleanup route, adapter inventory, worktree release and browser stay real.
  withDaemonDb(daemon, (db) => {
    db.prepare(`UPDATE tasks SET status = 'failed', completed_at = ?, worktree_path = ?,
      branch = 'legacy-cmux-task', provider = 'git', home_name = 'Original home',
      home_backend = 'cmux', terminal_resource_id = NULL WHERE id = ?`)
      .run(Date.now(), worktree, id);
  });
  await daemon.restart();
  await dashboard.reload();
  await dashboard.keyboard.press("Shift+P");
  const sitrep = dashboard.getByRole("dialog", { name: "Sitrep" });
  await expectContentClearsBorder(sitrep);
  const row = sitrep.locator(".report-row", { hasText: title });
  for (let attempt = 0; attempt < 2; attempt++) {
    // Each attempt has an arming click and a confirming click. Only confirmation
    // sends the request, and it must settle before the next attempt starts.
    await row.getByRole("button", { name: "Clean up" }).click();
    const confirmation = row.getByText("reclaim worktree & stop agent?");
    await expect(confirmation).toBeVisible();
    const response = dashboard.waitForResponse(r => r.url().endsWith(`/api/tasks/${id}/reclaim`) && r.request().method() === "POST");
    await row.getByRole("button", { name: "Clean up" }).click();
    const rejected = await response;
    expect(rejected.ok()).toBe(false);
    expect((await rejected.json()).error).toMatch(/terminal identity.*unknown/);
    await expect(confirmation).toBeHidden();
    await expect(row.getByRole("button", { name: "Clean up" })).toBeVisible();
  }
  const current = (await (await fetch(`${daemon.baseURL}/api/tasks`)).json() as Task[]).find(t => t.id === id)!;
  expect(current.worktreePath).toBe(worktree);
  expect(current.homeName).toBe("Original home");
  expect(existsSync(unfinished)).toBe(true);
  expect(readFileSync(unfinished, "utf8")).toContain("Uncommitted work must survive");
  const calls = readdirSync(daemon.recordDir).filter(name => name.startsWith("cmux-")).map(name =>
    JSON.parse(readFileSync(join(daemon.recordDir, name), "utf8")) as { argv: string[] });
  expect(calls.some(call => call.argv[0] === "close-workspace")).toBe(false);
  if (process.env.MC_E2E_EVIDENCE) {
    const evidence = artifactsDir("cmux-legacy-cleanup");
    mkdirSync(evidence, { recursive: true });
    await dashboard.screenshot({ path: join(evidence, "checkout-preserved.png"), fullPage: true });
  }
});
