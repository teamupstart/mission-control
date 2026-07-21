import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "foreman-codex-runner-"));
const argvPath = join(home, "argv");
const fake = join(home, "codex");
process.env.HARNESS_HOME = join(home, "state");
process.env.MISSION_CODEX_BIN = fake;
process.env.CODEX_TEST_ARGV = argvPath;
writeFileSync(fake, `#!/bin/sh
printf '%s\\n' "$@" > "$CODEX_TEST_ARGV"
cat >/dev/null
printf '%s' '{"purpose":"Routine dependency approval.","classification":"access","action":"answer","answer":{"text":"Approve.","submit":true},"confidence":0.99}'
`);
chmodSync(fake, 0o755);

const { reviewSession } = await import("../src/server/foreman/review.ts");

after(() => rmSync(home, { recursive: true, force: true }));

test("Foreman structured review actually routes through Codex with the selected model", async () => {
  const result = await reviewSession({
    session: {
      agent: "codex",
      name: "worker",
      cwd: "/repo",
      gitBranch: "feature",
      state: "idle",
      activity: "waiting",
      goal: "Finish the change",
    },
    surface: "input-review",
    question: "May I read package.json?",
    transcript: [],
    truncated: false,
    instructions: "",
  }, "gpt-5.6-terra", "codex");

  assert.equal(result.kind, "verdict");
  const argv = readFileSync(argvPath, "utf8").split("\n");
  assert.ok(argv.includes("exec"));
  assert.ok(argv.includes("gpt-5.6-terra"));
  assert.ok(argv.includes("features.shell_tool=false"));
});
