/**
 * A terminal launch's work unit decision, handed over before the agent starts, taken by the
 * registry when it first sees THAT launch's agent, and settled by the launcher.
 *
 * Why a hand-over and not a write after the launch: a pane-backed session is discovered - and
 * announced - before the code that spawned it gets control back, and its launch record has to
 * be installed before that first announcement (`docs/work-units.md`, "The launch record").
 *
 * Matched by the launch itself, never by the checkout it runs in. Every terminal launch has its
 * own private state home, and its agent runs beneath a wrapper (or a managed resume's guard)
 * whose command names that home; discovery reads it off the process ancestry
 * (`DiscoveredSession.missionLaunchHome`). Another pane in the same checkout - the operator's
 * own `claude`, a second launch - runs beneath no wrapper or another one, so it cannot take
 * this decision.
 *
 * Being seen beneath the launch's own wrapper is proof that THIS launch's agent started, with
 * this environment. So the record follows the agent, not the launch's verdict on the rest of
 * its work, and the launcher settles the hand-over with one of three outcomes:
 *  - `"succeeded"`: the record stands, now or when the agent appears.
 *  - `"failed"`: the launch failed somewhere, and its agent may still be running - a dispatch
 *    keeps the terminal of a failed launch. A taken record is undone only if that agent is gone
 *    by then; while it lives it carries the variable, and the record is what keeps the reuse
 *    guard from handing it another work unit's task. An untaken decision keeps waiting, so an
 *    agent that appears late still gets its record; only that launch's agent can take it.
 *  - `"not-started"`: the launch definitely started nothing (a managed resume the terminal
 *    refused). An untaken decision is withdrawn; there is no agent to take it.
 * Undoing restores whatever the session's keys held before, so a failed launch whose agent did
 * not survive leaves the records exactly as they were.
 *
 * No timer. An entry lasts exactly as long as its launch home exists: the wrapper removes that
 * home only when it exits, which is after its agent has, so once it is gone no agent can still
 * appear beneath it, however slow the terminal was. While it exists, the agent that may yet
 * appear is the only one that can take the entry.
 *
 * Module state rather than a registry field because a managed resume reaches it from
 * `launchPreparedResume`, which has no registry; the registry hands back the undo when it
 * takes an entry.
 */
import { existsSync } from "node:fs";

export interface TerminalLaunchWorkUnit {
  /** The launch's private state home: the one its wrapper, and nothing else, runs from. */
  readonly launchHome: string;
  /** The launch's one decision: the id its environment carries, or null for none. */
  readonly workUnitId: string | null;
  /**
   * The conversation key the launched agent will bind to, when the launch knows it already: a
   * managed resume or a runtime transfer reopens a known conversation. Its session is first
   * seen under a pane id, so without this a resume that carries none would leave the previous
   * process's record under the conversation key for the rebind to find. Null for a new
   * conversation, whose key nobody has yet.
   */
  readonly conversationKey: string | null;
  readonly expectedAt: number;
}

/** The launcher's verdict on a terminal launch. See the module comment. */
export type TerminalLaunchOutcome = "succeeded" | "failed" | "not-started";

interface Entry {
  readonly decision: TerminalLaunchWorkUnit;
  /** Taken by the registry: the record is installed. */
  taken: boolean;
  /** The launcher has settled it; a later take installs a final record. */
  settled: boolean;
  /**
   * Undoes the install if the agent it describes is gone; held only while a taken entry is
   * unsettled. The registry decides liveness, so this is safe to call at any time.
   */
  undo: (() => void) | null;
}

const entries: Entry[] = [];

/**
 * Forget the entries whose launch is over: its home is gone, so its wrapper - and with it any
 * agent beneath it - has exited. A taken entry still unsettled then keeps its record, which
 * describes a process that has ended.
 */
function sweep(): void {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (!existsSync(entries[i]!.decision.launchHome)) entries.splice(i, 1);
  }
}

function entryFor(decision: TerminalLaunchWorkUnit | null | undefined): Entry | undefined {
  return decision ? entries.find((entry) => entry.decision === decision) : undefined;
}

/**
 * State the decision of a terminal launch whose wrapper will run from `launchHome`. Call it
 * immediately before the spawn, with the value the launch's environment was built from. Returns
 * the decision, which is what `settleTerminalLaunchWorkUnit` takes.
 */
export function expectTerminalLaunchWorkUnit(
  launchHome: string,
  workUnitId: string | null,
  conversationKey: string | null = null,
): TerminalLaunchWorkUnit {
  sweep();
  const decision: TerminalLaunchWorkUnit = { launchHome, workUnitId, conversationKey, expectedAt: Date.now() };
  entries.push({ decision, taken: false, settled: false, undo: null });
  return decision;
}

/**
 * The launcher's verdict (see the module comment). Settling twice, or a decision already
 * swept, does nothing.
 */
export function settleTerminalLaunchWorkUnit(
  decision: TerminalLaunchWorkUnit | null | undefined,
  outcome: TerminalLaunchOutcome,
): void {
  const entry = entryFor(decision);
  if (!entry || entry.settled) return;
  entry.settled = true;
  if (!entry.taken) {
    // Nothing can appear for a launch that started nothing. Any other outcome waits for the
    // launch's own agent, which alone can take it.
    if (outcome === "not-started") entries.splice(entries.indexOf(entry), 1);
    return;
  }
  entries.splice(entries.indexOf(entry), 1);
  const undo = entry.undo;
  entry.undo = null;
  if (outcome !== "succeeded") undo?.();
}

/**
 * Take the live decision of the launch at `launchHome`, for its agent's first sighting.
 * `install` puts the record in place and returns how to undo it if its agent is gone; the undo
 * is kept until the launcher settles. Returns the decision taken, or null when this launch
 * handed none over.
 */
export function takeTerminalLaunchWorkUnit(
  launchHome: string | null | undefined,
  install: (decision: TerminalLaunchWorkUnit) => () => void,
): TerminalLaunchWorkUnit | null {
  // Not swept first: the agent being taken for is proof its launch is still running.
  if (!launchHome) return null;
  const entry = entries.find((candidate) => !candidate.taken && candidate.decision.launchHome === launchHome);
  if (!entry) return null;
  const undo = install(entry.decision);
  entry.taken = true;
  // Settled already: this agent appeared after its launcher's verdict, and it is running with
  // the variable, so its record is final whatever that verdict was.
  if (entry.settled) entries.splice(entries.indexOf(entry), 1);
  else entry.undo = undo;
  return entry.decision;
}

/** For tests: forget every decision. */
export function resetTerminalLaunchWorkUnits(): void {
  entries.length = 0;
}
