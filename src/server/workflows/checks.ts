import { createLimiter } from "../llm/structured.ts";
import { resolveRepoPath } from "../repos.ts";
import {
  WORKFLOW_EXECUTION_LIMITS,
  checkBlockedReason,
  checkCommandSubpath,
  formatCheckCommand,
  resolveWorkflowCommand,
  type WorkflowCheckOutcome,
  type WorkflowCheckSlot,
  type WorkflowCommandView,
  type WorkflowPolicy,
} from "@shared/workflow.ts";

// What a Check node decides, and everything about that decision that does NOT need a
// process.
//
// The ladder here is the whole gate: which command applies, whether the operator authorized
// running one, and what an exit code means. Only the last rung spawns anything, and it is
// reached through `CheckRunDeps.execute` - a seam, in the `PaneDeps.pane` shape, so this
// module's rules are driven by tests with nothing installed and the execution runtime is a
// separate implementation unit that plugs in behind one function type.
//
// THE THREE PASSING OUTCOMES ARE THE POINT. A gate nobody configured, a gate nobody
// authorized, and a gate no runtime can serve are all things the operator has to be told
// about and none of them is evidence against the change under review. Each returns a
// sentence and lets the graph advance; only a command that ran and exited non-zero fails.
// A shipped workflow carrying check gates has to be safe on a machine that configured none
// of them, or it is a shipped workflow that is broken by default.

/**
 * Why an attempt could not produce a verdict at all.
 *
 * Separated from a `failed` outcome because the engine already enforces "an infrastructure
 * problem is never a fail verdict" for Personas, and a check has strictly more ways to hit
 * one. A timeout, an out-of-memory kill, a lease that could not be taken: none of them is a
 * statement about the submission, and all of them belong on the retry-then-block path.
 */
export interface CheckInfrastructureFailure {
  kind: "infrastructure";
  reason: string;
}

export type CheckResult =
  | { kind: "outcome"; outcome: WorkflowCheckOutcome }
  | CheckInfrastructureFailure;

/** What the execution runtime is asked to do, once the ladder has decided it should run. */
export interface CheckExecutionRequest {
  slot: WorkflowCheckSlot;
  /** argv, never a shell string. Nothing downstream has a shell. */
  command: string[];
  /** The repository the submission belongs to, for the runtime to resolve a checkout from. */
  repoRoot: string;
  /**
   * Where inside that checkout the command runs, relative to its root. `""` is the root.
   *
   * Present because command resolution lets a nested entry beat a repository-wide one - the
   * monorepo case, where `/repo/packages/web` overrides `/repo`. Without this the runtime
   * receives only the repository and would run the package's command at the top of the
   * tree, which for most build tools succeeds against the wrong target rather than failing
   * loudly.
   *
   * RELATIVE on purpose: the runtime runs in a pooled worktree pinned to the captured
   * commit, not in the operator's own directory, so this is joined onto whatever tree it
   * leased. See `checkCommandSubpath`.
   */
  workingSubpath: string;
  /** The commit the submission captured, or null when the capture recorded none. */
  headSha: string | null;
}

export type CheckExecutionResult =
  /** The command ran to completion and reported this. */
  | { kind: "exited"; exitCode: number; output: string; truncatedBytes: number }
  /** The configured executable is not there. A settings problem, not a defect. */
  | { kind: "unavailable"; note: string }
  /** It could not be run, or died without answering. Never a fail. */
  | { kind: "infrastructure"; reason: string };

export type CheckExecutor = (request: CheckExecutionRequest) => Promise<CheckExecutionResult>;

/**
 * Where the session's directory sits inside its own checkout, or null when git cannot say.
 *
 * A dependency rather than a direct call because it is the one part of resolution that
 * leaves the process, and because a test asserting which package was selected should not
 * need a real monorepo on disk.
 */
export type CheckoutSubpathResolver = (
  cwd: string,
  repoRoot: string,
) => Promise<string | null>;

