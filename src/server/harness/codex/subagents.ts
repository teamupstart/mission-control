import type { SubagentEntry, SubagentState, SubagentSummary } from "@shared/types.ts";
import { SUBAGENT_LIMIT } from "@shared/subagents.ts";
import type { CollabAgentStatus, ItemStartedNotification, ThreadStartedNotification, TurnCompletedNotification } from "./app-server/protocol.ts";

/** Bound both live bookkeeping and folded identities retained against repeated frames. */
const TRACKED_LIMIT = 512;
type Tracked = {
  entry: SubagentEntry;
  folded: boolean;
  /** A folded identity stays hidden even after its aggregate count has been cleared. */
  counted: boolean;
};
type Wait = { threadId: string; turnId: string; children: string[] };

function cap<T>(map: Map<string, T>): void {
  while (map.size > TRACKED_LIMIT) map.delete(map.keys().next().value!);
}

function agentState(status: CollabAgentStatus): SubagentState | null {
  switch (status) {
    case "pendingInit":
    case "running": return "running";
    case "completed": return "completed";
    case "errored": return "failed";
    case "interrupted":
    case "shutdown": return "stopped";
    case "notFound": return null; // Absence is not proof of how an agent ended.
  }
}

/** Codex children are asynchronous except while a live wait names them. No routing policy. */
export class CodexSubagents {
  private readonly agents = new Map<string, Tracked>();
  private readonly waits = new Map<string, Wait>();

  clear(): void {
    this.agents.clear();
    this.waits.clear();
  }

  /** Called only after the driver has learned the frame's parent edges. */
  observe(method: string, params: unknown, ownsChild: (id: string) => boolean, now: number): void {
    if (method === "thread/started") {
      const thread = (params as ThreadStartedNotification).thread;
      if (thread?.id && ownsChild(thread.id)) {
        this.put(thread.id, now, {
          type: thread.agentRole || thread.agentNickname || null,
          description: thread.preview || null,
        });
      }
    } else if (method === "item/started" || method === "item/completed") {
      const { item, threadId, turnId } = params as ItemStartedNotification;
      if (item?.type === "subAgentActivity" && ownsChild(item.agentThreadId)) {
        const state = item.kind === "completed" ? "completed" : item.kind === "interrupted" ? "stopped" : "running";
        this.put(item.agentThreadId, now, { state });
      } else if (item?.type === "collabAgentToolCall") {
        const children = (item.receiverThreadIds ?? []).filter(ownsChild).slice(0, TRACKED_LIMIT);
        const key = JSON.stringify([threadId, item.id]);
        if (item.tool === "wait") {
          if (method === "item/started" && item.status === "inProgress" && children.length) {
            this.waits.set(key, { threadId, turnId, children });
            cap(this.waits);
          } else {
            this.waits.delete(key);
          }
        }
        for (const id of children) {
          const reported = item.agentsStates?.[id];
          const state = reported ? agentState(reported.status) : null;
          // A wait/close call completing says nothing about its targets without agentsStates.
          if (item.tool !== "spawnAgent" && !state) continue;
          this.put(id, now, {
            ...(state ? { state } : {}),
            ...(item.tool === "spawnAgent" && item.prompt ? { description: item.prompt } : {}),
            ...(reported?.message ? { summary: reported.message } : {}),
          });
        }
      }
    } else if (method === "turn/completed") {
      const { threadId, turn } = params as TurnCompletedNotification;
      for (const [key, wait] of this.waits) {
        if (wait.threadId === threadId && wait.turnId === turn.id) this.waits.delete(key);
      }
    }
    // Ownership may disappear when the driver's bounded parent map forgets an edge.
    for (const id of this.agents.keys()) if (!ownsChild(id)) this.agents.delete(id);
  }

  private put(id: string, now: number, patch: Partial<SubagentEntry>): void {
    const known = this.agents.get(id);
    const prior = known?.entry;
    const entry: SubagentEntry = prior ?? {
      id, type: null, description: null, state: "running", startedAt: now, endedAt: null,
      toolUses: null, tokens: null, lastTool: null, summary: null, launchTurnId: null,
    };
    const restarting = prior && prior.state !== "running" && patch.state === "running";
    this.agents.set(id, {
      entry: {
        ...entry,
        ...(restarting ? { summary: null } : {}),
        ...patch,
        type: patch.type ?? entry.type,
        description: patch.description ?? entry.description,
        startedAt: restarting ? now : entry.startedAt,
        endedAt: patch.state === "running" ? null : patch.state ? (entry.endedAt ?? now) : entry.endedAt,
      },
      folded: restarting ? false : (known?.folded ?? false),
      counted: restarting ? false : (known?.counted ?? false),
    });
    cap(this.agents);
  }

  /** Snapshot before sending: completions that overtake the acknowledgement stay visible. */
  finishedIds(): string[] {
    return [...this.agents].filter(([, t]) => !t.folded && t.entry.state !== "running").map(([id]) => id);
  }

  fold(ids: readonly string[]): void {
    for (const id of ids) {
      const t = this.agents.get(id);
      if (!t || t.folded || t.entry.state === "running") continue;
      t.folded = true;
      t.counted = true;
    }
    if (![...this.agents.values()].some((t) => t.entry.state === "running")) {
      for (const t of this.agents.values()) t.counted = false;
    }
  }

  summary(): SubagentSummary | null {
    const hidden = new Set([...this.waits.values()].flatMap((wait) => wait.children));
    const visible = [...this.agents.values()].filter((t) => !t.folded && !hidden.has(t.entry.id));
    visible.sort((a, b) => {
      const ar = a.entry.state === "running", br = b.entry.state === "running";
      if (ar !== br) return ar ? -1 : 1;
      return ar ? a.entry.startedAt - b.entry.startedAt : (b.entry.endedAt ?? 0) - (a.entry.endedAt ?? 0);
    });
    for (const t of visible.slice(SUBAGENT_LIMIT)) {
      if (t.entry.state !== "running") {
        t.folded = true;
        t.counted = true;
      }
    }
    const agents = visible.slice(0, SUBAGENT_LIMIT).map((t) => t.entry);
    // Count only retained identities: cap eviction and ownership pruning must forget their
    // contribution too, or a later frame can list the same child as both running and folded.
    const finishedFolded = [...this.agents.values()].filter((t) => t.counted).length;
    return agents.length || finishedFolded ? { agents, finishedFolded } : null;
  }
}
