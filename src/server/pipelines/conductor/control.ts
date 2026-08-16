import {
  pipelineGrantRefusal,
  type PipelineAction,
  type PipelineActionResult,
} from "@shared/pipeline.ts";

import { run, type RunResult } from "../../util/exec.ts";
import { conductorBin } from "./probe.ts";

// Asking ai-conductor to do something, and finding out whether it did.
//
// This is the one file in `src/server/pipelines/` that is not a read, and the boundary it
// holds is the whole reason it exists rather than a few `writeFile` calls somewhere: it
// spawns the ENGINE'S OWN CLI and never touches a file the engine owns. Park markers, grant
// records, the pidfile and the pause marker are all written by conductor, in response to a
// verb, exactly as they are when a person types it. That is what keeps the projection a read
// of one program's state instead of a negotiation between two - and it is not fastidiousness,
// because that state is lease- and CAS-guarded and a second writer racing the engine's own
// atomic renames is a corrupted feature, not a merge conflict.
//
// **THE EXIT CODE IS NOT THE ANSWER.** Read this before adding a verb.
//
// conductor's `engineer` verbs print their usage guide and `return 0` for every missing
// required flag - its own `docs/reference/cli.md` calls that out as a known limitation and
// says to check stdout instead. The same shape reaches further than `engineer`: a malformed
// `decide-grant`, a malformed `reseal` and a slug-less `daemon park` are rejected by
// conductor's argv detectors before any of those verbs is reached, so what runs is the
// generic "the inline SDLC pipeline now runs under the `inline` subcommand" refusal - a
// message that never mentions the verb we asked for. A zero from any of them says only that
// a process started and stopped.
//
// So every verb below carries a `confirms` predicate over what conductor PRINTED, and that
// predicate is the success signal. The exit code is a precondition, not evidence: a non-zero
// exit or a child that died without reporting one is enough to fail an action, but a zero is
// never enough to pass it. `daemon stop` is the interesting case - it prints nothing at all
// when it works - so its predicate is the absence of output, which is a real assertion here
// precisely because conductor writes its supervisor errors to STDOUT rather than stderr.
//
// Verified against ai-conductor `8b51392d`. Every predicate matches a PREFIX of conductor's
// sentence rather than the whole of it, so a release that extends a message keeps working;
// what it must not do is match a different message, which is why none of them is a bare
// substring of a common word.

/**
 * How long each verb gets.
 *
 * `daemon start` is the outlier by an order of magnitude, and not because starting a tmux
 * session is slow: it first runs the engine's own `bin/install --check` with inherited
 * stdio, which walks a skills tree. Everything else is a marker file or a `tmux send-keys`.
 */
const VERB_TIMEOUT_MS = 10_000;
const START_TIMEOUT_MS = 60_000;

/** How much of the engine's output travels back to the browser on a failure. */
const MAX_OUTPUT_CHARS = 4000;

/** What a verb needs to name the thing it acts on. */
export interface ConductorControlTarget {
  /**
   * The MAIN checkout root, always.
   *
   * Two of these verbs resolve nothing for themselves. `decide-grant` and `reseal` join
   * `.daemon/grants` and `.worktrees/<slug>` straight onto `process.cwd()` with no
   * `git rev-parse`, so running either from inside a feature worktree writes a grant that
   * authorizes nothing - and exits 0 having printed its success line. The consented
   * `repoRoot` is already a resolved git root (`PUT /api/pipelines/config` runs it through
   * `resolveRepoRoot`), which is what makes passing it here correct rather than hopeful.
   */
  repoRoot: string;
  slug: string | null;
  step: string | null;
  reason: string | null;
}

/** One verb: what to spawn, and how to recognise that it worked. */
interface ConductorVerb {
  argv: (target: ConductorControlTarget) => string[];
  timeoutMs: number;
  /**
   * Did conductor do the thing?
   *
   * Reads the combined output because conductor is not consistent about which stream it
   * uses and the inconsistency is per verb: the supervisor verbs print even their errors to
   * stdout, `decide-grant` and `reseal` refuse on stderr, and `daemon park` writes stdout
   * synchronously so a refusal survives `process.exit`. A predicate that picked the wrong
   * stream would read a refusal as silence, and silence is `daemon stop`'s success.
   */
  confirms: (out: { stdout: string; stderr: string }, target: ConductorControlTarget) => boolean;
  /** The sentence shown when `confirms` was true. */
  success: (target: ConductorControlTarget) => string;
}

/** A conductor sentence naming this exact feature, as a matcher over its first word. */
function quoted(slug: string | null): string {
  return `'${slug ?? ""}'`;
}

/**
 * Escape a value for use inside a regular expression.
 *
 * Slugs are directory names and steps come off a frozen table, so neither is likely to carry
 * a metacharacter - but "likely" is not a guarantee about a string that arrived over a route,
 * and an unescaped `.` in a slug turns a confirmation matcher into one that accepts a
 * DIFFERENT feature's success line.
 */
