import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { publishNativeAddon } from "../scripts/native-addon-publish.mjs";

/**
 * Publishing a native addon, and the one property that keeps a daemon startable.
 *
 * `copyFile` onto the published path keeps the destination's inode. On macOS, rewriting an
 * addon that some live process has mapped invalidates the kernel's code-signature bookkeeping
 * for that vnode, and every later process that loads it is `SIGKILL`ed with an empty stderr -
 * no exception, no log line, exit code 137. `codesign` still calls the file valid and the
 * byte-identical file at a fresh inode still loads, so nothing about the file looks wrong.
 *
 * That is not a hypothetical: `npm run build:native` runs on every `make start`, a restarting
 * developer has the previous daemon or Electron shell holding the addon open, and one such
 * restart left this repository's `dist/native/keep-awake.node` permanently unloadable. Every
 * daemon spawned from that worktree then died during startup, including the ones
 * `test/daemon-state-ownership.test.ts` spawns.
 *
 * These tests pin the mechanical property that prevents it - the destination is REPLACED, never
 * written through - without needing a real signed addon or a macOS host.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** A disposable `dist/native`, with an addon already published into it. */
function published(bytes = "first build"): { dir: string; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "mission-native-publish-"));
  const output = join(dir, "addon.node");
  writeFileSync(output, bytes);
  return { dir, output };
}

test("publishing replaces the destination rather than writing through it", async () => {
  const { dir, output } = published();
  const before = statSync(output).ino;

  const built = join(dir, "built.node");
  writeFileSync(built, "second build");
  await publishNativeAddon(built, output);

  assert.equal(readFileSync(output, "utf8"), "second build");
  assert.notEqual(
    statSync(output).ino,
    before,
    "the published name must resolve to a new inode, or macOS kills every process that loads it",
  );
});

test("a process holding the previous addon keeps reading the bytes it opened", async () => {
  // The running daemon, modelled: it mapped the old addon and must go on seeing exactly what
  // it validated. A rename leaves that inode alone; a copy would rewrite it underneath.
  const { dir, output } = published("mapped by the running daemon");
  const held = openSync(output, "r");
  try {
    const built = join(dir, "built.node");
    writeFileSync(built, "rebuilt while the daemon was up");
    await publishNativeAddon(built, output);

    const buffer = Buffer.alloc(64);
    const read = readSync(held, buffer, 0, buffer.length, 0);
    assert.equal(buffer.subarray(0, read).toString("utf8"), "mapped by the running daemon");
    assert.equal(readFileSync(output, "utf8"), "rebuilt while the daemon was up");
  } finally {
    closeSync(held);
  }
});

test("a failed publish leaves the previous addon in place and no staging behind", async () => {
  const { dir, output } = published("the addon that still works");

  await assert.rejects(publishNativeAddon(join(dir, "never-built.node"), output));

  assert.equal(readFileSync(output, "utf8"), "the addon that still works");
  assert.deepEqual(
    readdirSync(dir),
    ["addon.node"],
    "a staging directory left in dist/native would ship as a half-built addon",
  );
});

/** Does this build script hand its artifact to the shared publisher, and copy nothing itself? */
function publishesThroughTheHelper(file: string): { imports: boolean; calls: boolean; copies: boolean } {
  const source = readFileSync(join(REPO_ROOT, "scripts", file), "utf8");
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);

  let imports = false;
  let calls = false;
  let copies = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text.endsWith("native-addon-publish.mjs")
    ) {
      imports = true;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === "publishNativeAddon") calls = true;
      // The defect this file exists for. `copyFile` is legitimate inside a private staging
      // directory, but a builder that reaches for it at all is one edit away from aiming it
      // at `dist/native`, and that is exactly how the two builders drifted apart.
      if (node.expression.text === "copyFile" || node.expression.text === "copyFileSync") {
        copies = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return { imports, calls, copies };
}

test("every native builder publishes through the one place that knows why", () => {
  // Both addons are loaded by the daemon at startup, so both carry the same consequence for
  // getting this wrong. `keep-awake` did not, for as long as it published its own output, and
  // nothing failed until a developer restarted the stack at the wrong moment.
  for (const script of ["build-state-lock-native.mjs", "build-keep-awake-native.mjs"]) {
    const { imports, calls, copies } = publishesThroughTheHelper(script);
    assert.ok(imports, `${script} must import the shared publisher`);
    assert.ok(calls, `${script} must publish through publishNativeAddon`);
    assert.equal(copies, false, `${script} must not copy its own artifact into dist/native`);
  }
});
