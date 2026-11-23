import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { computeSessionDiff } from "../src/server/diff.ts";
import { parsePatch } from "../src/web/lib/diff.ts";
import { resolveBinPath } from "../src/server/util/exec.ts";

test("untracked diff reads overlap within a bound, preserve order, and fail closed", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mission-diff-parallel-")));
  const previous = process.env.MISSION_GIT_BIN;
  t.after(() => {
    if (previous === undefined) delete process.env.MISSION_GIT_BIN;
    else process.env.MISSION_GIT_BIN = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const realGit = await resolveBinPath("git");
  assert.ok(realGit);
  const git = (...args: string[]) => execFileSync(realGit, ["-C", root, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(root, "tracked.txt"), "before\n");
  git("add", "tracked.txt");
  git("commit", "-qm", "base");
  writeFileSync(join(root, "tracked.txt"), "after\n");
  const paths = Array.from({ length: 19 }, (_, i) => `new-${String(i).padStart(2, "0")}.txt`);
  for (const path of paths) writeFileSync(join(root, path), `content for ${path}\n`);
  const expected = await computeSessionDiff(root);
  assert.equal(expected.ok, true);

  // Instrument the executable boundary, keeping real Git's output and exit semantics.
  // Deliberately finish the first file last; elapsed-time thresholds would flake on CI.
  const log = join(root, ".git", "reads.jsonl");
  const fail = join(root, ".git", "fail");
  const wrapper = join(root, ".git", "git-wrapper");
  writeFileSync(wrapper, `#!${process.execPath}
const { appendFileSync, existsSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const path = args.at(-1);
const untracked = args.includes('--no-index');
const record = (event) => appendFileSync(${JSON.stringify(log)}, JSON.stringify({ event, path }) + '\\n');
if (untracked) record('start');
setTimeout(() => {
  if (untracked && existsSync(${JSON.stringify(fail)}) && /new-0[01]/.test(path)) {
    record('end');
    process.exit(1); // A partial batch must never become a successful partial patch.
  }
  const result = spawnSync(${JSON.stringify(realGit)}, args, { encoding: 'utf8' });
  if (untracked) record('end');
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  process.exit(result.status ?? 2);
}, untracked && path === 'new-00.txt' ? 250 : 0);
`);
  chmodSync(wrapper, 0o755);
  process.env.MISSION_GIT_BIN = wrapper;
  const actual = await computeSessionDiff(root);
  assert.deepEqual(actual, expected, "parallel completion must retain the exact patch, stats and metadata");
  assert.deepEqual(parsePatch(actual.patch).map((file) => file.path), ["tracked.txt", ...paths]);
  const events = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { event: string; path: string });
  let active = 0;
  let peak = 0;
  for (const { event } of events) {
    active += event === "start" ? 1 : -1;
    peak = Math.max(peak, active);
  }
  assert.ok(peak > 1, "new-file reads must overlap instead of serializing the whole list");
  assert.ok(peak <= 8, `untracked reads must stay bounded, saw ${peak}`);
  assert.equal(active, 0);
  assert.notEqual(events.find((event) => event.event === "end")?.path, paths[0]);

  writeFileSync(fail, "fail the first two files\n");
  const failed = await computeSessionDiff(root);
  assert.equal(failed.ok, false);
  assert.equal(failed.patch, "");
  assert.equal(failed.filesChanged, 0);
  assert.equal(failed.error, "could not read untracked file new-00.txt", "report the first path in Git order, not the first process to fail");
});
