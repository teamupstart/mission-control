import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetPreview, resetToOrigin } from "../src/server/actions.ts";
import { gitIn, mkOriginAndClone as mkFixture } from "./helpers/git-fixture.ts";
import type { Session } from "../src/shared/types.ts";

const mkOriginAndClone = (): { origin: string; clone: string } => mkFixture("harness-reset-");

/** A minimal Session over `cwd`, with no pane (so `/clear` is a no-op we can assert). */
function sess(cwd: string | null, branch: string | null = "main"): Session {
  return {
    id: "s1", agent: "claude", name: "work", nameSource: "process", state: "idle",
    cwd, gitBranch: branch, gitRoot: null, nomistakesGated: false, pid: 1, tty: null,
    permissionMode: null, wezterm: null, tmux: null, agentSessionId: null, transcriptPath: null,
    instrumented: false, activity: null, startedAt: null, firstSeen: 0, lastSeen: 0,
    lastActivity: null, pendingReviews: 0, nomistakes: null, task: null,
    nomistakesNarration: null, prUrl: null, prNumber: null, prState: null, prChecks: null,
    meta: null, note: null,
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

test("resetToOrigin with clear:true reports cleared:false when the session has no pane", async () => {
  const { clone } = mkOriginAndClone();
  // No tmux/wezterm handle -> sendText can't deliver /clear, but the git reset
  // has already landed, so the whole op still succeeds (cleared just stays false).
  const r = await resetToOrigin(sess(clone), true);
  assert.equal(r.ok, true);
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
