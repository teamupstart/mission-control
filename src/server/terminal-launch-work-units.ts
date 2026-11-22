/**
 * A terminal launch's work unit decision, handed over before the agent starts and taken by the
 * registry when it first sees THAT launch's agent.
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
 * this environment, so taking the decision installs a record that is final: it describes that
 * agent for as long as it runs, whatever else the launch then failed at. A dispatch that fails
 * keeps its terminal, so its agent may well still be running, and its record is what keeps the
 * reuse guard from handing it another work unit's task. When that agent ends, its record
 * describes a process that has ended, which no reader takes for a live agent, and the next
 * launch of its conversation replaces it.
 *
 * The launcher settles its decision only to withdraw one that nothing can take: a launch that
 * definitely started nothing (`"not-started"`, such as a managed resume the terminal refused).
 * Any other outcome leaves an untaken decision waiting, so an agent that appears late still
 * gets its record.
 *
 * No timer. An entry lasts exactly as long as its launch home exists: the wrapper removes that
 * home only when it exits, which is after its agent has, so once it is gone no agent can still
 * appear beneath it, however slow the terminal was. Every call here sweeps the ended entries -
 * a new launch, a launcher's verdict, and each new session discovery sees - so the list holds
 * only launches whose home still exists, even when nothing else is ever launched. No size cap:
 * a launch still running would lose the decision its agent has yet to be seen with.
 *
 * Module state rather than a registry field because a managed resume reaches it from
 * `launchPreparedResume`, which has no registry.
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

/** The launcher's verdict on a terminal launch. Only `"not-started"` changes anything. */
export type TerminalLaunchOutcome = "succeeded" | "failed" | "not-started";

const pending: TerminalLaunchWorkUnit[] = [];

/**
 * More waiting decisions than any sane number of launches in flight. The list is bounded by
 * homes that still exist, and a wrapper killed before its cleanup (a SIGKILL) leaves its home
 * behind, so its entry stays until the daemon restarts. Not dropped by age - a slow terminal's
 * agent may still appear - but crossing this is logged, once per crossing, so such a leak shows.
 */
export const TERMINAL_LAUNCH_WORK_UNITS_WARN_AT = 64;
let warned = false;

function noteSize(): void {
  if (pending.length < TERMINAL_LAUNCH_WORK_UNITS_WARN_AT) {
    warned = false;
    return;
  }
  if (warned) return;
  warned = true;
  console.warn(
    `[work-unit] ${pending.length} terminal launch hand-overs are waiting; each lasts while its launch home exists, so homes a killed wrapper left behind may be accumulating`,
  );
}

/** Forget the decisions whose launch is over: its home is gone, so its wrapper has exited. */
function sweep(): void {
  for (let i = pending.length - 1; i >= 0; i -= 1) {
    if (!existsSync(pending[i]!.launchHome)) pending.splice(i, 1);
  }
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
  pending.push(decision);
  noteSize();
  return decision;
}

/**
 * The launcher's verdict. A launch that started nothing withdraws its untaken decision; any
 * other outcome leaves it for the launch's own agent. A decision already taken, or swept, is
 * not affected.
 */
export function settleTerminalLaunchWorkUnit(
  decision: TerminalLaunchWorkUnit | null | undefined,
  outcome: TerminalLaunchOutcome,
): void {
  sweep();
  if (!decision || outcome !== "not-started") return;
  const index = pending.indexOf(decision);
  if (index >= 0) pending.splice(index, 1);
}

/**
 * Take the waiting decision of the launch at `launchHome`, for its agent's first sighting, and
 * remove it once `install` has put the record in place; that record is final. Returns the decision
 * taken, or null when this launch handed none over.
 */
export function takeTerminalLaunchWorkUnit(
  launchHome: string | null | undefined,
  install: (decision: TerminalLaunchWorkUnit) => void,
): TerminalLaunchWorkUnit | null {
  // Swept first. An agent seen beneath a live launch finds its home still there, so its entry
  // survives; one whose home is already gone had exited before this sighting was published.
  sweep();
  if (!launchHome) return null;
  const index = pending.findIndex((decision) => decision.launchHome === launchHome);
  if (index < 0) return null;
  // Removed only once installed: an install that throws (its write failed) leaves the decision
  // waiting, and the session is not in the map yet, so the next sweep's first sight retries it.
  const decision = pending[index]!;
  install(decision);
  pending.splice(pending.indexOf(decision), 1);
  return decision;
}

/** For tests: how many decisions are waiting. */
export function terminalLaunchWorkUnitsWaiting(): number {
  return pending.length;
}

/** For tests: forget every decision. */
export function resetTerminalLaunchWorkUnits(): void {
  pending.length = 0;
  warned = false;
}
