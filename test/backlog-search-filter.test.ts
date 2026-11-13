import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_BACKLOG_FILTER,
  backlogFacetCount,
  backlogFacetCounts,
  backlogFilterActive,
  matchesBacklogFilter,
  matchesBacklogSearch,
  searchHighlights,
  toggleFacet,
  DEP_FACETS,
  type BacklogFilter,
  type BacklogFilterSubject,
} from "../src/web/lib/backlog-filter.ts";
import { mkTask } from "./helpers/session-fixture.ts";

const subject = (title: string, over: Partial<ReturnType<typeof mkTask>> = {}, blocked = false): BacklogFilterSubject => ({
  task: mkTask({ title, intent: `Intent for ${title}`, ...over }),
  blocked,
});

const backlog = [
  subject("Fix GitHub auth refresh", { enabled: true }),
  subject("Rotate Codex auth token", { enabled: false }),
  subject("Build on the auth fix", { enabled: true }, true),
  subject("Tidy changelog", { enabled: false, labels: ["docs"] }, true),
];

const shown = (filter: Partial<BacklogFilter>): string[] =>
  backlog
    .filter((s) => matchesBacklogFilter(s, { ...EMPTY_BACKLOG_FILTER, ...filter }))
    .map((s) => s.task.title);

test("an empty filter keeps every task and is not active", () => {
  assert.equal(backlogFilterActive(EMPTY_BACKLOG_FILTER), false);
  assert.equal(backlogFilterActive({ ...EMPTY_BACKLOG_FILTER, query: "   " }), false);
  assert.equal(shown({}).length, 4);
});

test("search matches every word across title, intent, labels and repository name", () => {
  const task = mkTask({ title: "Rotate token", intent: "Codex needs a fresh one", labels: ["Security"], repoRoot: "/w/mission-control" });
  assert.equal(matchesBacklogSearch(task, "ROTATE codex"), true);
  assert.equal(matchesBacklogSearch(task, "security"), true);
  assert.equal(matchesBacklogSearch(task, "mission-control"), true);
  assert.equal(matchesBacklogSearch(task, "rotate github"), false, "every word must match");
  // The repository's parent path is not part of the name a person searches by.
  assert.equal(matchesBacklogSearch(task, "/w/"), false);
});

test("facets OR within a facet and AND across facets", () => {
  assert.deepEqual(shown({ deps: ["ready"] }), ["Fix GitHub auth refresh", "Rotate Codex auth token"]);
  assert.deepEqual(shown({ deps: ["blocked"] }), ["Build on the auth fix", "Tidy changelog"]);
  assert.equal(shown({ deps: ["ready", "blocked"] }).length, 4);
  assert.deepEqual(shown({ autopilot: ["off"] }), ["Rotate Codex auth token", "Tidy changelog"]);
  assert.deepEqual(shown({ deps: ["blocked"], autopilot: ["off"] }), ["Tidy changelog"]);
  assert.deepEqual(shown({ deps: ["ready"], autopilot: ["on"], query: "auth" }), ["Fix GitHub auth refresh"]);
});

test("each facet's counts apply the search and the other facet, never their own", () => {
  const counts = backlogFacetCounts(backlog, { ...EMPTY_BACKLOG_FILTER, deps: ["ready"], query: "auth" });
  // Search "auth" leaves three. Dependency counts ignore their own "ready" selection.
  assert.equal(counts.ready, 2);
  assert.equal(counts.blocked, 1);
  // Autopilot counts honour the "ready" selection.
  assert.equal(counts.on, 1);
  assert.equal(counts.off, 1);
});

test("toggling a facet keeps its declared order, and the badge counts checked values", () => {
  assert.deepEqual(toggleFacet(["blocked"], "ready", DEP_FACETS), ["ready", "blocked"]);
  assert.deepEqual(toggleFacet(["ready", "blocked"], "ready", DEP_FACETS), ["blocked"]);
  assert.equal(backlogFacetCount({ query: "x", deps: ["ready"], autopilot: ["on", "off"] }), 3);
});

test("search highlights mark every occurrence of every word, case-insensitively", () => {
  assert.deepEqual(searchHighlights("Auth then auth", "AUTH"), [
    { text: "Auth", hit: true },
    { text: " then ", hit: false },
    { text: "auth", hit: true },
  ]);
  assert.deepEqual(searchHighlights("Plain", ""), [{ text: "Plain", hit: false }]);
});
