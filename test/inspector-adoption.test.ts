import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Type-only, so it is erased rather than resolved before the state-dir preamble below.
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { PipelineRun } from "../src/shared/pipeline.ts";

// Isolate the state dir BEFORE any value import that can resolve it - static imports are
// hoisted above this line, so every server module below must load dynamically. Without
// this, the beforeEach below ran `DELETE FROM app_config` against the operator's real
// `~/.mission-control/harness.db` on every `npm test`, wiping every saved setting on the
// machine (foreman, ui, harnesses, cost, skills) each time this suite ran.
const home = mkdtempSync(join(tmpdir(), "mission-inspector-adoption-"));
process.env.HARNESS_HOME = join(home, "state");

const {
  openDb,
  getInspectorPr,
  loadInspectorInspections,
  loadOpenInspectorPrs,
  updateInspectorPr,
  upsertInspectorComment,
} = await import("../src/server/db.ts");
const { adoptPipelinePr, adoptPr, pushEndsTheWait } = await import(
  "../src/server/inspector/worker.ts"
);
const { parseGitHubRemoteUrl, parsePrUrl } = await import(
  "../src/server/inspector/github.ts"
);
const { getInspectorConfig, setInspectorConfig } = await import(
  "../src/server/inspector/config.ts"
);
const { opensPullRequest } = await import("../src/shared/pr-command.mjs");
const { Registry, SDK_SESSION_ID_PREFIX } = await import("../src/server/registry.ts");
const { mkMuxHandle } = await import("./helpers/session-fixture.ts");

after(() => rmSync(home, { recursive: true, force: true }));

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
const URL_2 = "https://github.com/mancej/ai-harness/pull/57";
const CTX = { sessionId: "s1", cwd: "/wt/a", repoRoot: "/repo/a" };

test("authorship is announced once per session per PR, on either evidence path", () => {
  // `pr_opened` is the ONLY push that can put a row in the table above, and the table is
  // the permission to comment in public. So "announce once" has to be enforced, not merely
  // intended: an adapter whose event stream reconnects or replays a tool result would
  // otherwise re-announce the same authorship, and the fact that `adoptInspectorPr` is an
  // `ON CONFLICT DO NOTHING` upsert is a downstream table being forgiving rather than this
  // side being correct.
  //
  // Both evidence paths go through one announcer, because "once" is a property of the
  // announcement and a rule with two implementations has one too many. Neither of them is
  // reachable from a `prUrl` sniff - see the tests below for what that distinction costs.
  const r = new Registry();
  const opened: Array<{ url: string; sessionId: string }> = [];
  r.onPrOpened((e) => opened.push({ url: e.url, sessionId: e.sessionId }));

  // The hook path: the bridge matched the `gh pr create` COMMAND.
  const pane = mkMuxHandle({ session: "s", paneId: "%77" });
  const discovered = {
    syntheticId: "proc:ttys7:900:0",
    agent: "claude",
    name: "pane work",
    nameSource: "process",
    cwd: "/wt/a",
    gitBranch: "feature",
    pid: 900,
    tty: "ttys7",
    terminals: [pane],
    startedAt: 0,
  } as DiscoveredSession;
  r.applyDiscovery([discovered]);
  const hook = { agent: "claude" as const, event: "PostToolUse", sessionId: null, cwd: null, transcriptPath: null, env: { tmuxPane: "%77" }, prUrl: URL_1, prCreated: true };
  r.applyHook(hook);
  r.applyHook(hook);
  assert.deepEqual(opened, [{ url: URL_1, sessionId: "proc:ttys7:900:0" }], "a repeated hook is not news");

  // The driver path: the same claim, from a session with no pane at all.
  const sdkId = `${SDK_SESSION_ID_PREFIX}22222222-2222-4222-8222-222222222222`;
  r.registerSdkSession({ id: sdkId, agent: "claude", name: "embedded", cwd: "/wt/b" });
  r.applyDriverEvent(sdkId, { kind: "pr_created", urls: [URL_2] });
  r.applyDriverEvent(sdkId, { kind: "pr_created", urls: [URL_2] });
  assert.deepEqual(opened.slice(1), [{ url: URL_2, sessionId: sdkId }], "nor is a replayed driver event");

  // What is suppressed is a REPEAT, not a sequence: an agent that opens a second pull
  // request is still its author, and a PR two different sessions both claim is a claim each
  // of them made. Adoption itself de-duplicates on the PR key, which is a separate rule
  // (see "adopting twice is a no-op" below).
  r.applyDriverEvent(sdkId, { kind: "pr_created", urls: [URL_1] });
  assert.deepEqual(opened.at(-1), { url: URL_1, sessionId: sdkId });
});

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

