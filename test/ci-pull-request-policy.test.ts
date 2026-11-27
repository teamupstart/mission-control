import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(new URL("../scripts/check-pull-request-policy.mjs", import.meta.url));

test("the CI pull request gate checks incoming trailers and changed paths against the merge base", (t) => {
  const root = mkdtempSync(join(tmpdir(), "mission-pr-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const git = (...args: string[]) => execFileSync("git", [
    "-c", "user.name=Policy Fixture", "-c", "user.email=policy@example.test",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args,
  ], { cwd: root, encoding: "utf8" }).trim();

  function write(path: string, contents: string) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
    git("add", "--", path);
  }

  function commit(message: string) {
    git("commit", "-qm", message);
    return git("rev-parse", "HEAD");
  }

  git("init", "-q");
  write("CHANGELOG.md", "# Changelog\n");
  const legacy = [
    "e2e/evidence/old.png",
    "docs/plans/old/evidence/old.jpg",
    "docs/plans/old/verification/old.webp",
    "docs/plans/old/shots/old.gif",
  ];
  for (const path of legacy) write(path, "existing");
  const base = commit("Baseline\n\nCo-authored-by: Claude <noreply@anthropic.com>");
  const repo = { full_name: "owner/repo" };
  const releaseRef = "release-please--branches--main--components--mission-control";

  function run(head: string, login = "contributor", ref = "feature", headRepo = repo, prBase = base) {
    const eventPath = join(root, "event.json");
    writeFileSync(eventPath, JSON.stringify({
      pull_request: {
        user: { login },
        base: { sha: prBase, ref: "main", repo },
        head: { sha: head, ref, repo: headRepo },
      },
    }));
    return spawnSync(process.execPath, [checker, eventPath], { cwd: root, encoding: "utf8" });
  }

  for (const path of legacy) write(path, "updated");
  write("docs/images/new.png", "product documentation");
  write("build/new-tray-icon.png", "desktop build asset");
  write("src/web/public/new-icon.svg", "web application asset");
  const clean = commit("Document behavior\n\nCo-authored-by: Claude Smith <colleague@example.test>");
  const allowed = run(clean);
  assert.equal(allowed.status, 0, allowed.stderr);
  t.diagnostic("Accepted new desktop and web assets alongside documentation images.");

  write("CHANGELOG.md", "# Changelog\n\nNew version");
  const release = commit("Regenerate changelog");
  assert.equal(run(release, "mission-control-release[bot]", releaseRef).status, 0);
  for (const result of [
    run(release, "contributor", releaseRef),
    run(release, "mission-control-release[bot]", "agent-sdk-update"),
    run(release, "mission-control-release[bot]", releaseRef, { full_name: "fork/repo" }),
  ]) {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /only Release Please pull requests/);
  }
  t.diagnostic("Rejected changelog changes without the release app, release branch, and canonical repository.");

  for (const path of legacy) write(path.replace("old.", "new."), "new evidence");
  write("unclassified screen.PNG", "evidence outside a named folder");
  write("src/web/public/evidence/screenshot.png", "evidence in an asset directory");
  const blocked = commit("Add proof\n\nco-authored-by: Claude Opus 5.5 <noreply@anthropic.com>\nCo-authored-by: Copilot <copilot@users.noreply.github.com>");
  const result = run(blocked, "mission-control-release[bot]", releaseRef);
  assert.equal(result.status, 1);
  assert.equal(result.stderr.match(/remove the agent Co-authored-by trailer/g)?.length, 2, result.stderr);
  assert.equal(result.stderr.match(/new images must be in/g)?.length, 6, result.stderr);
  t.diagnostic("Rejected two incoming agent co-authors and six incoming evidence image paths. Accepted human co-authors, existing evidence paths, and docs/images.");

  const sharedAddition = "e2e/evidence/parallel.png";
  git("switch", "--quiet", "--detach", base);
  write(sharedAddition, "same image on both branches");
  const advancedBase = commit("Add image on base");
  git("switch", "--quiet", "--detach", base);
  write(sharedAddition, "same image on both branches");
  const divergentHead = commit("Add image on feature");
  const divergent = run(divergentHead, "contributor", "feature", repo, advancedBase);
  assert.equal(divergent.status, 1);
  assert.match(divergent.stderr, /"e2e\/evidence\/parallel\.png": new images must be in/);
  t.diagnostic("Rejected the same image path added independently on both sides of the merge base.");

  git("switch", "--quiet", "--detach", base);
  const renamedPath = "e2e/evidence/renamed.png";
  git("mv", "--", legacy[0]!, renamedPath);
  const renameHead = commit("Move existing evidence");
  const renamed = run(renameHead);
  assert.equal(renamed.status, 1);
  assert.match(renamed.stderr, /"e2e\/evidence\/renamed\.png": new images must be in/);
  t.diagnostic("Rejected the destination of a tracked evidence image moved to a new path.");
});
