import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { PublishedWorkflowGraph } from "../src/shared/workflow.ts";
import { mkTask } from "./helpers/session-fixture.ts";

/**
 * Agent evidence belongs to the BINDING, not to a task's dispatch-time intent.
 *
 * A workflow reaches a conversation two ways: `tasks.workflow_id` selected before dispatch,
 * or an operator attaching one to a session that is already running. Only the first writes
 * that column, and the Persona repair prompt names `submit_workflow_evidence` for both - so
 * gating the agent's intake on the column refused every manually attached conversation with
 * `workflow_unbound`, which is a Persona asking for proof the daemon then would not accept.
 */

const home = mkdtempSync(join(tmpdir(), "mission-workflow-agent-evidence-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { openDb } = await import("../src/server/db.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const { Registry, noteKeyFor } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { PersonaManager } = await import("../src/server/workflows/personas.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const { buildApp } = await import("../src/server/routes.ts");

const PERSONA_GRAPH: PublishedWorkflowGraph = {
  nodes: [
    { id: "session", kind: "session", position: { x: 0, y: 0 } },
    {
      id: "persona",
      kind: "persona",
      persona: {
        sourcePersonaId: "persona-evidence",
        sourceRevision: 1,
        name: "Evidence reviewer",
        description: "",
        guidanceMarkdown: "Review the evidence.",
        runner: "claude",
        model: "fake",
      },
      position: { x: 100, y: 0 },
    },
    { id: "end", kind: "end", outcome: "Complete", position: { x: 200, y: 0 } },
  ],
  edges: [
    { id: "s-p", source: "session", sourcePort: "submitted", target: "persona", targetPort: "activate" },
    { id: "p-pass", source: "persona", sourcePort: "pass", target: "end", targetPort: "terminal" },
    { id: "p-fail", source: "persona", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
  ],
};

function seedPersonaVersion(id: string): string {
  const db = openDb();
  const defaults = JSON.stringify({ triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 3 });
  db.prepare(
    `INSERT INTO workflow_definitions (
       id, name, normalized_name, description, draft_graph_json, completion_policy_json,
       binding_defaults_json, draft_revision, current_version_id, archived_at, created_at, updated_at
     ) VALUES (?, ?, ?, '', '{"nodes":[],"edges":[]}', '{"kind":"none"}', ?, 1, ?, NULL, 1, 1)`,
  ).run(`w-${id}`, `W ${id}`, `w-${id}`, defaults, `v-${id}`);
  db.prepare(
    `INSERT INTO workflow_versions (
       id, workflow_id, version, source_draft_revision, graph_json,
       completion_policy_json, binding_defaults_json, published_at
     ) VALUES (?, ?, 1, 1, ?, '{"kind":"none"}', ?, 1)`,
  ).run(`v-${id}`, `w-${id}`, JSON.stringify(PERSONA_GRAPH), defaults);
  return `v-${id}`;
}

function discovered(cwd: string, id: string, over: Partial<DiscoveredSession> = {}): DiscoveredSession {
  return {
    syntheticId: id,
    agent: "claude",
    name: "synthesis scout",
    nameSource: "process",
    cwd,
    gitBranch: "feature",
    gitRoot: cwd,
    repoRoot: cwd,
    pid: 1,
    tty: `ttys-${id}`,
    terminals: [],
    startedAt: 1,
    ...over,
  } as DiscoveredSession;
}

/**
 * One live scout session inside a real checkout, with a workflow attached BY HAND.
 *
 * The task deliberately keeps `workflowId: null` - that is what a manual attach leaves
 * behind, and reproducing the report means never writing that column.
 */
function harness(repo: string, id: string) {
  const versionId = seedPersonaVersion(`agent-evidence-${id}`);
  const registry = new Registry();
  registry.applyDiscovery([discovered(repo, id)]);
  const session = registry.getSession(id);
  assert.ok(session);
  registry.upsertTask(mkTask({
    id: `scout-${id}`,
    kind: "scout",
    title: "Synthesis: Platform reliability investment review",
    status: "running",
    sessionId: session.id,
    repoRoot: repo,
    worktreePath: repo,
    workflowId: null,
  }));
  const personas = new PersonaManager(registry);
  const workflows = new WorkflowManager(registry, personas.store);
  const app = buildApp(
    registry,
    new ReviewManager(registry),
    new TaskManager(registry),
    new QueueManager(registry),
    undefined,
    personas,
    workflows,
  );
  return { app, registry, session, workflows, versionId };
}

async function evidenceRequest(
  app: ReturnType<typeof buildApp>,
  body: unknown,
): Promise<Response> {
  return await app.request("/mcp/workflow-evidence", {
    method: "POST",
    headers: {
      host: "127.0.0.1:7317",
      "content-type": "application/json",
      "x-harness-token": ensureToken(),
    },
    body: JSON.stringify(body),
  });
}

test("a manually attached workflow accepts agent evidence from a scout session", async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "mission-agent-evidence-repo-")));
  try {
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, ".gitignore"), "evidence/\n");
    const { app, session, workflows, versionId } = harness(repo, "bound-scout-session");

    const bound = workflows.createBinding({ workflowVersionId: versionId, sessionId: session.id });
    assert.equal(bound.ok, true, bound.ok ? "" : bound.message);

    const response = await evidenceRequest(app, {
      env: { cwd: repo },
      cwd: repo,
      commandOutputs: [{
        kind: "command",
        clientItemId: "focused-regression",
        command: "npx playwright test e2e/specs/files-toolbar.spec.ts",
        exitCode: 0,
        output: "1 passed",
        caption: "Focused Playwright regression for the narrow files toolbar",
        repositoryScope: "repo-01",
      }],
    });

    const body = await response.text();
    assert.equal(response.status, 200, body);
    const staged = JSON.parse(body) as {
      generation: number;
      artifacts: Array<{ clientItemId: string; sourceKind: string }>;
    };
    assert.equal(staged.generation, 1);
    assert.deepEqual(
      staged.artifacts.map((entry) => [entry.clientItemId, entry.sourceKind]),
      [["focused-regression", "command"]],
    );
    assert.equal(
      workflows.store.listWorkflowEvidence(noteKeyFor(session)).artifacts?.length,
      1,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("an unbound session still cannot register agent evidence", async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "mission-agent-evidence-unbound-")));
  try {
    execFileSync("git", ["init", "-q", repo]);
    const { app } = harness(repo, "unbound-scout-session");

    const response = await evidenceRequest(app, {
      env: { cwd: repo },
      cwd: repo,
      commandOutputs: [{
        kind: "command",
        clientItemId: "focused-regression",
        command: "npm test",
        exitCode: 0,
        output: "ok",
        caption: "Evidence with no workflow to consume it",
        repositoryScope: "repo-01",
      }],
    });

    assert.equal(response.status, 403);
    assert.equal((await response.json() as { code: string }).code, "workflow_unbound");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
