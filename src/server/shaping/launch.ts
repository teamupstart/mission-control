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
/** The record's reason when the final check of a shaped turn one did not answer in time. */
const FINAL_CHECK_TIMED_OUT = "the final check of turn one against its delivery path did not finish in time";

/** `work`, or `fallback` once `ms` pass first. The timer never outlives the race. */
async function settleWithin<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

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
    // One deadline for the whole step - measurement, engine and final check - taken from its start,
    // so no phase that stalls can hold the launch: each falls back to the original turn one.
    const stepEnds = started + config.limits.deadlineMs + BACKSTOP_GRACE_MS;
    const remaining = () => Math.max(0, stepEnds - performance.now());
    // A measurement that cannot be taken, or does not finish in time, never stops the launch it was
    // measuring: the budget then withholds the section (`turnOneAllowance`), and the record says why.
    const launch = input.launch
      ? await settleWithin(input.launch(), remaining(), null).catch((error: unknown) => {
        console.warn("[shaping] could not measure the launch's arguments and environment:", error);
        return null;
      })
      : null;
    // Asked again now, synchronously, before any shaper is started: a cancel or a replacement
    // that landed during the measurement must not run a single shaper for this launch.
    if (!input.stillDispatching()) return EMPTY;
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
        backstop = setTimeout(() => resolve("backstop"), remaining());
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
    // Its own short bound past the step's deadline, so an engine that answered just in time still
    // gets its check, and a check that never settles drops the section rather than hold the launch.
    // A check that answers "does not fit" is a size limit, recorded as truncation like any other cut.
    // One that throws or never answers is a failure of the step, recorded as degraded.
    let checkFailed = false;
    const unfit = shaped.section && input.finalCheck
      ? await settleWithin(input.finalCheck(shaped.section), remaining() + BACKSTOP_GRACE_MS, FINAL_CHECK_TIMED_OUT)
        .then((reason) => { if (reason === FINAL_CHECK_TIMED_OUT) checkFailed = true; return reason; })
        .catch((error: unknown) => {
          checkFailed = true;
          return `the final check of turn one failed (${error instanceof Error ? error.message : String(error)})`;
        })
      : null;
    if (!unfit || !shaped.summary) return shaped;
    return { summary: withoutDeliveredSection(shaped.summary, unfit, checkFailed ? "degraded" : shaped.summary.state), section: "" };
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
/**
 * A record for a launch whose section did not reach turn one after all. Nothing is counted as
 * delivered: each shaper keeps its outcome, and an answer that had entries reads as truncated,
 * as the record does. `state` is the record's own unless the caller says otherwise.
 */
function withoutDeliveredSection(summary: TaskShaping, reason: string, state: TaskShaping["state"] = summary.state): TaskShaping {
  return {
    ...summary,
    state,
    entries: 0,
    bytes: 0,
    truncated: true,
    limit: { bytes: 0, reason: reason.slice(0, SHAPING_LIMITS.reasonChars) },
    shapers: summary.shapers.map((shaper) =>
      shaper.entries || shaper.bytes ? { ...shaper, entries: 0, bytes: 0, truncated: true } : shaper),
  };
}

/** Why a launch wrapper ran the original turn one: see `fittingLaunch` in `agent-subprocess-env.ts`. */
export const TURN_ONE_FALLBACK_REASON =
  "the terminal's environment left too little room under this platform's argument limit for the context, and the agent launched with its original prompt";

/**
 * The record for a launch whose wrapper fell back to the original turn one at exec. Unlike a cut
 * the daemon made before the launch, this is recorded as degraded: the daemon offered a section
 * the terminal could not carry, which says something is wrong with that terminal's environment.
 */
export function launchFellBack(shaping: LaunchShaping): LaunchShaping {
  if (!shaping.summary) return { summary: null, section: "" };
  return { summary: withoutDeliveredSection(shaping.summary, TURN_ONE_FALLBACK_REASON, "degraded"), section: "" };
}

/** Why a handover sent its original prompt: its checkout could not be read again before delivery. */
export const CHECKOUT_UNVERIFIED_REASON =
  "the checkout could not be read before or after shaping, so the original prompt was sent without the context";

/**
 * The record for a handover that dropped its section because the checkout the context was chosen
 * for could not be confirmed unchanged. Degraded, nothing counted as delivered, the reason kept.
 */
export function deliveredWithoutContext(shaping: LaunchShaping, reason: string): LaunchShaping {
  if (!shaping.summary) return { summary: null, section: "" };
  return { summary: withoutDeliveredSection(shaping.summary, reason, "degraded"), section: "" };
}

/** Why a launch whose wrapper left no readable receipt is not recorded as delivered. */
export const TURN_ONE_UNCONFIRMED_REASON =
  "the launch could not confirm which turn one the agent received, so the context is not counted as delivered";

/**
 * The record for a launch whose wrapper had a fallback but left no readable receipt: the agent may
 * hold either turn one. Neither is claimed - nothing is counted as delivered, the record is
 * degraded and says it is unconfirmed, and no delivered text is kept.
 */
export function launchUnconfirmed(shaping: LaunchShaping): LaunchShaping {
  if (!shaping.summary) return { summary: null, section: "" };
  return { summary: withoutDeliveredSection(shaping.summary, TURN_ONE_UNCONFIRMED_REASON, "degraded"), section: "" };
}

function recordLimit(run: ShapingRun, allowance: ReturnType<typeof turnOneAllowance>, totalBytes: number): LaunchShaping {
  if (!run.summary || !allowance || allowance.maxSectionBytes >= totalBytes) return { summary: run.summary, section: run.section };
  return {
    summary: { ...run.summary, limit: { bytes: allowance.maxSectionBytes, reason: allowance.reason.slice(0, SHAPING_LIMITS.reasonChars) } },
    section: run.section,
  };
}