function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The verb table, keyed by the wire vocabulary.
 *
 * `Record<PipelineAction, ConductorVerb>` is the enforcement, exactly as the provider
 * registry is: a verb appended to `PIPELINE_ACTIONS` does not compile until somebody has
 * said what conductor is asked to run AND how its answer is recognised. A verb with argv and
 * no predicate is the failure this shape prevents - it would report every invocation as a
 * success, including the ones conductor never understood.
 */
const VERBS: Record<PipelineAction, ConductorVerb> = {
  "daemon-start": {
    // `-D` rather than a bare start, and it is not a preference. Without it conductor
    // decides what to do from `process.stdin.isTTY`: with no terminal it prints a different
    // sentence, and with one - which a daemon spawned from a shell can have - it hands the
    // terminal over to `tmux attach-session` and does not return. Detached is the only
    // outcome a subprocess can ask for and then observe.
    argv: () => ["daemon", "start", "-D"],
    timeoutMs: START_TIMEOUT_MS,
    // Anchored to a line rather than to the start of the output, because conductor runs its
    // own installation freshness check first with inherited stdio - so the confirmation is
    // preceded by however many lines that check felt like printing.
    confirms: ({ stdout }) => /^daemon started\b/m.test(stdout),
    success: () => "The engine daemon is running in this repository.",
  },
  "daemon-stop": {
    argv: () => ["daemon", "stop"],
    timeoutMs: VERB_TIMEOUT_MS,
    /**
     * SILENCE is the success, and it is a real assertion rather than a shrug.
     *
     * `daemon stop` prints nothing when it works - including when there was nothing running,
     * because killing the session is idempotent - and prints its failures to STDOUT, not
     * stderr. So any output at all is conductor telling us something went wrong, and an
     * empty stdout beside a clean exit is the only shape a successful stop has. This is the
     * one verb where the caller's exit-code precondition is carrying real weight, which is
     * why it is stated here rather than assumed.
     */
    confirms: ({ stdout, stderr }) => stdout.trim() === "" && stderr.trim() === "",
    success: () => "The engine daemon is stopped. Nothing in this repository advances now.",
  },
  "daemon-pause": {
    argv: () => ["daemon", "pause"],
    timeoutMs: VERB_TIMEOUT_MS,
    // Both arms are successes: an operator who pauses an already-paused daemon got what they
    // asked for, and reporting that as a failure would put a red flash on a correct state.
    confirms: ({ stdout }) => /^(daemon paused|already paused)$/m.test(stdout.trim()),
    success: () => "The engine daemon is paused. A step already running still finishes.",
  },
  "daemon-resume": {
    argv: () => ["daemon", "resume"],
    timeoutMs: VERB_TIMEOUT_MS,
    confirms: ({ stdout }) => /^(daemon resumed|not paused)$/m.test(stdout.trim()),
    success: () => "The engine daemon is dispatching again.",
  },
  park: {
    // A BARE POSITIONAL, not a flag. There is no `--slug` on this verb, and conductor's
    // detector returns null without one - which falls through to a refusal about the inline
    // pipeline that never mentions parking.
    argv: ({ slug }) => ["daemon", "park", slug ?? ""],
    timeoutMs: VERB_TIMEOUT_MS,
    // Two shapes, both successes: a fresh park leads with `Parked '<slug>'`, and one that
    // was already parked says so. Matched on the prefix each sentence opens with, so the
    // clause conductor appends after it - which is prose, and moves - is not part of the test.
    confirms: ({ stdout }, { slug }) =>
      new RegExp(`^Parked ${escapeRe(quoted(slug))}`, "m").test(stdout) ||
      new RegExp(`^${escapeRe(quoted(slug))} is already parked`, "m").test(stdout),
    success: ({ slug }) => `${slug} is parked. The engine will not dispatch or re-kick it.`,
  },
  unpark: {
    argv: ({ slug }) => ["daemon", "unpark", slug ?? ""],
    timeoutMs: VERB_TIMEOUT_MS,
    confirms: ({ stdout }, { slug }) =>
      new RegExp(`^Unparked ${escapeRe(quoted(slug))}`, "m").test(stdout) ||
      new RegExp(`^${escapeRe(quoted(slug))} was not operator-parked`, "m").test(stdout),
    success: ({ slug }) => `${slug} is unparked. Normal dispatch and re-kick resume.`,
  },
  grant: {
    // A top-level verb rather than a `daemon` subcommand, and its detector is strict: exactly
    // these three flags, each once, each with a value. An extra flag or a repeated one is not
    // a warning - the whole invocation is rejected before the verb runs.
    argv: ({ slug, step, reason }) => [
      "decide-grant",
      "--slug",
      slug ?? "",
      "--step",
      step ?? "",
      "--reason",
      reason ?? "",
    ],
    timeoutMs: VERB_TIMEOUT_MS,
    confirms: ({ stdout }, { slug, step }) =>
      new RegExp(
        `^DECIDE grant recorded for ${escapeRe(quoted(step))} in ${escapeRe(quoted(slug))}\\.$`,
        "m",
      ).test(stdout),
    success: ({ slug, step }) =>
      `${slug} may enter ${step} once. The engine spends the grant on its next dispatch.`,
  },
};

