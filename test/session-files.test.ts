import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  listSessionFiles,
  MAX_SESSION_EDITOR_BYTES,
  readSessionFile,
  saveSessionFile,
  SessionFileError,
} from "../src/server/session-files.ts";

async function fixture(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mission-files-"));
  execFileSync("git", ["-C", dir, "init", "-q"]);
  return dir;
}

test("lists tracked and untracked non-ignored regular files deterministically", async (t) => {
  const dir = await fixture();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, ".gitignore"), "ignored.txt\n");
  await writeFile(path.join(dir, "z.txt"), "tracked");
  await writeFile(path.join(dir, "a.txt"), "untracked");
  await writeFile(path.join(dir, "ignored.txt"), "hidden");
  await symlink("z.txt", path.join(dir, "link.txt"));
  execFileSync("git", ["-C", dir, "add", ".gitignore", "z.txt", "link.txt"]);
  assert.deepEqual(await listSessionFiles(dir), [
    { path: ".gitignore" },
    { path: "a.txt" },
    { path: "z.txt" },
  ]);
});

test("reads UTF-8 text by content and classifies HTML independently", async (t) => {
  const dir = await fixture();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "README"), "hello π\n");
  await writeFile(path.join(dir, "page.html"), "<h1>Hello</h1>");
  const text = await readSessionFile(dir, "README");
  assert.equal(text.kind, "text");
  assert.equal(text.editable, true);
  assert.equal(text.text, "hello π\n");
  assert.match(text.revision, /^[a-f0-9]{64}$/);
  assert.equal((await readSessionFile(dir, "page.html")).kind, "html");
});

test("rejects binary, invalid UTF-8, oversized, traversal, and symlink escape targets", async (t) => {
  const dir = await fixture();
  const outside = await mkdtemp(path.join(os.tmpdir(), "mission-files-outside-"));
  t.after(() => Promise.all([rm(dir, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await writeFile(path.join(dir, "nul.dat"), Buffer.from([65, 0, 66]));
  await writeFile(path.join(dir, "invalid.txt"), Buffer.from([0xc3, 0x28]));
  await writeFile(path.join(dir, "large.txt"), Buffer.alloc(MAX_SESSION_EDITOR_BYTES + 1, 65));
  await writeFile(path.join(outside, "secret.txt"), "secret");
  await symlink(path.join(outside, "secret.txt"), path.join(dir, "escape.txt"));
  assert.equal((await readSessionFile(dir, "nul.dat")).kind, "binary");
  assert.equal((await readSessionFile(dir, "invalid.txt")).kind, "binary");
  assert.equal((await readSessionFile(dir, "large.txt")).kind, "oversized");
  await assert.rejects(() => readSessionFile(dir, "../secret.txt"), SessionFileError);
  await assert.rejects(() => readSessionFile(dir, "escape.txt"), SessionFileError);
  await assert.rejects(() => readSessionFile(dir, path.join(dir, "nul.dat")), SessionFileError);
});

test("matching revisions save atomically, preserve mode, and leave no temp file", async (t) => {
  const dir = await fixture();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, "script.sh");
  await writeFile(target, "echo before\n");
  await chmod(target, 0o751);
  const before = await readSessionFile(dir, "script.sh");
  const saved = await saveSessionFile(dir, "script.sh", "echo after\n", before.revision);
  assert.equal(saved.ok, true);
  assert.equal(await readFile(target, "utf8"), "echo after\n");
  assert.equal((await stat(target)).mode & 0o777, 0o751);
  assert.deepEqual((await readdir(dir)).filter((name) => name.startsWith(".mission-control-")), []);
});

test("a stale revision returns disk text without replacing either version", async (t) => {
  const dir = await fixture();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, "same.txt");
  await writeFile(target, "one");
  const opened = await readSessionFile(dir, "same.txt");
  await writeFile(target, "agent edit");
  const result = await saveSessionFile(dir, "same.txt", "operator edit", opened.revision);
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.currentText, "agent edit");
  assert.equal(await readFile(target, "utf8"), "agent edit");
});
