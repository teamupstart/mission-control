import { basename } from "node:path";
import { SHAPING_LIMITS, type ShapingConfig, type TaskShaping } from "@shared/shaping.ts";
import { taskHasRepository } from "@shared/task.ts";
import type { SessionRuntime, Task } from "@shared/types.ts";
import { featureEnabled } from "../feature-flags/index.ts";
import { turnOneAllowance, type LaunchArgumentLaunch, type TurnOneDelivery } from "../turn-one-budget.ts";
import { shapeTask, type ShapeTaskInput, type ShapingRun } from "./engine.ts";
import { getShapingConfig } from "./index.ts";
import type { ShapingTraceContext } from "./transports/index.ts";

/**
 * Task shaping at dispatch: the one place a launch asks the engine for context, and the one
 * helper that puts what it returned into turn one. `Dispatcher.dispatch` calls `shapeLaunch`
 * once, after every input is collected and before `composeTurnOne` is built, and appends the
 * section with `withTaskContext` inside it, so both turn-one variants carry identical text.
 *
 * Nothing here can stop a launch. The engine never throws; a stand-in that does, or one that
 * never answers, is recorded as a degraded step and the worker starts without a section.
 */

/** Turn one with the task context section after it. An empty section changes nothing. */
export function withTaskContext(turnOne: string, section: string): string {
  return section ? `${turnOne}\n\n${section}` : turnOne;
}

export interface LaunchShapingInput {
  /** The task as provisioned: its worktrees, branches and bases are what shapers are told. */
  task: Task;
  runtime: SessionRuntime;
  /**
   * The after-work workflow's name, or null when it cannot be named. Asked only once shaping is
   * on, inside the step's failure boundary: a lookup that throws falls back to the workflow id.
   */
  workflowName: () => string | null;
  /** The trace context the session's agent is launched with, or null when it gets none. */
  trace: ShapingTraceContext | null;
  /** How this launch's turn one reaches the worker. */
  delivery: TurnOneDelivery;
  /** Every turn-one variant this launch may send, without the section, exactly as the path carries it. */
  turnOnes: readonly string[];
  /**
   * A launch argument's other arguments and environment, measured only once shaping is on, or
   * null on every other path.
   */
  launch: (() => Promise<LaunchArgumentLaunch>) | null;
  /** True while the task is still this dispatch's to launch. Polled to stop a cancelled shaping step. */
  stillDispatching: () => boolean;
  /** Raised while the engine runs, for the pending tile's "Shaping context". */
  onShaping: (active: boolean) => void;
  /**
   * A last check of the composed turn against its delivery path, after the engine answered: the
   * reason the section cannot be carried, or null when it fits. A section that does not fit is
   * dropped, and the record says why. Supplied where a path's limit depends on the exact text,
   * such as a pane paste that travels as an `osascript` argument.
   */
  finalCheck?: (section: string) => Promise<string | null>;
}

export interface LaunchShaping {
  /** This launch's own record, unstamped: the dispatcher names the session at commit. Null when no shaper applied. */
  summary: TaskShaping | null;
  /** The section for turn one, empty when nothing was kept. */
  section: string;
}

export interface LaunchShapingDeps {
  shapeTask?: typeof shapeTask;
  /** Overrides the `task-shaping` flag, for tests. */
  enabled?: boolean;
}

const EMPTY: LaunchShaping = Object.freeze({ summary: null, section: "" });
/** How often a running shaping step checks that its task was not cancelled underneath it. */
const CANCEL_POLL_MS = 200;
/** Past the step's own deadline, how long a call that never settles is waited for. */
const BACKSTOP_GRACE_MS = 2000;

/** The engine's input, from everything dispatch collected (constraint C2). */
export function shapingInputFor(
  input: Pick<LaunchShapingInput, "task" | "runtime" | "trace"> & { workflowName: string | null },
): ShapeTaskInput {
  const { task } = input;
  // Named as the dry run names them: the repository's own directory, not the worktree's.
  const repositories: ShapeTaskInput["context"]["repositories"] = taskHasRepository(task)
    ? [
        { name: basename(task.repoRoot), role: "primary", branch: task.branch, baseSha: task.baseSha, path: task.worktreePath },
        ...task.extraRepos.map((entry) => ({
          name: basename(entry.repoRoot), role: "additional" as const, branch: entry.branch, baseSha: entry.baseSha,
          path: entry.worktreePath,
        })),
      ]
    : [];
  return {
    task: task.intent,
    context: {
      taskId: task.id,
      title: task.title,
      kind: task.kind,
      harness: task.agent,
      runtime: input.runtime,
      afterWork: task.workflowId ? { workflowId: task.workflowId, name: input.workflowName ?? task.workflowId } : null,
      labels: [...task.labels],
      priority: task.priority,
      repositories,
    },
    trace: input.trace,
    // Both call sites shape a conversation's first turn: a dispatch's launch, or the turn a
    // handover types after its reset. A resident's wake turn is an `iteration` and never
    // reaches either of them.
    turn: "launch",
  };
}

/** The record of a step that never produced the engine's own: a stand-in threw or never answered. */
function stepRecord(outcome: "failed" | "timed_out", reason: string, at: number, durationMs: number): TaskShaping {
  return {
    state: "degraded",
    at,
    durationMs,
    entries: 0,
    bytes: 0,
    truncated: false,
    shapers: [{
      id: "shaping-step", label: "Shaping step", stage: "shaping", origin: "registered", sha256: null,
      outcome, reason: reason.replace(/\s+/g, " ").trim().slice(0, SHAPING_LIMITS.reasonChars), durationMs,
      entries: 0, bytes: 0, truncated: false, redacted: false, version: null,
    }],
  };
}