export interface CheckRunDeps {
  /** Defaults to asking git. Null is a legitimate answer and declines nested matching. */
  checkoutSubpath?: CheckoutSubpathResolver;
  /**
   * The execution runtime, or null when this build has none.
   *
   * Null is the shipped answer today and it is a first-class one, not a stub: the runtime a
   * check needs is a pooled worktree leased and pinned to the captured commit, a streaming
   * process group that can be torn down with its descendants, a durable lease registry that
   * survives a restart, and a holder-verified idempotent return. That is its own
   * implementation unit, and shipping the node with the runtime absent is honest - a check
   * reports `unavailable` with a sentence and passes, which is the identical, already-tested
   * degradation an unauthorized repository takes.
   *
   * What must NOT happen is the tempting shortcut: running the command in the binding's
   * `sessionRepoRoot`. That names the shared main repository behind a linked worktree, so on
   * the common dispatch shape - a session in a pooled tree under `~/.treehouse/` - it would
   * test an unrelated checkout and report the answer as if it were about this submission.
   */
  execute?: CheckExecutor | null;
}

/**
 * How many check commands the daemon runs at once.
 *
 * Small on purpose, and separate from `ReviewScheduler` on purpose. That scheduler's own
 * comment defines its membership as tool-less MODEL calls with a ceiling of three; a check
 * is a build, and one three-minute test suite sharing that budget would leave a single slot
 * for every Persona review in the daemon.
 */
export const DEFAULT_CHECK_CONCURRENCY = 2;

/** Runs `fn` once the shared check budget has a slot. Same shape as `ReviewScheduler`. */
export type CheckScheduler = <T>(fn: () => Promise<T>) => Promise<T>;

export function createCheckScheduler(
  concurrency: number = DEFAULT_CHECK_CONCURRENCY,
): CheckScheduler {
  return createLimiter(concurrency);
}

/** The sentence a build with no execution runtime gives, in one place so tests can name it. */
export const CHECK_RUNTIME_UNAVAILABLE_NOTE =
  "This build cannot run workflow Commands yet, so the gate was recorded and passed.";
const encoder = new TextEncoder();

function outcome(
  slot: WorkflowCheckSlot,
  status: WorkflowCheckOutcome["status"],
  note: string,
  over: Partial<WorkflowCheckOutcome> = {},
): CheckResult {
  return {
    kind: "outcome",
    outcome: {
      status,
      slot,
      command: null,
      exitCode: null,
      output: "",
      truncatedBytes: 0,
      note,
      ...over,
    },
  };
}

/**
 * Keep the LAST `maxBytes` UTF-8 bytes, because a failing build's useful lines are its last ones.
 *
 * A compiler prints its summary at the end and a test runner prints its failures there; a
 * head-biased clip of a 40,000-line build log is 4,000 bytes of dependency resolution.
 */
export function tailBounded(
  text: string,
  maxBytes: number,
): { text: string; droppedBytes: number } {
  const totalBytes = encoder.encode(text).byteLength;
  if (totalBytes <= maxBytes) return { text, droppedBytes: 0 };
  const kept: string[] = [];
  let keptBytes = 0;
  for (const scalar of [...text].reverse()) {
    const scalarBytes = encoder.encode(scalar).byteLength;
    if (keptBytes + scalarBytes > maxBytes) break;
    kept.push(scalar);
    keptBytes += scalarBytes;
  }
  return {
    text: kept.reverse().join(""),
    droppedBytes: totalBytes - keptBytes,
  };
}

function checkOutcomeNote(command: readonly string[], suffix: string): string {
  const printed = formatCheckCommand(command);
  const commandLimit = WORKFLOW_EXECUTION_LIMITS.verdictSummary - suffix.length - 2;
  if (printed.length <= commandLimit) return `\`${printed}\`${suffix}`;
  let prefix = printed.slice(0, Math.max(0, commandLimit - 1));
  const last = prefix.charCodeAt(prefix.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) prefix = prefix.slice(0, -1);
  return `\`${prefix}…\`${suffix}`;
}

/**
 * The session's directory relative to the root of the checkout it is standing in.
 *
 * `resolveRepoPath` already expresses a path against the repository that owns its tree -
 * which is exactly this question for a pooled worktree, whose own root is not the
 * repository. Reused rather than reimplemented so Settings and resolution agree about what
 * "inside the repository" means; they were two answers to one question before.
 */
async function defaultCheckoutSubpath(cwd: string, repoRoot: string): Promise<string | null> {
  const resolved = await resolveRepoPath(cwd);
  if (!resolved) return null;
  // A cwd whose repository is not this session's says nothing about this session.
  if (trimTrailingSlash(resolved.repoRoot) !== trimTrailingSlash(repoRoot)) return null;
  return checkCommandSubpath(resolved.repoRoot, resolved.path);
}

function trimTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

/**
 * Decide one Check node.
 *
 * `cwd` and `repoRoot` are both taken because a binding records both and they answer
 * different halves of the same question - see `resolveWorkflowCommand`.
 */
export async function runCheck(
  input: {
    slot: WorkflowCheckSlot;
    /**
     * This slot's entry in the Global Command catalog, or null when the caller has none.
     *
     * Handed IN rather than looked up. Resolution is a pure function of the catalog entry
     * and the session's location, and a runtime that queried SQLite for it would be a second
     * reader of a catalog the daemon already owns - and one no test could drive.
     */
    command: WorkflowCommandView | null;
    /**
     * Authorisation, separately. It is asked AFTER resolution and it is not a property of
     * the command: the same argv is authorised in one repository and not in another.
     */
    policy: Pick<WorkflowPolicy, "checksEnabled" | "repoAllowlist">;
    cwd: string | null;
    repoRoot: string | null;
    headSha: string | null;
  },
  deps: CheckRunDeps = {},
): Promise<CheckResult> {
  const { slot, policy } = input;

  // Unconfigured is asked FIRST, before consent. A repository nobody wrote a command for is
  // not a repository the operator failed to authorize, and telling them to switch checks on
  // would send them to a setting that would change nothing.
  // Derived BEFORE resolution, because a nested entry can only be chosen by comparing the
  // session's position inside its own checkout - see `resolveWorkflowCommand`'s third
  // applicability route. Null (no cwd, no repository, or git could not say) declines nested
  // matching and lands on the repository-wide entry, which is the safe direction.
  const checkoutSubpath = input.cwd && input.repoRoot
    ? await (deps.checkoutSubpath ?? defaultCheckoutSubpath)(input.cwd, input.repoRoot)
    : null;
  const resolved = resolveWorkflowCommand(
    input.command,
    { cwd: input.cwd, repoRoot: input.repoRoot, checkoutSubpath },
  );
  if (!resolved) {
    return outcome(
      slot,
      "skipped",
      `No ${slot} Command is configured for this machine or repository, so this gate was `
      + "skipped.",
    );
  }
  const command = resolved.command;

  const blocked = checkBlockedReason(policy, input.cwd, input.repoRoot);
  if (blocked) return outcome(slot, "unavailable", blocked, { command });

  // A configured command with no repository to run it in cannot be located, and guessing one
  // is how a gate ends up testing somebody else's checkout.
  if (!input.repoRoot) {
    return outcome(
      slot,
      "unavailable",
      "This session reported no repository, so there was nowhere to run the command.",
      { command },
    );
  }

  const execute = deps.execute ?? null;
  if (!execute) {
    return outcome(slot, "unavailable", CHECK_RUNTIME_UNAVAILABLE_NOTE, { command });
  }

  const result = await execute({
    slot,
    command,
    repoRoot: input.repoRoot,
    // Carried by the entry that WON, not derived from the binding, so a nested monorepo
    // override runs where it was configured rather than at the top of the repository - and a
    // global default, which names no repository, runs at the checkout root.
    workingSubpath: resolved.workingSubpath,
    headSha: input.headSha,
  });
  if (result.kind === "infrastructure") return { kind: "infrastructure", reason: result.reason };
  if (result.kind === "unavailable") {
    return outcome(slot, "unavailable", result.note, { command });
  }

  const bounded = tailBounded(result.output, WORKFLOW_EXECUTION_LIMITS.checkOutput);
  // The runtime counts the bytes it dropped while streaming; this only adds what the final
  // clip dropped on top. Summing rather than overwriting is what keeps the figure exact
  // instead of reporting the last truncation as if it were the only one.
  const truncatedBytes = result.truncatedBytes + bounded.droppedBytes;
  return result.exitCode === 0
    ? outcome(slot, "passed", checkOutcomeNote(command, " passed."), {
        command,
        exitCode: 0,
        output: bounded.text,
        truncatedBytes,
      })
    : outcome(slot, "failed", checkOutcomeNote(command, ` exited ${result.exitCode}.`), {
        command,
        exitCode: result.exitCode,
        output: bounded.text,
        truncatedBytes,
      });
}
