import type {
  SweepContext,
  SweepResult,
  TaskSourceImpl,
  TaskSourceInstance,
  TaskSourceKind,
} from "@shared/task-source.ts";
import { TASK_SOURCE_KINDS } from "@shared/task-source.ts";
import { githubIssues } from "./github-issues.ts";
import { jira } from "./jira.ts";

// The registry of implementations - the server half of the split
// `HARNESS_CAPABILITIES` / `HARNESSES` makes: `TASK_SOURCE_KIND_INFO`
// (@shared/task-source.ts) holds what the browser can answer, and each implementation
// spreads its own info in and adds the two calls that leave the process.
//
// Reach an implementation through `sweepSource` / `preflightSource` below, never by
// testing `inst.kind` at a call site.

/**
 * A registered implementation with its config type ERASED - which is how the daemon
 * holds one, since the sweeper and the routes carry a `TaskSourceInstance` whose
 * `config` is `unknown` by construction.
 */
interface ErasedTaskSource {
  kind: TaskSourceKind;
  label: string;
  blurb: string;
  preflight(config: unknown, ctx: SweepContext): Promise<string | null>;
  sweep(config: unknown, ctx: SweepContext): Promise<SweepResult>;
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
