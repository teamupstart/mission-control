import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// A fake `gh` that records its argv and reports no pull requests, set in the file body as the
// suite's other executable overrides are.
const fakeGhDir = mkdtempSync(join(tmpdir(), "pr-origin-repo-gh-"));
const fakeGhArgv = join(fakeGhDir, "argv.json");
writeFileSync(
  join(fakeGhDir, "gh"),
  `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(fakeGhArgv)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write("[]");\n`,
  { mode: 0o755 },
);
process.env.MISSION_GH_BIN = join(fakeGhDir, "gh");
process.on("exit", () => rmSync(fakeGhDir, { recursive: true, force: true }));

const { prListArgs, queryPr } = await import("../src/server/pr.ts");
const { openPullRequestCommand, originRepositoryShell } = await import("../src/shared/pr-command.mjs");

// A fork of an org that enforces SAML SSO: `gh` left to choose prefers the `upstream` remote
// outside a terminal, and asking about that parent fails for a login not authorized there.
function forkCheckout(origin: string | null): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pr-origin-repo-"));
  execFileSync("git", ["init", "-q", dir]);
  if (origin) execFileSync("git", ["-C", dir, "remote", "add", "origin", origin]);
  execFileSync("git", ["-C", dir, "remote", "add", "upstream", "https://github.com/org/parent.git"]);
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

function commit(dir: string): void {
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"]);
}

test("the branch lookup always names its repository", () => {
  assert.deepEqual(prListArgs("feat/x", "me/fork").slice(0, 6), ["pr", "list", "--repo", "me/fork", "--head", "feat/x"]);
});

test("the poller's branch lookup asks gh about origin's repository, not upstream's", async (t) => {
  const repo = forkCheckout("https://github.com/me/fork.git");
  t.after(repo.done);
  commit(repo.dir);
  assert.equal(await queryPr(repo.dir, "feat/x"), null);
  const argv = JSON.parse(readFileSync(fakeGhArgv, "utf8")) as string[];
  assert.deepEqual(argv.slice(0, 6), ["pr", "list", "--repo", "me/fork", "--head", "feat/x"]);
});

test("the poller follows a gh default pin on another remote", async (t) => {
  const repo = forkCheckout("https://github.com/me/fork.git");
  t.after(repo.done);
  commit(repo.dir);
  execFileSync("git", ["-C", repo.dir, "config", "remote.upstream.gh-resolved", "base"]);
  assert.equal(await queryPr(repo.dir, "feat/x"), null);
  const argv = JSON.parse(readFileSync(fakeGhArgv, "utf8")) as string[];
  assert.deepEqual(argv.slice(0, 4), ["pr", "list", "--repo", "org/parent"]);
});

// Without a resolvable repository the old poller ran a bare `gh pr list`, and gh's own choice
// was the fork's parent. Now it never asks: "error" leaves the chip as it was.
test("a checkout with no GitHub origin and no pin answers error without running gh", async (t) => {
  for (const origin of [null, "https://gitlab.com/me/fork.git"]) {
    const repo = forkCheckout(origin);
    t.after(repo.done);
    commit(repo.dir);
    rmSync(fakeGhArgv, { force: true });
    assert.equal(await queryPr(repo.dir, "feat/x"), "error", String(origin));
    assert.equal(existsSync(fakeGhArgv), false, "gh must not run");
  }
});

// PR creation depends on this snippet alone, so run it rather than read it: a sed that left
// the scp prefix or the `.git` in place, or a JS-to-shell escaping slip, would name no repo.
test("the open command reads its repository through the exported origin line", () => {
  // Skills copy `originRepositoryShell` verbatim; the open command must be built on the same
  // line, so the run below proves every copy. The full text is pinned too: the Inspector adopts
  // a pull request from this exact command, and every instruction already shipped gives it.
  assert.ok(openPullRequestCommand("main").startsWith(`${originRepositoryShell} && `));
  assert.equal(
    openPullRequestCommand("main"),
    String.raw`repo=$(git remote get-url origin | sed -E 's#^.*github\.com[:/]##; s#\.git$##') && ` +
      String.raw`gh api "repos/$repo/pulls" -f head="$(git branch --show-current)" -f base=main ` +
      String.raw`-f title="<title>" -F body=@<body-file> --jq .html_url`,
  );
});

test("the open command's origin snippet resolves owner/repo from every GitHub URL form", async (t) => {
  const prefix = originRepositoryShell;
  for (const url of [
    "https://github.com/me/fork.git",
    "https://github.com/me/fork",
    "git@github.com:me/fork.git",
    "git@github.com:me/fork",
    "ssh://git@github.com/me/fork.git",
  ]) {
    const repo = forkCheckout(url);
    t.after(repo.done);
    const out = execFileSync("sh", ["-c", `${prefix} && printf %s "$repo"`], { cwd: repo.dir, encoding: "utf8" });
    assert.equal(out, "me/fork", url);
  }
});
