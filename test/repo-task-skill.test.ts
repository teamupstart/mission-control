import assert from "node:assert/strict";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  appendRepoTaskSkills,
  resolveRepoTaskSkills,
  stripFrontmatter,
  REPO_TASK_SKILL_MAX_BODY_BYTES,
} from "../src/server/instructions/repo-task-skill.ts";
import { TASK_KINDS } from "../src/shared/types.ts";
import { tempDir } from "./temp-root.mjs";

function repo(name: string, skill?: string | null, kind = "ship"): { repoRoot: string; worktreePath: string; dir: string } {
  const dir = tempDir("rts-");
  const wt = join(dir, name);
  mkdirSync(join(wt, ".claude", "skills", kind), { recursive: true });
  if (skill != null) writeFileSync(join(wt, ".claude", "skills", kind, "SKILL.md"), skill);
  return { repoRoot: join("/main", name), worktreePath: wt, dir };
}

test("no skill leaves the prompt byte-identical, for every kind", () => {
  const r = repo("app");
  for (const kind of TASK_KINDS) {
    const resolved = resolveRepoTaskSkills(kind, [r]);
    assert.deepEqual(resolved.contributingWorktreePaths, []);
    assert.deepEqual(resolved.record, { included: [], skipped: [] });
    assert.equal(appendRepoTaskSkills("PROMPT", resolved), "PROMPT");
  }
  assert.equal(appendRepoTaskSkills("PROMPT", null), "PROMPT");
  rmSync(r.dir, { recursive: true, force: true });
});

test("a skill is appended after the prompt with the supplement line, frontmatter removed", () => {
  const r = repo("app", "﻿---\nname: ship\n---\n\nEnd every summary with SHIPPED\n");
  const out = appendRepoTaskSkills("PROMPT", resolveRepoTaskSkills("ship", [r]));
  assert.ok(out.startsWith("PROMPT\n\nThis repository adds the following ship skill. It supplements"));
  assert.ok(out.includes("## Repository ship skill (.claude/skills/ship/SKILL.md)\n\nEnd every summary with SHIPPED"));
  assert.ok(!out.includes("name: ship"));
  rmSync(r.dir, { recursive: true, force: true });
});

test("each kind reads its own file", () => {
  const r = repo("app", "bug text", "bugfix");
  assert.equal(resolveRepoTaskSkills("ship", [r]).blocks.length, 0);
  const b = resolveRepoTaskSkills("bugfix", [r]);
  assert.match(appendRepoTaskSkills("P", b), /following bugfix skill/);
  rmSync(r.dir, { recursive: true, force: true });
});

test("several repositories: manifest order, repo-name headings, full root on a shared name", () => {
  const a = repo("api", "A body");
  const b = repo("web", "B body");
  const out = appendRepoTaskSkills("P", resolveRepoTaskSkills("ship", [a, b]));
  assert.ok(out.indexOf("## Repository ship skill: api") < out.indexOf("## Repository ship skill: web"));
  const c = repo("api", "C body");
  const same = appendRepoTaskSkills("P", resolveRepoTaskSkills("ship", [a, c]));
  assert.ok(same.includes("## Repository ship skill: /main/api"));
  for (const x of [a, b, c]) rmSync(x.dir, { recursive: true, force: true });
});

test("contributing worktree paths describe the resolved blocks even when skill files change", (t) => {
  const first = repo("app", "First body");
  const missing = repo("app");
  const empty = repo("empty", "---\nname: ship\n---\n");
  const last = repo("app", "Last body");
  t.after(() => {
    for (const r of [first, missing, empty, last]) rmSync(r.dir, { recursive: true, force: true });
  });
  const resolved = resolveRepoTaskSkills("ship", [first, missing, empty, last]);
  const prompt = appendRepoTaskSkills("PROMPT", resolved);
  // Same repository names cannot identify which worktrees actually contributed.
  assert.deepEqual(resolved.contributingWorktreePaths, [first.worktreePath, last.worktreePath]);
  assert.deepEqual(resolved.blocks.map((block) => block.body), ["First body", "Last body"]);

  writeFileSync(join(missing.worktreePath, ".claude/skills/ship/SKILL.md"), "Late body");
  writeFileSync(join(empty.worktreePath, ".claude/skills/ship/SKILL.md"), "Now nonempty");
  rmSync(join(first.worktreePath, ".claude/skills/ship/SKILL.md"));
  assert.deepEqual(resolved.contributingWorktreePaths, [first.worktreePath, last.worktreePath]);
  assert.equal(appendRepoTaskSkills("PROMPT", resolved), prompt);
  assert.deepEqual(resolveRepoTaskSkills("ship", [first, missing, empty, last]).contributingWorktreePaths,
    [missing.worktreePath, empty.worktreePath, last.worktreePath]);
});

test("a symlink leaving the worktree is skipped as outside-worktree", () => {
  const r = repo("app");
  const outside = join(r.dir, "secret.md");
  writeFileSync(outside, "secret");
  symlinkSync(outside, join(r.worktreePath, ".claude", "skills", "ship", "SKILL.md"));
  const resolved = resolveRepoTaskSkills("ship", [r]);
  assert.equal(resolved.record.skipped[0]?.reason, "outside-worktree");
  assert.deepEqual(resolved.contributingWorktreePaths, []);
  assert.equal(appendRepoTaskSkills("P", resolved), "P");
  rmSync(r.dir, { recursive: true, force: true });
});

