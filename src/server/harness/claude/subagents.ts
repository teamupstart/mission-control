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
  /** Earlier runs of this task already seen, so a late frame from one is recognised as late. */
  pastRuns: readonly string[];
}

/**
 * What is known about a task's runs: the current one and those seen before it.
 *
 * Runs are told apart by IDENTITY, never by how their ids sort. A run id is an opaque string
 * (`r10` sorts before `r9` as text), so the only safe readings are "this is the run I am
 * showing", "this is a run I have already seen" (a late frame) and "this is a run I have not
 * seen" (a new one). A CLI writes one ordered stream, so a run's frames cannot first reach the
 * reader after a later run's.
 */
type RunMemory = Pick<Tracked, "runId" | "pastRuns">;

/** The run memory of a task with no tracked entry or retired guard: its recorded history. */
function remembered(history: ReadonlyMap<string, readonly string[]>, id: string): RunMemory {
  return { runId: null, pastRuns: history.get(id) ?? [] };
}

/** `history` with the runs of the given tasks added. Returns `history` itself when none are new. */
function remember(
  history: ReadonlyMap<string, readonly string[]>,
  gone: Iterable<[string, RunMemory]>,
): ReadonlyMap<string, readonly string[]> {
  let next: Map<string, readonly string[]> | null = null;
  for (const [id, mem] of gone) {
    const runs = mem.runId !== null ? [...mem.pastRuns, mem.runId] : mem.pastRuns;
    const known = (next ?? history).get(id) ?? [];
    const added = runs.filter((r, i) => !known.includes(r) && runs.indexOf(r) === i);
    if (added.length === 0) continue;
    next ??= new Map(history);
    next.set(id, [...known, ...added]);
  }
  return next ?? history;
}

export interface ClaudeSubagentState {
  /** True once this CLI process has sent a `background_tasks_changed` frame. */
  readonly levelSeen: boolean;
  readonly tasks: ReadonlyMap<string, Tracked>;
  readonly finishedFolded: number;
  /**
   * Ended agents no longer tracked - folded by a turn, or pushed past the cap - that the live
   * set still names, each with its run memory. A finishing task leaves the live set only AFTER
   * its notification, so a fold in that gap would otherwise let the next live-set frame bring
   * a finished agent back as running.
   *
   * Only an agent the current live set names is retired: one it does not name (a foreground
   * agent, say) has no stale membership to guard against, and a later start for it is already
   * refused by `live`. Every live-set frame drops the ids it no longer names. So an id is
   * guarded for exactly as long as the live set lists it, never evicted early, and the map is
   * never larger than the live set.
   */
  readonly retired: ReadonlyMap<string, RunMemory>;
  /**
   * Every agent the last `background_tasks_changed` named, ambient ones included. The live set is the
   * authority on who is running: once it has been seen, an edge frame (a start, or a move to the
   * background) may only count an agent the set currently names. A delayed or repeated start
   * for an agent the set has already dropped is late, and cannot bring it back.
   *
   * Keyed by agent, with the run id the set lists for it (null when it names none). A start
   * naming a different run than the one the set lists is refused: the set is what establishes
   * a run, so the start of a run it does not list is a late or stray frame.
   */
  readonly live: ReadonlyMap<string, string | null>;
  /**
   * Every run id seen for a task this process no longer tracks or guards, so that a task id
   * rejoining under a new run - whether or not the live set names that run - still recognises
   * a late frame from any run before it. Read only when a task has neither a tracked entry nor
   * a retired guard; it never decides what is shown.
   *
   * Kept for the life of the CLI process (a relaunch starts empty): one short list per task
   * that reported run ids. State equality compares the map by reference. A frame reads only its
   * own task's list - a map lookup, then a search of that list for the incoming run id - so the
   * cost per frame does not grow with the number of tasks remembered.
   */
  readonly runHistory: ReadonlyMap<string, readonly string[]>;
}

