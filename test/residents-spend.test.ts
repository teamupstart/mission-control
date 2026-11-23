import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { mkTask } from "./helpers/session-fixture.ts";
import { ResidentProfileRevisionSchema, residentLaunchInput } from "../src/shared/residents.ts";
import { Registry } from "../src/server/registry.ts";
import { openDb, sessionSpendSince } from "../src/server/db.ts";
import { upsertSdkSession } from "../src/server/sdk/store.ts";
import * as store from "../src/server/residents/store.ts";
import { residentGuardrail, RESIDENT_DAY_MS } from "../src/server/residents/loop-store.ts";
import { residentSpendProblem } from "../src/server/residents/spend.ts";

process.env.MISSION_USAGE_POLL_MS = "10";
const { startUsagePoller } = await import("../src/server/usage.ts");

for (const [codexModel, expectedSpend] of [
  ["gpt-6-luna", 0.000107], ["gpt-6.2-sol", 0.00212], ["gpt-6.2-astra", 0.00848],
] as const) {
  test(`real Registry pipelines account resident spend and enforce the cap for ${codexModel}`, async () => {
    const registry = new Registry();
    const nativeId = (agent: string): string => `native-${codexModel}-${agent}`;
    const runId = (agent: string): string => `${codexModel}-${agent}`;
    const at = Date.now();
    for (const agent of ["claude", "codex"] as const) {
      const model = agent === "claude" ? "claude-haiku-4-5" : codexModel;
      const settings = ResidentProfileRevisionSchema.parse({ identity: { name: runId(agent) }, persona: { personaId: "p" }, execution: { agent, model }, loop: { spendCapUsd: 0.000001 } });
      store.createResidentProfile({ id: runId(agent), settings, at });
      store.reserveResidentRun({ id: runId(agent), profileId: runId(agent), profileRevision: 1, taskId: runId(agent), launchRequestId: runId(agent),
        launchInput: residentLaunchInput("/repo", ""), repoSpelling: "/repo", persona: { personaId: "p", name: "Observer", guidanceMarkdown: "" }, runInstructions: "", at });
      store.markResidentRunLaunched(runId(agent), null, at);
      const id = `sdk:${runId(agent)}`; const native = nativeId(agent);
      registry.upsertTask(mkTask({ id: runId(agent), kind: "resident", agent, model, sessionId: id }));
      upsertSdkSession({ id, agent, agentSessionId: native, cwd: "/repo", taskId: runId(agent), model, effort: null, permissionMode: null, status: "running", turnInProgress: false });
      registry.registerSdkSession({ id, agent, agentSessionId: native, cwd: "/repo", name: agent });
      let path: string | null = null;
      if (agent === "codex") {
        path = join(process.env.HARNESS_HOME!, `${codexModel}-rollout.jsonl`);
        writeFileSync(path, [
          { type: "session_meta", timestamp: new Date(at).toISOString(), payload: { id: native, cwd: "/repo", source: "cli" } },
          { type: "turn_context", payload: { model } },
          { type: "event_msg", timestamp: new Date(at).toISOString(), payload: { type: "token_count", info: { last_token_usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 50, reasoning_output_tokens: 0, cache_write_input_tokens: 0 } } } },
        ].map(r => JSON.stringify(r)).join("\n") + "\n");
      }
      registry.applyDriverEvent(id, { kind: "bound", agentSessionId: native, transcriptPath: path, modelId: model, pid: null });
      registry.applyDriverEvent(id, { kind: "turn_done", usage: agent === "claude" ? {
        modelId: model, costUsd: 0.25, input: 1000, output: 50, cacheRead: 0, cacheWrite: 0, reasoningOutput: 0, turnId: "result-1",
        models: [{ modelId: model, input: 1000, output: 50, cacheRead: 0, cacheWrite: 0, reasoningOutput: 0, reportedCostUsd: 0.25 }],
      } : null });
    }
    const stop = startUsagePoller(registry);
    try {
      for (let i = 0; i < 100 && sessionSpendSince([nativeId("codex")], 0).costUsd === 0; i++) await delay(10);
      assert.equal(sessionSpendSince([nativeId("claude")], 0).costUsd, 0.25);
      const codex = sessionSpendSince([nativeId("codex")], 0);
      assert.equal(codex.costUsd, expectedSpend);
      await delay(30);
      assert.deepEqual(sessionSpendSince([nativeId("codex")], 0), codex, "poller replay cannot double-count");
      for (const agent of ["claude", "codex"] as const) {
        const run = store.getResidentRun(runId(agent))!.run;
        const spend = sessionSpendSince([nativeId(agent)], 0);
        const recordedAt = spend.entries[0]!.at;
        assert.match(residentGuardrail(run, recordedAt + RESIDENT_DAY_MS - 1)!, /Spend guardrail.*Resume after/);
        assert.equal(residentGuardrail(run, recordedAt + RESIDENT_DAY_MS), null);
        assert.equal(sessionSpendSince([nativeId(agent)], recordedAt).costUsd, 0);
      }
      openDb().prepare("UPDATE usage_ledger SET cost_known = 0 WHERE note_key = ?").run(nativeId("codex"));
      assert.equal(sessionSpendSince([nativeId("codex")], 0).costUsd, null);
      assert.match(residentGuardrail(store.getResidentRun(runId("codex"))!.run, at + 1000)!, /cannot be measured/);
    } finally { stop(); }
  });
}

test("unpriced model validation never silently disables a configured spend cap", () => {
  for (const agent of ["claude", "codex"] as const) {
    const settings = ResidentProfileRevisionSchema.parse({ identity: { name: agent }, persona: { personaId: "p" }, execution: { agent, model: "unknown-new-model" } });
    assert.match(residentSpendProblem(settings)!, /cannot be priced/);
    assert.equal(residentSpendProblem({ ...settings, loop: { ...settings.loop, spendCapUsd: null } }), null);
  }
});

for (const model of ["gpt-6.1-sol", "gpt-6.2-sol", "gpt-6.2-astra"]) {
  test(`${model} can retain the default resident spend cap`, () => {
    const settings = ResidentProfileRevisionSchema.parse({ identity: { name: "Agent Wrangler" }, execution: { agent: "codex", model } });
    assert.equal(settings.loop.spendCapUsd, 20);
    assert.equal(residentSpendProblem(settings), null);
  });
}

test("all published Claude spend models accept caps without substituting estimated rates", async () => {
  const { CLAUDE_REPORTED_SPEND_MODELS } = await import("../src/shared/resident-spend.ts");
  const { claudeRunner } = await import("../src/server/llm/claude.ts");
  for (const model of CLAUDE_REPORTED_SPEND_MODELS) {
    const settings = ResidentProfileRevisionSchema.parse({ identity: { name: model }, execution: { agent: "claude", model } });
    assert.equal(residentSpendProblem(settings), null, model);
    assert.deepEqual(claudeRunner.price({ modelId: model, reportedCostUsd: 0.37, input: 1000, output: 1000, cacheRead: 1000, cacheWrite: 1000, reasoningOutput: 0 }), {
      costUsd: 0.37, basis: "reported", pricingVersion: "",
    });
  }
});
