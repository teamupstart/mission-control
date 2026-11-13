import type { SubagentEntry, SubagentState, SubagentSummary } from "@shared/types.ts";
import { SUBAGENT_LIMIT } from "@shared/subagents.ts";
import type { ClaudeSdkMessage } from "./sdk-types.ts";

// Claude Agent SDK background sub-agents, reduced from the CLI's `task_*` system frames into
// the harness-neutral `SubagentSummary` the registry holds.
//
// Pure: every function takes a state and returns a state, and returns the SAME object when a
// frame changed nothing, so the driver can tell a no-op from a change by identity.
//
// ## Who decides membership
//
// `background_tasks_changed` is a LEVEL signal - the full set of live background tasks,
// replace semantics, reset whenever the CLI process starts. When a CLI sends it, it decides
// which tasks are running in the background; a counted agent that leaves the set without
// having reported an end was stopped. The `task_*` frames are EDGES that add detail: type,
// description, counters, last tool, summary and how it ended. A CLI that predates the level
// signal is read from the edges alone, filtered by `is_backgrounded`.
//
// ## What counts
//
// Only `local_agent` tasks: the same frames also describe shells, MCP tasks, monitors and
// workflows. A task flagged `ambient` is housekeeping and never counts, nor does a
// backgrounded main session. A foreground agent blocks the parent's turn, so the parent
// already reads as working; it starts counting only if it is moved to the background.

interface Tracked {
  entry: SubagentEntry;
  /** Registered in the background, or moved there later. */
  background: boolean;
  ambient: boolean;
  /**
   * Has counted as a background agent. Once ended it stays listed until the next turn folds
   * it, or until the cap folds it sooner to make room (see `bounded`).
   */
  shown: boolean;
  /** The run this entry describes, when the CLI names runs. A resumed task gets a new one. */
  runId: string | null;
}

export interface ClaudeSubagentState {
  /** True once this CLI process has sent a `background_tasks_changed` frame. */
  readonly levelSeen: boolean;
  readonly tasks: ReadonlyMap<string, Tracked>;
  readonly finishedFolded: number;
  /**
   * Ended agents no longer tracked - folded by a turn, pushed past the cap, or a foreground
   * agent that never counted - each with the run it ended in. A finishing task leaves the live
   * set only AFTER its notification, so a fold in that gap would otherwise let the next
   * live-set frame bring a finished agent back as running.
   *
   * Held only while the CLI sends the live set (without it there is no stale membership to
   * guard against), and every live-set frame drops the ids it no longer names. So an id is
   * guarded for exactly as long as the live set still lists it, never evicted early, and the
   * map is never larger than the live set plus what ended since its last frame.
   */
  readonly retired: ReadonlyMap<string, string | null>;
  /**
   * Every agent the last `background_tasks_changed` named, ambient ones included. The live set is the
   * authority on who is running: once it has been seen, an edge frame (a start, or a move to the
   * background) may only count an agent the set currently names. A delayed or repeated start
   * for an agent the set has already dropped is late, and cannot bring it back.
   */
  readonly live: ReadonlySet<string>;
}

export function emptyClaudeSubagents(): ClaudeSubagentState {
  return { levelSeen: false, tasks: new Map(), finishedFolded: 0, retired: new Map(), live: new Set() };
}

function withRetired(
  state: Pick<ClaudeSubagentState, "levelSeen" | "retired">,
  gone: Iterable<Tracked>,
): ReadonlyMap<string, string | null> {
  if (!state.levelSeen) return state.retired;
  const next = new Map(state.retired);
  for (const t of gone) next.set(t.entry.id, t.runId);
  return next;
}

/**
 * Whether `incoming` names a later run than `known`. Run ids of one task sort, by plain string
 * comparison, in the order the runs opened; without both there is no ordering to read.
 */
function laterRun(incoming: string | null, known: string | null): boolean {
  return incoming !== null && known !== null && incoming > known;
}

/**
 * The tracked entry a frame about `runId` may build on: one still running in that same run.
 * Anything else - an ended run, or a running one the frame names a later run of - is replaced
 * by a fresh entry, so a resumed run never inherits its predecessor's clock or counters.
 */
function continuing(known: Tracked | undefined, runId: string | null): Tracked | undefined {
  if (!known || known.entry.state !== "running" || laterRun(runId, known.runId)) return undefined;
  return known;
}

/**
 * Whether a live-set entry for an agent that already ended is a new run of it. Run ids decide
 * when both sides carry one. Without them the live set's own history does: a finishing task
 * leaves the set only after its end is reported, so an ended agent the previous set still named
 * is a late listing, while one the set had dropped and now names again has rejoined.
 */
