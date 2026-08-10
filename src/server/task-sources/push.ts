import type {
  PushContext,
  PushDraft,
  PushResult,
  TaskSourceInstance,
  TaskSourceRef,
} from "@shared/task-source.ts";
import type { Task } from "@shared/types.ts";
import { inTransaction, recordTaskSourceSeen } from "../db.ts";
import type { TaskManager } from "../tasks.ts";
import { canPushTo, pushToSource } from "./index.ts";

// The outward twin of `ingest.ts`, and the only thing on the push path that writes to our
// database. A source implementation publishes and returns the ref it minted; what becomes
// of that ref is decided here, exactly once, for the same reason ingest concentrates the
// inbound decision: de-duplication that lives in one place cannot be got wrong per kind.
//
// What is at stake is different in this direction, and worse. An inbound mistake files
// junk into a list a human deletes. An outbound one PUBLISHES to a tracker other people
// read, and deleting the local row does not retract it - so the two hazards this file
// exists to prevent are a double-created issue and an issue nobody here remembers
// creating. They pull in opposite directions:
//
//   - Never retry blind. `gh` refusing (`outcomeUnknown: false`) means nothing was
//     published and a retry is safe; `gh` never reporting back means the issue MAY exist,
//     and a retry files a duplicate. Those two must reach the caller as different answers,
//     which is why `PushTaskOutcome` separates `upstream` from `unknown-outcome` and the
//     route maps them to 502 and 504.
//   - Never forget an issue we created. The `task_source_seen` row is what stops this
//     source's next sweep from filing the issue this push just created as a NEW backlog
//     task. It is written in the same transaction as the link, and the one case where they
//     part company is deliberate and documented at step 6 below.

/**
 * The seams a test replaces. Nothing here is a policy choice; they are the I/O.
 *
 * The same shape and the same rationale as `IngestDeps`: the decisions - which refusals
 * come before the subprocess, what an unknown outcome means, what commits together - stay
 * in the function, so a test that swaps these is testing the real ordering rather than a
 * parallel one.
 */
export interface PushDeps {
  /** Publish the draft upstream and report what was created. */
  push?: (
    inst: TaskSourceInstance,
    draft: PushDraft,
    ctx: PushContext,
  ) => Promise<PushResult>;
  /** Remember that this source has filed this item, so its next sweep does not re-file it. */
  remember?: (sourceId: string, externalId: string, url: string | null) => void;
  /** Run the two writes together. */
  transaction?: <T>(fn: () => T) => T;
  log?: (msg: string) => void;
}

/**
 * What one push did.
 *
 * Four failure kinds rather than a boolean plus a message, because the caller's correct
 * response differs in each and a sentence cannot be branched on:
 *
 *  - `unpushable`: this KIND has no outward verb. A request that could never work - the
 *    route's 400.
 *  - `conflict`: the task or the source is not in a state this can act on. Nothing was
 *    published; the operator can see the reason and resolve it - the route's 409.
 *  - `upstream`: the external system refused. Nothing was published, so a retry is safe -
 *    the route's 502.
 *  - `unknown-outcome`: the item may exist upstream and we cannot tell. NEVER retry this
 *    blind - the route's 504, and the reason this type is not three kinds.
 */
export type PushTaskOutcome =
  | { ok: true; task: Task }
  | {
      ok: false;
      kind: "unpushable" | "conflict" | "upstream" | "unknown-outcome";
      error: string;
    };

/**
 * Task ids with a push in flight right now.
 *
 * Module-level, mirroring the sweeper's `entry.sweeping`, and for a sharper version of the
 * same reason. Two concurrent pushes of one task both pass the `task.source === null`
 * guard - the first has not linked anything yet, because `gh` is still running - and both
 * create an issue. The DB cannot catch that: the second issue is a genuinely new external
 * item with its own id, so nothing about it looks like a duplicate by the time it exists.
 * The window has to be closed BEFORE the subprocess, which is what this does.
 *
 * It is per PROCESS, which is the whole scope that needs covering: the daemon is the only
 * thing that pushes, and the port bind is the mutex that makes it the only daemon.
 */
