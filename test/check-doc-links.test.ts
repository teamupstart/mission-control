import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(new URL("../scripts/check-doc-links.mjs", import.meta.url));

test("documentation link checks ignore code examples and reject broken visible links", () => {
  const root = mkdtempSync(join(tmpdir(), "mission-doc-links-"));
  try {
    mkdirSync(join(root, "docs"));
    mkdirSync(join(root, "e2e"));
    writeFileSync(join(root, "README.md"), "# Readme\n");
    writeFileSync(join(root, "AGENTS.md"), "# Agents\n");
    writeFileSync(join(root, "e2e", "README.md"), "# E2E\n");
    writeFileSync(join(root, "docs", "target.md"), "# Target\n");
    writeFileSync(
      join(root, "docs", "examples.md"),
      [
        "# Examples",
        "",
        "`[inline example](missing-inline.md)`",
        "",
        "`[multi-line example]",
        "(missing-multiline.md)`",
        "",
        "```md",
        "[fenced example](missing-fenced.md)",
        "```",
        "",
        "[Real link](target.md#target)",
        "",
      ].join("\n"),
    );

    const output = execFileSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
    assert.match(output, /Verified 5 Markdown files/);

    writeFileSync(join(root, "docs", "broken.md"), "[Broken](missing-visible.md)\n");
    assert.throws(
      () => execFileSync(process.execPath, [checker], { cwd: root, encoding: "utf8" }),
      (error: unknown) => {
        assert.ok(error && typeof error === "object" && "status" in error);
        assert.equal(error.status, 1);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
