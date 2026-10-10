// Attributed APIs must neither fall back to cwd guesses nor let an agent name another owner.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, realpathSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkTask } from "./helpers/session-fixture.ts";

const home = mkdtempSync(join(tmpdir(), "mission-plan-routes-"));
process.env.MISSION_HOME = join(home, "state");
const { Registry } = await import("../src/server/registry.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const { openDb, closeDb } = await import("../src/server/db.ts");
const { readPlanRevision, readPlanFile } = await import("../src/server/plans/store.ts");
const { gitInfo } = await import("../src/server/util/git.ts");
after(() => { closeDb(); rmSync(home, { recursive: true, force: true }); });

for (const linked of [false, true]) {
  test(`taskless sessions in a ${linked ? "linked worktree" : "repository"} subdirectory save at the checkout root`, async () => {
    const root = realpathSync(mkdtempSync(join(home, "subdirectory-")));
    const owner = join(root, "owner");
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
    mkdirSync(owner);
    git(owner, "init", "-q", "-b", "main");
    git(owner, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial", "--allow-empty");
    const checkout = linked ? join(root, "worktree") : owner;
    if (linked) git(owner, "worktree", "add", "--detach", checkout);
    const cwd = join(checkout, "packages", "web");
    mkdirSync(cwd, { recursive: true });
    const info = gitInfo(cwd);
    assert.equal(info.root, checkout);
    assert.equal(info.repoRoot, owner);
    const id = randomUUID();
    const registry = new Registry();
    registry.applyDiscovery([{ syntheticId: id, agent: "claude", name: "plan", nameSource: "process", cwd, gitBranch: info.branch, gitRoot: info.root, repoRoot: info.repoRoot, pid: 100, tty: null, terminals: [], startedAt: 1 }]);
    assert.equal(registry.taskForSession(id, cwd), undefined);
    const tasks = new TaskManager(registry);
    const app = buildApp({ registry, tasks, reviews: new ReviewManager(registry), queues: new QueueManager(registry) });
    try {
      const request = (operation: string, input: object) => app.request(`/mcp/plans/${operation}`, {
        method: "POST", headers: { "content-type": "application/json", "x-harness-token": ensureToken() },
        body: JSON.stringify({ env: {}, sessionId: id, cwd, ...input }),
      });
      const payload = { repoSlot: "repo-01", requestId: randomUUID(), slug: "subdirectory-plan", expectedRevision: 0, files: [{ name: "plan.md", content: "# Rooted plan" }, { name: "plan.html", content: "<h1>Rooted plan</h1>" }] };
      const response = await request("save", payload);
      assert.equal(response.status, 200, await response.clone().text());
      const saved = await response.json();
      assert.deepEqual(saved.requiredPaths, ["docs/plans/subdirectory-plan/plan.md"]);
      assert.equal(readFileSync(join(checkout, saved.requiredPaths[0]), "utf8"), "# Rooted plan");
      assert.equal(existsSync(join(cwd, "docs")), false);
      if (linked) assert.equal(existsSync(join(owner, "docs")), false);
      git(checkout, "add", ".");
      assert.deepEqual(git(checkout, "diff", "--cached", "--name-only").split("\n"), saved.requiredPaths);
      const context = await request("context", { repoSlot: "repo-01" });
      assert.equal(context.status, 200, await context.clone().text());
      const locations = await context.json();
      assert.equal(locations.checkoutRoot, checkout);
      assert.equal(locations.repoRoot, owner);
      const preview = await request("read", { input: { repoSlot: "repo-01", planId: saved.manifest.planId, revision: 1, file: "plan.html" } });
      assert.equal(preview.status, 200, await preview.clone().text());
    } finally { await tasks.stop(); }
  });
}

test("HTTP save accepts an escaped 8 MiB bundle and refuses bodies beyond the transport limit", async () => {
  const cwd = realpathSync(mkdtempSync(join(home, "escaped-bundle-")));
  execFileSync("git", ["init", "-q", cwd]);
  const id = randomUUID();
  const registry = new Registry();
  registry.applyDiscovery([{ syntheticId: id, agent: "claude", name: "plan", nameSource: "process", cwd, gitBranch: "main", gitRoot: cwd, repoRoot: cwd, pid: 100, tty: null, terminals: [], startedAt: 1 }]);
  const tasks = new TaskManager(registry);
  const app = buildApp({ registry, tasks, reviews: new ReviewManager(registry), queues: new QueueManager(registry) });
  try {
    // Controls require six JSON bytes each; quotes and backslashes require two.
    const escapedText = (bytes: number) => "\u0001".repeat(bytes - 2) + '"\\';
    const files = [{ name: "plan.md", content: escapedText(1024 * 1024) }, { name: "plan.html", content: "<h1>Plan</h1>" }];
    files.push(...Array.from({ length: 6 }, (_, i) => ({ name: `review-${i}.txt`, content: escapedText(1024 * 1024) })));
    files.push({ name: "remainder.txt", content: escapedText(1024 * 1024 - Buffer.byteLength(files[1]!.content)) });
    assert.equal(files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0), 8 * 1024 * 1024);
    assert.ok(files.every((file) => Buffer.byteLength(file.content) <= 1024 * 1024));
    const payload = { env: {}, sessionId: id, cwd, repoSlot: "repo-01", requestId: randomUUID(), slug: "escaped-bundle", expectedRevision: 0, files };
    const encoded = JSON.stringify(payload);
    assert.ok(Buffer.byteLength(encoded) > 47 * 1024 * 1024, "valid content can expand well beyond the old 10 MiB HTTP cap");
    const transportLimit = 49 * 1024 * 1024;
    const body = encoded + " ".repeat(transportLimit - Buffer.byteLength(encoded));
    assert.equal(Buffer.byteLength(body), transportLimit);
    const headers = { "content-type": "application/json", "x-harness-token": ensureToken() };
    const response = await app.request("/mcp/plans/save", { method: "POST", headers, body });
    assert.equal(response.status, 200, await response.clone().text());
    const saved = await response.json();
    assert.deepEqual(readPlanRevision(saved.manifest.planId, 1), saved, "the HTTP save became ready");
    assert.deepEqual(saved.requiredPaths, ["docs/plans/escaped-bundle/plan.md"]);
    assert.equal(readFileSync(join(cwd, saved.requiredPaths[0]), "utf8"), files[0]!.content);
    assert.equal(existsSync(join(cwd, "docs/plans/escaped-bundle/plan.html")), false);
    for (const file of files) assert.equal(readPlanFile(saved.manifest.planId, 1, file.name).toString("utf8"), file.content);

    for (const contentLength of [false, true]) {
      const requestId = randomUUID(), slug = `too-large-${contentLength}`;
      const rejected = JSON.stringify({ ...payload, requestId, slug });
      // Valid JSON and valid decoded content, but one transport byte beyond the cap.
      const oversized = rejected + " ".repeat(transportLimit + 1 - Buffer.byteLength(rejected));
      assert.equal(Buffer.byteLength(oversized), transportLimit + 1);
      const refusal = await app.request("/mcp/plans/save", { method: "POST", headers: { ...headers, ...(contentLength ? { "content-length": String(Buffer.byteLength(oversized)) } : {}) }, body: oversized });
      assert.equal(refusal.status, 413);
      assert.deepEqual(await refusal.json(), { error: "Plan request is too large" });
      assert.equal(openDb().prepare("SELECT * FROM managed_plan_revisions WHERE request_id = ?").get(requestId), undefined);
      assert.equal(openDb().prepare("SELECT * FROM managed_plans WHERE slug = ?").get(slug), undefined);
      assert.equal(existsSync(join(cwd, "docs/plans", slug)), false);
    }
    assert.deepEqual(readPlanRevision(saved.manifest.planId, 1), saved, "refused requests preserve the earlier ready revision");
    assert.equal(readFileSync(join(cwd, saved.requiredPaths[0]), "utf8"), files[0]!.content);
  } finally { await tasks.stop(); }
});

test("registered sessions save in issued repository slots and read only their exact revisions", async () => {
  const repos = ["primary", "attached", "unrelated"].map((name) => {
    const dir = join(home, name); mkdirSync(dir);
    execFileSync("git", ["init", "-q", dir]); return dir;
  });
  const registry = new Registry();
  registry.applyDiscovery(repos.map((cwd, i) => ({ syntheticId: `plan-owner-${i}`, agent: "claude" as const, name: "plan", nameSource: "process" as const, cwd, gitBranch: "main", gitRoot: cwd, repoRoot: cwd, pid: i + 10, tty: null, terminals: [], startedAt: 1 })));
  const tasks = new TaskManager(registry);
  const app = buildApp({ registry, tasks, reviews: new ReviewManager(registry), queues: new QueueManager(registry) });
  try {
    const id = "plan-owner-0";
    registry.upsertTask(mkTask({ id: randomUUID(), sessionId: id, status: "running", kind: "ship", repoRoot: repos[0]!, worktreePath: repos[0]!, extraRepos: [{ repoRoot: repos[1]!, worktreePath: repos[1]!, branch: null, baseSha: null, provider: "git", worktreeLeaseId: null, prUrl: null, prState: null, mergedAt: null }] }));
    const identity = { env: {}, sessionId: id, cwd: repos[0] };
    const request = (operation: string, input: object, token = true) => app.request(`/mcp/plans/${operation}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-harness-token": ensureToken() } : {}) }, body: JSON.stringify({ ...identity, ...input }) });
    assert.equal((await request("context", {}, false)).status, 401);
    assert.equal((await request("context", { sessionId: "missing", cwd: null })).status, 403);
    assert.equal((await request("context", { repoSlot: "repo-99" })).status, 403);
    assert.equal((await request("context", { repoRoot: repos[2] })).status, 400);
    const context = await request("context", { repoSlot: "repo-02" });
    assert.equal(context.status, 200, await context.clone().text());
    assert.equal((await context.json()).checkoutRoot, repos[1]);
    const payload = { repoSlot: "repo-02", requestId: randomUUID(), slug: "attached-plan", expectedRevision: 0, files: [{ name: "plan.md", content: "# Attached" }, { name: "plan.html", content: "<h1>Attached</h1>" }] };
    assert.equal((await request("save", { ...payload, policy: { storage: "local" } })).status, 400);
    const response = await request("save", payload);
    assert.equal(response.status, 200, await response.clone().text());
    const saved = await response.json();
    const discover = (query = "") => app.request(`/api/sessions/${id}/plans${query}`, { headers: { host: "127.0.0.1:7317" } });
    const attached = await discover("?repoSlot=repo-02");
    assert.equal(attached.status, 200, await attached.clone().text());
    assert.deepEqual(await attached.json(), [saved], "Files offers the attached slot's exact saved revision");
    assert.deepEqual(await (await discover("?repoSlot=repo-01")).json(), []);
    assert.equal((await discover("?repoSlot=repo-99")).status, 403);
    const allSlots = await discover();
    assert.equal(allSlots.status, 200, await allSlots.clone().text());
    assert.deepEqual(await allSlots.json(), [saved], "the unfiltered Files request includes attached repositories");
    assert.deepEqual(await (await app.request("/api/sessions/plan-owner-2/plans", { headers: { host: "127.0.0.1:7317" } })).json(), []);
    const read = { planId: saved.manifest.planId, revision: 1, file: "plan.md" };
    assert.equal((await request("read", { input: { ...read, repoSlot: "repo-01" } })).status, 403);
    assert.equal((await request("read", { input: { ...read, repoSlot: "repo-02" } })).status, 200);
    assert.equal((await request("read", { input: { planId: read.planId, repoSlot: "repo-02" } })).status, 400);
    assert.equal((await request("read", { input: { ...read, repoSlot: "repo-02", revision: 2 } })).status, 404);
    const attachment = await app.request(`/api/plans/${read.planId}/1/files/plan.html`, { headers: { host: "127.0.0.1:7317" } });
    assert.equal(attachment.status, 200);
    assert.equal(attachment.headers.get("Content-Disposition"), "attachment");
    assert.match(attachment.headers.get("Content-Security-Policy")!, /sandbox/);
    assert.equal(await attachment.text(), "<h1>Attached</h1>");
  } finally { await tasks.stop(); }
});
