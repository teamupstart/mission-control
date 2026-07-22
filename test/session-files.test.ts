import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  listSessionFiles,
  MAX_SESSION_EDITOR_BYTES,
  readFileWithinCap,
  readSessionFile,
  saveSessionFile,
  SessionFileError,
  withFileSaveLock,
} from "../src/server/session-files.ts";
import {
  applyFileLoadFailure,
  applyFileLoadSuccess,
  LatestFileRequests,
  updateExistingSession,
  type FileBuffer,
  type SessionFilesState,
} from "../src/web/lib/sessionFiles.ts";

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
  await writeFile(path.join(dir, "notes.md"), "# Notes");
  const text = await readSessionFile(dir, "README");
  assert.equal(text.kind, "text");
  assert.equal(text.editable, true);
  assert.equal(text.text, "hello π\n");
  assert.match(text.revision, /^[a-f0-9]{64}$/);
  assert.equal((await readSessionFile(dir, "page.html")).kind, "html");
  assert.equal((await readSessionFile(dir, "notes.md")).kind, "markdown");
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

test("bounded reads stop after one byte beyond the cap", async (t) => {
  const dir = await fixture();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, "growing.txt");
  await writeFile(target, Buffer.alloc(32, 65));
  const handle = await open(target, "r");
  t.after(() => handle.close());
  const result = await readFileWithinCap(handle, 8);
  assert.equal(result.exceeded, true);
  assert.equal(result.bytes.length, 9);
});

test("save locks serialize writers for the same target", async () => {
  const order: string[] = [];
  let releaseFirst = (): void => {};
  const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = withFileSaveLock("same-target", async () => {
    order.push("first:start");
    await gate;
    order.push("first:end");
  });
  await Promise.resolve();
  const second = withFileSaveLock("same-target", async () => {
    order.push("second:start");
    order.push("second:end");
  });
  await Promise.resolve();
  assert.deepEqual(order, ["first:start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first:start", "first:end", "second:start", "second:end"]);
});

test("async file results cannot recreate a dropped session", () => {
  const state: SessionFilesState = {
    files: [], listState: "ready", listError: null, selectedPath: null,
    openError: null, mode: "editor", buffers: {},
  };
  const sessions = { active: state };
  let called = false;
  const retained = updateExistingSession(sessions, "active", (session) => session);
  const dropped = updateExistingSession({}, "active", () => {
    called = true;
    return state;
  });
  assert.equal(retained, sessions);
  assert.deepEqual(dropped, {});
  assert.equal(called, false);
});

test("only the latest file request may update a session path", () => {
  const requests = new LatestFileRequests();
  const key = "active\0file\0README.md";
  const first = requests.begin(key);
  const second = requests.begin(key);
  assert.equal(requests.isCurrent(key, first), false);
  assert.equal(requests.isCurrent(key, second), true);
  requests.forgetSession("active");
  assert.equal(requests.isCurrent(key, second), false);
  const recreated = requests.begin(key);
  assert.ok(recreated > second);
  assert.equal(requests.isCurrent(key, recreated), true);
});

test("failed revalidation removes clean stale buffers but preserves local edits", () => {
  const document = {
    path: "README.md", kind: "markdown" as const, editable: true, text: "disk",
    size: 4, mtime: 1, language: "markdown", revision: "one", error: null,
  };
  const clean: FileBuffer = {
    document, text: "disk", savedText: "disk", saveState: "saved", error: null, conflict: null,
  };
  const base: SessionFilesState = {
    files: [], listState: "ready", listError: null, selectedPath: "README.md",
    openError: null, mode: "preview", buffers: { "README.md": clean },
  };
  const stale = applyFileLoadFailure(base, "README.md", "File not found");
  assert.equal(stale.openError, "File not found");
  assert.equal(stale.buffers["README.md"], undefined);

  const modified = { ...clean, text: "local", saveState: "modified" as const };
  const edited = applyFileLoadFailure(
    { ...base, buffers: { "README.md": modified } },
    "README.md",
    "File not found",
  );
  assert.equal(edited.openError, "File not found");
  assert.equal(edited.buffers["README.md"], modified);
  const refreshed = applyFileLoadSuccess(edited, "README.md", { ...document, text: "new disk" }, true);
  assert.equal(refreshed.openError, null);
  assert.equal(refreshed.buffers["README.md"], modified);
});

test("background file loads cannot replace the selected path's error", () => {
  const state: SessionFilesState = {
    files: [], listState: "ready", listError: null, selectedPath: "current.txt",
    openError: "Current file is missing", mode: "editor", buffers: {},
  };
  assert.equal(applyFileLoadFailure(state, "old.txt", "Old file is missing"), state);
  const loaded = applyFileLoadSuccess(state, "old.txt", {
    path: "old.txt", kind: "text", editable: true, text: "old", size: 3,
    mtime: 1, language: "text", revision: "one", error: null,
  }, true);
  assert.equal(loaded.openError, "Current file is missing");
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

test("saving refuses a disk version that grew beyond the editor cap", async (t) => {
  const dir = await fixture();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, "same.txt");
  await writeFile(target, "one");
  const opened = await readSessionFile(dir, "same.txt");
  await writeFile(target, Buffer.alloc(MAX_SESSION_EDITOR_BYTES + 1, 65));
  const result = await saveSessionFile(dir, "same.txt", "operator edit", opened.revision);
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.currentText, null);
  assert.equal(result.currentRevision, undefined);
  assert.equal((await stat(target)).size, MAX_SESSION_EDITOR_BYTES + 1);
});
