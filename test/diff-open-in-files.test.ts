import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { diffFileOpenTarget, type DiffFile } from "../src/web/lib/diff.ts";

function mkFile(overrides: Partial<DiffFile> = {}): DiffFile {
  return {
    path: "src/web/App.tsx",
    status: "modified",
    added: 3,
    removed: 1,
    binary: false,
    lines: [],
    ...overrides,
  };
}

test("a changed file resolves to a path relative to the session cwd", () => {
  const target = diffFileOpenTarget(mkFile(), "/repo", "/repo");
  assert.equal(target.reason, null);
  assert.equal(target.path, "src/web/App.tsx");
});

test("every non-deleted status gets a route, not just modified", () => {
  for (const status of ["added", "renamed", "modified"] as const) {
    const target = diffFileOpenTarget(mkFile({ status }), "/repo", "/repo");
    assert.equal(target.reason, null, `${status} should be openable`);
    assert.equal(target.path, "src/web/App.tsx");
  }
});

test("a deleted file has no working-tree copy, so it reports why instead of a route", () => {
  const target = diffFileOpenTarget(mkFile({ status: "deleted" }), "/repo", "/repo");
  assert.equal(target.path, null);
  assert.match(target.reason ?? "", /deleted/i);
});

/**
 * The bug this function exists to prevent. Git writes toplevel-relative paths, the Files
 * tab is rooted at the session's cwd, and a session opened inside a package sees both.
 * Handing the patch's `src/index.ts` straight to the Files tab would open the package's
 * OWN `src/index.ts` - a real file, wrong file, no error anywhere. Verified against the
 * daemon: `readSessionFile("/mono/packages/app", "src/index.ts")` returns the package's
 * file, and the only path that reaches the root's is refused 403.
 *
 * Refusing here is a HUMAN DECISION, taken after review asked for the opposite. Making
 * this file openable means re-rooting the Files workspace at the repo root, not
 * relaxing this check - see `diffFileOpenTarget`. Do not "fix" this test by asserting a
 * path; that would reinstate the wrong-file read.
 */
test("a changed file outside the session's cwd is refused, not silently rebased", () => {
  const target = diffFileOpenTarget(
    mkFile({ path: "src/index.ts" }),
    "/repo",
    "/repo/packages/app",
  );
  assert.equal(target.path, null, "must not resolve to the package's own src/index.ts");
  assert.match(target.reason ?? "", /outside/i);
});

test("a changed file inside a subdirectory cwd is rebased onto that cwd", () => {
  const target = diffFileOpenTarget(
    mkFile({ path: "packages/app/src/index.ts" }),
    "/repo",
    "/repo/packages/app",
  );
  assert.equal(target.reason, null);
  // Rebased onto the cwd the Files workspace is actually rooted at.
  assert.equal(target.path, "src/index.ts");
});

test("a sibling directory that shares a name prefix with the cwd is still outside it", () => {
  const target = diffFileOpenTarget(
    mkFile({ path: "app-legacy/src/index.ts" }),
    "/repo",
    "/repo/app",
  );
  assert.equal(target.path, null);
  assert.match(target.reason ?? "", /outside/i);
});

test("a missing cwd or repo root disables the jump with its own reason", () => {
  const noCwd = diffFileOpenTarget(mkFile(), "/repo", null);
  assert.equal(noCwd.path, null);
  assert.match(noCwd.reason ?? "", /working directory/i);

  const noRoot = diffFileOpenTarget(mkFile(), null, "/repo");
  assert.equal(noRoot.path, null);
  assert.match(noRoot.reason ?? "", /checkout root/i);
});

test("a trailing slash on either directory does not corrupt the path", () => {
  assert.equal(diffFileOpenTarget(mkFile(), "/repo/", "/repo").path, "src/web/App.tsx");
  assert.equal(diffFileOpenTarget(mkFile(), "/repo", "/repo/").path, "src/web/App.tsx");
});

/**
 * `workspaceFileTarget` reads a trailing `:12` as a line number, which is right for a
 * path a human typed in a sentence and wrong for one git emitted. Routing the diff
 * through it opened `notes` for a file genuinely named `notes:12` - enabled, and the
 * wrong file. The diff path is exact and must stay that way.
 */
test("a filename ending in a colon and digits is not read as a line number", () => {
  assert.equal(diffFileOpenTarget(mkFile({ path: "notes:12" }), "/repo", "/repo").path, "notes:12");
  assert.equal(diffFileOpenTarget(mkFile({ path: "a/b:3:4" }), "/repo", "/repo").path, "a/b:3:4");
});

test("a path with a parent segment is refused rather than escaping the checkout", () => {
  const target = diffFileOpenTarget(mkFile({ path: "../outside.ts" }), "/repo", "/repo");
  assert.equal(target.path, null);
  assert.match(target.reason ?? "", /cannot be resolved/i);
});

test("the jump renders for every file, and says why when it cannot act", () => {
  const viewer = readFileSync(
    fileURLToPath(new URL("../src/web/components/DiffViewer.tsx", import.meta.url)),
    "utf8",
  );

  // One control per rendered file, driven by the resolver rather than by `file.status`
  // at the call site - so "deleted" and "outside the checkout" cannot drift apart.
  assert.match(viewer, /diffFileOpenTarget\(active, diff\.repoRoot, session\.cwd\)/);
  assert.match(viewer, /aria-disabled=\{target\.path === null\}/);
  assert.match(viewer, /label=\{target\.reason \?\? `Open \$\{file\.path\} in the Files tab`\}/);
  // `aria-disabled`, never `disabled`: a disabled button is not focusable and its tooltip
  // is unreachable, which is where the reason lives.
  assert.doesNotMatch(viewer, /className="diff-open-file"[\s\S]{0,200}\sdisabled\b/);
});

test("the shared diff reader routes the jump through the one open-a-file path", () => {
  const detail = readFileSync(
    fileURLToPath(new URL("../src/web/components/layouts/ConsoleDetail.tsx", import.meta.url)),
    "utf8",
  );
  const app = readFileSync(
    fileURLToPath(new URL("../src/web/App.tsx", import.meta.url)),
    "utf8",
  );

  // Console and Board: the shared destination, without the prose parsing.
  assert.match(detail, /onOpenInFiles=\{\(path\) => view\.onOpenFilePath\(session\.id, path\)\}/);
  assert.doesNotMatch(app, /closeDiff|setDiffSessionId/);
  // One destination, two entry points: prose hrefs still funnel through the exact-path
  // opener rather than duplicating the layout branching.
  assert.match(app, /openSessionPath\(sessionId, target\.path\);/);
});