const inFlight = new Set<string>();

/**
 * File one backlog task as an item in the external system, and record what was created.
 *
 * In order, and the order is the design:
 *
 *  1. Kind capability. Asked through `canPushTo`, never by testing `inst.kind`.
 *  2. Task and source state - not backlog, already linked, different repo. All three are
 *     cheap, local, and certain, so they refuse BEFORE anything is spawned and a refusal
 *     therefore carries a guarantee that nothing was published.
 *  3. The in-flight claim, held across the subprocess in try/finally.
 *  4. The push itself - the one call that leaves the process.
 *  5. The unknown outcome, separated from the refusal, before either is reported.
 *  6. The seen row and the link, in ONE transaction, remember-first.
 *
 * Steps 1-3 are what "cheap local refusals before any subprocess" means, and phase 3's UI
 * depends on it: the modal filters the sources it offers by the identical comparisons, so
 * the server never refuses what the UI offered.
 */
export async function pushTask(
  inst: TaskSourceInstance,
  task: Task,
  tasks: TaskManager,
  deps: PushDeps = {},
): Promise<PushTaskOutcome> {
  const push = deps.push ?? pushToSource;
  const remember = deps.remember ?? recordTaskSourceSeen;
  const transaction = deps.transaction ?? inTransaction;
  const log = deps.log ?? ((m: string) => console.log(`[task-source] ${m}`));

  // 1. A kind that declares no outward verb. Distinct from every refusal below because it
  //    is a fact about the BUILD rather than about this task: no state change makes it
  //    work, so the caller should stop asking rather than resolve something.
  if (!canPushTo(inst)) {
    return {
      ok: false,
      kind: "unpushable",
      error: `${inst.kind} cannot receive pushed tasks`,
    };
  }

  // 2. State. Each of these is also re-checked inside the transaction by `attachSource`,
  //    because `gh` runs in between - but they are asked here FIRST so the common refusal
  //    costs no subprocess and, more importantly, publishes nothing.
  if (task.status !== "backlog") {
    return {
      ok: false,
      kind: "conflict",
      error: `task is ${task.status}, not in the backlog`,
    };
  }
  if (task.source) {
    return {
      ok: false,
      kind: "conflict",
      error: `task is already linked to ${task.source.externalId}`,
    };
  }
  // String equality, deliberately, and NOT a re-resolution. Both paths were resolved to a
  // git root when they were stored (the dispatch route for the task, the task-sources PUT
  // for the source), so comparing the stored values compares what the operator actually
  // configured. Re-resolving here would consult a filesystem that may have moved since,
  // and could refuse a pair the UI - which cannot run git - had every reason to offer.
  if (inst.repoRoot !== task.repoRoot) {
    return {
      ok: false,
      kind: "conflict",
      error: `this source files against ${inst.repoRoot}, and this task is based on ${task.repoRoot}`,
    };
  }

  // 3. See `inFlight`. Claimed before the subprocess starts and released only once the
  //    writes are done - the claim spans steps 4 to 6 rather than just the `await`,
  //    because "an issue exists but is not yet recorded" is precisely the state a second
  //    push must not be allowed to observe.
  if (inFlight.has(task.id)) {
    return {
      ok: false,
      kind: "conflict",
      error: "a push for this task is already running",
    };
  }
  inFlight.add(task.id);

  try {
    // 4. `signal` is shape parity with `SweepContext` and nothing more - see
    //    `TaskSourceImpl.push`. Nothing aborts it, because `run()` takes no signal and a
    //    push that has already reached GitHub cannot be un-sent by observing one. The real
    //    bounds on a wedged push are the implementation's own subprocess timeout and the
    //    in-flight claim above, which the finally releases either way.
    let result: PushResult;
    try {
      result = await push(
        inst,
        { title: task.title, intent: task.intent },
        { sourceId: inst.id, repoRoot: inst.repoRoot, signal: new AbortController().signal },
      );
    } catch (err) {
      // A THROW out of the one call that reaches the external system, which is a different
      // event from the `PushResult` it was supposed to return - and it must not escape into
      // the route, because an uncaught error arrives at the caller as a generic failure with
      // no `outcomeUnknown` on it, which is indistinguishable from a retry-safe refusal.
      // That is the double-created issue this file exists to prevent, entering through the
      // one door that was left open.
      //
      // Classified as UNKNOWN rather than as a refusal, and the asymmetry with
      // `pushToSource`'s own catch is deliberate. That one may conclude "nothing was
      // published" because it wraps the implementation call and knows `run()` never throws,
      // so a throw inside it is our own code failing before or after the subprocess. This
      // one wraps the SEAM - an injected `push`, a registry lookup, a future refactor of
      // that guarantee - and from here an exception says nothing about which side of the
      // request it fell on. "No information about whether it landed" is the definition of
      // `unknown-outcome`, and the alternative is an optimistic default in the one place
      // this feature cannot afford one.
      const why = err instanceof Error ? err.message : String(err);
      log(
        `${inst.label || inst.id}: push of "${task.title}" threw (${why}) - ` +
          `nothing was recorded here; check the external system before retrying`,
      );
      return {
        ok: false,
        kind: "unknown-outcome",
        error: `the push failed unexpectedly: ${why} - the item may exist; check before retrying`,
      };
    }

    // 5. Asked BEFORE the error, because an unknown outcome usually carries an error
    //    message too and reading that first would collapse the distinction this whole file
    //    is built around. Nothing is written on either path: a seen row here would suppress
    //    the sweep that is the operator's best way of finding out whether the issue exists.
    if (result.outcomeUnknown) {
      log(
        `${inst.label || inst.id}: push of "${task.title}" did not report back - ` +
          `nothing was recorded here; check the external system before retrying`,
      );
      return {
        ok: false,
        kind: "unknown-outcome",
        error:
          result.error ?? "the push did not report back - the item may exist; check before retrying",
      };
    }
    if (result.error || !result.ref) {
      return {
        ok: false,
        kind: "upstream",
        error: result.error ?? "the push reported neither an item nor an error",
      };
    }
    const ref: TaskSourceRef = result.ref;

    // 6. The pair, together. Remember FIRST, and never conditionally: from this line on an
    //    issue exists upstream, and the sweep that would otherwise re-file it as a new
    //    backlog task must be stopped whatever happens to the link.
    //
    //    Which is exactly the case below. `attachSource` RETURNS its refusals rather than
    //    throwing (a throw would roll this transaction back), so a task DELETED while `gh`
    //    was running still commits its seen row - and the operator is told the issue's
    //    name, because it is real and this is the last place it is known. A task merely
    //    dispatched mid-push is not that case: it still takes the link, because the issue
    //    was created for it and provenance is not a provisioning field (`attachSource`).
    let attached: { ok: boolean; error?: string; task?: Task };
    try {
      attached = transaction(() => {
        remember(inst.id, ref.externalId, ref.url);
        return tasks.attachSource(task.id, ref);
      });
    } catch (err) {
      // The transaction rolled back, so neither write landed - but the ISSUE still exists.
      // Reported as an unknown outcome rather than as a refusal for exactly that reason: a
      // retry would file a second issue, which is the one thing this file exists to
      // prevent. "Retry-safe" is a claim about what is upstream, not about what we managed
      // to write down.
      const why = err instanceof Error ? err.message : String(err);
      log(`${inst.label || inst.id}: created ${ref.externalId} but could not record it: ${why}`);
      return {
        ok: false,
        kind: "unknown-outcome",
        error: `created ${ref.externalId}, but recording it here failed: ${why} - the issue exists; do not push again`,
      };
    }

    if (!attached.ok || !attached.task) {
      const why = attached.error ?? "the task could not be linked";
      log(`${inst.label || inst.id}: created ${ref.externalId}, but could not link it: ${why}`);
      return {
        ok: false,
        kind: "conflict",
        error: `created ${ref.externalId}, but it could not be linked (${why}) - the issue exists and will not be re-swept`,
      };
    }

    log(`${inst.label || inst.id}: pushed "${task.title}" as ${ref.externalId}`);
    return { ok: true, task: attached.task };
  } finally {
    inFlight.delete(task.id);
  }
}
