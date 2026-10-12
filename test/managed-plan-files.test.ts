import assert from "node:assert/strict";
import test from "node:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
