import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  hasUnwrittenEdits,
  isSavePending,
  type FileBuffer,
  type FileSaveState,
} from "../src/web/lib/sessionFiles.ts";

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

// The other half, and the one a launch path forgets: these are unsaved states that no
// write will resolve, so "not pending" must not be read as "disk is current". Every state
// belongs to exactly one of the two predicates, or a third one added later falls through
// both and silently launches stale bytes.
test("edits with no write coming are their own answer, not the absence of one", () => {
  for (const stuck of ["failed", "offline", "conflict"] as const) {
    assert.equal(hasUnwrittenEdits(buffer(stuck)), true, `${stuck} has edits that never landed`);
    assert.equal(isSavePending(buffer(stuck)), false);
  }
  for (const current of ["saved", "readonly"] as const) {
    assert.equal(hasUnwrittenEdits(buffer(current)), false, `${current} is what is on disk`);
  }
  for (const pending of ["modified", "saving"] as const) {
    assert.equal(hasUnwrittenEdits(buffer(pending)), false, "a pending write is waited on, not refused");
  }
});

const workspaceSource = (): string =>
  readFileSync(
    fileURLToPath(new URL("../src/web/components/FileWorkspace.tsx", import.meta.url)),
    "utf8",
  );

test("the workspace flushes, waits for the buffer to settle, then launches", () => {
  const source = workspaceSource();
  // Flush first, launch later: the click must not go straight to the daemon.
  assert.match(source, /isSavePending\(buffer\)\)\s*\{\s*controller\.flush\([\s\S]*?setPendingOpen/);
  // And the wait ends on the buffer, not on a timer - a fixed delay is either a stall or
  // a race, depending on how big the file is.
  assert.match(source, /if \(pending && isSavePending\(pending\)\) return;/);
  // A save that failed must not silently open the stale bytes.
  assert.match(source, /if \(hasUnwrittenEdits\(pending\)\) \{\s*setLaunchError/);
});

// The click path needs its OWN refusal, and this is the one that was missing: a buffer
// already sitting in `failed` / `offline` / `conflict` has nothing pending, so it never
// enters the effect above - it fell through to a launch of the version before the edit.
// Both branches, or the guard only covers files that went unsaved while you watched.
test("a buffer that is already unsaved is refused at the click, not just after a flush", () => {
  const source = workspaceSource();
  const openIn = /function openIn\([\s\S]*?\n  \}/.exec(source)?.[0] ?? "";
  assert.ok(openIn, "openIn should be findable");
  assert.match(openIn, /hasUnwrittenEdits\(buffer\)\)\s*\{\s*setLaunchError\([\s\S]*?return;/);
  assert.ok(
    openIn.indexOf("hasUnwrittenEdits") < openIn.indexOf("void launch("),
    "the refusal has to come before the launch, or it refuses nothing",
  );
  // One sentence for one refusal: the two paths must not drift into different wording.
  assert.equal(source.match(/Not opened/g)?.length, 1);
});

test("a failed launch is visible, and a successful one says nothing", () => {
  const source = workspaceSource();
  assert.match(source, /setLaunchError\(result\.ok \? null : \(result\.error \?\? [^)]+\)\)/);
  assert.match(source, /\{launchError && \(/, "a failure the human cannot see is a broken button");
});
