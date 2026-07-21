import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetPreview, resetToOrigin } from "../src/server/actions.ts";
import { stubRun } from "../src/server/util/exec.ts";
import { bindSession } from "../src/server/terminal/registry.ts";
import type { PaneHandles } from "../src/shared/pane.ts";
import { gitIn, mkCloneOnBranch, mkOriginAndClone as mkFixture } from "./helpers/git-fixture.ts";
import type { Session } from "../src/shared/types.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";

const mkOriginAndClone = (): { origin: string; clone: string } => mkFixture("harness-reset-");

/** A minimal Session over `cwd`, with no pane (so `/clear` is a no-op we can assert). */
function sess(cwd: string | null, branch: string | null = "main"): Session {
  return {
    id: "s1", agent: "claude", name: "work", nameSource: "process", state: "idle",
    cwd, gitBranch: branch, gitRoot: null, repoRoot: null, nomistakesGated: false, pid: 1, tty: null,
    permissionMode: null, terminals: [], agentSessionId: null, transcriptPath: null,
    instrumented: false, hooksSeen: false, activity: null, startedAt: null, firstSeen: 0, lastSeen: 0,
    lastActivity: null, pendingReviews: 0, nomistakes: null, nomistakesFixes: [], task: null,
    nomistakesNarration: null, prUrl: null, prNumber: null, prState: null, prChecks: null, inspector: null,
    meta: null, note: null, cost: null, goal: null, queue: null, orphanedQueue: null, paneDialog: null,
  };
}

test("resetPreview reports local commits, dirty, and untracked as what's lost", async () => {
  const { clone } = mkOriginAndClone();
  // Diverge the clone: a local commit, an uncommitted edit, and an untracked file.
  writeFileSync(join(clone, "keep.txt"), "base\nlocal-committed\n");
  gitIn(clone, "add", "-A");
  gitIn(clone, "commit", "-qm", "local work on top");
  writeFileSync(join(clone, "keep.txt"), "base\nlocal-committed\ndirty-uncommitted\n");
  writeFileSync(join(clone, "scratch.txt"), "untracked\n");

  const p = await resetPreview(sess(clone));
  assert.equal(p.ok, true);
  assert.equal(p.error, null);
  assert.equal(p.target, "origin/main");
  assert.equal(p.clean, false);
  assert.equal(p.aheadCommits, 1);
  assert.deepEqual(p.aheadSubjects, ["local work on top"]);
  assert.equal(p.dirtyFiles, 1); // keep.txt has uncommitted edits
  assert.equal(p.untrackedFiles, 1); // scratch.txt
});

test("resetPreview reports clean when the checkout already matches origin", async () => {
  const { clone } = mkOriginAndClone();
  const p = await resetPreview(sess(clone));
  assert.equal(p.ok, true);
  assert.equal(p.clean, true);
  assert.equal(p.aheadCommits, 0);
  assert.equal(p.dirtyFiles, 0);
  assert.equal(p.untrackedFiles, 0);
  assert.deepEqual(p.aheadSubjects, []);
});

test("resetToOrigin discards local commits, uncommitted edits, and untracked files", async () => {
  const { clone } = mkOriginAndClone();
  const originalHead = gitIn(clone, "rev-parse", "HEAD");
  writeFileSync(join(clone, "keep.txt"), "base\nlocal-committed\n");
  gitIn(clone, "add", "-A");
  gitIn(clone, "commit", "-qm", "local work");
  writeFileSync(join(clone, "keep.txt"), "base\nlocal-committed\ndirty\n");
  writeFileSync(join(clone, "scratch.txt"), "untracked\n");

  const r = await resetToOrigin(sess(clone), false);
  assert.equal(r.ok, true);
  assert.equal(r.error, null);
  assert.equal(r.cleared, false); // clear:false was requested

  // HEAD is back at origin/main's commit, the file is pristine, untracked is gone.
  assert.equal(gitIn(clone, "rev-parse", "HEAD"), originalHead);
  assert.equal(readFileSync(join(clone, "keep.txt"), "utf8"), "base\n");
  assert.equal(existsSync(join(clone, "scratch.txt")), false);
  assert.equal(gitIn(clone, "status", "--porcelain"), ""); // fully clean
});

