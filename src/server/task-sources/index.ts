import type {
  PushContext,
  PushDraft,
  PushResult,
  SweepContext,
  SweepResult,
  TaskSourceImpl,
  TaskSourceInstance,
  TaskSourceKind,
  WritebackContext,
  WritebackNotice,
  WritebackResult,
} from "@shared/task-source.ts";
import { TASK_SOURCE_KINDS, TASK_SOURCE_KIND_INFO } from "@shared/task-source.ts";
import { githubIssues } from "./github-issues.ts";
import { jira } from "./jira.ts";

// The registry of implementations - the server half of the split
// `HARNESS_CAPABILITIES` / `HARNESSES` makes: `TASK_SOURCE_KIND_INFO`
// (@shared/task-source.ts) holds what the browser can answer, and each implementation
// spreads its own info in and adds the calls that leave the process.
//
// Reach an implementation through `sweepSource` / `preflightSource` / `pushToSource` /
// `annotateWith` / `resolveWith` below, never by testing `inst.kind` at a call site.

/**
 * A registered implementation with its config type ERASED - which is how the daemon
 * holds one, since the sweeper and the routes carry a `TaskSourceInstance` whose
 * `config` is `unknown` by construction.
 */
interface ErasedTaskSource {
  kind: TaskSourceKind;
  label: string;
  blurb: string;
  /** Mirrors the kind's `canPush`, so one object answers every question about a kind. */
  canPush: boolean;
  preflight(config: unknown, ctx: SweepContext): Promise<string | null>;
  sweep(config: unknown, ctx: SweepContext): Promise<SweepResult>;
  /**
   * Null when this kind cannot receive a pushed task.
   *
   * Null rather than absent, because "this slot exists and is empty" is checkable and
   * `undefined` on an optional property is not distinguishable from a typo in the key.
   */
  push: ((config: unknown, draft: PushDraft, ctx: PushContext) => Promise<PushResult>) | null;
  /** Mirrors the kind's `canAnnotate`, for the reason `canPush` is mirrored. */
  canAnnotate: boolean;
  /** Mirrors the kind's `canResolve`. */
  canResolve: boolean;
  /** Null when this kind cannot write a note back. Null rather than absent, as above. */
  annotate:
    | ((config: unknown, notice: WritebackNotice, ctx: WritebackContext) => Promise<WritebackResult>)
    | null;
  /** Null when this kind cannot mark an item resolved. */
  resolve:
    | ((config: unknown, notice: WritebackNotice, ctx: WritebackContext) => Promise<WritebackResult>)
    | null;
}

/**
 * Erase one implementation's config type by parsing at the boundary.
 *
 * The parse is not a formality: the stored blob was written by an older build, or by a
 * `PUT` against a schema that has since gained a field, and the implementation is
 * entitled to assume its own schema's output. Doing it here means it happens exactly
 * once, on every path, rather than at the top of each `sweep`.
 *
 * A config the schema rejects becomes a REFUSAL, never an empty success - the same rule
 * the implementations are held to, for the same reason: a broken source and a quiet one
 * must not look alike.
 */
function erase<C>(impl: TaskSourceImpl<C>): ErasedTaskSource {
  const reason = (err: { message: string }): string =>
    `this source's settings are not valid for ${impl.kind}: ${err.message}`;
  return {
    kind: impl.kind,
    label: impl.label,
    blurb: impl.blurb,
    canPush: TASK_SOURCE_KIND_INFO[impl.kind].canPush,
    canAnnotate: TASK_SOURCE_KIND_INFO[impl.kind].canAnnotate,
    canResolve: TASK_SOURCE_KIND_INFO[impl.kind].canResolve,
    async preflight(config, ctx) {
      const parsed = impl.configSchema.safeParse(config ?? {});
      if (!parsed.success) return reason(parsed.error);
      return impl.preflight(parsed.data, ctx);
    },
    async sweep(config, ctx) {
      const parsed = impl.configSchema.safeParse(config ?? {});
      if (!parsed.success) return { items: [], error: reason(parsed.error) };
      return impl.sweep(parsed.data, ctx);
    },
    // Same boundary parse, and the same rule about what a rejected blob becomes - except
    // the stakes are higher here than for a sweep. `outcomeUnknown: false` is a FACT: the
    // config never reached an implementation, so no subprocess ran and nothing was
    // published. That is the one direction a caller may safely retry from.
    //
    // Called back through `impl` rather than through a captured reference, exactly as the
    // two above are, so an implementation written as a method keeps its receiver.
    push: impl.push
      ? async (config, draft, ctx) => {
          const parsed = impl.configSchema.safeParse(config ?? {});
          if (!parsed.success) {
            return { ref: null, error: reason(parsed.error), outcomeUnknown: false };
          }
          return impl.push!(parsed.data, draft, ctx);
        }
      : null,
    // The same boundary parse, and the same reading of a rejected blob. `outcomeUnknown:
    // false` is a fact here too: the config never reached an implementation, so nothing
    // was said upstream and the ledger row may be retried once the config is fixed.
    annotate: impl.annotate
      ? async (config, notice, ctx) => {
          const parsed = impl.configSchema.safeParse(config ?? {});
          if (!parsed.success) {
            return { error: reason(parsed.error), outcomeUnknown: false, detail: null };
          }
          return impl.annotate!(parsed.data, notice, ctx);
        }
      : null,
    resolve: impl.resolve
      ? async (config, notice, ctx) => {
          const parsed = impl.configSchema.safeParse(config ?? {});
          if (!parsed.success) {
            return { error: reason(parsed.error), outcomeUnknown: false, detail: null };
          }
          return impl.resolve!(parsed.data, notice, ctx);
        }
      : null,
  };
}

