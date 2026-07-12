import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyAgent, nativeAgent } from "../src/server/discovery/processes.ts";

test("classifyAgent: claude launcher (bare argv0)", () => {
  assert.equal(classifyAgent("claude"), "claude");
  assert.equal(classifyAgent("claude --resume"), "claude");
});

test("classifyAgent: claude version-named binary (re-exec)", () => {
  assert.equal(
    classifyAgent("/Users/me/.local/share/claude/versions/2.1.204 --session-id abc"),
    "claude",
  );
});

test("classifyAgent: claude local install + npm package", () => {
  assert.equal(classifyAgent("/Users/me/.claude/local/claude"), "claude");
  assert.equal(classifyAgent("node /x/node_modules/@anthropic-ai/claude-code/cli.js"), "claude");
});

test("classifyAgent: codex node script", () => {
  assert.equal(classifyAgent("node /opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js"), "codex");
  assert.equal(classifyAgent("codex"), "codex");
  assert.equal(classifyAgent("/opt/homebrew/bin/codex"), "codex");
});

test("classifyAgent: wrapped invocations", () => {
  assert.equal(classifyAgent("/Applications/Xcode.app/Contents/Developer/usr/bin/make claude"), "claude");
  assert.equal(classifyAgent("docker exec -it ctr zsh -lc claude"), "claude");
  assert.equal(classifyAgent("sh -c codex"), "codex");
});

test("classifyAgent: negatives (avoid false positives)", () => {
  assert.equal(classifyAgent('git commit -m "fix claude bug"'), null);
  assert.equal(classifyAgent("vim claude.md"), null);
  assert.equal(classifyAgent("zsh"), null);
  assert.equal(classifyAgent("node server.js"), null);
  assert.equal(classifyAgent(""), null);
});

test("nativeAgent: strong signatures are native, wrapper tokens are not", () => {
  // Real agent binaries -> native.
  assert.equal(nativeAgent("claude"), "claude");
  assert.equal(nativeAgent("/Users/me/.local/share/claude/versions/2.1.204 --session-id x"), "claude");
  assert.equal(nativeAgent("node /x/node_modules/@openai/codex/bin/codex.js"), "codex");
  // Launchers that merely mention the agent -> not native (they run in the launch
  // dir, not the agent's cwd), though classifyAgent still tags them as the agent.
  assert.equal(nativeAgent("/Applications/Xcode.app/Contents/Developer/usr/bin/make claude"), null);
  assert.equal(nativeAgent("sh -c codex"), null);
  assert.equal(classifyAgent("make claude"), "claude");
});