test("reset anchors at the worktree top even when the session cwd is a nested subdir", async () => {
  const { clone } = mkOriginAndClone();
  // A committed subdir (so the pane can sit in it) plus untracked files at BOTH
  // the repo root and inside the subdir - a clean run from the subdir alone would
  // miss the root one, so this proves we anchor at the toplevel.
  const sub = join(clone, "packages", "app");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, "index.ts"), "export {};\n");
  gitIn(clone, "add", "-A");
  gitIn(clone, "commit", "-qm", "add nested package");
  const rootHead = gitIn(clone, "rev-parse", "HEAD");
  // origin doesn't have that commit, so it's "ahead" and gets discarded too.
  writeFileSync(join(clone, "root-untracked.txt"), "at repo root\n");
  writeFileSync(join(sub, "sub-untracked.txt"), "in subdir\n");

  const p = await resetPreview(sess(sub));
  assert.equal(p.ok, true);
  assert.equal(p.untrackedFiles, 2); // both untracked files seen from the top
  assert.equal(p.aheadCommits, 1);

  const r = await resetToOrigin(sess(sub), false);
  assert.equal(r.ok, true);
  // The reported root is the worktree top, not the nested cwd - callers key off it
  // to find which sessions this reset actually wiped.
  assert.equal(r.root, clone);
  assert.equal(gitIn(clone, "rev-parse", "HEAD"), gitIn(clone, "rev-parse", "origin/main"));
  assert.notEqual(gitIn(clone, "rev-parse", "HEAD"), rootHead); // the ahead commit is gone
  assert.equal(existsSync(join(clone, "root-untracked.txt")), false); // cleaned from the top
  assert.equal(existsSync(join(sub, "sub-untracked.txt")), false);
  assert.equal(existsSync(sub), false); // the whole untracked package dir is gone
});

test("resetToOrigin pulls newer origin/main and lands the checkout on it", async () => {
  const { origin, clone } = mkOriginAndClone();
  // origin advances after the clone was taken - the reset must fetch and adopt it.
  writeFileSync(join(origin, "keep.txt"), "base\nupstream-new\n");
  gitIn(origin, "add", "-A");
  gitIn(origin, "commit", "-qm", "upstream advance");
  const upstreamHead = gitIn(origin, "rev-parse", "HEAD");

  const r = await resetToOrigin(sess(clone), false);
  assert.equal(r.ok, true);
  assert.equal(gitIn(clone, "rev-parse", "HEAD"), upstreamHead);
  assert.equal(readFileSync(join(clone, "keep.txt"), "utf8"), "base\nupstream-new\n");
});

test("resetToOrigin releases the feature branch it was standing on", async () => {
  const clone = mkCloneOnBranch("harness-reset-branch-", "mancej/feature");
  const upstream = gitIn(clone, "rev-parse", "origin/main");

  const r = await resetToOrigin(sess(clone, "mancej/feature"), false);
  assert.equal(r.ok, true);
  assert.equal(r.detached, true);

  // The checkout holds no branch at all, so nothing keys a finished PR to it: the
  // chip retires on the next poll and the next task is free to claim its own branch.
  assert.equal(gitIn(clone, "branch", "--show-current"), "");
  assert.equal(gitIn(clone, "rev-parse", "HEAD"), upstream);
  // The branch NAME survives (where the reset left it, at origin/main). Deleting it
  // would be a loss the confirm dialog never warned about; leaving it costs nothing
  // because the commits it held are already gone.
  assert.equal(gitIn(clone, "rev-parse", "mancej/feature"), upstream);
});

test("resetToOrigin leaves a checkout already on the default branch on it", async () => {
  const { clone } = mkOriginAndClone();

  // The main checkout's resting state: no PR is keyed to `main`, and detaching the
  // user's own tree out from under them is not a thing a reset should do.
  const r = await resetToOrigin(sess(clone), false);
  assert.equal(r.ok, true);
  assert.equal(r.detached, false);
  assert.equal(gitIn(clone, "branch", "--show-current"), "main");
});