test("inspection tallies distinguish posted findings from pending rows", () => {
  adoptPr(URL_1, CTX, "hook", 1000);
  const statuses = ["open", "drafted", "posting", "resolved"] as const;
  for (const [index, status] of statuses.entries()) {
    upsertInspectorComment({
      id: `finding-${index}`,
      prKey: "mancej/ai-harness#56",
      fingerprint: `fingerprint-${index}`,
      path: "src/example.ts",
      line: index + 1,
      title: `Finding ${index}`,
      body: "Detail",
      severity: "major",
      round: 1,
      status,
      replies: 0,
      answeredCommentId: null,
      createdAt: 1000,
      updatedAt: 1000,
    });
  }

  const row = loadInspectorInspections().find((entry) => entry.key === "mancej/ai-harness#56");
  assert.equal(row?.openFindings, 3);
  assert.equal(row?.postedOpenFindings, 1);
  assert.equal(row?.resolvedFindings, 1);
});

// Older persisted provenance and the current hook signal can both reach this path. The
// second one to arrive must be a no-op rather than a re-adoption: rewriting the row would
// reset `head_sha` and make the Inspector review the whole PR again from scratch, posting
// duplicates of everything it had already said.
test("adopting twice is a no-op, whichever signal gets there second", () => {
  assert.equal(adoptPr(URL_1, CTX, "hook", 1000), true);
  updateInspectorPr("mancej/ai-harness#56", { headSha: "abc123", round: 4 }, 2000);

  assert.equal(adoptPr(URL_1, CTX, "legacy", 3000), false, "second adoption is a no-op");
  const row = getInspectorPr("mancej/ai-harness#56");
  assert.equal(row?.headSha, "abc123", "progress must survive a re-sighting");
  assert.equal(row?.round, 4);
  assert.equal(row?.source, "hook", "provenance is a fact about the past");
});

test("a projected pipeline PR is adopted once when its configured remote matches", async () => {
  const run: PipelineRun = {
    provider: "ai-conductor",
    repoRoot: "/repo/a",
    slug: "pipeline-pr",
    worktree: "/repo/a/.worktrees/pipeline-pr",
    tier: "M",
    track: "technical",
    steps: [{ name: "open_pr", state: "done" }],
    lastStep: "open_pr",
    halt: null,
    group: "processed",
    prUrl: URL_1,
    costTokens: null,
    updatedAt: 1000,
  };
  const configuredRemote = async () => [{ owner: "MANCEJ", repo: "AI-HARNESS" }];
  assert.equal(await adoptPipelinePr(run, 1000, configuredRemote), true);
  assert.equal(await adoptPipelinePr(run, 2000, configuredRemote), false);
  const row = getInspectorPr("mancej/ai-harness#56");
  assert.equal(row?.source, "pipeline");
  assert.equal(row?.repoRoot, "/repo/a");
  assert.equal(row?.cwd, "/repo/a/.worktrees/pipeline-pr");
  assert.equal(row?.sessionId, null);
});

test("a projected pipeline PR outside the configured repository is never adopted", async () => {
  const run: PipelineRun = {
    provider: "ai-conductor",
    repoRoot: "/repo/a",
    slug: "foreign-pr",
    worktree: "/repo/a/.worktrees/foreign-pr",
    tier: "S",
    track: "technical",
    steps: [{ name: "open_pr", state: "done" }],
    lastStep: "open_pr",
    halt: null,
    group: "processed",
    prUrl: URL_1,
    costTokens: null,
    updatedAt: 1000,
  };

  assert.equal(
    await adoptPipelinePr(run, 1000, async () => [{ owner: "someone-else", repo: "other" }]),
    false,
  );
  assert.equal(await adoptPipelinePr(run, 1000, async () => []), false);
  assert.equal(loadOpenInspectorPrs().length, 0);
});

