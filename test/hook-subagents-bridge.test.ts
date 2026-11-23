import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  HOOK_BACKGROUND_TASKS_MAX,
  HOOK_SUBAGENT_TEXT_MAX,
  agentToolDescriptor,
  backgroundTaskList,
  backgroundTasksTruncated,
  hookText,
} from "../src/shared/hook-subagents.mjs";
import { HookIngestSchema } from "../src/shared/protocol.ts";

// What each hook bridge lifts off a payload about background sub-agents, run the way the agent
// runs it: a real `node hooks/<bridge>.mjs <event>` POSTing to a stub daemon. The payloads are
// the agents' own hook JSON (Claude Code's `SubagentStart`, its Agent tool's `PostToolUse`, and
// `background_tasks` on `Stop`; Codex's `SubagentStart`).

const home = mkdtempSync(join(tmpdir(), "mission-hook-subagents-bridge-"));
const CLAUDE = fileURLToPath(new URL("../hooks/harness-hook.mjs", import.meta.url));
const CODEX = fileURLToPath(new URL("../hooks/codex-hook.mjs", import.meta.url));
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

/** Run `bridge` once per payload and return what the daemon received, in order. */
async function bridged(bridge: string, sends: [string, Record<string, unknown>][]): Promise<Record<string, unknown>[]> {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      bodies.push(JSON.parse(raw) as Record<string, unknown>);
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    for (const [event, payload] of sends) {
      await new Promise<void>((resolve) => {
        const child = execFile(
          process.execPath,
          [bridge, event],
          { env: { ...process.env, MISSION_PORT: String(port), MISSION_HOME: home, MISSION_HEADLESS: "" } },
          () => resolve(),
        );
        child.stdin?.end(JSON.stringify({ session_id: "s-1", cwd: "/repo", hook_event_name: event, ...payload }));
      });
    }
  } finally {
    server.close();
  }
  return bodies;
}

test("the Claude bridge forwards a sub-agent's type, its launch, and the in-flight set", async () => {
  const [start, launch, plain, stop] = await bridged(CLAUDE, [
    ["SubagentStart", { agent_id: "a1", agent_type: "Explore" }],
    ["PostToolUse", {
      tool_name: "Agent",
      tool_use_id: "toolu_1",
      tool_input: { subagent_type: "Explore", description: "Map call sites", prompt: "SECRET PROMPT", run_in_background: true },
      tool_response: { status: "async_launched", agentId: "a1", description: "Map call sites", prompt: "SECRET PROMPT" },
    }],
    ["PostToolUse", { tool_name: "Grep", tool_input: { pattern: "x" }, tool_response: "y" }],
    ["Stop", {
      background_tasks: [
        { id: "a1", type: "subagent", status: "running", description: "Map call sites", agent_type: "Explore" },
        { id: "sh1", type: "shell", status: "running", description: "npm test", command: "npm test" },
      ],
    }],
  ]);
  assert.equal(start?.agentId, "a1");
  assert.equal(start?.agentType, "Explore");
  assert.deepEqual(launch?.agentTool, {
    agentId: "a1", status: "async_launched", subagentType: "Explore", description: "Map call sites",
  });
  // The prompt never leaves the machine on account of this, and neither does a shell's command.
  assert.equal(JSON.stringify(launch).includes("SECRET PROMPT"), false);
  assert.equal("agentTool" in (plain ?? {}), false, "every other tool adds nothing to the wire");
  assert.equal("backgroundTasks" in (plain ?? {}), false);
  assert.deepEqual(stop?.backgroundTasks, [
    { id: "a1", type: "subagent", description: "Map call sites", agentType: "Explore" },
    { id: "sh1", type: "shell", description: "npm test" },
  ]);
  // Every body is a valid ingest, so the daemon reads exactly what the bridge sent.
  for (const body of [start, launch, plain, stop]) {
    const parsed = HookIngestSchema.parse(body);
    assert.deepEqual(parsed.agentTool, body?.agentTool);
    assert.deepEqual(parsed.backgroundTasks, body?.backgroundTasks);
  }
});

