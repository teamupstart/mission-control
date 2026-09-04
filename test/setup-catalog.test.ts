import assert from "node:assert/strict";
import test from "node:test";

import {
  ENVIRONMENT_ROW_METADATA,
  SETUP_DEPENDENCY_IDS,
  SETUP_DEPENDENCY_INFO,
  TERMINAL_PAIR_INFO,
} from "../src/shared/setup-catalog.ts";

test("the setup catalog is exhaustive, append-only, and carries usable remedies", () => {
  assert.deepEqual(Object.keys(SETUP_DEPENDENCY_INFO), [...SETUP_DEPENDENCY_IDS]);
  assert.equal(SETUP_DEPENDENCY_IDS.at(-1), "iterm", "new persisted ids append after existing entries");
  assert.equal(SETUP_DEPENDENCY_INFO["gh-cli"].requirement, "required");
  assert.equal(SETUP_DEPENDENCY_INFO["gh-auth"].requirement, "required");
  assert.deepEqual(SETUP_DEPENDENCY_INFO.iterm.remedy, {
    kind: "command",
    argv: ["brew", "install", "--cask", "iterm2"],
    note: "Install iTerm2 with Homebrew.",
  });
  for (const id of SETUP_DEPENDENCY_IDS) {
    const remedy = SETUP_DEPENDENCY_INFO[id].remedy;
    if (remedy.kind === "command") {
      assert.ok(remedy.argv.length > 0, id);
      assert.ok(remedy.argv.every((part) => part.trim() === part && part.length > 0), id);
    }
  }
});

test("each source owns the requirement projected onto a row", () => {
  for (const id of SETUP_DEPENDENCY_IDS) {
    assert.ok(["required", "recommended", "optional"].includes(SETUP_DEPENDENCY_INFO[id].requirement));
  }
  assert.equal(ENVIRONMENT_ROW_METADATA["upstartclaw-core-setup"].requirement, "optional");
  assert.equal(TERMINAL_PAIR_INFO.requirement, "required");
});
