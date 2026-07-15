import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkOriginAndClone as mkFixture } from "./helpers/git-fixture.ts";

/** Every temp dir this file makes, removed once the suite is done with them. */
const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

// Isolate the daemon's state dir (token + sqlite) BEFORE anything reads config.
process.env.FLEET_HOME = tmp("fleet-fixlog-");
// Point the no-mistakes DB lookup at an empty dir: these tests are about the git
// side, and the join must degrade to "log without context" when there's no db.
process.env.NM_HOME = tmp("nm-home-empty-");

const { openDb } = await import("../src/server/db.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { pollFixLogs } = await import("../src/server/nomistakes.ts");
const { fixSummaries, forgetFixLog } = await import("../src/server/nomistakes-fixes.ts");
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { NmFixDetail, Session, SessionDiff } from "../src/shared/types.ts";

openDb();
const TOKEN = ensureToken();
const LOOPBACK = { host: "127.0.0.1:7317" };
const authed = { ...LOOPBACK, "content-type": "application/json", "x-harness-token": TOKEN };

/** A real origin + clone, so reset runs a genuine fetch/reset/clean. */
function mkOriginAndClone(): string {
  const { root, clone } = mkFixture("harness-fixlog-");
  temps.push(root);
  return clone;
}

function commit(cwd: string, file: string, body: string, subject: string, agoMs = 0): void {
  writeFileSync(join(cwd, file), body);
  execFileSync("git", ["-C", cwd, "add", "-A"], { stdio: "pipe" });
  // `%ct` is the committer date, and the log's freshness rules read it - so dating
  // a commit in the past is how a fix gets to be older than the round-write race.
  const when = new Date(Date.now() - agoMs).toISOString();
  execFileSync("git", ["-C", cwd, "commit", "-qm", subject], {
    stdio: "pipe",
    env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
  });
}

function disco(over: Partial<DiscoveredSession>): DiscoveredSession {
  return {
    syntheticId: "sess-fx",
    agent: "claude",
    name: "work",
    nameSource: "tmux",
    cwd: "/repo",
    gitBranch: "main",
    gitRoot: null,
    nomistakesGated: true,
    pid: 4242,
    tty: "ttys003",
    wezterm: null,
    tmux: null,
    startedAt: 0,
    ...over,
  };
}

/**
 * The log is what the pipeline actually landed on this branch: its fix commits,
 * and only those. Hand-written commits alongside them are the user's work, not
 * no-mistakes', and must not be attributed to it.
 */
test("the fix log lists no-mistakes commits, with their stats, newest first", async () => {
  const clone = mkOriginAndClone();
  const registry = new Registry();
  buildApp(registry, new ReviewManager(registry), new TaskManager(registry), new QueueManager(registry));

  commit(clone, "a.ts", "one\n", "feat: my own work");
  commit(clone, "b.ts", "x\ny\n", "no-mistakes(review): fix(queue): reject bad names");
  commit(clone, "docs.md", "d\n", "no-mistakes(document): document the chord");

  registry.applyDiscovery([disco({ cwd: clone })]);
  forgetFixLog(clone);
  await pollFixLogs(registry);

  const fixes = registry.getSession("sess-fx")!.nomistakesFixes;
  assert.equal(fixes.length, 2, "the hand-written commit is not a no-mistakes fix");
  assert.deepEqual(
    fixes.map((f) => f.step),
    ["document", "review"], // git log order: newest first
  );
  // The subject's own colon must survive the prefix strip.
  assert.equal(fixes[1]!.summary, "fix(queue): reject bad names");
  assert.equal(fixes[1]!.filesChanged, 1);
  assert.equal(fixes[1]!.added, 2);
  // No no-mistakes db in NM_HOME, so the log stands on its own without context.
  assert.equal(fixes[1]!.decision, null);
  assert.equal(fixes[1]!.findingCount, 0);
});

/**
 * `grep.patternType` belongs to the USER, and it picks which regex dialect
 * `--grep` speaks. A `(` in the pattern is a literal in basic and an unbalanced
 * group in extended and perl, where git exits 128 instead of matching - and an
 * unread log is an empty log, so the whole feature silently vanished for anyone
 * who had set it. Escaping doesn't save it either: basic regex spells a group
 * `\(`, so `\(` breaks exactly the dialects the bare paren worked in.
 *
 * Every dialect, not just the broken one: the point is that the prefilter means
 * the same thing in all of them, which one config value can't demonstrate.
 */
for (const patternType of ["basic", "extended", "perl"]) {
  test(`the fix log survives grep.patternType = ${patternType}`, async () => {
    const clone = mkOriginAndClone();
    const registry = new Registry();
    buildApp(registry, new ReviewManager(registry), new TaskManager(registry), new QueueManager(registry));

    // Repo-local, which is how a user's ~/.gitconfig reaches this code.
    execFileSync("git", ["-C", clone, "config", "grep.patternType", patternType], { stdio: "pipe" });
    commit(clone, "b.ts", "x\n", "no-mistakes(review): fix a thing");
    commit(clone, "own.ts", "mine\n", "feat: my own work");

    const id = `sess-pt-${patternType}`;
    registry.applyDiscovery([disco({ syntheticId: id, cwd: clone })]);
    forgetFixLog(clone);
    await pollFixLogs(registry);

    const fixes = registry.getSession(id)!.nomistakesFixes;
    assert.equal(fixes.length, 1, "the fix still lists");
    assert.equal(fixes[0]!.summary, "fix a thing");
    // The paren left the --grep pattern, so parseFixSubject is now the only thing
    // keeping non-fix commits out. It still has to.
    assert.ok(!fixes.some((f) => f.summary === "my own work"), "a hand-written commit is not a fix");
  });
}

/**
 * The user's report, driven the way they'd hit it: fixes landed, then they press
 * Reset. Reset hard-resets to origin, which destroys the very commits the log is
 * read from - so the log must empty, and stay empty when polling resumes.
 */
test("pressing Reset empties the fix log, and polling can't bring it back", async () => {
  const clone = mkOriginAndClone();
  const registry = new Registry();
  const app = buildApp(registry, new ReviewManager(registry), new TaskManager(registry), new QueueManager(registry));

  commit(clone, "b.ts", "x\n", "no-mistakes(review): fix a thing");
  registry.applyDiscovery([disco({ syntheticId: "sess-rst", cwd: clone })]);
  forgetFixLog(clone);
  await pollFixLogs(registry);

  const card = async (): Promise<Session> => {
    const res = await app.request("/api/sessions", { headers: LOOPBACK });
    return ((await res.json()) as Session[]).find((s) => s.id === "sess-rst")!;
  };

  assert.equal((await card()).nomistakesFixes.length, 1); // precondition

  const res = await app.request("/api/sessions/sess-rst/reset", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ clear: false }),
  });
  assert.equal(res.status, 200);

  // Clean the moment reset returns, not one poll later.
  assert.deepEqual((await card()).nomistakesFixes, []);

  // ...and the next poll agrees, because the commits are genuinely gone. No
  // dismissal set is involved: git is the source of truth.
  await pollFixLogs(registry);
  assert.deepEqual((await card()).nomistakesFixes, []);
});