export function emptyClaudeSubagents(): ClaudeSubagentState {
  return { levelSeen: false, tasks: new Map(), finishedFolded: 0, retired: new Map(), live: new Map(), runHistory: new Map() };
}

function withRetired(
  state: Pick<ClaudeSubagentState, "levelSeen" | "retired" | "live">,
  gone: Iterable<Tracked>,
): ReadonlyMap<string, RunMemory> {
  if (!state.levelSeen) return state.retired;
  const named = [...gone].filter((t) => state.live.has(t.entry.id));
  if (named.length === 0) return state.retired;
  const next = new Map(state.retired);
  for (const t of named) next.set(t.entry.id, { runId: t.runId, pastRuns: t.pastRuns });
  return next;
}

/**
 * Whether `incoming` names a later run than the one `known` describes: a run id that is not the
 * current one and has never been seen. Without both ids there is nothing to compare.
 */
function laterRun(incoming: string | null, known: RunMemory): boolean {
  return incoming !== null && known.runId !== null && incoming !== known.runId &&
    !known.pastRuns.includes(incoming);
}

/**
 * The run memory after a frame about `incoming`. A `fresh` entry starts a new run, so the run
 * it replaces moves into the history even when the new one carries no id.
 */
function advance(known: RunMemory, incoming: string | null, fresh: boolean): RunMemory {
  const runId = fresh ? incoming : incoming ?? known.runId;
  if (runId === known.runId) return { runId, pastRuns: known.pastRuns };
  const pastRuns = known.runId !== null && !known.pastRuns.includes(known.runId)
    ? [...known.pastRuns, known.runId]
    : known.pastRuns;
  // Unbounded on purpose: forgetting a run is exactly what would let its late frame pass for a
  // new one. The list grows by one id per resume of this one task. When the task is folded or
  // otherwise dropped, its runs move to `runHistory` rather than being lost: a later run of the
  // same task id may still rejoin and is tracked afresh, while frames naming any of the old
  // runs stay late.
  return { runId, pastRuns };
}

/**
 * The tracked entry a frame about `runId` may build on: one still running in that same run.
 * Anything else - an ended run, or a running one the frame names a later run of - is replaced
 * by a fresh entry, so a resumed run never inherits its predecessor's clock or counters.
 */
function continuing(known: Tracked | undefined, runId: string | null): Tracked | undefined {
  if (!known || known.entry.state !== "running" || laterRun(runId, known)) return undefined;
  return known;
}

/**
 * Whether a live-set entry for an agent that already ended is a new run of it. Run ids decide
 * when both sides carry one. Without them the live set's own history does: a finishing task
 * leaves the set only after its end is reported, so an ended agent the previous set still named
 * is a late listing, while one the set had dropped and now names again has rejoined.
 */
function newRun(incoming: string | null, known: RunMemory, wasLive: boolean): boolean {
  if (incoming !== null && known.runId !== null) return laterRun(incoming, known);
  return !wasLive;
}

/**
 * Whether a progress, update or notification frame is about a run other than the one tracked.
 * Those frames never open a run - only a start or a live-set entry does - so when both sides
 * name a run and the names differ, the frame belongs to some other run and changes nothing.
 * The check compares the two ids directly rather than consulting the run history, so it holds
 * for any other run, including one never recorded. `earlierRun` covers the remaining case, a
 * current run with no id, from the task's past runs (kept across live-set gaps in
 * `runHistory`).
 */
function otherRun(incoming: string | null, known: RunMemory): boolean {
  return incoming !== null && known.runId !== null && incoming !== known.runId;
}

/** Whether `incoming` names the run `known` describes, or one already seen before it. */
function sameOrEarlierRun(incoming: string | null, known: RunMemory): boolean {
  return incoming !== null && (incoming === known.runId || known.pastRuns.includes(incoming));
}

/**
 * Whether `incoming` names a run seen before the current one: a late frame from an old run.
 * Read from the history even when the current run carries no id - a restart the live set
 * reported without one - because the runs before it still did, and their late frames must not
 * end it.
 */
