import type { SubagentEntry, SubagentSummary } from "@shared/types.ts";
import { SUBAGENT_LIMIT } from "@shared/subagents.ts";

// A TERMINAL session's background sub-agents, reduced from its hooks into the harness-neutral
// `SubagentSummary` the registry holds. An SDK session's driver owns its own summary
// (`claude/subagents.ts`), so the registry never runs this for one.
//
// Harness-neutral on purpose. What each harness's events MEAN is that harness's answer -
// `HookSpec.subagentSignals` translates its vocabulary into the signals below - and the
// bookkeeping they drive is the same for every harness: an agent seen, counted, ended, folded.
//
// Pure: every function returns the SAME object when nothing changed, so the registry can tell
// a no-op from a change by identity.
//
// ## What a hook can and cannot say
//
// That an agent started and stopped, its type, and sometimes the description its launch was
// given. Never a token count, a tool count or a last tool, so those stay null - a row shows
// type, state and elapsed time and never a placeholder number. Never how an agent ENDED either:
// a stop is `completed` unless the agent simply vanished from the live set, which reads
// `stopped`. And never which turn launched it, so `launchTurnId` stays null.
//
// ## Ordering
//
// Each hook is its own process POSTing on its own, so two events of one agent can land in
// either order. Three rules keep that from showing: an ended agent is remembered (bounded) so a
// late launch or a late live set cannot bring it back as running; a live set only stops agents
// counted before it was taken; and a real stop overrides a stop that was only inferred.

/** What one hook says about a session's sub-agents, in harness-neutral terms. */
export type HookSubagentSignal =
  /**
   * An agent started, foreground or background - the hook cannot tell. Remembered so a later
   * launch can take its start time and type, but not counted: a foreground agent blocks the
   * parent's turn, so the parent already reads as working.
   */
  | { kind: "started"; id: string; type: string | null }
  /** An agent is running in the background: count it from now. */
  | { kind: "launched"; id: string; type: string | null; description: string | null }
  /** An agent finished. */
  | { kind: "ended"; id: string; type: string | null }
  /**
   * The whole set of background agents in flight at this event (replace semantics). A counted
   * agent missing from it was stopped; a listed agent not yet counted is counted.
   *
   * `partial` marks a set cut short in transit (the bridge bounds it). It is then only a
   * lower bound on what is running: it still adds the agents it lists, and stops none, since an
   * agent missing from it may simply have been past the cut.
   */
  | {
      kind: "live";
      agents: readonly { id: string; type: string | null; description: string | null }[];
      partial?: true;
    }
  /** The operator's next turn: finished agents fold into the "N finished" count. */
  | { kind: "fold" }
  /** A new process: nothing the old one ran is still running under this session. */
  | { kind: "reset" };

interface Tracked {
  entry: SubagentEntry;
  /** When the daemon counted it, by the hook's clock - what a live set is compared against. */
  countedAt: number;
  /** Stopped only because a live set omitted it; a real stop for it still wins. */
  inferred: boolean;
}

export interface HookSubagentState {
  readonly agents: ReadonlyMap<string, Tracked>;
  /** Agents seen starting and not (yet) counted, with when and as what. */
  readonly started: ReadonlyMap<string, { at: number; type: string | null }>;
  /** Ended ids, newest last, so a late signal cannot revive one. */
  readonly ended: ReadonlySet<string>;
  readonly finishedFolded: number;
}

/**
 * Bounds on what one session's hooks can make the daemon hold. The running set is bounded too,
 * because a hook stream that only ever launches (its stops lost) must not grow without limit.
 */
const STARTED_MAX = 32;
const ENDED_MAX = 64;
const RUNNING_MAX = 64;

const EMPTY: HookSubagentState = { agents: new Map(), started: new Map(), ended: new Set(), finishedFolded: 0 };

export function emptyHookSubagents(): HookSubagentState {
  return EMPTY;
}

/** A map or set trimmed to its newest `max` keys (insertion order is age). */
function newest<K, V>(map: Map<K, V>, max: number): Map<K, V> {
  while (map.size > max) map.delete(map.keys().next().value as K);
  return map;
}

function entry(id: string, at: number, type: string | null, description: string | null): SubagentEntry {
  return {
    id,
    type,
    description,
    state: "running",
    startedAt: at,
    endedAt: null,
    toolUses: null,
    tokens: null,
    lastTool: null,
    summary: null,
    launchTurnId: null,
  };
}

/** Running first by start, then the newest finished - the order `SubagentSummary` promises. */
function order(a: SubagentEntry, b: SubagentEntry): number {
  const ar = a.state === "running";
  const br = b.state === "running";
  if (ar !== br) return ar ? -1 : 1;
  if (ar) return a.startedAt - b.startedAt;
  return (b.endedAt ?? 0) - (a.endedAt ?? 0);
}

class Draft {
  agents: Map<string, Tracked>;
  started: Map<string, { at: number; type: string | null }>;
  ended: Set<string>;
  finishedFolded: number;
  changed = false;

  constructor(state: HookSubagentState) {
    this.agents = new Map(state.agents);
    this.started = new Map(state.started);
    this.ended = new Set(state.ended);
    this.finishedFolded = state.finishedFolded;
  }

  private end(id: string): void {
    this.ended.delete(id);
    this.ended.add(id);
    while (this.ended.size > ENDED_MAX) this.ended.delete(this.ended.values().next().value as string);
  }

