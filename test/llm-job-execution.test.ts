import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

// What is at stake: which provider a background job SPAWNS on, and whether the row written
// about that call names the same one.
//
// Both halves used to be trivially true because there was one answer for the whole app. With
// a provider per job they are two separate claims, and the second fails silently: a caller
// that re-derives its label from `llmRunnerChoice` prints the app-wide provider next to a call
// that ran on the job's own. Nothing in the product contradicts it - the ledger simply says
// Claude about a Codex call, forever, on every installation that set an override.
//
// So this file asserts the pair from both ends. `runJob` and `runJobStructured` hand back what
// they used, and what they hand back is what they actually spawned with - asserted with an
// override SET, because with none set the wrong answer and the right one coincide and a test
// that only covers the default case cannot see the bug at all.

const home = mkdtempSync(join(tmpdir(), "mission-llm-exec-"));
// Set before importing anything that resolves the state dir.
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { setLlmConfig } = await import("../src/server/llm/config.ts");
const { LLM_RUNNERS } = await import("../src/server/llm/index.ts");
const { runJob, runJobStructured } = await import("../src/server/llm/jobs.ts");
const { LLM_JOB_SPECS } = await import("../src/shared/llm-jobs.ts");
const { LLM_RUNNER_IDS } = await import("../src/shared/llm.ts");
const { compactWorkflowContext } = await import("../src/server/workflows/context.ts");
import type { LlmRunnerId } from "../src/shared/llm.ts";
import type { RawWorkflowContext } from "../src/server/workflows/context.ts";

after(() => rmSync(home, { recursive: true, force: true }));

/** What each runner was actually asked to spawn, in call order. */
let spawned: { runner: LlmRunnerId; model: string | undefined }[] = [];
/** What the next `run` on any runner replies with. */
let reply = "";

const originals = new Map(LLM_RUNNER_IDS.map((id) => [id, LLM_RUNNERS[id].run]));

beforeEach(() => {
  openDb().exec("DELETE FROM app_config");
  for (const job of Object.values(LLM_JOB_SPECS)) delete process.env[job.envVar];
  delete process.env.MISSION_LLM_RUNNER;
  spawned = [];
  reply = "";
  // Stubbed per runner rather than through one shared fake, because the whole question here
  // is WHICH runner was reached, and a single fake standing in for both cannot answer it.
  for (const id of LLM_RUNNER_IDS) {
    LLM_RUNNERS[id].run = async (_prompt, opts) => {
      spawned.push({ runner: id, model: opts?.model });
      return reply;
    };
  }
});

after(() => {
  for (const [id, run] of originals) LLM_RUNNERS[id].run = run;
});

test("runJob spawns on the job's own provider and reports the pair it used", async () => {
  setLlmConfig({ runner: "claude", runners: { "away-digest": "codex" } });
  reply = "the fleet did some things";

  const result = await runJob("away-digest", "prompt");

  assert.equal(result.text, "the fleet did some things");
  assert.deepEqual(spawned, [{ runner: "codex", model: "gpt-5.6-luna" }]);
  // The reported pair is the SPAWNED pair, not a second resolution of the same config.
  assert.deepEqual(result.execution, { runner: "codex", model: "gpt-5.6-luna" });
});

test("the reported pair is the POST-GUARD one when a fallback was substituted", async () => {
  // The one thing only the callee knows. A caller re-deriving its label would print the id
  // that was refused rather than the one that ran.
  setLlmConfig({ runners: { goal: "codex" }, models: { goal: "claude-sonnet-5" } });
  reply = '{"title":"x"}';

  const result = await runJob("goal", "prompt");

  assert.deepEqual(spawned, [{ runner: "codex", model: "gpt-5.6-luna" }]);
  assert.deepEqual(result.execution, { runner: "codex", model: "gpt-5.6-luna" });
});

const TitleSchema = z.object({ title: z.string() });