/** The after-work workflow's name, or null: a lookup that fails is the same as no name. */
function workflowNameOf(lookup: () => string | null): string | null {
  try {
    return lookup();
  } catch (error) {
    console.warn("[shaping] could not read the after-work workflow's name; shapers get its id:", error);
    return null;
  }
}

/**
 * Shape one launch. Resolves to no summary and no section with the flag off, so that launch is
 * byte-identical to one from before shaping existed. Never rejects: everything from reading the
 * flag and the config to the engine's answer sits inside one failure boundary, so a launch or a
 * handover always goes on, with the unshaped prompt when the step cannot run.
 */
export async function shapeLaunch(input: LaunchShapingInput, deps: LaunchShapingDeps = {}): Promise<LaunchShaping> {
  const startedAt = Date.now();
  const started = performance.now();
  let config: ShapingConfig;
  try {
    if (!(deps.enabled ?? featureEnabled("task-shaping"))) return EMPTY;
    // One snapshot for the whole run: the budget, the backstop and the engine all read this one,
    // so a settings change during the launch measurement cannot split them.
    config = getShapingConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[shaping] the shaping step could not start; launching without its context:", message);
    return { summary: stepRecord("failed", `The shaping step could not start: ${message}`, startedAt, Math.round(performance.now() - started)), section: "" };
  }
  const cancel = new AbortController();
  let poll: ReturnType<typeof setInterval> | undefined;
  let backstop: ReturnType<typeof setTimeout> | undefined;
  let marked = false;
  try {
    // Budgeted against the larger variant, so whichever one is sent fits its path.
    const largest = input.turnOnes.reduce((a, b) => (Buffer.byteLength(b) > Buffer.byteLength(a) ? b : a), "");
    // A measurement that cannot be taken never stops the launch it was measuring: the budget then
    // withholds the section (`turnOneAllowance`), and the record says why.
    const launch = input.launch ? await input.launch().catch((error: unknown) => {
      console.warn("[shaping] could not measure the launch's arguments and environment:", error);
      return null;
    }) : null;
    const allowance = turnOneAllowance(input.delivery, largest, launch);
    const engineInput = {
      ...shapingInputFor({ ...input, workflowName: workflowNameOf(input.workflowName) }),
      signal: cancel.signal,
      ...(allowance ? { maxSectionBytes: allowance.maxSectionBytes } : {}),
    };
    poll = setInterval(() => { if (!input.stillDispatching()) cancel.abort(); }, CANCEL_POLL_MS);
    input.onShaping(true);
    marked = true;
    const run = await Promise.race([
      (deps.shapeTask ?? shapeTask)(engineInput, { config, enabled: true }),
      new Promise<"backstop">((resolve) => {
        backstop = setTimeout(() => resolve("backstop"), config.limits.deadlineMs + BACKSTOP_GRACE_MS);
      }),
    ]).catch((error: unknown) => ({ error }));
    const durationMs = Math.round(performance.now() - started);
    if (run === "backstop") {
      return { summary: stepRecord("timed_out", `The shaping step did not finish within ${Math.round(config.limits.deadlineMs / 100) / 10} s.`, startedAt, durationMs), section: "" };
    }
    if ("error" in run) {
      const message = run.error instanceof Error ? run.error.message : String(run.error);
      console.warn("[shaping] the shaping step failed; launching without its context:", message);
      return { summary: stepRecord("failed", `The shaping step failed: ${message}`, startedAt, durationMs), section: "" };
    }
    const shaped = recordLimit(run, allowance, config.limits.totalBytes);
    const unfit = shaped.section && input.finalCheck ? await input.finalCheck(shaped.section) : null;
    if (!unfit || !shaped.summary) return shaped;
    // Nothing reached turn one, so nothing is counted as delivered: each shaper keeps its
    // outcome, and an answer that had entries reads as truncated, as the record does.
    return {
      summary: {
        ...shaped.summary,
        entries: 0,
        bytes: 0,
        truncated: true,
        limit: { bytes: 0, reason: unfit.slice(0, SHAPING_LIMITS.reasonChars) },
        shapers: shaped.summary.shapers.map((shaper) =>
          shaper.entries || shaper.bytes ? { ...shaper, entries: 0, bytes: 0, truncated: true } : shaper),
      },
      section: "",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[shaping] the shaping step failed; launching without its context:", message);
    return { summary: stepRecord("failed", `The shaping step failed: ${message}`, startedAt, Math.round(performance.now() - started)), section: "" };
  } finally {
    clearInterval(poll);
    clearTimeout(backstop);
    // A run the backstop abandoned is told to stop, so its calls release what they hold. A run
    // that settled has already detached from the signal, and this changes nothing for it.
    cancel.abort();
    if (marked) input.onShaping(false);
  }
}

/** Note on the record that this launch's path, not the configured total, set the section's room. */
function recordLimit(run: ShapingRun, allowance: ReturnType<typeof turnOneAllowance>, totalBytes: number): LaunchShaping {
  if (!run.summary || !allowance || allowance.maxSectionBytes >= totalBytes) return { summary: run.summary, section: run.section };
  return {
    summary: { ...run.summary, limit: { bytes: allowance.maxSectionBytes, reason: allowance.reason.slice(0, SHAPING_LIMITS.reasonChars) } },
    section: run.section,
  };
}
