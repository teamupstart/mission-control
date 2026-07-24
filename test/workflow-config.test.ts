import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoAllowlisted } from "../src/shared/allowlist.ts";
import { DEFAULT_WORKFLOW_CONFIG } from "../src/shared/workflow.ts";

const home = mkdtempSync(join(tmpdir(), "mission-workflow-config-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { getWorkflowConfig, setWorkflowConfig } = await import("../src/server/workflows/config.ts");
const { resolveRepoRoot } = await import("../src/server/repos.ts");

test("workflow live consent defaults off and parsed writes replace the allowlist", () => {
  assert.deepEqual(getWorkflowConfig(), DEFAULT_WORKFLOW_CONFIG);
  assert.deepEqual(
    setWorkflowConfig({ liveEnabled: true, repoAllowlist: ["/repo"] }),
    { ...DEFAULT_WORKFLOW_CONFIG, liveEnabled: true, repoAllowlist: ["/repo"] },
  );
  assert.deepEqual(
    setWorkflowConfig({ liveEnabled: false, repoAllowlist: [] }),
    DEFAULT_WORKFLOW_CONFIG,
  );
  assert.throws(() => setWorkflowConfig({ liveEnabled: true, repoAllowlist: [""] }));
});

test("workflow config HTTP writes use the shared parser and replace the complete object", async () => {
  const { Registry } = await import("../src/server/registry.ts");
  const { ReviewManager } = await import("../src/server/reviews.ts");
  const { TaskManager } = await import("../src/server/tasks.ts");
  const { QueueManager } = await import("../src/server/queue.ts");
  const { buildApp } = await import("../src/server/routes.ts");
  const registry = new Registry();
  const app = buildApp(
    registry,
    new ReviewManager(registry),
    new TaskManager(registry),
    new QueueManager(registry),
  );
  const invalid = await app.request("/api/workflows/config", {
    method: "PUT",
    headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
    body: JSON.stringify({ liveEnabled: "yes", repoAllowlist: [] }),
  });
  assert.equal(invalid.status, 400);
  const written = await app.request("/api/workflows/config", {
    method: "PUT",
    headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
    body: JSON.stringify({ liveEnabled: true, repoAllowlist: ["/one", "/two"] }),
  });
  assert.equal(written.status, 200);
  assert.deepEqual(await written.json(), {
    ...DEFAULT_WORKFLOW_CONFIG,
    liveEnabled: true,
    repoAllowlist: ["/one", "/two"],
  });
  assert.deepEqual(
    await (await app.request("/api/workflows/config", {
      headers: { host: "127.0.0.1:7317" },
    })).json(),
    { ...DEFAULT_WORKFLOW_CONFIG, liveEnabled: true, repoAllowlist: ["/one", "/two"] },
  );
});

test("canonical repo roots allow linked worktree identity but reject path-prefix lookalikes", async () => {
  const repo = join(home, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  const canonical = await resolveRepoRoot(repo);
  const realRepo = realpathSync(repo);
  assert.equal(canonical, realRepo);
  assert.equal(repoAllowlisted(join(home, "worktree", "pkg"), canonical, [realRepo]), true);
  assert.equal(repoAllowlisted(`${realRepo}-unrelated`, `${realRepo}-unrelated`, [realRepo]), false);
  assert.equal(repoAllowlisted(join(realRepo, "pkg"), realRepo, [realRepo]), true);
});

test("removing consent leaves no live authorization", () => {
  const config = setWorkflowConfig({ liveEnabled: true, repoAllowlist: ["/repo"] });
  assert.equal(config.liveEnabled && repoAllowlisted("/repo/pkg", "/repo", config.repoAllowlist), true);
  const removed = setWorkflowConfig({ liveEnabled: true, repoAllowlist: [] });
  assert.equal(removed.liveEnabled && repoAllowlisted("/repo/pkg", "/repo", removed.repoAllowlist), false);
});
