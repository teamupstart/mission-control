import { residentMarkerColor, type ResidentProfile, type ResidentRunSummary } from "@shared/residents.ts";
import { isTerminalTask } from "@shared/task-status.ts";
import type { ServerEvent, Session, Task } from "@shared/types.ts";
import { canonicalVoiceRoster } from "@shared/voice.ts";
import {
  normalizeSpokenName,
  residentSpokenNameKey,
  taskKindTakesCallSign,
  taskSpokenNameKey,
  type SpokenName,
  type SpokenNameState,
} from "@shared/voice-names.ts";
import { voiceStateStore, type VoiceStateStore } from "./state.ts";

// The daemon's voice name registry (contract C): who can be addressed by voice, published as
// `VoiceState.roster` and `voice_roster`.
//
// It holds one entry per live resident profile and one per task with a call sign, computed from
// what the daemon's Registry already holds - profiles, open runs, tasks and live sessions - and
// recomputed when one of their frames says something it reads may have moved. Nothing here is
// stored: a restart computes the same roster from the same rows, less the memory of when a task
// that was not finished stopped running, which then counts from the restart.

/** How long a task that stopped running keeps its name on the roster, marked not running. */
export const VOICE_NAME_RETENTION_MS = 24 * 60 * 60 * 1000;

/** What the registry reads. The daemon's `Registry` is one as it stands. */
export interface VoiceNameSources {
  listResidentProfiles(): readonly ResidentProfile[];
  listResidentRuns(): readonly ResidentRunSummary[];
  listTasks(): readonly Task[];
  liveSessions(): readonly Session[];
  subscribe(fn: (event: ServerEvent) => void): () => void;
}

export interface VoiceNameDeps {
  now(): number;
  /** Whether the `voice` flag is on. Off, nothing is recomputed until something reads it. */
  enabled(): boolean;
  /**
   * Whether a task's row is still stored. A task the Registry drops from memory while its row
   * remains was only evicted (it keeps the 50 most recent finished tasks), so its name stays
   * until its day is up; a deleted one leaves at once.
   */
  taskStored(id: string): boolean;
  /** Schedules the recompute that drops an expired name. Unref'd, so it never holds the process. */
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

/** What `computeVoiceRoster` decides from. */
export interface VoiceRosterInputs {
  profiles: readonly ResidentProfile[];
  runs: readonly ResidentRunSummary[];
  tasks: readonly Task[];
  liveSessions: readonly Session[];
  /** When a task that is not running stopped, for its 24 hours. */
  stoppedAt(task: Task): number;
  now: number;
}

export interface VoiceRosterResult {
  roster: SpokenName[];
  /** The earliest moment a listed name expires, or null when none will. */
  nextExpiry: number | null;
  /** The tasks listed, by id, so a caller can keep one the Registry later evicts. */
  listedTasks: Map<string, Task>;
}

/** A role as one line: whitespace collapsed, ends trimmed. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Whether a task is an agent that answers to its call sign: it has one, it has been launched at
 * least once, and it is not a resident's task, which answers to its profile's name instead.
 *
 * Launched means `dispatchedAt`, which the dispatcher stamps as a launch attempt starts, whatever
 * the status: a task created to launch now sits in `dispatching` with none until the dispatcher
 * reaches it, and listing it then would start its 24 hours before it ever ran.
 */
export function taskHasSpokenName(task: Task): boolean {
  if (!task.callSign || !taskKindTakesCallSign(task.kind) || task.status === "backlog") return false;
  return task.dispatchedAt !== null;
}

function taskState(task: Task, sessionId: string | null): SpokenNameState {
  if (sessionId) return "running";
  return task.status === "hibernated" ? "hibernated" : "not-running";
}

function byName(a: SpokenName, b: SpokenName): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.key.localeCompare(b.key);
}

/**
 * The roster, as a pure function of what the daemon holds.
 *
 * - A resident profile is listed by its reference name, else its profile name, with its
 *   description as its role. It is `running` while it has an open run, else `not-running`, and
 *   never leaves while the profile is live.
 * - A task with a call sign is listed by it, with its title as its role. It is `running` while a
 *   live session runs it, `hibernated` while hibernated, else `not-running`. Not running, it
 *   leaves 24 hours after it stopped, or at once when another agent answers to the same name: a
 *   resident, a task that is running or hibernated, or a task that stopped later.
 *
 * Residents come first, then sessions, each by name.
 */
