/**
 * The daemon's side of launch failures: dismissing them, and starting the session that reports
 * one. The record itself and every reading of it live in `@shared/launch-failure.ts`; this file
 * only writes through the Registry, which is the one task writer.
 */
import { join } from "node:path";
import {
  LAUNCH_FAILURE_PHASE_COPY,
  hasOpenLaunchFailure,
  launchFailureGroupKey,
  launchFailureOutcome,
  type LaunchFailureOutcome,
} from "@shared/launch-failure.ts";
import { stateDir } from "@shared/harness-runtime.mjs";
import type { Task } from "@shared/types.ts";
import type { Registry } from "./registry.ts";

type TaskWriter = Pick<Registry, "getTask" | "upsertTask">;

/** Dismiss each named task's open launch failure. Returns how many were open. */
export function dismissLaunchFailures(registry: TaskWriter, taskIds: readonly string[], now: number): number {
  let dismissed = 0;
  for (const id of new Set(taskIds)) {
    const task = registry.getTask(id);
    if (!task || !hasOpenLaunchFailure(task)) continue;
    registry.upsertTask({ ...task, launchFailure: { ...task.launchFailure!, dismissedAt: now }, updatedAt: now });
    dismissed++;
  }
  return dismissed;
}

/**
 * Every task whose launch failed the same way as `task`, newest first, `task` included.
 *
 * Dismissed attempts are included: a report is about the reason, and the attempts an operator
 * already acknowledged are still evidence of how often it happens.
 */
export function launchFailureGroupFor(tasks: readonly Task[], task: Task): Task[] {
  const key = launchFailureGroupKey(task);
  return tasks
    .filter((t) => t.launchFailure && launchFailureGroupKey(t) === key)
    .sort((a, b) => (b.launchFailure!.at) - (a.launchFailure!.at));
}

/** Record the report session on every attempt in the group, so each tile can open it. */
export function recordLaunchFailureReport(registry: TaskWriter, group: readonly Task[], reportTaskId: string, now: number): void {
  for (const member of group) {
    const task = registry.getTask(member.id);
    if (!task?.launchFailure) continue;
    registry.upsertTask({ ...task, launchFailure: { ...task.launchFailure, reportTaskId }, updatedAt: now });
  }
}

/**
 * Mark a task as the Report bug session for `failedTaskId`, read back from the Registry so a
 * write the dispatch has already made to it since its creation is kept.
 */
export function markLaunchFailureReport(registry: TaskWriter, reportTaskId: string, failedTaskId: string, now: number): Task | null {
  const report = registry.getTask(reportTaskId);
  if (!report) return null;
  const marked = { ...report, launchReportFor: failedTaskId, updatedAt: now };
  registry.upsertTask(marked);
  return marked;
}

/** The report session's card title. */
export function launchFailureReportTitle(task: Task): string {
  return `Report: ${task.title} did not start`.slice(0, 200);
}

const OUTCOME_COPY: Record<LaunchFailureOutcome, string> = {
  "not-started": "failed before its session started; nothing is running",
  returned: "failed while provisioning and was put back in the Backlog",
  kept: "failed after its session was created; that session was kept",
};

function when(at: number): string {
  return new Date(at).toISOString();
}

/**
 * The report session's first prompt, built from the failed task and its group.
 *
 * Private facts go in, because this is the operator's own session and it needs them to find
 * the evidence. The public issue is the session's to compose, and the brief says - as its
 * first requirement, not a footnote - what must never reach it.
 */
export function launchFailureReportBrief(task: Task, group: readonly Task[]): string {
  const failure = task.launchFailure!;
  const outcome = launchFailureOutcome(task);
  const attempts = group.map((t) => `- ${when(t.launchFailure!.at)} - task ${t.id} (${t.status})`);
  const facts = [
    `- Task kind: ${task.kind}`,
    `- Agent: ${task.agent}${task.model ? `, model ${task.model}` : ""}`,
    `- Stopped ${LAUNCH_FAILURE_PHASE_COPY[failure.phase]} (dispatch phase \`${failure.phase}\`)`,
    `- Outcome: ${outcome ? OUTCOME_COPY[outcome] : "no longer open"}`,
    `- Error recorded on the task: ${task.error ?? "(none recorded)"}`,
    // Facts only some kinds have, read off the record rather than off a list of kinds: only a
    // resident launch records a profile, and only a pipeline dispatch owns a provider run.
    ...(failure.residentProfileId ? [`- Resident profile id: ${failure.residentProfileId}`] : []),
    ...(task.pipelineRun ? [`- Pipeline provider: ${task.pipelineRun.provider}`] : []),
  ];
  return [
    "The operator pressed Report bug on a Mission Control dispatch that did not start. They are asking you to catalog this failure and report it as a Mission Control bug.",
    "",
    "## The failure",
    ...facts,
    "",
    `## Attempts that failed the same way (${group.length})`,
    ...attempts,
    "",
    "## What to do",
    "1. Catalog the failure. Read the Mission Control daemon log around each attempt - it is usually " +
      `\`${join(stateDir(), "daemon.log")}\` - and search it for the task ids above. Note the first error, ` +
      "the dispatch phase it happened in, and anything that differs between attempts. For a resident, also note which of its MCP servers failed and how. Do not change any setting or retry the launch.",
    "2. Call `report_product_issue` with type `bug`. Title it after the failure, not the task. In the details give the dispatch kind, agent, phase, the error with its specifics generalized, how many attempts failed, and the steps that reproduce it.",
    "3. The issue is PUBLIC. Leave out task intents, titles of private work, resident profile instructions, repository names and paths, user names, home directories, MCP server URLs, tokens and other secrets, and conversation text. Replace each with a neutral description such as `<repository>` or `<MCP server>`.",
    "4. The tool shows the operator the exact public text and waits for them to submit or dismiss it. Report what they chose, and stop.",
  ].join("\n");
}
