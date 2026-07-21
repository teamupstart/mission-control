// The third axis: which MODEL does the app's own offline work.
//
// Foreman's review/verify/triage/backlog calls, the goal refiner, the task titler, the
// away digest and the Inspector all shell out to a model that is NOT the agent in the
// card. That is a provider choice, independent of the harness being watched - which is
// why this file is nowhere near `Harness`. Folding the two together would mean you could
// not review a Pi session with Claude, or run titling on a cheaper local model.
//
// Pure, and in `shared`, for the reason `cost.ts`, `backlog.ts` and `foreman-models.ts`
// are: the daemon SPAWNS with these answers and the settings panel DISPLAYS them, and a
// panel that describes a runner the daemon does not actually use is a confident wrong
// answer to "what is this running as?". No `node:` imports, no `process.env` reads - the
// web bundle imports this.
//
// WHICH MODEL a given call runs as is deliberately NOT decided here.
// `@shared/model-choice.ts` owns that ladder (config key -> env var -> shipped fallback,
// reporting which of the three won) and the ROLES stay with their subsystem:
// `@shared/foreman-models.ts` holds Foreman's four, `@shared/inspector.ts` its one, and
// `@shared/llm-jobs.ts` the daemon's own background jobs. A runner answers "how is a model
// called"; a role answers "which model". Two questions, and only the first one is this
// file's.

import type { ModelSource } from "./model-choice.ts";

/**
 * Every provider that can do the app's offline work.
 *
 * A `Record<LlmRunnerId, LlmRunner>` (see `src/server/llm/index.ts`) is what makes a new
 * id fail typecheck until it is actually implemented, the same trick
 * `SESSION_FIELD_COMPARATORS` plays on a new `Session` field. Adding an id here and
 * nothing else must not compile.
 */
export const LLM_RUNNER_IDS = ["claude", "codex"] as const;

export type LlmRunnerId = (typeof LLM_RUNNER_IDS)[number];

/**
 * The runner used when nothing says otherwise.
 *
 * `claude` because that is what every offline call is today, and because the CLI is
 * already installed and authenticated on any machine running this app - the operator does
 * not have to hold an API key for the app's own bookkeeping.
 *
 * In `shared` rather than beside `LLM_RUNNERS` because the RESOLVER below is shared: the
 * daemon reads the config from the DB, the Foreman worker reads it off a route, and the
 * settings panel renders what both of them will do. Three readers, one fallback.
 */
export const DEFAULT_LLM_RUNNER_ID: LlmRunnerId = "claude";

/**
 * The `envVar()` suffix naming the runner, so an operator can pin one without the
 * dashboard - the same escape hatch every model id already has.
 *
 * Split from the printed spelling below for the reason `INSPECTOR_MODEL_ENV` is: the
 * daemon looks it up through the `MISSION_` / `FLEET_` / `HARNESS_` chain while the panel
 * prints one name a human can actually export, and two literals would let the printed one
 * drift off the one that works.
 */
export const LLM_RUNNER_ENV = "LLM_RUNNER";

/** The env var as the operator would type it. Shown in the settings panel. */
export const LLM_RUNNER_ENV_VAR = `MISSION_${LLM_RUNNER_ENV}`;

/** A runner id, and which of the three layers chose it. */
export interface ResolvedLlmRunner {
  id: LlmRunnerId;
  source: ModelSource;
  /**
   * The value that was asked for and could not be honoured, or null when nothing was
   * dropped.
   *
   * Reported rather than swallowed: a config naming a runner this build does not have is
   * indistinguishable from an unset one once it has been silently replaced, and the
   * operator would read the panel's "Claude Code" as their own choice rather than as a
   * fallback from the id they typed.
   */
  unknown: string | null;
}

/**
 * Rank the three layers for the RUNNER, the same order `resolveModelChoice` ranks a model
 * id: config, then env, then the shipped default.
 *
 * Separate from `resolveModelChoice` because the two validate differently and must. A
 * model id is free text - the `claude` CLI accepts ids this repo has no business knowing
 * about - while a runner id has to name something in `LLM_RUNNERS` or there is nothing to
 * spawn. An unrecognised one therefore falls back rather than being handed on, which
 * matters in exactly one direction: the config is PERSISTED, so a downgrade (or a runner
 * withdrawn) leaves a stored id this build cannot resolve, and the app has to keep working
 * rather than fail to do its own bookkeeping.
 */
