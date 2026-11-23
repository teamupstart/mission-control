import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";
import type { PrMatch } from "../src/server/registry.ts";

// The hook bridge sniffs a PR URL out of ANY tool output, so `gh pr view 1304` used to
// decorate the card with #1304 exactly as `gh pr create` would. Only the session that OPENED
// a pull request may wear it. A resident is stricter still: its task has no repository, so
// the poller never visits it to confirm or retract a chip at all.
const home = realpathSync(mkdtempSync(join(tmpdir(), "resident-pr-chip-")));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { Registry } = await import("../src/server/registry.ts");

const URL = "https://github.com/owner/repo/pull/1304";

function hookFrom(sessionId: string, cwd: string, prCreated: boolean) {
  return {
    agent: "claude" as const,
    event: "PostToolUse",
    sessionId,
    cwd,
    transcriptPath: null,
    env: {},
    toolName: "Bash",
    prUrl: URL,
    prUrls: [URL],
    prCreated,
  };
}

test("a resident that reads or even opens a pull request is never decorated with it", () => {
  const registry = new Registry();
  const cwd = join(home, "residents", "runs", "r1", "workspace");
  const session = registry.registerSdkSession({
    id: "sdk:resident",
    agent: "claude",
    name: "Agent Shepherd",
    cwd,
    agentSessionId: "agent-resident",
  });
  registry.upsertTask(mkTask({
    id: "resident-task",
    kind: "resident",
    workspaceKind: "resident-workspace",
    status: "running",
    repoRoot: cwd,
    worktreePath: null,
    provider: null,
    homeName: null,
    sessionId: session.id,
  }));

  for (const prCreated of [false, true]) {
    registry.applyHook(hookFrom("agent-resident", cwd, prCreated));
    const card = registry.getSession(session.id)!;
    assert.equal(card.task?.kind, "resident", "the hook reached the resident's card");
    assert.equal(card.prUrl, null, `prCreated=${prCreated}: no chip`);
    assert.equal(card.prNumber, null);
    assert.equal(card.prState, null);
  }
});

test("a repository task is decorated only by the pull request it opened, never one it read", () => {
  const registry = new Registry();
  const cwd = join(home, "repo");
  const session = registry.registerSdkSession({
    id: "sdk:ship",
    agent: "claude",
    name: "Ship",
    cwd,
    agentSessionId: "agent-ship",
  });
  registry.upsertTask(mkTask({
    id: "ship-task",
    kind: "ship",
    status: "running",
    repoRoot: cwd,
    sessionId: session.id,
  }));

  registry.applyHook(hookFrom("agent-ship", cwd, false));
  assert.equal(registry.getSession(session.id)!.prUrl, null, "gh pr view: no chip");

  registry.applyHook(hookFrom("agent-ship", cwd, true));
  const card = registry.getSession(session.id)!;
  assert.equal(card.prUrl, URL);
  assert.equal(card.prNumber, 1304);
  assert.equal(card.prState, "open");
});

test("the PR poller cannot associate a pull request with a resident either", () => {
  const registry = new Registry();
  const cwd = join(home, "residents", "runs", "r2", "workspace");
  const session = registry.registerSdkSession({
    id: "sdk:resident-poll",
    agent: "claude",
    name: "Agent Shepherd",
    cwd,
    agentSessionId: "agent-resident-poll",
  });
  registry.upsertTask(mkTask({
    id: "resident-poll-task",
    kind: "resident",
    workspaceKind: "resident-workspace",
    status: "running",
    repoRoot: cwd,
    worktreePath: null,
    provider: null,
    homeName: null,
    sessionId: session.id,
  }));

  // Both poller entry points: the resident is never a poll target, and even a match handed
  // straight to the reconciler for it is ignored rather than written onto the card.
  assert.equal(registry.prPollTargets().some((t) => t.id === session.id), false);
  const match: PrMatch = {
    url: URL,
    number: 1304,
    state: "open",
    checks: "passing",
    branch: "feat/someone-else",
    agentSessionId: "agent-resident-poll",
    episodeId: registry.workEpisodeForSession(session.id)?.episodeId ?? null,
    createdAt: Date.now(),
    mergedAt: null,
    headSha: "head",
    worktreeHeadSha: "head",
  };
  registry.reconcilePrs(new Map([[session.id, match]]), new Set());
  assert.equal(registry.getSession(session.id)!.prUrl, null);
});
