import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { openDb, getInspectorPr, loadOpenInspectorPrs, updateInspectorPr } from "../src/server/db.ts";
import { adoptPr } from "../src/server/inspector/worker.ts";
import { parsePrUrl } from "../src/server/inspector/github.ts";
import { getInspectorConfig, setInspectorConfig } from "../src/server/inspector/config.ts";

// A row in `inspector_prs` IS the permission to write on someone's pull request. Nothing
// else grants it: the tick only ever iterates this table, so whatever gets in here is
// what the Inspector will comment on.
//
// Which makes adoption the highest-stakes decision in the feature, and the failure mode
// asymmetric in a way worth being blunt about. Failing to adopt costs one uninspected
// PR, privately. Adopting wrongly posts automated review comments on a stranger's pull
// request, publicly, under the operator's name.

beforeEach(() => {
  openDb().exec("DELETE FROM inspector_prs; DELETE FROM inspector_comments; DELETE FROM app_config");
});

const URL_1 = "https://github.com/mancej/ai-harness/pull/56";
const CTX = { sessionId: "s1", cwd: "/wt/a", repoRoot: "/repo/a" };

test("adopting records the PR under a key that survives clones and worktrees", () => {
  assert.equal(adoptPr(URL_1, CTX, "hook", 1000), true);
  const row = getInspectorPr("mancej/ai-harness#56");
  assert.equal(row?.url, URL_1);
  assert.equal(row?.owner, "mancej");
  assert.equal(row?.repo, "ai-harness");
  assert.equal(row?.number, 56);
  assert.equal(row?.state, "open");
  assert.equal(row?.source, "hook");
  // Nothing reviewed yet - and crucially headSha is null, so the first tick reviews
  // rather than deciding it has already seen this head.
  assert.equal(row?.headSha, null);
  assert.equal(row?.round, 0);
});

// Both signals call this freely, from different places, on different schedules. The
// second one to arrive must be a no-op rather than a re-adoption: rewriting the row would
// reset `head_sha` and make the Inspector review the whole PR again from scratch, posting
// duplicates of everything it had already said.
test("adopting twice is a no-op, whichever signal gets there second", () => {
  assert.equal(adoptPr(URL_1, CTX, "hook", 1000), true);
  updateInspectorPr("mancej/ai-harness#56", { headSha: "abc123", round: 4 }, 2000);

  assert.equal(adoptPr(URL_1, CTX, "no-mistakes", 3000), false, "second adoption is a no-op");
  const row = getInspectorPr("mancej/ai-harness#56");
  assert.equal(row?.headSha, "abc123", "progress must survive a re-sighting");
  assert.equal(row?.round, 4);
  assert.equal(row?.source, "hook", "provenance is a fact about the past");
});

// The loose `prUrl` sniff matches any PR link in any Bash output - `gh pr view` trips it,
// so does `cat notes.md`. It reaches `adoptPr` only when `prCreated` is also set, and
// this is the other half of that: nothing here adopts on its own.
test("a URL that isn't a pull request adopts nothing", () => {
  for (const bad of [
    "https://github.com/mancej/ai-harness",
    "https://github.com/mancej/ai-harness/pull/",
    "https://github.com/mancej/ai-harness/issues/56",
    "https://github.com/mancej/ai-harness/compare/main...x",
    "https://evil.test/mancej/ai-harness/pull/56",
    "http://github.com/mancej/ai-harness/pull/56", // not https
    "not a url at all",
    "",
  ]) {
    assert.equal(adoptPr(bad, CTX, "hook", 1000), false, `should not adopt: ${bad}`);
  }
  assert.equal(loadOpenInspectorPrs().length, 0);
});

test("a host that merely ends in github.com is not github.com", () => {
  // The anchor on the URL pattern is what stops this; a `.includes("github.com")` would
  // adopt it and then run `gh` against a repo path an attacker chose.
  assert.equal(parsePrUrl("https://notgithub.com/o/r/pull/1"), null);
  assert.equal(parsePrUrl("https://github.com.evil.test/o/r/pull/1"), null);
});

test("only open PRs are handed to the tick", () => {
  adoptPr(URL_1, CTX, "hook", 1000);
  adoptPr("https://github.com/mancej/ai-harness/pull/57", CTX, "hook", 1000);
  updateInspectorPr("mancej/ai-harness#57", { state: "closed" }, 2000);

  const open = loadOpenInspectorPrs();
  assert.deepEqual(
    open.map((p) => p.number),
    [56],
  );
  // Closed, not deleted: the audit trail of what was said on a landed PR is worth keeping.
  assert.equal(getInspectorPr("mancej/ai-harness#57")?.state, "closed");
});

// ---- config ----

// Every default is the off position, and that is not caution theatre: this is the only
// subsystem that publishes under the operator's GitHub identity. If a future refactor
// flips any of these three, it flips them for everyone on upgrade, silently.
test("the Inspector ships off, in dry run, trusting no repo", () => {
  const cfg = getInspectorConfig();
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.mode, "dry-run");
  assert.deepEqual(cfg.repoAllowlist, []);
});

test("a patch merges over what is stored rather than replacing it", () => {
  setInspectorConfig({ repoAllowlist: ["/repo/a"] });
  setInspectorConfig({ enabled: true });
  const cfg = getInspectorConfig();
  assert.equal(cfg.enabled, true);
  assert.deepEqual(cfg.repoAllowlist, ["/repo/a"], "an unrelated edit must not clear the list");
  assert.equal(cfg.mode, "dry-run", "and must not quietly promote the mode");
});

// A config blob written by an older build has to keep working, and one written by a NEWER
// build must not crash this one - the state dir outlives any single version on a user's
// machine.
test("a stored blob from another version still reads", () => {
  openDb()
    .prepare(`INSERT INTO app_config (key, value) VALUES ('inspector', ?)`)
    .run(JSON.stringify({ enabled: true, somethingFromTheFuture: 7 }));
  const cfg = getInspectorConfig();
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.mode, "dry-run", "a key the old blob lacked gets its default");
  assert.equal(cfg.maxCommentsPerRound, 8);
});