export function computeVoiceRoster(inputs: VoiceRosterInputs): VoiceRosterResult {
  const sessionForTask = new Map<string, string>();
  for (const session of inputs.liveSessions) {
    if (session.state !== "exited" && session.task) sessionForTask.set(session.task.id, session.id);
  }
  const openRuns = new Map<string, ResidentRunSummary>();
  for (const run of inputs.runs) {
    const held = openRuns.get(run.profileId);
    if (!held || run.createdAt > held.createdAt) openRuns.set(run.profileId, run);
  }

  const residents: SpokenName[] = inputs.profiles.map((profile) => {
    const { identity, board, execution } = profile.settings;
    const run = openRuns.get(profile.id);
    return {
      key: residentSpokenNameKey(profile.id),
      name: identity.referenceName?.trim() || identity.name,
      kind: "resident",
      taskId: run?.taskId ?? null,
      sessionId: run ? sessionForTask.get(run.taskId) ?? null : null,
      role: oneLine(identity.description),
      colorId: residentMarkerColor(board.colorId),
      agent: execution.agent,
      state: run ? "running" : "not-running",
    };
  });

  interface Candidate { entry: SpokenName; task: Task; stoppedAt: number | null }
  const candidates: Candidate[] = [];
  for (const task of inputs.tasks) {
    if (!taskHasSpokenName(task)) continue;
    const live = sessionForTask.get(task.id) ?? null;
    const state = taskState(task, live);
    const stoppedAt = state === "not-running" ? inputs.stoppedAt(task) : null;
    if (stoppedAt !== null && inputs.now >= stoppedAt + VOICE_NAME_RETENTION_MS) continue;
    candidates.push({
      task,
      stoppedAt,
      entry: {
        key: taskSpokenNameKey(task.id),
        name: task.callSign!,
        kind: "session",
        taskId: task.id,
        sessionId: live ?? task.sessionId ?? null,
        role: oneLine(task.title),
        colorId: null,
        agent: task.agent,
        state,
      },
    });
  }

  // A name another agent now answers to is that agent's: drop the stopped task that held it.
  const residentNames = new Set(residents.map((entry) => normalizeSpokenName(entry.name)));
  const kept = candidates.filter((candidate) => {
    if (candidate.stoppedAt === null) return true;
    const name = normalizeSpokenName(candidate.entry.name);
    if (residentNames.has(name)) return false;
    return !candidates.some((other) => other !== candidate
      && normalizeSpokenName(other.entry.name) === name
      && (other.stoppedAt === null
        || other.stoppedAt > candidate.stoppedAt!
        || (other.stoppedAt === candidate.stoppedAt && other.entry.key > candidate.entry.key)));
  });

  const expiries = kept.flatMap((candidate) =>
    candidate.stoppedAt === null ? [] : [candidate.stoppedAt + VOICE_NAME_RETENTION_MS]);
  return {
    roster: [...residents.sort(byName), ...kept.map((candidate) => candidate.entry).sort(byName)],
    nextExpiry: expiries.length > 0 ? Math.min(...expiries) : null,
    listedTasks: new Map(kept.map((candidate) => [candidate.task.id, candidate.task])),
  };
}

/** Event types that can move the roster. Everything else is ignored without a look. */
const ROSTER_EVENTS = new Set<ServerEvent["type"]>([
  "session_upsert",
  "session_remove",
  "task_upsert",
  "task_remove",
  "resident_profile_upsert",
  "resident_profile_remove",
  "resident_run_upsert",
  "resident_run_remove",
]);

/**
 * The daemon's one name registry. Subscribed to the Registry's frames; recomputes the roster
 * when one of them can move it, and tells its listeners when the roster changed.
 *
 * It recomputes whatever the `voice` flag says, and only telling the listeners waits for the
 * flag. The bookkeeping a recompute keeps (when a task was first seen stopped, which tasks are
 * listed and so kept if the Registry evicts them) has to follow the frames as they happen: kept
 * only while voice is on, a task that stopped or was evicted while it was off would have its 24
 * hours counted from when voice came back, or lose its name early. A recompute is cheap and only
 * the frames that can move the roster reach it.
 */