/** A failed reset leaves the work in place, so its fixes must stay on the card. */
test("a failed reset leaves the fix log alone", async () => {
  const notRepo = realpathSync(tmp("harness-fixlog-nogit-"));
  const registry = new Registry();
  const app = buildApp(registry, new ReviewManager(registry), new TaskManager(registry), new QueueManager(registry));

  registry.applyDiscovery([disco({ syntheticId: "sess-bad", cwd: notRepo, pid: 99 })]);
  registry.applyNomistakesFixes("sess-bad", [
    {
      sha: "abc1234", step: "review", summary: "keep me", committedAt: 1,
      filesChanged: 1, added: 1, removed: 0, decision: null, findingCount: 0,
    },
  ]);

  const res = await app.request("/api/sessions/sess-bad/reset", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ clear: false }),
  });
  assert.equal(res.status, 500); // not a git repository

  assert.equal(registry.getSession("sess-bad")!.nomistakesFixes.length, 1);
});

/** Opening a fix asks for that fix's context by sha. */
test("the detail route returns one fix, and 404s for a sha that isn't one", async () => {
  const clone = mkOriginAndClone();
  const registry = new Registry();
  const app = buildApp(registry, new ReviewManager(registry), new TaskManager(registry), new QueueManager(registry));

  commit(clone, "b.ts", "x\ny\nz\n", "no-mistakes(review): fix the guard");
  registry.applyDiscovery([disco({ syntheticId: "sess-det", cwd: clone })]);
  forgetFixLog(clone);
  await pollFixLogs(registry);

  const sha = registry.getSession("sess-det")!.nomistakesFixes[0]!.sha;
  const res = await app.request(`/api/sessions/sess-det/nomistakes/fixes/${sha}`, { headers: LOOPBACK });
  assert.equal(res.status, 200);
  const detail = (await res.json()) as NmFixDetail;
  assert.equal(detail.sha, sha);
  assert.equal(detail.summary, "fix the guard");
  assert.deepEqual(detail.files, [{ path: "b.ts", added: 3, removed: 0 }]);

  // The hand-written base commit is a real sha but not a fix.
  const base = execFileSync("git", ["-C", clone, "rev-parse", "--short", "HEAD~1"]).toString().trim();
  const miss = await app.request(`/api/sessions/sess-det/nomistakes/fixes/${base}`, { headers: LOOPBACK });
  assert.equal(miss.status, 404);
});

