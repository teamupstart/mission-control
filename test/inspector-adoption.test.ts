import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { openDb, getInspectorPr, loadOpenInspectorPrs, updateInspectorPr } from "../src/server/db.ts";
import { adoptPr } from "../src/server/inspector/worker.ts";
import { parsePrUrl } from "../src/server/inspector/github.ts";
import { getInspectorConfig, setInspectorConfig } from "../src/server/inspector/config.ts";
import { opensPullRequest } from "../src/shared/pr-command.mjs";

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

// ---- the discriminator itself ----

// `sniffPrCreated` in the hook turns "a PR URL appeared" into "we may write on this pull
// request", and that promotion is the whole consent model. The regex behind it had no
// test at all because it lived unexported inside a bare-node hook - so any future
// loosening was invisible, and a loosening here writes comments on strangers' PRs.
test("only an actual `gh pr create` reads as opening a pull request", () => {
  for (const cmd of [
    "gh pr create --fill",
    "gh pr create",
    "cd /repo && gh pr create --draft --title x",
    "git push && gh pr create --fill && echo done",
    "echo $(gh pr create --fill)",
    "gh pr --draft create", // a valueless flag before the subcommand
  ]) {
    assert.equal(opensPullRequest(cmd), true, `should open a PR: ${cmd}`);
  }
});

test("everything that merely mentions or prints a PR is not opening one", () => {
  for (const cmd of [
    "gh pr view 12 --json url", // prints the identical URL
    "gh pr list --head my-branch",
    "gh pr checkout 12",
    "gh issue create --title x",
    "ghpr create",
    "mygh pr create",
    "no-mistakes --push", // how PRs are actually opened in this repo - signal (b)'s job
    "",
  ]) {
    assert.equal(opensPullRequest(cmd), false, `should NOT open a PR: ${cmd}`);
  }
});

// Two known limits of reading the command as text, pinned so a future "fix" for either
// has to be a deliberate decision rather than a quiet widening.
//
// It matches prose that quotes the command, which is harmless only because the boolean
// is half a signal: adoption also needs a PR URL in the same tool response, and a commit
// message has none. And it misses a flag that takes a separate value, which costs one
// uninspected PR - the cheap direction, and the one this predicate always takes.
test("the command match is text, and it is strict where being loose would cost most", () => {
  assert.equal(opensPullRequest("echo 'run gh pr create when ready' >> NOTES.md"), true);
  assert.equal(opensPullRequest("gh --repo o/r pr create"), false);
  // Not a general escape hatch: the trailing-boundary requirement still rules out the
  // most common way the phrase appears in prose, at the end of a quoted string.
  assert.equal(opensPullRequest('git commit -m "document gh pr create"'), false);
});

test("a command that is not a string is never a match", () => {
  for (const bad of [undefined, null, 42, { command: "gh pr create" }, ["gh pr create"]]) {
    assert.equal(opensPullRequest(bad), false);
  }
});

// ---- the retry backoff ----

// The backoff is the only thing standing between a permanently broken PR and two full
// `claude -p` runs every poll interval, forever. Its two failure modes are both about
// reading state that is already stale: an increment derived from the pre-tick snapshot
// never climbs, and a "things look fine now" reset that cannot see the failure recorded
// seconds earlier in the same pass hands the backoff its own reset button.
test("consecutive failures climb rather than restating the same count", () => {
  adoptPr(URL_1, CTX, "hook", 1000);
  const key = "mancej/ai-harness#56";

  updateInspectorPr(key, { lastError: "first", failCount: 1, nextAttemptAt: 2000 }, 1000);
  const first = getInspectorPr(key)!;
  updateInspectorPr(
    key,
    { lastError: "second", failCount: first.failCount + 1, nextAttemptAt: 9000 },
    2000,
  );

  const row = getInspectorPr(key)!;
  assert.equal(row.failCount, 2, "the second failure must build on the first, not replace it");
  assert.equal(row.nextAttemptAt, 9000);
});

test("a cleared PR is due immediately again", () => {
  adoptPr(URL_1, CTX, "hook", 1000);
  const key = "mancej/ai-harness#56";
  updateInspectorPr(key, { lastError: "boom", failCount: 3, nextAttemptAt: 999_999 }, 1000);
  updateInspectorPr(key, { lastError: null, failCount: 0, nextAttemptAt: null }, 2000);

  const row = getInspectorPr(key)!;
  assert.equal(row.failCount, 0);
  assert.equal(row.nextAttemptAt, null, "nothing should hold a healthy PR back");
  assert.equal(row.lastError, null);
});

// `cwd` and `repoRoot` record where the PR was opened from - a fact about the past. The
// worktree behind them gets reaped and pooled worktrees get reused, so the tick resolves
// a directory that still exists per pass instead. Nothing may quietly rewrite the record.
test("a ledger update cannot rewrite where the PR came from", () => {
  adoptPr(URL_1, CTX, "hook", 1000);
  const key = "mancej/ai-harness#56";
  updateInspectorPr(key, { headSha: "deadbeef", round: 2 }, 2000);

  const row = getInspectorPr(key)!;
  assert.equal(row.cwd, CTX.cwd);
  assert.equal(row.repoRoot, CTX.repoRoot);
  assert.equal(row.headSha, "deadbeef", "the mutable half still moves");
});

// ---- the head a backoff was earned on ----

// A backed-off PR still gets looked at, and a NEW push ends the wait its predecessor
// earned - including the six-hour park a diff too large to buffer buys. That comparison
// has to be against the last head we ATTEMPTED, not the last one we successfully
// reviewed: a failed round never advances `headSha`, so keying on that would read every
// single tick as a fresh push and the backoff would never hold at all.
test("the attempted head is tracked separately from the reviewed head", () => {
  adoptPr(URL_1, CTX, "hook", 1000);
  const key = "mancej/ai-harness#56";

  assert.equal(getInspectorPr(key)?.lastAttemptSha, null, "nothing attempted yet");

  // A round starts on `aaa` and fails: attempted, never reviewed.
  updateInspectorPr(key, { lastAttemptSha: "aaa" }, 2000);
  updateInspectorPr(key, { lastError: "timed out", failCount: 1, nextAttemptAt: 99_999 }, 2000);
  const failed = getInspectorPr(key)!;
  assert.equal(failed.lastAttemptSha, "aaa");
  assert.equal(failed.headSha, null, "a failed round must not record the push as reviewed");

  // The same head on a later tick is still the input that earned the wait.
  assert.equal(getInspectorPr(key)?.lastAttemptSha, "aaa");

  // A push ENDS THE WAIT but does not reset the ladder. Clearing `failCount` here would
  // hand a PR that fails for a head-independent reason - revoked write access, a diff
  // the model reliably cannot answer for in time - a fresh full review on every push, so
  // an afternoon of iteration would cost a round of up to two `claude -p` runs per push
  // and the backoff would never accumulate. Only a round that COMPLETES resets it.
  updateInspectorPr(key, { lastAttemptSha: "bbb", nextAttemptAt: null }, 3000);
  const pushed = getInspectorPr(key)!;
  assert.equal(pushed.lastAttemptSha, "bbb");
  assert.equal(pushed.nextAttemptAt, null, "a new push is due now, whatever the old one bought");
  assert.equal(pushed.failCount, 1, "but the ladder continues from where the failures left it");

  // What a completed round does, and the only thing that should.
  updateInspectorPr(key, { lastError: null, failCount: 0, nextAttemptAt: null }, 4000);
  assert.equal(getInspectorPr(key)?.failCount, 0);
});
