import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";
import { gitIn, mkOriginAndClone, mkLinkedWorktree } from "./helpers/git-fixture.ts";

const home = mkdtempSync(join(tmpdir(), "mission-repo-change-retention-"));
process.env.MISSION_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { teardownWorktree, releasedTaskResources } = await import("../src/server/dispatcher.ts");
const { taskWorkEpisodeForTask, markWorkEpisodeMerged, recordWorkEpisodeRepoPr } = await import("../src/server/db.ts");
const roots: string[] = [];
const managers: InstanceType<typeof TaskManager>[] = [];
after(async () => {
  for (const manager of managers) { manager.stopMissionSessionClosures(); await manager.settleWorktreeReturns(); }
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

for (const secondaryChanged of [false, true]) {
  test(`cleanup retains fresh ${secondaryChanged ? "changed" : "unchanged"} secondary evidence after restart`, async () => {
    const primary = mkOriginAndClone("mission-retain-primary-");
    const secondary = mkOriginAndClone("mission-retain-secondary-");
    roots.push(primary.root, secondary.root);
    const path = mkLinkedWorktree(primary.clone, "feat/retain", join(primary.root, "tree"));
    const extraPath = mkLinkedWorktree(secondary.clone, "feat/retain", join(secondary.root, "tree"));
    const base = gitIn(path, "rev-parse", "HEAD");
    const extraBase = gitIn(extraPath, "rev-parse", "HEAD");
    const id = `retain-${secondaryChanged}`;
    const registry = new Registry();
    registry.applyDiscovery([{ syntheticId: id, agent: "claude", name: id, nameSource: "process", cwd: path,
      gitBranch: "feat/retain", gitRoot: primary.clone, repoRoot: primary.clone, pid: 100, tty: null,
      terminals: [], startedAt: 0 }]);
    registry.applyHook({ agent: "claude", event: "Stop", sessionId: `${id}-agent`, cwd: path, transcriptPath: null, env: {} });
    registry.upsertTask(mkTask({ id, status: "running", sessionId: id, repoRoot: primary.clone,
      branch: "feat/retain", worktreePath: path, provider: "git", baseSha: base, homeName: null,
      extraRepos: [{ repoRoot: secondary.clone, worktreePath: extraPath, branch: "feat/retain", provider: "git",
        worktreeLeaseId: null, baseSha: extraBase, prUrl: null, prState: null, mergedAt: null }] }));
    registry.bindTaskToWorkEpisode(id, id);
    const binding = taskWorkEpisodeForTask(id)!;
    registry.recordWorktreeHeads(new Map([[path, base], [extraPath, extraBase]]));
    const beforeCleanupPollTargets = registry.repoChangeEvidenceTargets();
    writeFileSync(join(path, "work.txt"), "primary work");
    gitIn(path, "add", "."); gitIn(path, "commit", "-qm", "primary work");
    if (secondaryChanged) {
      writeFileSync(join(extraPath, "work.txt"), "secondary work");
      gitIn(extraPath, "add", "."); gitIn(extraPath, "commit", "-qm", "secondary work");
    }
    const primaryUrl = `https://github.com/example/primary/pull/${secondaryChanged ? 1402 : 1401}`;
    registry.reconcilePrs(new Map([[id, { url: primaryUrl, number: 1401, state: "open", checks: null,
      branch: binding.branch!, episodeId: binding.episodeId, agentSessionId: binding.agentSessionId,
      createdAt: binding.boundAt, mergedAt: null, headSha: gitIn(path, "rev-parse", "HEAD"),
      worktreeHeadSha: gitIn(path, "rev-parse", "HEAD") }]]), new Set());
    registry.upsertTask(mkTask({ id: `${id}-dependent`, dependencies: [{ type: "task", taskId: id,
      title: "Prerequisite", sessionId: id, episodeId: binding.episodeId, agentSessionId: binding.agentSessionId,
      branch: binding.branch, prUrl: primaryUrl, selectedAt: 1, satisfiedAt: null }] }));
    registry.upsertTask({ ...registry.getTask(id)!, status: "done", outcome: "completed", completedAt: Date.now() });
    const source = registry.getTask(id)!;
    await teardownWorktree(source);
    assert.equal(existsSync(path), false); assert.equal(existsSync(extraPath), false);
    // A stale poll can finish after capture but before resource metadata is cleared.
    registry.recordWorktreeHeads(new Map([[path, base], [extraPath, extraBase]]), beforeCleanupPollTargets);
    registry.upsertTask({ ...source, ...releasedTaskResources(source, null) });
    const evidence = taskWorkEpisodeForTask(id)!.repoChanges!;
    assert.equal(evidence.find(v => v.repoRoot === secondary.clone)?.verdict, secondaryChanged ? "changed" : "unchanged");
    markWorkEpisodeMerged(id, binding.episodeId, primaryUrl, Date.now());
    const restarted = new Registry();
    const tasks = new TaskManager(restarted); managers.push(tasks);
    tasks.reconcileMergedTasks();
    const edge = () => restarted.getTask(`${id}-dependent`)!.dependencies[0]!;
    if (secondaryChanged) {
      assert.equal(edge().satisfiedAt, null, "a merged primary cannot hide the reclaimed secondary's changed work");
      const secondaryUrl = "https://github.com/example/secondary/pull/1403";
      recordWorkEpisodeRepoPr({ taskId: id, sessionId: id, episodeId: binding.episodeId, repoRoot: secondary.clone,
        prUrl: secondaryUrl, prState: "open", prHeadSha: "head" }, Date.now());
      markWorkEpisodeMerged(id, binding.episodeId, secondaryUrl, Date.now());
      tasks.reconcileMergedTasks();
    }
    assert.equal(typeof edge().satisfiedAt, "number");
    assert.equal(restarted.getTask(id)!.outcome, "completed");
  });
}
