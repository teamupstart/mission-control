// `removeTree`'s contract in plain Node. Why it exists at all (Electron's asar layer) can only be
// shown under Electron: see `test/remove-tree-electron.test.ts`.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("a trailing backslash is part of the name, so its sibling without one is never the target", async (t) => {
  const root = scratch(t);
  const named = join(root, "deps\\");
  const sibling = join(root, "deps");
  for (const path of [named, sibling]) {
    mkdirSync(join(path, "pkg"), { recursive: true });
    writeFileSync(join(path, "pkg", "index.js"), "module.exports = 1;\n");
  }
  await removeTree(named);
  assert.equal(existsSync(named), false, "the exact path named is removed");
  assert.ok(existsSync(join(sibling, "pkg", "index.js")), "the sibling without the backslash is untouched");

  // A trailing `/` is still only a separator.
  await removeTree(`${sibling}/`);
  assert.equal(existsSync(sibling), false);
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
  assert.equal(error.message, `rm -rf reported success but ${path} remains (after 3 attempts)`);
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

/**
 * A stand-in `rm` that counts its runs in `count` and fails the first `failures` of them with
 * `rm`'s own kind of message, then hands over to the real `rm`.
 */
function failingRm(root: string, failures: number): { rm: string; runs: () => number } {
  const rm = join(root, "failing-rm");
  const count = join(root, "runs");
  writeFileSync(rm, [
    "#!/bin/sh",
    `echo run >> ${JSON.stringify(count)}`,
    `n=$(wc -l < ${JSON.stringify(count)})`,
    `if [ "$n" -le ${failures} ]; then echo "rm: $3: Directory not empty" >&2; exit 1; fi`,
    'exec /bin/rm "$@"',
    "",
  ].join("\n"), { mode: 0o755 });
  return { rm, runs: () => (existsSync(count) ? readFileSync(count, "utf8").trim().split("\n").length : 0) };
}

test("an rm that fails once is retried, as fs.rm's maxRetries: 2 was, and the tree is removed", async (t) => {
  const root = scratch(t);
  const path = tree(root);
  const fake = failingRm(root, 1);
  await removeTree(path, { executable: fake.rm });
  assert.equal(fake.runs(), 2, "one failure, then the retry that removed it");
  assert.equal(existsSync(path), false);
});

test("an rm that keeps failing is tried three times in all, then reported with its own reason", async (t) => {
  const root = scratch(t);
  const path = tree(root);
  const fake = failingRm(root, 99);
  const started = Date.now();
  const error = await removeTree(path, { executable: fake.rm }).then(() => null, (caught: unknown) => caught);
  assert.ok(error instanceof TreeRemovalError, String(error));
  assert.equal(error.ended, "failed");
  assert.match(error.message, /^rm -rf exited with code 1: rm: .*Directory not empty \(after 3 attempts\)$/);
  assert.equal(fake.runs(), 3, "the first run and two retries");
  assert.ok(Date.now() - started >= 300, "a linear backoff of 100 ms, then 200 ms, between them");
  assert.ok(existsSync(join(path, "node_modules", "pkg", "index.js")));
});

test("maxRetries: 0 makes a single attempt", async (t) => {
  const root = scratch(t);
  const path = tree(root);
  const fake = failingRm(root, 99);
  const error = await removeTree(path, { executable: fake.rm, maxRetries: 0 }).then(() => null, (caught: unknown) => caught);
  assert.ok(error instanceof TreeRemovalError);
  assert.match(error.message, /^rm -rf exited with code 1: [^()]*$/, "one attempt carries no attempt count");
  assert.equal(fake.runs(), 1);
});

test("a Stop during the pause between attempts ends the removal without another attempt", async (t) => {
  const root = scratch(t);
  const path = tree(root);
  const fake = failingRm(root, 99);
  const controller = new AbortController();
  const pending = removeTree(path, { executable: fake.rm, retryDelayMs: 5_000, signal: controller.signal });
  const until = Date.now() + 10_000;
  while (fake.runs() === 0 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
  await new Promise((resolve) => setTimeout(resolve, 100));
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof TreeRemovalError && error.ended === "stopped");
  assert.equal(fake.runs(), 1, "the Stop landed in the backoff, so no retry ran");
});

test("retries never outlast the deadline: a backoff that would cross it ends as timed out", async (t) => {
  const root = scratch(t);
  const path = tree(root);
  const fake = failingRm(root, 99);
  const started = Date.now();
  const error = await removeTree(path, { executable: fake.rm, timeoutMs: 2_000, retryDelayMs: 5_000 })
    .then(() => null, (caught: unknown) => caught);
  assert.ok(error instanceof TreeRemovalError);
  assert.equal(error.ended, "timedOut");
  assert.equal(fake.runs(), 1);
  assert.ok(Date.now() - started < 2_000, "it gave up at once instead of sleeping past the deadline");
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
