import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  SCOUT_REPORT_PATH_SHAPE,
  SCOUT_REPORT_ROOT,
} from "../src/shared/scouts.ts";
import { MISSION_MCP_TOOLS, kindMissionMcpRequirement } from "../src/server/mission-mcp.ts";
import {
  SCOUT_APPENDIX_MARKER,
  isScoutTask,
  scoutReportAppendix,
} from "../src/server/scouts/prompt.ts";
import { scoutRepoSlots } from "../src/server/scouts/repos.ts";
import { withTaskKindContract } from "../src/server/task-contract.ts";
import { SUBMIT_WORKFLOW_EVIDENCE_TOOL } from "../src/server/workflows/evidence-tool.ts";
import { NO_MISTAKES_REVIEW_WORKFLOW_ID } from "../src/shared/builtin-workflow.ts";
import { SUBMIT_SCOUT_ARTIFACTS_TOOL } from "../src/server/scouts/submission-tool.ts";
import { SubmitScoutArtifactsSchema } from "../src/shared/protocol.ts";
import type { Task } from "../src/shared/types.ts";

/**
 * The delivery contract, and its two ways of drifting.
 *
 * A scout's report requirement lives in two documents that a reader will assume agree: the
 * appendix the daemon composes onto every scout intent, and `skills/html-report/SKILL.md`,
 * which is the opt-in guidance on how to write a good one. They are separate on purpose -
 * one is enforced and one is advice - so this file is what stops them from disagreeing about
 * the path, the rules, or whether a short answer is exempt.
 *
 * The second drift is between the prompt and the LAUNCH: a prompt naming a tool the launch
 * did not pre-approve produces an agent that stops on a permission prompt, which reads as an
 * agent that simply sat there.
 */

const src = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8");

function mkTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "Why did resume lose permissions?",
    intent: "Find out why a resumed agent lost repository permissions.",
    kind: "scout",
    agent: "claude",
    priority: null,
    labels: [],
    dependencies: [],
    enabled: true,
    model: null,
    effort: null,
    workflowId: null,
    source: null,
    repoRoot: "/repos/demo",
    worktreePath: "/work/demo",
    branch: null,
    provider: null,
    baseSha: null,
    extraRepos: [],
    homeName: null,
    terminalResourceId: null,
    sessionId: null,
    status: "running",
    outcome: null,
    outcomeUrl: null,
    error: null,
    scheduleId: null,
    scheduleOccurrenceId: null,
    scheduledFor: null,
    createdAt: 1,
    updatedAt: 1,
    dispatchedAt: null,
    completedAt: null,
    ...overrides,
  } as Task;
}

// ---------------------------------------------------------------------------
// What a scout is told
// ---------------------------------------------------------------------------

test("a scout's intent arrives intact, with the contract appended after it", () => {
  const task = mkTask();
  const delivered = withTaskKindContract(task, task.intent);
  assert.ok(delivered.startsWith(task.intent), "the operator's request is read first, unmodified");
  const marker = delivered.indexOf(SCOUT_APPENDIX_MARKER);
  assert.ok(marker > task.intent.length - 1, "and the contract follows it");
});

test("a ship task's intent is byte-identical to what it was", () => {
  const task = mkTask({ kind: "ship" });
  assert.equal(withTaskKindContract(task, task.intent), task.intent);
  assert.equal(isScoutTask(task), false);
});

test("only a ship task whose selected graph runs Personas receives workflow evidence", () => {
  const task = mkTask({ kind: "ship", workflowId: NO_MISTAKES_REVIEW_WORKFLOW_ID });
  const delivered = withTaskKindContract(task, task.intent, { workflowEvidence: true });
  assert.match(delivered, new RegExp(SUBMIT_WORKFLOW_EVIDENCE_TOOL));
  assert.match(delivered, /gitignored/);
  assert.match(delivered, /Do not commit/);
  const required = kindMissionMcpRequirement(task, null, true);
  assert.deepEqual(required?.tools, [SUBMIT_WORKFLOW_EVIDENCE_TOOL]);
});

test("the contract names the path, the rules, the tool, and the no-pull-request rule", () => {
  const appendix = scoutReportAppendix(scoutRepoSlots(mkTask()));
  assert.match(appendix, new RegExp(escape(SCOUT_REPORT_PATH_SHAPE)));
  assert.match(appendix, /NO JavaScript/);
  assert.match(appendix, /no external request of any kind/);
  assert.match(appendix, /open correctly from `file:\/\/`/);
  assert.match(appendix, /Answer first/);
  assert.match(appendix, /one sentence/, "a short scout still writes the page");
  assert.match(appendix, new RegExp(escape(SUBMIT_SCOUT_ARTIFACTS_TOOL)));
  assert.match(appendix, /Do NOT open a pull request/);
  assert.match(appendix, /no href/, "citations stay visible text");
  assert.match(appendix, /cannot be marked done/);
});

test("the contract issues the repository slots a submission has to use", () => {
  const single = scoutReportAppendix(scoutRepoSlots(mkTask()));
  assert.match(single, /repoSlot: "repo-01"/);
  assert.ok(!single.includes("repo-02"));

  const multi = scoutReportAppendix(
    scoutRepoSlots(
      mkTask({
        extraRepos: [
          {
            repoRoot: "/repos/sibling",
            worktreePath: "/work/sibling",
            branch: null,
            provider: null,
            baseSha: null,
            prUrl: null,
            prState: null,
            mergedAt: null,
          },
        ],
      }),
    ),
  );
  assert.match(multi, /`repo-01` - demo \(your working directory\)/);
  assert.match(multi, /`repo-02` - sibling/);
});