/** Everything the engine said, clipped to something a browser can draw. */
function captured(result: RunResult): string {
  const both = [result.stdout.trim(), result.stderr.trim()].filter((part) => part !== "").join("\n");
  return both.length > MAX_OUTPUT_CHARS ? `${both.slice(0, MAX_OUTPUT_CHARS)}\n…` : both;
}

/**
 * Why an invocation that produced no confirmation failed, in one sentence.
 *
 * Ordered by how specific the evidence is. A child that died without reporting an exit is
 * the least informative and the most alarming, so it is named first rather than folded into
 * "the engine refused"; a non-zero exit is conductor deciding against us; and an exit of
 * zero with no confirmation is the case this whole module exists for, so it says exactly
 * that rather than pretending the command failed.
 */
function refusal(result: RunResult, bin: string): string {
  if (result.outcomeUnknown) {
    return `${bin} did not report an outcome - it was killed, or it timed out.`;
  }
  if (result.overflowed) return `${bin} printed more output than this daemon will read.`;
  if (result.code !== 0) return `${bin} refused this. Its own words are below.`;
  return (
    `${bin} exited cleanly without confirming it did this, which is what a malformed ` +
    "invocation looks like. Nothing here assumed it worked."
  );
}

/**
 * Ask conductor to do one thing, and report what it said about it.
 *
 * Never throws: `run` is total, and a caller drawing a control surface needs a sentence for
 * every outcome including "the binary is not there". Never writes: the only side effects are
 * conductor's own.
 */
export async function runConductorControl(
  action: PipelineAction,
  target: ConductorControlTarget,
): Promise<PipelineActionResult> {
  const bin = conductorBin();
  const verb = VERBS[action];
  const args = verb.argv(target);
  const command = [bin, ...args].join(" ");

  // Refused HERE rather than relayed from conductor, and that is the difference between an
  // explanation and an error message. conductor does refuse `--step plan` itself - in four
  // independent places - but what it prints is a line on stderr behind exit code 2, and a
  // surface that spawned a subprocess to learn something it already knew would be teaching
  // an operator by rejection. See `pipelineGrantRefusal`.
  if (action === "grant") {
    const refused = target.step === null ? "a grant names a step" : pipelineGrantRefusal("ai-conductor", target.step);
    if (refused) return { ok: false, action, command, detail: refused, output: "" };
  }

  const result = await run(bin, args, { timeoutMs: verb.timeoutMs, cwd: target.repoRoot });

  // The exit code as a PRECONDITION. A confirmation printed by a process that then died or
  // failed is not a confirmation - conductor prints its park success line before doing the
  // work that can still throw - so both halves have to hold.
  const clean = !result.outcomeUnknown && !result.overflowed && result.code === 0;
  const ok = clean && verb.confirms({ stdout: result.stdout, stderr: result.stderr }, target);

  return {
    ok,
    action,
    command,
    detail: ok ? verb.success(target) : refusal(result, bin),
    // Carried only on a failure. A successful verb's output is a sentence we have just
    // restated in our own words, and showing both invites the reader to look for the
    // difference between them.
    output: ok ? "" : captured(result),
  };
}

/**
 * The argv for one hosted console, or null when this build cannot compose one.
 *
 * Neither of these is a request with an answer, which is why they are here rather than in
 * the verb table: `daemon connect` attaches a terminal to the engine's tmux session and
 * holds it for as long as somebody watches, and `reseal` refuses to run at all unless
 * `process.stdin.isTTY` - a guard against a build agent resealing the artifact it was
 * supposed to respect, since conductor's providers all feed their children through `input`.
 * There is no stdout to validate in either case, because the person reading it is the point.
 *
 * `daemon connect` is spawned INTO the terminal Mission Control hosts rather than through
 * conductor's `--attach-into <tmux target>`. That flag exists for an operator who already
 * has a tmux pane and wants the attach sent there; hosting the terminal ourselves means
 * there is no target to mint, and it is the one form that works on the emulator backends,
 * which have no tmux target to name at all. Read-only, deliberately: this is a console for
 * watching, and the engine's own default for `connect` is the same.
 */
export function conductorConsoleArgv(
  console_: "daemon" | "reseal",
  target: ConductorControlTarget & { paths: readonly string[]; clearHalt: boolean },
): string[] {
  const bin = conductorBin();
  if (console_ === "daemon") return [bin, "daemon", "connect"];
  return [
    bin,
    "reseal",
    "--slug",
    target.slug ?? "",
    ...target.paths.flatMap((path) => ["--path", path]),
    "--reason",
    target.reason ?? "",
    ...(target.clearHalt ? ["--clear-halt"] : []),
  ];
}

/** The verb table, for a test that wants to assert on argv without spawning anything. */
export function conductorControlArgv(
  action: PipelineAction,
  target: ConductorControlTarget,
): string[] {
  return [conductorBin(), ...VERBS[action].argv(target)];
}