function newRun(incoming: string | null, known: string | null, wasLive: boolean): boolean {
  if (incoming !== null && known !== null) return incoming > known;
  return !wasLive;
}

/** Whether `incoming` names the same run as `known`, or an earlier one. */
function sameOrEarlierRun(incoming: string | null, known: string | null): boolean {
  return incoming !== null && known !== null && incoming <= known;
}

/** Whether `incoming` names a run strictly before `known`: a late frame from an old run. */
function earlierRun(incoming: string | null, known: string | null): boolean {
  return incoming !== null && known !== null && incoming < known;
}

const SUBTYPES = new Set([
  "task_started",
  "task_progress",
  "task_updated",
  "task_notification",
  "background_tasks_changed",
]);

/** Whether a frame is one of the task frames this reducer reads. */
export function isClaudeSubagentFrame(message: ClaudeSdkMessage): boolean {
  return message.type === "system" && typeof message.subtype === "string" && SUBTYPES.has(message.subtype);
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** A backgrounded main session is a task too, and is not a sub-agent. */
const MAIN_SESSION = "main-session";

function isAgentTask(taskType: unknown, subagentType: unknown): boolean {
  if (subagentType === MAIN_SESSION) return false;
  if (taskType === "local_agent") return true;
  // `task_type` is optional on `task_started`; a Task-tool sub-agent still names its type.
  return taskType === undefined && typeof subagentType === "string";
}

function ended(status: unknown): SubagentState | null {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "stopped":
    case "killed":
      return "stopped";
    default:
      return null;
  }
}

function freshEntry(id: string, now: number): SubagentEntry {
  return {
    id,
    type: null,
    description: null,
    state: "running",
    startedAt: now,
    endedAt: null,
    toolUses: null,
    tokens: null,
    lastTool: null,
    summary: null,
    launchTurnId: null,
  };
}