/**
 * View diff must show what THAT fix changed. The bug this guards is real: the
 * session diff runs from the merge-base, so handing it a sha answers with
 * everything *since* that commit - the wrong (larger) diff under the right label.
 */
test("?commit= isolates one fix and doesn't leak the commits after it", async () => {
  const clone = mkOriginAndClone();
  const registry = new Registry();
  const app = buildApp(registry, new ReviewManager(registry), new TaskManager(registry), new QueueManager(registry));

  commit(clone, "first.ts", "first\n", "no-mistakes(review): the fix we want");
  commit(clone, "second.ts", "second\n", "no-mistakes(lint): a later fix");
  registry.applyDiscovery([disco({ syntheticId: "sess-diff", cwd: clone })]);
  forgetFixLog(clone);
  await pollFixLogs(registry);

  const fixes = registry.getSession("sess-diff")!.nomistakesFixes;
  const wanted = fixes.find((f) => f.summary === "the fix we want")!;

  const res = await app.request(`/api/sessions/sess-diff/diff?commit=${wanted.sha}`, { headers: LOOPBACK });
  const diff = (await res.json()) as SessionDiff;
  assert.equal(diff.ok, true);
  assert.equal(diff.filesChanged, 1);
  assert.match(diff.patch, /first\.ts/);
  assert.doesNotMatch(diff.patch, /second\.ts/, "the later fix must not appear");

  // Without ?commit= the same route still means "the whole branch".
  const whole = await app.request("/api/sessions/sess-diff/diff", { headers: LOOPBACK });
  const wholeDiff = (await whole.json()) as SessionDiff;
  assert.equal(wholeDiff.filesChanged, 2);
});

/**
 * The cache is keyed by cwd, and nothing but Reset drops an entry - so a daemon
 * that has been up a week holds the log of every worktree it ever polled, each
 * carrying its findings' text. It has to be bounded by the LIVE FLEET rather than
 * by uptime: the checkouts still being polled are exactly the ones worth keeping,
 * and an age-based sweep alone still lets a busy long-lived fleet accumulate.
 */
test("a checkout that leaves the fleet doesn't keep its cached fix log", async () => {
  const clone = mkOriginAndClone();
  const registry = new Registry();
  buildApp(registry, new ReviewManager(registry), new TaskManager(registry), new QueueManager(registry));

  commit(clone, "b.ts", "x\n", "no-mistakes(review): fix a thing");
  registry.applyDiscovery([disco({ syntheticId: "sess-swp", cwd: clone })]);
  forgetFixLog(clone);
  // Taken BEFORE the poll, so every read below happens at an instant the entry
  // cannot yet have gone stale at. What's asserted is eviction, never timing.
  const t0 = Date.now();
  await pollFixLogs(registry);
  assert.equal(registry.getSession("sess-swp")!.nomistakesFixes.length, 1); // precondition

  // Move the source ref up to HEAD, so a FRESH read finds nothing in
  // `origin/main..HEAD` while a cache hit still answers with the old log. HEAD
  // itself never moves - the entry stays keyed on a live sha, which is the
  // freshness the cache exists for and which the sweep must not cost us.
  execFileSync("git", ["-C", clone, "update-ref", "refs/remotes/origin/main", "HEAD"]);
  assert.equal((await fixSummaries(clone, t0)).length, 1, "still cached: HEAD hasn't moved");

  // The session leaves the fleet, so its checkout stops being polled.
  registry.applyDiscovery([]);
  await pollFixLogs(registry);

  // Same instant, so only the eviction can explain the re-read.
  assert.equal((await fixSummaries(clone, t0)).length, 0, "the log left with the session");
});

/**
 * A fix with no matching round is not an edge case, it's the STEADY STATE - the
 * run that made it gets deleted and its rounds go with it, so the context is
 * permanently absent, as this whole file's empty NM_HOME models. Retrying on
 * `decision === null` alone therefore never settled: RETRY_MS is <= the poll
 * interval, so the guard was vacuous and every tick re-ran `git log`, two more
 * rev-parses and a sqlite open, forever, for an answer that cannot change.
 *
 * Freshness is invisible in the output, so the read is made observable the way the
 * sweep test above does it: move the source ref up to HEAD and a FRESH read finds
 * nothing in `origin/main..HEAD`, while a cache hit still answers with the old log.
 */