test("configured GitHub remote URLs resolve across ordinary git transports", () => {
  for (const remote of [
    "https://github.com/mancej/ai-harness.git",
    "git@github.com:mancej/ai-harness.git",
    "ssh://git@github.com/mancej/ai-harness.git",
    "git://github.com/mancej/ai-harness",
  ]) {
    assert.deepEqual(parseGitHubRemoteUrl(remote), { owner: "mancej", repo: "ai-harness" });
  }
  assert.equal(parseGitHubRemoteUrl("https://gitlab.com/mancej/ai-harness.git"), null);
  assert.equal(parseGitHubRemoteUrl("https://github.com/mancej/ai-harness/extra.git"), null);
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

test("workflow PR hints can look up provenance but have no adoption path", () => {
  const manager = readFileSync(
    new URL("../src/server/workflows/manager.ts", import.meta.url),
    "utf8",
  );
  assert.match(manager, /session\?\.prUrl/);
  assert.match(manager, /getInspectorPr/);
  assert.doesNotMatch(manager, /\badoptPr\b|\badoptInspectorPr\b/);
  assert.equal(loadOpenInspectorPrs().length, 0);
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
    "review-tool --push",
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

// A backed-off PR still gets looked at, and a NEW push can end the wait its predecessor
// earned. That comparison has to be against the last head we ATTEMPTED, not the last one
// we successfully reviewed: a failed round never advances `headSha`, so keying on that
// would read every single tick as a fresh push and the backoff would never hold at all.
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

  // When a push ends the wait it never resets the ladder itself. The two are separate
  // levers: clearing `nextAttemptAt` is what gets a force-pushed three-line diff reviewed
  // on the next tick, and keeping `failCount` is what stops the wait restarting from the
  // bottom once the pushes stop. Only a round that COMPLETES resets the count.
  updateInspectorPr(key, { lastAttemptSha: "bbb", nextAttemptAt: null }, 3000);
  const pushed = getInspectorPr(key)!;
  assert.equal(pushed.lastAttemptSha, "bbb");
  assert.equal(pushed.nextAttemptAt, null, "a new push is due now, whatever the old one bought");
  assert.equal(pushed.failCount, 1, "but the ladder continues from where the failures left it");

  // What a completed round does, and the only thing that should.
  updateInspectorPr(key, { lastError: null, failCount: 0, nextAttemptAt: null }, 4000);
  assert.equal(getInspectorPr(key)?.failCount, 0);
});

// The other half of that lever. Ending the wait on EVERY push would leave a PR failing
// for a head-INDEPENDENT reason - revoked write access, a diff the model reliably cannot
// answer for in time - buying a fresh full review each time the author pushes, so an
// afternoon of iteration would cost up to two `claude -p` runs per push however high the
// ladder had climbed. Past the threshold such a push waits like everything else.
test("a push stops cutting the wait short once the ladder is high", () => {
  adoptPr(URL_1, CTX, "hook", 1000);
  const key = "mancej/ai-harness#56";
  updateInspectorPr(
    key,
    { lastAttemptSha: "aaa", failCount: 5, lastFailKind: "persistent", nextAttemptAt: 99_999 },
    2000,
  );

  assert.equal(pushEndsTheWait(getInspectorPr(key)!), false, "a push cannot fix this one");

  // A push at this height records the new head so the next tick can compare, and leaves
  // the wait exactly where it was.
  updateInspectorPr(key, { lastAttemptSha: "bbb" }, 3000);
  const row = getInspectorPr(key)!;
  assert.equal(row.lastAttemptSha, "bbb", "the head we would attempt next is still tracked");
  assert.equal(row.nextAttemptAt, 99_999, "but the wait it has earned is not cut short");
  assert.equal(row.failCount, 5);
});

// And the exception that keeps that cap from inverting the rule it was added to serve.
//
// A diff too large to buffer parks at the flat six-hour ceiling and can be re-attempted
// ONLY by a push, so its failures accumulate one per push. Counted against a single cap
// they run it out in four: park, push, park, push, park, push, and the fourth push - the
// one that finally drops the vendored directory - would find the cap spent and sit out
// six hours. That is precisely the author the escape exists for, so the cap has to read
// the failure CLASS rather than a bare count.
test("a diff parked as too large is always released by the next push", () => {
  adoptPr(URL_1, CTX, "hook", 1000);
  const key = "mancej/ai-harness#56";

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    updateInspectorPr(
      key,
      {
        lastAttemptSha: `head${attempt}`,
        failCount: attempt,
        lastFailKind: "push-fixable",
        nextAttemptAt: 1000 + 6 * 60 * 60 * 1000,
      },
      2000,
    );
    assert.equal(
      pushEndsTheWait(getInspectorPr(key)!),
      true,
      `push ${attempt + 1} still gets to shrink the diff`,
    );
  }
});

// The class is a property of the LAST failure, because the last failure is what set the
// wait now in force. A PR that was parked for an oversize diff and then started failing
// for a reason a push cannot touch is back under the cap.
test("the escape follows the failure that earned the current wait", () => {
  assert.equal(pushEndsTheWait({ failCount: 9, lastFailKind: "push-fixable" }), true);
  assert.equal(pushEndsTheWait({ failCount: 9, lastFailKind: "persistent" }), false);
  assert.equal(
    pushEndsTheWait({ failCount: 9, lastFailKind: null }),
    false,
    "an unnamed class falls under the cap, never out of it",
  );
  assert.equal(
    pushEndsTheWait({ failCount: 1, lastFailKind: "persistent" }),
    true,
    "a low ladder still lets a push through, whatever earned it",
  );
});

test("a driver's pr_created adopts; a bare prUrl sighting on the same session does not", () => {
  // The end of the provenance chain, on the runtime that has no hook script. `applyDriverEvent`
  // reaches the SAME announcer the hook path does (`announcePrOpened`), and the listener that
  // subscribes to it is what writes the row - so an embedded session's PR is adopted by the
  // one rule, not by a second one written beside it.
  //
  // The distinction being pinned is authorship. The driver emits `pr_created` only after
  // pairing a Bash command that satisfies `opensPullRequest` with the URL that command
  // printed; a URL SEEN in some other output proves nothing (`gh pr view` prints one, so does
  // `cat notes.md`), and adopting on it would post automated review comments on a stranger's
  // pull request under the operator's name.
  const r = new Registry();
  const opened: Array<{ url: string; sessionId: string }> = [];
  r.onPrOpened((e) => opened.push({ url: e.url, sessionId: e.sessionId }));
  const sdkId = `${SDK_SESSION_ID_PREFIX}33333333-3333-4333-8333-333333333333`;
  r.registerSdkSession({ id: sdkId, agent: "claude", name: "embedded", cwd: "/wt/a" });

  // The command half alone is not a URL to adopt, and the sniff half alone is not authorship.
  assert.equal(opensPullRequest("gh pr view 56 --json url"), false);
  assert.ok(opensPullRequest("gh pr create --fill"));

  r.applyDriverEvent(sdkId, { kind: "pr_created", urls: [URL_1] });
  assert.deepEqual(opened, [{ url: URL_1, sessionId: sdkId }]);

  // What the listener does with it is the ordinary adoption, keyed on the repo rather than
  // on the session, so a driver-run PR is reviewed exactly as a pane-run one is.
  const ctx = { sessionId: sdkId, cwd: "/wt/a", repoRoot: "/repo/a" };
  assert.equal(adoptPr(URL_1, ctx, "hook", 1000), true);
  assert.equal(loadOpenInspectorPrs().length, 1);
  assert.equal(getInspectorPr("mancej/ai-harness#56")?.number, 56);

  // And nothing else on the driver channel can put a row in that table. A session carrying a
  // `prUrl` it merely observed emits no announcement at all, so there is no second path in.
  assert.deepEqual(opened.length, 1);
});
