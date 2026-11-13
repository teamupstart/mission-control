import { AGENT_IDENTITY } from "@shared/agent.ts";
import { PRIORITY_LABELS, TASK_KIND_INFO } from "@shared/task.ts";
import type { Task } from "@shared/types.ts";
import { relativeTime } from "./format.ts";
import { matchesEveryWord, pathLeaf } from "./search-text.ts";

/**
 * Search and filtering for the backlog, shared by the Board's Backlog column and the Line's
 * Backlog drawer so the two surfaces cannot disagree about which tasks a filter keeps.
 *
 * A filter only HIDES rows. It never reorders them, never changes what autopilot takes next,
 * and never writes anything: the order a person sees through a filter is the backlog's own
 * order with some rows left out.
 *
 * Two facets, each a set of values combined with OR inside the facet and AND across facets:
 *
 *  - **Dependencies.** `ready` is a task with no unmet dependency and `blocked` is one with at
 *    least one. The caller supplies that fact from `blockersIn`, the one definition of what
 *    blocks what, so a card the filter calls ready is a card the board does not mark blocked.
 *  - **Autopilot.** `on` and `off` read the task's own autopilot switch (`task.enabled`).
 *
 * An empty facet filters nothing, so checking both values of a facet and checking neither
 * show the same rows.
 */

export type BacklogDepFacet = "ready" | "blocked";
export type BacklogAutopilotFacet = "on" | "off";

export interface BacklogFilter {
  /** Free text, matched case-insensitively. Blank matches everything. */
  query: string;
  deps: readonly BacklogDepFacet[];
  autopilot: readonly BacklogAutopilotFacet[];
}

export const EMPTY_BACKLOG_FILTER: BacklogFilter = { query: "", deps: [], autopilot: [] };

/** What a filter needs to know about one backlog task. */
export interface BacklogFilterSubject {
  task: Task;
  /** Whether the task has at least one unmet dependency, from `blockersIn`. */
  blocked: boolean;
}

export const DEP_FACET_LABELS: Record<BacklogDepFacet, string> = {
  ready: "Ready to start",
  blocked: "Blocked",
};

export const AUTOPILOT_FACET_LABELS: Record<BacklogAutopilotFacet, string> = {
  on: "Autopilot on",
  off: "Autopilot off",
};

export function backlogFilterActive(filter: BacklogFilter): boolean {
  return filter.query.trim() !== "" || filter.deps.length > 0 || filter.autopilot.length > 0;
}

/** How many facet values are checked, for the Filter button's badge. Search is not counted. */
export function backlogFacetCount(filter: BacklogFilter): number {
  return filter.deps.length + filter.autopilot.length;
}

/**
 * Everything a backlog card says about its task, as searchable text: the title, the intent,
 * the labels, every repository it spans, the agent, the kind, the priority, the model and
 * effort it will dispatch with, its status, its autopilot switch ("autopilot on"/"autopilot off") and the
 * "autopilot will skip this" line a parked card prints, and how long ago it was added. Repositories
 * match by their name and by the full path the card's repository tooltip shows.
 */
export function backlogSearchFields(task: Task): (string | null | undefined)[] {
  return [
    task.title,
    task.intent,
    ...task.labels,
    pathLeaf(task.repoRoot),
    task.repoRoot,
    ...task.extraRepos.flatMap((extra) => [pathLeaf(extra.repoRoot), extra.repoRoot]),
    task.agent,
    AGENT_IDENTITY[task.agent]?.label,
    task.kind,
    TASK_KIND_INFO[task.kind]?.label,
    task.priority && PRIORITY_LABELS[task.priority],
    task.model,
    task.effort,
    task.status,
    // The switch prints a bare ON/OFF; labelled here so "autopilot on" can find enabled cards.
    task.enabled ? "autopilot on" : "autopilot off",
    task.enabled ? null : "autopilot will skip this",
    relativeTime(task.createdAt),
  ];
}

/**
 * Whether a task matches the search text: every whitespace-separated word must appear
 * somewhere on its card (see `backlogSearchFields`).
 */
export function matchesBacklogSearch(task: Task, query: string): boolean {
  return matchesEveryWord(backlogSearchFields(task), query);
}

function depFacet(subject: BacklogFilterSubject): BacklogDepFacet {
  return subject.blocked ? "blocked" : "ready";
}

function autopilotFacet(subject: BacklogFilterSubject): BacklogAutopilotFacet {
  return subject.task.enabled ? "on" : "off";
}

function passes<T>(selected: readonly T[], value: T): boolean {
  return selected.length === 0 || selected.includes(value);
}

export function matchesBacklogFilter(subject: BacklogFilterSubject, filter: BacklogFilter): boolean {
  return (
    passes(filter.deps, depFacet(subject)) &&
    passes(filter.autopilot, autopilotFacet(subject)) &&
    matchesBacklogSearch(subject.task, filter.query)
  );
}

export type BacklogFacetCounts = Record<BacklogDepFacet | BacklogAutopilotFacet, number>;

/**
 * How many tasks each menu row would show if it were the only value checked in its facet.
 *
 * Each facet's counts apply the search and the OTHER facet, never their own - the usual
 * faceted-search rule, so "Ready to start 9" still reads 9 after you check it, and checking
 * "Autopilot off" changes the dependency counts to the ones you would now see.
 */
export function backlogFacetCounts(
  subjects: readonly BacklogFilterSubject[],
  filter: BacklogFilter,
): BacklogFacetCounts {
  const counts: BacklogFacetCounts = { ready: 0, blocked: 0, on: 0, off: 0 };
  for (const subject of subjects) {
    if (!matchesBacklogSearch(subject.task, filter.query)) continue;
    const dep = depFacet(subject);
    const auto = autopilotFacet(subject);
    if (passes(filter.autopilot, auto)) counts[dep] += 1;
    if (passes(filter.deps, dep)) counts[auto] += 1;
  }
  return counts;
}

/** Add a facet value if absent, remove it if present, keeping the facet's declared order. */
export function toggleFacet<T extends string>(
  selected: readonly T[],
  value: T,
  order: readonly T[],
): T[] {
  const next = selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value];
  return order.filter((v) => next.includes(v));
}

export const DEP_FACETS: readonly BacklogDepFacet[] = ["ready", "blocked"];
export const AUTOPILOT_FACETS: readonly BacklogAutopilotFacet[] = ["on", "off"];

/**
 * Split text into runs that do and do not match a search word, for drawing the match.
 * Case-insensitive, and every word in the query is marked wherever it occurs.
 */
export function searchHighlights(text: string, query: string): Array<{ text: string; hit: boolean }> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0 || text === "") return [{ text, hit: false }];
  const lower = text.toLowerCase();
  const marked: boolean[] = Array.from({ length: text.length }, () => false);
  for (const word of words) {
    for (let at = lower.indexOf(word); at !== -1; at = lower.indexOf(word, at + 1)) {
      marked.fill(true, at, at + word.length);
    }
  }
  const runs: Array<{ text: string; hit: boolean }> = [];
  for (let i = 0; i < text.length; i++) {
    const last = runs[runs.length - 1];
    if (last && last.hit === marked[i]) last.text += text[i];
    else runs.push({ text: text[i] ?? "", hit: marked[i] ?? false });
  }
  return runs;
}