test("the Claude bridge says when it cut the in-flight list, and only then", async () => {
  const many = Array.from({ length: HOOK_BACKGROUND_TASKS_MAX + 1 }, (_, i) => ({ id: `t${i}`, type: "subagent" }));
  const [cut, whole] = await bridged(CLAUDE, [
    ["Stop", { background_tasks: many }],
    ["Stop", { background_tasks: many.slice(0, HOOK_BACKGROUND_TASKS_MAX) }],
  ]);
  assert.equal((cut?.backgroundTasks as unknown[]).length, HOOK_BACKGROUND_TASKS_MAX);
  assert.equal(cut?.backgroundTasksTruncated, true);
  assert.equal(HookIngestSchema.parse(cut).backgroundTasksTruncated, true);
  assert.equal((whole?.backgroundTasks as unknown[]).length, HOOK_BACKGROUND_TASKS_MAX);
  assert.equal("backgroundTasksTruncated" in (whole ?? {}), false, "a list at the bound is whole");
  // Malformed entries are not tasks, so they never make a whole list read as cut.
  assert.equal(backgroundTasksTruncated({ background_tasks: [...many.slice(0, HOOK_BACKGROUND_TASKS_MAX), { type: "shell" }] }), undefined);
  assert.equal(backgroundTasksTruncated({}), undefined);
});

test("the Codex bridge names the child only on its own lifecycle events", async () => {
  const [start, stop, tool] = await bridged(CODEX, [
    ["SubagentStart", { agent_id: "t-1", agent_type: "worker", turn_id: "turn-1" }],
    ["SubagentStop", { agent_id: "t-1", agent_type: "worker", last_assistant_message: "done" }],
    ["PreToolUse", { agent_id: "t-1", agent_type: "worker", tool_name: "shell", tool_input: { command: "ls" } }],
  ]);
  assert.equal(start?.agentId, "t-1");
  assert.equal(start?.agentType, "worker");
  assert.equal(stop?.agentId, "t-1");
  assert.equal("agentId" in (tool ?? {}), false, "other events keep reaching the parent as they did");
  for (const body of [start, stop, tool]) assert.ok(HookIngestSchema.safeParse(body).success);
});

test("every forwarded value fits the schema's bounds", () => {
  const long = "x".repeat(HOOK_SUBAGENT_TEXT_MAX * 3);
  const clipped = hookText(long)!;
  assert.equal(clipped.length, HOOK_SUBAGENT_TEXT_MAX);
  assert.ok(clipped.endsWith("…"));
  assert.equal(hookText("   "), undefined);
  assert.equal(hookText(7), undefined);

  const tasks = backgroundTaskList({
    background_tasks: [
      "not a task", null, { type: "subagent" },
      ...Array.from({ length: HOOK_BACKGROUND_TASKS_MAX + 10 }, (_, i) => ({ id: `t${i}`, type: "subagent", description: long })),
    ],
  })!;
  assert.equal(tasks.length, HOOK_BACKGROUND_TASKS_MAX);
  assert.equal(tasks[0]?.id, "t0", "entries without an id are skipped, not counted");
  assert.ok(HookIngestSchema.safeParse({ event: "Stop", env: {}, backgroundTasks: tasks }).data?.backgroundTasks);
  assert.equal(backgroundTaskList({}), undefined);
  assert.deepEqual(backgroundTaskList({ background_tasks: [] }), []);

  assert.equal(agentToolDescriptor({ tool_name: "Agent" }, "PreToolUse"), undefined);
  assert.equal(agentToolDescriptor({ tool_name: "Bash", tool_response: { status: "async_launched" } }, "PostToolUse"), undefined);
  // The older tool name is read the same way.
  assert.deepEqual(
    agentToolDescriptor({ tool_name: "Task", tool_input: { description: long }, tool_response: { status: "async_launched", agentId: "a" } }, "PostToolUse"),
    { agentId: "a", status: "async_launched", subagentType: undefined, description: clipped },
  );
});
