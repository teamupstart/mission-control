// `removeTree`'s contract in plain Node. Why it exists at all (Electron's asar layer) can only be
// shown under Electron: see `test/remove-tree-electron.test.ts`.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { removeTree, TreeRemovalError } from "../src/server/util/remove-tree.ts";
import { ownWorktreeProcesses } from "../src/server/worktrees/own-processes.ts";

function scratch(t: TestContext): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mission-remove-tree-")));
  t.after(() => {
    try { chmodSync(join(root, "tree", "locked"), 0o755); } catch { /* not every case locks it */ }
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function tree(root: string): string {
  const path = join(root, "tree");
  mkdirSync(join(path, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(path, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
  writeFileSync(join(path, "README.md"), "fixture\n");
  return path;
}

/** A stand-in `rm` that never finishes, as the asar layer's delete did not. */
function hangingRm(root: string): string {
  const path = join(root, "hanging-rm");
  writeFileSync(path, "#!/bin/sh\nexec /bin/sleep 60\n", { mode: 0o755 });
  return path;
}

test("removes a whole tree and proves nothing is left", async (t) => {
  const path = tree(scratch(t));
  await removeTree(path);
  assert.equal(existsSync(path), false);
});

test("never follows a symbolic link, at the path or inside the tree", async (t) => {
  const root = scratch(t);
  const outside = join(root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "kept.txt"), "kept\n");
  const path = tree(root);
  symlinkSync(outside, join(path, "link"));
  const top = join(root, "top-link");
  symlinkSync(outside, top);
  await removeTree(path);
  await removeTree(top);
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(top), false);
  assert.ok(existsSync(join(outside, "kept.txt")), "the link's target is untouched");
});

test("a missing path is removed by default and an ENOENT when the caller proved it was there", async (t) => {
  const root = scratch(t);
  await removeTree(join(root, "absent"));
  await assert.rejects(removeTree(join(root, "absent"), { allowMissing: false }), { code: "ENOENT" });
});

test("refuses a relative path and a filesystem root before anything runs", async () => {
  await assert.rejects(removeTree("relative/tree"), /not absolute/);
  await assert.rejects(removeTree(""), /not absolute/);
  await assert.rejects(removeTree("/"), /filesystem root/);
  await assert.rejects(removeTree("//"), /filesystem root/);
});

test("a delete that cannot finish is a reported failure, and what it could not reach stays", {
  skip: process.getuid?.() === 0 ? "root ignores directory permissions" : false,
}, async (t) => {
  const root = scratch(t);
  const path = tree(root);
  mkdirSync(join(path, "locked"));
  writeFileSync(join(path, "locked", "held.txt"), "held\n");
  chmodSync(join(path, "locked"), 0o555);
  const error = await removeTree(path).then(() => null, (caught: unknown) => caught);
  assert.ok(error instanceof TreeRemovalError, String(error));
  assert.equal(error.ended, "failed");
  assert.match(error.message, /^rm -rf exited with code 1: .*held\.txt/);
  assert.ok(existsSync(join(path, "locked", "held.txt")));
});

test("a delete whose child cannot launch is a reported failure that touches nothing", async (t) => {
  const root = scratch(t);
  const path = tree(root);
  const error = await removeTree(path, { executable: join(root, "no-such-rm") }).then(() => null, (caught: unknown) => caught);
  assert.ok(error instanceof TreeRemovalError, String(error));
  assert.equal(error.ended, "failed");
  assert.match(error.message, /^rm could not start: .*ENOENT/);
  assert.ok(existsSync(join(path, "node_modules", "pkg", "index.js")));
  assert.equal(ownWorktreeProcesses().size, 0);
});

test("a child that reports success but leaves the tree is a reported failure, never a removal", async (t) => {
  const root = scratch(t);
  const path = tree(root);
  const liar = join(root, "succeeding-rm");
  writeFileSync(liar, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const error = await removeTree(path, { executable: liar }).then(() => null, (caught: unknown) => caught);
  assert.ok(error instanceof TreeRemovalError, String(error));
  assert.equal(error.ended, "failed");
  assert.equal(error.message, `rm -rf reported success but ${path} remains`);
  assert.ok(existsSync(join(path, "node_modules", "pkg", "index.js")), "the tree is still there");
});

test("a removal with no time left is out of time before anything starts", async (t) => {
  const root = scratch(t);
  const path = tree(root);
  const started = join(root, "started");
  const marking = join(root, "marking-rm");
  writeFileSync(marking, `#!/bin/sh\n: > ${JSON.stringify(started)}\nexec /bin/rm "$@"\n`, { mode: 0o755 });
  for (const timeoutMs of [0, -1]) {
    const error = await removeTree(path, { timeoutMs, executable: marking }).then(() => null, (caught: unknown) => caught);
    assert.ok(error instanceof TreeRemovalError, String(error));
    assert.equal(error.ended, "timedOut");
    assert.equal(error.message, `removal of ${path} had no time left`);
  }
  assert.equal(existsSync(started), false, "no delete was launched");
  assert.ok(existsSync(join(path, "node_modules", "pkg", "index.js")), "the tree is untouched");
});

test("a delete that hangs is killed at its deadline and reported, never awaited forever", async (t) => {
  const root = scratch(t);
  const path = tree(root);
  const started = Date.now();
  const error = await removeTree(path, { timeoutMs: 300, executable: hangingRm(root) }).then(() => null, (caught: unknown) => caught);
  assert.ok(error instanceof TreeRemovalError, String(error));
  assert.equal(error.ended, "timedOut");
  assert.match(error.message, /timed out after 0\.3 s/);
  assert.ok(Date.now() - started < 10_000, "the deadline bounds the wait");
  assert.equal(ownWorktreeProcesses().size, 0, "the killed child is no longer counted as the daemon's own");
});

test("a Stop kills the delete and is reported as stopped", async (t) => {
  const root = scratch(t);
  const path = tree(root);
  const controller = new AbortController();
  const pending = removeTree(path, { signal: controller.signal, executable: hangingRm(root) });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending, (error: unknown) => error instanceof TreeRemovalError && error.ended === "stopped");
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(removeTree(path, { signal: aborted.signal }), (error: unknown) =>
    error instanceof TreeRemovalError && error.ended === "stopped");
  assert.ok(existsSync(path), "a removal stopped before it started touches nothing");
});

test("the delete counts as the daemon's own process while it runs, so occupancy never blames it", async (t) => {
  const root = scratch(t);
  const path = tree(root);
  const pending = removeTree(path, { timeoutMs: 1_000, executable: hangingRm(root) });
  const deadline = Date.now() + 5_000;
  while (ownWorktreeProcesses().size === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(ownWorktreeProcesses().size, 1);
  await assert.rejects(pending, TreeRemovalError);
  assert.equal(ownWorktreeProcesses().size, 0);
});
