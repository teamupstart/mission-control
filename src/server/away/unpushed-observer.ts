import { readUnpushedCommits } from "../git/unpushed.ts";
import type { UnpushedByRun } from "@shared/stall.ts";
import type { UnpushedCommits } from "@shared/unpushed.ts";
import type { WorkflowRunSummary } from "@shared/workflow.ts";

// The daemon's standing answer to "does this parked run's checkout hold commits nobody has
// pushed?", kept fresh enough for the stall rule to quote and cheap enough to sit on a 5s poll.
//
// This exists because of a shape mismatch that cannot be papered over at the call site. The
// stall rule is SYNCHRONOUS and pure - it is shared with the browser, it takes a clock, and it
// returns a sentence - while the observation behind one of its sentences is four sequential
// git subprocesses. `pass()` in `watcher.ts` cannot await, and making it async would put a
// subprocess round trip inside the tick that also folds the away buffer, so a slow or hung git
// would stop stall detection for every session in the fleet rather than for the one checkout
// it could not read.
//
// So the read is moved OFF the tick entirely. `observe` starts reads and returns immediately;
// `snapshot` hands back whatever has already come back. The tick never blocks, and the answer
// is at most one refresh interval stale - which costs nothing here, because the sentence it
// feeds is only ever spoken about a session that has already been idle for twenty minutes.

/**
 * How long an observation stands before it is read again.
 *
 * Far longer than the 5s watcher tick, because this is a subprocess and the tick is a pure
 * function. Far shorter than the 20-minute stall threshold, so the sentence a person finally
 * reads was measured well after the session went quiet rather than when it was last busy.
 */
export const UNPUSHED_TTL_MS = 60_000;

/**
 * The seams, so the unit test needs neither a git repository nor the Workflow store.
 *
 * `checkoutFor` is a FUNCTION rather than a path on the run because the path lives on the
 * binding (`WorkflowBinding.sessionCwd`), and this module must not import the Workflow store -
 * the same boundary `AwayDeps.workflowRepeatOffenders` is drawn along, and for the same reason.
 * It matters that it resolves per RUN: a multi-repo task holds one run per repository, each
 * bound to a different checkout, so resolving through the session would read one repository's
 * commits and report them against another's run.
 */
export interface UnpushedObserverDeps {
  checkoutFor: (run: WorkflowRunSummary) => string | null;
  read?: typeof readUnpushedCommits;
  now?: () => number;
  ttlMs?: number;
}

export interface UnpushedObserver {
  /**
   * Name the runs that currently matter. Starts any read that is due and returns at once.
   *
   * Never awaited by the caller on purpose - see the module comment. Runs that are no longer
   * parked are forgotten here, which is what keeps a long-lived daemon's map the size of the
   * parked set rather than the size of every run it has ever seen.
   */
  observe: (runs: readonly WorkflowRunSummary[]) => void;
  /** What is known right now. Missing keys read as "no claim", never as "nothing unpushed". */
  snapshot: () => UnpushedByRun;
}

interface Entry {
  obs: UnpushedCommits;
  readAt: number;
}

/**
 * Only this status. `waiting_for_session` is un-parked by a resubmission rather than by a
 * push, so `parkedReason` never quotes an unpushed count for one - reading git for it would
 * spend four subprocesses on an answer with nowhere to go.
 */
function wantsObservation(run: WorkflowRunSummary): boolean {
  return run.status === "waiting_for_new_head";
}

export function createUnpushedObserver(deps: UnpushedObserverDeps): UnpushedObserver {
  const read = deps.read ?? readUnpushedCommits;
  const now = deps.now ?? (() => Date.now());
  const ttlMs = deps.ttlMs ?? UNPUSHED_TTL_MS;

  const entries = new Map<string, Entry>();
  /** Runs with a read in flight, so a tick every 5s cannot stack reads on a slow checkout. */
  const inFlight = new Set<string>();
  /**
   * The runs the last `observe` saw parked. A read may only commit for a run still in here.
   *
   * The cleanup below can delete only entries that EXIST, and a read in flight has none yet -
   * so without this a run that un-parks mid-read gets its result written back afterwards, into
   * a map nobody will clean again.
   */
  const wanted = new Set<string>();
  /**
   * How many times each run has LEFT the observed set, so a read cannot land across a park.
   *
   * `wanted` alone is not enough: a run can un-park and park again while one read is still in
   * flight, and that read would find its id wanted once more and commit a count measured
   * before the push that un-parked it. The generation is captured when the read starts and
   * re-checked when it lands, so only a read that spans no park at all may speak.
   */
  const generation = new Map<string, number>();

  const refresh = (run: WorkflowRunSummary): void => {
    const id = run.id;
    if (inFlight.has(id)) return;
    inFlight.add(id);
    const startedAt = generation.get(id) ?? 0;
    // Deliberately not awaited, and deliberately cannot reject: `readUnpushedCommits` maps
    // every git failure to an `unknown` observation, and the catch here covers the one thing
    // it cannot - a throw from the seam itself, which a test injects and a real deps bug
    // would produce. An unhandled rejection inside a 5s poll would take the daemon down.
    void (async () => {
      try {
        const obs = await read(deps.checkoutFor(run));
        // Still the same run, still parked, still the same park. Anything else and this
        // answer is about a question that has since been settled - by the very push the
        // Inspector was waiting for, in the case that matters.
        if (wanted.has(id) && (generation.get(id) ?? 0) === startedAt) {
          entries.set(id, { obs, readAt: now() });
        }
      } catch {
        // Claim nothing. Leaving the previous entry in place would let a stale `ahead` outlive
        // the checkout it described, and writing an `unknown` would be a claim we did not make.
        entries.delete(id);
      } finally {
        inFlight.delete(id);
      }
    })();
  };

  return {
    observe(runs) {
      const live = new Set<string>();
      for (const run of runs) {
        if (!wantsObservation(run)) continue;
        live.add(run.id);
        const entry = entries.get(run.id);
        if (!entry || now() - entry.readAt >= ttlMs) refresh(run);
      }
      // Forget runs that moved on. A run that un-parked has had its head observed, so its
      // count is not merely stale - it is about a question nobody is asking any more.
      for (const id of entries.keys()) if (!live.has(id)) entries.delete(id);
      // Count the departure BEFORE `wanted` is rewritten, so a read still in flight for this
      // run can tell that it spanned one.
      for (const id of wanted) {
        if (!live.has(id)) generation.set(id, (generation.get(id) ?? 0) + 1);
      }
      wanted.clear();
      for (const id of live) wanted.add(id);
      // Keep the generation map the size of the interesting set rather than of every run this
      // daemon has ever seen. An id with a read still in flight has to keep its count, because
      // that read has not yet checked it.
      for (const id of generation.keys()) {
        if (!wanted.has(id) && !inFlight.has(id)) generation.delete(id);
      }
    },
    snapshot() {
      const out = new Map<string, UnpushedCommits>();
      for (const [id, entry] of entries) out.set(id, entry.obs);
      return out;
    },
  };
}
