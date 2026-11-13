import assert from "node:assert/strict";
import test from "node:test";

import { matchesRestoringFilter, matchesSessionFilter } from "../src/web/lib/fleet-filter.ts";
import type { RestoringSession, Session } from "../src/shared/types.ts";
import { mkSession } from "./helpers/session-fixture.ts";

test("a session matches the visible pull-request label", () => {
  const session = mkSession({
    prUrl: "https://github.com/acme/mission-control/pull/864",
    prNumber: 864,
    prState: "open",
  });

  assert.equal(matchesSessionFilter(session, "864"), true);
  assert.equal(matchesSessionFilter(session, "#864"), true);
  assert.equal(matchesSessionFilter(session, "pr #864"), true);
  assert.equal(matchesSessionFilter(session, "865"), false);
});

test("a PR number without a visible pull-request card does not match", () => {
  const session = mkSession({ prUrl: null, prNumber: 864, prState: null });

  assert.equal(matchesSessionFilter(session, "864"), false);
});

test("title, displayed status, and agent remain searchable", () => {
  const session = mkSession({ name: "Console filters", state: "idle", agent: "codex" });

  assert.equal(matchesSessionFilter(session, "console"), true);
  assert.equal(matchesSessionFilter(session, "idle"), true);
  assert.equal(matchesSessionFilter(session, "codex"), true);
});

test("every fact on a session card is searchable", () => {
  const session = mkSession({
    name: "Ship the search fix",
    agent: "claude",
    repoRoot: "/Users/op/workspace/mission-control",
    gitBranch: "feat/card-search",
    permissionMode: "plan",
    goal: { text: "Broaden the nav-bar search" } as Session["goal"],
    meta: {
      model: "Opus 5.5",
      modelId: "claude-opus-5-5",
      longContext: false,
      thinkingLevel: "high",
      thinkingEnabled: true,
      contextPct: 42,
      contextTokens: null,
      contextWindow: null,
      source: "transcript",
      updatedAt: 0,
    } as Session["meta"],
    blocker: { kind: "dependency", reason: "Needs the schema PR", waitingOn: "platform team" } as Session["blocker"],
  });

  for (const query of [
    "mission-control", // repository
    "card-search", // branch
    "opus", // model label
    "claude-opus-5-5", // model id
    "high", // effort
    "plan", // permission mode
    "nav-bar", // goal
    "dependency", // blocker kind
    "schema", // blocker reason
    "platform", // blocker waiting on
    "claude code", // agent's product name
  ]) {
    assert.equal(matchesSessionFilter(session, query), true, query);
  }
});

test("every query word must appear, each in any field", () => {
  const session = mkSession({ name: "Ship the search fix", repoRoot: "/w/mission-control", agent: "codex" });

  assert.equal(matchesSessionFilter(session, "codex mission-control"), true);
  assert.equal(matchesSessionFilter(session, "search codex"), true);
  assert.equal(matchesSessionFilter(session, "codex ghostty"), false);
});

test("the context meter, cost, last-seen time and full paths are searchable", () => {
  const session = mkSession({
    name: "Busy card",
    repoRoot: "/Users/op/workspace/mission-control",
    lastActivity: Date.now() - 5 * 60_000,
    meta: { model: "Opus", contextPct: 42 } as Session["meta"],
    cost: { costUsd: 2.5, input: 10, cacheRead: 0, cacheWrite: 0, output: 10 } as Session["cost"],
  });

  assert.equal(matchesSessionFilter(session, "42%"), true, "the context meter");
  assert.equal(matchesSessionFilter(session, "$2.50"), true, "the cost chip");
  assert.equal(matchesSessionFilter(session, "5m ago"), true, "the last-seen cell");
  assert.equal(matchesSessionFilter(session, "/users/op/workspace"), true, "the full path on hover");
});

test("the live activity ticker is the one thing not searched", () => {
  const session = mkSession({ name: "Quiet card", activity: "running Bash" });

  assert.equal(matchesSessionFilter(session, "bash"), false);
});

test("an Agent SDK session matches its runtime chip", () => {
  const session = mkSession({ name: "Embedded", runtime: "sdk", nameSource: "sdk", gitBranch: null });

  assert.equal(matchesSessionFilter(session, "agent sdk"), true);
});

test("a session with no repository matches the foot's \"no repository\" text", () => {
  const task = { kind: "resident", workspaceKind: "resident-workspace" } as NonNullable<Session["task"]>;
  const without = mkSession({ name: "Resident", gitBranch: null, task });
  const withRepo = mkSession({ name: "Resident", gitBranch: null, task: { ...task, kind: "ship" } });

  assert.equal(matchesSessionFilter(without, "no repository"), true);
  assert.equal(matchesSessionFilter(withRepo, "no repository"), false, "only the fallback prints it");
  // The foot prints "no repository" instead of the branch whenever the task has none, so a
  // branch does not change the answer; and a session with no task never prints it.
  const withBranch = mkSession({ name: "Resident", gitBranch: "feat/x", task });
  assert.equal(matchesSessionFilter(withBranch, "no repository"), true, "a branch does not replace the text");
  const noTask = mkSession({ name: "Loose", gitBranch: null, task: null });
  assert.equal(matchesSessionFilter(noTask, "no repository"), false, "no task, no fallback text");
});

test("the checkout path, an unpriced token chip and the started-time fallback are searchable", () => {
  const session = mkSession({
    name: "Fallback card",
    repoRoot: null,
    gitRoot: null,
    workspaceRoot: "/Users/op/.pool/7/checkout-leaf",
    lastActivity: null,
    startedAt: Date.now() - 3 * 60_000,
    cost: { costUsd: null, input: 12_000, cacheRead: 0, cacheWrite: 0, output: 3_000 } as Session["cost"],
  });

  assert.equal(matchesSessionFilter(session, "checkout-leaf"), true, "the worktree pill's leaf");
  assert.equal(matchesSessionFilter(session, "/users/op/.pool/7"), true, "the worktree tooltip's full path");
  assert.equal(matchesSessionFilter(session, "15k tok"), true, "the unpriced token-only cost chip");
  assert.equal(matchesSessionFilter(session, "up 3m"), true, "the started-time fallback in the foot");
});

test("a restoring row matches every word across its name, status and agent", () => {
  const row = { id: "r1", agent: "codex", name: "Rebuild the index", cwd: "/w/x", repoRoot: null } as RestoringSession;

  assert.equal(matchesRestoringFilter(row, "rebuild restoring codex"), true);
  assert.equal(matchesRestoringFilter(row, "restoring"), true);
  assert.equal(matchesRestoringFilter(row, "rebuild zebra"), false, "one absent word hides it");
});

test("the permission-mode chip is searched with the text it prints, when it is drawn", () => {
  const auto = mkSession({ name: "Mode card", agent: "claude", permissionMode: "auto" });
  const unobserved = mkSession({ name: "Mode card", agent: "claude", permissionMode: null });

  assert.equal(matchesSessionFilter(auto, "auto"), true, "the mode chip's label");
  assert.equal(matchesSessionFilter(unobserved, "permissions"), true, "the not-yet-observed placeholder");
  assert.equal(matchesSessionFilter(unobserved, "auto"), false);
});