function earlierRun(incoming: string | null, known: RunMemory): boolean {
  return incoming !== null && incoming !== known.runId && known.pastRuns.includes(incoming);
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
  let runHistory = state.runHistory;
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
      // With a live set to answer to, only an agent it currently names may count or come back.
      const listedNow = !levelSeen || state.live.has(id);
      // The live set establishes runs: a start for a run other than the one it lists is late.
      const listedRun = state.live.get(id) ?? null;
      if (levelSeen && runId !== null && listedRun !== null && runId !== listedRun) return state;
      // Whether this start may bring an ended agent back: it must be evidence of a new run. A
      // resumed agent keeps its task id, so the id alone proves nothing, and a repeated start
      // arrives while the live set can still name the agent it just finished. With a live set,
      // only a later run id is that evidence here; a resume without run ids is recognised when
      // the set drops the agent and names it again (see `newRun`). Without a live set there is
      // no other signal, so any start that is not for the same or an earlier run counts.
      const restarts = (known: RunMemory): boolean =>
        levelSeen ? listedNow && laterRun(runId, known) : !sameOrEarlierRun(runId, known);
      const wasRetired = retired.get(id);
      if (wasRetired) {
        if (!restarts(wasRetired)) return state;
        unretire(id);
      }
      const known = tasks.get(id);
      if (known && known.entry.state !== "running" && !restarts(known)) return state;
      // The memory this start is judged against: the tracked entry, its retired guard, or - for
      // a task neither holds any more - the runs it had before.
      const history = known ?? wasRetired ?? remembered(runHistory, id);
      // A start from a run before the one tracked is late, running or not: taking it would
      // roll the entry back to that run, and the old run's own end would then end this one.
      if (earlierRun(runId, history)) return state;
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
        // Tied to the run, like the live set's flag: a start continuing a run the set already
        // marked ambient keeps that, and a start for a new run is classified by itself alone.
        ambient: (prior?.ambient ?? false) || message.ambient === true,
        // A start that beats the agent into the live set records its detail hidden; the live-set
        // frame that names it is what shows it.
        shown: (prior?.shown ?? false) || (background && listedNow),
        ...advance(history, runId, !prior),
      });
      break;
    }
    case "background_tasks_changed": {
      levelSeen = true;
      const listed = new Map<string, string | null>();
      for (const raw of Array.isArray(message.tasks) ? message.tasks : []) {
        const t = record(raw);
        const id = str(t?.task_id);
        if (!t || !id || !isAgentTask(t.task_type, t.subagent_type)) continue;
        const entryRun = str(t.run_id);
        const wasRetired = retired.get(id);
        const known = tasks.get(id);
        // The memory this entry is judged against: the tracked entry, its retired guard, or - for
        // a task neither holds any more - the runs it had before.
        const history = known ?? wasRetired ?? remembered(runHistory, id);
        // An entry about an older run than the one tracked is late: it neither updates nor stops
        // anything, and it must not change which run the set is taken to list either - a valid
        // start for the current run would otherwise be refused against the stale one.
        if (earlierRun(entryRun, history)) {
          listed.set(id, history.runId ?? state.live.get(id) ?? null);
          continue;
        }
        listed.set(id, entryRun);
        // Whether this entry says the run is housekeeping. Absent says nothing: the run keeps the
        // classification it already has, which lives on its tracked entry beside its run memory.
        const flagged = t.ambient === true;
        // Already ended and no longer tracked: this level is late, not a new start - unless it
        // names a later run, which is the agent resumed (a run joins the set before its start).
        if (wasRetired) {
          if (!newRun(entryRun, wasRetired, state.live.has(id))) continue;
          unretire(id);
        }
        // A late level that still lists an agent which already reported its end does not
        // revive it: a finishing task leaves the set after its notification.
        const rejoined = known !== undefined && known.entry.state !== "running" &&
          newRun(entryRun, known, state.live.has(id));
        if (known && known.entry.state !== "running" && !rejoined) {
          // It may still learn that its run was housekeeping, which takes it off the list.
          if (flagged && !known.ambient && !laterRun(entryRun, known)) put(id, { ...known, ambient: true });
          continue;
        }
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
          // Tied to the run: the same run keeps what any earlier frame said (a start or a set
          // that flagged it), and a new run starts unclassified, so only this entry can flag it.
          ambient: flagged || (prior?.ambient ?? false),
          shown: true,
          ...advance(history, entryRun, !prior),
        });
      }
      for (const [id, t] of tasks) {
        if (t.shown && t.entry.state === "running" && !listed.has(id)) {
          // Left the live set without reporting an end: it was stopped.
          put(id, { ...t, entry: { ...t.entry, state: "stopped", endedAt: now } });
        } else if (!t.shown && t.background && !listed.has(id)) {
          // A background start the set never took up was a late one for an agent already gone:
          // an early start is always followed by a set that names it. Foreground agents stay
          // tracked, since one may still be moved to the background.
          tasks.delete(id);
          runHistory = remember(runHistory, [[id, t]]);
        }
      }
      // A retired id the live set no longer lists has nothing left to be revived by. Its runs
      // are already in the history: every path that retires a task also records them there.
      if ([...retired.keys()].some((id) => !listed.has(id))) {
        retired = new Map([...retired].filter(([id]) => listed.has(id)));
      }
      liveNow = listed;
      break;
    }
    case "task_progress": {
      const id = str(message.task_id);
      const prior = id ? tasks.get(id) : undefined;
      if (!id || !prior || otherRun(runId, prior) || earlierRun(runId, prior)) return state;
      const usage = record(message.usage);
      put(id, {
        ...prior,
        // The flag counts whichever task frame carries it. The pinned SDK defines it only on
        // starts, notifications and live-set entries; honouring it here too costs nothing and
        // keeps the rule true if a later CLI adds it.
        ambient: prior.ambient || message.ambient === true,
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
      if (!id || !prior || !patch || otherRun(runId, prior) || earlierRun(runId, prior)) return state;
      const end = ended(patch.status);
      const background = prior.background || patch.is_backgrounded === true;
      const running = prior.entry.state === "running";
      put(id, {
        ...prior,
        background,
        // As in `task_progress`: honoured on the frame or its patch, wherever it appears.
        ambient: prior.ambient || message.ambient === true || patch.ambient === true,
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
      if (!id || !prior || otherRun(runId, prior) || earlierRun(runId, prior)) return state;
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
  if (forgotten.length > 0) {
    retired = withRetired({ levelSeen, retired, live: liveNow }, forgotten);
    runHistory = remember(runHistory, forgotten.map((t) => [t.entry.id, t]));
  }
  return bounded({ levelSeen, tasks, finishedFolded: state.finishedFolded, retired, live: liveNow, runHistory }, state);
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
    runHistory: remember(state.runHistory, gone.map((t) => [t.entry.id, t])),
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
    next = {
      ...next,
      tasks,
      finishedFolded,
      retired: withRetired(next, capped),
      runHistory: remember(next.runHistory, capped.map((t) => [t.entry.id, t])),
    };
  }
  return sameState(next, prior) ? prior : next;
}

function sameState(a: ClaudeSubagentState, b: ClaudeSubagentState): boolean {
  if (a.levelSeen !== b.levelSeen || a.finishedFolded !== b.finishedFolded) return false;
  // Replaced, never mutated, and only when a run is added: identity is equality here.
  if (a.runHistory !== b.runHistory) return false;
  if (a.live.size !== b.live.size) return false;
  for (const [id, run] of a.live) {
    if (!b.live.has(id) || b.live.get(id) !== run) return false;
  }
  if (a.retired.size !== b.retired.size) return false;
  for (const [id, run] of a.retired) {
    if (!b.retired.has(id) || JSON.stringify(b.retired.get(id)) !== JSON.stringify(run)) return false;
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