test("resetToOrigin reports an already-detached checkout as detached", async () => {
  const { clone } = mkOriginAndClone();
  gitIn(clone, "checkout", "-q", "--detach", "origin/main");

  // Nothing holds this checkout, so there is nothing to release - but `detached`
  // describes where the checkout ENDS UP, not whether this reset moved it there.
  const r = await resetToOrigin(sess(clone, null), false);
  assert.equal(r.ok, true);
  assert.equal(r.detached, true);
  assert.equal(gitIn(clone, "branch", "--show-current"), "");
});

test("resetToOrigin with clear:true reports cleared:false when the session has no pane", async () => {
  const { clone } = mkOriginAndClone();
  // No terminal handle -> sendText can't deliver /clear, but the git reset
  // has already landed, so the whole op still succeeds (cleared just stays false).
  const r = await resetToOrigin(sess(clone), true);
  assert.equal(r.ok, true);
  assert.equal(r.cleared, false);
});

/**
 * A session with a pane, and a fake terminal behind it that plays back `screens` one
 * capture at a time.
 *
 * `cleared` is the only claim in the result that depends on the AGENT rather than on
 * git, and it is the one a caller types behind - so it has to be driven, not assumed.
 */
function withFakePane(clone: string, screens: (string | null)[]) {
  const session = {
    ...sess(clone),
    terminals: [mkMuxHandle()],
  };
  const deps = {
    // Exit 0 with empty output: the terminal took the keystrokes, and the pane is in no
    // mode. The real adapter runs on it, so the commands are the ones tmux would get.
    pane: (s: PaneHandles) => bindSession(s, async () => stubRun({ stdout: "", stderr: "", code: 0 })),
    capture: async () => (screens.length ? screens.shift()! : screens[screens.length - 1] ?? null),
    sleep: async () => {},
  };
  return { session, deps };
}

test("resetToOrigin reports cleared only once the agent has ACTED on the /clear", async () => {
  // tmux accepting the keystrokes is not the event that matters. `TaskManager.assign`
  // pastes a task's intent behind this, and a `/clear` processed after that paste wipes
  // the prompt off the composer while every check downstream still reads success.
  const { clone } = mkOriginAndClone();
  const { session, deps } = withFakePane(clone, [
    "❯ ", // before: the composer as it was
    "❯ /clear", // typed, not yet acted on - the window the race lives in
    "welcome back", // the screen the clear leaves behind
  ]);
  const r = await resetToOrigin(session, true, deps);
  assert.equal(r.ok, true);
  assert.equal(r.cleared, true);
});

test("a /clear that sits in the composer is never reported as cleared", async () => {
  const { clone } = mkOriginAndClone();
  const { session, deps } = withFakePane(clone, ["❯ ", "❯ /clear"]);
  const r = await resetToOrigin(session, true, deps);
  assert.equal(r.ok, true, "the git half landed, and that is still true");
  assert.equal(r.cleared, false, "an unacted /clear must not read as a cleared context");
});

test("a pane we cannot read reports cleared:false rather than assuming the best", async () => {
  // "I could not see it happen" and "it happened" are the two answers this must never
  // collapse: the caller uses this one to decide whether it is safe to type.
  const { clone } = mkOriginAndClone();
  const { session, deps } = withFakePane(clone, [null]);
  const r = await resetToOrigin(session, true, deps);
  assert.equal(r.cleared, false);
});

test("reset degrades gracefully outside a repo and with no working dir", async () => {
  const notRepo = realpathSync(mkdtempSync(join(tmpdir(), "harness-reset-nogit-")));
  const p = await resetPreview(sess(notRepo));
  assert.equal(p.ok, false);
  assert.equal(p.error, "not a git repository");

  const r = await resetToOrigin(sess(notRepo), false);
  assert.equal(r.ok, false);
  assert.equal(r.error, "not a git repository");

  const n = await resetPreview(sess(null));
  assert.equal(n.ok, false);
  assert.match(n.error ?? "", /no working directory/);
});
