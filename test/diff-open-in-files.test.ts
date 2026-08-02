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

test("a changed file resolves to an absolute href under the session cwd", () => {
  const target = diffFileOpenTarget(mkFile(), "/repo", "/repo");
  assert.equal(target.reason, null);
  assert.equal(target.href, "/repo/src/web/App.tsx");
});

test("every non-deleted status gets a route, not just modified", () => {
  for (const status of ["added", "renamed", "modified"] as const) {
    const target = diffFileOpenTarget(mkFile({ status }), "/repo", "/repo");
    assert.equal(target.reason, null, `${status} should be openable`);
    assert.equal(target.href, "/repo/src/web/App.tsx");
  }
});

test("a deleted file has no working-tree copy, so it reports why instead of a route", () => {
  const target = diffFileOpenTarget(mkFile({ status: "deleted" }), "/repo", "/repo");
  assert.equal(target.href, null);
  assert.match(target.reason ?? "", /deleted/i);
});

/**
 * The bug this function exists to prevent. Git writes toplevel-relative paths, the Files
 * tab is rooted at the session's cwd, and a session opened inside a package sees both.
 * Handing the patch's `src/index.ts` straight to the Files tab would open the package's
 * OWN `src/index.ts` - a real file, wrong file, no error anywhere.
 */
test("a changed file outside the session's cwd is refused, not silently rebased", () => {
  const target = diffFileOpenTarget(
    mkFile({ path: "src/index.ts" }),
    "/repo",
    "/repo/packages/app",
  );
  assert.equal(target.href, null, "must not resolve to /repo/packages/app/src/index.ts");
  assert.match(target.reason ?? "", /outside/i);
});

test("a changed file inside a subdirectory cwd keeps its full repo-root path", () => {
  const target = diffFileOpenTarget(
    mkFile({ path: "packages/app/src/index.ts" }),
    "/repo",
    "/repo/packages/app",
  );
  assert.equal(target.reason, null);
  // Absolute, so the one resolver downstream re-derives "src/index.ts" relative to cwd.
  assert.equal(target.href, "/repo/packages/app/src/index.ts");
});

test("a sibling directory that shares a name prefix with the cwd is still outside it", () => {
  const target = diffFileOpenTarget(
    mkFile({ path: "app-legacy/src/index.ts" }),
    "/repo",
    "/repo/app",
  );
  assert.equal(target.href, null);
  assert.match(target.reason ?? "", /outside/i);
});

test("a missing cwd or repo root disables the jump with its own reason", () => {
  const noCwd = diffFileOpenTarget(mkFile(), "/repo", null);
  assert.equal(noCwd.href, null);
  assert.match(noCwd.reason ?? "", /working directory/i);

  const noRoot = diffFileOpenTarget(mkFile(), null, "/repo");
  assert.equal(noRoot.href, null);
  assert.match(noRoot.reason ?? "", /checkout root/i);
});

test("a trailing slash on the repo root does not double up in the href", () => {
  const target = diffFileOpenTarget(mkFile(), "/repo/", "/repo");
  assert.equal(target.href, "/repo/src/web/App.tsx");
});

test("the jump renders for every file, and says why when it cannot act", () => {
  const viewer = readFileSync(
    fileURLToPath(new URL("../src/web/components/DiffViewer.tsx", import.meta.url)),
    "utf8",
  );

  // One control per rendered file, driven by the resolver rather than by `file.status`
  // at the call site - so "deleted" and "outside the checkout" cannot drift apart.
  assert.match(viewer, /diffFileOpenTarget\(active, diff\.repoRoot, session\.cwd\)/);
  assert.match(viewer, /aria-disabled=\{target\.href === null\}/);
  assert.match(viewer, /label=\{target\.reason \?\? `Open \$\{file\.path\} in the Files tab`\}/);
  // `aria-disabled`, never `disabled`: a disabled button is not focusable and its tooltip
  // is unreachable, which is where the reason lives.
  assert.doesNotMatch(viewer, /className="diff-open-file"[\s\S]{0,200}\sdisabled\b/);
});

test("both diff hosts route the jump through the one open-a-file path", () => {
  const detail = readFileSync(
    fileURLToPath(new URL("../src/web/components/layouts/ConsoleDetail.tsx", import.meta.url)),
    "utf8",
  );
  const app = readFileSync(
    fileURLToPath(new URL("../src/web/App.tsx", import.meta.url)),
    "utf8",
  );

  // Console and Board: the same callback a transcript file link uses.
  assert.match(detail, /onOpenInFiles=\{\(href\) => view\.onOpenFile\(session\.id, href\)\}/);
  // Cards: no Files tab, so the diff overlay stands down before the Files window opens.
  assert.match(app, /closeDiff\(\);\s*\n\s*openSessionFile\(sessionId, href\);/);
});