/** Apply one task frame. Returns `state` itself when the frame changed nothing. */
export function observeClaudeSubagentFrame(
  state: ClaudeSubagentState,
  message: ClaudeSdkMessage,
  now: number,
): ClaudeSubagentState {
  if (!isClaudeSubagentFrame(message)) return state;
  const tasks = new Map(state.tasks);
  let levelSeen = state.levelSeen;
  let retired = state.retired;
  let liveNow = state.live;
  const put = (id: string, next: Tracked): void => {
    tasks.set(id, next);
  };
  const unretire = (id: string): void => {
    const next = new Map(retired);
    next.delete(id);
    retired = next;
  };
  const runId = str(message.run_id);

  switch (message.subtype) {
    case "task_started": {
      const id = str(message.task_id);
      if (!id || !isAgentTask(message.task_type, message.subagent_type)) return state;
      // A start for a run already seen (a repeat, or a late frame) changes nothing. Any other
      // start of an ended id is a real one - a resumed agent keeps its task id - and is the one
      // thing that brings it back.
      // With a live set to answer to, only an agent it currently names may count or come back.
      const listedNow = !levelSeen || state.live.has(id);
      if (retired.has(id)) {
        if (sameOrEarlierRun(runId, retired.get(id) ?? null) || !listedNow) return state;
        unretire(id);
      }
      const known = tasks.get(id);
      if (known && known.entry.state !== "running") {
        if (sameOrEarlierRun(runId, known.runId) || !listedNow) return state;
      }
      // A start from a run before the one tracked is late, running or not: taking it would
      // roll the entry back to that run, and the old run's own end would then end this one.
      if (known && earlierRun(runId, known.runId)) return state;
      // A resumed run is a new run: its predecessor's state, clock and counters go, whether that
      // run had ended or is still tracked as running.
      const prior = continuing(known, runId);
      const entry: SubagentEntry = {
        ...(prior?.entry ?? freshEntry(id, now)),
        type: str(message.subagent_type) ?? prior?.entry.type ?? null,
        description: str(message.description) ?? prior?.entry.description ?? null,
        launchTurnId: str(message.tool_use_id) ?? prior?.entry.launchTurnId ?? null,
      };
      const background = (prior?.background ?? false) || message.is_backgrounded === true;
      put(id, {
        entry,
        background,
        ambient: (prior?.ambient ?? false) || message.ambient === true,
        // A start that beats the agent into the live set records its detail hidden; the live-set
        // frame that names it is what shows it.
        shown: (prior?.shown ?? false) || (background && listedNow),
        runId: runId ?? prior?.runId ?? null,
      });
      break;
    }
    case "background_tasks_changed": {
      levelSeen = true;
      const live = new Set<string>();
      const ambientIds = new Set<string>();
      const listed = new Set<string>();
      for (const raw of Array.isArray(message.tasks) ? message.tasks : []) {
        const t = record(raw);
        const id = str(t?.task_id);
        if (!t || !id || !isAgentTask(t.task_type, t.subagent_type)) continue;
        listed.add(id);
        const entryRun = str(t.run_id);
        // Already ended and no longer tracked: this level is late, not a new start - unless it
        // names a later run, which is the agent resumed (a run joins the set before its start).
        if (retired.has(id)) {
          if (!newRun(entryRun, retired.get(id) ?? null, state.live.has(id))) continue;
          unretire(id);
        }
        if (t.ambient === true) {
          ambientIds.add(id);
          continue;
        }
        live.add(id);
        const known = tasks.get(id);
        // A late level that still lists an agent which already reported its end does not
        // revive it: a finishing task leaves the set after its notification.
        const rejoined = known !== undefined && known.entry.state !== "running" &&
          newRun(entryRun, known.runId, state.live.has(id));
        if (known && known.entry.state !== "running" && !rejoined) continue;
        // A level about an older run than the one tracked is late; it neither updates nor stops.
        if (known && earlierRun(entryRun, known.runId)) continue;
        // A later run starts clean, even if the run it replaces is still tracked as running.
        const prior = rejoined ? undefined : continuing(known, entryRun);
        const base = prior?.entry ?? freshEntry(id, now);
        put(id, {
          entry: {
            ...base,
            type: base.type ?? str(t.subagent_type),
            description: base.description ?? str(t.description),
          },
          background: true,
          ambient: false,
          shown: true,
          runId: entryRun ?? prior?.runId ?? null,
        });
      }
      for (const [id, t] of tasks) {
        if (ambientIds.has(id)) {
          put(id, { ...t, ambient: true });
        } else if (t.shown && t.entry.state === "running" && !live.has(id)) {
          // Left the live set without reporting an end: it was stopped.
          put(id, { ...t, entry: { ...t.entry, state: "stopped", endedAt: now } });
        } else if (!t.shown && t.background && !listed.has(id)) {
          // A background start the set never took up was a late one for an agent already gone:
          // an early start is always followed by a set that names it. Foreground agents stay
          // tracked, since one may still be moved to the background.
          tasks.delete(id);
        }
      }
      // A retired id the live set no longer lists has nothing left to be revived by.
      if ([...retired.keys()].some((id) => !listed.has(id))) {
        retired = new Map([...retired].filter(([id]) => listed.has(id)));
      }
      liveNow = listed;
      break;
    }
    case "task_progress": {
      const id = str(message.task_id);
      const prior = id ? tasks.get(id) : undefined;
      if (!id || !prior || earlierRun(runId, prior.runId)) return state;
      const usage = record(message.usage);
      put(id, {
        ...prior,
        entry: {
          ...prior.entry,
          type: prior.entry.type ?? str(message.subagent_type),
          description: str(message.description) ?? prior.entry.description,
          toolUses: num(usage?.tool_uses) ?? prior.entry.toolUses,
          tokens: num(usage?.total_tokens) ?? prior.entry.tokens,
          lastTool: str(message.last_tool_name) ?? prior.entry.lastTool,
          summary: str(message.summary) ?? prior.entry.summary,
        },
      });
      break;
    }
    case "task_updated": {
      const id = str(message.task_id);
      const prior = id ? tasks.get(id) : undefined;
      const patch = record(message.patch);
      if (!id || !prior || !patch || earlierRun(runId, prior.runId)) return state;
      const end = ended(patch.status);
      const background = prior.background || patch.is_backgrounded === true;
      const running = prior.entry.state === "running";
      put(id, {
        ...prior,
        background,
        // Moved to the background while still running: it starts counting now - once the live
        // set, when there is one, names it too.
        shown: prior.shown || (background && running && (!levelSeen || state.live.has(id))),
        entry: {
          ...prior.entry,
          description: str(patch.description) ?? prior.entry.description,
          ...(end && running ? { state: end, endedAt: num(patch.end_time) ?? now } : {}),
        },
      });
      break;
    }
    case "task_notification": {
      const id = str(message.task_id);
      const prior = id ? tasks.get(id) : undefined;
      if (!id || !prior || earlierRun(runId, prior.runId)) return state;
      const end = ended(message.status);
      const usage = record(message.usage);
      const running = prior.entry.state === "running";
      put(id, {
        ...prior,
        ambient: prior.ambient || message.ambient === true,
        entry: {
          ...prior.entry,
          ...(end && running ? { state: end, endedAt: now } : {}),
          toolUses: num(usage?.tool_uses) ?? prior.entry.toolUses,
          tokens: num(usage?.total_tokens) ?? prior.entry.tokens,
          summary: str(message.summary) ?? prior.entry.summary,
        },
      });
      break;
    }
  }

  // An ended agent nobody sees - a foreground one that never counted, or an ambient one - has
  // nothing left to say. Ambient entries are never drawn, capped or counted in a fold, so
  // keeping them until the next turn would only let them pile up.
  const forgotten: Tracked[] = [];
  for (const [id, t] of tasks) {
    if (!visible(t) && t.entry.state !== "running") {
      tasks.delete(id);
      forgotten.push(t);
    }
  }
  if (forgotten.length > 0) retired = withRetired({ levelSeen, retired }, forgotten);
  return bounded({ levelSeen, tasks, finishedFolded: state.finishedFolded, retired, live: liveNow }, state);
}

