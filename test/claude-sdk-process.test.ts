import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSdkSpec } from "../src/server/harness/claude/sdk.ts";
import { defaultClaudeSdkDeps } from "../src/server/harness/claude/sdk-deps.ts";

test("the real Claude SDK transport exposes its child lifetime and still drains on stop", { timeout: 15_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "mission-sdk-process-"));
  let childPid: number | null = null;
  t.after(() => {
    if (childPid) { try { process.kill(childPid, "SIGKILL"); } catch { /* Already reaped. */ } }
    rmSync(root, { recursive: true, force: true });
  });
  const executable = join(root, "fake-claude.mjs");
  writeFileSync(executable, `
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
writeFileSync("pid", String(process.pid));
const emit = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.type === "control_request") emit({ type: "control_response", response: {
    subtype: "success", request_id: frame.request_id, response: {}
  } });
  if (frame.type === "user") {
    emit({ type: "system", subtype: "init", session_id: "process-proof", model: "fake" });
    emit({ type: "result", subtype: "success", session_id: "process-proof", is_error: false });
  }
});
lines.on("close", () => { writeFileSync("drained", "stdin closed"); process.exit(0); });
`);
  const handle = await claudeSdkSpec({ ...defaultClaudeSdkDeps, executable: async () => executable,
    env: () => ({ PATH: process.env.PATH }) }).launch({ cwd: root, stateHome: root,
    prompt: "fixture only", model: null, effort: null, permissionMode: null, mcp: null,
    extraDirs: [], standingInstructions: "", standingInstructionsPrompt: "", resume: null });
  childPid = handle.recoveryProcessId ?? null;
  for await (const event of handle.events) {
    if (event.kind === "bound") break;
    assert.notEqual(event.kind, "exited");
  }
  assert.equal(childPid, Number(readFileSync(join(root, "pid"), "utf8")));
  assert.ok(childPid);
  assert.equal(handle.recoveryProcessId, childPid);
  assert.notEqual(childPid, process.pid, "the daemon is not proof of a subprocess lifetime");
  process.kill(childPid, 0);
  await handle.stop();
  for await (const event of handle.events) if (event.kind === "exited") break;
  assert.equal(readFileSync(join(root, "drained"), "utf8"), "stdin closed");
  assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
});
