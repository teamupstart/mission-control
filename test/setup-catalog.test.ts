import assert from "node:assert/strict";
import test from "node:test";

import {
  ENVIRONMENT_ROW_METADATA,
  SETUP_DEPENDENCY_DISPLAY_ORDER,
  SETUP_DEPENDENCY_IDS,
  SETUP_DEPENDENCY_INFO,
  TERMINAL_PAIR_INFO,
} from "../src/shared/setup-catalog.ts";

test("the setup catalog is exhaustive, append-only, and carries usable remedies", () => {
  assert.deepEqual(Object.keys(SETUP_DEPENDENCY_INFO), [...SETUP_DEPENDENCY_IDS]);
  assert.deepEqual(SETUP_DEPENDENCY_IDS.slice(-7), ["coderabbit-cli", "claude-mcp-trust", "codex-mcp-trust", "acli-cli", "acli-auth", "coderabbit-auth", "macos-terminal"], "new persisted ids append after existing entries");
  assert.equal(SETUP_DEPENDENCY_INFO["gh-cli"].requirement, "required");
  assert.equal(SETUP_DEPENDENCY_INFO["gh-auth"].requirement, "required");
  assert.deepEqual(SETUP_DEPENDENCY_INFO.iterm.remedy, {
    kind: "command",
    purpose: "install",
    argv: ["brew", "install", "--cask", "iterm2"],
    note: "Install iTerm2 with Homebrew.",
  });
  // Homebrew, like the other terminal and CLI installs, rather than a documentation link.
  assert.deepEqual(SETUP_DEPENDENCY_INFO.herdr.remedy, {
    kind: "command",
    purpose: "install",
    argv: ["brew", "install", "herdr"],
    note: "Install Herdr with Homebrew.",
  });
  const codeRabbit = SETUP_DEPENDENCY_INFO["coderabbit-cli"].remedy;
  assert.equal(codeRabbit.kind, "command");
  assert.deepEqual(codeRabbit.kind === "command" && [codeRabbit.purpose, codeRabbit.argv], ["install", ["brew", "install", "--cask", "coderabbit"]]);
  // Sign-in follows the install as its own row, the way acli's does.
  const signIn = SETUP_DEPENDENCY_INFO["coderabbit-auth"];
  assert.equal(signIn.family, SETUP_DEPENDENCY_INFO["coderabbit-cli"].family);
  assert.equal(signIn.remedy.kind, "command");
  assert.deepEqual(signIn.remedy.kind === "command" && [signIn.remedy.purpose, signIn.remedy.argv], ["sign-in", ["coderabbit", "auth", "login"]]);
  for (const id of SETUP_DEPENDENCY_IDS) {
    const remedy = SETUP_DEPENDENCY_INFO[id].remedy;
    if (remedy.kind === "command") {
      assert.ok(remedy.argv.length > 0, id);
      assert.ok(remedy.argv.every((part) => part.trim() === part && part.length > 0), id);
    }
  }
});

test("a follow-up step renders directly beneath the row it follows, in its family", () => {
  assert.deepEqual([...SETUP_DEPENDENCY_DISPLAY_ORDER].sort(), [...SETUP_DEPENDENCY_IDS].sort());
  const at = SETUP_DEPENDENCY_DISPLAY_ORDER.indexOf("coderabbit-cli");
  assert.equal(SETUP_DEPENDENCY_DISPLAY_ORDER[at + 1], "coderabbit-auth");
  for (const id of SETUP_DEPENDENCY_IDS) {
    const after = SETUP_DEPENDENCY_INFO[id].after;
    if (after) assert.equal(SETUP_DEPENDENCY_INFO[after].family, SETUP_DEPENDENCY_INFO[id].family, id);
  }
});

test("each source owns the requirement projected onto a row", () => {
  for (const id of SETUP_DEPENDENCY_IDS) {
    assert.ok(["required", "recommended", "optional"].includes(SETUP_DEPENDENCY_INFO[id].requirement));
  }
  assert.equal(ENVIRONMENT_ROW_METADATA["upstartclaw-core-setup"].requirement, "optional");
  assert.equal(TERMINAL_PAIR_INFO.requirement, "required");
});
