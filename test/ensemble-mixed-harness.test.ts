import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * What is at stake: one ensemble wave can mix Claude and Codex members, and each must launch with
 * its own agent/model/effort and role prompt, all cut from the ONE pinned base, and each must reach
 * the launch-scoped Mission MCP `submit_ensemble_result` tool regardless of harness - the whole
 * point being that a member submits without the operator having installed the global integration.
 * ensemble-submission.test.ts already proves session->task->member attribution for both harnesses
 * (and that a non-ensemble/uninstrumented session cannot claim a submission); mission-mcp.test.ts
 * proves the Claude ask-channel and Codex TOML all-or-none composition. This suite proves the piece
 * between them: a mixed fleet launches correctly through the engine, and the member launch attaches
 * the submit tool harness-neutrally.
 */

const home = mkdtempSync(join(tmpdir(), "mission-ensemble-mixed-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { EnsembleStore, clearEnsembleTables } = await import("../src/server/ensembles/store.ts");
const { EnsembleEngine } = await import("../src/server/ensembles/engine.ts");
const { TaskManagerGateway } = await import("../src/server/ensembles/member-launch.ts");
const { SUBMIT_ENSEMBLE_RESULT_TOOL } = await import("../src/server/ensembles/submission-tool.ts");
const { MISSION_MCP_TOOLS } = await import("../src/server/mission-mcp.ts");
const { FakeGateway, stubAdapters, runInsert } = await import("./ensemble-fixture.ts");
const fx = await import("./ensemble-strategy-fixtures.ts");

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => clearEnsembleTables(db));

function src(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

test("a mixed Claude/Codex wave launches each member with its own config from one pinned base", async () => {
  const store = new EnsembleStore(db);
  const gateway = new FakeGateway();
  const engine = new EnsembleEngine({ store, tasks: gateway, publish: () => {}, armTimer: () => () => {}, adapters: stubAdapters() });
  const plan = fx.fixedMatrixPlan([
    { agent: "claude", model: "claude-opus-4-8", effort: "high" },
    { agent: "codex", model: "gpt-5-codex" },
    { agent: "claude" },
  ]);
  const run = store.createRun(runInsert(plan, { sourceKey: "mixed-1", baseSha: "a".repeat(40) })).run;
  await engine.launch(run.id);

  // Every cell launched, with its own harness and overrides carried onto the create request.
  assert.deepEqual(gateway.created.map((c) => c.agent), ["claude", "codex", "claude"]);
  const claudeCell = gateway.created[0]!;
  assert.equal(claudeCell.model, "claude-opus-4-8");
  assert.equal(claudeCell.effort, "high");
  assert.equal(gateway.created[1]!.model, "gpt-5-codex");
  assert.equal(gateway.created[1]!.effort, null, "an unset override stays null, never a fabricated default");
  // The ensemble role appendix is folded into the first prompt each member receives.
  assert.match(claudeCell.intent, /submit/i, "the role prompt tells the member to submit for comparison");

  // The whole fleet is cut from the ONE pinned base - a mixed comparison is invalid otherwise.
  assert.equal(gateway.dispatched.length, 3);
  assert.ok(gateway.dispatched.every((d) => d.baseSha === "a".repeat(40)), "every member pinned to the same base");
});

test("the ensemble member launch requires the submit tool for every harness, never branching on the agent", async () => {
  // A recording TaskManager stand-in that captures the dispatch options for each member.
  const recorded: Array<{ taskId: string; missionMcpTools: string[] | null; baseSha: string | undefined }> = [];
  const fakeTasks = {
    create() {},
    async dispatch(taskId: string, opts: { baseSha?: string; missionMcp?: { tools: string[] } }) {
      recorded.push({ taskId, missionMcpTools: opts.missionMcp?.tools ?? null, baseSha: opts.baseSha });
      return { ok: true as const };
    },
    async cancel() {
      return { ok: true as const };
    },
  };
  const fakeRegistry = { getTask: () => undefined, getSession: () => undefined };
  const gateway = new TaskManagerGateway(fakeTasks as never, fakeRegistry as never);

  for (const agent of ["claude", "codex"] as const) {
    await gateway.dispatch({ taskId: `task-${agent}`, baseSha: "b".repeat(40), model: null, effort: null } as never);
  }

  assert.equal(recorded.length, 2);
  for (const call of recorded) {
    assert.deepEqual(call.missionMcpTools, [SUBMIT_ENSEMBLE_RESULT_TOOL], "both harnesses require exactly the submit tool");
    assert.equal(call.baseSha, "b".repeat(40));
  }
});

test("the submit tool is single-sourced and reachable through the one Mission MCP seam", () => {
  // The launch requirement, the MCP vocabulary, and the server registration must name ONE constant,
  // or a launch pre-approves a tool the server never publishes (or worse, the reverse).
  assert.ok(MISSION_MCP_TOOLS.includes(SUBMIT_ENSEMBLE_RESULT_TOOL), "the shared MCP vocabulary includes the submit tool");
  const mcpServer = src("src/mcp/server.ts");
  assert.match(mcpServer, new RegExp(`registerTool\\(\\s*["']${SUBMIT_ENSEMBLE_RESULT_TOOL}["']`), "the MCP server registers the submit tool by that exact name");
  const protocol = src("src/shared/protocol.ts");
  assert.match(protocol, /SubmitEnsembleResultSchema/, "the shared protocol validates the submit body");
  // member-launch attaches it unconditionally - not inside any per-agent branch.
  const launch = src("src/server/ensembles/member-launch.ts");
  assert.match(launch, /missionMcp:\s*\{\s*tools:\s*\[SUBMIT_ENSEMBLE_RESULT_TOOL\]/, "the requirement is a literal, not agent-conditional");
  assert.doesNotMatch(launch, /agent\s*===\s*["']codex["']/, "member dispatch never branches on the harness");
});