export class VoiceNameRegistry {
  private current: SpokenName[] = [];
  private currentKey = canonicalVoiceRoster([]);
  private stale = true;
  /** When each task that is not finished was first seen not running. */
  private readonly stopped = new Map<string, number>();
  /** Tasks listed at the last compute, so an evicted one can be kept. */
  private listed = new Map<string, Task>();
  /** Listed tasks the Registry evicted from memory while their rows remain. */
  private readonly retained = new Map<string, Task>();
  /** Which task each live session runs, so a session frame that changes neither is ignored. */
  private readonly sessionTasks = new Map<string, string | null>();
  private readonly listeners = new Set<(roster: readonly SpokenName[]) => void>();
  private timer: unknown = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly sources: VoiceNameSources, private readonly deps: VoiceNameDeps) {}

  /** Start following the Registry. Returns the stop the daemon calls at shutdown. */
  start(): () => void {
    for (const session of this.sources.liveSessions()) this.sessionTasks.set(session.id, session.task?.id ?? null);
    this.unsubscribe ??= this.sources.subscribe((event) => this.observe(event));
    this.refresh();
    return () => this.stop();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.disarm();
  }

  /** Who can be addressed now. Computed first if nothing has computed it yet. */
  roster(): readonly SpokenName[] {
    if (this.stale) this.compute();
    return this.current;
  }

  onChange(listener: (roster: readonly SpokenName[]) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Recompute the roster, and while voice is on tell the listeners when it changed. */
  refresh(): void {
    const before = this.currentKey;
    this.compute();
    if (!this.deps.enabled() || this.currentKey === before) return;
    for (const listener of Array.from(this.listeners)) {
      try { listener(this.current); }
      catch (error) { console.warn("[voice] roster listener failed:", error); }
    }
  }

  private observe(event: ServerEvent): void {
    if (!ROSTER_EVENTS.has(event.type)) return;
    switch (event.type) {
      case "session_upsert": {
        const running = event.session.state === "exited" ? undefined : event.session.task?.id ?? null;
        if (running === undefined ? !this.sessionTasks.has(event.session.id) : this.sessionTasks.get(event.session.id) === running) return;
        if (running === undefined) this.sessionTasks.delete(event.session.id);
        else this.sessionTasks.set(event.session.id, running);
        break;
      }
      case "session_remove":
        if (!this.sessionTasks.delete(event.id)) return;
        break;
      case "task_upsert":
        // Only a task that has a call sign, or had one when last listed, can move the roster;
        // a resident's own task moves it through its run and session frames.
        if (!event.task.callSign && !this.listed.has(event.task.id) && !this.retained.has(event.task.id)) return;
        this.retained.delete(event.task.id);
        break;
      case "task_remove": {
        const listed = this.listed.get(event.id);
        if (listed && this.deps.taskStored(event.id)) this.retained.set(event.id, listed);
        else if (!this.retained.delete(event.id) && !listed) return;
        break;
      }
      default:
        break;
    }
    this.refresh();
  }

  private compute(): void {
    const now = this.deps.now();
    const inMemory = this.sources.listTasks();
    const ids = new Set(inMemory.map((task) => task.id));
    const tasks = [...inMemory, ...[...this.retained.values()].filter((task) => !ids.has(task.id))];
    const stoppedNow = new Set<string>();
    const result = computeVoiceRoster({
      profiles: this.sources.listResidentProfiles(),
      runs: this.sources.listResidentRuns(),
      tasks,
      liveSessions: this.sources.liveSessions(),
      now,
      stoppedAt: (task) => {
        stoppedNow.add(task.id);
        if (isTerminalTask(task.status)) return task.completedAt ?? task.updatedAt;
        const seen = this.stopped.get(task.id);
        if (seen !== undefined) return seen;
        this.stopped.set(task.id, now);
        return now;
      },
    });
    // Forget what no longer applies: a stop that ended (the task runs again or is gone), and a
    // retained task whose name has left.
    // Deleting the entry a Map iterator is on is safe: iteration continues with the next.
    for (const id of this.stopped.keys()) if (!stoppedNow.has(id)) this.stopped.delete(id);
    for (const id of this.retained.keys()) if (!result.listedTasks.has(id)) this.retained.delete(id);
    this.listed = result.listedTasks;
    this.current = result.roster;
    this.currentKey = canonicalVoiceRoster(result.roster);
    this.stale = false;
    this.arm(result.nextExpiry, now);
  }

  /** Armed whatever the flag, so a name that expires while voice is off is gone when it is on. */
  private arm(at: number | null, now: number): void {
    this.disarm();
    if (at === null) return;
    const set = this.deps.setTimer ?? ((fn: () => void, ms: number) => {
      const handle = setTimeout(fn, ms);
      handle.unref?.();
      return handle;
    });
    // At least a second: a name that expires now is dropped by this compute, never in a loop.
    this.timer = set(() => {
      this.timer = null;
      this.refresh();
    }, Math.max(1000, at - now));
  }

  private disarm(): void {
    if (this.timer === null) return;
    (this.deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
  }
}

/**
 * The one bridge from the name registry to open windows, wired once at daemon start before the
 * voice state's: the state reads its roster from `names`, and every change reaches `emit` as a
 * `voice_roster` frame.
 *
 * Returns the stop the daemon calls at shutdown.
 */
export function wireVoiceNameEvents(
  names: VoiceNameRegistry,
  emit: (roster: readonly SpokenName[]) => void,
  store: VoiceStateStore = voiceStateStore,
): () => void {
  store.useRoster(() => names.roster());
  const stopEmit = names.onChange(emit);
  const stopNames = names.start();
  return () => {
    stopEmit();
    stopNames();
    store.useRoster(null);
  };
}