test("an assigned scout's slot resolves to the session's own checkout", () => {
  // `TaskManager.assign` refuses a multi-repo task, so an assignment always has exactly one
  // slot - and it has no worktree of its own, which is why the fallback exists at all.
  const slots = scoutRepoSlots(mkTask({ worktreePath: null }), "/home/dev/demo");
  assert.equal(slots.length, 1);
  assert.equal(slots[0]!.root, "/home/dev/demo");
  assert.equal(slots[0]!.slot, "repo-01");
});

// ---------------------------------------------------------------------------
// Drift against the optional skill
// ---------------------------------------------------------------------------

test("the html-report skill and the daemon contract agree about the report", () => {
  const skill = src("skills/html-report/SKILL.md");
  const appendix = scoutReportAppendix(scoutRepoSlots(mkTask()));

  // The path, spelled the same way in both.
  assert.match(skill, new RegExp(escape(`${SCOUT_REPORT_ROOT}/<slug>/report.html`)));
  assert.match(appendix, new RegExp(escape(SCOUT_REPORT_PATH_SHAPE)));

  // Self-contained, offline, no JavaScript - the three rules a capture actually refuses on.
  assert.match(skill, /Self-contained/);
  assert.match(skill, /No JavaScript/);
  assert.match(skill, /file:\/\//);

  // Answer first, in both.
  assert.match(skill, /Answer first/);
  assert.match(appendix, /Answer first/);

  // The path handed back at the end, in both.
  assert.match(skill, /log the report as a checkout-relative path/i);
  assert.match(appendix, /naming the report path on its own line/);
});

test("the skill's short-answer exception is explicitly withdrawn for a scout", () => {
  const skill = src("skills/html-report/SKILL.md");
  assert.match(
    skill,
    /one-sentence exception never applies to a Mission Control scout task/,
    "a scout writes the page whatever the answer's size",
  );
  assert.match(skill, new RegExp(escape(SUBMIT_SCOUT_ARTIFACTS_TOOL)));
  assert.match(skill, /cannot be marked done/);
});

test("the skill teaches a scout to drop the href its Files-tab advice adds", () => {
  const skill = src("skills/html-report/SKILL.md");
  // The Files tab wants a link into the checkout; an archive read after that checkout is gone
  // must not carry one, and capture refuses a relative link that leaves the report directory.
  assert.match(skill, /On a scout task, drop the href too/);
  assert.match(skill, /refuses a\s+relative link that leaves that directory/);
});

// ---------------------------------------------------------------------------
// Drift between the prompt and the launch
// ---------------------------------------------------------------------------

test("every scout launch requires the tool its prompt names", () => {
  const appendix = scoutReportAppendix(scoutRepoSlots(mkTask()));
  assert.match(appendix, new RegExp(escape(SUBMIT_SCOUT_ARTIFACTS_TOOL)));
  assert.ok(
    ([...MISSION_MCP_TOOLS] as string[]).includes(SUBMIT_SCOUT_ARTIFACTS_TOOL),
    "a caller can require it",
  );
  const required = kindMissionMcpRequirement(mkTask(), null);
  assert.deepEqual(required, { tools: [SUBMIT_SCOUT_ARTIFACTS_TOOL] });
});

test("a scout's requirement is unioned with the caller's rather than replacing it", () => {
  const required = kindMissionMcpRequirement(mkTask(), { tools: ["report_status"] });
  assert.deepEqual([...(required?.tools ?? [])].sort(), ["report_status", SUBMIT_SCOUT_ARTIFACTS_TOOL].sort());
  // And a repeat is idempotent - a set, not a list.
  const again = kindMissionMcpRequirement(mkTask(), required);
  assert.equal(again?.tools.length, 2);
});

test("a ship task's requirement is returned untouched, null included", () => {
  const ship = mkTask({ kind: "ship" });
  assert.equal(kindMissionMcpRequirement(ship, null), null, "an unchanged dispatch stays unchanged");
  const existing = { tools: ["submit_ensemble_result"] } as const;
  assert.equal(kindMissionMcpRequirement(ship, existing), existing, "the same object, not a copy");
});

test("the bundled MCP server registers the tool under the exact name the prompt uses", () => {
  const server = src("src/mcp/server.ts");
  assert.match(
    server,
    new RegExp(`registerTool\\(\\s*["']${SUBMIT_SCOUT_ARTIFACTS_TOOL}["']`),
    "the registry scrape and the prompt must find the same string",
  );
  const protocol = src("src/shared/protocol.ts");
  assert.match(protocol, /SubmitScoutArtifactsSchema/, "the daemon validates the body it receives");
  const routes = src("src/server/routes.ts");
  assert.match(routes, /\/mcp\/scouts\/submit/, "and the route the bundled server posts to exists");
});

test("the scout submission body cannot select a session or checkout", () => {
  const parsed = SubmitScoutArtifactsSchema.parse({
    env: { tmuxPane: "%victim" },
    sessionId: "victim-session",
    cwd: "/victim/checkout",
    taskId: "victim-task",
    reportPath: "docs/reports/resume/report.html",
    summary: "found it",
  });
  assert.deepEqual(parsed, {
    reportPath: "docs/reports/resume/report.html",
    summary: "found it",
    tags: [],
    supporting: [],
  });
});

test("both delivery seams compose the contract, not just the dispatcher", () => {
  // A dispatcher-only helper would leave every backlog scout assigned to a live agent with no
  // idea it owed an HTML page - the exact gap this pins. One symbol, because the composer is
  // kind-dispatched now: a second helper beside it is how the two seams start disagreeing
  // about the order the contract is appended in.
  assert.match(src("src/server/dispatcher.ts"), /withTaskKindContract\(/);
  assert.match(src("src/server/tasks.ts"), /withTaskKindContract\(/);
});

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