export function resolveLlmRunner(
  configValue: string | null | undefined,
  envValue: string | null | undefined,
): ResolvedLlmRunner {
  for (const [value, source] of [
    [configValue, "config"],
    [envValue, "env"],
  ] as const) {
    const asked = value?.trim();
    if (!asked) continue;
    if (isLlmRunnerId(asked)) return { id: asked, source, unknown: null };
    return { id: DEFAULT_LLM_RUNNER_ID, source: "default", unknown: asked };
  }
  return { id: DEFAULT_LLM_RUNNER_ID, source: "default", unknown: null };
}

/** Whether a string names a runner this build actually has. */
export function isLlmRunnerId(value: string): value is LlmRunnerId {
  return (LLM_RUNNER_IDS as readonly string[]).includes(value);
}

/**
 * A grant of tools to one run, and the two things that have to come with it.
 *
 * These three travel together because they are one decision, not three options. Handing a
 * model tools is what makes an untrusted prompt dangerous; `cwd` is what bounds what those
 * tools can reach, and `denyPaths` is what carves the credential stores back out. A shape
 * that let a caller pass `tools` without the other two would be an interface that makes
 * the unsafe call the easy one.
 *
 * The absence of a grant is the default and the common case: every caller but the
 * Inspector embeds untrusted transcript or repo text in its prompt and needs the model to
 * do nothing but emit JSON. See `LlmRunner.run`.
 */
export interface LlmToolGrant {
  /**
   * Tool names the run may use. Must be non-empty (an empty grant is `null`, not `[]`) and
   * every name must appear in the runner's `sandbox.tools`, or the run is refused.
   */
  tools: readonly string[];
  /**
   * Absolute working directory the run is scoped to.
   *
   * Required, and absolute: under a one-shot run there is nobody to approve a read outside
   * the directory, so the directory IS the read scope. A relative path would resolve
   * against whatever process happened to spawn the run, which is not a scope anyone chose.
   */
  cwd: string;
  /**
   * Path globs no granted tool may read, enforced by the provider rather than by asking
   * the model nicely.
   *
   * Provider-NEUTRAL on purpose: these are globs, not one provider's permission syntax, so
   * a runner that expresses denials differently can still honour them (and one that cannot
   * express them at all declares `sandbox: null` and is never handed a grant).
   */
  denyPaths: readonly string[];
}

export interface LlmRunOptions {
  /**
   * The model id. Omit to inherit whatever the provider defaults to, which is both the
   * priciest and the least predictable choice - every cheap caller should name one.
   */
  model?: string;
  /** Wall-clock budget for the whole call. Omit to take the runner's own default. */
  timeoutMs?: number;
  /**
   * Tools for this run, or `null`/omitted for the default: NOTHING enabled.
   *
   * The default lives here, inside the interface, and not at the call sites. That is the
   * point: it is what makes it safe to put a stranger's transcript in a prompt, and
   * widening it for the one caller that argued for it must not widen it for the rest.
   */
  grant?: LlmToolGrant | null;
}

/**
 * What a runner will accept in a grant, or `null` when it cannot sandbox one at all.
 *
 * `null` is a real answer, not a stub: a runner that cannot bound a tool grant must REFUSE
 * one rather than quietly drop it, because "the provider ignored the deny list" and "the
 * provider honoured it" look identical from the call site until something leaks.
 */
export interface LlmSandboxSpec {
  /**
   * The complete set of tool names a grant may name. Read-only tools only, by
   * construction - a caller cannot reach for a mutating tool without editing the runner,
   * which is where the argument for it belongs.
   */
  tools: readonly string[];
  /**
   * True when `denyPaths` are enforced by the provider itself. False would mean the denial
   * is advisory (a line in the prompt), which is not a sandbox and should be read as one.
   */
  enforcesDenyPaths: boolean;
}

/**
 * Where a runner's finished runs leave files behind, or `null` when they leave nothing.
 *
 * Not a detail: `claude -p` writes a full transcript per run, nothing reads them, and
 * nothing deleted them until `goal/prune.ts` existed - 153 of 250 transcripts sampled on
 * one machine were the app's own. A provider that litters has to say so here, or the
 * sweeper has no way to learn about it short of someone noticing a full disk.
 */
export interface LlmLitterSpec {
  /** Absolute directory the runs pile up in. A function: it can depend on TMPDIR. */
  dir(): string;
  /**
   * Filename suffix the sweep may delete. Never `"*"`: the directory is not necessarily
   * exclusively ours, and a sweep that deletes whatever it finds is a bug waiting for a
   * shared parent directory.
   */
  ext: string;
}