/**
 * The operator's next turn: every finished agent folds into the "N finished" count. With
 * nothing left running, the count goes too, so a session whose agents are all done and
 * acknowledged looks exactly as it did before it launched any.
 */
export function foldClaudeSubagents(state: ClaudeSubagentState): ClaudeSubagentState {
  const tasks = new Map(state.tasks);
  let folded = state.finishedFolded;
  const gone: Tracked[] = [];
  for (const [id, t] of tasks) {
    if (t.shown && t.entry.state !== "running") {
      tasks.delete(id);
      gone.push(t);
      if (!t.ambient) folded += 1;
    }
  }
  const stillRunning = [...tasks.values()].some((t) => visible(t) && t.entry.state === "running");
  const finishedFolded = stillRunning ? folded : 0;
  if (tasks.size === state.tasks.size && finishedFolded === state.finishedFolded) return state;
  return {
    levelSeen: state.levelSeen,
    live: state.live,
    tasks,
    finishedFolded,
    retired: gone.length > 0 ? withRetired(state, gone) : state.retired,
  };
}

const visible = (t: Tracked): boolean => t.shown && !t.ambient;

/** Running first by start, then the newest finished. */
function order(a: SubagentEntry, b: SubagentEntry): number {
  const ar = a.state === "running";
  const br = b.state === "running";
  if (ar !== br) return ar ? -1 : 1;
  if (ar) return a.startedAt - b.startedAt;
  return (b.endedAt ?? 0) - (a.endedAt ?? 0);
}

/** Keep the finished tail inside the cap by folding its oldest members. */
function bounded(next: ClaudeSubagentState, prior: ClaudeSubagentState): ClaudeSubagentState {
  const finished = [...next.tasks.values()]
    .filter((t) => visible(t) && t.entry.state !== "running")
    .map((t) => t.entry)
    .sort(order);
  const running = [...next.tasks.values()].filter((t) => visible(t) && t.entry.state === "running").length;
  const room = Math.max(0, SUBAGENT_LIMIT - running);
  let finishedFolded = next.finishedFolded;
  if (finished.length > room) {
    const tasks = new Map(next.tasks);
    const capped = finished.slice(room).flatMap((entry) => {
      const t = tasks.get(entry.id);
      return t ? [t] : [];
    });
    for (const t of capped) {
      tasks.delete(t.entry.id);
      finishedFolded += 1;
    }
    next = { ...next, tasks, finishedFolded, retired: withRetired(next, capped) };
  }
  return sameState(next, prior) ? prior : next;
}

function sameState(a: ClaudeSubagentState, b: ClaudeSubagentState): boolean {
  if (a.levelSeen !== b.levelSeen || a.finishedFolded !== b.finishedFolded) return false;
  if (a.live.size !== b.live.size || [...a.live].some((id) => !b.live.has(id))) return false;
  if (a.retired.size !== b.retired.size) return false;
  for (const [id, run] of a.retired) {
    if (!b.retired.has(id) || b.retired.get(id) !== run) return false;
  }
  if (a.tasks.size !== b.tasks.size) return false;
  for (const [id, t] of a.tasks) {
    const o = b.tasks.get(id);
    if (!o || JSON.stringify(o) !== JSON.stringify(t)) return false;
  }
  return true;
}

/** The registry's view: null when there is nothing to show. */
export function claudeSubagentSummary(state: ClaudeSubagentState): SubagentSummary | null {
  const agents = [...state.tasks.values()]
    .filter(visible)
    .map((t) => t.entry)
    .sort(order)
    .slice(0, SUBAGENT_LIMIT);
  if (agents.length === 0 && state.finishedFolded === 0) return null;
  return { agents, finishedFolded: state.finishedFolded };
}
