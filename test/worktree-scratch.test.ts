import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { NativeWorktreeGit } from "../src/server/worktrees/git.ts";
import { run } from "../src/server/util/exec.ts";
import { worktreeRepositoryIdentity } from "../src/server/util/git.ts";
import { gitIn, mkOriginAndClone } from "./helpers/git-fixture.ts";

function fixture(t: TestContext) {
  const { root, clone } = mkOriginAndClone("mission-worktree-scratch-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "slot");
  gitIn(clone, "worktree", "add", "--detach", path, "HEAD");
  const identity = worktreeRepositoryIdentity(clone)!;
  const write = (name: string, text = "harness state\n") => {
    const file = join(path, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  return { path, identity, write };
}

const scratch = [
  ".pipeline/.memory-count-at-start",
  ".pipeline/conduct-state.json",
  ".pipeline/engineer-run.json",
  ".pipeline/HALT",
  ".pipeline/HALT.class",
  ".pipeline/DONE",
  ".pipeline/events.jsonl",
  ".pipeline/gates/build.json",
] as const;

test("recognized untracked conductor state is clean and removable without force", async (t) => {
  const { path, identity, write } = fixture(t);
  for (const name of scratch) write(name);
  assert.match(gitIn(path, "status", "--porcelain", "--untracked-files=all"), /memory-count-at-start/);
  const git = new NativeWorktreeGit();
  const inspected = await git.inspect(path);
  assert.ok(inspected.ok);
  assert.equal(inspected.value.dirty, false);
  assert.equal(existsSync(join(path, scratch[0])), true, "inspection does not clean files");
  assert.deepEqual(await git.remove(identity, path, false), { ok: true, value: undefined });
  assert.equal(existsSync(path), false);
  assert.ok(!gitIn(identity.mainCheckoutRoot, "worktree", "list", "--porcelain").includes(path));
});

for (const name of [
  "notes.txt",
  ".pipeline/notes.txt",
  ".pipeline-copy/DONE",
  "nested/.pipeline/DONE",
  ".pipeline/gates/nested/notes.json",
  ".pipeline/DONE/notes.txt",
  'notes\n?? .pipeline/DONE',
  'a "quoted" file.txt',
  "résumé.txt",
]) {
  test(`unrecognized untracked content stays dirty: ${JSON.stringify(name)}`, async (t) => {
    const { path, identity, write } = fixture(t);
    write(scratch[0]);
    write(name, "real work\n");
    const git = new NativeWorktreeGit();
    const inspected = await git.inspect(path);
    assert.ok(inspected.ok);
    assert.equal(inspected.value.dirty, true);
    assert.equal((await git.remove(identity, path, false)).ok, false);
    assert.equal(readFileSync(join(path, name), "utf8"), "real work\n");
    assert.equal(existsSync(join(path, scratch[0])), true, "a dirty tree is not cleaned");
  });
}

for (const change of ["staged", "modified", "deleted", "renamed"] as const) {
  test(`tracked conductor files remain dirty when ${change}`, async (t) => {
    const { path, identity, write } = fixture(t);
    write(".pipeline/DONE");
    gitIn(path, "add", ".pipeline/DONE");
    if (change !== "staged") {
      gitIn(path, "commit", "-qm", "tracked pipeline data");
      if (change === "modified") write(".pipeline/DONE", "user edit\n");
      if (change === "deleted") rmSync(join(path, ".pipeline/DONE"));
      if (change === "renamed") gitIn(path, "mv", ".pipeline/DONE", ".pipeline/HALT");
    }
    const git = new NativeWorktreeGit();
    const inspected = await git.inspect(path);
    assert.ok(inspected.ok);
    assert.equal(inspected.value.dirty, true);
    assert.equal((await git.remove(identity, path, false)).ok, false);
    assert.equal(existsSync(path), true);
  });
}

test("symlinks at scratch file and directory paths remain dirty", async (t) => {
  const { path, write } = fixture(t);
  write(".pipeline/placeholder");
  rmSync(join(path, ".pipeline/placeholder"));
  symlinkSync("../keep.txt", join(path, ".pipeline/DONE"));
  const git = new NativeWorktreeGit();
  let inspected = await git.inspect(path);
  assert.ok(inspected.ok);
  assert.equal(inspected.value.dirty, true);
  rmSync(join(path, ".pipeline"), { recursive: true });
  symlinkSync("../clone", join(path, ".pipeline"));
  inspected = await git.inspect(path);
  assert.ok(inspected.ok);
  assert.equal(inspected.value.dirty, true);
});

test("non-force removal preserves work arriving after scratch cleanup", async (t) => {
  const { path, identity, write } = fixture(t);
  write(scratch[0]);
  let cleaned = false;
  const git = new NativeWorktreeGit(async (bin, args, options) => {
    if (args.includes("remove")) {
      cleaned = !existsSync(join(path, scratch[0]));
      assert.ok(!args.includes("--force"));
      write("late-work.txt", "keep me\n");
    }
    return run(bin, args, options);
  });
  assert.equal((await git.remove(identity, path, false)).ok, false);
  assert.equal(cleaned, true);
  assert.equal(readFileSync(join(path, "late-work.txt"), "utf8"), "keep me\n");
});

for (const replacement of ["staged file", "directory"] as const) {
  test(`cleanup preserves scratch replaced by a ${replacement} after inspection`, async (t) => {
    const { path, identity, write } = fixture(t);
    write(".pipeline/DONE");
    let cleaned = false;
    const git = new NativeWorktreeGit(async (bin, args, options) => {
      if (args.includes("clean")) {
        cleaned = true;
        if (replacement === "staged file") {
          write(".pipeline/DONE", "keep me\n");
          gitIn(path, "add", ".pipeline/DONE");
        } else {
          rmSync(join(path, ".pipeline/DONE"));
          write(".pipeline/DONE/notes.txt", "keep me\n");
        }
      }
      return run(bin, args, options);
    });
    assert.equal((await git.remove(identity, path, false)).ok, false);
    assert.equal(cleaned, true);
    const file = replacement === "staged file" ? ".pipeline/DONE" : ".pipeline/DONE/notes.txt";
    assert.equal(readFileSync(join(path, file), "utf8"), "keep me\n");
  });
}

test("failed or uncertain status and cleanup cannot reach worktree removal", async (t) => {
  const { path, identity, write } = fixture(t);
  write(".pipeline/DONE");
  for (const step of ["status", "clean"]) {
    for (const problem of [{ code: 1 }, { outcomeUnknown: true }, { overflowed: true }]) {
      const git = new NativeWorktreeGit(async (bin, args, options) => {
        assert.ok(!args.includes("remove"), "no removal after an inconclusive prerequisite");
        if (args.includes(step)) return {
          stdout: "", stderr: "probe failed", code: 0, outcomeUnknown: false, overflowed: false,
          ...problem,
        };
        return run(bin, args, options);
      });
      const result = await git.remove(identity, path, false);
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, new RegExp(`git ${step}`));
      assert.equal(existsSync(join(path, ".pipeline/DONE")), true);
    }
  }
});
