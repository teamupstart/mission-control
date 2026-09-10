import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The one place this bridge is allowed to write to an agent's stdout, exercised as the agent
 * runs it: a real `node hooks/harness-hook.mjs <event>` against a real HTTP daemon.
 *
 * Why this is worth a subprocess. Everything a hook prints on `UserPromptSubmit` is read by
 * Claude, and anything that is not a decision it understands lands in the model's context - so
 * the failure mode of a stray byte here is not a broken feature, it is every prompt on the
 * machine carrying a line of our JSON. The bridge's own contract said "write NOTHING to
 * stdout" for exactly that reason, and this change carves one exception out of it. These pin
 * the shape of the exception rather than trusting it.
 *
 * The daemon is a stub because the subject is the SCRIPT: what it sends, what it prints, and
 * that it always exits 0. `test/mission-session-closure.test.ts` owns the real route's
 * decision, and `test/hook-bridge-decision.test.ts` owns the transport's fail-open rules.
 */

const home = mkdtempSync(join(tmpdir(), "mission-hook-script-"));
const HOOK = fileURLToPath(new URL("../hooks/harness-hook.mjs", import.meta.url));

/** Run the hook script against a daemon that answers `reply`, and report what it printed. */
async function runHook(
  event: string,
  reply: { status: number; body?: string },
): Promise<{ stdout: string; stderr: string; code: number; hit: boolean }> {
  let hit = false;
  const server = createServer((req, res) => {
    hit = true;
    // Drain the request so the client's POST completes before the answer.
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(reply.status, reply.body ? { "content-type": "application/json" } : undefined);
      res.end(reply.body ?? "");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    return await new Promise((resolve) => {
      const child = execFile(
        process.execPath,
        [HOOK, event],
        {
          env: {
            ...process.env,
            MISSION_PORT: String(port),
            MISSION_HOME: home,
            // Cleared: the script declines to POST at all for the daemon's own headless runs.
            MISSION_HEADLESS: "",
          },
        },
        (error, stdout, stderr) => {
          resolve({
            stdout,
            stderr,
            code: error && typeof error.code === "number" ? error.code : 0,
            hit,
          });
        },
      );
      child.stdin?.end(JSON.stringify({ session_id: "agent-1", cwd: "/repo", prompt: "keep going" }));
    });
  } finally {
    server.close();
  }
}

const BLOCK = JSON.stringify({ decision: "block", reason: "This run was concluded." });

test("a refused prompt is printed as the decision Claude reads, and nothing else", async () => {
  const run = await runHook("UserPromptSubmit", { status: 200, body: BLOCK });
  assert.equal(run.hit, true, "the event still reached the daemon");
  assert.deepEqual(JSON.parse(run.stdout), { decision: "block", reason: "This run was concluded." });
  assert.equal(run.code, 0, "a hook never fails the session, even when it refuses a prompt");
});

test("an ordinary prompt prints NOTHING, which is the property the contract rests on", async () => {
  const run = await runHook("UserPromptSubmit", { status: 204 });
  assert.equal(run.hit, true);
  assert.equal(run.stdout, "", "a byte here would be injected into the model's context");
  assert.equal(run.code, 0);
});

test("no other event can be refused, whatever the daemon answers", async () => {
  // The blast radius of a decision channel is every event it can reach. This one reaches one.
  for (const event of ["Stop", "PreToolUse", "SessionStart", "Notification"]) {
    const run = await runHook(event, { status: 200, body: BLOCK });
    assert.equal(run.stdout, "", `${event} must never be refused through this bridge`);
    assert.equal(run.code, 0);
  }
});

test("a daemon that is down neither blocks the prompt nor fails the hook", async () => {
  // Nothing is listening on this port: the script must still print nothing and exit 0.
  const run = await new Promise<{ stdout: string; code: number }>((resolve) => {
    const child = execFile(
      process.execPath,
      [HOOK, "UserPromptSubmit"],
      { env: { ...process.env, MISSION_PORT: "1", MISSION_HOME: home, MISSION_HEADLESS: "" } },
      (error, stdout) => resolve({ stdout, code: error && typeof error.code === "number" ? error.code : 0 }),
    );
    child.stdin?.end(JSON.stringify({ session_id: "agent-1", cwd: "/repo", prompt: "keep going" }));
  });
  assert.equal(run.stdout, "");
  assert.equal(run.code, 0);
});

process.on("exit", () => rmSync(home, { recursive: true, force: true }));