test("a fix whose round never landed settles instead of re-reading every tick", async () => {
  const clone = mkOriginAndClone();
  // Dated well before the race window: a round that hasn't been written in an hour
  // is never going to be.
  commit(clone, "b.ts", "x\n", "no-mistakes(review): fix a thing", 60 * 60_000);
  forgetFixLog(clone);

  const t0 = Date.now();
  const first = await fixSummaries(clone, t0);
  assert.equal(first.length, 1);
  assert.equal(first[0]!.decision, null, "no db, so no context - permanently");

  execFileSync("git", ["-C", clone, "update-ref", "refs/remotes/origin/main", "HEAD"]);

  // Past RETRY_MS and well inside FRESH_MS. Answering 1 means the cache held.
  assert.equal((await fixSummaries(clone, t0 + 5_001)).length, 1, "settled: no re-read");
});

/**
 * A commit date is not our clock - it comes from whoever made the commit, and a
 * skewed or rebased one dates into the future. Measured as a plain age that reads
 * as negative, which is forever "recent": the same permanent re-read loop, just
 * reached from the other side.
 */
test("a fix dated in the future settles too", async () => {
  const clone = mkOriginAndClone();
  commit(clone, "b.ts", "x\n", "no-mistakes(review): fix a thing", -60 * 60_000); // an hour ahead
  forgetFixLog(clone);

  const t0 = Date.now();
  assert.equal((await fixSummaries(clone, t0)).length, 1);

  execFileSync("git", ["-C", clone, "update-ref", "refs/remotes/origin/main", "HEAD"]);

  assert.equal((await fixSummaries(clone, t0 + 5_001)).length, 1, "settled: no re-read");
});

/**
 * The other half: RETRY_MS still has to do the job it was written for. A fix
 * commits BEFORE its round row is written, so a log read in that window sees a
 * contextless commit and, keyed on HEAD alone, would stay contextless forever.
 * Recency is what tells that fix apart from one whose round is simply gone.
 */
test("a fix that just landed still retries for its context", async () => {
  const clone = mkOriginAndClone();
  commit(clone, "b.ts", "x\n", "no-mistakes(review): fix a thing"); // dated now
  forgetFixLog(clone);

  const t0 = Date.now();
  assert.equal((await fixSummaries(clone, t0)).length, 1);

  execFileSync("git", ["-C", clone, "update-ref", "refs/remotes/origin/main", "HEAD"]);

  // Same instant as the test above, and the opposite answer: 0 proves it re-read.
  assert.equal((await fixSummaries(clone, t0 + 5_001)).length, 0, "the race window is still open");
});

/**
 * `base` is documented as the source BRANCH and the viewer renders it as one, but
 * a commit isn't diffed against a branch - it's diffed against its parent, which
 * is what `baseSha` carries. A parent sha in `base` shows a raw sha where a
 * branch name is expected.
 */
test("a commit diff names no base branch and carries its parent as a sha", async () => {
  const clone = mkOriginAndClone();
  const registry = new Registry();
  const app = buildApp(registry, new ReviewManager(registry), new TaskManager(registry), new QueueManager(registry));

  commit(clone, "b.ts", "x\n", "no-mistakes(review): fix a thing");
  registry.applyDiscovery([disco({ syntheticId: "sess-base", cwd: clone })]);
  forgetFixLog(clone);
  await pollFixLogs(registry);

  const sha = registry.getSession("sess-base")!.nomistakesFixes[0]!.sha;
  const res = await app.request(`/api/sessions/sess-base/diff?commit=${sha}`, { headers: LOOPBACK });
  const diff = (await res.json()) as SessionDiff;
  assert.equal(diff.ok, true);
  assert.equal(diff.base, null, "one commit has a parent, not a base branch");
  const parent = execFileSync("git", ["-C", clone, "rev-parse", "HEAD~1"]).toString().trim();
  assert.equal(diff.baseSha, parent.slice(0, 12), "the parent is carried as a sha, where it belongs");

  // The branch diff is the one that HAS a base branch, and still names it.
  const whole = await app.request("/api/sessions/sess-base/diff", { headers: LOOPBACK });
  assert.equal(((await whole.json()) as SessionDiff).base, "main");
});

/**
 * An empty fix commit is real - `lint` commits "typecheck clean, no fixes needed"
 * constantly, and parseFixLog models it - so it can be opened. That's the state
 * the viewer's empty copy renders for, and it must not be framed against a base.
 */
