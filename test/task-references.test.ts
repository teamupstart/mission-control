import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TASK_REFERENCE_RULE, taskIdCandidates, withTaskTitles } from "../src/shared/task-references.ts";
import { buildBacklogPrompt } from "../src/server/foreman/backlog-prompt.ts";
import type { TaskDependency } from "../src/shared/types.ts";
import { mkTask } from "./helpers/session-fixture.ts";

// A person reading Mission Control sees tasks by title only. Every agent surface that hands
// out task ids has to say so, and prose the board renders verbatim must not carry one.

const ID_A = "5f0c2a8e-1b3d-4c6e-9f00-aa11bb22cc33";
const ID_B = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
const ID_C = "6f0c2a8e-1b3d-4c6e-9f00-aa11bb22cc33";
const ID_D = "7f0c2a8e-1b3d-4c6e-9f00-aa11bb22cc33";
const ID_E = "8f0c2a8e-1b3d-4c6e-9f00-aa11bb22cc33";

test("withTaskTitles names every known task id, wherever it sits, except in a checkout path", () => {
  const titles = new Map([[ID_A, "Add the schema"], [ID_B, "Retry the schema"]]);
  assert.equal(
    withTaskTitles(`waits for ${ID_A}, then ${ID_B}`, titles),
    `waits for "Add the schema", then "Retry the schema"`,
  );
  assert.equal(
    withTaskTitles(`after \`${ID_A}\` and "${ID_A}"`, titles),
    `after "Add the schema" and "Add the schema"`,
    "existing quotes are consumed rather than doubled",
  );
  assert.equal(
    withTaskTitles(`see /tasks/${ID_A} and /api/tasks/${ID_A}/update`, titles),
    `see /tasks/"Add the schema" and /api/tasks/"Add the schema"/update`,
    "the dashboard has no task URLs, so an id in a path is still a reference to the task",
  );
  assert.equal(
    withTaskTitles(`Task task-${ID_A} is blocked; see task_${ID_A}, (${ID_A}) and ${ID_A}.`, titles),
    `Task task-"Add the schema" is blocked; see task_"Add the schema", ("Add the schema") and "Add the schema".`,
    "a task id names the task whatever punctuation is around it",
  );
  assert.equal(
    withTaskTitles(`checkout ~/.mission-control/worktrees/${ID_A}/src/a.ts and worktrees/${ID_A}-1/b.ts`, titles),
    `checkout ~/.mission-control/worktrees/${ID_A}/src/a.ts and worktrees/${ID_A}-1/b.ts`,
    "a checkout path, the one real name Mission Control builds from a task id, keeps opening its file",
  );
  assert.equal(
    withTaskTitles(`x${ID_A} and ${ID_A}9`, titles),
    `x${ID_A} and ${ID_A}9`,
    "a letter or digit touching the UUID makes it part of a longer token",
  );
  assert.equal(withTaskTitles("no ids here", titles), "no ids here");
  assert.equal(
    withTaskTitles(`ship ${ID_A.toUpperCase()} after "${ID_B.toUpperCase()}"`, titles),
    `ship "Add the schema" after "Retry the schema"`,
    "a capitalised id is the same task",
  );
});

test("taskIdCandidates finds each task-shaped id once, lowercased, in order", () => {
  assert.deepEqual(
    taskIdCandidates(
      `see ${ID_A}, ${ID_A.toUpperCase()}, /tasks/${ID_C}, worktrees/${ID_D} and task-${ID_E}`,
    ),
    [ID_A, ID_C, ID_E],
    "repeats collapse, uppercase included; path segments and prefixed forms count; a checkout path does not",
  );
  assert.deepEqual(taskIdCandidates(`only ${ID_C.toUpperCase()}`), [ID_C], "lowercased, the form a task id is stored in");
  assert.deepEqual(taskIdCandidates("no ids here"), []);
});

test("the backlog planner is told to name tasks by title, and sees each prerequisite's title", () => {
  const dependency = {
    type: "task", taskId: "dep-1", title: "Land the schema", sessionId: null, episodeId: null,
    agentSessionId: null, branch: null, prUrl: null, selectedAt: null, satisfiedAt: null,
  } as TaskDependency;
  const prompt = buildBacklogPrompt([mkTask({ id: "t-1", title: "Use the schema", dependencies: [dependency] })]);
  assert.match(prompt, /whenever a reason or the note mentions a task, name it by its\s+title, never by its id/);
  assert.ok(prompt.includes(`operator dependencies: dep-1 (title: "Land the schema")`), prompt);
});

// The real stdio server, so the assertion is on what a harness actually receives.
const home = mkdtempSync(join(tmpdir(), "task-references-"));
const client = new Client({ name: "task-references", version: "1" });
before(async () => {
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", fileURLToPath(new URL("../src/mcp/server.ts", import.meta.url))],
    env: {
      ...process.env,
      MISSION_HOME: home,
      HARNESS_HOME: home,
      MISSION_API_TOKEN: "stub-token",
      MISSION_PORT: "1",
      MISSION_SESSION_ID: "sdk:task-references",
    } as Record<string, string>,
    stderr: "pipe",
  }));
});
after(async () => {
  await client.close();
  rmSync(home, { recursive: true, force: true });
});

test("the Mission Control MCP server states the rule in its instructions and every task tool", async () => {
  assert.equal(client.getInstructions(), TASK_REFERENCE_RULE);
  const { tools } = await client.listTools();
  for (const name of ["create_task", "list_tasks", "get_task", "update_task", "delete_task"]) {
    const tool = tools.find((candidate) => candidate.name === name);
    assert.ok(tool, `${name} is registered`);
    assert.ok(tool.description?.endsWith(TASK_REFERENCE_RULE), `${name} carries the rule`);
  }
});