/**
 * Every kind's implementation.
 *
 * `Record<TaskSourceKind, …>` is the enforcement: a kind appended to
 * `TASK_SOURCE_KINDS` does not compile until something here can actually sweep it. The
 * alternative - a lookup that returns undefined - is a source the panel offers, the
 * config accepts, and the sweeper skips in silence.
 */
export const TASK_SOURCES: Record<TaskSourceKind, ErasedTaskSource> = {
  "github-issues": erase(githubIssues),
  jira: erase(jira),
};

/** The kinds this build offers, for the panel's add control. Derived, never hand-kept. */
export function taskSourceKinds(): { kind: TaskSourceKind; label: string; blurb: string }[] {
  return TASK_SOURCE_KINDS.map((kind) => ({
    kind,
    label: TASK_SOURCES[kind].label,
    blurb: TASK_SOURCES[kind].blurb,
  }));
}

/**
 * Sweep one configured source, reporting a thrown implementation as a failure.
 *
 * The catch is the loop's guarantee as much as this call's: one source that throws must
 * not take out the tick that was about to sweep the others, and must not read as "no
 * work" on the way down.
 */
export async function sweepSource(
  inst: TaskSourceInstance,
  ctx: SweepContext,
): Promise<SweepResult> {
  try {
    return await TASK_SOURCES[inst.kind].sweep(inst.config, ctx);
  } catch (err) {
    return { items: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** "Can this run at all?" - null when fine, else a sentence naming the fix. */
export async function preflightSource(
  inst: TaskSourceInstance,
  ctx: SweepContext,
): Promise<string | null> {
  try {
    return await TASK_SOURCES[inst.kind].preflight(inst.config, ctx);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Can this configured source receive a task pushed outward from the backlog?
 *
 * The call-site-safe spelling of the question, so nothing outside this file tests
 * `inst.kind` to decide - which is how a third kind ends up push-capable everywhere
 * except the one branch somebody forgot.
 */
export function canPushTo(inst: TaskSourceInstance): boolean {
  return TASK_SOURCES[inst.kind].canPush;
}

/**
 * Push one task to a configured source, reporting a thrown implementation as a refusal.
 *
 * The catch differs from `sweepSource`'s in what it is allowed to conclude, and the
 * difference is the whole safety property. A throw out of here is OUR code failing -
 * building an argv, reading a result - because `run()` never throws and reports its own
 * `outcomeUnknown` when a child dies. So a throw means the subprocess either never ran or
 * already told us what happened, and `outcomeUnknown: false` is a fact rather than an
 * optimistic default.
 *
 * A kind with no `push` is an ERROR, never a silent success: the caller asked for an item
 * to be published, and "nothing happened, all fine" would leave a task looking filed.
 */
export async function pushToSource(
  inst: TaskSourceInstance,
  draft: PushDraft,
  ctx: PushContext,
): Promise<PushResult> {
  const push = TASK_SOURCES[inst.kind].push;
  if (!push) {
    return {
      ref: null,
      error: `${inst.kind} cannot receive pushed tasks`,
      outcomeUnknown: false,
    };
  }
  try {
    return await push(inst.config, draft, ctx);
  } catch (err) {
    return {
      ref: null,
      error: err instanceof Error ? err.message : String(err),
      outcomeUnknown: false,
    };
  }
}

// ---- the write-back verbs ----
//
// Two more capability/verb pairs, reached the same way and for the same reason: a third
// kind must not end up write-back-capable everywhere except the one branch somebody
// forgot. The difference from `push` is who calls them - the worker, draining a ledger,
// never an operator's click - which is why both of these say what happened rather than
// what was created.

/** Can this configured source write a note back onto an item it swept? */
export function canAnnotateTo(inst: TaskSourceInstance): boolean {
  return TASK_SOURCES[inst.kind].canAnnotate;
}

/** Can this configured source mark an item resolved? */
export function canResolveTo(inst: TaskSourceInstance): boolean {
  return TASK_SOURCES[inst.kind].canResolve;
}

/**
 * Write one note back, reporting a thrown implementation as a refusal.
 *
 * The catch concludes what `pushToSource`'s does, for the identical reason: `run()` never
 * throws and reports its own `outcomeUnknown`, so a throw out of here is OUR code failing
 * before or after the call that left the process. `outcomeUnknown: false` is therefore a
 * fact rather than an optimistic default, and the worker may safely back off and retry.
 *
 * A kind with no `annotate` is an ERROR, never a silent success. A silent success would
 * mark the ledger row `delivered`, which is this feature's version of a task that looks
 * filed upstream when no issue exists.
 */
export async function annotateWith(
  inst: TaskSourceInstance,
  notice: WritebackNotice,
  ctx: WritebackContext,
): Promise<WritebackResult> {
  const annotate = TASK_SOURCES[inst.kind].annotate;
  if (!annotate) {
    return {
      error: `${inst.kind} cannot write back to its items`,
      outcomeUnknown: false,
      detail: null,
    };
  }
  try {
    return await annotate(inst.config, notice, ctx);
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
      outcomeUnknown: false,
      detail: null,
    };
  }
}

/** Mark one item resolved. Same contract as `annotateWith`, on the verb that changes state. */
export async function resolveWith(
  inst: TaskSourceInstance,
  notice: WritebackNotice,
  ctx: WritebackContext,
): Promise<WritebackResult> {
  const resolve = TASK_SOURCES[inst.kind].resolve;
  if (!resolve) {
    return {
      error: `${inst.kind} cannot resolve its items`,
      outcomeUnknown: false,
      detail: null,
    };
  }
  try {
    return await resolve(inst.config, notice, ctx);
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
      outcomeUnknown: false,
      detail: null,
    };
  }
}
