import assert from "node:assert/strict";
import test from "node:test";
import { constants, openSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativePlanFiles } from "../src/server/plans/native.ts";
import { digest, readSafe, replaceSafe } from "../src/server/plans/files.ts";
import { ensureNativeStateLockAddon } from "./helpers/native-state-lock.ts";

ensureNativeStateLockAddon();

test("a parent swapped immediately before rename cannot redirect publication or cleanup", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "managed-plan-parent-race-")));
  try {
    const checkout = join(root, "checkout"), outside = join(root, "outside");
    const original = join(checkout, "docs/plans/topic");
    mkdirSync(original, { recursive: true });
    mkdirSync(join(outside, "topic"), { recursive: true });
    writeFileSync(join(original, "plan.md"), "original");
    writeFileSync(join(outside, "topic/plan.md"), "outside stays intact");
    let staged = "";
    replaceSafe(checkout, "docs/plans/topic/plan.md", Buffer.from("updated"), digest("original"), () => {
      staged = readdirSync(original).find((name) => name.endsWith(".tmp"))!;
      assert.ok(staged);
      copyFileSync(join(original, staged), join(outside, "topic", staged));
      renameSync(join(checkout, "docs/plans"), join(checkout, "original-plans"));
      symlinkSync(outside, join(checkout, "docs/plans"));
    });
    assert.equal(readFileSync(join(outside, "topic/plan.md"), "utf8"), "outside stays intact");
    assert.equal(existsSync(join(outside, "topic", staged)), true, "cleanup cannot follow the substituted parent either");
    assert.equal(readFileSync(join(checkout, "original-plans/topic/plan.md"), "utf8"), "updated");
    assert.deepEqual(readdirSync(join(checkout, "original-plans/topic")), ["plan.md"]);
    assert.throws(() => readSafe(checkout, "docs/plans/topic/plan.md"), /symbolic link/, "the save's final output verification refuses the changed checkout path");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const existed of [false, true]) test(`replacement preserves an edit made at publication time (existing output ${existed})`, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "managed-plan-edit-race-")));
  try {
    if (existed) writeFileSync(join(root, "plan.md"), "baseline");
    assert.throws(() => replaceSafe(root, "plan.md", Buffer.from("saved"), existed ? digest("baseline") : null, () => {
      writeFileSync(join(root, "plan.md"), "last-moment operator edit");
    }), /conflict/i);
    assert.equal(readFileSync(join(root, "plan.md"), "utf8"), "last-moment operator edit");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const edited of [false, true]) test(`an interrupted exchange verifies retained displaced bytes on retry (edited ${edited})`, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "managed-plan-exchange-retry-")));
  try {
    writeFileSync(join(root, "plan.md"), "baseline");
    assert.throws(() => replaceSafe(root, "plan.md", Buffer.from("saved"), digest("baseline"), () => {
      if (edited) writeFileSync(join(root, "plan.md"), "last-moment edit");
      const staged = readdirSync(root).find((name) => name.endsWith(".tmp"))!;
      const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY);
      try { nativePlanFiles().renamePlanEntry(fd, staged, "plan.md", true); } finally { closeSync(fd); }
      throw new Error("process exit after exchange, before verifying displaced bytes");
    }), /process exit/);
    assert.equal(readFileSync(join(root, "plan.md"), "utf8"), "saved");
    if (edited) {
      assert.throws(() => replaceSafe(root, "plan.md", Buffer.from("saved"), digest("baseline")), /conflict/);
      assert.equal(readFileSync(join(root, "plan.md"), "utf8"), "last-moment edit");
      assert.throws(() => replaceSafe(root, "plan.md", Buffer.from("saved"), digest("baseline")), /conflict/);
    } else {
      replaceSafe(root, "plan.md", Buffer.from("saved"), digest("baseline"));
      assert.deepEqual(readdirSync(root), ["plan.md"]);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