  private count(id: string, at: number, type: string | null, description: string | null): void {
    const seen = this.started.get(id);
    this.started.delete(id);
    this.agents.set(id, {
      entry: entry(id, seen?.at ?? at, type ?? seen?.type ?? null, description),
      countedAt: at,
      inferred: false,
    });
    this.changed = true;
  }

  apply(signal: HookSubagentSignal, at: number): void {
    switch (signal.kind) {
      case "started": {
        if (this.ended.has(signal.id)) return;
        const known = this.agents.get(signal.id);
        if (known) {
          if (known.entry.type === null && signal.type) {
            this.agents.set(signal.id, { ...known, entry: { ...known.entry, type: signal.type } });
            this.changed = true;
          }
          return;
        }
        if (!this.started.has(signal.id)) {
          this.started.set(signal.id, { at, type: signal.type });
          newest(this.started, STARTED_MAX);
          this.changed = true;
        }
        return;
      }
      case "launched": {
        if (this.ended.has(signal.id)) return;
        const known = this.agents.get(signal.id);
        if (known) {
          const type = known.entry.type ?? signal.type;
          const description = known.entry.description ?? signal.description;
          if (type !== known.entry.type || description !== known.entry.description) {
            this.agents.set(signal.id, { ...known, entry: { ...known.entry, type, description } });
            this.changed = true;
          }
          return;
        }
        this.count(signal.id, at, signal.type, signal.description);
        return;
      }
      case "ended": {
        const known = this.agents.get(signal.id);
        if (known && (known.entry.state === "running" || known.inferred)) {
          this.agents.set(signal.id, {
            ...known,
            inferred: false,
            entry: {
              ...known.entry,
              type: known.entry.type ?? signal.type,
              state: "completed",
              endedAt: at,
            },
          });
          this.changed = true;
        }
        if (this.started.delete(signal.id)) this.changed = true;
        if (!this.ended.has(signal.id)) this.changed = true;
        this.end(signal.id);
        return;
      }
      case "live": {
        const listed = new Set<string>();
        for (const agent of signal.agents) {
          listed.add(agent.id);
          if (this.ended.has(agent.id)) continue;
          const known = this.agents.get(agent.id);
          if (!known) {
            this.count(agent.id, at, agent.type, agent.description);
          } else if (
            (known.entry.type === null && agent.type) ||
            (known.entry.description === null && agent.description)
          ) {
            this.agents.set(agent.id, {
              ...known,
              entry: {
                ...known.entry,
                type: known.entry.type ?? agent.type,
                description: known.entry.description ?? agent.description,
              },
            });
            this.changed = true;
          }
        }
        // A cut-short set cannot say who is missing from it.
        if (signal.partial) return;
        for (const [id, known] of this.agents) {
          // Only an agent counted before this set was taken can be missing from it; one counted
          // after is newer than the reading and says nothing about it.
          if (known.entry.state !== "running" || listed.has(id) || known.countedAt > at) continue;
          this.agents.set(id, { ...known, inferred: true, entry: { ...known.entry, state: "stopped", endedAt: at } });
          this.end(id);
          this.changed = true;
        }
        return;
      }
      case "fold": {
        let folded = 0;
        for (const [id, known] of this.agents) {
          if (known.entry.state === "running") continue;
          this.agents.delete(id);
          folded += 1;
        }
        const stillRunning = this.agents.size > 0;
        const finishedFolded = stillRunning ? this.finishedFolded + folded : 0;
        if (folded > 0 || finishedFolded !== this.finishedFolded) this.changed = true;
        this.finishedFolded = finishedFolded;
        return;
      }
      case "reset": {
        if (this.agents.size > 0 || this.started.size > 0 || this.ended.size > 0 || this.finishedFolded > 0) {
          this.agents = new Map();
          this.started = new Map();
          this.ended = new Set();
          this.finishedFolded = 0;
          this.changed = true;
        }
        return;
      }
    }
  }

  /** Keep the list inside its bounds by folding the oldest finished, then the oldest running. */
  bound(): void {
    const all = [...this.agents.values()].map((t) => t.entry).sort(order);
    const running = all.filter((e) => e.state === "running");
    const finished = all.filter((e) => e.state !== "running");
    const room = Math.max(0, SUBAGENT_LIMIT - running.length);
    for (const gone of finished.slice(room)) {
      this.agents.delete(gone.id);
      this.finishedFolded += 1;
      this.changed = true;
    }
    for (const gone of running.slice(0, Math.max(0, running.length - RUNNING_MAX))) {
      this.agents.delete(gone.id);
      this.changed = true;
    }
  }

  freeze(prior: HookSubagentState): HookSubagentState {
    if (!this.changed) return prior;
    return { agents: this.agents, started: this.started, ended: this.ended, finishedFolded: this.finishedFolded };
  }
}

/** Apply one hook's signals, in order. Returns `state` itself when they changed nothing. */
export function reduceHookSubagents(
  state: HookSubagentState,
  signals: readonly HookSubagentSignal[],
  at: number,
): HookSubagentState {
  if (signals.length === 0) return state;
  const draft = new Draft(state);
  for (const signal of signals) draft.apply(signal, at);
  draft.bound();
  return draft.freeze(state);
}

/** The registry's view: null when there is nothing to show. */
export function hookSubagentSummary(state: HookSubagentState): SubagentSummary | null {
  const agents = [...state.agents.values()].map((t) => t.entry).sort(order).slice(0, SUBAGENT_LIMIT);
  if (agents.length === 0 && state.finishedFolded === 0) return null;
  return { agents, finishedFolded: state.finishedFolded };
}