test("a symlink to a contained file whose name starts with two dots is included", () => {
  const r = repo("app");
  writeFileSync(join(r.worktreePath, "..ship.md"), "Contained guidance.");
  symlinkSync(join(r.worktreePath, "..ship.md"), join(r.worktreePath, ".claude", "skills", "ship", "SKILL.md"));
  const resolved = resolveRepoTaskSkills("ship", [r]);
  assert.deepEqual(resolved.record.skipped, []);
  assert.equal(resolved.blocks[0]?.body, "Contained guidance.");
  assert.deepEqual(resolved.contributingWorktreePaths, [r.worktreePath]);
  rmSync(r.dir, { recursive: true, force: true });
});

test("a directory, an empty body and an oversize file are skipped and recorded", () => {
  const d = repo("d");
  rmSync(join(d.worktreePath, ".claude", "skills", "ship"), { recursive: true });
  mkdirSync(join(d.worktreePath, ".claude", "skills", "ship", "SKILL.md"), { recursive: true });
  assert.equal(resolveRepoTaskSkills("ship", [d]).record.skipped[0]?.reason, "not-a-regular-file");
  const e = repo("e", "---\nx: y\n---\n   \n");
  assert.equal(resolveRepoTaskSkills("ship", [e]).record.skipped[0]?.reason, "empty");
  const big = repo("big", "x".repeat(4 * 1024 * 1024 + 1));
  assert.equal(resolveRepoTaskSkills("ship", [big]).record.skipped[0]?.reason, "too-large");
  for (const x of [d, e, big]) rmSync(x.dir, { recursive: true, force: true });
});

test("a body over 32 KiB is cut at the last newline in the window, with the exact omitted count", () => {
  // 1000 lines of 100 bytes. Trimmed, the body is 99,999 bytes. A 32,768-byte window holds 327
  // whole lines plus 68 bytes of the next, so the cut lands on the 327th newline and keeps
  // 327 lines without their trailing newline: 32,699 bytes. 99,999 - 32,699 = 67,300 omitted.
  const line = "y".repeat(99) + "\n";
  const r = repo("app", line.repeat(1000));
  const resolved = resolveRepoTaskSkills("ship", [r]);
  const block = resolved.blocks[0]!;
  const expectedKept = Array.from({ length: 327 }, () => "y".repeat(99)).join("\n");
  assert.equal(Buffer.byteLength(expectedKept), 32699);
  assert.equal(
    block.body,
    `${expectedKept}\n[truncated: 67300 bytes omitted from .claude/skills/ship/SKILL.md]`,
  );
  assert.equal(resolved.record.included[0]?.truncated, true);
  assert.deepEqual(resolved.contributingWorktreePaths, [r.worktreePath]);
  assert.equal(resolved.record.included[0]?.bytes, Buffer.byteLength(block.body));
  rmSync(r.dir, { recursive: true, force: true });
});

test("a body at exactly 32 KiB is kept whole and unmarked", () => {
  const r = repo("app", "z".repeat(REPO_TASK_SKILL_MAX_BODY_BYTES));
  const resolved = resolveRepoTaskSkills("ship", [r]);
  assert.equal(resolved.blocks[0]?.body.length, REPO_TASK_SKILL_MAX_BODY_BYTES);
  assert.equal(resolved.record.included[0]?.truncated, false);
  rmSync(r.dir, { recursive: true, force: true });
});

test("a file of exactly 4 MiB is read and included, truncated to the body ceiling", () => {
  const r = repo("app", "a".repeat(4 * 1024 * 1024));
  const resolved = resolveRepoTaskSkills("ship", [r]);
  assert.deepEqual(resolved.record.skipped, []);
  assert.equal(resolved.record.included.length, 1);
  assert.equal(resolved.record.included[0]?.truncated, true);
  assert.match(
    resolved.blocks[0]!.body,
    new RegExp(`\\[truncated: ${4 * 1024 * 1024 - REPO_TASK_SKILL_MAX_BODY_BYTES} bytes omitted from`),
  );
  rmSync(r.dir, { recursive: true, force: true });
});

test("a file that exists but cannot be read is recorded as unreadable and the other repository still contributes", (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("root can read a mode 000 file");
    return;
  }
  const locked = repo("locked", "secret body");
  const good = repo("good", "good body");
  const file = join(locked.worktreePath, ".claude", "skills", "ship", "SKILL.md");
  chmodSync(file, 0o000);
  try {
    const resolved = resolveRepoTaskSkills("ship", [locked, good]);
    assert.deepEqual(resolved.record.skipped, [
      { repo: "locked", kind: "ship", path: ".claude/skills/ship/SKILL.md", reason: "unreadable" },
    ]);
    assert.deepEqual(resolved.blocks.map((b) => b.repo), ["good"]);
    assert.deepEqual(resolved.contributingWorktreePaths, [good.worktreePath]);
  } finally {
    chmodSync(file, 0o644);
    for (const x of [locked, good]) rmSync(x.dir, { recursive: true, force: true });
  }
});

test("frontmatter: unclosed fence is kept, CRLF fences are recognised", () => {
  assert.equal(stripFrontmatter("---\nno close\n"), "---\nno close\n");
  assert.equal(stripFrontmatter("---\r\na: b\r\n---\r\nbody"), "body");
});