/**
 * One provider of offline model calls.
 *
 * ## The contract, which is not just the signature
 *
 * **Every `run` starts from an empty context.** This is the load-bearing property, and it
 * is a correctness one rather than a nicety. The Foreman reviews MANY sessions: an
 * implementation that carried context between calls would grow that context monotonically
 * across every session it ever looked at, and would let session A's transcript decide the
 * verdict on session B.
 *
 * For `claude -p` the guarantee comes from three flags that are ABSENT - no `--resume`, no
 * `--continue`, no `--session-id` - so it reads like an omission and is not one. The
 * tempting way to lose it is a warm held-open process to skip the spawn: verified, a
 * held-open `--input-format stream-json` process does exactly the wrong thing (turn 2
 * answers questions about turn 1), and measured, the saving is only ~1.8-2.4s of a 4-6s
 * call because the prompt cache is server-side and survives process death. Almost nothing
 * to buy, a correctness property to lose.
 *
 * **A run must not be attributable to a human's session.** A headless run of an agent CLI
 * is that agent, so it fires the same instrumentation a person's session does. An
 * implementation must strip the spawner's terminal identity from the child's environment
 * and mark the run as ours, or its events bind to whichever card the daemon was launched
 * from. That is not hypothetical - it had fused two different real cards onto one headless
 * run's uuid before `headlessEnv()` existed. Test: `claude-cli-headless-env.test.ts`.
 */
export interface LlmRunner {
  id: LlmRunnerId;
  /** Human-facing name, for the settings panel. */
  label: string;

  /**
   * One prompt in, the model's text out. FRESH CONTEXT EVERY CALL - see above.
   *
   * The return value is the model's text with any provider envelope already removed
   * (`claude -p --output-format json` wraps it in `{ result: "…" }`). The envelope belongs
   * to the runner because a different provider has a different one, and a caller that
   * unwraps is undoing what its runner asked for.
   *
   * Rejects on spawn failure, timeout, a non-zero exit, or a grant this runner cannot
   * honour. Never resolves with a partial answer.
   */
  run(prompt: string, opts?: LlmRunOptions): Promise<string>;

  /**
   * Optional: continue ONE conversation, keyed by `threadKey`.
   *
   * `null` when unsupported, which is the current answer for every runner here. If it is
   * ever implemented the key must be a SUPERVISED SESSION, never a process-wide or
   * app-wide thread - one conversation per observed session, never one shared across them,
   * or it reintroduces exactly the cross-session bleed `run` exists to prevent. For
   * `claude -p` the shape is `--session-id <uuid>` then `--resume`.
   */
  runInThread: ((threadKey: string, prompt: string, opts?: LlmRunOptions) => Promise<string>) | null;

  /** What this runner will accept in `LlmRunOptions.grant`, or `null` if it accepts none. */
  sandbox: LlmSandboxSpec | null;

  /** What finished runs leave on disk for the sweeper, or `null` if they leave nothing. */
  litter: LlmLitterSpec | null;

  /**
   * Kill every run this runner started.
   *
   * Required, not optional, and every exit path should call it: these children are
   * deliberately detached (so a session poller cannot mistake one for a real session),
   * which also means they OUTLIVE their parent and keep burning tokens to nowhere.
   */
  killLiveRuns(): void;
}

/**
 * Check a grant against a runner before it reaches the provider. Returns the reason it is
 * refused, or `null` when it is fine.
 *
 * Shared rather than per-runner because every one of these failures is an interface
 * violation rather than a provider quirk, and because a runner that hand-rolled the checks
 * could quietly skip one. Refusing is the whole point - see `LlmSandboxSpec`.
 */
export function grantRefusal(
  sandbox: LlmSandboxSpec | null,
  grant: LlmToolGrant,
): string | null {
  if (!sandbox) return "this runner cannot sandbox a tool grant";
  if (grant.tools.length === 0) return "a grant with no tools: pass no grant instead";
  const unknown = grant.tools.filter((t) => !sandbox.tools.includes(t));
  if (unknown.length > 0) {
    return `tool(s) this runner will not grant: ${unknown.join(", ")}`;
  }
  // Not `path.isAbsolute` - this file may not import `node:path`. A leading slash is the
  // check that matters anyway: the failure being prevented is a path resolved against
  // whatever process spawned the run.
  if (!grant.cwd.startsWith("/")) return `grant cwd must be absolute, got ${grant.cwd || "(empty)"}`;
  return null;
}
