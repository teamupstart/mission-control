import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the daemon's state dir (token + sqlite) BEFORE anything reads config.
process.env.FLEET_HOME = mkdtempSync(join(tmpdir(), "fleet-fixlog-"));
// Point the no-mistakes DB lookup at an empty dir: these tests are about the git
// side, and the join must degrade to "log without context" when there's no db.
process.env.NM_HOME = mkdtempSync(join(tmpdir(), "nm-home-empty-"));

const { openDb } = await import("../src/server/db.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { pollFixLogs } = await import("../src/server/nomistakes.ts");
const { forgetFixLog } = await import("../src/server/nomistakes-fixes.ts");
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { NmFixDetail, Session, SessionDiff } from "../src/shared/types.ts";

openDb();
const TOKEN = ensureToken();
const LOOPBACK = { host: "127.0.0.1:7317" };
const authed = { ...LOOPBACK, "content-type": "application/json", "x-harness-token": TOKEN };

/** A real origin + clone, so reset runs a genuine fetch/reset/clean. */
function mkOriginAndClone(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "harness-fixlog-")));
  const origin = join(root, "origin");
  execFileSync("git", ["init", "-q", origin]);
  const og = (...a: string[]) => execFileSync("git", ["-C", origin, ...a], { stdio: "pipe" }).toString();
  og("branch", "-M", "main");
  og("config", "user.email", "t@test");
  og("config", "user.name", "t");
  writeFileSync(join(origin, "keep.txt"), "base\n");
  og("add", "-A");
  og("commit", "-qm", "base");
  const clone = join(root, "clone");
  execFileSync("git", ["clone", "-q", origin, clone]);
  const cg = (...a: string[]) => execFileSync("git", ["-C", clone, ...a], { stdio: "pipe" }).toString();
  cg("config", "user.email", "t@test");
  cg("config", "user.name", "t");
  return clone;
}

function commit(cwd: string, file: string, body: string, subject: string): void {
  writeFileSync(join(cwd, file), body);
  execFileSync("git", ["-C", cwd, "add", "-A"], { stdio: "pipe" });
  execFileSync("git", ["-C", cwd, "commit", "-qm", subject], { stdio: "pipe" });
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
  const notRepo = realpathSync(mkdtempSync(join(tmpdir(), "harness-fixlog-nogit-")));
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