test("runJobStructured reports the pair on both the ok and the failed branch", async () => {
  setLlmConfig({ runners: { "task-title": "codex" } });

  reply = '{"title":"named"}';
  const ok = await runJobStructured<typeof TitleSchema>(
    "task-title",
    "prompt",
    (raw) => TitleSchema.safeParse(JSON.parse(raw)).data ?? null,
    "Title",
  );
  assert.equal(ok.kind, "ok");
  assert.deepEqual(ok.execution, { runner: "codex", model: "gpt-5.6-luna" });

  spawned = [];
  reply = "not json at all";
  const failed = await runJobStructured<typeof TitleSchema>(
    "task-title",
    "prompt",
    () => null,
    "Title",
  );
  assert.equal(failed.kind, "failed");
  // A caller recording what it TRIED needs the pair exactly as much as one recording what
  // worked - and both attempts of the retry ran on it, which is what makes it one answer.
  assert.deepEqual(failed.execution, { runner: "codex", model: "gpt-5.6-luna" });
  assert.deepEqual(
    spawned.map((s) => s.runner),
    ["codex", "codex"],
    "the parse retry must not land on a different provider than the first attempt",
  );
});

test("onExecution fires before the first attempt, so an in-flight row can be labelled", async () => {
  // The `llm_calls` row is inserted from inside `observer.start` and closed at `finish`, which
  // is earlier than any return value. Without this hook the engine had no way to name the pair
  // except by resolving it again, which is the bug.
  setLlmConfig({ runners: { "workflow-context": "codex" } });
  reply = '{"constraints":[],"acceptanceCriteria":[]}';
  const order: string[] = [];

  await runJobStructured<typeof TitleSchema>(
    "workflow-context",
    "prompt",
    (raw) => TitleSchema.safeParse(JSON.parse(raw)).data ?? null,
    "Compaction",
    {
      onExecution: (execution) => order.push(`execution:${execution.runner}`),
      observer: { start: (attempt) => void order.push(`start:${attempt}`), finish: () => {} },
    },
  );

  assert.deepEqual(order.slice(0, 2), ["execution:codex", "start:1"]);
});

const RAW: RawWorkflowContext = {
  primaryGoal: { rawPrompt: "ship it", refined: "Ship it", sourceNoteKey: "n1" },
  humanDecisions: [],
  priorPersonaFeedback: [],
  session: { agent: "claude", name: "work", cwd: "/repo", branch: "feature" },
  evidence: {
    headSha: "abc",
    diffFingerprint: "diff",
    diff: "patch",
    diffTruncated: false,
    workingTreeDirty: false,
    workingTreeStatus: [],
    workingTreeStatusTruncated: false,
    transcript: [],
    transcriptAnchor: 12,
    transcriptTruncated: false,
    standards: [],
    standardsTruncated: false,
  },
};

test("the compaction stamp records the provider the call used, not the app-wide one", async () => {
  // Asserted with a per-job override SET, because that is the case where a re-resolving label
  // and the real call diverge every time rather than only under a race. With no override the
  // two coincide and the assertion proves nothing.
  setLlmConfig({ runner: "claude", runners: { "workflow-context": "codex" } });
  reply = '{"constraints":["be quick"],"acceptanceCriteria":["it works"],"canonicalCriteria":[]}';

  const snapshot = await compactWorkflowContext(RAW);

  assert.equal(snapshot.compaction.status, "model");
  assert.deepEqual(spawned, [{ runner: "codex", model: "gpt-5.6-luna" }]);
  assert.equal(snapshot.compaction.runner, "codex", "the stamp named the app-wide provider");
  assert.equal(snapshot.compaction.model, "gpt-5.6-luna");
});

test("a failed compaction stamps the provider it tried, on the same evidence", async () => {
  setLlmConfig({ runners: { "workflow-context": "codex" } });
  reply = "not json";

  const snapshot = await compactWorkflowContext(RAW);

  assert.equal(snapshot.compaction.status, "fallback");
  assert.equal(snapshot.compaction.runner, "codex");
  assert.equal(snapshot.compaction.model, "gpt-5.6-luna");
});
