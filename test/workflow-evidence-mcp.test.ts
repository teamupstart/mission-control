import assert from "node:assert/strict";
import test from "node:test";
import { submitWorkflowEvidenceToDaemon } from "../src/mcp/workflow-evidence.ts";

const identity = { env: {}, sessionId: "session-1", cwd: "/repo" };
const coverage = [{
  clientCriterionId: "criterion-1",
  criterion: "The focused check passes",
  proofClass: "focused_execution" as const,
  repositoryScope: "repo-01" as const,
  links: [],
}];
const artifact = {
  clientItemId: "artifact-1",
  path: ".evidence/focused.log",
  caption: "Focused test output",
  repositoryScope: "repo-01" as const,
};

type Call = { path: string; method: string; body: unknown };

function requester(supported: boolean): { calls: Call[]; request: (path: string, method: string, body?: unknown) => Promise<Response> } {
  const calls: Call[] = [];
  return {
    calls,
    request: async (path, method, body) => {
      calls.push({ path, method, body });
      if (path === "/api/health") {
        return Response.json({
          service: "mission-control",
          capabilities: supported ? ["criterion-mapped-workflow-evidence-v1"] : [],
        });
      }
      return Response.json({ artifacts: [artifact], coverage, generation: 4 });
    },
  };
}

test("criterion coverage is refused before forwarding to an unsupported daemon", async () => {
  const fake = requester(false);
  const result = await submitWorkflowEvidenceToDaemon({ coverage }, identity, fake.request);
  assert.equal(result.isError, true);
  assert.match(result.text, /Restart Mission Control/);
  assert.deepEqual(fake.calls.map((call) => call.path), ["/api/health"]);
});

test("criterion coverage is forwarded intact after a supported daemon answers", async () => {
  const fake = requester(true);
  const result = await submitWorkflowEvidenceToDaemon({ coverage }, identity, fake.request);
  assert.equal(result.isError, false);
  assert.deepEqual(fake.calls.map((call) => call.path), ["/api/health", "/mcp/workflow-evidence"]);
  assert.deepEqual(fake.calls[1]?.body, {
    ...identity,
    images: [],
    artifacts: [],
    commandOutputs: [],
    coverage,
  });
});

test("legacy evidence remains usable without probing an unsupported daemon", async () => {
  const fake = requester(false);
  const result = await submitWorkflowEvidenceToDaemon({ artifacts: [artifact] }, identity, fake.request);
  assert.equal(result.isError, false);
  assert.deepEqual(fake.calls.map((call) => call.path), ["/mcp/workflow-evidence"]);
  assert.deepEqual(fake.calls[0]?.body, {
    ...identity,
    images: [],
    artifacts: [{ kind: "text", ...artifact }],
    commandOutputs: [],
    coverage: [],
  });
});