test("an empty fix commit opens as a diff with no changes and no base branch", async () => {
  const clone = mkOriginAndClone();
  const registry = new Registry();
  const app = buildApp(registry, new ReviewManager(registry), new TaskManager(registry), new QueueManager(registry));

  execFileSync("git", ["-C", clone, "commit", "-q", "--allow-empty", "-m", "no-mistakes(lint): typecheck clean"], { stdio: "pipe" });
  registry.applyDiscovery([disco({ syntheticId: "sess-mt", cwd: clone })]);
  forgetFixLog(clone);
  await pollFixLogs(registry);

  const fixes = registry.getSession("sess-mt")!.nomistakesFixes;
  assert.equal(fixes.length, 1, "a fix that changed nothing still listed");
  assert.equal(fixes[0]!.filesChanged, 0);

  const res = await app.request(`/api/sessions/sess-mt/diff?commit=${fixes[0]!.sha}`, { headers: LOOPBACK });
  const diff = (await res.json()) as SessionDiff;
  assert.equal(diff.ok, true, "an empty commit is not an error");
  assert.equal(diff.filesChanged, 0);
  assert.equal(diff.patch, "");
  assert.equal(diff.base, null);
});

/**
 * A read that FAILED must never look like a read that found nothing - the third
 * instance of that class on this branch, after the caps and `listFixes` returning
 * [] on a git error. An empty fix commit is real (the test above opens one) and
 * renders as "No changes in this commit.", so a diff we couldn't read has to take
 * the viewer's error path rather than borrow that copy for a fix that changed
 * real code.
 *
 * Both calls, because each fails open on its own. These configs are the user's to
 * set - the same way `grep.patternType` reached the fix log - and they fail the
 * shape any broken diff does (a timeout, a crash): git exits non-zero having
 * written nothing to stdout.
 */
for (const { setting, value, error } of [
  // --numstat doesn't run the external program, so the stats still come back and
  // only the patch dies: `ok: true` with real files and an empty patch, which the
  // viewer parses to zero files and renders as "No changes in this commit."
  { setting: "diff.external", value: "false", error: /could not read the diff$/ },
  // An unparseable algorithm kills both calls, so the stats check is what fires.
  { setting: "diff.algorithm", value: "bogus", error: /could not read the diff stats$/ },
]) {
  test(`a commit diff broken by ${setting} says so instead of claiming no changes`, async () => {
    const clone = mkOriginAndClone();
    const registry = new Registry();
    const app = buildApp(registry, new ReviewManager(registry), new TaskManager(registry), new QueueManager(registry));

    const id = `sess-dfail-${setting}`;
    commit(clone, "b.ts", "x\n", "no-mistakes(review): fix a thing");
    registry.applyDiscovery([disco({ syntheticId: id, cwd: clone })]);
    forgetFixLog(clone);
    await pollFixLogs(registry);
    const sha = registry.getSession(id)!.nomistakesFixes[0]!.sha;

    // Set after the poll: the point is the diff, and `git log --numstat` reads this
    // config too. Repo-local is how a user's ~/.gitconfig reaches this code.
    execFileSync("git", ["-C", clone, "config", setting, value], { stdio: "pipe" });

    const res = await app.request(`/api/sessions/${id}/diff?commit=${sha}`, { headers: LOOPBACK });
    const diff = (await res.json()) as SessionDiff;
    assert.equal(diff.ok, false, "an unreadable diff is not an empty one");
    assert.match(diff.error ?? "", error);
    // The empty-commit copy keys off `ok`, so failing closed is what keeps them apart.
    assert.equal(diff.patch, "");
    // The parent still belongs in baseSha, and no branch in base: an error is still a commit diff.
    assert.equal(diff.base, null);
    assert.equal(diff.baseSha, execFileSync("git", ["-C", clone, "rev-parse", "HEAD~1"]).toString().trim().slice(0, 12));
  });
}

/** A sha that's been rebased away should say so, not answer with a wrong diff. */
test("?commit= reports an unreachable sha rather than guessing", async () => {
  const clone = mkOriginAndClone();
  const registry = new Registry();
  const app = buildApp(registry, new ReviewManager(registry), new TaskManager(registry), new QueueManager(registry));
  registry.applyDiscovery([disco({ syntheticId: "sess-gone", cwd: clone })]);

  const res = await app.request("/api/sessions/sess-gone/diff?commit=deadbee", { headers: LOOPBACK });
  const diff = (await res.json()) as SessionDiff;
  assert.equal(diff.ok, false);
  assert.match(diff.error ?? "", /not reachable/);
});
