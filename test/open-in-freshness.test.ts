import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isSavePending, type FileBuffer, type FileSaveState } from "../src/web/lib/sessionFiles.ts";

// What is at stake: every "Open in" target reads the FILE, and the editor beside it is
// 750ms of autosave debounce behind the keystroke. Click straight after an edit and the
// browser gets the previous version - a bug that looks exactly like the launcher having
// cached the page, and that a human debugs by reloading rather than by suspecting us.
//
// So the workspace flushes and waits. `isSavePending` is where "waiting will end" is
// decided, and it is narrower than "unsaved" for a reason: `failed`, `offline` and
// `conflict` are unsaved states that no save is coming for, so treating them as pending
// would hang the launch forever instead of saying the file could not be written.

const buffer = (saveState: FileSaveState): FileBuffer => ({
  document: {
    path: "page.html", kind: "html", editable: true, text: "", size: 0,
    mtime: 0, language: "html", revision: "", error: null,
  },
  text: "", savedText: "", saveState, error: null, conflict: null,
});

test("a write is still coming for exactly the two states that have one", () => {
  assert.equal(isSavePending(buffer("modified")), true);
  assert.equal(isSavePending(buffer("saving")), true);
  for (const settled of ["saved", "readonly", "failed", "offline", "conflict"] as const) {
    assert.equal(isSavePending(buffer(settled)), false, `${settled} would wait forever`);
  }
});

test("the workspace flushes, waits for the buffer to settle, then launches", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../src/web/components/FileWorkspace.tsx", import.meta.url)),
    "utf8",
  );
  // Flush first, launch later: the click must not go straight to the daemon.
  assert.match(source, /isSavePending\(buffer\)\)\s*\{\s*controller\.flush\([\s\S]*?setPendingOpen/);
  // And the wait ends on the buffer, not on a timer - a fixed delay is either a stall or
  // a race, depending on how big the file is.
  assert.match(source, /if \(pending && isSavePending\(pending\)\) return;/);
  // A save that failed must not silently open the stale bytes.
  assert.match(source, /saveState === "saved" \|\| pending\.saveState === "readonly"/);
  assert.match(source, /setLaunchError\(`Not opened/);
});

test("a failed launch is visible, and a successful one says nothing", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../src/web/components/FileWorkspace.tsx", import.meta.url)),
    "utf8",
  );
  assert.match(source, /setLaunchError\(result\.ok \? null : \(result\.error \?\? [^)]+\)\)/);
  assert.match(source, /\{launchError && \(/, "a failure the human cannot see is a broken button");
});
